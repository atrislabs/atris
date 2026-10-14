'use strict';

// Waking some members while jobs wait for a kind of work none of them do
// says so, once per kind, and names the step that gets the job started:
// wake a member who does that work, or add one when the team has nobody.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');
const { createMemberUp } = require('../lib/member-up');

const cliPath = path.resolve(__dirname, '..', 'bin', 'atris.js');
const JOBS = { executor: 'build', navigator: 'search', validator: 'review' };

function fakeTeam({ members, waiting, only }) {
  const lines = [];
  let now = Date.parse('2026-10-14T09:00:00Z');
  const up = createMemberUp({
    listMembers: () => members,
    pickTask: () => null,
    spawn: () => {},
    now: () => now,
    print: (line) => lines.push(line),
    jobOf: (name) => JOBS[name] || 'build',
    waitingTasks: () => waiting,
  }, { only });
  return { up, lines, tick: (ms) => { now += ms; } };
}

test('review jobs waiting while only builders are awake names the reviewer to wake, once', () => {
  const members = [{ name: 'executor' }, { name: 'navigator' }, { name: 'validator' }];
  const waiting = [
    { id: 'T-1', title: 'review the readme', job: 'review' },
    { id: 'T-2', title: 'review the docs', job: 'review' },
  ];
  const { up, lines, tick } = fakeTeam({ members, waiting, only: ['executor', 'navigator'] });
  up.check();
  tick(60 * 1000);
  up.check();
  const hint = '2 review jobs are waiting, but nobody who does review is awake. wake one: atris member wake validator --keep';
  assert.equal(lines.filter((line) => line === hint).length, 1, lines.join('\n'));
});

test('a team with nobody for the waiting kind hears how to add one', () => {
  const { up, lines } = fakeTeam({
    members: [{ name: 'executor' }],
    waiting: [{ id: 'T-1', title: 'find prior art', job: 'search' }],
  });
  up.check();
  assert.ok(lines.includes('1 search job is waiting, but no member on the team does search. add one: atris member create researcher'), lines.join('\n'));
});

test('no hint when an awake member does the waiting kind, or a sleeper is a human seat', () => {
  const covered = fakeTeam({
    members: [{ name: 'executor' }],
    waiting: [{ id: 'T-1', title: 'fix the typo', job: 'build' }],
  });
  covered.up.check();
  assert.ok(!covered.lines.some((line) => /jobs? (is|are) waiting/.test(line)), covered.lines.join('\n'));

  const human = fakeTeam({
    members: [{ name: 'executor' }, { name: 'validator', human: true }],
    waiting: [{ id: 'T-1', title: 'review the readme', job: 'review' }],
  });
  human.up.check();
  assert.ok(human.lines.some((line) => line.includes('no member on the team does review')), human.lines.join('\n'));
});

test('real wake: the hint shows, and following it starts the waiting review job', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-wake-other-kind-'));
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
  const added = atris(['task', 'new', 'review the readme wording so new users find setup', '--verify', 'npm test']);
  assert.equal(added.status, 0, added.stderr || added.stdout);

  const builders = atris(['member', 'wake', 'executor', 'navigator', '--dry-run']);
  assert.equal(builders.status, 0, builders.stderr);
  assert.match(builders.stdout, /1 review job is waiting, but nobody who does review is awake\. wake one: atris member wake (\S+) --keep/);
  const reviewer = builders.stdout.match(/atris member wake (\S+) --keep/)[1];

  const followed = atris(['member', 'wake', reviewer, '--keep', '--dry-run']);
  assert.equal(followed.status, 0, followed.stderr);
  assert.match(followed.stdout, new RegExp(`would start ${reviewer} on: review the readme wording`));
  assert.doesNotMatch(followed.stdout, /jobs? (is|are) waiting/);
});
