'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSimpleFlags } = require('../commands/interview');

test('quoted flag values lose their surrounding quotes', () => {
  const parsed = parseSimpleFlags(
    ['--name', '"test dj"', "--want='more gigs'"],
    ['--name', '--want']
  );

  assert.strictEqual(parsed.values['--name'], 'test dj');
  assert.strictEqual(parsed.values['--want'], 'more gigs');
});
