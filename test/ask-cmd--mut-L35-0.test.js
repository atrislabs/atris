require('./helpers/clean-temp');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('one-shot replies remove a nested inline tool event', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-event-reply-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  const api = require('../utils/api');
  const auth = require('../utils/auth');
  const output = [];
  t.mock.method(auth, 'ensureValidCredentials', async () => ({
    credentials: { token: 'saved-test-token' },
  }));
  t.mock.method(api, 'httpRequest', async () => ({
    status: 200,
    body: Buffer.from(JSON.stringify({
      response: 'Before [[EVENT]]{"type":"tool_call","tool":"calendar","args":{"query":"meetings"}} After',
    })),
  }));
  t.mock.method(process.stdout, 'write', chunk => {
    output.push(String(chunk));
    return true;
  });
  t.mock.method(process, 'exit', code => { throw new Error(`unexpected exit ${code}`); });
  try {
    process.env.HOME = home;
    process.chdir(home);
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
    const { askAtris } = require('../commands/ask');
    await askAtris(['What meetings do I have?']);
    assert.equal(output.join('').includes('"tool_call"'), false);
    assert.match(output.join(''), /Before\s+After/);
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (ttyDescriptor) Object.defineProperty(process.stdout, 'isTTY', ttyDescriptor);
    else delete process.stdout.isTTY;
  }
});
