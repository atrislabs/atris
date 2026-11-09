'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const taskDb = require('../lib/task-db');
const { hasNodeSqlite, makeTempDir, cleanupTempDir, runCli, taskEnv } = require('./helpers/task-next-fixture');

function room() {
  const dir = makeTempDir('agent-next-cli-');
  const root = path.join(dir, 'room');
  fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
  fs.writeFileSync(path.join(root, 'atris', 'atris.md'), '# protocol\n');
  const env = taskEnv(dir);
  const db = taskDb.open(env.ATRIS_TASKS_DB);
  const workspaceRoot = taskDb.workspaceRoot(root);
  const add = (values) => taskDb.addTask(db, { workspaceRoot, ...values });
  const cli = (args, extra = {}) => {
    const result = runCli(args, { cwd: root, env: { ...env, ...extra } });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  };
  const snapshot = () => ({
    tasks: db.prepare('SELECT id, status, claimed_by FROM tasks ORDER BY id').all(),
    events: db.prepare('SELECT task_id, version, event_type FROM task_events ORDER BY task_id, version').all(),
  });
  return { dir, root, env, db, add, cli, snapshot, close() { taskDb.close(); cleanupTempDir(dir); } };
}

function commandRef(command) {
  const match = command.match(/^atris task (?:page|claim|accept) (\S+)/);
  assert.ok(match, `unexpected command: ${command}`);
  return match[1];
}

function checkActor(payload) {
  assert.deepEqual(payload.actor, { kind: 'agent', member: 'builder' });
  assert.ok(Array.isArray(payload.human_pending));
  assert.ok(payload.context && typeof payload.context === 'object');
}

const sqlite = { skip: !hasNodeSqlite() };

test('agent next keeps certified review pending and points all aliases at the unchecked assigned task without writes', sqlite, () => {
  const c = room();
  try {
    const review = c.add({ title: 'Await human acceptance', status: 'review', claimedBy: 'builder', metadata: { agent_certified: true, agent_review_pass_count: 2 } });
    const work = c.add({ title: 'Build the next feature', status: 'open', metadata: { assigned_to: 'builder' } });
    const before = c.snapshot();
    const task = c.cli(['task', 'next', '--agent', 'builder', '--json']);
    checkActor(task);
    assert.equal(task.action, 'plan');
    assert.equal(task.task_id, work.id);
    assert.match(task.command, /^atris task page \S+ --json$/);
    assert.ok(task.needs.includes('runnable_check'));
    assert.ok(task.human_pending.some(item => item.task_id === review.id));
    const now = c.cli(['now', '--agent', 'builder', '--json']);
    const next = c.cli(['next', '--agent', 'builder', '--json']);
    for (const alias of [now, next]) {
      checkActor(alias);
      for (const key of ['action', 'task_id', 'human_pending', 'needs']) assert.deepEqual(alias[key], task[key]);
    }
    assert.equal(now.next, task.command);
    assert.equal(next.next_action, task.command);
    assert.equal(c.cli(['task', 'show', commandRef(task.command), '--json']).id, work.id);
    assert.deepEqual(c.snapshot(), before);
    const createNext = c.cli(['task', 'next', '--agent', 'builder', '--create-next', '--json']);
    assert.equal(createNext.task_id, work.id);
    assert.deepEqual(c.snapshot(), before);
  } finally { c.close(); }
});

