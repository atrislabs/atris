'use strict';

const {
  HOUR,
  FIRST,
  withEnv,
  room,
  jobTitle,
  job,
  jobs,
  listJobs,
  codexIsStrong,
  dryFlight,
  liveFlight,
  fakeEngines,
  isolated,
  isolatedHome,
} = require('./helpers/pick-fleet-fixtures');

// The picker inside the flights. The fleet used to deal engines to jobs in turn, whatever
// each engine had actually landed. Now, unless someone turns it off, each job goes to the
// builder its real results favor, the flight prints one plain line saying why, and the
// receipt keeps that line. These tests run the real flights over a scratch task store that
// holds made-up history, and read what the flights dealt, printed and saved:
//
//   - the order and the line, in a dry run and in a live run, and the receipt's copy
//   - nobody has results yet, so jobs go in turn and the flight says so
//   - `--pick turns`, `ATRIS_PICK=turns`: exactly today's dealing, nothing new printed
//   - explicit choices come first, with results or without: `--engine`, a job that names its
//     engine (even one that is resting), a job assigned to a member (that member's own engine);
//     a job whose choice the flight cannot give is left out of the flight with one line
//   - an engine that is cooling, out of credit, or one the Claude spend guard would stop
//     is never picked, and the flight says which and why; the guard is asked about the launch the
//     fleet will really make, in the environment its workers will really run in
//   - an engine list a caller names is never filtered, on the first pick or on a retry
//   - a landing counts only when its commit is on origin's default branch, is no older than its
//     claim, and no other job recorded it first; origin is fetched once before the first pick, by
//     an explicit refspec, and only when an engine's own landing needs it
//   - a landing pays the engine that finished it: a rescued job is claimed for the engine it was
//     dealt to and handed in under the engine that finished it
//   - when no landing can be checked here at all (no git, no origin branch, no default branch
//     set, origin out of reach), jobs are dealt in turn and the flight says why; misses alone
//     steer without a fetch
//   - a play's lane is the lane its job was in at the claim, so retagging a finished job
//     afterwards changes nothing
//   - a retry on another engine takes the next builder in the job's order; a stall handover
//     keeps the roster's own backup order
//   - the command line: the flags reach the flight, and a value nobody knows is refused
//   - atris rating says steering is on and how many jobs it has picked

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const fleet = require('../lib/fleet');
const tasks = require('../lib/task-db');
const registry = require('../lib/engine-registry');
const engineCommand = require('../commands/engine');
const { ratingCommand } = require('../commands/rating');
const { unattendedStop } = require('../lib/claude-spend-guard');
const { historyStore, watchGit } = require('./helpers/pick-history');
const { createScratchCli } = require('./helpers/scratch-cli');

const runCli = createScratchCli(60000);

const MINUTE = 60000;

// Every test here counts from the same day, whatever today is, and starts with the picker on.
process.env.ATRIS_PICK_SINCE = '2026-11-01';
process.env.ATRIS_PICK_SEED_DAY = '2026-11-03';
delete process.env.ATRIS_PICK;

const DEAD = { exitCode: 1, report: '', stderr: 'Usage limit reached. Purchase more credits.' };

// ---------------------------------------------------------------------------
// Three. An engine that is cooling, out of credit, or stopped by the spend guard is never picked.

test('a cooling or credit-out engine is never picked, and turns still deals to it as before', async (t) => {
  const { ws, app, store } = room(t);
  const bin = fakeEngines(ws, ['claude', 'codex', 'cursor-agent']);
  await withEnv(isolated(ws, bin), async () => {
    // The best record belongs to the engine that has run out of credit.
    store.plays(12, { member: 'fleet-claude', outcome: 'landed', at: FIRST });
    store.plays(12, { member: 'fleet-codex', outcome: 'dropped', at: FIRST });
    const rows = jobs(4);

    registry.setEngineHealth('claude', 'credit_out', app);
    const steered = await dryFlight(app, rows, { engines: null });
    assert.ok(!steered.flight.roster.includes('claude'), `credit-out claude is still on the roster: ${steered.flight.roster}`);
    assert.ok(steered.flight.staffed.every((row) => row.engine !== 'claude'), 'no job goes to an engine that is out of credit');
    assert.equal(steered.flight.staffed.length, 4);
    assert.ok(steered.logs.some((line) => /claude \(out of credit\)/.test(line) && /not ready/.test(line)), `the flight says who it left out:\n${steered.logs.join('\n')}`);

    const turns = await dryFlight(app, rows, { engines: null, pick: 'turns' });
    assert.ok(turns.flight.roster.includes('claude'), 'turns is today\'s dealing, health and all');
    assert.ok(turns.flight.staffed.some((row) => row.engine === 'claude'));

    registry.setEngineHealth('claude', 'ready', app);
    registry.setEngineHealth('cursor', 'cooling', app);
    const cooling = await dryFlight(app, rows, { engines: null });
    assert.ok(!cooling.flight.roster.includes('cursor'));
    assert.ok(cooling.flight.staffed.every((row) => row.engine !== 'cursor'), 'no job goes to an engine that is cooling');
    assert.ok(cooling.logs.some((line) => /cursor \(cooling\)/.test(line)));
  });
});

test('when no engine is ready, nothing is dealt and the flight says why', async (t) => {
  const { ws, app } = room(t);
  const bin = fakeEngines(ws, ['claude']);
  await withEnv(isolated(ws, bin), async () => {
    registry.setEngineHealth('claude', 'credit_out', app);
    const { flight, logs } = await dryFlight(app, jobs(2), { engines: null });
    assert.deepEqual(flight.staffed, []);
    assert.deepEqual(flight.roster, []);
    assert.ok(logs.some((line) => /claude \(out of credit\)/.test(line)), logs.join('\n'));
  });
});

test('a job that names an engine that is out of credit still goes there, and the free jobs are picked from the engines that are ready', async (t) => {
  const { ws, app, store } = room(t);
  const bin = fakeEngines(ws, ['claude', 'codex', 'cursor-agent']);
  await withEnv(isolated(ws, bin), async () => {
    for (const member of ['fleet-claude', 'fleet-codex', 'fleet-cursor']) store.plays(12, { member, outcome: 'landed', at: FIRST });
    registry.setEngineHealth('codex', 'credit_out', app);
    const rows = [job(1, { metadata: { executed_by: 'codex' } }), job(2), job(3), job(4)];
    const { flight, logs } = await dryFlight(app, rows, { engines: null });
    assert.equal(flight.staffed[0].engine, 'codex', 'the job names codex, so it goes to codex');
    assert.ok(!('pick' in flight.staffed[0]));
    assert.ok(!flight.roster.includes('codex'), 'codex sits out the picking');
    assert.ok(flight.staffed.slice(1).every((row) => row.engine !== 'codex' && row.pick), 'the other jobs are picked from the engines that are ready');
    assert.ok(logs.some((line) => /codex \(out of credit\)/.test(line) && /not ready/.test(line)), logs.join('\n'));
  });
});

