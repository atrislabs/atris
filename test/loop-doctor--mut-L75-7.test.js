'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scanLoopReceipts } = require('../lib/loop-doctor');

test('repeated failures retain the earliest recorded occurrence', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-first-seen-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runs = path.join(root, 'atris', 'runs');
  fs.mkdirSync(runs, { recursive: true });
  const earliest = '2026-07-10T10:00:00.000Z';
  for (const [name, ts] of [
    ['mission-a.json', '2026-07-10T11:00:00.000Z'],
    ['mission-b.json', earliest],
  ]) {
    fs.writeFileSync(path.join(runs, name), JSON.stringify({
      ts,
      ticks: [{ status: 'errored', error: 'worker exited 7' }],
    }));
  }

  const finding = scanLoopReceipts({ root, now: '2026-07-10T12:00:00.000Z' })
    .find((entry) => entry.kind === 'repeated_tick_error');
  assert.equal(finding.first_seen, earliest);
});
