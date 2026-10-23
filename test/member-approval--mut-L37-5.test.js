'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseApprovalRequired } = require('../lib/member-approval');

test('parses block items ending at frontmatter boundary', () => {
  const result = parseApprovalRequired('---\napproval-required:\n  - deploy\n---');
  assert.equal(result.length, 1);
  assert.equal(result[0], 'deploy');
});
