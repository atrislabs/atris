'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { memberRefusalReason } = require('../lib/member-type');

test('human members receive the person refusal with their name', () => {
  const expected = 'Sam is a person, not an AI teammate; Atris can prepare work for them but cannot act as them';
  assert.strictEqual(memberRefusalReason('Sam', { type: 'human' }), expected);
  assert.strictEqual(memberRefusalReason('Sam', { type: '  HuMaN  ' }), expected);
});

test('unknown types are refused with trimmed spelling preserved', () => {
  assert.strictEqual(
    memberRefusalReason('Robin', { type: '  Robot  ' }),
    "Robin has type 'Robot', which is neither ai nor human, so Atris won't run it"
  );
  assert.strictEqual(
    memberRefusalReason('Robin', { type: 'human-ish' }),
    "Robin has type 'human-ish', which is neither ai nor human, so Atris won't run it"
  );
});

test('ai and agent aliases have no refusal regardless of case or surrounding spaces', () => {
  for (const type of ['ai', 'agent', '  AI  ', '  AgEnT  ']) {
    assert.strictEqual(memberRefusalReason('Alex', { type }), '', type);
  }
});

test('missing, empty, and non-string types default to runnable members', () => {
  for (const frontmatter of [undefined, null, {}, { type: '' }, { type: ' \t\n ' },
    { type: null }, { type: 42 }, { type: false }, { type: ['human'] }]) {
    assert.strictEqual(memberRefusalReason('Alex', frontmatter), '');
  }
});
