'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, fork } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');
const picker = require('../lib/member-task-pick');

const taskStore = require('../lib/task-db');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

const sqliteAvailability = new Set();

function hasNodeSqlite() {
  const env = { ...process.env, NODE_NO_WARNINGS: '1' };
  const key = JSON.stringify([
    process.execPath,
    process.cwd(),
    Object.keys(env).sort().map(name => [name, env[name]]),
  ]);
  if (sqliteAvailability.has(key)) return true;
  const result = spawnSync(process.execPath, ['-e', 'require("node:sqlite")'], {
    encoding: 'utf8',
    env,
  });
  if (result.status === 0 && !result.error && !result.signal) sqliteAvailability.add(key);
  return result.status === 0;
}

function runCli(args, { cwd, env }) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...scrubAgentEnv(),
      ATRIS_SKIP_UPDATE_CHECK: '1',
      NODE_NO_WARNINGS: '1',
      ...env,
    },
  });
  if (result.error) throw result.error;
  return result;
}

function withTask(fn) {
  if (!hasNodeSqlite()) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-task-reopen-test-'));
  const env = {
    ATRIS_TASKS_DB: path.join(dir, 'tasks.db'),
    ATRIS_AGENT_PROOF_ONLY: '0',
  };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const created = runCli(['task', 'new', 'Send finished work back to open', '--json'], { cwd: dir, env });
    assert.equal(created.status, 0, created.stderr);
    fn({ dir, env, task: JSON.parse(created.stdout).task });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function finish(env, task, status) {
  const db = taskStore.open(env.ATRIS_TASKS_DB);
  const result = taskStore.doneTask(db, { id: task.id, status, actor: 'tester', proof: 'checked by hand' });
  assert.equal(result.updated, true);
}

function show(dir, env, id) {
  const shown = runCli(['task', 'show', id, '--json'], { cwd: dir, env });
  assert.equal(shown.status, 0, shown.stderr);
  return JSON.parse(shown.stdout);
}

test('atris task reopen sends a done task back to open', () => {
  withTask(({ dir, env, task }) => {
    finish(env, task, 'done');
    assert.equal(show(dir, env, task.display_id).status, 'done');

    const result = runCli(['task', 'reopen', task.display_id, '--reason', 'the fix did not hold', '--json'], { cwd: dir, env });
    assert.equal(result.status, 0, result.stderr);
    const body = JSON.parse(result.stdout);
    assert.equal(body.ok, true);
    assert.equal(body.action, 'reopened');
    assert.equal(body.reopened_from, 'done');

    const after = show(dir, env, task.display_id);
    assert.equal(after.status, 'open');
    assert.ok(!after.claimed_by, 'reopened task should not keep its old owner');
  });
});

async function withMemberTask(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-task-recovery-'));
  const env = { ...scrubAgentEnv(), ATRIS_TASKS_DB: path.join(dir, 'tasks.db'),
    ATRIS_TEST_STATE_DIR: path.join(dir, 'state'), ATRIS_PROGRESS_DIR: path.join(dir, 'progress'),
    ATRIS_SKIP_UPDATE_CHECK: '1', NODE_NO_WARNINGS: '1', ATRIS_CALLER_RUNTIME: 'terminal' };
  const memberDir = path.join(dir, 'atris', 'team', 'executor');
  fs.mkdirSync(memberDir, { recursive: true });
  fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), '---\nname: executor\nrole: Builder\n---\n# executor\n');
  taskStore.close();
  const db = taskStore.open(env.ATRIS_TASKS_DB);
  const workspaceRoot = taskStore.workspaceRoot(dir);
  const created = taskStore.addTask(db, { title: 'Repair the clock', workspaceRoot,
    metadata: { verify: 'node --test test/clock.test.js' } });
  const task = taskStore.getTask(db, created.id);
  try { await fn({ dir, env, db, task, workspaceRoot }); }
  finally { taskStore.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

// Stop the actual CLI at its claim confirmation, before it needs a model.
// This exercises the real idle check, recovery, SQLite claim, and IPC handoff.
function takeInCli(dir, env) {
  const barrierPath = path.join(dir, 'pause-after-claim.cjs');
  fs.writeFileSync(barrierPath, [
    "'use strict';",
    "const send = process.send;",
    "process.send = function(message) {",
    "  const result = Reflect.apply(send, this, arguments);",
    "  if (message?.type === 'member_task_claimed') {",
    "    const cell = new Int32Array(new SharedArrayBuffer(4));",
    "    for (;;) Atomics.wait(cell, 0, 0);",
    "  }",
    "  return result;",
    "};",
    ""
  ].join('\n'));
  return new Promise((resolve, reject) => {
    const child = fork(cliPath, ['member', 'go', 'executor', '--needs-check', '--json'],
      { cwd: dir, env, silent: true, execArgv: [...process.execArgv, '--require', barrierPath] });
    let claimed;
    let failure;
    let hardStopAttempted = false;
    let output = '';
    const hardStop = (error) => {
      failure ||= error;
      if (hardStopAttempted || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
      hardStopAttempted = true;
      try { child.kill('SIGKILL'); } catch (error) { failure ||= error; }
    };
    const timer = setTimeout(() => hardStop(new Error('claim confirmation timed out')), 15000);
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { output += data; });
    child.on('message', (message) => {
      if (message.type === 'member_task_claimed') { claimed = message.task; child.kill('SIGTERM'); }
    });
    child.on('error', hardStop);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      if (!claimed) return reject(new Error(`CLI did not claim: ${code} ${signal} ${output}`));
      if (signal !== 'SIGTERM') return reject(new Error(`CLI did not stop after the claim: ${code} ${signal} ${output}`));
      resolve({ claimed, code, signal });
    });
  });
}

