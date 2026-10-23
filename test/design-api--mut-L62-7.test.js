'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { designRequest } = require('../lib/design-api');

async function listen(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

async function withLocalApi(t) {
  const seen = [];
  const origin = await listen(t, (req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ method: req.method }));
    });
  });
  const previous = process.env.ATRIS_API_URL;
  process.env.ATRIS_API_URL = `${origin}/api`;
  t.after(() => {
    if (previous === undefined) delete process.env.ATRIS_API_URL;
    else process.env.ATRIS_API_URL = previous;
  });
  return seen;
}

test('designRequest sends the method the caller asked for', async (t) => {
  const seen = await withLocalApi(t);
  const result = await designRequest('/design/search', {
    key: 'local-test-key',
    method: 'POST',
    body: { query: 'calm pricing page', limit: 3 },
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, 'POST');
  assert.equal(seen[0].url, '/api/design/search');
  assert.deepEqual(JSON.parse(seen[0].body), { query: 'calm pricing page', limit: 3 });
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.deepEqual(result.data, { method: 'POST' });
});

test('designRequest sends other verbs unchanged', async (t) => {
  const seen = await withLocalApi(t);
  const result = await designRequest('/design/extractions/abc', {
    key: 'local-test-key',
    method: 'DELETE',
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, 'DELETE');
  assert.deepEqual(result.data, { method: 'DELETE' });
});

test('designRequest defaults to GET when no method is given', async (t) => {
  const seen = await withLocalApi(t);
  const result = await designRequest('/design/extractions/abc', { key: 'local-test-key' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, 'GET');
  assert.deepEqual(result.data, { method: 'GET' });
});
