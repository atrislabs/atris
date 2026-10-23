const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('redirected short replies are printed without animation', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-redirected-'));
  const cwd = process.cwd();
  const savedEnv = { ...process.env };
  const tty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  const lines = [];
  try {
    process.env.HOME = home;
    process.env.ATRIS_TOKEN = `test.${Buffer.from('{"type":"agent_access"}').toString('base64url')}.test`;
    process.chdir(home);
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
    for (const transport of ['node:http', 'node:https']) {
      t.mock.method(require(transport), 'request', () => { throw new Error('network is disabled'); });
    }
    t.mock.method(require('../utils/api'), 'httpRequest', async () => ({
      status: 200,
      body: Buffer.from(JSON.stringify({ response: 'The saved preference is blue.' })),
    }));
    t.mock.method(console, 'log', (...values) => lines.push(values.join(' ')));
    t.mock.method(process.stdout, 'write', chunk => { lines.push(String(chunk)); return true; });
    t.mock.method(process, 'exit', code => { throw new Error(`exit ${code}`); });
    const { askAtris } = require('../commands/ask');
    await askAtris(['what preference did I save?']);
    assert.equal(lines.some(line => line.includes('preference is blue')), true);
  } finally {
    t.mock.restoreAll();
    if (tty) Object.defineProperty(process.stdout, 'isTTY', tty);
    else delete process.stdout.isTTY;
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  }
});
