const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function hasNodeSqlite() {
  const result = spawnSync(process.execPath, ['-e', 'require("node:sqlite")'], {
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  return result.status === 0;
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-task-autolog-test-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runCli(args, { cwd, env } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      ...(env || {}),
    },
  });
  if (result.error) throw result.error;
  return result;
}

function todayLogName() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}.md`;
}

function setupWorkspace(dir) {
  fs.mkdirSync(path.join(dir, 'atris', 'team', 'auto-improver'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'atris', 'team', 'auto-improver', 'MEMBER.md'), '# auto-improver\n', 'utf8');
}

test('task accept autologs to project log and associated member log', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const env = {
    ATRIS_TASKS_DB: path.join(dir, 'tasks.db'),
    NODE_NO_WARNINGS: '1',
    ATRIS_AGENT_PROOF_ONLY: '0',
  };
  try {
    setupWorkspace(dir);
    const created = runCli(['task', 'new', 'Autolog accepted member task', '--tag', 'logs', '--json'], { cwd: dir, env });
    assert.equal(created.status, 0, created.stderr);
    const task = JSON.parse(created.stdout).task;
    assert.equal(runCli(['task', 'claim', task.display_id, '--as', 'auto-improver'], { cwd: dir, env }).status, 0);
    const proof = `${'context '.repeat(35)}Verifiers: node --test test/task-autolog.test.js passed, git diff --check clean, receipt captured in daily log`;
    const ready = runCli(['task', 'ready', task.display_id, '--proof', proof, '--as', 'auto-improver'], { cwd: dir, env });
    assert.equal(ready.status, 0, ready.stderr);

    const accepted = runCli(['task', 'accept', task.display_id, '--as', 'keshavrao', '--json'], { cwd: dir, env });
    assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);
    assert.equal(JSON.parse(accepted.stdout).action, 'accepted');

    const logName = todayLogName();
    const projectLog = fs.readFileSync(path.join(dir, 'atris', 'logs', logName.slice(0, 4), logName), 'utf8');
    assert.match(projectLog, /Task accepted/);
    assert.match(projectLog, /- task: .*1/);
    assert.match(projectLog, /- title: Autolog accepted member task/);
    assert.match(projectLog, /- status: done/);
    assert.match(projectLog, /- action: accepted/);
    assert.match(projectLog, /- member: auto-improver/);
    assert.match(projectLog, /- actor: keshavrao/);
    assert.match(projectLog, /test\/task-autolog\.test\.js passed/);

    const memberLog = fs.readFileSync(path.join(dir, 'atris', 'team', 'auto-improver', 'logs', logName), 'utf8');
    assert.match(memberLog, /Task accepted/);
    assert.match(memberLog, /- title: Autolog accepted member task/);
    assert.match(memberLog, /- status: done/);
    assert.match(memberLog, /- actor: keshavrao/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task done autologs to an associated member claimed on the task', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const env = {
    ATRIS_TASKS_DB: path.join(dir, 'tasks.db'),
    NODE_NO_WARNINGS: '1',
    ATRIS_AGENT_PROOF_ONLY: '0',
  };
  try {
    setupWorkspace(dir);
    const created = runCli(['task', 'new', 'Autolog done member task', '--tag', 'logs', '--json'], { cwd: dir, env });
    assert.equal(created.status, 0, created.stderr);
    const task = JSON.parse(created.stdout).task;
    assert.equal(runCli(['task', 'claim', task.display_id, '--as', 'auto-improver'], { cwd: dir, env }).status, 0);
    const proof = `${'context '.repeat(35)}Verifiers: node --test test/task-autolog.test.js passed and task done log was inspected`;
    const done = runCli(['task', 'done', task.display_id, '--proof', proof, '--as', 'auto-improver', '--json'], { cwd: dir, env });
    assert.equal(done.status, 0, done.stderr || done.stdout);

    const logName = todayLogName();
    const memberLog = fs.readFileSync(path.join(dir, 'atris', 'team', 'auto-improver', 'logs', logName), 'utf8');
    assert.match(memberLog, /Task completed/);
    assert.match(memberLog, /- title: Autolog done member task/);
    assert.match(memberLog, /- action: done/);
    assert.match(memberLog, /- actor: auto-improver/);
  } finally {
    cleanupTempDir(dir);
  }
});
