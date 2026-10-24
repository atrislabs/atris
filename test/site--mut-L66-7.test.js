require('./helpers/clean-temp');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildSite } = require('../lib/site');

test('a custom brand accent appears in the generated site mark', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-brand-accent-'));
  const doc = path.join(dir, 'guide.md');
  fs.writeFileSync(doc, '# Guide\n\nGetting started.\n');
  const result = buildSite(doc, { out: path.join(dir, 'out'), accent: '!' });
  const html = fs.readFileSync(result.indexPath, 'utf8');
  const mark = html.match(/class="mark"[^>]*>[\s\S]*?<b>([^<]*)<\/b>/);
  assert.strictEqual(mark && mark[1], '!');
});
