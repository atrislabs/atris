'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

test('a design call refused for a sign-in token says to use a developer key', async (t) => {
  const server = http.createServer((req, res) => { res.statusCode = 401; res.setHeader('content-type', 'application/json'); res.end('{"detail":"Missing API key"}'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const prev = process.env.ATRIS_API_URL;
  process.env.ATRIS_API_URL = `http://127.0.0.1:${server.address().port}/api`;
  t.after(() => { if (prev === undefined) delete process.env.ATRIS_API_URL; else process.env.ATRIS_API_URL = prev; });
  const { designRequest } = require('../lib/design-api');
  const signIn = await designRequest('/design/search?q=x', { key: 'eyJ.login.jwt' });
  assert.equal(signIn.status, 401);
  assert.match(signIn.error, /^Missing API key\. design tools take a developer key, not your sign-in/);
  const devKey = await designRequest('/design/search?q=x', { key: 'atris_bad' });
  assert.equal(devKey.error, 'Missing API key');
});
