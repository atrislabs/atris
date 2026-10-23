'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { noteTitle } = require('../lib/daily-log');

test('maps each escalation keyword to its journal title', () => {
  assert.equal(noteTitle('decision: keep the master log curated'), 'Task decision');
  assert.equal(noteTitle('decided: ship it friday'), 'Task decision');
  assert.equal(noteTitle('handoff: cursor owns the wiki pass'), 'Task handoff');
  assert.equal(noteTitle('shipped: v3.1.2'), 'Task shipped');
  assert.equal(noteTitle('launched: snowpine site'), 'Task shipped');
  assert.equal(noteTitle('landed: reply gate merge'), 'Task shipped');
  assert.equal(noteTitle('blocked: waiting on credentials'), 'Task blocked');
  assert.equal(noteTitle('milestone: 100 receipts'), 'Task milestone');
});

test('keyword match is case-insensitive and allows a dash or colon', () => {
  assert.equal(noteTitle('DECISION: uppercase'), 'Task decision');
  assert.equal(noteTitle('Blocked - dash separator'), 'Task blocked');
  assert.equal(noteTitle('  handoff : padded spaces'), 'Task handoff');
});

test('notes without a leading keyword fall back to Task update', () => {
  assert.equal(noteTitle('a plain work note'), 'Task update');
  assert.equal(noteTitle('the decision: keyword not at start'), 'Task update');
  assert.equal(noteTitle('ship: only full listed words count'), 'Task update');
});

test('keyword alone without a separator falls back to Task update', () => {
  assert.equal(noteTitle('decision'), 'Task update');
  assert.equal(noteTitle('blocked on prod'), 'Task update');
});

test('empty and non-string input falls back to Task update', () => {
  assert.equal(noteTitle(''), 'Task update');
  assert.equal(noteTitle('   '), 'Task update');
  assert.equal(noteTitle(null), 'Task update');
  assert.equal(noteTitle(undefined), 'Task update');
  assert.equal(noteTitle(42), 'Task update');
});
