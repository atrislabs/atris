const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { inferBudgetTier } = require('../commands/wish');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const systemPath = '/usr/bin:/bin:/usr/sbin:/sbin';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-wish-test-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function hasNodeSqlite() {
  const result = spawnSync(process.execPath, ['-e', 'require("node:sqlite")'], {
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  return result.status === 0;
}

function prepareWorkspace(dir) {
  fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
}

function makeFakeEngines(dir) {
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  for (const name of ['codex', 'claude']) {
    const file = path.join(binDir, name);
    fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', 'utf8');
    fs.chmodSync(file, 0o755);
  }
  return binDir;
}

function runCli(args, { cwd, env = {} } = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      NODE_NO_WARNINGS: '1',
      ...env,
    },
  });
}

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function todayJournalPath(dir) {
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return path.join(dir, 'atris', 'logs', String(now.getFullYear()), `${date}.md`);
}

test('wish capture writes the journal inbox and wishes jsonl', () => {
  const dir = makeTempDir();
  const emptyBin = path.join(dir, 'empty-bin');
  fs.mkdirSync(emptyBin, { recursive: true });
  try {
    prepareWorkspace(dir);
    const res = runCli(['wish', 'make the boot screen friendlier'], {
      cwd: dir,
      env: { PATH: `${emptyBin}:${systemPath}` },
    });
    assert.equal(res.status, 1);

    const journal = fs.readFileSync(todayJournalPath(dir), 'utf8');
    assert.match(journal, /make the boot screen friendlier/);

    const records = readJsonl(path.join(dir, '.atris', 'state', 'wishes.jsonl'));
    assert.equal(records[0].text, 'make the boot screen friendlier');
    assert.equal(records[0].status, 'captured');
    assert.equal(records.at(-1).status, 'needs_input');
  } finally {
    cleanupTempDir(dir);
  }
});

test('vague wish yields numbered questions', () => {
  const dir = makeTempDir();
  try {
    prepareWorkspace(dir);
    const fakeBin = makeFakeEngines(dir);
    const res = runCli(['wish', 'fix auth'], {
      cwd: dir,
      env: { PATH: `${fakeBin}:${systemPath}` },
    });
    assert.equal(res.status, 1, res.stderr || res.stdout);
    assert.match(res.stdout, /^1\. What exact outcome should this create\?/);
    assert.doesNotMatch(res.stdout, /wish-|mission-|[A-Z0-9]{3}-\d/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('healthy wish delegates a task and starts a verified mission', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  try {
    prepareWorkspace(dir);
    const fakeBin = makeFakeEngines(dir);
    const dbPath = path.join(dir, 'tasks.db');
    const res = runCli(['wish', 'make the boot screen friendlier', '--json'], {
      cwd: dir,
      env: { PATH: `${fakeBin}:${systemPath}`, ATRIS_TASKS_DB: dbPath },
    });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const payload = JSON.parse(res.stdout);
    assert.deepEqual(Object.keys(payload).sort(), ['budget', 'engine', 'mission_id', 'questions', 'status', 'task_id', 'wish_id']);
    assert.equal(payload.status, 'delegated');
    assert.equal(payload.engine, 'codex');
    assert.equal(payload.budget, 'long');
    assert.deepEqual(payload.questions, []);
    assert.ok(payload.task_id);
    assert.ok(payload.mission_id);

    const wishes = readJsonl(path.join(dir, '.atris', 'state', 'wishes.jsonl'));
    assert.equal(wishes.at(-1).status, 'delegated');
    assert.equal(wishes.at(-1).task_id, payload.task_id);
    assert.equal(wishes.at(-1).mission_id, payload.mission_id);

    const missions = readJsonl(path.join(dir, '.atris', 'state', 'missions.jsonl'));
    const mission = missions.find((row) => row.id === payload.mission_id);
    assert.equal(mission.runner, 'codex');
    assert.equal(mission.verifier, 'git diff --check');
    assert.deepEqual(mission.task_ids, [payload.task_id]);

    const projection = JSON.parse(fs.readFileSync(path.join(dir, '.atris', 'state', 'tasks.projection.json'), 'utf8'));
    assert.ok(projection.tasks.some((task) => task.id === payload.task_id && task.metadata.delegate_via === 'local'));
  } finally {
    cleanupTempDir(dir);
  }
});

test('wish budget tier inference follows plain wording', () => {
  assert.equal(inferBudgetTier('quick polish the help copy'), 'quick');
  assert.equal(inferBudgetTier('small fix for the prompt'), 'quick');
  assert.equal(inferBudgetTier('overhaul all mission screens'), 'deep');
  assert.equal(inferBudgetTier('make the boot screen friendlier'), 'long');
});

test('json question shape is stable', () => {
  const dir = makeTempDir();
  try {
    prepareWorkspace(dir);
    const fakeBin = makeFakeEngines(dir);
    const res = runCli(['wish', 'fix auth', '--json'], {
      cwd: dir,
      env: { PATH: `${fakeBin}:${systemPath}` },
    });
    assert.equal(res.status, 1, res.stderr || res.stdout);
    const payload = JSON.parse(res.stdout);
    assert.deepEqual(Object.keys(payload).sort(), ['budget', 'engine', 'mission_id', 'questions', 'status', 'task_id', 'wish_id']);
    assert.equal(payload.status, 'needs_input');
    assert.equal(payload.task_id, null);
    assert.equal(payload.mission_id, null);
    assert.equal(payload.engine, 'codex');
    assert.equal(payload.budget, 'long');
    assert.ok(Array.isArray(payload.questions));
  } finally {
    cleanupTempDir(dir);
  }
});

test('wish list stays in plain language without ids', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  try {
    prepareWorkspace(dir);
    const fakeBin = makeFakeEngines(dir);
    const dbPath = path.join(dir, 'tasks.db');
    const created = runCli(['wish', 'make the boot screen friendlier', '--json'], {
      cwd: dir,
      env: { PATH: `${fakeBin}:${systemPath}`, ATRIS_TASKS_DB: dbPath },
    });
    assert.equal(created.status, 0, created.stderr || created.stdout);

    const list = runCli(['wish', 'list'], {
      cwd: dir,
      env: { PATH: `${fakeBin}:${systemPath}`, ATRIS_TASKS_DB: dbPath },
    });
    assert.equal(list.status, 0, list.stderr || list.stdout);
    assert.match(list.stdout, /make the boot screen friendlier - in flight/);
    assert.doesNotMatch(list.stdout, /[0-9A-HJKMNP-TV-Z]{26}/);
    assert.doesNotMatch(list.stdout, /wish-|mission-|[A-Z0-9]{3}-\d/);
  } finally {
    cleanupTempDir(dir);
  }
});
