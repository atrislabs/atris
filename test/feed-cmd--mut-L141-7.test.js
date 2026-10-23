'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('list --author keeps the named author and excludes other authors', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'feed-author-filter-'));
  const originalHome = process.env.HOME;
  const originalCwd = process.cwd();
  const originalLog = console.log;
  const originalError = console.error;
  const originalExit = process.exit;
  process.env.HOME = home;
  process.chdir(home);
  t.after(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    console.log = originalLog;
    console.error = originalError;
    process.exit = originalExit;
  });

  fs.mkdirSync(path.join(home, '.atris'));
  fs.writeFileSync(path.join(home, '.atris', 'business.json'), JSON.stringify({
    business_id: 'author-filter-business', name: 'Author Filter',
  }));

  const api = require('../utils/api');
  const auth = require('../utils/auth');
  const originalRequest = api.apiRequestJson;
  const originalCredentials = auth.ensureValidCredentials;
  t.after(() => {
    api.apiRequestJson = originalRequest;
    auth.ensureValidCredentials = originalCredentials;
  });
  auth.ensureValidCredentials = async () => ({
    credentials: { token: 'test-token', user_id: 'reader', email: 'reader@example.com' },
  });
  api.apiRequestJson = async () => ({
    status: 200,
    data: { posts: [
      { id: 'alice-post', author_display_name: 'Alice', content: 'Alice update', created_at: '2025-01-01T12:00:00Z' },
      { id: 'bob-post', author_display_name: 'Bob', content: 'Bob update', created_at: '2025-01-01T12:00:00Z' },
    ] },
  });
  const logs = [];
  console.log = (...args) => logs.push(args.map(String).join(' '));
  console.error = () => {};
  process.exit = (code) => { throw new Error(`unexpected exit: ${code}`); };
  const { feedCommand } = require('../commands/feed');

  assert.equal(await feedCommand(['list', '--author', 'ALICE', '--json']), 0);
  const posts = JSON.parse(logs.join('\n'));
  assert.ok(posts.some((post) => post.id === 'alice-post'), 'the requested author remains visible');
  assert.ok(!posts.some((post) => post.id === 'bob-post'), 'another author must be filtered out');
});
