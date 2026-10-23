'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const api = require('../utils/api');

test('displays template description in template listing', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-test-'));
  const prevHome = process.env.HOME;
  const prevAtrisToken = process.env.ATRIS_TOKEN;
  const origApiRequestJson = api.apiRequestJson;
  const origLog = console.log;
  const origExit = process.exit;
  const origArgv = process.argv;
  const lines = [];

  try {
    process.env.HOME = tmp;
    process.env.ATRIS_TOKEN = 'mock-token';
    const atrisDir = path.join(tmp, '.atris');
    fs.mkdirSync(atrisDir, { recursive: true });
    fs.writeFileSync(
      path.join(atrisDir, 'credentials.json'),
      JSON.stringify({ token: 'mock-token' }),
      'utf8'
    );

    process.argv = [process.execPath, 'atris'];

    console.log = (...args) => lines.push(args.join(' '));
    process.exit = (code) => {
      throw new Error(`exit: ${code}`);
    };

    api.apiRequestJson = async () => ({
      ok: true,
      data: [
        {
          name: 'sample-template',
          description: 'target-description-text',
        },
      ],
    });

    const mod = require('../commands/browse');
    const [runCommand] = Object.values(mod);

    await runCommand();

    assert.equal(lines.some((line) => line.includes('target-description-text')), true);
  } finally {
    api.apiRequestJson = origApiRequestJson;
    console.log = origLog;
    process.exit = origExit;
    process.argv = origArgv;
    if (prevHome !== undefined) {
      process.env.HOME = prevHome;
    }
    if (prevAtrisToken === undefined) {
      delete process.env.ATRIS_TOKEN;
    } else {
      process.env.ATRIS_TOKEN = prevAtrisToken;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
