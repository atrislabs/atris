'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildSite } = require('../lib/site');

test('index page preserves the document paragraph in its preview', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-preview-'));
  const doc = path.join(dir, 'guide.md');
  fs.writeFileSync(doc, '# Guide\n\nCopper lanterns illuminate the workshop.\n');
  const result = buildSite(doc, { out: path.join(dir, 'public') });
  const index = fs.readFileSync(result.indexPath, 'utf8');
  assert.match(index, /Copper lanterns/);
});
