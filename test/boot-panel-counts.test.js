'use strict';

// Boot panel (atris atris.md) must show task-lane truth from the task DB:
// actual task titles for what's moving and what awaits the human ok, with
// remaining lane counts folded into one trailing line. Falls back to
// TODO.md parsing only when no DB exists.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { withTaskReadyResult } = require('./helpers/task-result');

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
  const result = spawnSync(process.execPath, [cliPath, ...withTaskReadyResult(args)], {
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
    assert.match(boot.stdout, /you\s+1 done, waiting for your ok:/);
    assert.match(boot.stdout, /-\s+Certified review task/);
    assert.match(boot.stdout, /now\s+Claimed active task/);
    assert.match(boot.stdout, /\.\.\.and 2 waiting to start, 1 getting a final look/);
    assert.match(boot.stdout, /next\s+atris task reviews\s+\(approve the finished work\)/);
    assert.doesNotMatch(boot.stdout, /—/);
    assert.doesNotMatch(boot.stdout, /[\u{1F300}-\u{1FAFF}]/u);
    assert.doesNotMatch(boot.stdout, /WORKSPACE DETECTED|READY TO INITIALIZE/);
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
    assert.match(boot.stdout, /soon\s+Lone open task/);
    assert.doesNotMatch(boot.stdout, /getting a final look/);
    assert.match(boot.stdout, /next\s+atris plan\s+\(plan the first tasks\)/);
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
    assert.match(boot.stdout, /now\s+Active markdown task/);
    assert.match(boot.stdout, /\.\.\.and 3 waiting to start/);
    assert.doesNotMatch(boot.stdout, /getting a final look/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('boot panel shows tidy counts for stale worktrees and unresolved lessons', () => {
  const base = makeTempDir();
  const dir = path.join(base, 'myrepo');
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.mkdirSync(path.join(base, '.agent-worktrees', 'myrepo', 'agent-one'), { recursive: true });
    fs.mkdirSync(path.join(base, '.agent-worktrees', 'myrepo', 'agent-two'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'lessons.md'), [
      '- **[2026-04-01] open-lesson** — fail — Still broken.',
      '- **[2026-04-02] closed-lesson** — pass — [resolved] Fixed.',
      // knowledge, not rot: a pass lesson has nothing to resolve
      '- **[2026-04-03] worked-lesson** — pass — This approach worked.',
      '- **[2026-04-04] fixed-fail** — fail — [resolved] Bug fixed, detector passed.',
      '',
    ].join('\n'), 'utf8');

    const boot = runCli(['atris.md'], { cwd: dir });
    assert.equal(boot.status, 0, boot.stderr);
    assert.match(boot.stdout, /tidy\s+2 old copies to toss, 1 open problem/);
  } finally {
    cleanupTempDir(base);
  }
});

test('boot panel hides tidy line when worktrees and lessons are clean', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'lessons.md'), [
      '- **[2026-04-02] closed-lesson** — pass — [resolved] Fixed.',
      '',
    ].join('\n'), 'utf8');

    const boot = runCli(['atris.md'], { cwd: dir });
    assert.equal(boot.status, 0, boot.stderr);
    assert.doesNotMatch(boot.stdout, /^\s*tidy\s/m);
  } finally {
    cleanupTempDir(dir);
  }
});
