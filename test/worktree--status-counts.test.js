'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const tmpRoot = fs.realpathSync(os.tmpdir());
const home = fs.mkdtempSync(path.join(tmpRoot, 'atris-status-counts-home-'));

for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_') || key.startsWith('GIT_')) delete process.env[key];
}
process.env.HOME = home;
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = path.join(home, '.gitconfig');
process.env.GIT_CONFIG_SYSTEM = path.join(home, 'system.gitconfig');
process.env.GIT_CEILING_DIRECTORIES = tmpRoot;
fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, [
  '[user]',
  '\temail = t@example.com',
  '\tname = tester',
  '[commit]',
  '\tgpgsign = false',
  '[core]',
  '\tautocrlf = false',
  '\tquotepath = false',
  '',
].join('\n'));
fs.writeFileSync(process.env.GIT_CONFIG_SYSTEM, '');

function gitAvailable() {
  try {
    execFileSync('git', ['--version'], { stdio: 'pipe', env: process.env });
    return true;
  } catch {
    return false;
  }
}

if (!gitAvailable()) {
  const bin = ['/usr/bin', '/bin', '/usr/local/bin', '/opt/homebrew/bin']
    .find((dir) => fs.existsSync(path.join(dir, 'git')));
  if (!bin) throw new Error('git is not available');
  process.env.PATH = [bin, process.env.PATH].filter(Boolean).join(path.delimiter);
  if (!gitAvailable()) throw new Error('git is not available');
}

const { statusCounts } = require('../commands/worktree');

after(() => fs.rmSync(home, { recursive: true, force: true }));

function git(cwd, args) {
  execFileSync('git', args, { cwd, env: process.env, stdio: 'pipe' });
}

function makeTemp(t, prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(tmpRoot, prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function initRepo(t) {
  const root = makeTemp(t, 'atris-status-counts-repo-');
  git(root, ['init', '-q']);
  git(root, ['commit', '-q', '--allow-empty', '-m', 'init']);
  return root;
}

test('statusCounts counts staged, unstaged, and untracked changes', (t) => {
  const root = initRepo(t);
  assert.deepStrictEqual(statusCounts(root), { staged: 0, unstaged: 0, untracked: 0 });

  fs.writeFileSync(path.join(root, 'tracked.txt'), 'one\n');
  git(root, ['add', 'tracked.txt']);
  git(root, ['commit', '-q', '-m', 'add tracked']);
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'two\n');
  fs.writeFileSync(path.join(root, 'staged.txt'), 'staged\n');
  git(root, ['add', 'staged.txt']);
  fs.writeFileSync(path.join(root, 'loose.txt'), 'loose\n');

  assert.deepStrictEqual(statusCounts(root), { staged: 1, unstaged: 1, untracked: 1 });
  assert.deepStrictEqual(statusCounts(root, {}), { staged: 1, unstaged: 1, untracked: 1 });

  git(root, ['add', 'tracked.txt']);
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'three\n');

  assert.deepStrictEqual(statusCounts(root), { staged: 2, unstaged: 1, untracked: 1 });
});

test('statusCounts skips ignored paths and expands untracked directories', (t) => {
  const root = initRepo(t);
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'one\n');
  fs.writeFileSync(path.join(root, 'also.txt'), 'one\n');
  fs.writeFileSync(path.join(root, 'both.txt'), 'one\n');
  git(root, ['add', 'tracked.txt', 'also.txt', 'both.txt']);
  git(root, ['commit', '-q', '-m', 'add tracked files']);

  fs.writeFileSync(path.join(root, 'tracked.txt'), 'two\n');
  fs.writeFileSync(path.join(root, 'also.txt'), 'two\n');
  fs.writeFileSync(path.join(root, 'both.txt'), 'two\n');
  git(root, ['add', 'both.txt']);
  fs.writeFileSync(path.join(root, 'both.txt'), 'three\n');

  fs.writeFileSync(path.join(root, 'staged.txt'), 'staged\n');
  fs.writeFileSync(path.join(root, 'kept-staged.txt'), 'kept\n');
  git(root, ['add', 'staged.txt', 'kept-staged.txt']);

  fs.mkdirSync(path.join(root, 'noise'));
  fs.writeFileSync(path.join(root, 'noise', 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(root, 'noise', 'b.txt'), 'b\n');
  fs.writeFileSync(path.join(root, 'skip-me.txt'), 'skip\n');
  fs.writeFileSync(path.join(root, 'keep-me.txt'), 'keep\n');

  assert.deepStrictEqual(statusCounts(root), { staged: 3, unstaged: 3, untracked: 3 });

  const expanded = statusCounts(root, {
    ignoredUntrackedFiles: new Set(['noise/a.txt', 'noise/b.txt']),
  });
  assert.deepStrictEqual(expanded, { staged: 3, unstaged: 3, untracked: 2 });

  const filtered = statusCounts(root, {
    ignoredUnstagedFiles: new Set(['tracked.txt', 'both.txt']),
    ignoredUntrackedFiles: new Set(['skip-me.txt']),
    ignoreUntracked: (file) => file.startsWith('noise/'),
    ignoreAny: (file) => file === 'staged.txt',
  });
  assert.deepStrictEqual(filtered, { staged: 2, unstaged: 2, untracked: 1 });
});

test('statusCounts returns null when git status cannot run', (t) => {
  const root = makeTemp(t, 'atris-status-counts-empty-');
  const missing = path.join(root, 'missing');
  const file = path.join(root, 'plain.txt');
  const broken = path.join(root, 'broken');
  fs.writeFileSync(file, 'x\n');
  fs.mkdirSync(path.join(broken, '.git'), { recursive: true });

  assert.strictEqual(statusCounts(missing), null);
  assert.strictEqual(statusCounts(file), null);
  assert.strictEqual(statusCounts(broken), null);
});
