'use strict';

// The fleet conductor's primitives. Humble name outside (`atris mission run
// --fleet`), the full loop inside: staff every idle engine on claimable
// safe-lane tasks, one mission per task, one worktree per engine, land
// arrivals serially. Proven by hand on 2026-07-02 (PRs #191-193, three
// engines) before any of this code existed — each function here is one thing
// the orchestrator did manually that day.
//
// INVARIANT: the fleet has NO state file. Flight state IS missions +
// worktrees + receipts. Kill a flight mid-run and nothing is orphaned — it
// is just missions in flight, resumable the normal way.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { RUNNER_PROFILE_DEFS, buildRunnerCommand } = require('./runner-command');
const { listWorktrees } = require('../commands/worktree');

// Lanes a fleet may never staff on its own: the human keeps irreversible
// calls. Mirrors the autoland denied lanes.
const DENIED_TAGS = ['billing', 'deploy', 'security', 'customer', 'external', 'feedback', 'voice'];

// ---------------------------------------------------------------------------
// T1 — dispatch primitive

// A task's own text is its spec: the board convention writes "Done: ..." and
// "Check: ..." into the title/description. Extract both so the dispatch
// prompt is generated, never hand-written.
function parseDoneCheck(text) {
  const s = String(text || '');
  const done = (s.match(/Done:\s*([^]*?)(?=Check:|$)/i) || [])[1];
  const check = (s.match(/Check:\s*([^]*?)$/i) || [])[1];
  return {
    done: done ? done.trim().replace(/\s+/g, ' ') : '',
    check: check ? check.trim().replace(/\s+/g, ' ') : '',
  };
}

// The bounded prompt every engine gets. Same contract the manual flight used:
// isolated worktree, commit never push, MAP first, focused verify, report.
function buildFleetPrompt(task, { worktreePath } = {}) {
  const ref = task.display_id || task.id || 'TASK';
  const title = String(task.title || '').trim();
  const { done, check } = parseDoneCheck(title);
  const lines = [
    'First, run `atris worktree guard`; if it fails, stop immediately, report back, and do not edit anything. Do this before any file edit.',
    '',
    `You are working task ${ref} in this repo checkout (an isolated git worktree${worktreePath ? ` at ${worktreePath}` : ''} — commit here, NEVER push).`,
    '',
    `Task: ${title}`,
    '',
  ];
  if (done) lines.push(`Done criteria: ${done}`, '');
  if (check) lines.push(`Check: ${check}`, '');
  lines.push(
    'Rules:',
    '- Read atris/MAP.md first to locate the code; never guess file locations.',
    '- Run git status first. Stage ONLY files you changed. Never revert or touch files another agent modified.',
    '- Include or update a focused regression test; run it with node --test before committing.',
    '- Commit on the current branch with a clear message. Do not push. Do not create branches.',
    '',
    'Final report (plain text): files changed, test command + result, commit sha (or say the commit failed and why).'
  );
  return lines.join('\n');
}

// Shell command that runs one engine on one prompt file, from the worktree.
// Rides the same profile definitions the whole CLI uses — no fleet-only
// spawn shapes.
// Build work needs file tools: allowedTools reaches the default claude-shaped
// spawn; template engines (cursor/codex/devin) ignore it — their CLIs manage
// their own permissions.
const FLEET_ALLOWED_TOOLS = 'Bash,Read,Edit,Write,Grep,Glob';

