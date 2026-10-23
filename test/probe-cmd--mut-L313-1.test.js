'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runAtris2Turn } = require('../commands/probe');

test('runAtris2Turn returns the exact answer from an object SSE event', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-object-event-'));
  const savedEnv = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    fs.rmSync(home, { recursive: true, force: true });
  });
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, {
    HOME: home,
    TERM_SESSION_ID: 'probe-object-event-test',
    ATRIS_TOKEN: 'synthetic-test-token',
    ATRIS_API_URL: 'http://probe.invalid',
  });

  // Replace only the transport. Exercise the exported client's real SSE parser
  // and event handler, without opening a socket or running an engine.
  t.mock.method(http, 'request', (options, onResponse) => {
    assert.equal(options.path, '/atris2/turn');
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.write = () => true;
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = 200;
      res.setEncoding = () => res;
      onResponse(res);
      res.emit('data', 'data: {"type":"result","result":"The streamed answer is preserved exactly."}\n\n');
      res.emit('end');
    };
    return req;
  });

  const result = await runAtris2Turn({ prompt: 'Return the fixture answer.' });
  assert.equal(result.error, null);
  assert.equal(result.text, 'The streamed answer is preserved exactly.');
});
