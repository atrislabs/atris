const test = require('node:test');
const assert = require('node:assert/strict');
const { parseLiveOptions } = require('../commands/live');

test('zero interval falls back to the normal polling interval', () => {
  assert.strictEqual(parseLiveOptions(['--interval', '0']).intervalSec, 120);
});
