'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-receipt-engine-'));
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

const { receiptEngine } = require('../lib/workforce-presence');

test('extracts and normalizes engine from normal receipt fields', () => {
  // Direct engine field
  assert.strictEqual(receiptEngine({ engine: 'codex' }), 'codex');
  assert.strictEqual(receiptEngine({ engine: '  Devin  ' }), 'devin');

  // Fallback to engines array
  assert.strictEqual(receiptEngine({ engines: ['grok'] }), 'grok');

  // Fallback to first engine in results array
  assert.strictEqual(
    receiptEngine({
      results: [
        { task: 'task-1' },
        { task: 'task-2', engine: 'agy' },
      ],
    }),
    'agy'
  );

  // Precedence order: engine > engines[0] > results[].engine
  assert.strictEqual(
    receiptEngine({
      engine: 'codex',
      engines: ['grok'],
      results: [{ engine: 'agy' }],
    }),
    'codex'
  );
  assert.strictEqual(
    receiptEngine({
      engines: ['grok'],
      results: [{ engine: 'agy' }],
    }),
    'grok'
  );
});

test('handles aliases and punctuation edge cases', () => {
  // Alias mappings
  assert.strictEqual(receiptEngine({ engine: 'cursor-agent' }), 'cursor');
  assert.strictEqual(receiptEngine({ engine: 'cursor agent' }), 'cursor');
  assert.strictEqual(receiptEngine({ engine: 'claude-code' }), 'claude');

  // Special character replacement and trimming
  assert.strictEqual(receiptEngine({ engine: 'custom/runner:v1' }), 'custom-runner-v1');
  assert.strictEqual(receiptEngine({ engine: '---gemini---' }), 'gemini');
  assert.strictEqual(receiptEngine({ engine: 'claude_opus-4.5' }), 'claude_opus-4.5');
});

test('returns empty string for missing, empty, or invalid input', () => {
  assert.strictEqual(receiptEngine(), '');
  assert.strictEqual(receiptEngine(null), '');
  assert.strictEqual(receiptEngine(undefined), '');
  assert.strictEqual(receiptEngine({}), '');
  assert.strictEqual(receiptEngine('not an object'), '');
  assert.strictEqual(receiptEngine(123), '');
  assert.strictEqual(receiptEngine({ engine: '' }), '');
  assert.strictEqual(receiptEngine({ engine: '   ' }), '');
  assert.strictEqual(receiptEngine({ engines: [] }), '');
  assert.strictEqual(receiptEngine({ engines: [''] }), '');
  assert.strictEqual(receiptEngine({ results: [] }), '');
  assert.strictEqual(receiptEngine({ results: [{ task: 'test' }] }), '');
});
