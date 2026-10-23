'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSets } = require('../commands/clarity');

test('parseSets ignores assignments without --set and keeps explicit assignments', () => {
  assert.deepEqual(
    parseSets(['--unrelated', 'voice=plain', '--set', 'focus=ship']),
    { focus: 'ship' },
  );
});
