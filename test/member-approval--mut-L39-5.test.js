'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseApprovalRequired } = require('../lib/member-approval');

test('an indentless YAML sequence retains its approval category', () => {
  const categories = parseApprovalRequired([
    '---',
    'name: reviewer',
    'permissions:',
    '  approval-required:',
    '  - publish',
    '  can-read: true',
    '---',
  ].join('\n'));

  assert.strictEqual(categories.includes('publish'), true);
});
