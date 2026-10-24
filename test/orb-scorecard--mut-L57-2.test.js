'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readOrbScorecard } = require('../lib/orb-scorecard');

test('zero-duration completed jobs contribute to the median duration', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orb-zero-duration-'));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    const index = path.join(root, '.atris', 'state', 'orb-runs', 'index.jsonl');
    fs.mkdirSync(path.dirname(index), { recursive: true });
    const rows = [0, 1000].map((durationMs, i) => ({
      ts: '2026-07-18T10:00:00.000Z',
      label: `completed job ${i}`,
      kind: 'review',
      engine: 'codex',
      exitCode: 0,
      durationMs,
      logPath: `job-${i}.log`,
    }));
    fs.writeFileSync(index, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
    const scorecard = readOrbScorecard(root, {
      days: 7,
      now: Date.parse('2026-07-18T12:00:00.000Z'),
    });
    assert.strictEqual(scorecard.median_duration_ms, 500);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
