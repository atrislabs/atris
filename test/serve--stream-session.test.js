'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { streamSession } = require('../commands/serve');

const ENV_KEYS = [
  'HOME',
  'ATRIS_API_URL',
  'ATRIS_BACKEND_URL',
  'ATRIS_TOKEN',
  'ATRIS_PROFILE',
  'ATRIS_AGENT_TOKEN_FILE',
  'ATRIS_CLIENT_ID',
  'ATRIS_CLIENT_SECRET',
  'ATRIS_CLIENT_SECRET_FILE',
];

function isolateEnv(t) {
  const saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-serve-home-'));
  process.env.HOME = home;
  const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-serve-wd-'));
  t.after(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
  return workingDir;
}

// One loopback server that answers the SSE events route, the ack route,
// and the registry route. Loopback only, no external network.
async function startServer(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => resolve(body));
  });
}

test('streamSession applies a write op and posts an ok ack', async (t) => {
  const workingDir = isolateEnv(t);
  const sessionId = 'sess-test-1';
  const token = 'tok-test';
  const acks = [];
  const eventsHeaders = [];
  let ackResolve;
  const ackSeen = new Promise((resolve) => { ackResolve = resolve; });

  const base = await startServer(t, (req, res) => {
    if (req.url === `/api/cli/sessions/${sessionId}/events`) {
      eventsHeaders.push(req.headers);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"type":"hello"}\n\n');
      res.write('data: {"type":"ping"}\n\n');
      res.write('data: {"op_id":"op-1","type":"write","path":"sub/dir/hello.txt","content":"hello world"}\n\n');
      // End the stream once the client has acked, so the promise resolves
      // only after the op was fully applied.
      ackSeen.then(() => res.end());
      return;
    }
    if (req.url === `/api/cli/sessions/${sessionId}/ack` && req.method === 'POST') {
      readBody(req).then((body) => {
        acks.push({ body: JSON.parse(body), auth: req.headers.authorization });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
        ackResolve();
      });
      return;
    }
    if (req.url === '/api/cli/sessions') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sessions: [{ id: sessionId }] }));
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });

  process.env.ATRIS_API_URL = `${base}/api`;

  await streamSession(token, sessionId, workingDir);
  await ackSeen;

  const written = path.join(workingDir, 'sub', 'dir', 'hello.txt');
  assert.equal(fs.readFileSync(written, 'utf8'), 'hello world');

  assert.equal(acks.length, 1);
  assert.equal(acks[0].auth, `Bearer ${token}`);
  assert.deepEqual(acks[0].body, {
    op_id: 'op-1',
    status: 'ok',
    result: { bytes_written: 11 },
  });

  assert.equal(eventsHeaders[0].authorization, `Bearer ${token}`);
  assert.equal(eventsHeaders[0].accept, 'text/event-stream');
});

test('streamSession skips malformed frames and acks an escaping path with an error', async (t) => {
  const workingDir = isolateEnv(t);
  const sessionId = 'sess-test-2';
  const acks = [];
  let ackResolve;
  const ackSeen = new Promise((resolve) => { ackResolve = resolve; });

  const base = await startServer(t, (req, res) => {
    if (req.url === `/api/cli/sessions/${sessionId}/events`) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {not json at all}\n\n');
      res.write('data: \n\n');
      res.write('data: {"op_id":"op-2","type":"write","path":"../escape.txt","content":"x"}\n\n');
      ackSeen.then(() => res.end());
      return;
    }
    if (req.url === `/api/cli/sessions/${sessionId}/ack` && req.method === 'POST') {
      readBody(req).then((body) => {
        acks.push(JSON.parse(body));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
        ackResolve();
      });
      return;
    }
    if (req.url === '/api/cli/sessions') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sessions: [{ id: sessionId }] }));
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });

  process.env.ATRIS_API_URL = `${base}/api`;

  await streamSession('tok-test', sessionId, workingDir);
  await ackSeen;

  // Exactly one ack, for the escaping path op only.
  assert.equal(acks.length, 1);
  assert.equal(acks[0].op_id, 'op-2');
  assert.equal(acks[0].status, 'error');
  assert.match(acks[0].result.error, /\.\./);

  // Nothing written inside or outside the working dir.
  assert.deepEqual(fs.readdirSync(workingDir), []);
  assert.equal(fs.existsSync(path.join(workingDir, '..', 'escape.txt')), false);
});

test('streamSession rejects when the events endpoint is not 200', async (t) => {
  const workingDir = isolateEnv(t);
  const sessionId = 'sess-gone';

  const base = await startServer(t, (req, res) => {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('session not found');
  });

  process.env.ATRIS_API_URL = `${base}/api`;

  await assert.rejects(
    streamSession('tok-test', sessionId, workingDir),
    (err) => {
      assert.match(err.message, /SSE failed: 404/);
      assert.match(err.message, /session not found/);
      return true;
    },
  );
});
