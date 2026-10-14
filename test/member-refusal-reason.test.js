'use strict';

// When a member's work on a task is sent back, the next tick prompt for that
// task names the reason up top, even when other tasks were sent back later
// and even when the tick runs from a worktree of the main checkout.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildTickPrompt } = require('../commands/mission');

const frozen = { lane: 'workspace', verifier: 'node check.js' };

function workspace(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-refusal-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeProjection(dir, tasks) {
  const file = path.join(dir, '.atris', 'state', 'tasks.projection.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ tasks }));
}

function boundMission(extra = {}) {
  return {
    id: 'm-refusal',
    objective: 'Ship the pricing page',
    owner: 'builder',
    cadence: 'manual',
    status: 'running',
    xp_task: { task_id: 'task-own', ref: 'CLI-7', title: 'Ship the pricing page' },
    ...extra,
  };
}

const ownTask = {
  id: 'task-own',
  display_id: 'CLI-7',
  title: 'Ship the pricing page',
  updated_at: 100,
  metadata: { approval_status: 'revise', human_revision_note: 'the price table still shows last year numbers' },
  events: [],
};

const otherTasks = [1, 2, 3].map((n) => ({
  id: `task-other-${n}`,
  title: `Other work ${n}`,
  updated_at: 200 + n,
  metadata: {},
  events: [{ event_type: 'revision_requested', payload: { note: `other reason ${n}` } }],
}));

test('the next try on a turned-down task sees the reason near the top', (t) => {
  const dir = workspace(t);
  writeProjection(dir, [ownTask, ...otherTasks]);
  const prompt = buildTickPrompt(boundMission(), 2, 3, frozen, [], dir);
  assert.match(prompt, /## why the last try was turned down/);
  assert.match(prompt, /the price table still shows last year numbers/);
  assert.ok(prompt.indexOf('turned down') < prompt.indexOf('## Your task'));
});

test('the reason falls back to the latest send-back event when no note is stored on the task', (t) => {
  const dir = workspace(t);
  writeProjection(dir, [{
    ...ownTask,
    metadata: {},
    events: [
      { event_type: 'revision_requested', payload: { note: 'first reason' } },
      { event_type: 'revision_requested', payload: { note: 'second reason, the newest' } },
    ],
  }]);
  const prompt = buildTickPrompt(boundMission(), 2, 3, frozen, [], dir);
  assert.match(prompt, /second reason, the newest/);
  assert.doesNotMatch(prompt.split('## why the last try was turned down')[1].split('\n\n')[0], /first reason/);
});

test('no section when the task was never turned down or the work was since accepted', (t) => {
  const dir = workspace(t);
  writeProjection(dir, [{ ...ownTask, metadata: {} }]);
  assert.doesNotMatch(buildTickPrompt(boundMission(), 1, 1, frozen, [], dir), /why the last try was turned down/);
  writeProjection(dir, [{ ...ownTask, metadata: { ...ownTask.metadata, approval_status: 'accepted' } }]);
  assert.doesNotMatch(buildTickPrompt(boundMission(), 1, 1, frozen, [], dir), /why the last try was turned down/);
  assert.doesNotMatch(buildTickPrompt(boundMission({ xp_task: null }), 1, 1, frozen, [], dir), /why the last try was turned down/);
});

test('a tick running in a worktree reads the reason from the main checkout', (t) => {
  const main = workspace(t);
  const git = (args, cwd) => {
    const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
  };
  git(['init', '-q'], main);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], main);
  const wt = path.join(main, '..', `${path.basename(main)}-wt`);
  t.after(() => fs.rmSync(wt, { recursive: true, force: true }));
  git(['worktree', 'add', '-q', '--detach', wt], main);
  writeProjection(main, [ownTask]);
  const prompt = buildTickPrompt(boundMission({ worktree: { path: wt } }), 2, 3, frozen, [], wt);
  assert.match(prompt, /the price table still shows last year numbers/);
});
