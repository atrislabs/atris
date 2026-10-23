const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('sleep resolves a saved business by its canonical slug under an alias key', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-business-lookup-'));
  const previous = {
    env: { ...process.env }, cwd: process.cwd(), argv: process.argv,
    log: console.log, error: console.error, exit: process.exit,
  };
  const api = require('../utils/api');
  const originalRequest = api.apiRequestJson;
  const cachedModules = new Set(Object.keys(require.cache));
  const requests = [];
  const stopped = new Error('captured exit');
  try {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ATRIS_') || key === 'TERM_SESSION_ID') delete process.env[key];
    }
    process.env.HOME = root;
    process.chdir(root);
    fs.mkdirSync(path.join(root, '.atris'));
    fs.writeFileSync(path.join(root, '.atris', 'credentials.json'), JSON.stringify({
      token: 'test-token', provider: 'test', saved_at: '2025-01-01T00:00:00.000Z',
    }));
    fs.writeFileSync(path.join(root, '.atris', 'businesses.json'), JSON.stringify({
      'old-name': {
        business_id: 'biz-acme', name: 'Acme', slug: 'acme',
        added_at: '2025-01-01T00:00:00.000Z',
      },
    }));
    api.apiRequestJson = async (route) => {
      requests.push(route);
      return { ok: true, data: [] };
    };
    console.log = () => {};
    console.error = () => {};
    process.exit = () => { throw stopped; };
    process.argv = ['node', 'atris', 'sleep', 'acme'];
    const { sleepAtris } = require('../commands/lifecycle');
    try {
      await sleepAtris();
    } catch (error) {
      if (error !== stopped) throw error;
    }
    assert.equal(requests.includes('/business/biz-acme/ai-computer/sleep'), true);
  } finally {
    api.apiRequestJson = originalRequest;
    for (const key of Object.keys(require.cache)) {
      if (!cachedModules.has(key)) delete require.cache[key];
    }
    console.log = previous.log;
    console.error = previous.error;
    process.exit = previous.exit;
    process.argv = previous.argv;
    process.chdir(previous.cwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previous.env);
  }
});
