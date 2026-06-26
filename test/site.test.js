const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildSite, collectMd, slugFor, firstHeading, firstParagraph } = require('../lib/site');
const { scanFile } = require('../commands/slop');

function mkDocs() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-'));
  fs.writeFileSync(path.join(dir, 'intro.md'), '# Getting started\n\nHow to begin with the system.\n\n## Steps\n\n- **One** install it\n- **Two** run it\n');
  fs.mkdirSync(path.join(dir, 'guides'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'guides', 'deep.md'), '# Deep dive\n\nThe details, explained calmly.\n');
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'junk.md'), '# should be skipped\n');
  return dir;
}

test('collectMd finds markdown recursively and skips noise dirs', () => {
  const dir = mkDocs();
  const files = collectMd(dir).map((f) => path.basename(f));
  assert.ok(files.includes('intro.md'));
  assert.ok(files.includes('deep.md'));
  assert.ok(!files.includes('junk.md'), 'node_modules skipped');
});

test('slugFor makes flat, safe slugs from nested paths', () => {
  const dir = '/tmp/docs';
  assert.equal(slugFor('/tmp/docs/guides/deep.md', dir), 'guides-deep');
  assert.equal(slugFor('/tmp/docs/Intro Page.md', dir), 'intro-page');
});

test('firstHeading and firstParagraph extract page meta', () => {
  const md = '---\ntheme: atris\n---\n# **Hello** world\n\nThe first real line.\n';
  assert.equal(firstHeading(md), 'Hello world');
  assert.equal(firstParagraph(md), 'The first real line.');
});

test('buildSite writes an index + a page per doc, all slop-clean', () => {
  const dir = mkDocs();
  const out = path.join(dir, 'dist');
  const res = buildSite(dir, { out, title: 'Docs' });
  assert.equal(res.pages.length, 2);
  assert.ok(fs.existsSync(res.indexPath));
  // index links to each page
  const index = fs.readFileSync(res.indexPath, 'utf8');
  for (const p of res.pages) assert.ok(index.includes(`href="${p.href}"`), `index links ${p.href}`);
  // nav present on a page, and the index has a toc block
  assert.ok(fs.readFileSync(res.pages[0].out, 'utf8').includes('class="sitenav"'));
  assert.ok(index.includes('data-atris-block="toc"'));
  // every emitted file passes the slop gate
  for (const f of [res.indexPath, ...res.pages.map((p) => p.out)]) {
    assert.equal(scanFile(f).length, 0, `${path.basename(f)} should be slop-clean`);
  }
});

test('a single markdown file builds a one-page site', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'site1-'));
  const doc = path.join(dir, 'only.md');
  fs.writeFileSync(doc, '# Only page\n\nJust one.\n');
  const res = buildSite(doc, { out: path.join(dir, 'dist') });
  assert.equal(res.pages.length, 1);
  assert.ok(fs.existsSync(res.indexPath));
});
