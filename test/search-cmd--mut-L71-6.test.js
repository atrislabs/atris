'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { collectSearchResults } = require('../commands/search');

test('singular planet query does not match a wiki entry about a plane', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-singular-search-'));
  const originalHome = process.env.HOME;
  process.env.HOME = root;
  try {
    const wiki = path.join(root, 'atris', 'wiki');
    fs.mkdirSync(wiki, { recursive: true });
    fs.writeFileSync(path.join(wiki, 'flight.md'), 'A plane carries passengers.\n');
    const result = collectSearchResults(root, 'planet', { memoryOnly: true });
    assert.equal(result.layers.wiki.lineHits.length, 0);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});
