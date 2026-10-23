const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const api = require('../utils/api');

test('displays template fork count when numeric', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-temp-'));
  const savedEnv = { ...process.env };
  const savedArgv = process.argv;
  const origLog = console.log;
  const origExit = process.exit;
  const origApiRequestJson = api.apiRequestJson;

  const logs = [];

  try {
    const atrisDir = path.join(home, '.atris');
    fs.mkdirSync(atrisDir, { recursive: true });
    fs.writeFileSync(
      path.join(atrisDir, 'credentials.json'),
      JSON.stringify({ token: 'test-token' })
    );

    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ATRIS_')) delete process.env[key];
    }
    process.env.HOME = home;
    process.argv = [process.execPath, 'cli'];

    console.log = (...values) => logs.push(values.join(' '));
    process.exit = (code) => {
      throw new Error(`exit ${code}`);
    };

    api.apiRequestJson = async () => ({
      ok: true,
      data: [{ name: 'demo', fork_count: 7 }],
    });

    const [run] = Object.values(require('../commands/browse'));
    await run();

    assert.ok(logs.some((line) => line.includes('7 forks')));
  } finally {
    console.log = origLog;
    process.exit = origExit;
    api.apiRequestJson = origApiRequestJson;
    process.argv = savedArgv;
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
    if (!process.env.HOME && savedEnv.HOME) {
      process.env.HOME = savedEnv.HOME;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
});
