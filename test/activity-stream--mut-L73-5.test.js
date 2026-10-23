'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeTaskEpisode } = require('../lib/activity-stream');

test('a zero reward preserves the review status of a task episode', () => {
  const event = normalizeTaskEpisode({
    reward: 0,
    state: { title: 'Ready for review', status: 'review' },
  });

  assert.equal(event.status, 'review');
});
