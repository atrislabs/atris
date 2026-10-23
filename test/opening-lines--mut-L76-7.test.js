'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { upsertAgentsOpeningLines } = require('../lib/opening-lines');

test('appending operating rules preserves existing project instructions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-preserve-instructions-'));
  try {
    const adapter = path.join(root, 'AGENTS.md');
    fs.writeFileSync(adapter, '# Project instructions\n\nUse node:test for tests.\n');

    upsertAgentsOpeningLines(adapter, '- **Accuracy.** Check your work.');

    assert.match(fs.readFileSync(adapter, 'utf8'), /^Use node:test for tests\.$/m);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
