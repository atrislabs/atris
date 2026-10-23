'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scanLoopReceipts } = require('../lib/loop-doctor');

test('the most frequent pause reason wins over an alphabetically earlier reason', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-pause-frequency-'));
  const runs = path.join(root, 'atris', 'runs');
  fs.mkdirSync(runs, { recursive: true });
  for (const [index, reason] of [
    'worker-unavailable', 'worker-unavailable', 'worker-unavailable',
    'engine-busy', 'engine-busy',
  ].entries()) {
    fs.writeFileSync(path.join(runs, `mission-${index}.json`), JSON.stringify({
      ts: '2026-07-10T11:00:00.000Z', pause_reason: reason,
    }));
  }
  const finding = scanLoopReceipts({ root, now: '2026-07-10T12:00:00.000Z' })
    .find((entry) => entry.kind === 'repeated_pause_reason');
  assert.equal(finding.evidence.value, 'worker-unavailable');
});
