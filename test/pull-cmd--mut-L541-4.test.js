require('./helpers/clean-temp');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('keep-local pull accepts an empty cloud workspace when local content is empty', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-empty-pull-'));
  const cwd = process.cwd();
  const env = { ...process.env };
  const argv = process.argv;
  const exit = process.exit;
  const log = console.log;
  let outcome;
  const stopped = new Error('command stopped');
  const api = require('../utils/api');
  const request = api.apiRequestJson;
  try {
    process.env.HOME = root;
    process.env.ATRIS_HOME = root;
    process.chdir(root);
    fs.mkdirSync(path.join(root, 'example-co', 'atris'), { recursive: true });
    process.argv = ['node', 'atris', 'pull', 'example-co', '--keep-local'];
    process.exit = () => { throw stopped; };
    console.log = () => {};
    const auth = require('../utils/auth');
    auth.saveCredentials('test-token', null, 'person@example.com', 'person', 'google');
    api.apiRequestJson = async (route, options) => {
      if (route === '/atris-sync/telemetry') {
        outcome = options.body.outcome;
        return { ok: true, data: {} };
      }
      if (route === '/business/') return { ok: true, data: [{ id: 'business-one', workspace_id: 'ws-one', slug: 'example-co', name: 'Example' }] };
      if (route.includes('validate')) return { ok: true, data: { valid: true, user: { id: 'person', email: 'person@example.com', provider: 'google' } } };
      if (route.endsWith('/snapshot?include_content=true')) return { ok: true, data: { files: [] } };
      if (route.endsWith('/git/head')) return { ok: true, data: { head: null } };
      throw new Error(`unexpected API route: ${route}`);
    };
    const { pullAtris } = require('../commands/pull');
    try {
      await pullAtris();
    } catch (error) {
      if (error !== stopped) throw error;
    }
    assert.equal(outcome, 'success');
  } finally {
    console.log = log;
    api.apiRequestJson = request;
    process.exit = exit;
    process.argv = argv;
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
  }
});
