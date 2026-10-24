require('./helpers/clean-temp');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const api = require('../utils/api');

test('sleep saves the canonical slug when a business is selected by name', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-canonical-wake-'));
  const previous = { env: { ...process.env }, cwd: process.cwd(), argv: process.argv,
    log: console.log, error: console.error, exit: process.exit, request: api.apiRequestJson };
  const lines = [];
  const stopped = new Error('exit');
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    process.env.HOME = root;
    process.chdir(root);
    fs.mkdirSync(path.join(root, '.atris'));
    fs.writeFileSync(path.join(root, '.atris', 'credentials.json'), JSON.stringify({ token: 'test-token' }));
    api.apiRequestJson = async (endpoint, options) => {
      if (endpoint === '/business/') return { ok: true, status: 200,
        data: [{ id: 'biz-1', workspace_id: 'ws-1', slug: 'acme-studio', name: 'Acme' }] };
      return { ok: true, status: 200, data: {} };
    };
    const { sleepAtris } = require('../commands/lifecycle');
    process.argv = ['node', 'atris', 'sleep', 'Acme'];
    console.log = (...values) => lines.push(values.join(' '));
    console.error = (...values) => lines.push(values.join(' '));
    process.exit = () => { throw stopped; };
    try { await sleepAtris(); } catch (error) { if (error !== stopped) throw error; }
    const saved = JSON.parse(fs.readFileSync(path.join(root, '.atris', 'businesses.json'), 'utf8'));
    assert.equal(saved.Acme.slug, 'acme-studio');
  } finally {
    api.apiRequestJson = previous.request;
    console.log = previous.log;
    console.error = previous.error;
    process.exit = previous.exit;
    process.argv = previous.argv;
    process.chdir(previous.cwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previous.env);
  }
});
