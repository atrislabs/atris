'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createMemberUp, runMemberUp, memberUpResult, IDLE_CHECK_MS, IDLE_EXIT, SUMMARY_MS, CHECK_MS } = require('../lib/member-up');

// A fake team: members, a task list per member, a clock and a spawner that
// records starts and lets the test end a run with an exit code. Tasks written
// without metadata get a runnable check, so only tests about checks set one.
const withCheck = (task) => (task && !task.metadata
  ? { ...task, metadata: { verify: 'node --test test/x.test.js' } } : task);

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
      return withCheck((tasks[name] || []).find((t) => !taken.has(t.id))) || null;
    },
    spawn: (name, onExit, onClaim) => {
      spawned.push(name);
      exits.set(name, onExit);
      onClaim(tasks[name][0]);
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
    exit(name, code, result) { exits.get(name)(code, result); },
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
  assert.ok(team.lines.includes('a done ok: no change summary reported'));
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

test('no task with a check means no start: idle at once, then checked every 5 minutes after 3 empty checks', () => {
  const team = fakeTeam([{ name: 'scout' }]);
  const up = createMemberUp(team.deps, {});
  up.check();
  assert.deepEqual(up.idle(), ['scout']);
  assert.deepEqual(team.spawned, []);
  team.advance(CHECK_MS);
  up.check();
  team.advance(CHECK_MS);
  up.check();
  assert.equal(team.lines.filter((l) => l === 'scout is idle, no task with a check').length, 1);
  const picksWhenIdle = team.picks.length;
  team.advance(CHECK_MS);
  up.check();
  assert.equal(team.picks.length, picksWhenIdle, 'an idle member is not checked a minute later');
  team.advance(IDLE_CHECK_MS);
  up.check();
  assert.equal(team.picks.length, picksWhenIdle + 1);
  assert.equal(team.lines.filter((l) => l === 'scout is idle, no task with a check').length, 1, 'idle prints once');
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
  assert.ok(team.lines.includes('mine failed: exit 1'));
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
  assert.ok(team.lines.includes('working 0, idle 1, done today 1'));
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
  assert.ok(team.lines.includes('a is idle, no task with a check'));
});

test('a task with no check or a prose check never starts a member', () => {
  const team = fakeTeam([{ name: 'a' }, { name: 'b' }], {
    a: [{ id: 't1', title: 'Polish the docs', metadata: { verify: 'looks good to a reader' } }],
    b: [{ id: 't2', title: 'Tidy the readme', metadata: {} }],
  });
  const up = createMemberUp(team.deps, {});
  assert.deepEqual(up.check(), []);
  assert.deepEqual(team.spawned, []);
  assert.deepEqual(team.lines, ['a is idle, no task with a check', 'b is idle, no task with a check']);
});

test('a run that finds no task with a check to claim ends idle, not done', () => {
  const team = fakeTeam([{ name: 'a' }], { a: [{ id: 't1', title: 'x' }] });
  const up = createMemberUp(team.deps, {});
  up.check();
  team.exit('a', IDLE_EXIT);
  assert.deepEqual(up.idle(), ['a']);
  assert.ok(team.lines.includes('a is idle, no task with a check'));
  assert.equal(up.summary(), 'working 0, idle 1, done today 0');
});


test('two live member logs stream in time order, wait for full lines, and finish once with results', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-up-progress-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'a.log'), '2026-10-14T11:59:00.000Z old editing stale.js\n');
  const team = fakeTeam([{ name: 'a' }, { name: 'b' }], {
    a: [{ id: 't1', title: 'one' }], b: [{ id: 't2', title: 'two' }],
  });
  const loop = runMemberUp(team.deps, { progressDir: dir, max: 2 });
  t.after(() => loop.stop());
  const hhmm = (iso) => {
    const d = new Date(iso);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  // b comes first in time even though the directory is read a before b.
  fs.appendFileSync(path.join(dir, 'a.log'), '2026-10-14T12:02:00.000Z m-a editing lib/a.js\n');
  fs.writeFileSync(path.join(dir, 'b.log'), '2026-10-14T12:01:00.000Z m-b reading lib/b.js\n');
  fs.writeFileSync(path.join(dir, 'outsider.log'), '2026-10-14T12:01:00.000Z m-x editing private.js\n');
  loop.scanProgress();
  assert.deepEqual(team.lines.slice(2), [
    `  b ${hhmm('2026-10-14T12:01:00Z')}  reading lib/b.js`,
    `  a ${hhmm('2026-10-14T12:02:00Z')}  editing lib/a.js`,
  ]);
  fs.appendFileSync(path.join(dir, 'b.log'), '2026-10-14T12:03:00.000Z m-b editing lib/b');
  loop.scanProgress();
  assert.equal(team.lines.length, 4);
  fs.appendFileSync(path.join(dir, 'b.log'), '.js\n2026-10-14T12:04:00.000Z m-b finished: failed: check timed out\n');
  // Exit drains pending lines, without waiting for the watcher or poll.
  team.exit('b', 0);
  assert.deepEqual(team.lines.slice(-2), [
    `  b ${hhmm('2026-10-14T12:03:00Z')}  editing lib/b.js`,
    'b failed: check timed out',
  ]);
  fs.appendFileSync(path.join(dir, 'a.log'), '2026-10-14T12:05:00.000Z m-a finished: ok\n');
  team.exit('a', 0, { ok: true, summary: 'fixed retry handling' });
  team.exit('a', 0);
  assert.equal(team.lines.filter((line) => line === 'a done ok: fixed retry handling').length, 1);
  loop.stop();
  await loop.done;
  const count = team.lines.length;
  fs.appendFileSync(path.join(dir, 'a.log'), '2026-10-14T12:06:00.000Z m-a editing after-stop.js\n');
  loop.scanProgress();
  assert.equal(team.lines.length, count);
});

test('live watcher prints steps while a child is still working', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-up-watch-'));
  const team = fakeTeam([{ name: 'a' }], { a: [{ id: 't1', title: 'one' }] });
  const loop = runMemberUp(team.deps, { progressDir: dir, progressPollMs: 10 });
  t.after(() => { loop.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(dir, 'a.log'), '2026-10-14T12:01:00.000Z m-a editing live.js\n');
  const deadline = Date.now() + 2000;
  while (!team.lines.some((line) => line.endsWith('editing live.js')) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(team.lines.some((line) => line.endsWith('editing live.js')));
  assert.deepEqual(loop.up.running(), ['a']);
  loop.stop();
  await loop.done;
});

test('checked child result supplies the change summary or the actual failure reason', () => {
  assert.deepEqual(memberUpResult('noise\n' + JSON.stringify({ task: { outcome: 'review' }, work_step: { summary: 'fixed retries' } })),
    { ok: true, summary: 'fixed retries' });
  const failed = memberUpResult(JSON.stringify({ task: { outcome: 'released', reason: 'the check did not pass' } }));
  assert.deepEqual(failed, { ok: false, reason: 'the check did not pass' });
  const team = fakeTeam([{ name: 'a' }], { a: [{ id: 't1', title: 'one' }] });
  const up = createMemberUp(team.deps);
  up.check();
  team.exit('a', 0, failed);
  assert.ok(team.lines.includes('a failed: the check did not pass'));
  assert.equal(up.summary(), 'working 0, idle 0, done today 0');
  assert.deepEqual(memberUpResult(''), { ok: false, reason: 'run ended without a checked task result' });
  assert.deepEqual(memberUpResult('', '', 'SIGTERM'), { ok: false, reason: 'stopped by sigterm' });
});
