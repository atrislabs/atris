'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createHash } = require('node:crypto');
const { applyBaseline } = require('../lib/security-scan');

test('applyBaseline suppresses accepted findings and counts only active severities', () => {
  const findings = [
    { rule: 'private-key', sev: 'critical', fingerprint: 'accepted', suppressed: false },
    { rule: 'assigned-secret', sev: 'high', fingerprint: 'open', suppressed: true },
    { rule: 'email', sev: 'low', fingerprint: 'accepted' },
    { rule: 'eval-call', sev: 'medium', fingerprint: 'review' },
  ];
  const original = findings.map((finding) => ({ ...finding }));
  const baseline = ['accepted', 'accepted', 'absent'];

  const result = applyBaseline(findings, baseline);

  assert.deepStrictEqual(result, {
    findings: [
      { ...findings[1], suppressed: false },
      { ...findings[3], suppressed: false },
    ],
    allFindings: findings.map((finding) => ({
      ...finding,
      suppressed: finding.fingerprint === 'accepted',
    })),
    suppressed: 2,
    counts: { critical: 0, high: 1, medium: 1, low: 0 },
    countsAll: { critical: 1, high: 1, medium: 1, low: 1 },
  });
  assert.deepStrictEqual(findings, original);
  assert.deepStrictEqual(baseline, ['accepted', 'accepted', 'absent']);
  result.allFindings.forEach((finding, index) => {
    assert.notStrictEqual(finding, findings[index]);
  });
});

test('applyBaseline generates normalized fingerprints independent of line numbers', () => {
  const fingerprint = createHash('sha256')
    .update('eval-call|code|src/run.js|eval( input )')
    .digest('hex');
  const findings = [
    { rule: 'eval-call', cat: 'code', file: 'src/run.js', line: 1,
      sev: 'medium', snippet: '  eval(\tinput\n)  ' },
    { rule: 'eval-call', cat: 'code', file: 'src/run.js', line: 99,
      sev: 'medium', snippet: 'eval( input )', fingerprint: '' },
  ];

  assert.deepStrictEqual(applyBaseline(findings, [fingerprint]), {
    findings: [],
    allFindings: findings.map((finding) => ({ ...finding, fingerprint, suppressed: true })),
    suppressed: 2,
    counts: { critical: 0, high: 0, medium: 0, low: 0 },
    countsAll: { critical: 0, high: 0, medium: 2, low: 0 },
  });
  assert.strictEqual(Object.hasOwn(findings[0], 'fingerprint'), false);
  assert.strictEqual(findings[1].fingerprint, '');
});

test('applyBaseline defaults to no suppressions and handles empty findings', () => {
  const finding = { rule: 'email', sev: 'low', fingerprint: 'known', suppressed: true };
  assert.deepStrictEqual(applyBaseline([finding]), {
    findings: [{ ...finding, suppressed: false }],
    allFindings: [{ ...finding, suppressed: false }],
    suppressed: 0,
    counts: { critical: 0, high: 0, medium: 0, low: 1 },
    countsAll: { critical: 0, high: 0, medium: 0, low: 1 },
  });
  const empty = {
    findings: [], allFindings: [], suppressed: 0,
    counts: { critical: 0, high: 0, medium: 0, low: 0 },
    countsAll: { critical: 0, high: 0, medium: 0, low: 0 },
  };
  assert.deepStrictEqual(applyBaseline([]), empty);
  assert.deepStrictEqual(applyBaseline([], ['unused']), empty);
});
