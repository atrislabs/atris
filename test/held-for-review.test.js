'use strict';

const {
  CLI,
  PR_URL,
  COMMIT,
  FEEDBACK_TASK,
  tempRoot,
  watchClaims,
  flyWith,
  planeFor,
  callsTo,
  sandboxDb,
  heldJob,
  seasonOf,
  playsOf,
  cliWorkspace,
} = require('./helpers/held-review-fixtures');

// Work in a protected lane (feedback, billing, security, ...) is never merged
// by a flight. It goes to a person as an open pull request and the job waits in
// Review under the builder's name. Before this, the ship gate refused the whole
// ship, the flight released the claim with no reason, and `atris rating` scored
// good work as a drop while no pull request existed for anyone to review.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const tasks = require('../lib/task-db');
const fleet = require('../lib/fleet');
const { loadSeason, rosterRows } = require('../lib/gm-season');
const { readRosterRuns, summarizeRuns, OUTCOMES } = require('../lib/roster-runs');
const { attachStaleModels } = require('../lib/roster-stale');
const { ratingCommand } = require('../commands/rating');
const worktreeCommand = require('../commands/worktree');
const heldPullRequests = require('../lib/held-pull-requests');
const { scrubAgentEnv } = require('./helpers/agent-env');
const DAY = 86400000;

// ---------------------------------------------------------------------------
// Small pieces the flight and the gate share.

test('protectedLaneOfTask reads the tag and the todo tags, in any case', () => {
  assert.equal(fleet.protectedLaneOfTask({ tag: 'Feedback' }), 'feedback');
  assert.equal(fleet.protectedLaneOfTask({ tag: 'code', metadata: { todo_tags: ['docs', 'BILLING'] } }), 'billing');
  assert.equal(fleet.protectedLaneOfTask({ tag: 'code', metadata: { todo_tags: ['docs'] } }), null);
  assert.equal(fleet.protectedLaneOfTask({ tag: 'code' }), null);
  assert.equal(fleet.protectedLaneOfTask({}), null);
  assert.equal(fleet.protectedLaneOfTask(null), null);
  for (const tag of fleet.DENIED_TAGS) assert.equal(fleet.protectedLaneOfTask({ tag }), tag);
});

// One function decides protection everywhere. Staffing (isSafeLane), the ship gate and the flight's
// landing all ask protectedLaneOfTask, which reads a task's tag, its tags list, the tags
// `atris task tag` adds later (metadata.tags), hashtags in its title, and the tags it was imported
// with from TODO.md (metadata.todo_tags). A task staffed as safe that the landing read as protected
// would be built and then stuck; the other way round, a protected task would be merged.
test('staffing and landing decide protection with the same function', () => {
  const { taskTagTokens } = require('../lib/task-decision');
  for (const [task, lane] of [
    [{ tag: 'code', metadata: { tags: ['security'] } }, 'security'],
    [{ tag: 'code', metadata: { tags: ['docs', 'Deploy'] } }, 'deploy'],
    [{ tag: 'code', tags: ['payments'] }, 'payments'],
    [{ tag: 'code', title: 'Rotate the signing keys #security' }, 'security'],
    [{ tag: 'code', title: '#customer Reply to the angry email' }, 'customer'],
    [{ title: 'No tag at all, but #money' }, 'money'],
    [{ tag: 'code', metadata: { todo_tags: ['security'] } }, 'security'],
    [{ tag: 'code', metadata: { todo_tags: ['Docs', 'External'] } }, 'external'],
  ]) {
    assert.equal(fleet.isSafeLane(task), false, `staffing treats ${JSON.stringify(task)} as protected`);
    assert.equal(fleet.protectedLaneOfTask(task), lane, JSON.stringify(task));
  }
  // A hashtag counts here because the staffing check counts it: both read it through taskTagTokens.
  assert.ok(taskTagTokens({ title: 'Rotate the signing keys #security' }).includes('security'));
  assert.ok(taskTagTokens({ title: 'Rotate the signing keys #docs' }).includes('docs'));

  // Todo tags still count. With two lanes the first found wins, a task's own tags before its todo tags.
  assert.equal(fleet.protectedLaneOfTask({ tag: 'code', metadata: { tags: ['ui'], todo_tags: ['security'] } }), 'security');
  assert.equal(fleet.protectedLaneOfTask({ tag: 'billing', metadata: { tags: ['deploy'], todo_tags: ['security'] } }), 'billing');

  // Nothing protected stays unprotected, and staffing agrees. Words in a title are not tags.
  for (const task of [
    {},
    { tag: 'code' },
    { title: 'Fix the login page' },
    { tag: 'code', tags: ['docs'], metadata: { tags: ['ui'] }, title: 'Tidy the docs #docs' },
    { tag: 'code', metadata: { todo_tags: ['docs', 'cleanup'] } },
    { tag: 'code', title: 'Tighten security checks on the billing page' },
  ]) {
    assert.equal(fleet.protectedLaneOfTask(task), null, JSON.stringify(task));
    assert.equal(fleet.isSafeLane(task), true, JSON.stringify(task));
  }
});

test('shipPullRequest reads the link ship printed, and nothing when no pull request was opened', () => {
  assert.deepEqual(fleet.shipPullRequest(`push: origin x\npr: https://github.com/atrislabs/atris/pull/1700\ndone: worktree shipped\n`),
    { url: 'https://github.com/atrislabs/atris/pull/1700', number: 1700 });
  assert.deepEqual(fleet.shipPullRequest('pr: 41 https://github.example/repo/pull/41\ndone: worktree shipped\n'),
    { url: 'https://github.example/repo/pull/41', number: 41 });
  assert.deepEqual(fleet.shipPullRequest('pr: https://git.example/merge-requests/9\n'), { url: 'https://git.example/merge-requests/9' });
  assert.equal(fleet.shipPullRequest('pr: skipped (no commits ahead of base)\npr: \ndone: worktree shipped\n'), null);
  assert.equal(fleet.shipPullRequest('pr: skipped (--no-pr)\n'), null);
  assert.equal(fleet.shipPullRequest(''), null);
  assert.equal(fleet.shipPullRequest(undefined), null);
});

test('the flight names an open pull request to task ready without a merge commit, and merges only when told to', () => {
  assert.deepEqual(fleet.openPullRequestFlags({ url: PR_URL, number: 77 }), ['--pr-number', '77', '--pr-url', PR_URL]);
  assert.deepEqual(fleet.openPullRequestFlags({ url: PR_URL }), ['--pr-url', PR_URL]);
  assert.deepEqual(fleet.openPullRequestFlags(null), []);
  const entry = { task: { display_id: 'BCK-1934', title: 'Fix the form. Done: x.' }, engine: 'codex', worktreePath: os.tmpdir() };
  const merging = fleet.fleetShipArgs(entry, 'node --test x.test.js', 'origin/master');
  const reviewing = fleet.fleetShipArgs(entry, 'node --test x.test.js', 'origin/master', { merge: false });
  assert.equal(merging.includes('--merge'), true);
  assert.equal(reviewing.includes('--merge'), false);
  assert.deepEqual(merging.filter((arg) => arg !== '--merge'), reviewing);
});
const flagValue = (args, flag) => args[args.indexOf(flag) + 1];

// The flight claims a job the store holds in its own process, and lets an unsaved held proof
// go itself the same way, through the task store it already holds its claim leases in. So the
// store needs a real job for it to claim: open, in the flight's workspace, which the flight
// claims as the builder with the lease the command line would have given it. The task the fake
// plane shows is what the task command shows for that job: its real id, the display id a person
// would read, and the workspace it sits in. builder is the name the flight will claim under.
function claimedForFlight(t, { builder = 'fleet-codex' } = {}) {
  const root = tempRoot(t);
  const workspace = tasks.workspaceRoot(root);
  const db = tasks.open();
  const { id } = tasks.addTask(db, { title: FEEDBACK_TASK.title, tag: 'feedback', workspaceRoot: workspace });
  const [shown] = tasks.withTaskDisplayRefs(tasks.listTasks(db, { workspaceRoot: workspace }));
  assert.notEqual(shown.display_id, id, 'a person reads the display id, which is not the row id');
  return { root, workspace, db, id, dbPath: process.env.ATRIS_TASKS_DB, task: { ...FEEDBACK_TASK, id, display_id: shown.display_id, workspace_root: workspace } };
}

// The job held by a builder before the flight starts, for a test whose flight cannot name the row
// it claims (so its claim does not reach the store) and then looks at what the store says.
function heldBy(seeded, builder) {
  const claim = tasks.claimTask(seeded.db, { id: seeded.id, claimedBy: builder, leaseMinutes: 60, leasePid: process.pid });
  assert.equal(claim.claimed, true);
  return claim;
}

// A job nobody holds yet, in the flight's own workspace, for a test whose claim is real.
// The folder gets an atris/ folder, which makes the real command take it as its workspace.
function openForFlight(t) {
  const root = tempRoot(t);
  fs.mkdirSync(path.join(root, 'atris'));
  const workspace = tasks.workspaceRoot(root);
  const db = tasks.open();
  const { id } = tasks.addTask(db, { title: FEEDBACK_TASK.title, tag: 'feedback', workspaceRoot: workspace });
  const [shown] = tasks.withTaskDisplayRefs(tasks.listTasks(db, { workspaceRoot: workspace }));
  return { root, workspace, db, id, dbPath: process.env.ATRIS_TASKS_DB, task: { ...FEEDBACK_TASK, id, display_id: shown.display_id, workspace_root: workspace } };
}

// A real task command, run from the flight's folder against the sandbox store the way the
// flight's own command line runs it. The rest of the task plane stays a stand-in.
function realCommand(root) {
  return (args) => {
    const result = spawnSync(process.execPath, [CLI, ...args], {
      cwd: root,
      encoding: 'utf8',
      timeout: 30000,
      env: { ...scrubAgentEnv(), ATRIS_TASKS_DB: process.env.ATRIS_TASKS_DB, ATRIS_SKIP_UPDATE_CHECK: '1', NODE_NO_WARNINGS: '1' },
    });
    return { status: result.status, stdout: String(result.stdout || ''), stderr: String(result.stderr || '') };
  };
}

