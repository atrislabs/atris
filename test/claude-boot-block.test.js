'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { upsertAtrisClaudeBootBlock } = require('../lib/claude-boot-block');

const START = '<!-- ATRIS:START - Auto-generated, do not edit -->';
const END = '<!-- ATRIS:END -->';

test('empty source gets just the block', () => {
  const { content, action } = upsertAtrisClaudeBootBlock('');
  assert.equal(action, 'created');
  assert.ok(content.startsWith(START));
  assert.ok(content.trimEnd().endsWith(END));
  assert.match(content, /execute `atris atris\.md`/);
});

test('existing CLAUDE.md without a block gets the block prepended', () => {
  const { content, action } = upsertAtrisClaudeBootBlock('\n\n# My project\nrules\n');
  assert.equal(action, 'prepended');
  assert.ok(content.startsWith(START));
  assert.ok(content.endsWith(`${END}\n\n# My project\nrules\n`));
});

test('running twice is a no-op', () => {
  const first = upsertAtrisClaudeBootBlock('# Project\n').content;
  const second = upsertAtrisClaudeBootBlock(first);
  assert.equal(second.action, 'unchanged');
  assert.equal(second.content, first);
});

test('a stale block is replaced and moved to the top, keeping user text', () => {
  const source = `# Intro\n${START}\nold boot text\n${END}\n\n# Rules\n`;
  const { content, action } = upsertAtrisClaudeBootBlock(source);
  assert.equal(action, 'updated');
  assert.ok(content.startsWith(START));
  assert.doesNotMatch(content, /old boot text/);
  assert.ok(content.endsWith(`${END}\n\n# Intro\n# Rules\n`));
  assert.equal(content.split(START).length, 2);
});

test('a block missing its end marker is repaired, keeping only the text before it', () => {
  const source = `# Keep me\n${START}\nhalf written`;
  const { content, action } = upsertAtrisClaudeBootBlock(source);
  assert.equal(action, 'repaired');
  assert.doesNotMatch(content, /half written/);
  assert.ok(content.endsWith(`${END}\n\n# Keep me\n`));
});

test('default argument behaves like an empty file', () => {
  assert.equal(upsertAtrisClaudeBootBlock().action, 'created');
});
