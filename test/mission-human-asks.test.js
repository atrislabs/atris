'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeHumanAsks, openHumanAsks } = require('../lib/mission-human-asks');

test('normalizeHumanAsks turns strings and objects into one shape', () => {
  assert.deepEqual(normalizeHumanAsks([
    'Approve the spend?',
    { text: 'Which logo?', answered_at: '2026-10-01', id: 'a2' },
    { text: 42 },
    null,
  ]), [
    { text: 'Approve the spend?', answered_at: null },
    { text: 'Which logo?', answered_at: '2026-10-01', id: 'a2' },
    { text: '42', answered_at: null },
    { text: '', answered_at: null },
  ]);
});

test('normalizeHumanAsks returns [] for anything that is not an array', () => {
  assert.deepEqual(normalizeHumanAsks(undefined), []);
  assert.deepEqual(normalizeHumanAsks('ask'), []);
  assert.deepEqual(normalizeHumanAsks({ text: 'x' }), []);
});

test('openHumanAsks keeps only unanswered asks with real text', () => {
  const open = openHumanAsks([
    'Pick a name',
    '   ',
    { text: 'Done already', answered_at: '2026-10-02' },
    { text: 'Still waiting', answered_at: '' },
  ]);
  assert.deepEqual(open.map((ask) => ask.text), ['Pick a name', 'Still waiting']);
});