// The shell a flight can inherit: an agent tool's marker, a mission driver's, a codex sandbox's.
const AGENT_SESSION = { CLAUDECODE: '1', CODEX_SANDBOX: 'seatbelt', ATRIS_MISSION_DRIVER_DETACHED: '1' };
async function withEnv(vars, run) {
  const saved = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  Object.assign(process.env, vars);
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

// Every place the staffing check reads a tag, the landing reads it too: a lane the task got after it
// was made (`atris task tag` writes metadata.tags) or in its title is still a lane a person lands.
for (const [label, task] of [
  ['its tag', FEEDBACK_TASK],
  ['a todo tag', { ...FEEDBACK_TASK, tag: 'code', metadata: { todo_tags: ['billing'] } }],
  ['a tag added later with atris task tag', { ...FEEDBACK_TASK, tag: 'code', metadata: { tags: ['billing'] } }],
  ['its tags list', { ...FEEDBACK_TASK, tag: 'code', tags: ['billing'] }],
  ['a hashtag in its title', { ...FEEDBACK_TASK, tag: 'code', title: `#billing ${FEEDBACK_TASK.title}` }],
]) {
  test(`a fix in a protected lane (by ${label}) is shipped without --merge and waits in Review with its pull request`, async (t) => {
    const plane = planeFor(task);
    const { flight, logs, receipt } = await flyWith(t, plane);

    const [ship] = callsTo(plane, 'worktree', 'ship');
    assert.ok(ship, 'ship ran');
    assert.equal(ship.includes('--merge'), false, 'a flight never merges protected-lane work');
    assert.equal(flagValue(ship, '--verify'), 'node --test test/form.test.js');

    assert.deepEqual(flight.landed, []);
    assert.deepEqual(flight.paused, []);
    assert.equal(flight.status, 'completed', 'a fix waiting for review is not a failed flight');
    assert.equal(flight.held_for_review.length, 1);
    const [held] = flight.held_for_review;
    assert.equal(held.task, 'BCK-1934');
    assert.equal(held.engine, 'codex');
    assert.equal(held.lane, task.tag === 'feedback' ? 'feedback' : 'billing');
    assert.deepEqual(held.pull_request, { url: PR_URL, number: 77 });
    assert.equal(held.review_recorded, true);
    assert.equal(held.verifier_result.passed, true);

    // The proof goes to Review under the builder's name with the pull request
    // and no merge commit, so nothing reads it as landed.
    const [ready] = callsTo(plane, 'task', 'ready');
    assert.equal(ready[2], 'BCK-1934');
    assert.equal(flagValue(ready, '--as'), 'fleet-codex');
    assert.equal(flagValue(ready, '--pr-url'), PR_URL);
    assert.equal(flagValue(ready, '--pr-number'), '77');
    for (const flag of ['--merge-commit', '--self-landed', '--merged-at']) assert.equal(ready.includes(flag), false, flag);
    assert.match(flagValue(ready, '--proof'), /not merged: pull request https:\/\/github\.example\/repo\/pull\/77 waits for a person to land it/);
    assert.match(flagValue(ready, '--proof'), /# pass 3/, 'the proof carries the real verifier output');
    assert.match(flagValue(ready, '--checked'), /passed before the pull request was opened/);

    // The claim stays with the builder: no release, and so no drop on the rating.
    assert.deepEqual(callsTo(plane, 'task', 'release'), []);

    assert.ok(logs.includes(`    ⏸ BCK-1934 waits for a person to land it: ${PR_URL}`), logs.join('\n'));
    assert.equal(logs.some((line) => /✓ landed/.test(line)), false);
    assert.ok(logs.some((line) => line.includes('dispatch over: 0 landed, 1 waiting for a person to land, 0 paused')), logs.join('\n'));

    // The receipt tells the held job apart from a landed one and from a failure.
    assert.equal(receipt.status, 'completed');
    assert.deepEqual(receipt.landed, []);
    assert.deepEqual(receipt.paused, []);
    assert.equal(receipt.held_for_review.length, 1);
    assert.equal(receipt.held_for_review[0].pull_request.url, PR_URL);
    assert.equal(receipt.held_for_review[0].review_recorded, true);
    assert.equal(receipt.result.kind, 'dispatch_held_for_review');
    assert.equal(receipt.result.passed, true);
    assert.equal(receipt.result.held_for_review, 1);
  });
}

// A yolo builder is handed a brief that says what the flight says about protected work: a person
// lands it. The builder commits and stops, so the flight is the only one that ships. If the builder
// shipped too, its pull request would open before the flight's own check, and a flight whose check
// or ship then failed would let go of the claim with that pull request open and unrecorded.
//
// The stand-in engine does what its brief orders: it commits and pushes nothing. The self-land check
// gives the stage the real check gives a commit that is not on master (self_land_missing). The flight
// then sends the commit through the same landing as any other protected fix: rebase, run the check
// again, ship once without --merge, and wait in Review with the pull request.
test('a protected-lane fix built in yolo mode is committed by the engine, shipped once without --merge by the flight, and waits in Review with its pull request', async (t) => {
  const plane = planeFor(FEEDBACK_TASK);
  const entries = [];
  const rebased = [];
  const { flight, logs, receipt } = await flyWith(t, plane, {
    options: {
      yolo: true,
      startCommitReader: () => 'base-commit',
      dispatcher: (entry) => {
        entries.push(entry);
        return Promise.resolve({ exitCode: 0, report: 'committed on the branch' });
      },
      rebase: (args) => {
        rebased.push(args);
        return { ok: true, stage: 'rebased' };
      },
      selfLandCheck: () => ({ ok: false, stage: 'self_land_missing', target: 'origin/master', detail: 'HEAD is not an ancestor of origin/master' }),
    },
  });

  // The engine keeps yolo, so its checks keep the network, but its brief orders a commit and no ship.
  assert.equal(entries.length, 1);
  assert.equal(entries[0].yolo, true);
  const brief = entries[0].prompt;
  assert.match(brief, /protected feedback lane/);
  assert.match(brief, /a person lands it/);
  assert.match(brief, /Do not push, do not run `atris worktree ship`, and do not create branches/);
  assert.doesNotMatch(brief, /--merge|--verify|then run:|PR URL/);

  // The engine never shipped. The one ship is the flight's own, and it does not merge.
  const ships = callsTo(plane, 'worktree', 'ship');
  assert.equal(ships.length, 1, 'only the flight ships');
  assert.equal(ships[0].includes('--target'), true, 'the one ship is the flight\'s, with its landing target');
  assert.equal(ships[0].includes('--merge'), false, `a ship merged protected work: ${ships[0].join(' ')}`);

  // The commit was not pushed, so the flight rebased it onto the target it ships to, then shipped.
  assert.equal(rebased.length, 1, 'an unpushed commit is rebased before it ships');
  assert.equal(rebased[0].targetRef, flagValue(ships[0], '--target'));

  // The flight does not call it landed, and does not pause or drop it.
  assert.ok(logs.includes('    BCK-1934 is committed but not landed; landing it now'), logs.join('\n'));
  assert.equal(logs.some((line) => /self-landed|✓ landed/.test(line)), false);
  assert.deepEqual(flight.landed, []);
  assert.deepEqual(flight.paused, []);
  assert.equal(flight.status, 'completed');
  assert.equal(flight.held_for_review.length, 1);
  const [held] = flight.held_for_review;
  assert.equal(held.task, 'BCK-1934');
  assert.equal(held.lane, 'feedback');
  assert.deepEqual(held.pull_request, { url: PR_URL, number: 77 });
  assert.equal(held.review_recorded, true);
  assert.equal(held.verifier_result.passed, true);

  // The job goes to Review under the builder with the open pull request and no merge commit, and the
  // claim stays: no release, so the rating sees good work waiting, not a drop.
  const [ready] = callsTo(plane, 'task', 'ready');
  assert.equal(ready[2], 'BCK-1934');
  assert.equal(flagValue(ready, '--as'), 'fleet-codex');
  assert.equal(flagValue(ready, '--pr-url'), PR_URL);
  assert.equal(flagValue(ready, '--pr-number'), '77');
  for (const flag of ['--merge-commit', '--self-landed', '--merged-at']) assert.equal(ready.includes(flag), false, flag);
  assert.match(flagValue(ready, '--proof'), /not merged: pull request https:\/\/github\.example\/repo\/pull\/77 waits for a person to land it/);
  assert.deepEqual(callsTo(plane, 'task', 'release'), []);

  assert.ok(logs.includes(`    ⏸ BCK-1934 waits for a person to land it: ${PR_URL}`), logs.join('\n'));
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.yolo, true);
  assert.deepEqual(receipt.landed, []);
  assert.equal(receipt.held_for_review.length, 1);
  assert.equal(receipt.held_for_review[0].pull_request.url, PR_URL);
  assert.equal(receipt.result.kind, 'dispatch_held_for_review');
  assert.equal(receipt.result.passed, true);
});

test('a safe-lane fix is still merged and counted as landed, with no held row', async (t) => {
  const task = { ...FEEDBACK_TASK, tag: 'code' };
  const record = JSON.stringify({ merge_commit: COMMIT, number: 4676, url: 'https://github.example/repo/pull/4676', merged_at: '2026-10-31T02:10:45Z' });
  const plane = planeFor(task, { shipOutput: `merge: merged\nmerge: record ${record}\ndone: worktree shipped\n` });
  const { flight, logs, receipt } = await flyWith(t, plane);

  assert.equal(callsTo(plane, 'worktree', 'ship')[0].includes('--merge'), true);
  assert.deepEqual(flight.landed.map((row) => row.task), ['BCK-1934']);
  assert.deepEqual(flight.held_for_review, []);
  assert.deepEqual(flight.paused, []);
  const [ready] = callsTo(plane, 'task', 'ready');
  assert.equal(flagValue(ready, '--merge-commit'), COMMIT);
  assert.equal(ready.includes('--self-landed'), true);
  assert.ok(logs.includes('    ✓ landed BCK-1934'));
  assert.equal(logs.some((line) => /waits for a person/.test(line)), false);
  assert.equal(receipt.result.kind, 'dispatch_landed');
  assert.equal(receipt.result.held_for_review, undefined);
  assert.deepEqual(receipt.held_for_review, []);
});

// Saving the proof of a held job failed. The pull request is open for a person, so the
// claim must not sit on its lease and then expire as a plain drop. The flight lets it
// go itself, in its own process, through the task store it already holds its leases
// in, and the event carries the kind and the pull request as fields. That is the only
// way to record it: `atris task release` takes no such flags, because any worker could
// pass them to excuse its own miss.

const heldRelease = () => ({
  released_by: 'fleet-codex',
  previous_claimed_by: 'fleet-codex',
  reason: `PR ${PR_URL} is open but its proof could not be saved: ready failed: nope`,
  kind: 'proof_not_saved',
  pull_request: { state: 'open', number: 77, url: PR_URL },
});

test('if saving the proof fails, the flight lets the claim go itself with the pull request link as the reason, and the event carries the kind and the pull request', async (t) => {
  const seeded = claimedForFlight(t);
  const plane = planeFor(seeded.task, { readyStatus: 1 });
  const { flight, logs, receipt } = await flyWith(t, plane, { root: seeded.root });

  // Not through the command line, where a flag is all it would take to say it.
  assert.deepEqual(callsTo(plane, 'task', 'release'), [], 'the flight records this release in its own process');
  assert.equal(plane.calls.some((args) => args.includes('--kind')), false);

  assert.equal(flight.status, 'failed');
  assert.equal(flight.paused.length, 1);
  const [paused] = flight.paused;
  assert.equal(paused.task, seeded.task.display_id);
  assert.equal(paused.stage, 'task_ready');
  assert.equal(paused.held_for_review, true);
  assert.equal(paused.landed, undefined);
  assert.match(paused.next_action, /leave the pull request open/);
  assert.deepEqual(paused.pull_request, { url: PR_URL, number: 77 });
  assert.equal(flight.held_for_review[0].review_recorded, false);

  // The claim opens again under the builder's own name, and the reason is where anyone finds the pull request.
  const row = tasks.getTask(seeded.db, seeded.id);
  assert.equal(row.status, 'open');
  assert.equal(row.claimed_by, null);
  assert.deepEqual(releaseEvents(seeded.db, seeded.id), [heldRelease()]);
  assert.equal(paused.claim_released, true);

  assert.ok(logs.some((line) => /the pull request is open, but saving its proof failed/.test(line)), logs.join('\n'));
  assert.ok(logs.includes(`    released the claim on ${seeded.task.display_id} with the pull request link as the reason`), logs.join('\n'));
  assert.equal(receipt.result.passed, false);
  assert.equal(receipt.paused[0].claim_released, true);
  assert.deepEqual(receipt.paused[0].pull_request, { url: PR_URL, number: 77 });
});

test('the rating shows the flight\'s own unsaved-proof release as waiting on a person, not as a drop', async (t) => {
  const seeded = claimedForFlight(t);
  await flyWith(t, planeFor(seeded.task, { readyStatus: 1 }), { root: seeded.root });

  const season = seasonOf(seeded.workspace, seeded.dbPath);
  assert.deepEqual(playsOf(season, seeded.id).map((o) => o.kind), ['took', 'held']);
  const member = memberRow(season, 'fleet-codex');
  assert.deepEqual([member.held, member.dropped, member.finished], [1, 0, 0]);
});

test('the same release is recorded when the flight inherits an agent session, a codex sandbox, and a mission driver: nothing in its shell can stop it', async (t) => {
  const seeded = claimedForFlight(t);
  const plane = planeFor(seeded.task, { readyStatus: 1 });
  const { flight } = await withEnv(AGENT_SESSION, () => flyWith(t, plane, { root: seeded.root }));

  assert.equal(flight.paused[0].claim_released, true);
  assert.equal(tasks.getTask(seeded.db, seeded.id).status, 'open');
  assert.deepEqual(releaseEvents(seeded.db, seeded.id), [heldRelease()]);
  const season = seasonOf(seeded.workspace, seeded.dbPath);
  assert.deepEqual(playsOf(season, seeded.id).map((o) => o.kind), ['took', 'held']);
  assert.equal(memberRow(season, 'fleet-codex').held, 1);
});

// The display id a person reads is not a key: the same folder name in another place gives
// the same ids. So the flight lets go of the exact row it claimed, the row id the task
// command showed it before the claim, and never looks the job up by what a person reads.
const eventCount = (db, id) => db.prepare('SELECT COUNT(*) AS n FROM task_events WHERE task_id = ?').get(id).n;

// The same folder name in another place gives the same display ids, so that workspace's
// first job reads the same to a person as the flight's own. It is held by the same name
// unless held is false. task is what the task command would print for it, with the workspace
// it sits in.
function jobInAnotherWorkspace(t, seeded, { held = true } = {}) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'held-other-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const root = path.join(parent, path.basename(seeded.root));
  fs.mkdirSync(root);
  const workspace = tasks.workspaceRoot(root);
  assert.notEqual(workspace, seeded.workspace);
  const { id } = tasks.addTask(seeded.db, { title: 'Fix the invoice page', tag: 'feedback', workspaceRoot: workspace });
  if (held) assert.equal(tasks.claimTask(seeded.db, { id, claimedBy: 'fleet-codex', leaseMinutes: 60, leasePid: process.pid }).claimed, true);
  const [shown] = tasks.withTaskDisplayRefs(tasks.listTasks(seeded.db, { workspaceRoot: workspace }));
  assert.equal(shown.display_id, seeded.task.display_id, 'a person cannot tell the two jobs apart by their display ids');
  const task = { ...FEEDBACK_TASK, id, display_id: shown.display_id, workspace_root: workspace, ...(held ? { status: 'claimed', claimed_by: 'fleet-codex' } : {}) };
  return { id, workspace, root, task };
}

