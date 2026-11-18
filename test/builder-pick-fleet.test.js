'use strict';

const {
  HOUR,
  START,
  FIRST,
  withEnv,
  room,
  job,
  jobs,
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
const tasks = require('../lib/task-db');
const registry = require('../lib/engine-registry');

// Every test here counts from the same day, whatever today is, and starts with the picker on.
process.env.ATRIS_PICK_SINCE = '2026-11-01';
process.env.ATRIS_PICK_SEED_DAY = '2026-11-03';
delete process.env.ATRIS_PICK;

// The line the fleet has always printed under its header for one staffed job.
const jobLine = (engine, row) => `    ${engine.padEnd(8)} → ${row.display_id}  ${row.title.slice(0, 80)}`;

// A team member whose engine the project's roster decides.
function addMember(app, member, engine) {
  const dir = path.join(app, 'atris', 'team', member);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'MEMBER.md'), `---\nname: ${member}\nrole: ${member}\ndescription: test member\n---\n\n# ${member}\n`);
  fs.writeFileSync(path.join(app, 'atris', 'ROSTER.md'), `# roster\n\n## team\n${member}: ${engine}\n`);
}

// ---------------------------------------------------------------------------
// One. Dealing: the order, the line under each job, and the receipt.

test('the fleet deals each job to the builder its results favor, and prints why under the job', async (t) => {
  const { app, store } = room(t);
  codexIsStrong(store);
  const rows = jobs(4);
  const { flight, logs } = await dryFlight(app, rows);

  assert.deepEqual(flight.staffed.map((row) => row.engine), ['codex', 'codex', 'claude', 'claude'], 'today it would be claude, codex, claude, codex');
  assert.deepEqual(flight.staffed.map((row) => row.task), ['F-1', 'F-2', 'F-3', 'F-4']);
  assert.equal(flight.staffed[0].pick, 'picked fleet-codex for this job: landed 12 of 12 since Nov 1 (fleet-claude 0 of 12)');
  assert.equal(flight.staffed[2].pick, 'picked fleet-claude for this job: landed 0 of 12 since Nov 1 (fleet-codex 12 of 12 but has its share)', 'nobody takes more than their share, so the next builder is used');

  // Each job's line is printed right under the job.
  flight.staffed.forEach((row, i) => {
    const at = logs.indexOf(jobLine(row.engine, rows[i]));
    assert.ok(at >= 0, `the job line for ${row.task} is printed:\n${logs.join('\n')}`);
    assert.equal(logs[at + 1], `      ${row.pick}`);
  });
  assert.equal(logs.filter((line) => /picked fleet-/.test(line)).length, 4);
});

test('the pick lines ride in the receipt of a live flight, and the engines asked are the ones picked', async (t) => {
  const { app, store } = room(t);
  codexIsStrong(store);
  const { flight, asked, calls } = await liveFlight(app, jobs(4));

  assert.deepEqual(asked.sort((a, b) => a[0].localeCompare(b[0])), [['F-1', 'codex'], ['F-2', 'codex'], ['F-3', 'claude'], ['F-4', 'claude']]);
  const claims = calls.filter((args) => args[0] === 'task' && args[1] === 'claim').map((args) => args[args.indexOf('--as') + 1]).sort();
  assert.deepEqual(claims, ['fleet-claude', 'fleet-claude', 'fleet-codex', 'fleet-codex'], 'each job is claimed by the builder picked for it');

  assert.equal(flight.status, 'completed');
  const receipt = JSON.parse(fs.readFileSync(flight.receipt, 'utf8'));
  assert.deepEqual(receipt.staffed.map((row) => [row.task, row.engine]), [['F-1', 'codex'], ['F-2', 'codex'], ['F-3', 'claude'], ['F-4', 'claude']]);
  assert.deepEqual(receipt.staffed.map((row) => row.pick), flight.staffed.map((row) => row.pick));
  assert.match(receipt.staffed[1].pick, /^picked fleet-codex for this job: landed 12 of 12 since Nov 1 \(fleet-claude 0 of 12\)$/);
  assert.match(receipt.staffed[3].pick, /^picked fleet-claude for this job: landed 0 of 12 since Nov 1 \(fleet-codex 12 of 12 but has its share\)$/);
});

