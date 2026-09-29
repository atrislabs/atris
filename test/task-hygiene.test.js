'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const taskStore = require('../lib/task-db');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function makeWorkspace() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-task-hygiene-')));
  fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
  fs.mkdirSync(path.join(root, '.atris', 'state'), { recursive: true });
  return root;
}

function runCli(args, { cwd, env }) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 30000,
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

function addBlocker(db, root, { missionId, status = 'open', blockerClass = 'runner-failed', tag = 'mission-blocker' }) {
  return taskStore.addTask(db, {
    title: `unblock ${missionId}`,
    tag,
    workspaceRoot: root,
    status,
    claimedBy: status === 'claimed' || status === 'review' ? 'worker' : null,
    metadata: {
      mission_id: missionId,
      mission_blocker_class: blockerClass,
      verify: 'node --test test/self-drive.test.js',
    },
  }).id;
}

test('task creation marks missing and diff-only verification as degraded', () => {
  const root = makeWorkspace();
  const dbPath = path.join(root, 'tasks.db');
  try {
    const db = taskStore.open(dbPath);
    const missingId = taskStore.addTask(db, {
      title: 'missing verifier',
      workspaceRoot: root,
      sourceKey: 'creation-gate:missing',
    }).id;
    const diffOnlyId = taskStore.addTask(db, {
      title: 'diff-only verifier',
      workspaceRoot: root,
      metadata: { verify: '  git diff --check  ' },
    }).id;
    const strongId = taskStore.addTask(db, {
      title: 'runnable verifier',
      workspaceRoot: root,
      metadata: { verify: 'node --test test/self-drive.test.js' },
    }).id;

    assert.deepEqual(
      [taskStore.getTask(db, missingId).metadata.verification_status, taskStore.getTask(db, missingId).metadata.verification_degraded_reason],
      ['degraded', 'missing_verify'],
    );
    assert.deepEqual(
      [taskStore.getTask(db, diffOnlyId).metadata.verification_status, taskStore.getTask(db, diffOnlyId).metadata.verification_degraded_reason],
      ['degraded', 'diff_only_verify'],
    );
    assert.equal(taskStore.getTask(db, strongId).metadata.verification_status, undefined);

    const duplicate = taskStore.addTask(db, {
      title: 'same source with a later verifier',
      workspaceRoot: root,
      sourceKey: 'creation-gate:missing',
      metadata: { verify: 'npm test' },
    });
    assert.equal(duplicate.inserted, false);
    assert.equal(taskStore.getTask(db, missingId).metadata.verification_degraded_reason, 'missing_verify');
  } finally {
    taskStore.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('task add exposes degraded verification and accepts a runnable verifier', () => {
  const root = makeWorkspace();
  const env = { ATRIS_TASKS_DB: path.join(root, 'tasks.db'), ATRIS_AGENT_PROOF_ONLY: '0' };
  try {
    const degraded = runCli(['task', 'add', 'task without a check', '--json'], { cwd: root, env });
    assert.equal(degraded.status, 0, degraded.stderr);
    const degradedTask = JSON.parse(degraded.stdout).task;
    const shownDegraded = runCli(['task', 'show', degradedTask.display_id, '--json'], { cwd: root, env });
    assert.equal(shownDegraded.status, 0, shownDegraded.stderr);
    assert.equal(JSON.parse(shownDegraded.stdout).metadata.verification_status, 'degraded');
    assert.equal(JSON.parse(shownDegraded.stdout).metadata.verification_degraded_reason, 'missing_verify');
    const shownText = runCli(['task', 'show', degradedTask.display_id], { cwd: root, env });
    assert.equal(shownText.status, 0, shownText.stderr);
    assert.match(shownText.stdout, /verification: degraded \(missing verify command\)/);

    const verified = runCli([
      'task', 'add', 'task with a real check', '--verify', 'node --test test/self-drive.test.js', '--json',
    ], { cwd: root, env });
    assert.equal(verified.status, 0, verified.stderr);
    const verifiedTask = JSON.parse(verified.stdout).task;
    assert.equal(verifiedTask.metadata.verify, 'node --test test/self-drive.test.js');
    assert.equal(verifiedTask.metadata.verification_status, undefined);
  } finally {
    taskStore.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('task ready --verify clears the creation-time degraded flag', () => {
  const root = makeWorkspace();
  const env = { ATRIS_TASKS_DB: path.join(root, 'tasks.db'), ATRIS_AGENT_PROOF_ONLY: '0' };
  try {
    fs.mkdirSync(path.join(root, 'test'), { recursive: true });
    fs.writeFileSync(path.join(root, 'test', 'ok.test.js'), "const t = require('node:test'); t('ok', () => {});\n", 'utf8');

    const added = runCli(['task', 'add', 'task without a check', '--json'], { cwd: root, env });
    assert.equal(added.status, 0, added.stderr);
    const addedTask = JSON.parse(added.stdout).task;
    const shownBeforeJson = runCli(['task', 'show', addedTask.display_id, '--json'], { cwd: root, env });
    assert.equal(shownBeforeJson.status, 0, shownBeforeJson.stderr);
    assert.equal(JSON.parse(shownBeforeJson.stdout).metadata.verification_status, 'degraded');
    const shownBefore = runCli(['task', 'show', addedTask.display_id], { cwd: root, env });
    assert.equal(shownBefore.status, 0, shownBefore.stderr);
    assert.match(shownBefore.stdout, /verification: degraded \(missing verify command\)/);

    const ready = runCli([
      'task', 'ready', addedTask.display_id,
      '--verify', 'node --test test/ok.test.js',
      '--result', 'the task now shows a real check instead of a stale warning.',
      '--json',
    ], { cwd: root, env });
    assert.equal(ready.status, 0, ready.stderr);

    const shownAfter = runCli(['task', 'show', addedTask.display_id, '--json'], { cwd: root, env });
    assert.equal(shownAfter.status, 0, shownAfter.stderr);
    const shownTask = JSON.parse(shownAfter.stdout);
    assert.equal(shownTask.metadata.verify, 'node --test test/ok.test.js');
    assert.equal(shownTask.metadata.verification_status, undefined);
    assert.equal(shownTask.metadata.verification_degraded_reason, undefined);
    const shownText = runCli(['task', 'show', addedTask.display_id], { cwd: root, env });
    assert.equal(shownText.status, 0, shownText.stderr);
    assert.doesNotMatch(shownText.stdout, /verification: degraded/);
  } finally {
    taskStore.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('task reaper closes blocker rows for complete and stopped missions only', () => {
  const root = makeWorkspace();
  const dbPath = path.join(root, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, ATRIS_AGENT_PROOF_ONLY: '0', ATRIS_AGENT_ID: 'reaper-test' };
  try {
    fs.writeFileSync(path.join(root, '.atris', 'state', 'missions.jsonl'), [
      JSON.stringify({ id: 'mission-complete', objective: 'complete work', status: 'complete', updated_at: '2026-08-02T10:00:00.000Z' }),
      JSON.stringify({ id: 'mission-stopped', objective: 'stopped work', status: 'stopped', updated_at: '2026-08-02T10:01:00.000Z' }),
      JSON.stringify({ id: 'mission-active', objective: 'active work', status: 'active', updated_at: '2026-08-02T10:02:00.000Z' }),
    ].join('\n') + '\n', 'utf8');

    const db = taskStore.open(dbPath);
    const completeOpen = addBlocker(db, root, { missionId: 'mission-complete' });
    const completeReview = addBlocker(db, root, { missionId: 'mission-complete', status: 'review', blockerClass: 'review-stuck' });
    const stoppedClaimed = addBlocker(db, root, { missionId: 'mission-stopped', status: 'claimed' });
    const activeOpen = addBlocker(db, root, { missionId: 'mission-active' });
    const regularOpen = addBlocker(db, root, { missionId: 'mission-complete', tag: 'feature', blockerClass: 'not-a-blocker' });
    taskStore.close();

    const first = runCli(['task', 'reap-mission-blockers', '--json'], { cwd: root, env });
    assert.equal(first.status, 0, first.stderr);
    const payload = JSON.parse(first.stdout);
    assert.equal(payload.action, 'reaped_mission_blockers');
    assert.equal(payload.closed_count, 3);
    assert.deepEqual(new Set(payload.closed.map(row => row.mission_status)), new Set(['complete', 'stopped']));
    assert.ok(payload.closed.every(row => /^[A-Z0-9]{2,4}-\d+$/.test(row.task_ref)), JSON.stringify(payload.closed));

    const checkedDb = taskStore.open(dbPath);
    assert.equal(taskStore.getTask(checkedDb, completeOpen).status, 'archived');
    assert.equal(taskStore.getTask(checkedDb, completeReview).status, 'archived');
    assert.equal(taskStore.getTask(checkedDb, stoppedClaimed).status, 'archived');
    assert.equal(taskStore.getTask(checkedDb, activeOpen).status, 'open');
    assert.equal(taskStore.getTask(checkedDb, regularOpen).status, 'open');
    const events = taskStore.listTaskEvents(checkedDb, { taskId: completeReview });
    assert.equal(events.at(-1).event_type, 'archived');
    assert.equal(events.at(-1).payload.reason, 'mission mission-complete is complete');
    assert.equal(taskStore.getTask(checkedDb, completeReview).metadata.archived_reason, 'mission mission-complete is complete');
    taskStore.close();

    const second = runCli(['task', 'reap-mission-blockers', '--json'], { cwd: root, env });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(JSON.parse(second.stdout).closed_count, 0);
  } finally {
    taskStore.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('task reap-stale-claims releases only silent loop claims; recent notes, persons, and dry run leave rows alone', () => {
  const root = makeWorkspace();
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  const dbPath = path.join(root, 'tasks.db');
  const env = { HOME: home, ATRIS_TASKS_DB: dbPath, ATRIS_AGENT_PROOF_ONLY: '0', ATRIS_AGENT_ID: 'reaper-test' };
  try {
    let db = taskStore.open(dbPath);
    const add = title => taskStore.addTask(db, { title, workspaceRoot: root }).id;
    const idleLoop = add('idle loop claim');
    const idleFleet = add('idle fleet claim');
    const idleButNoted = add('idle loop claim with a recent note');
    const idlePerson = add('idle person claim');
    const freshLoop = add('fresh loop claim');
    taskStore.close();

    const claim = (id, as) => {
      const r = runCli(['task', 'claim', id, '--as', as, '--json'], { cwd: root, env });
      assert.equal(r.status, 0, r.stderr || r.stdout);
    };
    claim(idleLoop, 'atris');
    claim(idleFleet, 'fleet-codex');
    claim(idleButNoted, 'atris');
    claim(idlePerson, 'keshavrao');
    claim(freshLoop, 'atris');

    db = taskStore.open(dbPath);
    const age = (id, days) => {
      const ts = Date.now() - days * 86400000;
      db.prepare('UPDATE tasks SET claimed_at = ?, updated_at = ? WHERE id = ?').run(ts, ts, id);
      db.prepare('UPDATE task_events SET created_at = ? WHERE task_id = ?').run(ts, id);
    };
    age(idleLoop, 20);
    age(idleFleet, 15);
    age(idleButNoted, 20);
    age(idlePerson, 30);
    age(freshLoop, 1);
    // A note is history, not a row update: it still counts as a sign of life.
    taskStore.noteTask(db, { id: idleButNoted, actor: 'atris', content: 'still working on it' });
    const before = JSON.stringify(db.prepare('SELECT * FROM tasks ORDER BY id').all());
    const eventsBefore = db.prepare('SELECT COUNT(*) AS n FROM task_events').get().n;
    taskStore.close();

    const dry = runCli(['task', 'reap-stale-claims', '--older-than', '14', '--json'], { cwd: root, env });
    assert.equal(dry.status, 0, dry.stderr);
    const dryPayload = JSON.parse(dry.stdout);
    assert.equal(dryPayload.dry_run, true);
    assert.deepEqual(dryPayload.sample.map(s => s.id).sort(), [idleLoop, idleFleet].sort());
    assert.equal(dryPayload.skipped_person_count, 1);
    assert.equal(dryPayload.skipped_person_sample[0].id, idlePerson);

    db = taskStore.open(dbPath);
    assert.equal(JSON.stringify(db.prepare('SELECT * FROM tasks ORDER BY id').all()), before);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM task_events').get().n, eventsBefore);
    taskStore.close();

    const apply = runCli(['task', 'reap-stale-claims', '--older-than', '14', '--apply', '--json'], { cwd: root, env });
    assert.equal(apply.status, 0, apply.stderr);
    const applyPayload = JSON.parse(apply.stdout);
    assert.equal(applyPayload.dry_run, false);
    assert.deepEqual(applyPayload.ids.slice().sort(), [idleLoop, idleFleet].sort());

    db = taskStore.open(dbPath);
    for (const id of [idleLoop, idleFleet]) {
      const row = taskStore.getTask(db, id);
      assert.equal(row.status, 'open');
      assert.equal(row.claimed_by, null);
      const events = taskStore.listTaskEvents(db, { taskId: id });
      assert.ok(events.some(e => e.event_type === 'claim_reaped'));
      assert.ok(events.some(e => e.event_type === 'message' && /stale claim released/.test((e.payload && e.payload.content) || '')));
    }
    for (const id of [idleButNoted, idlePerson, freshLoop]) {
      assert.equal(taskStore.getTask(db, id).status, 'claimed', id);
    }
    taskStore.close();

    const persons = runCli(['task', 'reap-stale-claims', '--older-than', '14', '--apply', '--include-persons', '--json'], { cwd: root, env });
    assert.equal(persons.status, 0, persons.stderr);
    assert.deepEqual(JSON.parse(persons.stdout).ids, [idlePerson]);

    const again = runCli(['task', 'reap-stale-claims', '--older-than', '14', '--json'], { cwd: root, env });
    assert.equal(JSON.parse(again.stdout).count, 0);
    const bad = runCli(['task', 'reap-stale-claims', '--older-than', '0', '--json'], { cwd: root, env });
    assert.notEqual(bad.status, 0);
  } finally {
    taskStore.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