test('the flight lets go of the exact job it claimed, not another workspace\'s job that shares its display id', async (t) => {
  const seeded = claimedForFlight(t);
  const other = jobInAnotherWorkspace(t, seeded);
  // The task list file as `atris task status --everywhere` can leave it in the flight's
  // folder: it names the other workspace's job and not this one.
  const file = path.join(seeded.root, '.atris', 'state', 'tasks.projection.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(tasks.taskProjection(seeded.db, { workspaceRoot: other.workspace, limit: 500 }), null, 2)}\n`);
  const listed = JSON.parse(fs.readFileSync(file, 'utf8')).tasks;
  assert.deepEqual(listed.map((task) => task.id), [other.id]);
  assert.equal(listed[0].display_id, seeded.task.display_id);
  const otherEventsBefore = eventCount(seeded.db, other.id);

  const { flight, logs } = await flyWith(t, planeFor(seeded.task, { readyStatus: 1 }), { root: seeded.root });

  // Its own job is let go, with the marker, and rates as waiting.
  assert.equal(flight.paused[0].claim_released, true, logs.join('\n'));
  const own = tasks.getTask(seeded.db, seeded.id);
  assert.equal(own.status, 'open');
  assert.equal(own.claimed_by, null);
  assert.deepEqual(releaseEvents(seeded.db, seeded.id), [heldRelease()]);
  assert.deepEqual(playsOf(seasonOf(seeded.workspace, seeded.dbPath), seeded.id).map((o) => o.kind), ['took', 'held']);

  // The other workspace's job is still held by the same name, and nothing was written to it.
  const theirs = tasks.getTask(seeded.db, other.id);
  assert.equal(theirs.status, 'claimed');
  assert.equal(theirs.claimed_by, 'fleet-codex');
  assert.deepEqual(releaseEvents(seeded.db, other.id), []);
  assert.equal(eventCount(seeded.db, other.id), otherEventsBefore, 'no new event on the other workspace\'s job');
});

test('a flight with no row id for the job does not release it, and the row says so', async (t) => {
  // What the task command showed carries no row id, so there is no exact row to let go of.
  const seeded = claimedForFlight(t);
  const { id, ...withoutId } = seeded.task;
  assert.ok(id);
  // The task command's claim by display id is what holds the job; the stand-in plane has no store to write to.
  heldBy(seeded, 'fleet-codex');
  const plane = planeFor(withoutId, { readyStatus: 1 });
  const { flight, logs, receipt } = await flyWith(t, plane, { root: seeded.root });

  assert.equal(flight.paused[0].task, seeded.task.display_id);
  assert.equal(flight.paused[0].claim_released, false);
  assert.equal(receipt.paused[0].claim_released, false);
  assert.ok(logs.some((line) => /could not release the claim on \S+: the flight has no row id for it/.test(line)), logs.join('\n'));
  assert.equal(tasks.getTask(seeded.db, seeded.id).status, 'claimed', 'it stays held until its lease runs out');
  assert.deepEqual(releaseEvents(seeded.db, seeded.id), []);
  assert.deepEqual(callsTo(plane, 'task', 'release'), [], 'nothing is sent through the command line by display id instead');
  // With no row id to name, the claim went by the display id, as it always did.
  assert.deepEqual(callsTo(plane, 'task', 'claim').map((args) => args[2]), [seeded.task.display_id]);
});

test('a row id the store does not know is not looked up again by display id', async (t) => {
  // The display id would find the held job. The row id the flight carries does not exist.
  const seeded = claimedForFlight(t);
  heldBy(seeded, 'fleet-codex');
  const plane = planeFor({ ...seeded.task, id: 'no-such-row' }, { readyStatus: 1 });
  const { flight, logs } = await flyWith(t, plane, { root: seeded.root });

  assert.equal(flight.paused[0].claim_released, false);
  assert.ok(logs.some((line) => /could not release the claim on \S+: release failed: not_found/.test(line)), logs.join('\n'));
  assert.equal(tasks.getTask(seeded.db, seeded.id).status, 'claimed');
  assert.deepEqual(releaseEvents(seeded.db, seeded.id), []);
});

// A flight works only on jobs in its own workspace, and it names each one by its row id at every
// step. The display id a person reads is not a key: the same folder name in another place gives
// the same ids, the list that gives an id its meaning can be written again between two commands,
// and the store takes a row id from any workspace. So right after the task command shows a job
// (the fleet flight: right after it picks the job from its list) the flight asks whose workspace
// that row is in, and a job that is not its own is refused: nothing is claimed, leased or built.
// For its own job, the row id it was shown is the word for the claim, the lease, task ready and
// every release.
//
// Which rows are inside a workspace is the store's own rule, the one its workspace listing uses:
// the workspace itself, and for a main checkout the linked git worktrees under it. A row with no
// workspace is in no workspace's listing, so a job shown with a row id and no workspace is
// refused too. A job shown with no row id has no row to ask about; it is named by its display id
// at every step, as it always was (that is the stand-in task plane).

// What the store says about a job now. new_events counts what it gained since `was`.
const claimEvents = (db, id) => db.prepare("SELECT COUNT(*) AS n FROM task_events WHERE task_id = ? AND event_type = 'claimed'").get(id).n;
const jobNow = (db, id, was) => {
  const row = tasks.getTask(db, id);
  return {
    status: row.status,
    claimed_by: row.claimed_by || null,
    ...(was === undefined ? {} : { new_events: eventCount(db, id) - was }),
    released: releaseEvents(db, id).length,
  };
};
const claimRefs = (plane) => [...callsTo(plane, 'task', 'claim').map((args) => args[2]), ...(plane.storeClaims || [])];
const readyRefs = (plane) => callsTo(plane, 'task', 'ready').map((args) => args[2]);
const releaseRefs = (plane) => callsTo(plane, 'task', 'release').map((args) => args[2]);

// Run something and answer which rows the flight leased while it ran.
async function leasing(run) {
  const leased = [];
  const real = tasks.setLease;
  tasks.setLease = (db, lease) => { leased.push([lease.id, lease.holder]); return real(db, lease); };
  try {
    return { leased, result: await run() };
  } finally {
    tasks.setLease = real;
  }
}

// Two jobs that read the same to a person: this workspace's own open job (local), and a job in
// another workspace (other), open unless held. The flight's folder keeps a task list file.
// writeList(workspace) writes it the way the task command does for that workspace, so the
// workspace it names is the one that owns the display id both jobs share.
function twoJobsOneName(t, { held }) {
  const local = openForFlight(t);
  const other = jobInAnotherWorkspace(t, local, { held });
  const file = path.join(local.root, '.atris', 'state', 'tasks.projection.json');
  const writeList = (workspace) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(tasks.taskProjection(local.db, { workspaceRoot: workspace, limit: 500 }), null, 2)}\n`);
  };
  const named = () => JSON.parse(fs.readFileSync(file, 'utf8')).tasks.map((task) => task.id);
  const was = { local: eventCount(local.db, local.id), other: eventCount(local.db, other.id) };
  return { local, other, writeList, named, was };
}

// What the other job looks like after a flight that must not touch it.
const untouched = (held) => (held
  ? { status: 'claimed', claimed_by: 'fleet-codex', new_events: 0, released: 0 }
  : { status: 'open', claimed_by: null, new_events: 0, released: 0 });

// The reviewer's input. The task command answers with another workspace's job (the list it read
// was last written by `atris task status --everywhere`, so it named that job under the display
// id), and by the time the flight would claim, the list names this workspace's own open job
// under the same display id. The other job is open or already held by the builder. Either way
// the flight refuses it, and neither job gets a new event.
for (const held of [false, true]) {
  test(`the dispatch flight refuses a job in another workspace before it claims anything, even when the list then changes to name its own job under that display id (the other job is ${held ? 'held' : 'open'})`, async (t) => {
    const { local, other, writeList, named, was } = twoJobsOneName(t, { held });
    writeList(other.workspace);
    assert.deepEqual(named(), [other.id], 'when the task command is asked, the list names the other workspace\'s job');
    // Once the task command has answered, the list is written again and names this workspace's job.
    const plane = planeFor(other.task, { readyStatus: 1, afterShow: () => writeList(local.workspace), afterClaim: () => writeList(local.workspace) });
    const { leased, result: { flight, logs, receipt } } = await leasing(() => flyWith(t, plane, { root: local.root }));
    const shown = other.task.display_id;
    assert.deepEqual(named(), [local.id], 'by the time of the claim, the list names this workspace\'s own open job under that display id');

    assert.deepEqual({
      shows: callsTo(plane, 'task', 'show').length,
      claims: claimRefs(plane),
      leased,
      paused: flight.paused.map((row) => [row.task, row.stage, row.detail]),
      built: callsTo(plane, 'worktree', 'start').length,
      readied: readyRefs(plane),
      released: releaseRefs(plane),
      local: jobNow(local.db, local.id, was.local),
      other: jobNow(local.db, other.id, was.other),
    }, {
      shows: 1,
      claims: [],
      leased: [],
      paused: [[shown, 'other_workspace', `${shown} names a job in another workspace`]],
      built: 0,
      readied: [],
      released: [],
      local: untouched(false),
      other: untouched(held),
    });
    assert.equal(flight.status, 'failed');

    // The pause is in the log and the receipt in plain words, under the display id a person reads.
    assert.ok(logs.includes(`    ✗ ${shown} names a job in another workspace`), logs.join('\n'));
    assert.equal(receipt.paused[0].stage, 'other_workspace');
    assert.equal(receipt.paused[0].detail, `${shown} names a job in another workspace`);
    assert.equal(logs.some((line) => line.includes(other.id) || line.includes(local.id)), false, 'no log line shows a row id');
  });
}

// A row the store lists in no workspace is outside every workspace: the listing of a workspace
// only takes rows whose workspace is that workspace or a worktree linked to it.
for (const [label, workspace_root] of [['shows none', undefined], ['shows an empty one', '']]) {
  test(`a job the task command shows with a row id and no workspace (it ${label}) is refused the same way`, async (t) => {
    const local = openForFlight(t);
    const was = eventCount(local.db, local.id);
    const plane = planeFor({ ...local.task, workspace_root });
    const { flight } = await flyWith(t, plane, { root: local.root });
    const shown = local.task.display_id;

    assert.deepEqual({
      claims: claimRefs(plane),
      paused: flight.paused.map((row) => [row.task, row.stage, row.detail]),
      built: callsTo(plane, 'worktree', 'start').length,
      released: releaseRefs(plane),
      local: jobNow(local.db, local.id, was),
    }, {
      claims: [],
      paused: [[shown, 'other_workspace', `${shown} names a job in another workspace`]],
      built: 0,
      released: [],
      local: untouched(false),
    });
  });
}

// The same two jobs, with the task command showing this workspace's own. The claim, the lease
// and the release all name the row it showed, and the other workspace's job that shares its
// display id is not touched, though the list names it by the time the flight has claimed.
test('the claim, the lease and the release all name the row the task command showed, and the other workspace\'s job that shares its display id is not touched', async (t) => {
  const { local, other, writeList, was } = twoJobsOneName(t, { held: true });
  const plane = planeFor(local.task, {
    readyStatus: 1,
    afterClaim: () => writeList(other.workspace),
  });
  // What the store holds for the row when the build starts.
  const atBuild = [];
  const inner = plane.cli;
  plane.cli = (args) => {
    if (args[0] === 'worktree' && args[1] === 'start') {
      const row = tasks.getTask(local.db, local.id);
      atBuild.push([row.status, row.claimed_by]);
    }
    return inner(args);
  };
  const { leased, result: { flight, logs, receipt } } = await leasing(() => flyWith(t, plane, { root: local.root }));
  const shown = local.task.display_id;

  // The job is shown once and named by that answer from then on: nothing is looked up again.
  assert.deepEqual({
    shows: callsTo(plane, 'task', 'show').length,
    claims: claimRefs(plane),
    atBuild,
    leased,
    paused: flight.paused.map((row) => [row.task, row.stage, row.claim_released]),
    local: { ...jobNow(local.db, local.id, was.local), claimed: claimEvents(local.db, local.id) },
    other: { ...jobNow(local.db, other.id, was.other), claimed: claimEvents(local.db, other.id) },
  }, {
    shows: 1,
    claims: [local.id],
    atBuild: [['claimed', 'fleet-codex']],
    leased: [[local.id, 'fleet-codex']],
    paused: [[shown, 'task_ready', true]],
    // The claim, the mark that its build started, and the release.
    local: { status: 'open', claimed_by: null, new_events: 3, released: 1, claimed: 1 },
    other: { ...untouched(true), claimed: 1 },
  });
  // The release is on that row, with the marker.
  assert.deepEqual(releaseEvents(local.db, local.id), [heldRelease()]);

  // Log lines and the receipt still say the display id a person reads. The work folder is named
  // by the row id (lowercased, so the sweep can find the job from its branch), and that folder
  // name is the only place a row id may show in the log.
  assert.equal(receipt.paused[0].task, shown);
  assert.ok(logs.includes(`    building ${shown} in dispatch-${local.id.toLowerCase()}`), logs.join('\n'));
  assert.ok(logs.includes(`    released the claim on ${shown} with the pull request link as the reason`), logs.join('\n'));
  const rowIds = [local.id, other.id].map((id) => id.toLowerCase());
  const outsideTheFolder = logs.filter((line) => rowIds.some((id) => line.toLowerCase().split(`dispatch-${id}`).join('').includes(id)));
  assert.deepEqual(outsideTheFolder, [], 'no log line shows a row id outside the work folder name');
  assert.equal(logs.some((line) => line.includes(other.id.toLowerCase())), false, 'the other workspace\'s row id is never shown');
});

test('a claim the store refuses pauses the dispatch flight at the claim under the display id a person reads, and nothing is leased, built or let go', async (t) => {
  // The task command shows the job open, but another builder holds it by the time of the claim.
  const { local, other, was } = twoJobsOneName(t, { held: false });
  assert.equal(tasks.claimTask(local.db, { id: local.id, claimedBy: 'fleet-gemini', leaseMinutes: 60, leasePid: process.pid }).claimed, true);
  was.local = eventCount(local.db, local.id);
  const plane = planeFor(local.task, { readyStatus: 1 });
  const { leased, result: { flight, logs } } = await leasing(() => flyWith(t, plane, { root: local.root }));
  const shown = local.task.display_id;

  assert.deepEqual({
    claims: claimRefs(plane),
    leased,
    paused: flight.paused.map((row) => [row.task, row.stage]),
    built: callsTo(plane, 'worktree', 'start').length,
    released: releaseRefs(plane),
    local: jobNow(local.db, local.id, was.local),
    other: jobNow(local.db, other.id, was.other),
  }, {
    claims: [local.id],
    leased: [],
    paused: [[shown, 'claim']],
    built: 0,
    released: [],
    local: { status: 'claimed', claimed_by: 'fleet-gemini', new_events: 0, released: 0 },
    other: untouched(false),
  });
  assert.match(flight.paused[0].detail, /claim failed: already_claimed \(held by fleet-gemini\)/);
  assert.ok(logs.includes(`    x ${shown} claim failed`), logs.join('\n'));
});

// The fleet flight picks its work from the task list file. A list entry carries the job's row id
// and the workspace it sits in, as the real list writes it.
const listedAs = (job, extra = {}) => ({
  id: job.id,
  display_id: job.task.display_id,
  workspace_root: job.workspace,
  status: 'open',
  title: 'edits lib/a.js Done: x. Check: node --test test/a.test.js.',
  ...extra,
});

// The fleet flight over a task list file. listed is what the file names when the flight reads
// it. atClaim runs once the store has answered the flight's claim, which is where a task command
// writes the list again. real names the task commands that go to the real command line (the
// flight claims in its own process, so claim is only answered here for a job the store has no
// row for); every other command is a stand-in that works, unless startsWorktree is false and
// the worktree cannot start.
async function flyFleet(t, local, { listed, atClaim = () => {}, real = [], startsWorktree = true }) {
  const file = path.join(local.root, '.atris', 'state', 'tasks.projection.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ tasks: listed }, null, 2)}\n`);
  const run = realCommand(local.root);
  const plane = { calls: [] };
  watchClaims(t, plane, atClaim);
  const cli = (args) => {
    plane.calls.push(args);
    if (args[0] === 'task') {
      const answer = real.includes(args[1]) ? run(args) : { status: 0, stdout: '', stderr: '' };
      if (args[1] === 'claim') atClaim();
      return answer;
    }
    if (args[0] === 'worktree' && args[1] === 'start') {
      return startsWorktree
        ? { status: 0, stdout: `next: cd ${local.root}/wt\n`, stderr: '' }
        : { status: 1, stdout: '', stderr: 'worktree start failed' };
    }
    return { status: 0, stdout: 'done: worktree shipped\n', stderr: '' };
  };
  const logs = [];
  const { leased, result: outcome } = await leasing(() => fleet.runFleetFlight({
    root: local.root,
    engines: ['codex'],
    log: (line = '') => logs.push(String(line)),
    ownCli: cli,
    dispatcher: () => Promise.resolve({ exitCode: 0, report: 'ok', stderr: '' }),
    lander: () => ({ ok: true, stage: 'shipped' }),
    guardCliLink: () => ({ changed: false, ok: true }),
  }).then((flight) => ({ flight }), (error) => ({ error })));
  return { plane, logs, leased, outcome };
}

// The reviewer's input for the fleet flight: the list names the other workspace's job as open,
// under the display id this workspace's own open job shares. It is refused before any claim, and
// should the flight claim anyway, the list is written again to name its own job.
for (const held of [false, true]) {
  test(`the fleet flight refuses a listed job whose row is in another workspace before it claims anything (the other job is ${held ? 'held' : 'open'})`, async (t) => {
    const { local, other, writeList, was } = twoJobsOneName(t, { held });
    const shown = local.task.display_id;
    const { plane, logs, leased, outcome } = await flyFleet(t, local, {
      listed: [listedAs(other)],
      atClaim: () => writeList(local.workspace),
    });

    assert.deepEqual({
      error: outcome.error && outcome.error.message,
      claims: claimRefs(plane),
      leased,
      paused: outcome.flight && outcome.flight.paused.map((row) => [row.task, row.engine, row.stage, row.detail]),
      built: callsTo(plane, 'worktree', 'start').length,
      released: releaseRefs(plane),
      local: jobNow(local.db, local.id, was.local),
      other: jobNow(local.db, other.id, was.other),
    }, {
      error: undefined,
      claims: [],
      leased: [],
      paused: [[shown, 'codex', 'other_workspace', `${shown} names a job in another workspace`]],
      built: 0,
      released: [],
      local: untouched(false),
      other: untouched(held),
    });
    assert.ok(logs.some((line) => line.endsWith(`✗ ${shown} names a job in another workspace`)), logs.join('\n'));
    assert.equal(logs.some((line) => line.includes(other.id) || line.includes(local.id)), false, 'no log line shows a row id');
  });
}

for (const [label, workspace_root] of [['names none', undefined], ['names an empty one', '']]) {
  test(`a listed job with a row id and no workspace (the list ${label}) is refused too`, async (t) => {
    const local = openForFlight(t);
    const was = eventCount(local.db, local.id);
    const { plane, outcome } = await flyFleet(t, local, { listed: [listedAs(local, { workspace_root })] });
    const shown = local.task.display_id;

    assert.deepEqual({
      claims: claimRefs(plane),
      paused: outcome.flight && outcome.flight.paused.map((row) => [row.task, row.stage, row.detail]),
      built: callsTo(plane, 'worktree', 'start').length,
      local: jobNow(local.db, local.id, was),
    }, {
      claims: [],
      paused: [[shown, 'other_workspace', `${shown} names a job in another workspace`]],
      built: 0,
      local: untouched(false),
    });
  });
}

test('the fleet flight claims and leases the row its own list named, even when the list is written again before the next command to name another workspace\'s job under that display id', async (t) => {
  const { local, other, writeList, was } = twoJobsOneName(t, { held: false });
  const shown = local.task.display_id;
  const { plane, logs, leased, outcome } = await flyFleet(t, local, {
    listed: [listedAs(local)],
    atClaim: () => writeList(other.workspace),
  });

  // The claim and the lease are on the row the list named, which the builder now holds. The
  // other workspace's job, which reads the same, is not touched.
  assert.deepEqual({
    error: outcome.error && outcome.error.message,
    claims: claimRefs(plane),
    leased,
    landed: outcome.flight && outcome.flight.landed.map((row) => row.task),
    local: jobNow(local.db, local.id, was.local),
    other: jobNow(local.db, other.id, was.other),
  }, {
    error: undefined,
    claims: [local.id],
    leased: [[local.id, 'fleet-codex']],
    landed: [shown],
    // The claim, and the mark that its build started.
    local: { status: 'claimed', claimed_by: 'fleet-codex', new_events: 2, released: 0 },
    other: untouched(false),
  });

  // Log lines still say the display id a person reads.
  assert.ok(logs.some((line) => line.includes(`building ${shown} in `)), logs.join('\n'));
  assert.equal(logs.some((line) => line.includes(other.id) || line.includes(local.id)), false, 'no log line shows a row id');
});

// The branch a flight builds a job on carries the job's row id, lowercased, as one word. The
// sweep that credits a builder for a pull request a person merged (`atris task sweep --held`)
// takes the branch as the proof that the pull request is this job's own build, so the branch has
// to say which job it is for. A display id cannot: the same folder name in another place gives the
// same ids, and the list that gives an id its meaning can be written again. `worktree start` builds
// the branch from the task name it is given, so every flight gives it the row id it already holds.
const ANOTHER_ROW_ID = '01K8X3M2Q4ABCDEFGHJKMNPQRS';
const branchOfStart = (args) => worktreeCommand.branchName(flagValue(args, '--agent'), flagValue(args, '--task'), new Date('2026-10-30T17:15:00Z'));

test('a flight names a branch for the row id after its kind, lowercased, and a job with no row id keeps the display id', () => {
  assert.equal(fleet.flightTaskName('dispatch', ANOTHER_ROW_ID), `dispatch-${ANOTHER_ROW_ID.toLowerCase()}`);
  assert.equal(fleet.flightTaskName('fleet', ANOTHER_ROW_ID), `fleet-${ANOTHER_ROW_ID.toLowerCase()}`);
  assert.equal(fleet.flightTaskName('dispatch', 'CLI-900'), 'dispatch-cli-900');
  // Every kind of flight fits the 36 characters `worktree start` keeps of a task name, so the whole id survives.
  for (const kind of ['dispatch', 'fleet']) {
    const branch = worktreeCommand.branchName('codex', fleet.flightTaskName(kind, ANOTHER_ROW_ID), new Date('2026-10-30T17:15:00Z'));
    assert.equal(branch, `codex/codex-${kind}-${ANOTHER_ROW_ID.toLowerCase()}-20261030-171500`);
    assert.equal(heldPullRequests.branchNamesJob(branch, ANOTHER_ROW_ID), true, kind);
  }
});

test('the dispatch flight builds on a branch named for the row id of the job it claimed', async (t) => {
  const seeded = claimedForFlight(t);
  assert.equal(seeded.id.length, 26, 'a row id is 26 characters');
  const plane = planeFor(seeded.task);

  const { logs } = await flyWith(t, plane, { root: seeded.root });

  const starts = callsTo(plane, 'worktree', 'start');
  assert.equal(starts.length, 1, logs.join('\n'));
  assert.equal(flagValue(starts[0], '--task'), `dispatch-${seeded.id.toLowerCase()}`);
  assert.ok(starts[0].includes('--force'), 'a retry still resumes the earlier run');
  assert.equal(claimRefs(plane)[0], seeded.id, 'and the claim went by the same row id');
  // The branch the real command cuts from that name is one the sweep reads as this job's own,
  // and no one else's.
  const branch = branchOfStart(starts[0]);
  assert.equal(heldPullRequests.branchNamesJob(branch, seeded.id), true, branch);
  assert.equal(heldPullRequests.branchNamesJob(branch, ANOTHER_ROW_ID), false, branch);
  assert.equal(logs.some((line) => line.includes(seeded.id)), false, 'no log line shows a row id');
});