test('with no results yet, jobs go in turn and the flight says so', async (t) => {
  const { app } = room(t);
  const rows = jobs(4);
  const { flight, logs } = await dryFlight(app, rows);

  assert.deepEqual(flight.staffed.map((row) => row.engine), ['claude', 'codex', 'claude', 'codex']);
  assert.ok(flight.staffed.every((row) => !('pick' in row)), 'a job nobody picked carries no pick line');
  assert.ok(logs.includes('  steering on since Nov 1: no results yet, so jobs are dealt in turn'), logs.join('\n'));
  assert.equal(logs.filter((line) => /picked fleet-/.test(line)).length, 0);
});

test('results that cannot be read leave the flight dealing in turn, and it says so', async (t) => {
  const { ws, app, store } = room(t);
  codexIsStrong(store);
  // A task list file that is not a task list: the flight must not stop, and must not guess.
  const broken = path.join(ws, 'broken.db');
  fs.writeFileSync(broken, 'this is not a database\n');
  const { flight, logs } = await withEnv({ ATRIS_TASKS_DB: broken }, () => dryFlight(app, jobs(4)));

  assert.deepEqual(flight.staffed.map((row) => row.engine), ['claude', 'codex', 'claude', 'codex'], 'today\'s turns');
  assert.ok(flight.staffed.every((row) => !('pick' in row)));
  const note = logs.find((line) => /steering on since Nov 1: could not read results/.test(line));
  assert.ok(note, logs.join('\n'));
  assert.match(note, /^  steering on since Nov 1: could not read results \(.+\), so jobs are dealt in turn$/);
});

test('plays from before the steering start do not move a single job', async (t) => {
  const { app, store } = room(t);
  const before = START - 3 * 24 * HOUR;
  store.plays(12, { member: 'fleet-codex', outcome: 'landed', at: before });
  store.plays(12, { member: 'fleet-claude', outcome: 'dropped', at: before });
  const { flight } = await dryFlight(app, jobs(4));
  assert.deepEqual(flight.staffed.map((row) => row.engine), ['claude', 'codex', 'claude', 'codex'], 'everyone starts even on the day steering ships');
  assert.ok(flight.staffed.every((row) => !('pick' in row)));
});

test('a held pull request and a job that could not start move nothing either way', async (t) => {
  const { app, store } = room(t);
  store.plays(12, { member: 'fleet-claude', outcome: 'held', at: FIRST });
  store.plays(12, { member: 'fleet-codex', outcome: 'could_not_start', at: FIRST });
  const { flight } = await dryFlight(app, jobs(4));
  assert.deepEqual(flight.staffed.map((row) => row.engine), ['claude', 'codex', 'claude', 'codex']);
});

// ---------------------------------------------------------------------------
// Two. Turning it off, and choices that are not the picker's to make.

