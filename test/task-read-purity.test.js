'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { withTaskReadyResult } = require('./helpers/task-result');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function hasNodeSqlite() {
  return spawnSync(process.execPath, ['-e', 'require("node:sqlite")'], {
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  }).status === 0;
}

function runCli(args, { cwd, env }) {
  const result = spawnSync(process.execPath, [cliPath, ...withTaskReadyResult(args)], {
    cwd,
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      ...(env || {}),
    },
  });
  if (result.error) throw result.error;
  return result;
}

function installVerifySpawnStub(dir, markerPath) {
  const preloadPath = path.join(dir, 'verify-spawn-stub.js');
  fs.writeFileSync(preloadPath, `
    'use strict';
    const childProcess = require('node:child_process');
    const fs = require('node:fs');
    const originalSpawnSync = childProcess.spawnSync;
    childProcess.spawnSync = function stubVerifySpawn(file, args, options) {
      if (file === 'node' && Array.isArray(args) && args.includes('test/read-path-verify.test.js')) {
        fs.appendFileSync(process.env.ATRIS_VERIFY_SPAWN_MARKER, 'verify spawned\\n');
        return { status: 0, signal: null, stdout: '', stderr: '', error: undefined };
      }
      return originalSpawnSync.call(this, file, args, options);
    };
  `, 'utf8');
  return {
    NODE_OPTIONS: `--require=${preloadPath}`,
    ATRIS_VERIFY_SPAWN_MARKER: markerPath,
  };
}

test('task reviews and status json never spawn a stored verifier', () => {
  if (!hasNodeSqlite()) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-task-read-purity-'));
  const dbPath = path.join(dir, 'tasks.db');
  const markerPath = path.join(dir, 'verify-spawns.log');
  const env = {
    ATRIS_TASKS_DB: dbPath,
    NODE_NO_WARNINGS: '1',
    ATRIS_AGENT_PROOF_ONLY: '0',
  };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'test', 'read-path-verify.test.js'), `
      const test = require('node:test');
      test('stored verifier', () => {});
    `, 'utf8');

    const created = runCli(['task', 'new', 'Keep task reads free of verify execution', '--tag', 'test', '--json'], { cwd: dir, env });
    assert.equal(created.status, 0, created.stderr);
    const task = JSON.parse(created.stdout).task;
    assert.equal(runCli(['task', 'claim', task.display_id, '--as', 'builder'], { cwd: dir, env }).status, 0);
    const ready = runCli([
      'task', 'ready', task.display_id,
      '--verify', 'node --test test/read-path-verify.test.js',
      '--as', 'builder',
    ], { cwd: dir, env });
    assert.equal(ready.status, 0, ready.stderr);
    const reviewed = runCli([
      'task', 'review', task.display_id,
      '--reward', '0',
      '--as', 'validator',
      '--proof', 'node --test test/read-path-verify.test.js passed and validator inspected the receipt plus current diff.',
      '--verify', 'node --test test/read-path-verify.test.js',
      '--json',
    ], { cwd: dir, env });
    assert.equal(reviewed.status, 0, reviewed.stderr || reviewed.stdout);

    const readEnv = { ...env, ...installVerifySpawnStub(dir, markerPath) };
    const status = runCli(['task', 'status', '--json'], { cwd: dir, env: readEnv });
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).action, 'status');

    const reviews = runCli(['task', 'reviews', '--json'], { cwd: dir, env: readEnv });
    assert.equal(reviews.status, 0, reviews.stderr);
    const payload = JSON.parse(reviews.stdout);
    assert.equal(payload.action, 'review_queue');
    assert.equal(payload.autoaccept.read_only, true);
    assert.ok(payload.queue.items.some(item => item.display_id === task.display_id));
    assert.equal(fs.existsSync(markerPath), false, 'read paths spawned the stored verifier');

    const shown = runCli(['task', 'show', task.display_id, '--json'], { cwd: dir, env });
    assert.equal(shown.status, 0, shown.stderr);
    assert.equal(JSON.parse(shown.stdout).status, 'review');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
