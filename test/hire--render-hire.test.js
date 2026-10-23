'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { renderHire } = require('../commands/hire');

// Fixed clock: every relative time in the output is computed from this, never from the real one.
const NOW = Date.parse('2026-10-23T23:00:00Z');
const CHECK_IN = 'Check in each morning: atris hires';

test('renderHire lays out a new hire with every field', () => {
  const out = renderHire({
    created: true,
    member: { name: 'Maya', job: 'grow the newsletter' },
    inbox: { address: 'maya@example.test' },
    allowance: { monthly_usd: 50, note: 'Resets on the 1st.' },
    schedule: { label: 'nightly at 2 AM', enabled: true },
    next_run_at: '2026-10-24T02:00:00Z',
    outreach: { requested: true, note: 'Uses a normal inbox for now.' },
  }, NOW);

  assert.strictEqual(out, [
    'Hired Maya.',
    'Job: grow the newsletter',
    'Inbox: maya@example.test',
    'Allowance: $50 a month. You still approve every purchase.',
    '  Resets on the 1st.',
    'Works nightly at 2 AM. First run in 3 h.',
    'Outreach: Uses a normal inbox for now.',
    '',
    CHECK_IN,
  ].join('\n'));
});

test('renderHire says so when the hire already existed, and respects a paused schedule', () => {
  const out = renderHire({
    created: false,
    member: { name: 'Leo' },
    allowance: { monthly_usd: 0 },
    schedule: { label: 'hourly', enabled: false },
    next_run_at: '2026-10-24T02:00:00Z',
  }, NOW);

  assert.strictEqual(out, [
    'Leo was already hired. Same hire, nothing duplicated.',
    'Allowance: none. It cannot ask to spend money.',
    'Works hourly. Asleep right now.',
    '',
    CHECK_IN,
  ].join('\n'));
  assert.doesNotMatch(out, /First run/);
  assert.doesNotMatch(out, /Inbox:/);
  assert.doesNotMatch(out, /Outreach:/);
});

test('renderHire clips a long job to 200 characters and formats cents', () => {
  const out = renderHire({
    created: true,
    member: { name: 'Sam', job: 'a'.repeat(250) },
    allowance: { monthly_usd: 12.5 },
  }, NOW);
  const lines = out.split('\n');

  assert.strictEqual(lines[1], `Job: ${'a'.repeat(199)}…`);
  assert.strictEqual(lines[1].length, 'Job: '.length + 200);
  assert.strictEqual(lines[2], 'Allowance: $12.50 a month. You still approve every purchase.');
  assert.strictEqual(lines[3], 'Works on its schedule.');
  assert.strictEqual(lines[lines.length - 1], CHECK_IN);
});

test('renderHire still returns a full check-in when given no data', () => {
  const out = renderHire();

  assert.strictEqual(typeof out, 'string');
  assert.match(out, /Allowance: none\. It cannot ask to spend money\./);
  assert.match(out, /Works on its schedule\./);
  assert.strictEqual(out.split('\n').pop(), CHECK_IN);
});