test('--pick turns and ATRIS_PICK=turns give exactly today\'s dealing and print nothing new', async (t) => {
  const { app, store } = room(t);
  codexIsStrong(store);
  const rows = jobs(4);
  const today = ['', '  fleet, 2 engines ready, 4 tasks staffed',
    jobLine('claude', rows[0]), jobLine('codex', rows[1]), jobLine('claude', rows[2]), jobLine('codex', rows[3]), ''];

  const byOption = await dryFlight(app, rows, { pick: 'turns' });
  assert.deepEqual(byOption.logs, today);
  assert.deepEqual(byOption.flight.staffed.map((row) => row.engine), ['claude', 'codex', 'claude', 'codex']);
  assert.ok(byOption.flight.staffed.every((row) => !('pick' in row)));

  const byEnv = await withEnv({ ATRIS_PICK: 'turns' }, () => dryFlight(app, rows));
  assert.deepEqual(byEnv.logs, today);
  assert.ok(byEnv.flight.staffed.every((row) => !('pick' in row)));

  const live = await withEnv({ ATRIS_PICK: 'turns' }, () => liveFlight(app, rows));
  assert.deepEqual(live.asked.sort((a, b) => a[0].localeCompare(b[0])), [['F-1', 'claude'], ['F-2', 'codex'], ['F-3', 'claude'], ['F-4', 'codex']]);
  const receipt = JSON.parse(fs.readFileSync(live.flight.receipt, 'utf8'));
  assert.ok(receipt.staffed.every((row) => !('pick' in row)));
});

test('--pick rating beats ATRIS_PICK=turns, because a flag is a choice and the environment is a habit', async (t) => {
  const { app, store } = room(t);
  codexIsStrong(store);
  const { flight } = await withEnv({ ATRIS_PICK: 'turns' }, () => dryFlight(app, jobs(4), { pick: 'rating' }));
  assert.deepEqual(flight.staffed.map((row) => row.engine), ['codex', 'codex', 'claude', 'claude']);
});

test('--engine wins: every job goes to that engine and the picker is not asked', async (t) => {
  const { app, store } = room(t);
  codexIsStrong(store);
  // Codex is the strong one, and the person said claude.
  const { flight, logs } = await dryFlight(app, jobs(3), { engine: 'claude' });
  assert.deepEqual(flight.staffed.map((row) => row.engine), ['claude', 'claude', 'claude']);
  assert.deepEqual(flight.roster, ['claude']);
  assert.ok(flight.staffed.every((row) => !('pick' in row)));
  assert.ok(!logs.some((line) => /picked|steering/.test(line)), logs.join('\n'));
  await assert.rejects(dryFlight(app, jobs(1), { engine: 'fable' }), /cannot build in a fleet/);
});

test('a job that names its engine goes there, with results or without', async (t) => {
  const { app, store } = room(t);
  const rows = [
    job(1, { metadata: { executed_by: 'codex' } }),
    job(2, { metadata: { executed_by: 'claude' } }),
    job(3),
    job(4),
  ];
  const quiet = await dryFlight(app, rows);
  assert.deepEqual(quiet.flight.staffed.map((row) => row.engine), ['codex', 'claude', 'claude', 'codex'], 'jobs one and two get the engines they name; today\'s turns would give claude and codex');
  assert.ok(quiet.flight.staffed.every((row) => !('pick' in row)));
  assert.ok(quiet.logs.includes('  steering on since Nov 1: no results yet, so jobs are dealt in turn'), 'the free jobs say they were dealt in turn');

  codexIsStrong(store);
  const steered = await dryFlight(app, rows);
  assert.deepEqual(steered.flight.staffed.slice(0, 2).map((row) => row.engine), ['codex', 'claude'], 'results do not move a job that names its engine');
  assert.ok(steered.flight.staffed.slice(0, 2).every((row) => !('pick' in row)), 'a named job is not the picker\'s');
  // Each named job already used one engine\'s place, so the free jobs are spread around them.
  assert.deepEqual(steered.flight.staffed.slice(2).map((row) => row.engine), ['codex', 'claude']);
  assert.match(steered.flight.staffed[2].pick, /^picked fleet-codex for this job: landed 12 of 12 since Nov 1/);
  assert.match(steered.flight.staffed[3].pick, /^picked fleet-claude for this job: landed 0 of 12 since Nov 1 \(fleet-codex 12 of 12 but has its share\)$/);

  // And `--pick turns` is exactly what it always was.
  const turns = await dryFlight(app, rows, { pick: 'turns' });
  assert.deepEqual(turns.flight.staffed.map((row) => row.engine), ['claude', 'codex', 'claude', 'codex']);
});

