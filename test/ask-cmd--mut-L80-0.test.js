const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('reply characters pause longer after a newline', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-character-delay-'));
  const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
  const oldHome = process.env.HOME;
  const oldCwd = process.cwd();
  process.env.HOME = home;
  process.chdir(home);
  const auth = require('../utils/auth');
  const api = require('../utils/api');
  for (const transport of ['node:http', 'node:https']) {
    t.mock.method(require(transport), 'request', () => { throw new Error('network forbidden'); });
  }
  t.mock.method(api, 'httpRequest', async () => ({ status: 200, body: Buffer.from(JSON.stringify({ response: 'a\nb' })) }));
  const pauses = [];
  let written = '';
  t.mock.method(auth, 'ensureValidCredentials', async () => ({ credentials: { token: 'test-token' } }));
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  t.mock.method(process, 'exit', code => { throw new Error(`unexpected exit ${code}`); });
  t.mock.method(process.stdout, 'write', text => { written += text; return true; });
  t.mock.method(global, 'setTimeout', (callback, delay) => {
    pauses.push({ character: written.slice(-1), delay });
    callback();
    return {};
  });
  try {
    const { askAtris } = require('../commands/ask');
    await askAtris(['say hello']);
    assert.equal(pauses.find(pause => pause.character === '\n')?.delay, 12);
    assert.equal(pauses.find(pause => pause.character === 'a')?.delay, 3);
  } finally {
    t.mock.restoreAll();
    if (ttyDescriptor) Object.defineProperty(process.stdout, 'isTTY', ttyDescriptor);
    else delete process.stdout.isTTY;
    process.chdir(oldCwd);
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  }
});
