const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('an empty account result reports that there are no errors', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-empty-errors-'));
  const originalHome = process.env.HOME;
  const originalCwd = process.cwd();
  const originalArgv = process.argv;
  const originalLog = console.log;
  const originalExit = process.exit;
  const api = require('../utils/api');
  const originalRequest = api.apiRequestJson;
  const output = [];
  let requested = false;
  try {
    process.env.HOME = home;
    process.chdir(home);
    fs.mkdirSync(path.join(home, '.atris'));
    fs.writeFileSync(path.join(home, '.atris', 'credentials.json'),
      JSON.stringify({ token: 'saved-account-token' }));
    api.apiRequestJson = async (endpoint) => {
      assert.match(endpoint, /^\/errors\?/);
      requested = true;
      return { ok: true, status: 200, data: { groups: [], total_events: 0 } };
    };
    console.log = (...args) => output.push(args.join(' '));
    process.exit = (code) => { throw new Error(`unexpected exit: ${code}`); };
    process.argv = [process.execPath, 'atris', 'errors', '--account'];
    const { errorsCommand } = require('../commands/errors');
    await errorsCommand();
    assert.equal(requested, true);
    assert.match(output.join('\n'), /no errors in the last 24h/i);
  } finally {
    api.apiRequestJson = originalRequest;
    console.log = originalLog;
    process.exit = originalExit;
    process.argv = originalArgv;
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});
