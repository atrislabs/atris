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
const TIMEOUT_MS = 20000;

function hasNodeSqlite() {
  try {
    require('node:sqlite');
    return true;
  } catch {
    return false;
  }
}

function makeTempDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-task-next-truth-')));
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
      USER: 'keshav',
      ...(env || {}),
    },
  });
  if (result.error && result.error.code === 'ETIMEDOUT') {
    assert.fail(`cli hung past ${timeout}ms (args: ${args.join(' ')})`);
  }
  if (result.error) throw result.error;
  return result;
}

function writeProjection(dir, tasks) {
  const stateDir = path.join(dir, '.atris', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'tasks.projection.json'), JSON.stringify({
    schema: 'atris.task_projection.v1',
    generated_at: new Date().toISOString(),
    workspace_root: dir,
    tasks,
  }, null, 2), 'utf8');
}

function nextEnv(dir, dbName = 'tasks.db') {
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  return {
    HOME: home,
    ATRIS_TASKS_DB: path.join(dir, dbName),
  };
}

function nextLine(stdout) {
  const match = String(stdout || '').match(/^next: (.+)$/m);
  return match ? match[1] : '';
}

function assertSameNext(dir, env, expected) {
  const desk = runCli(['task'], { cwd: dir, env });
  assert.equal(desk.status, 0, desk.stderr || desk.stdout);
  const next = runCli(['task', 'next'], { cwd: dir, env });
  assert.equal(next.status, 0, next.stderr || next.stdout);
  assert.equal(nextLine(next.stdout), expected);
  assert.doesNotMatch(next.stdout, /atris task step |<cmd>|<plain sentence>|Start with: atris task new "\.\.\."/);
  assert.doesNotMatch(next.stdout, /Describe the desired outcome|say yes:/i);
  return { desk, next };
}

test('task next names ready for a claimed task even when the unix user differs', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const env = { ...nextEnv(dir), USER: 'ubuntu' };
    const created = runCli(['task', 'new', 'Ship the landing page', '--json'], { cwd: dir, env });
    assert.equal(created.status, 0, created.stderr || created.stdout);
    const ref = JSON.parse(created.stdout).task.display_id;
    const claimed = runCli(['task', 'claim', ref, '--as', 'keshav'], { cwd: dir, env });
    assert.equal(claimed.status, 0, claimed.stderr || claimed.stdout);
    const expected = `atris task ready ${ref}`;
    const { desk, next } = assertSameNext(dir, env, expected);
    assert.equal(nextLine(desk.stdout), expected);
    const json = runCli(['task', 'next', '--json'], { cwd: dir, env });
    assert.equal(json.status, 0, json.stderr || json.stdout);
    const payload = JSON.parse(json.stdout);
    assert.equal(payload.action, 'ready');
    assert.equal(payload.command, expected);
    assert.equal(payload.task.display_id, ref);
    assert.equal(payload.task.status, 'claimed');
    assert.doesNotMatch(next.stdout, /No open tasks/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task next names accept for a certified review and does not invent a seed', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  try {
    writeProjection(dir, [
      {
        id: 'task-1',
        display_id: 'UNW-1',
        title: 'Older open follow-up',
        status: 'open',
        updated_at: 40,
      },
      {
        id: 'task-2',
        display_id: 'UNW-2',
        title: 'Print a human line like 4 words so the count is easy to read.',
        status: 'review',
        claimed_by: 'keshav',
        updated_at: 20,
        review: { agent_certified: true, agent_review_pass_count: 2 },
      },
    ]);
    const env = nextEnv(dir, 'certified.db');
    const expected = 'atris task accept UNW-2';
    const { next } = assertSameNext(dir, env, expected);
    assert.doesNotMatch(next.stdout, /Create: atris task new|Claim: atris task claim/);
    const json = runCli(['task', 'next', '--json'], { cwd: dir, env });
    assert.equal(json.status, 0, json.stderr || json.stdout);
    const payload = JSON.parse(json.stdout);
    assert.equal(payload.action, 'accept');
    assert.equal(payload.command, expected);
    assert.equal(payload.task.display_id, 'UNW-2');
    assert.equal(payload.task_id, 'task-2');
  } finally {
    cleanupTempDir(dir);
  }
});

test('task next names claim for an open task and does not claim it', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const env = nextEnv(dir);
    const older = runCli(['task', 'new', 'Older leftover', '--json'], { cwd: dir, env });
    assert.equal(older.status, 0, older.stderr || older.stdout);
    const newer = runCli(['task', 'new', 'Make next tell the truth', '--json'], { cwd: dir, env });
    assert.equal(newer.status, 0, newer.stderr || newer.stdout);
    const olderRef = JSON.parse(older.stdout).task.display_id;
    const newerRef = JSON.parse(newer.stdout).task.display_id;
    const expected = `atris task claim ${newerRef} --as keshav`;
    assertSameNext(dir, env, expected);
    const json = runCli(['task', 'next', '--json'], { cwd: dir, env });
    assert.equal(json.status, 0, json.stderr || json.stdout);
    const payload = JSON.parse(json.stdout);
    assert.equal(payload.action, 'claim');
    assert.equal(payload.command, expected);
    assert.equal(payload.task.display_id, newerRef);
    const olderShow = JSON.parse(runCli(['task', 'show', olderRef, '--json'], { cwd: dir, env }).stdout);
    const newerShow = JSON.parse(runCli(['task', 'show', newerRef, '--json'], { cwd: dir, env }).stdout);
    assert.equal(olderShow.status, 'open');
    assert.equal(newerShow.status, 'open');
  } finally {
    cleanupTempDir(dir);
  }
});

test('empty task next names task new and does not prompt', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  try {
    const env = nextEnv(dir, 'empty.db');
    const next = runCli(['task', 'next'], { cwd: dir, env });
    assert.equal(next.status, 0, next.stderr || next.stdout);
    assert.match(next.stdout, /No open tasks/);
    assert.equal(nextLine(next.stdout), 'atris task new');
    assert.doesNotMatch(next.stdout, /atris task step |Start with: atris task new "\.\.\."/);
    assert.doesNotMatch(next.stdout, /Describe the desired outcome|say yes:/i);
    const json = runCli(['task', 'next', '--json'], { cwd: dir, env });
    assert.equal(json.status, 0, json.stderr || json.stdout);
    const payload = JSON.parse(json.stdout);
    assert.equal(payload.action, 'none');
    assert.equal(payload.command, 'atris task new');
    assert.equal(payload.task_id, null);
  } finally {
    cleanupTempDir(dir);
  }
});
