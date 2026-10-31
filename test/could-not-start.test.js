'use strict';

// A job the build machine could not start is nobody's miss.
//
// On 2026-10-31 a dispatch claimed a job, `worktree start` refused because the disk had
// under 10 GB free, the flight let the claim go, and `atris rating` scored that release as
// a drop against fleet-codex, which never touched the work. Three changes close it:
//
//   One.   Both flights look at the disk once, before they claim anything, with worktree
//          start's own check and reaping. Under the floor they stop with one plain line
//          and exit 2, the way worktree start does, and write nothing to any job.
//   Two.   A claim let go before the engine ran carries a kind, could_not_start, as a
//          field on the release. Only the flights write it, in their own process.
//   Three. The rating reads that field and counts the job as neither a miss nor finished,
//          and says so in its own line.
//
// The kind is only as honest as the claim it rides on, so the flights keep it honest (a review of the
// first version found four ways it was not):
//
//   - A builder cannot excuse its own miss. Right before the assigned engine is asked, the flight marks the
//     claim started (a build_started event). The store drops the kind from a release of a marked claim, and the
//     rating reads the same rule. A scout or prep pass before the builder never counts as the builder starting.
//   - A job is let go at the point it fails to start, not at the end of the flight, and a lease that throws is
//     caught the same way, so a failure on one job cannot leave another job's claim to run out as a miss.
//   - Every release checks the job is still held under the claim this flight made, and the check is part of the
//     write itself, on the claim's own event id. A job another run claimed since, under the same builder name,
//     is left alone with one plain line. The flights let go of their claims in their own process for that; only
//     a job the store holds no claim of (a stand-in task plane) still goes through the task command.
//   - A sealed review sandbox that could not be prepared is the machine's failure too, and carries the kind.
//
// And a second review found four more holes, closed here:
//
//   - A lost claim means stop. A flight that has lost its claim by the time it is about to ask the engine stops
//     there: the engine is not asked, nothing more is written to the job, and one plain line says so.
//   - The release is a compare-and-set on the claim event, in one statement, not a look followed by a write.
//   - The rating's two-minute hand-over rule is kept for old history, but a release on a claim the engine started
//     is a real miss whoever claims next, and a release that could not start keeps its own line.
//   - A release the store failed is tried again by the closing pass, and a job that throws in its attempt (a retry
//     brief that cannot be written) lets its claim go where it failed instead of ending the run with claims held.
//
// A third review found five windows left between a look and a write, closed here:
//
//   - The start check runs before every engine start, not only the first. A retry on another engine after a dead
//     one, and a handover to the next worker, mark the current claim first and stop the same way if it is lost.
//   - A flight claims a job the store holds in its own process and takes the claim's name from the claim write
//     itself, so there is no moment between claiming and learning which claim is its own. A flight with no name for
//     its claim leaves the job alone with one plain line, and never falls back to a release that names no claim.
//   - A lease is written, renewed and cleared only while the job is held under the claim the writer names, so an
//     older claim, even by the same builder, can never replace or clear the lease of the one after it.
//   - A claim and its history entry are one transaction, and so are a release and its entry: a check cannot pass
//     against a claim whose entry is not in the store yet, and an entry that cannot be saved takes the change back.
//
// A fourth review found two things the flight's own claim took away from the task command's:
//
//   - The task command clears the claims that have run out before it claims anything, so a job whose old claim was
//     dead was cleared and claimed in one go. The claim in the flight's own process runs the same step, the store's
//     own function, before every claim in both flights: the same reach (every claim that has run out) and the same
//     history (a claim_expired entry for each).
//   - The commit a claim records as the job's start is read with the write lock held, not before it, so a commit
//     that lands in the checkout while the claim waits for the lock is the start, and a job that makes no commit
//     after that is not credited with it when its landing is checked.
//
// The disk check before any claim asks about the folder the build will really use, which for a sealed
// review-only flight is the temp folder.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const tasks = require('../lib/task-db');
const fleet = require('../lib/fleet');
const { readEngineRegistry, setEngineHealth } = require('../lib/engine-registry');
const { lowDiskRefusal } = require('../commands/worktree');
const { loadSeason, rosterRows, lastPlays } = require('../lib/gm-season');
const { atrisRating } = require('../lib/atris-rating');
const { COULD_NOT_START, isCouldNotStart } = require('../lib/release-kind');
const { ratingCommand } = require('../commands/rating');
const { scrubAgentEnv } = require('./helpers/agent-env');
const { proveTaskLanding } = require('../lib/landing-proof');

const CLI = path.resolve(__dirname, '..', 'bin', 'atris.js');
const TITLE = 'Fix the form so people stop retyping. Done: the form keeps what was typed. Check: node --test test/form.test.js.';
const TIGHT = () => 4e9;
const ROOMY = () => 50e9;
const LOW_DISK_LINE = /only 4\.0 GB free on this disk, and a new build copy needs at least 10\.0 GB/;
const REFUSAL = 'refusing: only 4.0 GB free on this disk';
const PR_URL = 'https://github.example/repo/pull/77';

// ---------------------------------------------------------------------------
// Fixtures: a workspace with a git checkout and a task store of its own.

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return String(result.stdout || '').trim();
}

// A checkout at <ws>/<name> with an origin next to it, like ~/arena.
function makeRepo(ws, name) {
  const root = path.join(ws, name);
  fs.mkdirSync(root);
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test User']);
  fs.writeFileSync(path.join(root, '.gitignore'), '.atris/\n');
  fs.writeFileSync(path.join(root, 'README.md'), `${name}\n`);
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'init']);
  git(root, ['branch', '-M', 'master']);
  const remote = path.join(ws, `${name}-origin.git`);
  git(ws, ['init', '--bare', '-q', remote]);
  git(root, ['remote', 'add', 'origin', remote]);
  git(root, ['push', '-q', '-u', 'origin', 'master']);
  git(root, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/master']);
  return root;
}

// A build copy under <ws>/.agent-worktrees/<repo>/<name>, level with origin and idle for hours:
// the kind of finished copy a low disk reaps.
function addCopy(root, name, { idleHours = 0 } = {}) {
  const copy = path.join(path.dirname(root), '.agent-worktrees', path.basename(root), name);
  fs.mkdirSync(path.dirname(copy), { recursive: true });
  git(root, ['worktree', 'add', '-q', '-b', `codex/${name}`, copy, 'origin/master']);
  if (idleHours) {
    const stamp = new Date(Date.now() - idleHours * 60 * 60 * 1000);
    const gitDir = path.resolve(copy, git(copy, ['rev-parse', '--git-dir']));
    for (const mark of [copy, path.join(gitDir, 'HEAD'), path.join(gitDir, 'logs', 'HEAD')]) {
      if (fs.existsSync(mark)) fs.utimesSync(mark, stamp, stamp);
    }
  }
  return copy;
}

// app is where the flight runs. other is a second checkout that can hold a finished copy. The task
// store is the sandbox's own, found by env the way the flight finds it.
function sandbox(t, { other = false } = {}) {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'could-not-start-')));
  const saved = process.env.ATRIS_TASKS_DB;
  process.env.ATRIS_TASKS_DB = path.join(ws, 'tasks.db');
  t.after(() => {
    tasks.close();
    if (saved === undefined) delete process.env.ATRIS_TASKS_DB; else process.env.ATRIS_TASKS_DB = saved;
    fs.rmSync(ws, { recursive: true, force: true });
  });
  const app = makeRepo(ws, 'app');
  return {
    t,
    ws,
    app,
    other: other ? makeRepo(ws, 'other') : null,
    db: tasks.open(),
    workspace: tasks.workspaceRoot(app),
    dbPath: process.env.ATRIS_TASKS_DB,
  };
}

// A job in the sandbox's workspace, as the task command would show it. claimedBy takes it as that builder.
// Display ids are numbered by creation time to the millisecond, and a tie falls to the random row id, so two
// jobs added in the same millisecond could swap numbers (and share one). Each job waits for the clock to move.
let lastJobAddedAt = 0;
function addJob(ctx, { title = TITLE, claimedBy = null } = {}) {
  while (Date.now() <= lastJobAddedAt) { /* wait for the next millisecond */ }
  lastJobAddedAt = Date.now();
  const { id } = tasks.addTask(ctx.db, { title, workspaceRoot: ctx.workspace });
  if (claimedBy) assert.equal(tasks.claimTask(ctx.db, { id, claimedBy, leaseMinutes: 60, leasePid: process.pid }).claimed, true);
  const shown = tasks.withTaskDisplayRefs(tasks.listTasks(ctx.db, { workspaceRoot: ctx.workspace })).find((row) => row.id === id);
  return { id, display_id: shown.display_id, workspace_root: ctx.workspace, status: 'open', title };
}

// A claim whose lease ran out hours ago: the next sweep of expired claims would write to it.
function lapse(db, id) {
  const until = new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString();
  db.prepare("UPDATE tasks SET metadata = json_set(COALESCE(metadata, '{}'), '$.lease.until', ?) WHERE id = ?").run(until, id);
}

