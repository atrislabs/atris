require('./helpers/clean-temp');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('sleep selects the business with the requested slug', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-slug-'));
  const previous = { env: { ...process.env }, cwd: process.cwd(), argv: process.argv, log: console.log, error: console.error, exit: process.exit };
  const api = require('../utils/api');
  const request = api.apiRequestJson;
  const calls = [];
  const stopped = new Error('exit');
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    process.env.HOME = root;
    process.chdir(root);
    fs.mkdirSync(path.join(root, '.atris'));
    fs.writeFileSync(path.join(root, '.atris', 'credentials.json'), JSON.stringify({ token: 'test-token', provider: null }));
    fs.writeFileSync(path.join(root, '.atris', 'businesses.json'), JSON.stringify({
      other: { business_id: 'other-id', slug: 'other', name: 'Other' },
      alias: { business_id: 'chosen-id', slug: 'chosen', name: 'Chosen workspace' },
    }));
    api.apiRequestJson = async (endpoint, options) => {
      calls.push({ endpoint, options });
      if (endpoint === '/business/') {
        return { ok: true, status: 200, data: [] };
      }
      return { ok: true, status: 200, data: {} };
    };
    const { sleepAtris } = require('../commands/lifecycle');
    process.argv = ['node', 'atris', 'sleep', 'CHOSEN'];
    console.log = () => {};
    console.error = () => {};
    process.exit = () => { throw stopped; };
    try { await sleepAtris(); } catch (error) { if (error !== stopped) throw error; }
    assert.strictEqual(calls.find(call => call.options.method === 'POST')?.endpoint,
      '/business/chosen-id/ai-computer/sleep');
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
