'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readOrbScorecard } = require('../lib/orb-scorecard');

test('a one-day window includes a pick on its first calendar day', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orb-first-day-'));
  fs.writeFileSync(path.join(root, 'now.md'), 'orb: review the proof · 2026-01-01\n');

  const card = readOrbScorecard(root, {
    days: 1,
    now: new Date(2026, 0, 2, 12).getTime(),
  });

  assert.strictEqual(card.picks, 1);
});
