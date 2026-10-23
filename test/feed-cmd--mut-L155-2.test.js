'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('feedCommand includes a post exactly one day old with --since 1d', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'feed-cutoff-'));
  const originalHome = process.env.HOME;
  const originalCwd = process.cwd();
  const originalNow = Date.now;
  const originalLog = console.log;
  const originalError = console.error;
  const originalExit = process.exit;
  process.env.HOME = home;
  process.chdir(home);

  const api = require('../utils/api');
  const auth = require('../utils/auth');
  const originalRequest = api.apiRequestJson;
  const originalCredentials = auth.ensureValidCredentials;
  t.after(() => {
    api.apiRequestJson = originalRequest;
    auth.ensureValidCredentials = originalCredentials;
    Date.now = originalNow;
    console.log = originalLog;
    console.error = originalError;
    process.exit = originalExit;
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  fs.mkdirSync(path.join(home, '.atris'));
  fs.writeFileSync(path.join(home, '.atris', 'business.json'),
    JSON.stringify({ business_id: 'cutoff-business', name: 'Cutoff' }));
  Date.now = () => Date.parse('2026-04-13T12:00:00Z');
  auth.ensureValidCredentials = async () => ({ credentials: { token: 'test-token' } });
  api.apiRequestJson = async () => ({
    status: 200,
    data: { posts: [{
      id: 'at-cutoff',
      content: 'cutoff-post-marker',
      created_at: '2026-04-12T12:00:00Z',
      author_display_name: 'Writer',
    }] },
  });
  const { feedCommand } = require('../commands/feed');
  const logs = [];
  console.log = (...args) => logs.push(args.join(' '));
  console.error = (...args) => logs.push(args.join(' '));
  process.exit = (code) => { throw new Error(`unexpected exit: ${code}`); };

  await feedCommand(['list', '--since', '1d', '--json']);

  assert.ok(logs.join('\n').includes('cutoff-post-marker'));
});
