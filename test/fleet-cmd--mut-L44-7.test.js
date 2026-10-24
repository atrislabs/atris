require('./helpers/clean-temp');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { EventEmitter } = require('node:events');

test('saved server takes precedence over the environment server', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-server-'));
  const cwd = process.cwd();
  const previous = { HOME: process.env.HOME, SWARLO_SERVER: process.env.SWARLO_SERVER };
  t.after(() => {
    process.chdir(cwd);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.HOME = root;
  process.env.SWARLO_SERVER = 'http://environment.invalid';
  process.chdir(root);
  const configDir = path.join(root, '.swarlo');
  fs.mkdirSync(configDir);
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
    server: 'http://saved.invalid', hub: 'test-hub',
  }));
  fs.writeFileSync(path.join(configDir, 'fleet-state.json'), JSON.stringify({
    api_key: 'test-key', hub_id: 'test-hub', member_id: 'test-member',
  }));
  const hosts = [];
  t.mock.method(http, 'request', (options, respond) => {
    hosts.push(options.hostname);
    const request = new EventEmitter();
    request.write = () => {};
    request.end = () => {
      const response = new EventEmitter();
      response.statusCode = 200;
      respond(response);
      response.emit('data', '{}');
      response.emit('end');
    };
    return request;
  });
  t.mock.method(console, 'log', () => {});
  t.mock.method(process, 'exit', (code) => { throw new Error(`unexpected exit: ${code}`); });
  const { fleet } = require('../commands/fleet');
  await fleet(['done', 'task:example', 'Completed repair.', '--global']);
  assert.equal(hosts[0], 'saved.invalid');
});
