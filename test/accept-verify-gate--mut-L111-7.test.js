'use strict';

// When the stored verify command points at a directory that is gone, the accept
// gate must say so in plain words. Either missing-directory reason (a `cd` target
// or a `git -C` worktree) has to pick that message; a command that really ran and
// failed gets the generic "did not pass" message instead.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MISSING_DIR_DETAIL = 'the stored verify command points at a directory that no longer exists';

let workspace;
let evaluateAcceptVerify;
const task = (verify) => ({ metadata: { verify } });

before(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-verify-gate-dir-'));
  fs.writeFileSync(path.join(workspace, 'broken.js'), 'const = ;\n');
  ({ evaluateAcceptVerify } = require('../lib/accept-verify-gate'));
});

after(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('a cd into a deleted directory is reported as a missing directory', () => {
  const r = evaluateAcceptVerify(task('cd deleted-workdir && node --check broken.js'), workspace);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'verify_workdir_missing');
  assert.strictEqual(r.ran, true);
  assert.strictEqual(r.detail, MISSING_DIR_DETAIL);
  assert.strictEqual(r.exit_code, null);
});

test('a git -C into a deleted worktree is reported as a missing directory', () => {
  const r = evaluateAcceptVerify(task('git -C deleted-worktree diff --check'), workspace);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'verify_worktree_missing');
  assert.strictEqual(r.ran, true);
  assert.strictEqual(r.detail, MISSING_DIR_DETAIL);
  assert.strictEqual(r.exit_code, null);
});

test('a command that ran and failed gets the generic did-not-pass message', () => {
  const r = evaluateAcceptVerify(task('node --check broken.js'), workspace);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'verify_failed');
  assert.strictEqual(r.detail, 'the stored verify command did not pass (verify_failed)');
  assert.notStrictEqual(r.detail, MISSING_DIR_DETAIL);
  assert.strictEqual(typeof r.exit_code, 'number');
  assert.notStrictEqual(r.exit_code, 0);
});
