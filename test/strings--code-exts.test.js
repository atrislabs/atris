const test = require('node:test');
const assert = require('node:assert/strict');
const { CODE_EXTS, TEXT_EXTS } = require('../commands/strings');

test('CODE_EXTS holds the code file extensions the scanner walks', () => {
  assert.ok(CODE_EXTS instanceof Set);
  assert.equal(CODE_EXTS.size, 9);
  for (const ext of ['.js', '.ts', '.jsx', '.tsx', '.mjs', '.vue', '.svelte', '.astro', '.html']) {
    assert.ok(CODE_EXTS.has(ext), `expected ${ext}`);
  }
});

test('CODE_EXTS excludes prose extensions that only TEXT_EXTS scans', () => {
  for (const ext of ['.md', '.mdx', '.txt']) {
    assert.ok(!CODE_EXTS.has(ext), `${ext} should not be a code ext`);
    assert.ok(TEXT_EXTS.has(ext), `${ext} should be a text ext`);
  }
  assert.ok(CODE_EXTS.isSubsetOf ? CODE_EXTS.isSubsetOf(TEXT_EXTS) : [...CODE_EXTS].every((e) => TEXT_EXTS.has(e)));
});

test('CODE_EXTS rejects empty, dotless, and differently-cased lookups', () => {
  assert.ok(!CODE_EXTS.has(''));
  assert.ok(!CODE_EXTS.has('js'), 'missing leading dot');
  assert.ok(!CODE_EXTS.has('.JS'), 'match is case-sensitive');
  assert.ok(!CODE_EXTS.has('.cjs'), 'cjs is not in the declared list');
  assert.ok(!CODE_EXTS.has(null));
  assert.ok(!CODE_EXTS.has(undefined));
});
