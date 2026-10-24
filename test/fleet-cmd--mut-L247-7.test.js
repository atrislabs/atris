const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { EventEmitter } = require('node:events');

test('fleet done posts the supplied result or the exact default completion message', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-done-content-'));
  const previousCwd = process.cwd();
  t.after(() => {
    process.chdir(previousCwd);
    fs.rmSync(root, { recursive: true, force: true });
  });
  process.chdir(root);
  t.mock.method(os, 'homedir', () => root);
  const configDir = path.join(root, '.swarlo');
  fs.mkdirSync(configDir);
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
    server: 'http://fleet.invalid', hub: 'test-hub',
  }));
  fs.writeFileSync(path.join(configDir, 'fleet-state.json'), JSON.stringify({
    api_key: 'test-key', hub_id: 'test-hub', member_id: 'test-member',
  }));

  const posts = [];
  // Exercise serialization through the public command without opening a socket.
  t.mock.method(http, 'request', (options, respond) => {
    const req = new EventEmitter();
    let body = '';
    req.write = (chunk) => { body += chunk; };
    req.end = () => {
      if (options.method === 'POST') {
        assert.equal(options.path, '/api/test-hub/channels/general/posts');
        posts.push(JSON.parse(body));
      } else {
        assert.equal(options.method, 'GET');
        assert.ok(['/api/health', '/api/test-hub/members'].includes(options.path));
      }
      const response = new EventEmitter();
      response.statusCode = 200;
      respond(response);
      response.emit('data', '{}');
      response.emit('end');
    };
    return req;
  });
  t.mock.method(console, 'log', () => {});

  const { fleet } = require('../commands/fleet');
  await fleet(['done', 'task:example', 'Completed the requested repair.', '--global']);
  await fleet(['done', 'task:example', '--global']);

  assert.deepEqual(posts, [
    { content: 'Completed the requested repair.', kind: 'result', task_key: 'task:example' },
    { content: 'Done: task:example', kind: 'result', task_key: 'task:example' },
  ]);
});
