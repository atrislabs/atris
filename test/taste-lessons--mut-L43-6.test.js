'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { addTaste, listTaste } = require('../lib/taste-lessons');

test('a saved lesson missing its verdict is excluded even when its reason is valid', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-invalid-verdict-'));
  try {
    fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
    addTaste({
      verdict: 'keep',
      subject: 'Readable dashboard typography',
      why: 'Clear hierarchy helps readers scan.',
      scope: 'design',
      added: '2026-08-03',
      root,
    });
    const file = path.join(root, 'atris', 'taste.json');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete saved[Object.keys(saved)[0]].verdict;
    fs.writeFileSync(file, JSON.stringify(saved));
    assert.equal(listTaste({ root }).length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
