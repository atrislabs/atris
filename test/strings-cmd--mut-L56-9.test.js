const test = require('node:test');
const assert = require('node:assert/strict');
const { isUserFacing } = require('../commands/strings');

test('numeric text is excluded from user-facing labels', () => {
  assert.strictEqual(isUserFacing('123 456', 2), false);
});
