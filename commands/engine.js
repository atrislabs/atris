'use strict';

// atris engine: bring any intelligence.
// Every installed headless coding CLI is a swappable worker behind one
// contract (bounded prompt in, verified proof out, engines never
// self-certify). This command shows the roster, flips the default, and the
// same names ride --engine on mission run / autopilot / run.
//
//   atris engine            roster + current default
//   atris engine cursor     make cursor the default engine here
//   atris engine reset      back to the house default (atris-fast)
//
// The default persists to .atris/engine.json. Per-run flags and
// ATRIS_RUNNER_PROFILE always beat the file.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  RUNNER_PROFILE_DEFS,
  RUNNER_PROFILE_ALIASES,
  RUNNER_PROFILE_NAMES,
  buildRunnerCommand,
} = require('../lib/runner-command');

const HOUSE_ENGINE = 'atris-fast';

function engineFile(root = process.cwd()) {
  return path.join(root, '.atris', 'engine.json');
}

function binInstalled(bin) {
  const safe = String(bin || '').replace(/[^A-Za-z0-9_.-]/g, '');
  if (!safe) return false;
  const probe = spawnSync('sh', ['-c', `command -v ${safe}`], { encoding: 'utf8' });
  return probe.status === 0 && Boolean(String(probe.stdout || '').trim());
}

function canonicalEngineName(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return '';
  if (RUNNER_PROFILE_DEFS[trimmed]) return trimmed;
  if (RUNNER_PROFILE_ALIASES[trimmed]) return RUNNER_PROFILE_ALIASES[trimmed];
  return '';
}

function readSavedEngine(root = process.cwd()) {
  try {
    const saved = JSON.parse(fs.readFileSync(engineFile(root), 'utf8'));
    return canonicalEngineName(saved.default);
  } catch {
    return '';
  }
}

// The default engine for this workspace, in precedence order:
// env (per-run flags land here) -> .atris/engine.json -> house default.
// The house default is our own intelligence when it is installed.
function resolveDefaultEngine(root = process.cwd()) {
  const env = canonicalEngineName(process.env.ATRIS_RUNNER_PROFILE);
  if (env) return { name: env, source: 'env' };
  const saved = readSavedEngine(root);
  if (saved) return { name: saved, source: 'saved' };
  if (binInstalled(RUNNER_PROFILE_DEFS[HOUSE_ENGINE].bin)) return { name: HOUSE_ENGINE, source: 'house' };
  const fallback = RUNNER_PROFILE_NAMES.find((name) => binInstalled(RUNNER_PROFILE_DEFS[name].bin));
  return fallback ? { name: fallback, source: 'detected' } : { name: HOUSE_ENGINE, source: 'none' };
}

function roster(root = process.cwd()) {
  const current = resolveDefaultEngine(root);
  return RUNNER_PROFILE_NAMES.map((name) => ({
    name,
    bin: RUNNER_PROFILE_DEFS[name].bin,
    installed: binInstalled(RUNNER_PROFILE_DEFS[name].bin),
    default: name === current.name,
  }));
}

