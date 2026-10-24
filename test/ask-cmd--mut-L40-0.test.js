'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const api = require('../utils/api');

test('surfaces tool name when tool_call event is received', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-cmd-mut-'));
  const envKeys = ['HOME', 'ATRIS_TOKEN', 'ATRIS_PROFILE', 'TERM_SESSION_ID'];
  const prevEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));

  process.env.HOME = home;
  process.env.ATRIS_PROFILE = '';
  process.env.TERM_SESSION_ID = 'test-session';
  process.env.ATRIS_TOKEN = `test.${Buffer.from(JSON.stringify({
    type: 'agent_access',
    exp: Math.floor(Date.now() / 1000) + 86400,
  })).toString('base64url')}.test`;

  const origHttpRequest = api.httpRequest;
  api.httpRequest = async () => ({
    status: 200,
    headers: {},
    body: Buffer.from(JSON.stringify({
      response: '[[EVENT]]{"type":"tool_call","tool":"calculator"}Done',
    })),
  });

  const { askAtris } = require('../commands/ask');

  const origIsTTY = process.stdout.isTTY;
  const origWrite = process.stdout.write;
  const origExit = process.exit;

  process.stdout.isTTY = true;
  const written = [];
  process.stdout.write = (chunk) => {
    written.push(String(chunk));
    return true;
  };
  process.exit = (code) => {
    throw new Error(`exit ${code}`);
  };

  try {
    await askAtris(['test question']);
    assert.strictEqual(written.some((chunk) => chunk.includes('calculator')), true);
  } finally {
    process.stdout.write = origWrite;
    process.stdout.isTTY = origIsTTY;
    process.exit = origExit;
    api.httpRequest = origHttpRequest;

    for (const [key, val] of Object.entries(prevEnv)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
});
