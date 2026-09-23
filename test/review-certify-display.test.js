const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');
const { withTaskReadyResult } = require('./helpers/task-result');

const CLI = path.join(__dirname, '..', 'bin', 'atris.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-certify-display-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function runCli(args, { cwd, env = {} } = {}) {
  return spawnSync(process.execPath, [CLI, ...withTaskReadyResult(args)], {
    cwd,
    env: {
      ...scrubAgentEnv(),
      ATRIS_SKIP_UPDATE_CHECK: '1',
      NODE_NO_WARNINGS: '1',
      ...env,
    },
    encoding: 'utf8',
  });
}

function addTask(dir, env, title) {
  const add = runCli(['task', 'add', title, '--json'], { cwd: dir, env });
  assert.equal(add.status, 0, add.stderr);
  return JSON.parse(add.stdout).task.display_id;
}

function readyTask(dir, env, ref) {
  const ready = runCli(['task', 'ready', ref, '--verify', 'true', '--no-falsify-check', '--json'], { cwd: dir, env });
  assert.equal(ready.status, 0, ready.stderr || ready.stdout);
  return ready;
}

test('two review passes from the builder alone do not display Checked or certify', () => {
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const builder = { ATRIS_TASKS_DB: dbPath, ATRIS_AGENT_ID: 'codex' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const ref = addTask(dir, builder, 'Self-passed card must not certify');

    readyTask(dir, builder, ref);
    readyTask(dir, builder, ref);

    const show = runCli(['task', 'show', ref], { cwd: dir, env: builder });
    assert.equal(show.status, 0, show.stderr);
    assert.doesNotMatch(show.stdout, /Checked: yes/);

    const showJson = runCli(['task', 'show', ref, '--json'], { cwd: dir, env: builder });
    assert.equal(showJson.status, 0, showJson.stderr);
    const detail = JSON.parse(showJson.stdout);
    assert.equal(detail.review.agent_review_pass_count, 2);
    assert.notEqual(detail.review.agent_certified, true);
  } finally {
    cleanupTempDir(dir);
  }
});

test('a pass from a second actor still certifies and prints Checked', () => {
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const builder = { ATRIS_TASKS_DB: dbPath, ATRIS_AGENT_ID: 'codex' };
  const reviewer = { ATRIS_TASKS_DB: dbPath, ATRIS_AGENT_ID: 'validator' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const ref = addTask(dir, builder, 'Independent pass certifies');

    readyTask(dir, builder, ref);
    readyTask(dir, reviewer, ref);

    const show = runCli(['task', 'show', ref], { cwd: dir, env: builder });
    assert.equal(show.status, 0, show.stderr);
    assert.match(show.stdout, /Checked: yes/);

    const showJson = runCli(['task', 'show', ref, '--json'], { cwd: dir, env: builder });
    assert.equal(showJson.status, 0, showJson.stderr);
    const detail = JSON.parse(showJson.stdout);
    assert.equal(detail.review.agent_certified, true);
  } finally {
    cleanupTempDir(dir);
  }
});
