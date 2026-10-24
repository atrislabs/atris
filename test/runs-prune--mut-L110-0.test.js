'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pruneRuns } = require('../lib/runs-prune');

test('archiving preserves a receipt with a directly recorded passing result', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-direct-result-'));
  const directory = path.join(root, 'atris', 'runs', 'completed');
  fs.mkdirSync(directory, { recursive: true });
  const receipt = path.join(directory, 'receipt.json');
  fs.writeFileSync(receipt, JSON.stringify({
    schema: 'receipt.v1',
    mission: { id: 'example', objective: 'check cleanup', owner: 'tester' },
    created_at: '2026-09-23T00:00:00.000Z',
    result: { passed: true, kind: 'check' },
  }));
  const timestamp = Date.UTC(2026, 8, 23) / 1000;
  fs.utimesSync(receipt, timestamp, timestamp);

  const result = pruneRuns(root, {
    nowMs: Date.UTC(2026, 9, 23), apply: true, keepDays: 14, keepNewest: 0,
  });
  const manifest = JSON.parse(fs.readFileSync(path.join(root, result.manifest_path), 'utf8'));
  assert.strictEqual(manifest.entries[0].compact.passed, true);
});
