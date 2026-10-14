'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function runCli(args, cwd, env = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...scrubAgentEnv(),
      ATRIS_SKIP_UPDATE_CHECK: '1',
      ...env,
    },
  });
  if (result.error) throw result.error;
  return result;
}

function writeMember(root, name) {
  const dir = path.join(root, 'atris', 'team', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'MEMBER.md'), [
    '---',
    `name: ${name}`,
    'role: Test Member',
    '---',
    '',
    `# ${name}`,
    '',
  ].join('\n'), 'utf8');
  return dir;
}

function writeGoal(root, name, goal) {
  const dir = path.join(root, 'atris', 'team', name);
  fs.writeFileSync(path.join(dir, 'goals.json'), JSON.stringify({
    schema: 'atris.member_goals.v1',
    member: name,
    goals: [
      {
        id: `goal-${name}`,
        status: 'active',
        experiments: [],
        ...goal,
      },
    ],
  }, null, 2));
}

test('member go --dry-run never uses a member name as the objective', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-member-go-'));
  try {
    const slugs = ['executor', 'navigator', 'improver'];
    for (const slug of slugs) writeMember(root, slug);

    const result = runCli(['member', 'go', '--dry-run', '--json'], root);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.ok(payload.prompt, 'member go should still produce an objective');

    const memberNames = new Set([...slugs, 'auto-improver']);
    assert.ok(
      !memberNames.has(payload.prompt),
      `objective should be a job, not a member name: ${payload.prompt}`
    );
    if (payload.subagent_shell && payload.subagent_shell.objective) {
      assert.ok(
        !memberNames.has(payload.subagent_shell.objective),
        `subagent objective should be a job, not a member name: ${payload.subagent_shell.objective}`
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('member go --dry-run uses the member real next job when a goal exists', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-member-go-'));
  try {
    for (const slug of ['executor', 'navigator', 'improver']) writeMember(root, slug);
    writeGoal(root, 'navigator', {
      title: 'Map the export pipeline',
      next_push: 'Trace the export call chain',
    });

    const result = runCli(['member', 'go', '--dry-run', '--json'], root);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.member, 'navigator');
    assert.equal(payload.prompt, 'Trace the export call chain');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// A temp project with its own task list. Tasks get spaced creation times so
// "oldest" is unambiguous.
function withTaskProject(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-member-go-tasks-'));
  const dbPath = path.join(root, 'tasks.db');
  const taskDb = require('../lib/task-db');
  taskDb.close();
  const db = taskDb.open(dbPath);
  const ws = taskDb.workspaceRoot(root);
  let clock = 1000;
  const add = (title, opts = {}) => {
    const { id } = taskDb.addTask(db, { title, workspaceRoot: ws, ...opts });
    db.prepare('UPDATE tasks SET created_at = ? WHERE id = ?').run(clock += 1000, id);
    return id;
  };
  try {
    for (const slug of ['executor', 'navigator']) writeMember(root, slug);
    fn({ root, db, taskDb, add, env: { ATRIS_TASKS_DB: dbPath } });
  } finally {
    taskDb.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('member go with no idea takes the oldest fitting task, skipping held, claimed, and billing rows', () => {
  withTaskProject(({ root, taskDb, db, add, env }) => {
    writeGoal(root, 'executor', { title: 'Old goal', next_push: 'Old next push' });
    add('Pick the launch price', { tag: 'needs-human' });
    add('Already taken', { status: 'claimed', claimedBy: 'someone' });
    add('Refund the double charge', { tag: 'billing' });
    const fits = add('Fix the flaky clock test', { metadata: { objective: 'It fails one run in five.' } });
    add('Rename the stale flag');

    for (const args of [['member', 'go', '--dry-run', '--json'], ['member', 'go', 'executor', '--dry-run', '--json']]) {
      const result = runCli(args, root, env);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.member, 'executor');
      assert.equal(payload.task.id, fits);
      assert.equal(payload.prompt, 'Fix the flaky clock test. It fails one run in five.');
    }
    // A dry run only looks.
    assert.equal(taskDb.getTask(db, fits).status, 'open');
  });
});

test('member go falls back to the member goal when no task fits', () => {
  withTaskProject(({ root, add, env }) => {
    writeGoal(root, 'executor', { title: 'Old goal', next_push: 'Old next push' });
    add('Hold for owner', { tag: 'needs-human' });
    add('Ship the invoice email', { tag: 'payments' });
    const result = runCli(['member', 'go', 'executor', '--dry-run', '--json'], root, env);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.task, null);
    assert.equal(payload.prompt, 'Old next push');
  });
});

test('a pulled task moves to review on a passing check and back to the list on a failing one', () => {
  const { memberGoFinishTask } = require('../commands/member');
  withTaskProject(({ taskDb, db, add, env }) => {
    process.env.ATRIS_TASKS_DB = env.ATRIS_TASKS_DB;
    try {
      const pass = add('Fix the clock test');
      const fail = add('Rename the flag');
      taskDb.claimTask(db, { id: pass, claimedBy: 'executor' });
      taskDb.claimTask(db, { id: fail, claimedBy: 'executor' });

      const passed = memberGoFinishTask('executor', taskDb.getTask(db, pass), {
        started: true, mission_id: 'm-1', mission: { status: 'complete', verifier_result: { passed: true } },
        work_step: { receipt_path: 'atris/runs/mission-m-1.json' },
      });
      assert.equal(passed.outcome, 'review');
      const reviewed = taskDb.getTask(db, pass);
      assert.equal(reviewed.status, 'review');
      assert.match(reviewed.metadata.latest_agent_proof, /atris\/runs\/mission-m-1\.json/);

      const waiting = add('Tidy the board copy');
      taskDb.claimTask(db, { id: waiting, claimedBy: 'executor' });
      const ready = memberGoFinishTask('executor', taskDb.getTask(db, waiting), {
        started: true, mission_id: 'm-3', mission: { status: 'ready', verifier_result: { passed: true } },
      });
      assert.equal(ready.outcome, 'review');

      const needsOwnCheck = add('Has its own check', { metadata: { verify: 'node --test test/a.test.js' } });
      taskDb.claimTask(db, { id: needsOwnCheck, claimedBy: 'executor' });
      const wrongCheck = memberGoFinishTask('executor', taskDb.getTask(db, needsOwnCheck), {
        started: true, mission_id: 'm-5',
        mission: { status: 'complete', verifier_result: { passed: true, command: 'node --version' } },
      });
      assert.equal(wrongCheck.outcome, 'released');

      const unproven = add('Status alone is not proof');
      taskDb.claimTask(db, { id: unproven, claimedBy: 'executor' });
      const noProof = memberGoFinishTask('executor', taskDb.getTask(db, unproven), {
        started: true, mission_id: 'm-4', mission: { status: 'complete' },
      });
      assert.equal(noProof.outcome, 'released');

      const failed = memberGoFinishTask('executor', taskDb.getTask(db, fail), {
        started: true, mission_id: 'm-2', mission: { status: 'running' }, error: 'check failed: 2 tests red\nstack',
      });
      assert.equal(failed.outcome, 'released');
      assert.equal(failed.reason, 'check failed: 2 tests red');
      const reopened = taskDb.getTask(db, fail);
      assert.equal(reopened.status, 'open');
      assert.equal(reopened.claimed_by, null);
    } finally {
      delete process.env.ATRIS_TASKS_DB;
    }
  });
});

test('member go never claims a task for a human member', () => {
  withTaskProject(({ root, taskDb, db, add, env }) => {
    const dir = path.join(root, 'atris', 'team', 'owner');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'MEMBER.md'), '---\nname: owner\ntype: human\nrole: Owner\n---\n# owner\n');
    const id = add('Fix the flaky clock test');
    const result = runCli(['member', 'go', 'owner', '--json'], root, env);
    assert.notEqual(result.status, 0);
    const row = taskDb.getTask(db, id);
    assert.equal(row.status, 'open');
    assert.equal(row.claimed_by, null);
  });
});
