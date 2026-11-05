'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const taskDb = require('../lib/task-db');
const { stampAutoAcceptMetadata, stampAcceptGroupMetadata, stampCertifyVerifyMetadata, stampVerifyCacheMetadata, stampReadyVerifyMetadata } = require('../commands/task');

for (const kind of ['claim', 'ready', 'plan']) {
  test(`${kind} preserves corrupt task metadata and writes no event`, () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'task-corrupt-lifecycle-'));
    const db = taskDb.open(path.join(tmp, 'tasks.db'));
    try {
      // A real git HEAD exercises the claim's start-commit metadata stamp.
      execFileSync('git', ['init', '--quiet'], { cwd: tmp });
      execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'test'], { cwd: tmp });
      const { id } = taskDb.addTask(db, { title: 'task', workspaceRoot: tmp });
      db.prepare('UPDATE tasks SET metadata = ? WHERE id = ?').run('{broken', id);
      const out = kind === 'claim' ? taskDb.claimTask(db, { id, claimedBy: 'builder' })
        : kind === 'ready' ? taskDb.readyTask(db, { id, actor: 'builder', proof: 'proof' })
          : taskDb.stageTask(db, { id, actor: 'builder', stage: 'plan', goal: 'goal', exit: 'done', proofNeeded: 'test' });
      assert.equal(out.reason, 'metadata_unreadable');
      const stored = db.prepare('SELECT status, metadata FROM tasks WHERE id = ?').get(id);
      assert.equal(stored.status, 'open');
      assert.equal(stored.metadata, '{broken');
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM task_events WHERE task_id = ?').get(id).n, 1);
    } finally {
      taskDb.close(); fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
}

test('a stale landing stamp preserves a later result without undoing acceptance', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'task-stamp-atomic-'));
  const db = taskDb.open(path.join(tmp, 'tasks.db'));
  const other = new DatabaseSync(path.join(tmp, 'tasks.db'));
  try {
    const { id } = taskDb.addTask(db, { title: 'task', workspaceRoot: tmp });
    db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(id);
    const initial = taskDb.getTask(db, id);
    let intervened = false;
    const interposed = {
      ...taskDb,
      getTask(connection, taskId) {
        const row = taskDb.getTask(connection, taskId);
        if (!intervened) {
          intervened = true;
          assert.equal(taskDb.setTaskResult(other, { id, actor: 'other', result: 'important result' }).saved, true);
        }
        return row;
      },
    };
    const landing = stampAutoAcceptMetadata(interposed, db, initial, 'reviewer', 'policy');
    assert.equal(taskDb.getTask(db, id).metadata.result, 'important result');
    assert.equal(taskDb.getTask(db, id).status, 'done');
    assert.equal(landing.status, 'unverified');
    assert.equal(landing.reason, 'task_changed_during_landing_proof');
  } finally {
    other.close(); taskDb.close(); fs.rmSync(tmp, { recursive: true, force: true });
  }
});

for (const [name, stamp] of [
  ['accept group', (api, db, id) => stampAcceptGroupMetadata(api, db, id, { actor: 'reviewer', group: 'g', verified: true, sampleVerifiedIds: [] })],
  ['certify verify', (api, db, id) => stampCertifyVerifyMetadata(api, db, id, 'reviewer', 'node --test test/example.test.js')],
  ['verify cache', (api, db, id) => stampVerifyCacheMetadata(api, db, id, { actor: 'reviewer', verify: 'test', result: { ok: true, code_sha: 'abc' } })],
  ['ready verify', (api, db, id) => stampReadyVerifyMetadata(api, db, id, 'node --test test/example.test.js')],
]) {
  test(`${name} merges a result committed immediately before its write`, () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'task-stamp-merge-'));
    const db = taskDb.open(path.join(tmp, 'tasks.db'));
    const other = new DatabaseSync(path.join(tmp, 'tasks.db'));
    try {
      const { id } = taskDb.addTask(db, { title: 'task', workspaceRoot: tmp });
      const api = {
        ...taskDb,
        mutateTaskMetadata(connection, options) {
          assert.equal(taskDb.setTaskResult(other, { id, actor: 'other', result: 'important result' }).saved, true);
          return taskDb.mutateTaskMetadata(connection, options);
        },
      };
      stamp(api, db, id);
      assert.equal(taskDb.getTask(db, id).metadata.result, 'important result');
    } finally {
      other.close(); taskDb.close(); fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test(`${name} preserves unreadable task metadata`, () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'task-stamp-corrupt-'));
    const db = taskDb.open(path.join(tmp, 'tasks.db'));
    try {
      const { id } = taskDb.addTask(db, { title: 'task', workspaceRoot: tmp });
      db.prepare('UPDATE tasks SET metadata = ? WHERE id = ?').run('{broken', id);
      assert.throws(() => stamp(taskDb, db, id), /metadata_unreadable/);
      assert.equal(db.prepare('SELECT metadata FROM tasks WHERE id = ?').get(id).metadata, '{broken');
    } finally {
      taskDb.close(); fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
}

