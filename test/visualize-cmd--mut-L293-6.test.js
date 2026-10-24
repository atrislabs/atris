'use strict';
require('./helpers/clean-temp');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('image generation skips an inactive agent with an id', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'image-agent-filter-'));
  const env = { ...process.env };
  const cwd = process.cwd();
  const log = console.log;
  const exit = process.exit;
  const api = require('../utils/api');
  const request = api.apiRequestJson;
  const calls = [];
  const unavailable = new Error('image service unavailable');
  try {
    for (const key of Object.keys(process.env)) if (key.startsWith('ATRIS_')) delete process.env[key];
    process.env.HOME = root;
    process.chdir(root);
    fs.mkdirSync(path.join(root, '.atris'));
    fs.writeFileSync(path.join(root, '.atris', 'credentials.json'), JSON.stringify({ token: 'fixture-token' }));
    console.log = () => {};
    process.exit = code => { throw new Error(`unexpected exit ${code}`); };
    api.apiRequestJson = async (route, options) => {
      calls.push({ route, options });
      if (route === '/auth/validate') return { ok: true, data: { valid: true } };
      if (route === '/agent/my-agents') return { ok: true, data: { agents: [
        { id: 'retired-artist', status: 'inactive', name: 'Retired Artist' },
        { id: 'working-artist', status: 'active', name: 'Working Artist' },
      ] } };
      throw unavailable;
    };
    const { visualizeAtris } = require('../commands/visualize');
    try {
      await visualizeAtris(['a garden', '--out', path.join(root, 'garden.png')]);
    } catch (error) {
      if (error !== unavailable) throw error;
    }
    assert.strictEqual(calls.find(call => call.route.endsWith('/image/generate')).route.split('/')[2], 'working-artist');
  } finally {
    api.apiRequestJson = request;
    console.log = log;
    process.exit = exit;
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
  }
});
