const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { EventEmitter } = require('node:events');

test('watch displays a post newer than the last seen post', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-new-post-'));
  const saved = {
    home: process.env.HOME, cwd: process.cwd(), log: console.log,
    exit: process.exit, exitCode: process.exitCode,
    request: http.request, interval: global.setInterval,
  };
  const output = [];
  let poll;
  const previous = {
    post_id: 'previous', created_at: '2024-01-01T12:00:00Z',
    member_name: 'reader', kind: 'message', content: 'earlier update',
  };
  const latest = {
    post_id: 'latest', created_at: '2024-01-02T12:00:00Z',
    member_name: 'writer', kind: 'message', content: 'fresh-board-update',
  };
  let board = [previous];
  try {
    process.env.HOME = home;
    process.chdir(home);
    console.log = (...args) => output.push(args.join(' '));
    process.exit = (code) => { throw new Error(`unexpected exit ${code}`); };
    global.setInterval = (callback) => { poll = callback; return {}; };
    http.request = (options, callback) => {
      const request = new EventEmitter();
      request.write = () => {};
      request.setTimeout = () => request;
      request.end = () => {
        const response = new EventEmitter();
        response.statusCode = 200;
        callback(response);
        const data = options.path.includes('/posts')
          ? { posts: board }
          : { member_id: 'reader', token: 'test-token', access_token: 'test-token' };
        response.emit('data', JSON.stringify(data));
        response.emit('end');
      };
      return request;
    };
    const { fleet } = require('../commands/fleet');
    const watching = fleet(['watch', '--global']);
    watching.catch(() => {});
    await new Promise(resolve => setImmediate(resolve));
    board = [latest, previous];
    await poll();
    assert.equal(output.some(line => line.includes('fresh-board-update')), true);
  } finally {
    console.log = saved.log;
    process.exit = saved.exit;
    process.exitCode = saved.exitCode;
    http.request = saved.request;
    global.setInterval = saved.interval;
    process.chdir(saved.cwd);
    if (saved.home === undefined) delete process.env.HOME;
    else process.env.HOME = saved.home;
  }
});
