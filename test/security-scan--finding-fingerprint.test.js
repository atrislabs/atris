'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { findingFingerprint } = require('../lib/security-scan');

test('findingFingerprint hashes the rule, category, file and normalized snippet', () => {
  const finding = {
    rule: 'eval-call',
    cat: 'code',
    file: 'src/app.js',
    snippet: 'eval(input)',
  };
  const expected = '01dfc7583fde15abb88f6754f0cb4d21adf777aa6bdc7e599b32286660ae10fe';

  assert.strictEqual(findingFingerprint(finding), expected);
  assert.strictEqual(findingFingerprint({
    ...finding, snippet: ' \t eval(input)\r\n ', line: 99,
    sev: 'critical', why: 'different explanation', suppressed: true,
  }), expected);

  for (const field of ['rule', 'cat', 'file', 'snippet']) {
    assert.notStrictEqual(
      findingFingerprint({ ...finding, [field]: finding[field] + '-changed' }),
      expected,
      `changing ${field} must change the fingerprint`,
    );
  }
});

test('findingFingerprint collapses internal whitespace without changing case', () => {
  const finding = { rule: 'assigned-secret', cat: 'secret', file: 'config.js' };
  const normalized = findingFingerprint({ ...finding, snippet: 'Alpha Beta Gamma' });

  assert.strictEqual(findingFingerprint({
    ...finding, snippet: '\n Alpha\t\tBeta\r\nGamma  ',
  }), normalized);
  assert.notStrictEqual(findingFingerprint({
    ...finding, snippet: 'alpha Beta Gamma',
  }), normalized);
});

test('findingFingerprint accepts empty fields and rejects a missing finding', () => {
  const expected = 'be5be69f55e91af25e54ecc2154d4da359b67b3b27e25f5cc0b3ff54eb74dff3';

  assert.strictEqual(findingFingerprint({}), expected);
  assert.strictEqual(findingFingerprint({
    rule: '', cat: '', file: '', snippet: ' \t\n ',
  }), expected);
  assert.strictEqual(findingFingerprint({
    rule: null, cat: null, file: null, snippet: null,
  }), expected);
  assert.throws(() => findingFingerprint(), TypeError);
  assert.throws(() => findingFingerprint(null), TypeError);
});
