'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { gmCommand } = require('../commands/gm');

test('phone startup suggests another port when the requested port is occupied', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-port-error-'));
  const originalHome = process.env.HOME;
  const cwd = process.cwd();
  const createServer = http.createServer;
  const error = console.error;
  const log = console.log;
  const exit = process.exit;
  const exitCode = process.exitCode;
  const errors = [];
  const stopped = new Error('exit intercepted');
  try {
    process.env.HOME = home;
    process.chdir(home);
    console.error = (...args) => errors.push(args.join(' '));
    console.log = () => {};
    process.exit = () => { throw stopped; };
    http.createServer = () => {
      const server = new EventEmitter();
      server.listen = () => {
        server.emit('error', Object.assign(new Error('address already in use'), { code: 'EADDRINUSE' }));
        return server;
      };
      return server;
    };
    try {
      await gmCommand('phone', '--port', '8123');
    } catch (err) {
      if (err !== stopped) throw err;
    }
    assert.ok(errors.some(line => /--port\s+8124\b/.test(line)), 'an occupied port should suggest the next port');
  } finally {
    http.createServer = createServer;
    console.error = error;
    console.log = log;
    process.exit = exit;
    process.exitCode = exitCode;
    process.chdir(cwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});
