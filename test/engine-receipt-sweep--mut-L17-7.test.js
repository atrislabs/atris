'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sweepEngineAskReceipts } = require('../lib/engine-receipt-sweep');

test('a stale running receipt without a process id is preserved', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-missing-pid-'));
  const runs = path.join(root, 'atris', 'runs');
  fs.mkdirSync(runs, { recursive: true });
  const file = path.join(runs, 'engine-ask-missing-pid.json');
  fs.writeFileSync(file, JSON.stringify({
    schema: 'atris.engine_ask_receipt.v1',
    status: 'running',
    engine: 'codex',
    started_at: '2026-08-12T11:00:00.000Z',
    at: '2026-08-12T11:00:00.000Z',
  }));
  sweepEngineAskReceipts(root, {
    now: () => new Date('2026-08-12T12:00:00.000Z'),
    kill: () => { throw Object.assign(new Error('no such process'), { code: 'ESRCH' }); },
  });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).status, 'running');
});
