'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { computeRevisionMetric } = require('../lib/revision-metric');

test('bot corrections are excluded from human revision counts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'author-email-'));
  const git = (args, email = 'human@example.com', date = '2026-08-23T12:00:00Z') => execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, HOME: root, GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Contributor', GIT_COMMITTER_NAME: 'Contributor',
      GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_EMAIL: email,
      GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
  try {
    git(['init', '-q', '--initial-branch=master']);
    fs.writeFileSync(path.join(root, 'feature.js'), 'initial\n');
    git(['add', 'feature.js']);
    git(['commit', '-q', '-m', 'land feature\n\nCo-authored-by: Atris <299057014+atris-builder[bot]@users.noreply.github.com>']);
    fs.writeFileSync(path.join(root, 'feature.js'), 'automated correction\n');
    git(['add', 'feature.js']);
    git(['commit', '-q', '-m', 'automated correction'], 'dependabot[bot]@users.noreply.github.com', '2026-08-23T13:00:00Z');
    const metric = computeRevisionMetric(root, { ref: 'master', now: Date.parse('2026-08-26T12:00:00Z') });
    assert.equal(metric.changes[0].revision_count, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
