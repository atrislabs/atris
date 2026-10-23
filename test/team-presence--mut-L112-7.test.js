'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTeamPresence } = require('../lib/team-presence');

test('custom mission cadence is preserved', () => {
  const presence = buildTeamPresence({
    now: '2026-10-23T12:00:00.000Z',
    missions: [
      {
        id: 'mission-custom-cadence',
        owner: 'builder',
        status: 'running',
        cadence: '15m',
        updated_at: '2026-10-23T11:55:00.000Z',
      },
    ],
  });

  assert.strictEqual(presence.members[0].loop.cadence, '15m');
});
