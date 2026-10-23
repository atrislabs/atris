'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { captureCodeBaseline } = require('../lib/mission-code-provenance');

test('a one-character untracked product path is readable dirty evidence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-short-path-'));
  const savedHome = process.env.HOME;
  process.env.HOME = root;
  try {
    const env = {
      PATH: process.env.PATH || '/usr/bin:/bin', HOME: root,
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
      GIT_AUTHOR_DATE: '2026-01-02T12:00:00Z',
      GIT_COMMITTER_DATE: '2026-01-02T12:00:00Z',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    };
    function git(...args) {
      const result = spawnSync('git', args, { cwd: root, env, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr || 'git failed');
    }
    git('init', '-q');
    git('commit', '--allow-empty', '-qm', 'baseline');
    fs.writeFileSync(path.join(root, 'x'), 'product change\n');
    const baseline = captureCodeBaseline(root);
    assert.notEqual(baseline.reason, 'git_status_unreadable');
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  }
});
