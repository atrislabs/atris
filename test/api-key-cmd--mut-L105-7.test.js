'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { apiKeyCommand } = require('../commands/api-key');

test('rotate and revoke without an id print the exact usage error', async () => {
  for (const action of ['rotate', 'revoke']) {
    const output = [];
    const errors = [];
    const result = await apiKeyCommand([action], {
      log: (line) => output.push(line),
      err: (line) => errors.push(line),
      loadCredentials: () => null,
      apiRequestJson: () => { throw new Error('unexpected network request'); },
    });

    assert.equal(result, 1);
    assert.deepEqual(output, []);
    assert.deepEqual(errors, [`usage: atris api-key ${action} <id>`]);
  }
});
