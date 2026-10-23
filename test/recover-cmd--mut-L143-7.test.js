'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { recoverCommand } = require('../commands/recover');

test('recovery JSON preserves the paused mission next action', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-recover-next-action-'));
  const originalLog = console.log;
  try {
    const state = path.join(root, '.atris', 'state');
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'missions.jsonl'), `${JSON.stringify({
      id: 'paused-with-next-action',
      objective: 'finish the saved work',
      status: 'paused',
      stop_reason: 'max-ticks-reached',
      next_action: 'review the saved result before resuming',
      created_at: '2025-01-01T00:00:00.000Z',
      updated_at: '2025-01-01T00:00:00.000Z',
    })}\n`);

    const output = [];
    console.log = (...values) => output.push(values.join(' '));
    const code = recoverCommand(['--json'], { root });
    console.log = originalLog;

    assert.equal(code, 0);
    const report = JSON.parse(output.join('\n'));
    assert.equal(report.results.length, 1);
    assert.equal(report.results[0].mission_id, 'paused-with-next-action');
    assert.equal(report.results[0].next_action, 'review the saved result before resuming');
  } finally {
    console.log = originalLog;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