test('the dispatch flight keeps the display id in the branch name when the task command gave no row id', async (t) => {
  const seeded = claimedForFlight(t);
  const { id, ...withoutId } = seeded.task;
  assert.ok(id);
  const plane = planeFor(withoutId);

  await flyWith(t, plane, { root: seeded.root });

  const starts = callsTo(plane, 'worktree', 'start');
  assert.equal(starts.length, 1);
  assert.equal(flagValue(starts[0], '--task'), `dispatch-${seeded.task.display_id.toLowerCase()}`);
  assert.equal(heldPullRequests.branchNamesJob(branchOfStart(starts[0]), id), false, 'such a branch proves nothing to the sweep');
});

// The review import (importReviewCommit) names its worktree the same way as the two flights, but it
// only runs in the sealed review-only lane, which no test reaches with an injected dispatcher. So
// the three places a flight starts a worktree are pinned here: each names the branch through
// flightTaskName, with the row id the flight holds.
test('every place a flight starts a worktree names the branch through flightTaskName', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'fleet.js'), 'utf8');
  const starts = [...source.matchAll(/cli\(\['worktree', 'start'[^\n]*\]\);/g)].map((match) => match[0]);
  assert.equal(starts.length, 3, 'the review import, the fleet flight and the dispatch flight');
  for (const call of starts) {
    const named = /'--task', flightTaskName\('(dispatch|fleet)', (ref|rowRef)\)/.exec(call);
    assert.ok(named, call);
    // Each also hands over the older, display-id name of the same kind of flight, so start can say
    // where unfinished work under that name may be (it never resumes it; see formerTaskArgs).
    const former = /\.\.\.formerTaskArgs\('(dispatch|fleet)', (ref|rowRef), (taskId|entry\.task\.display_id)\)/.exec(call);
    assert.ok(former, `${call} hands over the older name too`);
    assert.deepEqual([former[1], former[2]], [named[1], named[2]], call);
  }
  assert.match(source, /ref: jobRef\(entry\.task, entry\.taskId\),/, 'the review import is handed the row id the flight holds');
});

// Before the branch carried the row id it carried the display id a person reads. A display name is not
// an identity, so start never resumes a branch under it and is never held up by one; a flight that
// names the job by its row id still hands `worktree start` the older name, and start names a branch
// left unfinished under it in one line.
test('the older, display-id name is handed over only when it differs from the row-id name', () => {
  assert.deepEqual(fleet.formerTaskArgs('dispatch', ANOTHER_ROW_ID, 'FEED-12'), ['--former-task', 'dispatch-feed-12']);
  assert.deepEqual(fleet.formerTaskArgs('fleet', ANOTHER_ROW_ID, 'feed-12'), ['--former-task', 'fleet-feed-12']);
  // A job shown with no row id is named by its display id at every step: there is no older name.
  assert.deepEqual(fleet.formerTaskArgs('dispatch', 'CLI-900', 'CLI-900'), []);
  assert.deepEqual(fleet.formerTaskArgs('fleet', 'cli-900', 'CLI-900'), []);
  // And with no display id there is nothing to hand over.
  for (const missing of ['', undefined, null]) assert.deepEqual(fleet.formerTaskArgs('dispatch', ANOTHER_ROW_ID, missing), [], String(missing));
});

test('the dispatch flight also hands worktree start the job\'s display-id name', async (t) => {
  const seeded = claimedForFlight(t);
  const plane = planeFor(seeded.task);

  await flyWith(t, plane, { root: seeded.root });

  const [start] = callsTo(plane, 'worktree', 'start');
  assert.equal(flagValue(start, '--task'), `dispatch-${seeded.id.toLowerCase()}`);
  assert.equal(flagValue(start, '--former-task'), `dispatch-${seeded.task.display_id.toLowerCase()}`);
  assert.equal(start.filter((arg) => arg === '--former-task').length, 1);
  assert.ok(start.includes('--force'), 'a retry still resumes the earlier run');
});

test('the dispatch flight hands over no older name when the task command gave no row id', async (t) => {
  const seeded = claimedForFlight(t);
  const { id, ...withoutId } = seeded.task;
  assert.ok(id);
  const plane = planeFor(withoutId);

  await flyWith(t, plane, { root: seeded.root });

  const [start] = callsTo(plane, 'worktree', 'start');
  assert.equal(flagValue(start, '--task'), `dispatch-${seeded.task.display_id.toLowerCase()}`);
  assert.equal(start.includes('--former-task'), false, 'the name is the display id already');
});

test('the fleet flight builds on a branch named for the row id of the job it claimed', async (t) => {
  const local = openForFlight(t);
  assert.equal(local.id.length, 26, 'a row id is 26 characters');

  const { plane, logs } = await flyFleet(t, local, { listed: [listedAs(local)], real: ['claim'] });

  const starts = callsTo(plane, 'worktree', 'start');
  assert.equal(starts.length, 1, logs.join('\n'));
  assert.equal(flagValue(starts[0], '--task'), `fleet-${local.id.toLowerCase()}`);
  assert.equal(claimRefs(plane)[0], local.id, 'and the claim went by the same row id');
  const branch = branchOfStart(starts[0]);
  assert.equal(heldPullRequests.branchNamesJob(branch, local.id), true, branch);
  assert.equal(heldPullRequests.branchNamesJob(branch, ANOTHER_ROW_ID), false, branch);
});

test('the fleet flight also hands worktree start the job\'s display-id name', async (t) => {
  const local = openForFlight(t);

  const { plane, logs } = await flyFleet(t, local, { listed: [listedAs(local)], real: ['claim'] });

  const [start] = callsTo(plane, 'worktree', 'start');
  assert.ok(start, logs.join('\n'));
  assert.equal(flagValue(start, '--task'), `fleet-${local.id.toLowerCase()}`);
  assert.equal(flagValue(start, '--former-task'), `fleet-${local.task.display_id.toLowerCase()}`);
  assert.equal(start.filter((arg) => arg === '--former-task').length, 1);
});

test('a claim the store refuses pauses the fleet flight under the display id a person reads, and nothing is leased, built or let go', async (t) => {
  // The list says this workspace's job is open, but another builder holds it by the time of the claim.
  const { local, other, was } = twoJobsOneName(t, { held: false });
  assert.equal(tasks.claimTask(local.db, { id: local.id, claimedBy: 'fleet-gemini', leaseMinutes: 60, leasePid: process.pid }).claimed, true);
  was.local = eventCount(local.db, local.id);
  const shown = local.task.display_id;
  const { plane, logs, leased, outcome } = await flyFleet(t, local, { listed: [listedAs(local)] });

  assert.deepEqual({
    error: outcome.error && outcome.error.message,
    claims: claimRefs(plane),
    paused: outcome.flight && outcome.flight.paused.map((row) => [row.task, row.engine, row.stage]),
    leased,
    built: callsTo(plane, 'worktree', 'start').length,
    released: releaseRefs(plane),
    local: jobNow(local.db, local.id, was.local),
    other: jobNow(local.db, other.id, was.other),
  }, {
    error: undefined,
    claims: [local.id],
    paused: [[shown, 'codex', 'claim']],
    leased: [],
    built: 0,
    released: [],
    local: { status: 'claimed', claimed_by: 'fleet-gemini', new_events: 0, released: 0 },
    other: untouched(false),
  });
  assert.match(outcome.flight.paused[0].detail, /claim failed: already_claimed \(held by fleet-gemini\)/);

  // The flight's own line and row name the job the way a person reads it.
  assert.ok(logs.some((line) => line.includes(`paused ${shown} at claim`)), logs.join('\n'));
});

// The name-collision state: this workspace's own job (local) is claimed by the flight, and from
// then on the task list file names another workspace's job (other) under the same display id. A
// command that finds the job again by what a person reads would now land on the other job. The
// task commands the flight still sends run for real, so a display id resolves the way it really
// does.
function collision(t, { held }) {
  const jobs = twoJobsOneName(t, { held });
  const run = realCommand(jobs.local.root);
  // Once the claim has gone through, the list is written for the other workspace.
  const afterClaim = () => jobs.writeList(jobs.other.workspace);
  return { ...jobs, run, afterClaim };
}

test('task ready names the row the dispatch flight claimed, so the other workspace\'s job under the same display id gets no proof', async (t) => {
  const { local, other, run, afterClaim, was } = collision(t, { held: true });
  const plane = planeFor(local.task, { afterClaim, ready: run });
  const { flight } = await flyWith(t, plane, { root: local.root });
  const shown = local.task.display_id;

  assert.deepEqual({
    readied: readyRefs(plane),
    held: flight.held_for_review.map((row) => [row.task, row.review_recorded]),
    paused: flight.paused,
    local: { ...jobNow(local.db, local.id), proofs: proofPayloads(local.db, local.id).length },
    other: { ...jobNow(local.db, other.id, was.other), proofs: proofPayloads(local.db, other.id).length },
  }, {
    readied: [local.id],
    held: [[shown, true]],
    paused: [],
    local: { status: 'review', claimed_by: 'fleet-codex', released: 0, proofs: 1 },
    other: { ...untouched(true), proofs: 0 },
  });
  assert.deepEqual(proofPayloads(local.db, local.id)[0].pull_request, { state: 'open', number: 77, url: PR_URL });
});

for (const held of [true, false]) {
  test(`a job the dispatch flight never started is let go by its row id, so the other workspace's job under the same display id is not (the other job is ${held ? 'held' : 'open'})`, async (t) => {
    const { local, other, run, afterClaim, was } = collision(t, { held });
    const plane = planeFor(local.task, { afterClaim, release: run, worktreeStart: () => ({ status: 1, stdout: '', stderr: 'worktree start failed' }) });
    const { flight } = await flyWith(t, plane, { root: local.root });
    const shown = local.task.display_id;

    // A job that never started is let go in the flight's own process, on the row it claimed (marked as
    // one that could not start), so no release goes through the task command.
    assert.deepEqual({
      released: releaseRefs(plane),
      paused: flight.paused.map((row) => [row.task, row.stage, row.claim_released]),
      local: jobNow(local.db, local.id),
      other: jobNow(local.db, other.id, was.other),
    }, {
      released: [],
      paused: [[shown, 'worktree_start', true]],
      local: { status: 'open', claimed_by: null, released: 1 },
      other: untouched(held),
    });
    assert.match(releaseEvents(local.db, local.id)[0].reason, /^paused at worktree start: worktree start failed$/);
    assert.equal(releaseEvents(local.db, local.id)[0].kind, 'could_not_start');
  });

  test(`a paused claim with no work is let go by its row id at the end of the dispatch flight, so the other workspace's job under the same display id is not (the other job is ${held ? 'held' : 'open'})`, async (t) => {
    const { local, other, run, afterClaim, was } = collision(t, { held });
    // The branch is pushed but no pull request link comes back, so the flight pauses at ship.
    const plane = planeFor(local.task, { afterClaim, release: run, shipOutput: 'push: origin codex/dispatch\ndone: worktree shipped\n' });
    const { flight } = await flyWith(t, plane, { root: local.root });
    const shown = local.task.display_id;

    // The engine ran on this job, so it is let go in the flight's own process too, on the row and the claim it made,
    // as an ordinary release (no kind), and no release goes through the task command.
    assert.deepEqual({
      released: releaseRefs(plane),
      paused: flight.paused.map((row) => [row.task, row.stage, row.claim_released]),
      local: jobNow(local.db, local.id),
      other: jobNow(local.db, other.id, was.other),
    }, {
      released: [],
      paused: [[shown, 'ship', true]],
      local: { status: 'open', claimed_by: null, released: 1 },
      other: untouched(held),
    });
    assert.match(releaseEvents(local.db, local.id)[0].reason, /^paused at ship: /);
    assert.equal(releaseEvents(local.db, local.id)[0].kind, undefined);
  });

  test(`a paused claim with no work is let go by its row id at the end of the fleet flight, so the other workspace's job under the same display id is not (the other job is ${held ? 'held' : 'open'})`, async (t) => {
    const { local, other, afterClaim, was } = collision(t, { held });
    const shown = local.task.display_id;
    const { plane, outcome } = await flyFleet(t, local, {
      listed: [listedAs(local)],
      atClaim: afterClaim,
      real: ['release'],
      startsWorktree: false,
    });

    // This pause is a job that never started, so it is let go in the flight's own process, on the row it
    // claimed, and no release goes through the task command.
    assert.deepEqual({
      error: outcome.error && outcome.error.message,
      released: releaseRefs(plane),
      paused: outcome.flight && outcome.flight.paused.map((row) => [row.task, row.stage, row.claim_released]),
      local: jobNow(local.db, local.id),
      other: jobNow(local.db, other.id, was.other),
    }, {
      error: undefined,
      released: [],
      paused: [[shown, 'worktree_start', true]],
      local: { status: 'open', claimed_by: null, released: 1 },
      other: untouched(held),
    });
    assert.equal(releaseEvents(local.db, local.id)[0].kind, 'could_not_start');
  });
}

test('task ready names the row the fleet flight claimed, so the other workspace\'s job under the same display id gets no proof', async (t) => {
  const { local, other, writeList, was } = twoJobsOneName(t, { held: true });
  const shown = local.task.display_id;
  const { plane, outcome } = await flyFleet(t, local, {
    listed: [listedAs(local)],
    atClaim: () => writeList(other.workspace),
    real: ['ready'],
  });

  assert.deepEqual({
    error: outcome.error && outcome.error.message,
    readied: readyRefs(plane),
    landed: outcome.flight && outcome.flight.landed.map((row) => [row.task, row.review_recorded]),
    paused: outcome.flight && outcome.flight.paused,
    local: { ...jobNow(local.db, local.id), proofs: proofPayloads(local.db, local.id).length },
    other: { ...jobNow(local.db, other.id, was.other), proofs: proofPayloads(local.db, other.id).length },
  }, {
    error: undefined,
    readied: [local.id],
    landed: [[shown, true]],
    paused: [],
    local: { status: 'review', claimed_by: 'fleet-codex', released: 0, proofs: 1 },
    other: { ...untouched(true), proofs: 0 },
  });
});

// Every place the flight sends task ready or a release, with nothing in the way: it names the
// row id the task command showed. The stand-in task plane answers, so the arguments are the test.
const A_PROOF_ONLY = { reviewOnly: true, verifierCommand: 'node --test test/form.test.js', changeInspector: () => ({ has_change: true, base: '1'.repeat(40), head: '2'.repeat(40), commit: '2'.repeat(40), dirty: false }) };
const MERGE_RECORD = JSON.stringify({ merge_commit: COMMIT, number: 4676, url: 'https://github.example/repo/pull/4676', merged_at: '2026-10-31T02:10:45Z' });

for (const [label, fly] of [
  ['a protected-lane fix waiting for a person to land it', (t, seeded) => {
    const plane = planeFor(seeded.task);
    return flyWith(t, plane, { root: seeded.root }).then(() => plane);
  }],
  ['a safe-lane fix that landed', (t, seeded) => {
    const plane = planeFor({ ...seeded.task, tag: 'code' }, { shipOutput: `merge: merged\nmerge: record ${MERGE_RECORD}\ndone: worktree shipped\n` });
    return flyWith(t, plane, { root: seeded.root }).then(() => plane);
  }],
  ['a proof for Review that nothing lands', (t, seeded) => {
    const plane = planeFor(seeded.task);
    return flyWith(t, plane, { root: seeded.root, options: A_PROOF_ONLY }).then(() => plane);
  }],
  ['a fix the fleet flight landed', async (t, seeded) => {
    const { plane } = await flyFleet(t, seeded, { listed: [listedAs(seeded)] });
    return plane;
  }],
]) {
  test(`task ready is sent with the job's row id: ${label}`, async (t) => {
    const seeded = claimedForFlight(t);
    const plane = await fly(t, seeded);
    assert.deepEqual(readyRefs(plane), [seeded.id]);
  });
}

