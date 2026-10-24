'use strict';
require('./helpers/clean-temp');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('a primitive receipt is reported as invalid ledger data', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-invalid-receipt-'));
  const previousEnv = { ...process.env };
  const cwd = process.cwd();
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    process.env.HOME = root;
    process.env.CODEX_STATE_DB = path.join(root, 'absent.sqlite');
    process.chdir(root);
    fs.mkdirSync(path.join(root, 'atris'));
    fs.writeFileSync(path.join(root, 'atris', 'atris.md'), '# temporary workspace\n');
    const state = path.join(root, '.atris', 'state');
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'career_xp_receipts.jsonl'), '42\n');
    const { collectLocalXpProjection } = require('../commands/xp');
    const result = collectLocalXpProjection(['--workspace', root]);
    assert.equal(result.integrity.errors.includes('invalid_receipt'), true);
  } finally {
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previousEnv);
  }
});
