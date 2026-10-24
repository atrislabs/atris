const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const taskDb = require('../lib/task-db');
const { delegateTask } = require('../commands/task');

// Runs fn inside a throwaway workspace. The task db, HOME, and cwd all point
// into the temp folder, and every ATRIS_* env var is cleared for the run.
function withSandbox(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-delegate-'));
  const savedCwd = process.cwd();
  const savedEnv = { ...process.env };
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(workspace, 'atris'), { recursive: true });
  // atris/atris.md marks this folder as the workspace root.
  fs.writeFileSync(path.join(workspace, 'atris', 'atris.md'), '# workspace\n');
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) delete process.env[key];
  }
  process.env.HOME = home;
  process.env.ATRIS_TASKS_DB = path.join(home, '.atris', 'tasks.db');
  process.chdir(workspace);
  try {
    fn(workspace);
  } finally {
    taskDb.close();
    process.chdir(savedCwd);
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function projectionTasks(workspace) {
  const file = path.join(workspace, '.atris', 'state', 'tasks.projection.json');
  return JSON.parse(fs.readFileSync(file, 'utf8')).tasks;
}

test('delegating a titled job saves it as open and returns a claim handoff', () => {
  withSandbox((workspace) => {
    const payload = delegateTask(
      ['Fix the login page', '--to', 'ledger-keeper', '--tag', 'auth'],
      { warnOperatorTitle: false },
    );

    assert.equal(payload.ok, true);
    assert.equal(payload.action, 'delegated');
    assert.equal(payload.inserted, true);
    assert.equal(payload.owner, 'ledger-keeper');
    assert.equal(payload.owner_resolution.reason, 'explicit_functional_owner');
    assert.equal(payload.via, 'local');
    assert.equal(payload.tag, 'auth');
    assert.equal(payload.executed_by, null);
    assert.equal(payload.task.title, 'Fix the login page');
    assert.equal(payload.task.status, 'open');
    assert.equal(payload.handoff.command, `atris task claim ${payload.task.display_id || payload.task.legacy_ref} --as ledger-keeper`);
    assert.equal(payload.handoff.swarlo, undefined);

    const saved = projectionTasks(workspace).find((task) => task.id === payload.task_id);
    assert.ok(saved, 'projection file should list the delegated task');
    assert.equal(saved.title, 'Fix the login page');
    assert.equal(saved.status, 'open');
  });
});

test('--claim with --via swarlo claims the task for the owner and adds a swarlo handoff', () => {
  withSandbox(() => {
    const payload = delegateTask(
      ['Rotate the deploy keys', '--to', 'ledger-keeper', '--tag', 'ops-queue', '--via', 'swarlo', '--claim'],
      { warnOperatorTitle: false },
    );

    assert.equal(payload.via, 'swarlo');
    assert.equal(payload.task.status, 'claimed');
    assert.equal(payload.task.claimed_by, 'ledger-keeper');
    assert.deepEqual(payload.handoff.swarlo, {
      task_key: payload.task.id,
      action: 'claim',
      channel: 'ops-queue',
      assignee: 'ledger-keeper',
    });
  });
});

test('--note is saved as a note event on the delegated task', () => {
  withSandbox(() => {
    const payload = delegateTask(
      ['Draft the pricing page copy', '--to', 'ledger-keeper', '--note', 'use the spring offer numbers'],
      { warnOperatorTitle: false },
    );

    const db = taskDb.open();
    const events = taskDb.listTaskEvents(db, { taskId: payload.task_id, workspaceRoot: null });
    const notes = events.filter((event) => event.payload && event.payload.content === 'use the spring offer numbers');
    assert.equal(notes.length, 1, `expected one note event, got ${JSON.stringify(events)}`);
  });
});

test('--executed-by is slugged and recorded separately from the owner', () => {
  withSandbox(() => {
    const payload = delegateTask(
      ['Tidy the changelog', '--to', 'ledger-keeper', '--executed-by', 'Codex Engine'],
      { warnOperatorTitle: false },
    );

    assert.equal(payload.owner, 'ledger-keeper');
    assert.equal(payload.executed_by, 'codex-engine');
  });
});

test('a missing or blank title exits with an error before any task is written', () => {
  withSandbox(() => {
    const realExit = process.exit;
    const realError = console.error;
    const messages = [];
    process.exit = (code) => {
      throw Object.assign(new Error('exit'), { exitCode: code });
    };
    console.error = (...parts) => messages.push(parts.join(' '));
    try {
      for (const args of [['--to', 'ledger-keeper'], ['   ']]) {
        messages.length = 0;
        assert.throws(() => delegateTask(args, { warnOperatorTitle: false }), (err) => {
          assert.equal(err.exitCode, 2);
          return true;
        });
        assert.deepEqual(messages, ['title required']);
      }
    } finally {
      process.exit = realExit;
      console.error = realError;
    }

    assert.equal(fs.existsSync(process.env.ATRIS_TASKS_DB), false, 'no task db should be created');
  });
});
