'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { collectStreamEvents } = require('../commands/stream');

test('a passing mission tick without a summary gets the success fallback', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-stream-passing-tick-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runs = path.join(root, 'atris', 'runs');
  fs.mkdirSync(runs, { recursive: true });
  const at = '2026-07-06T08:06:00.000Z';
  // Omit summary so the verifier outcome selects the fallback message.
  fs.writeFileSync(path.join(runs, 'mission-check.json'), JSON.stringify({
    schema: 'atris.mission_receipt.v1',
    mission_id: 'mission-check',
    owner: 'codex',
    objective: 'check the stream',
    at,
    result: {
      kind: 'mission_run_tick',
      tick: { status: 'ran', verifier_passed: true, finished_at: at },
    },
  }));

  const events = collectStreamEvents({
    root,
    sinceMs: Date.parse('2026-07-06T08:00:00.000Z'),
    nowMs: Date.parse('2026-07-06T09:00:00.000Z'),
  });
  assert.deepEqual(events.map(({ event, summary }) => ({ event, summary })), [
    { event: 'mission_run_tick', summary: 'ran a mission tick.' },
  ]);
});
