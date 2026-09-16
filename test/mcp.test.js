'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function startHttpMock(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      let body = null;
      if (text) {
        try { body = JSON.parse(text); } catch { body = text; }
      }
      const request = {
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        body,
      };
      requests.push(request);
      Promise.resolve()
        .then(() => handler(request))
        .catch((error) => ({ status: 500, body: { error: String(error.message || error) } }))
        .then((response) => {
          res.statusCode = response?.status || 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(response?.body || {}));
        });
    });
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, requests });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

// Spawns `atris mcp`, sends initialize + initialized + the given requests over
// stdio, and closes stdin once the response for `closeAfterId` lands. Resolves
// every parsed response message. Rejects on any stdout line that is not valid
// JSON-RPC, since a clean stream is the contract this test guards.
function mcpSession(requests, { extraEnv = {}, closeAfterId, timeout = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mcp-'));
    const child = spawn(process.execPath, [cliPath, 'mcp'], {
      env: {
        ...process.env,
        HOME: home,
        ATRIS_SKIP_UPDATE_CHECK: '1',
        ATRIS_NONINTERACTIVE: '1',
        ATRIS_TOKEN: '',
        ATRIS_PROFILE: '',
        ATRIS_API_KEY: 'test-design-key',
        ...extraEnv,
      },
    });
    let stdout = '';
    let stderr = '';
    const finish = () => {
      try { child.stdin.end(); } catch { /* already closed */ }
    };
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.split('\n').some((line) => {
        try { return JSON.parse(line).id === closeAfterId; } catch { return false; }
      })) finish();
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`mcp server hung past ${timeout}ms. stderr: ${stderr}`));
    }, timeout);

    const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'atris-test', version: '0.0.0' },
      },
    });
    send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    for (const request of requests) send(request);

    child.on('error', (error) => {
      clearTimeout(timer);
      fs.rmSync(home, { recursive: true, force: true });
      reject(error);
    });
    child.on('close', () => {
      clearTimeout(timer);
      fs.rmSync(home, { recursive: true, force: true });
      const messages = [];
      for (const line of stdout.split('\n').map((l) => l.trim()).filter(Boolean)) {
        try {
          messages.push(JSON.parse(line));
        } catch {
          reject(new Error(`non-json line on mcp stdout: ${line}. full stdout: ${stdout}`));
          return;
        }
      }
      resolve({ messages, stdout, stderr });
    });
  });
}

test('atris mcp lists the three design tools over stdio', async () => {
  const { messages, stderr } = await mcpSession(
    [{ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }],
    { closeAfterId: 2 },
  );
  const init = messages.find((m) => m.id === 1);
  assert.ok(init && init.result, `no initialize response. stderr: ${stderr}`);
  const list = messages.find((m) => m.id === 2);
  assert.ok(list && list.result && Array.isArray(list.result.tools), `no tools/list response. stderr: ${stderr}`);
  const names = list.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['design_check', 'design_extract', 'design_search']);
  const extract = list.result.tools.find((t) => t.name === 'design_extract');
  assert.deepEqual(extract.inputSchema.required, ['url']);
});

test('atris mcp tools/call runs design_search against the mocked api', async () => {
  const mock = await startHttpMock((request) => {
    if (request.url === '/api/design/search' && request.method === 'POST') {
      assert.equal(request.authorization, 'Bearer test-design-key');
      assert.deepEqual(request.body, { query: 'developer tools' });
      return {
        status: 200,
        body: {
          results: [{ brand_name: 'Supabase', source_url: 'https://supabase.com' }],
          atris: { credits_charged: 1, balance_remaining_usd: 42.49 },
        },
      };
    }
    return { status: 404, body: { error: `unexpected ${request.url}` } };
  });

  try {
    const { messages, stderr } = await mcpSession(
      [{
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'design_search', arguments: { query: 'developer tools' } },
      }],
      { closeAfterId: 3, extraEnv: { ATRIS_API_URL: `http://127.0.0.1:${mock.port}/api` } },
    );
    const call = messages.find((m) => m.id === 3);
    assert.ok(call && call.result && Array.isArray(call.result.content),
      `no tools/call response. stderr: ${stderr}`);
    assert.equal(call.result.isError, undefined);
    const text = call.result.content[0].text;
    assert.match(text, /Supabase/);
    assert.match(text, /"credits_charged": 1/);
    assert.match(text, /"balance_remaining_usd": 42\.49/);
  } finally {
    await closeServer(mock.server);
  }
});

test('atris mcp tools/call rides out transient poll failures', async () => {
  let polls = 0;
  const mock = await startHttpMock((request) => {
    if (request.url === '/api/design/extractions' && request.method === 'POST') {
      return { status: 202, body: { id: 'job-6', status: 'accepted' } };
    }
    if (request.url === '/api/design/extractions/job-6') {
      polls += 1;
      if (polls <= 2) return { status: 500, body: { error: 'backend blip' } };
      return {
        status: 200,
        body: {
          id: 'job-6',
          status: 'completed',
          source_url: 'https://stripe.com',
          result: { design_system: { profile: { brand_name: 'Stripe' } } },
          atris: { credits_charged: 10, balance_remaining_usd: 42.4 },
        },
      };
    }
    return { status: 404, body: { error: `unexpected ${request.url}` } };
  });

  try {
    const { messages, stderr } = await mcpSession(
      [{
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'design_extract', arguments: { url: 'https://stripe.com' } },
      }],
      { closeAfterId: 4, extraEnv: { ATRIS_API_URL: `http://127.0.0.1:${mock.port}/api` }, timeout: 30000 },
    );
    const call = messages.find((m) => m.id === 4);
    assert.ok(call && call.result && Array.isArray(call.result.content),
      `no tools/call response. stderr: ${stderr}`);
    assert.equal(call.result.isError, undefined);
    assert.ok(polls >= 3, `expected the poll loop to retry past the blips, got ${polls} poll(s)`);
    assert.match(call.result.content[0].text, /Stripe/);
  } finally {
    await closeServer(mock.server);
  }
});

test('atris mcp tools/call error names the job id and poll path', async () => {
  const mock = await startHttpMock((request) => {
    if (request.url === '/api/design/extractions' && request.method === 'POST') {
      return { status: 202, body: { id: 'job-8', status: 'accepted' } };
    }
    if (request.url === '/api/design/extractions/job-8') {
      return { status: 500, body: { error: 'backend down' } };
    }
    return { status: 404, body: { error: `unexpected ${request.url}` } };
  });

  try {
    const { messages, stderr } = await mcpSession(
      [{
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'design_extract', arguments: { url: 'https://stripe.com' } },
      }],
      { closeAfterId: 5, extraEnv: { ATRIS_API_URL: `http://127.0.0.1:${mock.port}/api` }, timeout: 30000 },
    );
    const call = messages.find((m) => m.id === 5);
    assert.ok(call && call.result, `no tools/call response. stderr: ${stderr}`);
    assert.equal(call.result.isError, true);
    const text = call.result.content[0].text;
    assert.match(text, /job-8/);
    assert.match(text, /\/design\/extractions\/job-8/);
  } finally {
    await closeServer(mock.server);
  }
});
