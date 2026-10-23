'use strict';

// The failure message depends on why the stored verify command failed: a command
// that points at a directory that is gone says so, a command that ran and exited
// nonzero says it did not pass. Each case pins the exact text.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const savedEnv = {};
let tmpRoot;
let evaluateAcceptVerify;

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-verify-detail-'));
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  }
  ({ evaluateAcceptVerify } = require('../lib/accept-verify-gate'));
});

after(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const task = (verify) => ({ metadata: { verify } });

const GONE_DETAIL = 'the stored verify command points at a directory that no longer exists';

test('a command that ran and exited nonzero reports it did not pass, not a missing directory', () => {
  fs.writeFileSync(path.join(tmpRoot, 'broken.js'), 'const = ;\n');
  const r = evaluateAcceptVerify(task('node --check broken.js'), tmpRoot);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'verify_failed');
  assert.strictEqual(r.ran, true);
  assert.strictEqual(r.exit_code, 1);
  assert.strictEqual(r.detail, 'the stored verify command did not pass (verify_failed)');
});

test('a cd into a directory that is gone reports the directory is missing', () => {
  const r = evaluateAcceptVerify(task('cd gone-dir && node --check x.js'), tmpRoot);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'verify_workdir_missing');
  assert.strictEqual(r.ran, true);
  assert.strictEqual(r.detail, GONE_DETAIL);
});

test('a git -C into a worktree that is gone reports the directory is missing', () => {
  const r = evaluateAcceptVerify(task('git -C gone-worktree diff --check HEAD'), tmpRoot);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'verify_worktree_missing');
  assert.strictEqual(r.ran, true);
  assert.strictEqual(r.detail, GONE_DETAIL);
});
