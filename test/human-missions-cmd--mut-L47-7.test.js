'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { stableMissionKey } = require('../commands/human-missions');

test('different goals do not share a mission deduplication key', () => {
  assert.notStrictEqual(
    stableMissionKey('user-1', 'business-1', 'Paint the door'),
    stableMissionKey('user-1', 'business-1', 'Repair the roof'),
  );
});
