'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { captureCodeBaseline, collectCodeProvenance, verifyCodeProvenance } = require('../lib/mission-code-provenance');

test('a symbolic revision cannot replace a pinned receipt commit', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-pinned-commit-'));
  const savedHome = process.env.HOME;
  process.env.HOME = root;
  try {
    const env = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
      GIT_AUTHOR_DATE: '2026-01-01T12:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T12:00:00Z' };
    const git = (...args) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8' });
    git('init', '-q');
    fs.writeFileSync(path.join(root, 'product.txt'), 'baseline\n');
    git('add', 'product.txt');
    git('commit', '-qm', 'baseline');
    const baseline = captureCodeBaseline(root);
    fs.writeFileSync(path.join(root, 'product.txt'), 'improved\n');
    git('add', 'product.txt');
    git('commit', '-qm', 'improvement');
    const evidence = collectCodeProvenance(root, baseline);
    const result = verifyCodeProvenance(root, { ...evidence, head_commit: 'HEAD' });
    assert.equal(result.reason, 'commit_unavailable');
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  }
});
