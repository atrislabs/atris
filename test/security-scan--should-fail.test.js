'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { shouldFail } = require('../lib/security-scan');

test('shouldFail defaults to high severity and considers every finding', () => {
  assert.strictEqual(shouldFail([{ sev: 'low' }, { sev: 'medium' }]), false);
  assert.strictEqual(shouldFail([{ sev: 'low' }, { sev: 'high' }]), true);
  assert.strictEqual(shouldFail([{ sev: 'critical' }]), true);
});

test('shouldFail includes the threshold and rejects severities below it', () => {
  const severities = ['low', 'medium', 'high', 'critical'];
  for (const [thresholdIndex, threshold] of severities.entries()) {
    for (const [severityIndex, severity] of severities.entries()) {
      assert.strictEqual(
        shouldFail([{ sev: severity }], threshold),
        severityIndex >= thresholdIndex,
        `${severity} finding at ${threshold} threshold`
      );
    }
  }
});

test('shouldFail falls back to high for an unknown or null threshold', () => {
  for (const threshold of ['unknown', '', null]) {
    assert.strictEqual(shouldFail([{ sev: 'medium' }], threshold), false);
    assert.strictEqual(shouldFail([{ sev: 'high' }], threshold), true);
  }
});

test('shouldFail returns false for empty findings and ignores unknown severities', () => {
  for (const threshold of ['low', 'medium', 'high', 'critical']) {
    assert.strictEqual(shouldFail([], threshold), false);
    assert.strictEqual(shouldFail([{ sev: 'unknown' }, {}], threshold), false);
  }
  assert.strictEqual(shouldFail([]), false);
  assert.strictEqual(shouldFail([{ sev: 'unknown' }, { sev: 'high' }]), true);
});
