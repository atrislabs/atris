'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeScorecard } = require('../lib/activity-stream');

test('scorecard kind prefers source, then member, then tick', () => {
  assert.equal(normalizeScorecard({ source: 'review', member: 'builder' }).kind, 'review');
  assert.equal(normalizeScorecard({ source: 'review' }).kind, 'review');
  assert.equal(normalizeScorecard({ member: 'builder' }).kind, 'builder');
  assert.equal(normalizeScorecard({}).kind, 'tick');
});
