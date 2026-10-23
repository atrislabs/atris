const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { EventEmitter } = require('node:events');

test('fleet reports registration status 300 as a failure', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-register-300-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // Isolate both configuration and the state path captured at module load.
  t.mock.method(os, 'homedir', () => root);
  t.mock.method(process, 'cwd', () => root);
  fs.mkdirSync(path.join(root, '.swarlo'));
  fs.writeFileSync(path.join(root, '.swarlo', 'config.json'), JSON.stringify({
    server: 'http://fleet.invalid', hub: 'test-hub',
  }));

  const errors = [];
  const output = [];
  const calls = [];
  const exit = new Error('intercepted process exit');
  t.mock.method(console, 'error', (...args) => errors.push(args));
  t.mock.method(console, 'log', (...args) => output.push(args));
  t.mock.method(process, 'exit', (code) => {
    assert.equal(code, 1);
    throw exit;
  });
  t.mock.method(https, 'request', () => { throw new Error('unexpected HTTPS request'); });
  t.mock.method(http, 'request', (options, callback) => {
    calls.push([options.method, options.path]);
    const req = new EventEmitter();
    req.write = () => {};
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = options.path === '/api/register' ? 300 : 200;
      callback(res);
      res.emit('data', JSON.stringify(options.path === '/api/register'
        ? 'registration requires a different endpoint' : {}));
      res.emit('end');
    };
    return req;
  });

  const { fleet } = require('../commands/fleet');
  let failure;
  try {
    await fleet(['post', 'hello', '--global']);
  } catch (error) {
    failure = error;
  }
  assert.deepEqual(errors, [
    ['✗ Failed to register:', 'registration requires a different endpoint'],
  ]);
  assert.equal(failure, exit);
  assert.deepEqual(output, []);
  assert.deepEqual(calls, [
    ['GET', '/api/health'],
    ['POST', '/api/register'],
  ]);
  assert.equal(fs.existsSync(path.join(root, '.swarlo', 'fleet-state.json')), false);
});
