'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildWorkforcePresence } = require('../lib/workforce-presence');

test('a receipt still identifies its process when the process start time is unavailable', () => {
  const presence = buildWorkforcePresence({
    nowMs: Date.parse('2026-08-16T00:45:00.000Z'),
    processes: [{ pid: 101, engine: 'codex', command: 'codex exec repair' }],
    receipts: [{
      name: 'dispatch-running.json',
      receipt: {
        schema: 'atris.dispatch_receipt.v1',
        status: 'running',
        pid: 101,
        engine: 'codex',
        actor: 'builder',
        tasks: ['CLI-1265'],
        started_at: '2026-08-16T00:37:28.000Z',
      },
    }],
  });

  assert.equal(presence.working[0]?.member, 'builder');
});
