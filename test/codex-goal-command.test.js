const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { codexGoalCommand, sqlString } = require('../commands/codex-goal');

const hasSqlite = spawnSync('sqlite3', ['--version'], { encoding: 'utf8' }).status === 0;
const ENV_KEYS = ['HOME', 'CODEX_STATE_DB', 'CODEX_THREADS_DB', 'CODEX_THREAD_ID'];

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-codex-goal-command-'));
const home = path.join(sandbox, 'home');
const codexDir = path.join(home, '.codex');
const savedEnv = {};
const savedCwd = process.cwd();
const savedExitCode = process.exitCode;

test.before(() => {
  fs.mkdirSync(codexDir, { recursive: true });
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.HOME = home;
  delete process.env.CODEX_STATE_DB;
  delete process.env.CODEX_THREADS_DB;
  delete process.env.CODEX_THREAD_ID;
});

test.afterEach(() => {
  process.chdir(savedCwd);
  process.exitCode = savedExitCode;
  delete process.env.CODEX_THREAD_ID;
});

test.after(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  process.exitCode = savedExitCode;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

// Run the command in-process, capturing what it prints and the exit code it sets.
function run(args) {
  const out = [];
  const err = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = (...parts) => out.push(parts.join(' '));
  console.error = (...parts) => err.push(parts.join(' '));
  process.exitCode = undefined;
  let thrown = null;
  try {
    codexGoalCommand(args);
  } catch (error) {
    thrown = error;
  } finally {
    console.log = realLog;
    console.error = realError;
  }
  const exitCode = process.exitCode;
  process.exitCode = undefined;
  return { stdout: out.join('\n'), stderr: err.join('\n'), exitCode, thrown };
}

function sqlite(dbPath, sql, args = []) {
  const result = spawnSync('sqlite3', [...args, dbPath, sql], { encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

// Mirrors the current Codex layout: goals in goals_1.sqlite, thread metadata in state_5.sqlite.
function seedSplitCodexHome() {
  const goalsDb = path.join(codexDir, 'goals_1.sqlite');
  const stateDb = path.join(codexDir, 'state_5.sqlite');
  const cwd = fs.realpathSync(sandbox);
  fs.rmSync(goalsDb, { force: true });
  fs.rmSync(stateDb, { force: true });
  sqlite(stateDb, `
CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT NOT NULL, title TEXT NOT NULL, updated_at_ms INTEGER);
INSERT INTO threads (id, cwd, title, updated_at_ms) VALUES
  ('thread-done', ${sqlString(cwd)}, 'finished thread', 2000),
  ('thread-live', '/somewhere/else', 'live thread', 1000);
`);
  sqlite(goalsDb, `
CREATE TABLE thread_goals (
  thread_id TEXT PRIMARY KEY NOT NULL,
  goal_id TEXT NOT NULL,
  objective TEXT NOT NULL,
  status TEXT NOT NULL,
  token_budget INTEGER,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  time_used_seconds INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
INSERT INTO thread_goals VALUES
  ('thread-done', 'g1', 'Ship the proof', 'complete', NULL, 12, 7, 1000, 2000),
  ('thread-live', 'g2', 'Keep going', 'active', NULL, 3, 1, 1000, 1000);
`);
  return { goalsDb, stateDb, cwd };
}

test('sqlString quotes values and doubles embedded single quotes', () => {
  assert.strictEqual(sqlString('plain'), "'plain'");
  assert.strictEqual(sqlString("it's"), "'it''s'");
  assert.strictEqual(sqlString("'; DROP TABLE thread_goals; --"), "'''; DROP TABLE thread_goals; --'");
  assert.strictEqual(sqlString(42), "'42'");
  assert.strictEqual(sqlString(''), "''");
});

test('no subcommand, help, --help and -h all print the usage text and exit clean', () => {
  for (const args of [[], ['help'], ['--help'], ['-h']]) {
    const res = run(args);
    assert.strictEqual(res.thrown, null);
    assert.strictEqual(res.exitCode, undefined, `args ${JSON.stringify(args)}`);
    assert.strictEqual(res.stderr, '');
    assert.match(res.stdout, /^atris codex-goal - guarded bridge for native Codex thread goals/);
    assert.match(res.stdout, /atris codex-goal status \[--thread <id>\|--latest\] \[--json\]/);
    assert.match(res.stdout, /atris codex-goal reset --thread <id> \[--json\]/);
    assert.match(res.stdout, /--state <path>/);
    assert.match(res.stdout, /--threads-db <path>/);
    assert.match(res.stdout, /new work and recurring monitors use a new dedicated Codex task/);
  }
});

test('an unknown subcommand reports it on stderr, shows usage, and sets exit code 1', () => {
  const res = run(['frobnicate']);
  assert.strictEqual(res.thrown, null);
  assert.strictEqual(res.exitCode, 1);
  assert.strictEqual(res.stdout, '');
  const lines = res.stderr.split('\n');
  assert.strictEqual(lines[0], 'Unknown codex-goal subcommand: frobnicate');
  assert.match(res.stderr, /atris codex-goal - guarded bridge/);
});

test('status fails with a clear message when no Codex database exists under HOME', () => {
  const res = run(['status']);
  assert.ok(res.thrown instanceof Error);
  assert.strictEqual(res.thrown.message, `Codex state database not found: ${path.join(codexDir, 'state_5.sqlite')}`);
  assert.strictEqual(res.stdout, '');
});

test('--state expands a leading ~ to HOME and wins over the default location', () => {
  const res = run(['status', '--state', '~/missing/goals.sqlite']);
  assert.ok(res.thrown instanceof Error);
  assert.strictEqual(res.thrown.message, `Codex state database not found: ${path.join(home, 'missing', 'goals.sqlite')}`);
});

test('CODEX_STATE_DB is used when --state is absent, and --state overrides it', () => {
  process.env.CODEX_STATE_DB = path.join(sandbox, 'from-env.sqlite');
  try {
    const fromEnv = run(['status']);
    assert.strictEqual(fromEnv.thrown.message, `Codex state database not found: ${path.join(sandbox, 'from-env.sqlite')}`);
    const fromFlag = run(['status', '--state', path.join(sandbox, 'from-flag.sqlite')]);
    assert.strictEqual(fromFlag.thrown.message, `Codex state database not found: ${path.join(sandbox, 'from-flag.sqlite')}`);
  } finally {
    delete process.env.CODEX_STATE_DB;
  }
});

test('reset without --thread or --latest refuses with guidance', { skip: !hasSqlite }, () => {
  const { goalsDb } = seedSplitCodexHome();
  const res = run(['reset', '--state', goalsDb]);
  assert.ok(res.thrown instanceof Error);
  assert.strictEqual(res.thrown.message, 'No Codex goal found. Pass --thread <thread-id> or --latest.');
  assert.strictEqual(res.stdout, '');
});

test('status lists recent goals newest first, joining thread metadata from state_5.sqlite', { skip: !hasSqlite }, () => {
  const { goalsDb, cwd } = seedSplitCodexHome();

  const asJson = run(['status', '--json']);
  assert.strictEqual(asJson.thrown, null);
  assert.strictEqual(asJson.exitCode, undefined);
  const payload = JSON.parse(asJson.stdout);
  assert.strictEqual(payload.ok, true);
  assert.strictEqual(payload.schema, 'atris.codex_goal.v1');
  assert.strictEqual(payload.action, 'status');
  assert.strictEqual(payload.state_path, goalsDb);
  assert.deepStrictEqual(payload.goals.map((g) => g.thread_id), ['thread-done', 'thread-live']);
  assert.strictEqual(payload.goals[0].thread_cwd, cwd);
  assert.strictEqual(payload.goals[0].thread_title, 'finished thread');
  assert.strictEqual(payload.goals[1].thread_cwd, '/somewhere/else');

  const asText = run(['status']);
  assert.deepStrictEqual(asText.stdout.split('\n'), [
    'Codex goals: 2 recent',
    '- complete thread-done: Ship the proof',
    '- active thread-live: Keep going',
    'Completed tasks stay closed. Start new work in a new Codex task.',
  ]);
});

test('status --limit caps how many goals come back', { skip: !hasSqlite }, () => {
  seedSplitCodexHome();
  const res = run(['status', '--limit', '1', '--json']);
  const payload = JSON.parse(res.stdout);
  assert.strictEqual(payload.goals.length, 1);
  assert.strictEqual(payload.goals[0].thread_id, 'thread-done');
});

test('status --thread prints one goal, and CODEX_THREAD_ID is the fallback', { skip: !hasSqlite }, () => {
  seedSplitCodexHome();

  const flagged = run(['status', '--thread', 'thread-live']);
  assert.deepStrictEqual(flagged.stdout.split('\n'), [
    'Codex goal: active',
    'Thread: thread-live',
    'Objective: Keep going',
    'Tokens/time: 3 tokens, 1s',
  ]);

  process.env.CODEX_THREAD_ID = 'thread-done';
  const fromEnv = run(['status', '--json']);
  const payload = JSON.parse(fromEnv.stdout);
  assert.strictEqual(payload.goal.thread_id, 'thread-done');
  assert.strictEqual(payload.goal.status, 'complete');
  assert.strictEqual(payload.goal.tokens_used, 12);
  assert.strictEqual(payload.goals, undefined);
});

test('status --latest picks the goal whose thread cwd matches the current directory', { skip: !hasSqlite }, () => {
  const { cwd } = seedSplitCodexHome();
  process.chdir(cwd);
  const res = run(['status', '--latest', '--json']);
  assert.strictEqual(res.thrown, null);
  const payload = JSON.parse(res.stdout);
  assert.strictEqual(payload.goal.thread_id, 'thread-done');
  assert.strictEqual(payload.goal.thread_cwd, cwd);
});

test('a single-file legacy state_5.sqlite is used when goals_1.sqlite is absent', { skip: !hasSqlite }, () => {
  const { goalsDb, stateDb } = seedSplitCodexHome();
  fs.rmSync(goalsDb, { force: true });
  sqlite(stateDb, `
CREATE TABLE thread_goals (
  thread_id TEXT PRIMARY KEY NOT NULL, goal_id TEXT NOT NULL, objective TEXT NOT NULL, status TEXT NOT NULL,
  token_budget INTEGER, tokens_used INTEGER NOT NULL DEFAULT 0, time_used_seconds INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
);
INSERT INTO thread_goals VALUES ('thread-live', 'g2', 'Legacy goal', 'paused', NULL, 0, 0, 1, 1);
`);
  const res = run(['status', '--json']);
  const payload = JSON.parse(res.stdout);
  assert.strictEqual(payload.state_path, stateDb);
  assert.strictEqual(payload.goals.length, 1);
  assert.strictEqual(payload.goals[0].objective, 'Legacy goal');
  assert.strictEqual(payload.goals[0].thread_title, 'live thread');
});

test('reset leaves a completed goal closed and never touches the database', { skip: !hasSqlite }, () => {
  const { goalsDb } = seedSplitCodexHome();
  const before = sqlite(goalsDb, 'SELECT * FROM thread_goals ORDER BY thread_id;', ['-json']);

  const res = run(['reset', '--thread', 'thread-done', '--json']);
  assert.strictEqual(res.thrown, null);
  assert.strictEqual(res.exitCode, 1);
  const payload = JSON.parse(res.stdout);
  assert.strictEqual(payload.ok, false);
  assert.strictEqual(payload.action, 'reset');
  assert.strictEqual(payload.status, 'completed_task_closed');
  assert.strictEqual(payload.mutated, false);
  assert.strictEqual(payload.goal.thread_id, 'thread-done');
  assert.match(payload.next_action, /^Create a new Codex task/);
  assert.ok(!Number.isNaN(Date.parse(payload.finished_at)));

  assert.strictEqual(sqlite(goalsDb, 'SELECT * FROM thread_goals ORDER BY thread_id;', ['-json']), before);
});

test('reset refuses an active goal in plain text and exits 1', { skip: !hasSqlite }, () => {
  const { goalsDb } = seedSplitCodexHome();
  const before = sqlite(goalsDb, 'SELECT * FROM thread_goals ORDER BY thread_id;', ['-json']);

  const res = run(['reset', '--thread', 'thread-live']);
  assert.strictEqual(res.exitCode, 1);
  assert.deepStrictEqual(res.stdout.split('\n'), [
    'Codex goal reset refused: this task is active.',
    'Objective: Keep going',
    'Next: Continue or hand off the current task without clearing its goal.',
  ]);
  assert.strictEqual(sqlite(goalsDb, 'SELECT * FROM thread_goals ORDER BY thread_id;', ['-json']), before);
});
