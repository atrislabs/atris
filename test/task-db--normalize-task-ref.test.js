'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { normalizeTaskRef } = require('../lib/task-db');

test('normalizeTaskRef normalizes task references and preserves letters and digits', () => {
  assert.strictEqual(normalizeTaskRef('cli-42'), 'CLI42');
  assert.strictEqual(normalizeTaskRef('01abcDEF234'), '01ABCDEF234');
  assert.strictEqual(normalizeTaskRef('CLI42'), 'CLI42');
});

test('normalizeTaskRef removes whitespace, punctuation, and non-ASCII characters', () => {
  assert.strictEqual(normalizeTaskRef(' \t[cli_0042]./\n'), 'CLI0042');
  assert.strictEqual(normalizeTaskRef('éß中🙂a-z９9'), 'AZ9');
  assert.strictEqual(normalizeTaskRef('000-007'), '000007');
});

test('normalizeTaskRef returns an empty string for missing, falsy, or stripped input', () => {
  for (const value of [undefined, null, '', false, 0, NaN, ' \t\n', '-_!🙂']) {
    assert.strictEqual(normalizeTaskRef(value), '');
  }
  assert.strictEqual(normalizeTaskRef(), '');
});

test('normalizeTaskRef coerces truthy non-string values before normalization', () => {
  assert.strictEqual(normalizeTaskRef(12345), '12345');
  assert.strictEqual(normalizeTaskRef(true), 'TRUE');
  assert.strictEqual(normalizeTaskRef({ toString: () => 'cli-42' }), 'CLI42');
});
