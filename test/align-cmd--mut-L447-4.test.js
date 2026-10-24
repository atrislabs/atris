const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const api = require('../utils/api');

test('hard force push succeeds when batches have no errors', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-test-'));
  const savedEnv = { ...process.env };
  const savedArgv = process.argv;
  const savedCwd = process.cwd();
  const origLog = console.log;
  const origExit = process.exit;
  const origApiRequestJson = api.apiRequestJson;

  const logs = [];
  let exitCode = null;

  try {
    const bizDir = path.join(home, 'my-proj');
    const atrisDir = path.join(bizDir, '.atris');
    fs.mkdirSync(atrisDir, { recursive: true });
    fs.writeFileSync(
      path.join(atrisDir, 'business.json'),
      JSON.stringify({ slug: 'my-proj' })
    );

    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ATRIS_')) delete process.env[key];
    }
    process.env.HOME = home;
    process.env.ATRIS_TOKEN = 'mock-token';
    process.chdir(bizDir);
    process.argv = [process.execPath, 'cli', 'run', 'my-proj', '--fix', '--hard'];

    console.log = (...values) => logs.push(values.join(' '));
    process.exit = (code) => {
      exitCode = code === undefined ? 0 : code;
      throw new Error(`process.exit called with ${exitCode}`);
    };

    api.apiRequestJson = async (pathname) => {
      if (pathname === '/business/' || pathname === '/business') {
        return {
          ok: true,
          status: 200,
          data: [{ id: 'b1', workspace_id: 'w1', name: 'my-proj', slug: 'my-proj' }],
        };
      }
      if (pathname.includes('/ai-computer/status')) {
        return {
          ok: true,
          status: 200,
          data: { status: 'running', endpoint: 'https://vm.test' },
        };
      }
      if (pathname.endsWith('/files')) {
        return {
          ok: true,
          status: 200,
          data: { files: [] },
        };
      }
      return { ok: true, status: 200, data: {} };
    };

    const [run] = Object.values(require('../commands/align'));
    await run();

    assert.strictEqual(exitCode, null);
    assert.strictEqual(logs.some((line) => line.includes('Force-push complete')), true);
  } finally {
    console.log = origLog;
    process.exit = origExit;
    api.apiRequestJson = origApiRequestJson;
    process.argv = savedArgv;
    try { process.chdir(savedCwd); } catch {}
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
    fs.rmSync(home, { recursive: true, force: true });
  }
});
