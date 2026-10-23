'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { hasAgentJargon } = require('../lib/autoland');

test('hasAgentJargon detects each supported jargon form in a sentence', () => {
  for (const text of [
    'The agent_certified result is ready.',
    'Read the landingResult now.',
    'Run with --dry-run first.',
    'The work belongs to CLI-123.',
    'Version v2_result is ready.',
  ]) {
    assert.strictEqual(hasAgentJargon(text), true, text);
    // Repeated calls must not retain a regular expression cursor.
    assert.strictEqual(hasAgentJargon(text), true, text);
  }
});

test('hasAgentJargon accepts plain language and respects token boundaries and case', () => {
  for (const text of [
    'People can review the result faster because the summary is clearer.',
    'A well-written result saves time.',
    'CLI tools help people.',
    'cli-123',
    'XCLI-1234Y',
    'UPPER_CASE',
    'word_',
    '--123',
  ]) {
    assert.strictEqual(hasAgentJargon(text), false, text);
  }
  assert.strictEqual(hasAgentJargon('(CLI-123)'), true);
  assert.strictEqual(hasAgentJargon('plain words'), false);
});

test('hasAgentJargon handles empty and coerced inputs', () => {
  for (const value of [undefined, null, '', '   \n\t', false, 0, 123]) {
    assert.strictEqual(hasAgentJargon(value), false);
  }
  assert.strictEqual(hasAgentJargon({ toString: () => 'agent_result' }), true);
  assert.throws(() => hasAgentJargon(Object.create(null)), TypeError);
});
