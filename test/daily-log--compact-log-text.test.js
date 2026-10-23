'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-compact-log-text-'));
process.env.HOME = tmpDir;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) {
    delete process.env[key];
  }
}

test.after(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (_) {}
});

const { compactLogText } = require('../lib/daily-log');

test('compactLogText collapses whitespace and preserves strings within length limits', () => {
  const normalText = 'alpha beta gamma';
  assert.strictEqual(compactLogText(normalText), 'alpha beta gamma');

  const messyWhitespace = "  line one \n\n  line  two\t\tline  three  \r\n";
  assert.strictEqual(compactLogText(messyWhitespace), 'line one line two line three');

  const exactlyTen = '1234567890';
  assert.strictEqual(compactLogText(exactlyTen, 10), '1234567890');
});

test('compactLogText truncates exceeding strings and trims before ellipsis', () => {
  const input = 'hello world from atris daily log';
  const truncated = compactLogText(input, 15);
  assert.strictEqual(truncated, 'hello world...');
  assert.strictEqual(truncated.length <= 15, true);

  const defaultTruncated = compactLogText('a'.repeat(250));
  assert.strictEqual(defaultTruncated, `${'a'.repeat(237)}...`);
  assert.strictEqual(defaultTruncated.length, 240);

  const tinyMax = compactLogText('abcdef', 3);
  assert.strictEqual(tinyMax, '...');

  const zeroMax = compactLogText('abcdef', 0);
  assert.strictEqual(zeroMax, '...');
});

test('compactLogText handles empty, falsy, and non-string inputs cleanly', () => {
  assert.strictEqual(compactLogText(''), '');
  assert.strictEqual(compactLogText('   \t\n  '), '');
  assert.strictEqual(compactLogText(null), '');
  assert.strictEqual(compactLogText(undefined), '');
  assert.strictEqual(compactLogText(12345), '12345');
  assert.strictEqual(compactLogText(true), 'true');
});
