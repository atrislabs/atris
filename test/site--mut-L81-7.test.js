const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildSite } = require('../lib/site');

test('buildSite uses the markdown heading as the page title', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-heading-title-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const input = path.join(dir, 'different-filename.md');
  fs.writeFileSync(input, '# A specific document title\n\nDocument content.\n');

  const result = buildSite(input, { root: dir, out: path.join(dir, 'output') });

  assert.deepEqual(result.pages.map((page) => page.title), ['A specific document title']);
});
