'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('a structured search error keeps its provider message in the failure output', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-search-error-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  process.env.HOME = home;
  process.chdir(home);

  try {
    const { xSearchCommand } = require('../commands/x-search');
    const output = [];
    const credentials = { token: 'fixture-user-token' };
    const status = await xSearchCommand(['orchard harvest', '--no-check'], {
      cwd: home,
      output: (line) => output.push(String(line)),
      ensureValidCredentials: async () => ({ credentials }),
      loadCredentials: () => credentials,
      mintScopedAgentToken: async () => ({ ok: true, token: 'fixture-search-token' }),
      apiRequestJson: async () => ({
        ok: false,
        status: 503,
        error: { message: 'Search provider temporarily unavailable' },
      }),
    });

    assert.equal(status, 1);
    assert.match(output.join('\n'), /Search provider temporarily unavailable/);
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
