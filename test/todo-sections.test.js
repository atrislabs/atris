'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { hasRenderedSections, isOpenSection, isDoneSection, sectionMatches } = require('../lib/todo-sections');

test('hasRenderedSections detects plain and emoji-decorated headings', () => {
  assert.equal(hasRenderedSections('## Backlog\n- x\n'), true);
  assert.equal(hasRenderedSections('## In Progress 🔄\n- x\n'), true);
  assert.equal(hasRenderedSections('## Completed ✅\n- x\n'), true);
  assert.equal(hasRenderedSections('## Inbox\n- x\n'), false, 'Inbox alone is not a rendered task section');
  assert.equal(hasRenderedSections(''), false);
});

test('hasRenderedSections does not match a name-prefixed heading like "Backlogged"', () => {
  assert.equal(hasRenderedSections('## Backlogged Notes\n- x\n'), false);
});

test('isOpenSection matches Backlog / In Progress incl. emoji decoration', () => {
  assert.equal(isOpenSection('Backlog'), true);
  assert.equal(isOpenSection('In Progress'), true);
  assert.equal(isOpenSection('In Progress 🔄'), true);
  assert.equal(isOpenSection('Completed'), false);
  assert.equal(isOpenSection('Backlogged Notes'), false);
});

test('isDoneSection matches Completed incl. emoji decoration', () => {
  assert.equal(isDoneSection('Completed'), true);
  assert.equal(isDoneSection('Completed ✅'), true);
  assert.equal(isDoneSection('Backlog'), false);
});

test('sectionMatches requires an exact name or a "name " prefix (space-guarded)', () => {
  assert.equal(sectionMatches('In Progress 🔄', 'In Progress'), true);
  assert.equal(sectionMatches('In Progress', 'In Progress'), true);
  assert.equal(sectionMatches('In Progressive', 'In Progress'), false);
  assert.equal(sectionMatches(null, 'Backlog'), false);
});
