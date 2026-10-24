'use strict';

// executeAgentSDKFast posts to a local backend over http. These tests swap
// http.request for a fake so no socket is ever opened, and swap console and
// process.exit so the output and exit code can be read back.

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const http = require('node:http');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-sdkfast-'));
process.env.HOME = sandbox;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}

const { executeAgentSDKFast } = require('../commands/workflow');

const HINT = '💡 start your local backend at http://127.0.0.1:8000.';

// scenario: { status, body, chunks, requestError, timeout }
async function run(userInput, scenario) {
  const seen = { options: null, written: '', timeoutMs: null, destroyed: false };
  const logs = [];
  const errors = [];
  const exits = [];

  const original = {
    request: http.request,
    log: console.log,
    error: console.error,
    exit: process.exit,
    cwd: process.cwd(),
  };

  http.request = (options, onResponse) => {
    seen.options = options;
    const req = new EventEmitter();
    req.write = (data) => { seen.written += data; };
    req.destroy = () => { seen.destroyed = true; };
    req.setTimeout = (ms, onTimeout) => {
      seen.timeoutMs = ms;
      if (scenario.timeout) onTimeout();
    };
    req.end = () => {
      if (scenario.requestError) {
        req.emit('error', new Error(scenario.requestError));
        return;
      }
      if (scenario.timeout) return;
      const res = new EventEmitter();
      res.statusCode = scenario.status === undefined ? 200 : scenario.status;
      onResponse(res);
      const chunks = scenario.chunks || [scenario.body];
      for (const chunk of chunks) res.emit('data', chunk);
      res.emit('end');
    };
    return req;
  };
  console.log = (...args) => { logs.push(args.join(' ')); };
  console.error = (...args) => { errors.push(args.join(' ')); };
  process.exit = (code) => { exits.push(code); };
  process.chdir(sandbox);

  try {
    await executeAgentSDKFast(userInput);
  } finally {
    http.request = original.request;
    console.log = original.log;
    console.error = original.error;
    process.exit = original.exit;
    process.chdir(original.cwd);
  }

  return { seen, logs, errors, exits };
}

test('prints assistant text, tool names, duration and cost for a normal reply', async () => {
  const body = JSON.stringify({
    result: [
      {
        type: 'assistant',
        content: [
          { type: 'text', text: 'looking at the repo' },
          { type: 'tool_use', tool_name: 'Read' },
          { type: 'text', text: 'all done' },
        ],
      },
      { type: 'result', duration_ms: 1234, cost_usd: 0.25 },
    ],
  });

  const out = await run('fix the typo', { body });

  assert.deepStrictEqual(out.logs, [
    '⚡ Executing: fix the typo',
    '',
    'looking at the repo',
    '\n⚙️  Read',
    'all done',
    '\n✅ Done in 1234ms',
    '💰 Cost: $0.2500',
  ]);
  assert.deepStrictEqual(out.errors, []);
  assert.deepStrictEqual(out.exits, []);
});

test('sends a JSON POST to the local agent-sdk endpoint with the working folder', async () => {
  const out = await run('ship it', { body: JSON.stringify({ result: [] }) });

  assert.strictEqual(out.seen.options.hostname, '127.0.0.1');
  assert.strictEqual(out.seen.options.port, 8000);
  assert.strictEqual(out.seen.options.path, '/api/agent-sdk/execute');
  assert.strictEqual(out.seen.options.method, 'POST');
  assert.strictEqual(out.seen.options.headers['Content-Type'], 'application/json');
  assert.strictEqual(out.seen.timeoutMs, 120000);

  const sent = JSON.parse(out.seen.written);
  assert.deepStrictEqual(sent, {
    message: 'ship it',
    workspace_path: fs.realpathSync(sandbox),
    model: 'claude-sonnet-4-6',
  });
  assert.strictEqual(out.seen.options.headers['Content-Length'], Buffer.byteLength(out.seen.written));
});

test('Content-Length counts bytes, not characters, for non-ASCII input', async () => {
  const input = 'héllo ⚡ 世界';
  const out = await run(input, { body: JSON.stringify({ result: [] }) });

  assert.ok(Buffer.byteLength(out.seen.written) > out.seen.written.length);
  assert.strictEqual(out.seen.options.headers['Content-Length'], Buffer.byteLength(out.seen.written));
  assert.strictEqual(JSON.parse(out.seen.written).message, input);
  assert.strictEqual(out.logs[0], `⚡ Executing: ${input}`);
});

