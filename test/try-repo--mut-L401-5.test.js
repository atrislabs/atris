'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createTryServer } = require('../lib/try-repo');

function fakeReq(path) {
  return {
    method: 'GET',
    url: path,
    headers: {},
    socket: { remoteAddress: '203.0.113.7' },
  };
}

function fakeRes() {
  const res = {
    status: null,
    body: null,
    writeHead(status) {
      res.status = status;
    },
    end(body) {
      res.body = body;
      res.done();
    },
  };
  res.finished = new Promise((resolve) => {
    res.done = resolve;
  });
  return res;
}

test('a visit exactly windowMs old no longer counts toward the limit', async (t) => {
  const realNow = Date.now;
  const windowMs = 60_000;
  const t0 = 1_700_000_000_000;
  let now = t0;
  Date.now = () => now;
  t.after(() => {
    Date.now = realNow;
  });

  const server = createTryServer({
    run: async () => ({ ok: true, html: 'mapped' }),
    perWindow: 1,
    windowMs,
  });
  t.after(() => server.close());

  const first = fakeRes();
  server.emit('request', fakeReq('/try?repo=https://github.com/a/b'), first);
  await first.finished;
  assert.strictEqual(first.status, 200);

  now = t0 + windowMs;
  const second = fakeRes();
  server.emit('request', fakeReq('/try?repo=https://github.com/a/b'), second);
  await second.finished;
  assert.strictEqual(second.status, 200);
});
