'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function hasNodeSqlite() {
  const result = spawnSync(process.execPath, ['-e', 'require("node:sqlite")'], {
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  return result.status === 0;
}

const REAL = '/Users/someone/real-project';
const HOUR = 60 * 60 * 1000;

// Build a task database that looks like the shared one: real projects mixed
// with rows written by test runs from temp folders, plus their history.
function seedDb(dbPath) {
  const taskStore = require('../lib/task-db');
  const db = taskStore.open(dbPath);
  db.exec(`CREATE TABLE IF NOT EXISTS part_uses (
    id INTEGER PRIMARY KEY, part_id INTEGER NOT NULL, used_by TEXT, used_at INTEGER NOT NULL, note TEXT
  )`);
  const old = Date.now() - 48 * HOUR;
  const now = Date.now();
  const addTask = db.prepare(`INSERT INTO tasks (id, title, status, workspace_root, created_at, updated_at)
    VALUES (?, ?, 'open', ?, ?, ?)`);
  let seq = 0;
  const addEvent = db.prepare(`INSERT INTO task_events (event_id, task_id, version, workspace_root, event_type, created_at)
    VALUES (?, ?, 1, ?, 'task_created', ?)`);
  const event = (taskId, root, at = old) => addEvent.run(`EV${++seq}`, taskId, root, at);
  const use = db.prepare('INSERT INTO part_uses (part_id, used_by, used_at) VALUES (1, ?, ?)');

  addTask.run('REAL1', 'real work', REAL, old, old);
  event('REAL1', REAL); event('REAL1', REAL);
  use.run('REAL1', old);
  addTask.run('REAL2', 'dot-dot path that leaves tmp', '/tmp/../Users/someone/other', old, old);
  event('REAL2', '/tmp/../Users/someone/other');
  addTask.run('LOOK', 'looks like tmp but is not', '/tmpfoo/project', old, old);

  addTask.run('TMP1', 'test junk', '/var/folders/ab/xyz/T/atris-test-1', old, old);
  event('TMP1', '/var/folders/ab/xyz/T/atris-test-1');
  event('TMP1', '/var/folders/ab/xyz/T/atris-test-1');
  event('TMP1', '/var/folders/ab/xyz/T/atris-test-1');
  use.run('TMP1', old);
  addTask.run('TMP2', 'test junk', '/private/tmp/atris-x', old, old);
  event('TMP2', '/private/tmp/atris-x');
  addTask.run('TMP3', 'test junk', '/tmp/atris-y', old, old);

  addTask.run('RECENT', 'a test that may still be running', '/tmp/atris-recent', now, now);
  event('RECENT', '/tmp/atris-recent', now);
  addTask.run('HELD', 'temp task with real-project history', '/tmp/atris-held', old, old);
  event('HELD', REAL);

  event('GONE1', '/var/folders/zz/T/stray');
  event('GONE2', REAL);
  taskStore.close();
}

function dump(dbPath) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return {
      tasks: db.prepare('SELECT * FROM tasks ORDER BY id').all(),
      events: db.prepare('SELECT * FROM task_events ORDER BY event_id').all(),
      uses: db.prepare('SELECT * FROM part_uses ORDER BY id').all(),
    };
  } finally {
    db.close();
  }
}

function runCli(args, { cwd, env }) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 60000,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      NODE_NO_WARNINGS: '1',
      ...env,
    },
  });
  if (result.error) throw result.error;
  return result;
}

function setup() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-prune-junk-')));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const dbPath = path.join(dir, 'db', 'tasks.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  seedDb(dbPath);
  const env = { ATRIS_TASKS_DB: dbPath, HOME: home, ATRIS_AGENT_ID: 'tester' };
  return { dir, dbPath, env };
}

test('prune-test-junk dry run counts temp-folder rows and changes nothing', () => {
  if (!hasNodeSqlite()) return;
  const { dir, dbPath, env } = setup();
  try {
    const before = dump(dbPath);
    const res = runCli(['task', 'prune-test-junk', '--json'], { cwd: dir, env });
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.dry_run, true);
    assert.equal(out.total_tasks, 8);
    assert.equal(out.remove.tasks, 3);
    assert.equal(out.remove.history_rows, 4);
    assert.equal(out.remove.stray_history_rows, 1);
    assert.equal(out.remove.part_uses, 1);
    assert.equal(out.kept.recent, 1);
    assert.equal(out.kept.held, 1);
    assert.ok(out.db_bytes > 0);
    const prefixes = Object.fromEntries(out.groups.map(g => [g.prefix, g.tasks]));
    assert.deepEqual(prefixes, { '/var/folders': 1, '/private/tmp': 1, '/tmp': 1 });

    const text = runCli(['task', 'prune-test-junk'], { cwd: dir, env });
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /nothing was changed/);
    assert.match(text.stdout, /3 test task/);

    assert.deepEqual(dump(dbPath), before);
    const backups = fs.readdirSync(path.dirname(dbPath)).filter(name => name.includes('before-prune'));
    assert.deepEqual(backups, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('prune-test-junk --yes backs up, removes only temp rows and their history, leaves no orphans', () => {
  if (!hasNodeSqlite()) return;
  const { dir, dbPath, env } = setup();
  try {
    const before = dump(dbPath);
    const res = runCli(['task', 'prune-test-junk', '--yes', '--vacuum', '--json'], { cwd: dir, env });
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.dry_run, false);
    assert.equal(out.removed.tasks, 3);
    assert.equal(out.removed.history_rows, 4);
    assert.equal(out.removed.stray_history_rows, 1);
    assert.equal(out.removed.part_uses, 1);
    assert.equal(out.vacuumed, true);

    const after = dump(dbPath);
    assert.deepEqual(after.tasks.map(r => r.id), ['HELD', 'LOOK', 'REAL1', 'REAL2', 'RECENT']);
    // every real-project row is byte-for-byte untouched
    for (const row of before.tasks.filter(r => !r.workspace_root.startsWith('/tmp/atris')
      && !r.workspace_root.startsWith('/var/') && !r.workspace_root.startsWith('/private/'))) {
      assert.deepEqual(after.tasks.find(r => r.id === row.id), row);
    }
    assert.deepEqual(after.uses.map(r => r.used_by), ['REAL1']);
    const liveIds = new Set(after.tasks.map(r => r.id));
    const orphans = after.events.filter(e => !liveIds.has(e.task_id)).map(e => e.task_id);
    assert.deepEqual(orphans, ['GONE2'], 'only the pre-existing real-project stray survives');
    assert.equal(after.events.filter(e => e.workspace_root === REAL).length, 4);

    assert.ok(out.backup_path.startsWith(`${dbPath}.before-prune-`));
    assert.ok(fs.existsSync(out.backup_path));
    assert.deepEqual(dump(out.backup_path), before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
