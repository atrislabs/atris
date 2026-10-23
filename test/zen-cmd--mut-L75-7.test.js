'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { zenCommand } = require('../commands/zen');

function git(cwd, env, ...args) {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

test('check headline reports the pending workspace cleanup count', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zencheck-home-'));
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zencheck-'));
  const origin = path.join(base, 'origin.git');
  const seed = path.join(base, 'seed');
  const checkout = path.join(base, 'checkout');
  const env = {
    ...process.env,
    ATRIS_SKIP_UPDATE_CHECK: '1',
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
  try {
    fs.mkdirSync(seed);
    git(base, env, 'init', '-q', '--bare', '--initial-branch=master', origin);
    git(seed, env, 'init', '-q', '--initial-branch=master');
    fs.writeFileSync(path.join(seed, 'app.js'), 'one\n');
    git(seed, env, 'add', '-A');
    git(seed, env, 'commit', '-q', '-m', 'init');
    git(seed, env, 'remote', 'add', 'origin', origin);
    git(seed, env, 'push', '-q', '-u', 'origin', 'master');
    git(base, env, 'clone', '-q', origin, checkout);

    // One fixed-date journal far past the archive threshold leaves exactly
    // one pending workspace cleanup for --check to count.
    const logs = path.join(checkout, 'atris', 'logs', '2020');
    fs.mkdirSync(logs, { recursive: true });
    fs.writeFileSync(path.join(logs, '2020-01-01.md'), '# log\n');
    git(checkout, env, 'add', '-A');
    git(checkout, env, 'commit', '-q', '-m', 'old journal');
    git(checkout, env, 'push', '-q');

    const lines = [];
    const original = console.log;
    console.log = (...a) => lines.push(a.join(' '));
    try {
      zenCommand(['--check', '--no-fetch'], checkout);
    } finally {
      console.log = original;
    }

    assert.match(lines[0], /workspace has 1 thing to tidy/);
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  }
});
