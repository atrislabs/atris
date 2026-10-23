'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scanLoopReceipts } = require('../lib/loop-doctor');

test('repeated tick errors expose trimmed text without JSON string quotes', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-doctor-mut-L150-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runs = path.join(root, 'atris', 'runs');
  fs.mkdirSync(runs, { recursive: true });
  const now = '2026-01-15T12:00:00.000Z';
  for (const name of ['mission-a.json', 'mission-b.json']) {
    fs.writeFileSync(path.join(runs, name), JSON.stringify({
      ts: now,
      ticks: [{ status: 'failed', error: '  worker exited 7  ' }],
    }));
  }

  const findings = scanLoopReceipts({ root, now });
  assert.deepEqual(
    findings.filter((finding) => finding.kind === 'repeated_tick_error'),
    [{
      kind: 'repeated_tick_error',
      evidence: {
        value: 'worker exited 7',
        receipts: ['mission-a.json', 'mission-b.json'],
        detail: 'the same tick error appeared in 2 recent mission receipts',
      },
      count: 2,
      first_seen: now,
      last_seen: now,
      suggested_mission: {
        objective: "repair the improve loop's repeated tick error: worker exited 7",
        verifier: 'atris improve doctor --check repeated_tick_error',
        owner: 'auto-improver',
        cadence: '15m',
      },
      reward_pressure: 0,
      effective_priority: 400,
    }],
  );
});