test('a flight where every job is explicit needs no results and says nothing about them', async (t) => {
  const { app } = room(t);
  const rows = [job(1, { metadata: { executed_by: 'codex' } }), job(2, { metadata: { executed_by: 'claude' } })];
  const { flight, logs } = await dryFlight(app, rows);
  assert.deepEqual(flight.staffed.map((row) => row.engine), ['codex', 'claude']);
  assert.ok(!logs.some((line) => /steering|picked/.test(line)), logs.join('\n'));
});
test('a job that names an engine this flight does not have is left out, with one line, and nothing is claimed or started for it', async (t) => {
  const { app, store } = room(t);
  codexIsStrong(store);
  const rows = [job(1, { metadata: { executed_by: 'devin' } }), job(2), job(3)];
  const line = 'left out F-1: it names devin, which this flight does not have (claude, codex)';

  const dry = await dryFlight(app, rows);
  assert.deepEqual(dry.flight.staffed.map((row) => row.task), ['F-2', 'F-3'], 'the job nobody can give an engine to is not in the flight');
  assert.ok(dry.logs.includes(`  ${line}`), dry.logs.join('\n'));
  assert.equal(dry.logs.filter((one) => /left out F-1/.test(one)).length, 1, 'said once');
  assert.ok(dry.logs.includes('  fleet, 2 engines ready, 2 tasks staffed'), 'the count is of the jobs that stay');

  const live = await liveFlight(app, rows);
  assert.deepEqual(live.asked.map(([task]) => task).sort(), ['F-2', 'F-3'], 'no engine was started for it');
  assert.ok(!JSON.stringify(live.calls).includes('row-1') && !JSON.stringify(live.calls).includes('F-1'), 'and it was not claimed, handed in or released');
  assert.ok(live.logs.includes(`  ${line}`));
  const receipt = JSON.parse(fs.readFileSync(live.flight.receipt, 'utf8'));
  assert.deepEqual(receipt.staffed.map((row) => row.task), ['F-2', 'F-3']);

  // A flight with every job left out starts nothing and says so for each.
  const none = await liveFlight(app, [rows[0], job(4, { metadata: { executed_by: 'grok' } })]);
  assert.deepEqual(none.asked, []);
  assert.deepEqual(none.flight.staffed, []);
  assert.ok(none.logs.includes(`  ${line}`) && none.logs.includes('  left out F-4: it names grok, which this flight does not have (claude, codex)'), none.logs.join('\n'));

  // And `--pick turns` is what it always was: the job keeps the engine its turn gave it.
  const turns = await dryFlight(app, rows, { pick: 'turns' });
  assert.deepEqual(turns.flight.staffed.map((row) => [row.task, row.engine]), [['F-1', 'claude'], ['F-2', 'codex'], ['F-3', 'claude']]);
  assert.ok(!turns.logs.some((one) => /left out/.test(one)));
});

test('a job assigned to a member whose engine this flight does not have is left out, naming the member and the engine', async (t) => {
  const { ws, app } = room(t);
  const bin = fakeEngines(ws, ['claude', 'codex', 'cursor-agent']);
  addMember(app, 'closer', 'cursor');
  await withEnv(isolatedHome(ws, bin), async () => {
    const { flight, logs } = await dryFlight(app, [job(1, { metadata: { assigned_to: 'closer' } }), job(2), job(3)]);
    assert.deepEqual(flight.staffed.map((row) => row.task), ['F-2', 'F-3']);
    assert.ok(logs.includes('  left out F-1: it is assigned to closer, whose engine is cursor, which this flight does not have (claude, codex)'), logs.join('\n'));
  });
});

