'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { run } = require('../commands/study');

test('correct grades a probe immediately after revealing it', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-grade-'));
  const cwd = process.cwd();
  const previousHome = process.env.HOME;
  const previousRoot = process.env.ATRIS_STUDY_ROOT;
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin');
  t.after(() => {
    process.chdir(cwd);
    Object.defineProperty(process, 'stdin', stdinDescriptor);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousRoot === undefined) delete process.env.ATRIS_STUDY_ROOT;
    else process.env.ATRIS_STUDY_ROOT = previousRoot;
  });
  process.env.HOME = home;
  process.env.ATRIS_STUDY_ROOT = home;
  process.chdir(home);
  fs.mkdirSync(path.join(home, 'venv', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(home, 'venv', 'bin', 'python'), '');

  const input = new EventEmitter();
  input.isTTY = true;
  input.setRawMode = () => {};
  input.resume = () => {};
  input.pause = () => {};
  const keys = [' ', 'c', 'q'];
  input.on('newListener', (event) => {
    if (event === 'data') queueMicrotask(() => input.emit('data', Buffer.from(keys.shift() || 'q')));
  });
  Object.defineProperty(process, 'stdin', { configurable: true, value: input });
  t.mock.method(process.stdout, 'write', () => true);
  t.mock.method(console, 'log', () => {});
  t.mock.method(process, 'exit', (code) => { throw new Error(`unexpected exit ${code}`); });

  function respond(callback, body) {
    const response = new EventEmitter();
    response.statusCode = 200;
    response.resume = () => {};
    callback(response);
    response.emit('data', JSON.stringify(body));
    response.emit('end');
  }
  t.mock.method(http, 'get', (url, options, callback) => {
    const request = new EventEmitter();
    queueMicrotask(() => respond(callback, url.endsWith('/api/next')
      ? { type: 'probe', card_id: 'probe-one', claim: 'Recall the answer', why: 'The answer' }
      : { locked_total: 0, retention_percent: 0 }));
    return request;
  });
  const answers = [];
  t.mock.method(http, 'request', (options, callback) => {
    const request = new EventEmitter();
    request.write = (data) => answers.push(JSON.parse(data));
    request.end = () => queueMicrotask(() => respond(callback, {}));
    return request;
  });

  // A shell builtin completes without starting a tool or waiting on a clock.
  await run(['--while', ':']);
  assert.equal(answers.find((answer) => answer.action === 'correct')?.card_id, 'probe-one');
});
