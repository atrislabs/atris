'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { compactMissionLedger } = require('../lib/mission-ledger-compact');

test('forcing compaction removes history from a small ledger', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-force-compact-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'missions.jsonl');
  fs.writeFileSync(file, [
    { id: 'small-mission', n: 1, status: 'running' },
    { id: 'small-mission', n: 1, status: 'complete' },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');

  const result = compactMissionLedger(file, { force: true });

  assert.equal(result.compacted, true);
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 1);
});