test('the Claude spend guard: an unattended run with no approval never picks a paid Claude model, and one line names the engine and why', async (t) => {
  const { ws, app, store } = room(t);
  const bin = fakeEngines(ws, ['claude', 'codex', 'cursor-agent']);
  // The best record belongs to claude.
  store.plays(12, { member: 'fleet-claude', outcome: 'landed', at: FIRST });
  store.plays(12, { member: 'fleet-codex', outcome: 'dropped', at: FIRST });
  store.plays(12, { member: 'fleet-cursor', outcome: 'dropped', at: FIRST });
  const rows = jobs(4);
  // A model the runner's own cheap-model rule does not catch by name, so claude would really run on it.
  const paid = { ATRIS_RUNNER_MODEL: 'claude-mystery-9' };

  await withEnv({ ...isolatedHome(ws, bin), ...paid }, async () => {
    const stopped = await dryFlight(app, rows, { engines: null });
    assert.ok(!stopped.flight.roster.includes('claude'));
    assert.equal(stopped.flight.staffed.length, 4);
    assert.ok(stopped.flight.staffed.every((row) => row.engine !== 'claude'), 'claude has the best record and still gets nothing');
    assert.deepEqual(stopped.logs.filter((line) => /not ready/.test(line)), ['  left out, not ready: claude (paid model claude-mystery-9, no spend approval)']);

    const turns = await dryFlight(app, rows, { engines: null, pick: 'turns' });
    assert.ok(turns.flight.staffed.some((row) => row.engine === 'claude'), 'turns is today\'s dealing; the guard\'s own hook still stops the run');
    assert.ok(!turns.logs.some((line) => /not ready/.test(line)));
  });

  await withEnv({ ...isolatedHome(ws, bin), ...paid, ATRIS_CLAUDE_SPEND_OK: 'claude-mystery-9' }, async () => {
    const approved = await dryFlight(app, rows, { engines: null });
    assert.ok(approved.flight.roster.includes('claude'));
    assert.ok(approved.flight.staffed.some((row) => row.engine === 'claude'), 'with the owner\'s yes for that model, claude is picked again');
    assert.ok(!approved.logs.some((line) => /not ready/.test(line)));
  });

  await withEnv({ ...isolatedHome(ws, bin), ATRIS_RUNNER_MODEL: 'claude-haiku-5-5' }, async () => {
    const cheap = await dryFlight(app, rows, { engines: null });
    assert.ok(cheap.flight.roster.includes('claude'));
    assert.ok(cheap.flight.staffed.some((row) => row.engine === 'claude'), 'a Haiku engine is picked freely');
    assert.ok(!cheap.logs.some((line) => /not ready/.test(line)));
  });
});

test('the Claude spend guard: a pay-per-use key leaves claude out of the picking, and ATRIS_CLAUDE_KEY_OK brings it back', async (t) => {
  const { ws, app, store } = room(t);
  const bin = fakeEngines(ws, ['claude', 'codex', 'cursor-agent']);
  store.plays(12, { member: 'fleet-claude', outcome: 'landed', at: FIRST });
  store.plays(12, { member: 'fleet-codex', outcome: 'dropped', at: FIRST });
  const keyed = { ...isolatedHome(ws, bin), ATRIS_RUNNER_MODEL: 'claude-haiku-5-5', ANTHROPIC_API_KEY: 'sk-test-not-real' };
  await withEnv(keyed, async () => {
    const { flight, logs } = await dryFlight(app, jobs(4), { engines: null });
    assert.ok(flight.staffed.every((row) => row.engine !== 'claude'));
    assert.deepEqual(logs.filter((line) => /not ready/.test(line)), ['  left out, not ready: claude (a pay-per-use Claude key is set)']);
  });
  await withEnv({ ...keyed, ATRIS_CLAUDE_KEY_OK: '1' }, async () => {
    const { flight } = await dryFlight(app, jobs(4), { engines: null });
    assert.ok(flight.staffed.some((row) => row.engine === 'claude'));
  });
});

test('the Claude spend guard is asked about the launch the fleet will really make: the older ATRIS_CLAUDE_MODEL on its own counts, and a newer variable beats it', async (t) => {
  const { ws, app, store } = room(t);
  const bin = fakeEngines(ws, ['claude', 'codex', 'cursor-agent']);
  store.plays(12, { member: 'fleet-claude', outcome: 'landed', at: FIRST });
  store.plays(12, { member: 'fleet-codex', outcome: 'dropped', at: FIRST });
  store.plays(12, { member: 'fleet-cursor', outcome: 'dropped', at: FIRST });
  const rows = jobs(4);
  const legacy = { ATRIS_CLAUDE_MODEL: 'claude-mystery-9' }; // the only model variable set: the launch carries this model

  await withEnv({ ...isolatedHome(ws, bin), ...legacy }, async () => {
    const stopped = await dryFlight(app, rows, { engines: null });
    assert.ok(stopped.flight.staffed.every((row) => row.engine !== 'claude'), 'the launch would carry a paid model with no approval, and the hook would stop it');
    assert.deepEqual(stopped.logs.filter((line) => /not ready/.test(line)), ['  left out, not ready: claude (paid model claude-mystery-9, no spend approval)']);
  });
  await withEnv({ ...isolatedHome(ws, bin), ...legacy, ATRIS_CLAUDE_SPEND_OK: 'claude-mystery-9' }, async () => {
    const approved = await dryFlight(app, rows, { engines: null });
    assert.ok(approved.flight.staffed.some((row) => row.engine === 'claude'), 'with the owner\'s yes for that model, claude is picked again');
    assert.ok(!approved.logs.some((line) => /not ready/.test(line)));
  });
  await withEnv({ ...isolatedHome(ws, bin), ...legacy, ATRIS_RUNNER_MODEL: 'claude-haiku-5-5' }, async () => {
    const beaten = await dryFlight(app, rows, { engines: null });
    assert.ok(beaten.flight.staffed.some((row) => row.engine === 'claude'), 'the newer variable names a cheap model and the launch uses that one');
    assert.ok(!beaten.logs.some((line) => /not ready/.test(line)));
  });
});

test('a caller that names its engines keeps every one of them in the pool, spend guard or not', async (t) => {
  const { ws, app, store } = room(t);
  const bin = fakeEngines(ws, ['claude', 'codex']);
  store.plays(12, { member: 'fleet-claude', outcome: 'landed', at: FIRST });
  store.plays(12, { member: 'fleet-codex', outcome: 'dropped', at: FIRST });
  await withEnv({ ...isolatedHome(ws, bin), ATRIS_RUNNER_MODEL: 'claude-mystery-9' }, async () => {
    const { flight, logs } = await dryFlight(app, jobs(4), { engines: ['claude', 'codex'] });
    assert.deepEqual(flight.roster, ['claude', 'codex']);
    assert.ok(flight.staffed.some((row) => row.engine === 'claude'));
    assert.ok(!logs.some((line) => /not ready/.test(line)));
  });
});

// ---------------------------------------------------------------------------
// Four. What counts: a landing must be on the default branch, made after its claim, and its job's alone. When no
// landing can be checked here at all, jobs are dealt in turn. A lane is the one at the claim.

const MADE_UP = 'deadbeef'.repeat(5); // forty hex digits that name no commit
const CAN_NOT = (why) => `steering on since Nov 1: dealing in turn: landings cannot be checked here (${why})`;
const FIX = 'git remote set-head origin --auto';
const FETCH_MAIN = 'fetch origin +refs/heads/main:refs/remotes/origin/main';

// A history of nothing but misses: claude missed eight, codex missed two.
function missesOnly(store) {
  store.plays(8, { member: 'fleet-claude', outcome: 'dropped', at: FIRST });
  store.plays(2, { member: 'fleet-codex', outcome: 'sent_back', at: FIRST });
}

