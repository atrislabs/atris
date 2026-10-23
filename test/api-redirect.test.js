'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { apiRequestJson } = require('../utils/api');
const { refreshAccessToken } = require('../utils/auth');
const { requestClientToken } = require('../utils/agent-client');
const { designRequest } = require('../lib/design-api');
const { run: publish } = require('../lib/site-publish');

async function listen(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

async function fixture(t, crossOrigin) {
  const bearer = randomUUID();
  const refresh = randomUUID();
  const secret = randomUUID();
  const requests = [];
  let foreignRequests = 0;
  const foreign = await listen(t, (req, res) => {
    foreignRequests++;
    req.resume();
    res.end('{}');
  });
  const state = { status: 307 };
  const origin = await listen(t, (req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      // Store only credential presence, so failed assertions cannot print secrets.
      requests.push({
        final: req.url === '/finish',
        bearer: req.headers.authorization === `Bearer ${bearer}`,
        refresh: body.includes(refresh),
        secret: body.includes(secret),
      });
      if (req.url !== '/finish') {
        res.writeHead(state.status, { Location: crossOrigin ? `${foreign}/finish` : '/finish' });
        res.end();
      } else {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ access_token: bearer, expires_in: 3600, verified: true }));
      }
    });
  });
  const previous = process.env.ATRIS_API_URL;
  process.env.ATRIS_API_URL = `${origin}/api`;
  t.after(() => {
    if (previous === undefined) delete process.env.ATRIS_API_URL;
    else process.env.ATRIS_API_URL = previous;
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-redirect-'));
  fs.writeFileSync(path.join(dir, 'index.html'), 'local redirect test');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const errors = [];
  const calls = [
    () => apiRequestJson('/start', { token: bearer, retries: 0 }),
    () => refreshAccessToken(refresh, null, (url, options) => apiRequestJson(url, { ...options, retries: 0 })),
    () => requestClientToken({ clientId: 'local-test', secret }),
    () => designRequest('/start', { key: bearer }),
    () => publish([dir, '--slug', 'local-test', '--no-claim'], {
      apiBase: `${origin}/api`, loadCredentials: () => ({ token: bearer }),
      log: () => {}, error: (message) => errors.push(message),
    }),
  ];
  return { state, requests, foreign, errors, calls, foreignRequests: () => foreignRequests };
}

test('same-origin redirects preserve bearer, refresh and client credentials', async (t) => {
  const f = await fixture(t, false);
  const expected = [
    { bearer: true, refresh: false, secret: false },
    { bearer: false, refresh: true, secret: false },
    { bearer: false, refresh: false, secret: true },
    { bearer: true, refresh: false, secret: false },
    { bearer: true, refresh: false, secret: false },
  ];
  for (const status of [301, 302, 307, 308]) {
    f.state.status = status;
    for (const [index, call] of f.calls.entries()) {
      const start = f.requests.length;
      const result = await call();
      assert.ok(index === 2 ? Boolean(result.access_token) : index === 4 ? result === 0 : result.ok);
      assert.deepEqual(f.requests.slice(start), [
        { final: false, ...expected[index] }, { final: true, ...expected[index] },
      ]);
    }
  }
  assert.equal(f.foreignRequests(), 0);
});

test('cross-origin redirects name the host and never send credentials to it', async (t) => {
  const f = await fixture(t, true);
  const host = new URL(f.foreign).host;
  for (const status of [301, 302, 307, 308]) {
    f.state.status = status;
    for (const [index, call] of f.calls.entries()) {
      if (index === 2 || index === 3) {
        await assert.rejects(call, (error) => error.message.includes(host));
      } else if (index === 4) {
        assert.equal(await call(), 1);
        assert.ok(f.errors.at(-1).includes(host));
      } else {
        const result = await call();
        assert.equal(result.ok, false);
        assert.ok(result.error.includes(host));
      }
      assert.equal(f.foreignRequests(), 0);
    }
  }
  assert.ok(f.requests.every((request) => !request.final));
});
