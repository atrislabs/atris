'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { landingWhyClause } = require('../lib/voice-gate');

test('landingWhyClause splits a landing sentence at its own why', () => {
  assert.deepStrictEqual(
    landingWhyClause('Replies now get a plain check, so operators keep deciding instead of waiting.'),
    {
      change: 'Replies now get a plain check.',
      why: 'operators keep deciding instead of waiting.',
    },
  );
  assert.deepStrictEqual(
    landingWhyClause('The reply check is built, so that people can trust the wording.'),
    {
      change: 'The reply check is built.',
      why: 'people can trust the wording.',
    },
  );
  assert.deepStrictEqual(
    landingWhyClause('The checks passed cleanly because the wording stayed plain.'),
    {
      change: 'The checks passed cleanly.',
      why: 'the wording stayed plain.',
    },
  );
  assert.deepStrictEqual(
    landingWhyClause('Landing text stays human, which means a person can follow it.'),
    {
      change: 'Landing text stays human.',
      why: 'a person can follow it.',
    },
  );
});

test('landingWhyClause rewrites a trailing participle and ignores a clause that is too short', () => {
  assert.deepStrictEqual(
    landingWhyClause('Replies stay short for people, keeping the decision easy.'),
    {
      change: 'Replies stay short for people.',
      why: 'it keeps the decision easy.',
    },
  );
  assert.deepStrictEqual(
    landingWhyClause('The saved reply stays short, KEEPING the decision easy.'),
    {
      change: 'The saved reply stays short.',
      why: 'it keeps the decision easy.',
    },
  );
  assert.deepStrictEqual(
    landingWhyClause('Replies now get a plain check,\nso   operators keep deciding instead of waiting.'),
    {
      change: 'Replies now get a plain check.',
      why: 'operators keep deciding instead of waiting.',
    },
  );
  assert.deepStrictEqual(
    landingWhyClause('Something long enough: so the reason is clearly stated.'),
    {
      change: 'Something long enough.',
      why: 'the reason is clearly stated.',
    },
  );
  assert.deepStrictEqual(
    landingWhyClause('abcdefghijkl, avoiding extra waiting.'),
    {
      change: 'abcdefghijkl.',
      why: 'it avoids extra waiting.',
    },
  );
  assert.equal(landingWhyClause('abcdefghijk, avoiding extra waiting.'), null);
  assert.equal(landingWhyClause('Ready now, so operators keep deciding today.'), null);
  assert.equal(landingWhyClause('Replies stay short for people keeping the decision easy.'), null);
  assert.equal(landingWhyClause('Replies stay short, keeping it.'), null);
});

test('landingWhyClause returns nothing when the sentence is empty or has no why', () => {
  assert.equal(landingWhyClause(''), null);
  assert.equal(landingWhyClause('   '), null);
  assert.equal(landingWhyClause(null), null);
  assert.equal(landingWhyClause(undefined), null);
  assert.equal(landingWhyClause('The reply check is built and ready for people.'), null);
});
