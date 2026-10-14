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
