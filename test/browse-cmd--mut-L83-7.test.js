require('./helpers/clean-temp');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('browse displays the name of a returned workspace template', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-template-name-'));
  const savedEnv = { ...process.env };
  const savedArgv = process.argv;
  const savedCwd = process.cwd();
  const logs = [];
  try {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ATRIS_')) delete process.env[key];
    }
    process.env.HOME = home;
    process.env.TERM_SESSION_ID = 'template-name-test';
    process.chdir(home);
    process.argv = [process.execPath, 'atris', 'browse'];
    fs.mkdirSync(path.join(home, '.atris'));
    fs.writeFileSync(path.join(home, '.atris', 'credentials.json'),
      JSON.stringify({ token: 'test-login-token' }));
    const api = require('../utils/api');
    t.mock.method(api, 'apiRequestJson', async () => ({
      ok: true,
      status: 200,
      data: [{ name: 'Orchard Planner', slug: 'orchard-planner' }],
    }));
    t.mock.method(console, 'log', (...values) => logs.push(values.join(' ')));
    t.mock.method(process, 'exit', code => {
      throw new Error(`unexpected exit: ${code}`);
    });
    const { browseAtris } = require('../commands/browse');
    await browseAtris();
    assert.match(logs.join('\n'), /\bOrchard Planner\b/);
  } finally {
    t.mock.restoreAll();
    process.chdir(savedCwd);
    process.argv = savedArgv;
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
  }
});