// A job the store holds a row for is claimed and let go in the flight's own process (below), so the task command
// is asked to release only a job the store has no row for. It still names the row id the task command showed.
for (const [label, fly] of [
  ['the worktree could not start on a job the store holds no row for', (t, seeded) => {
    const plane = planeFor({ ...seeded.task, id: 'row-the-store-lacks' }, { worktreeStart: () => ({ status: 1, stdout: '', stderr: 'worktree start failed' }) });
    return flyWith(t, plane, { root: seeded.root }).then(() => plane);
  }],
]) {
  test(`a release is sent with the job's row id: ${label}`, async (t) => {
    const seeded = claimedForFlight(t);
    const plane = await fly(t, seeded);
    assert.deepEqual(releaseRefs(plane), [plane.task.id]);
    assert.equal(plane.task.id, 'row-the-store-lacks');
    const [release] = callsTo(plane, 'task', 'release');
    assert.equal(flagValue(release, '--as'), 'fleet-codex');
  });
}

// A claim the flight made is let go in the flight's own process, not through the task command: on the row id
// the task command showed, by the builder that claimed it, and only if the job is still held under that very
// claim. A job that never started (no engine ran) is marked as one that could not start.
// The task command is not asked to release it.
for (const [label, fly] of [
  ['the worktree could not start', (t, seeded) => {
    const plane = planeFor(seeded.task, { worktreeStart: () => ({ status: 1, stdout: '', stderr: 'worktree start failed' }) });
    return flyWith(t, plane, { root: seeded.root }).then(() => plane);
  }],
  ['the fleet flight could not start a worktree', async (t, seeded) => {
    const { plane } = await flyFleet(t, seeded, { listed: [listedAs(seeded)], startsWorktree: false });
    return plane;
  }],
  // The sealed review flight builds in the temp folder, so its disk check asks about that folder with the
  // check on: a roomy disk is given, so this test does not depend on the machine it runs on.
  ['the sealed review sandbox could not be prepared', (t, seeded) => {
    const plane = planeFor(seeded.task);
    return flyWith(t, plane, { root: seeded.root, options: { ...A_PROOF_ONLY, dispatcher: null, freeSpace: () => 50e9 } }).then(() => plane);
  }],
]) {
  test(`a release of a job that never started lands on the job's row id, in process: ${label}`, async (t) => {
    const seeded = claimedForFlight(t);
    const plane = await fly(t, seeded);
    assert.deepEqual(releaseRefs(plane), []);
    const events = releaseEvents(seeded.db, seeded.id);
    assert.equal(events.length, 1);
    assert.equal(events[0].released_by, 'fleet-codex');
    assert.equal(events[0].kind, 'could_not_start');
    assert.deepEqual(jobNow(seeded.db, seeded.id), { status: 'open', claimed_by: null, released: 1 });
  });
}

// A job the engine ran on, paused at ship with nothing to keep, is let go the same way, in process, as an ordinary
// release: the engine started, so it is not a job that could not start.
test('a release of a job the engine ran on lands on the job\'s row id, in process, as an ordinary release: the flight paused at ship and the job holds no work', async (t) => {
  const seeded = claimedForFlight(t);
  const plane = planeFor(seeded.task, { shipOutput: 'push: origin codex/dispatch\ndone: worktree shipped\n' });
  await flyWith(t, plane, { root: seeded.root });

  assert.deepEqual(releaseRefs(plane), []);
  const events = releaseEvents(seeded.db, seeded.id);
  assert.equal(events.length, 1);
  assert.equal(events[0].released_by, 'fleet-codex');
  assert.equal(events[0].kind, undefined);
  assert.match(events[0].reason, /^paused at ship: /);
  assert.deepEqual(jobNow(seeded.db, seeded.id), { status: 'open', claimed_by: null, released: 1 });
});

// The flight's folder is compared with the job's workspace the way the store spells it, through
// its real path. A folder reached through a link is the same workspace as the folder itself.
test('a flight started from a link to its folder still works on its own workspace\'s job', async (t) => {
  const seeded = claimedForFlight(t);
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'held-link-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const link = path.join(parent, 'link');
  fs.symlinkSync(seeded.root, link);
  assert.notEqual(link, seeded.workspace);
  const plane = planeFor(seeded.task);
  const { flight } = await flyWith(t, plane, { root: link });

  assert.deepEqual(flight.paused, []);
  assert.deepEqual(claimRefs(plane), [seeded.id]);
  assert.equal(flight.held_for_review.length, 1);
});

// A main checkout's listing also covers the git worktrees linked to it, whose jobs keep the
// worktree as their workspace. A job there is the flight's own, as the old claim by display id
// (which went through that listing) always treated it.
test('a job whose row sits in a git worktree linked to the flight\'s workspace is its own', async (t) => {
  const root = tempRoot(t);
  const git = (args, cwd = root) => {
    const run = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    return run.stdout.trim();
  };
  git(['init', '-q']);
  git(['config', 'user.name', 'Test User']);
  git(['config', 'user.email', 'test@example.com']);
  fs.writeFileSync(path.join(root, 'app.js'), 'module.exports = 1;\n');
  git(['add', '.']);
  git(['commit', '-qm', 'initial']);
  const side = fs.mkdtempSync(path.join(os.tmpdir(), 'held-linked-'));
  t.after(() => fs.rmSync(side, { recursive: true, force: true }));
  const linked = path.join(side, 'linked');
  git(['worktree', 'add', '-q', '-b', 'side', linked]);

  const db = tasks.open();
  const workspace = tasks.workspaceRoot(linked);
  assert.notEqual(workspace, tasks.workspaceRoot(root));
  const { id } = tasks.addTask(db, { title: FEEDBACK_TASK.title, tag: 'feedback', workspaceRoot: workspace });
  const plane = planeFor({ ...FEEDBACK_TASK, id, display_id: 'SIDE-1', workspace_root: workspace });
  // A flight in a git checkout builds on a local branch and stops at a proof for Review.
  const { flight } = await flyWith(t, plane, { root, options: { changeInspector: A_PROOF_ONLY.changeInspector } });

  assert.deepEqual(flight.paused, []);
  assert.deepEqual({ claims: claimRefs(plane), readied: readyRefs(plane), ready: flight.ready.length }, { claims: [id], readied: [id], ready: 1 });
});

// Which rows are inside a workspace is decided in one place, the store, by the rule its own
// listing uses. The flight asks the store; it does not spell the rule again.
test('the store says a row is inside a workspace by the rule its own listing uses: the workspace, the git worktrees linked to it, and not a row with no workspace', (t) => {
  tempRoot(t);
  const db = tasks.open();
  const side = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'held-views-')));
  t.after(() => fs.rmSync(side, { recursive: true, force: true }));
  const main = path.join(side, 'main');
  const linked = path.join(side, 'linked');
  const elsewhere = path.join(side, 'elsewhere');
  fs.mkdirSync(main);
  fs.mkdirSync(elsewhere);
  const git = (args) => {
    const run = spawnSync('git', args, { cwd: main, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
  };
  git(['init', '-q']);
  git(['config', 'user.name', 'Test User']);
  git(['config', 'user.email', 'test@example.com']);
  fs.writeFileSync(path.join(main, 'app.js'), 'module.exports = 1;\n');
  git(['add', '.']);
  git(['commit', '-qm', 'initial']);
  git(['worktree', 'add', '-q', '-b', 'side', linked]);

  const workspace = tasks.workspaceRoot(main);
  const add = (title, where) => tasks.addTask(db, { title, workspaceRoot: where }).id;
  const ids = {
    own: add('A job in the workspace', workspace),
    linked: add('A job in a git worktree linked to it', tasks.workspaceRoot(linked)),
    elsewhere: add('A job in another workspace', tasks.workspaceRoot(elsewhere)),
    nowhere: add('A job with no workspace', workspace),
  };
  db.prepare("UPDATE tasks SET workspace_root = '' WHERE id = ?").run(ids.nowhere);

  const listed = new Set(tasks.listTasks(db, { workspaceRoot: workspace }).map((row) => row.id));
  const inside = Object.fromEntries(Object.entries(ids).map(([name, id]) => [name, tasks.rowInWorkspace(tasks.getTask(db, id), workspace)]));
  assert.deepEqual(inside, { own: true, linked: true, elsewhere: false, nowhere: false });
  for (const [name, id] of Object.entries(ids)) assert.equal(inside[name], listed.has(id), `${name}: the answer the listing gives`);
  // Only the listing of every workspace shows a row that sits in none.
  assert.ok(tasks.listTasks(db, {}).some((row) => row.id === ids.nowhere));

  // A row that carries no workspace at all, no row, and no workspace to compare with are inside nothing.
  assert.equal(tasks.rowInWorkspace({ id: ids.own }, workspace), false);
  assert.equal(tasks.rowInWorkspace(null, workspace), false);
  assert.equal(tasks.rowInWorkspace(tasks.getTask(db, ids.own), ''), false);
});

// The real task commands end to end, for a job in the flight's own workspace: the task command
// shows it with its workspace, and the flight claims it (in its own process), proves it and leaves
// it in Review, all by its row id, without ever refusing it as another workspace's.
test('a job in the flight\'s own workspace goes through the real task commands without being refused, by its row id', async (t) => {
  const local = openForFlight(t);
  const run = realCommand(local.root);
  const plane = planeFor(local.task, { show: run, ready: run, release: run });
  const { flight, logs } = await flyWith(t, plane, { root: local.root });

  const shown = JSON.parse(run(['task', 'show', local.task.display_id, '--json']).stdout);
  assert.equal(shown.id, local.id);
  assert.equal(shown.workspace_root, local.workspace, 'the task command says which workspace the job sits in, spelled the way the store spells it');

  assert.deepEqual({
    paused: flight.paused,
    held: flight.held_for_review.map((row) => [row.task, row.review_recorded]),
    claims: claimRefs(plane),
    readied: readyRefs(plane),
    released: releaseRefs(plane),
    job: jobNow(local.db, local.id),
  }, {
    paused: [],
    held: [[local.task.display_id, true]],
    claims: [local.id],
    readied: [local.id],
    released: [],
    job: { status: 'review', claimed_by: 'fleet-codex', released: 0 },
  });
  assert.equal(logs.some((line) => line.includes(local.id)), false, 'no log line shows a row id');
});

// The worktree start a stand-in task plane answers with, after looking at something the flight has drawn by then.
const startsAfter = (look) => (args) => {
  look();
  return { status: 0, stdout: `next: cd /wt/${args[args.indexOf('--task') + 1]}\n`, stderr: '' };
};

test('after the flight lets the claim go, the task list file shows the job open again, as the release command leaves it', async (t) => {
  const seeded = claimedForFlight(t);
  const file = path.join(seeded.root, '.atris', 'state', 'tasks.projection.json');
  const shown = () => JSON.parse(fs.readFileSync(file, 'utf8')).tasks.find((task) => task.id === seeded.id);
  // The file as the claim leaves it: the flight draws it when it claims, as the task command's claim does, so by
  // the time its build starts the file shows the job held by the builder.
  let asTheClaimLeftIt = null;
  const plane = planeFor(seeded.task, { readyStatus: 1, worktreeStart: startsAfter(() => { asTheClaimLeftIt = shown(); }) });

  await flyWith(t, plane, { root: seeded.root });

  assert.equal(asTheClaimLeftIt.status, 'claimed');
  assert.equal(asTheClaimLeftIt.claimed_by, 'fleet-codex');
  assert.equal(shown().status, 'open', 'the list file shows the released job as open again');
  assert.equal(shown().claimed_by || null, null);

  // The flight writes it with the command's own writer, into its own folder.
  const written = fs.readFileSync(file, 'utf8');
  const { writeDefaultProjection } = require('../commands/task');
  writeDefaultProjection(tasks, seeded.db, { root: seeded.root });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).tasks, JSON.parse(written).tasks);
});

// atris/TODO.md is a picture of the saved task state. `atris task release` redraws it after
// every release (the task command's own step for every change), so the flight does the same
// for its own workspace; a job it let go must not stay in In Progress.
const todoPath = (seeded) => path.join(seeded.root, 'atris', 'TODO.md');
const drawTodo = (seeded) => tasks.renderTodoMarkdown(
  tasks.listTasks(seeded.db, { workspaceRoot: seeded.workspace, limit: 500 }),
  { refRows: tasks.listTasks(seeded.db, { workspaceRoot: seeded.workspace }) },
);
const todoSection = (seeded, name) => {
  const lines = fs.readFileSync(todoPath(seeded), 'utf8').split('\n');
  const from = lines.indexOf(`## ${name}`);
  assert.ok(from >= 0, `${name} is in TODO.md`);
  const next = lines.findIndex((line, at) => at > from && line.startsWith('## '));
  return lines.slice(from + 1, next < 0 ? undefined : next).join('\n').trim();
};
// The workspace gets an atris/ folder, which is what makes the task command draw TODO.md at all. The flight draws
// it when it claims, as the task command's claim does: by the time its build starts, the job is under In Progress,
// held by the builder. The look is what the plane's worktree start does, which returns the answer a start gives.
function lookAtTodoAsTheClaimLeftIt(seeded, seen) {
  fs.mkdirSync(path.dirname(todoPath(seeded)), { recursive: true });
  return startsAfter(() => {
    seen.todo = fs.readFileSync(todoPath(seeded), 'utf8');
  });
}
function assertTodoAsTheClaimLeftIt(seeded, seen) {
  const lines = seen.todo.split('\n');
  const from = lines.indexOf('## In Progress');
  assert.ok(from >= 0, 'In Progress is in TODO.md');
  assert.match(lines.slice(from + 1, lines.findIndex((line, at) => at > from && line.startsWith('## '))).join('\n'), new RegExp(`\\[${seeded.task.display_id}\\].*fleet-codex`));
}

test('after the flight lets the claim go, atris/TODO.md in its workspace no longer shows the job as claimed', async (t) => {
  const seeded = claimedForFlight(t);
  const seen = {};

  await flyWith(t, planeFor(seeded.task, { readyStatus: 1, worktreeStart: lookAtTodoAsTheClaimLeftIt(seeded, seen) }), { root: seeded.root });

  assertTodoAsTheClaimLeftIt(seeded, seen);
  assert.equal(todoSection(seeded, 'In Progress'), '(Empty)', 'the released job is not shown as claimed');
  assert.match(todoSection(seeded, 'Backlog'), new RegExp(`\\[${seeded.task.display_id}\\]`));
  assert.equal(fs.readFileSync(todoPath(seeded), 'utf8'), drawTodo(seeded), 'it is the same picture the saved state draws');
});

test('a task list file that cannot be written does not undo a release that is already saved, nor stop TODO.md being redrawn', async (t) => {
  const seeded = claimedForFlight(t);
  const seen = {};
  // A folder where the list file goes: the write fails, after the claim and after the release are saved.
  fs.mkdirSync(path.join(seeded.root, '.atris', 'state', 'tasks.projection.json'), { recursive: true });
  const { flight, logs, receipt } = await flyWith(t, planeFor(seeded.task, { readyStatus: 1, worktreeStart: lookAtTodoAsTheClaimLeftIt(seeded, seen) }), { root: seeded.root });

  assertTodoAsTheClaimLeftIt(seeded, seen);
  assert.equal(tasks.getTask(seeded.db, seeded.id).status, 'open', 'the claim is let go');
  assert.deepEqual(releaseEvents(seeded.db, seeded.id), [heldRelease()]);
  assert.equal(flight.paused[0].claim_released, true, 'the row does not say the release failed when it was saved');
  assert.equal(receipt.paused[0].claim_released, true);
  assert.ok(logs.includes(`    released the claim on ${seeded.task.display_id} with the pull request link as the reason`), logs.join('\n'));
  assert.equal(logs.some((line) => /could not release/.test(line)), false, logs.join('\n'));
  assert.equal(todoSection(seeded, 'In Progress'), '(Empty)', 'the other file is still redrawn');
});

