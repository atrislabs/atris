'use strict';

// `atris pulse` — the durable overnight self-improvement heartbeat for atris-cli.
//
//   atris pulse tick      run ONE self-improvement tick (what the cron calls)
//   atris pulse status    liveness, reward sum, ghost-tick detection
//   atris pulse install   write the OS-cron tick script + install the crontab line
//   atris pulse uninstall remove the crontab line
//   atris pulse run       run N ticks in the foreground (manual / testing)
//
// One tick: lock -> 'started' receipt -> run mission engine -> verify -> write
// 'finished' receipt (pulse_agi_loop_receipts.jsonl) + reward scorecard
// (scorecards.jsonl, gated) -> release lock. The whole point is that this fires
// from an OS cron, so it self-improves overnight without Claude Code open.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const pulse = require('../lib/pulse');

function hasFlag(args, name) {
  return args.includes(name);
}
function readFlag(args, name, fallback = null) {
  const i = args.indexOf(name);
  if (i === -1 || i === args.length - 1) return fallback;
  return args[i + 1];
}
function wantsJson(args) {
  return hasFlag(args, '--json');
}

function helpText() {
  return `
Usage: atris pulse <tick|status|install|uninstall|run> [options]

Durable overnight self-improvement heartbeat.

Commands:
  tick        Run one heartbeat tick
  status      Show liveness, reward, and ghost-tick detection
  install     Install the OS cron heartbeat
  uninstall   Remove the OS cron heartbeat
  run         Run bounded ticks in the foreground

Options:
  --json                 Print machine-readable output
  --no-runner            Do not spawn model-backed mission/autopilot work
  --no-claude            Legacy alias for --no-runner
  --no-verify            Skip verifier command
  --verify "<cmd>"       Verifier for changed-work ticks (default: npm test)
  --cadence "<cron>"     Cron cadence for install
  --days <n>             Auto-expire installed heartbeat after n days
  --model <id>           Runner model alias/id for installed heartbeat
  --runner-profile <n>   Runner profile for installed heartbeat (e.g. atris-fast)
  --runner-bin <path>    Runner binary for installed heartbeat
  --runner-template <s>  Runner command template for installed heartbeat
  --max-ticks <n>        Number of foreground ticks for run
  --help, -h             Show this help
`.trim();
}

function showHelp() {
  process.stdout.write(`${helpText()}\n`);
  return { ok: true, action: 'pulse_help' };
}

function emit(obj, asJson) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
  }
  return obj;
}

const STATE_HOME = path.join(os.homedir(), '.atris', 'overnight', 'atris-cli-self-improve');

// --- engine: run one mission-run-due tick via the real CLI ---

function runMissionEngine(root, { noClaude = false, timeoutMs = 600000 } = {}) {
  const cliPath = path.join(__dirname, '..', 'bin', 'atris.js');
  const args = ['mission', 'run', '--due', '--max-ticks', '1', '--complete-on-pass', '--json'];
  if (noClaude) args.push('--no-claude');
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: timeoutMs,
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' },
  });
  let payload = null;
  try {
    payload = JSON.parse(result.stdout || '{}');
  } catch {}
  // Map the mission-run result to a normalized actor outcome.
  const reason = payload && payload.reason ? payload.reason
    : (result.status === 0 ? 'completed' : 'error');
  return {
    actor: 'mission_run_due',
    ok: result.status === 0,
    reason, // 'completed' | 'no_due_mission' | 'error' | ...
    status: result.status,
    payload,
    stdout: String(result.stdout || '').slice(-2000),
    stderr: String(result.stderr || '').slice(-2000),
  };
}

// Fallback worker: one headless autopilot tick. This is the path that reaches
// proposeCandidateHorizons — i.e. where the member AUTHORS a new goal when no
// mission is due, instead of idling.
function runAutopilotTick(root, { timeoutMs = 600000 } = {}) {
  const cliPath = path.join(__dirname, '..', 'bin', 'atris.js');
  const args = ['autopilot', '--auto', '--iterations=1'];
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: timeoutMs,
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' },
  });
  return {
    actor: 'autopilot',
    ok: result.status === 0,
    reason: result.status === 0 ? 'completed' : 'error',
    status: result.status,
    stdout: String(result.stdout || '').slice(-2000),
    stderr: String(result.stderr || '').slice(-2000),
  };
}

