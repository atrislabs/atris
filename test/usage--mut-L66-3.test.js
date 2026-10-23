'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readUsage, usagePath } = require('../lib/usage');

test('zero lookback keeps historical command usage', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-zero-lookback-'));
  try {
    fs.mkdirSync(path.join(dir, '.git'));
    fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
    fs.writeFileSync(usagePath(dir), JSON.stringify({
      at: '2026-01-01T12:00:00.000Z', cmd: 'status',
    }) + '\n');

    const entries = readUsage(dir, { sinceDays: 0, now: '2026-06-01T12:00:00.000Z' });
    assert.equal(entries.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
