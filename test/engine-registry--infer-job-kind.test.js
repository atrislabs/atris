'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// inferJobKind itself is pure, but the module it lives in reads env and HOME
// elsewhere, so the load happens against a scratch home with no ATRIS_* leaks.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}
const scratchHome = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-infer-kind-'));
process.env.HOME = scratchHome;

const { inferJobKind } = require('../lib/engine-registry');

test.after(() => {
  fs.rmSync(scratchHome, { recursive: true, force: true });
});

test('inferJobKind names the one kind in a job name', () => {
  assert.equal(inferJobKind('small build'), 'build');
  assert.equal(inferJobKind('deep review'), 'review');
  assert.equal(inferJobKind('code search'), 'search');
  assert.equal(inferJobKind('build'), 'build');
});

test('inferJobKind reads kind words through case and punctuation', () => {
  assert.equal(inferJobKind('  Review Pass!  '), 'review');
  assert.equal(inferJobKind('build_to_build'), 'build');
  assert.equal(inferJobKind('SEARCH THE WIKI'), 'search');
});

test('inferJobKind refuses a name with two kinds or none', () => {
  assert.equal(inferJobKind('build and review'), '');
  assert.equal(inferJobKind('search-build'), '');
  assert.equal(inferJobKind('search build review'), '');
  assert.equal(inferJobKind('ship it'), '');
});

test('inferJobKind needs the whole word, not a substring', () => {
  assert.equal(inferJobKind('rebuild'), '');
  assert.equal(inferJobKind('reviewer'), '');
  assert.equal(inferJobKind('research'), '');
  assert.equal(inferJobKind('builder'), '');
});

test('inferJobKind returns empty for empty and non-string input', () => {
  assert.equal(inferJobKind(''), '');
  assert.equal(inferJobKind('   '), '');
  assert.equal(inferJobKind('!!!'), '');
  assert.equal(inferJobKind(), '');
  assert.equal(inferJobKind(null), '');
  assert.equal(inferJobKind(0), '');
  assert.equal(inferJobKind({}), '');
});
