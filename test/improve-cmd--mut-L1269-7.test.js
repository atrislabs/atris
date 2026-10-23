'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { collectRevisionSignals } = require('../commands/improve');

test('a later merge preserves a human revision already on the mainline', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'improve-arrival-'));
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(root, 'no-global-config'),
    GIT_AUTHOR_NAME: 'Test Human',
    GIT_AUTHOR_EMAIL: 'human@example.com',
    GIT_COMMITTER_NAME: 'Test Human',
    GIT_COMMITTER_EMAIL: 'human@example.com',
  };
  let date;
  const git = (...args) => execFileSync('git', args, {
    cwd: root, encoding: 'utf8', stdio: 'pipe',
    env: { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  }).trim();
  const commit = (file, content, message, at) => {
    date = at;
    fs.writeFileSync(path.join(root, file), content);
    git('add', '--', file);
    git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  try {
    git('init', '-q', '--initial-branch=main');
    const landing = commit('product.js', 'module.exports = "agent";\n',
      'agent landing\n\nCo-authored-by: Codex <codex@openai.com>', '2025-01-01T01:00:00Z');
    const correction = commit('product.js', 'module.exports = "corrected";\n',
      'human correction', '2025-01-01T02:00:00Z');
    // The branch starts after the correction, so its ancestry reaches both
    // commits. Traversing it must not replace their existing mainline arrivals.
    git('checkout', '-q', '-b', 'side');
    commit('side.txt', 'side\n', 'side work', '2025-01-01T03:00:00Z');
    git('checkout', '-q', 'main');
    commit('main.txt', 'main\n', 'main work', '2025-01-01T04:00:00Z');
    date = '2025-01-01T05:00:00Z';
    git('-c', 'commit.gpgsign=false', 'merge', '--no-ff', '-m', 'merge side', 'side');

    assert.deepEqual(collectRevisionSignals(root, { days: 7, now: '2025-01-02T00:00:00Z' }), {
      schema: 'atris.improve_revisions.v1',
      generated_at: '2025-01-02T00:00:00.000Z',
      days: 7,
      window_hours: 72,
      landings: 1,
      revised: 1,
      rate: 1,
      fixed: 1,
      coached: 0,
      fix_rate: 1,
      revisions: [{
        landing: { hash: landing, subject: 'agent landing', at: '2025-01-01T01:00:00Z' },
        revised_by: [{ hash: correction, subject: 'human correction', at: '2025-01-01T02:00:00Z' }],
        files: ['product.js'],
        kind: 'fix',
      }],
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
