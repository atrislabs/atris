'use strict';

// A side copy left untouched for days has its unsaved work pinned to a
// backup branch before the copy is removed. The branch must really exist.

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const zenApply = require('../lib/zen-apply');

const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-zen-mut-L112-')));
const home = path.join(work, 'home');
fs.mkdirSync(home);

const keys = [
  'HOME',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
];
const previous = {};
for (const key of keys) previous[key] = process.env[key];
process.env.HOME = home;
process.env.GIT_AUTHOR_NAME = 'test';
process.env.GIT_AUTHOR_EMAIL = 'test@example.com';
process.env.GIT_COMMITTER_NAME = 'test';
process.env.GIT_COMMITTER_EMAIL = 'test@example.com';

after(() => {
  for (const key of keys) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
  fs.rmSync(work, { recursive: true, force: true });
});

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60000 });
  if (result.error) throw result.error;
  assert.strictEqual(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function write(cwd, file, content) {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), content);
}

test('a side copy untouched for days keeps its unsaved work on a backup branch', () => {
  const base = path.join(work, 'repo');
  const origin = path.join(base, 'origin.git');
  const seed = path.join(base, 'seed');
  const checkout = path.join(base, 'checkout');
  fs.mkdirSync(seed, { recursive: true });
  git(base, 'init', '-q', '--bare', '--initial-branch=master', origin);
  git(seed, 'init', '-q', '--initial-branch=master');
  write(seed, 'app.js', 'one\n');
  git(seed, 'add', 'app.js');
  git(seed, 'commit', '-q', '-m', 'app');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-q', '-u', 'origin', 'master');
  git(base, 'clone', '-q', origin, checkout);

  const copy = path.join(base, 'old');
  git(checkout, 'worktree', 'add', '-q', '-b', 'old-branch', copy);
  write(copy, 'wip.js', 'forgotten\n');

  // A fixed moment far past the untouched-for-days window, so the copy
  // counts as abandoned no matter when the test runs.
  const result = zenApply.applyZen({
    cwd: checkout,
    now: new Date('2030-06-15T12:00:00Z'),
    freshMinutes: 30,
  });

  assert.strictEqual(result.ok, true);
  const kept = git(checkout, 'branch', '--list', 'zen-backup/*-old', '--format=%(refname:short)')
    .split('\n')
    .filter(Boolean);
  assert.strictEqual(kept.length, 1);
  assert.strictEqual(git(checkout, 'show', `${kept[0]}:wip.js`), 'forgotten');
});
