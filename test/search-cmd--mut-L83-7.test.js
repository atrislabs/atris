'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { collectSearchResults } = require('../commands/search');

test('multi-word query lists its terms longest first', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-terms-order-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
  fs.writeFileSync(path.join(root, 'atris', 'MAP.md'), '# map\n');

  const { terms } = collectSearchResults(root, 'cat dogs');
  assert.equal(terms[0], 'cat dogs');
  assert.equal(terms.indexOf('dogs') < terms.indexOf('cat'), true);
});
