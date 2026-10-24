require('./helpers/clean-temp');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildSite } = require('../lib/site');

test('a custom index headline appears in the rendered heading', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-headline-'));
  const doc = path.join(dir, 'intro.md');
  fs.writeFileSync(doc, '# Introduction\n\nStart here.\n');
  const result = buildSite(doc, {
    out: path.join(dir, 'output'),
    title: 'Handbook',
    headline: 'Explore the fieldnotes',
  });
  const html = fs.readFileSync(result.indexPath, 'utf8');
  assert.match(html, /<h1\b[^>]*>[^<]*Explore the fieldnotes/);
});
