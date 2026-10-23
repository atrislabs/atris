'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { meaningfulWords } = require('../lib/short-name');

test('meaningfulWords keeps content words and drops filler, capped at three', () => {
  assert.deepStrictEqual(
    meaningfulWords('claim the haiku loop via smoke'),
    ['haiku', 'loop', 'smoke'],
  );
  assert.deepStrictEqual(
    meaningfulWords('Please fix the CLI from the docs'),
    ['fix', 'cli', 'docs'],
  );
});

test('meaningfulWords honors a smaller limit and keeps apostrophes and digits', () => {
  assert.deepStrictEqual(
    meaningfulWords('Please fix the CLI from the docs', 2),
    ['fix', 'cli'],
  );
  assert.deepStrictEqual(
    meaningfulWords("Don't drop O'Brien's well-known A1 token", 4),
    ["don't", 'drop', "o'brien's", 'well'],
  );
});

test('meaningfulWords returns an empty list for blank, missing, or filler-only text', () => {
  assert.deepStrictEqual(meaningfulWords(''), []);
  assert.deepStrictEqual(meaningfulWords(null), []);
  assert.deepStrictEqual(meaningfulWords(undefined), []);
  assert.deepStrictEqual(meaningfulWords('   !!!   '), []);
  assert.deepStrictEqual(meaningfulWords('the and of via please claim'), []);
});
