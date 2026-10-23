'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const https = require('node:https');
const http = require('node:http');
const { runAtris2Turn } = require('../commands/probe');

test('a relayed CLI operation retains its operation name in the receipt', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-cli-operation-'));
  const savedEnv = { ...process.env };
  const originalHttps = https.request;
  const originalHttp = http.request;
  process.env.HOME = home;
  process.env.ATRIS_TOKEN = 'test-token';
  process.env.ATRIS_API_URL = 'https://example.invalid';
  process.env.TERM_SESSION_ID = 'cli-operation-test';

  function request(options, callback) {
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.write = () => true;
    req.destroy = () => req;
    req.end = () => queueMicrotask(() => {
      const res = new EventEmitter();
      res.statusCode = 200;
      res.setEncoding = () => res;
      callback(res);
      if (options.path === '/atris2/turn') {
        res.emit('data', `data: ${JSON.stringify({
          type: 'tool_call_request', name: 'local_atris_cli_op',
          call_id: 'calendar-call', args: { type: 'calendar_today' },
        })}\n`);
      } else {
        res.emit('data', JSON.stringify({ exit_code: 0, stdout: 'No events scheduled.' }));
      }
      res.emit('end');
    });
    return req;
  }

  https.request = request;
  http.request = request;
  try {
    const result = await runAtris2Turn({ prompt: 'Show my calendar today.' });
    assert.strictEqual(result.cli_ops[0], 'calendar_today');
  } finally {
    https.request = originalHttps;
    http.request = originalHttp;
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
  }
});
