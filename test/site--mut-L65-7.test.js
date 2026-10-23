const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildSite } = require('../lib/site');

test('buildSite preserves the supplied site title in the index title', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-title-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const input = path.join(dir, 'intro.md');
  fs.writeFileSync(input, '# Introduction\n\nWelcome to the guide.\n');

  const result = buildSite(input, {
    root: dir,
    out: path.join(dir, 'output'),
    title: 'Field Guide',
  });
  const html = fs.readFileSync(result.indexPath, 'utf8');
  assert.equal(html.match(/<title>(.*?)<\/title>/s)?.[1], 'Field Guide');
});
