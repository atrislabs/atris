const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('sleep resolves a connected workspace by its cached name when the service is unavailable', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-sleep-lookup-'));
  const previous = { cwd: process.cwd(), env: { ...process.env }, argv: process.argv,
    log: console.log, error: console.error, exit: process.exit };
  const api = require('../utils/api');
  const request = api.apiRequestJson;
  const calls = [];
  const stopped = new Error('captured exit');
  try {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ATRIS_') || key === 'TERM_SESSION_ID') delete process.env[key];
    }
    process.env.HOME = root;
    process.chdir(root);
    fs.mkdirSync(path.join(root, '.atris'));
    fs.writeFileSync(path.join(root, '.atris', 'credentials.json'), JSON.stringify({
      token: 'saved-login-token', refresh_token: null, email: 'test@example.com',
      user_id: 'user-1', provider: null, saved_at: '2025-01-01T00:00:00.000Z'
    }));
    fs.writeFileSync(path.join(root, '.atris', 'businesses.json'), JSON.stringify({
      'example-co': { business_id: 'biz-1', slug: 'example-co', name: 'Example Co',
        added_at: '2025-01-01T00:00:00.000Z' }
    }));
    api.apiRequestJson = async (endpoint, options) => {
      calls.push({ endpoint, options });
      return endpoint === '/business/'
        ? { ok: false, status: 503, data: null, error: 'service unavailable' }
        : { ok: true, status: 200, data: { status: 'sleeping' } };
    };
    const { sleepAtris } = require('../commands/lifecycle');
    process.argv = ['node', 'atris', 'sleep', 'Example Co'];
    console.log = (...values) => {};
    console.error = (...values) => {};
    process.exit = () => { throw stopped; };
    try { await sleepAtris(); } catch (error) { if (error !== stopped) throw error; }
    assert.equal(calls.find(({ endpoint }) => endpoint.endsWith('/sleep'))?.endpoint, '/business/biz-1/ai-computer/sleep');
  } finally {
    api.apiRequestJson = request;
    console.log = previous.log;
    console.error = previous.error;
    process.exit = previous.exit;
    process.argv = previous.argv;
    process.chdir(previous.cwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previous.env);
  }
});