test('a real plan and claim advance from plan to claim to continue without next changing state', sqlite, () => {
  const c = room();
  try {
    const work = c.add({ title: 'Build a checked feature', status: 'open', metadata: { assigned_to: 'builder' } });
    const initial = c.cli(['task', 'next', '--agent', 'builder', '--json']);
    const ref = commandRef(initial.command);
    assert.equal(initial.action, 'plan');
    c.cli(['task', 'plan', ref, '--as', 'builder', '--goal', 'Build a checked feature', '--summary', 'Inspect and implement the feature', '--exit', 'Feature is working', '--first-move', 'Inspect the code', '--proof-needed', 'node --test test/feature.test.js', '--json']);
    let before = c.snapshot();
    const planned = c.cli(['task', 'next', '--agent', 'builder', '--json']);
    assert.equal(planned.task_id, work.id);
    assert.equal(planned.action, 'claim');
    assert.match(planned.command, /^atris task claim \S+/);
    assert.equal(c.cli(['task', 'show', commandRef(planned.command), '--json']).id, work.id);
    assert.deepEqual(c.snapshot(), before);
    c.cli(['task', 'claim', ref, '--as', 'builder', '--json']);
    before = c.snapshot();
    const claimed = c.cli(['task', 'next', '--agent', 'builder', '--json']);
    assert.equal(claimed.task_id, work.id);
    assert.equal(claimed.action, 'continue');
    assert.equal(c.cli(['task', 'show', commandRef(claimed.command), '--json']).id, work.id);
    assert.deepEqual(c.snapshot(), before);
  } finally { c.close(); }
});

test('worker markers use builder and --human restores the default human result', sqlite, () => {
  const c = room();
  try {
    c.add({ title: 'Human decision', status: 'review', metadata: { agent_certified: true, agent_review_pass_count: 2 } });
    c.add({ title: 'Builder work', status: 'open', metadata: { assigned_to: 'builder' } });
    const human = c.cli(['task', 'next', '--json']);
    const automatic = c.cli(['task', 'next', '--json'], { CODEX_SANDBOX: '1' });
    checkActor(automatic);
    assert.equal(automatic.action, 'plan');
    const forced = c.cli(['task', 'next', '--human', '--json'], { CODEX_SANDBOX: '1' });
    for (const key of ['command', 'action', 'task_id']) assert.deepEqual(forced[key], human[key]);
    assert.equal(c.cli(['task', 'show', commandRef(forced.command), '--json']).status, 'review');
  } finally { c.close(); }
});

test('an agent named yes does not trigger the legacy yes action', sqlite, () => {
  const c = room();
  try {
    const work = c.add({ title: 'Work for yes', status: 'open', metadata: { assigned_to: 'yes' } });
    const before = c.snapshot();
    const result = c.cli(['next', '--agent', 'yes', '--json']);
    assert.deepEqual(result.actor, { kind: 'agent', member: 'yes' });
    assert.equal(result.task_id, work.id);
    assert.equal(result.action, 'plan');
    assert.deepEqual(c.snapshot(), before);
  } finally { c.close(); }
});

test('agent skips other owners and protected work', sqlite, () => {
  const c = room();
  try {
    c.add({ title: 'Other member open', status: 'open', metadata: { assigned_to: 'other' } });
    c.add({ title: 'Other member claimed', status: 'claimed', claimedBy: 'other', metadata: { verify: 'node --test' } });
    c.add({ title: 'Protected billing work', tag: 'billing', status: 'open', metadata: { assigned_to: 'builder' } });
    const eligible = c.add({ title: 'Safe assigned work', status: 'open', metadata: { assigned_to: 'builder' } });
    const result = c.cli(['task', 'next', '--agent', 'builder', '--json']);
    assert.equal(result.task_id, eligible.id);
    assert.equal(result.action, 'plan');
  } finally { c.close(); }
});

test('finds older assigned work behind more than 200 foreign open tasks', sqlite, () => {
  const c = room();
  try {
    const eligible = c.add({ title: 'Older builder work', status: 'open', metadata: { assigned_to: 'builder' } });
    c.db.prepare('UPDATE tasks SET created_at = 1 WHERE id = ?').run(eligible.id);
    for (let i = 0; i < 205; i++) {
      const foreign = c.add({ title: `Foreign job ${i}`, status: 'open', metadata: { assigned_to: 'other' } });
      c.db.prepare('UPDATE tasks SET created_at = ? WHERE id = ?').run(i + 2, foreign.id);
    }
    const before = c.snapshot();
    const result = c.cli(['task', 'next', '--agent', 'builder', '--json']);
    assert.equal(result.task_id, eligible.id);
    assert.equal(c.cli(['task', 'show', commandRef(result.command), '--json']).id, eligible.id);
    assert.deepEqual(c.snapshot(), before);
  } finally { c.close(); }
});

