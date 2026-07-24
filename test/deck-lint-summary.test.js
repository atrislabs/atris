'use strict';

// deck compose's one-line lint tally must use singular nouns for a count of 1
// ("1 error, 1 warning") instead of the machine-plural "1 errors, 1 warnings".

const test = require('node:test');
const assert = require('node:assert/strict');
const { countLabel, lintSummary } = require('../commands/deck');

test('countLabel uses the singular noun for exactly one', () => {
  assert.equal(countLabel(1, 'slide'), '1 slide');
  assert.equal(countLabel(1, 'error'), '1 error');
});

test('countLabel pluralizes zero and many', () => {
  assert.equal(countLabel(0, 'slide'), '0 slides');
  assert.equal(countLabel(3, 'warning'), '3 warnings');
});

test('lintSummary reports singular error and warning at a count of one', () => {
  const findings = [
    { severity: 'error', slide: 1, rule: 'r', message: 'm' },
    { severity: 'warn', slide: 2, rule: 'r', message: 'm' },
  ];
  assert.equal(lintSummary(findings), '1 error, 1 warning');
});

test('lintSummary pluralizes zero and many', () => {
  assert.equal(lintSummary([]), '0 errors, 0 warnings');
  const findings = [
    { severity: 'error', slide: 1, rule: 'r', message: 'm' },
    { severity: 'error', slide: 2, rule: 'r', message: 'm' },
    { severity: 'warn', slide: 3, rule: 'r', message: 'm' },
    { severity: 'warn', slide: 4, rule: 'r', message: 'm' },
  ];
  assert.equal(lintSummary(findings), '2 errors, 2 warnings');
});
