'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createMemberUp, runMemberUp, IDLE_CHECK_MS, SUMMARY_MS, CHECK_MS } = require('../lib/member-up');

// A fake team: members, a task list per member, a clock and a spawner that
// records starts and lets the test end a run with an exit code.
function fakeTeam(members, tasks = {}) {
  let clock = Date.UTC(2026, 9, 14, 12, 0, 0);
  const lines = [];
  const spawned = [];
  const exits = new Map();
  const picks = [];
  const deps = {
    listMembers: () => members,
    pickTask: (name, taken) => {
      picks.push(name);
      return (tasks[name] || []).find((t) => !taken.has(t.id)) || null;
    },
    spawn: (name, onExit) => {
      spawned.push(name);
      exits.set(name, onExit);
    },
    now: () => clock,
    print: (line) => lines.push(line),
  };
  return {
    deps,
    lines,
    spawned,
    picks,
    tasks,
    advance(ms) { clock += ms; },
    exit(name, code) { exits.get(name)(code); },
  };
}

test('never starts more than --max members at once', () => {
  const members = ['a', 'b', 'c', 'd'].map((name) => ({ name }));
  const tasks = Object.fromEntries(members.map((m, i) => [m.name, [{ id: `t${i}`, title: `task ${m.name}` }]]));
  const team = fakeTeam(members, tasks);
  const up = createMemberUp(team.deps, { max: 2 });
  up.check();
  assert.deepEqual(team.spawned, ['a', 'b']);
  team.advance(CHECK_MS);
  up.check();
  assert.deepEqual(team.spawned, ['a', 'b'], 'full slots start nobody new');
  team.tasks.a = [];
  team.exit('a', 0);
  team.advance(CHECK_MS);
  up.check();
  assert.deepEqual(team.spawned, ['a', 'b', 'c']);
  assert.ok(team.lines.includes('a finished ok'));
});

test('members already working elsewhere count toward --max', () => {
  const team = fakeTeam(
    [{ name: 'busy', live: true }, { name: 'a' }, { name: 'b' }],
    { a: [{ id: 't1', title: 'one' }], b: [{ id: 't2', title: 'two' }] },
  );
  const up = createMemberUp(team.deps, { max: 1 });
  up.check();
  assert.deepEqual(team.spawned, [], 'one live member already fills a limit of one');
  const dry = fakeTeam(team.deps.listMembers(), team.tasks);
  assert.deepEqual(createMemberUp(dry.deps, { max: 2, dryRun: true }).check().map((s) => s.name), ['a']);
});

test('a member goes idle after 3 empty checks and is then checked every 5 minutes', () => {
  const team = fakeTeam([{ name: 'scout' }]);
  const up = createMemberUp(team.deps, {});
  up.check();
  team.advance(CHECK_MS);
  up.check();
  assert.deepEqual(up.idle(), []);
  team.advance(CHECK_MS);
  up.check();
  assert.deepEqual(up.idle(), ['scout']);
  assert.equal(team.lines.filter((l) => l === 'scout is idle, nothing to do').length, 1);
  const picksWhenIdle = team.picks.length;
  team.advance(CHECK_MS);
  up.check();
  assert.equal(team.picks.length, picksWhenIdle, 'an idle member is not checked a minute later');
  team.advance(IDLE_CHECK_MS);
  up.check();
  assert.equal(team.picks.length, picksWhenIdle + 1);
  assert.equal(team.lines.filter((l) => l === 'scout is idle, nothing to do').length, 1, 'idle prints once');
});

test('a new fitting task wakes an idle member', () => {
  const team = fakeTeam([{ name: 'scout' }]);
  const up = createMemberUp(team.deps, {});
  for (let i = 0; i < 3; i += 1) { up.check(); team.advance(CHECK_MS); }
  assert.deepEqual(up.idle(), ['scout']);
  team.tasks.scout = [{ id: 't1', title: 'Fix the login page' }];
  team.advance(IDLE_CHECK_MS);
  up.check();
  assert.ok(team.lines.includes('scout woke up for: Fix the login page'));
  assert.ok(team.lines.includes('scout started on: Fix the login page'));
  assert.deepEqual(team.spawned, ['scout']);
  assert.deepEqual(up.idle(), []);
});

test('never starts a member that is already running', () => {
  const team = fakeTeam(
    [{ name: 'busy', live: true }, { name: 'mine' }],
    { busy: [{ id: 't1', title: 'one' }], mine: [{ id: 't2', title: 'two' }, { id: 't3', title: 'three' }] },
  );
  const up = createMemberUp(team.deps, {});
  up.check();
  team.advance(CHECK_MS);
  up.check();
  assert.deepEqual(team.spawned, ['mine'], 'a live run elsewhere and our own child both block a second start');
  team.exit('mine', 1);
  assert.ok(team.lines.includes('mine failed (exit 1)'));
});

test('skips parked, human and sleeping members', () => {
  const work = [{ id: 't1', title: 'work' }];
  const team = fakeTeam(
    [{ name: 'p', parked: true }, { name: 'h', human: true }, { name: 's', sleeping: true }, { name: 'ok' }],
    { p: work, h: work, s: work, ok: [{ id: 't2', title: 'work' }] },
  );
  createMemberUp(team.deps, {}).check();
  assert.deepEqual(team.spawned, ['ok']);
  assert.deepEqual(team.picks, ['ok']);
});

test('two members never get the same task in one pass', () => {
  const shared = [{ id: 't1', title: 'only task' }];
  const team = fakeTeam([{ name: 'a' }, { name: 'b' }], { a: shared, b: shared });
  createMemberUp(team.deps, {}).check();
  assert.deepEqual(team.spawned, ['a']);
});

test('prints a summary every 10 minutes', () => {
  const team = fakeTeam([{ name: 'a' }], { a: [{ id: 't1', title: 'x' }] });
  const up = createMemberUp(team.deps, {});
  up.check();
  team.exit('a', 0);
  team.advance(SUMMARY_MS);
  team.tasks.a = [];
  up.check();
  assert.ok(team.lines.includes('working 0, idle 0, done today 1'));
});

test('dry run prints what it would start and starts nothing', () => {
  const members = ['a', 'b', 'c'].map((name) => ({ name }));
  const tasks = { a: [{ id: 't1', title: 'one' }], b: [{ id: 't2', title: 'two' }], c: [{ id: 't3', title: 'three' }] };
  const team = fakeTeam(members, tasks);
  const started = createMemberUp(team.deps, { dryRun: true, max: 2 }).check();
  assert.equal(started.length, 2);
  assert.deepEqual(team.spawned, []);
  assert.deepEqual(team.lines, ['would start a on: one', 'would start b on: two']);
});

test('the loop keeps checking until stopped', async () => {
  const team = fakeTeam([{ name: 'a' }]);
  let sleeps = 0;
  let loop;
  team.deps.sleep = async (ms) => {
    team.advance(ms);
    sleeps += 1;
    if (sleeps === 4) loop.stop();
  };
  loop = runMemberUp(team.deps, {});
  await loop.done;
  assert.equal(sleeps, 4);
  assert.ok(team.lines.includes('a is idle, nothing to do'));
});
