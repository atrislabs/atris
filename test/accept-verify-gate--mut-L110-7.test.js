'use strict';

// When a stored verify command runs and fails, the gate must hand back the reason
// the runner gave, not flatten every failure into the generic 'verify_failed'.
// A verify that points at a directory that no longer exists is one of 21 proofs in
// the 2026-07-26 audit, and callers tell it apart from a real red check by reason.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const savedEnv = {};
let workspace;
let evaluateAcceptVerify;

before(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-accept-gate-reason-'));
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
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('a verify whose directory is gone keeps the runner reason, not the generic one', () => {
  const task = { metadata: { verify: 'cd gone-worktree && node --test missing.test.js' } };
  const r = evaluateAcceptVerify(task, workspace);

  assert.equal(r.ok, false);
  assert.equal(r.ran, true);
  assert.equal(r.reason, 'verify_workdir_missing');
  assert.notEqual(r.reason, 'verify_failed');
  assert.equal(r.detail, 'the stored verify command points at a directory that no longer exists');
  assert.equal(r.command, 'cd gone-worktree && node --test missing.test.js');
  assert.equal(r.exit_code, null);
});
