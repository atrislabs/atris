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

let counter = 0;

// Local-only setup: a bare "origin" on disk, a seed clone that pushes to it,
// and a checkout that is one commit behind after a fetch.
function createRepos() {
  counter += 1;
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
    assert.deepStrictEqual(lines, ['usage: atris sync-checkout.']);
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
    ]);
    assert.strictEqual(git(checkout, 'rev-parse', 'HEAD'), before);
    assert.strictEqual(
      fs.readFileSync(path.join(checkout, 'tracked.txt'), 'utf8'),
      staged ? 'staged\n' : 'unstaged\n'
    );
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
