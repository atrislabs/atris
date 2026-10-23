const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { askAtris } = require('../commands/ask');

async function askOnce(t, responseText) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-ask-mut-'));
  const overrides = {
    HOME: home,
    ATRIS_AGENT_TOKEN_FILE: path.join(home, 'agent-token.json'),
    ATRIS_PROFILE: '',
    TERM_SESSION_ID: 'ask-mut-test',
    // Scoped tokens are checked locally, so no authentication request is made.
    ATRIS_TOKEN: `test.${Buffer.from(JSON.stringify({
      type: 'agent_access',
      exp: 4000000000,
    })).toString('base64url')}.test`,
  };
  const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));

  const written = [];
  const out = t.mock.method(process.stdout, 'write', chunk => {
    written.push(String(chunk));
    return true;
  });
  const exit = t.mock.method(process, 'exit', code => {
    assert.fail(`ask must not exit the process (${code})`);
  });
  const httpGuard = t.mock.method(require('node:http'), 'request', () => {
    assert.fail('http transport must not be used');
  });
  const httpsMock = t.mock.method(require('node:https'), 'request', (options, cb) => {
    const req = new EventEmitter();
    req.setTimeout = () => {};
    req.hasHeader = () => false;
    req.setHeader = () => {};
    req.write = () => {};
    req.destroy = () => {};
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = 200;
      res.headers = {};
      cb(res);
      res.emit('data', Buffer.from(JSON.stringify({ response: responseText })));
      res.emit('end');
      req.emit('close');
    };
    return req;
  });
  const hadTty = process.stdout.isTTY;
  process.stdout.isTTY = false;

  try {
    Object.assign(process.env, overrides);
    const result = await askAtris(['ping']);
    assert.strictEqual(result, undefined);
    return written.join('');
  } finally {
    process.stdout.isTTY = hadTty;
    out.mock.restore();
    exit.mock.restore();
    httpGuard.mock.restore();
    httpsMock.mock.restore();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('ask strips an inline tool_call event and prints only the reply', async t => {
  const output = await askOnce(t, '[[EVENT]]{"type":"tool_call","tool":"x"}hello');
  assert.strictEqual(output, 'hello\n');
});

test('ask strips an inline non-tool event and prints only the reply', async t => {
  const output = await askOnce(t, '[[EVENT]]{"a":1}done');
  assert.strictEqual(output, 'done\n');
});
