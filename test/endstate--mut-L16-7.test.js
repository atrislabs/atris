'use strict';
require('./helpers/clean-temp');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { getGitHead } = require('../lib/endstate');

test('getGitHead returns the commit ID of an existing repository', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-head-'));
  const oldHome = process.env.HOME;
  process.env.HOME = dir;
  try {
    const env = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: path.join(dir, 'no-config'),
      GIT_AUTHOR_NAME: 'Test Author',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Test Author',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
      GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z',
    };
    const git = (...args) => execFileSync('git', args, {
      cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    git('init');
    git('commit', '--allow-empty', '--no-gpg-sign', '-m', 'fixture');
    const expected = git('rev-parse', 'HEAD');
    assert.strictEqual(getGitHead(dir), expected);
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  }
});
