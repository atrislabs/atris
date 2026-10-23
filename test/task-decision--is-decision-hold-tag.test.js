'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { isDecisionHoldTag } = require('../lib/task-decision');

test('the three hold tags match', () => {
  assert.equal(isDecisionHoldTag('needs-human'), true);
  assert.equal(isDecisionHoldTag('needshuman'), true);
  assert.equal(isDecisionHoldTag('decision'), true);
});

test('spacing, case, and underscores still count as a hold', () => {
  assert.equal(isDecisionHoldTag('  NEEDS_HUMAN  '), true);
  assert.equal(isDecisionHoldTag('Decision'), true);
  assert.equal(isDecisionHoldTag('NEEDSHUMAN'), true);
});

test('empty, missing, and nearby tags are not holds', () => {
  assert.equal(isDecisionHoldTag(''), false);
  assert.equal(isDecisionHoldTag('   '), false);
  assert.equal(isDecisionHoldTag(null), false);
  assert.equal(isDecisionHoldTag(undefined), false);
  assert.equal(isDecisionHoldTag('needs-human,decision'), false);
  assert.equal(isDecisionHoldTag('#decision'), false);
  assert.equal(isDecisionHoldTag('decisions'), false);
  assert.equal(isDecisionHoldTag('needs--human'), false);
});
