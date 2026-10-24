'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { frontmatterOf } = require('../lib/member-export');

test('a description ending with a bracket remains a scalar', () => {
  const { fields } = frontmatterOf('---\ndescription: Reviews changes [carefully]\n---\n');
  assert.strictEqual(fields.description, 'Reviews changes [carefully]');
});
