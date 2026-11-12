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
const ESC = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
    const childEnv = { ...env, ...extraEnv };
    // A check run under this test would join the outer test runner and exit 0 without running.
    if (args.includes('--verify')) delete childEnv.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [cliPath, ...args], { cwd: root, env: childEnv, encoding: 'utf8', timeout: 20000 });
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
  // Two checks that read result.txt: the main folder says "before" and the copy says "after".
  const checkFor = (word) => `require('node:test')('result says ${word}', () => require('node:assert/strict').equal(require('node:fs').readFileSync('result.txt', 'utf8'), '${word}'));\n`;
  fs.writeFileSync(path.join(root, 'before.test.cjs'), checkFor('before'));
  fs.writeFileSync(path.join(root, 'after.test.cjs'), checkFor('after'));
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
  // Another copy of the project with a commit of its own.
  const addCopy = (name) => {
    const other = path.join(dir, name);
    git(['worktree', 'add', '-q', '-b', name, other]);
    fs.writeFileSync(path.join(other, 'result.txt'), `after ${name}`);
    git(['add', '.'], other);
    git(['commit', '-q', '-m', `built in ${name}`], other);
    return other;
  };
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  return { dir, root, copy, git, show, ready, addCopy, cleanup };
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
    assert.match(ready.stderr, new RegExp(`^work root not found: ${ESC(missing)}$`, 'm'));
    const after = p.show();
    assert.equal(after.status, 'claimed');
    assert.equal(after.claimed_by, 'builder');
    assert.equal(after.updated_at, before.updated_at);
    assert.equal(after.metadata.work_commit, undefined);
  } finally {
    p.cleanup();
  }
});

// A check that passes in the main folder and fails in the copy must not pass the copy's job.
test('--verify runs in the work root and a check that fails in the copy stops ready', () => {
  const p = makeProject();
  try {
    const before = p.show();
    // "result says before" holds in the main folder only. The copy says "after".
    const stopped = p.ready(['--work-root', p.copy, '--verify', 'node --test before.test.cjs']);
    assert.equal(stopped.status, 1, stopped.stderr + stopped.stdout);
    assert.match(stopped.stderr, /verifier failed/);
    const after = p.show();
    assert.equal(after.status, 'claimed');
    assert.equal(after.updated_at, before.updated_at);
    assert.equal(after.metadata.work_commit, undefined);
  } finally {
    p.cleanup();
  }
});

test('--verify that passes in the work root readies the job and records its commit with the receipt where a reviewer looks', () => {
  const p = makeProject();
  try {
    const copyHead = p.git(['rev-parse', 'HEAD'], p.copy);
    // "result says after" holds in the copy only. Passing proves the check ran there.
    const ready = p.ready(['--work-root', p.copy, '--verify', 'node --test after.test.cjs']);
    assert.equal(ready.status, 0, ready.stderr + ready.stdout);
    const task = p.show();
    assert.equal(task.status, 'review');
    assert.equal(task.metadata.work_commit, copyHead);
    const named = /Receipt: (atris\/runs\/\S+\.json)/.exec(ready.stdout) || /receipt (atris\/runs\/\S+\.json)/.exec(ready.stdout);
    assert.ok(named, ready.stdout);
    const receipt = JSON.parse(fs.readFileSync(path.join(p.root, named[1]), 'utf8'));
    assert.equal(receipt.result.passed, true);
    assert.equal(receipt.commit, copyHead);
    assert.equal(fs.existsSync(path.join(p.copy, 'atris', 'runs')), false);
  } finally {
    p.cleanup();
  }
});

test('the same check passes without --work-root, which is why the copy has to be named', () => {
  const p = makeProject();
  try {
    const mainHead = p.git(['rev-parse', 'HEAD']);
    const ready = p.ready(['--verify', 'node --test before.test.cjs']);
    assert.equal(ready.status, 0, ready.stderr + ready.stdout);
    assert.equal(p.show().metadata.work_commit, mainHead);
  } finally {
    p.cleanup();
  }
});

test('--work-root pointing at a folder with no git commit stops with a plain line and leaves the job alone', () => {
  const p = makeProject();
  try {
    const empty = path.join(p.dir, 'empty-folder');
    fs.mkdirSync(empty);
    const freshRepo = path.join(p.dir, 'fresh-repo');
    fs.mkdirSync(freshRepo);
    p.git(['init', '-q', '-b', 'main'], freshRepo);
    const before = p.show();
    for (const folder of [empty, freshRepo]) {
      const ready = p.ready(['--work-root', folder]);
      assert.equal(ready.status, 1, ready.stderr + ready.stdout);
      assert.match(ready.stderr, new RegExp(`^work root has no git commit: ${ESC(folder)}$`, 'm'));
    }
    const after = p.show();
    assert.equal(after.status, 'claimed');
    assert.equal(after.updated_at, before.updated_at);
    assert.equal(after.metadata.work_commit, undefined);
  } finally {
    p.cleanup();
  }
});

test('an empty --work-root is an error and never falls back to ATRIS_WORK_ROOT', () => {
  const p = makeProject();
  try {
    const before = p.show();
    for (const value of ['', '   ']) {
      const ready = p.ready(['--work-root', value], { ATRIS_WORK_ROOT: p.copy });
      assert.equal(ready.status, 1, ready.stderr + ready.stdout);
      assert.match(ready.stderr, /^work root is empty$/m);
    }
    // The flag with nothing after it at all is the same mistake.
    const bare = spawnSync(process.execPath, [cliPath, 'task', 'ready', before.id, '--as', 'builder', '--result', RESULT, '--proof', PROOF, '--work-root'], {
      cwd: p.root,
      env: { ...scrubAgentEnv(), ATRIS_TASKS_DB: path.join(p.dir, 'tasks.db'), ATRIS_WORK_ROOT: p.copy },
      encoding: 'utf8',
      timeout: 20000,
    });
    assert.equal(bare.status, 1, bare.stderr + bare.stdout);
    assert.match(bare.stderr, /^work root is empty$/m);
    const after = p.show();
    assert.equal(after.status, 'claimed');
    assert.equal(after.updated_at, before.updated_at);
    assert.equal(after.metadata.work_commit, undefined);
  } finally {
    p.cleanup();
  }
});

test('the flag wins over ATRIS_WORK_ROOT', () => {
  const p = makeProject();
  try {
    const other = p.addCopy('other-copy');
    const otherHead = p.git(['rev-parse', 'HEAD'], other);
    const copyHead = p.git(['rev-parse', 'HEAD'], p.copy);
    assert.notEqual(otherHead, copyHead);
    const ready = p.ready(['--work-root', other], { ATRIS_WORK_ROOT: p.copy });
    assert.equal(ready.status, 0, ready.stderr + ready.stdout);
    assert.equal(p.show().metadata.work_commit, otherHead);
  } finally {
    p.cleanup();
  }
});
