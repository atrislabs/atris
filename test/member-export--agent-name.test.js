'use strict';

// agentName turns a member folder name into one form both Claude Code and
// Codex accept: lowercase letters, digits, and hyphens.

const test = require('node:test');
const assert = require('node:assert');
const { agentName } = require('../lib/member-export');

test('a normal member slug becomes a lowercase hyphenated agent name', () => {
  assert.strictEqual(agentName('validator'), 'validator');
  assert.strictEqual(agentName('Chief-Of-Staff'), 'chief-of-staff');
  assert.strictEqual(agentName('Reviewer_One'), 'reviewer-one');
  assert.strictEqual(agentName('Scout.Lead'), 'scout-lead');
});

test('punctuation, spaces, and repeated separators collapse, and real hyphens stay', () => {
  assert.strictEqual(agentName('  Hello World!! '), 'hello-world');
  assert.strictEqual(agentName('foo___bar'), 'foo-bar');
  assert.strictEqual(agentName('---already---'), 'already');
  assert.strictEqual(agentName('A--B'), 'a--b');
  assert.strictEqual(agentName('Agent 007'), 'agent-007');
  assert.strictEqual(agentName('Émile'), 'mile');
});

test('an empty or symbol-only name falls back to member', () => {
  assert.strictEqual(agentName(''), 'member');
  assert.strictEqual(agentName('   '), 'member');
  assert.strictEqual(agentName('---'), 'member');
  assert.strictEqual(agentName('!!!'), 'member');
  assert.strictEqual(agentName(null), 'null');
  assert.strictEqual(agentName(undefined), 'undefined');
});
