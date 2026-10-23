const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const https = require('node:https');
const api = require('../utils/api');

const originalBase = api.getApiBaseUrl;
api.getApiBaseUrl = () => 'https://example.com:8443';
const { streamSession } = require('../commands/serve');
api.getApiBaseUrl = originalBase;

test('session stream preserves an explicit HTTPS port', async () => {
  const originalRequest = https.request;
  let port;
  https.request = (options) => {
    port = options.port;
    const request = new EventEmitter();
    request.end = () => queueMicrotask(() => request.emit('error', new Error('offline fixture')));
    return request;
  };
  try {
    await streamSession('session_fixture', 'token_fixture', () => {}).catch(() => {});
    assert.equal(port, '8443');
  } finally {
    https.request = originalRequest;
  }
});
