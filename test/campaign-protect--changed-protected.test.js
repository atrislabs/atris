'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { changedProtected } = require('../lib/campaign-protect');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'changed-protected-'));
  const original = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('GIT_') || key.startsWith('ATRIS_')) delete process.env[key];
  }
  Object.assign(process.env, {
    HOME: root,
    XDG_CONFIG_HOME: root,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(root, 'empty-git-config'),
    GIT_AUTHOR_NAME: 'Test Author',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test Author',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
    GIT_AUTHOR_DATE: '2020-01-02T03:04:05Z',
    GIT_COMMITTER_DATE: '2020-01-02T03:04:05Z',
  });
  t.after(() => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, original);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const write = (name, contents = 'original\n') => fs.writeFileSync(path.join(root, name), contents);
  git('init', '--quiet', '--template=');
  git('config', 'core.autocrlf', 'false');
  return { root, git, write };
}

test('reports sorted protected changes across committed, staged, unstaged, deleted and untracked files', (t) => {
  const { root, git, write } = fixture(t);
  for (const name of ['committed', 'staged', 'unstaged', 'deleted', 'untouched', 'outside']) write(name);
  git('add', '.');
  git('commit', '--quiet', '-m', 'baseline');
  const base_commit = git('rev-parse', 'HEAD');
  write('committed', 'committed change\n');
  git('add', 'committed');
  git('commit', '--quiet', '-m', 'change protected file');
  write('staged', 'staged change\n');
  git('add', 'staged');
  write('unstaged', 'unstaged change\n');
  fs.unlinkSync(path.join(root, 'deleted'));
  write('new-file');
  write('outside', 'unprotected change\n');
  write('outside-new');
  assert.deepStrictEqual(changedProtected(root, {
    base_commit,
    paths: ['unstaged', 'staged', 'committed', 'deleted', 'new-file', 'untouched', 'committed'],
  }), { changed: ['committed', 'deleted', 'new-file', 'staged', 'unstaged'] });
});

test('treats pathspec wildcard characters literally', (t) => {
  const { root, git, write } = fixture(t);
  write('file[1].txt');
  write('file1.txt');
  git('add', '.');
  git('commit', '--quiet', '-m', 'baseline');
  const saved = { base_commit: git('rev-parse', 'HEAD'), paths: ['file[1].txt'] };
  write('file1.txt', 'changed lookalike\n');
  assert.deepStrictEqual(changedProtected(root, saved), { changed: [] });
  write('file[1].txt', 'changed literal\n');
  assert.deepStrictEqual(changedProtected(root, saved), { changed: ['file[1].txt'] });
});

test('returns no changes for unchanged and nonexistent protected paths', (t) => {
  const { root, git, write } = fixture(t);
  write('protected');
  git('add', '.');
  git('commit', '--quiet', '-m', 'baseline');
  assert.deepStrictEqual(changedProtected(root, {
    base_commit: git('rev-parse', 'HEAD'), paths: ['protected', 'missing'],
  }), { changed: [] });
});

test('returns a comparison error when the saved commit does not exist', (t) => {
  const { root } = fixture(t);
  const result = changedProtected(root, { base_commit: 'abcdef1234567890', paths: ['protected'] });
  assert.deepStrictEqual(Object.keys(result), ['error']);
  assert.match(result.error, /^cannot compare with abcdef123456: .+/);
});