test('verify cache does not advance the task ordering timestamp', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'task-cache-order-'));
  const db = taskDb.open(path.join(tmp, 'tasks.db'));
  try {
    const { id } = taskDb.addTask(db, { title: 'task', workspaceRoot: tmp });
    const before = taskDb.getTask(db, id).updated_at;
    stampVerifyCacheMetadata(taskDb, db, id, { actor: 'reviewer', verify: 'test', result: { ok: true, code_sha: 'abc' } });
    const after = taskDb.getTask(db, id);
    assert.equal(after.updated_at, before);
    assert.equal(after.metadata.verify_cache.ok, true);
  } finally {
    taskDb.close(); fs.rmSync(tmp, { recursive: true, force: true });
  }
});

for (const kind of ['reopen', 'backlog', 'tag', 'chat', 'plan']) {
  test(`${kind} serializes a concurrent cache change without losing it`, () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'task-cache-cas-'));
    const db = taskDb.open(path.join(tmp, 'tasks.db'));
    const other = new DatabaseSync(path.join(tmp, 'tasks.db'));
    try {
      const { id } = taskDb.addTask(db, { title: 'task', workspaceRoot: tmp, tag: 'planned' });
      if (kind === 'reopen') db.prepare("UPDATE tasks SET status = 'failed' WHERE id = ?").run(id);
      let intervened = false;
      let blocked = false;
      const wrapped = {
        get isTransaction() { return db.isTransaction; },
        exec: db.exec.bind(db),
        prepare(sql) {
          const statement = db.prepare(sql);
          if (!intervened && /SELECT id, title, status, tag, workspace_root/.test(sql)) {
            return { get(...args) {
              const row = statement.get(...args);
              intervened = true;
              try {
                other.prepare("UPDATE tasks SET metadata = json_set(metadata, '$.verify_cache.ok', json('true')) WHERE id = ?").run(id);
              } catch (error) {
                if (!/locked|busy/i.test(String(error.message))) throw error;
                blocked = true;
              }
              return row;
            } };
          }
          return statement;
        },
      };
      const out = kind === 'reopen' ? taskDb.reopenTask(wrapped, { id, actor: 'test' })
        : kind === 'backlog' ? taskDb.backlogTask(wrapped, { id, actor: 'test' })
          : kind === 'tag' ? taskDb.tagTask(wrapped, { id, actor: 'test', add: ['one'] })
            : kind === 'chat' ? taskDb.chatTask(wrapped, { id, actor: 'test', goal: 'new goal' })
              : taskDb.stageTask(wrapped, { id, actor: 'test', stage: 'plan', goal: 'goal', exit: 'done', proofNeeded: 'test' });
      assert.equal(blocked, true);
      assert.equal(out[{ reopen: 'reopened', backlog: 'backlogged', tag: 'tagged', chat: 'chatted', plan: 'staged' }[kind]], true);
      taskDb.mutateTaskMetadata(other, {
        id, touch: false, mutate(metadata) { metadata.verify_cache = { ok: true }; },
      });
      assert.deepEqual(taskDb.getTask(db, id).metadata.verify_cache, { ok: true });
    } finally {
      other.close(); taskDb.close(); fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
}
