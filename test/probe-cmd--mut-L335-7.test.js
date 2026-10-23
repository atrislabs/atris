'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { runAtris2Turn } = require('../commands/probe');

test('relayed file listings preserve the terminal output sent to the caller', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-list-output-'));
  const env = { ...process.env };
  const cwd = process.cwd();
  const savedHttps = https.request;
  const savedHttp = http.request;
  let stream;
  let output;
  process.env.HOME = home;
  process.env.ATRIS_TOKEN = 'fixture-token';
  process.env.ATRIS_API_URL = 'https://example.invalid/api';
  process.env.TERM_SESSION_ID = 'fixture-terminal';
  process.chdir(home);

  const request = (options, callback) => {
    const req = new EventEmitter();
    let body = '';
    req.write = (chunk) => { body += chunk; };
    req.setTimeout = () => req;
    req.destroy = () => {};
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = 200;
      res.setEncoding = () => {};
      callback(res);
      if (options.path.endsWith('/terminal')) {
        res.emit('data', JSON.stringify({ exit_code: 0, stdout: './draft.txt\n', stderr: '' }));
        res.emit('end');
      } else if (options.path.endsWith('/tool-result')) {
        const payload = JSON.parse(body);
        output = JSON.parse(payload.output_encoding === 'base64'
          ? Buffer.from(payload.result, 'base64').toString('utf8')
          : payload.result);
        res.emit('data', '{}');
        res.emit('end');
        stream.emit('data', 'data: ' + JSON.stringify({ type: 'result', result: 'done' }) + '\n\n');
        stream.emit('end');
      } else {
        stream = res;
        res.emit('data', 'data: ' + JSON.stringify({
          type: 'tool_call_request', call_id: 'list-drafts', name: 'local_file_op',
          args: { type: 'list', path: '.' },
        }) + '\n\n');
      }
    };
    return req;
  };
  https.request = http.request = request;
  try {
    await runAtris2Turn({ prompt: 'List the draft files.', cwd: home });
    assert.match(output.stdout, /draft\.txt/);
  } finally {
    https.request = savedHttps;
    http.request = savedHttp;
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, env);
  }
});
