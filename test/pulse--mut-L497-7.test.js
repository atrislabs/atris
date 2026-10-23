'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const pulse = require('../lib/pulse');

test('expiry defaults to exactly seven days when days is omitted or null', () => {
  const expected = {
    source: 'days',
    hours: null,
    days: 7,
    seconds: 604800,
  };

  assert.deepStrictEqual(pulse.normalizeExpiryDuration({}), expected);
  assert.deepStrictEqual(pulse.normalizeExpiryDuration({ days: null }), expected);
});
