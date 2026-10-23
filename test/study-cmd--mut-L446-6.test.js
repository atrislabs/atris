'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { run } = require('../commands/study');

test('an ordinary waiting-room card displays its claim immediately', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'study-card-'));
  const previousCwd = process.cwd();
  const previousEnv = Object.fromEntries(['HOME', 'ATRIS_STUDY_ROOT'].map(key => [key, process.env[key]]));
  const previousGet = http.get;
  const previousWrite = process.stdout.write;
  const previousExit = process.exit;
  const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const rawDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'setRawMode');
  let output = '';
  try {
    process.env.HOME = temp;
    process.env.ATRIS_STUDY_ROOT = temp;
    process.chdir(temp);
    fs.mkdirSync(path.join(temp, 'venv', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(temp, 'venv', 'bin', 'python'), '');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdin, 'setRawMode', { configurable: true, value() {} });
    process.exit = code => { throw new Error(`unexpected exit ${code}`); };
    process.stdout.write = chunk => { output += String(chunk); return true; };
    // Supply feed responses in memory, without opening a socket.
    http.get = (url, options, callback) => {
      const request = new EventEmitter();
      const response = new EventEmitter();
      response.statusCode = 200;
      response.resume = () => {};
      queueMicrotask(() => {
        callback(response);
        response.emit('data', JSON.stringify(String(url).endsWith('/api/next')
          ? { type: 'fact', claim: 'Spaced repetition strengthens recall.', why: 'Retrieval builds memory.' }
          : { locked_total: 0, retention_percent: 0 }));
        response.emit('end');
      });
      return request;
    };
    await run(['--while', "printf 'build complete\\n'"]);
    assert.ok(output.includes('Spaced repetition'), 'the initial card should show its learning content');
  } finally {
    http.get = previousGet;
    process.stdout.write = previousWrite;
    process.exit = previousExit;
    process.stdin.pause();
    for (const [key, descriptor] of [['isTTY', ttyDescriptor], ['setRawMode', rawDescriptor]]) {
      if (descriptor) Object.defineProperty(process.stdin, key, descriptor);
      else delete process.stdin[key];
    }
    process.chdir(previousCwd);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
