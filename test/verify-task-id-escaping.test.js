'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { findTaskInContent, escapeRegExp } = require('../commands/verify');

const SAMPLE = [
  '# TODO',
  '',
  '### T1: do the first thing',
  'some work',
  '',
  '### T2: do the second thing',
  'more work',
  '',
].join('\n');

test('escapeRegExp neutralizes regex metacharacters', () => {
  assert.equal(escapeRegExp('a.b'), 'a\\.b');
  assert.equal(escapeRegExp('('), '\\(');
  assert.equal(escapeRegExp('a+b*c'), 'a\\+b\\*c');
});

test('findTaskInContent still matches a normal task id', () => {
  const m = findTaskInContent(SAMPLE, '1');
  assert.ok(m, 'T1 should be found');
  assert.match(m.title, /T1/);
});

test('findTaskInContent does not throw on a regex-metacharacter id (was an uncaught SyntaxError)', () => {
  // "(" used to reach `new RegExp("### (T(|Task ()...")` → thrown SyntaxError → CLI crash.
  let result;
  assert.doesNotThrow(() => { result = findTaskInContent(SAMPLE, '('); });
  assert.equal(result, null, 'an unmatched metacharacter id resolves to "not found", not a crash');
});

test('findTaskInContent treats "." as a literal, not any-char (no silent wrong match)', () => {
  // A literal-dot id must not match "T1" via "." wildcarding.
  const m = findTaskInContent(SAMPLE, '.');
  assert.equal(m, null, 'a bare "." must not wildcard-match an existing task');
});

test('findTaskInContent falls back to a case-insensitive title substring match', () => {
  const m = findTaskInContent(SAMPLE, 'second');
  assert.ok(m, 'substring of a task title should match');
  assert.match(m.title, /second thing/);
});
