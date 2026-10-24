'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { gitDelta, gitSnapshot } = require('../lib/rsi-record');

// gitDelta shells out to git and inherits process.env, so point git at an
// empty identity and no config before any repo is touched.
const GIT_ENV = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
};

const saved = {};
const tempDirs = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsi-git-delta-'));
  tempDirs.push(dir);
  return dir;
}

function git(cwd, args) {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', '-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function write(dir, file, body = 'x\n') {
  fs.writeFileSync(path.join(dir, file), body);
}

function commit(dir, file, message) {
  write(dir, file);
  git(dir, ['add', file]);
  git(dir, ['commit', '-q', '-m', message]);
}

function makeRepo() {
  const dir = makeTempDir();
  git(dir, ['init', '-q']);
  commit(dir, 'a.txt', 'base');
  return dir;
}

before(() => {
  const env = { ...GIT_ENV, HOME: makeTempDir() };
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
});

after(() => {
  for (const key of Object.keys(saved)) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

test('counts commits and lists committed plus newly dirty files since a snapshot', () => {
  const dir = makeRepo();
  const before = gitSnapshot(dir);

  commit(dir, 'b.txt', 'add b');
  write(dir, 'a.txt', 'changed\n');
  write(dir, 'c.txt');

  const delta = gitDelta(dir, before);
  assert.strictEqual(delta.commits, 1);
  assert.deepStrictEqual([...delta.files].sort(), ['a.txt', 'b.txt', 'c.txt']);
});

test('does not credit dirt that was already there before the snapshot', () => {
  const dir = makeRepo();
  write(dir, 'pre.txt', 'mess from earlier\n');
  write(dir, 'a.txt', 'also mess from earlier\n');
  const before = gitSnapshot(dir);

  commit(dir, 'b.txt', 'add b');
  write(dir, 'pre.txt', 'mess, edited again\n');
  write(dir, 'd.txt');

  const delta = gitDelta(dir, before);
  assert.strictEqual(delta.commits, 1);
  assert.deepStrictEqual([...delta.files].sort(), ['b.txt', 'd.txt']);
});

test('accepts a bare HEAD string and reports nothing when nothing changed', () => {
  const dir = makeRepo();
  const head = git(dir, ['rev-parse', 'HEAD']);

  assert.deepStrictEqual(gitDelta(dir, head), { commits: 0, files: [] });

  commit(dir, 'b.txt', 'add b');
  assert.deepStrictEqual(gitDelta(dir, head), { commits: 1, files: ['b.txt'] });
});

test('reports a staged rename by its new path only', () => {
  const dir = makeRepo();
  const before = gitSnapshot(dir);

  git(dir, ['mv', 'a.txt', 'renamed.txt']);

  assert.deepStrictEqual(gitDelta(dir, before), { commits: 0, files: ['renamed.txt'] });
});

test('caps the file list at 200 entries', () => {
  const dir = makeRepo();
  const before = gitSnapshot(dir);

  for (let i = 0; i < 205; i += 1) write(dir, `new-${String(i).padStart(3, '0')}.txt`);

  const delta = gitDelta(dir, before);
  assert.strictEqual(delta.commits, 0);
  assert.strictEqual(delta.files.length, 200);
});

test('returns the empty result for a missing root or a directory that is not a repo', () => {
  assert.deepStrictEqual(gitDelta(null, 'abc1234'), { commits: 0, files: [] });

  const plain = makeTempDir();
  write(plain, 'loose.txt');
  assert.deepStrictEqual(gitDelta(plain, 'deadbeef'), { commits: 0, files: [] });
});
