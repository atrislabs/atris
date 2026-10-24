require('./helpers/clean-temp');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('account error sample displays its shortened identifier', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-error-id-'));
  const previous = {
    home: process.env.HOME,
    cwd: process.cwd(),
    argv: process.argv,
    exit: process.exit,
    log: console.log,
  };
  const api = require('../utils/api');
  const request = api.apiRequestJson;
  const output = [];
  try {
    process.env.HOME = dir;
    process.chdir(dir);
    fs.mkdirSync(path.join(dir, '.atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.atris', 'credentials.json'),
      JSON.stringify({ token: 'fixture-token' }));
    api.apiRequestJson = async () => ({
      ok: true,
      status: 200,
      data: {
        window_hours: 24,
        total_events: 1,
        total_signatures: 1,
        groups: [{
          count: 1,
          signature: 'fixture failure',
          sample: {
            id: '12345678-abcd-4321-9876-123456789abc',
            created_at: '2024-01-15T12:00:00Z',
            status_code: 500,
            message: 'fixture failure',
          },
        }],
      },
    });
    console.log = (...args) => output.push(args.join(' '));
    process.exit = code => { throw new Error(`unexpected exit ${code}`); };
    process.argv = [process.execPath, 'atris', 'errors', '--account'];
    const { errorsCommand } = require('../commands/errors');
    await errorsCommand();
    assert.match(output.join('\n'), /\b12345678\b/);
  } finally {
    api.apiRequestJson = request;
    console.log = previous.log;
    process.exit = previous.exit;
    process.argv = previous.argv;
    process.chdir(previous.cwd);
    if (previous.home === undefined) delete process.env.HOME;
    else process.env.HOME = previous.home;
  }
});
