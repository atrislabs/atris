const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('a JSON-shaped reply retains its content', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-json-reply-'));
  const previousHome = process.env.HOME;
  const previousToken = process.env.ATRIS_TOKEN;
  const cwd = process.cwd();
  process.env.HOME = home;
  process.env.ATRIS_TOKEN = `test.${Buffer.from('{"type":"agent_access"}').toString('base64url')}.test`;
  process.chdir(home);
  const lines = [];
  try {
    for (const transport of ['node:http', 'node:https']) {
      t.mock.method(require(transport), 'request', () => {
        throw new Error('network is disabled');
      });
    }
    t.mock.method(require('../utils/api'), 'httpRequest', async () => ({
      status: 200,
      body: Buffer.from(JSON.stringify({ response: '{"enabled":true}' })),
    }));
    t.mock.method(console, 'log', (...values) => lines.push(values.join(' ')));
    t.mock.method(process.stdout, 'write', chunk => {
      lines.push(String(chunk));
      return true;
    });
    t.mock.method(process, 'exit', code => { throw new Error(`exit ${code}`); });
    const { askAtris } = require('../commands/ask');
    await askAtris(['show the configuration as JSON']);
    assert.equal(lines.some(line => line.includes('enabled')), true);
  } finally {
    t.mock.restoreAll();
    process.chdir(cwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousToken === undefined) delete process.env.ATRIS_TOKEN;
    else process.env.ATRIS_TOKEN = previousToken;
  }
});
