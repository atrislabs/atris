'use strict';

// The em dash repair picks the punctuation the shape of the line asks for.
// A comma after a bold label made "**Verify claims**, If something sounds",
// which is worse prose than the dash it replaced.

const test = require('node:test');
const assert = require('node:assert/strict');
const { RULES } = require('../commands/slop');

const fix = RULES.find(rule => rule.id === 'em-dash').fix;

test('a line-opening bold label, code span, or bracket takes a colon', () => {
  assert.equal(fix('1. **Verify claims** — If something sounds important, check it.'),
    '1. **Verify claims**: If something sounds important, check it.');
  assert.equal(fix('- **Hard stop** — wait for a person'), '- **Hard stop**: wait for a person');
  assert.equal(fix('- `atris task` — durable task state'), '- `atris task`: durable task state');
  assert.equal(fix('- [Claim] — [Source URL or file:line]'), '- [Claim]: [Source URL or file:line]');
});

test('a heading takes a colon at its first dash', () => {
  assert.equal(fix('# Researcher — Deep Researcher'), '# Researcher: Deep Researcher');
  assert.equal(fix('## Step one — read — then act'), '## Step one: read, then act');
});

test('every other dash keeps the comma repair', () => {
  assert.equal(fix("You don't summarize — you find sources."), "You don't summarize, you find sources.");
  assert.equal(fix('The body must be **valid JSON** — invalid JSON fails.'), 'The body must be **valid JSON**, invalid JSON fails.');
  assert.equal(fix('- **Label** — first — second'), '- **Label**: first, second');
});

test('a short list-item opener of five words or fewer takes a colon', () => {
  assert.equal(fix('- Accuracy over speed — wrong fast is worse than right slow'),
    '- Accuracy over speed: wrong fast is worse than right slow');
  assert.equal(fix('- Honesty — if the ship is partial, say so.'), '- Honesty: if the ship is partial, say so.');
  assert.equal(fix('1. inventory — send a navigator to sweep'), '1. inventory: send a navigator to sweep');
  assert.equal(fix('- Cleaning up after a build is not optional overhead — it is part of the build.'),
    '- Cleaning up after a build is not optional overhead, it is part of the build.');
  assert.equal(fix('Accuracy over speed — wrong fast is worse.'), 'Accuracy over speed, wrong fast is worse.');
});

test('a pair of dashes around an aside becomes parentheses', () => {
  assert.equal(fix('Doubt and resistance — a failing verifier, a contradicted lesson — are not obstacles.'),
    'Doubt and resistance (a failing verifier, a contradicted lesson) are not obstacles.');
  assert.equal(fix('- **Label** — first — second'), '- **Label**: first, second');
  assert.equal(fix('one — two — three — four'), 'one, two, three, four');
  assert.equal(fix('a pause at the end — then —'), 'a pause at the end, then,');
  assert.equal(fix('4. route —'), '4. route:');
  assert.equal(fix('Change from `v0 — planned` to `v1 — shipped` now.'), 'Change from `v0, planned` to `v1, shipped` now.');
});
