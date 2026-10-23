'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeTaskEpisode } = require('../lib/activity-stream');

test('task episode detail preserves the explicit action over the state status', () => {
  const event = normalizeTaskEpisode({
    action: 'reviewed',
    state: { title: 'fix bug', status: 'review' },
  });

  assert.equal(event.detail, 'reviewed');
});
