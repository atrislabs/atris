require('./helpers/clean-temp');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('account groups display the sample error message', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-error-sample-'));
  const previous = {
    home: process.env.HOME,
    cwd: process.cwd(),
    argv: process.argv,
    log: console.log,
    exit: process.exit,
  };
  const api = require('../utils/api');
  const request = api.apiRequestJson;
  const lines = [];
  try {
    process.env.HOME = dir;
    process.chdir(dir);
    fs.mkdirSync(path.join(dir, '.atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.atris', 'credentials.json'),
      JSON.stringify({ token: 'sample-test-token' }));
    api.apiRequestJson = async () => ({
      ok: true,
      data: {
        hours: 24,
        total_events: 1,
        unique_signatures: 1,
        groups: [{
          count: 1,
          signature: 'upload-failure',
          sample: { message: 'upload sample marker' },
        }],
      },
    });
    console.log = (...args) => lines.push(args.join(' '));
    process.exit = code => { throw new Error(`unexpected exit ${code}`); };
    process.argv = [process.execPath, 'atris', 'errors', '--account'];
    const { errorsCommand } = require('../commands/errors');
    await errorsCommand();
    assert.ok(lines.some(line => line.includes('upload sample marker')));
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
