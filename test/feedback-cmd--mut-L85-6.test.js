'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('submission preserves an unparsed server error', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-feedback-response-'));
  const env = { ...process.env };
  const argv = process.argv;
  const cwd = process.cwd();
  const api = require('../utils/api');
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    process.env.HOME = root;
    process.env.ATRIS_TOKEN = 'fixture-token';
    process.chdir(root);
    t.mock.method(api, 'apiRequestJson', async () => ({
      ok: false, status: 503, data: null,
      text: 'service temporarily unavailable', error: 'service temporarily unavailable',
    }));
    const logs = [];
    t.mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
    t.mock.method(console, 'error', (...args) => logs.push(args.join(' ')));
    t.mock.method(process, 'exit', () => { throw new Error('exit requested'); });
    const { feedbackCommand } = require('../commands/feedback');
    process.argv = [process.execPath, 'atris', 'feedback', 'submit', 'The queue does not refresh'];
    try { await feedbackCommand(); } catch (error) { logs.push(error.message); }
    assert.match(logs.join('\n'), /temporarily unavailable/i);
  } finally {
    t.mock.restoreAll();
    process.chdir(cwd);
    process.argv = argv;
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, env);
  }
});
