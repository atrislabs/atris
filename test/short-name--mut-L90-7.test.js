'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { recordMatchesRef } = require('../lib/short-name');

test('matches id prefix with leading hash reference', () => {
  const record = { id: 'mission-alpha' };
  assert.strictEqual(recordMatchesRef(record, '#mission'), true);
});
