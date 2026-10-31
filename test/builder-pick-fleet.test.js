'use strict';

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
const os = require('node:os');
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
const HOUR = 3600000;
const START = Date.parse('2026-11-01T00:00:00Z');
const FIRST = START + 2 * HOUR;

// Every test here counts from the same day, whatever today is, and starts with the picker on.
process.env.ATRIS_PICK_SINCE = '2026-11-01';
delete process.env.ATRIS_PICK;

async function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  const apply = (values) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  };
  apply(vars);
  try {
    return await fn();
  } finally {
    apply(saved);
  }
}

// ---------------------------------------------------------------------------
// Fixtures.

// A folder to fly from, and a task store of its own that holds the made-up history.
function room(t, storeOptions) {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'builder-pick-fleet-')));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  const app = path.join(ws, 'app');
  // An atris folder lets the engine registry save what it learns about each engine.
  fs.mkdirSync(path.join(app, 'atris'), { recursive: true });
  return { ws, app, store: historyStore(t, app, storeOptions) };
}

const jobTitle = (n) => `Fix form ${n} so it keeps what was typed. Done: it keeps input. Check: node --test test/form${n}.test.js. Edits lib/form${n}.js`;
const job = (n, extra = {}) => ({ id: `row-${n}`, display_id: `F-${n}`, status: 'open', title: jobTitle(n), ...extra });
const jobs = (n) => Array.from({ length: n }, (_, i) => job(i + 1));

// The task list file the flights read. Each job is in this folder's workspace, the way the task command shows it.
function listJobs(app, rows) {
  const file = path.join(app, '.atris', 'state', 'tasks.projection.json');
  const workspace = tasks.workspaceRoot(app);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ tasks: rows.map((row) => ({ workspace_root: workspace, ...row })) })}\n`);
}

// The line the fleet has always printed under its header for one staffed job.
const jobLine = (engine, row) => `    ${engine.padEnd(8)} → ${row.display_id}  ${row.title.slice(0, 80)}`;

// Codex has landed everything it was given since steering began; claude has dropped everything.
function codexIsStrong(store, n = 12) {
  store.plays(n, { member: 'fleet-codex', outcome: 'landed', at: FIRST });
  store.plays(n, { member: 'fleet-claude', outcome: 'dropped', at: FIRST });
}

async function dryFlight(app, rows, options = {}) {
  listJobs(app, rows);
  const logs = [];
  const flight = await fleet.runFleetFlight({
    root: app, slots: 6, engines: ['claude', 'codex'], dryRun: true, log: (line = '') => logs.push(String(line)), ...options,
  });
  return { flight, logs };
}

// A live flight with stand-ins for the task commands, the engines and the landing.
async function liveFlight(app, rows, options = {}) {
  listJobs(app, rows);
  const logs = [];
  const asked = [];
  const calls = [];
  const flight = await fleet.runFleetFlight({
    root: app,
    slots: 6,
    engines: ['claude', 'codex'],
    log: (line = '') => logs.push(String(line)),
    ownCli: (args) => {
      calls.push(args);
      if (args[0] === 'worktree' && args[1] === 'start') return { status: 0, stdout: `next: cd ${app}/wt-${args[args.indexOf('--task') + 1]}\n`, stderr: '' };
      return { status: 0, stdout: 'ok', stderr: '' };
    },
    dispatcher: (entry) => {
      asked.push([entry.task.display_id, entry.engine]);
      return Promise.resolve(options.answer ? options.answer(entry) : { exitCode: 0, report: 'built it' });
    },
    lander: () => ({ ok: true, stage: 'shipped' }),
    guardCliLink: () => ({ ok: true, changed: false }),
    scoutAsk: false,
    ...options.flight,
  });
  return { flight, logs, asked, calls };
}

// Fake engine programs on PATH, so the real roster sees these engines as installed.
function fakeEngines(dir, names) {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  for (const name of names) fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return bin;
}
const tidyPath = (bin) => `${bin}${path.delimiter}/usr/bin${path.delimiter}/bin`;
const isolated = (ws, bin) => ({ PATH: tidyPath(bin), ATRIS_MACHINE_ROSTER_PATH: path.join(ws, 'machine-roster.json'), ATRIS_ROUTER_EXPLAIN: '0' });
// ...and the owner's own roster file, home folder and Claude settings are not read either.
const isolatedHome = (ws, bin) => ({
  ...isolated(ws, bin),
  HOME: path.join(ws, 'home'),
  ATRIS_MACHINE_ROSTER_MD_PATH: path.join(ws, 'machine-ROSTER.md'),
  ATRIS_ROSTER_SESSION: undefined,
  ATRIS_RUNNER_MODEL: undefined,
  ATRIS_CLAUDE_MODEL: undefined,
  ATRIS_CLAUDE_SPEND_OK: undefined,
  ATRIS_CLAUDE_KEY_OK: undefined,
  ATRIS_RUNNER_PROFILE: undefined,
  ATRIS_RUNNER_BIN: undefined,
  ATRIS_CLAUDE_BIN: undefined,
  ATRIS_RUNNER_COMMAND_TEMPLATE: undefined,
  ATRIS_CLAUDE_COMMAND_TEMPLATE: undefined,
  ANTHROPIC_API_KEY: undefined,
  ANTHROPIC_AUTH_TOKEN: undefined,
  ANTHROPIC_MODEL: undefined,
  ANTHROPIC_DEFAULT_OPUS_MODEL: undefined,
  ANTHROPIC_DEFAULT_SONNET_MODEL: undefined,
  ANTHROPIC_DEFAULT_HAIKU_MODEL: undefined,
});

// A team member whose engine the project's roster decides.
function addMember(app, member, engine) {
  const dir = path.join(app, 'atris', 'team', member);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'MEMBER.md'), `---\nname: ${member}\nrole: ${member}\ndescription: test member\n---\n\n# ${member}\n`);
  fs.writeFileSync(path.join(app, 'atris', 'ROSTER.md'), `# roster\n\n## team\n${member}: ${engine}\n`);
}

const DEAD = { exitCode: 1, report: '', stderr: 'Usage limit reached. Purchase more credits.' };

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
  const answer = (entry) => (entry.engine === 'claude' ? DEAD : { exitCode: 0, report: 'built it' });
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
