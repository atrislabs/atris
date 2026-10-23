'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readUsage } = require('../lib/usage');

test('readUsage includes an entry exactly at the sinceDays cutoff', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-usage-cutoff-'));
  try {
    const state = path.join(root, '.atris', 'state');
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(root, '.atris', 'business.json'), '{}');
    const boundary = { at: '2024-01-01T12:00:00.000Z', cmd: 'status' };
    const before = { at: '2024-01-01T11:59:59.999Z', cmd: 'help' };
    const after = { at: '2024-01-01T12:00:00.001Z', cmd: 'task' };
    fs.writeFileSync(path.join(state, 'usage.jsonl'),
      [before, boundary, after].map(entry => JSON.stringify(entry)).join('\n') + '\n');

    assert.deepStrictEqual(readUsage(root, {
      sinceDays: 1,
      now: '2024-01-02T12:00:00.000Z',
    }), [boundary, after]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