// The full heartbeat composition: continue a due mission, else author+pursue a
// new goal via autopilot. This is the /loop skill's logic, encoded for OS cron.
function runEngine(root, { noClaude = false, autopilotFallback = true, timeoutMs = 600000 } = {}) {
  const mission = runMissionEngine(root, { noClaude, timeoutMs });
  if (pulse.shouldFallbackToAutopilot({ missionReason: mission.reason, autopilotFallback, noClaude })) {
    const ap = runAutopilotTick(root, { timeoutMs });
    return { ...ap, fell_back_from: 'no_due_mission' };
  }
  return mission;
}

function gitChangedFiles(root) {
  try {
    const r = spawnSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8', timeout: 15000 });
    if (r.status !== 0) return [];
    return String(r.stdout || '')
      .split('\n')
      .map((l) => l.slice(3).trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

// A cheap snapshot of the working tree: current HEAD + the set of dirty files.
// Comparing two snapshots gives a tick's ACTUAL contribution (a new commit, or
// files it newly dirtied) — never the whole pre-existing dirty tree.
function gitSnapshot(root) {
  let head = null;
  try {
    const r = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 15000 });
    if (r.status === 0) head = String(r.stdout || '').trim();
  } catch {}
  return { head, dirty: new Set(gitChangedFiles(root)) };
}

function runVerify(root, verifyCmd, timeoutMs = 600000) {
  if (!verifyCmd) return { passed: null, cmd: null };
  const r = spawnSync(verifyCmd, {
    cwd: root,
    shell: true,
    encoding: 'utf8',
    timeout: timeoutMs,
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', ATRIS_AGENT_PROOF_ONLY: '0' },
  });
  return { passed: r.status === 0, cmd: verifyCmd, status: r.status };
}

function noRunnerFlag(args = []) {
  return hasFlag(args, '--no-runner') || hasFlag(args, '--no-claude');
}

// --- atris pulse tick ---

function tickCommand(args, root = process.cwd()) {
  const asJson = wantsJson(args);
  const noRunner = noRunnerFlag(args);
  const noVerify = hasFlag(args, '--no-verify');
  const verifyCmd = noVerify ? null : readFlag(args, '--verify', 'npm test');
  const startedAt = Date.now();

  // Detect a previous tick that died mid-run before we take the lock.
  const priorReceipts = pulse.readPulseReceipts(root);
  const priorStale = pulse.detectStaleTick(priorReceipts);

  const lock = pulse.acquireLock(root);
  if (!lock.acquired) {
    const out = { ok: false, action: 'pulse_tick', skipped: true, reason: 'locked', age_ms: lock.ageMs };
    if (!asJson) process.stdout.write('pulse: previous tick still running; skipped.\n');
    return emit(out, asJson);
  }

  const tickIndex = pulse.nextTickIndex(root);

  // 'started' receipt — if the tick dies after this, the orphan surfaces as a ghost.
  pulse.appendPulseReceipt(root, pulse.buildPulseReceipt({
    tickIndex,
    phase: 'started',
    prevTickStale: priorStale.stale,
  }));

  let engine;
  let verify = { passed: null, cmd: verifyCmd };
  try {
    const before = gitSnapshot(root);
    engine = runEngine(root, { noClaude: noRunner, autopilotFallback: !hasFlag(args, '--no-autopilot') });
    const after = gitSnapshot(root);
    // This tick's ACTUAL contribution: files it newly dirtied, or a new commit.
    // Pre-existing dirt is excluded so reward isn't re-credited every tick.
    const changedFiles = [...after.dirty].filter((f) => !before.dirty.has(f));
    const committed = Boolean(before.head && after.head && before.head !== after.head);
    const producedWork = committed || changedFiles.length > 0;

    // Verify only matters when the tick produced work; a no-op tick skips it.
    if (producedWork && verifyCmd) {
      verify = runVerify(root, verifyCmd);
    } else if (verifyCmd) {
      verify = { passed: null, cmd: verifyCmd, skipped: true };
    }

    const elapsedMs = Date.now() - startedAt;
    const reward = pulse.scoreTick({ verifyPassed: verify.passed, producedWork });
    const changedTail = committed
      ? ' — committed'
      : (changedFiles.length ? ` — ${changedFiles.length} file(s) changed` : '');
    const what = engine.actor === 'autopilot'
      ? `autopilot authored/advanced a goal${changedTail}`
      : engine.reason === 'no_due_mission'
        ? 'no due mission; heartbeat alive (no-op)'
        : `mission ${engine.reason}${changedTail}`;

    const receipt = pulse.buildPulseReceipt({
      tickIndex,
      phase: 'finished',
      actor: engine.actor,
      actorOk: engine.ok,
      actorReason: engine.reason,
      verifyCmd: verify.cmd,
      verifyPassed: verify.passed,
      changedFiles,
      what,
      elapsedMs,
      prevTickStale: priorStale.stale,
      reward,
    });
    pulse.appendPulseReceipt(root, receipt);

    // Revive the reward channel — but only when there is signal (gate noise).
    let scorecardWritten = false;
    if (pulse.shouldWriteScorecard({ reward })) {
      pulse.appendScorecard(root, pulse.buildPulseScorecardRow({
        reward,
        verifyPassed: verify.passed,
        what,
        changedFiles,
        elapsedMs,
        model: process.env.ATRIS_RUNNER_MODEL || process.env.ATRIS_CLAUDE_MODEL || 'opus',
      }));
      scorecardWritten = true;
    }

    const out = {
      ok: true,
      action: 'pulse_tick',
      tick_index: tickIndex,
      actor: engine.actor,
      actor_reason: engine.reason,
      verify_passed: verify.passed,
      reward,
      scorecard_written: scorecardWritten,
      changed_files: changedFiles,
      prev_tick_stale: priorStale.stale,
      elapsed_ms: elapsedMs,
      receipts_path: pulse.pulseReceiptsPath(root),
    };
    if (!asJson) {
      const ghost = priorStale.stale ? ` (recovered ghost tick #${priorStale.tick_index || '?'})` : '';
      const r = reward > 0 ? `+${reward}` : String(reward);
      process.stdout.write(`pulse tick #${tickIndex}: ${what} — verify ${verify.passed === null ? 'n/a' : verify.passed ? 'pass' : 'FAIL'} — reward ${r}${ghost}\n`);
    }
    return emit(out, asJson);
  } catch (err) {
    // Surface the death instead of leaving a silent orphan 'started' receipt.
    pulse.appendPulseReceipt(root, pulse.buildPulseReceipt({
      tickIndex,
      phase: 'finished',
      actor: 'mission_run_due',
      actorOk: false,
      actorReason: 'error',
      what: `tick crashed: ${err && err.message ? err.message : String(err)}`,
      elapsedMs: Date.now() - startedAt,
      reward: -1,
    }));
    const out = { ok: false, action: 'pulse_tick', tick_index: tickIndex, error: err && err.message ? err.message : String(err) };
    if (!asJson) process.stdout.write(`pulse tick #${tickIndex} crashed: ${out.error}\n`);
    return emit(out, asJson);
  } finally {
    pulse.releaseLock(root);
  }
}

// --- atris pulse status ---

function cronInstalled(marker = pulse.PULSE_MARKER) {
  try {
    const r = spawnSync('crontab', ['-l'], { encoding: 'utf8', timeout: 10000 });
    if (r.status !== 0) return false;
    return String(r.stdout || '').includes(marker);
  } catch {
    return false;
  }
}

function statusCommand(args, root = process.cwd()) {
  const asJson = wantsJson(args);
  const receipts = pulse.readPulseReceipts(root);
  const summary = pulse.summarizePulse(receipts);
  const installed = cronInstalled();
  const out = {
    ok: true,
    action: 'pulse_status',
    cron_installed: installed,
    ...summary,
  };
  if (!asJson) {
    process.stdout.write([
      `pulse: ${installed ? 'cron INSTALLED' : 'cron NOT installed (run: atris pulse install)'}`,
      `ticks: ${summary.total_ticks} | reward: ${summary.reward_sum} | verify pass/fail: ${summary.verify_pass}/${summary.verify_fail}`,
      `last tick: ${summary.last_tick_ts || 'never'} (verify ${summary.last_verify_passed === null ? 'n/a' : summary.last_verify_passed ? 'pass' : 'FAIL'})`,
      summary.stale.stale ? `⚠ STALE: ${summary.stale.reason}${summary.stale.tick_index ? ` (ghost tick #${summary.stale.tick_index})` : ''}` : 'liveness: fresh',
      summary.orphan_ticks.length ? `⚠ orphan (crashed) ticks: ${summary.orphan_ticks.join(', ')}` : '',
    ].filter(Boolean).join('\n') + '\n');
  }
  return emit(out, asJson);
}

// --- atris pulse install / uninstall ---

function resolveAtrisBin() {
  // Prefer a globally linked `atris`; fall back to this checkout's bin.
  const which = spawnSync('which', ['atris'], { encoding: 'utf8', timeout: 8000 });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
  return `${process.execPath} ${path.join(__dirname, '..', 'bin', 'atris.js')}`;
}

// The dirs holding the binaries the engine spawns by bare name (claude, node,
// git, atris). Baked into the cron script's PATH so a minimal cron environment
// can still find them. Missing tools just contribute nothing.
function resolveEngineBinDirs(extraBins = []) {
  const dirs = new Set([path.dirname(process.execPath)]); // node
  for (const tool of ['ax', 'claude', 'git', 'atris']) {
    const r = spawnSync('which', [tool], { encoding: 'utf8', timeout: 8000 });
    if (r.status === 0 && r.stdout.trim()) dirs.add(path.dirname(r.stdout.trim()));
  }
  for (const bin of [process.env.ATRIS_RUNNER_BIN, process.env.ATRIS_CLAUDE_BIN, ...extraBins]) {
    const configured = String(bin || '').trim();
    if (configured && configured.includes(path.sep)) dirs.add(path.dirname(configured));
    if (configured && !configured.includes(path.sep)) {
      const r = spawnSync('which', [configured], { encoding: 'utf8', timeout: 8000 });
      if (r.status === 0 && r.stdout.trim()) dirs.add(path.dirname(r.stdout.trim()));
    }
  }
  dirs.add(path.join(os.homedir(), '.local', 'bin')); // common claude location
  return Array.from(dirs);
}

function installCommand(args, root = process.cwd()) {
  const asJson = wantsJson(args);
  const cron = readFlag(args, '--cadence', pulse.DEFAULT_CADENCE_CRON);
  const days = Math.max(1, Number(readFlag(args, '--days', '7')) || 7);
  const verifyCmd = readFlag(args, '--verify', 'npm test');
  const model = readFlag(args, '--model', process.env.ATRIS_RUNNER_MODEL || process.env.ATRIS_CLAUDE_MODEL || 'opus');
  const runnerProfile = readFlag(args, '--runner-profile', process.env.ATRIS_RUNNER_PROFILE || '');
  const runnerBin = readFlag(args, '--runner-bin', process.env.ATRIS_RUNNER_BIN || process.env.ATRIS_CLAUDE_BIN || '');
  const runnerCommandTemplate = readFlag(args, '--runner-template', process.env.ATRIS_RUNNER_COMMAND_TEMPLATE || process.env.ATRIS_CLAUDE_COMMAND_TEMPLATE || '');
  const deadlineEpoch = Math.floor(Date.now() / 1000) + days * 86400;

  fs.mkdirSync(STATE_HOME, { recursive: true });
  const scriptPath = path.join(STATE_HOME, 'tick.sh');
  // Resolve the real bin dirs the engine spawns by bare name, so cron's minimal
  // PATH doesn't silently break the worker spawn (claude lives in ~/.local/bin).
  const pathDirs = resolveEngineBinDirs([runnerBin]);
  const script = pulse.buildTickScript({
    root,
    atrisBin: resolveAtrisBin(),
    stateHome: STATE_HOME,
    deadlineEpoch,
    model,
    runnerProfile,
    runnerBin,
    runnerCommandTemplate,
    verifyCmd,
    pathDirs,
  });
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  const line = pulse.buildCrontabLine({ cron, scriptPath });
  // Append our line to the existing crontab (idempotent: strip any prior marker first).
  const existing = spawnSync('crontab', ['-l'], { encoding: 'utf8', timeout: 10000 });
  const prior = existing.status === 0 ? String(existing.stdout || '') : '';
  const cleaned = prior.split('\n').filter((l) => l && !l.includes(pulse.PULSE_MARKER)).join('\n');
  const next = `${cleaned ? cleaned + '\n' : ''}${line}\n`;
  const apply = spawnSync('crontab', ['-'], { input: next, encoding: 'utf8', timeout: 10000 });

  const out = {
    ok: apply.status === 0,
    action: 'pulse_install',
    script_path: scriptPath,
    crontab_line: line,
    cadence: cron,
    expires_in_days: days,
    deadline_epoch: deadlineEpoch,
    runner_profile: runnerProfile || null,
    runner_bin: runnerBin || null,
    runner_template_configured: Boolean(runnerCommandTemplate),
  };
  if (!asJson) {
    if (apply.status === 0) {
      process.stdout.write([
        `pulse installed. heartbeat fires '${cron}' against ${root}.`,
        `script: ${scriptPath}`,
        `auto-expires in ${days} days. stop early: atris pulse uninstall`,
      ].join('\n') + '\n');
    } else {
      process.stdout.write(`pulse install failed to write crontab: ${apply.stderr || apply.status}\nscript written to ${scriptPath}; add this line to your crontab manually:\n${line}\n`);
    }
  }
  return emit(out, asJson);
}

function uninstallCommand(args) {
  const asJson = wantsJson(args);
  const existing = spawnSync('crontab', ['-l'], { encoding: 'utf8', timeout: 10000 });
  if (existing.status !== 0) {
    const out = { ok: true, action: 'pulse_uninstall', removed: false, reason: 'no_crontab' };
    if (!asJson) process.stdout.write('pulse: no crontab to clean.\n');
    return emit(out, asJson);
  }
  const prior = String(existing.stdout || '');
  const had = prior.includes(pulse.PULSE_MARKER);
  const cleaned = prior.split('\n').filter((l) => l && !l.includes(pulse.PULSE_MARKER)).join('\n');
  const apply = spawnSync('crontab', ['-'], { input: cleaned ? cleaned + '\n' : '', encoding: 'utf8', timeout: 10000 });
  const out = { ok: apply.status === 0, action: 'pulse_uninstall', removed: had };
  if (!asJson) process.stdout.write(had ? 'pulse uninstalled (crontab line removed).\n' : 'pulse: no heartbeat line found.\n');
  return emit(out, asJson);
}

// --- atris pulse run (foreground N ticks) ---

function runCommand(args, root = process.cwd()) {
  const asJson = wantsJson(args);
  const maxTicks = Math.max(1, Number(readFlag(args, '--max-ticks', '1')) || 1);
  const passthrough = args.filter((a) => a !== '--max-ticks' && a !== String(maxTicks));
  const results = [];
  for (let i = 0; i < maxTicks; i++) {
    results.push(tickCommand(passthrough.concat(['--json-silent']).filter((a) => a !== '--json'), root));
  }
  const out = { ok: true, action: 'pulse_run', ticks: results.length, results };
  return emit(out, asJson);
}

function pulseCommand(argv = []) {
  const sub = argv[0];
  const rest = argv.slice(1);
  if (sub === '--help' || sub === '-h' || sub === 'help') return showHelp();
  switch (sub) {
    case 'tick':
      return tickCommand(rest);
    case 'status':
    case undefined:
      return statusCommand(rest);
    case 'install':
      return installCommand(rest);
    case 'uninstall':
      return uninstallCommand(rest);
    case 'run':
      return runCommand(rest);
    default: {
      const asJson = wantsJson(rest);
      const out = { ok: false, action: 'pulse', error: `unknown subcommand: ${sub}`, usage: 'atris pulse tick|status|install|uninstall|run' };
      if (!asJson) process.stdout.write(`${out.error}\nUsage: ${out.usage}\n`);
      return emit(out, asJson);
    }
  }
}

module.exports = {
  pulseCommand,
  tickCommand,
  statusCommand,
  installCommand,
  uninstallCommand,
  runCommand,
  runMissionEngine,
  runAutopilotTick,
  runEngine,
  gitChangedFiles,
  runVerify,
  noRunnerFlag,
  STATE_HOME,
};
