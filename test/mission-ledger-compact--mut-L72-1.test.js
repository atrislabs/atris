'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { compactMissionLedger } = require('../lib/mission-ledger-compact');

test('forced compaction leaves a small ledger untouched', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-force-compact-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'missions.jsonl');
  const before = [{ id: 'small-mission', status: 'running' }, { id: 'small-mission', status: 'complete' }].map(JSON.stringify).join('\n') + '\n';
  fs.writeFileSync(file, before);
  assert.equal(compactMissionLedger(file, { force: true }).compacted, false);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});