test('a landing nobody can vouch for does not count: an engine with only such landings has no results', async (t) => {
  const { app, store } = room(t);
  const side = store.side(FIRST);
  store.plays(3, { member: 'fleet-codex', outcome: 'landed', at: FIRST, commit: MADE_UP });             // a commit that does not exist
  store.plays(3, { member: 'fleet-codex', outcome: 'landed', at: FIRST + HOUR, commit: side });          // a commit on a side branch only
  store.plays(3, { member: 'fleet-codex', outcome: 'landed', at: FIRST + 2 * HOUR, commit: null });     // a landing with no commit
  store.plays(3, { member: 'fleet-codex', outcome: 'landed', at: FIRST + 3 * HOUR, commit: store.main }); // work that was on the branch before the claim
  const { flight, logs } = await dryFlight(app, jobs(4));
  assert.deepEqual(flight.staffed.map((row) => row.engine), ['claude', 'codex', 'claude', 'codex'], 'twelve landings nobody can vouch for steer nothing');
  assert.ok(flight.staffed.every((row) => !('pick' in row)));
  assert.ok(logs.includes('  steering on since Nov 1: no results yet, so jobs are dealt in turn'));
  assert.ok(!logs.some((line) => /cannot be checked/.test(line)), 'the check could run, so there is nothing to say about it');
});

test('a landing on the default branch counts, and a merged pull request counts through its merge commit', async (t) => {
  const { app, store } = room(t);
  store.plays(6, { member: 'fleet-codex', outcome: 'landed', at: FIRST });                              // each lands its own new commit on the default branch
  for (let i = 0; i < 6; i += 1) {                                                                       // each lands its own merged pull request
    const at = FIRST + HOUR + i * MINUTE;
    store.play({ member: 'fleet-codex', outcome: 'landed', at, commit: store.merged(at + 10 * MINUTE).merge, where: 'pull_request' });
  }
  store.plays(12, { member: 'fleet-claude', outcome: 'dropped', at: FIRST });
  const { flight } = await dryFlight(app, jobs(4));
  assert.deepEqual(flight.staffed.map((row) => row.engine), ['codex', 'codex', 'claude', 'claude']);
  assert.match(flight.staffed[0].pick, /^picked fleet-codex for this job: landed 12 of 12 since Nov 1 \(fleet-claude 0 of 12\)$/);
});

test('one commit lands one job: the first job to record it keeps it, and a later job that names it gets no credit', async (t) => {
  const { app, store } = room(t);
  // One commit, made two minutes after the first claim. Every claim below is early enough to have landed it, so the
  // only thing that can keep the later jobs from counting is that another job recorded it first.
  const shared = store.land(FIRST + 2 * MINUTE);
  store.play({ member: 'fleet-claude', outcome: 'landed', at: FIRST, commit: shared });
  store.plays(4, { member: 'fleet-codex', outcome: 'landed', at: FIRST + MINUTE, commit: shared });
  const { flight, logs } = await dryFlight(app, jobs(4));
  const lines = flight.staffed.map((row) => row.pick).join('\n');
  // Claude's one landing is the only one that counts: claude is 1 of 1, and codex has nothing counted.
  assert.ok(flight.staffed.every((row) => row.pick), 'there is a result, so every job is picked');
  assert.ok(flight.staffed.some((row) => /^picked fleet-claude for this job: landed 1 of 1 since Nov 1/.test(row.pick)), lines);
  assert.ok(flight.staffed.every((row) => !/fleet-codex [1-9]\d* of/.test(row.pick) && !/^picked fleet-codex for this job: landed [1-9]/.test(row.pick)), lines);
  assert.ok(!logs.some((line) => /landings cannot be checked|no results yet, so jobs are dealt in turn/.test(line)), 'the results were readable, so nobody is dealt in turn');
});

test('first to record is first by the record, not by the claim', async (t) => {
  const { app, store } = room(t);
  const shared = store.land(FIRST + 2 * MINUTE);
  // Codex claimed first and recorded last; claude claimed second and recorded first. Both claims are early enough
  // to have landed the commit, so the order of the records is the only thing that decides.
  const early = store.play({ member: 'fleet-codex', outcome: 'landed', at: FIRST, commit: shared });
  store.play({ member: 'fleet-claude', outcome: 'landed', at: FIRST + MINUTE, commit: shared });
  store.db.prepare("UPDATE task_events SET created_at = ? WHERE task_id = ? AND event_type = 'proof_ready'").run(FIRST + 3 * HOUR, early);
  const { flight } = await dryFlight(app, jobs(2));
  const lines = flight.staffed.map((row) => row.pick).join('\n');
  assert.ok(flight.staffed.some((row) => /^picked fleet-claude for this job: landed 1 of 1 since Nov 1/.test(row.pick)), lines);
  assert.ok(flight.staffed.every((row) => !/fleet-codex [1-9]\d* of/.test(row.pick) && !/^picked fleet-codex for this job: landed [1-9]/.test(row.pick)), lines);
});

test('misses count whether or not landings can be checked', async (t) => {
  const { app, store } = room(t);
  store.plays(12, { member: 'fleet-claude', outcome: 'dropped', at: FIRST });
  store.plays(12, { member: 'fleet-codex', outcome: 'landed', at: FIRST, commit: MADE_UP });
  const { flight, logs } = await dryFlight(app, jobs(4));
  assert.ok(flight.staffed.every((row) => row.pick), 'there is a result (claude\'s twelve misses), so every job is picked');
  assert.ok(!logs.includes('  steering on since Nov 1: no results yet, so jobs are dealt in turn'));
  assert.ok(flight.staffed.every((row) => !/12 of 12/.test(row.pick)), 'codex\'s twelve unchecked landings are not 12 of 12');
  assert.ok(flight.staffed.some((row) => /fleet-claude 0 of 12|landed 0 of 12/.test(row.pick)), 'claude\'s misses are counted');
});

test('with no origin branch to check against, jobs are dealt in turn even though misses are on record, and the flight says why once', async (t) => {
  const { app, store } = room(t, { origin: false });
  missesOnly(store);
  store.plays(8, { member: 'fleet-codex', outcome: 'landed', at: FIRST + HOUR });
  const { flight, logs } = await dryFlight(app, jobs(4));
  assert.deepEqual(flight.staffed.map((row) => row.engine), ['claude', 'codex', 'claude', 'codex'], 'exactly the turns: the engines that do the most work are not punished');
  assert.ok(flight.staffed.every((row) => !('pick' in row)));
  assert.deepEqual(logs.filter((line) => /cannot be checked/.test(line)), [`  ${CAN_NOT('no origin branch')}`]);
  assert.ok(!logs.some((line) => /no results yet/.test(line)), 'one line, not two');
});

test('the same history in a folder that has an origin still steers, and says nothing about landings', async (t) => {
  const { app, store } = room(t);
  missesOnly(store);
  store.plays(8, { member: 'fleet-codex', outcome: 'landed', at: FIRST + HOUR });
  const { flight, logs } = await dryFlight(app, jobs(4));
  assert.ok(flight.staffed.every((row) => row.pick), 'every job is picked');
  assert.ok(flight.staffed.some((row) => row.engine === 'codex'), 'codex has landed work and two misses; claude has eight misses');
  assert.ok(!logs.some((line) => /dealing in turn|landings cannot be checked|no results yet, so jobs are dealt in turn/.test(line)), logs.join('\n'));
});

