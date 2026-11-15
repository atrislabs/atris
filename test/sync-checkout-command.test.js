'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { syncCheckoutCommand } = require('../commands/sync-checkout');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-sync-checkout-cmd-'));
const fakeHome = path.join(sandbox, 'home');
fs.mkdirSync(fakeHome);

const savedEnv = {};
const envOverrides = {
  HOME: fakeHome,
  GIT_CONFIG_GLOBAL: path.join(fakeHome, '.gitconfig'),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CEILING_DIRECTORIES: sandbox,
  GIT_TERMINAL_PROMPT: '0',
};
for (const [key, value] of Object.entries(envOverrides)) {
  savedEnv[key] = process.env[key];
  process.env[key] = value;
}

test.after(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function runCommand(args, cwd) {
  const lines = [];
  const originalLog = console.log;
  console.log = (...parts) => lines.push(parts.join(' '));
  let code;
  try {
    code = syncCheckoutCommand(args, cwd);
  } finally {
    console.log = originalLog;
  }
  return { code, lines };
}

const backupDir = path.join(fakeHome, '.atris', 'backups', 'checkout');

function listBackups() {
  return fs.existsSync(backupDir) ? fs.readdirSync(backupDir).sort() : [];
}

let counter = 0;

// Local-only setup: a bare "origin" on disk, a seed clone that pushes to it,
// and a checkout that is one commit behind after a fetch.
function createRepos() {
  counter += 1;
  fs.rmSync(path.join(fakeHome, '.atris'), { recursive: true, force: true });
  const base = path.join(sandbox, `case-${counter}`);
  const origin = path.join(base, 'origin.git');
  const seed = path.join(base, 'seed');
  const checkout = path.join(base, 'checkout');
  fs.mkdirSync(seed, { recursive: true });

  git(base, 'init', '--bare', '--initial-branch=master', origin);
  git(seed, 'init', '--initial-branch=master');
  git(seed, 'config', 'user.email', 'test@example.com');
  git(seed, 'config', 'user.name', 'test');
  fs.writeFileSync(path.join(seed, 'tracked.txt'), 'first\n');
  git(seed, 'add', 'tracked.txt');
  git(seed, 'commit', '-m', 'first');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-u', 'origin', 'master');
  git(base, 'clone', origin, checkout);
  git(checkout, 'config', 'user.email', 'test@example.com');
  git(checkout, 'config', 'user.name', 'test');

  return { base, origin, seed, checkout };
}

function pushSeedCommit(seed, content, message) {
  fs.writeFileSync(path.join(seed, 'tracked.txt'), content);
  git(seed, 'add', 'tracked.txt');
  git(seed, 'commit', '-m', message);
  git(seed, 'push');
}

test('help flags return 0 and print usage without touching git', () => {
  const missingDir = path.join(sandbox, 'does-not-exist');
  for (const args of [['--help'], ['-h'], ['help'], ['help', 'extra'], ['--dry', '--help']]) {
    const { code, lines } = runCommand(args, missingDir);
    assert.strictEqual(code, 0, `args ${JSON.stringify(args)}`);
    assert.deepStrictEqual(lines, ['usage: atris sync-checkout [--backup].']);
  }
});

test('a folder that is not a git checkout is refused with exit 1', () => {
  const plain = path.join(sandbox, 'plain-folder');
  fs.mkdirSync(plain);

  const { code, lines } = runCommand([], plain);
  assert.strictEqual(code, 1);
  assert.deepStrictEqual(lines, [
    'this checkout is not on a git branch; sync-checkout refused to touch it.',
  ]);
});

test('a detached HEAD is refused and the checkout is left alone', () => {
  const { checkout } = createRepos();
  git(checkout, 'checkout', '--detach');
  const before = git(checkout, 'rev-parse', 'HEAD');

  const { code, lines } = runCommand([], checkout);
  assert.strictEqual(code, 1);
  assert.deepStrictEqual(lines, [
    'this checkout is not on a git branch; sync-checkout refused to touch it.',
  ]);
  assert.strictEqual(git(checkout, 'rev-parse', 'HEAD'), before);
});

test('unstaged and staged tracked edits are refused without moving HEAD', () => {
  for (const staged of [false, true]) {
    const { seed, checkout } = createRepos();
    fs.writeFileSync(path.join(checkout, 'tracked.txt'), staged ? 'staged\n' : 'unstaged\n');
    if (staged) git(checkout, 'add', 'tracked.txt');
    pushSeedCommit(seed, 'second\n', 'second');
    const before = git(checkout, 'rev-parse', 'HEAD');

    const { code, lines } = runCommand([], checkout);
    assert.strictEqual(code, 1, `staged=${staged}`);
    assert.deepStrictEqual(lines, [
      'this checkout has tracked changes; sync-checkout refused to touch it.',
      'run: atris sync-checkout --backup   (saves your edits as a patch, then syncs)',
    ]);
    assert.strictEqual(git(checkout, 'rev-parse', 'HEAD'), before);
    assert.strictEqual(
      fs.readFileSync(path.join(checkout, 'tracked.txt'), 'utf8'),
      staged ? 'staged\n' : 'unstaged\n'
    );
    assert.strictEqual(fs.existsSync(backupDir), false, 'a refusal must not write a backup');
  }
});

test('a branch with no upstream is refused with exit 1', () => {
  const { checkout } = createRepos();
  git(checkout, 'checkout', '-b', 'local-only');

  const { code, lines } = runCommand([], checkout);
  assert.strictEqual(code, 1);
  assert.deepStrictEqual(lines, [
    'this checkout has no upstream; sync-checkout refused to touch it.',
  ]);
});

test('a clean checkout fast-forwards to the upstream and reports it', () => {
  const { seed, checkout } = createRepos();
  pushSeedCommit(seed, 'second\n', 'second');
  pushSeedCommit(seed, 'third\n', 'third');
  assert.notStrictEqual(git(checkout, 'rev-parse', 'HEAD'), git(seed, 'rev-parse', 'HEAD'));

  const { code, lines } = runCommand([], checkout);
  assert.strictEqual(code, 0);
  assert.deepStrictEqual(lines, ['this checkout is up to date with origin/master.']);
  assert.strictEqual(git(checkout, 'rev-parse', 'HEAD'), git(seed, 'rev-parse', 'HEAD'));
  assert.strictEqual(fs.readFileSync(path.join(checkout, 'tracked.txt'), 'utf8'), 'third\n');
});

test('untracked files do not block a sync and survive it', () => {
  const { seed, checkout } = createRepos();
  fs.writeFileSync(path.join(checkout, 'scratch.txt'), 'mine\n');
  pushSeedCommit(seed, 'second\n', 'second');

  const { code, lines } = runCommand([], checkout);
  assert.strictEqual(code, 0);
  assert.deepStrictEqual(lines, ['this checkout is up to date with origin/master.']);
  assert.strictEqual(fs.readFileSync(path.join(checkout, 'scratch.txt'), 'utf8'), 'mine\n');
  assert.strictEqual(fs.readFileSync(path.join(checkout, 'tracked.txt'), 'utf8'), 'second\n');
});

test('an already current checkout still returns 0 and changes nothing', () => {
  const { checkout } = createRepos();
  const before = git(checkout, 'rev-parse', 'HEAD');

  const { code, lines } = runCommand([], checkout);
  assert.strictEqual(code, 0);
  assert.deepStrictEqual(lines, ['this checkout is up to date with origin/master.']);
  assert.strictEqual(git(checkout, 'rev-parse', 'HEAD'), before);
});

test('a diverged branch is refused and its local commit is kept', () => {
  const { seed, checkout } = createRepos();
  fs.writeFileSync(path.join(checkout, 'local.txt'), 'local work\n');
  git(checkout, 'add', 'local.txt');
  git(checkout, 'commit', '-m', 'local work');
  const localHead = git(checkout, 'rev-parse', 'HEAD');
  pushSeedCommit(seed, 'remote change\n', 'remote change');

  const { code, lines } = runCommand([], checkout);
  assert.strictEqual(code, 1);
  assert.deepStrictEqual(lines, [
    'this checkout could not fast-forward; sync-checkout refused to change it.',
  ]);
  assert.strictEqual(git(checkout, 'rev-parse', 'HEAD'), localHead);
});

test('a failing fetch is reported and the checkout is not changed', () => {
  const { origin, checkout } = createRepos();
  const before = git(checkout, 'rev-parse', 'HEAD');
  fs.rmSync(origin, { recursive: true, force: true });

  const { code, lines } = runCommand([], checkout);
  assert.strictEqual(code, 1);
  assert.deepStrictEqual(lines, ['this checkout could not sync because git fetch failed.']);
  assert.strictEqual(git(checkout, 'rev-parse', 'HEAD'), before);
});

test('--backup saves unstaged and staged edits as a patch, then syncs', () => {
  for (const staged of [false, true]) {
    const { seed, checkout } = createRepos();
    fs.writeFileSync(path.join(checkout, 'tracked.txt'), staged ? 'staged\n' : 'unstaged\n');
    if (staged) git(checkout, 'add', 'tracked.txt');
    pushSeedCommit(seed, 'second\n', 'second');

    const { code, lines } = runCommand(['--backup'], checkout);
    assert.strictEqual(code, 0, `staged=${staged}`);

    const files = listBackups();
    assert.strictEqual(files.length, 1, `staged=${staged}`);
    assert.match(files[0], /^\d{4}-\d{2}-\d{2}-\d{6}\.patch$/);
    const patchPath = path.join(backupDir, files[0]);
    assert.deepStrictEqual(lines, [
      `saved your edits to ${patchPath}`,
      `to restore them: git apply ${patchPath}`,
      'this checkout is up to date with origin/master.',
    ]);

    // Synced, and the checkout is clean again.
    assert.strictEqual(git(checkout, 'rev-parse', 'HEAD'), git(seed, 'rev-parse', 'HEAD'));
    assert.strictEqual(git(checkout, 'status', '--porcelain', '--untracked-files=no'), '');
    assert.strictEqual(fs.readFileSync(path.join(checkout, 'tracked.txt'), 'utf8'), 'second\n');

    // The patch really holds the edit: apply it on a copy that is back at the old commit.
    git(checkout, 'checkout', '--quiet', '--detach', 'HEAD~1');
    git(checkout, 'apply', patchPath);
    assert.strictEqual(
      fs.readFileSync(path.join(checkout, 'tracked.txt'), 'utf8'),
      staged ? 'staged\n' : 'unstaged\n'
    );
  }
});

test('--backup lists untracked files by name, keeps them in place, and does not copy them', () => {
  const { seed, checkout } = createRepos();
  fs.writeFileSync(path.join(checkout, 'tracked.txt'), 'edited\n');
  fs.writeFileSync(path.join(checkout, 'scratch.txt'), 'secret scratch\n');
  fs.writeFileSync(path.join(checkout, '.gitignore'), 'ignored.log\n');
  fs.writeFileSync(path.join(checkout, 'ignored.log'), 'noise\n');
  pushSeedCommit(seed, 'second\n', 'second');

  const { code, lines } = runCommand(['--backup'], checkout);
  assert.strictEqual(code, 0);

  const files = listBackups();
  assert.strictEqual(files.length, 2);
  const patchName = files.find((name) => name.endsWith('.patch'));
  const listName = files.find((name) => name.endsWith('.untracked.txt'));
  assert.ok(patchName && listName, files.join(', '));
  assert.strictEqual(listName.replace('.untracked.txt', ''), patchName.replace('.patch', ''));

  const listPath = path.join(backupDir, listName);
  assert.deepStrictEqual(fs.readFileSync(listPath, 'utf8').split('\n').filter(Boolean), [
    '.gitignore',
    'scratch.txt',
  ]);
  assert.ok(lines.includes(`untracked files were left in place; their names are in ${listPath}`));
  assert.ok(!fs.readFileSync(path.join(backupDir, patchName), 'utf8').includes('secret scratch'));
  assert.strictEqual(fs.readFileSync(path.join(checkout, 'scratch.txt'), 'utf8'), 'secret scratch\n');
  assert.strictEqual(fs.readFileSync(path.join(checkout, 'ignored.log'), 'utf8'), 'noise\n');
});

test('--backup keeps a deleted file and a new staged file in the patch', () => {
  const { seed, checkout } = createRepos();
  fs.writeFileSync(path.join(checkout, 'added.txt'), 'brand new\n');
  git(checkout, 'add', 'added.txt');
  fs.rmSync(path.join(checkout, 'tracked.txt'));
  pushSeedCommit(seed, 'second\n', 'second');

  const { code } = runCommand(['--backup'], checkout);
  assert.strictEqual(code, 0);
  assert.strictEqual(git(checkout, 'status', '--porcelain', '--untracked-files=no'), '');
  assert.strictEqual(fs.existsSync(path.join(checkout, 'added.txt')), false);

  const patch = fs.readFileSync(path.join(backupDir, listBackups()[0]), 'utf8');
  assert.match(patch, /deleted file mode/);
  assert.match(patch, /new file mode/);
  assert.match(patch, /\+brand new/);
});

test('--backup on a clean checkout syncs like normal and writes no backup', () => {
  const { seed, checkout } = createRepos();
  pushSeedCommit(seed, 'second\n', 'second');

  const { code, lines } = runCommand(['--backup'], checkout);
  assert.strictEqual(code, 0);
  assert.deepStrictEqual(lines, ['this checkout is up to date with origin/master.']);
  assert.deepStrictEqual(listBackups(), []);
  assert.strictEqual(git(checkout, 'rev-parse', 'HEAD'), git(seed, 'rev-parse', 'HEAD'));
});

test('--backup on a current checkout leaves the edits in place and writes no backup', () => {
  const { checkout } = createRepos();
  fs.writeFileSync(path.join(checkout, 'tracked.txt'), 'mine\n');

  const { code, lines } = runCommand(['--backup'], checkout);
  assert.strictEqual(code, 0);
  assert.deepStrictEqual(lines, [
    'this checkout is up to date with origin/master; your edits were left in place.',
  ]);
  assert.deepStrictEqual(listBackups(), []);
  assert.strictEqual(fs.readFileSync(path.join(checkout, 'tracked.txt'), 'utf8'), 'mine\n');
});

test('--backup does not touch the edits when the sync could not work anyway', () => {
  // Diverged: a local commit the upstream does not have.
  {
    const { seed, checkout } = createRepos();
    fs.writeFileSync(path.join(checkout, 'local.txt'), 'local work\n');
    git(checkout, 'add', 'local.txt');
    git(checkout, 'commit', '-m', 'local work');
    fs.writeFileSync(path.join(checkout, 'tracked.txt'), 'mine\n');
    pushSeedCommit(seed, 'remote change\n', 'remote change');

    const { code, lines } = runCommand(['--backup'], checkout);
    assert.strictEqual(code, 1);
    assert.deepStrictEqual(lines, [
      'this checkout could not fast-forward; sync-checkout refused to change it.',
    ]);
    assert.deepStrictEqual(listBackups(), []);
    assert.strictEqual(fs.readFileSync(path.join(checkout, 'tracked.txt'), 'utf8'), 'mine\n');
  }

  // No upstream.
  {
    const { checkout } = createRepos();
    git(checkout, 'checkout', '-b', 'local-only');
    fs.writeFileSync(path.join(checkout, 'tracked.txt'), 'mine\n');

    const { code, lines } = runCommand(['--backup'], checkout);
    assert.strictEqual(code, 1);
    assert.deepStrictEqual(lines, [
      'this checkout has no upstream; sync-checkout refused to touch it.',
    ]);
    assert.deepStrictEqual(listBackups(), []);
    assert.strictEqual(fs.readFileSync(path.join(checkout, 'tracked.txt'), 'utf8'), 'mine\n');
  }

  // Detached HEAD.
  {
    const { checkout } = createRepos();
    git(checkout, 'checkout', '--detach');
    fs.writeFileSync(path.join(checkout, 'tracked.txt'), 'mine\n');

    const { code } = runCommand(['--backup'], checkout);
    assert.strictEqual(code, 1);
    assert.deepStrictEqual(listBackups(), []);
    assert.strictEqual(fs.readFileSync(path.join(checkout, 'tracked.txt'), 'utf8'), 'mine\n');
  }
});

test('two backups in the same second get different names', () => {
  const { seed, checkout } = createRepos();
  const RealDate = Date;
  const frozen = new RealDate(2026, 10, 12, 13, 46, 55).getTime();
  global.Date = class extends RealDate {
    constructor(...parts) {
      super(...(parts.length ? parts : [frozen]));
    }
  };
  try {
    for (const content of ['one\n', 'two\n']) {
      fs.writeFileSync(path.join(checkout, 'tracked.txt'), content);
      pushSeedCommit(seed, `${content}remote\n`, `remote ${content.trim()}`);
      const { code } = runCommand(['--backup'], checkout);
      assert.strictEqual(code, 0);
    }
  } finally {
    global.Date = RealDate;
  }
  assert.deepStrictEqual(listBackups(), ['2026-11-12-134655-1.patch', '2026-11-12-134655.patch']);
});
