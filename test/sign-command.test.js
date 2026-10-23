'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  TRAILER,
  installSignHook,
  removeSignHook,
  signCommand,
  signStatus,
} = require('../commands/sign');

function tempRepo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-sign-'));
  fs.mkdirSync(path.join(root, '.git'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function withCwd(root, fn) {
  const previous = process.cwd();
  process.chdir(root);
  try {
    return fn();
  } finally {
    process.chdir(previous);
  }
}

function captureLog(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.map((part) => String(part)).join(' '));
  try {
    const code = fn();
    return { code, out: lines.join('\n') };
  } finally {
    console.log = original;
  }
}

test('install writes one executable co-author hook and status reports it', (t) => {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-sign-nogit-'));
  t.after(() => fs.rmSync(bare, { recursive: true, force: true }));
  assert.throws(() => installSignHook(bare), /not a git repo/);

  const root = tempRepo(t);
  const hookPath = path.join(root, '.git', 'hooks', 'prepare-commit-msg');
  const first = installSignHook(root);
  const text = fs.readFileSync(hookPath, 'utf8');

  assert.strictEqual(first.already, false);
  assert.strictEqual(first.hookPath, hookPath);
  assert.ok(text.startsWith('#!/bin/sh\n'));
  assert.ok(text.includes('# atris co-author'));
  assert.ok(text.includes('"$2" != "merge"'));
  assert.ok(text.includes('"$2" != "squash"'));
  assert.ok(text.includes(TRAILER));
  assert.strictEqual(fs.statSync(hookPath).mode & 0o777, 0o755);
  assert.deepStrictEqual(signStatus(root), { hookPath, installed: true });

  const second = installSignHook(root);
  assert.strictEqual(second.already, true);
  assert.strictEqual(fs.readFileSync(hookPath, 'utf8'), text);
});

test('remove leaves other hook lines, and sign reports help, status, and off', (t) => {
  const root = tempRepo(t);
  const hookPath = path.join(root, '.git', 'hooks', 'prepare-commit-msg');
  const foreign = '#!/bin/sh\necho keep-me\n';

  assert.deepStrictEqual(removeSignHook(root), { hookPath, removed: false });
  assert.deepStrictEqual(signStatus(root), { hookPath, installed: false });

  fs.mkdirSync(path.dirname(hookPath), { recursive: true });
  fs.writeFileSync(hookPath, foreign);
  installSignHook(root);
  assert.strictEqual(removeSignHook(root).removed, true);
  assert.strictEqual(fs.readFileSync(hookPath, 'utf8'), foreign);

  fs.rmSync(hookPath);
  installSignHook(root);
  assert.strictEqual(removeSignHook(root).removed, true);
  assert.strictEqual(fs.existsSync(hookPath), false);

  withCwd(root, () => {
    const help = captureLog(() => signCommand('nope'));
    assert.strictEqual(help.code, 2);
    assert.ok(help.out.includes('atris sign          install the prepare-commit-msg hook'));
    assert.ok(help.out.includes('atris sign off      remove it'));
    assert.ok(help.out.includes('atris sign status   check whether it\'s installed'));
    assert.ok(help.out.includes(TRAILER));

    const off = captureLog(() => signCommand('status'));
    assert.strictEqual(off.code, 0);
    assert.ok(off.out.includes("atris co-author is off, run 'atris sign' to turn it on"));

    const installed = captureLog(() => signCommand());
    assert.strictEqual(installed.code, 0);
    assert.ok(installed.out.includes('atris co-author installed: .git/hooks/prepare-commit-msg'));
    assert.ok(installed.out.includes(TRAILER));
    assert.strictEqual(signStatus(root).installed, true);

    const again = captureLog(() => signCommand('install'));
    assert.strictEqual(again.code, 0);
    assert.ok(again.out.includes('already installed: .git/hooks/prepare-commit-msg'));

    const on = captureLog(() => signCommand('on'));
    assert.strictEqual(on.code, 0);
    assert.ok(on.out.includes('already installed: .git/hooks/prepare-commit-msg'));

    const status = captureLog(() => signCommand('status'));
    assert.strictEqual(status.code, 0);
    assert.ok(status.out.includes('atris co-author is on: .git/hooks/prepare-commit-msg'));
    assert.ok(status.out.includes(`every commit gets: ${TRAILER}`));

    const removed = captureLog(() => signCommand('off'));
    assert.strictEqual(removed.code, 0);
    assert.ok(removed.out.includes('atris co-author removed: .git/hooks/prepare-commit-msg'));
    assert.strictEqual(fs.existsSync(hookPath), false);

    const nothing = captureLog(() => signCommand('remove'));
    assert.strictEqual(nothing.code, 0);
    assert.ok(nothing.out.includes('nothing to remove, atris co-author is not installed'));
  });
});
