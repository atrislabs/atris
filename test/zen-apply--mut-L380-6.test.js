'use strict';
require('./helpers/clean-temp');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { applyZen } = require('../lib/zen-apply');

test('catching up a tracked-only team script edit brings in its upstream executable permission', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-script-mode-'));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  const env = { ...process.env, HOME: root, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com', GIT_AUTHOR_DATE: '2025-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2025-01-01T00:00:00Z', GIT_CONFIG_NOSYSTEM: '1' };
  function git(cwd, ...args) {
    const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr || String(result.error));
    return result.stdout.trim();
  }
  try {
    const seed = path.join(root, 'seed');
    const checkout = path.join(root, 'checkout');
    fs.mkdirSync(seed);
    git(seed, 'init', '-q', '--initial-branch=master');
    fs.mkdirSync(path.join(seed, 'atris'));
    fs.writeFileSync(path.join(seed, 'atris/check.sh'), '#!/bin/sh\nprintf original\n');
    fs.chmodSync(path.join(seed, 'atris/check.sh'), 0o644);
    git(seed, 'add', '.');
    git(seed, 'commit', '-q', '-m', 'initial');
    git(root, 'clone', '-q', seed, checkout);
    fs.chmodSync(path.join(seed, 'atris/check.sh'), 0o755);
    git(seed, 'add', '.');
    git(seed, 'commit', '-q', '-m', 'update note');
    git(checkout, 'fetch', '-q', 'origin');
    fs.writeFileSync(path.join(checkout, 'atris/check.sh'), '#!/bin/sh\nprintf original\n# local documentation\n');
    applyZen({ cwd: checkout, fetch: false, now: new Date('2025-02-01T12:00:00Z'), freshMinutes: 0 });
    assert.notEqual(fs.statSync(path.join(checkout, 'atris/check.sh')).mode & 0o111, 0);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
