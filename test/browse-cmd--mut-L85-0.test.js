require('./helpers/clean-temp');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('template listing includes its numeric agent count', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-browse-count-'));
  const env = { ...process.env };
  const argv = process.argv;
  const cwd = process.cwd();
  const logs = [];
  const exit = new Error('intercepted exit');
  try {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ATRIS_')) delete process.env[key];
    }
    process.env.HOME = home;
    process.env.TERM_SESSION_ID = 'browse-count-test';
    process.chdir(home);
    process.argv = [process.execPath, 'atris', 'browse'];
    const auth = require('../utils/auth');
    auth.saveCredentials('browse-test-token', null, null, null, null);
    const api = require('../utils/api');
    t.mock.method(api, 'apiRequestJson', async () => ({
      ok: true, status: 200,
      data: [{ name: 'Support desk', slug: 'support-desk', description: 'Customer support workspace', agent_count: 3 }],
    }));
    t.mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
    t.mock.method(process, 'exit', () => { throw exit; });
    const { browseAtris } = require('../commands/browse');
    try { await browseAtris(); } catch (error) { if (error !== exit) throw error; }
    assert.ok(logs.some(line => /\b3\s+agents\b/.test(line)));
  } finally {
    t.mock.restoreAll();
    process.argv = argv;
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) {
      if (!(key in env)) delete process.env[key];
    }
    Object.assign(process.env, env);
  }
});
