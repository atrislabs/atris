'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { memberMarkdown } = require('../lib/member-scaffold');

test('custom member purpose is preserved in the description field', () => {
  const description = 'Review accessibility regressions.';
  const text = memberMarkdown({ name: 'orb', role: 'Reviewer', description });
  const field = text.split('\n').find(line => line.startsWith('description:'));
  assert.equal(field.slice('description:'.length).trim(), description);
});
