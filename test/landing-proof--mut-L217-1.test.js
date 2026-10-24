'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { proveCheckBeforePublish } = require('../lib/landing-proof');

test('a check on a committed refinement still contains the earlier work', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-refined-check-'));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Proof',
    GIT_AUTHOR_EMAIL: 'proof@example.com',
    GIT_COMMITTER_NAME: 'Proof',
    GIT_COMMITTER_EMAIL: 'proof@example.com',
    GIT_AUTHOR_DATE: '2025-01-15T12:00:00Z',
    GIT_COMMITTER_DATE: '2025-01-15T12:00:00Z',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  };
  function git(...args) {
    const result = spawnSync('git', args, { cwd: root, env, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    return result.stdout.trim();
  }
  function commit(body, message) {
    fs.writeFileSync(path.join(root, 'feature.js'), body);
    git('add', 'feature.js');
    git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  }
  try {
    git('init', '-q', '-b', 'master');
    const base = commit('module.exports = 1;\n', 'initial feature');
    const work = commit('module.exports = 2;\n', 'improve feature');
    commit('module.exports = 3;\n', 'refine feature further');

    const result = proveCheckBeforePublish(root, {
      commit: work,
      base,
      verify: 'node feature.js',
    });
    assert.equal(result, null);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
