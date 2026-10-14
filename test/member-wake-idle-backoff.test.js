'use strict';

// An idle member is checked less often the longer it stays idle: one-minute
// checks at first, then waits of 5, 10, 20 and at most 30 minutes. Finding
// work resets it to quick checks.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createMemberUp, idleWaitMs, CHECK_MS, IDLE_CHECK_MS, IDLE_MAX_CHECK_MS,
} = require('../lib/member-up');

const MIN = 60 * 1000;

function fakeTeam(tasks = []) {
  let clock = Date.UTC(2026, 9, 14, 12, 0, 0);
  const checks = [];
  const exits = [];
  const deps = {
    listMembers: () => [{ name: 'scout' }],
    pickTask: (name, taken) => {
      checks.push(clock);
      const task = tasks.find((t) => !taken.has(t.id));
      return task ? { ...task, metadata: { verify: 'node --test test/x.test.js' } } : null;
    },
    spawn: (name, onExit) => { exits.push(onExit); },
    now: () => clock,
    print: () => {},
  };
  return {
    deps,
    tasks,
    checks,
    exits,
    advance(ms) { clock += ms; },
    // Minutes since the start at which the member was checked.
    minutes() { return checks.map((at) => (at - checks[0]) / MIN); },
  };
}

// Run the supervisor the way `member up` does: one check per minute.
function runMinutes(up, team, minutes) {
  for (let i = 0; i < minutes; i += 1) {
    up.check();
    team.advance(CHECK_MS);
  }
}

test('the wait grows 5, 10, 20 minutes and stops at 30', () => {
  assert.equal(idleWaitMs(0), 0);
  assert.equal(idleWaitMs(2), 0);
  assert.equal(idleWaitMs(3), IDLE_CHECK_MS);
  assert.equal(idleWaitMs(4), 10 * MIN);
  assert.equal(idleWaitMs(5), 20 * MIN);
  assert.equal(idleWaitMs(6), IDLE_MAX_CHECK_MS);
  assert.equal(idleWaitMs(500), IDLE_MAX_CHECK_MS, 'a member idle all week still gets checked every 30 minutes');
  assert.equal(IDLE_MAX_CHECK_MS, 30 * MIN);
});

test('an idle member is checked less often the longer it stays idle', () => {
  const team = fakeTeam();
  const up = createMemberUp(team.deps, {});
  runMinutes(up, team, 180);
  // three quick checks, then gaps of 5, 10, 20, 30, 30, ...
  assert.deepEqual(team.minutes(), [0, 1, 2, 7, 17, 37, 67, 97, 127, 157]);
  // a flat 5-minute wait checks 38 times in the same 3 hours
  assert.equal(team.checks.length, 10);
});

test('finding work resets the wait to quick checks', () => {
  const team = fakeTeam();
  const up = createMemberUp(team.deps, {});
  runMinutes(up, team, 70); // idle long enough to reach the 30 minute wait
  team.tasks.push({ id: 't1', title: 'Fix the login page' });
  runMinutes(up, team, 30);
  assert.equal(team.exits.length, 1, 'the new task is picked up at the next due check');
  team.tasks.length = 0;
  team.exits[0](0, { ok: true, summary: 'fixed' });
  const before = team.checks.length;
  runMinutes(up, team, 3);
  assert.equal(team.checks.length - before, 3, 'after finishing work it checks every minute again');
});
