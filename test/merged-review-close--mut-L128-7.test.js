'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { closeMergedReviewJobs } = require('../lib/merged-review-close');

test('a deleted check file cannot prove that review work is present', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-deleted-check-'));
  const savedHome = process.env.HOME;
  process.env.HOME = root;
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
    GIT_AUTHOR_DATE: '2025-01-03T12:00:00Z',
    GIT_COMMITTER_DATE: '2025-01-03T12:00:00Z',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  function git(...args) {
    const result = spawnSync('git', args, { cwd: root, env, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  }
  try {
    git('init', '-q', '-b', 'master');
    fs.writeFileSync(path.join(root, 'README.md'), 'fixture\n');
    git('add', '.');
    git('commit', '-qm', 'initial');
    git('checkout', '-qb', 'builder');
    fs.mkdirSync(path.join(root, 'test'));
    fs.writeFileSync(path.join(root, 'test', 'removed.test.js'), 'module.exports = {};\n');
    git('add', '.');
    git('commit', '-qm', 'add check');
    git('checkout', '-q', 'master');
    git('merge', '-q', '--no-ff', '-m', 'merge check', 'builder');
    git('rm', 'test/removed.test.js');
    git('commit', '-qm', 'remove obsolete check');
    const result = closeMergedReviewJobs({
      root, dryRun: true,
      tasks: [{
        id: 'deleted-check-job', title: 'check removed functionality',
        status: 'review', workspace_root: root,
        created_at: Date.parse('2025-01-02T12:00:00Z'),
        metadata: { approval_status: 'pending', verify: 'node --test test/removed.test.js' },
      }],
    });
    assert.equal(result.matched.length, 0);
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  }
});
