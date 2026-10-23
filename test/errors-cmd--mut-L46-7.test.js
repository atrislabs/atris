const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const api = require('../utils/api');

test('account flag selects account scope', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-test-'));
  const origEnv = { ...process.env };
  const origArgv = process.argv;
  const origLog = console.log;
  const origApiRequestJson = api.apiRequestJson;
  const origCwd = process.cwd();

  const logs = [];

  t.after(() => {
    console.log = origLog;
    api.apiRequestJson = origApiRequestJson;
    process.argv = origArgv;
    process.chdir(origCwd);
    for (const key of Object.keys(process.env)) {
      if (!(key in origEnv)) delete process.env[key];
    }
    Object.assign(process.env, origEnv);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const configDir = path.join(tmpDir, '.atris');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'credentials.json'),
    JSON.stringify({ token: 'mock-token' })
  );

  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) delete process.env[key];
  }
  process.env.HOME = tmpDir;
  process.chdir(tmpDir);
  process.argv = [process.execPath, 'cli', 'cmd', '--account', '--json'];

  console.log = (...args) => logs.push(args.join(' '));

  api.apiRequestJson = async () => ({
    ok: true,
    events: [],
  });

  const [run] = Object.values(require('../commands/errors'));
  await run();

  const result = JSON.parse(logs[0]);
  assert.strictEqual(result.scope, 'account');
});
