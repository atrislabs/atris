'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { isHumanActor } = require('../lib/campaign-schema');

test('recognizes human actors and rejects other actor prefixes', () => {
  assert.strictEqual(isHumanActor('human:alice'), true);
  assert.strictEqual(isHumanActor('human:bob@example.com'), true);
  assert.strictEqual(isHumanActor('agent:alice'), false);
  assert.strictEqual(isHumanActor('member:alice'), false);
});

test('matches the exact prefix without trimming or requiring a suffix', () => {
  assert.strictEqual(isHumanActor('human:'), true);
  assert.strictEqual(isHumanActor('human:agent:alice'), true);
  for (const actor of ['human', 'Human:alice', 'HUMAN:alice', ' human:alice', 'agent:human:alice']) {
    assert.strictEqual(isHumanActor(actor), false, JSON.stringify(actor));
  }
});

test('returns false for empty and non-string inputs without coercing them', () => {
  assert.strictEqual(isHumanActor(), false);
  for (const actor of ['', '   ', null, undefined, false, true, 0, 42, [], ['human:alice'], {}, Symbol('human:alice')]) {
    assert.strictEqual(isHumanActor(actor), false);
  }
  assert.strictEqual(isHumanActor({
    toString() { throw new Error('must not coerce actor'); },
    startsWith() { throw new Error('must not call non-string methods'); },
  }), false);
});
