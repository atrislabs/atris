'use strict';

// loadPhoneView reads the real task db, the autoland policy, and the saved
// weekly targets for one workspace. These tests point it at a throwaway
// workspace under the system temp dir with a hand-built sqlite db.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadPhoneView } = require('../lib/gm-phone');
const { workspaceRoot } = require('../lib/task-db');

const HOUR = 60 * 60 * 1000;
// A fixed wednesday noon UTC: local time lands wednesday or early thursday
// in every zone, so a play "at" NOW is always inside its own local week.
const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);

// The loader can reach the home state dir when no targetsDir is passed, so
// HOME and the task db env var are pinned inside the temp dir for the run.
function useTempHome(t, dir) {
  const home = process.env.HOME;
  const tasksDb = process.env.ATRIS_TASKS_DB;
  process.env.HOME = dir;
  delete process.env.ATRIS_TASKS_DB;
  t.after(() => {
    if (home === undefined) delete process.env.HOME; else process.env.HOME = home;
    if (tasksDb === undefined) delete process.env.ATRIS_TASKS_DB; else process.env.ATRIS_TASKS_DB = tasksDb;
  });
}

// A temp dir carrying the markers workspaceRoot looks for, the realpathed
// workspace root, a written autoland policy, and an empty targets dir.
function makeWorkspace(t, { policy = { enabled: false } } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-gm-phone-view-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, '.atris', 'policy'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
  const ws = workspaceRoot(dir);
  fs.writeFileSync(path.join(ws, '.atris', 'policy', 'autoland.json'), `${JSON.stringify(policy)}\n`);
  useTempHome(t, dir);
  return { dir, ws, targetsDir: path.join(dir, 'gm-targets') };
}