test('a fresh read-only agent look does not create a task database', sqlite, () => {
  const dir = makeTempDir('agent-next-empty-');
  try {
    const root = path.join(dir, 'room');
    fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(root, 'atris', 'atris.md'), '# protocol\n');
    const env = taskEnv(dir);
    const result = runCli(['task', 'next', '--agent', 'builder', '--json'], { cwd: root, env });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    checkActor(JSON.parse(result.stdout));
    assert.equal(fs.existsSync(env.ATRIS_TASKS_DB), false);
  } finally { cleanupTempDir(dir); }
});

test('worker thread and session callers remain unable to accept even after requesting a human view', sqlite, () => {
  const c = room();
  try {
    const review = c.add({ title: 'Keep this result pending', status: 'review', metadata: { agent_certified: true, agent_review_pass_count: 2 } });
    const before = c.snapshot();
    for (const marker of ['CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_SANDBOX']) {
      const extra = { [marker]: 'worker-session' };
      const human = c.cli(['task', 'next', '--human', '--json'], extra);
      assert.match(human.command, /^atris task accept /);
      const result = runCli(['task', 'accept', review.id, '--as', 'operator', '--json'], {
        cwd: c.root, env: { ...c.env, ...extra },
      });
      assert.notEqual(result.status, 0);
      assert.equal(JSON.parse(result.stdout).reason, 'agent_proof_only_human_accept_blocked');
      assert.deepEqual(c.snapshot(), before);
    }
  } finally { c.close(); }
});

test('all agent entry points reuse the same goal and status scope', sqlite, () => {
  const c = room();
  try {
    c.add({ title: 'Work in another goal', tag: 'no', metadata: { assigned_to: 'builder', goal_id: 'other-goal' } });
    const work = c.add({ title: 'Work in this goal', tag: 'no', metadata: { assigned_to: 'builder', goal_id: 'this-goal' } });
    const before = c.snapshot();
    const args = ['--agent', 'builder', '--goal-id=this-goal', '--status', 'open', '--tag', 'no', '--json'];
    const task = c.cli(['task', 'next', ...args]);
    const now = c.cli(['now', ...args]);
    const next = c.cli(['next', ...args]);
    for (const result of [task, now, next]) {
      assert.equal(result.task_id, work.id);
      assert.equal(result.action, 'plan');
      assert.equal(result.scope.goal_id, 'this-goal');
    }
    assert.equal(now.next, task.command);
    assert.equal(next.next_action, task.command);
    assert.deepEqual(c.snapshot(), before);
  } finally { c.close(); }
});

test('a finished display reference stays bound outside the recent outcome window', sqlite, () => {
  const c = room();
  try {
    const done = c.add({ title: 'Earlier finished task', status: 'done' });
    c.db.prepare('UPDATE tasks SET created_at = 1, updated_at = 1 WHERE id = ?').run(done.id);
    for (let i = 0; i < 5; i++) c.add({ title: 'More recent result ' + i, status: 'done' });
    c.add({ title: 'Different open work', metadata: { assigned_to: 'builder' } });
    const ref = c.cli(['task', 'show', done.id, '--json']).display_id;
    const before = c.snapshot();
    const result = c.cli(['task', 'next', '--agent', 'builder', '--task', ref, '--json']);
    assert.equal(result.action, 'blocked');
    assert.equal(result.task_id, done.id);
    assert.equal(c.cli(['task', 'show', commandRef(result.command), '--json']).id, done.id);
    assert.deepEqual(c.snapshot(), before);
  } finally { c.close(); }
});

