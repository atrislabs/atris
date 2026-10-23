'use strict';

// taskTrustSubject picks whose trust a finished task counts toward. It must
// name the builder (stamped, then claimed, then executed) and never the
// approver, because trust is earned by building work, not by signing it off.

const { test } = require('node:test');
const assert = require('node:assert');
const { taskTrustSubject } = require('../lib/trust-tiers');

test('stamped built_by wins, normalized to trimmed lowercase', () => {
  const task = {
    claimed_by: 'Bob',
    metadata: { built_by: '  Alice  ', executed_by: 'Carol' },
  };
  assert.equal(taskTrustSubject(task), 'alice');
});

test('falls back to claimed_by, then metadata.executed_by', () => {
  assert.equal(taskTrustSubject({ claimed_by: ' Bob ', metadata: {} }), 'bob');
  assert.equal(taskTrustSubject({ metadata: { executed_by: 'Carol' } }), 'carol');
});

// Current behavior, pinned on purpose: a whitespace-only built_by is truthy,
// so the || chain stops there, it trims to empty, and claimed_by is never
// tried. If this is changed to fall back to 'dan', update this expectation.
test('a whitespace-only built_by blocks the claimed_by fallback and yields null', () => {
  const task = { claimed_by: 'Dan', metadata: { built_by: '   ' } };
  assert.equal(taskTrustSubject(task), null);
});

test('the approver is never the trust subject', () => {
  const task = {
    approved_by: 'Reviewer',
    actor: 'Reviewer',
    metadata: { approved_by: 'Reviewer', verify_passed: true },
  };
  assert.equal(taskTrustSubject(task), null);
});

test('missing, empty, or null input returns null', () => {
  assert.equal(taskTrustSubject(undefined), null);
  assert.equal(taskTrustSubject(null), null);
  assert.equal(taskTrustSubject({}), null);
  assert.equal(taskTrustSubject({ metadata: null, claimed_by: '' }), null);
});
