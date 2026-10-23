const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function runBrowse(t, args) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-browse-test-'));
  const savedEnv = { ...process.env };
  const savedArgv = process.argv;
  const logs = [];
  const errors = [];
  const exit = new Error('intercepted process exit');
  let exitCode;
  try {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ATRIS_')) delete process.env[key];
    }
    process.env.HOME = home;
    process.argv = [process.execPath, 'atris', 'browse', ...args];
    t.mock.method(console, 'log', (...values) => logs.push(values.join(' ')));
    t.mock.method(console, 'error', (...values) => errors.push(values.join(' ')));
    t.mock.method(process, 'exit', code => {
      exitCode = code;
      throw exit;
    });
    const { browseAtris } = require('../commands/browse');
    await assert.rejects(browseAtris(), error => error === exit);
    return { logs, errors, exitCode };
  } finally {
    t.mock.restoreAll();
    process.argv = savedArgv;
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('browse --help prints usage and examples without requiring login', async t => {
  const result = await runBrowse(t, ['--help']);
  assert.strictEqual(result.exitCode, 0);
  assert.deepStrictEqual(result.logs, [
    'Usage: atris browse [query]',
    '',
    '  atris browse             List all workspace templates',
    '  atris browse crm         Search for templates matching "crm"',
  ]);
  assert.deepStrictEqual(result.errors, []);
});

test('browse with a query requires login before searching templates', async t => {
  const result = await runBrowse(t, ['crm']);
  assert.strictEqual(result.exitCode, 1);
  assert.deepStrictEqual(result.errors, ['Not logged in. Run: atris login']);
  assert.deepStrictEqual(result.logs, []);
});
