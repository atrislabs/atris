'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FUNCTIONAL_MEMBER_TOPICS, resolveFunctionalOwner } = require('../lib/functional-owner');

test('an empty topic term does not match nonempty task text', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'functional-owner-empty-term-'));
  const originalLength = FUNCTIONAL_MEMBER_TOPICS.length;
  try {
    // The exported topic table is mutable. Empty terms must contribute no
    // signal, even though every nonempty string includes the empty string.
    FUNCTIONAL_MEMBER_TOPICS.push({ owner: 'empty-term-owner', terms: [''] });
    assert.deepStrictEqual(resolveFunctionalOwner({ root, title: 'quartz' }), {
      owner: 'architect',
      reason: 'missing_functional_owner_fit',
      requested_owner: null,
      executed_by: null,
      proposed_member: 'quartz-owner',
    });
  } finally {
    FUNCTIONAL_MEMBER_TOPICS.length = originalLength;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
