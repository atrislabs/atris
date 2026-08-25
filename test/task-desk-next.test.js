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
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-task-desk-next-')));
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

function deskEnv(dir, dbName = 'tasks.db') {
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

test('task desk next line names accept for a certified review', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  try {
    writeProjection(dir, [{
      id: 'task-2',
      display_id: 'UNW-2',
      title: 'Print a human line like 4 words so the count is easy to read.',
      status: 'review',
      claimed_by: 'keshav',
      updated_at: 20,
      review: { agent_certified: true, agent_review_pass_count: 2 },
    }]);
    const desk = runCli(['task'], { cwd: dir, env: deskEnv(dir, 'certified.db') });
    assert.equal(desk.status, 0, desk.stderr || desk.stdout);
    assert.match(desk.stdout, /TASK DESK/);
    assert.equal(nextLine(desk.stdout), 'atris task accept UNW-2');
    assert.doesNotMatch(desk.stdout, /next: atris task next/);
    assert.doesNotMatch(desk.stdout, /Describe the desired outcome|say yes:/i);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task desk next line names accept for a two-pass review', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  try {
    writeProjection(dir, [{
      id: 'task-8',
      display_id: 'UNW-8',
      title: 'Second pass is already in',
      status: 'review',
      updated_at: 20,
      review: { agent_review_pass_count: 2 },
    }]);
    const desk = runCli(['task'], { cwd: dir, env: deskEnv(dir, 'two-pass.db') });
    assert.equal(desk.status, 0, desk.stderr || desk.stdout);
    assert.equal(nextLine(desk.stdout), 'atris task accept UNW-8');
  } finally {
    cleanupTempDir(dir);
  }
});

test('task desk next line names ready for a claimed task without templates', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const created = runCli(['task', 'new', 'Ship the landing page', '--json'], {
      cwd: dir,
      env: deskEnv(dir),
    });
    assert.equal(created.status, 0, created.stderr || created.stdout);
    const createdPayload = JSON.parse(created.stdout);
    const ref = createdPayload.task.display_id;
    const claimed = runCli(['task', 'claim', ref, '--as', 'keshav'], {
      cwd: dir,
      env: deskEnv(dir),
    });
    assert.equal(claimed.status, 0, claimed.stderr || claimed.stdout);
    const desk = runCli(['task'], { cwd: dir, env: deskEnv(dir) });
    assert.equal(desk.status, 0, desk.stderr || desk.stdout);
    assert.match(desk.stdout, /TASK DESK/);
    assert.equal(nextLine(desk.stdout), `atris task ready ${ref}`);
    assert.doesNotMatch(desk.stdout, /<cmd>|<plain sentence>|next: atris task next/);
    assert.doesNotMatch(desk.stdout, /Describe the desired outcome|say yes:/i);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task desk next line names claim for an open task', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const created = runCli(['task', 'new', 'Make the desk tell the truth', '--json'], {
      cwd: dir,
      env: deskEnv(dir),
    });
    assert.equal(created.status, 0, created.stderr || created.stdout);
    const ref = JSON.parse(created.stdout).task.display_id;
    const desk = runCli(['task'], { cwd: dir, env: deskEnv(dir) });
    assert.equal(desk.status, 0, desk.stderr || desk.stdout);
    assert.equal(nextLine(desk.stdout), `atris task claim ${ref} --as keshav`);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task desk next line stays on task next when only done work remains', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  try {
    writeProjection(dir, [{
      id: 'task-0',
      display_id: 'CLI-0',
      title: 'Already shipped',
      status: 'done',
      updated_at: 5,
    }]);
    const desk = runCli(['task'], { cwd: dir, env: deskEnv(dir, 'done.db') });
    assert.equal(desk.status, 0, desk.stderr || desk.stdout);
    assert.match(desk.stdout, /clear\s+no active tasks/);
    assert.equal(nextLine(desk.stdout), 'atris task next');
  } finally {
    cleanupTempDir(dir);
  }
});

test('empty task desk names task new and does not point at task next', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  try {
    const desk = runCli(['task'], { cwd: dir, env: deskEnv(dir, 'empty.db') });
    assert.equal(desk.status, 0, desk.stderr || desk.stdout);
    assert.match(desk.stdout, /No tasks yet/);
    assert.match(desk.stdout, /atris task new/);
    assert.doesNotMatch(desk.stdout, /next: atris task next/);
    assert.doesNotMatch(desk.stdout, /Describe the desired outcome|say yes:/i);
  } finally {
    cleanupTempDir(dir);
  }
});
