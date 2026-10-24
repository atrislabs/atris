'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('approving a shipped wish shows its review reference', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-review-prompt-'));
  const home = process.env.HOME;
  const cwd = process.cwd();
  const exit = process.exit;
  const log = console.log;
  const lines = [];
  try {
    process.env.HOME = root;
    process.chdir(root);
    process.exit = (code) => { throw new Error(`unexpected exit ${code}`); };
    console.log = (line) => lines.push(String(line));
    const { nextCommand } = require('../commands/next');
    const { appendWishRecord } = require('../lib/wish-store');
    appendWishRecord(root, {
      id: 'wish-2099-01-01-publish-guide-a1234567',
      n: 8,
      ts: '2099-01-01T12:00:00.000Z',
      text: 'Publish the guide',
      status: 'shipped',
    });
    nextCommand(['yes'], root, { log: (line) => lines.push(String(line)) });
    assert.match(lines.join('\n'), /wish\s+review\s+#8\b/);
  } finally {
    console.log = log;
    process.exit = exit;
    process.chdir(cwd);
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
  }
});
