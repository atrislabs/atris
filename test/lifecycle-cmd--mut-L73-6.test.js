const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('sleep falls back to the requested slug when the business list has no match', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-sleep-lookup-'));
  const savedEnv = { ...process.env };
  const previous = { cwd: process.cwd(), argv: process.argv, log: console.log, error: console.error, exit: process.exit };
  const api = require('../utils/api');
  const request = api.apiRequestJson;
  const lines = [];
  const calls = [];
  const stopped = new Error('captured exit');
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    process.env.HOME = root;
    process.chdir(root);
    fs.mkdirSync(path.join(root, '.atris'));
    fs.writeFileSync(path.join(root, '.atris', 'credentials.json'), JSON.stringify({ token: 'test-token' }));
    api.apiRequestJson = async (endpoint, options) => {
      calls.push({ endpoint, options });
      if (endpoint === '/business/' && options.method === 'GET') {
        return { ok: true, status: 200, data: [{ id: 'other-id', slug: 'other-workspace', name: 'Other workspace' }] };
      }
      if (endpoint === '/workspace/missing-workspace/sleep' && options.method === 'POST') {
        return { ok: true, status: 200, data: {} };
      }
      throw new Error(`unexpected request: ${endpoint}`);
    };
    const { sleepAtris } = require('../commands/lifecycle');
    process.argv = ['node', 'atris', 'sleep', 'missing-workspace'];
    console.log = console.error = (...values) => lines.push(values.join(' '));
    process.exit = () => { throw stopped; };
    try { await sleepAtris(); } catch (error) { if (error !== stopped) throw error; }
    assert.ok(calls.some(({ endpoint, options }) =>
      endpoint === '/workspace/missing-workspace/sleep' && options.method === 'POST'),
    'sleep must still target the requested slug when no business matches');
    assert.ok(lines.some(line => line.includes("'missing-workspace' is now sleeping")),
      'the user should receive confirmation that the requested workspace is sleeping');
  } finally {
    api.apiRequestJson = request;
    console.log = previous.log;
    console.error = previous.error;
    process.exit = previous.exit;
    process.argv = previous.argv;
    process.chdir(previous.cwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  }
});
