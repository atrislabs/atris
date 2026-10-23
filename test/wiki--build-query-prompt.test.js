'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { buildQueryPrompt } = require('../lib/wiki');

test('public mode names the question and points at the public wiki root', () => {
  const prompt = buildQueryPrompt('Who owns billing?');
  assert.strictEqual(
    prompt,
    [
      'Atris wiki query: Who owns billing?',
      '',
      'Read atris/wiki/index.md first, then the most relevant pages.',
      'Answer from the wiki with direct references to page paths under atris/wiki/.',
      'If the answer reveals a reusable insight, offer to save it as a brief page.',
    ].join('\n'),
  );
  assert.ok(!prompt.includes('.atris/presidio'));
});

test('explicit public mode matches the default', () => {
  assert.strictEqual(buildQueryPrompt('same?', 'public'), buildQueryPrompt('same?'));
});

test('private mode swaps every wiki path to the private root', () => {
  const prompt = buildQueryPrompt('What did we promise the lender?', 'private');
  assert.ok(prompt.startsWith('Atris wiki query: What did we promise the lender?\n'));
  assert.ok(prompt.includes('Read .atris/presidio/index.md first'));
  assert.ok(prompt.includes('page paths under .atris/presidio/.'));
  assert.ok(!prompt.includes('atris/wiki'));
});

test('an unknown mode falls back to the public root', () => {
  assert.strictEqual(buildQueryPrompt('q', 'bogus'), buildQueryPrompt('q', 'public'));
  assert.strictEqual(buildQueryPrompt('q', null), buildQueryPrompt('q', 'public'));
});

test('an empty question still produces a full prompt with a bare header', () => {
  const lines = buildQueryPrompt('').split('\n');
  assert.strictEqual(lines[0], 'Atris wiki query: ');
  assert.strictEqual(lines[1], '');
  assert.strictEqual(lines.length, 5);
});

test('question text passes through untouched, including newlines and template syntax', () => {
  const question = 'line one\nline two with `ticks` and ${not_expanded} and $1';
  const prompt = buildQueryPrompt(question);
  assert.ok(prompt.startsWith(`Atris wiki query: ${question}\n\nRead atris/wiki/index.md first`));
});

test('a missing question is stringified rather than throwing', () => {
  assert.strictEqual(buildQueryPrompt().split('\n')[0], 'Atris wiki query: undefined');
});

test('the same input gives the same output on repeated calls', () => {
  assert.strictEqual(buildQueryPrompt('stable?', 'private'), buildQueryPrompt('stable?', 'private'));
});
