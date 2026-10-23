'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { taskTagTokens } = require('../lib/task-decision');

test('taskTagTokens returns an empty list for missing or non-object tasks', () => {
  assert.deepStrictEqual(taskTagTokens(), []);
  assert.deepStrictEqual(taskTagTokens(null), []);
  assert.deepStrictEqual(taskTagTokens(undefined), []);
  assert.deepStrictEqual(taskTagTokens('needs-human'), []);
  assert.deepStrictEqual(taskTagTokens(42), []);
  assert.deepStrictEqual(taskTagTokens(false), []);
  assert.deepStrictEqual(taskTagTokens({}), []);
});

test('taskTagTokens collects tag, tags, metadata.tags, then title hashtags in that order', () => {
  const task = {
    tag: 'primary',
    tags: ['alpha', 'beta'],
    metadata: { tags: ['gamma'] },
    title: 'Ship it #delta and #epsilon',
  };
  assert.deepStrictEqual(taskTagTokens(task), [
    'primary',
    'alpha',
    'beta',
    'gamma',
    'delta',
    'epsilon',
  ]);
});

test('taskTagTokens normalizes case, whitespace, and underscores', () => {
  const task = {
    tag: '  Needs_Human  ',
    tags: ['DECISION', 'Some_Thing_Else'],
  };
  assert.deepStrictEqual(taskTagTokens(task), [
    'needs-human',
    'decision',
    'some-thing-else',
  ]);
});

test('taskTagTokens drops empty, whitespace-only, null, and undefined entries', () => {
  const task = {
    tag: '   ',
    tags: ['', '  ', null, undefined, 'keep'],
    metadata: { tags: [null, '', 'also-keep'] },
  };
  assert.deepStrictEqual(taskTagTokens(task), ['keep', 'also-keep']);
});

test('taskTagTokens ignores tags and metadata.tags that are not arrays', () => {
  assert.deepStrictEqual(
    taskTagTokens({ tags: 'needs-human', metadata: { tags: 'decision' } }),
    [],
  );
  assert.deepStrictEqual(taskTagTokens({ metadata: null }), []);
  assert.deepStrictEqual(taskTagTokens({ metadata: {} }), []);
  assert.deepStrictEqual(taskTagTokens({ metadata: { tags: { 0: 'decision' } } }), []);
});

test('taskTagTokens still reads the other sources when some are malformed', () => {
  const task = {
    tag: 'solo',
    tags: 'not-an-array',
    metadata: { tags: ['meta'] },
    title: 'plain title',
  };
  assert.deepStrictEqual(taskTagTokens(task), ['solo', 'meta']);
});

test('taskTagTokens pulls hashtags out of the title and lowercases them', () => {
  assert.deepStrictEqual(taskTagTokens({ title: 'Fix #Needs-Human thing' }), ['needs-human']);
  assert.deepStrictEqual(taskTagTokens({ title: '#one#two #Three-3' }), ['one', 'two', 'three-3']);
  assert.deepStrictEqual(taskTagTokens({ title: 'no tags here' }), []);
  assert.deepStrictEqual(taskTagTokens({ title: 'lonely # hash and C#' }), []);
});

test('taskTagTokens title hashtags stop at underscores, so only the leading part is kept', () => {
  assert.deepStrictEqual(taskTagTokens({ title: 'Wait #needs_human' }), ['needs']);
});

test('taskTagTokens tolerates non-string titles and numeric tags', () => {
  assert.deepStrictEqual(taskTagTokens({ title: 12345 }), []);
  assert.deepStrictEqual(taskTagTokens({ title: null }), []);
  assert.deepStrictEqual(taskTagTokens({ tags: [7, 'x'] }), ['7', 'x']);
});

test('taskTagTokens keeps duplicates across sources instead of de-duplicating', () => {
  const task = {
    tag: 'decision',
    tags: ['decision'],
    metadata: { tags: ['Decision'] },
    title: 'pick #decision',
  };
  assert.deepStrictEqual(taskTagTokens(task), ['decision', 'decision', 'decision', 'decision']);
});

test('taskTagTokens returns a fresh array and does not mutate the task', () => {
  const task = { tag: 'a', tags: ['B'], metadata: { tags: ['C'] }, title: 'x #d' };
  const snapshot = JSON.stringify(task);
  const first = taskTagTokens(task);
  first.push('mutated');
  assert.strictEqual(JSON.stringify(task), snapshot);
  assert.deepStrictEqual(taskTagTokens(task), ['a', 'b', 'c', 'd']);
});
