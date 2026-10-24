'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pruneRuns } = require('../lib/runs-prune');

test('archived room receipt preserves its recorded timestamp', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-timestamp-'));
  const receiptPath = path.join(root, 'atris/runs/room/receipt.json');
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  const at = '2026-09-01T12:00:00.000Z';
  fs.writeFileSync(receiptPath, JSON.stringify({
    schema: 'atris.mission_room_receipt.v1',
    at,
    product_wedge: 'Chaos -> Mission Room',
    room: { objective: 'verify saved proof', execution_mode: 'preview' },
    thinking_memory: null,
    receipt_path: 'atris/runs/room/receipt.json',
  }));
  const modified = new Date('2026-09-01T12:00:00.000Z');
  fs.utimesSync(receiptPath, modified, modified);

  const result = pruneRuns(root, {
    nowMs: Date.parse('2026-10-23T12:00:00.000Z'),
    apply: true,
    keepDays: 14,
    keepNewest: 0,
  });
  const manifest = JSON.parse(fs.readFileSync(path.join(root, result.manifest_path), 'utf8'));
  assert.strictEqual(manifest.entries[0].compact.at, at);
});
