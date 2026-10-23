'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ingestOrbScorecard } = require('../lib/pulse');

test('distinct failed jobs each produce a scorecard instead of suppressing the second job', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-distinct-failures-'));
  try {
    const directory = path.join(root, '.atris', 'state', 'orb-runs');
    fs.mkdirSync(directory, { recursive: true });
    const records = ['repair routing', 'repair output'].map((label, index) => ({
      ts: '2024-01-15T10:00:00.000Z',
      label,
      kind: 'task',
      engine: 'codex',
      exitCode: 1,
      durationMs: 250,
      logPath: `.atris/state/orb-runs/failed-${index}.log`,
      error: 'verification failed',
    }));
    fs.writeFileSync(path.join(directory, 'index.jsonl'),
      records.map((record) => JSON.stringify(record)).join('\n') + '\n');

    const result = ingestOrbScorecard(root, {
      days: 7,
      now: Date.parse('2024-01-15T12:00:00.000Z'),
    });
    assert.strictEqual(result.scorecards_written, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
