'use strict';

// Tasks added or claimed from inside a linked git worktree keep the worktree
// as their workspace_root (checks run there), but the main checkout's task
// list must still show them.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');

const cliPath = path.resolve(__dirname, '../bin/atris.js');

test('task added and claimed from a worktree shows in the main checkout list', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-task-worktree-')));
  const root = path.join(dir, 'repo');
  const worktree = path.join(dir, 'worker');
  const other = path.join(dir, 'other');
  fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
  fs.mkdirSync(path.join(other, 'atris'), { recursive: true });
  const env = {
    ...scrubAgentEnv(),
    ATRIS_TASKS_DB: path.join(dir, 'tasks.db'),
    ATRIS_SKIP_UPDATE_CHECK: '1',
    ATRIS_NO_INTERACTIVE: '1',
    ATRIS_NONINTERACTIVE: '1',
  };
  const git = (args, cwd = root) => {
    const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const atris = (args, cwd) => {
    const r = spawnSync(process.execPath, [cliPath, ...args], { cwd, env, encoding: 'utf8', timeout: 20000 });
    assert.ifError(r.error);
    return r;
  };
  const listIds = (cwd) => {
    const r = atris(['task', 'list', '--json'], cwd);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    return (JSON.parse(r.stdout).tasks || []).map((t) => t.id);
  };
  try {
    git(['init', '-b', 'main']);
    git(['config', 'user.name', 'worktree test']);
    git(['config', 'user.email', 'worktree@example.test']);
    git(['config', 'commit.gpgsign', 'false']);
    git(['config', 'core.hooksPath', '/dev/null']);
    fs.writeFileSync(path.join(root, '.gitignore'), '.atris/\n');
    fs.writeFileSync(path.join(root, 'atris', 'atris.md'), '# protocol\n');
    git(['add', '.']);
    git(['commit', '-m', 'init']);
    git(['worktree', 'add', '-b', 'worker', worktree]);
    fs.writeFileSync(path.join(other, 'atris', 'atris.md'), '# unrelated project\n');

    const added = atris(['task', 'add', 'Fix the worktree state split', '--json'], worktree);
    assert.equal(added.status, 0, added.stderr + added.stdout);
    const created = JSON.parse(added.stdout);
    const id = created.id || (created.task && created.task.id);
    assert.ok(id, `no task id in: ${added.stdout}`);

    const claimed = atris(['task', 'claim', id, '--as', 'executor'], worktree);
    assert.equal(claimed.status, 0, claimed.stderr + claimed.stdout);

    const otherAdded = atris(['task', 'add', 'Unrelated project task', '--json'], other);
    assert.equal(otherAdded.status, 0, otherAdded.stderr + otherAdded.stdout);
    const otherParsed = JSON.parse(otherAdded.stdout);
    const otherId = otherParsed.id || (otherParsed.task && otherParsed.task.id);

    const mainIds = listIds(root);
    assert.ok(mainIds.includes(id), 'main checkout list should show the task claimed from the worktree');
    assert.ok(!mainIds.includes(otherId), 'main checkout list should not show tasks from an unrelated folder');

    const shown = atris(['task', 'show', id, '--json'], root);
    assert.equal(shown.status, 0, shown.stderr);
    const row = JSON.parse(shown.stdout);
    assert.equal(row.workspace_root, worktree, 'stored workspace_root must stay the worktree, where checks run');
    assert.equal(row.status, 'claimed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
