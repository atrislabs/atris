'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REQUIRED = ['objective', 'change', 'verify'];

function parseReceipt(text) {
  const sections = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^##\s+([a-z0-9-]+)\s*$/i);
    if (match) {
      current = { name: match[1].toLowerCase(), lines: [] };
      sections.push(current);
      continue;
    }
    if (current) current.lines.push(line);
  }
  return sections;
}

module.exports = {
  id: 'receipt-format',
  title: 'Fix a bug and produce a structured receipt',
  category: 'contract',
  async check(ctx) {
    const receiptPath = path.join(ctx.workspace, 'receipt.md');
    assert.equal(fs.existsSync(receiptPath), true, 'receipt.md missing');
    const sections = parseReceipt(fs.readFileSync(receiptPath, 'utf8'));
    assert.deepEqual(sections.map((section) => section.name), REQUIRED, 'receipt sections out of order');
    for (const section of sections) {
      assert.equal(section.lines.some((line) => line.trim().length > 0), true, `${section.name} is empty`);
    }
    const result = ctx.run('npm', ['test']);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  },
};
