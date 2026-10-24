'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateEvent } = require('../lib/campaign-schema');

test('an event with an empty origin reports bad_origin', () => {
  const result = validateEvent({
    id: 'evt-empty-origin',
    campaign_id: 'cmp-ship',
    type: 'campaign_started',
    at: '2026-10-15T10:00:00Z',
    origin: '',
    seq: 1,
    actor: 'mission-lead',
    data: { title: 'Ship campaign', judge: 'node check.js', budget: 10 },
  });

  assert.strictEqual(result.errors.includes('bad_origin'), true);
});
