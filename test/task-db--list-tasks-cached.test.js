'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'task-db-list-tasks-cached-'));
process.env.HOME = home;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

const taskDb = require('../lib/task-db');
const { DatabaseSync } = require('node:sqlite');

function openDb(t) {
  const dir = fs.mkdtempSync(path.join(home, 'db-'));
  const workspace = path.join(dir, 'workspace');
  const other = path.join(dir, 'other');
  fs.mkdirSync(workspace);
  fs.mkdirSync(other);
  const db = new DatabaseSync(path.join(dir, 'tasks.db'));
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      tag TEXT,
      workspace_root TEXT NOT NULL,
      source_key TEXT,
      claimed_by TEXT,
      claimed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      done_at INTEGER,
      metadata TEXT
    )
  `);
  t.after(() => {
    try { db.close(); } catch { /* already closed in the failure case */ }
  });
  return { db, workspace, other };
}

function insertTask(db, row) {
  const metadata = Object.prototype.hasOwnProperty.call(row, 'rawMetadata')
    ? row.rawMetadata
    : (row.metadata == null ? null : JSON.stringify(row.metadata));
  db.prepare(`
    INSERT INTO tasks (
      id, title, status, tag, workspace_root, source_key,
      claimed_by, claimed_at, created_at, updated_at, done_at, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id,
    row.title,
    row.status,
    row.tag ?? null,
    row.workspace_root,
    row.source_key ?? null,
    row.claimed_by ?? null,
    row.claimed_at ?? null,
    row.created_at,
    row.updated_at ?? row.created_at,
    row.done_at ?? null,
    metadata,
  );
}

function row(fields) {
  const item = {
    id: fields.id,
    title: fields.title,
    status: fields.status,
    tag: fields.tag ?? null,
    workspace_root: fields.workspace_root,
    source_key: fields.source_key ?? null,
    claimed_by: fields.claimed_by ?? null,
    claimed_at: fields.claimed_at ?? null,
    created_at: fields.created_at,
    updated_at: fields.updated_at ?? fields.created_at,
    done_at: fields.done_at ?? null,
    metadata: fields.metadata === undefined ? null : fields.metadata,
  };
  if (Object.prototype.hasOwnProperty.call(fields, 'rawMetadata')) item.rawMetadata = fields.rawMetadata;
  return item;
}

function storedRow(item) {
  const { rawMetadata, ...rest } = item;
  return rest;
}

// Fixed created_at integers. Status, then endgame, then newer created_at.
function seed(db, workspace, other) {
  const rows = [
    row({
      id: 'open-end',
      title: 'Ship the gate',
      status: 'open',
      tag: 'endgame',
      workspace_root: workspace,
      source_key: 'src-open-end',
      created_at: 1000,
      metadata: { verify: 'node --test test/task-db--list-tasks-cached.test.js' },
    }),
    row({
      id: 'open-new',
      title: 'Newer open job',
      status: 'open',
      tag: 'docs',
      workspace_root: workspace,
      created_at: 3000,
      metadata: { note: 'plain' },
    }),
    row({
      id: 'open-old',
      title: 'Older open job',
      status: 'open',
      workspace_root: workspace,
      created_at: 2000,
    }),
    row({
      id: 'claimed-end',
      title: 'Claimed endgame',
      status: 'claimed',
      tag: 'endgame',
      workspace_root: workspace,
      claimed_by: 'bea',
      claimed_at: 2500,
      created_at: 2500,
    }),
    row({
      id: 'claimed-plain',
      title: 'Claimed plain',
      status: 'claimed',
      workspace_root: workspace,
      claimed_by: 'ada',
      claimed_at: 5000,
      created_at: 5000,
    }),
    row({
      id: 'review-job',
      title: 'Review job',
      status: 'review',
      tag: 'endgame',
      workspace_root: workspace,
      created_at: 100,
    }),
    row({
      id: 'failed-bad',
      title: 'Broken notes',
      status: 'failed',
      workspace_root: workspace,
      created_at: 1500,
      metadata: null,
      rawMetadata: '{not-json',
    }),
    row({
      id: 'done-job',
      title: 'Done job',
      status: 'done',
      tag: 'endgame',
      workspace_root: workspace,
      created_at: 9000,
      done_at: 9100,
    }),
    row({
      id: 'other-open',
      title: 'Other workspace',
      status: 'open',
      tag: 'endgame',
      workspace_root: other,
      created_at: 99999,
      metadata: { elsewhere: true },
    }),
  ];
  for (const item of rows) insertTask(db, item);
  return rows.filter(item => item.workspace_root === workspace).map(storedRow);
}

