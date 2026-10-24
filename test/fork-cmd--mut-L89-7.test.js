require('./helpers/clean-temp');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('fork skips API files with null content while writing usable files', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-fork-null-'));
  const previousEnv = { ...process.env };
  const previousCwd = process.cwd();
  const previousArgv = process.argv;
  const previousLog = console.log;
  const previousError = console.error;
  const previousExit = process.exit;
  const api = require('../utils/api');
  const previousRequest = api.apiRequestJson;
  const messages = [];
  let failure;

  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    process.env.HOME = home;
    process.env.ATRIS_TOKEN = 'test-token';
    process.chdir(home);
    process.argv = [process.execPath, 'atris', 'fork', 'demo', 'copy'];
    console.log = (...args) => messages.push(args.join(' '));
    console.error = (...args) => messages.push(args.join(' '));
    process.exit = (code) => { throw new Error(`exit ${code}`); };
    api.apiRequestJson = async () => ({
      ok: true,
      status: 200,
      data: {
        files: [
          { path: 'unavailable.txt', content: null },
          { path: 'README.md', content: 'usable template\n' },
        ],
      },
    });
    const { forkAtris } = require('../commands/fork');
    try {
      await forkAtris();
    } catch (error) {
      failure = error;
    }
    assert.equal(fs.existsSync(path.join(home, 'copy', 'unavailable.txt')), false,
      'null content must not create a file');
    assert.equal(fs.existsSync(path.join(home, 'copy', 'README.md')), true,
      `usable content must survive a null entry: ${messages.join('\n')}`);
    assert.equal(fs.readFileSync(path.join(home, 'copy', 'README.md'), 'utf8'), 'usable template\n');
    assert.equal(failure, undefined);
  } finally {
    api.apiRequestJson = previousRequest;
    console.log = previousLog;
    console.error = previousError;
    process.exit = previousExit;
    process.argv = previousArgv;
    process.chdir(previousCwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previousEnv);
  }
});
