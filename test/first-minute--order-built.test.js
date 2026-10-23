const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// lib/first-minute.js reads HOME and ATRIS_* at call time only. Point HOME at a
// throwaway folder and clear ATRIS_* so the check never touches this machine.
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'first-minute-order-built-'));
process.env.HOME = SANDBOX;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}

const { orderBuilt } = require('../lib/first-minute');

test.after(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

test('keeps the order when no file is an index page', () => {
  const files = ['js/app.js', 'css/site.css', 'notes.txt'];
  const before = [...files];
  const out = orderBuilt(files);

  assert.deepStrictEqual(out, ['js/app.js', 'css/site.css', 'notes.txt']);
  assert.notStrictEqual(out, files, 'returns a new array');
  assert.deepStrictEqual(files, before, 'does not change the input');
});

test('moves the root index page to the front and keeps the rest in order', () => {
  const files = ['js/app.js', 'index.html', 'css/site.css'];

  assert.deepStrictEqual(orderBuilt(files), [
    'index.html',
    'js/app.js',
    'css/site.css',
  ]);
});

test('picks the shallowest index page when several exist', () => {
  const files = ['blog/index.html', 'docs/index.html', 'index.html'];

  assert.deepStrictEqual(orderBuilt(files), [
    'index.html',
    'blog/index.html',
    'docs/index.html',
  ]);
});

test('breaks a depth tie by name', () => {
  const files = ['b/index.html', 'a/index.html'];

  assert.deepStrictEqual(orderBuilt(files), ['a/index.html', 'b/index.html']);
});

test('matches index.htm in any letter case', () => {
  const files = ['notes.txt', 'site/INDEX.htm'];

  assert.deepStrictEqual(orderBuilt(files), ['site/INDEX.htm', 'notes.txt']);
});

test('does not treat a file that only ends in "index" as an index page', () => {
  const files = ['about.html', 'myindex.html', 'sub/myindex.html'];

  assert.deepStrictEqual(orderBuilt(files), [
    'about.html',
    'myindex.html',
    'sub/myindex.html',
  ]);
});

test('empty and non-list input gives an empty list', () => {
  assert.deepStrictEqual(orderBuilt([]), []);
  assert.deepStrictEqual(orderBuilt(), []);
  assert.deepStrictEqual(orderBuilt(null), []);
  assert.deepStrictEqual(orderBuilt('index.html'), []);
});

test('a single file comes back alone', () => {
  assert.deepStrictEqual(orderBuilt(['only.html']), ['only.html']);
});
