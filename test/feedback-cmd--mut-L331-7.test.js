'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('a shorthand report preserves the supplied message', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-report-message-'));
  const savedEnv = { ...process.env };
  const savedArgv = process.argv;
  const savedCwd = process.cwd();
  const savedLog = console.log;
  const savedError = console.error;
  const savedExit = process.exit;
  const api = require('../utils/api');
  const savedRequest = api.apiRequestJson;
  let submittedMessage;
  const message = 'The feedback button does not respond';
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    process.env.HOME = home;
    process.chdir(home);
    fs.mkdirSync(path.join(home, '.atris'));
    fs.writeFileSync(path.join(home, '.atris', 'credentials.json'), JSON.stringify({ token: 'fixture-token' }));
    api.apiRequestJson = async (endpoint, options = {}) => {
      if (options.body && options.body.message) submittedMessage = options.body.message;
      return { ok: true, status: 200, data: { id: 'report-fixture', user: { id: 'fixture-user' } } };
    };
    console.log = () => {};
    console.error = () => {};
    process.exit = (code) => { throw new Error(`unexpected exit ${code}`); };
    process.argv = [process.execPath, 'atris', 'feedback', message];
    const { feedbackCommand } = require('../commands/feedback');
    let commandError;
    try {
      await feedbackCommand();
    } catch (error) {
      commandError = error;
    }
    assert.strictEqual(submittedMessage, message, commandError && commandError.message);
  } finally {
    api.apiRequestJson = savedRequest;
    console.log = savedLog;
    console.error = savedError;
    process.exit = savedExit;
    process.argv = savedArgv;
    process.chdir(savedCwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  }
});
