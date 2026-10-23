'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { scoreTick } = require('../lib/pulse');

test('a missing mission without work does not count as an engine crash', () => {
  assert.strictEqual(scoreTick({
    verifyPassed: null,
    producedWork: false,
    actorOk: false,
    actorReason: 'mission_not_found',
  }), 0);
});
