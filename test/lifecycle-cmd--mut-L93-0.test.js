const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('sleep resolves a cached workspace by its canonical slug when listing is unavailable', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-canonical-sleep-'));
  const previous = { cwd: process.cwd(), env: { ...process.env }, argv: process.argv,
    log: console.log, error: console.error, exit: process.exit };
  const api = require('../utils/api');
  const request = api.apiRequestJson;
  const calls = [];
  const lines = [];
  const stopped = new Error('captured exit');
  try {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ATRIS_') || key === 'TERM_SESSION_ID') delete process.env[key];
    }
    process.env.HOME = root;
    process.chdir(root);
    fs.mkdirSync(path.join(root, '.atris'));
    fs.writeFileSync(path.join(root, '.atris', 'credentials.json'), JSON.stringify({
      token: 'test-token', provider: 'test', saved_at: '2026-01-01T12:00:00Z',
    }));
    fs.writeFileSync(path.join(root, '.atris', 'businesses.json'), JSON.stringify({
      studio: { business_id: 'biz-studio', name: 'Studio', slug: 'studio', canonical_slug: 'studio', added_at: '2026-01-01T12:00:00Z' },
      'old-acme': { business_id: 'biz-acme', name: 'Acme Co', slug: 'old-acme', canonical_slug: 'acme', added_at: '2026-01-01T12:00:00Z' },
    }));
    api.apiRequestJson = async (endpoint) => {
      calls.push(endpoint);
      if (endpoint === '/business/') {
        return { ok: false, status: 503, error: 'service unavailable' };
      }
      return { ok: true, status: 200, data: { sleeping: true } };
    };
    console.log = console.error = (...values) => lines.push(values.join(' '));
    process.exit = () => { throw stopped; };
    process.argv = ['node', 'atris', 'sleep', 'acme'];
    const { sleepAtris } = require('../commands/lifecycle');
    try { await sleepAtris(); } catch (error) { if (error !== stopped) throw error; }
    assert.strictEqual(calls.find(endpoint => endpoint.endsWith('/ai-computer/sleep')), '/business/biz-acme/ai-computer/sleep');
  } finally {
    api.apiRequestJson = request;
    console.log = previous.log;
    console.error = previous.error;
    process.exit = previous.exit;
    process.argv = previous.argv;
    process.chdir(previous.cwd);
    for (const key of Object.keys(process.env)) if (!(key in previous.env)) delete process.env[key];
    Object.assign(process.env, previous.env);
  }
});
