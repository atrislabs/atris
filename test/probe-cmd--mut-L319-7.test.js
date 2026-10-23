'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runAtris2Turn } = require('../commands/probe');

test('relayed file reads preserve args when arguments is absent', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-relay-args-'));
  const savedEnv = { ...process.env };
  const cwd = process.cwd();
  t.after(() => {
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  });
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, {
    HOME: home,
    PATH: '/usr/bin:/bin',
    TERM_SESSION_ID: 'probe-relay-args-test',
    ATRIS_TOKEN: 'fixture-token',
    ATRIS_API_URL: 'http://probe.invalid',
    ATRIS_TOOL_RESULT_B64: '0',
  });
  process.chdir(home);
  fs.writeFileSync(path.join(home, 'notes.txt'), 'saved relay content');
  const results = [];

  // Replace the transport, keeping the real event parser and local file read.
  t.mock.method(http, 'request', (options, onResponse) => {
    const req = new EventEmitter();
    let body = '';
    req.setTimeout = () => req;
    req.write = (chunk) => { body += chunk; return true; };
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = 200;
      res.setEncoding = () => res;
      onResponse(res);
      if (options.path === '/atris2/turn') {
        res.emit('data', `data: ${JSON.stringify({
          type: 'tool_call_request', call_id: 'read-notes', name: 'local_file_op',
          args: { type: 'read', path: 'notes.txt' },
        })}\n\n`);
      } else {
        assert.equal(options.path, '/atris2/turn/tool-result');
        results.push(JSON.parse(body));
        res.emit('data', '{}');
      }
      res.emit('end');
    };
    return req;
  });

  await runAtris2Turn({ prompt: 'Read notes.txt', localCwd: home });
  assert.equal(results.length, 1);
  assert.equal(results[0].result.stdout, 'saved relay content');
});
