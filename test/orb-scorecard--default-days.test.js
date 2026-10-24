'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  DEFAULT_DAYS,
  DAY_MS,
  readOrbScorecard,
  parseOrbScorecardDays,
} = require('../lib/orb-scorecard');

function makeTempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orb-scorecard-test-'));
  process.env.HOME = root;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) delete process.env[key];
  }
  return root;
}

// Fixed instant far inside a 7-day window in every timezone: local day for the
// cutoff lands on 2026-10-08 or 2026-10-09, today on 2026-10-15 or 2026-10-16.
const FIXED_NOW = Date.parse('2026-10-15T12:00:00Z');

test('DEFAULT_DAYS is a positive integer constant of 7', () => {
  assert.strictEqual(DEFAULT_DAYS, 7);
  assert.ok(Number.isInteger(DEFAULT_DAYS));
  assert.ok(DEFAULT_DAYS > 0);
  assert.strictEqual(DEFAULT_DAYS * DAY_MS, 7 * 24 * 60 * 60 * 1000);
});

test('readOrbScorecard uses DEFAULT_DAYS as the window when days is omitted', () => {
  const root = makeTempRoot();
  fs.writeFileSync(
    path.join(root, 'now.md'),
    [
      'orb: inside the default window · 2026-10-14',
      'orb: outside the default window · 2026-10-01',
      '',
    ].join('\n'),
  );

  const scorecard = readOrbScorecard(root, { now: FIXED_NOW });

  assert.strictEqual(scorecard.days, DEFAULT_DAYS);
  assert.strictEqual(scorecard.picks, 1);
  assert.strictEqual(scorecard.dispatches, 0);
  assert.strictEqual(scorecard.completion_rate, null);
});

test('parseOrbScorecardDays falls back to DEFAULT_DAYS on empty args', () => {
  const parsed = parseOrbScorecardDays([]);
  assert.deepStrictEqual(parsed, { ok: true, days: DEFAULT_DAYS });
});

test('readOrbScorecard rejects a non-positive days override', () => {
  const root = makeTempRoot();
  assert.throws(
    () => readOrbScorecard(root, { days: 0, now: FIXED_NOW }),
    /orb scorecard days must be a positive integer/,
  );
  assert.throws(
    () => readOrbScorecard(root, { days: 'abc', now: FIXED_NOW }),
    /orb scorecard days must be a positive integer/,
  );
});
