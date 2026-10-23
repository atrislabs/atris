'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('saved credentials without a token prompt the user to log in', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-feedback-no-token-'));
  const savedEnv = { ...process.env };
  const savedArgv = process.argv;
  const savedCwd = process.cwd();
  const errors = [];
  const exit = new Error('command exit');
  try {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ATRIS_')) delete process.env[key];
    }
    process.env.HOME = home;
    process.chdir(home);
    fs.mkdirSync(path.join(home, '.atris'));
    fs.writeFileSync(path.join(home, '.atris', 'credentials.json'), '{}');
    const api = require('../utils/api');
    t.mock.method(api, 'apiRequestJson', async () => ({ ok: false, status: 401, data: {} }));
    t.mock.method(api, 'httpRequest', async () => ({ statusCode: 401, data: {} }));
    t.mock.method(console, 'log', () => {});
    t.mock.method(console, 'error', (...args) => errors.push(args.join(' ')));
    t.mock.method(process, 'exit', () => { throw exit; });
    const { feedbackCommand } = require('../commands/feedback');
    process.argv = [process.execPath, 'atris', 'feedback', 'list'];
    try {
      await feedbackCommand();
    } catch (error) {
      if (error !== exit) throw error;
    }
    assert.ok(errors.some((line) => /login/i.test(line)), 'missing token should produce login guidance');
  } finally {
    t.mock.restoreAll();
    process.chdir(savedCwd);
    process.argv = savedArgv;
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
  }
});
