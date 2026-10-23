'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { ideaScore } = require('../lib/idea-ledger');

test('median minutes is null when landed row has no idea drop time', () => {
  const row = {
    id: 'a',
    outcome: 'landed',
    idea_at: null,
    finished: '2026-10-23T12:00:00.000Z',
  };
  const score = ideaScore([row], { now: Date.parse('2026-10-23T12:00:00.000Z') });
  assert.strictEqual(score.median_minutes_to_landed, null);
});
