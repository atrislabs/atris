'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { checkedCodeSha } = require('../lib/job-code-verify');

test('checkedCodeSha falls back to head when start and work commits match an earlier commit', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-test-'));
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
    const result = spawnSync('git', [
      '-c', 'core.hooksPath=/dev/null',
      '-c', 'commit.gpgsign=false',
      '-c', 'user.name=Test',
      '-c', 'user.email=test@example.invalid',
      ...args,
    ], {
      cwd: repo,
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    });
    assert.strictEqual(result.status, 0, result.stderr);
    return result.stdout.trim();
  }

  git('init', '--quiet');
  git('commit', '--quiet', '--allow-empty', '-m', 'base');
  const baseSha = git('rev-parse', 'HEAD');
  git('commit', '--quiet', '--allow-empty', '-m', 'head');
  const headSha = git('rev-parse', 'HEAD');

  const task = {
    workspace_root: repo,
    metadata: { start_commit: baseSha, work_commit: baseSha },
  };

  assert.strictEqual(checkedCodeSha(task, repo), headSha);
});