test('review recommendations use complete prior claims and built-with history', sqlite, () => {
  for (const history of ['claim', 'built-with']) {
    const c = room();
    try {
      const work = c.add({ title: 'Review the saved note repair', metadata: { assigned_to: 'builder' } });
      if (history === 'claim') {
        assert.equal(taskDb.claimTask(c.db, { id: work.id, claimedBy: 'Codex_Review' }).claimed, true);
        assert.equal(taskDb.releaseTask(c.db, { id: work.id, actor: 'Codex_Review' }).released, true);
      }
      assert.equal(taskDb.claimTask(c.db, { id: work.id, claimedBy: 'builder' }).claimed, true);
      const handIn = (builtWith = []) => taskDb.readyTask(c.db, {
        id: work.id, actor: 'builder', builtWith,
        proof: 'commit 0123456789012345678901234567890123456789: isolated fixture evidence passed with exit 0',
        result: 'The note can be read, so the saved text can be recovered.',
      });
      assert.equal(handIn(history === 'built-with' ? ['Codex_Review'] : []).ready, true);
      if (history === 'built-with') {
        assert.equal(taskDb.reviseTask(c.db, { id: work.id, actor: 'operator', note: 'Revise the note repair' }).revised, true);
        if (taskDb.getTask(c.db, work.id).status === 'open') {
          assert.equal(taskDb.claimTask(c.db, { id: work.id, claimedBy: 'builder' }).claimed, true);
        }
        assert.equal(handIn().ready, true);
      }
      const before = c.snapshot();
      const contributor = c.cli(['task', 'next', '--agent', 'codex-review', '--json']);
      assert.notEqual(contributor.action, 'review', history);
      const independent = c.cli(['task', 'next', '--agent', 'validator', '--json']);
      assert.equal(independent.action, 'review', history);
      assert.equal(independent.task_id, work.id);
      assert.deepEqual(c.snapshot(), before);
    } finally { c.close(); }
  }
});

test('an oversized saved projection remains a bounded read-only discovery response', sqlite, () => {
  const c = room();
  try {
    const huge = 'x'.repeat(50000);
    const row = { id: 'PROJECTED1', display_id: 'ROOM-1', title: 'Inspect saved evidence', status: huge, claimed_by: huge, metadata: { assigned_to: huge } };
    const file = path.join(c.root, '.atris', 'state', 'tasks.projection.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const saved = JSON.stringify({ generated_at: new Date().toISOString(), workspace_root: c.root, tasks: [row] });
    fs.writeFileSync(file, saved);
    const before = c.snapshot();
    const result = runCli(['next', '--agent', 'builder', '--task', row.id, '--json'], { cwd: c.root, env: c.env });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(Buffer.byteLength(result.stdout) <= 16000);
    const value = JSON.parse(result.stdout);
    assert.equal(value.action, 'discover');
    assert.equal(value.command, null);
    assert.ok(value.task.claimed_by === null);
    assert.ok(value.task.assigned_to === null);
    assert.ok(value.task.status === null);
    assert.equal(fs.readFileSync(file, 'utf8'), saved);
    assert.deepEqual(c.snapshot(), before);
  } finally { c.close(); }
});

test('legacy first-proof authors remain excluded when no current builder is stamped', sqlite, () => {
  const c = room();
  try {
    const work = c.add({ title: 'Legacy note result', status: 'review' });
    const note = taskDb.noteTask(c.db, { id: work.id, actor: 'Codex_Review', content: 'Legacy hand-in' });
    assert.equal(note.noted, true);
    c.db.prepare("UPDATE task_events SET event_type = 'proof_ready', payload = '{}' WHERE task_id = ? AND version = ?")
      .run(work.id, note.event.version);
    const before = c.snapshot();
    assert.notEqual(c.cli(['task', 'next', '--agent', 'codex-review', '--json']).action, 'review');
    assert.equal(c.cli(['task', 'next', '--agent', 'validator', '--json']).action, 'review');
    assert.deepEqual(c.snapshot(), before);
  } finally { c.close(); }
});
