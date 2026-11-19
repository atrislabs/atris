'use strict';

// A check that opens a desktop app skips itself on a person's machine: it
// prints a fixed line and exits 75 (project-obelisk scripts/lib/launches-app.cjs).
// It used to exit 0, and the hourly lander took "did not run here" for "passed",
// so a task whose only proof opens the app landed with nothing checked.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runVerifyCommand } = require('../lib/auto-accept-certified');
const { checkSkippedHere, buildVerifiedProof, SKIPPED_HERE_EXIT, SKIPPED_HERE_LINE } = require('../lib/task-proof');
const { plainLandingReason } = require('../lib/voice-gate');

function workspace(t, body) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-skipped-here-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(path.join(root, 'scripts', 'check.js'), body);
  return root;
}

const SKIPPING = `console.log('test-mind-ui ${SKIPPED_HERE_LINE}'); process.exit(${SKIPPED_HERE_EXIT});\n`;

test('the code and line match the desktop app helper', () => {
  assert.equal(SKIPPED_HERE_EXIT, 75);
  assert.equal(SKIPPED_HERE_LINE, 'skipped on this Mac: opens the app; runs in the no-screen lane');
});

test('the lander reads a skipped app check as not verified here, never as passed', (t) => {
  const root = workspace(t, SKIPPING);
  const result = runVerifyCommand('node scripts/check.js', root);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'verify_skipped_here');
  assert.equal(result.status, 75);
});

test('exit 75 without the skip line is still a failure', (t) => {
  const root = workspace(t, "console.log('temporary failure'); process.exit(75);\n");
  const result = runVerifyCommand('node scripts/check.js', root);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'verify_failed');
});

test('the old exit 0 skip is unchanged: it reads as a pass, which is why the skip now exits 75', (t) => {
  const root = workspace(t, `console.log('x ${SKIPPED_HERE_LINE}');\n`);
  assert.equal(runVerifyCommand('node scripts/check.js', root).reason, 'verify_passed');
});

test('a ready-time proof refuses a skipped app check', () => {
  const skipped = buildVerifiedProof('node scripts/check.js', '', () => ({ status: 75, stdout: `x ${SKIPPED_HERE_LINE}\n`, stderr: '' }));
  assert.equal(skipped.ok, false);
  assert.equal(skipped.reason, 'verifier_skipped_here');
  assert.equal(checkSkippedHere({ status: 0, stdout: SKIPPED_HERE_LINE }), false);
  assert.equal(checkSkippedHere(null), false);
});

test('the refusal reads as a plain sentence', () => {
  assert.match(plainLandingReason('verify_skipped_here'), /no-screen lane/);
});
