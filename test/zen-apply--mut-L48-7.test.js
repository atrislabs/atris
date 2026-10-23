'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { applyZen } = require('../lib/zen-apply');

test('applyZen preserves the first git error when a catch-up is blocked by an index lock', () => {
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zen-apply-error-')));
  const repo = path.join(work, 'repo');
  const previousTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = work;
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(work, 'no-config'),
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
    GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
    GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
    LC_ALL: 'C',
  };
  function git(...args) {
    const result = spawnSync('git', args, { cwd: repo, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  try {
    fs.mkdirSync(repo);
    git('init', '-q', '--initial-branch=master');
    git('commit', '-q', '--allow-empty', '-m', 'base');
    const base = git('rev-parse', 'HEAD');
    git('commit', '-q', '--allow-empty', '-m', 'incoming');
    git('update-ref', 'refs/remotes/origin/master', 'HEAD');
    git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/master');
    git('config', 'remote.origin.url', path.join(work, 'unused-origin'));
    git('config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
    git('config', 'branch.master.remote', 'origin');
    git('config', 'branch.master.merge', 'refs/heads/master');
    git('reset', '-q', '--hard', base);
    const lock = path.join(repo, '.git', 'index.lock');
    fs.writeFileSync(lock, '');

    const result = applyZen({ cwd: repo, fetch: false, now: new Date('2100-01-01T12:00:00Z'), freshMinutes: 1 });

    assert.equal(result.ok, true);
    assert.deepEqual(result.left, [
      `could not catch up with origin/master: error: Unable to create '${lock}': File exists.`,
    ]);
  } finally {
    if (previousTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpdir;
    fs.rmSync(work, { recursive: true, force: true });
  }
});
