'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DEFAULT_LEDGER, recordRun, loadLedger } = require('../lib/security-scan');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-ledger-'));
}

test('DEFAULT_LEDGER is the relative .atris/state/security_review.jsonl path', () => {
  assert.strictEqual(typeof DEFAULT_LEDGER, 'string');
  assert.strictEqual(DEFAULT_LEDGER, path.join('.atris', 'state', 'security_review.jsonl'));
  assert.ok(!path.isAbsolute(DEFAULT_LEDGER), 'ledger path must stay relative so path.join(root, ...) scopes it to the repo');
  assert.strictEqual(path.basename(DEFAULT_LEDGER), 'security_review.jsonl');
  assert.strictEqual(path.extname(DEFAULT_LEDGER), '.jsonl');
});

test('DEFAULT_LEDGER resolves inside an arbitrary root without escaping it', () => {
  const root = tmpRoot();
  try {
    const resolved = path.resolve(root, DEFAULT_LEDGER);
    assert.ok(resolved.startsWith(path.resolve(root) + path.sep), `resolved path escapes root: ${resolved}`);
    assert.deepStrictEqual(path.relative(root, resolved).split(path.sep), ['.atris', 'state', 'security_review.jsonl']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('recordRun writes to DEFAULT_LEDGER and loadLedger reads it back; empty root yields []', () => {
  const root = tmpRoot();
  try {
    assert.deepStrictEqual(loadLedger(root), [], 'ledger on a fresh root is empty');

    const scan = { findings: [], scanned: 2, counts: { critical: 0, high: 0, medium: 0, low: 0 } };
    const row = recordRun(root, scan);
    assert.ok(row, 'recordRun returned null');

    const file = path.join(root, DEFAULT_LEDGER);
    assert.ok(fs.existsSync(file), `ledger file missing at ${file}`);
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    assert.strictEqual(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.strictEqual(parsed.scanned, 2);
    assert.deepStrictEqual(parsed.open, []);

    const loaded = loadLedger(root);
    assert.strictEqual(loaded.length, 1);
    assert.strictEqual(loaded[0].scanned, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
