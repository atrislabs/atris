'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const { Writable } = require('node:stream');
const { startSecretGateway } = require('../lib/secret-gateway');

test('array credential headers retain their first placeholder for authorization', async (t) => {
  let server;
  t.mock.method(http.Server.prototype, 'listen', function (...args) {
    server = this;
    args.at(-1)();
    return this;
  });
  t.mock.method(http.Server.prototype, 'address', () => ({ port: 12345 }));
  let forwardedCredential;
  t.mock.method(https, 'request', (options) => {
    forwardedCredential = options.headers['set-cookie'];
    return new Writable({ write(_chunk, _encoding, done) { done(); } });
  });

  await startSecretGateway({
    grant: {
      id: 'array-credential',
      host: 'api.example.com',
      secretEnv: 'API_SECRET',
      credentialHeader: 'set-cookie',
      placeholderEnv: 'API_PLACEHOLDER',
      baseUrlEnv: 'API_BASE_URL',
      pathPrefixes: ['/v1/items'],
      methods: ['GET'],
    },
    placeholder: 'reserved-placeholder',
    secret: 'real-credential',
  });

  // Node preserves incoming set-cookie headers as arrays.
  server.emit('request', {
    method: 'GET',
    url: '/v1/items',
    headers: { host: 'localhost:12345', 'set-cookie': ['reserved-placeholder'] },
  }, { setHeader() {}, end() {} });

  assert.equal(forwardedCredential, 'real-credential');
});