// A throwaway task db with the real schema columns the loader reads.
function makeDb(ws, dbPath) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', tag TEXT,
      workspace_root TEXT NOT NULL, source_key TEXT, claimed_by TEXT, claimed_at INTEGER, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, done_at INTEGER, metadata TEXT);
    CREATE TABLE task_events (event_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, version INTEGER NOT NULL,
      workspace_root TEXT NOT NULL, actor TEXT, event_type TEXT NOT NULL, payload TEXT, created_at INTEGER NOT NULL);
  `);
  const insTask = db.prepare('INSERT INTO tasks (id, title, status, workspace_root, claimed_by, claimed_at, created_at, updated_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const insEvent = db.prepare('INSERT INTO task_events (event_id, task_id, version, workspace_root, actor, event_type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const versions = new Map();
  return {
    task: (id, title, status, claimedBy, claimedAt, at) =>
      insTask.run(id, title, status, ws, claimedBy, claimedAt, at, at, '{}'),
    // versions count up per task, like appendTaskEvent
    event: (id, taskId, actor, type, payload, at) => {
      const version = (versions.get(taskId) || 0) + 1;
      versions.set(taskId, version);
      insEvent.run(id, taskId, version, ws, actor, type, JSON.stringify(payload), at);
    },
    close: () => db.close(),
  };
}

test('loadPhoneView reads reviews, stuck claims, plays, and policy from the workspace', (t) => {
  const { dir, ws, targetsDir } = makeWorkspace(t, { policy: { enabled: true, enabled_by: 'owner' } });
  const db = makeDb(ws, path.join(dir, 'tasks.db'));
  // builder claimed one job and it was accepted half an hour later
  db.task('T-1', 'fix the login', 'done', 'builder', NOW - 30 * 60 * 1000, NOW - 30 * 60 * 1000);
  db.event('E-1', 'T-1', 'builder', 'claimed', {}, NOW - 30 * 60 * 1000);
  db.event('E-2', 'T-1', 'keshav', 'completed', { action: 'accepted' }, NOW);
  // nick's claim has not moved in 8h, so it reads as stuck
  db.task('T-2', 'stuck job', 'claimed', 'nick', NOW - 8 * HOUR, NOW - 8 * HOUR);
  db.event('E-3', 'T-2', 'nick', 'claimed', {}, NOW - 8 * HOUR);
  // scout's job sits in review, proof posted 2h ago
  db.task('T-3', 'review job', 'review', 'scout', NOW - 3 * HOUR, NOW - 3 * HOUR);
  db.event('E-4', 'T-3', 'scout', 'proof_ready', {}, NOW - 2 * HOUR);
  db.close();

  const view = loadPhoneView(ws, { now: NOW, dbPath: path.join(dir, 'tasks.db'), targetsDir });

  assert.equal(view.workspace_name, path.basename(ws));
  assert.equal(view.error, null);
  assert.equal(view.landed_this_week, 1);
  assert.equal(view.target, null);
  assert.deepEqual(view.target_default, { landed: 1, max_abandoned: 2, max_stuck: 0 });

  assert.equal(view.reviews.length, 1);
  assert.equal(view.reviews[0].task_id, 'T-3');
  assert.equal(view.reviews[0].title, 'review job');
  assert.equal(view.reviews[0].member, 'scout');
  assert.equal(view.reviews[0].age, '2h');
  assert.ok(typeof view.reviews[0].ref === 'string' && view.reviews[0].ref.length > 0);

  assert.equal(view.stuck.length, 1);
  assert.equal(view.stuck[0].task_id, 'T-2');
  assert.equal(view.stuck[0].member, 'nick');
  assert.equal(view.stuck[0].age, '8h');

  assert.equal(view.outcomes.length, 3);
  const landed = view.outcomes.find(o => o.kind === 'landed');
  assert.equal(landed.member, 'builder');
  assert.equal(landed.at, NOW);
  assert.equal(landed.landed_by, 'you');

  assert.equal(view.last_plays[0].member, 'builder');
  assert.equal(view.last_plays[0].play, 'landed');
  assert.equal(view.last_plays[0].title, 'fix the login');

  assert.deepEqual(view.roster.map(r => r.name), ['builder', 'nick']);
  assert.equal(view.roster[0].status, 'idle');
  assert.equal(view.roster[1].status, 'stuck 8h');

  assert.equal(view.policy.authorized, true);
  assert.equal(view.policy.accept_all, false);
});

test('loadPhoneView on a workspace with no task db reads as an empty board', (t) => {
  const { dir, ws, targetsDir } = makeWorkspace(t);
  const view = loadPhoneView(ws, { now: NOW, dbPath: path.join(dir, 'missing.db'), targetsDir });

  assert.equal(view.error, null);
  assert.equal(view.workspace_name, path.basename(ws));
  assert.deepEqual(view.reviews, []);
  assert.deepEqual(view.stuck, []);
  assert.deepEqual(view.outcomes, []);
  assert.deepEqual(view.roster, []);
  assert.deepEqual(view.last_plays, []);
  assert.equal(view.landed_this_week, 0);
  assert.equal(view.target, null);
  assert.equal(view.target_default.landed, 1);
  assert.equal(view.policy.authorized, false);
});

test('loadPhoneView reports a corrupt task db in error instead of throwing', (t) => {
  const { dir, ws, targetsDir } = makeWorkspace(t);
  const dbPath = path.join(dir, 'tasks.db');
  fs.writeFileSync(dbPath, 'this is not a sqlite database, just text that is long enough to fill a header page\n'.repeat(20));
  const view = loadPhoneView(ws, { now: NOW, dbPath, targetsDir });

  assert.equal(typeof view.error, 'string');
  assert.ok(view.error.length > 0);
  assert.deepEqual(view.outcomes, []);
  assert.deepEqual(view.reviews, []);
  assert.deepEqual(view.stuck, []);
  assert.equal(view.landed_this_week, 0);
  assert.equal(view.target, null);
  assert.equal(view.target_default, null);
});
