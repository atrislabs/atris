'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { frontmatterOf } = require('../lib/member-export');

test('plain markdown without metadata retains its instructions', () => {
  const instructions = '# Reviewer\n\nCheck each change against its requirements.\n';
  assert.equal(frontmatterOf(instructions).body, instructions);
});
