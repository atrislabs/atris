'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { untrackedFiles } = require('../lib/zen');

function fixture(t, initialize = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-untracked-'));
  const saved = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('GIT_') || key.startsWith('ATRIS_')) delete process.env[key];
  }
  process.env.HOME = root;
  process.env.XDG_CONFIG_HOME = root;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_CONFIG_GLOBAL = path.join(root, 'absent-gitconfig');
  function git(...args) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.strictEqual(result.status, 0, result.stderr || String(result.error));
  }
  if (initialize) git('init', '--quiet', '--template=');
  function write(name, content = 'fixture\n') {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return { root, git, write };
}

test('untrackedFiles expands a directory and excludes tracked, ignored, and outside files', (t) => {
  const { root, git, write } = fixture(t);
  write('.gitignore', '*.ignored\n');
  write('new/tracked.js');
  git('add', '.gitignore', 'new/tracked.js');
  write('new/tracked.js', 'modified\n');
  write('new/first.js');
  write('new/nested/second.js');
  write('new/hidden.ignored');
  write('outside.js');

  assert.deepStrictEqual(untrackedFiles(root, 'new/').sort(), [
    'new/first.js',
    'new/nested/second.js',
  ]);
});

test('untrackedFiles preserves spaces, tabs, newlines, and unicode in filenames', (t) => {
  const { root, write } = fixture(t);
  const names = ['odd/a space.txt', 'odd/a\ttab.txt', 'odd/a\nline.txt', 'odd/café.txt'];
  for (const name of names) write(name);

  assert.deepStrictEqual(untrackedFiles(root, 'odd/').sort(), [...names].sort());
  assert.deepStrictEqual(untrackedFiles(root, names[0]), [names[0]]);
});

test('untrackedFiles returns an empty array when no untracked files match', (t) => {
  const { root, git, write } = fixture(t);
  write('tracked.txt');
  git('add', 'tracked.txt');

  assert.deepStrictEqual(untrackedFiles(root, '.'), []);
  assert.deepStrictEqual(untrackedFiles(root, 'missing/'), []);
});

test('untrackedFiles returns an empty array when git cannot read a repository', (t) => {
  const { root, write } = fixture(t, false);
  write('file.txt');

  assert.deepStrictEqual(untrackedFiles(root, '.'), []);
  assert.deepStrictEqual(untrackedFiles(path.join(root, 'missing'), '.'), []);
});
