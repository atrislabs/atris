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
// injectable for tests.
function dispatchToEngine({ task, engine, worktreePath, timeoutMs = 900000, runner = null }) {
  const prompt = buildFleetPrompt(task, { worktreePath });
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
  const fromTitle = (String(task.title || '').match(/#([a-z0-9-]+)/gi) || []).map((t) => t.slice(1));
  return [...fromTags, ...fromTitle].map((t) => String(t).toLowerCase());
}

function isSafeLane(task) {
  const tags = taskTags(task);
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
  parseDoneCheck,
  buildFleetPrompt,
  buildEngineCommand,
  dispatchToEngine,
  taskTags,
  isSafeLane,
  fileSurface,
  surfacesOverlap,
  staffFlight,
  assignEngines,
  landArrival,
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
  const m = check.match(/node --test [^,;.]+/);
  return m ? m[0].trim() : '';
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
} = {}) {
  const cli = ownCli || defaultOwnCli(root);
  const roster = engines || (() => {
    const { roster: fullRoster } = require('../commands/engine');
    return fullRoster(root).filter((e) => e.installed && FLEET_CAPABLE.includes(e.name)).map((e) => e.name);
  })();

  const staffed = assignEngines(staffFlight(readProjectionTasks(root), { slots }), roster);
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
    resolve(dispatchToEngine({ task: entry.task, engine: entry.engine, worktreePath: entry.worktreePath }));
  }));

  const prepared = [];
  for (const entry of staffed) {
    cli(['task', 'claim', String(entry.task.display_id), '--as', `fleet-${entry.engine}`]);
    const started = cli(['worktree', 'start', '--agent', entry.engine, '--task', `fleet-${String(entry.task.display_id).toLowerCase()}`]);
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
    const shipped = cli(['worktree', 'ship', '--message', `${String(entry.task.title || '').split(/[.:]/)[0].slice(0, 90)} (${entry.task.display_id}, built by ${entry.engine})`, '--verify', check, '--merge'], entry.worktreePath);
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
      cli(['task', 'ready', String(entry.task.display_id), '--proof', `Built by ${entry.engine} engine in fleet flight, landed via worktree ship gate (rebase-before-ship, verify re-run). Report tail: ${String(result.report || '').slice(-300).replace(/\n/g, ' ')}`, '--as', `fleet-${entry.engine}`]);
      log(`    ${entry.engine.padEnd(8)} ✓ landed ${entry.task.display_id}`);
    } else {
      flight.paused.push({ task: entry.task.display_id, engine: entry.engine, ...landed });
      log(`    ${entry.engine.padEnd(8)} ⏸ paused ${entry.task.display_id} at ${landed.stage}${landed.conflicts ? ` (${landed.conflicts.join(', ')})` : ''} — worktree kept`);
    }
  }

  const receiptDir = path.join(root, 'atris', 'runs');
  fs.mkdirSync(receiptDir, { recursive: true });
  flight.receipt = path.join(receiptDir, `fleet-${nowStamp()}.json`);
  fs.writeFileSync(flight.receipt, `${JSON.stringify(flight, null, 2)}\n`);
  log('');
  log(`  flight over: ${flight.landed.length} landed, ${flight.paused.length} paused · receipt: ${path.relative(root, flight.receipt)}`);
  log('');
  return flight;
}
