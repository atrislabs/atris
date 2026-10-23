'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('list explains that agent clients need a backend update when the endpoint returns 404', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-client-unavailable-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  process.env.HOME = home;
  process.chdir(home);

  try {
    const { agentClientCommand } = require('../commands/agent-client');
    const errors = [];
    const code = await agentClientCommand(['list'], {
      log: () => {},
      err: (line) => errors.push(String(line)),
      readActiveCredentials: () => null,
      ensureValidCredentials: async () => ({ credentials: { token: 'owner-token' }, user: null }),
      apiRequestJson: async () => ({
        ok: false,
        status: 404,
        data: { detail: 'Not Found' },
      }),
    });

    assert.equal(code, 1);
    assert.match(errors.join('\n'), /agent clients are not live on the server yet/i);
    assert.match(errors.join('\n'), /backend update/i);
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
