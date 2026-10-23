const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildSite } = require('../lib/site');

test('buildSite uses opts.out when specified instead of dist', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-out-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const doc = path.join(dir, 'test.md');
  fs.writeFileSync(doc, '# Test\n\nTesting output directory.\n');

  const customOut = path.join(dir, 'custom-output');
  const res = buildSite(doc, { out: customOut });

  assert.equal(res.outDir, customOut);
  assert.equal(res.indexPath, path.join(customOut, 'index.html'));
  assert.ok(fs.existsSync(res.indexPath));
});
