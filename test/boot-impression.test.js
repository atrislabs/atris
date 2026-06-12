'use strict';

// Boot impression: assert session boot (atris atris.md) includes the active
// endgame verbatim, and the selector (task next --json) prefers endgame-tagged tasks.

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-boot-impression-test-'));
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

function seedTask(dir, env, title, { tag } = {}) {
  const args = ['task', 'new', title];
  if (tag) {
    args.push('--tag', tag);
  }
  args.push('--json');
  const created = runCli(args, { cwd: dir, env });
  assert.equal(created.status, 0, created.stderr);
  const task = JSON.parse(created.stdout).task;
  return task;
}

test('boot panel renders active endgame verbatim and task next prefers endgame-tagged tasks', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const env = { ATRIS_TASKS_DB: path.join(dir, 'tasks.db'), NODE_NO_WARNINGS: '1' };
  try {
    const atrisDir = path.join(dir, 'atris');
    fs.mkdirSync(atrisDir, { recursive: true });

    // Create TODO.md with an endgame section
    const todoContent = [
      '# TODO',
      '',
      '## Endgame',
      '**Slug:** cli-235',
      '**Horizon:** make the repeated impression enforceable',
      '',
      '## Backlog',
      '- Regular backlog task',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(atrisDir, 'TODO.md'), todoContent, 'utf8');

    // Seed one endgame-tagged task and one regular task
    const endgameTask = seedTask(dir, env, 'endgame task one', { tag: 'endgame' });
    const regularTask = seedTask(dir, env, 'regular task one', {});

    // Boot should show the endgame horizon verbatim
    const boot = runCli(['atris.md'], { cwd: dir, env });
    assert.equal(boot.status, 0, boot.stderr);
    assert.match(boot.stdout, /make the repeated impression enforceable/,
      'boot stdout should contain endgame horizon text verbatim');

    // task list --json should return the endgame-tagged task first
    const taskList = runCli(['task', 'list', '--json'], { cwd: dir, env });
    assert.equal(taskList.status, 0, taskList.stderr);
    const listData = JSON.parse(taskList.stdout);
    assert(listData.tasks && listData.tasks.length > 0, 'task list should return at least one task');
    assert.equal(listData.tasks[0].display_id, endgameTask.display_id,
      `task list should return endgame task ${endgameTask.display_id} first, not ${listData.tasks[0].display_id}`);
  } finally {
    cleanupTempDir(dir);
  }
});
