'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { scoreFindings } = require('../lib/security-scan');

test('scoreFindings sums severity weights across findings', () => {
  const findings = [
    { sev: 'critical' },
    { sev: 'high' },
    { sev: 'medium' },
    { sev: 'low' },
  ];
  assert.equal(scoreFindings(findings), 161);
});

test('scoreFindings counts repeated severities per finding', () => {
  assert.equal(scoreFindings([{ sev: 'critical' }, { sev: 'critical' }]), 200);
  assert.equal(scoreFindings([{ sev: 'high' }, { sev: 'high' }, { sev: 'low' }]), 101);
});

test('scoreFindings returns 0 for an empty findings list', () => {
  assert.equal(scoreFindings([]), 0);
});

test('scoreFindings treats unknown or missing severities as zero', () => {
  const findings = [
    { sev: 'info' },
    { sev: 'CRITICAL' },
    {},
    { sev: 'medium' },
  ];
  assert.equal(scoreFindings(findings), 10);
});
