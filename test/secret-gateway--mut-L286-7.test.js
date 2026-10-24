'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { startSecretGateway } = require('../lib/secret-gateway');

test('forwards the client accept header to the upstream request', async (t) => {
  let handler;
  let upstreamHeaders;
  const server = new EventEmitter();
  server.listen = (...args) => { args.at(-1)(); return server; };
  server.address = () => ({ port: 43123, address: '127.0.0.1' });
  server.close = (done) => { if (done) done(); };
  t.mock.method(http, 'createServer', (callback) => { handler = callback; return server; });
  t.mock.method(https, 'request', (options) => {
    upstreamHeaders = options.headers;
    const upstream = new PassThrough();
    upstream.setTimeout = () => upstream;
    return upstream;
  });

  await startSecretGateway({
    grant: {
      id: 'items-read', host: 'api.example.com', secretEnv: 'ITEMS_SECRET',
      pathPrefixes: ['/v1/items'], methods: ['GET'],
      credentialHeader: 'authorization', placeholderEnv: 'ITEMS_KEY',
      baseUrlEnv: 'ITEMS_URL',
    },
    secret: 'Bearer upstream-secret', placeholder: 'client-placeholder',
  });
  const request = new PassThrough();
  request.method = 'GET';
  request.url = '/v1/items';
  request.headers = {
    host: '127.0.0.1:43123', authorization: 'client-placeholder',
    accept: 'application/json',
  };
  request.socket = { remoteAddress: '127.0.0.1' };
  const response = new PassThrough();
  response.setHeader = () => {};
  response.writeHead = () => response;
  await handler(request, response);
  request.end();
  assert.equal(upstreamHeaders && upstreamHeaders.accept, 'application/json');
});