test('with only misses and no origin branch the flight still deals in turn, because the folder cannot say what landed', async (t) => {
  const { app, store } = room(t, { origin: false });
  missesOnly(store);
  const { flight, logs } = await dryFlight(app, jobs(4));
  assert.deepEqual(flight.staffed.map((row) => row.engine), ['claude', 'codex', 'claude', 'codex']);
  assert.deepEqual(logs.filter((line) => /cannot be checked/.test(line)), [`  ${CAN_NOT('no origin branch')}`]);
});

test('with no git repository in the folder, jobs are dealt in turn and the flight says why', async (t) => {
  const { app, store } = room(t, { git: false });
  store.plays(8, { member: 'fleet-codex', outcome: 'landed', at: FIRST, commit: MADE_UP });
  store.plays(4, { member: 'fleet-claude', outcome: 'dropped', at: FIRST });
  const { flight, logs } = await dryFlight(app, jobs(4));
  assert.deepEqual(flight.staffed.map((row) => row.engine), ['claude', 'codex', 'claude', 'codex']);
  assert.ok(flight.staffed.every((row) => !('pick' in row)));
  assert.deepEqual(logs.filter((line) => /cannot be checked/.test(line)), [`  ${CAN_NOT('this folder is not a git repository')}`]);
});

test('with origin\'s default branch unset, origin/main is not guessed: jobs are dealt in turn and the line names the fix', async (t) => {
  const { app, store } = room(t);
  store.plays(8, { member: 'fleet-codex', outcome: 'landed', at: FIRST });
  store.plays(4, { member: 'fleet-claude', outcome: 'dropped', at: FIRST });
  store.dropOriginHead();
  const { flight, logs } = await dryFlight(app, jobs(4));
  assert.deepEqual(flight.staffed.map((row) => row.engine), ['claude', 'codex', 'claude', 'codex']);
  const lines = logs.filter((line) => /cannot be checked/.test(line));
  assert.equal(lines.length, 1, logs.join('\n'));
  assert.match(lines[0], /^  steering on since Nov 1: dealing in turn: landings cannot be checked here \(.*default branch.*\)$/);
  assert.ok(lines[0].includes(FIX), lines[0]);
});

