'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { startSecretGateway } = require('../lib/secret-gateway');

test('chunked read requests are rejected before forwarding credentials', async () => {
  const originalCreateServer = http.createServer;
  const originalRequest = https.request;
  https.request = () => {
    const upstream = new EventEmitter();
    upstream.end = () => upstream;
    upstream.destroy = () => upstream;
    upstream.setTimeout = () => upstream;
    return upstream;
  };
  let handler;
  http.createServer = (callback) => {
    handler = callback;
    const server = new EventEmitter();
    server.listen = (...args) => { args.at(-1)(); return server; };
    server.address = () => ({ address: '127.0.0.1', port: 43210 });
    server.close = (callback) => callback();
    return server;
  };
  let gateway;
  try {
    gateway = await startSecretGateway({
      grant: {
        id: 'read-items', host: 'api.example.com', secretEnv: 'ITEM_SECRET',
        pathPrefixes: ['/v1/items'], methods: ['GET', 'HEAD'],
        credentialHeader: 'authorization', placeholderEnv: 'ITEM_KEY',
        baseUrlEnv: 'ITEM_URL',
      },
      secret: 'Bearer private-value', placeholder: 'placeholder-value',
    });
    const req = new EventEmitter();
    req.method = 'GET';
    req.url = '/v1/items';
    req.headers = {
      host: '127.0.0.1:43210', authorization: 'placeholder-value',
      'transfer-encoding': 'chunked',
    };
    req.socket = { remoteAddress: '127.0.0.1' };
    req.resume = () => req;
    const res = {
      statusCode: 200,
      writeHead(status) { this.statusCode = status; return this; },
      setHeader() {},
      end() {},
    };
    handler(req, res);
    assert.equal(res.statusCode, 400);
  } finally {
    http.createServer = originalCreateServer;
    https.request = originalRequest;
    if (gateway) await gateway.close();
  }
});
