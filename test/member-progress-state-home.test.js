'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const progressModule = path.resolve(__dirname, '../lib/member-progress.js');
const appendProbe = `require(process.argv[1]).appendProgress('architect', 'reading owned-fixture.txt', 'owned-mission');`;

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-progress-home-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const fence = path.join(root, 'fence');
  const cwd = path.join(root, 'workspace');
  fs.mkdirSync(path.join(home, '.atris', 'progress'), { recursive: true });
  fs.mkdirSync(fence);
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(home, 'sentinel'), 'owned protected home\n', { mode: 0o600 });
  fs.writeFileSync(path.join(home, '.atris', 'progress', 'keep.log'), 'owned older progress\n');
  fs.writeFileSync(path.join(fence, 'sentinel'), 'owned test state\n');
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    ATRIS_TEST_PROTECTED_HOME: home,
    ATRIS_TEST_STATE_DIR: fence,
  };
  delete env.ATRIS_PROGRESS_DIR;
  delete env.ATRIS_TEST_REAL_HOME;
  return { root, home, fence, cwd, env };
}

// Reading may change access times. Progress must preserve the protected
// tree's contents, permissions, modification times and change times.
function snapshot(root) {
  const rows = [];
  function walk(file, relative) {
    const stat = fs.lstatSync(file, { bigint: true });
    const row = { path: relative, mode: String(stat.mode), mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs) };
    if (stat.isDirectory()) {
      rows.push({ ...row, type: 'directory' });
      for (const name of fs.readdirSync(file).sort()) walk(path.join(file, name), path.join(relative, name));
    } else {
      rows.push({ ...row, type: 'file', bytes: fs.readFileSync(file).toString('hex') });
    }
  }
  walk(root, '.');
  return rows;
}

function run(f) {
  const result = spawnSync(process.execPath, ['-e', appendProbe, progressModule], {
    cwd: f.cwd, env: f.env, encoding: 'utf8', timeout: 30000,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function assertProgress(dir) {
  const file = path.join(dir, 'architect.log');
  assert.ok(fs.existsSync(file), 'the actual progress line must reach its chosen folder');
  assert.match(fs.readFileSync(file, 'utf8'), /^\d{4}-\d{2}-\d{2}T\S+ owned-mission reading owned-fixture\.txt\n$/);
}

test('progress stays fenced after a child loses the test-context marker', (t) => {
  const f = fixture(t);
  delete f.env.NODE_TEST_CONTEXT;
  const before = snapshot(f.home);
  run(f);
  assert.deepEqual(snapshot(f.home), before, 'protected home contents, modes and times changed');
  assertProgress(path.join(f.fence, '.atris', 'progress'));
});

test('ordinary progress keeps the normal home destination', (t) => {
  const f = fixture(t);
  delete f.env.NODE_TEST_CONTEXT;
  delete f.env.ATRIS_TEST_STATE_DIR;
  delete f.env.ATRIS_TEST_PROTECTED_HOME;
  const before = snapshot(f.fence);
  run(f);
  assertProgress(path.join(f.home, '.atris', 'progress'));
  assert.deepEqual(snapshot(f.fence), before);
});

test('an explicit temporary home wins over a different retained test-state folder', (t) => {
  const f = fixture(t);
  delete f.env.NODE_TEST_CONTEXT;
  delete f.env.ATRIS_TEST_PROTECTED_HOME;
  const before = snapshot(f.fence);
  run(f);
  assertProgress(path.join(f.home, '.atris', 'progress'));
  assert.deepEqual(snapshot(f.fence), before);
});

test('an explicit progress folder wins over test-context suppression and the home fence', (t) => {
  const f = fixture(t);
  f.env.ATRIS_PROGRESS_DIR = path.join(f.root, 'explicit-progress');
  const beforeHome = snapshot(f.home);
  const beforeFence = snapshot(f.fence);
  run(f);
  assertProgress(f.env.ATRIS_PROGRESS_DIR);
  assert.deepEqual(snapshot(f.home), beforeHome);
  assert.deepEqual(snapshot(f.fence), beforeFence);
});

test('the deliberate real-home opt-out retains the normal progress destination', (t) => {
  const f = fixture(t);
  delete f.env.NODE_TEST_CONTEXT;
  f.env.ATRIS_TEST_REAL_HOME = '1';
  const before = snapshot(f.fence);
  run(f);
  assertProgress(path.join(f.home, '.atris', 'progress'));
  assert.deepEqual(snapshot(f.fence), before);
});

test('the original test-context suppression still writes no default progress', (t) => {
  const f = fixture(t);
  const beforeHome = snapshot(f.home);
  const beforeFence = snapshot(f.fence);
  assert.ok(f.env.NODE_TEST_CONTEXT, 'the real test runner supplied its context marker');
  run(f);
  assert.deepEqual(snapshot(f.home), beforeHome);
  assert.deepEqual(snapshot(f.fence), beforeFence);
});
