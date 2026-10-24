'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { checkedCodeSha } = require('../lib/job-code-verify');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-mut-'));
  const previousHome = process.env.HOME;
  process.env.HOME = dir;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  function git(...args) {
    const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null',
      '-c', 'commit.gpgsign=false', '-c', 'user.name=Test',
      '-c', 'user.email=test@example.invalid', ...args], {
      cwd: repo, encoding: 'utf8', timeout: 5000,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    });
    assert.strictEqual(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  git('init', '--quiet');
  git('commit', '--quiet', '--allow-empty', '-m', 'fixture');
  return { repo: fs.realpathSync(repo), sha: git('rev-parse', 'HEAD') };
}

test('ignores queued commit that is missing from repo', (t) => {
  const { repo, sha } = fixture(t);
  const state = path.join(repo, '.atris', 'state');
  fs.mkdirSync(state, { recursive: true });
  const missing = 'f'.repeat(40);
  fs.writeFileSync(path.join(state, 'autoland-queue.json'), JSON.stringify({ entries: {
    matching: { task_ids: ['task-1'], pushed: missing },
  } }));
  assert.strictEqual(checkedCodeSha({ id: 'task-1', workspace_root: repo,
    metadata: { work_commit: sha } }, repo), sha);
});
