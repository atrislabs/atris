'use strict';

// eventAnswers pulls every typed answer off one wish event. Callers (next-moves,
// wish-delegate) only check the length, so the shape of each answer and the
// order they come back in are what this file pins down.

const { test } = require('node:test');
const assert = require('node:assert');
const { eventAnswers } = require('../lib/wish-store');

test('collects answer, answer_text, grant_answer, then the answers array, in that order', () => {
  const event = {
    id: 'wish-2026-10-23-example-abcd1234',
    answer: 'ship it',
    answer_text: 'yes, after review',
    grant_answer: 'granted for the pilot',
    answers: ['first list item', 'second list item'],
  };
  assert.deepEqual(eventAnswers(event), [
    'ship it',
    'yes, after review',
    'granted for the pilot',
    'first list item',
    'second list item',
  ]);
});

test('drops blank and whitespace-only answers, keeps real text untrimmed, and stringifies non-strings', () => {
  const event = {
    answer: '   ',
    answer_text: '',
    grant_answer: '  keep my spacing  ',
    answers: ['', '\t', 42, 'real'],
  };
  assert.deepEqual(eventAnswers(event), ['  keep my spacing  ', '42', 'real']);
});

test('returns an empty list for a missing, null, or bare event and ignores a non-array answers field', () => {
  assert.deepEqual(eventAnswers(undefined), []);
  assert.deepEqual(eventAnswers(null), []);
  assert.deepEqual(eventAnswers({}), []);
  assert.deepEqual(eventAnswers({ answers: 'not an array' }), []);
});
