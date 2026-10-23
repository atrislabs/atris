'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { summarizeFindings } = require('../lib/security-scan');

test('summarizeFindings counts each severity and always returns all four keys', () => {
  const findings = [
    { sev: 'critical', rule: 'aws-key' },
    { sev: 'high', rule: 'private-key' },
    { sev: 'high', rule: 'slack-token' },
    { sev: 'medium', rule: 'home-path' },
    { sev: 'low', rule: 'todo-secret' },
    { sev: 'low', rule: 'email' },
    { sev: 'low', rule: 'ip-address' },
  ];

  assert.deepStrictEqual(summarizeFindings(findings), {
    critical: 1,
    high: 2,
    medium: 1,
    low: 3,
  });
});

test('summarizeFindings returns zeros for an empty list and does not mutate its input', () => {
  const findings = [];

  assert.deepStrictEqual(summarizeFindings(findings), {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
  });
  assert.deepStrictEqual(findings, []);
});

test('summarizeFindings gives an unknown severity its own key and leaves the four known keys alone', () => {
  const counts = summarizeFindings([
    { sev: 'high' },
    { sev: 'info' },
    { sev: 'info' },
  ]);

  assert.strictEqual(counts.high, 1);
  assert.strictEqual(counts.info, 2);
  assert.strictEqual(counts.critical, 0);
  assert.strictEqual(counts.medium, 0);
  assert.strictEqual(counts.low, 0);
});

test('summarizeFindings throws a TypeError when given something that is not a list', () => {
  assert.throws(() => summarizeFindings(undefined), TypeError);
  assert.throws(() => summarizeFindings(null), TypeError);
});