test('listTasksCached returns one workspace in status, tag, and time order', (t) => {
  const { db, workspace, other } = openDb(t);
  const expected = seed(db, workspace, other);

  const listed = taskDb.listTasksCached(db, { workspaceRoot: workspace });
  assert.deepStrictEqual(listed, expected);
  assert.deepStrictEqual(listed.map(item => item.id), [
    'open-end',
    'open-new',
    'open-old',
    'claimed-end',
    'claimed-plain',
    'review-job',
    'failed-bad',
    'done-job',
  ]);
  assert.deepStrictEqual(listed[0].metadata, {
    verify: 'node --test test/task-db--list-tasks-cached.test.js',
  });
  const broken = db.prepare('SELECT metadata FROM tasks WHERE id = ?').get('failed-bad');
  assert.strictEqual(broken.metadata, '{not-json');
  assert.strictEqual(listed.find(item => item.id === 'failed-bad').metadata, null);
  assert.strictEqual(listed.find(item => item.id === 'done-job').done_at, 9100);
  assert.strictEqual(listed.some(item => item.id === 'other-open'), false);

  assert.deepStrictEqual(
    taskDb.listTasksCached(db, { workspaceRoot: workspace, status: 'review' }).map(item => item.id),
    ['review-job'],
  );
  assert.deepStrictEqual(
    taskDb.listTasksCached(db, { workspaceRoot: workspace, claimedBy: 'ada' }).map(item => item.title),
    ['Claimed plain'],
  );
  assert.deepStrictEqual(
    taskDb.listTasksCached(db, { workspaceRoot: workspace, limit: 2 }).map(item => item.id),
    ['open-end', 'open-new'],
  );
});

test('listTasksCached reuses the same rows until the database changes', (t) => {
  const { db, workspace, other } = openDb(t);
  seed(db, workspace, other);

  const first = taskDb.listTasksCached(db, { workspaceRoot: workspace });
  const again = taskDb.listTasksCached(db, { workspaceRoot: workspace });
  assert.strictEqual(again, first);
  assert.strictEqual(first.length, 8);

  // A missing limit and an explicit 0 share one cache key, and neither adds a LIMIT.
  const unlimited = taskDb.listTasksCached(db, { workspaceRoot: workspace, limit: 0 });
  assert.strictEqual(unlimited, first);

  const onlyFirst = taskDb.listTasksCached(db, { workspaceRoot: workspace, limit: 1 });
  assert.notStrictEqual(onlyFirst, first);
  assert.deepStrictEqual(onlyFirst.map(item => item.id), ['open-end']);

  insertTask(db, row({
    id: 'late-end',
    title: 'Late endgame',
    status: 'open',
    tag: 'endgame',
    workspace_root: workspace,
    created_at: 8000,
  }));

  const after = taskDb.listTasksCached(db, { workspaceRoot: workspace });
  assert.notStrictEqual(after, first);
  assert.deepStrictEqual(after.map(item => item.id), [
    'late-end',
    'open-end',
    'open-new',
    'open-old',
    'claimed-end',
    'claimed-plain',
    'review-job',
    'failed-bad',
    'done-job',
  ]);
  const onlyFirstAfter = taskDb.listTasksCached(db, { workspaceRoot: workspace, limit: 1 });
  assert.notStrictEqual(onlyFirstAfter, onlyFirst);
  assert.deepStrictEqual(onlyFirstAfter.map(item => item.id), ['late-end']);
});

test('listTasksCached returns an empty list when nothing matches and still reads when the stamp fails', (t) => {
  const { db, workspace, other } = openDb(t);
  insertTask(db, row({
    id: 'other-open',
    title: 'Other workspace',
    status: 'open',
    tag: 'endgame',
    workspace_root: other,
    created_at: 4000,
    metadata: { elsewhere: true },
  }));

  const none = taskDb.listTasksCached(db, { workspaceRoot: workspace });
  assert.deepStrictEqual(none, []);
  assert.strictEqual(taskDb.listTasksCached(db, { workspaceRoot: workspace }), none);

  const noArchived = taskDb.listTasksCached(db, { workspaceRoot: other, status: 'archived' });
  assert.deepStrictEqual(noArchived, []);
  assert.notStrictEqual(noArchived, none);

  const unstampable = {
    prepare(sql) {
      const text = String(sql);
      if (text.includes('data_version') || text.includes('total_changes')) {
        throw new Error('stamp unavailable');
      }
      return db.prepare(sql);
    },
  };
  const fallback = taskDb.listTasksCached(unstampable, { workspaceRoot: other });
  const fallbackAgain = taskDb.listTasksCached(unstampable, { workspaceRoot: other });
  assert.deepStrictEqual(fallback.map(item => item.id), ['other-open']);
  assert.deepStrictEqual(fallbackAgain, fallback);
  assert.notStrictEqual(fallbackAgain, fallback);

  db.close();
  assert.throws(() => taskDb.listTasksCached(db, { workspaceRoot: workspace }), Error);
});
