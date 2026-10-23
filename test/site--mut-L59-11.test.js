const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildSite } = require('../lib/site');

test('long page summaries keep the ellipsis inside the preview limit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-preview-'));
  const doc = path.join(dir, 'guide.md');
  fs.writeFileSync(doc, '# Guide\n\n' + 'Readable documentation explains the workflow. '.repeat(20));
  const result = buildSite(doc, { out: path.join(dir, 'public') });
  const html = fs.readFileSync(result.indexPath, 'utf8');
  const preview = html.match(/Readable documentation[^<]+/);
  assert.equal(preview && preview[0].length, 120);
});