// A job left out is taken out before the flight is staffed. It takes no slot, and it blocks no other job's files.
test('a job left out takes no slot: with one slot, the next job that can go is staffed', async (t) => {
  const { app } = room(t);
  const rows = [job(1, { metadata: { executed_by: 'devin' } }), job(2), job(3)];
  const dry = await dryFlight(app, rows, { slots: 1 });
  assert.deepEqual(dry.flight.staffed.map((row) => row.task), ['F-2'], 'the only slot goes to a job that can have an engine');
  assert.ok(dry.logs.includes('  left out F-1: it names devin, which this flight does not have (claude, codex)'), dry.logs.join('\n'));
  assert.ok(dry.logs.includes('  fleet, 2 engines ready, 1 task staffed'));
  assert.ok(!dry.logs.some((line) => /left out F-3/.test(line)), 'a job further down the list, never looked at, is not named');

  // Two slots and two left out ahead of the jobs that go: still both slots are filled.
  const two = await dryFlight(app, [job(1, { metadata: { executed_by: 'devin' } }), job(2, { metadata: { executed_by: 'grok' } }), job(3), job(4), job(5)], { slots: 2 });
  assert.deepEqual(two.flight.staffed.map((row) => row.task), ['F-3', 'F-4']);

  // The live flight claims and starts the job that goes, and nothing for the one left out.
  const live = await liveFlight(app, rows, { flight: { slots: 1 } });
  assert.deepEqual(live.asked.map(([task]) => task), ['F-2']);
  assert.ok(!JSON.stringify(live.calls).includes('row-1'), 'the job left out was not claimed');

  // And `--pick turns` is what it always was: the job keeps its slot, and the flight is the one job it names.
  const turns = await dryFlight(app, rows, { slots: 1, pick: 'turns' });
  assert.deepEqual(turns.flight.staffed.map((row) => row.task), ['F-1']);
});

test('a job left out blocks no other job that touches the same file, or the one job whose files nobody could guess', async (t) => {
  const { app } = room(t);
  const shared = (n, extra = {}) => job(n, { title: `Fix thing ${n}. Done: it works. Check: node --test test/shared.test.js. Edits lib/shared.js`, ...extra });
  const dry = await dryFlight(app, [shared(1, { metadata: { executed_by: 'devin' } }), shared(2), job(3)]);
  assert.deepEqual(dry.flight.staffed.map((row) => row.task), ['F-2', 'F-3'], 'the job that cannot go does not hold lib/shared.js');
  // Control: with nothing left out, the second job on the file waits for another flight, as it always did.
  const held = await dryFlight(app, [shared(1), shared(2), job(3)]);
  assert.deepEqual(held.flight.staffed.map((row) => row.task), ['F-1', 'F-3']);
  // A job whose files cannot be guessed is allowed one at a time; one that is left out does not use that up.
  const blind = (n, extra = {}) => ({ id: `row-${n}`, display_id: `F-${n}`, status: 'open', title: `Tidy up thing ${n}`, ...extra });
  const unknown = await dryFlight(app, [blind(1, { metadata: { executed_by: 'devin' } }), blind(2), blind(3)]);
  assert.deepEqual(unknown.flight.staffed.map((row) => row.task), ['F-2']);
});

test('with no engine at all, no job is named as left out: the flight simply has nobody to staff', async (t) => {
  const { app } = room(t);
  const dry = await dryFlight(app, [job(1, { metadata: { executed_by: 'devin' } }), job(2)], { engines: [] });
  assert.deepEqual(dry.flight.staffed, []);
  assert.ok(dry.logs.includes('  fleet, 0 engines ready, 0 tasks staffed'), dry.logs.join('\n'));
  assert.ok(!dry.logs.some((line) => /left out/.test(line)), dry.logs.join('\n'));
});

