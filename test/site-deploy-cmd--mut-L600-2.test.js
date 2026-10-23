'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../commands/site-deploy');

test('fullstack deploy rejects multiple choices during service lookup', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-upload-status-'));
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  });
  fs.writeFileSync(path.join(home, 'package.json'), JSON.stringify({ scripts: { start: 'node server.js' } }));
  const errors = [];

  const code = await run([home, '--fullstack', '--name', 'upload-choices', '--yes'], {
    homedir: () => home,
    renderApiKey: 'test-render-key',
    spawnSync: () => ({ status: 0, stdout: '', stderr: '' }),
    sleep: async () => {},
    loadCredentials: () => ({ token: 'test-token' }),
    log: () => {},
    error: (line) => errors.push(line),
    httpRequest: async (url, options) => {
      let status = 200;
      let data = {};
      if (url.includes('/services?name=')) {
        status = 300;
        data = [{ service: { id: 'srv-app', name: 'atris-app-upload-choices', serviceDetails: { url: 'https://example.onrender.com' } } }];
      } else if (url.includes('/deploys')) {
        data = [{ deploy: { id: 'dep-app', status: 'live' } }];
      } else if (url.includes('/services/')) {
        data = { id: 'srv-app', ownerId: 'tea-test' };
      }
      return { status, body: Buffer.from(JSON.stringify(data)) };
    },
  });

  assert.strictEqual(code, 1);
  assert.match(errors.join('\n'), /\b300\b/);
});
