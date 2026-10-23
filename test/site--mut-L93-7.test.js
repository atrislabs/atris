const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildSite } = require('../lib/site');

test('buildSite preserves a custom closing tagline in the index', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-closing-tagline-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const input = path.join(dir, 'intro.md');
  fs.writeFileSync(input, '# Introduction\n\nWelcome.\n');

  const result = buildSite(input, {
    root: dir,
    out: path.join(dir, 'output'),
    tagline: 'A home for every useful idea.',
  });
  const html = fs.readFileSync(result.indexPath, 'utf8');
  assert.equal(
    html.match(/<p class="tagline">[\s\S]*?<\/p>/)?.[0],
    '<p class="tagline">A home for every useful idea.</p>',
  );
});
