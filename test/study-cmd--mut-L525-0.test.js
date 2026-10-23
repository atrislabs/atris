'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { run } = require('../commands/study');

test('q switches to command output without requesting an interrupt exit', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'key-input-'));
  const cwd = process.cwd();
  const previous = { HOME: process.env.HOME, ATRIS_STUDY_ROOT: process.env.ATRIS_STUDY_ROOT };
  const tty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const rawMode = Object.getOwnPropertyDescriptor(process.stdin, 'setRawMode');
  let exitCode;
  const exitSignal = new Error('exit requested');
  try {
    process.env.HOME = home;
    process.env.ATRIS_STUDY_ROOT = home;
    process.chdir(home);
    fs.mkdirSync(path.join(home, 'venv', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(home, 'venv', 'bin', 'python'), '');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdin, 'setRawMode', { configurable: true, value: () => {} });
    t.mock.method(process.stdin, 'resume', () => process.stdin);
    t.mock.method(process.stdin, 'pause', () => process.stdin);
    t.mock.method(process, 'exit', (code) => { exitCode = code; throw exitSignal; });
    t.mock.method(global, 'setTimeout', (callback) => { queueMicrotask(callback); return {}; });
    t.mock.method(http, 'get', (url, options, callback) => {
      const request = new EventEmitter();
      queueMicrotask(() => {
        const response = new EventEmitter();
        response.statusCode = 200;
        response.resume = () => {};
        callback(response);
        response.emit('data', JSON.stringify(String(url).endsWith('/next')
          ? { type: 'deepdive', claim: 'A useful card', why: 'An explanation' }
          : { locked_total: 0, retention_percent: 0 }));
        response.emit('end');
      });
      return request;
    });
    t.mock.method(console, 'log', () => {});
    t.mock.method(process.stdout, 'write', () => true);
    const onListener = (event) => {
      if (event === 'data') queueMicrotask(() => process.stdin.emit('data', Buffer.from('q')));
    };
    process.stdin.on('newListener', onListener);
    try {
      await run(['--while', `"${process.execPath}" -e "process.stdout.write('finished')"`]);
    } catch (error) {
      if (error !== exitSignal) throw error;
    } finally {
      process.stdin.removeListener('newListener', onListener);
    }
    assert.equal(exitCode, undefined);
  } finally {
    t.mock.restoreAll();
    if (tty) Object.defineProperty(process.stdin, 'isTTY', tty);
    else delete process.stdin.isTTY;
    if (rawMode) Object.defineProperty(process.stdin, 'setRawMode', rawMode);
    else delete process.stdin.setRawMode;
    process.chdir(cwd);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
