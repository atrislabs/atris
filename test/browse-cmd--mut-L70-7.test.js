const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('browse prints returned templates when the API responds ok', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-browse-mut-'));
  const savedEnv = { ...process.env };
  const savedArgv = process.argv;
  const logs = [];
  const errors = [];
  const exit = new Error('intercepted process exit');
  let exitCode;
  const api = require('../utils/api');
  const auth = require('../utils/auth');
  const realApiRequestJson = api.apiRequestJson;
  const realLoadCredentials = auth.loadCredentials;
  try {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ATRIS_')) delete process.env[key];
    }
    process.env.HOME = home;
    process.argv = [process.execPath, 'atris', 'browse'];
    api.apiRequestJson = async () => ({
      ok: true,
      data: [
        {
          name: 'crm-starter',
          description: 'CRM workspace',
          agent_count: 3,
          fork_count: 12,
          author: 'atris',
        },
      ],
    });
    auth.loadCredentials = () => ({ token: 'test-token' });
    t.mock.method(console, 'log', (...values) => logs.push(values.join(' ')));
    t.mock.method(console, 'error', (...values) => errors.push(values.join(' ')));
    t.mock.method(process, 'exit', code => {
      exitCode = code;
      throw exit;
    });
    const { browseAtris } = require('../commands/browse');
    await browseAtris();
    assert.strictEqual(exitCode, undefined);
    assert.deepStrictEqual(logs, [
      '',
      'Browsing workspace templates...',
      '',
      '  1 template found:',
      '',
      '  crm-starter',
      '    CRM workspace',
      '    3 agents  |  12 forks  |  atris',
      '',
      '  Fork any template with: atris fork <name>',
      '',
    ]);
    assert.deepStrictEqual(errors, []);
  } finally {
    api.apiRequestJson = realApiRequestJson;
    auth.loadCredentials = realLoadCredentials;
    t.mock.restoreAll();
    process.argv = savedArgv;
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
    fs.rmSync(home, { recursive: true, force: true });
  }
});
