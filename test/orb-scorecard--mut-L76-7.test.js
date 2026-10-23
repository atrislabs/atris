'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readOrbScorecard } = require('../lib/orb-scorecard');

test('a dispatch with a zero process id is orphaned even when its process group exists', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orb-invalid-pid-'));
  const previousHome = process.env.HOME;
  const originalKill = process.kill;
  process.env.HOME = root;
  try {
    const index = path.join(root, '.atris', 'state', 'orb-runs', 'index.jsonl');
    fs.mkdirSync(path.dirname(index), { recursive: true });
    fs.writeFileSync(index, JSON.stringify({
      status: 'dispatched',
      ts: '2026-07-18T10:00:00.000Z',
      label: 'unfinished job',
      kind: 'review',
      engine: 'codex',
      logPath: 'unfinished.log',
      pid: 0,
    }) + '\n');
    // Signal zero can succeed for a process group, but that is no job PID.
    // Keep the probe deterministic without querying any actual processes.
    process.kill = () => true;
    const scorecard = readOrbScorecard(root, {
      days: 7,
      now: Date.parse('2026-07-18T12:00:00.000Z'),
    });
    assert.strictEqual(scorecard.orphaned, 1);
  } finally {
    process.kill = originalKill;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
