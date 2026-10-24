'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildWeekReportData } = require('../commands/report');

test('zero days falls back to a week and includes recent earned xp', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-zero-days-'));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    const state = path.join(root, '.atris', 'state');
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'career_xp_receipts.jsonl'), `${JSON.stringify({
      receipt_id: 'recent-earned-xp',
      outcome: 'accepted',
      xp: 8,
      accepted_at: '2026-07-03T12:00:00Z',
    })}\n`);

    const data = buildWeekReportData(root, {
      days: 0,
      now: Date.parse('2026-07-05T12:00:00Z'),
    });

    assert.equal(data.days, 7, 'zero days should use the default weekly window');
    assert.equal(data.xp.total, 8, 'the weekly window should retain xp earned two days ago');
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
