'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { countTodoItems } = require('../commands/brain');

const PLAIN = [
  '## Backlog',
  '- **A:** one',
  '',
  '## In Progress',
  '- **B:** two',
  '- **C:** three',
  '',
  '## Completed',
  '- **D:** four',
  '',
].join('\n');

const EMOJI = PLAIN
  .replace('## In Progress', '## In Progress 🔄')
  .replace('## Completed', '## Completed ✅');

test('countTodoItems counts open (Backlog + In Progress) and done (Completed) on plain headings', () => {
  const r = countTodoItems(PLAIN);
  assert.equal(r.open, 3);
  assert.equal(r.done, 1);
});

test('countTodoItems handles emoji-decorated headings identically to plain (CLI-287 sibling)', () => {
  assert.deepEqual(countTodoItems(EMOJI), countTodoItems(PLAIN));
});

test('countTodoItems does not match a "Backlogged" heading as the Backlog section', () => {
  const text = ['## Backlogged Notes', '- **Z:** note', '## Completed ✅', '- **D:** done'].join('\n');
  // hasRenderedSections is true (Completed ✅), but "Backlogged Notes" is not an open section
  assert.equal(countTodoItems(text).open, 0);
});
