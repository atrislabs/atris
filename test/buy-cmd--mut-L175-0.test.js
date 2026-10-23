'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buyCommand } = require('../commands/buy');

test('buy status warns that money may have moved when the state is unknown', async () => {
  const output = [];
  const errors = [];
  const code = await buyCommand(['status', 'ord_test'], {
    loadCredentials: () => ({ token: 'test-token' }),
    now: () => 0,
    apiRequestJson: async (pathname, options) => {
      assert.equal(pathname, '/commerce/ord_test');
      assert.equal(options.method, 'GET');
      return { ok: true, data: { id: 'ord_test', kind: 'trade', state: 'unknown' } };
    },
    log: (text) => output.push(text),
    err: (text) => errors.push(text),
  });

  assert.equal(code, 0);
  assert.deepEqual(errors, []);
  assert.deepEqual(output, [
    'ord_test  trade  UNKNOWN\n' +
    'Money may have moved. Check the store or Robinhood app. Do not buy again to fix it.',
  ]);
});
