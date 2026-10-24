'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildWorkforcePresence } = require('../lib/workforce-presence');

test('claimed task preserves its title in workforce presence', () => {
  const presence = buildWorkforcePresence({
    nowMs: 1700000000000,
    tasks: [
      {
        id: 'task-1',
        title: 'Fix issue with presence reporting',
        status: 'claimed',
        claimed_by: 'runtime-engineer',
        updated_at: 1700000000000,
      },
    ],
  });

  assert.strictEqual(presence.waiting[0]?.title, 'Fix issue with presence reporting');
});
