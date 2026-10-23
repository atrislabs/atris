const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('browse without a query prints the exact login instruction', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-browse-no-query-'));
  const savedEnv = { ...process.env };
  const savedArgv = process.argv;
  const errors = [];
  const logs = [];
  const exit = new Error('intercepted exit');
  let exitCode;
  let failure;

  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    process.env.HOME = home;
    process.env.ATRIS_TEST_STATE_DIR = home;
    process.argv = [process.execPath, 'atris', 'browse'];
    t.mock.method(console, 'error', (...args) => errors.push(args.join(' ')));
    t.mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
    t.mock.method(process, 'exit', code => {
      exitCode = code;
      throw exit;
    });

    const { browseAtris } = require('../commands/browse');
    try {
      await browseAtris();
    } catch (error) {
      failure = error;
    }

    assert.deepEqual(errors, ['Not logged in. Run: atris login']);
    assert.deepEqual(logs, []);
    assert.equal(exitCode, 1);
    assert.equal(failure, exit);
  } finally {
    t.mock.restoreAll();
    process.argv = savedArgv;
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    fs.rmSync(home, { recursive: true, force: true });
  }
});
