'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { RENDERED_SECTION_RE } = require('../lib/todo-sections');

test('matches each canonical rendered section and captures its name', () => {
  for (const name of ['Backlog', 'In Progress', 'Blocked', 'Completed']) {
    const match = RENDERED_SECTION_RE.exec(`## ${name}`);
    assert.ok(match, `expected a match for ${name}`);
    assert.strictEqual(match[0], `## ${name}`);
    assert.strictEqual(match[1], name);
  }
});

test('finds decorated headings within multiline documents', () => {
  const text = '# Tasks\n\n## In Progress 🔄\n- implement the feature\n';
  const match = RENDERED_SECTION_RE.exec(text);
  assert.ok(match);
  assert.strictEqual(match[0], '## In Progress');
  assert.strictEqual(match[1], 'In Progress');
  assert.strictEqual(match.index, text.indexOf('##'));
  assert.strictEqual(RENDERED_SECTION_RE.test('##\tCompleted ✅'), true);
});

test('rejects empty input, noncanonical names, and headings at other levels', () => {
  for (const text of [
    '',
    'ordinary task text',
    '## Backlogged Notes',
    '## In Progression',
    '## BlockedTasks',
    '## Completed_items',
    '## backlog',
    '# Backlog',
    '### Backlog',
    '##Backlog',
    'prefix ## Backlog',
    '  ## Backlog',
  ]) {
    assert.strictEqual(RENDERED_SECTION_RE.exec(text), null, JSON.stringify(text));
  }
});