test('a release the store refuses or fails on is tried once and the row says so; a job the store does not know is said plainly', async (t) => {
  for (const [label, release, wanted] of [
    ['refuses', () => ({ released: false, reason: 'stale_task_state', claimed_by: 'fleet-codex' }), /could not release the claim on \S+: release failed: stale_task_state \(held by fleet-codex\)/],
    ['throws', () => { throw new Error('database is locked'); }, /could not release the claim on \S+: database is locked/],
    ['throws with nothing to say', () => { throw new Error(''); }, /could not release the claim on \S+: unknown/],
  ]) {
    const seeded = claimedForFlight(t);
    const plane = planeFor(seeded.task, { readyStatus: 1 });
    let attempts = 0;
    const real = tasks.releaseTask;
    tasks.releaseTask = (...args) => { attempts += 1; return release(...args); };
    let flown;
    try { flown = await flyWith(t, plane, { root: seeded.root }); } finally { tasks.releaseTask = real; }
    assert.equal(attempts, 1, `${label}: the end-of-flight pass does not retry it`);
    assert.deepEqual(callsTo(plane, 'task', 'release'), [], label);
    assert.equal(flown.flight.paused[0].claim_released, false, label);
    assert.equal(flown.receipt.paused[0].claim_released, false, label);
    assert.ok(flown.logs.some((line) => wanted.test(line)), `${label}: ${flown.logs.join('\n')}`);
    assert.equal(tasks.getTask(seeded.db, seeded.id).status, 'claimed', `${label}: it stays held until its lease runs out`);
  }

  const unknown = planeFor(FEEDBACK_TASK, { readyStatus: 1 });
  const { flight, logs } = await flyWith(t, unknown);
  assert.equal(flight.paused[0].claim_released, false);
  assert.ok(logs.some((line) => /could not release the claim on BCK-1934: the flight has no row id for it/.test(line)), logs.join('\n'));
  assert.deepEqual(callsTo(unknown, 'task', 'release'), [], 'nothing is sent through the command line instead');
});

test('the release reason carries only the first line of the save error, with the link first, and never more than 300 characters', async (t) => {
  for (const [readyError, check] of [
    ['\n  database is locked\n    at saveProof (task-db.js:12:3)\n', (reason) => assert.equal(reason, `PR ${PR_URL} is open but its proof could not be saved: database is locked`)],
    [`x${'y'.repeat(500)}`, (reason) => {
      assert.ok(reason.length <= 300, `${reason.length} characters`);
      assert.ok(reason.startsWith(`PR ${PR_URL} is open but its proof could not be saved: x`), 'the link comes first, so a long error never cuts it');
    }],
  ]) {
    const seeded = claimedForFlight(t);
    await flyWith(t, planeFor(seeded.task, { readyStatus: 1, readyError }), { root: seeded.root });
    const events = releaseEvents(seeded.db, seeded.id);
    assert.equal(events.length, 1, 'the flight recorded one release');
    const [payload] = events;
    check(payload.reason);
    assert.equal(payload.kind, 'proof_not_saved');
  }
});

test('every other release a flight makes goes through the command line as a plain release: no kind, no pull request', async (t) => {
  const noLink = planeFor(FEEDBACK_TASK, { shipOutput: 'push: origin codex/dispatch\ndone: worktree shipped\n' });
  await flyWith(t, noLink);
  const [plain] = callsTo(noLink, 'task', 'release');
  assert.ok(plain, 'that flight let its claim go');
  for (const flag of ['--kind', '--pr-url', '--pr-number']) assert.equal(plain.includes(flag), false, flag);
});

test('a protected-lane ship with no pull request link pauses at ship and says why, instead of pretending', async (t) => {
  for (const [shipOutput, wanted] of [
    ['pr: skipped (no commits ahead of base)\npr: \ndone: worktree shipped\n', 'no commits ahead of base, so there was no pull request to open'],
    ['push: origin codex/dispatch\ndone: worktree shipped\n', 'the branch was pushed, but no pull request link came back for the protected feedback lane'],
  ]) {
    const plane = planeFor(FEEDBACK_TASK, { shipOutput });
    const { flight } = await flyWith(t, plane);
    assert.deepEqual(flight.held_for_review, []);
    assert.deepEqual(flight.landed, []);
    assert.equal(flight.paused.length, 1);
    assert.equal(flight.paused[0].stage, 'ship');
    assert.equal(flight.paused[0].detail, wanted);
    assert.deepEqual(callsTo(plane, 'task', 'ready'), []);
    // Nothing is waiting on a person here, so the claim is let go, with the reason saved.
    const [release] = callsTo(plane, 'task', 'release');
    assert.equal(flagValue(release, '--reason'), `paused at ship: ${wanted}`);
  }
});
const memberRow = (season, name) => rosterRows({ outcomes: season.outcomes, limit: Number.MAX_SAFE_INTEGER }).find((row) => row.name === name);
const proofPayloads = (db, id) => db.prepare("SELECT payload FROM task_events WHERE task_id = ? AND event_type = 'proof_ready' ORDER BY version").all(id).map((row) => JSON.parse(row.payload));

test('a held job sits in Review under the builder with its open pull request on file, and nothing says it landed', (t) => {
  const { dir, db } = sandboxDb(t);
  const id = heldJob(db, dir);
  const row = tasks.getTask(db, id);
  assert.equal(row.status, 'review');
  assert.equal(row.claimed_by, 'fleet-codex');
  assert.equal(row.metadata.lease, undefined, 'a review row carries no claim lease');
  assert.equal(row.metadata.merge_commit, undefined);
  const [payload] = proofPayloads(db, id);
  assert.deepEqual(payload.pull_request, { state: 'open', number: 77, url: PR_URL });
  assert.equal(payload.landing.merge_commit, undefined);
  assert.equal(payload.self_landed, undefined);

  // A pull request with a merge commit is a landing; one without is not, and
  // junk in the link fields is dropped rather than saved.
  const odd = tasks.addTask(db, { title: 'odd link', workspaceRoot: dir }).id;
  tasks.claimTask(db, { id: odd, claimedBy: 'fleet-codex' });
  tasks.readyTask(db, { id: odd, actor: 'fleet-codex', proof: 'ready', merge: { number: 'x', url: 'javascript:alert(1)' } });
  assert.equal(proofPayloads(db, odd)[0].pull_request, undefined);
});

test('a job waiting on its pull request is not an outcome yet: no landing, no drop, and the claim stays open', (t) => {
  const { dir, dbPath, db } = sandboxDb(t);
  const id = heldJob(db, dir);
  const season = seasonOf(dir, dbPath);
  assert.deepEqual(playsOf(season, id).map((o) => o.kind), ['took']);
  const row = memberRow(season, 'fleet-codex');
  assert.deepEqual([row.took, row.landed, row.dropped, row.sent_back, row.abandoned, row.finished], [1, 0, 0, 0, 0, 0]);
});

test('when a person lands the pull request later, the builder is credited as landed by you', (t) => {
  const { dir, dbPath, db } = sandboxDb(t);
  const byMerge = heldJob(db, dir, { title: 'landed by a merge proof' });
  const byAccept = heldJob(db, dir, { title: 'landed by an accept' });
  const stillWaiting = heldJob(db, dir, { title: 'still waiting' });

  // A different actor records the merge: the same command the brief names.
  const landing = tasks.readyTask(db, {
    id: byMerge,
    actor: 'claude',
    proof: 'Merged the pull request by hand after reading it.',
    merge: { merge_commit: COMMIT, number: '77', url: PR_URL, merged_at: '2026-10-31T02:10:45Z' },
  });
  assert.equal(landing.ready, true);
  // Or a person accepts the job in Review.
  assert.equal(tasks.doneTask(db, { id: byAccept, status: 'done', actor: 'keshav', allowReview: true, action: 'accepted' }).updated, true);

  const season = seasonOf(dir, dbPath);
  for (const id of [byMerge, byAccept]) {
    const plays = playsOf(season, id);
    assert.deepEqual(plays.map((o) => o.kind), ['took', 'landed']);
    const landed = plays.find((o) => o.kind === 'landed');
    assert.equal(landed.member, 'fleet-codex', 'the credit goes to the original claimant');
    assert.equal(landed.landed_by, 'you');
  }
  assert.deepEqual(playsOf(season, stillWaiting).map((o) => o.kind), ['took']);
  assert.equal(season.outcomes.some((o) => o.member === 'claude' || o.member === 'keshav'), false, 'the person who landed it takes no credit');
  const row = memberRow(season, 'fleet-codex');
  assert.deepEqual([row.took, row.landed, row.dropped, row.finished], [3, 2, 0, 2]);
});

test('the claim sweep never expires a job waiting in Review, however old', (t) => {
  const { dir, db } = sandboxDb(t);
  const held = heldJob(db, dir);
  // A control the sweep is allowed to take: still claimed, lease long gone.
  const stranded = tasks.addTask(db, { title: 'stranded worker', workspaceRoot: dir }).id;
  assert.equal(tasks.claimTask(db, { id: stranded, claimedBy: 'fleet-codex', leaseMinutes: 60, leasePid: 999999 }).claimed, true);

  const later = Date.now() + 365 * DAY;
  const byLease = tasks.expireLeases(db, { now: later, isAlive: () => false, dryRun: true });
  assert.deepEqual(byLease.map((x) => x.id), [stranded]);
  const byAge = tasks.expireLeases(db, { now: later, staleDays: 1, claimer: 'fleet-codex', dryRun: true, isAlive: () => false });
  assert.deepEqual(byAge.map((x) => x.id), [stranded]);

  const swept = tasks.expireLeases(db, { now: later, staleDays: 1, isAlive: () => false });
  assert.deepEqual(swept.map((x) => x.id), [stranded]);
  assert.equal(tasks.getTask(db, stranded).status, 'open');
  const row = tasks.getTask(db, held);
  assert.equal(row.status, 'review');
  assert.equal(row.claimed_by, 'fleet-codex');
  assert.equal(db.prepare("SELECT count(*) AS n FROM task_events WHERE task_id = ? AND event_type = 'claim_expired'").get(held).n, 0);
});

test('the row keeps the open pull request until a merge is recorded; a later review pass leaves it alone', (t) => {
  const { dir, db } = sandboxDb(t);
  const id = heldJob(db, dir);
  const open = { state: 'open', number: 77, url: PR_URL };
  assert.deepEqual(tasks.getTask(db, id).metadata.pull_request, open);

  // An independent review names no pull request; the one on file stays open.
  assert.equal(tasks.readyTask(db, { id, actor: 'claude', proof: 'Read the diff and reran the check; both are fine.' }).ready, true);
  assert.deepEqual(tasks.getTask(db, id).metadata.pull_request, open);

  // Only a recorded merge changes it.
  const merge = { merge_commit: COMMIT, number: '77', url: PR_URL, merged_at: '2026-10-31T02:10:45Z' };
  assert.equal(tasks.readyTask(db, { id, actor: 'claude', proof: 'Merged the pull request by hand after reading it.', merge }).ready, true);
  assert.deepEqual(tasks.getTask(db, id).metadata.pull_request, { state: 'merged', merge_commit: COMMIT, number: 77, url: PR_URL, merged_at: '2026-10-31T02:10:45Z' });

  // A job that never had a pull request carries no such field.
  const plain = tasks.addTask(db, { title: 'plain job', workspaceRoot: dir }).id;
  tasks.claimTask(db, { id: plain, claimedBy: 'fleet-codex' });
  tasks.readyTask(db, { id: plain, actor: 'fleet-codex', proof: 'ready' });
  assert.equal(tasks.getTask(db, plain).metadata.pull_request, undefined);
});

test('sending a held job back to open drops the pull request on its row, so the next attempt starts clean', (t) => {
  const { dir, db } = sandboxDb(t);
  const id = heldJob(db, dir);
  assert.deepEqual(tasks.getTask(db, id).metadata.pull_request, { state: 'open', number: 77, url: PR_URL });
  const reopened = tasks.reopenTask(db, { id, actor: 'keshav', reason: 'the pull request was closed unmerged', fromReview: true });
  assert.equal(reopened.reopened, true, JSON.stringify(reopened));
  const row = tasks.getTask(db, id);
  assert.equal(row.status, 'open');
  assert.equal(row.metadata.pull_request, undefined, 'a stale open pull request would keep auto-accept away from the next attempt');
});

// ---------------------------------------------------------------------------
// A claim let go because saving the proof failed. The builder did the work and a
// pull request is open for a person; only the record failed. That is neither a
// landing nor a miss, and the rating has to know it from a field, not from the words.

const landedJob = (db, dir, n, builder = 'fleet-codex') => {
  const { id } = tasks.addTask(db, { title: `Landed job ${n}`, workspaceRoot: dir });
  assert.equal(tasks.claimTask(db, { id, claimedBy: builder }).claimed, true);
  assert.equal(tasks.readyTask(db, { id, actor: builder, proof: 'Merged.', merge: { merge_commit: `${n}`.repeat(40).slice(0, 40), number: String(100 + n), url: `https://github.example/repo/pull/${100 + n}`, merged_at: '2026-10-31T02:10:45Z' } }).ready, true);
  return id;
};
const unsavedJob = (db, dir, { title = 'Fix the feedback form', builder = 'fleet-codex', release = {} } = {}) => {
  const { id } = tasks.addTask(db, { title, tag: 'feedback', workspaceRoot: dir });
  assert.equal(tasks.claimTask(db, { id, claimedBy: builder }).claimed, true);
  const released = tasks.releaseTask(db, {
    id,
    actor: builder,
    reason: `PR ${PR_URL} is open but its proof could not be saved: database is locked`,
    kind: 'proof_not_saved',
    pullRequest: { number: 77, url: PR_URL },
    ...release,
  });
  assert.equal(released.released, true, JSON.stringify(released));
  return id;
};
const releaseEvents = (db, id) => db.prepare("SELECT payload FROM task_events WHERE task_id = ? AND event_type = 'claim_released' ORDER BY version").all(id).map((row) => JSON.parse(row.payload));

test('a release can say its proof was not saved, with the pull request, as fields on the event; a plain release says nothing of the kind', (t) => {
  const { dir, db } = sandboxDb(t);
  const id = unsavedJob(db, dir);
  assert.deepEqual(releaseEvents(db, id), [{
    released_by: 'fleet-codex',
    previous_claimed_by: 'fleet-codex',
    reason: `PR ${PR_URL} is open but its proof could not be saved: database is locked`,
    kind: 'proof_not_saved',
    pull_request: { state: 'open', number: 77, url: PR_URL },
  }]);
  assert.equal(tasks.getTask(db, id).status, 'open', 'the claim is let go all the same');

  const plain = tasks.addTask(db, { title: 'plain', workspaceRoot: dir }).id;
  tasks.claimTask(db, { id: plain, claimedBy: 'fleet-codex' });
  tasks.releaseTask(db, { id: plain, actor: 'fleet-codex', reason: 'paused at ship: blocked' });
  assert.deepEqual(releaseEvents(db, plain), [{ released_by: 'fleet-codex', previous_claimed_by: 'fleet-codex', reason: 'paused at ship: blocked' }]);

  // Only one kind exists, and it needs a real link: anything else leaves the claim held.
  for (const [label, extra] of [
    ['an unknown kind', { kind: 'looks_fine' }],
    ['no pull request', { pullRequest: undefined }],
    ['a link that is not a link', { pullRequest: { url: 'javascript:alert(1)' } }],
    ['a pull request with no kind', { kind: undefined }],
  ]) {
    const odd = tasks.addTask(db, { title: label, workspaceRoot: dir }).id;
    tasks.claimTask(db, { id: odd, claimedBy: 'fleet-codex' });
    const refused = tasks.releaseTask(db, { id: odd, actor: 'fleet-codex', kind: 'proof_not_saved', pullRequest: { url: PR_URL }, ...extra });
    assert.equal(refused.released, false, label);
    assert.equal(refused.reason, 'invalid_release_marker', label);
    assert.equal(tasks.getTask(db, odd).status, 'claimed', label);
    assert.deepEqual(releaseEvents(db, odd), [], label);
  }
});

test('the rating reads a release as waiting on a person only from the fields, and only when they are whole', () => {
  const { isProofNotSaved } = require('../lib/release-kind');
  const open = { state: 'open', number: 77, url: PR_URL };
  const whole = { released_by: 'fleet-codex', reason: 'anything at all', kind: 'proof_not_saved', pull_request: open };
  assert.equal(isProofNotSaved(whole), true);
  assert.equal(isProofNotSaved({ ...whole, pull_request: { state: 'open', number: 77 } }), true, 'a number is enough');
  assert.equal(isProofNotSaved({ ...whole, pull_request: { state: 'OPEN', url: PR_URL } }), true, 'a link is enough, in any case');
  for (const [label, payload] of [
    ['nothing', null],
    ['a list', [whole]],
    ['the same words and no fields', { released_by: 'fleet-codex', reason: `PR ${PR_URL} is open but its proof could not be saved: nope` }],
    ['another kind', { ...whole, kind: 'looks_fine' }],
    ['no kind', { reason: 'x', pull_request: open }],
    ['no pull request', { kind: 'proof_not_saved' }],
    ['a pull request that is only a link in a string', { kind: 'proof_not_saved', pull_request: PR_URL }],
    ['a merged pull request', { ...whole, pull_request: { ...open, state: 'merged' } }],
    ['no link and no number', { ...whole, pull_request: { state: 'open' } }],
    ['a link that is not a link', { ...whole, pull_request: { state: 'open', url: 'javascript:alert(1)' } }],
  ]) assert.equal(isProofNotSaved(payload), false, label);
});

