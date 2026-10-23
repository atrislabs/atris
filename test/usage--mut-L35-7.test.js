'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readUsage, usagePath } = require('../lib/usage');

test('usage ignores a record missing its command', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-usage-partial-'));
  try {
    fs.mkdirSync(path.join(dir, '.git'));
    fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
    fs.writeFileSync(usagePath(dir), JSON.stringify({ at: '2026-01-01T12:00:00.000Z' }) + '\n');
    assert.equal(readUsage(dir).length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