function setEngine(name, root = process.cwd()) {
  const canonical = canonicalEngineName(name);
  if (!canonical) {
    throw new Error(`Unknown engine "${name}". Known engines: ${RUNNER_PROFILE_NAMES.join(', ')}`);
  }
  const file = engineFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ default: canonical, set_at: new Date().toISOString() }, null, 2)}\n`);
  return canonical;
}

function resetEngine(root = process.cwd()) {
  try { fs.unlinkSync(engineFile(root)); return true; } catch { return false; }
}

function printRoster(root) {
  const list = roster(root);
  const found = list.filter((e) => e.installed).length;
  const current = resolveDefaultEngine(root);
  console.log('');
  console.log(`  engines — ${found} intelligence${found === 1 ? '' : 's'} found`);
  console.log('');
  for (const engine of list) {
    const mark = engine.default ? '→' : ' ';
    const state = engine.installed ? 'ready' : 'not installed';
    console.log(`  ${mark} ${engine.name.padEnd(12)} ${state}`);
  }
  console.log('');
  console.log(`  default: ${current.name}${current.source === 'saved' ? ' (set here)' : current.source === 'env' ? ' (this session)' : ''}`);
  console.log(`  switch:  atris engine <name>   ·   one run: --engine <name> on mission run / autopilot / run`);
  console.log('');
}

// Preflight: run one engine CLI headless with a reply-OK prompt and report
// pass/fail. A dead login, missing binary, or hung spawn is a one-command
// diagnosis instead of a failed overnight flight. `name` is canonical.
const PROBE_PROMPT = 'Reply with exactly the two characters: OK';
// Real engines think before replying: cursor measured at ~68s for a one-word
// answer on 2026-07-02. 30s produced a false FAIL on a healthy engine.
const PROBE_DEFAULT_TIMEOUT_MS = 120000;

function probeEngine(name, { timeout = PROBE_DEFAULT_TIMEOUT_MS } = {}) {
  const def = RUNNER_PROFILE_DEFS[name];
  if (!binInstalled(def.bin)) {
    return {
      engine: name,
      bin: def.bin,
      pass: false,
      reason: 'not-installed',
      message: `${def.bin} CLI not installed`,
      stdout: '',
      stderr: '',
      durationMs: 0,
    };
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-engine-probe-'));
  const promptFile = path.join(tmpDir, 'prompt.txt');
  fs.writeFileSync(promptFile, `${PROBE_PROMPT}\n`);
  let cmd;
  const prevProfile = process.env.ATRIS_RUNNER_PROFILE;
  process.env.ATRIS_RUNNER_PROFILE = name;
  try {
    cmd = buildRunnerCommand({ promptFile });
  } finally {
    if (prevProfile === undefined) delete process.env.ATRIS_RUNNER_PROFILE;
    else process.env.ATRIS_RUNNER_PROFILE = prevProfile;
  }
  const start = Date.now();
  let res;
  try {
    res = spawnSync('sh', ['-c', cmd], { encoding: 'utf8', timeout });
  } catch (err) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return {
      engine: name,
      bin: def.bin,
      pass: false,
      reason: 'spawn-error',
      message: String(err && err.message ? err.message : err),
      stdout: '',
      stderr: '',
      durationMs: Date.now() - start,
    };
  }
  const durationMs = Date.now() - start;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  const stdout = res.stdout || '';
  const stderr = res.stderr || '';
  const timedOut = res.status === null && Boolean(res.signal) && String(res.signal).toLowerCase().includes('term');
  const combined = `${stdout}\n${stderr}`.trim();
  const ok = res.status === 0 && /OK/i.test(combined);
  let reason;
  if (ok) reason = 'ok';
  else if (timedOut) reason = 'timeout';
  else if (res.status !== 0 && res.status !== null) reason = 'bad-exit';
  else if (!/OK/i.test(combined)) reason = 'no-ok';
  else reason = 'unknown';
  return {
    engine: name,
    bin: def.bin,
    pass: ok,
    reason,
    message: ok
      ? 'responded OK'
      : (timedOut ? `no reply within ${timeout}ms` : `did not reply OK (exit ${res.status}, signal ${res.signal})`),
    stdout,
    stderr,
    durationMs,
  };
}

function runEngineTest(targets, { json, root } = {}) {
  let enginesToTest;
  if (targets && targets.length) {
    enginesToTest = targets.map((n) => {
      const c = canonicalEngineName(n);
      if (!c) {
        throw new Error(`Unknown engine "${n}". Known engines: ${RUNNER_PROFILE_NAMES.join(', ')}`);
      }
      return c;
    });
  } else {
    enginesToTest = RUNNER_PROFILE_NAMES.filter((n) => binInstalled(RUNNER_PROFILE_DEFS[n].bin));
    if (!enginesToTest.length) {
      if (json) {
        console.log(JSON.stringify({ ok: false, results: [], summary: { pass: 0, fail: 0 } }, null, 2));
      } else {
        console.error('\n  no installed engines to test\n');
      }
      return 1;
    }
  }
  const results = enginesToTest.map((name) => probeEngine(name));
  const failures = results.filter((r) => !r.pass);
  const passed = results.length - failures.length;
  if (json) {
    console.log(JSON.stringify({
      ok: failures.length === 0,
      results,
      summary: { pass: passed, fail: failures.length },
    }, null, 2));
  } else {
    console.log('');
    for (const r of results) {
      const mark = r.pass ? '✓' : '✗';
      const line = r.pass
        ? `  ${mark} ${r.engine.padEnd(12)} pass — ${r.message} (${r.durationMs}ms)`
        : `  ${mark} ${r.engine.padEnd(12)} FAIL — ${r.message}`;
      if (r.pass) console.log(line);
      else console.error(line);
    }
    console.log('');
    if (failures.length) {
      console.error(`  ${failures.length} engine${failures.length === 1 ? '' : 's'} failed: ${failures.map((f) => f.engine).join(', ')}`);
      console.error(`  fix the login/binary, then re-run: atris engine test${targets && targets.length ? ' ' + targets.join(' ') : ''}`);
    } else {
      console.log(`  all engines responded — clear for flight`);
    }
    console.log('');
  }
  return failures.length ? 1 : 0;
}

function engineCommand(args = []) {
  const json = args.includes('--json');
  const positional = args.filter((a) => !a.startsWith('--'));
  const sub = (positional[0] || '').trim();
  const root = process.cwd();

  if (sub === 'test') {
    return runEngineTest(positional.slice(1), { json, root });
  }

  if (!sub || sub === 'list' || sub === 'status') {
    if (json) {
      const current = resolveDefaultEngine(root);
      console.log(JSON.stringify({ engines: roster(root), default: current.name, source: current.source }, null, 2));
      return 0;
    }
    printRoster(root);
    return 0;
  }

  if (sub === 'reset' || sub === 'off') {
    const removed = resetEngine(root);
    console.log(removed
      ? `\n  default engine reset — back to ${resolveDefaultEngine(root).name}\n`
      : `\n  nothing to reset — no engine was set here\n`);
    return 0;
  }

  if (sub === 'help') {
    console.log('\n  atris engine            roster + current default\n  atris engine <name>     make that engine the default here\n  atris engine test [name] preflight: run the engine CLI headless, report pass/fail\n  atris engine reset      back to the house default\n  --engine <name>         one run on that engine (mission run / autopilot / run)\n');
    return 0;
  }

  // atris engine <name> — flip the default.
  const canonical = setEngine(sub, root);
  const def = RUNNER_PROFILE_DEFS[canonical];
  const installed = binInstalled(def.bin);
  console.log('');
  console.log(`  default engine: ${canonical}`);
  if (!installed) console.log(`  heads up: its CLI (${def.bin}) is not installed here yet — runs will fail until it is.`);
  console.log(`  every mission run / autopilot / run tick now rides it. one-off: --engine <name>. undo: atris engine reset`);
  console.log('');
  return 0;
}

module.exports = {
  engineCommand,
  resolveDefaultEngine,
  canonicalEngineName,
  readSavedEngine,
  setEngine,
  resetEngine,
  roster,
  probeEngine,
  runEngineTest,
  HOUSE_ENGINE,
};
