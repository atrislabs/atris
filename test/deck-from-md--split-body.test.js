const test = require('node:test');
const assert = require('node:assert/strict');
const { splitBody } = require('../lib/deck-from-md');

test('splitBody groups consecutive prose lines into paragraphs and collects bullets', () => {
  const { bullets, paras } = splitBody([
    'First line',
    'second line',
    '',
    '- one',
    '- two',
    'tail para',
  ]);
  assert.deepEqual(bullets, ['one', 'two']);
  assert.deepEqual(paras, ['First line second line', 'tail para']);
});

test('splitBody treats blockquotes as their own paragraph and trims padding', () => {
  const { bullets, paras } = splitBody([
    '  > quoted line  ',
    '  *  star bullet   ',
    '\t+ plus bullet',
  ]);
  assert.deepEqual(bullets, ['star bullet', 'plus bullet']);
  assert.deepEqual(paras, ['quoted line']);
});

test('splitBody on empty and whitespace-only input returns empty lists', () => {
  assert.deepEqual(splitBody([]), { bullets: [], paras: [] });
  assert.deepEqual(splitBody(['', '   ', '\t']), { bullets: [], paras: [] });
});