test('when origin cannot be fetched, jobs are dealt in turn and the flight says so; once origin is back it steers again', async (t) => {
  const { app, store } = room(t);
  store.plays(12, { member: 'fleet-codex', outcome: 'landed', at: FIRST });
  store.plays(12, { member: 'fleet-claude', outcome: 'dropped', at: FIRST });
  store.breakRemote();
  const down = await dryFlight(app, jobs(4));
  assert.deepEqual(down.flight.staffed.map((row) => row.engine), ['claude', 'codex', 'claude', 'codex']);
  assert.ok(down.flight.staffed.every((row) => !('pick' in row)));
  const lines = down.logs.filter((line) => /cannot be checked/.test(line));
  assert.equal(lines.length, 1, down.logs.join('\n'));
  assert.match(lines[0], /^  steering on since Nov 1: dealing in turn: landings cannot be checked here \(could not fetch origin/);

  store.restoreRemote();
  const up = await dryFlight(app, jobs(4));
  assert.deepEqual(up.flight.staffed.map((row) => row.engine), ['codex', 'codex', 'claude', 'claude']);
  assert.ok(!up.logs.some((line) => /cannot be checked/.test(line)));
});

test('origin\'s default branch is fetched once, with an explicit refspec, before the first pick, and a merge from a minute ago counts; a retry does not fetch again', async (t) => {
  const { app, store } = room(t);
  store.plays(12, { member: 'fleet-codex', outcome: 'landed', at: FIRST });   // twelve new commits that exist on origin and nowhere else yet
  store.plays(12, { member: 'fleet-claude', outcome: 'dropped', at: FIRST });
  const watch = watchGit(t);
  watch.clear();
  const picked = await dryFlight(app, jobs(4));
  assert.deepEqual(picked.flight.staffed.map((row) => row.engine), ['codex', 'codex', 'claude', 'claude'], 'what the fetch found is counted');
  assert.deepEqual(watch.startingWith('fetch'), [FETCH_MAIN], `one fetch, for the default branch only:\n${watch.calls().join('\n')}`);
  assert.equal(watch.startingWith('rev-list').length, 2, `one call for the commits asked about and one listing the branch:\n${watch.calls().join('\n')}`);
  assert.deepEqual(watch.startingWith('merge-base'), [], 'no process is started for any one landing');

  // A live flight whose first engine dies and is retried: still one fetch for the whole flight.
  watch.clear();
  let dead = null;   // whichever engine the draw sends first dies, so a job is retried on any day
  const answer = (entry) => {
    dead = dead || entry.engine;
    return entry.engine === dead ? DEAD : { exitCode: 0, report: 'built it' };
  };
  const live = await liveFlight(app, jobs(4), { answer, flight: { engines: ['claude', 'codex', 'cursor'] } });
  assert.ok(live.flight.results.some((row) => row.restaffed), 'a job was retried');
  assert.deepEqual(watch.startingWith('fetch'), [FETCH_MAIN], watch.calls().join('\n'));
});

test('nothing is fetched when nothing needs it: --pick turns, one ready engine, or a flight of named jobs', async (t) => {
  const { app, store } = room(t);
  store.plays(12, { member: 'fleet-codex', outcome: 'landed', at: FIRST });
  const watch = watchGit(t);
  watch.clear();
  await dryFlight(app, jobs(4), { pick: 'turns' });
  await dryFlight(app, jobs(4), { engines: ['claude'] });
  await dryFlight(app, [job(1, { metadata: { executed_by: 'codex' } }), job(2, { metadata: { executed_by: 'claude' } })]);
  assert.deepEqual(watch.startingWith('fetch'), [], watch.calls().join('\n'));
});

test('nothing is fetched when only misses are on record: a miss needs no commit', async (t) => {
  const { app, store } = room(t);
  store.plays(6, { member: 'fleet-claude', outcome: 'dropped', at: FIRST });
  const watch = watchGit(t);
  watch.clear();
  const { flight } = await dryFlight(app, jobs(4));
  assert.ok(flight.staffed.every((row) => row.pick), 'the misses are results, so the jobs are picked');
  assert.deepEqual(watch.startingWith('fetch'), [], watch.calls().join('\n'));
});
test('misses alone steer without a fetch, even when origin is out of reach: a newcomer is tried and the engine that missed gets fewer jobs', async (t) => {
  // The draw is seeded by the UTC day; pin the day so the deal is the same on every run.
  t.mock.timers.enable({ apis: ['Date'], now: FIRST + 3 * HOUR });
  const { app, store } = room(t);
  store.plays(14, { member: 'fleet-claude', outcome: 'dropped', at: FIRST });
  store.breakRemote();
  const watch = watchGit(t);
  watch.clear();
  const { flight, logs } = await dryFlight(app, jobs(4), { engines: ['claude', 'codex', 'cursor'] });
  assert.ok(flight.staffed.every((row) => row.pick), 'the misses are results, so every job is picked');
  assert.deepEqual(watch.startingWith('fetch'), [], watch.calls().join('\n'));
  assert.ok(!logs.some((line) => /cannot be checked|dealing in turn/.test(line)), logs.join('\n'));
  const load = (name) => flight.staffed.filter((row) => row.engine === name).length;
  assert.ok(load('codex') >= 1 && load('cursor') >= 1, `the newcomers are tried: ${flight.staffed.map((row) => row.engine)}`);
  assert.ok(load('claude') < load('codex') && load('claude') < load('cursor'), `the engine that missed gets fewer jobs: ${flight.staffed.map((row) => row.engine)}`);
});

test('a folder that cannot be checked deals in turn with one line even when only misses are on record, and with landings on record too', async (t) => {
  for (const withLandings of [false, true]) {
    const { app, store } = room(t, { origin: false });
    missesOnly(store);
    if (withLandings) store.plays(4, { member: 'fleet-codex', outcome: 'landed', at: FIRST + HOUR, commit: MADE_UP });
    const { flight, logs } = await dryFlight(app, jobs(4));
    assert.deepEqual(flight.staffed.map((row) => row.engine), ['claude', 'codex', 'claude', 'codex'], `withLandings ${withLandings}`);
    assert.deepEqual(logs.filter((line) => /cannot be checked/.test(line)), [`  ${CAN_NOT('no origin branch')}`]);
  }
});

test('the dealing-in-turn line is said once even when a retry is the first to read the results', async (t) => {
  const { app, store } = room(t, { origin: false });
  store.plays(8, { member: 'fleet-codex', outcome: 'landed', at: FIRST });
  const engines = ['claude', 'codex', 'cursor'];
  const answer = (entry) => (entry.engine === 'claude' ? DEAD : { exitCode: 0, report: 'built it' });
  // The only job names its engine, so the deal reads no results; the dead engine's retry does.
  const { flight, logs } = await liveFlight(app, [job(1, { metadata: { executed_by: 'claude' } })], { answer, flight: { engines } });
  const note = CAN_NOT('no origin branch');
  assert.deepEqual(logs.filter((line) => line.includes(note)), [`      ${note}`], 'once, under the line that says the job was restaffed');
  const at = logs.findIndex((line) => /restaffed F-1: claude -> /.test(line));
  assert.ok(at >= 0 && logs[at + 1] === `      ${note}`, logs.join('\n'));
  assert.deepEqual(flight.results[0].restaffed.notes, [note]);
  assert.ok(!('pick' in flight.results[0].restaffed), 'the retry takes the roster\'s own next engine');
  const receipt = JSON.parse(fs.readFileSync(flight.receipt, 'utf8'));
  assert.deepEqual(receipt.results[0].restaffed.notes, [note]);
});

test('retagging finished jobs afterwards changes nothing the flight picks or says', async (t) => {
  const { app, store } = room(t);
  // codex landed 8 jobs that were docs jobs when it took them, and missed 4 cli jobs; claude landed 12 cli jobs.
  const docs = store.plays(8, { member: 'fleet-codex', outcome: 'landed', at: FIRST, tag: 'docs' });
  store.plays(4, { member: 'fleet-codex', outcome: 'dropped', at: FIRST + HOUR, tag: 'cli' });
  store.plays(12, { member: 'fleet-claude', outcome: 'landed', at: FIRST, tag: 'cli' });
  const rows = [1, 2, 3, 4].map((n) => job(n, { tag: 'cli' }));
  const lines = (flight) => flight.staffed.map((row) => `${row.engine}: ${row.pick}`);
  const codexLine = /^picked fleet-codex for this cli job: landed 8 of 12 since Nov 1, 0 of 4 on jobs like it/;

  const before = await dryFlight(app, rows);
  assert.ok(before.flight.staffed.some((row) => codexLine.test(row.pick || '')), `codex is picked for some cli job, with its cli record quoted:\n${lines(before.flight).join('\n')}`);

  // Somebody tags the eight finished docs jobs as cli jobs. They were not cli jobs when codex took them.
  for (const id of docs) store.tag(id, { add: ['cli'] });
  const after = await dryFlight(app, rows);
  assert.deepEqual(lines(after.flight), lines(before.flight), 'the same picks and the same lines as before the retag');
});

// ---------------------------------------------------------------------------
// Five. A retry takes the next builder in the job's own order; a handover keeps the roster's.

test('a retry after a dead engine takes the next builder in the picker\'s order, and says so', async (t) => {
  const { app, store } = room(t);
  // codex has the weaker record, cursor the stronger: today's rule would try codex first.
  store.plays(12, { member: 'fleet-codex', outcome: 'dropped', at: FIRST });
  store.plays(12, { member: 'fleet-cursor', outcome: 'landed', at: FIRST });
  const engines = ['claude', 'codex', 'cursor'];
  const named = job(1, { metadata: { executed_by: 'claude' } });
  const answer = (entry) => (entry.engine === 'claude' ? DEAD : { exitCode: 0, report: 'built it' });

  const today = fleet.nextInstalledFleetEngine('claude', { root: app, installedEngines: engines });
  assert.equal(today, 'codex', 'today\'s rule');

  const picked = await liveFlight(app, [named], { answer, flight: { engines } });
  assert.deepEqual(picked.asked, [['F-1', 'claude'], ['F-1', 'cursor']], 'the job names claude, and when claude is dead the better record takes over');
  const row = picked.flight.results[0];
  assert.equal(row.restaffed.from, 'claude');
  assert.equal(row.restaffed.to, 'cursor');
  assert.equal(row.restaffed.pick, 'picked fleet-cursor for this job: landed 12 of 12 since Nov 1 (fleet-codex 0 of 12)');
  const at = picked.logs.findIndex((line) => /restaffed F-1: claude -> cursor/.test(line));
  assert.ok(at >= 0, picked.logs.join('\n'));
  assert.equal(picked.logs[at + 1], `      ${row.restaffed.pick}`);
  const receipt = JSON.parse(fs.readFileSync(picked.flight.receipt, 'utf8'));
  assert.equal(receipt.results[0].restaffed.pick, row.restaffed.pick);

  const turns = await liveFlight(app, [named], { answer, flight: { engines, pick: 'turns' } });
  assert.deepEqual(turns.asked, [['F-1', 'claude'], ['F-1', 'codex']], 'turns keeps today\'s rule');
  assert.ok(!('pick' in turns.flight.results[0].restaffed));
});

test('a retry with nobody having a result keeps today\'s rule', async (t) => {
  const { app } = room(t);
  const engines = ['claude', 'codex', 'cursor'];
  const answer = (entry) => (entry.engine === 'claude' ? DEAD : { exitCode: 0, report: 'built it' });
  const { asked, flight } = await liveFlight(app, [job(1, { metadata: { executed_by: 'claude' } })], { answer, flight: { engines } });
  assert.deepEqual(asked, [['F-1', 'claude'], ['F-1', 'codex']]);
  assert.ok(!('pick' in flight.results[0].restaffed));
});
test('a rescued job is claimed for the engine it was dealt and handed in under the engine that finished it, and the next flight pays the finisher', async (t) => {
  const { app, store } = room(t);
  const engines = ['claude', 'codex', 'cursor'];
  const answer = (entry) => (entry.engine === 'claude' ? DEAD : { exitCode: 0, report: 'built it' });
  const live = await liveFlight(app, [job(1, { metadata: { executed_by: 'claude' } })], { answer, flight: { engines } });
  const finisher = live.flight.results[0].restaffed.to;
  assert.equal(live.flight.results[0].restaffed.from, 'claude');
  assert.notEqual(finisher, 'claude');
  const nameOf = (verb) => {
    const call = live.calls.find((args) => args[0] === 'task' && args[1] === verb);
    return call ? call[call.indexOf('--as') + 1] : null;
  };
  assert.equal(nameOf('claim'), 'fleet-claude', 'the job was claimed for the engine it was dealt to');
  assert.equal(nameOf('ready'), `fleet-${finisher}`, 'the hand-in is written under the engine that finished it: the store says who finished');

  // Twelve jobs claimed for claude and finished by that engine are what the next flight reads. They pay the finisher.
  store.plays(12, { member: 'fleet-claude', outcome: 'landed', at: FIRST, handIn: { by: `fleet-${finisher}` } });
  const { flight } = await dryFlight(app, jobs(3), { engines });
  const lines = flight.staffed.map((row) => `${row.engine}: ${row.pick}`).join('\n');
  const paid = flight.staffed.find((row) => row.engine === finisher);
  assert.ok(paid && new RegExp(`^picked fleet-${finisher} for this job: landed 12 of 12 since Nov 1`).test(paid.pick), lines);
  assert.ok(flight.staffed.every((row) => !/^picked fleet-claude for this job: landed [1-9]/.test(row.pick) && !/fleet-claude [1-9]\d* of/.test(row.pick)), `the engine that died is not paid:\n${lines}`);
  assert.ok(flight.staffed.some((row) => /fleet-claude new/.test(row.pick)), `claude has no record of its own:\n${lines}`);
});

// A dispatch flight on one job (CLI-900) whose first engine, codex, is dead, with stand-ins for everything else.
// Resolves to the flight and the engines it asked, in order.
function dispatchRun(app, options = {}) {
  const asked = [];
  const task = { id: 'row-900', display_id: 'CLI-900', workspace_root: tasks.workspaceRoot(app), status: 'open', tag: 'cli', title: jobTitle(900) };
  return fleet.runDispatchFlight({
    root: app,
    taskIds: ['CLI-900'],
    engine: 'codex',
    installedEngines: ['codex', 'cursor', 'claude'],
    ownCli: (args) => {
      if (args[0] === 'task' && args[1] === 'show') return { status: 0, stdout: JSON.stringify(task), stderr: '' };
      if (args[0] === 'worktree' && args[1] === 'start') return { status: 0, stdout: `next: cd ${app}/wt-900\n`, stderr: '' };
      return { status: 0, stdout: 'done: worktree shipped\n', stderr: '' };
    },
    dispatcher: (entry) => {
      asked.push(entry.engine);
      return Promise.resolve(entry.engine === 'codex' ? DEAD : { exitCode: 0, report: 'built it' });
    },
    scoutAsk: false,
    rebase: () => ({ ok: true, stage: 'rebased' }),
    verifier: () => ({ status: 0, stdout: '# pass 1\n', stderr: '' }),
    log: () => {},
    ...options,
  }).then((flight) => ({ flight, asked }));
}

test('a dispatch flight\'s retry follows the picker too, in the job\'s lane', async (t) => {
  const { app, store } = room(t);
  store.plays(12, { member: 'fleet-claude', outcome: 'landed', at: FIRST });
  store.plays(12, { member: 'fleet-cursor', outcome: 'dropped', at: FIRST });
  const run = (options = {}) => dispatchRun(app, options);

  assert.equal(fleet.nextInstalledFleetEngine('codex', { root: app, installedEngines: ['codex', 'cursor', 'claude'] }), 'cursor', 'today\'s rule');
  const picked = await run();
  assert.deepEqual(picked.asked, ['codex', 'claude']);
  assert.equal(picked.flight.results[0].restaffed.pick, 'picked fleet-claude for this cli job: landed 12 of 12 since Nov 1 (fleet-cursor 0 of 12)');
  const receipt = JSON.parse(fs.readFileSync(picked.flight.receipt, 'utf8'));
  assert.equal(receipt.results[0].restaffed.pick, picked.flight.results[0].restaffed.pick);

  const turns = await run({ pick: 'turns' });
  assert.deepEqual(turns.asked, ['codex', 'cursor']);
});

test('a retry on a list the caller named is never filtered: an engine that is resting can still be the retry, on a fleet flight and a dispatch flight alike', async (t) => {
  const { ws, app, store } = room(t);
  const bin = fakeEngines(ws, ['claude', 'codex', 'cursor-agent']);
  // The best record belongs to cursor, which the registry has out of credit; codex has the misses.
  store.plays(12, { member: 'fleet-cursor', outcome: 'landed', at: FIRST });
  store.plays(12, { member: 'fleet-codex', outcome: 'dropped', at: FIRST });
  await withEnv(isolatedHome(ws, bin), async () => {
    // A dead engine is marked out of credit by the flight that meets it, so each flight starts from the same board.
    const board = () => {
      for (const name of ['claude', 'codex']) registry.setEngineHealth(name, 'ready', app);
      registry.setEngineHealth('cursor', 'credit_out', app);
    };
    const engines = ['claude', 'codex', 'cursor'];
    const answer = (entry) => (entry.engine === 'claude' ? DEAD : { exitCode: 0, report: 'built it' });

    // A fleet flight with a named list: the job names claude, claude is dead, and the better record takes over.
    board();
    const fleetNamed = await liveFlight(app, [job(1, { metadata: { executed_by: 'claude' } })], { answer, flight: { engines } });
    assert.deepEqual(fleetNamed.asked, [['F-1', 'claude'], ['F-1', 'cursor']], 'the caller named cursor, so it stays a candidate');
    assert.equal(fleetNamed.flight.results[0].restaffed.to, 'cursor');
    assert.ok(!fleetNamed.logs.some((line) => /not ready/.test(line)));

    // A dispatch flight with a named list: the same.
    board();
    const dispatchNamed = await dispatchRun(app, { installedEngines: ['codex', 'cursor', 'claude'] });
    assert.deepEqual(dispatchNamed.asked, ['codex', 'cursor']);

    // A dispatch flight with no list (the machine's own engines) leaves the resting engine out of its retry.
    board();
    const dispatchOpen = await dispatchRun(app, { installedEngines: null });
    assert.ok(!dispatchOpen.asked.includes('cursor'), `cursor is out of credit and nobody named it: ${dispatchOpen.asked}`);
    assert.equal(dispatchOpen.asked[0], 'codex');
    assert.equal(dispatchOpen.asked.length, 2, 'the job was still retried, on an engine that is ready');
  });
});

test('a retry on a list the caller named keeps an engine the spend guard would stop, and an open list does not', async (t) => {
  const { ws, app, store } = room(t);
  const bin = fakeEngines(ws, ['claude', 'codex', 'cursor-agent']);
  // The best record belongs to claude, whose launch carries a paid model nobody approved.
  store.plays(12, { member: 'fleet-claude', outcome: 'landed', at: FIRST });
  store.plays(12, { member: 'fleet-cursor', outcome: 'dropped', at: FIRST });
  await withEnv({ ...isolatedHome(ws, bin), ATRIS_RUNNER_MODEL: 'claude-mystery-9' }, async () => {
    const named = await dispatchRun(app, { installedEngines: ['codex', 'cursor', 'claude'] });
    assert.deepEqual(named.asked, ['codex', 'claude'], 'the caller named claude: its record wins the retry, and the guard\'s own hook is the one that stops a run');
    for (const name of ['claude', 'codex', 'cursor']) registry.setEngineHealth(name, 'ready', app);
    const open = await dispatchRun(app, { installedEngines: null });
    assert.ok(!open.asked.includes('claude'), `nobody named claude and its launch would be stopped: ${open.asked}`);
    assert.equal(open.asked.length, 2);
  });
});

test('steeringFor: the spend guard is asked in the environment the workers will really run in, and a named list is never filtered', async (t) => {
  const { ws, app } = room(t);
  const bin = fakeEngines(ws, ['claude', 'codex']);
  const PAID = 'claude-mystery-9';
  const STOPPED = `left out, not ready: claude (paid model ${PAID}, no spend approval)`;
  const KEYED = 'left out, not ready: claude (a pay-per-use Claude key is set)';
  const ask = (options = {}) => fleet.steeringFor({ root: app, ...options }).rest(['claude', 'codex']);

  // Plain workers inherit the environment this process runs in, owner approval and all.
  await withEnv({ ...isolatedHome(ws, bin), ATRIS_RUNNER_MODEL: PAID, ATRIS_CLAUDE_SPEND_OK: PAID }, () => {
    assert.deepEqual(ask().ready, ['claude', 'codex'], 'the approval reaches a plain worker');
    // A sealed worker (a one-lap build) is given no approval, so the hook would stop the same run.
    const sealed = ask({ sealed: true });
    assert.deepEqual(sealed.ready, ['codex']);
    assert.equal(sealed.note, STOPPED);
  });

  // A pay-per-use key is in this process; a sealed worker has it stripped, a plain worker keeps it.
  await withEnv({ ...isolatedHome(ws, bin), ATRIS_RUNNER_MODEL: 'claude-haiku-5-5', ANTHROPIC_API_KEY: 'sk-test-not-real' }, () => {
    const plain = ask();
    assert.deepEqual(plain.ready, ['codex']);
    assert.equal(plain.note, KEYED);
    assert.deepEqual(ask({ sealed: true }).ready, ['claude', 'codex'], 'the key is stripped before the sealed worker starts');
  });

  // A list the caller named is never filtered, sealed or not, and steering off never asks.
  await withEnv({ ...isolatedHome(ws, bin), ATRIS_RUNNER_MODEL: PAID }, () => {
    for (const sealed of [false, true]) {
      assert.deepEqual(ask({ named: true, sealed }), { ready: ['claude', 'codex'], resting: [], note: '' });
    }
    assert.deepEqual(ask({ pick: 'turns', sealed: true }), { ready: ['claude', 'codex'], resting: [], note: '' });
  });

  // The environment a sealed worker is given, as far as the guard reads it.
  assert.ok(Object.isFrozen(fleet.SEALED_WORKER_GUARD_ENV));
  assert.equal(unattendedStop({ model: 'claude-haiku-5-5', env: fleet.SEALED_WORKER_GUARD_ENV }), null);
  assert.equal(unattendedStop({ model: PAID, env: fleet.SEALED_WORKER_GUARD_ENV }).why, `paid model ${PAID}, no spend approval`);
});

test('steeringFor: a custom launch template sits claude out of a plain flight and a sealed one, and the line says it could not tell', async (t) => {
  const { ws, app } = room(t);
  const bin = fakeEngines(ws, ['claude', 'codex']);
  const LINE = 'left out, not ready: claude (could not tell which model its custom launch template uses, so it counts as paid, and there is no spend approval)';
  const ask = (options = {}) => fleet.steeringFor({ root: app, ...options }).rest(['claude', 'codex']);
  // The owner's own Claude settings say Haiku. Neither kind of worker gets to use that.
  fs.mkdirSync(path.join(ws, 'home', '.claude'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'home', '.claude', 'settings.json'), JSON.stringify({ model: 'haiku' }));

  for (const template of ['{bin} -p x --model $(printf %s op us)', '{bin} -p {model}', '{bin} -p {prompt}', '{bin} -p {prompt} --model claude-haiku-5-5']) {
    await withEnv({ ...isolatedHome(ws, bin), ANTHROPIC_MODEL: 'haiku', ATRIS_RUNNER_COMMAND_TEMPLATE: template }, () => {
      for (const sealed of [false, true]) {
        const said = ask({ sealed });
        assert.deepEqual(said.ready, ['codex'], `${template}, sealed ${sealed}`);
        assert.equal(said.note, LINE, `${template}, sealed ${sealed}`);
      }
      // A list the caller named is never filtered.
      assert.deepEqual(fleet.steeringFor({ root: app, named: true, sealed: true }).rest(['claude', 'codex']), { ready: ['claude', 'codex'], resting: [], note: '' });
    });
  }

  // Approving the paid default covers it for a plain worker, which inherits the approval, and not for a sealed one.
  await withEnv({ ...isolatedHome(ws, bin), ATRIS_RUNNER_COMMAND_TEMPLATE: '{bin} -p {prompt}', ATRIS_CLAUDE_SPEND_OK: 'default' }, () => {
    assert.deepEqual(ask().ready, ['claude', 'codex']);
    assert.equal(ask({ sealed: true }).note, LINE);
  });

  // The same flight without the template is the fleet's own launch, which passes Haiku.
  await withEnv({ ...isolatedHome(ws, bin), ANTHROPIC_MODEL: 'haiku' }, () => {
    for (const sealed of [false, true]) assert.deepEqual(ask({ sealed }).ready, ['claude', 'codex']);
  });
});

test('a stalled engine hands the job to the next on its team in the roster\'s own order, whatever the records say', async (t) => {
  const { ws, app, store } = room(t);
  fs.writeFileSync(path.join(app, 'atris', 'ROSTER.md'), '# roster\n\n## build\n- devin\n- grok\n- cursor\n');
  store.plays(12, { member: 'fleet-grok', outcome: 'dropped', at: FIRST });
  store.plays(12, { member: 'fleet-cursor', outcome: 'landed', at: FIRST });
  const rosterFile = path.join(ws, 'machine-roster.json');
  await withEnv({ ATRIS_MACHINE_ROSTER_PATH: rosterFile, ATRIS_ROUTER_EXPLAIN: '0', ATRIS_ROSTER_SESSION: undefined }, async () => {
    for (const name of ['devin', 'grok', 'cursor']) registry.setEngineHealth(name, 'ready', app);
    const task = { id: 'row-900', display_id: 'CLI-900', workspace_root: tasks.workspaceRoot(app), status: 'open', title: jobTitle(900) };
    const run = async (options = {}) => {
      for (const name of ['devin', 'grok', 'cursor']) registry.setEngineHealth(name, 'ready', app);
      const asked = [];
      const flight = await fleet.runDispatchFlight({
        root: app,
        taskIds: ['CLI-900'],
        engine: 'devin',
        installedEngines: [],
        ownCli: (args) => {
          if (args[0] === 'task' && args[1] === 'show') return { status: 0, stdout: JSON.stringify(task), stderr: '' };
          if (args[0] === 'worktree' && args[1] === 'start') return { status: 0, stdout: `next: cd ${app}/wt-900\n`, stderr: '' };
          return { status: 0, stdout: 'done: worktree shipped\n', stderr: '' };
        },
        dispatcher: (entry) => {
          asked.push(entry.engine);
          return Promise.resolve(entry.engine === 'devin' ? { exitCode: null, timed_out: true, report: '', stderr: '', max_seconds: 1 } : { exitCode: 0, report: 'built it' });
        },
        scoutAsk: false,
        rebase: () => ({ ok: true, stage: 'rebased' }),
        verifier: () => ({ status: 0, stdout: '# pass 1\n', stderr: '' }),
        log: () => {},
        ...options,
      });
      return { flight, asked };
    };

    // The team lists grok first. Cursor has the record and grok has the misses; the roster's order is the owner's
    // choice, so the picker does not touch it.
    const picked = await run();
    assert.deepEqual(picked.asked, ['devin', 'grok'], 'the first worker listed takes over');
    assert.equal(picked.flight.results[0].handover.to, 'grok');
    assert.ok(!('picks' in picked.flight.results[0].handover), 'no pick line: nothing was picked');
    assert.ok(!('pick' in picked.flight.results[0].handover));
    const receipt = JSON.parse(fs.readFileSync(picked.flight.receipt, 'utf8'));
    assert.ok(!('picks' in receipt.results[0].handover));

    const turns = await run({ pick: 'turns' });
    assert.deepEqual(turns.asked, picked.asked, 'exactly what the handover did before the picker');
    assert.deepEqual(turns.flight.results[0].handover, picked.flight.results[0].handover);
  });
});

// ---------------------------------------------------------------------------
// Six. The command line.

function cliRoom(t, names = ['claude', 'codex']) {
  const made = room(t);
  const bin = fakeEngines(made.ws, names);
  fs.mkdirSync(path.join(made.ws, 'home'), { recursive: true });
  listJobs(made.app, jobs(4));
  const fly = (args, env = {}) => runCli(['mission', 'run', '--fleet', '--dry-run', '--json', '--slots', '4', ...args], {
    cwd: made.app,
    env: {
      PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}/usr/bin${path.delimiter}/bin`,
      HOME: path.join(made.ws, 'home'),
      ATRIS_TASKS_DB: made.store.dbPath,
      ATRIS_PICK_SINCE: '2026-11-01',
      ATRIS_PICK: undefined,
      ...env,
    },
  });
  return { ...made, fly };
}

test('mission run --fleet: results pick by default, --pick turns deals in turn, --engine wins, a pick nobody knows is refused', (t) => {
  const { store, fly } = cliRoom(t);
  codexIsStrong(store);
  const staffed = (result) => {
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  };

  const picked = staffed(fly([]));
  assert.deepEqual(picked.staffed.map((row) => row.engine), ['codex', 'codex', 'claude', 'claude']);
  assert.match(picked.staffed[0].pick, /^picked fleet-codex for this job: landed 12 of 12 since Nov 1/);

  const turns = staffed(fly(['--pick', 'turns']));
  assert.deepEqual(turns.staffed.map((row) => row.engine), [0, 1, 2, 3].map((i) => turns.roster[i % turns.roster.length]), 'the roster\'s own turns');
  assert.ok(turns.staffed.every((row) => !('pick' in row)));

  const envTurns = staffed(fly([], { ATRIS_PICK: 'turns' }));
  assert.deepEqual(envTurns.staffed.map((row) => row.engine), turns.staffed.map((row) => row.engine));

  const named = staffed(fly(['--engine', 'claude']));
  assert.deepEqual(named.staffed.map((row) => row.engine), ['claude', 'claude', 'claude', 'claude']);
  assert.ok(named.staffed.every((row) => !('pick' in row)));

  const unknown = fly(['--pick', 'sideways']);
  assert.notEqual(unknown.status, 0);
  assert.match(`${unknown.stdout}${unknown.stderr}`, /--pick takes rating or turns/);
  const wrongEngine = fly(['--engine', 'fable']);
  assert.notEqual(wrongEngine.status, 0);
  assert.match(`${wrongEngine.stdout}${wrongEngine.stderr}`, /--engine for a fleet takes one of/);
});

test('engine dispatch takes --pick, keeps its value out of the task ids, and refuses a value nobody knows', async () => {
  const parsed = engineCommand.parseDispatchArgs(['CLI-1', '--engine', 'codex', '--pick', 'turns', 'CLI-2']);
  assert.deepEqual(parsed.taskIds, ['CLI-1', 'CLI-2']);
  assert.equal(parsed.pick, 'turns');
  assert.equal(engineCommand.parseDispatchArgs(['CLI-1', '--engine=codex', '--pick=rating']).pick, 'rating');
  assert.equal(engineCommand.parseDispatchArgs(['CLI-1', '--engine', 'codex']).pick, '');

  const errors = [];
  const original = console.error;
  console.error = (line = '') => errors.push(String(line));
  try {
    const code = await engineCommand.engineCommand(['dispatch', 'CLI-1', '--engine', 'codex', '--pick', 'sideways'], { root: process.cwd() });
    assert.equal(code, 2);
  } finally {
    console.error = original;
  }
  assert.match(errors.join('\n'), /--pick takes rating or turns/);
});

// ---------------------------------------------------------------------------
// Seven. atris rating says steering is on.

function rate(args, deps) {
  const out = [];
  const code = ratingCommand(args, { write: (text) => out.push(text), season: { outcomes: [], workspace_name: 'scratch' }, lineup: null, ...deps });
  assert.equal(code, 0);
  return out.join('');
}

test('atris rating says steering is on and how many jobs it has picked, only when it is on', async (t) => {
  const { app, store } = room(t);
  codexIsStrong(store);
  // The start is set to a date that has passed, so the receipts these flights write today count whatever the clock says.
  const env = { ATRIS_PICK_SINCE: '2026-10-01' };

  assert.match(rate([], { root: app, env }), /\nsteering on since Oct 1: picked 0 jobs\n$/, 'before any flight');

  await liveFlight(app, jobs(4));
  const text = rate([], { root: app, env });
  assert.match(text, /\nsteering on since Oct 1: picked 4 jobs\n$/);
  assert.equal(text.split('steering on').length, 2, 'said once');

  // A job picked at the start whose first engine then died is picked a second time for the retry. It is still one job.
  let asks = 0;
  const retried = await liveFlight(app, [job(5)], {
    answer: () => (asks++ === 0 ? DEAD : { exitCode: 0, report: 'built it' }),
    flight: { engines: ['claude', 'codex', 'cursor'] },
  });
  assert.ok(retried.flight.staffed[0].pick && retried.flight.results[0].restaffed.pick, 'the job was picked twice');
  assert.match(rate([], { root: app, env }), /steering on since Oct 1: picked 5 jobs\n$/);

  const json = JSON.parse(rate(['--json'], { root: app, env }));
  assert.deepEqual(json.steering, { on: true, since: '2026-10-01T00:00:00.000Z', picked: 5, line: 'steering on since Oct 1: picked 5 jobs' });

  // Off means off: no line, and the json says so.
  const off = { ATRIS_PICK_SINCE: '2026-10-01', ATRIS_PICK: 'turns' };
  assert.doesNotMatch(rate([], { root: app, env: off }), /steering/);
  assert.deepEqual(JSON.parse(rate(['--json'], { root: app, env: off })).steering, { on: false });

  // A later start leaves the earlier picks out.
  assert.match(rate([], { root: app, env: { ATRIS_PICK_SINCE: '2099-01-01' } }), /steering on since Jan 1: picked 0 jobs\n$/);

  // One engine's card is about that engine; the steering line belongs to the overview.
  assert.doesNotMatch(rate(['opus'], { root: app, env }), /steering/);
});
