'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDraft } = require('../lib/campaign-new');

test('a draft without a title uses an empty title', () => {
  const draft = parseDraft(JSON.stringify({ judge_script: 'exit 1', seats: [] }), []);
  assert.strictEqual(draft.title, '');
});
