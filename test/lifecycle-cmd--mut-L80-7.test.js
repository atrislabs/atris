require('./helpers/clean-temp');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('sleep preserves the original business registration timestamp when refreshing saved details', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-registration-'));
  const previous = {
    env: { ...process.env }, cwd: process.cwd(), argv: process.argv,
    log: console.log, error: console.error, exit: process.exit,
  };
  let api;
  let request;
  try {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ATRIS_') || key === 'TERM_SESSION_ID') delete process.env[key];
    }
    process.env.HOME = root;
    process.chdir(root);
    process.argv = ['node', 'atris', 'sleep', 'sample-business'];
    console.log = () => {};
    console.error = () => {};
    process.exit = (code) => { throw new Error(`unexpected exit ${code}`); };

    const dir = path.join(root, '.atris');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify({ token: 'saved-test-token' }));
    const registered = '2001-02-03T04:05:06+00:00';
    const saved = path.join(dir, 'businesses.json');
    fs.writeFileSync(saved, JSON.stringify({
      'sample-business': { business_id: 'business-1', added_at: registered },
    }));

    api = require('../utils/api');
    request = api.apiRequestJson;
    api.apiRequestJson = async (route) => {
      if (route === '/business/') {
        return { ok: true, data: [{ id: 'business-1', slug: 'sample-business', name: 'Sample business' }] };
      }
      if (route === '/business/business-1/ai-computer/sleep') return { ok: true, data: {} };
      throw new Error(`unexpected request ${route}`);
    };
    const { sleepAtris } = require('../commands/lifecycle');
    await sleepAtris();

    assert.strictEqual(JSON.parse(fs.readFileSync(saved, 'utf8'))['sample-business'].added_at, registered);
  } finally {
    if (api) api.apiRequestJson = request;
    console.log = previous.log;
    console.error = previous.error;
    process.exit = previous.exit;
    process.argv = previous.argv;
    process.chdir(previous.cwd);
    for (const key of Object.keys(process.env)) {
      if (!(key in previous.env)) delete process.env[key];
    }
    Object.assign(process.env, previous.env);
  }
});
