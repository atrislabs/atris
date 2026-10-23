'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const api = require('../utils/api');

test('streams typewriter chunks when response text length is four thousand', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'test-mut-'));
  const envKeys = ['HOME', 'ATRIS_TOKEN', 'ATRIS_PROFILE', 'TERM_SESSION_ID'];
  const prevEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));

  process.env.HOME = home;
  process.env.ATRIS_PROFILE = '';
  process.env.TERM_SESSION_ID = 'test-session';
  process.env.ATRIS_TOKEN = `test.${Buffer.from(JSON.stringify({
    type: 'agent_access',
    exp: 2000000000,
  })).toString('base64url')}.test`;

  const origHttpRequest = api.httpRequest;
  api.httpRequest = async () => ({
    status: 200,
    headers: {},
    body: Buffer.from(JSON.stringify({
      response: 'a'.repeat(4000),
    })),
  });

  const { askAtris } = require('../commands/ask');

  const origIsTTY = process.stdout.isTTY;
  const origWrite = process.stdout.write;
  const origSetTimeout = global.setTimeout;

  process.stdout.isTTY = true;
  let chunkCount = 0;
  process.stdout.write = () => {
    chunkCount += 1;
    return true;
  };
  global.setTimeout = (fn, delay, ...args) => {
    if (delay === 3 || delay === 0 || delay === undefined) {
      fn(...args);
      return 0;
    }
    return origSetTimeout(fn, delay, ...args);
  };

  try {
    await askAtris(['question']);
    assert.strictEqual(chunkCount > 2, true);
  } finally {
    global.setTimeout = origSetTimeout;
    process.stdout.write = origWrite;
    process.stdout.isTTY = origIsTTY;
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
