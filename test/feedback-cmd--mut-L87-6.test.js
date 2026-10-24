'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('a failed submission reports a repeated server error only once', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-error-'));
  const previousHome = process.env.HOME;
  const previousArgv = process.argv;
  const previousCwd = process.cwd();
  const api = require('../utils/api');
  t.mock.method(api, 'apiRequestJson', async () => ({
    ok: false,
    status: 503,
    error: 'Service unavailable',
    data: { detail: 'Service unavailable' },
  }));
  const errors = [];
  t.mock.method(console, 'error', (...args) => errors.push(args.join(' ')));
  t.mock.method(process, 'exit', () => { throw new Error('command stopped'); });
  try {
    process.env.HOME = home;
    process.chdir(home);
    fs.mkdirSync(path.join(home, '.atris'), { recursive: true });
    fs.writeFileSync(path.join(home, '.atris', 'credentials.json'), JSON.stringify({
      token: 'fixture-token', saved_at: '2026-01-01T00:00:00.000Z',
    }));
    process.argv = [process.execPath, 'atris', 'feedback', 'submit', 'The queue is broken'];
    const { feedbackCommand } = require('../commands/feedback');
    try {
      await feedbackCommand();
    } catch (error) {
      // The command stops after reporting the request failure.
    }
    assert.equal((errors.join('\n').match(/Service unavailable/g) || []).length, 1);
  } finally {
    process.argv = previousArgv;
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    t.mock.restoreAll();
  }
});
