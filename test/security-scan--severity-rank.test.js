'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { SEVERITY_RANK } = require('../lib/security-scan');

test('known severities rank from low to critical', () => {
  assert.deepStrictEqual(
    {
      low: SEVERITY_RANK.low,
      medium: SEVERITY_RANK.medium,
      high: SEVERITY_RANK.high,
      critical: SEVERITY_RANK.critical,
    },
    { low: 0, medium: 1, high: 2, critical: 3 },
  );

  const names = ['low', 'medium', 'high', 'critical'];
  for (let i = 0; i < names.length; i++) {
    for (let j = 0; j < names.length; j++) {
      assert.strictEqual(SEVERITY_RANK[names[i]] >= SEVERITY_RANK[names[j]], i >= j);
    }
  }
});

test('unknown and empty severity names have no rank', () => {
  assert.strictEqual(SEVERITY_RANK.Critical, undefined);
  assert.strictEqual(SEVERITY_RANK['high '], undefined);
  assert.strictEqual(SEVERITY_RANK.urgent, undefined);
  assert.strictEqual(SEVERITY_RANK[''], undefined);
  assert.strictEqual(SEVERITY_RANK[''] == null, true);
  assert.strictEqual(SEVERITY_RANK.high >= SEVERITY_RANK[''], false);
  assert.strictEqual(SEVERITY_RANK[''] >= SEVERITY_RANK.high, false);
});
