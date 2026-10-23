const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const api = require('../utils/api');
const origApiRequestJson = api.apiRequestJson;
api.apiRequestJson = async () => ({ ok: false, error: 'Token expired' });

const { logSyncAtris: run } = require('../commands/log-sync');

test('auth failure detail is preserved when no enotfound', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'test-runner-'));

  const origHome = process.env.HOME;
  const origCwd = process.cwd();
  const origLog = console.log;
  const origArgv4 = process.argv[4];

  process.env.HOME = root;
  process.chdir(root);
  process.argv[4] = '--date=2024-03-15';
  console.log = () => {};

  fs.mkdirSync(path.join(root, '.atris'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.atris', 'credentials.json'),
    JSON.stringify({ token: 'mock-token' })
  );

  fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'atris', '.config'),
    JSON.stringify({ agent_id: 'test-agent' })
  );

  t.after(() => {
    api.apiRequestJson = origApiRequestJson;
    console.log = origLog;
    process.chdir(origCwd);
    if (origHome) {
      process.env.HOME = origHome;
    } else {
      process.env.HOME = os.tmpdir();
    }
    if (origArgv4 === undefined) {
      delete process.argv[4];
    } else {
      process.argv[4] = origArgv4;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  await assert.rejects(
    () => run(),
    /Token expired/
  );
});