test('a claim let go because its proof was not saved is neither a landing nor a miss on the rating, and it is the field that says so, not the words', (t) => {
  const { dir, dbPath, db } = sandboxDb(t);
  for (const n of [1, 2, 3]) landedJob(db, dir, n);
  const before = memberRow(seasonOf(dir, dbPath), 'fleet-codex');
  assert.deepEqual([before.landed, before.dropped, before.finished], [3, 0, 3]);

  const unsaved = unsavedJob(db, dir);
  // The same words in the reason with no field: that is a plain drop.
  const wordsOnly = unsavedJob(db, dir, { title: 'Same words, no field', release: { kind: undefined, pullRequest: undefined } });
  const season = seasonOf(dir, dbPath);
  assert.deepEqual(playsOf(season, unsaved).map((o) => o.kind), ['took', 'held']);
  assert.deepEqual(playsOf(season, wordsOnly).map((o) => o.kind), ['took', 'dropped']);

  const row = memberRow(season, 'fleet-codex');
  assert.deepEqual([row.took, row.landed, row.dropped, row.sent_back, row.abandoned], [5, 3, 1, 0, 0]);
  assert.equal(row.held, 1);
  assert.equal(row.finished, 4, 'only the plain drop is a finished job beside the three landings');
  // Take the plain drop away and the rating is exactly what it was before the held one.
  const withoutWords = season.outcomes.filter((o) => o.task_id !== wordsOnly);
  const clean = rosterRows({ outcomes: withoutWords, limit: 99 }).find((r) => r.name === 'fleet-codex');
  assert.equal(clean.ovr, before.ovr, 'a held job moves the rating by nothing');
  assert.equal(clean.finished, 3);
  assert.equal(clean.held, 1);
  assert.ok(row.ovr < clean.ovr, 'the plain drop still costs');
});

test('a held play shows on the board by its own word and takes no place in a member\'s form, hours, or rating', () => {
  const { form, lastPlays, memberRatings } = require('../lib/gm-season');
  const HOUR = 3600000;
  const play = (kind, n) => ({ event_id: `e${n}`, task_id: `t${n}`, member: 'delta', title: `Job ${n}`, kind, at: n * HOUR, claimed_at: (n - 1) * HOUR });
  const plays = [1, 2, 3, 4, 5].map((n) => play('landed', n)).concat([play('held', 6)]);
  // Five landings and then a held job: the form is still all five landings.
  assert.equal(form(plays), 'kkkkk');
  const [newest, before] = lastPlays(plays, 2);
  assert.equal(newest.kind, 'held');
  assert.equal(newest.play, 'held');
  assert.equal(newest.hours, null, 'a held job did not finish, so it has no hours');
  assert.equal(before.hours, 1, 'a finished job still does');
  assert.deepEqual(memberRatings(plays).get('delta').finished, 5);
});

test('a held release stays held when a person later accepts the job: the claim it closed is not reopened for credit', (t) => {
  const { dir, dbPath, db } = sandboxDb(t);
  const id = unsavedJob(db, dir);
  // A person lands the pull request and closes the job by hand.
  assert.equal(tasks.doneTask(db, { id, status: 'done', actor: 'keshav', allowReview: true, action: 'accepted' }).updated, true);
  const season = seasonOf(dir, dbPath);
  assert.deepEqual(playsOf(season, id).map((o) => o.kind), ['took', 'held']);
  assert.equal(season.outcomes.some((o) => o.kind === 'landed' || o.kind === 'dropped'), false);
});

test('atris rating shows jobs waiting on a pull request on their own line, outside the finished count and the miss reasons', (t) => {
  const { dir, dbPath, db } = sandboxDb(t);
  for (const n of [1, 2, 3]) landedJob(db, dir, n, 'alpha');
  for (const n of [4, 5, 6]) landedJob(db, dir, n, 'beta');
  unsavedJob(db, dir, { title: 'Held one', builder: 'alpha' });
  unsavedJob(db, dir, { title: 'Held two', builder: 'alpha' });
  unsavedJob(db, dir, { title: 'Only held', builder: 'gamma' });
  const season = seasonOf(dir, dbPath);
  const ask = (...args) => {
    let out = '';
    assert.equal(ratingCommand(args, { root: dir, season, lineup: null, write: (s) => { out += s; } }), 0);
    return out;
  };

  const text = ask('alpha');
  assert.match(text, /landed 3 of 3 finished jobs/);
  assert.match(text, /waiting on a pull request: 2 \(the work is done and a person has to land it, so they do not count either way\)/);
  assert.doesNotMatch(text, /top miss reasons/, 'the held release is not a miss reason');
  assert.doesNotMatch(text, /could not be saved/);
  const member = JSON.parse(ask('alpha', '--json')).member;
  assert.equal(member.held, 2);
  assert.equal(member.finished, 3);
  assert.equal(member.miss_reasons, undefined);

  // A member whose only job is waiting on a pull request still has somewhere to see it.
  const gamma = ask('gamma');
  assert.match(gamma, /landed 0 of 0 finished jobs/);
  assert.match(gamma, /waiting on a pull request: 1 \(the work is done and a person has to land it, so it does not count either way\)/);
  assert.equal(JSON.parse(ask('gamma', '--json')).member.finished, 0);

  // A member with nothing waiting has no such line and no such field.
  assert.doesNotMatch(ask('beta'), /waiting on a pull request/);
  assert.equal('held' in JSON.parse(ask('beta', '--json')).member, false);
});

test('the real task ready takes the flight\'s held proof as written, parks the job in Review, and the sweep leaves it alone', async (t) => {
  // Capture exactly what the flight sends for a held job.
  const plane = planeFor(FEEDBACK_TASK);
  await flyWith(t, plane);
  const sent = callsTo(plane, 'task', 'ready')[0];
  assert.ok(sent, 'the flight sent task ready');

  const { dir, dbPath, run } = cliWorkspace(t);
  const create = (title) => JSON.parse(run(['task', 'new', title, '--tag', 'feedback', '--json']).stdout).task.display_id;
  const held = create('Fix the form so people stop retyping');
  const stranded = create('A worker that walked off');
  run(['task', 'claim', held, '--as', 'fleet-codex']);
  run(['task', 'claim', stranded, '--as', 'fleet-codex']);

  run(['task', 'ready', held, ...sent.slice(3)]);

  const shown = JSON.parse(run(['task', 'show', held, '--json']).stdout);
  assert.equal(shown.status, 'review');
  assert.equal(shown.claimed_by, 'fleet-codex');

  let id;
  const reader = new DatabaseSync(dbPath, { readOnly: true });
  try {
    id = reader.prepare('SELECT id FROM tasks WHERE title = ?').get('Fix the form so people stop retyping').id;
    const payload = JSON.parse(reader.prepare("SELECT payload FROM task_events WHERE task_id = ? AND event_type = 'proof_ready'").get(id).payload);
    assert.deepEqual(payload.pull_request, { state: 'open', number: 77, url: PR_URL });
    assert.equal(payload.landing.merge_commit, undefined);
    assert.equal(payload.self_landed, undefined);
  } finally {
    reader.close();
  }

  // Nothing about the wait reads as a landing or a drop on the rating.
  assert.deepEqual(playsOf(seasonOf(dir, dbPath), id).map((o) => o.kind), ['took']);

  // The real sweep takes the stranded claim and leaves the waiting job.
  const swept = JSON.parse(run(['task', 'sweep', '--stale-days', '0', '--json']).stdout);
  assert.deepEqual(swept.tasks.map((x) => x.title), ['A worker that walked off']);
  assert.equal(JSON.parse(run(['task', 'show', held, '--json']).stdout).status, 'review');
  assert.equal(JSON.parse(run(['task', 'show', stranded, '--json']).stdout).status, 'open');
});

// The release command takes no kind and no pull request link. A worker holding a job it
// failed can still type them, and what it gets is what typing a flag nobody defined
// gets: the claim is let go, plainly, and the rating counts the miss. Only the flight,
// in its own process, can say a proof was not saved.
const MADE_UP_LINK = 'https://made-up.example/pr/123';

for (const [where, env] of [['a plain shell', {}], ['an agent session with a mission driver', AGENT_SESSION]]) {
  test(`a worker cannot excuse its own miss by releasing with a kind and a pull request link (${where}): it is a plain drop on the rating`, (t) => {
    const { dir, dbPath, run } = cliWorkspace(t);
    const inputs = [
      ['the reviewer\'s exact input', ['--kind', 'proof_not_saved', '--pr-url', MADE_UP_LINK]],
      ['a pull request number in place of the link', ['--kind', 'proof_not_saved', '--pr-number', '123']],
      ['both, the way the flight used to send them', ['--kind', 'proof_not_saved', '--pr-url', MADE_UP_LINK, '--pr-number', '123']],
      ['a flag nobody ever defined', ['--bogus', 'yes']],
    ];
    const jobs = inputs.map(([label, extra], n) => {
      const title = `Fix the feedback form ${n}`;
      const ref = JSON.parse(run(['task', 'new', title, '--tag', 'feedback', '--json']).stdout).task.display_id;
      run(['task', 'claim', ref, '--as', 'fleet-codex']);
      const released = JSON.parse(run(['task', 'release', ref, '--as', 'fleet-codex', ...extra, '--json'], { env }).stdout);
      assert.equal(released.ok, true, label);
      assert.equal(released.action, 'released', label);
      assert.equal(released.kind, undefined, label);
      assert.equal(released.pull_request, undefined, label);
      return { label, title };
    });

    const reader = new DatabaseSync(dbPath, { readOnly: true });
    const ids = [];
    try {
      for (const job of jobs) {
        const id = reader.prepare('SELECT id FROM tasks WHERE title = ?').get(job.title).id;
        ids.push(id);
        const payloads = reader.prepare("SELECT payload FROM task_events WHERE task_id = ? AND event_type = 'claim_released'").all(id).map((row) => JSON.parse(row.payload));
        assert.equal(payloads.length, 1, job.label);
        assert.equal(payloads[0].kind, undefined, job.label);
        assert.equal(payloads[0].pull_request, undefined, job.label);
      }
    } finally {
      reader.close();
    }

    // The rating counts every one of them as a miss, and none as waiting.
    const season = seasonOf(dir, dbPath);
    for (const id of ids) assert.deepEqual(playsOf(season, id).map((o) => o.kind), ['took', 'dropped']);
    const member = memberRow(season, 'fleet-codex');
    assert.deepEqual([member.dropped, member.held, member.finished], [jobs.length, 0, jobs.length]);

    // And the task list file shows each of them open again.
    const projection = JSON.parse(fs.readFileSync(path.join(dir, '.atris', 'state', 'tasks.projection.json'), 'utf8'));
    for (const id of ids) assert.equal(projection.tasks.find((task) => task.id === id).status, 'open');
  });
}

test('the release help offers a reason and nothing about a kind or a pull request', (t) => {
  const { run } = cliWorkspace(t);
  const lines = run(['task', 'help']).stdout.split('\n');
  const at = lines.findIndex((line) => /atris task release <id>/.test(line));
  assert.ok(at >= 0, 'the release line is in the help');
  assert.match(lines[at], /--reason/);
  assert.doesNotMatch(lines.slice(at, at + 2).join('\n'), /proof_not_saved|--kind|--pr-url|--pr-number/);
  assert.match(lines[at + 1], /atris task capabilities/, 'the release entry is one line');
});

// The flight claims by the row id the task command showed it. For a job in the same
// workspace the command has to do then what it does for the display id: say the same words
// when it works and refuse for the same reasons when it does not. The one line that differs
// is the hint that repeats whatever was typed.
test('atris task claim by row id does what it does by display id for a job in the same workspace: the same words and the same refusals', (t) => {
  const { run, attempt } = cliWorkspace(t);
  const created = JSON.parse(run(['task', 'new', 'Fix the feedback form', '--tag', 'feedback', '--json']).stdout);
  const ref = created.task.display_id;
  const id = created.task_id;
  assert.notEqual(ref, id, 'a person reads the display id, which is not the row id');
  // The command as the flight sends it.
  const claim = (how, as, ...extra) => ['task', 'claim', how, '--as', as, '--lease-minutes', '60', '--lease-pid', String(process.pid), ...extra];
  const letGo = () => run(['task', 'release', ref, '--as', 'fleet-codex']);

  // When it works: the same words in both modes, whichever way the job is named.
  const claimed = [ref, id].map((how) => {
    const text = run(claim(how, 'fleet-codex'));
    letGo();
    const json = JSON.parse(run(claim(how, 'fleet-codex', '--json')).stdout);
    letGo();
    return {
      stdout: text.stdout,
      stderr: text.stderr,
      json: { ok: json.ok, action: json.action, task_id: json.task_id, owner: json.owner, display_id: json.task.display_id, status: json.task.status },
    };
  });
  assert.deepEqual(claimed[1], claimed[0]);
  assert.match(claimed[0].stdout, new RegExp(`^claimed ${ref} as fleet-codex$`, 'm'), 'it says the display id even when the job was named by its row id');
  assert.equal(claimed[0].json.task_id, id);

  // When it is refused: held by another builder, and a job that does not exist. The reason and
  // the exit code are the same. Only the words that repeat what was typed differ.
  run(claim(ref, 'fleet-codex'));
  const whenTyped = (result, how) => ({ status: result.status, stdout: result.stdout.split(how).join('<typed>'), stderr: result.stderr.split(how).join('<typed>') });
  for (const [label, hows, as] of [
    ['held by another builder', [ref, id], 'fleet-gemini'],
    ['a job that does not exist', ['NOPE-99', '00000000000000000000000000'], 'fleet-codex'],
  ]) {
    for (const extra of [[], ['--json']]) {
      const refused = hows.map((how) => attempt(claim(how, as, ...extra)));
      assert.ok(refused.every((result) => result.status !== 0), `${label}: it is refused both ways`);
      assert.deepEqual(whenTyped(refused[1], hows[1]), whenTyped(refused[0], hows[0]), `${label}${extra.length ? ' (json)' : ''}`);
    }
  }
  const held = [ref, id].map((how) => attempt(claim(how, 'fleet-gemini')));
  for (const [result, how] of [[held[0], ref], [held[1], id]]) {
    assert.match(result.stderr, /^claim failed: already_claimed \(held by fleet-codex\)$/m);
    assert.match(result.stderr, new RegExp(`^Recovery: atris task release ${how} --as fleet-codex$`, 'm'), 'the hint repeats what was typed');
  }
});

// The flight also sends task ready and task release by the row id. For a job in the same
// workspace the commands have to do then what they do for the display id: say the same words
// when they work, save the same thing, and refuse for the same reasons when they do not. The
// only words that differ are the ones that repeat what was typed.
function twoJobsOnTheCommandLine(run, names) {
  return names.map((name) => {
    const made = JSON.parse(run(['task', 'new', `Fix the feedback form (${name})`, '--tag', 'feedback', '--json']).stdout);
    return { ref: made.task.display_id, id: made.task_id };
  });
}
// What a command printed, with the display id of the job it was about written as <job>.
const printed = (result, job) => {
  const clean = (text) => text.split(job.ref).join('<job>').split(job.id).join('<id>');
  return { status: result.status, stdout: clean(result.stdout), stderr: clean(result.stderr) };
};

