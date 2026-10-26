'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  hasNodeSqlite,
  makeTempDir: makeFixtureDir,
  cleanupTempDir,
  runCli,
  writeProjection,
  taskEnv: deskEnv,
  nextLine,
} = require('./helpers/task-next-fixture');

const makeTempDir = () => makeFixtureDir('atris-task-desk-next-');

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
    const desk = runCli(['task', 'desk'], { cwd: dir, env: deskEnv(dir, 'certified.db') });
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
    const desk = runCli(['task', 'desk'], { cwd: dir, env: deskEnv(dir, 'two-pass.db') });
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
    const desk = runCli(['task', 'desk'], { cwd: dir, env: deskEnv(dir) });
    assert.equal(desk.status, 0, desk.stderr || desk.stdout);
    assert.match(desk.stdout, /TASK DESK/);
    assert.equal(nextLine(desk.stdout), `atris "add a test for the claimed task"`);
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
    const desk = runCli(['task', 'desk'], { cwd: dir, env: deskEnv(dir) });
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
    const desk = runCli(['task', 'desk'], { cwd: dir, env: deskEnv(dir, 'done.db') });
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
    const desk = runCli(['task', 'desk'], { cwd: dir, env: deskEnv(dir, 'empty.db') });
    assert.equal(desk.status, 0, desk.stderr || desk.stdout);
    assert.match(desk.stdout, /No tasks yet/);
    assert.match(desk.stdout, /atris task new/);
    assert.doesNotMatch(desk.stdout, /next: atris task next/);
    assert.doesNotMatch(desk.stdout, /Describe the desired outcome|say yes:/i);
  } finally {
    cleanupTempDir(dir);
  }
});
