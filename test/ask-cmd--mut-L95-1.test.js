const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('a successful message prints the returned reply', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-reply-'));
  const previousEnv = { ...process.env };
  const previousCwd = process.cwd();
  const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  const output = [];
  const exitSignal = new Error('process exit');
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    process.env.HOME = home;
    process.env.ATRIS_AGENT_TOKEN_FILE = path.join(home, 'agent-token.json');
    process.env.ATRIS_TOKEN = `test.${Buffer.from(JSON.stringify({ type: 'agent_access', exp: 4102444800 })).toString('base64url')}.test`;
    process.chdir(home);
    const api = require('../utils/api');
    t.mock.method(api, 'httpRequest', async () => ({
      status: 200,
      body: Buffer.from(JSON.stringify({ response: 'Your appointment is confirmed.' })),
    }));
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
    t.mock.method(process.stdout, 'write', chunk => { output.push(String(chunk)); return true; });
    t.mock.method(console, 'error', () => {});
    t.mock.method(process, 'exit', () => { throw exitSignal; });
    const { askAtris } = require('../commands/ask');
    try {
      await askAtris(['Confirm my appointment']);
    } catch (error) {
      if (error !== exitSignal) throw error;
    }
    assert.match(output.join(''), /appointment is confirmed/);
  } finally {
    t.mock.restoreAll();
    if (ttyDescriptor) Object.defineProperty(process.stdout, 'isTTY', ttyDescriptor);
    else delete process.stdout.isTTY;
    process.chdir(previousCwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previousEnv);
  }
});
