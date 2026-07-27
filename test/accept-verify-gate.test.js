'use strict';

// The accept gate must require a proof that can fail. Each case below is a shape
// found in the 2026-07-26 reward-ledger audit, where 131 of 802 accepted proofs
// (16.3%) were unfalsifiable at the moment they were signed off.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { evaluateAcceptVerify, storedVerifyCommand } = require('../lib/accept-verify-gate');

const ROOT = path.join(__dirname, '..');
const task = (verify) => ({ metadata: { verify } });

test('an unfilled template sentence is not a proof (54 of the 131)', () => {
  const r = evaluateAcceptVerify(
    task('Concrete command, file, receipt, or verifier evidence for the member experiment.'), ROOT);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'verify_placeholder');
  assert.equal(r.ran, false);
});

test('a bare git diff --check cannot fail for the reason the task exists (55 of the 131)', () => {
  const r = evaluateAcceptVerify(task('git diff --check'), ROOT);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'verify_not_falsifying');
});

test('a bare file path is a receipt, not a check (1 of the 131)', () => {
  const r = evaluateAcceptVerify(task('/tmp/run/proof.json'), ROOT);
  assert.equal(r.ok, false);
});

test('prose joined by commas does not parse as a command', () => {
  const r = evaluateAcceptVerify(
    task('node --check, focused heartbeat test, aggregate heartbeat test, live dry run'), ROOT);
  assert.equal(r.ok, false);
  assert.equal(r.ran, false);
});

test('an absent verify field is out of scope, not a block', () => {
  // All 131 audit findings stored a command. Requiring one on every accept is a
  // separate policy change; this gate only refuses checks that cannot fail.
  const r = evaluateAcceptVerify(task(''), ROOT);
  assert.equal(r.ok, true);
  assert.equal(r.unchecked, true);
  assert.equal(evaluateAcceptVerify({ metadata: {} }, ROOT).ok, true);
});

test('a real command that passes lets the accept through', () => {
  const r = evaluateAcceptVerify(task('node --check bin/atris.js'), ROOT);
  assert.equal(r.ok, true);
  assert.equal(r.ran, true);
  assert.equal(r.exit_code, 0);
});

test('a real command that fails blocks the accept, and it actually ran', () => {
  const r = evaluateAcceptVerify(task('node --check lib/does-not-exist-anywhere.js'), ROOT);
  assert.equal(r.ok, false);
  assert.equal(r.ran, true);
});

test('storedVerifyCommand falls back to latest_agent_verify', () => {
  assert.equal(storedVerifyCommand({ metadata: { latest_agent_verify: 'npm test' } }), 'npm test');
  assert.equal(storedVerifyCommand({ metadata: { verify: 'tsc', latest_agent_verify: 'npm test' } }), 'tsc');
  assert.equal(storedVerifyCommand({}), '');
});
