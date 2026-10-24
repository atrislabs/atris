'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildActivityStream } = require('../lib/activity-stream');

test('mission events retain their supplied type in the feed', () => {
  const events = buildActivityStream({
    missionEvents: [{ type: 'failed', ts: '2026-06-16T10:00:00Z' }],
  });

  assert.strictEqual(events[0].kind, 'failed');
});