test('real revision returns to the next idle member pick and claim', async (t) => {
  await withMemberTask(async ({ dir, env, db, task, workspaceRoot }) => {
    taskStore.claimTask(db, { id: task.id, claimedBy: 'executor' });
    taskStore.readyTask(db, { id: task.id, actor: 'executor', proof: 'checked the clock' });
    const revised = runCli(['task', 'revise', task.id, '--note', 'the clock still drifts', '--json'], { cwd: dir, env });
    assert.equal(revised.status, 0, revised.stderr || revised.stdout);
    const preview = runCli(['member', 'go', 'executor', '--needs-check', '--dry-run', '--json'], { cwd: dir, env });
    assert.equal(preview.status, 0, preview.stderr);
    assert.equal(JSON.parse(preview.stdout).task.id, task.id);
    assert.equal(taskStore.getTask(db, task.id).status, 'claimed', 'preview must not release a claim');
    const taken = await takeInCli(dir, env);
    assert.equal(taken.claimed.id, task.id);
    const after = taskStore.getTask(db, task.id);
    assert.equal(after.claimed_by, 'executor');
    assert.equal(after.metadata.human_revision_note, 'the clock still drifts');
    const events = taskStore.listTaskEvents(db, { taskId: task.id });
    assert.ok(events.some((event) => event.event_type === 'claim_released'));
    assert.equal(events.filter((event) => event.event_type === 'claimed').length, 2);
    assert.equal(picker.pickTaskForMember(taskStore, db, { workspaceRoot, job: 'build' }), null);
    t.diagnostic(`task revise exit: ${revised.status}; output: ${revised.stdout.trim()}; member go preview exit: ${preview.status}; task: ${JSON.parse(preview.stdout).task.title}; member go actual claim: ${taken.claimed.title}; stopped after confirmation: ${taken.signal}`);
  });
});

test('a closed window with a known dead process lets its member recover the claim', async (t) => {
  await withMemberTask(async ({ dir, env, db, task }) => {
    taskStore.claimTask(db, { id: task.id, claimedBy: 'executor' });
    const exited = spawnSync(process.execPath, ['-e', ''], { env });
    assert.equal(exited.status, 0);
    const state = path.join(dir, '.atris', 'state');
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'missions.jsonl'), JSON.stringify({ id: 'interrupted', owner: 'executor', status: 'running', objective: 'Repair the clock' }) + '\n');
    fs.writeFileSync(path.join(state, 'mission-interrupted.lock'), JSON.stringify({ pid: exited.pid }));
    const taken = await takeInCli(dir, env);
    assert.equal(taken.claimed.id, task.id);
    assert.equal(taskStore.listTaskEvents(db, { taskId: task.id }).filter((event) => event.event_type === 'claimed').length, 2);
    t.diagnostic(`node bin/atris.js member go executor --needs-check --json; confirmed: ${taken.claimed.title}; stopped after confirmation: ${taken.signal}; prior process exit: ${exited.status}`);
  });
});