function realpathOrResolve(value) {
  const resolved = path.resolve(String(value));
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function assertIsolatedWorktree(worktreePath, root = process.cwd()) {
  if (!worktreePath) {
    throw new Error('fleet dispatch blocked: worktreePath is required; refusing to dispatch without an isolated worktree');
  }
  const resolvedWorktree = realpathOrResolve(worktreePath);
  const worktrees = listWorktrees(root);
  const primaryRoot = realpathOrResolve(worktrees[0]?.path || root);
  if (resolvedWorktree === primaryRoot) {
    throw new Error(`fleet dispatch blocked: worktreePath resolves to the primary repo checkout (${primaryRoot}); refusing to dispatch outside an isolated worktree`);
  }
  return { worktreePath: resolvedWorktree, primaryRoot };
}

function buildEngineCommand(engineName, promptFile) {
  if (!RUNNER_PROFILE_DEFS[engineName]) throw new Error(`unknown engine "${engineName}"`);
  const prev = process.env.ATRIS_RUNNER_PROFILE;
  process.env.ATRIS_RUNNER_PROFILE = engineName;
  try {
    const cmd = buildRunnerCommand({ promptFile, allowedTools: FLEET_ALLOWED_TOOLS });
    // devin's default is read-only for writes; fleet builds ALWAYS run in an
    // isolated worktree, so the conductor grants write permission here and
    // only here (the profile itself stays safe for non-worktree ticks).
    if (engineName === 'devin') return cmd.replace(/^devin -p /, 'devin -p --permission-mode dangerous ');
    return cmd;
  } finally {
    if (prev === undefined) delete process.env.ATRIS_RUNNER_PROFILE;
    else process.env.ATRIS_RUNNER_PROFILE = prev;
  }
}

// Run one engine on one task in one worktree. Blocking; the conductor runs
// dispatches in parallel via child processes, not threads. `runner` is
// injectable for tests. `prompt` is injectable too: a caller-supplied prompt
// (e.g. `atris engine dispatch --prompt-file`) skips the generated
// buildFleetPrompt text entirely.
function dispatchToEngine({ task, engine, worktreePath, root = process.cwd(), timeoutMs = 900000, runner = null, prompt: promptOverride = '' }) {
  assertIsolatedWorktree(worktreePath, root);
  const prompt = promptOverride || buildFleetPrompt(task, { worktreePath });
  const promptFile = path.join(worktreePath, '.atris', `fleet-prompt-${task.display_id || 'task'}.md`);
  fs.mkdirSync(path.dirname(promptFile), { recursive: true });
  fs.writeFileSync(promptFile, prompt);
  const command = buildEngineCommand(engine, promptFile);
  const exec = runner || ((cmd) => spawnSync('sh', ['-c', cmd], {
    cwd: worktreePath,
    encoding: 'utf8',
    timeout: timeoutMs,
  }));
  const result = exec(command);
  return {
    task: task.display_id || task.id,
    engine,
    worktreePath,
    command,
    exitCode: result.status,
    report: String(result.stdout || '').slice(-8000),
    stderr: String(result.stderr || '').slice(-2000),
  };
}

// ---------------------------------------------------------------------------
// T2 — staffing

function taskTags(task) {
  const fromTags = Array.isArray(task.tags) ? task.tags : [];
  // Tags added after creation live in metadata.tags (`atris task tag`); a
  // fleet that only read task.tags/title hashtags would ignore an owner-hold
  // flag stamped on a live task and keep restaffing it (CLI-879).
  const fromMeta = task && task.metadata && Array.isArray(task.metadata.tags) ? task.metadata.tags : [];
  const fromTitle = (String(task.title || '').match(/#([a-z0-9-]+)/gi) || []).map((t) => t.slice(1));
  return [...fromTags, ...fromMeta, ...fromTitle].map((t) => String(t).toLowerCase());
}

// A task flagged for a human decision is never fleet-staffable, whatever its
// lane. Mirrors the sweep's needs-human hold so both loops agree.
function isHumanHoldTag(tag) {
  const normalized = String(tag).trim().toLowerCase().replace(/_/g, '-');
  return normalized === 'needs-human' || normalized === 'needshuman';
}

function isSafeLane(task) {
  const tags = taskTags(task);
  if (tags.some(isHumanHoldTag)) return false;
  return !tags.some((t) => DENIED_TAGS.includes(t));
}

// Rough file-surface guess from a task's text: paths and bare `commands/x.js`
// style mentions. Used only to keep concurrent picks disjoint — the merge
// conflict on 2026-07-02 (two engines in commands/mission.js) is the tax this
// avoids.
function fileSurface(task) {
  const text = String(task.title || '');
  const matches = text.match(/\b(?:commands|lib|bin|test|scripts)\/[A-Za-z0-9._/-]+/g) || [];
  return [...new Set(matches)];
}

function surfacesOverlap(a, b) {
  return a.some((f) => b.includes(f));
}

// Pick up to `slots` open, safe-lane, mutually file-disjoint tasks. Tasks
// whose surface cannot be guessed are allowed one at a time (the unknown
// surface could overlap anything).
function staffFlight(tasks, { slots = 3 } = {}) {
  const open = (tasks || []).filter((t) => t && t.status === 'open' && isSafeLane(t));
  const picked = [];
  let blindPicked = false;
  for (const task of open) {
    if (picked.length >= slots) break;
    const surface = fileSurface(task);
    if (surface.length === 0) {
      if (blindPicked) continue;
      blindPicked = true;
      picked.push({ task, surface });
      continue;
    }
    if (picked.some((p) => surfacesOverlap(p.surface, surface))) continue;
    picked.push({ task, surface });
  }
  return picked.map((p, i) => ({ task: p.task, surface: p.surface, slot: i }));
}

// Pair staffed tasks with installed engines, round-robin. `engines` comes
// from commands/engine.js roster (installed only).
function assignEngines(staffed, engines) {
  const pool = (engines || []).filter(Boolean);
  if (!pool.length) return [];
  return staffed.map((entry, i) => ({ ...entry, engine: pool[i % pool.length] }));
}

// ---------------------------------------------------------------------------
// T3 — serial landing lane

// Land one arrival: rebase onto latest base first; a conflict pauses the
// landing (never auto-resolve) and reports which files collided so the
// conductor or a human can take it. `git` is injectable for tests.
// Fleet landings always target master. Without the explicit --target, ship
// falls back to the launcher branch's atris-base — a flight launched from a
// feature-branch checkout would merge PRs into that branch while the receipt
// and land board define "landed" as in-master (PRs #207/#208, 2026-07-04).
function fleetShipArgs(entry, check) {
  return [
    'worktree', 'ship',
    '--message', `${String(entry.task.title || '').split(/[.:]/)[0].slice(0, 90)} (${entry.task.display_id}, built by ${entry.engine})`,
    '--verify', check,
    '--target', 'origin/master',
    '--merge',
  ];
}

function landArrival({ worktreePath, git = null }) {
  const run = git || ((args) => spawnSync('git', args, { cwd: worktreePath, encoding: 'utf8' }));
  const fetch = run(['fetch', 'origin']);
  if (fetch.status !== 0) return { ok: false, stage: 'fetch', detail: String(fetch.stderr || '').trim() };
  const rebase = run(['rebase', 'origin/master']);
  if (rebase.status !== 0) {
    const conflicted = run(['diff', '--name-only', '--diff-filter=U']);
    run(['rebase', '--abort']);
    return {
      ok: false,
      stage: 'rebase_conflict',
      conflicts: String(conflicted.stdout || '').trim().split('\n').filter(Boolean),
    };
  }
  return { ok: true, stage: 'rebased' };
}

module.exports = {
  DENIED_TAGS,
  get FLEET_CAPABLE() { return FLEET_CAPABLE; },
  get runFleetFlight() { return runFleetFlight; },
  get focusedCheck() { return focusedCheck; },
  get dispatchCheck() { return dispatchCheck; },
  get runDispatchFlight() { return runDispatchFlight; },
  parseDoneCheck,
  buildFleetPrompt,
  assertIsolatedWorktree,
  buildEngineCommand,
  dispatchToEngine,
  taskTags,
  isHumanHoldTag,
  isSafeLane,
  fileSurface,
  surfacesOverlap,
  staffFlight,
  assignEngines,
  landArrival,
  fleetShipArgs,
};

// ---------------------------------------------------------------------------
// T4 — the conductor: one flight, watchable, receipted

// Engines that can edit a repo headlessly. atris-fast (ax) is a chat lane,
// not a repo worker — it keeps owning normal mission ticks, not fleet builds.
const FLEET_CAPABLE = ['claude', 'codex', 'cursor', 'devin'];

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function readProjectionTasks(root) {
  try {
    const raw = fs.readFileSync(path.join(root, '.atris', 'state', 'tasks.projection.json'), 'utf8');
    const projection = JSON.parse(raw);
    return Array.isArray(projection.tasks) ? projection.tasks : [];
  } catch {
    return [];
  }
}

function defaultOwnCli(root) {
  const bin = path.resolve(__dirname, '..', 'bin', 'atris.js');
  return (cliArgs, cwd = root) => {
    const result = spawnSync(process.execPath, [bin, ...cliArgs], { cwd, encoding: 'utf8', timeout: 600000 });
    return { status: result.status, stdout: String(result.stdout || ''), stderr: String(result.stderr || '') };
  };
}

// Extract a runnable focused check from the task's Check: line; the wide
// gates (npm test, CI) stay at the ship gate, not per-arrival.
function focusedCheck(task) {
  const { check } = parseDoneCheck(task.title);
  const m = check.match(/node --test \S+/);
  if (!m) return '';
  let cmd = m[0].trim();
  // Board convention often ends the Check: sentence with a trailing period
  // right after the test file path (e.g. "node --test test/x.test.js."). A
  // naive [^.]+ stop would also truncate the ".test.js" extension itself, so
  // only strip the LAST period, and only when the path still ends in a real
  // extension without it (otherwise the period is part of the path).
  if (cmd.endsWith('.')) {
    const stripped = cmd.slice(0, -1);
    if (/\.(js|mjs|cjs|ts|tsx)$/.test(stripped)) cmd = stripped;
  }
  return cmd;
}

// One-command dispatch runs a single explicit task, so the wide-gate caution
// behind focusedCheck (many staffed tasks, keep per-arrival checks narrow)
// does not apply: fall back to the task's whole Check: text so the operator's
// actual check command is what gets re-run as verification.
function dispatchCheck(task) {
  const narrow = focusedCheck(task);
  if (narrow) return narrow;
  const { check } = parseDoneCheck(task.title);
  return check;
}

function readTaskById(cli, taskId) {
  const result = cli(['task', 'show', String(taskId), '--json']);
  if (!result || result.status !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout);
    return parsed && parsed.display_id ? parsed : null;
  } catch {
    return null;
  }
}

function defaultVerifyRunner(command, cwd) {
  const result = spawnSync(command, { cwd, encoding: 'utf8', shell: true });
  return { status: result.status, stdout: String(result.stdout || ''), stderr: String(result.stderr || '') };
}

// One flight. Staff -> dispatch in parallel -> land serially -> receipt.
// No fleet state file: progress is narrated via `log`, durability lives in
// worktrees, task claims, and the receipt written at the end.
async function runFleetFlight({
  root = process.cwd(),
  slots = 3,
  engines = null,
  dryRun = false,
  log = console.log,
  ownCli = null,
  dispatcher = null,
  lander = null,
  checkoutBase = 'origin/master',
} = {}) {
  const cli = ownCli || defaultOwnCli(root);
  const roster = engines || (() => {
    const { roster: fullRoster } = require('../commands/engine');
    return fullRoster(root).filter((e) => e.installed && FLEET_CAPABLE.includes(e.name)).map((e) => e.name);
  })();

  const staffed = assignEngines(staffFlight(readProjectionTasks(root), { slots }), roster);
  // The receipt path is decided BEFORE landings so each task's ready-proof
  // can cite it — the proof policy certifies receipt-backed proofs agent-side.
  const receiptPath = path.join(root, 'atris', 'runs', `fleet-${nowStamp()}.json`);
  const flight = {
    at: new Date().toISOString(),
    root,
    slots,
    roster,
    staffed: staffed.map((s) => ({ task: s.task.display_id, title: String(s.task.title || '').slice(0, 140), engine: s.engine, surface: s.surface })),
    results: [],
    landed: [],
    paused: [],
  };

  log('');
  log(`  fleet — ${roster.length} engine${roster.length === 1 ? '' : 's'} ready, ${staffed.length} task${staffed.length === 1 ? '' : 's'} staffed`);
  for (const s of staffed) log(`    ${s.engine.padEnd(8)} → ${s.task.display_id}  ${String(s.task.title || '').slice(0, 80)}`);
  log('');

  if (dryRun || staffed.length === 0) {
    flight.dry_run = true;
    return flight;
  }

  // Claim + cut a worktree per assignment, then dispatch all in parallel.
  const dispatch = dispatcher || ((entry) => new Promise((resolve) => {
    resolve(dispatchToEngine({ task: entry.task, engine: entry.engine, worktreePath: entry.worktreePath, root }));
  }));

  // Cut every build worktree from origin/master by default, not the launcher's
  // HEAD. A flight launched from a long-lived feature-branch checkout would
  // otherwise stack all that branch's commits onto the build branch, so
  // rebase-before-ship replays them onto master and pauses at rebase_conflict
  // (three backend pauses on members.py, 2026-07-05). --base overrides only
  // when the operator explicitly wants launcher-HEAD.
  const startBaseArgs = checkoutBase ? ['--base', checkoutBase] : [];
  const prepared = [];
  for (const entry of staffed) {
    cli(['task', 'claim', String(entry.task.display_id), '--as', `fleet-${entry.engine}`]);
    const started = cli(['worktree', 'start', '--agent', entry.engine, '--task', `fleet-${String(entry.task.display_id).toLowerCase()}`, ...startBaseArgs]);
    const wt = (started.stdout.match(/next: cd (.+)/) || [])[1];
    if (!wt) {
      flight.paused.push({ task: entry.task.display_id, stage: 'worktree_start', detail: started.stderr.slice(0, 200) });
      continue;
    }
    prepared.push({ ...entry, worktreePath: wt.trim() });
    log(`    ${entry.engine.padEnd(8)} building ${entry.task.display_id} in ${path.basename(wt.trim())}`);
  }

  const results = await Promise.all(prepared.map((entry) =>
    dispatch(entry).then((r) => ({ entry, result: r })).catch((err) => ({ entry, result: { exitCode: 1, report: '', stderr: String(err && err.message || err) } }))
  ));
  flight.results = results.map(({ entry, result }) => ({ task: entry.task.display_id, engine: entry.engine, exitCode: result.exitCode }));

  // Land serially: rebase-before-ship, conflict pauses (never auto-resolve).
  const land = lander || (({ entry }) => {
    const rebased = landArrival({ worktreePath: entry.worktreePath });
    if (!rebased.ok) return rebased;
    const check = focusedCheck(entry.task) || 'git log -1 --oneline';
    const shipped = cli(fleetShipArgs(entry, check), entry.worktreePath);
    if (shipped.status !== 0 || !/done: worktree shipped/.test(shipped.stdout)) {
      return { ok: false, stage: 'ship', detail: (shipped.stderr || shipped.stdout).slice(-300) };
    }
    return { ok: true, stage: 'shipped' };
  });

  for (const { entry, result } of results) {
    if (result.exitCode !== 0) {
      flight.paused.push({ task: entry.task.display_id, engine: entry.engine, stage: 'build', detail: (result.stderr || '').slice(0, 200) });
      log(`    ${entry.engine.padEnd(8)} ✗ build failed ${entry.task.display_id} — worktree kept for takeover`);
      continue;
    }
    log(`    ${entry.engine.padEnd(8)} landing ${entry.task.display_id}...`);
    const landed = land({ entry, result });
    if (landed.ok) {
      flight.landed.push({ task: entry.task.display_id, engine: entry.engine });
      cli(['task', 'ready', String(entry.task.display_id), '--proof', `Built by ${entry.engine} engine in fleet flight, landed via worktree ship gate (rebase-before-ship, verify re-run). Receipt saved at ${path.relative(root, receiptPath)}. Report tail: ${String(result.report || '').slice(-300).replace(/\n/g, ' ')}`, '--as', `fleet-${entry.engine}`]);
      log(`    ${entry.engine.padEnd(8)} ✓ landed ${entry.task.display_id}`);
    } else {
      flight.paused.push({ task: entry.task.display_id, engine: entry.engine, ...landed });
      log(`    ${entry.engine.padEnd(8)} ⏸ paused ${entry.task.display_id} at ${landed.stage}${landed.conflicts ? ` (${landed.conflicts.join(', ')})` : ''} — worktree kept`);
    }
  }

  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  flight.receipt = receiptPath;
  fs.writeFileSync(flight.receipt, `${JSON.stringify(flight, null, 2)}\n`);
  log('');
  log(`  flight over: ${flight.landed.length} landed, ${flight.paused.length} paused · receipt: ${path.relative(root, flight.receipt)}`);
  log('');
  return flight;
}

// ---------------------------------------------------------------------------
// T5 — one-command dispatch: `atris engine dispatch <task-id> --engine <name>`

// The manual version of this loop took 6 Bash calls per task the night this
// was written: claim, worktree start, prompt file, engine -p, verify, ship.
// One or more explicit task ids build in parallel isolated worktrees on ONE
// named engine; landings are serial, reusing the same rebase-before-ship,
// never-auto-resolve contract as the fleet. Unlike the fleet, dispatch
// re-runs the task's own Check: command directly (not just via the ship
// gate) and captures its real output for the ready proof, so proof text cites
// an actual re-runnable verifier instead of an engine's self-report.
async function runDispatchFlight({
  root = process.cwd(),
  taskIds = [],
  engine,
  prompt: promptOverride = '',
  log = console.log,
  ownCli = null,
  dispatcher = null,
  lander = null,
  verifier = null,
  rebase = null,
  checkoutBase = 'origin/master',
} = {}) {
  if (!engine) throw new Error('runDispatchFlight: engine is required');
  if (!FLEET_CAPABLE.includes(engine)) {
    throw new Error(`runDispatchFlight: engine "${engine}" cannot build headlessly (capable: ${FLEET_CAPABLE.join(', ')})`);
  }
  const ids = [...new Set((taskIds || []).map((id) => String(id).trim()).filter(Boolean))];
  if (!ids.length) throw new Error('runDispatchFlight: at least one task id is required');
  if (promptOverride && ids.length > 1) {
    throw new Error('runDispatchFlight: --prompt-file only supports a single task id');
  }

  const cli = ownCli || defaultOwnCli(root);
  const verify = verifier || defaultVerifyRunner;
  const receiptPath = path.join(root, 'atris', 'runs', `dispatch-${nowStamp()}.json`);
  const flight = { at: new Date().toISOString(), root, engine, tasks: ids, results: [], landed: [], paused: [] };

  log('');
  log(`  dispatch — ${ids.length} task${ids.length === 1 ? '' : 's'} -> ${engine}`);
  log('');

  // Same rule as the fleet: dispatch worktrees cut from origin/master by
  // default so rebase-before-ship never replays a launcher feature branch.
  const startBaseArgs = checkoutBase ? ['--base', checkoutBase] : [];
  const prepared = [];
  for (const taskId of ids) {
    const task = readTaskById(cli, taskId);
    if (!task) {
      flight.paused.push({ task: taskId, stage: 'task_lookup', detail: 'task not found' });
      log(`    ✗ ${taskId} not found`);
      continue;
    }
    cli(['task', 'claim', taskId, '--as', `fleet-${engine}`]);
    const started = cli(['worktree', 'start', '--agent', engine, '--task', `dispatch-${taskId.toLowerCase()}`, ...startBaseArgs]);
    const wt = (started.stdout.match(/next: cd (.+)/) || [])[1];
    if (!wt) {
      flight.paused.push({ task: taskId, stage: 'worktree_start', detail: String(started.stderr || '').slice(0, 200) });
      log(`    ✗ ${taskId} worktree start failed`);
      continue;
    }
    prepared.push({ task, taskId, worktreePath: wt.trim() });
    log(`    building ${taskId} in ${path.basename(wt.trim())}`);
  }

  const dispatch = dispatcher || ((entry) => new Promise((resolve) => {
    resolve(dispatchToEngine({
      task: entry.task,
      engine,
      worktreePath: entry.worktreePath,
      root,
      prompt: promptOverride || undefined,
    }));
  }));

  const results = await Promise.all(prepared.map((entry) =>
    dispatch(entry).then((r) => ({ entry, result: r })).catch((err) => ({ entry, result: { exitCode: 1, report: '', stderr: String(err && err.message || err) } }))
  ));
  flight.results = results.map(({ entry, result }) => ({ task: entry.taskId, exitCode: result.exitCode }));

  // Land serially: rebase, re-run Check: for real, ship gate re-verifies,
  // conflict/verify failure pauses (never auto-resolve).
  const rebaseArrival = rebase || landArrival;
  const land = lander || (({ entry }) => {
    const rebased = rebaseArrival({ worktreePath: entry.worktreePath });
    if (!rebased.ok) return rebased;
    const check = dispatchCheck(entry.task) || 'git log -1 --oneline';
    const verified = verify(check, entry.worktreePath);
    if (verified.status !== 0) {
      return {
        ok: false,
        stage: 'verify_failed',
        detail: `${verified.stdout}${verified.stderr}`.slice(-500),
        verifyOutput: `${verified.stdout}${verified.stderr}`,
      };
    }
    const shipped = cli(fleetShipArgs({ task: entry.task, engine }, check), entry.worktreePath);
    if (shipped.status !== 0 || !/done: worktree shipped/.test(shipped.stdout)) {
      return { ok: false, stage: 'ship', detail: (shipped.stderr || shipped.stdout).slice(-500) };
    }
    return { ok: true, stage: 'shipped', check, verifyOutput: `${verified.stdout}${verified.stderr}` };
  });

  for (const { entry, result } of results) {
    if (result.exitCode !== 0) {
      flight.paused.push({ task: entry.taskId, stage: 'build', detail: String(result.stderr || '').slice(0, 300) });
      log(`    ✗ build failed ${entry.taskId} — worktree kept for takeover`);
      continue;
    }
    log(`    landing ${entry.taskId}...`);
    const landed = land({ entry, result });
    if (landed.ok) {
      flight.landed.push({ task: entry.taskId, engine, check: landed.check });
      const verifyTail = String(landed.verifyOutput || '').trim().slice(-1200).replace(/\n/g, ' ');
      cli([
        'task', 'ready', entry.taskId,
        '--proof', `Built by ${engine} engine via atris engine dispatch, landed via worktree ship gate (rebase-before-ship, verify re-run). Check re-run: ${landed.check}. Verify output: ${verifyTail || '(command produced no output, exit 0)'}. Receipt saved at ${path.relative(root, receiptPath)}.`,
        '--as', `fleet-${engine}`,
      ]);
      log(`    ✓ landed ${entry.taskId}`);
    } else {
      flight.paused.push({ task: entry.taskId, engine, ...landed });
      log(`    ⏸ paused ${entry.taskId} at ${landed.stage}${landed.conflicts ? ` (${landed.conflicts.join(', ')})` : ''} — worktree kept`);
    }
  }

  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  flight.receipt = receiptPath;
  fs.writeFileSync(flight.receipt, `${JSON.stringify(flight, null, 2)}\n`);
  log('');
  log(`  dispatch over: ${flight.landed.length} landed, ${flight.paused.length} paused · receipt: ${path.relative(root, flight.receipt)}`);
  log('');
  return flight;
}
