const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePackShareArgs } = require('../commands/pack');

test('pack share rejects a recipient label that is empty after trimming', () => {
  assert.throws(
    () => parsePackShareArgs(['design-brain', '--for', '   ']),
    {
      name: 'Error',
      message: '--for needs a recipient label between 1 and 120 characters',
    },
  );
});
