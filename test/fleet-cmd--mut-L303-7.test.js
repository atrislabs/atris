const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { EventEmitter } = require('node:events');

test('watch prints posts arriving after the previously seen post', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-board-watch-'));
  const original = {
    home: process.env.HOME, cwd: process.cwd(), request: http.request,
    log: console.log, exit: process.exit,
    setInterval: global.setInterval, clearInterval: global.clearInterval,
  };
  const listeners = process.listeners('SIGINT');
  const output = [];
  const oldPost = {
    post_id: 'post-old', created_at: '2024-01-01T12:00:00Z',
    member_name: 'builder', kind: 'message', content: 'initial-update',
  };
  const newPost = {
    ...oldPost, post_id: 'post-new', created_at: '2024-01-01T13:00:00Z',
    content: 'arriving-update',
  };
  let boardReads = 0;
  try {
    process.env.HOME = home;
    process.chdir(home);
    fs.mkdirSync(path.join(home, '.swarlo'));
    fs.writeFileSync(path.join(home, '.swarlo', 'fleet-state.json'), JSON.stringify({
      api_key: 'test-key', hub_id: 'atris', member_id: 'reader',
      hub_url: 'http://localhost:8090',
    }));
    fs.writeFileSync(path.join(home, '.swarlo', 'config.json'), JSON.stringify({
      server: 'http://localhost:8090', hub: 'atris',
    }));
    http.request = (options, callback) => {
      const req = new EventEmitter();
      req.end = () => queueMicrotask(() => {
        const res = new EventEmitter();
        res.statusCode = 200;
        callback(res);
        let body = {};
        if (options.path.endsWith('/members')) body = { members: [], count: 0 };
        else if (options.path.includes('/posts?')) {
          body = { posts: boardReads++ === 0 ? [oldPost] : [newPost, oldPost] };
        } else if (options.path !== '/api/health') throw new Error('unexpected request');
        res.emit('data', JSON.stringify(body));
        res.emit('end');
      });
      return req;
    };
    console.log = (...args) => output.push(args.join(' '));
    process.exit = () => { throw new Error('unexpected exit'); };
    global.setInterval = (poll) => {
      queueMicrotask(async () => {
        await poll();
        process.emit('SIGINT');
      });
      return Symbol('manual interval');
    };
    global.clearInterval = () => {};
    const { fleet } = require('../commands/fleet');
    await fleet(['watch', '--global']);
    assert.equal(output.some(line => line.includes('arriving-update')), true);
  } finally {
    for (const listener of process.listeners('SIGINT')) {
      if (!listeners.includes(listener)) process.removeListener('SIGINT', listener);
    }
    http.request = original.request;
    console.log = original.log;
    process.exit = original.exit;
    global.setInterval = original.setInterval;
    global.clearInterval = original.clearInterval;
    process.chdir(original.cwd);
    if (original.home === undefined) delete process.env.HOME;
    else process.env.HOME = original.home;
  }
});
