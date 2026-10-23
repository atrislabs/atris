'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateCampaign } = require('../lib/campaign-schema');

test('a member seat may omit its optional role', () => {
  const result = validateCampaign({
    title: 'Ship the release',
    judge: 'node --test',
    budget: 10,
    seats: [{ member: 'builder' }],
  });

  assert.strictEqual(result.ok, true);
});
