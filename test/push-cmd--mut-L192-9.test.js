const test = require('node:test');
const assert = require('node:assert/strict');
const { shouldRetrySyncIndividually } = require('../commands/push');

test('a successful batch must not retry its files individually', () => {
  const files = [
    { path: '/first.md', content: 'first' },
    { path: '/second.md', content: 'second' },
  ];

  assert.strictEqual(shouldRetrySyncIndividually({ ok: true, status: 200 }, files), false);
});
