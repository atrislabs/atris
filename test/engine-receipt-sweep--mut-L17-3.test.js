'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sweepEngineAskReceipts } = require('../lib/engine-receipt-sweep');

test('a zero pid cannot establish that a running receipt is dead', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-zero-pid-'));
  const runs = path.join(root, 'atris', 'runs');
  fs.mkdirSync(runs, { recursive: true });
  const file = path.join(runs, 'engine-ask-zero.json');
  fs.writeFileSync(file, JSON.stringify({
    schema: 'atris.engine_ask_receipt.v1',
    status: 'running',
    pid: 0,
    started_at: '2020-01-01T00:00:00.000Z',
  }));

  sweepEngineAskReceipts(root, {
    now: () => new Date('2020-01-02T00:00:00.000Z'),
    kill: () => {
      throw Object.assign(new Error('no such process group'), { code: 'ESRCH' });
    },
  });

  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).status, 'running');
});
