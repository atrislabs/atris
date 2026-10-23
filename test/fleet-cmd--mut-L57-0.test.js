const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { EventEmitter } = require('node:events');

test('a plain HTTP hub uses the HTTP transport', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-transport-'));
  const env = { ...process.env };
  const cwd = process.cwd();
  const original = { http: http.request, https: https.request, log: console.log,
    error: console.error, exit: process.exit, exitCode: process.exitCode };
  const transports = [];
  function requestFor(protocol) {
    return (...args) => {
      transports.push(protocol);
      const callback = args.find((arg) => typeof arg === 'function');
      const req = new EventEmitter();
      req.write = () => {};
      req.setTimeout = () => req;
      req.destroy = () => {};
      req.end = () => {
        const res = new EventEmitter();
        res.statusCode = 200;
        res.setEncoding = () => {};
        callback(res);
        res.emit('data', JSON.stringify({ ok: true, members: [], claims: [] }));
        res.emit('end');
      };
      return req;
    };
  }
  try {
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.SWARLO_HUB_URL = 'http://localhost:8090';
    process.env.SWARLO_HUB = 'http://localhost:8090';
    process.chdir(home);
    http.request = requestFor('http:');
    https.request = requestFor('https:');
    console.log = () => {};
    console.error = () => {};
    process.exit = (code) => { throw new Error(`unexpected exit ${code}`); };
    const { fleet } = require('../commands/fleet');
    await fleet(['status', '--global', '--json']);
    assert.equal(transports[0], 'http:');
  } finally {
    http.request = original.http;
    https.request = original.https;
    console.log = original.log;
    console.error = original.error;
    process.exit = original.exit;
    process.exitCode = original.exitCode;
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
  }
});
