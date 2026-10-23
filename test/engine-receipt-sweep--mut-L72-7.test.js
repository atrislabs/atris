'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { sweepEngineAskReceipts } = require('../lib/engine-receipt-sweep');

const NOW = '2026-08-12T12:00:00.000Z';
const OLD = '2026-08-12T11:40:00.000Z';

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-sweep-mut-'));
}

function receiptPath(root, name) {
  return path.join(root, 'atris', 'runs', `${name}.json`);
}

function writeRawReceipt(root, name, value) {
  fs.mkdirSync(path.join(root, 'atris', 'runs'), { recursive: true });
  fs.writeFileSync(receiptPath(root, name), `${JSON.stringify(value, null, 2)}\n`);
  return receiptPath(root, name);
}

function deadPidError() {
  return Object.assign(new Error('no such process'), { code: 'ESRCH' });
}

test('sweep skips a running receipt whose schema does not match', () => {
  const root = tempRoot();
  try {
    const file = writeRawReceipt(root, 'engine-ask-other', {
      schema: 'atris.engine_ask_receipt.v0',
      started_at: OLD,
      at: OLD,
      status: 'running',
      pid: 424242,
      engine: 'codex',
    });
    const before = fs.readFileSync(file, 'utf8');
    const summary = sweepEngineAskReceipts(root, {
      now: () => new Date(NOW),
      kill: () => { throw deadPidError(); },
    });
    assert.equal(summary.scanned, 0);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sweep skips a receipt file that parses to null', () => {
  const root = tempRoot();
  try {
    const runsDir = path.join(root, 'atris', 'runs');
    fs.mkdirSync(runsDir, { recursive: true });
    fs.writeFileSync(path.join(runsDir, 'engine-ask-null.json'), 'null\n');
    const summary = sweepEngineAskReceipts(root, {
      now: () => new Date(NOW),
      kill: () => { throw deadPidError(); },
    });
    assert.equal(summary.scanned, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
