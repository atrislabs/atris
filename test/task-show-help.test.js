'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const TIMEOUT_MS = 12000;
const SHOW_USAGE = 'Usage: atris task show <id> [--json]';

function hasNodeSqlite() {
  try {
    require('node:sqlite');
    return true;
  } catch (_) {
    return false;
  }
}

function makeTempDir(prefix = 'atris-task-show-help-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runCli(args, { cwd, env, timeout = TIMEOUT_MS } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...scrubAgentEnv(),
      ATRIS_SKIP_UPDATE_CHECK: '1',
      ATRIS_NO_INTERACTIVE: '1',
      ATRIS_NONINTERACTIVE: '1',
      NODE_NO_WARNINGS: '1',
      ...(env || {}),
    },
  });
  if (result.error && result.error.code === 'ETIMEDOUT') {
    assert.fail(`cli hung past ${timeout}ms (args: ${args.join(' ')})`);
  }
  if (result.error) throw result.error;
  return result;
}

function assertShowHelpOnly(res, label) {
  assert.equal(res.status, 0, `${label}: ${res.stdout}\n${res.stderr}`);
  const lines = String(res.stdout || '').trim().split('\n').filter(Boolean);
  assert.ok(lines.length >= 1 && lines.length <= 2, `${label} should print one usage line: ${res.stdout}`);
  assert.equal(lines[0], SHOW_USAGE, `${label}: ${res.stdout}`);
  const blob = `${res.stdout}\n${res.stderr}`;
  assert.doesNotMatch(blob, /durable local task state|Confidence Gate|TASK DESK|atris task list|say yes:/);
  assert.doesNotMatch(blob, /Technical details|Dialogue:|id required|task not found|missing_id/i);
}

test('task show --help prints one usage line and does not list or mutate', () => {
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  try {
    for (const args of [
      ['task', 'show', '--help'],
      ['task', 'show', '-h'],
      ['task', 'show', 'help'],
      ['task', 'show', '-?'],
    ]) {
      const res = runCli(args, {
        cwd: dir,
        env: { ATRIS_TASKS_DB: dbPath },
      });
      assertShowHelpOnly(res, args.join(' '));
    }
    assert.equal(fs.existsSync(dbPath), false, 'show --help must not open the task db');
    assert.equal(fs.existsSync(path.join(dir, '.atris')), false, 'show --help must not create .atris');
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false, 'show --help must not scaffold atris/');
  } finally {
    cleanupTempDir(dir);
  }
});

test('task --help still prints the full task usage', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['task', '--help'], { cwd: dir });
    assert.equal(res.status, 0, `task --help: ${res.stdout}\n${res.stderr}`);
    const lines = String(res.stdout || '').trim().split('\n').filter(Boolean);
    assert.ok(lines.length > 10, `task --help should stay the encyclopedia: ${res.stdout}`);
    assert.match(res.stdout, /atris task - durable local task state/);
    assert.match(res.stdout, /atris task show <id> \[--json\]/);
    assert.notEqual(lines[0], SHOW_USAGE);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task show <id> --help does not show the task', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, ATRIS_AGENT_ID: 'codex' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const add = runCli(['task', 'add', 'Keep show help from dumping the card', '--tag', 'cli', '--json'], {
      cwd: dir,
      env,
    });
    assert.equal(add.status, 0, add.stderr || add.stdout);
    const ref = JSON.parse(add.stdout).task.display_id;
    const before = JSON.parse(runCli(['task', 'show', ref, '--json'], { cwd: dir, env }).stdout);

    const help = runCli(['task', 'show', ref, '--help'], { cwd: dir, env });
    assertShowHelpOnly(help, `task show ${ref} --help`);
    assert.doesNotMatch(`${help.stdout}\n${help.stderr}`, new RegExp(ref));
    assert.doesNotMatch(`${help.stdout}\n${help.stderr}`, /Keep show help from dumping the card/);

    const after = JSON.parse(runCli(['task', 'show', ref, '--json'], { cwd: dir, env }).stdout);
    assert.equal(after.status, before.status);
    assert.equal(after.updated_at, before.updated_at);
    assert.equal(after.title, before.title);
  } finally {
    cleanupTempDir(dir);
  }
});
