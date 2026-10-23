'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Everything lives under one temp dir. Git reads no machine config and never
// walks up out of that dir, so the repos below behave the same everywhere.
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-zen-dirty-')));
const home = path.join(base, 'home');
fs.mkdirSync(home);
fs.writeFileSync(path.join(home, 'gitconfig'), '');

const savedEnv = { ...process.env };
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_') || key === 'GIT_DIR' || key === 'GIT_WORK_TREE' || key === 'GIT_INDEX_FILE') {
    delete process.env[key];
  }
}
Object.assign(process.env, {
  HOME: home,
  XDG_CONFIG_HOME: path.join(home, '.config'),
  GIT_CONFIG_GLOBAL: path.join(home, 'gitconfig'),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CEILING_DIRECTORIES: base,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z',
});

const { dirtyEntries } = require('../lib/zen');

test.after(() => {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  fs.rmSync(base, { recursive: true, force: true });
});

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30000 });
  if (result.error) throw result.error;
  assert.strictEqual(result.status, 0, result.stderr);
  return result.stdout;
}

let repoCount = 0;
function makeRepo() {
  repoCount += 1;
  const dir = path.join(base, `repo-${repoCount}`);
  fs.mkdirSync(dir);
  git(dir, 'init', '-q');
  return dir;
}

function write(dir, file, content) {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), content);
}

function commitAll(dir) {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'baseline');
}

// Git lists tracked changes before untracked ones; compare by path so these
// tests do not lean on that ordering.
function byPath(entries) {
  return [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

const LINES = Array.from({ length: 12 }, (_, i) => `line ${i + 1} of a file long enough to detect a rename\n`).join('');

test('dirtyEntries reports every kind of change with its two-letter status', () => {
  const dir = makeRepo();
  write(dir, '.gitignore', 'ignored.log\n');
  write(dir, 'a-modified.txt', 'one\n');
  write(dir, 'b-deleted.txt', 'two\n');
  write(dir, 'c-both.txt', 'three\n');
  write(dir, 'clean.txt', 'untouched\n');
  commitAll(dir);

  write(dir, 'a-modified.txt', 'one changed\n');
  fs.rmSync(path.join(dir, 'b-deleted.txt'));
  write(dir, 'c-both.txt', 'three staged\n');
  git(dir, 'add', 'c-both.txt');
  write(dir, 'c-both.txt', 'three staged then edited\n');
  write(dir, 'd-added.txt', 'new and staged\n');
  git(dir, 'add', 'd-added.txt');
  write(dir, 'e-untracked.txt', 'not added\n');
  write(dir, 'f-dir/inner.txt', 'inside a new folder\n');
  write(dir, 'f-dir/deep/more.txt', 'deeper\n');
  write(dir, 'ignored.log', 'git skips this\n');

  const entries = dirtyEntries(dir);

  assert.deepStrictEqual(byPath(entries), [
    { xy: ' M', path: 'a-modified.txt', orig: null },
    { xy: ' D', path: 'b-deleted.txt', orig: null },
    { xy: 'MM', path: 'c-both.txt', orig: null },
    { xy: 'A ', path: 'd-added.txt', orig: null },
    { xy: '??', path: 'e-untracked.txt', orig: null },
    { xy: '??', path: 'f-dir/', orig: null },
  ]);
});

test('dirtyEntries keeps spaces and non-ascii characters in paths unquoted', () => {
  const dir = makeRepo();
  write(dir, 'seed.txt', 'seed\n');
  commitAll(dir);

  write(dir, 'my notes.txt', 'has a space\n');
  write(dir, 'café.txt', 'has an accent\n');
  write(dir, 'docs/quoted "name".md', 'has quotes\n');

  const paths = dirtyEntries(dir).map((entry) => entry.path).sort();

  assert.deepStrictEqual(paths, ['café.txt', 'docs/', 'my notes.txt']);
  write(dir, 'docs/other.md', 'second file in the folder\n');
  git(dir, 'add', 'docs');
  const docs = byPath(dirtyEntries(dir)).filter((entry) => entry.xy === 'A ');
  assert.deepStrictEqual(docs.map((entry) => entry.path), ['docs/other.md', 'docs/quoted "name".md']);
});

test('dirtyEntries gives a rename its original path and still reads the entries after it', () => {
  const dir = makeRepo();
  write(dir, 'aaa-before.txt', 'before\n');
  write(dir, 'old-dir/old-name.txt', LINES);
  commitAll(dir);

  write(dir, 'aaa-before.txt', 'before, edited\n');
  fs.mkdirSync(path.join(dir, 'new-dir'));
  git(dir, 'mv', 'old-dir/old-name.txt', 'new-dir/new-name.txt');
  write(dir, 'zzz-after.txt', 'untracked, listed after the rename\n');

  assert.deepStrictEqual(byPath(dirtyEntries(dir)), [
    { xy: ' M', path: 'aaa-before.txt', orig: null },
    { xy: 'R ', path: 'new-dir/new-name.txt', orig: 'old-dir/old-name.txt' },
    { xy: '??', path: 'zzz-after.txt', orig: null },
  ]);

  write(dir, 'new-dir/new-name.txt', `${LINES}one more line\n`);
  const renamed = dirtyEntries(dir).find((entry) => entry.path === 'new-dir/new-name.txt');
  assert.deepStrictEqual(renamed, { xy: 'RM', path: 'new-dir/new-name.txt', orig: 'old-dir/old-name.txt' });
});

test('dirtyEntries returns an empty list for a clean tree or one with only ignored files', () => {
  const dir = makeRepo();
  write(dir, '.gitignore', '*.log\n');
  write(dir, 'tracked.txt', 'tracked\n');
  commitAll(dir);
  assert.deepStrictEqual(dirtyEntries(dir), []);

  write(dir, 'build.log', 'ignored output\n');
  assert.deepStrictEqual(dirtyEntries(dir), []);
});

test('dirtyEntries works in a repo with no commits yet', () => {
  const dir = makeRepo();
  assert.deepStrictEqual(dirtyEntries(dir), []);

  write(dir, 'first.txt', 'first\n');
  assert.deepStrictEqual(dirtyEntries(dir), [{ xy: '??', path: 'first.txt', orig: null }]);

  git(dir, 'add', 'first.txt');
  assert.deepStrictEqual(dirtyEntries(dir), [{ xy: 'A ', path: 'first.txt', orig: null }]);
});

test('dirtyEntries from a subfolder still lists the whole repo with root-relative paths', () => {
  const dir = makeRepo();
  write(dir, 'sub/inside.txt', 'inside\n');
  write(dir, 'top.txt', 'top\n');
  commitAll(dir);

  write(dir, 'sub/inside.txt', 'inside, edited\n');
  write(dir, 'top.txt', 'top, edited\n');

  const expected = [
    { xy: ' M', path: 'sub/inside.txt', orig: null },
    { xy: ' M', path: 'top.txt', orig: null },
  ];
  assert.deepStrictEqual(byPath(dirtyEntries(path.join(dir, 'sub'))), expected);
  assert.deepStrictEqual(byPath(dirtyEntries(dir)), expected);
});

test('dirtyEntries returns an empty list when git cannot read the folder', () => {
  const notRepo = path.join(base, 'not-a-repo');
  fs.mkdirSync(notRepo);
  write(notRepo, 'loose.txt', 'no repo here\n');
  assert.deepStrictEqual(dirtyEntries(notRepo), []);

  assert.deepStrictEqual(dirtyEntries(path.join(base, 'does-not-exist')), []);
});
