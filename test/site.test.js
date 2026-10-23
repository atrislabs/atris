const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildSite, collectMd, slugFor, firstHeading, firstParagraph } = require('../lib/site');
const { scanFile } = require('../commands/slop');

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function mkDocs(t) {
  const dir = tempDir(t, 'site-');
  fs.writeFileSync(path.join(dir, 'intro.md'), '# Getting started\n\nHow to begin with the system.\n\n## Steps\n\n- **One** install it\n- **Two** run it\n');
  fs.mkdirSync(path.join(dir, 'guides'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'guides', 'deep.md'), '# Deep dive\n\nThe details, explained calmly.\n');
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'junk.md'), '# should be skipped\n');
  return dir;
}

test('collectMd finds markdown recursively and skips noise dirs', (t) => {
  const dir = mkDocs(t);
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

test('buildSite writes an index + a page per doc, all slop-clean', (t) => {
  const dir = mkDocs(t);
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

test('a single markdown file builds a one-page site', (t) => {
  const dir = tempDir(t, 'site1-');
  const doc = path.join(dir, 'only.md');
  fs.writeFileSync(doc, '# Only page\n\nJust one.\n');
  const res = buildSite(doc, { out: path.join(dir, 'dist') });
  assert.equal(res.pages.length, 1);
  assert.ok(fs.existsSync(res.indexPath));
});

test('serveSite refuses files in a sibling folder that shares the root prefix', async () => {
  const http = require('node:http');
  const { serveSite } = require('../lib/site');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-serve-'));
  fs.mkdirSync(path.join(base, 'site'));
  fs.mkdirSync(path.join(base, 'site-evil'));
  fs.writeFileSync(path.join(base, 'site', 'index.html'), 'PUBLIC');
  fs.writeFileSync(path.join(base, 'site-evil', 'secret.txt'), 'SECRET');
  const { server } = await serveSite(path.join(base, 'site'), 0);
  const { port } = server.address();
  const get = (p) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
  try {
    assert.equal((await get('/')).body, 'PUBLIC');
    for (const p of ['/../site-evil/secret.txt', '/..%2fsite-evil%2fsecret.txt']) {
      const r = await get(p);
      assert.notEqual(r.body, 'SECRET', p);
      assert.equal(r.status, 403, p);
    }
    assert.equal((await get('/%E0%A4%A')).status, 400);
    assert.equal(server.address().address, '127.0.0.1');
  } finally {
    server.close();
  }
});

test('serveSite refuses a symlink inside the site folder that points outside it', async () => {
  const http = require('node:http');
  const { serveSite } = require('../lib/site');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-serve-link-'));
  fs.mkdirSync(path.join(base, 'site'));
  fs.writeFileSync(path.join(base, 'outside.txt'), 'SECRET');
  fs.writeFileSync(path.join(base, 'site', 'ok.txt'), 'FINE');
  fs.symlinkSync(path.join(base, 'outside.txt'), path.join(base, 'site', 'leak.txt'));
  fs.symlinkSync(path.join(base, 'site', 'ok.txt'), path.join(base, 'site', 'alias.txt'));
  const { server } = await serveSite(path.join(base, 'site'), 0);
  const { port } = server.address();
  const get = (p) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
  try {
    const leak = await get('/leak.txt');
    assert.notEqual(leak.body, 'SECRET');
    assert.equal(leak.status, 403);
    assert.equal((await get('/alias.txt')).body, 'FINE', 'a link that stays inside the site still works');
  } finally {
    server.close();
  }
});

test('serveSite answers a null byte in the URL with 400 and keeps serving', async () => {
  const http = require('node:http');
  const { serveSite } = require('../lib/site');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-serve-nul-'));
  fs.mkdirSync(path.join(base, 'site'));
  fs.writeFileSync(path.join(base, 'site', 'index.html'), 'PUBLIC');
  const { server } = await serveSite(path.join(base, 'site'), 0);
  const { port } = server.address();
  const get = (p) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
  try {
    assert.equal((await get('/%00')).status, 400);
    assert.equal((await get('/index.html%00.txt')).status, 400);
    assert.equal((await get('/')).body, 'PUBLIC', 'the server is still up');
  } finally {
    server.close();
  }
});

test('collectMd skips symlinked files and folders, so a site only holds files from its own folder', (t) => {
  const { collectMd } = require('../lib/site');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-collect-link-'));
  fs.mkdirSync(path.join(base, 'docs'));
  fs.mkdirSync(path.join(base, 'elsewhere'));
  fs.writeFileSync(path.join(base, 'docs', 'real.md'), '# Real');
  fs.writeFileSync(path.join(base, 'elsewhere', 'other.md'), '# Other');
  fs.symlinkSync(path.join(base, 'elsewhere', 'other.md'), path.join(base, 'docs', 'linked.md'));
  fs.symlinkSync(path.join(base, 'elsewhere'), path.join(base, 'docs', 'linked-dir'));
  const names = collectMd(path.join(base, 'docs')).map((f) => path.basename(f));
  assert.deepEqual(names, ['real.md']);
});
