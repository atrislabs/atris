const test = require('node:test');
const assert = require('node:assert');
const { DENIED_TAGS, isSafeLane } = require('../lib/fleet');

test('money and payments tags are denied lanes, same as billing', () => {
  for (const tag of ['money', 'payments', 'billing']) {
    assert.ok(DENIED_TAGS.includes(tag), `${tag} must be a denied lane`);
  }
});
