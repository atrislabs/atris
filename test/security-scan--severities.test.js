'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  SEVERITIES,
  SEVERITY_RANK,
  RULES,
  summarizeFindings,
  shouldFail,
} = require('../lib/security-scan');

test('SEVERITIES lists the four levels from most to least severe', () => {
  assert.ok(Array.isArray(SEVERITIES));
  assert.deepStrictEqual(SEVERITIES, ['critical', 'high', 'medium', 'low']);
  assert.strictEqual(new Set(SEVERITIES).size, SEVERITIES.length);
});

test('SEVERITIES order matches SEVERITY_RANK, highest rank first', () => {
  assert.deepStrictEqual(Object.keys(SEVERITY_RANK).sort(), [...SEVERITIES].sort());
  const ranks = SEVERITIES.map((sev) => SEVERITY_RANK[sev]);
  assert.deepStrictEqual(ranks, [3, 2, 1, 0]);
  for (let i = 1; i < ranks.length; i++) {
    assert.ok(ranks[i - 1] > ranks[i], `${SEVERITIES[i - 1]} should outrank ${SEVERITIES[i]}`);
  }
});

test('every rule uses a severity from SEVERITIES, so rule listings drop nothing', () => {
  assert.ok(RULES.length > 0);
  for (const rule of RULES) {
    assert.ok(SEVERITIES.includes(rule.sev), `rule ${rule.id} has unknown severity ${rule.sev}`);
  }
  // printRules walks SEVERITIES and filters RULES, so the walk must cover them all
  const walked = SEVERITIES.reduce((n, sev) => n + RULES.filter((r) => r.sev === sev).length, 0);
  assert.strictEqual(walked, RULES.length);
});

test('summarizeFindings returns one zeroed count per SEVERITIES entry when empty', () => {
  const counts = summarizeFindings([]);
  assert.deepStrictEqual(Object.keys(counts).sort(), [...SEVERITIES].sort());
  for (const sev of SEVERITIES) assert.strictEqual(counts[sev], 0);
});

test('summarizeFindings counts findings per severity and keeps unknown levels separate', () => {
  const counts = summarizeFindings([
    { sev: 'critical' }, { sev: 'high' }, { sev: 'high' }, { sev: 'low' }, { sev: 'bogus' },
  ]);
  assert.strictEqual(counts.critical, 1);
  assert.strictEqual(counts.high, 2);
  assert.strictEqual(counts.medium, 0);
  assert.strictEqual(counts.low, 1);
  assert.strictEqual(counts.bogus, 1);
});

test('shouldFail treats each SEVERITIES entry as a threshold, and unknown names fall back to high', () => {
  for (const sev of SEVERITIES) {
    assert.strictEqual(shouldFail([{ sev }], sev), true, `${sev} finding fails at ${sev}`);
  }
  assert.strictEqual(shouldFail([{ sev: 'medium' }], 'high'), false);
  assert.strictEqual(shouldFail([{ sev: 'high' }], 'critical'), false);
  assert.strictEqual(shouldFail([{ sev: 'low' }], 'low'), true);
  assert.strictEqual(shouldFail([], 'low'), false);
  assert.strictEqual(shouldFail([{ sev: 'high' }], 'not-a-level'), true);
  assert.strictEqual(shouldFail([{ sev: 'medium' }], 'not-a-level'), false);
});
