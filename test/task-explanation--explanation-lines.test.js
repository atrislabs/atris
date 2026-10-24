'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { explanationLines, taskExplanation } = require('../lib/task-explanation');

// explanationLines is pure: it reads only its arguments, so no temp dir, HOME,
// or ATRIS_* env is needed. Every input below is a fixed string.

const authored = {
  what_changes: 'Users can reset a password by email.',
  why_it_matters: 'Lockout tickets are the top support complaint.',
  done_looks_like: 'A reset email arrives within a minute in staging.',
};

test('explanationLines returns the three labeled lines in order', () => {
  assert.deepStrictEqual(explanationLines(authored), [
    'What changes: Users can reset a password by email.',
    'Why it matters: Lockout tickets are the top support complaint.',
    'Done looks like: A reset email arrives within a minute in staging.',
  ]);
});

test('explanationLines prefixes every line with the indent option', () => {
  assert.deepStrictEqual(explanationLines(authored, { indent: '  ' }), [
    '  What changes: Users can reset a password by email.',
    '  Why it matters: Lockout tickets are the top support complaint.',
    '  Done looks like: A reset email arrives within a minute in staging.',
  ]);
});

test('explanationLines drops what_changes when it only echoes the title', () => {
  const derived = { ...authored, what_changes: 'Ship the login page.' };

  // The title is compared after a sentence ending is added, so both forms match.
  assert.deepStrictEqual(explanationLines(derived, { title: 'Ship the login page' }), [
    'Why it matters: Lockout tickets are the top support complaint.',
    'Done looks like: A reset email arrives within a minute in staging.',
  ]);
  assert.deepStrictEqual(explanationLines(derived, { title: 'Ship the login page.' }), [
    'Why it matters: Lockout tickets are the top support complaint.',
    'Done looks like: A reset email arrives within a minute in staging.',
  ]);
});

test('explanationLines keeps what_changes when it says more than the title', () => {
  assert.deepStrictEqual(explanationLines(authored, { title: 'Password reset' }), [
    'What changes: Users can reset a password by email.',
    'Why it matters: Lockout tickets are the top support complaint.',
    'Done looks like: A reset email arrives within a minute in staging.',
  ]);
});

test('explanationLines keeps every line when no title is given, even an exact echo', () => {
  const derived = { ...authored, what_changes: 'Ship the login page.' };

  assert.strictEqual(explanationLines(derived).length, 3);
  assert.strictEqual(explanationLines(derived)[0], 'What changes: Ship the login page.');
});

test('explanationLines on an empty task shows the honest fallback lines', () => {
  // taskExplanation({}) has no title, goal, parent, proof, or verify to draw on.
  // The lines say so instead of inventing a reason.
  const explanation = taskExplanation({});

  assert.deepStrictEqual(explanationLines(explanation), [
    'What changes: Not written down yet.',
    'Why it matters: The task does not say why this matters yet.',
    'Done looks like: The owner shows proof the work is real and it clears review.',
  ]);
});

test('explanationLines does not mutate the explanation it reads', () => {
  const derived = { ...authored, what_changes: 'Ship the login page.' };
  const before = JSON.stringify(derived);

  explanationLines(derived, { title: 'Ship the login page', indent: '  ' });

  assert.strictEqual(JSON.stringify(derived), before);
});
