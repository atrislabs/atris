'use strict';
require('./helpers/clean-temp');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { Readable } = require('node:stream');
const { EventEmitter } = require('node:events');
const { run } = require('../commands/study');

test('an already running feed supplies session stats in while mode', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-feed-session-'));
  const cwd = process.cwd();
  const savedEnv = { HOME: process.env.HOME, ATRIS_STUDY_ROOT: process.env.ATRIS_STUDY_ROOT };
  const tty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const rawMode = Object.getOwnPropertyDescriptor(process.stdin, 'setRawMode');
  const lines = [];
  try {
    process.env.HOME = temp;
    process.env.ATRIS_STUDY_ROOT = temp;
    process.chdir(temp);
    fs.mkdirSync(path.join(temp, 'venv/bin'), { recursive: true });
    fs.writeFileSync(path.join(temp, 'venv/bin/python'), '');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdin, 'setRawMode', { configurable: true, value: () => {} });
    t.mock.method(process.stdin, 'resume', () => process.stdin);
    t.mock.method(process.stdin, 'pause', () => process.stdin);
    t.mock.method(process.stdout, 'write', () => true);
    t.mock.method(console, 'log', (...args) => lines.push(args.join(' ')));
    t.mock.method(process, 'exit', (code) => { throw new Error(`unexpected exit ${code}`); });
    t.mock.method(http, 'get', (url, options, callback) => {
      const body = String(url).endsWith('/api/stats')
        ? { locked_total: 37, retention_percent: 82 }
        : { type: 'progress', claim: 'Keep learning', why: 'Practice helps' };
      const response = Readable.from([JSON.stringify(body)]);
      response.statusCode = 200;
      callback(response);
      return new EventEmitter();
    });

    await run(['--while', 'exit 0']);
    assert.ok(lines.some((line) => /\b37 locked in\b/.test(line)));
  } finally {
    t.mock.restoreAll();
    if (tty) Object.defineProperty(process.stdin, 'isTTY', tty);
    else delete process.stdin.isTTY;
    if (rawMode) Object.defineProperty(process.stdin, 'setRawMode', rawMode);
    else delete process.stdin.setRawMode;
    process.chdir(cwd);
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
