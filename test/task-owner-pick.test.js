'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, fork } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');
const store = require('../lib/task-db');
const picker = require('../lib/member-task-pick');
const cli = path.resolve(__dirname, '../bin/atris.js');

async function project(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-owner-pick-'));
  const env = { ...scrubAgentEnv(), ATRIS_TASKS_DB: path.join(dir, 'tasks.db'),
    ATRIS_TEST_STATE_DIR: path.join(dir, 'state'), ATRIS_PROGRESS_DIR: path.join(dir, 'progress'),
    ATRIS_SKIP_UPDATE_CHECK: '1', NODE_NO_WARNINGS: '1', ATRIS_CALLER_RUNTIME: 'terminal' };
  for (const member of ['executor', 'validator']) {
    const folder = path.join(dir, 'atris', 'team', member);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'MEMBER.md'), `---\nname: ${member}\nrole: ${member === 'executor' ? 'Builder' : 'Reviewer'}\n---\n# ${member}\n`);
  }
  store.close();
  const db = store.open(env.ATRIS_TASKS_DB);
  const workspaceRoot = store.workspaceRoot(dir);
  let clock = 1000;
  const add = (metadata = {}, opts = {}) => {
    const { id } = store.addTask(db, { workspaceRoot, title: 'Repair the clock', metadata, ...opts });
    db.prepare('UPDATE tasks SET created_at = ? WHERE id = ?').run(clock += 1000, id);
    return id;
  };
  const run = (args) => {
    const result = spawnSync(process.execPath, [cli, ...args], { cwd: dir, env, encoding: 'utf8', timeout: 20000 });
    assert.ifError(result.error);
    return result;
  };
  try { await fn({ dir, env, db, workspaceRoot, add, run }); }
  finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

// Observe the real CLI's atomic claim, then stop before starting a paid engine.
function take(dir, env, member) {
  return new Promise((resolve, reject) => {
    const child = fork(cli, ['member', 'go', member, '--needs-check', '--json'], { cwd: dir, env, silent: true });
    let claimed;
    let output = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`no claim: ${output}`)); }, 15000);
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('message', (message) => {
      if (message.type === 'member_task_claimed') { claimed = message.task; child.kill('SIGTERM'); }
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (!claimed) reject(new Error(`no claim: ${code} ${signal} ${output}`));
      else resolve({ claimed, signal });
    });
  });
}

test('a delegated job waits for its named member, who previews and really claims it', async (t) => {
  await project(async ({ dir, env, db, run }) => {
    const delegated = run(['task', 'delegate', 'Review the clock change', '--to', 'executor',
      '--tag', 'review', '--verify', 'node --test test/clock.test.js', '--json']);
    assert.equal(delegated.status, 0, delegated.stderr || delegated.stdout);
    const task = JSON.parse(delegated.stdout).task;
    const other = run(['member', 'go', 'validator', '--needs-check', '--dry-run', '--json']);
    assert.equal(JSON.parse(other.stdout).mode, 'idle', other.stdout);
    assert.equal(store.getTask(db, task.id).status, 'open');
    const preview = run(['member', 'go', 'executor', '--needs-check', '--dry-run', '--json']);
    assert.equal(preview.status, 0, preview.stderr);
    assert.equal(JSON.parse(preview.stdout).task.id, task.id);
    assert.equal(store.getTask(db, task.id).status, 'open', 'preview must not claim');
    const taken = await take(dir, env, 'executor');
    assert.equal(taken.claimed.id, task.id);
    assert.equal(store.getTask(db, task.id).claimed_by, 'executor');
    t.diagnostic(`task delegate exit ${delegated.status}: assigned to ${JSON.parse(delegated.stdout).owner}; validator preview: ${other.stdout.trim()}; executor preview exit ${preview.status}: ${JSON.parse(preview.stdout).task.title}; member go actual: ${taken.claimed.title}, claimed by executor, stopped after confirmation (${taken.signal})`);
  });
});

test('assigned work comes first, in age order, then unassigned matching jobs', async () => {
  await project(({ db, workspaceRoot, add }) => {
    const general = add();
    add({ assigned_to: 'validator' });
    const assigned = add({ assigned_to: 'executor' }, { tag: 'review' });
    const later = add({ assigned_to: 'executor' });
    const options = { workspaceRoot, member: 'executor', job: 'build' };
    assert.equal(picker.pickTaskForMember(store, db, options).id, assigned);
    assert.equal(picker.claimTaskForMember(store, db, options).task.id, assigned);
    assert.equal(picker.claimTaskForMember(store, db, options).task.id, later);
    assert.equal(picker.claimTaskForMember(store, db, options).task.id, general);
    assert.equal(picker.claimTaskForMember(store, db, options), null);
    assert.equal(picker.pickTaskForMember(store, db, { workspaceRoot, job: 'build' }), null,
      'a caller with no member cannot take assigned work');
  });
});

test('assignment preserves human, protected lane, check, and claim holds', async () => {
  await project(({ db, workspaceRoot, add }) => {
    const metadata = { assigned_to: 'executor', verify: 'node --test test/clock.test.js' };
    const held = [
      add(metadata, { tag: 'needs-human' }),
      add(metadata, { tag: 'security' }),
      add({ ...metadata, details: 'Protected lane: a human accepts this one.' }),
      add({ ...metadata, verify: 'looks good' }),
      add({ assigned_to: 'executor' }),
      add(metadata, { status: 'claimed', claimedBy: 'validator' }),
      add({ ...metadata, assigned_to: 'validator' }, { status: 'claimed', claimedBy: 'executor' }),
    ];
    const before = held.map((id) => store.getTask(db, id));
    const options = { workspaceRoot, member: 'executor', job: 'build', requireCheck: true, recoverClaimed: true };
    assert.equal(picker.pickTaskForMember(store, db, options), null);
    assert.equal(picker.claimTaskForMember(store, db, options), null);
    assert.deepEqual(held.map((id) => store.getTask(db, id)), before, 'held jobs stay untouched');
  });
});
