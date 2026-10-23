'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-presence-mut-'));
process.env.HOME = home;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}

test.after(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const { buildWorkforcePresence } = require('../lib/workforce-presence');

const NOW = Date.parse('2026-08-16T00:45:00.000Z');

test('a running receipt with no live process keeps its recorded pid in the stale row', () => {
  const presence = buildWorkforcePresence({
    nowMs: NOW,
    processes: [],
    receipts: [{
      name: 'dispatch-gone.json',
      receipt: {
        status: 'running',
        pid: 555,
        engine: 'codex',
        actor: 'builder',
        started_at: '2026-08-16T00:40:00.000Z',
      },
    }],
  });

  assert.equal(presence.stale.length, 1);
  assert.strictEqual(presence.stale[0].pid, 555);
});

test('a working row built from a receipt reports the live process pid', () => {
  const presence = buildWorkforcePresence({
    nowMs: NOW,
    processes: [{
      pid: 700,
      engine: 'codex',
      command: '/usr/local/bin/codex exec task',
      started_at: '2026-08-16T00:40:00.000Z',
      ancestor_pids: [555],
    }],
    receipts: [{
      name: 'dispatch-child.json',
      receipt: {
        status: 'running',
        pid: 555,
        engine: 'codex',
        actor: 'builder',
        started_at: '2026-08-16T00:40:00.000Z',
      },
    }],
  });

  assert.equal(presence.working.length, 1);
  assert.strictEqual(presence.working[0].pid, 700);
});
