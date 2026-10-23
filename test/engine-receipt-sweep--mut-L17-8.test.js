'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sweepEngineAskReceipts } = require('../lib/engine-receipt-sweep');

test('a running receipt without a pid is preserved when liveness is unknown', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-unknown-pid-'));
  try {
    const runs = path.join(root, 'atris', 'runs');
    fs.mkdirSync(runs, { recursive: true });
    const file = path.join(runs, 'engine-ask-pending.json');
    fs.writeFileSync(file, JSON.stringify({
      schema: 'atris.engine_ask_receipt.v1',
      started_at: '2026-08-12T11:40:00.000Z',
      at: '2026-08-12T11:40:00.000Z',
      status: 'running',
      engine: 'codex',
    }));
    sweepEngineAskReceipts(root, { now: () => new Date('2026-08-12T12:00:00.000Z') });
    assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).status, 'running');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
