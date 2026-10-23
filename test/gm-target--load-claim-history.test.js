'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const { loadClaimHistory } = require('../lib/gm-target');

// No filesystem or home-directory access: each test owns an in-memory database.
function database(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE tasks (id TEXT PRIMARY KEY, workspace_root TEXT, status TEXT);
    CREATE TABLE task_events (
      task_id TEXT, workspace_root TEXT, event_type TEXT,
      actor TEXT, created_at INTEGER, version INTEGER
    );
  `);
  return db;
}

function event(db, task, workspace, type, actor, at, version) {
  db.prepare('INSERT INTO task_events VALUES (?, ?, ?, ?, ?, ?)')
    .run(task, workspace, type, actor, at, version);
  return Object.assign(Object.create(null), {
    task_id: task, event_type: type, actor, created_at: at, version,
  });
}

test('loads full histories for recent workspace tasks in task and version order', t => {
  const db = database(t);
  const since = Date.parse('2025-01-15T00:00:00Z');
  const later = event(db, 'b', 'workspace', 'completed', 'bea', since + 1, 2);
  const first = event(db, 'a', 'workspace', 'claimed', 'ada', since - 100, 1);
  const boundary = event(db, 'a', 'workspace', 'proof_ready', 'ada', since, 2);
  const earlier = event(db, 'b', 'workspace', 'claimed', 'bea', since - 200, 1);
  event(db, 'old', 'workspace', 'claimed', 'old', since - 1, 1);
  event(db, 'foreign', 'elsewhere', 'claimed', 'other', since + 1, 1);

  const history = loadClaimHistory(db, 'workspace', since);
  assert.ok(history instanceof Map);
  assert.deepStrictEqual([...history], [
    ['a', [first, boundary]],
    ['b', [earlier, later]],
  ]);
});

test('includes old currently claimed tasks and does not duplicate recent claims', t => {
  const db = database(t);
  const since = Date.parse('2025-01-15T00:00:00Z');
  const insert = db.prepare('INSERT INTO tasks VALUES (?, ?, ?)');
  insert.run('old', 'workspace', 'claimed');
  insert.run('recent', 'workspace', 'claimed');
  insert.run('released', 'workspace', 'open');
  insert.run('foreign', 'elsewhere', 'claimed');
  const old = event(db, 'old', 'workspace', 'claimed', null, since - 100, 1);
  const recent = event(db, 'recent', 'workspace', 'claimed', 'ada', since, 1);
  event(db, 'released', 'workspace', 'claim_released', 'bea', since - 1, 1);
  event(db, 'foreign', 'elsewhere', 'claimed', 'other', since - 1, 1);

  assert.deepStrictEqual([...loadClaimHistory(db, 'workspace', since)], [
    ['old', [old]],
    ['recent', [recent]],
  ]);
});

test('returns an empty map when no histories match', t => {
  const db = database(t);
  const since = Date.parse('2025-01-15T00:00:00Z');
  assert.deepStrictEqual(loadClaimHistory(db, 'workspace', since), new Map());
  event(db, 'foreign', 'elsewhere', 'claimed', 'other', since, 1);
  assert.deepStrictEqual(loadClaimHistory(db, 'workspace', since), new Map());
});

test('propagates database query errors', t => {
  const db = database(t);
  db.exec('DROP TABLE task_events');
  assert.throws(() => loadClaimHistory(db, 'workspace', 0), /no such table: task_events/);
});