test('atris task ready by row id does what it does by display id for a job in the same workspace: the same words, the same saved proof, the same refusals', async (t) => {
  // The words the flight really sends for a job waiting on a pull request.
  const flown = planeFor(FEEDBACK_TASK);
  await flyWith(t, flown);
  const sent = callsTo(flown, 'task', 'ready')[0].slice(3);
  assert.ok(sent.length > 0, 'the flight sent task ready');

  const { run, attempt, dbPath } = cliWorkspace(t);
  const jobs = twoJobsOnTheCommandLine(run, ['first', 'second']);
  for (const job of jobs) run(['task', 'claim', job.ref, '--as', 'fleet-codex']);
  const ready = (how, ...extra) => ['task', 'ready', how, ...sent, ...extra];

  // When it works: the same words whichever way the job is named, and the same proof saved.
  const worded = jobs.map((job, n) => printed(run(ready(n === 0 ? job.ref : job.id)), job));
  assert.deepEqual(worded[1], worded[0]);
  assert.match(worded[0].stdout, /^ready for approval <job> v\d+$/m, 'it says the display id even when the job was named by its row id');
  const reader = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const saved = jobs.map((job) => {
      const row = reader.prepare('SELECT status, claimed_by FROM tasks WHERE id = ?').get(job.id);
      const { result_trace: trace, result_packet: packet, ...proof } = JSON.parse(reader.prepare("SELECT payload FROM task_events WHERE task_id = ? AND event_type = 'proof_ready'").get(job.id).payload);
      assert.ok(packet);
      return { status: row.status, claimed_by: row.claimed_by, proof, trace: { ...trace, purpose: '<title>', recorded_at: '<at>' } };
    });
    assert.deepEqual(saved[1], saved[0]);
    assert.equal(saved[0].status, 'review');
    assert.deepEqual(saved[0].proof.pull_request, { state: 'open', number: 77, url: PR_URL });
  } finally {
    reader.close();
  }
  const json = jobs.map((job, n) => printed(run(ready(n === 0 ? job.ref : job.id, '--json')), job));
  assert.deepEqual(json[1], json[0]);
  assert.equal(JSON.parse(json[0].stdout).ok, true);

  // When it is refused: a job that does not exist, and a job that is no longer open. The reason
  // and the exit code are the same.
  const refused = [
    ['a job that does not exist', [{ ref: 'NOPE-99', id: 'NOPE-99' }, { ref: '00000000000000000000000000', id: '00000000000000000000000000' }]],
    ['a job that was archived', (() => {
      const gone = twoJobsOnTheCommandLine(run, ['third', 'fourth']);
      for (const job of gone) run(['task', 'archive', job.ref, '--reason', 'swept in a test']);
      return gone;
    })()],
  ];
  for (const [label, pair] of refused) {
    const results = pair.map((job, n) => printed(attempt(ready(n === 0 ? job.ref : job.id)), job));
    assert.notEqual(results[0].status, 0, `${label}: it is refused`);
    assert.deepEqual(results[1], results[0], label);
  }
});

test('atris task release by row id does what it does by display id for a job in the same workspace: the same words, the same saved release, the same refusals', (t) => {
  const { run, attempt, dbPath } = cliWorkspace(t);
  const jobs = twoJobsOnTheCommandLine(run, ['first', 'second']);
  const claim = (as = 'fleet-codex') => { for (const job of jobs) run(['task', 'claim', job.ref, '--as', as]); };
  // The command as the flight sends it.
  const release = (how, as, ...extra) => ['task', 'release', how, '--as', as, '--reason', 'paused at ship: no pull request link came back', ...extra];
  const named = (n, job) => (n === 0 ? job.ref : job.id);

  // When it works, in both modes: the same words, and the same release saved.
  claim();
  const worded = jobs.map((job, n) => printed(run(release(named(n, job), 'fleet-codex')), job));
  assert.deepEqual(worded[1], worded[0]);
  assert.match(worded[0].stdout, /^released <job> from fleet-codex \(paused at ship: no pull request link came back\)$/m);
  claim();
  const json = jobs.map((job, n) => {
    const result = run(release(named(n, job), 'fleet-codex', '--json'));
    const body = JSON.parse(printed(result, job).stdout);
    return { status: result.status, ok: body.ok, action: body.action, task_id: body.task_id, owner: body.owner, reason: body.reason, display_id: body.task.display_id, job_status: body.task.status };
  });
  assert.deepEqual(json[1], json[0]);
  assert.equal(json[0].action, 'released');
  const reader = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const saved = jobs.map((job) => ({
      row: { ...reader.prepare('SELECT status, claimed_by FROM tasks WHERE id = ?').get(job.id) },
      released: reader.prepare("SELECT payload FROM task_events WHERE task_id = ? AND event_type = 'claim_released' ORDER BY version").all(job.id).map((event) => JSON.parse(event.payload)),
    }));
    assert.deepEqual(saved[1], saved[0]);
    assert.deepEqual(saved[0].row, { status: 'open', claimed_by: null });
    assert.equal(saved[0].released.length, 2);
    assert.equal(saved[0].released[0].kind, undefined, 'a plain release');
  } finally {
    reader.close();
  }

  // When it is refused: not held by that name, not held at all, and a job that does not exist.
  claim();
  const refused = [
    ['held by another builder', jobs, 'fleet-gemini', /release failed: held_by_other \(held by fleet-codex\)/],
    ['a job that does not exist', [{ ref: 'NOPE-99', id: 'NOPE-99' }, { ref: '00000000000000000000000000', id: '00000000000000000000000000' }], 'fleet-codex', /task not found/],
  ];
  for (const [label, pair, as, wanted] of refused) {
    const results = pair.map((job, n) => printed(attempt(release(named(n, job), as)), job));
    assert.notEqual(results[0].status, 0, `${label}: it is refused`);
    assert.deepEqual(results[1], results[0], label);
    assert.match(results[0].stderr, wanted, label);
  }
  for (const job of jobs) run(release(job.id, 'fleet-codex'));
  const open = jobs.map((job, n) => printed(attempt(release(named(n, job), 'fleet-codex')), job));
  assert.notEqual(open[0].status, 0, 'a job nobody holds is refused');
  assert.deepEqual(open[1], open[0]);
  assert.match(open[0].stderr, /release failed: already_open/);
});

// ---------------------------------------------------------------------------
// The engine's run history. It counts landed runs and a landed run renews the
// worker's verified date, so a held build, which only waits for a person, must
// not be written down as landed.

const heldRuns = (root) => readRosterRuns(root).filter((run) => run.task === 'BCK-1934');
const PIN_VERIFIED = '2000-01-01';
const pinReport = () => ({
  jobs: [{
    job: 'build',
    from: 'all projects',
    file: '~/.atris/ROSTER.md',
    workers: [{
      engine: 'codex', model: 'gpt-6.1-sol', status: 'leads', why: '', line: 7, verified: PIN_VERIFIED,
      runs: { engine: 'codex', model: 'gpt-6.1-sol', model_source: 'roster', text: 'codex (gpt-6.1-sol)' },
    }],
  }],
  team: [],
});
// The pin's verified date after these runs, for a worker that runs the pinned model.
const verifiedAfter = (runs, now) => attachStaleModels(pinReport(), {
  catalog: { codex: ['gpt-6.1-sol'] },
  runs: runs.map((run) => ({ ...run, model: 'gpt-6.1-sol' })),
  now,
}).jobs[0].workers[0].pin_verified_at;

test('a held attempt is written to the run history as held, not landed, and verifies nothing until a person lands it', async (t) => {
  const { flight, root } = await flyWith(t, planeFor(FEEDBACK_TASK));
  assert.equal(flight.held_for_review.length, 1);

  const runs = heldRuns(root);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].outcome, 'held');
  assert.equal(runs[0].engine, 'codex');
  assert.equal(runs[0].detail, `waiting for a person to land ${PR_URL}`);
  assert.ok(OUTCOMES.includes('held'), 'held is a recorded outcome, not coerced into a failure');

  const summary = summarizeRuns(runs);
  assert.equal(summary.landed, 0);
  assert.equal(summary.held, 1);

  // The verified date of a pinned worker moves only on a landed run.
  const now = new Date(Date.parse(runs[0].at) + 3600000);
  assert.equal(verifiedAfter(runs, now), PIN_VERIFIED);
  assert.notEqual(verifiedAfter([{ ...runs[0], outcome: 'landed' }], now), PIN_VERIFIED, 'a landed run would have renewed it');
});

test('saving the proof failing does not turn a held attempt into a landing or a failure in the run history', async (t) => {
  const { root } = await flyWith(t, planeFor(FEEDBACK_TASK, { readyStatus: 1 }));
  const runs = heldRuns(root);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].outcome, 'held');
  assert.equal(runs[0].detail, `pull request ${PR_URL} is open but its proof could not be saved`);
});

test('a fix that really landed is still written down as landed, and a paused one as failed', async (t) => {
  const record = JSON.stringify({ merge_commit: COMMIT, number: 4676, url: 'https://github.example/repo/pull/4676', merged_at: '2026-10-31T02:10:45Z' });
  const landed = await flyWith(t, planeFor({ ...FEEDBACK_TASK, tag: 'code' }, { shipOutput: `merge: merged\nmerge: record ${record}\ndone: worktree shipped\n` }));
  assert.deepEqual(heldRuns(landed.root).map((run) => run.outcome), ['landed']);

  const paused = await flyWith(t, planeFor(FEEDBACK_TASK, { shipOutput: 'push: origin codex/dispatch\ndone: worktree shipped\n' }));
  assert.deepEqual(heldRuns(paused.root).map((run) => run.outcome), ['failed']);
});

// ---------------------------------------------------------------------------
// A flight that runs for a member claims the job and hands it in under the member's name, so the
// engines that did the building never reached the job's history, and either one could later review
// the work as an independent check. The hand-in names them too, each by the name it has on a flight
// with no member (fleet-<engine>).

const OUT_OF_CREDIT = { exitCode: 1, stderr: 'Usage limit reached. Purchase more credits.', report: '' };
// codex runs out of credit and cursor builds the same prompt. `ran` collects the engines that ran.
const codexRunsOut = (ran = []) => (entry) => {
  ran.push(entry.engine);
  return Promise.resolve(entry.engine === 'codex' ? OUT_OF_CREDIT : { exitCode: 0, report: 'cursor finished the same prompt' });
};
// A flight on the real task commands: the pull request waits for a person, and the job waits in Review.
async function switchedEngines(t, options = {}) {
  const local = openForFlight(t);
  const run = realCommand(local.root);
  const plane = planeFor(local.task, { show: run, claim: run, ready: run, release: run });
  const ran = [];
  const { flight } = await flyWith(t, plane, {
    root: local.root,
    options: { installedEngines: ['codex', 'cursor'], dispatcher: codexRunsOut(ran), ...options },
  });
  assert.deepEqual(ran, ['codex', 'cursor']);
  assert.equal(flight.held_for_review.length, 1, JSON.stringify(flight.paused));
  return { local, plane };
}
const authorsNow = (local) => [...tasks.authorsOfTask(local.db, tasks.getTask(local.db, local.id))].sort();
const passFrom = (local, actor) => assert.equal(tasks.readyTask(local.db, { id: local.id, actor, proof: `Pass by ${actor}: node --test exited 0.` }).ready, true);

test('a flight that runs for a member puts every engine that built the job on its record, so neither can review it as independent, and a third name still can', async (t) => {
  const { local, plane } = await switchedEngines(t, { actor: 'maya' });

  assert.deepEqual(jobNow(local.db, local.id), { status: 'review', claimed_by: 'maya', released: 0 });
  const [ready] = callsTo(plane, 'task', 'ready');
  assert.equal(flagValue(ready, '--as'), 'maya');
  assert.equal(flagValue(ready, '--built-with'), 'fleet-codex,fleet-cursor');
  const [handIn] = proofPayloads(local.db, local.id);
  assert.equal(handIn.handed_in_by, 'maya');
  assert.deepEqual(handIn.built_with, ['fleet-codex', 'fleet-cursor']);
  assert.deepEqual(authorsNow(local), ['fleet-codex', 'fleet-cursor', 'maya']);

  // A pass by either engine is refused as an independent check: two passes do not certify the job.
  passFrom(local, 'fleet-codex');
  passFrom(local, 'fleet-cursor');
  const afterEngines = tasks.getTask(local.db, local.id).metadata;
  assert.equal(afterEngines.agent_review_pass_count, 3, 'the hand-in and the two passes');
  assert.equal(afterEngines.agent_certified, undefined);
  assert.equal(afterEngines.independent_review_by, undefined);
  // And neither can give it a positive review.
  for (const actor of ['fleet-codex', 'fleet-cursor', 'maya']) {
    const refused = tasks.reviewTask(local.db, { id: local.id, actor, reward: 1, proof: 'Looks good.' });
    assert.deepEqual([refused.reviewed, refused.reason], [false, 'judge_equals_worker'], actor);
  }
  // A third name, which built none of it, still counts.
  passFrom(local, 'fleet-gemini');
  const certified = tasks.getTask(local.db, local.id).metadata;
  assert.equal(certified.agent_certified, true);
  assert.equal(certified.independent_review_by, 'fleet-gemini');
});

test('a flight with no member already records both engines through its own claim and hand-in, and sends nothing extra', async (t) => {
  const { local, plane } = await switchedEngines(t);

  assert.deepEqual(jobNow(local.db, local.id), { status: 'review', claimed_by: 'fleet-codex', released: 0 });
  const [ready] = callsTo(plane, 'task', 'ready');
  assert.equal(flagValue(ready, '--as'), 'fleet-cursor');
  assert.equal(ready.includes('--built-with'), false, 'the claim and the hand-in name the two engines already');
  assert.deepEqual(authorsNow(local), ['fleet-codex', 'fleet-cursor']);
  passFrom(local, 'fleet-codex');
  passFrom(local, 'fleet-cursor');
  assert.equal(tasks.getTask(local.db, local.id).metadata.agent_certified, undefined);
  passFrom(local, 'fleet-gemini');
  assert.equal(tasks.getTask(local.db, local.id).metadata.independent_review_by, 'fleet-gemini');
});

for (const [label, build] of [
  ['a protected-lane fix waiting for a person to land it', (task) => ({ plane: planeFor(task), options: {} })],
  ['a safe-lane fix that landed', (task) => ({ plane: planeFor({ ...task, tag: 'code' }, { shipOutput: `merge: merged\nmerge: record ${MERGE_RECORD}\ndone: worktree shipped\n` }), options: {} })],
  ['a proof for Review that nothing lands', (task) => ({ plane: planeFor(task), options: A_PROOF_ONLY })],
]) {
  test(`whichever way a member's flight hands the job in, it names the engines that built it: ${label}`, async (t) => {
    const { plane, options } = build(FEEDBACK_TASK);
    const ran = [];
    await flyWith(t, plane, { options: { ...options, actor: 'maya', installedEngines: ['codex', 'cursor'], dispatcher: codexRunsOut(ran) } });

    assert.deepEqual(ran, ['codex', 'cursor']);
    const sent = callsTo(plane, 'task', 'ready');
    assert.equal(sent.length, 1);
    assert.equal(flagValue(sent[0], '--as'), 'maya');
    assert.equal(flagValue(sent[0], '--built-with'), 'fleet-codex,fleet-cursor');
    assert.equal(sent[0].filter((arg) => arg === '--built-with').length, 1);
  });
}

test('a member\'s flight that never switched engines names only the one that built the job', async (t) => {
  const plane = planeFor(FEEDBACK_TASK);
  await flyWith(t, plane, { options: { actor: 'maya', installedEngines: ['codex', 'cursor'] } });

  const [ready] = callsTo(plane, 'task', 'ready');
  assert.equal(flagValue(ready, '--as'), 'maya');
  assert.equal(flagValue(ready, '--built-with'), 'fleet-codex');
});

test('builtWithArgs names every engine that ran, by the name it has on a flight with no member, less the names the claim and the hand-in already put on the record', () => {
  const member = { claimedAs: 'maya', handedInAs: 'maya' };
  assert.deepEqual(fleet.builtWithArgs(['codex', 'cursor'], member), ['--built-with', 'fleet-codex,fleet-cursor']);
  // In order, once each, however the engine is written; blanks mean nothing.
  assert.deepEqual(fleet.builtWithArgs(['codex', ' Cursor ', 'codex', '', null, undefined], member), ['--built-with', 'fleet-codex,fleet-cursor']);
  // With no member the first engine claims and the last hands in: both are on the record already.
  assert.deepEqual(fleet.builtWithArgs(['codex', 'cursor'], { claimedAs: 'fleet-codex', handedInAs: 'fleet-cursor' }), []);
  assert.deepEqual(fleet.builtWithArgs(['codex'], { claimedAs: 'fleet-codex', handedInAs: 'fleet-codex' }), []);
  // A chain of three leaves the one in the middle, which neither the claim nor the hand-in names.
  assert.deepEqual(fleet.builtWithArgs(['codex', 'claude', 'cursor'], { claimedAs: 'fleet-codex', handedInAs: 'fleet-cursor' }), ['--built-with', 'fleet-claude']);
  // Nothing ran, nothing to name.
  for (const none of [[], undefined, null, 'codex']) assert.deepEqual(fleet.builtWithArgs(none, member), [], String(none));
  assert.deepEqual(fleet.builtWithArgs(['codex']), ['--built-with', 'fleet-codex']);
});