test('reassembles a reply that arrives in several chunks', async () => {
  const full = JSON.stringify({
    result: [{ type: 'assistant', content: [{ type: 'text', text: 'split across chunks' }] }],
  });
  const cut = Math.floor(full.length / 3);
  const chunks = [full.slice(0, cut), full.slice(cut, cut * 2), full.slice(cut * 2)];

  const out = await run('go', { chunks });

  assert.deepStrictEqual(out.logs, ['⚡ Executing: go', '', 'split across chunks']);
  assert.deepStrictEqual(out.exits, []);
});

test('skips cost when it is missing or zero and ignores unknown events and blocks', async () => {
  const body = JSON.stringify({
    result: [
      { type: 'system', content: [{ type: 'text', text: 'should not print' }] },
      { type: 'assistant' },
      { type: 'assistant', content: [{ type: 'image', text: 'should not print' }] },
      { type: 'result', duration_ms: 7, cost_usd: 0 },
      { type: 'result', duration_ms: 9 },
    ],
  });

  const out = await run('quiet', { body });

  assert.deepStrictEqual(out.logs, [
    '⚡ Executing: quiet',
    '',
    '\n✅ Done in 7ms',
    '\n✅ Done in 9ms',
  ]);
  assert.deepStrictEqual(out.exits, []);
});

test('prints only the header when the reply has no result list', async () => {
  const noResult = await run('one', { body: JSON.stringify({ ok: true }) });
  assert.deepStrictEqual(noResult.logs, ['⚡ Executing: one', '']);
  assert.deepStrictEqual(noResult.exits, []);

  const notAnArray = await run('two', { body: JSON.stringify({ result: 'text' }) });
  assert.deepStrictEqual(notAnArray.logs, ['⚡ Executing: two', '']);
  assert.deepStrictEqual(notAnArray.exits, []);
});

test('accepts an empty prompt and still sends it', async () => {
  const out = await run('', { body: JSON.stringify({ result: [] }) });

  assert.strictEqual(JSON.parse(out.seen.written).message, '');
  assert.strictEqual(out.logs[0], '⚡ Executing: ');
  assert.deepStrictEqual(out.exits, []);
});

test('a non-2xx reply reports its detail, shows the hint and exits 1', async () => {
  const out = await run('bad', { status: 500, body: JSON.stringify({ detail: 'boom' }) });

  assert.deepStrictEqual(out.errors, ['✗ Error: boom']);
  assert.ok(out.logs.includes(HINT));
  assert.deepStrictEqual(out.exits, [1]);
});

test('a non-2xx reply falls back to error, then to the status code', async () => {
  const withError = await run('a', { status: 400, body: JSON.stringify({ error: 'bad input' }) });
  assert.deepStrictEqual(withError.errors, ['✗ Error: bad input']);
  assert.deepStrictEqual(withError.exits, [1]);

  const bare = await run('b', { status: 503, body: JSON.stringify({}) });
  assert.deepStrictEqual(bare.errors, ['✗ Error: HTTP 503']);
  assert.deepStrictEqual(bare.exits, [1]);
});

test('a 200 reply carrying an error field is treated as a failure', async () => {
  const out = await run('c', { body: JSON.stringify({ error: 'agent failed', result: [] }) });

  assert.deepStrictEqual(out.errors, ['✗ Error: agent failed']);
  assert.ok(out.logs.includes(HINT));
  assert.deepStrictEqual(out.exits, [1]);
});

test('a reply that is not JSON reports the raw body and exits 1', async () => {
  const out = await run('d', { body: '<html>nope</html>' });

  assert.deepStrictEqual(out.errors, ['✗ Error: Failed to parse response: <html>nope</html>']);
  assert.deepStrictEqual(out.exits, [1]);
});

test('an empty reply body is a parse failure', async () => {
  const out = await run('e', { body: '' });

  assert.deepStrictEqual(out.errors, ['✗ Error: Failed to parse response: ']);
  assert.deepStrictEqual(out.exits, [1]);
});

test('a connection error is reported and exits 1', async () => {
  const out = await run('f', { requestError: 'connect ECONNREFUSED 127.0.0.1:8000' });

  assert.deepStrictEqual(out.errors, ['✗ Error: connect ECONNREFUSED 127.0.0.1:8000']);
  assert.ok(out.logs.includes(HINT));
  assert.deepStrictEqual(out.exits, [1]);
});

test('a timeout destroys the request, reports it and exits 1', async () => {
  const out = await run('g', { timeout: true });

  assert.strictEqual(out.seen.destroyed, true);
  assert.deepStrictEqual(out.errors, ['✗ Error: Request timeout after 120s']);
  assert.deepStrictEqual(out.exits, [1]);
});

after(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});
