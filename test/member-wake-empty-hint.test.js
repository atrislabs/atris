'use strict';

// Waking the team when no member has a job says the one step that gives a
// member work, once, and following that step really does wake a member.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');
const { ADD_JOB_HINT, createMemberUp } = require('../lib/member-up');

const cliPath = path.resolve(__dirname, '..', 'bin', 'atris.js');

function fakeTeam(pickTask) {
  const lines = [];
  let now = Date.parse('2026-10-14T09:00:00Z');
  const up = createMemberUp({
    listMembers: () => [{ name: 'navigator' }, { name: 'executor' }],
    pickTask,
    spawn: () => {},
    now: () => now,
    print: (line) => lines.push(line),
  });
  return { up, lines, tick: (ms) => { now += ms; } };
}

test('a team with no jobs hears how to add one, once', () => {
  const { up, lines, tick } = fakeTeam(() => null);
  up.check();
  tick(60 * 1000);
  up.check();
  tick(60 * 1000);
  up.check();
  assert.equal(lines.filter((line) => line === ADD_JOB_HINT).length, 1, lines.join('\n'));
  assert.match(ADD_JOB_HINT, /atris task new ".+" --verify "npm test"/);
});

test('a team with a job to start gets no hint', () => {
  const job = { id: 'T-1', title: 'fix the readme typo', metadata: { verify: 'npm test' } };
  const { up, lines } = fakeTeam((name) => (name === 'executor' ? job : null));
  up.check();
  assert.ok(lines.includes('executor started on: fix the readme typo'), lines.join('\n'));
  assert.ok(!lines.includes(ADD_JOB_HINT), lines.join('\n'));
});

test('in a brand new project, wake says how to add a job, and doing it wakes a member', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-wake-empty-hint-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  fs.mkdirSync(root, { recursive: true });
  const env = {
    ...scrubAgentEnv(),
    ATRIS_SKIP_UPDATE_CHECK: '1',
    ATRIS_TASKS_DB: path.join(base, 'tasks.db'),
    NODE_NO_WARNINGS: '1',
  };
  const atris = (args) => spawnSync(process.execPath, [cliPath, ...args], {
    cwd: root, encoding: 'utf8', timeout: 60000, env,
  });
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: root }).status, 0);
  const init = atris(['init', '--yes']);
  assert.equal(init.status, 0, init.stderr || init.stdout);

  const empty = atris(['member', 'wake', '2', '--dry-run']);
  assert.equal(empty.status, 0, empty.stderr);
  assert.ok(empty.stdout.includes(ADD_JOB_HINT), empty.stdout);

  const added = atris(['task', 'new', 'fix the readme typo', '--verify', 'npm test']);
  assert.equal(added.status, 0, added.stderr || added.stdout);

  const ready = atris(['member', 'wake', '2', '--dry-run']);
  assert.equal(ready.status, 0, ready.stderr);
  assert.match(ready.stdout, /would start \S+ on: fix the readme typo/);
  assert.ok(!ready.stdout.includes(ADD_JOB_HINT), ready.stdout);
});
