'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { checkoutBehind, checkoutBehindMessage } = require('../lib/checkout-sync');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env,
    timeout: 30000,
  });
  if (result.error) throw result.error;
  return result;
}

function git(cwd, ...args) {
  const result = run('git', args, cwd);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function runCli(cwd, ...args) {
  return run(process.execPath, [cliPath, ...args], cwd, {
    ...process.env,
    ATRIS_SKIP_UPDATE_CHECK: '1',
  });
}

function createBehindCheckout() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-sync-checkout-'));
  const origin = path.join(base, 'origin.git');
  const seed = path.join(base, 'seed');
  const checkout = path.join(base, 'checkout');

  fs.mkdirSync(seed);
  git(base, 'init', '--bare', '--initial-branch=master', origin);
  git(seed, 'init', '--initial-branch=master');
  git(seed, 'config', 'user.email', 'test@example.com');
  git(seed, 'config', 'user.name', 'test');
  fs.mkdirSync(path.join(seed, 'atris'));
  fs.writeFileSync(path.join(seed, 'atris', 'TODO.md'), '# TODO\n');
  fs.writeFileSync(path.join(seed, 'tracked.txt'), 'first\n');
  git(seed, 'add', 'atris/TODO.md', 'tracked.txt');
  git(seed, 'commit', '-m', 'first');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-u', 'origin', 'master');
  git(base, 'clone', origin, checkout);

  fs.writeFileSync(path.join(seed, 'tracked.txt'), 'second\n');
  git(seed, 'add', 'tracked.txt');
  git(seed, 'commit', '-m', 'second');
  git(seed, 'push');
  git(checkout, 'fetch');

  return { base, checkout };
}

test('behind detection reports commits behind origin in boot output', () => {
  const { base, checkout } = createBehindCheckout();
  try {
    assert.deepEqual(checkoutBehind(checkout), {
      count: 1,
      upstream: 'origin/master',
      remote: 'origin',
    });
    assert.equal(
      checkoutBehindMessage(checkout),
      'this checkout is 1 commit behind origin; run atris sync-checkout'
    );

    const boot = runCli(checkout, 'atris.md');
    assert.equal(boot.status, 0, boot.stderr);
    assert.match(
      boot.stdout,
      /this checkout is 1 commit behind origin; run atris sync-checkout/
    );

    const status = runCli(checkout, 'status', '--quick');
    assert.equal(status.status, 0, status.stderr);
    assert.match(
      status.stdout,
      /this checkout is 1 commit behind origin; run atris sync-checkout/
    );
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('sync-checkout refuses unstaged and staged tracked changes without fetching', () => {
  for (const staged of [false, true]) {
    const { base, checkout } = createBehindCheckout();
    try {
      fs.writeFileSync(path.join(checkout, 'tracked.txt'), staged ? 'staged\n' : 'unstaged\n');
      if (staged) git(checkout, 'add', 'tracked.txt');
      const beforeHead = git(checkout, 'rev-parse', 'HEAD');
      const beforeOrigin = git(checkout, 'rev-parse', 'origin/master');
      git(path.join(base, 'seed'), 'commit', '--allow-empty', '-m', 'third');
      git(path.join(base, 'seed'), 'push');

      const result = runCli(checkout, 'sync-checkout');
      assert.equal(result.status, 1);
      assert.equal(
        result.stdout.trim(),
        'this checkout has tracked changes; sync-checkout refused to touch it.'
      );
      assert.equal(git(checkout, 'rev-parse', 'HEAD'), beforeHead);
      assert.equal(git(checkout, 'rev-parse', 'origin/master'), beforeOrigin);
      assert.equal(
        fs.readFileSync(path.join(checkout, 'tracked.txt'), 'utf8'),
        staged ? 'staged\n' : 'unstaged\n'
      );
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  }
});

test('sync-checkout fetches and fast-forwards a clean current branch', () => {
  const { base, checkout } = createBehindCheckout();
  try {
    const result = runCli(checkout, 'sync-checkout');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'this checkout is up to date with origin/master.');
    assert.equal(git(checkout, 'rev-parse', 'HEAD'), git(checkout, 'rev-parse', 'origin/master'));
    assert.equal(fs.readFileSync(path.join(checkout, 'tracked.txt'), 'utf8'), 'second\n');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
