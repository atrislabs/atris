'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { heartbeatLiveness } = require('../lib/autoland');

// The root is unused: liveness here reports the saved policy value only.
test('heartbeatLiveness preserves explicit installed and uninstalled booleans', () => {
  assert.strictEqual(heartbeatLiveness(undefined, { heartbeat_installed: true }), true);
  assert.strictEqual(heartbeatLiveness(undefined, { heartbeat_installed: false }), false);
});

test('heartbeatLiveness returns unknown for missing or empty policy', () => {
  assert.strictEqual(heartbeatLiveness(), null);
  assert.strictEqual(heartbeatLiveness(undefined, undefined), null);
  assert.strictEqual(heartbeatLiveness(undefined, null), null);
  assert.strictEqual(heartbeatLiveness(undefined, {}), null);
  assert.strictEqual(heartbeatLiveness(undefined, { enabled: true }), null);
});

test('heartbeatLiveness does not coerce nonboolean installation values', () => {
  for (const value of [undefined, null, 0, 1, '', 'true', 'false', [], {}, new Boolean(false)]) {
    assert.strictEqual(
      heartbeatLiveness(undefined, { heartbeat_installed: value }),
      null,
      `expected unknown for ${Object.prototype.toString.call(value)}: ${String(value)}`,
    );
  }
});
