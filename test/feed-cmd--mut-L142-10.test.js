'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('list uses the window following --since to select recent posts', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'feed-since-window-'));
  const originalEnv = { ...process.env };
  const originalCwd = process.cwd();
  const originalLog = console.log;
  const originalError = console.error;
  const originalExit = process.exit;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) delete process.env[key];
  }
  process.env.HOME = home;
  process.chdir(home);
  const logs = [];
  console.log = (...parts) => logs.push(parts.join(' '));
  console.error = () => {};
  process.exit = (code) => { throw new Error(`unexpected exit: ${code}`); };

  const api = require('../utils/api');
  const auth = require('../utils/auth');
  const originalRequest = api.apiRequestJson;
  const originalEnsure = auth.ensureValidCredentials;
  t.after(() => {
    api.apiRequestJson = originalRequest;
    auth.ensureValidCredentials = originalEnsure;
    console.log = originalLog;
    console.error = originalError;
    process.exit = originalExit;
    process.chdir(originalCwd);
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  fs.mkdirSync(path.join(home, '.atris'));
  fs.writeFileSync(path.join(home, '.atris', 'business.json'),
    JSON.stringify({ business_id: 'window-test' }));
  auth.ensureValidCredentials = async () => ({ credentials: { token: 'test-token' } });
  const now = Date.now();
  api.apiRequestJson = async (pathname) => {
    if (!pathname.startsWith('/business/window-test/feed?')) {
      throw new Error(`unexpected request: ${pathname}`);
    }
    return { status: 200, data: { posts: [
      { id: 'older', created_at: new Date(now - 72 * 3600000).toISOString() },
      { id: 'recent', created_at: new Date(now - 3600000).toISOString() },
    ] } };
  };
  const { feedCommand } = require('../commands/feed');
  await feedCommand(['list', '--since', '48h', '--json']);

  const posts = JSON.parse(logs.join('\n') || '[]');
  assert.strictEqual(posts[0]?.id, 'recent');
});
