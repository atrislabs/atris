'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildMissionRoom } = require('../lib/mission-room');

test('normalizes action verbs for title creation', () => {
  const room = buildMissionRoom('clarifies onboarding');
  assert.strictEqual(room.name, 'Onboarding Mission Room');
});
