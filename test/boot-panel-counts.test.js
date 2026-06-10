'use strict';

// Boot panel (atris atris.md) must show task-lane truth from the task DB —
// backlog/active counts plus the review lane (the human accept gate) —
// falling back to TODO.md parsing only when no DB exists.

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-boot-panel-test-'));
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

function writeMissionReceipt(dir, name, { missionId = 'mission-boot-123', passed = true } = {}) {
  const runsDir = path.join(dir, 'atris', 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  const rel = path.join('atris', 'runs', name);
  fs.writeFileSync(path.join(dir, rel), JSON.stringify({
    schema: 'atris.mission_receipt.v1',
    mission_id: missionId,
    result: { kind: 'mission_tick', tick: { verifier_passed: passed } },
  }, null, 2) + '\n', 'utf8');
  return rel;
}

function certifiedProofMentioning(receiptRel) {
  return `${'context '.repeat(35)}Verifiers: node --test test/boot-panel-counts.test.js passed, receipt ${receiptRel} attached, git diff --check clean`;
}

function seedTask(dir, env, title, { claim, certify } = {}) {
  const created = runCli(['task', 'new', title, '--tag', 'boot-test', '--json'], { cwd: dir, env });
  assert.equal(created.status, 0, created.stderr);
  const task = JSON.parse(created.stdout).task;
  if (claim || certify) {
    assert.equal(runCli(['task', 'claim', task.display_id, '--as', 'codex'], { cwd: dir, env }).status, 0);
  }
  if (certify) {
    const receiptRel = writeMissionReceipt(dir, `mission-${task.display_id.toLowerCase()}-receipt.json`, { passed: true });
    const ready = runCli(['task', 'ready', task.display_id, '--proof', certifiedProofMentioning(receiptRel), '--as', 'codex'], { cwd: dir, env });
    assert.equal(ready.status, 0, ready.stderr);
    const review = runCli(['task', 'review', task.display_id, '--reward', '0', '--as', 'validator'], { cwd: dir, env });
    assert.equal(review.status, 0, review.stderr);
  }
  return task;
}

test('boot panel shows DB lane truth including certified review gate', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const env = { ATRIS_TASKS_DB: path.join(dir, 'tasks.db'), NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    seedTask(dir, env, 'Open backlog task one');
    seedTask(dir, env, 'Open backlog task two');
    seedTask(dir, env, 'Claimed active task', { claim: true });
    seedTask(dir, env, 'Certified review task', { certify: true });

    const boot = runCli(['atris.md'], { cwd: dir, env });
    assert.equal(boot.status, 0, boot.stderr);
    assert.match(boot.stdout, /Tasks:\s+2 backlog, 1 active/);
    assert.match(boot.stdout, /Review:\s+1 waiting \(1 certified\)/);
    assert.match(boot.stdout, /1 certified await accept — run 'atris task reviews'/);
    assert.match(boot.stdout, /TODO\.md ←── 2 tasks waiting/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('boot panel hides review line when nothing is in review', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const env = { ATRIS_TASKS_DB: path.join(dir, 'tasks.db'), NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    seedTask(dir, env, 'Lone open task');

    const boot = runCli(['atris.md'], { cwd: dir, env });
    assert.equal(boot.status, 0, boot.stderr);
    assert.match(boot.stdout, /Tasks:\s+1 backlog, 0 active/);
    assert.doesNotMatch(boot.stdout, /Review:/);
    assert.match(boot.stdout, /Ready\. Run 'atris plan' to start\./);
    assert.match(boot.stdout, /TODO\.md ←── 1 task waiting/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('boot panel falls back to TODO.md parse when no task DB exists', () => {
  const dir = makeTempDir();
  // Point at a DB path that does not exist so the fallback path is exercised.
  const env = { ATRIS_TASKS_DB: path.join(dir, 'missing', 'tasks.db'), NODE_NO_WARNINGS: '1' };
  try {
    const atrisDir = path.join(dir, 'atris');
    fs.mkdirSync(atrisDir, { recursive: true });
    fs.writeFileSync(path.join(atrisDir, 'TODO.md'), [
      '# TODO',
      '',
      '## In Progress',
      '- Active markdown task',
      '',
      '## Backlog',
      '- Backlog markdown task one',
      '- Backlog markdown task two',
      '- Backlog markdown task three',
      '',
    ].join('\n'), 'utf8');

    const boot = runCli(['atris.md'], { cwd: dir, env });
    assert.equal(boot.status, 0, boot.stderr);
    assert.match(boot.stdout, /Tasks:\s+3 backlog, 1 active/);
    assert.doesNotMatch(boot.stdout, /Review:/);
  } finally {
    cleanupTempDir(dir);
  }
});
