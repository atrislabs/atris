'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { addTaste, listTaste } = require('../lib/taste-lessons');

test('a saved lesson missing its added date is excluded from the list', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taste-incomplete-'));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    fs.mkdirSync(path.join(root, 'atris'));
    addTaste({
      verdict: 'keep',
      subject: 'Readable dashboard typography',
      why: 'Clear hierarchy helps scanning.',
      scope: 'design',
      added: '2026-08-03',
      root,
    });
    const savedPath = path.join(root, 'atris', 'taste.json');
    const saved = JSON.parse(fs.readFileSync(savedPath, 'utf8'));
    delete Object.values(saved)[0].added;
    fs.writeFileSync(savedPath, JSON.stringify(saved));

    assert.equal(listTaste({ root }).length, 0);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
