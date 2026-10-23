'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { digestLine } = require('../lib/autoland');

// digestLine only formats its argument: no files, environment, or dates are used.
test('prefers the result and keeps only its first sentence', () => {
  assert.strictEqual(digestLine({
    result: 'Completed: Reports load faster so users save time. More detail follows.',
    happened: 'Search is simpler because filters are clearer.',
    title: 'Exports are safer because checks catch errors.',
  }), 'reports load faster so users save time');
});

test('uses a clear landing sentence when the result contains jargon', () => {
  assert.strictEqual(digestLine({
    result: 'Updated cache_state for all users.',
    happened: 'COMPLETED: Reports load faster so users save time. Extra detail.',
    title: 'Exports are safer because checks catch errors.',
  }), 'reports load faster so users save time');
});

test('falls back from a short result and clarifies the mission title', () => {
  assert.strictEqual(digestLine({
    result: 'Done.',
    happened: 'Reports load faster so users save time.',
  }), 'reports load faster so users save time');
  assert.strictEqual(digestLine({
    result: 'Done.',
    happened: 'Updated cache_state successfully.',
    title: 'Mission XP: Safer cache_state checks prevent errors.',
  }), 'safer cache state checks prevent errors');
});

test('returns an empty line for missing or unexplained content', () => {
  assert.strictEqual(digestLine({}), '');
  assert.strictEqual(digestLine({ result: '', happened: '', title: '' }), '');
  assert.strictEqual(digestLine({ title: 'Update reports' }), '');
});

test('closes a long result at a clause within the length budget', () => {
  assert.strictEqual(digestLine({
    result: `Reports load faster so users save time when reviewing the full history of their purchases, ${'with detailed records '.repeat(10)}`,
  }), 'reports load faster so users save time when reviewing the full history of their purchases');
});
