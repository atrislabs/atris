'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startSecretGateway } = require('../lib/secret-gateway');

test('denied requests retain their requested path in the audit receipt', async (t) => {
  let server;
  t.mock.method(http.Server.prototype, 'listen', function (...args) {
    server = this;
    args.at(-1)();
    return this;
  });
  t.mock.method(http.Server.prototype, 'address', () => ({ port: 12345 }));

  const gateway = await startSecretGateway({
    grant: {
      id: 'audit-path',
      host: 'api.example.com',
      secretEnv: 'API_SECRET',
      credentialHeader: 'authorization',
      placeholderEnv: 'API_PLACEHOLDER',
      baseUrlEnv: 'API_BASE_URL',
      pathPrefixes: ['/v1/items'],
      methods: ['GET'],
    },
    placeholder: 'reserved-placeholder',
    secret: 'real-credential',
  });

  server.emit('request', {
    method: 'GET',
    url: '/v1/items/42',
    headers: { host: 'localhost:12345', authorization: 'wrong-placeholder' },
  }, { setHeader() {}, end() {} });

  assert.strictEqual(gateway.receipts[0].path, '/v1/items/42');
});
