'use strict';

// When a stored verify command runs and fails, the gate reports the exit code the
// command actually returned. A syntax error makes `node --check` exit 1, so the
// result must carry exit_code 1, not null. The file lives in a fresh temp workspace
// so nothing under the repo is read or written.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { evaluateAcceptVerify } = require('../lib/accept-verify-gate');

test('a verify that runs and exits nonzero reports the real exit code', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-verify-exit-'));
  try {
    fs.writeFileSync(path.join(workspace, 'broken.js'), 'function (\n');
    const r = evaluateAcceptVerify({ metadata: { verify: 'node --check broken.js' } }, workspace);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'verify_failed');
    assert.equal(r.ran, true);
    assert.equal(r.exit_code, 1);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
