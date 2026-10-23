'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { balanceCommand } = require('../commands/balance');

test('balanceCommand prints request failed when result has no error property', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'balance-mut-'));
  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const errLines = [];
  const logLines = [];
  const code = await balanceCommand([], {
    loadCredentials: () => ({ token: 'mock-token' }),
    apiRequestJson: async () => ({ ok: false }),
    err: (msg) => errLines.push(String(msg)),
    log: (msg) => logLines.push(String(msg)),
  });

  assert.strictEqual(code, 1);
  assert.deepStrictEqual(errLines, ['request failed']);
  assert.deepStrictEqual(logLines, []);
});

test('balanceCommand with --json reports request failed when result has no error property', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'balance-mut-'));
  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const errLines = [];
  const logLines = [];
  const code = await balanceCommand(['--json'], {
    loadCredentials: () => ({ token: 'mock-token' }),
    apiRequestJson: async () => ({ ok: false }),
    err: (msg) => errLines.push(String(msg)),
    log: (msg) => logLines.push(String(msg)),
  });

  assert.strictEqual(code, 1);
  assert.deepStrictEqual(errLines, []);
  assert.strictEqual(logLines.length, 1);
  assert.deepStrictEqual(JSON.parse(logLines[0]), { ok: false, error: 'request failed' });
});
