'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { headCommit } = require('../lib/campaign-protect');

// Every path below lives in one temp sandbox. HOME and the git ceiling point
// inside it, so no real git config or parent repo can change the answer.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-protect-head-'));
const realSandbox = fs.realpathSync(sandbox);
const savedEnv = { ...process.env };

for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}
process.env.HOME = path.join(sandbox, 'home');
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CEILING_DIRECTORIES = [sandbox, realSandbox].join(path.delimiter);
process.env.GIT_AUTHOR_NAME = 'Test Author';
process.env.GIT_AUTHOR_EMAIL = 'author@example.invalid';
process.env.GIT_COMMITTER_NAME = 'Test Author';
process.env.GIT_COMMITTER_EMAIL = 'author@example.invalid';
process.env.GIT_AUTHOR_DATE = '2026-01-01T00:00:00Z';
process.env.GIT_COMMITTER_DATE = '2026-01-01T00:00:00Z';
fs.mkdirSync(process.env.HOME, { recursive: true });

test.after(() => {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.strictEqual(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function makeCheckout(name) {
  const dir = path.join(sandbox, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q']);
  return dir;
}

function commitFile(dir, file, text, message) {
  fs.writeFileSync(path.join(dir, file), text);
  git(dir, ['add', file]);
  git(dir, ['commit', '-q', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']);
}

test('headCommit returns the full sha HEAD points at, and follows new commits', () => {
  const dir = makeCheckout('checkout-with-commits');

  const first = commitFile(dir, 'notes.txt', 'one\n', 'first');
  assert.match(headCommit(dir), /^[0-9a-f]{40,64}$/);
  assert.strictEqual(headCommit(dir), first);

  const second = commitFile(dir, 'notes.txt', 'two\n', 'second');
  assert.notStrictEqual(second, first);
  assert.strictEqual(headCommit(dir), second);
});

test('headCommit gives the same commit from a subfolder of the checkout', () => {
  const dir = makeCheckout('checkout-subfolder');
  const head = commitFile(dir, 'notes.txt', 'hello\n', 'root commit');
  const sub = path.join(dir, 'deep', 'folder');
  fs.mkdirSync(sub, { recursive: true });

  assert.strictEqual(headCommit(sub), head);
});

test('headCommit ignores uncommitted edits, since it reads HEAD only', () => {
  const dir = makeCheckout('checkout-dirty');
  const head = commitFile(dir, 'notes.txt', 'saved\n', 'saved');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'unsaved edit\n');
  fs.writeFileSync(path.join(dir, 'new.txt'), 'untracked\n');

  assert.strictEqual(headCommit(dir), head);
});

test('headCommit returns null in a checkout with no commits yet', () => {
  const dir = makeCheckout('checkout-no-commits');

  assert.strictEqual(headCommit(dir), null);
});

test('headCommit returns null outside any git checkout', () => {
  const dir = path.join(sandbox, 'plain-folder');
  fs.mkdirSync(dir, { recursive: true });

  assert.strictEqual(headCommit(dir), null);
});

test('headCommit returns null when the folder does not exist', () => {
  const missing = path.join(sandbox, 'does-not-exist');

  assert.strictEqual(headCommit(missing), null);
});
