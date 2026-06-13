'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseContributionCard, escapeRegExp } = require('../commands/brain');

test('escapeRegExp neutralizes regex metacharacters', () => {
  assert.equal(escapeRegExp('c++'), 'c\\+\\+');
  assert.equal(escapeRegExp('a.b'), 'a\\.b');
  assert.equal(escapeRegExp('('), '\\(');
});

test('parseContributionCard parses a normal member section', () => {
  const card = parseContributionCard('## navigator\ncurrent_score_signal: 0.5\n', { name: 'navigator' });
  assert.ok(card, 'card should parse');
  assert.equal(card.score, '0.5');
});

test('parseContributionCard does not throw on a regex-metacharacter member name', () => {
  // name "c++ bot" → firstName "c++" → old code built /^##\s+c++\b/ → "Nothing to repeat" crash
  let card;
  assert.doesNotThrow(() => { card = parseContributionCard('## c++ bot\ncurrent_score_signal: 0.9\n', { name: 'c++ bot' }); });
  // graceful: returns null (no match) instead of crashing
  assert.equal(card, null);
});

test('parseContributionCard treats a metacharacter name as literal (matches), not a wildcard', () => {
  const match = parseContributionCard('## a.b\ncurrent_score_signal: 0.7\n', { name: 'a.b' });
  assert.ok(match, 'literal "a.b" heading should match');
  assert.equal(match.score, '0.7');

  // the unescaped "." would have wildcard-matched "axb"; escaped, it must not
  const noMatch = parseContributionCard('## axb\ncurrent_score_signal: 0.7\n', { name: 'a.b' });
  assert.equal(noMatch, null, 'escaped "." must not wildcard-match "axb"');
});
