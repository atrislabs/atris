const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-codex-goal-test-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runSqlite(dbPath, sql, args = []) {
  const result = spawnSync('sqlite3', [...args, dbPath, sql], { encoding: 'utf8' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

function runCli(args, { cwd }) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
    },
  });
  if (result.error) throw result.error;
  return result;
}

function seedCodexState(dir) {
  const dbPath = path.join(dir, 'state_5.sqlite');
  const threadCwd = fs.realpathSync.native ? fs.realpathSync.native(dir) : fs.realpathSync(dir);
  runSqlite(dbPath, `
CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  cwd TEXT NOT NULL,
  title TEXT NOT NULL,
  updated_at_ms INTEGER
);
CREATE TABLE thread_goals (
  thread_id TEXT PRIMARY KEY NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  goal_id TEXT NOT NULL,
  objective TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'budget_limited', 'complete')),
  token_budget INTEGER,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  time_used_seconds INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
INSERT INTO threads (id, cwd, title, updated_at_ms)
VALUES
  ('thread-complete', '${threadCwd.replace(/'/g, "''")}', 'completed thread', 2000),
  ('thread-active', '${threadCwd.replace(/'/g, "''")}', 'active thread', 1000);
INSERT INTO thread_goals (thread_id, goal_id, objective, status, token_budget, tokens_used, time_used_seconds, created_at_ms, updated_at_ms)
VALUES
  ('thread-complete', 'goal-complete', 'Ship the next useful proof', 'complete', NULL, 12, 7, 1000, 2000),
  ('thread-active', 'goal-active', 'Keep working', 'active', NULL, 3, 1, 1000, 1000);
`);
  return dbPath;
}

test('codex-goal status reads the latest goal for the current cwd', () => {
  const dir = makeTempDir();
  try {
    const dbPath = seedCodexState(dir);
    const res = runCli(['codex-goal', 'status', '--state', dbPath, '--latest', '--json'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.goal.thread_id, 'thread-complete');
    assert.equal(payload.goal.status, 'complete');
  } finally {
    cleanupTempDir(dir);
  }
});

test('codex-goal reset backs up, dumps, and clears only a completed goal row', () => {
  const dir = makeTempDir();
  try {
    const dbPath = seedCodexState(dir);
    const outDir = path.join(dir, 'atris', 'runs');
    const res = runCli([
      'codex-goal',
      'reset',
      '--state',
      dbPath,
      '--thread',
      'thread-complete',
      '--out-dir',
      outDir,
      '--confirm-complete-goal-reset',
      '--json',
    ], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.status, 'reset');
    assert.equal(payload.deleted, 1);
    assert.ok(fs.existsSync(payload.backup_path));
    assert.ok(fs.existsSync(payload.dump_path));
    assert.ok(fs.existsSync(payload.receipt_path));

    const backupRows = JSON.parse(runSqlite(payload.backup_path, "SELECT count(*) AS n FROM thread_goals WHERE thread_id = 'thread-complete';", ['-json']));
    assert.equal(backupRows[0].n, 1);

    const rows = JSON.parse(runSqlite(dbPath, "SELECT count(*) AS n FROM thread_goals WHERE thread_id = 'thread-complete';", ['-json']));
    assert.equal(rows[0].n, 0);
    const activeRows = JSON.parse(runSqlite(dbPath, "SELECT count(*) AS n FROM thread_goals WHERE thread_id = 'thread-active';", ['-json']));
    assert.equal(activeRows[0].n, 1);
  } finally {
    cleanupTempDir(dir);
  }
});

test('codex-goal reset defaults backups to ignored private runtime dir', () => {
  const dir = makeTempDir();
  try {
    const dbPath = seedCodexState(dir);
    const res = runCli([
      'codex-goal',
      'reset',
      '--state',
      dbPath,
      '--thread',
      'thread-complete',
      '--confirm-complete-goal-reset',
      '--json',
    ], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    const payload = JSON.parse(res.stdout);
    const expectedDirPath = path.join(dir, '.atris', 'runs');
    const expectedDir = fs.realpathSync.native ? fs.realpathSync.native(expectedDirPath) : fs.realpathSync(expectedDirPath);
    assert.equal(path.dirname(payload.backup_path), expectedDir);
    assert.equal(path.dirname(payload.dump_path), expectedDir);
    assert.equal(path.dirname(payload.receipt_path), expectedDir);
  } finally {
    cleanupTempDir(dir);
  }
});

test('codex-goal reset without confirmation exits non-zero', () => {
  const dir = makeTempDir();
  try {
    const dbPath = seedCodexState(dir);
    const res = runCli([
      'codex-goal',
      'reset',
      '--state',
      dbPath,
      '--thread',
      'thread-complete',
      '--json',
    ], { cwd: dir });
    assert.notEqual(res.status, 0);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.status, 'needs_confirmation');
    assert.equal(payload.required_flag, '--confirm-complete-goal-reset');
  } finally {
    cleanupTempDir(dir);
  }
});

test('codex-goal reset refuses active native goals', () => {
  const dir = makeTempDir();
  try {
    const dbPath = seedCodexState(dir);
    const res = runCli([
      'codex-goal',
      'reset',
      '--state',
      dbPath,
      '--thread',
      'thread-active',
      '--confirm-complete-goal-reset',
    ], { cwd: dir });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /Refusing to reset active goal/);
  } finally {
    cleanupTempDir(dir);
  }
});