for (const processState of ['live', 'unknown']) {
  test(`recovery leaves a ${processState} run and its claim alone`, async () => {
    await withMemberTask(({ dir, env, db, task }) => {
      taskStore.claimTask(db, { id: task.id, claimedBy: 'executor' });
      const before = taskStore.getTask(db, task.id);
      const state = path.join(dir, '.atris', 'state');
      fs.mkdirSync(state, { recursive: true });
      fs.writeFileSync(path.join(state, 'missions.jsonl'), JSON.stringify({ id: 'held', owner: 'executor', status: 'running', objective: 'Repair the clock' }) + '\n');
      if (processState === 'live') fs.writeFileSync(path.join(state, 'mission-held.lock'), JSON.stringify({ pid: process.pid }));
      const result = runCli(['member', 'go', 'executor', '--needs-check', '--dry-run', '--json'], { cwd: dir, env });
      assert.equal(result.status, 75, result.stderr);
      assert.equal(JSON.parse(result.stdout).mode, 'idle');
      assert.equal(taskStore.getTask(db, task.id).updated_at, before.updated_at);
      assert.equal(taskStore.getTask(db, task.id).claimed_by, 'executor');
    });
  });
}

test('recovery keeps other members, human holds, protected lanes, and check gates', async () => {
  await withMemberTask(({ db, task, workspaceRoot }) => {
    taskStore.claimTask(db, { id: task.id, claimedBy: 'other-member' });
    for (const options of [{ tag: 'needs-human' }, { tag: 'security' }, { metadata: {} },
      { metadata: { verify: 'looks good' } }, { tag: 'review' }]) {
      taskStore.addTask(db, { title: 'Repair the clock', workspaceRoot, status: 'claimed', claimedBy: 'executor',
        metadata: { verify: 'node --test test/clock.test.js' }, ...options });
    }
    assert.equal(picker.claimTaskForMember(taskStore, db, { workspaceRoot, member: 'executor', job: 'build', requireCheck: true, recoverClaimed: true }), null);
    assert.equal(taskStore.getTask(db, task.id).claimed_by, 'other-member');
    assert.ok(taskStore.listTasks(db, { workspaceRoot }).every((row) => row.status === 'claimed'));
  });
});

test('recovery does not release a claim changed after the pick', async () => {
  await withMemberTask(({ db, task }) => {
    taskStore.claimTask(db, { id: task.id, claimedBy: 'executor' });
    const before = taskStore.getTask(db, task.id);
    db.prepare('UPDATE tasks SET updated_at = updated_at + 1 WHERE id = ?').run(task.id);
    const result = taskStore.releaseTask(db, { id: task.id, actor: 'executor', expectedUpdatedAt: before.updated_at });
    assert.equal(result.released, false);
    assert.equal(result.reason, 'stale_task_state');
    assert.equal(taskStore.getTask(db, task.id).status, 'claimed');
  });
});

test('atris task reopen lets the job be claimed again', () => {
  withTask(({ dir, env, task }) => {
    finish(env, task, 'failed');
    const reopened = runCli(['task', 'reopen', task.display_id], { cwd: dir, env });
    assert.equal(reopened.status, 0, reopened.stderr);
    assert.match(reopened.stdout, /reopened .*\(was failed\)/);

    const reclaimed = runCli(['task', 'claim', task.display_id, '--as', 'second-try'], { cwd: dir, env });
    assert.equal(reclaimed.status, 0, reclaimed.stderr);
    assert.equal(show(dir, env, task.display_id).claimed_by, 'second-try');
  });
});

test('atris task reopen refuses a task that is already open', () => {
  withTask(({ dir, env, task }) => {
    const result = runCli(['task', 'reopen', task.display_id, '--json'], { cwd: dir, env });
    assert.equal(result.status, 1);
    const body = JSON.parse(result.stdout);
    assert.equal(body.ok, false);
    assert.equal(body.reason, 'already_open');
    assert.equal(show(dir, env, task.display_id).status, 'open');
  });
});

test('atris task reopen requires a task id', () => {
  withTask(({ dir, env }) => {
    const result = runCli(['task', 'reopen'], { cwd: dir, env });
    assert.notEqual(result.status, 0);
  });
});

test('atris task reopen sends a job that is done and waiting to merge back to open', () => {
  withTask(({ dir, env, task }) => {
    const db = taskStore.open(env.ATRIS_TASKS_DB);
    assert.equal(taskStore.claimTask(db, { id: task.id, claimedBy: 'builder' }).claimed, true);
    assert.notEqual(taskStore.readyTask(db, { id: task.id, actor: 'builder', proof: 'checked by hand' }).ready, false);
    assert.equal(show(dir, env, task.display_id).status, 'review');

    const result = runCli(['task', 'reopen', task.display_id, '--reason', 'pulled before merge', '--json'], { cwd: dir, env });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).reopened_from, 'review');
    const after = show(dir, env, task.display_id);
    assert.equal(after.status, 'open');
    assert.ok(!after.claimed_by);
    // The store itself still refuses unless asked, so other callers keep their behavior.
    assert.equal(taskStore.reopenTask(db, { id: task.id }).reopened, false);
  });
});
