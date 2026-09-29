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
      uses: db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'part_uses'").get()
        ? db.prepare('SELECT * FROM part_uses ORDER BY id').all()
        : [],
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

// Review round one: location alone is not enough, history counts as
// activity, orphan history keeps the real-project guard, and deletes use the
// task-id index with transactions bounded by rows.

function libFixture() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-prune-lib-')));
  const dbPath = path.join(dir, 'tasks.db');
  const taskStore = require('../lib/task-db');
  const db = taskStore.open(dbPath);
  const old = Date.now() - 48 * HOUR;
  let seq = 0;
  const api = {
    dir,
    dbPath,
    old,
    task(id, root, at = old) {
      db.prepare(`INSERT INTO tasks (id, title, status, workspace_root, created_at, updated_at)
        VALUES (?, ?, 'open', ?, ?, ?)`).run(id, id, root, at, at);
    },
    event(taskId, root, at = old) {
      db.prepare(`INSERT INTO task_events (event_id, task_id, version, workspace_root, event_type, created_at)
        VALUES (?, ?, ?, ?, 'message', ?)`).run(`E${++seq}`, taskId, seq, root, at);
    },
    done() { taskStore.close(); },
    cleanup() { taskStore.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
  return api;
}

test('a temp-folder project that still exists on disk is never junk, in either /var spelling', () => {
  if (!hasNodeSqlite()) return;
  const prune = require('../lib/task-prune');
  const fx = libFixture();
  try {
    const live = path.join(fx.dir, 'live-worktree');
    fs.mkdirSync(live);
    const real = fs.realpathSync(live);
    const other = real.startsWith('/private/') ? real.slice('/private'.length) : `/private${real}`;
    fx.task('LIVE_REAL', real);
    fx.task('LIVE_OTHER', other);
    fx.task('GONE', path.join(fx.dir, 'removed-by-test'));
    fx.done();
    const plan = prune.dryRun(fx.dbPath);
    assert.equal(plan.remove.tasks, 1);
    assert.equal(plan.kept.folder_exists, fs.existsSync(other) ? 2 : 1);
    const out = prune.applyPrune(fx.dbPath);
    assert.equal(out.removed.tasks, 1);
    const left = dump(fx.dbPath).tasks.map(r => r.id);
    assert.ok(left.includes('LIVE_REAL'));
    assert.ok(left.includes('LIVE_OTHER'));
    assert.ok(!left.includes('GONE'));
  } finally {
    fx.cleanup();
  }
});

test('a custom TMPDIR counts as temp through its symlink and its real path', () => {
  const prune = require('../lib/task-prune');
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-prune-tmpdir-')));
  try {
    const realTmp = path.join(base, 'real-tmp');
    const link = path.join(base, 'link-tmp');
    fs.mkdirSync(realTmp);
    fs.symlinkSync(realTmp, link);
    // No named roots: only the custom TMPDIR decides.
    const viaLink = prune.tempRoots({ tmpdir: link, named: [] });
    assert.ok(prune.tempPrefixFor(path.join(realTmp, 'gone'), viaLink));
    assert.ok(prune.tempPrefixFor(path.join(link, 'gone'), viaLink));
    const viaReal = prune.tempRoots({ tmpdir: realTmp, named: [] });
    assert.ok(prune.tempPrefixFor(path.join(link, 'gone'), viaReal));
    assert.equal(prune.tempPrefixFor(path.join(base, 'elsewhere'), viaReal), null);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('new history counts as activity, and a note written after the backup keeps the task', () => {
  if (!hasNodeSqlite()) return;
  const prune = require('../lib/task-prune');
  const fx = libFixture();
  try {
    fx.task('FRESH_NOTE', path.join(fx.dir, 'gone-a'));
    fx.event('FRESH_NOTE', path.join(fx.dir, 'gone-a'), Date.now());
    fx.task('NOTED_LATER', path.join(fx.dir, 'gone-b'));
    fx.event('NOTED_LATER', path.join(fx.dir, 'gone-b'));
    fx.task('PLAIN', path.join(fx.dir, 'gone-c'));
    fx.done();
    const plan = prune.dryRun(fx.dbPath);
    assert.equal(plan.kept.recent, 1, 'a fresh history row makes the task recent');
    assert.equal(plan.remove.tasks, 2);

    const out = prune.applyPrune(fx.dbPath, {
      afterBackup() {
        // noteTask appends history without bumping tasks.updated_at.
        const taskStore = require('../lib/task-db');
        const db = taskStore.open(fx.dbPath);
        const noted = taskStore.noteTask(db, { id: 'NOTED_LATER', actor: 'live-agent', content: 'still working' });
        assert.equal(noted.noted, true);
        taskStore.close();
      },
    });
    assert.equal(out.removed.tasks, 1);
    assert.equal(out.skipped.changed_since_backup, 1);
    const after = dump(fx.dbPath);
    assert.deepEqual(after.tasks.map(r => r.id).sort(), ['FRESH_NOTE', 'NOTED_LATER']);
    assert.equal(after.events.filter(e => e.task_id === 'NOTED_LATER').length, 2);
  } finally {
    fx.cleanup();
  }
});

test('history of a missing task stays whole when any of it names a real project', () => {
  if (!hasNodeSqlite()) return;
  const prune = require('../lib/task-prune');
  const fx = libFixture();
  try {
    fx.task('ANCHOR', REAL);
    fx.event('MIXED', path.join(fx.dir, 'gone-x'));
    fx.event('MIXED', REAL);
    fx.event('ONLY_TEMP', path.join(fx.dir, 'gone-y'));
    fx.done();
    const plan = prune.dryRun(fx.dbPath);
    assert.equal(plan.remove.stray_history_rows, 1);
    assert.equal(plan.kept.stray_held, 1);
    prune.applyPrune(fx.dbPath);
    const left = dump(fx.dbPath).events.map(e => e.task_id).sort();
    assert.deepEqual(left, ['MIXED', 'MIXED']);
  } finally {
    fx.cleanup();
  }
});

test('deletes look up history by task id, and each transaction is bounded by rows', () => {
  if (!hasNodeSqlite()) return;
  const prune = require('../lib/task-prune');
  const { DatabaseSync } = require('node:sqlite');
  const fx = libFixture();
  try {
    for (let i = 0; i < 6; i++) {
      fx.task(`T${i}`, path.join(fx.dir, `gone-${i}`));
      fx.event(`T${i}`, path.join(fx.dir, `gone-${i}`));
      fx.event(`T${i}`, path.join(fx.dir, `gone-${i}`));
    }
    fx.event('ORPHAN', path.join(fx.dir, 'gone-orphan'));
    fx.done();
    // A database that lost the task-id index gets the house index back.
    const raw = new DatabaseSync(fx.dbPath);
    raw.exec('DROP INDEX idx_task_events_task');
    raw.close();

    const out = prune.applyPrune(fx.dbPath, { maxRowsPerBatch: 4 });
    assert.equal(out.removed.tasks, 6);
    assert.equal(out.removed.history_rows, 12);
    assert.equal(out.removed.stray_history_rows, 1);
    // 6 tasks x 3 rows each plus 1 orphan row, at most 4 rows per batch:
    // one task per batch, and the orphan row rides with the last task.
    assert.equal(out.batches, 6);

    const check = new DatabaseSync(fx.dbPath, { readOnly: true });
    try {
      for (const sql of Object.values(prune.EVENT_SQL)) {
        const plan = check.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('x').map(r => r.detail).join(' | ');
        assert.match(plan, /idx_task_events_task/, `${sql} -> ${plan}`);
        assert.doesNotMatch(plan, /idx_task_events_ws/);
      }
    } finally {
      check.close();
    }
  } finally {
    fx.cleanup();
  }
});