// The task commands a flight sends, answered here by the sandbox store the way the real commands answer
// them: a claim claims the row, a release releases it with no kind. worktreeStart answers `worktree start`.
// afterClaim runs once a claim has landed in the store, which is where a test spoils what the flight does next. A
// flight claims a job the store holds in its own process, so the claim never reaches this stand-in; the hook rides
// on the store's claim instead, and fires for the flight's claim wherever it is made.
function taskPlane(ctx, jobs, { worktreeStart = null, afterClaim = null } = {}) {
  const calls = [];
  if (afterClaim) {
    const claimTask = tasks.claimTask;
    ctx.t.mock.method(tasks, 'claimTask', (db, args) => {
      const claim = claimTask(db, args);
      if (claim.claimed) afterClaim(args.id);
      return claim;
    });
  }
  const cli = (args) => {
    calls.push(args);
    const flag = (name) => args[args.indexOf(name) + 1];
    if (args[0] === 'task' && args[1] === 'show') {
      const job = jobs.find((row) => row.display_id === args[2]);
      return job ? { status: 0, stdout: JSON.stringify(job), stderr: '' } : { status: 1, stdout: '', stderr: 'not found' };
    }
    // A job the store has no row for (a stand-in task plane shows none) is claimed and released in name only.
    const known = tasks.getTask(ctx.db, args[2] || 'none');
    if (args[0] === 'task' && args[1] === 'claim' && !known) return { status: 0, stdout: 'claimed', stderr: '' };
    if (args[0] === 'task' && args[1] === 'release' && !known) return { status: 0, stdout: 'released', stderr: '' };
    if (args[0] === 'task' && args[1] === 'claim') {
      const claim = tasks.claimTask(ctx.db, { id: args[2], claimedBy: flag('--as'), leaseMinutes: 60, leasePid: process.pid });
      return claim.claimed ? { status: 0, stdout: 'claimed', stderr: '' } : { status: 1, stdout: '', stderr: `claim failed: ${claim.reason}` };
    }
    if (args[0] === 'task' && args[1] === 'release') {
      const result = tasks.releaseTask(ctx.db, { id: args[2], actor: flag('--as'), reason: flag('--reason') });
      return result.released ? { status: 0, stdout: 'released', stderr: '' } : { status: 1, stdout: '', stderr: `release failed: ${result.reason}` };
    }
    if (args[0] === 'worktree' && args[1] === 'start') {
      if (worktreeStart) return worktreeStart(args);
      return { status: 0, stdout: `next: cd /wt/${flag('--task')}\n`, stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  return { cli, calls };
}

const callsTo = (plane, ...words) => plane.calls.filter((args) => words.every((word, i) => args[i] === word));
const refuse = () => ({ status: 2, stdout: '', stderr: REFUSAL });
const spoilMetadata = (ctx) => (id) => ctx.db.prepare("UPDATE tasks SET metadata = 'not json' WHERE id = ?").run(id);

// The engine stand-in: it records what it was asked to build and answers as the test says.
function engineStandIn(answer = { exitCode: 0, report: 'engine report' }) {
  const ran = [];
  return { ran, dispatcher: (entry) => { ran.push(entry.task.display_id); return Promise.resolve(answer); } };
}

// The dispatch flight over one job. options go to the flight as they are.
async function flyDispatch(ctx, plane, job, { engine = engineStandIn(), ...options } = {}) {
  const logs = [];
  const flight = await fleet.runDispatchFlight({
    root: ctx.app,
    taskIds: [job.display_id],
    engine: 'codex',
    ownCli: plane.cli,
    dispatcher: engine.dispatcher,
    rebase: () => ({ ok: true, stage: 'rebased' }),
    verifier: () => ({ status: 0, stdout: '# tests 3\n# pass 3\n# fail 0\n', stderr: '' }),
    log: (line = '') => logs.push(String(line)),
    ...options,
  });
  return { flight, logs, ran: engine.ran };
}

// The fleet flight over a task list file that names these jobs as open.
async function flyFleet(ctx, plane, jobs, { engine = engineStandIn(), ...options } = {}) {
  const file = path.join(ctx.app, '.atris', 'state', 'tasks.projection.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ tasks: jobs }, null, 2)}\n`);
  const logs = [];
  const flight = await fleet.runFleetFlight({
    root: ctx.app,
    engines: ['codex'],
    ownCli: plane.cli,
    dispatcher: engine.dispatcher,
    lander: () => ({ ok: true, stage: 'shipped' }),
    guardCliLink: () => ({ changed: false, ok: true }),
    log: (line = '') => logs.push(String(line)),
    ...options,
  });
  return { flight, logs, ran: engine.ran };
}

const eventTotal = (db) => db.prepare('SELECT COUNT(*) AS n FROM task_events').get().n;
const releaseEvents = (db, id) => db.prepare("SELECT payload FROM task_events WHERE task_id = ? AND event_type = 'claim_released' ORDER BY version").all(id).map((row) => JSON.parse(row.payload));
const seasonOf = (ctx) => {
  const season = loadSeason(ctx.workspace, { dbPath: ctx.dbPath, now: Date.now() + 1000, lastSeen: null });
  assert.equal(season.error, undefined);
  return season;
};
const playsOf = (season, id) => season.outcomes.filter((o) => o.task_id === id);
const memberRow = (season, name) => rosterRows({ outcomes: season.outcomes, limit: Number.MAX_SAFE_INTEGER }).find((row) => row.name === name);

// ---------------------------------------------------------------------------
// One. A flight looks at the disk once, before it claims anything.

test('lowDiskRefusal asks worktree start\'s own question, with the same floor: the free space and what a build copy needs', (t) => {
  const { app } = sandbox(t);
  const ask = (options) => lowDiskRefusal({ root: app, agent: 'codex', task: 'flight', spaceGuard: true, env: {}, ...options });

  const refused = ask({ freeSpace: TIGHT });
  assert.match(refused.message, LOW_DISK_LINE);
  assert.equal(refused.free, 4e9);
  assert.equal(refused.needs, 10e9);

  assert.equal(ask({ freeSpace: ROOMY }), null);
  // The floor is worktree start's, so its own setting moves it here too.
  assert.equal(ask({ freeSpace: TIGHT, env: { ATRIS_WORKTREE_MIN_FREE_GB: '3' } }), null);
  // A disk that cannot be read refuses nothing.
  assert.equal(ask({ freeSpace: () => null }), null);
  // Temp folders hold test fixtures, and worktree start leaves them alone; so does this.
  assert.equal(lowDiskRefusal({ root: app, agent: 'codex', task: 'flight', freeSpace: TIGHT, env: {} }), null);
});

test('the dispatch flight stops before it claims anything when the disk is under the floor: one plain line, the reaping worktree start does, and nothing written to any job', async (t) => {
  const ctx = sandbox(t, { other: true });
  const finished = addCopy(ctx.other, 'finished', { idleHours: 3 });
  const job = addJob(ctx);
  const stale = addJob(ctx, { claimedBy: 'fleet-gemini' });
  lapse(ctx.db, stale.id);
  assert.equal(tasks.expireLeases(ctx.db, { dryRun: true }).length, 1, 'a sweep of expired claims would write to that job');
  const before = eventTotal(ctx.db);

  const plane = taskPlane(ctx, [job]);
  const { flight, logs, ran } = await flyDispatch(ctx, plane, job, { freeSpace: TIGHT, spaceGuard: true });

  assert.deepEqual(plane.calls, [], 'no task command and no worktree command was sent');
  assert.deepEqual(ran, []);
  assert.equal(eventTotal(ctx.db), before, 'nothing was written to any job, not even the sweep of expired claims');
  assert.equal(tasks.getTask(ctx.db, job.id).status, 'open');
  assert.equal(tasks.getTask(ctx.db, stale.id).status, 'claimed');

  // The reaping is worktree start's: the finished copy in the other checkout is gone.
  assert.equal(fs.existsSync(finished), false);
  const lines = logs.filter((line) => line.trim());
  assert.equal(lines.length, 1, logs.join('\n'));
  assert.match(lines[0], LOW_DISK_LINE);
  assert.match(lines[0], /Removed 1 finished build copy first/);

  assert.equal(flight.refusal.reason, 'low_disk');
  assert.match(flight.refusal.detail, LOW_DISK_LINE);
  assert.equal(flight.refusal.free_bytes, 4e9);
  assert.equal(flight.refusal.needs_bytes, 10e9);
  assert.equal(flight.status, 'failed');
  assert.deepEqual(flight.paused.map((row) => [row.task, row.stage]), [[job.display_id, 'low_disk']]);
  assert.deepEqual([flight.landed, flight.ready, flight.results], [[], [], []]);
  assert.equal(flight.receipt, undefined, 'a flight that did nothing leaves no receipt');
  assert.equal(fs.existsSync(path.join(ctx.app, 'atris', 'runs')), false);
  // The command that ran the flight exits the way worktree start does on a low disk.
  assert.equal(fleet.flightExitCode(flight), 2);
});

test('the fleet flight stops before it claims anything when the disk is under the floor, the same way', async (t) => {
  const ctx = sandbox(t, { other: true });
  const finished = addCopy(ctx.other, 'finished', { idleHours: 3 });
  const job = addJob(ctx);
  const stale = addJob(ctx, { claimedBy: 'fleet-gemini' });
  lapse(ctx.db, stale.id);
  const before = eventTotal(ctx.db);

  const plane = taskPlane(ctx, [job]);
  const { flight, logs, ran } = await flyFleet(ctx, plane, [job], { freeSpace: TIGHT, spaceGuard: true });

  assert.deepEqual(plane.calls, [], 'no task command and no worktree command was sent');
  assert.deepEqual(ran, []);
  assert.equal(eventTotal(ctx.db), before, 'nothing was written to any job');
  assert.equal(tasks.getTask(ctx.db, job.id).status, 'open');
  assert.equal(fs.existsSync(finished), false, 'the reaping worktree start does ran first');

  const said = logs.filter((line) => /GB/.test(line));
  assert.equal(said.length, 1, logs.join('\n'));
  assert.match(said[0], LOW_DISK_LINE);
  assert.match(said[0], /Removed 1 finished build copy first/);

  assert.equal(flight.refusal.reason, 'low_disk');
  assert.equal(flight.refusal.free_bytes, 4e9);
  assert.equal(flight.refusal.needs_bytes, 10e9);
  assert.deepEqual(flight.paused.map((row) => [row.task, row.engine, row.stage]), [[job.display_id, 'codex', 'low_disk']]);
  assert.deepEqual([flight.landed, flight.results], [[], []]);
  assert.equal(fs.existsSync(path.join(ctx.app, 'atris', 'runs')), false, 'no receipt was written');
  assert.equal(fleet.flightExitCode(flight), 2);
});

test('a preview claims nothing, so a full disk does not stop it; an ordinary flight keeps its own exit codes', async (t) => {
  const ctx = sandbox(t);
  const job = addJob(ctx);
  const plane = taskPlane(ctx, [job]);
  const { flight } = await flyFleet(ctx, plane, [job], { dryRun: true, freeSpace: TIGHT, spaceGuard: true });
  assert.equal(flight.dry_run, true);
  assert.equal(flight.refusal, undefined);
  assert.deepEqual(plane.calls, []);

  assert.equal(fleet.flightExitCode(flight), 0);
  assert.equal(fleet.flightExitCode({ paused: [{ task: 'BCK-1', stage: 'ship' }] }), 1);
  assert.equal(fleet.flightExitCode({ paused: [], landed: [{ task: 'BCK-1' }] }), 0);
});

// ---------------------------------------------------------------------------
// A disk with room changes nothing, and a claim let go after the engine ran is an ordinary release.

test('with room on the disk the dispatch flight goes on as before, and a claim let go after the engine ran is a plain release, still a drop', async (t) => {
  const ctx = sandbox(t);
  const job = addJob(ctx);
  const plane = taskPlane(ctx, [job]);
  const engine = engineStandIn({ exitCode: 1, report: '', stderr: 'boom' });
  const { flight, ran } = await flyDispatch(ctx, plane, job, { engine, installedEngines: [], freeSpace: ROOMY, spaceGuard: true });

  assert.equal(flight.refusal, undefined);
  assert.deepEqual(ran, [job.display_id], 'the engine ran');
  assert.deepEqual(flight.paused.map((row) => row.stage), ['build']);
  assert.deepEqual(callsTo(plane, 'task', 'release'), [], 'let go in the flight\'s own process, on the claim it made, not through the task command');
  assert.deepEqual(releaseEvents(ctx.db, job.id).map((event) => event.kind), [undefined]);
  assert.deepEqual(playsOf(seasonOf(ctx), job.id).map((o) => o.kind), ['took', 'dropped']);
  assert.equal(fleet.flightExitCode(flight), 1);
});

test('with room on the disk the fleet flight goes on as before, and a claim let go after the engine ran is a plain release, still a drop', async (t) => {
  const ctx = sandbox(t);
  const clean = addCopy(ctx.app, 'clean');
  const job = addJob(ctx);
  const plane = taskPlane(ctx, [job], { worktreeStart: () => ({ status: 0, stdout: `next: cd ${clean}\n`, stderr: '' }) });
  const engine = engineStandIn({ exitCode: 1, report: '', stderr: 'boom' });
  const { flight, ran } = await flyFleet(ctx, plane, [job], { engine, freeSpace: ROOMY, spaceGuard: true });

  assert.equal(flight.refusal, undefined);
  assert.deepEqual(ran, [job.display_id], 'the engine ran');
  assert.deepEqual(flight.paused.map((row) => row.stage), ['build']);
  assert.equal(flight.paused[0].claim_released, true);
  assert.deepEqual(callsTo(plane, 'task', 'release'), [], 'let go in the flight\'s own process, on the claim it made, not through the task command');
  assert.deepEqual(releaseEvents(ctx.db, job.id).map((event) => event.kind), [undefined]);
  assert.deepEqual(playsOf(seasonOf(ctx), job.id).map((o) => o.kind), ['took', 'dropped']);
});

// ---------------------------------------------------------------------------
// Two. A claim let go before the engine ran says so, in a field.

test('a release can say the job could not start, as a field on the event; other kinds, half a marker and the task command say nothing of the kind', (t) => {
  const ctx = sandbox(t);
  const claimed = (title) => addJob(ctx, { title, claimedBy: 'fleet-codex' });
  const reason = `paused at worktree start: ${REFUSAL}`;

  const job = claimed('one');
  const released = tasks.releaseTask(ctx.db, { id: job.id, actor: 'fleet-codex', reason, kind: COULD_NOT_START });
  assert.equal(released.released, true, JSON.stringify(released));
  assert.deepEqual(releaseEvents(ctx.db, job.id), [{ released_by: 'fleet-codex', previous_claimed_by: 'fleet-codex', reason, kind: 'could_not_start' }]);
  assert.equal(isCouldNotStart(releaseEvents(ctx.db, job.id)[0]), true);
  for (const payload of [null, undefined, [], {}, { kind: 'proof_not_saved' }, { reason }, { kind: 'Could_Not_Start' }]) {
    assert.equal(isCouldNotStart(payload), false, JSON.stringify(payload));
  }

  // The store refuses a kind it does not know, and this kind with a pull request beside it. The claim stays as it was.
  const kept = claimed('two');
  for (const marker of [{ kind: 'made_up' }, { kind: COULD_NOT_START, pullRequest: { number: 77, url: PR_URL } }, { pullRequest: { number: 77, url: PR_URL } }]) {
    assert.deepEqual(tasks.releaseTask(ctx.db, { id: kept.id, actor: 'fleet-codex', ...marker }), { released: false, reason: 'invalid_release_marker' });
  }
  assert.equal(tasks.getTask(ctx.db, kept.id).status, 'claimed');
  assert.deepEqual(releaseEvents(ctx.db, kept.id), []);

  // A plain release says nothing of the kind.
  const plain = claimed('three');
  assert.equal(tasks.releaseTask(ctx.db, { id: plain.id, actor: 'fleet-codex', reason }).released, true);
  assert.deepEqual(releaseEvents(ctx.db, plain.id), [{ released_by: 'fleet-codex', previous_claimed_by: 'fleet-codex', reason }]);

  // The task command still takes no kind: a worker holding a failed job could type one to excuse its own miss.
  const typed = claimed('four');
  const run = spawnSync(process.execPath, [CLI, 'task', 'release', typed.id, '--as', 'fleet-codex', '--kind', COULD_NOT_START, '--reason', reason], {
    cwd: ctx.app,
    encoding: 'utf8',
    timeout: 30000,
    env: { ...scrubAgentEnv(), ATRIS_TASKS_DB: ctx.dbPath, ATRIS_SKIP_UPDATE_CHECK: '1', NODE_NO_WARNINGS: '1' },
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.deepEqual(releaseEvents(ctx.db, typed.id), [{ released_by: 'fleet-codex', previous_claimed_by: 'fleet-codex', reason }]);
  assert.deepEqual(playsOf(seasonOf(ctx), typed.id).map((o) => o.kind), ['took', 'dropped']);
});

// Every way the dispatch flight lets a claim go before its engine ran. The reason text is what the flight
// always wrote for it.
const DISPATCH_NEVER_STARTED = [
  ['worktree start refuses', (ctx) => ({ worktreeStart: refuse }), 'worktree_start', `paused at worktree start: ${REFUSAL}`],
  ['preparing the job throws', (ctx) => ({ worktreeStart: () => { throw new Error('spawn EMFILE'); } }), 'prepare', 'paused at prepare: spawn EMFILE'],
  ['the claim lease cannot be set', (ctx) => ({ afterClaim: spoilMetadata(ctx) }), 'prepare', 'paused at prepare: could not set claim lease'],
];

for (const [label, plan, stage, reason] of DISPATCH_NEVER_STARTED) {
  test(`dispatch: when ${label}, the flight lets the claim go itself as one that could not start, with the reason it always wrote`, async (t) => {
    const ctx = sandbox(t);
    const job = addJob(ctx);
    const plane = taskPlane(ctx, [job], plan(ctx));
    const { flight, ran } = await flyDispatch(ctx, plane, job);

    assert.deepEqual(ran, [], 'the engine never ran');
    // Not through the task command, which takes no kind.
    assert.deepEqual(callsTo(plane, 'task', 'release'), []);
    assert.equal(tasks.getTask(ctx.db, job.id).status, 'open');
    assert.equal(tasks.getTask(ctx.db, job.id).claimed_by, null);
    assert.deepEqual(releaseEvents(ctx.db, job.id), [{ released_by: 'fleet-codex', previous_claimed_by: 'fleet-codex', reason, kind: 'could_not_start' }]);

    assert.deepEqual(flight.paused.map((row) => [row.task, row.stage, row.claim_released]), [[job.display_id, stage, true]]);
    assert.match(flight.paused[0].detail, /claim released, safe to retry$/);
    assert.equal(flight.status, 'failed');

    // The rating: no drop, nothing finished, and the job is counted in its own place.
    const season = seasonOf(ctx);
    assert.deepEqual(playsOf(season, job.id).map((o) => o.kind), ['took', 'could_not_start']);
    const member = memberRow(season, 'fleet-codex');
    assert.deepEqual([member.could_not_start, member.dropped, member.finished], [1, 0, 0]);
  });
}

test('dispatch: a brief that cannot be written lets that claim go as one that could not start, instead of leaving it to expire, and the flight finishes', async (t) => {
  const ctx = sandbox(t);
  // A folder where the brief ledger's file belongs: writing the brief fails before the engine is asked.
  fs.mkdirSync(path.join(ctx.app, '.atris', 'state', 'briefs.jsonl'), { recursive: true });
  const job = addJob(ctx);
  const plane = taskPlane(ctx, [job]);
  const { flight, ran } = await flyDispatch(ctx, plane, job);

  assert.deepEqual(ran, [], 'the engine never ran');
  assert.deepEqual(callsTo(plane, 'task', 'release'), []);
  assert.equal(tasks.getTask(ctx.db, job.id).status, 'open');
  const [event, ...more] = releaseEvents(ctx.db, job.id);
  assert.deepEqual(more, []);
  assert.equal(event.kind, 'could_not_start');
  assert.match(event.reason, /^paused at brief capture: /);
  assert.deepEqual(flight.paused.map((row) => [row.task, row.stage, row.claim_released]), [[job.display_id, 'brief_capture', true]]);
  assert.equal(flight.status, 'failed');
  assert.deepEqual(playsOf(seasonOf(ctx), job.id).map((o) => o.kind), ['took', 'could_not_start']);
});

// The fleet flight lets a claim go where the job fails to start, in its own process.
const FLEET_NEVER_STARTED = [
  ['worktree start refuses', () => ({ worktreeStart: refuse }), 'worktree_start', `paused at worktree start: ${REFUSAL}`],
  ['the claim lease cannot be set', (ctx) => ({ afterClaim: spoilMetadata(ctx) }), 'prepare', 'paused at prepare: could not set claim lease'],
];

for (const [label, plan, stage, reason] of FLEET_NEVER_STARTED) {
  test(`fleet: when ${label}, the flight lets the claim go itself as one that could not start, with the reason it always wrote`, async (t) => {
    const ctx = sandbox(t);
    const job = addJob(ctx);
    const plane = taskPlane(ctx, [job], plan(ctx));
    // The flight must finish: a lease that cannot be set used to throw out of the whole flight and leave the claim to expire.
    const { flight, ran } = await flyFleet(ctx, plane, [job]);

    assert.deepEqual(ran, [], 'the engine never ran');
    assert.deepEqual(callsTo(plane, 'task', 'release'), [], 'the flight records this release in its own process');
    assert.equal(tasks.getTask(ctx.db, job.id).status, 'open');
    assert.deepEqual(releaseEvents(ctx.db, job.id), [{ released_by: 'fleet-codex', previous_claimed_by: 'fleet-codex', reason, kind: 'could_not_start' }]);
    assert.deepEqual(flight.paused.map((row) => [row.task, row.stage, row.claim_released]), [[job.display_id, stage, true]]);
    assert.equal(flight.status, 'failed');

    const member = memberRow(seasonOf(ctx), 'fleet-codex');
    assert.deepEqual([member.could_not_start, member.dropped, member.finished], [1, 0, 0]);
  });
}

test('fleet: a brief that cannot be written lets that claim go as one that could not start, and the flight finishes', async (t) => {
  const ctx = sandbox(t);
  const clean = addCopy(ctx.app, 'clean');
  fs.mkdirSync(path.join(ctx.app, '.atris', 'state', 'briefs.jsonl'), { recursive: true });
  const job = addJob(ctx);
  const plane = taskPlane(ctx, [job], { worktreeStart: () => ({ status: 0, stdout: `next: cd ${clean}\n`, stderr: '' }) });
  const { flight, ran } = await flyFleet(ctx, plane, [job]);

  assert.deepEqual(ran, [], 'the engine never ran');
  assert.deepEqual(callsTo(plane, 'task', 'release'), []);
  assert.equal(tasks.getTask(ctx.db, job.id).status, 'open');
  const [event, ...more] = releaseEvents(ctx.db, job.id);
  assert.deepEqual(more, []);
  assert.equal(event.kind, 'could_not_start');
  assert.match(event.reason, /^paused at brief capture: /);
  assert.deepEqual(flight.paused.map((row) => [row.task, row.engine, row.stage, row.claim_released]), [[job.display_id, 'codex', 'brief_capture', true]]);
  assert.deepEqual(playsOf(seasonOf(ctx), job.id).map((o) => o.kind), ['took', 'could_not_start']);
});

// A claim let go in the flight's own process is drawn into the two files people read, the way the
// release command leaves them: the task list file, and atris/TODO.md in the flight's workspace.
const listFileOf = (ctx) => path.join(ctx.app, '.atris', 'state', 'tasks.projection.json');
const todoFileOf = (ctx) => path.join(ctx.workspace, 'atris', 'TODO.md');
const listedJob = (ctx, id) => JSON.parse(fs.readFileSync(listFileOf(ctx), 'utf8')).tasks.find((row) => row.id === id);
const todoSection = (ctx, name) => {
  const lines = fs.readFileSync(todoFileOf(ctx), 'utf8').split('\n');
  const from = lines.indexOf(`## ${name}`);
  assert.ok(from >= 0, `${name} is in TODO.md`);
  const next = lines.findIndex((line, at) => at > from && line.startsWith('## '));
  return lines.slice(from + 1, next < 0 ? undefined : next).join('\n').trim();
};
// The files as the claim command leaves them: drawn from the saved state, with the job claimed.
function drawList(ctx) {
  fs.mkdirSync(path.dirname(listFileOf(ctx)), { recursive: true });
  fs.writeFileSync(listFileOf(ctx), `${JSON.stringify(tasks.taskProjection(ctx.db, { workspaceRoot: ctx.workspace, limit: 500 }), null, 2)}\n`);
}
function drawTodo(ctx) {
  fs.mkdirSync(path.dirname(todoFileOf(ctx)), { recursive: true });
  fs.writeFileSync(todoFileOf(ctx), tasks.renderTodoMarkdown(
    tasks.listTasks(ctx.db, { workspaceRoot: ctx.workspace, limit: 500 }),
    { refRows: tasks.listTasks(ctx.db, { workspaceRoot: ctx.workspace }) },
  ));
}

test('dispatch: a claim let go as one that could not start is drawn into the task list file and atris/TODO.md as open again, as the release command leaves them', async (t) => {
  const ctx = sandbox(t);
  const job = addJob(ctx);
  let claimedInFiles = false;
  const plane = taskPlane(ctx, [job], {
    worktreeStart: refuse,
    afterClaim: () => {
      drawList(ctx);
      drawTodo(ctx);
      claimedInFiles = listedJob(ctx, job.id).status === 'claimed' && todoSection(ctx, 'In Progress').includes(`[${job.display_id}]`);
    },
  });
  await flyDispatch(ctx, plane, job);

  assert.equal(claimedInFiles, true, 'the files showed the job claimed before the flight let it go');
  assert.equal(listedJob(ctx, job.id).status, 'open', 'the list file shows the job open again');
  assert.equal(listedJob(ctx, job.id).claimed_by || null, null);
  assert.equal(todoSection(ctx, 'In Progress'), '(Empty)');
  assert.ok(todoSection(ctx, 'Backlog').includes(`[${job.display_id}]`), 'TODO.md shows the job waiting again');
});

test('dispatch: a task list file that cannot be written does not undo a release that is already saved, nor stop TODO.md being redrawn', async (t) => {
  const ctx = sandbox(t);
  const job = addJob(ctx);
  // A folder where the list file goes: the write fails, after the release is saved.
  fs.mkdirSync(listFileOf(ctx), { recursive: true });
  const plane = taskPlane(ctx, [job], { worktreeStart: refuse, afterClaim: () => drawTodo(ctx) });
  const { flight } = await flyDispatch(ctx, plane, job);

  assert.equal(tasks.getTask(ctx.db, job.id).status, 'open', 'the claim is let go');
  assert.equal(releaseEvents(ctx.db, job.id)[0].kind, 'could_not_start');
  assert.equal(flight.paused[0].claim_released, true, 'the row does not say the release failed when it was saved');
  assert.equal(todoSection(ctx, 'In Progress'), '(Empty)', 'the other file is still redrawn');
});

test('fleet: a claim let go as one that could not start is drawn into atris/TODO.md as open again', async (t) => {
  const ctx = sandbox(t);
  const job = addJob(ctx);
  let claimedInTodo = false;
  const plane = taskPlane(ctx, [job], {
    worktreeStart: refuse,
    afterClaim: () => {
      drawTodo(ctx);
      claimedInTodo = todoSection(ctx, 'In Progress').includes(`[${job.display_id}]`);
    },
  });
  await flyFleet(ctx, plane, [job]);

  assert.equal(claimedInTodo, true, 'TODO.md showed the job claimed before the flight let it go');
  assert.equal(todoSection(ctx, 'In Progress'), '(Empty)');
  assert.ok(todoSection(ctx, 'Backlog').includes(`[${job.display_id}]`), 'TODO.md shows the job waiting again');
});

test('a job shown with no row in the store (a stand-in task plane) is still let go through the task command, as a plain release', async (t) => {
  const ctx = sandbox(t);
  const job = { ...addJob(ctx), id: undefined };
  const plane = taskPlane(ctx, [job], { worktreeStart: refuse });
  // The stand-in claims nothing in the store, so the lease has no row to hold and the flight goes on to the failed start.
  const { flight } = await flyDispatch(ctx, plane, job);

  assert.equal(callsTo(plane, 'task', 'release').length, 1);
  assert.deepEqual(callsTo(plane, 'task', 'release')[0].slice(0, 2), ['task', 'release']);
  assert.equal(flight.paused[0].stage, 'worktree_start');
});

// ---------------------------------------------------------------------------
// Three. The rating reads the field and counts the job as neither a miss nor finished.

// A claim let go with the kind on its event, the way a flight's release stores it.
function unstartedJob(ctx, { builder = 'fleet-codex', title = 'Fix the form', reason = `paused at worktree start: ${REFUSAL}` } = {}) {
  const job = addJob(ctx, { title, claimedBy: builder });
  assert.equal(tasks.releaseTask(ctx.db, { id: job.id, actor: builder, reason }).released, true);
  ctx.db.prepare("UPDATE task_events SET payload = json_set(payload, '$.kind', 'could_not_start') WHERE task_id = ? AND event_type = 'claim_released'").run(job.id);
  return job;
}

// The same release with the same words and no field: an old release, or a worker's own.
function plainDrop(ctx, { builder = 'fleet-codex', title = 'Fix the form', reason = `paused at worktree start: ${REFUSAL}` } = {}) {
  const job = addJob(ctx, { title, claimedBy: builder });
  assert.equal(tasks.releaseTask(ctx.db, { id: job.id, actor: builder, reason }).released, true);
  return job;
}

function landedJob(ctx, n, builder) {
  const job = addJob(ctx, { title: `Landed job ${n}`, claimedBy: builder });
  const merge = { merge_commit: `${n}`.repeat(40).slice(0, 40), number: String(100 + n), url: `https://github.example/repo/pull/${100 + n}`, merged_at: '2026-10-31T02:10:45Z' };
  assert.equal(tasks.readyTask(ctx.db, { id: job.id, actor: builder, proof: 'Merged.', merge }).ready, true);
  return job;
}

test('the season reads the kind from the field: the play is its own, outside finished and outside the misses, and the same words with no field stay a drop', (t) => {
  const ctx = sandbox(t);
  for (const n of [1, 2, 3]) landedJob(ctx, n, 'alpha');
  const started = unstartedJob(ctx, { builder: 'alpha' });
  const dropped = plainDrop(ctx, { builder: 'alpha' });
  const season = seasonOf(ctx);

  assert.deepEqual(playsOf(season, started.id).map((o) => o.kind), ['took', 'could_not_start']);
  assert.deepEqual(playsOf(season, dropped.id).map((o) => o.kind), ['took', 'dropped'], 'words alone never make a release one that could not start');
  const member = memberRow(season, 'alpha');
  assert.deepEqual([member.landed, member.dropped, member.could_not_start, member.finished], [3, 1, 1, 4]);
  assert.equal(member.ovr, atrisRating(3, 4), 'the rating is what it would be without the job that could not start');

  // A member whose only jobs could not start has no finished job and no rating, and is still counted.
  unstartedJob(ctx, { builder: 'gamma' });
  const gamma = memberRow(seasonOf(ctx), 'gamma');
  assert.deepEqual([gamma.could_not_start, gamma.finished, gamma.ovr], [1, 0, null]);

  // The plays list shows the job in a word that fits the outcome column. The claim and the release can land
  // in the same millisecond, so the play is found by its kind, not by being the job's latest.
  const play = lastPlays(season.outcomes, 20).find((row) => row.task_id === started.id && row.kind === 'could_not_start');
  assert.ok(play, 'the plays list has the job that could not start');
  assert.equal(play.play, 'unstarted');
  assert.ok(play.play.length < 10);
  assert.equal(play.hours, null, 'it is not a finished play');
});

test('a release from before this change that says the same words with no field is still a drop', (t) => {
  const ctx = sandbox(t);
  for (const n of [1, 2, 3]) landedJob(ctx, n, 'fleet-codex');
  const old = plainDrop(ctx, { reason: 'paused at worktree start: refusing: only 4.0 GB free on this disk, and a new build copy needs at least 10.0 GB.' });
  const member = memberRow(seasonOf(ctx), 'fleet-codex');
  assert.deepEqual([member.landed, member.dropped, member.could_not_start, member.finished], [3, 1, 0, 4]);
  assert.deepEqual(playsOf(seasonOf(ctx), old.id).map((o) => o.kind), ['took', 'dropped']);
});

function askRating(ctx, season) {
  return (...args) => {
    let out = '';
    assert.equal(ratingCommand(args, { root: ctx.workspace, season, lineup: null, write: (s) => { out += s; } }), 0);
    return out;
  };
}

test('atris rating says in its own line that jobs could not start, for a member and for here, and carries the count in json', (t) => {
  const ctx = sandbox(t);
  for (const n of [1, 2, 3]) landedJob(ctx, n, 'alpha');
  for (const n of [4, 5, 6]) landedJob(ctx, n, 'beta');
  unstartedJob(ctx, { builder: 'alpha', title: 'One' });
  unstartedJob(ctx, { builder: 'alpha', title: 'Two' });
  unstartedJob(ctx, { builder: 'gamma', title: 'Three' });
  const ask = askRating(ctx, seasonOf(ctx));

  // The member view.
  const alpha = ask('alpha');
  assert.match(alpha, /landed 3 of 3 finished jobs/);
  assert.match(alpha, /^ {2}2 jobs could not start on this machine\. They don't count against anyone\.$/m);
  assert.doesNotMatch(alpha, /top miss reasons/, 'a job that could not start is not a miss reason');
  const member = JSON.parse(ask('alpha', '--json')).member;
  assert.equal(member.could_not_start, 2);
  assert.equal(member.finished, 3);
  assert.equal(member.miss_reasons, undefined);

  // A member whose only job could not start still has somewhere to see it.
  const gamma = ask('gamma');
  assert.match(gamma, /landed 0 of 0 finished jobs/);
  assert.match(gamma, /^ {2}1 job could not start on this machine\. It doesn't count against anyone\.$/m);
  assert.equal(JSON.parse(ask('gamma', '--json')).member.could_not_start, 1);

  // A member with none has no such line and no such field.
  assert.doesNotMatch(ask('beta'), /could not start/);
  assert.equal('could_not_start' in JSON.parse(ask('beta', '--json')).member, false);

  // The here view says it once, for everyone, and its json carries the total and each member's count.
  const here = ask();
  assert.match(here, /^3 jobs could not start on this machine\. They don't count against anyone\.$/m);
  const data = JSON.parse(ask('--json')).here;
  assert.equal(data.could_not_start, 3);
  assert.deepEqual(data.members.map((m) => [m.member, m.could_not_start]).sort(), [['alpha', 2], ['beta', undefined], ['gamma', 1]]);
});

test('atris rating has no could-not-start line or field when no job could not start', (t) => {
  const ctx = sandbox(t);
  for (const n of [1, 2, 3]) landedJob(ctx, n, 'alpha');
  const ask = askRating(ctx, seasonOf(ctx));
  assert.doesNotMatch(ask(), /could not start/);
  assert.doesNotMatch(ask('alpha'), /could not start/);
  assert.equal('could_not_start' in JSON.parse(ask('--json')).here, false);
});

test('a flight\'s own release shows in atris rating as a job that could not start, not as a drop', async (t) => {
  const ctx = sandbox(t);
  for (const n of [1, 2, 3]) landedJob(ctx, n, 'fleet-codex');
  const job = addJob(ctx);
  const plane = taskPlane(ctx, [job], { worktreeStart: refuse });
  await flyDispatch(ctx, plane, job);

  const ask = askRating(ctx, seasonOf(ctx));
  const text = ask('fleet-codex');
  assert.match(text, /landed 3 of 3 finished jobs/);
  assert.match(text, /1 job could not start on this machine\. It doesn't count against anyone\./);
  assert.doesNotMatch(text, /top miss reasons/);
});

// ---------------------------------------------------------------------------
// The stamp checks itself. A builder holds the same task store the flight does, so the store must not take
// the could-not-start kind for a claim whose engine already started. The flight marks the claim started
// right before it asks the assigned engine, and the store and the rating both read that mark.

const startedMarks = (db, id) => db.prepare("SELECT COUNT(*) AS n FROM task_events WHERE task_id = ? AND event_type = 'build_started'").get(id).n;
const heldNow = (ctx, id) => {
  const row = tasks.getTask(ctx.db, id);
  return [row.status, row.claimed_by];
};
const markOf = (ctx, id) => tasks.markBuildStarted(ctx.db, { id, actor: 'fleet-codex' });
const STAMP_REASON = `paused at worktree start: ${REFUSAL}`;
// The change a stamped release is made on: the same words, and the kind in a field, as a worker's own call would write.
const stampAfterwards = (ctx, id) => ctx.db.prepare("UPDATE task_events SET payload = json_set(payload, '$.kind', 'could_not_start') WHERE task_id = ? AND event_type = 'claim_released'").run(id);

test('the store keeps a release plain once the claim is marked started, and a mark never carries over to the next claim', (t) => {
  const ctx = sandbox(t);

  // No mark: the stamp stands.
  const unmarked = addJob(ctx, { title: 'one', claimedBy: 'fleet-codex' });
  assert.equal(tasks.releaseTask(ctx.db, { id: unmarked.id, actor: 'fleet-codex', reason: STAMP_REASON, kind: COULD_NOT_START }).released, true);
  assert.equal(releaseEvents(ctx.db, unmarked.id)[0].kind, 'could_not_start');

  // Marked: the same call lets the claim go, with no kind, and does not throw, so the claim is never left held.
  const started = addJob(ctx, { title: 'two', claimedBy: 'fleet-codex' });
  assert.equal(markOf(ctx, started.id).marked, true);
  const released = tasks.releaseTask(ctx.db, { id: started.id, actor: 'fleet-codex', reason: STAMP_REASON, kind: COULD_NOT_START });
  assert.equal(released.released, true);
  assert.deepEqual(releaseEvents(ctx.db, started.id), [{ released_by: 'fleet-codex', previous_claimed_by: 'fleet-codex', reason: STAMP_REASON }]);
  assert.deepEqual(heldNow(ctx, started.id), ['open', null]);

  // The next claim of the same job starts clean: the old mark belongs to the old claim.
  assert.equal(tasks.claimTask(ctx.db, { id: started.id, claimedBy: 'fleet-codex' }).claimed, true);
  assert.equal(tasks.releaseTask(ctx.db, { id: started.id, actor: 'fleet-codex', reason: STAMP_REASON, kind: COULD_NOT_START }).released, true);
  assert.deepEqual(releaseEvents(ctx.db, started.id).map((event) => event.kind), [undefined, 'could_not_start']);
});

test('only the holder can mark a claim started, only the claim it names, and a second mark adds nothing', (t) => {
  const ctx = sandbox(t);
  const job = addJob(ctx, { title: 'three', claimedBy: 'fleet-codex' });
  const claim = tasks.latestClaim(ctx.db, job.id);
  assert.equal(typeof claim.event_id, 'string');

  assert.equal(tasks.markBuildStarted(ctx.db, { id: job.id, actor: 'someone-else' }).reason, 'held_by_other');
  assert.equal(tasks.markBuildStarted(ctx.db, { id: job.id, actor: 'fleet-codex', claimEventId: 'not-this-claim' }).reason, 'claim_changed');
  assert.equal(tasks.markBuildStarted(ctx.db, { id: addJob(ctx, { title: 'four' }).id, actor: 'fleet-codex' }).reason, 'already_open');
  assert.equal(startedMarks(ctx.db, job.id), 0, 'a refused mark writes nothing');

  assert.equal(tasks.markBuildStarted(ctx.db, { id: job.id, actor: 'fleet-codex', claimEventId: claim.event_id }).marked, true);
  assert.equal(tasks.markBuildStarted(ctx.db, { id: job.id, actor: 'fleet-codex', claimEventId: claim.event_id }).marked, true);
  assert.equal(startedMarks(ctx.db, job.id), 1, 'marked once');
});

test('the rating applies the same rule: a stamp on a claim whose engine started is a drop, and one on a claim that never started is not', (t) => {
  const ctx = sandbox(t);
  for (const n of [1, 2, 3]) landedJob(ctx, n, 'alpha');

  // The engine started on this claim, so a release that carries the stamp is still a drop.
  const started = addJob(ctx, { title: 'Started', claimedBy: 'alpha' });
  assert.equal(tasks.markBuildStarted(ctx.db, { id: started.id, actor: 'alpha' }).marked, true);
  assert.equal(tasks.releaseTask(ctx.db, { id: started.id, actor: 'alpha', reason: 'gave up' }).released, true);
  stampAfterwards(ctx, started.id);

  // Never started: the stamp counts.
  const unstarted = unstartedJob(ctx, { builder: 'alpha', title: 'Unstarted' });

  // The same job twice: the first claim started and was let go, the second never started and carries the stamp.
  const twice = addJob(ctx, { title: 'Twice', claimedBy: 'alpha' });
  assert.equal(tasks.markBuildStarted(ctx.db, { id: twice.id, actor: 'alpha' }).marked, true);
  assert.equal(tasks.releaseTask(ctx.db, { id: twice.id, actor: 'alpha', reason: 'engine failed' }).released, true);
  assert.equal(tasks.claimTask(ctx.db, { id: twice.id, claimedBy: 'alpha' }).claimed, true);
  assert.equal(tasks.releaseTask(ctx.db, { id: twice.id, actor: 'alpha', reason: STAMP_REASON }).released, true);
  ctx.db.prepare("UPDATE task_events SET payload = json_set(payload, '$.kind', 'could_not_start') WHERE event_id = (SELECT event_id FROM task_events WHERE task_id = ? AND event_type = 'claim_released' ORDER BY version DESC LIMIT 1)").run(twice.id);

  const season = seasonOf(ctx);
  assert.deepEqual(playsOf(season, started.id).map((o) => o.kind), ['took', 'dropped']);
  assert.deepEqual(playsOf(season, unstarted.id).map((o) => o.kind), ['took', 'could_not_start']);
  assert.deepEqual(playsOf(season, twice.id).map((o) => o.kind), ['took', 'dropped', 'took', 'could_not_start']);
  const member = memberRow(season, 'alpha');
  assert.deepEqual([member.landed, member.dropped, member.could_not_start, member.finished], [3, 2, 2, 5]);
});

// A builder holds the same task store the flight does and can call the same function from its own shell. This
// one gives up after the engine started and says the job never did.
function giveUpAndStamp(ctx, job, seen) {
  return {
    ran: [],
    dispatcher: (entry) => {
      seen.asked = entry.task.display_id;
      seen.marks = startedMarks(ctx.db, job.id);
      seen.released = tasks.releaseTask(ctx.db, { id: job.id, actor: 'fleet-codex', reason: 'gave up', kind: COULD_NOT_START }).released;
      return Promise.resolve({ exitCode: 1, report: '', stderr: 'boom' });
    },
  };
}

const A_REVIEW_ONLY = { reviewOnly: true, verifierCommand: 'node --test test/form.test.js', changeInspector: () => ({ has_change: true, base: '1'.repeat(40), head: '2'.repeat(40), commit: '2'.repeat(40), dirty: false }) };
const LAUNCHES = [
  ['dispatch', (ctx, plane, job, engine) => flyDispatch(ctx, plane, job, { engine, installedEngines: [] })],
  ['review-only dispatch', (ctx, plane, job, engine) => flyDispatch(ctx, plane, job, { engine, installedEngines: [], ...A_REVIEW_ONLY })],
  ['fleet', (ctx, plane, job, engine) => flyFleet(ctx, plane, [job], { engine })],
];
const onCleanCopy = (ctx, extra = {}) => {
  const clean = addCopy(ctx.app, 'clean');
  return { worktreeStart: () => ({ status: 0, stdout: `next: cd ${clean}\n`, stderr: '' }), ...extra };
};

for (const [label, launch] of LAUNCHES) {
  test(`${label}: the claim is marked started before the engine is asked, so a builder that stamps its own release from its shell gets an ordinary release and a drop`, async (t) => {
    const ctx = sandbox(t);
    const job = addJob(ctx);
    const plane = taskPlane(ctx, [job], onCleanCopy(ctx));
    const seen = {};
    await launch(ctx, plane, job, giveUpAndStamp(ctx, job, seen));

    assert.equal(seen.asked, job.display_id, 'the engine was asked');
    assert.equal(seen.marks, 1, 'the claim was marked started before the engine was asked');
    assert.equal(seen.released, true, 'the release went through: the claim is never left held');
    assert.deepEqual(releaseEvents(ctx.db, job.id), [{ released_by: 'fleet-codex', previous_claimed_by: 'fleet-codex', reason: 'gave up' }], 'a release with no kind');
    assert.deepEqual(playsOf(seasonOf(ctx), job.id).map((o) => o.kind), ['took', 'dropped']);
  });
}

test('dispatch: a scout pass that ran first does not count as the build starting, the mark is written right before the assigned engine is asked', async (t) => {
  const ctx = sandbox(t);
  fs.mkdirSync(path.join(ctx.app, 'lib'));
  fs.writeFileSync(path.join(ctx.app, 'lib', 'form.js'), '// the form keeps what was typed\n');
  fs.writeFileSync(path.join(ctx.app, 'lib', 'form-helper.js'), '// helper for the form\n');
  git(ctx.app, ['add', '.']);
  git(ctx.app, ['commit', '-qm', 'form files']);
  git(ctx.app, ['push', '-q', 'origin', 'master']);
  const job = addJob(ctx);
  const plane = taskPlane(ctx, [job], onCleanCopy(ctx));
  const seen = { scouts: 0, markAtScout: null, markAtEngine: null };
  const engine = {
    ran: [],
    dispatcher: () => {
      seen.markAtEngine = startedMarks(ctx.db, job.id);
      return Promise.resolve({ exitCode: 0, report: 'built it' });
    },
  };
  await flyDispatch(ctx, plane, job, {
    engine,
    installedEngines: [],
    scoutAsk: async () => {
      seen.scouts += 1;
      seen.markAtScout = startedMarks(ctx.db, job.id);
      return null;
    },
  });
  assert.deepEqual(seen, { scouts: 1, markAtScout: 0, markAtEngine: 1 });
});

test('dispatch: a mark that cannot be saved stops the start before the engine runs, and the claim goes back as one that could not start', async (t) => {
  const ctx = sandbox(t);
  const job = addJob(ctx);
  const plane = taskPlane(ctx, [job], onCleanCopy(ctx));
  const original = tasks.markBuildStarted;
  tasks.markBuildStarted = () => { throw new Error('database or disk is full'); };
  t.after(() => { tasks.markBuildStarted = original; });
  const { flight, ran } = await flyDispatch(ctx, plane, job, { installedEngines: [] });

  assert.deepEqual(ran, [], 'the engine never ran');
  assert.deepEqual(flight.paused.map((row) => [row.task, row.stage, row.claim_released]), [[job.display_id, 'prepare', true]]);
  const [event, ...more] = releaseEvents(ctx.db, job.id);
  assert.deepEqual(more, []);
  assert.equal(event.kind, 'could_not_start');
  assert.match(event.reason, /^paused at prepare: .*database or disk is full/);
  assert.deepEqual(playsOf(seasonOf(ctx), job.id).map((o) => o.kind), ['took', 'could_not_start']);
});

test('a brief that cannot be written leaves no mark: the engine was never asked', async (t) => {
  const ctx = sandbox(t);
  fs.mkdirSync(path.join(ctx.app, '.atris', 'state', 'briefs.jsonl'), { recursive: true });
  const job = addJob(ctx);
  const plane = taskPlane(ctx, [job], onCleanCopy(ctx));
  await flyDispatch(ctx, plane, job, { installedEngines: [] });
  assert.equal(startedMarks(ctx.db, job.id), 0);
  assert.equal(releaseEvents(ctx.db, job.id)[0].kind, 'could_not_start');
});

// ---------------------------------------------------------------------------
// The two-minute rule. A release that another member's claim follows within two minutes is read as a hand-over and
// left out of the rating. That is a rule about old history, whose releases carry no mark, and it stays as it was for
// them. A claim the engine started is marked, and a release of it is a real miss whoever claims next. A release that
// could not start is shown on its own line, and the next member's claim does not take it off.

// A job held by one member and let go (marked started first when mark is set), then claimed by another member
// straight after.
function handedOn(ctx, { from = 'alpha', to = 'beta', mark = false, release = {} } = {}) {
  const job = addJob(ctx, { title: 'Handed on', claimedBy: from });
  if (mark) assert.equal(tasks.markBuildStarted(ctx.db, { id: job.id, actor: from }).marked, true);
  assert.equal(tasks.releaseTask(ctx.db, { id: job.id, actor: from, reason: 'gave up', ...release }).released, true);
  assert.equal(tasks.claimTask(ctx.db, { id: job.id, claimedBy: to, leaseMinutes: 60, leasePid: process.pid }).claimed, true);
  return job;
}
const whoDidWhat = (ctx, job) => playsOf(seasonOf(ctx), job.id).map((o) => [o.member, o.kind]);

test('a release on a claim the engine started stays on the record when another member takes the job within two minutes', (t) => {
  const ctx = sandbox(t);
  for (const n of [1, 2, 3]) landedJob(ctx, n, 'alpha');
  const plain = handedOn(ctx, { mark: true });
  // The could-not-start request on a marked claim is an ordinary release (the store drops the kind), so it is kept the same way.
  const stamped = handedOn(ctx, { mark: true, release: { kind: COULD_NOT_START } });

  assert.deepEqual(whoDidWhat(ctx, plain), [['alpha', 'took'], ['alpha', 'dropped'], ['beta', 'took']]);
  assert.deepEqual(whoDidWhat(ctx, stamped), [['alpha', 'took'], ['alpha', 'dropped'], ['beta', 'took']]);
  const member = memberRow(seasonOf(ctx), 'alpha');
  assert.deepEqual([member.landed, member.dropped, member.could_not_start, member.finished], [3, 2, 0, 5]);
});

test('a release that waits on a person, on a claim the engine started, also stays when another member takes the job within two minutes', (t) => {
  const ctx = sandbox(t);
  const job = handedOn(ctx, { mark: true, release: { kind: 'proof_not_saved', pullRequest: { state: 'open', number: 77, url: PR_URL } } });
  assert.deepEqual(whoDidWhat(ctx, job), [['alpha', 'took'], ['alpha', 'held'], ['beta', 'took']]);
});

test('a release on a claim with no mark is still read as a hand-over when another member takes the job within two minutes, as it always was', (t) => {
  const ctx = sandbox(t);
  const plain = handedOn(ctx);
  const held = handedOn(ctx, { release: { kind: 'proof_not_saved', pullRequest: { state: 'open', number: 77, url: PR_URL } } });

  assert.deepEqual(whoDidWhat(ctx, plain), [['alpha', 'took'], ['beta', 'took']]);
  assert.deepEqual(whoDidWhat(ctx, held), [['alpha', 'took'], ['beta', 'took']]);
});

test('a release that could not start stays on its own line when another member takes the job within two minutes', (t) => {
  const ctx = sandbox(t);
  for (const n of [1, 2, 3]) landedJob(ctx, n, 'alpha');
  const job = handedOn(ctx, { release: { kind: COULD_NOT_START, reason: STAMP_REASON } });

  assert.deepEqual(whoDidWhat(ctx, job), [['alpha', 'took'], ['alpha', 'could_not_start'], ['beta', 'took']]);
  const member = memberRow(seasonOf(ctx), 'alpha');
  assert.deepEqual([member.landed, member.dropped, member.could_not_start, member.finished], [3, 0, 1, 3]);
});

// ---------------------------------------------------------------------------
// A claim is let go where the job fails to start, not at the end of the run: another job's failure cannot skip it.

const ALPHA = 'Fix lib/alpha.js so the form keeps typed words. Done: it keeps them. Check: node --test test/alpha.test.js.';
const BETA = 'Fix lib/beta.js so the page loads fast. Done: it loads fast. Check: node --test test/beta.test.js.';

for (const [label, fly] of [
  ['dispatch', (ctx, plane, job) => flyDispatch(ctx, plane, job, { installedEngines: [] })],
  ['fleet', (ctx, plane, job) => flyFleet(ctx, plane, [job])],
]) {
  test(`${label}: a claim lease that throws, not only one that cannot be set, lets the claim go as one that could not start and the flight finishes`, async (t) => {
    const ctx = sandbox(t);
    const job = addJob(ctx);
    const plane = taskPlane(ctx, [job], onCleanCopy(ctx));
    const original = tasks.setLease;
    tasks.setLease = () => { throw new Error('database is locked'); };
    t.after(() => { tasks.setLease = original; });
    const { flight, ran } = await fly(ctx, plane, job);

    assert.deepEqual(ran, [], 'the engine never ran');
    assert.deepEqual(flight.paused.map((row) => [row.task, row.stage, row.claim_released]), [[job.display_id, 'prepare', true]]);
    const [event, ...more] = releaseEvents(ctx.db, job.id);
    assert.deepEqual(more, []);
    assert.deepEqual([event.kind, event.reason], ['could_not_start', 'paused at prepare: database is locked']);
    assert.deepEqual(playsOf(seasonOf(ctx), job.id).map((o) => o.kind), ['took', 'could_not_start']);
  });
}

test('fleet: a job whose lease cannot be set is let go at once, so a failure later in the same flight cannot leave it to expire as a miss', async (t) => {
  const ctx = sandbox(t);
  const a = addJob(ctx, { title: ALPHA });
  const b = addJob(ctx, { title: BETA });
  const plane = taskPlane(ctx, [a, b], onCleanCopy(ctx, { afterClaim: (id) => { if (id === a.id) spoilMetadata(ctx)(id); } }));
  // The other job lands badly: the flight throws before it reaches its closing pass.
  await assert.rejects(flyFleet(ctx, plane, [a, b], { lander: () => { throw new Error('lander exploded'); } }), /lander exploded/);

  assert.deepEqual(heldNow(ctx, a.id), ['open', null], 'the job that never started is not left claimed');
  const [event, ...more] = releaseEvents(ctx.db, a.id);
  assert.deepEqual(more, []);
  assert.deepEqual([event.kind, event.reason], ['could_not_start', 'paused at prepare: could not set claim lease']);
  assert.deepEqual(playsOf(seasonOf(ctx), a.id).map((o) => o.kind), ['took', 'could_not_start']);
});

test('fleet: a job that throws while it is prepared is let go at once and the other jobs carry on', async (t) => {
  const ctx = sandbox(t);
  const a = addJob(ctx, { title: ALPHA });
  const b = addJob(ctx, { title: BETA });
  const clean = addCopy(ctx.app, 'clean');
  const plane = taskPlane(ctx, [a, b], {
    worktreeStart: (args) => {
      if (args.includes(`fleet-${a.display_id.toLowerCase()}`)) throw new Error('spawn EMFILE');
      return { status: 0, stdout: `next: cd ${clean}\n`, stderr: '' };
    },
  });
  const { flight, ran, logs } = await flyFleet(ctx, plane, [a, b]);

  assert.deepEqual(ran, [b.display_id], `the other job still ran\n${JSON.stringify(flight.paused)}\n${logs.join('\n')}`);
  assert.deepEqual(heldNow(ctx, a.id), ['open', null]);
  const [event, ...more] = releaseEvents(ctx.db, a.id);
  assert.deepEqual(more, []);
  assert.deepEqual([event.kind, event.reason], ['could_not_start', 'paused at prepare: spawn EMFILE']);
  assert.deepEqual(flight.paused.filter((row) => row.task === a.display_id).map((row) => [row.stage, row.claim_released]), [['prepare', true]]);
});

for (const [label, fly] of [
  ['dispatch', (ctx, plane, jobs, engine) => flyDispatch(ctx, plane, jobs[0], { engine, installedEngines: [], taskIds: jobs.map((job) => job.display_id) })],
  ['fleet', (ctx, plane, jobs, engine) => flyFleet(ctx, plane, jobs, { engine })],
]) {
  test(`${label}: a job whose brief cannot be written is let go where it fails, not at the end of the flight, while the other job is still building`, async (t) => {
    const ctx = sandbox(t);
    const a = addJob(ctx, { title: ALPHA });
    const b = addJob(ctx, { title: BETA });
    const plane = taskPlane(ctx, [a, b], onCleanCopy(ctx));
    // The brief of the first job cannot be saved (the disk fills for that one write); the second job's can.
    const appendFileSync = fs.appendFileSync;
    fs.appendFileSync = (file, data, ...rest) => {
      if (String(file).endsWith('briefs.jsonl') && String(data).includes('lib/alpha.js')) throw new Error('no space left on device');
      return appendFileSync.call(fs, file, data, ...rest);
    };
    t.after(() => { fs.appendFileSync = appendFileSync; });
    const seen = {};
    const engine = {
      ran: [],
      dispatcher: async (entry) => {
        engine.ran.push(entry.task.display_id);
        // The second job's engine is still running when this look is taken: it waits here (up to two seconds)
        // for the first job to be let go. A flight that only lets it go at the end of the run never does.
        const until = Date.now() + 2000;
        while (heldNow(ctx, a.id)[0] === 'claimed' && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10));
        seen.firstJobNow = heldNow(ctx, a.id);
        return { exitCode: 0, report: 'built' };
      },
    };
    const { flight, logs } = await fly(ctx, plane, [a, b], engine);

    assert.deepEqual(engine.ran, [b.display_id], 'only the second job reached its engine');
    assert.deepEqual(seen.firstJobNow, ['open', null], `the first job was already let go while the second was still building\n${JSON.stringify(flight.paused)}\n${logs.join('\n')}`);
    const [event, ...more] = releaseEvents(ctx.db, a.id);
    assert.deepEqual(more, []);
    assert.deepEqual([event.kind, event.reason], ['could_not_start', 'paused at brief capture: no space left on device']);
    assert.equal(flight.paused.find((row) => row.task === a.display_id).claim_released, true);
  });
}

// ---------------------------------------------------------------------------
// A claim is let go only when it is still the one this flight made. Another run can take a job over under the
// same builder name (a lease that ran out, then a second flight), and the first flight's late release must not
// land on, or put the could-not-start kind on, a claim that belongs to someone else.

// Another run takes the job over: the first claim is let go and the job is claimed again, by a run of its own.
function takenOver(ctx, id, by = 'fleet-codex') {
  assert.equal(tasks.releaseTask(ctx.db, { id, actor: by, reason: 'lease ran out' }).released, true);
  assert.equal(tasks.claimTask(ctx.db, { id, claimedBy: by, leaseMinutes: 60, leasePid: process.pid + 1 }).claimed, true);
}
const claimCount = (db, id) => db.prepare("SELECT COUNT(*) AS n FROM task_events WHERE task_id = ? AND event_type = 'claimed'").get(id).n;
const leftAlone = (job) => new RegExp(`left ${job.display_id} alone: another run claimed it after this one did`);

for (const [label, fly] of [
  ['dispatch', (ctx, plane, job) => flyDispatch(ctx, plane, job)],
  ['fleet', (ctx, plane, job) => flyFleet(ctx, plane, [job])],
]) {
  test(`${label}: a claim that another run has taken over since is left alone when the start fails, not released and not marked as one that could not start`, async (t) => {
    const ctx = sandbox(t);
    const job = addJob(ctx);
    const plane = taskPlane(ctx, [job], { worktreeStart: () => { takenOver(ctx, job.id); return refuse(); } });
    const { flight, logs } = await fly(ctx, plane, job);

    assert.deepEqual(heldNow(ctx, job.id), ['claimed', 'fleet-codex'], 'the other run still holds its claim');
    assert.equal(claimCount(ctx.db, job.id), 2);
    assert.deepEqual(releaseEvents(ctx.db, job.id), [{ released_by: 'fleet-codex', previous_claimed_by: 'fleet-codex', reason: 'lease ran out' }], 'only the other run\'s own release is on record, with no kind');
    assert.deepEqual(callsTo(plane, 'task', 'release'), [], 'and the task command is not asked to do it either');
    assert.equal(logs.filter((line) => leftAlone(job).test(line)).length, 1, logs.join('\n'));
    assert.deepEqual(flight.paused.map((row) => [row.task, row.stage, row.claim_released]), [[job.display_id, 'worktree_start', false]]);
  });

  test(`${label}: a claim that another run has taken over since is left alone when the engine failed, too, not released by the closing pass`, async (t) => {
    const ctx = sandbox(t);
    const job = addJob(ctx);
    const plane = taskPlane(ctx, [job], onCleanCopy(ctx));
    const engine = { ran: [], dispatcher: () => { takenOver(ctx, job.id); return Promise.resolve({ exitCode: 1, report: '', stderr: 'boom' }); } };
    const { flight, logs } = await (label === 'dispatch'
      ? flyDispatch(ctx, plane, job, { engine, installedEngines: [] })
      : flyFleet(ctx, plane, [job], { engine }));

    assert.deepEqual(heldNow(ctx, job.id), ['claimed', 'fleet-codex'], 'the other run still holds its claim');
    assert.deepEqual(releaseEvents(ctx.db, job.id).map((event) => event.reason), ['lease ran out'], 'the flight released nothing');
    assert.deepEqual(callsTo(plane, 'task', 'release'), []);
    assert.equal(logs.filter((line) => leftAlone(job).test(line)).length, 1, logs.join('\n'));
    assert.deepEqual(flight.paused.map((row) => [row.task, row.stage, row.claim_released]), [[job.display_id, 'build', false]]);
  });
}

// ---------------------------------------------------------------------------
// A lost claim means stop. The mark is the flight's last look at the claim before the engine is asked. If the mark
// is refused because this flight no longer holds the claim (it was let go, replaced, or claimed again under the same
// name), the engine is not asked, nothing more is written, and one plain line says so. A mark that fails from a store
// error while the flight still holds the claim is the machine's trouble, and the claim is let go as one that could
// not start (the test of that is above).

// Run act once, right after a brief is saved and before that job's claim is marked started. only, when given,
// picks the job: the brief that is saved must name it.
function afterBriefSaved(t, act, { only = '' } = {}) {
  const appendFileSync = fs.appendFileSync;
  let fired = false;
  fs.appendFileSync = (file, data, ...rest) => {
    const out = appendFileSync.call(fs, file, data, ...rest);
    if (!fired && String(file).endsWith('briefs.jsonl') && String(data).includes(only)) {
      fired = true;
      act();
    }
    return out;
  };
  t.after(() => { fs.appendFileSync = appendFileSync; });
}

// Another run gets the job, from the claim this flight made: the old claim is let go and a new one is made by `to`.
// The new claim's lease names a process of its own unless the test says otherwise.
function handedOver(ctx, id, to, leasePid = process.pid + 1) {
  assert.equal(tasks.releaseTask(ctx.db, { id, actor: 'fleet-codex', reason: 'lease ran out' }).released, true);
  assert.equal(tasks.claimTask(ctx.db, { id, claimedBy: to, leaseMinutes: 60, leasePid }).claimed, true);
}

const LOST_CLAIMS = [
  ['was let go by someone else', (ctx, id) => assert.equal(tasks.releaseTask(ctx.db, { id, actor: 'fleet-codex', reason: 'lease ran out' }).released, true), ['open', null]],
  ['was claimed again under the same name', (ctx, id) => handedOver(ctx, id, 'fleet-codex'), ['claimed', 'fleet-codex']],
  ['was claimed by another builder', (ctx, id) => handedOver(ctx, id, 'fleet-gemini'), ['claimed', 'fleet-gemini']],
];
const lostClaimLine = /no longer holds the claim, so the engine was not started and the job was left alone/;

for (const [label, fly] of [
  ['dispatch', (ctx, plane, job) => flyDispatch(ctx, plane, job, { installedEngines: [] })],
  ['fleet', (ctx, plane, job) => flyFleet(ctx, plane, [job])],
]) {
  for (const [how, lose, held] of LOST_CLAIMS) {
    test(`${label}: when the claim ${how} before the mark, the engine is not asked, nothing more is written, and one plain line says so`, async (t) => {
      const ctx = sandbox(t);
      const job = addJob(ctx);
      const plane = taskPlane(ctx, [job], onCleanCopy(ctx));
      let written = null;
      afterBriefSaved(t, () => {
        lose(ctx, job.id);
        written = eventTotal(ctx.db);
      });
      const { flight, logs, ran } = await fly(ctx, plane, job);

      assert.notEqual(written, null, 'the claim was lost between the brief and the mark');
      assert.deepEqual(ran, [], 'the engine was not asked');
      assert.equal(startedMarks(ctx.db, job.id), 0, 'no mark was written');
      assert.deepEqual(heldNow(ctx, job.id), held, 'the job is as the other run left it');
      assert.equal(eventTotal(ctx.db), written, 'nothing more was written to any job');
      assert.deepEqual(callsTo(plane, 'task', 'release'), [], 'and the task command is not asked to let it go');

      const said = logs.filter((line) => lostClaimLine.test(line));
      assert.equal(said.length, 1, logs.join('\n'));
      assert.ok(said[0].includes(job.display_id), 'the line names the job');
      assert.deepEqual(logs.filter((line) => /prepare failed|brief capture failed|attempt failed/.test(line)), [], 'and it is the only line about it');
      assert.deepEqual(flight.paused.map((row) => [row.task, row.stage, row.claim_released]), [[job.display_id, 'claim_lost', false]]);
      assert.match(flight.paused[0].detail, lostClaimLine);
      assert.equal(flight.status, 'failed');
      assert.equal(fleet.flightExitCode(flight), 1);
    });
  }
}

test('review-only dispatch: a claim lost before the mark stops the start the same way', async (t) => {
  const ctx = sandbox(t);
  const job = addJob(ctx);
  const plane = taskPlane(ctx, [job], onCleanCopy(ctx));
  let written = null;
  afterBriefSaved(t, () => {
    handedOver(ctx, job.id, 'fleet-codex');
    written = eventTotal(ctx.db);
  });
  const { flight, logs, ran } = await flyDispatch(ctx, plane, job, { installedEngines: [], ...A_REVIEW_ONLY });

  assert.deepEqual(ran, []);
  assert.equal(startedMarks(ctx.db, job.id), 0);
  assert.deepEqual(heldNow(ctx, job.id), ['claimed', 'fleet-codex']);
  assert.equal(eventTotal(ctx.db), written);
  assert.equal(logs.filter((line) => lostClaimLine.test(line)).length, 1, logs.join('\n'));
  assert.deepEqual(flight.paused.map((row) => [row.task, row.stage, row.claim_released]), [[job.display_id, 'claim_lost', false]]);
});

// The lease timer is the only thing in a flight that writes to a job on its own clock. These tests take hold of it
// and ring it by hand once the flight is over, to see which jobs it would still renew.
function captureLeaseTimers(t) {
  const timers = [];
  const renewed = [];
  const setInterval = global.setInterval;
  const renewLease = tasks.renewLease;
  global.setInterval = (fn, ms, ...rest) => {
    if (ms === 5 * 60000) timers.push(fn);
    return setInterval(fn, ms, ...rest);
  };
  tasks.renewLease = (db, options) => { renewed.push(options.id); return renewLease(db, options); };
  t.after(() => { global.setInterval = setInterval; tasks.renewLease = renewLease; });
  return { timers, renewed, ring: () => timers.forEach((tick) => tick()) };
}

for (const [label, fly] of [
  ['dispatch', (ctx, plane, job) => flyDispatch(ctx, plane, job, { installedEngines: [] })],
  ['fleet', (ctx, plane, job) => flyFleet(ctx, plane, [job])],
]) {
  test(`${label}: a flight that lost its claim stops renewing the lease on that job, and a job it still holds is renewed`, async (t) => {
    const ctx = sandbox(t);
    const lost = addJob(ctx, { title: ALPHA });
    const kept = addJob(ctx, { title: BETA });
    const plane = taskPlane(ctx, [lost, kept], onCleanCopy(ctx));
    const clock = captureLeaseTimers(t);
    afterBriefSaved(t, () => handedOver(ctx, lost.id, 'fleet-codex'), { only: 'lib/alpha.js' });
    await (label === 'dispatch'
      ? flyDispatch(ctx, plane, lost, { installedEngines: [], taskIds: [lost.display_id, kept.display_id] })
      : flyFleet(ctx, plane, [lost, kept]));

    assert.equal(clock.timers.length, 1, 'the flight has one lease timer');
    clock.ring();
    assert.deepEqual(clock.renewed.filter((id) => id === lost.id), [], 'the job whose claim was lost is not renewed');
    assert.ok(clock.renewed.includes(kept.id), 'the job it still holds is');
    assert.equal(tasks.getTask(ctx.db, lost.id).metadata.lease.pid, process.pid + 1, 'the other run\'s lease is as it left it');
  });
}

// ---------------------------------------------------------------------------
// A release is one write that checks the claim. Looking at the claim and then writing leaves a gap in which another
// run can take the job over, and a late release then lands on a claim that is not the flight's. So the check rides
// inside the write, on the claim's own event id (a claim time can collide, two claims can land in one millisecond).

// A connection that does something right before the release is written: the instant after the store has looked at
// the job and before it writes. It stands in for another process getting there first.
function atTheMomentOfRelease(db, act) {
  let armed = true;
  const bound = (target, value) => (typeof value === 'function' ? value.bind(target) : value);
  return new Proxy(db, {
    get(target, name) {
      if (name !== 'prepare') return bound(target, target[name]);
      return (sql) => {
        const statement = target.prepare(sql);
        if (!/UPDATE tasks\s+SET status = 'open'/.test(sql)) return statement;
        return new Proxy(statement, {
          get(inner, member) {
            if (member !== 'run') return bound(inner, inner[member]);
            return (...args) => {
              if (armed) { armed = false; act(); }
              return inner.run(...args);
            };
          },
        });
      };
    },
  });
}

test('a release is one write that checks the claim: a job claimed again in the gap, even in the same millisecond, is left alone', (t) => {
  const ctx = sandbox(t);
  const job = addJob(ctx, { claimedBy: 'fleet-codex' });
  const mine = tasks.latestClaim(ctx.db, job.id);
  const claimedAt = tasks.getTask(ctx.db, job.id).claimed_at;
  const racing = atTheMomentOfRelease(ctx.db, () => {
    takenOver(ctx, job.id);
    // The other claim lands in the same millisecond as ours: only the claim event can tell the two apart.
    ctx.db.prepare('UPDATE tasks SET claimed_at = ? WHERE id = ?').run(claimedAt, job.id);
  });
  const result = tasks.releaseTask(racing, { id: job.id, actor: 'fleet-codex', reason: 'gave up', claimEventId: mine.event_id });

  assert.deepEqual([result.released, result.reason, result.claimed_by], [false, 'claim_changed', 'fleet-codex']);
  assert.deepEqual(heldNow(ctx, job.id), ['claimed', 'fleet-codex'], 'the other run still holds its claim');
  assert.deepEqual(releaseEvents(ctx.db, job.id).map((event) => event.reason), ['lease ran out'], 'only the other run\'s own release is on record');
});

test('a claim is written before its event, so a release or a mark from the claim before it is refused in that gap too', (t) => {
  const ctx = sandbox(t);
  const job = addJob(ctx, { claimedBy: 'fleet-codex' });
  const mine = tasks.latestClaim(ctx.db, job.id);
  assert.equal(tasks.releaseTask(ctx.db, { id: job.id, actor: 'fleet-codex', reason: 'lease ran out' }).released, true);
  // The job is claimed again by an older CLI, which writes the row first and the claimed event a moment later (claimTask
  // now writes both in one transaction). This is the moment between.
  while (Date.now() <= mine.created_at + 1) { /* the clock moves on */ }
  const at = Date.now();
  ctx.db.prepare("UPDATE tasks SET status = 'claimed', claimed_by = 'fleet-codex', claimed_at = ?, updated_at = ? WHERE id = ?").run(at, at, job.id);

  const mark = tasks.markBuildStarted(ctx.db, { id: job.id, actor: 'fleet-codex', claimEventId: mine.event_id });
  assert.deepEqual([mark.marked, mark.reason, mark.claimed_by], [false, 'claim_changed', 'fleet-codex']);
  assert.equal(startedMarks(ctx.db, job.id), 0, 'a refused mark writes nothing');
  const release = tasks.releaseTask(ctx.db, { id: job.id, actor: 'fleet-codex', reason: 'gave up', claimEventId: mine.event_id });
  assert.deepEqual([release.released, release.reason], [false, 'claim_changed']);
  assert.deepEqual(heldNow(ctx, job.id), ['claimed', 'fleet-codex']);

  // The event lands, and now the new claim is the one a mark or a release names.
  tasks.appendTaskEvent(ctx.db, { taskId: job.id, workspaceRoot: ctx.workspace, actor: 'fleet-codex', eventType: 'claimed', payload: { claimed_by: 'fleet-codex' } });
  const next = tasks.latestClaim(ctx.db, job.id);
  assert.notEqual(next.event_id, mine.event_id);
  assert.equal(tasks.markBuildStarted(ctx.db, { id: job.id, actor: 'fleet-codex', claimEventId: mine.event_id }).reason, 'claim_changed');
  assert.equal(tasks.markBuildStarted(ctx.db, { id: job.id, actor: 'fleet-codex', claimEventId: next.event_id }).marked, true);
  assert.equal(tasks.releaseTask(ctx.db, { id: job.id, actor: 'fleet-codex', reason: 'gave up', claimEventId: next.event_id }).released, true);
});

test('a release that is refused says why: not held, held by someone else, or no longer the claim named', (t) => {
  const ctx = sandbox(t);
  const open = addJob(ctx, { title: 'one' });
  const held = addJob(ctx, { title: 'two', claimedBy: 'fleet-gemini' });
  const mine = addJob(ctx, { title: 'three', claimedBy: 'fleet-codex' });
  const name = (job, claimEventId) => {
    const result = tasks.releaseTask(ctx.db, { id: job.id, actor: 'fleet-codex', reason: 'gave up', claimEventId });
    return [result.released, result.reason];
  };
  assert.deepEqual(name(open, 'any'), [false, 'already_open']);
  assert.deepEqual(name(held, tasks.latestClaim(ctx.db, held.id).event_id), [false, 'held_by_other']);
  assert.deepEqual(name(mine, 'not-this-claim'), [false, 'claim_changed']);
  assert.deepEqual(name({ id: 'no-such-row' }, 'any'), [false, 'not_found']);
  assert.deepEqual(heldNow(ctx, mine.id), ['claimed', 'fleet-codex'], 'a refused release writes nothing');
  assert.deepEqual(name(mine, tasks.latestClaim(ctx.db, mine.id).event_id), [true, undefined]);
});

for (const [label, fly] of [
  ['dispatch', (ctx, plane, job, engine) => flyDispatch(ctx, plane, job, { engine, installedEngines: [] })],
  ['fleet', (ctx, plane, job, engine) => flyFleet(ctx, plane, [job], { engine })],
]) {
  test(`${label}: a job another run takes over at the instant the flight lets go of it is left alone, with one plain line`, async (t) => {
    const ctx = sandbox(t);
    const job = addJob(ctx);
    const plane = taskPlane(ctx, [job], onCleanCopy(ctx));
    // The engine fails, so the flight lets the claim go. The other run gets there in the gap between the flight's last look at
    // the claim and its release, which the flight cannot see and the write itself has to.
    const release = tasks.releaseTask;
    let armed = true;
    tasks.releaseTask = (db, args) => {
      if (armed) { armed = false; takenOver(ctx, args.id); }
      return release(db, args);
    };
    t.after(() => { tasks.releaseTask = release; });
    const engine = { ran: [], dispatcher: () => Promise.resolve({ exitCode: 1, report: '', stderr: 'boom' }) };
    const { flight, logs } = await fly(ctx, plane, job, engine);

    assert.equal(armed, false, 'the flight did try to let the claim go');
    assert.deepEqual(heldNow(ctx, job.id), ['claimed', 'fleet-codex'], 'the other run keeps its claim');
    assert.equal(claimCount(ctx.db, job.id), 2);
    assert.deepEqual(releaseEvents(ctx.db, job.id).map((event) => event.reason), ['lease ran out'], 'nothing of the flight\'s is on the record');
    assert.deepEqual(callsTo(plane, 'task', 'release'), []);
    assert.equal(logs.filter((line) => leftAlone(job).test(line)).length, 1, logs.join('\n'));
    assert.deepEqual(flight.paused.map((row) => [row.task, row.stage, row.claim_released]), [[job.display_id, 'build', false]]);
  });
}

const HELD_LANDING = {
  ok: true,
  stage: 'held_for_review',
  lane: 'feedback',
  pull_request: { state: 'open', number: 77, url: PR_URL },
  check: 'node --test test/form.test.js',
  verifyOutput: '# tests 3\n# pass 3\n# fail 0\n',
  verifier_result: { command: 'node --test test/form.test.js', passed: true, status: 0, output: '# pass 3' },
};

test('dispatch: an open pull request whose proof could not be saved does not release a claim that another run has taken over since', async (t) => {
  const ctx = sandbox(t);
  const job = addJob(ctx);
  const plane = taskPlane(ctx, [job], onCleanCopy(ctx));
  const cli = (args) => {
    if (args[0] === 'task' && args[1] === 'ready') {
      takenOver(ctx, job.id);
      return { status: 1, stdout: '', stderr: 'ready failed: nope' };
    }
    return plane.cli(args);
  };
  const { flight, logs } = await flyDispatch(ctx, { ...plane, cli }, job, { installedEngines: [], lander: () => HELD_LANDING });

  assert.deepEqual(heldNow(ctx, job.id), ['claimed', 'fleet-codex'], 'the other run still holds its claim');
  assert.deepEqual(releaseEvents(ctx.db, job.id), [{ released_by: 'fleet-codex', previous_claimed_by: 'fleet-codex', reason: 'lease ran out' }], 'no proof-not-saved release was written onto it');
  assert.equal(logs.filter((line) => leftAlone(job).test(line)).length, 1, logs.join('\n'));
  const [paused] = flight.paused;
  assert.deepEqual([paused.stage, paused.held_for_review, paused.claim_released], ['task_ready', true, false]);
});

test('dispatch: an open pull request whose proof could not be saved is still let go as before when the claim is the flight\'s own', async (t) => {
  const ctx = sandbox(t);
  const job = addJob(ctx);
  const plane = taskPlane(ctx, [job], onCleanCopy(ctx));
  const cli = (args) => (args[0] === 'task' && args[1] === 'ready' ? { status: 1, stdout: '', stderr: 'ready failed: nope' } : plane.cli(args));
  const { flight } = await flyDispatch(ctx, { ...plane, cli }, job, { installedEngines: [], lander: () => HELD_LANDING });

  assert.deepEqual(heldNow(ctx, job.id), ['open', null]);
  assert.deepEqual(releaseEvents(ctx.db, job.id).map((event) => event.kind), ['proof_not_saved']);
  assert.equal(flight.paused[0].claim_released, true);
});

// ---------------------------------------------------------------------------
// The review-only setup: the sealed review sandbox is part of starting, so a sandbox that cannot be prepared is the
// machine's trouble, not the builder's.

test('review-only dispatch: a sealed review sandbox that cannot be prepared lets the claim go in process as one that could not start', async (t) => {
  const ctx = sandbox(t);
  const job = addJob(ctx);
  // The folder is no longer a git checkout of its own, so the sealed sandbox cannot be cut from it.
  fs.rmSync(path.join(ctx.app, '.git'), { recursive: true, force: true });
  const plane = taskPlane(ctx, [job]);
  const { flight, ran } = await flyDispatch(ctx, plane, job, {
    engine: { ran: [], dispatcher: null },
    installedEngines: [],
    freeSpace: ROOMY,
    ...A_REVIEW_ONLY,
  });

  assert.deepEqual(ran, []);
  assert.deepEqual(callsTo(plane, 'task', 'release'), [], 'not through the task command, which takes no kind');
  assert.equal(heldNow(ctx, job.id)[0], 'open');
  const [event, ...more] = releaseEvents(ctx.db, job.id);
  assert.deepEqual(more, []);
  assert.equal(event.kind, 'could_not_start');
  assert.match(event.reason, /^paused at remote quarantine: review-only dispatch requires the workspace to be its own git repository/);
  assert.deepEqual(flight.paused.map((row) => [row.task, row.stage, row.claim_released]), [[job.display_id, 'remote_quarantine', true]]);
  assert.deepEqual(playsOf(seasonOf(ctx), job.id).map((o) => o.kind), ['took', 'could_not_start']);
});

// ---------------------------------------------------------------------------
// The disk check measures the folder the build will use. A sealed review-only flight builds in the temp folder.

test('lowDiskRefusal can be told which folder the build will use, and asks about that one', (t) => {
  const { app } = sandbox(t);
  const asked = [];
  const freeSpace = (target) => { asked.push(path.resolve(target)); return 4e9; };
  const refused = lowDiskRefusal({ root: app, agent: 'codex', task: 'flight', spaceGuard: true, env: {}, freeSpace, target: os.tmpdir() });
  assert.match(refused.message, LOW_DISK_LINE);
  assert.equal(asked[0], path.resolve(os.tmpdir()));
});

test('a sealed review-only flight asks about the temp folder it builds in, with the check on, and stops before it claims anything when that disk is short', async (t) => {
  const ctx = sandbox(t);
  const job = addJob(ctx);
  const stale = addJob(ctx, { claimedBy: 'fleet-gemini' });
  lapse(ctx.db, stale.id);
  const before = eventTotal(ctx.db);
  const asked = [];
  const freeSpace = (target) => { asked.push(path.resolve(target)); return 4e9; };
  const plane = taskPlane(ctx, [job]);
  const { flight } = await flyDispatch(ctx, plane, job, { engine: { ran: [], dispatcher: null }, installedEngines: [], freeSpace, ...A_REVIEW_ONLY });

  assert.equal(asked[0], path.resolve(os.tmpdir()), 'the sandbox is cut in the temp folder, so that is the disk asked about');
  assert.equal(flight.refusal && flight.refusal.reason, 'low_disk');
  assert.deepEqual(plane.calls, [], 'no task command and no worktree command was sent');
  assert.equal(eventTotal(ctx.db), before, 'nothing was written to any job');
  assert.equal(fleet.flightExitCode(flight), 2);
});

test('a review-only flight with an engine of its own builds in the ordinary build-copy folder, so a temp folder is still left alone', async (t) => {
  const ctx = sandbox(t);
  const job = addJob(ctx);
  const asked = [];
  const freeSpace = (target) => { asked.push(target); return 4e9; };
  const plane = taskPlane(ctx, [job]);
  const { flight } = await flyDispatch(ctx, plane, job, { installedEngines: [], freeSpace, ...A_REVIEW_ONLY });
  assert.equal(flight.refusal, undefined);
  assert.deepEqual(asked, [], 'a copy in a temp folder is not checked, as before');
});

// ---------------------------------------------------------------------------
// A release that fails is tried again, and a job that blows up on its own cannot take the run down with it. The
// closing pass goes back over any claim a start failure could not let go. An exception in one job's attempt, a
// retry brief that cannot be written included, lets that job's claim go where it failed (as one that could not start
// if the engine was never asked, as an ordinary release if it was) and the run goes on to its cleanup.

for (const [label, fly] of [
  ['dispatch', (ctx, plane, job) => flyDispatch(ctx, plane, job)],
  ['fleet', (ctx, plane, job) => flyFleet(ctx, plane, [job])],
]) {
  test(`${label}: a release that failed once is tried again by the closing pass, and the claim goes back as one that could not start`, async (t) => {
    const ctx = sandbox(t);
    const job = addJob(ctx);
    const plane = taskPlane(ctx, [job], { worktreeStart: refuse });
    const release = tasks.releaseTask;
    let locked = 1;
    tasks.releaseTask = (db, args) => {
      if (locked-- > 0) throw new Error('database is locked');
      return release(db, args);
    };
    t.after(() => { tasks.releaseTask = release; });
    const { flight, logs } = await fly(ctx, plane, job);

    assert.deepEqual(heldNow(ctx, job.id), ['open', null], 'the claim is not left to run out as a miss');
    const [event, ...more] = releaseEvents(ctx.db, job.id);
    assert.deepEqual(more, []);
    assert.equal(event.kind, 'could_not_start');
    const [row] = flight.paused;
    assert.deepEqual([row.task, row.stage, row.claim_released], [job.display_id, 'worktree_start', true]);
    assert.doesNotMatch(row.detail, /database is locked/, 'the row tells the end of it, not the first failure');
    // The dispatch row carries the outcome of the release in its words; the fleet row has always carried the cause alone.
    if (label === 'dispatch') assert.match(row.detail, /claim released, safe to retry$/);
    assert.equal(logs.filter((line) => line.includes(`released claim on ${job.display_id} on a second try`)).length, 1, logs.join('\n'));
    assert.deepEqual(playsOf(seasonOf(ctx), job.id).map((o) => o.kind), ['took', 'could_not_start']);
  });

  test(`${label}: a release that fails twice leaves the claim held, says so in one plain line, and the flight still finishes`, async (t) => {
    const ctx = sandbox(t);
    const job = addJob(ctx);
    const plane = taskPlane(ctx, [job], { worktreeStart: refuse });
    const release = tasks.releaseTask;
    tasks.releaseTask = () => { throw new Error('database is locked'); };
    t.after(() => { tasks.releaseTask = release; });
    const { flight, logs } = await fly(ctx, plane, job);

    assert.deepEqual(heldNow(ctx, job.id), ['claimed', 'fleet-codex'], 'still held: it runs out with its lease unless the record is repaired');
    const [row] = flight.paused;
    assert.deepEqual([row.stage, row.claim_released], ['worktree_start', false]);
    if (label === 'dispatch') assert.match(row.detail, /claim release failed: database is locked$/);
    assert.equal(logs.filter((line) => line.includes(`could not release the claim on ${job.display_id}: database is locked`)).length, 1, logs.join('\n'));
    assert.equal(flight.status, 'failed');
  });
}

for (const [label, fly] of [
  ['dispatch', (ctx, plane, jobs, engine) => flyDispatch(ctx, plane, jobs[0], { engine, installedEngines: ['codex', 'cursor'], taskIds: jobs.map((job) => job.display_id), lander: () => ({ ok: true, stage: 'shipped' }) })],
  ['fleet', (ctx, plane, jobs, engine) => flyFleet(ctx, plane, jobs, { engine, engines: ['codex', 'cursor'] })],
]) {
  test(`${label}: a retry brief that cannot be written, after the first engine ran, lets that job go as an ordinary release, and the other job is still built`, async (t) => {
    const ctx = sandbox(t);
    const a = addJob(ctx, { title: ALPHA });
    const b = addJob(ctx, { title: BETA });
    const plane = taskPlane(ctx, [a, b], onCleanCopy(ctx));
    // The first job's first engine hits its usage limit, so the job is handed to the next engine, and the disk fills
    // for the brief of that second try (the second brief written for the first job; a stamp on a brief is not one).
    const briefs = path.join(ctx.app, '.atris', 'state', 'briefs.jsonl');
    const appendFileSync = fs.appendFileSync;
    let written = 0;
    fs.appendFileSync = (file, data, ...rest) => {
      if (path.resolve(String(file)) === briefs && String(data).includes('lib/alpha.js') && String(data).includes('"outcome":null') && ++written === 2) throw new Error('no space left on device');
      return appendFileSync.call(fs, file, data, ...rest);
    };
    t.after(() => { fs.appendFileSync = appendFileSync; });
    const engine = {
      ran: [],
      dispatcher: (entry) => {
        engine.ran.push(entry.task.display_id);
        const firstTry = entry.task.display_id === a.display_id && engine.ran.filter((id) => id === a.display_id).length === 1;
        return Promise.resolve(firstTry ? { exitCode: 1, report: '', stderr: 'You have hit your usage limit' } : { exitCode: 0, report: 'built' });
      },
    };
    const { flight, logs } = await fly(ctx, plane, [a, b], engine);
    const holder = tasks.latestClaim(ctx.db, a.id).actor;

    assert.equal(written, 2, 'the second brief for the first job was the one that failed');
    assert.deepEqual(engine.ran.filter((id) => id === a.display_id), [a.display_id], 'the first job\'s engine was asked once, and the second try never started');
    assert.ok(engine.ran.includes(b.display_id), 'the other job was built');
    assert.equal(startedMarks(ctx.db, a.id), 1, 'the first engine was asked, so the claim is marked');
    assert.deepEqual(heldNow(ctx, a.id), ['open', null], 'and the claim went back at once');
    assert.deepEqual(releaseEvents(ctx.db, a.id), [{ released_by: holder, previous_claimed_by: holder, reason: 'paused at dispatch: no space left on device' }], 'an ordinary release: the engine had started');
    assert.deepEqual(flight.paused.filter((row) => row.task === a.display_id).map((row) => [row.stage, row.claim_released]), [['dispatch', true]]);
    assert.ok(flight.landed.some((row) => row.task === b.display_id), 'the other job landed');
    assert.equal(logs.filter((line) => line.includes(`${a.display_id} attempt failed`)).length, 1, logs.join('\n'));
    assert.deepEqual(playsOf(seasonOf(ctx), a.id).map((o) => o.kind), ['took', 'dropped'], 'the engine started, so it is a real miss');
    assert.equal(flight.status, 'failed');
  });
}

test('one job that throws in its attempt comes back as a job that did not start, with the words of the failure, and nothing else is lost', async (t) => {
  const ctx = sandbox(t);
  const entry = { task: { display_id: 'X-1', title: 'Fix it' }, worktreePath: ctx.app, prompt: 'Fix it.' };
  const marked = [];
  const result = await fleet.dispatchEntryWithRestaff({
    entry,
    engine: 'codex',
    root: ctx.app,
    dispatch: () => Promise.resolve({ exitCode: 0, report: 'built' }),
    installedEngines: [],
    restaffState: { used: false },
    scoutAsk: false,
    clock: () => { throw new Error('clock exploded'); },
    beforeEngine: (e) => marked.push(e.task.display_id),
  });

  assert.deepEqual(marked, ['X-1'], 'the claim was marked before the failure, as it is right before the engine');
  assert.equal(result.not_started, 'dispatch');
  assert.match(result.detail, /clock exploded/);
  assert.deepEqual(result.attempts, []);
});

// ---------------------------------------------------------------------------
// Round three, One. The start check runs before every engine start. A claim can be lost between one attempt and the
// next (the first engine ran for minutes), so a retry on another engine after a dead one, and a handover to the next
// worker on the roster, each mark the current claim first, and stop the way the first start does if it is lost.

const onceOnly = (act) => {
  let done = false;
  return (...args) => {
    if (done) return undefined;
    done = true;
    return act(...args);
  };
};
// The job changes hands from whoever holds it now.
function handedOverFromHolder(ctx, id, to, leasePid = process.pid + 1) {
  const holder = tasks.getTask(ctx.db, id).claimed_by;
  assert.equal(tasks.releaseTask(ctx.db, { id, actor: holder, reason: 'lease ran out' }).released, true);
  assert.equal(tasks.claimTask(ctx.db, { id, claimedBy: to, leaseMinutes: 60, leasePid }).claimed, true);
}
const USAGE_LIMIT = { exitCode: 1, report: '', stderr: 'You have hit your usage limit' };
const RETRIES = [
  ['dispatch', (ctx, plane, job, engine) => flyDispatch(ctx, plane, job, { engine, installedEngines: ['codex', 'cursor'], lander: () => ({ ok: true, stage: 'shipped' }) })],
  ['fleet', (ctx, plane, job, engine) => flyFleet(ctx, plane, [job], { engine, engines: ['codex', 'cursor'] })],
];

for (const [label, fly] of RETRIES) {
  test(`${label}: a retry on another engine after a dead one checks the claim first, and a claim lost while the first engine ran means the second is not asked`, async (t) => {
    const ctx = sandbox(t);
    const job = addJob(ctx);
    const plane = taskPlane(ctx, [job], onCleanCopy(ctx));
    let written = null;
    const engine = {
      ran: [],
      dispatcher: (entry) => {
        engine.ran.push(entry.engine);
        // The first engine hits its usage limit, and by then another builder has the job.
        handedOverFromHolder(ctx, job.id, 'fleet-gemini');
        written = eventTotal(ctx.db);
        return Promise.resolve(USAGE_LIMIT);
      },
    };
    const { flight, logs } = await fly(ctx, plane, job, engine);

    assert.equal(engine.ran.length, 1, `the second engine was not asked (asked: ${engine.ran.join(', ')})`);
    assert.equal(startedMarks(ctx.db, job.id), 1, 'only the first engine\'s mark, on the claim it ran under');
    assert.deepEqual(heldNow(ctx, job.id), ['claimed', 'fleet-gemini'], 'the other builder still holds the job');
    assert.equal(eventTotal(ctx.db), written, 'nothing more was written to any job');
    assert.deepEqual(callsTo(plane, 'task', 'release'), []);
    assert.equal(logs.filter((line) => lostClaimLine.test(line)).length, 1, logs.join('\n'));
    assert.deepEqual(flight.paused.map((row) => [row.task, row.stage, row.claim_released]), [[job.display_id, 'claim_lost', false]]);
    assert.equal(fleet.flightExitCode(flight), 1);
  });

  test(`${label}: a retry on a claim the flight still holds marks that claim again before the second engine, and the mark is written once`, async (t) => {
    const ctx = sandbox(t);
    const job = addJob(ctx);
    const plane = taskPlane(ctx, [job], onCleanCopy(ctx));
    const marks = [];
    const markBuildStarted = tasks.markBuildStarted;
    t.mock.method(tasks, 'markBuildStarted', (db, args) => {
      marks.push(args.claimEventId);
      return markBuildStarted(db, args);
    });
    const engine = {
      ran: [],
      dispatcher: (entry) => {
        engine.ran.push(entry.engine);
        return Promise.resolve(engine.ran.length === 1 ? USAGE_LIMIT : { exitCode: 0, report: 'built' });
      },
    };
    await fly(ctx, plane, job, engine);

    const mine = tasks.latestClaim(ctx.db, job.id).event_id;
    assert.equal(engine.ran.length, 2, 'the retry ran');
    assert.deepEqual(marks, [mine, mine], 'each start was checked against the claim the flight made');
    assert.equal(startedMarks(ctx.db, job.id), 1, 'marking twice adds nothing');
  });
}

// A scratch roster for one test: the build team is devin, then grok. The machine roster and the engines' health live
// in the sandbox, never in a home folder.
function withRoster(ctx, text) {
  const keys = ['ATRIS_MACHINE_ROSTER_PATH', 'ATRIS_MACHINE_ROSTER_MD_PATH', 'ATRIS_ROUTER_EXPLAIN', 'ATRIS_ENGINE_COOLDOWN_MINUTES'];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  process.env.ATRIS_MACHINE_ROSTER_PATH = path.join(ctx.ws, 'home', '.atris', 'roster.json');
  process.env.ATRIS_ROUTER_EXPLAIN = '0';
  fs.mkdirSync(path.join(ctx.app, 'atris'), { recursive: true });
  fs.writeFileSync(path.join(ctx.app, 'atris', 'ROSTER.md'), text);
  readEngineRegistry(ctx.app);
  for (const name of ['devin', 'grok', 'cursor', 'codex']) setEngineHealth(name, 'ready', ctx.app);
  ctx.t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
}

test('a handover to the next worker on the roster checks the claim first, and a claim lost while the stalled worker ran means the next one is not asked', async (t) => {
  const ctx = sandbox(t);
  withRoster(ctx, '# roster\n\n## build\n- devin\n- grok\n');
  const asked = [];
  const checked = [];
  const result = await fleet.dispatchEntryWithRestaff({
    entry: { task: { display_id: 'X-1', title: 'Fix it' }, worktreePath: ctx.app, prompt: 'Fix it.' },
    engine: 'devin',
    root: ctx.app,
    dispatch: (entry) => {
      asked.push(entry.engine);
      return Promise.resolve({ exitCode: null, timed_out: true, signal: 'SIGTERM' });
    },
    installedEngines: [],
    restaffState: { used: false },
    scoutAsk: false,
    beforeEngine: () => {
      checked.push(asked.length);
      // The second start is the handover; by then the claim is another run's.
      if (checked.length === 2) throw Object.assign(new Error('the claim on X-1 is no longer this run\'s (claim_changed)'), { claimLost: true });
    },
  });

  assert.deepEqual(checked, [0, 1], 'the claim was checked right before each start, the second after the first worker had run');
  assert.deepEqual(asked, ['devin'], 'the next worker was not asked');
  assert.equal(result.not_started, 'claim_lost');
  assert.match(result.detail, /no longer this run's/);
});

// ---------------------------------------------------------------------------
// Round three, Two. A flight claims a job the store holds in its own process, and the claim's name comes from the
// claim write itself. Looking the claim up afterwards cannot tell this flight's claim from one made just after it.

for (const [label, fly] of [
  ['dispatch', (ctx, plane, job) => flyDispatch(ctx, plane, job, { installedEngines: [] })],
  ['fleet', (ctx, plane, job) => flyFleet(ctx, plane, [job])],
]) {
  for (const [who, to] of [['a run of the same name', 'fleet-codex'], ['another builder', 'fleet-gemini']]) {
    test(`${label}: ${who} that takes the job over the instant after the flight claims it is not mistaken for the flight's own claim: the engine is not asked and the job is left alone`, async (t) => {
      const ctx = sandbox(t);
      const job = addJob(ctx);
      let written = null;
      const plane = taskPlane(ctx, [job], onCleanCopy(ctx, {
        afterClaim: onceOnly((id) => {
          handedOver(ctx, id, to);
          written = eventTotal(ctx.db);
        }),
      }));
      const { flight, logs, ran } = await fly(ctx, plane, job);

      assert.notEqual(written, null, 'the job changed hands between the flight\'s claim and its next step');
      assert.deepEqual(ran, [], 'the engine was not asked');
      assert.equal(startedMarks(ctx.db, job.id), 0, 'no mark was written on the other run\'s claim');
      assert.deepEqual(heldNow(ctx, job.id), ['claimed', to], 'the other run still holds the job');
      assert.equal(claimCount(ctx.db, job.id), 2);
      assert.equal(tasks.getTask(ctx.db, job.id).metadata.lease.pid, process.pid + 1, 'and its lease is as it left it');
      assert.deepEqual(releaseEvents(ctx.db, job.id).map((event) => event.reason), ['lease ran out'], 'the flight released nothing');
      assert.deepEqual(callsTo(plane, 'task', 'release'), [], 'and sent no release by the job\'s name');
      assert.equal(eventTotal(ctx.db), written, 'nothing of the flight\'s was written after the other run took over');
      assert.equal(logs.filter((line) => leftAlone(job).test(line)).length, 1, logs.join('\n'));
      assert.deepEqual(flight.paused.map((row) => [row.task, row.stage, row.claim_released]), [[job.display_id, 'prepare', false]]);
    });
  }

  test(`${label}: a claim that lands with no name for it leaves the job alone: no engine, no release through the task command, one plain line`, async (t) => {
    const ctx = sandbox(t);
    const job = addJob(ctx);
    const plane = taskPlane(ctx, [job], onCleanCopy(ctx));
    // The claim write lands but does not say which claim it made.
    const claimTask = tasks.claimTask;
    t.mock.method(tasks, 'claimTask', (db, args) => {
      const { event, ...unnamed } = claimTask(db, args);
      return unnamed;
    });
    const { flight, logs, ran } = await fly(ctx, plane, job);

    assert.deepEqual(ran, [], 'the engine was not asked');
    assert.deepEqual(callsTo(plane, 'worktree', 'start'), [], 'no build copy was cut');
    assert.deepEqual(callsTo(plane, 'task', 'release'), [], 'and no release was sent by the job\'s name, which could land on anyone\'s claim');
    assert.deepEqual(heldNow(ctx, job.id), ['claimed', 'fleet-codex'], 'the claim that landed is left to run out with its lease');
    assert.deepEqual(releaseEvents(ctx.db, job.id), []);
    assert.equal(startedMarks(ctx.db, job.id), 0);
    assert.equal(logs.filter((line) => UNNAMED_LINE.test(line)).length, 1, logs.join('\n'));
    assert.deepEqual(flight.paused.map((row) => [row.task, row.stage]), [[job.display_id, 'claim']]);
    assert.match(flight.paused[0].detail, UNNAMED_LINE);
    assert.equal(fleet.flightExitCode(flight), 1);
  });

  test(`${label}: the claim draws the task list file and atris/TODO.md with the job held, the way the claim command does`, async (t) => {
    const ctx = sandbox(t);
    fs.mkdirSync(path.join(ctx.workspace, 'atris'), { recursive: true });
    const job = addJob(ctx);
    const clean = addCopy(ctx.app, 'clean');
    // The files as they stand when the build copy is cut, which is right after the claim.
    const seen = {};
    const plane = taskPlane(ctx, [job], {
      worktreeStart: () => {
        try {
          seen.listed = listedJob(ctx, job.id);
          seen.inProgress = todoSection(ctx, 'In Progress');
        } catch (err) {
          seen.error = String(err && err.message || err);
        }
        return { status: 0, stdout: `next: cd ${clean}\n`, stderr: '' };
      },
    });
    await fly(ctx, plane, job);

    assert.equal(seen.error, undefined);
    assert.deepEqual([seen.listed.status, seen.listed.claimed_by], ['claimed', 'fleet-codex'], 'the list file shows the job held by the builder');
    assert.ok(seen.inProgress.includes(`[${job.display_id}]`), 'and so does TODO.md');
  });
}

const UNNAMED_LINE = /has no record of which claim is its own, so the job was left alone/;

test('dispatch: a reserved actor still cannot claim, as the claim command refuses it', async (t) => {
  const ctx = sandbox(t);
  const job = addJob(ctx);
  const plane = taskPlane(ctx, [job], onCleanCopy(ctx));
  const { flight, ran } = await flyDispatch(ctx, plane, job, { actor: 'autoland-verifier', installedEngines: [] });

  assert.deepEqual(ran, []);
  assert.equal(claimCount(ctx.db, job.id), 0, 'nothing was claimed');
  assert.deepEqual(heldNow(ctx, job.id), ['open', null]);
  assert.deepEqual(flight.paused.map((row) => [row.task, row.stage]), [[job.display_id, 'claim']]);
  assert.match(flight.paused[0].detail, /reserved_actor/);
});

test('a flight with no name for its claim writes nothing to a job the store holds, and leaves a job the store does not know to the task command', (t) => {
  const ctx = sandbox(t);
  const job = addJob(ctx, { claimedBy: 'fleet-codex' });
  const total = eventTotal(ctx.db);
  const claims = { eventId: () => '' }; // a flight that remembered no claim of its own

  // A release that names no claim could land on anyone's: it is not sent, not retried, and the caller says so.
  const unnamed = fleet.releaseOwnClaim({ taskDb: tasks, db: ctx.db, root: ctx.app, ref: job.id, actor: 'fleet-codex', reason: 'gave up', claimEventId: '' });
  assert.deepEqual([unnamed.status, unnamed.unnamed, unnamed.retryable, unnamed.final, unnamed.not_ours], [1, true, undefined, undefined, undefined]);
  assert.match(unnamed.stderr, UNNAMED_LINE);
  // A job the store has no row for is the task command's to let go, as it always was.
  assert.equal(fleet.releaseOwnClaim({ taskDb: tasks, db: ctx.db, root: ctx.app, ref: 'display-id-only', actor: 'fleet-codex', reason: 'gave up', claimEventId: '' }), null);

  // A mark on a job the store holds, with no claim to name, stops the start. On a job the store does not know, it goes on.
  assert.throws(
    () => fleet.markClaimStarted({ taskDb: tasks, db: ctx.db, claims, ref: job.id, actor: 'fleet-codex', task: job.display_id }),
    (err) => err.claimLost === true && err.unnamed === true && UNNAMED_LINE.test(err.message),
  );
  assert.deepEqual(fleet.markClaimStarted({ taskDb: tasks, db: ctx.db, claims, ref: 'display-id-only', actor: 'fleet-codex', task: 'X-1' }), { marked: false, reason: 'not_found' });

  assert.deepEqual(heldNow(ctx, job.id), ['claimed', 'fleet-codex']);
  assert.equal(eventTotal(ctx.db), total, 'nothing was written to any job');
});

// ---------------------------------------------------------------------------
// Round three, Three. A lease is written, renewed and cleared only while the job is held under the claim the writer
// names. A flight that lost its job (a lease that ran out, then a second flight, even in the same process and under
// the same builder name) cannot replace or clear the lease of the claim that came after it.

// The first claim on a job, then a second one by the same builder with a lease of its own.
function twoClaims(ctx, { pid = process.pid + 7 } = {}) {
  const job = addJob(ctx, { claimedBy: 'fleet-codex' });
  const first = tasks.latestClaim(ctx.db, job.id).event_id;
  handedOver(ctx, job.id, 'fleet-codex', pid);
  const second = tasks.latestClaim(ctx.db, job.id).event_id;
  assert.notEqual(first, second);
  return { job, first, second, lease: () => tasks.getTask(ctx.db, job.id).metadata.lease };
}

test('a lease is set only while the job is held under the claim the writer names: an older claim, even by the same builder, cannot replace the lease of the one after it', (t) => {
  const ctx = sandbox(t);
  const { job, first, second, lease } = twoClaims(ctx);
  const theirs = lease();

  assert.equal(tasks.setLease(ctx.db, { id: job.id, holder: 'fleet-codex', pid: 1, claimEventId: first }), false);
  assert.deepEqual(lease(), theirs, 'the newer claim\'s lease is as it was');
  assert.equal(tasks.setLease(ctx.db, { id: job.id, holder: 'fleet-codex', pid: 4242, claimEventId: second }), true);
  assert.equal(lease().pid, 4242);
  // A writer that names no claim is as it always was.
  assert.equal(tasks.setLease(ctx.db, { id: job.id, holder: 'fleet-codex', pid: 4343 }), true);
  assert.equal(lease().pid, 4343);
});

test('a lease is renewed only while the job is held under the claim the writer names, even when the other claim names the same process', (t) => {
  const ctx = sandbox(t);
  const { job, first, second, lease } = twoClaims(ctx, { pid: process.pid });
  const theirs = lease();
  const later = Date.now() + 5 * 60000;

  assert.equal(tasks.renewLease(ctx.db, { id: job.id, holder: 'fleet-codex', pid: process.pid, claimEventId: first, now: later }), false);
  assert.deepEqual(lease(), theirs, 'the newer claim\'s lease is as it was');
  assert.equal(tasks.renewLease(ctx.db, { id: job.id, holder: 'fleet-codex', pid: process.pid, claimEventId: second, now: later }), true);
  assert.notEqual(lease().until, theirs.until, 'a renewal on the claim the writer made goes through');
});

test('a lease is cleared only while the job is held under the claim the writer names; a job that has moved on to review still has its own lease cleared', (t) => {
  const ctx = sandbox(t);
  const { job, first, second, lease } = twoClaims(ctx);
  const theirs = lease();

  assert.equal(tasks.clearLease(ctx.db, { id: job.id, holder: 'fleet-codex', claimEventId: first }), false);
  assert.deepEqual(lease(), theirs, 'the newer claim\'s lease is still there');
  ctx.db.prepare("UPDATE tasks SET status = 'review' WHERE id = ?").run(job.id);
  assert.equal(tasks.clearLease(ctx.db, { id: job.id, holder: 'fleet-codex', claimEventId: second }), true);
  assert.equal(lease(), undefined);
});

for (const [label, fly] of [
  ['dispatch', (ctx, plane, job, engine) => flyDispatch(ctx, plane, job, { engine, installedEngines: [] })],
  ['fleet', (ctx, plane, job, engine) => flyFleet(ctx, plane, [job], { engine })],
]) {
  test(`${label}: the closing cleanup does not clear the lease of a claim another run made in the instant before it`, async (t) => {
    const ctx = sandbox(t);
    const job = addJob(ctx);
    const plane = taskPlane(ctx, [job], onCleanCopy(ctx));
    // The engine fails, so the flight lets its claim go and the job reads open when the cleanup looks. Before the
    // cleanup writes, another run claims the job, under the same name, with a lease of its own.
    const clearLease = tasks.clearLease;
    t.mock.method(tasks, 'clearLease', (db, args) => {
      assert.equal(tasks.claimTask(db, { id: job.id, claimedBy: 'fleet-codex', leaseMinutes: 60, leasePid: process.pid + 1 }).claimed, true);
      return clearLease(db, args);
    });
    const engine = { ran: [], dispatcher: () => Promise.resolve({ exitCode: 1, report: '', stderr: 'boom' }) };
    await fly(ctx, plane, job, engine);

    assert.equal(tasks.clearLease.mock.callCount(), 1, 'the cleanup did run');
    assert.deepEqual(heldNow(ctx, job.id), ['claimed', 'fleet-codex'], 'the other run holds the job');
    assert.equal(tasks.getTask(ctx.db, job.id).metadata.lease.pid, process.pid + 1, 'and its lease is still there');
  });

  test(`${label}: the lease timer renews the lease of the claim the flight made, and cannot replace the lease of a claim made after it, even by the same builder in the same process`, async (t) => {
    const ctx = sandbox(t);
    const job = addJob(ctx);
    const plane = taskPlane(ctx, [job], onCleanCopy(ctx));
    const clock = captureLeaseTimers(t);
    const lease = () => tasks.getTask(ctx.db, job.id).metadata.lease;
    const nextMillisecond = () => { const at = Date.now(); while (Date.now() <= at) { /* wait for the clock to move */ } };
    const seen = {};
    const engine = {
      ran: [],
      dispatcher: () => {
        // The flight's own claim: the timer renews it.
        const own = lease().until;
        nextMillisecond();
        clock.ring();
        seen.renewedOwn = lease().until !== own;
        // Another run of the same name takes over, in this very process, and the timer rings again.
        handedOverFromHolder(ctx, job.id, 'fleet-codex', process.pid);
        seen.theirs = lease();
        nextMillisecond();
        clock.ring();
        seen.after = lease();
        return Promise.resolve({ exitCode: 1, report: '', stderr: 'boom' });
      },
    };
    await fly(ctx, plane, job, engine);

    assert.equal(seen.renewedOwn, true, 'the claim the flight made was renewed');
    assert.deepEqual(seen.after, seen.theirs, 'the claim made after it was not');
  });
}

// ---------------------------------------------------------------------------
// Round three, Four. A claim and its claimed entry, and a release and its released entry, are one transaction.

// A connection that does something right before a statement of this kind runs: the instant after the store has
// written the job's row and before it writes the entry. It stands in for another process looking at that moment.
function justBefore(db, pattern, act) {
  let armed = true;
  const bound = (target, value) => (typeof value === 'function' ? value.bind(target) : value);
  return new Proxy(db, {
    get(target, name) {
      if (name !== 'prepare') return bound(target, target[name]);
      return (sql) => {
        const statement = target.prepare(sql);
        if (!pattern.test(sql)) return statement;
        return new Proxy(statement, {
          get(inner, member) {
            if (member !== 'run') return bound(inner, inner[member]);
            return (...args) => {
              if (armed) { armed = false; act(); }
              return inner.run(...args);
            };
          },
        });
      };
    },
  });
}
// What a second connection to the store sees of a job: the row, and how many of an entry kind it has.
function seenApart(t, ctx, id, eventType) {
  const apart = new DatabaseSync(ctx.dbPath);
  t.after(() => apart.close());
  return () => {
    const row = apart.prepare('SELECT status, claimed_by FROM tasks WHERE id = ?').get(id);
    const n = apart.prepare('SELECT COUNT(*) AS n FROM task_events WHERE task_id = ? AND event_type = ?').get(id, eventType).n;
    return [row.status, row.claimed_by, n];
  };
}
const noRoomFor = (db, eventType) => db.exec(`CREATE TRIGGER no_room_for_${eventType} BEFORE INSERT ON task_events WHEN NEW.event_type = '${eventType}' BEGIN SELECT RAISE(ABORT, 'no space left on device'); END`);
const roomAgain = (db, eventType) => db.exec(`DROP TRIGGER no_room_for_${eventType}`);

test('a claim and its claimed entry are one write: nobody else can see the claim before its entry', (t) => {
  const ctx = sandbox(t);
  const job = addJob(ctx);
  const apart = seenApart(t, ctx, job.id, 'claimed');
  const atTheEntry = [];
  const racing = justBefore(ctx.db, /INSERT INTO task_events/, () => atTheEntry.push(apart()));
  const claim = tasks.claimTask(racing, { id: job.id, claimedBy: 'fleet-codex', leaseMinutes: 60, leasePid: process.pid });

  assert.equal(claim.claimed, true);
  assert.deepEqual(atTheEntry, [['open', null, 0]], 'another connection saw the job as it was, with no claim and no entry, not a claim without its entry');
  assert.deepEqual(apart(), ['claimed', 'fleet-codex', 1], 'and then both');
});

test('a release and its released entry are one write: nobody else can see the release before its entry', (t) => {
  const ctx = sandbox(t);
  const job = addJob(ctx, { claimedBy: 'fleet-codex' });
  const apart = seenApart(t, ctx, job.id, 'claim_released');
  const atTheEntry = [];
  const racing = justBefore(ctx.db, /INSERT INTO task_events/, () => atTheEntry.push(apart()));
  const mine = tasks.latestClaim(ctx.db, job.id).event_id;
  const released = tasks.releaseTask(racing, { id: job.id, actor: 'fleet-codex', reason: 'gave up', claimEventId: mine });

  assert.equal(released.released, true);
  assert.deepEqual(atTheEntry, [['claimed', 'fleet-codex', 0]], 'another connection saw the job still held, with no entry, not a release without its entry');
  assert.deepEqual(apart(), ['open', null, 1], 'and then both');
});

test('a claim whose entry cannot be saved is taken back with it, and the retry claims once', (t) => {
  const ctx = sandbox(t);
  const job = addJob(ctx);
  noRoomFor(ctx.db, 'claimed');
  assert.throws(() => tasks.claimTask(ctx.db, { id: job.id, claimedBy: 'fleet-codex', leaseMinutes: 60, leasePid: process.pid }), /no space left on device/);

  assert.deepEqual(heldNow(ctx, job.id), ['open', null], 'the job is as it was: no claim without its entry');
  assert.equal(claimCount(ctx.db, job.id), 0);
  assert.notEqual(ctx.db.isTransaction, true, 'and no transaction is left open');
  roomAgain(ctx.db, 'claimed');
  const retry = tasks.claimTask(ctx.db, { id: job.id, claimedBy: 'fleet-codex', leaseMinutes: 60, leasePid: process.pid });
  assert.equal(retry.claimed, true);
  assert.equal(claimCount(ctx.db, job.id), 1);
  assert.equal(retry.event.event_id, tasks.latestClaim(ctx.db, job.id).event_id, 'the claim answers with the entry it wrote');
});

test('a release whose entry cannot be saved is taken back with it, so the retry sees the job still held and records it once', (t) => {
  const ctx = sandbox(t);
  const job = addJob(ctx, { claimedBy: 'fleet-codex' });
  const mine = tasks.latestClaim(ctx.db, job.id).event_id;
  noRoomFor(ctx.db, 'claim_released');
  assert.throws(() => tasks.releaseTask(ctx.db, { id: job.id, actor: 'fleet-codex', reason: 'gave up', claimEventId: mine }), /no space left on device/);

  assert.deepEqual(heldNow(ctx, job.id), ['claimed', 'fleet-codex'], 'the claim is still held: a release with no record never happened');
  assert.deepEqual(releaseEvents(ctx.db, job.id), []);
  assert.notEqual(ctx.db.isTransaction, true, 'and no transaction is left open');
  roomAgain(ctx.db, 'claim_released');
  const retry = tasks.releaseTask(ctx.db, { id: job.id, actor: 'fleet-codex', reason: 'gave up', claimEventId: mine });
  assert.equal(retry.released, true, JSON.stringify(retry));
  assert.deepEqual(releaseEvents(ctx.db, job.id).map((event) => event.reason), ['gave up']);
  assert.deepEqual(heldNow(ctx, job.id), ['open', null]);
});

test('a claim answers with the entry it wrote, and a claim it lost answers with none', (t) => {
  const ctx = sandbox(t);
  const job = addJob(ctx);
  const won = tasks.claimTask(ctx.db, { id: job.id, claimedBy: 'fleet-codex', leaseMinutes: 60, leasePid: process.pid });
  assert.equal(won.claimed, true);
  assert.deepEqual([won.event.event_type, won.event.task_id, won.event.actor], ['claimed', job.id, 'fleet-codex']);
  assert.equal(won.event.event_id, tasks.latestClaim(ctx.db, job.id).event_id);

  // Another claim after it: the first answer still names the first claim, and the second names its own.
  handedOver(ctx, job.id, 'fleet-codex');
  const next = tasks.latestClaim(ctx.db, job.id).event_id;
  assert.notEqual(next, won.event.event_id);
  const lost = tasks.claimTask(ctx.db, { id: job.id, claimedBy: 'fleet-gemini', leaseMinutes: 60, leasePid: process.pid });
  assert.equal(lost.claimed, false);
  assert.equal(lost.event, undefined);
});

test('a claim, a release or a lease change made inside a caller\'s own transaction joins it, and is taken back with it', (t) => {
  const ctx = sandbox(t);
  const job = addJob(ctx);
  ctx.db.exec('BEGIN IMMEDIATE');
  assert.equal(tasks.claimTask(ctx.db, { id: job.id, claimedBy: 'fleet-codex', leaseMinutes: 60, leasePid: process.pid }).claimed, true);
  const mine = tasks.latestClaim(ctx.db, job.id).event_id;
  assert.equal(tasks.releaseTask(ctx.db, { id: job.id, actor: 'fleet-codex', reason: 'gave up', claimEventId: mine }).released, true);
  ctx.db.exec('ROLLBACK');

  assert.deepEqual(heldNow(ctx, job.id), ['open', null]);
  assert.equal(claimCount(ctx.db, job.id), 0, 'the caller\'s rollback took both back');
  assert.deepEqual(releaseEvents(ctx.db, job.id), []);
});

for (const [label, fly] of [
  ['dispatch', (ctx, plane, job) => flyDispatch(ctx, plane, job)],
  ['fleet', (ctx, plane, job) => flyFleet(ctx, plane, [job])],
]) {
  test(`${label}: a release whose entry could not be saved leaves nothing half done, and the closing pass's second try records it once`, async (t) => {
    const ctx = sandbox(t);
    const job = addJob(ctx);
    const plane = taskPlane(ctx, [job], { worktreeStart: refuse });
    const release = tasks.releaseTask;
    let tries = 0;
    t.mock.method(tasks, 'releaseTask', (db, args) => {
      tries += 1;
      if (tries > 1) return release(db, args);
      // The first try meets a full disk at the entry, after the store has begun the write.
      noRoomFor(db, 'claim_released');
      try { return release(db, args); } finally { roomAgain(db, 'claim_released'); }
    });
    const { flight } = await fly(ctx, plane, job);

    assert.equal(tries, 2, 'the release was tried twice');
    assert.deepEqual(heldNow(ctx, job.id), ['open', null], 'the claim went back');
    const [event, ...more] = releaseEvents(ctx.db, job.id);
    assert.deepEqual(more, [], 'recorded once');
    assert.equal(event.kind, 'could_not_start');
    assert.equal(flight.paused[0].claim_released, true);
    assert.deepEqual(playsOf(seasonOf(ctx), job.id).map((o) => o.kind), ['took', 'could_not_start']);
  });
}

// ---------------------------------------------------------------------------
// Round four, One. Every task command begins by clearing the claims that have run out (runTaskCommand), so a job whose
// old claim was dead got cleared and claimed in one go. A flight claims in its own process now, and that step has to
// come with it: the same one, the store's own, right before every claim, with the same reach and the same history.

const historyIn = (db, id) => db.prepare('SELECT version, event_type, actor, payload FROM task_events WHERE task_id = ? ORDER BY version').all(id)
  .map((row) => ({ version: row.version, type: row.event_type, actor: row.actor, payload: JSON.parse(row.payload) }));
const lapseTo = (db, id, until) => db.prepare("UPDATE tasks SET metadata = json_set(COALESCE(metadata, '{}'), '$.lease.until', ?) WHERE id = ?").run(until, id);

for (const [label, fly, runsOutOnTheWay] of [
  // The dispatch flight clears expired claims once as it starts, so the claim only the sweep before each claim reaches
  // is one that runs out after that, while the flight gets the job ready. The fleet flight has no sweep of its own.
  ['dispatch', (ctx, plane, job) => flyDispatch(ctx, plane, job), true],
  ['fleet', (ctx, plane, job) => flyFleet(ctx, plane, [job]), false],
]) {
  test(`${label}: a job whose old claim has run out by another member is cleared and claimed, and the old claim is recorded the way the task command records it`, async (t) => {
    const ctx = sandbox(t);
    const job = addJob(ctx, { claimedBy: 'fleet-gemini' });
    const alsoRunOut = addJob(ctx, { claimedBy: 'fleet-claude' });
    const stillRunning = addJob(ctx, { claimedBy: 'fleet-cursor' });
    const ranOut = new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString();
    const runOut = [job.id, alsoRunOut.id];
    for (const id of runOut) lapseTo(ctx.db, id, ranOut);

    // What the task command does with the same store: a copy of it as it stands, claimed from by the real command.
    const copyPath = path.join(ctx.ws, 'task-command-copy.db');
    ctx.db.exec(`VACUUM INTO '${copyPath}'`);
    const asked = spawnSync(process.execPath, [CLI, 'task', 'claim', job.id, '--as', 'fleet-codex', '--lease-minutes', '60', '--lease-pid', String(process.pid)], {
      cwd: ctx.app,
      encoding: 'utf8',
      timeout: 60000,
      env: { ...scrubAgentEnv(), ATRIS_TASKS_DB: copyPath, ATRIS_SKIP_UPDATE_CHECK: '1', NODE_NO_WARNINGS: '1' },
    });
    assert.equal(asked.status, 0, asked.stderr || asked.stdout);
    const copy = new DatabaseSync(copyPath, { readOnly: true });
    t.after(() => copy.close());

    // The flight meets the same store. Where the claims run out on the way, they are alive when it starts.
    const plane = taskPlane(ctx, [job]);
    if (runsOutOnTheWay) {
      for (const id of runOut) lapseTo(ctx.db, id, new Date(Date.now() + 60 * 60 * 1000).toISOString());
      const answer = plane.cli;
      plane.cli = (args) => {
        if (args[0] === 'task' && args[1] === 'show') for (const id of runOut) lapseTo(ctx.db, id, ranOut);
        return answer(args);
      };
    }
    const { flight } = await fly(ctx, plane, job);

    assert.deepEqual(flight.paused.filter((row) => row.stage === 'claim'), [], 'the claim went through');
    const claimedAgain = historyIn(ctx.db, job.id).filter((event) => event.type === 'claimed');
    assert.deepEqual(claimedAgain.map((event) => event.actor), ['fleet-gemini', 'fleet-codex']);
    // Each job's history reads as the task command left it: the old claim expired by the one who held it, with the same
    // words and dates, ahead of the new claim; the other dead claim cleared in the same sweep; the live one left alone.
    for (const id of [job.id, alsoRunOut.id, stillRunning.id]) {
      const theirs = historyIn(copy, id);
      assert.deepEqual(historyIn(ctx.db, id).slice(0, theirs.length), theirs, `${id} reads the same as after the task command`);
    }
    assert.deepEqual(historyIn(copy, job.id).map((event) => event.type).slice(-2), ['claim_expired', 'claimed']);
    const expired = historyIn(ctx.db, job.id).find((event) => event.type === 'claim_expired');
    assert.equal(expired.actor, 'fleet-gemini');
    assert.equal(expired.payload.claimed_by, 'fleet-gemini');
    assert.equal(expired.payload.lease_until, ranOut);
    assert.match(expired.payload.reason, /worker stopped without reporting back within 60 minutes/);
    assert.equal(historyIn(ctx.db, alsoRunOut.id).filter((event) => event.type === 'claim_expired').length, 1);
    assert.deepEqual(heldNow(ctx, alsoRunOut.id), ['open', null]);
    assert.deepEqual(heldNow(ctx, stillRunning.id), ['claimed', 'fleet-cursor']);
  });
}

// ---------------------------------------------------------------------------
// Round four, Two. The commit a claim records as the start of the job is what the landing check measures the job's
// own work from (lib/landing-proof.js). It is read with the write lock held: a claim that has to wait for the lock
// is made when it gets it, and a commit that landed in the checkout meanwhile is part of what was there before the
// job began.

// A connection that does something right before the claim asks for the write lock. It stands for the wait: another
// writer has the lock, and the world goes on.
function justBeforeLock(db, act) {
  let armed = true;
  return new Proxy(db, {
    get(target, name) {
      const value = target[name];
      if (name !== 'exec') return typeof value === 'function' ? value.bind(target) : value;
      return (sql) => {
        if (armed && /^\s*BEGIN IMMEDIATE/i.test(sql)) { armed = false; act(); }
        return target.exec(sql);
      };
    },
  });
}
const commitSomething = (app, name) => {
  fs.writeFileSync(path.join(app, name), `${name}\n`);
  git(app, ['add', name]);
  git(app, ['commit', '-qm', name]);
  return git(app, ['rev-parse', 'HEAD']);
};
const startRecorded = (db, id) => historyIn(db, id).find((event) => event.type === 'claimed').payload.start_commit;

test('a commit that lands while a claim waits for the write lock is the start it records, and a job that makes no commit after that is not credited with one', (t) => {
  const ctx = sandbox(t);
  const job = addJob(ctx);
  const before = git(ctx.app, ['rev-parse', 'HEAD']);

  let landed = '';
  const waiting = justBeforeLock(ctx.db, () => { landed = commitSomething(ctx.app, 'landed-while-waiting.txt'); });
  const claim = tasks.claimTask(waiting, { id: job.id, claimedBy: 'fleet-codex', leaseMinutes: 60, leasePid: process.pid });

  assert.equal(claim.claimed, true);
  assert.notEqual(landed, before, 'a commit landed while the claim waited');
  assert.equal(claim.row.metadata.start_commit, landed, 'the job began on that commit, not the one before it');
  assert.equal(tasks.getTask(ctx.db, job.id).metadata.start_commit, landed);
  assert.equal(startRecorded(ctx.db, job.id), landed, 'the claimed entry says the same');

  // The job makes no commit. When the builder says it is ready, the checkout is still on that commit, and the landing
  // check must read that as no work done, not as the commit that landed before the job began.
  assert.equal(tasks.readyTask(ctx.db, { id: job.id, actor: 'fleet-codex', proof: 'looked, nothing to change' }).ready, true);
  const row = tasks.getTask(ctx.db, job.id);
  assert.equal(row.metadata.work_commit, landed);
  const verdict = proveTaskLanding(row);
  assert.deepEqual([verdict.status, verdict.reason], ['no_op', 'no_commit_made']);
});

test('a job that does make a commit after its claim is still credited with it, and a claim that waits for nothing records the commit it began on', (t) => {
  const ctx = sandbox(t);
  const job = addJob(ctx);
  const began = git(ctx.app, ['rev-parse', 'HEAD']);
  assert.equal(tasks.claimTask(ctx.db, { id: job.id, claimedBy: 'fleet-codex', leaseMinutes: 60, leasePid: process.pid }).claimed, true);
  assert.equal(startRecorded(ctx.db, job.id), began);

  const made = commitSomething(ctx.app, 'made-by-the-job.txt');
  assert.equal(tasks.readyTask(ctx.db, { id: job.id, actor: 'fleet-codex', proof: 'changed one file' }).ready, true);
  const row = tasks.getTask(ctx.db, job.id);
  assert.equal(row.metadata.work_commit, made);
  assert.notEqual(proveTaskLanding(row).reason, 'no_commit_made');

  // A claim that is refused records nothing.
  const refused = tasks.claimTask(ctx.db, { id: job.id, claimedBy: 'fleet-gemini', leaseMinutes: 60, leasePid: process.pid });
  assert.equal(refused.claimed, false);
  assert.equal(startRecorded(ctx.db, job.id), began);
});