// The pick is made from the saved task list, and the claim comes a little later. A job whose member or engine was
// changed in between is not claimed for the old choice: the claim itself compares them, in its own transaction.
test('a job whose member or engine changed after the pick is not claimed for the old choice: it is left for the next flight, with one line', async (t) => {
  const { app, store } = room(t);
  const workspace = tasks.workspaceRoot(app);
  // Jobs the store really holds, so the flight claims them in its own process; the same words are in the task list.
  const real = (n, metadata = {}) => {
    const row = job(n, { metadata });
    store.db.prepare('INSERT INTO tasks (id, title, status, tag, workspace_root, created_at, updated_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(row.id, row.title, 'open', null, workspace, START, START, JSON.stringify(metadata));
    return row;
  };
  const edit = (id, change) => {
    const was = JSON.parse(store.db.prepare('SELECT metadata FROM tasks WHERE id = ?').get(id).metadata);
    store.db.prepare('UPDATE tasks SET metadata = ? WHERE id = ?').run(JSON.stringify(change(was)), id);
  };
  const state = (id) => ({ ...store.db.prepare('SELECT status, claimed_by FROM tasks WHERE id = ?').get(id) });
  const claimedEvents = (id) => store.db.prepare("SELECT COUNT(*) AS n FROM task_events WHERE task_id = ? AND event_type = 'claimed'").get(id).n;
  const rows = [real(1, { assigned_to: 'closer' }), real(2), real(3, { executed_by: 'codex' }), real(4, { assigned_to: 'closer' }), real(5, { executed_by: 'claude' })];

  // The changes land after the flight has picked and before it claims: here, while it checks the disk.
  const live = await liveFlight(app, rows, {
    flight: {
      spaceGuard: true,
      freeSpace: () => {
        edit('row-1', (was) => ({ ...was, assigned_to: 'someone-else' }));   // given to another member
        edit('row-3', (was) => ({ ...was, executed_by: 'claude' }));          // another engine named
        edit('row-4', ({ assigned_to, ...rest }) => rest);                    // taken off the member
        edit('row-5', (was) => ({ ...was, assigned_to: 'closer' }));          // a member added to a job that named an engine
        return 10 ** 13;
      },
    },
  });

  assert.deepEqual(live.asked.map(([task]) => task), ['F-2'], 'only the job nobody changed was started');
  for (const id of ['row-1', 'row-3', 'row-4', 'row-5']) {
    assert.deepEqual(state(id), { status: 'open', claimed_by: null }, `${id} was not claimed`);
    assert.equal(claimedEvents(id), 0, `${id} has no claim on its record`);
  }
  assert.equal(state('row-2').status, 'claimed', 'the job nobody changed was claimed as usual');
  assert.equal(claimedEvents('row-2'), 1);
  const said = (label) => live.logs.filter((line) => line.includes(label) && /for the next flight/.test(line));
  for (const label of ['F-1', 'F-3', 'F-4', 'F-5']) {
    assert.equal(said(label).length, 1, `one line for ${label}:\n${live.logs.join('\n')}`);
  }
  assert.equal(said('F-1')[0], '    left F-1 for the next flight: who it is assigned to, or the engine it names, changed after this flight read the list');
  assert.equal(said('F-2').length, 0);
  assert.deepEqual(live.flight.paused.map((row) => [row.task, row.stage]).sort(), [['F-1', 'choice_changed'], ['F-3', 'choice_changed'], ['F-4', 'choice_changed'], ['F-5', 'choice_changed']]);

  // The task list file is drawn again from the store, so the next flight reads the jobs as they are now and does not
  // meet the same old words again.
  const redrawn = JSON.parse(fs.readFileSync(path.join(app, '.atris', 'state', 'tasks.projection.json'), 'utf8')).tasks;
  const wording = (id) => redrawn.find((row) => row.id === id).metadata;
  assert.equal(wording('row-1').assigned_to, 'someone-else');
  assert.equal(wording('row-3').executed_by, 'claude');
  assert.equal(wording('row-4').assigned_to, undefined);
  assert.equal(wording('row-5').assigned_to, 'closer');

  // The next flight picks for what the jobs say now.
  const again = await liveFlight(app, [job(1, { metadata: { assigned_to: 'someone-else' } }), job(3, { metadata: { executed_by: 'claude' } })]);
  assert.deepEqual(again.asked.map(([task, engine]) => [task, engine]).sort(), [['F-1', 'claude'], ['F-3', 'claude']].sort(), 'F-3 now names claude, and it goes there');
  assert.equal(state('row-3').status, 'claimed');
  assert.equal(state('row-1').status, 'claimed');
});

test('with --pick turns the claim asks nothing of the job: the turns went on neither its member nor its engine, so a changed job is claimed as it always was', async (t) => {
  const { app, store } = room(t);
  const workspace = tasks.workspaceRoot(app);
  const rows = [job(1, { metadata: { assigned_to: 'closer' } }), job(2, { metadata: { executed_by: 'codex' } })];
  for (const row of rows) {
    store.db.prepare('INSERT INTO tasks (id, title, status, tag, workspace_root, created_at, updated_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(row.id, row.title, 'open', null, workspace, START, START, JSON.stringify(row.metadata));
  }
  const live = await liveFlight(app, rows, {
    flight: {
      pick: 'turns',
      spaceGuard: true,
      freeSpace: () => {
        store.db.prepare('UPDATE tasks SET metadata = ? WHERE id = ?').run(JSON.stringify({ assigned_to: 'someone-else' }), 'row-1');
        store.db.prepare('UPDATE tasks SET metadata = ? WHERE id = ?').run(JSON.stringify({ executed_by: 'claude' }), 'row-2');
        return 10 ** 13;
      },
    },
  });
  assert.deepEqual(live.asked, [['F-1', 'claude'], ['F-2', 'codex']], 'each job keeps the engine its turn gave it');
  assert.deepEqual(live.flight.paused, []);
  assert.ok(!live.logs.some((line) => /for the next flight/.test(line)), live.logs.join('\n'));
  assert.deepEqual(['row-1', 'row-2'].map((id) => store.db.prepare('SELECT status FROM tasks WHERE id = ?').get(id).status), ['claimed', 'claimed']);
});

test('a flight that refuses every claim for a changed choice still draws the task list again, so the next flight does not meet the old words', async (t) => {
  const { app, store } = room(t);
  const workspace = tasks.workspaceRoot(app);
  const row = job(1, { metadata: { assigned_to: 'closer' } });
  store.db.prepare('INSERT INTO tasks (id, title, status, tag, workspace_root, created_at, updated_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(row.id, row.title, 'open', null, workspace, START, START, JSON.stringify(row.metadata));
  const live = await liveFlight(app, [row], {
    flight: {
      spaceGuard: true,
      freeSpace: () => {
        store.db.prepare('UPDATE tasks SET metadata = ? WHERE id = ?').run(JSON.stringify({ executed_by: 'codex' }), row.id);
        return 10 ** 13;
      },
    },
  });
  assert.deepEqual(live.asked, [], 'the only job was not started');
  assert.equal(live.flight.paused.length, 1);
  assert.equal(live.flight.paused[0].stage, 'choice_changed');
  assert.deepEqual({ ...store.db.prepare('SELECT status, claimed_by FROM tasks WHERE id = ?').get(row.id) }, { status: 'open', claimed_by: null });
  // The list file was hand-written for this test with the old words. Nothing was claimed, and still it is drawn again.
  const listed = JSON.parse(fs.readFileSync(path.join(app, '.atris', 'state', 'tasks.projection.json'), 'utf8')).tasks.find((one) => one.id === row.id);
  assert.equal(listed.metadata.executed_by, 'codex');
  assert.equal(listed.metadata.assigned_to, undefined);
});

test('a job nobody changed is claimed as before, whatever it names, and a change that leaves the words alone changes nothing', async (t) => {
  const { app, store } = room(t);
  const workspace = tasks.workspaceRoot(app);
  const real = (n, metadata = {}) => {
    const row = job(n, { metadata });
    store.db.prepare('INSERT INTO tasks (id, title, status, tag, workspace_root, created_at, updated_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(row.id, row.title, 'open', null, workspace, START, START, JSON.stringify(metadata));
    return row;
  };
  const rows = [real(1, { assigned_to: 'ghost' }), real(2, { executed_by: 'Codex ' }), real(3, { notes: 'x' })];
  const live = await liveFlight(app, rows, {
    flight: {
      spaceGuard: true,
      freeSpace: () => {
        // The words, spelled another way, are the same choice: nothing here moves a job.
        store.db.prepare('UPDATE tasks SET metadata = ? WHERE id = ?').run(JSON.stringify({ assigned_to: ' ghost ' }), 'row-1');
        store.db.prepare('UPDATE tasks SET metadata = ? WHERE id = ?').run(JSON.stringify({ engine: 'codex' }), 'row-2');
        store.db.prepare('UPDATE tasks SET metadata = ? WHERE id = ?').run(JSON.stringify({ notes: 'y', priority: 'high' }), 'row-3');
        return 10 ** 13;
      },
    },
  });
  assert.deepEqual(live.asked.map(([task]) => task).sort(), ['F-1', 'F-2', 'F-3']);
  assert.ok(!live.logs.some((line) => /for the next flight/.test(line)), live.logs.join('\n'));
  assert.deepEqual(live.flight.paused, []);
});

test('a job assigned to a member goes to that member\'s own engine, and an assigned member the roster does not decide keeps its turn', async (t) => {
  const { ws, app, store } = room(t);
  const bin = fakeEngines(ws, ['claude', 'codex']);
  addMember(app, 'closer', 'codex');
  fs.mkdirSync(path.join(app, 'atris', 'team', 'ghost'), { recursive: true });
  fs.writeFileSync(path.join(app, 'atris', 'team', 'ghost', 'MEMBER.md'), '---\nname: ghost\nrole: ghost\ndescription: test member\n---\n\n# ghost\n');
  await withEnv(isolatedHome(ws, bin), async () => {
    const rows = [
      job(1, { metadata: { assigned_to: 'closer' } }),
      job(2, { metadata: { assigned_to: 'ghost' } }),
      job(3),
      job(4),
    ];
    const turns = await dryFlight(app, rows, { pick: 'turns' });
    assert.deepEqual(turns.flight.staffed.map((row) => row.engine), ['claude', 'codex', 'claude', 'codex']);

    for (const strong of [false, true]) {
      if (strong) store.plays(12, { member: 'fleet-claude', outcome: 'landed', at: FIRST });
      const { flight } = await dryFlight(app, rows);
      assert.equal(flight.staffed[0].engine, 'codex', 'closer\'s own engine, not the turn\'s claude');
      assert.equal(flight.staffed[1].engine, 'codex', 'ghost has no engine the roster decided, so its job keeps its turn');
      assert.ok(!('pick' in flight.staffed[0]) && !('pick' in flight.staffed[1]), 'neither is the picker\'s');
    }
  });
});

test('--engine beats everything, even an engine that is out of credit, and the picker is not asked', async (t) => {
  const { ws, app, store } = room(t);
  const bin = fakeEngines(ws, ['claude', 'codex']);
  await withEnv(isolated(ws, bin), async () => {
    codexIsStrong(store);
    registry.setEngineHealth('claude', 'credit_out', app);
    const rows = [job(1, { metadata: { executed_by: 'codex' } }), job(2), job(3)];
    const { flight, logs } = await dryFlight(app, rows, { engine: 'claude', engines: null });
    assert.deepEqual(flight.staffed.map((row) => row.engine), ['claude', 'claude', 'claude'], 'the person said claude, for every job');
    assert.ok(flight.staffed.every((row) => !('pick' in row)));
    assert.ok(!logs.some((line) => /picked|steering|not ready/.test(line)), logs.join('\n'));
  });
});
