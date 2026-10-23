'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { upsertAgentsOpeningLines } = require('../lib/opening-lines');

test('previewing new operating rules leaves project instructions untouched', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-preview-rules-'));
  try {
    const adapter = path.join(root, 'AGENTS.md');
    const original = '# Project instructions\n\nUse node:test for tests.\n';
    fs.writeFileSync(adapter, original);

    upsertAgentsOpeningLines(adapter, '- **Accuracy.** Check your work.', { dryRun: true });

    assert.strictEqual(fs.readFileSync(adapter, 'utf8').includes('Accuracy'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
