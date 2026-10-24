'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { runAtris2Turn } = require('../commands/probe');

test('a streamed result reaches the caller from a complete event frame', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-stream-result-'));
  const savedEnv = { ...process.env };
  const savedRequest = https.request;
  try {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ATRIS_')) delete process.env[key];
    }
    process.env.HOME = home;
    process.env.ATRIS_API_URL = 'https://example.invalid';
    fs.mkdirSync(path.join(home, '.atris'));
    fs.writeFileSync(path.join(home, '.atris', 'credentials.json'), JSON.stringify({
      token: 'test-stream-token', email: 'stream@example.test', provider: null,
    }));
    https.request = (_options, receive) => {
      const req = new EventEmitter();
      req.setTimeout = () => req;
      req.write = () => true;
      req.end = () => {
        const res = new EventEmitter();
        res.statusCode = 200;
        res.setEncoding = () => res;
        receive(res);
        res.emit('data', '\ndata: ' + JSON.stringify({ type: 'result', result: 'The requested document is ready.' }) + '\n\n');
        res.emit('end');
      };
      return req;
    };
    const result = await runAtris2Turn({ prompt: 'Summarize the document.' });
    assert.equal(result.text, 'The requested document is ready.');
  } finally {
    https.request = savedRequest;
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
  }
});
