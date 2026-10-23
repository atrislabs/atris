'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');

test('runAtris2Turn selects the transport matching the API URL protocol', async (t) => {
  let base;
  t.mock.method(require('../utils/auth'), 'loadCredentials', () => ({ token: 'test-token' }));
  t.mock.method(require('../utils/api'), 'getApiBaseUrl', () => base);
  t.mock.method(Date, 'now', () => 1000);

  // Stop at the request boundary: neither transport can open a socket.
  // Their distinct errors expose the chosen transport in the returned result.
  t.mock.method(http, 'request', () => { throw new Error('http transport selected'); });
  t.mock.method(https, 'request', () => { throw new Error('https transport selected'); });

  const { runAtris2Turn } = require('../commands/probe');
  for (const protocol of ['https', 'http']) {
    base = `${protocol}://probe.invalid/api`;
    assert.deepStrictEqual(await runAtris2Turn({ prompt: 'transport check' }), {
      ok: false,
      text: '',
      engine: null,
      tools_run: 0,
      cli_ops: [],
      unsupported: [],
      error: `Error: ${protocol} transport selected`,
      duration_ms: 0,
    });
  }
});
