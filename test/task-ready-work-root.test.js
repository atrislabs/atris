'use strict';

// `atris task ready --work-root <copy>` lets a builder name the copy it built in,
// so the job records that copy's commit instead of the main folder's commit.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');

const cliPath = path.resolve(__dirname, '../bin/atris.js');
const RESULT = 'Anyone can now see the saved result is correct because the file was fixed.';
const PROOF = 'Verifier passed: the saved file was read back after the change and matches the expected text.';

function makeProject() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-ready-work-root-')));
  const root = path.join(dir, 'repo');
  const copy = path.join(dir, 'copy');
  fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
  const env = {
    ...scrubAgentEnv(),
    ATRIS_TASKS_DB: path.join(dir, 'tasks.db'),
    ATRIS_SKIP_UPDATE_CHECK: '1',
    ATRIS_NO_INTERACTIVE: '1',
    ATRIS_NONINTERACTIVE: '1',
  };
  delete env.ATRIS_WORK_ROOT;
  function git(args, cwd = root) {
    const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  function atris(args, extraEnv = {}) {
    const result = spawnSync(process.execPath, [cliPath, ...args], { cwd: root, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 20000 });
    assert.ifError(result.error);
    return result;
  }
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'work root test']);
  git(['config', 'user.email', 'workroot@example.test']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['config', 'core.hooksPath', '/dev/null']);
  fs.writeFileSync(path.join(root, '.gitignore'), 'atris/\n.atris/\n');
  fs.writeFileSync(path.join(root, 'result.txt'), 'before');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'base']);
  git(['worktree', 'add', '-q', '-b', 'worker', copy]);
  fs.writeFileSync(path.join(copy, 'result.txt'), 'after');
  git(['add', '.'], copy);
  git(['commit', '-q', '-m', 'built in the copy'], copy);
  const added = atris(['task', 'add', 'Fix result.txt. Done: the saved result is correct. Check: read result.txt back.', '--tag', 'cli']);
  assert.equal(added.status, 0, added.stderr);
  const listed = atris(['task', 'list', '--json']);
  assert.equal(listed.status, 0, listed.stderr);
  const id = JSON.parse(listed.stdout).tasks[0].id;
  const claimed = atris(['task', 'claim', id, '--as', 'builder']);
  assert.equal(claimed.status, 0, claimed.stderr);
  const show = () => {
    const shown = atris(['task', 'show', id, '--json']);
    assert.equal(shown.status, 0, shown.stderr);
    return JSON.parse(shown.stdout);
  };
  const ready = (extra = [], extraEnv = {}) => atris(['task', 'ready', id, '--as', 'builder', '--result', RESULT, '--proof', PROOF, ...extra], extraEnv);
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  return { dir, root, copy, git, show, ready, cleanup };
}

test('--work-root records the commit of the copy the builder built in', () => {
  const p = makeProject();
  try {
    const mainHead = p.git(['rev-parse', 'HEAD']);
    const copyHead = p.git(['rev-parse', 'HEAD'], p.copy);
    assert.notEqual(copyHead, mainHead);
    const ready = p.ready(['--work-root', p.copy]);
    assert.equal(ready.status, 0, ready.stderr + ready.stdout);
    const task = p.show();
    assert.equal(task.status, 'review');
    assert.equal(task.metadata.work_commit, copyHead);
    assert.notEqual(task.metadata.work_commit, mainHead);
  } finally {
    p.cleanup();
  }
});

test('ATRIS_WORK_ROOT names the copy when the flag is absent', () => {
  const p = makeProject();
  try {
    const copyHead = p.git(['rev-parse', 'HEAD'], p.copy);
    const ready = p.ready([], { ATRIS_WORK_ROOT: p.copy });
    assert.equal(ready.status, 0, ready.stderr + ready.stdout);
    assert.equal(p.show().metadata.work_commit, copyHead);
  } finally {
    p.cleanup();
  }
});

test('without --work-root the job records the main folder commit, as before', () => {
  const p = makeProject();
  try {
    const mainHead = p.git(['rev-parse', 'HEAD']);
    const copyHead = p.git(['rev-parse', 'HEAD'], p.copy);
    assert.notEqual(copyHead, mainHead);
    const ready = p.ready();
    assert.equal(ready.status, 0, ready.stderr + ready.stdout);
    const task = p.show();
    assert.equal(task.status, 'review');
    assert.equal(task.metadata.work_commit, mainHead);
  } finally {
    p.cleanup();
  }
});

test('--work-root pointing at a missing folder stops with a plain line and leaves the job alone', () => {
  const p = makeProject();
  try {
    const missing = path.join(p.dir, 'no-such-copy');
    const before = p.show();
    const ready = p.ready(['--work-root', missing]);
    assert.equal(ready.status, 1, ready.stderr + ready.stdout);
    assert.match(ready.stderr, new RegExp(`^work root not found: ${missing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
    const after = p.show();
    assert.equal(after.status, 'claimed');
    assert.equal(after.claimed_by, 'builder');
    assert.equal(after.updated_at, before.updated_at);
    assert.equal(after.metadata.work_commit, undefined);
  } finally {
    p.cleanup();
  }
});
