'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { lastTouched } = require('../lib/zen');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-last-touched-'));
  const saved = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_') || key.startsWith('GIT_')) delete process.env[key];
  }
  process.env.HOME = root;
  process.env.XDG_CONFIG_HOME = root;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_CONFIG_GLOBAL = path.join(root, 'no-global-config');
  process.env.GIT_AUTHOR_DATE = '2001-01-01T00:00:00Z';
  process.env.GIT_COMMITTER_DATE = '2001-01-01T00:00:00Z';
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  function git(...args) {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    assert.strictEqual(result.status, 0, result.stderr);
  }
  git('init', '--quiet');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  function write(name, time, content = name) {
    const file = path.join(repo, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    const date = new Date(time);
    fs.utimesSync(file, date, date);
    return fs.statSync(file).mtimeMs;
  }
  return { root, repo, git, write };
}

test('lastTouched selects the newest changed file and ignores clean files', (t) => {
  const { repo, git, write } = fixture(t);
  write('clean.txt', '2020-01-01T00:00:00Z');
  write('edited.txt', '2001-01-01T00:00:00Z');
  git('add', '.');
  git('commit', '--quiet', '-m', 'baseline');
  const older = write('edited.txt', '2002-01-01T00:00:00Z', 'changed');
  assert.strictEqual(lastTouched(repo), older);
  const newest = write('staged.txt', '2003-01-01T00:00:00Z');
  git('add', 'staged.txt');
  assert.strictEqual(lastTouched(repo), newest);
});

test('lastTouched expands untracked folders and handles spaces in paths', (t) => {
  const { repo, write } = fixture(t);
  const newest = write('new folder/deep/newest file.txt', '2005-01-01T00:00:00Z');
  write('new folder/older.txt', '2002-01-01T00:00:00Z');
  // Directory times must not replace the times of their contained files.
  fs.utimesSync(path.join(repo, 'new folder'), new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
  assert.strictEqual(lastTouched(repo), newest);
});

test('lastTouched returns zero for clean, deleted-only, and non-repository inputs', (t) => {
  const { root, repo, git, write } = fixture(t);
  assert.strictEqual(lastTouched(repo), 0);
  write('removed.txt', '2001-01-01T00:00:00Z');
  git('add', '.');
  git('commit', '--quiet', '-m', 'baseline');
  assert.strictEqual(lastTouched(repo), 0);
  fs.unlinkSync(path.join(repo, 'removed.txt'));
  assert.strictEqual(lastTouched(repo), 0);
  assert.strictEqual(lastTouched(root), 0);
  assert.strictEqual(lastTouched(path.join(root, 'missing')), 0);
});
