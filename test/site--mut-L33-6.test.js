const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { collectMd } = require('../lib/site');

test('collectMd excludes ordinary text files in nested documentation folders', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collect-markdown-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const nested = path.join(dir, 'guides');
  fs.mkdirSync(nested);
  const notes = path.join(nested, 'notes.txt');
  fs.writeFileSync(notes, 'Internal notes that are not a markdown page.');
  fs.writeFileSync(path.join(nested, 'intro.md'), '# Introduction\n');

  assert.equal(collectMd(dir).includes(notes), false);
});
