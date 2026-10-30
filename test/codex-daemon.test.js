'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const {
  CLIENT_METHODS,
  CodexDaemonClient,
  FrameReader,
  OPCODE,
  UPGRADE_PATH,
  activityLine,
  connectCodexDaemon,
  encodeFrame,
  parseUpgradeResponse,
  resumeCodexThread,
  runCodexTurn,
  serverRequestDecline,
  startCodexThread,
  upgradeRequest,
  verifyUpgradeResponse,
  websocketAccept,
} = require('../lib/codex-daemon');

const FAKE_PROXY = path.join(__dirname, 'helpers', 'fake-codex-proxy.js');
// A fresh node child can take seconds to boot on a busy machine.
const CHILD_BOOT_MS = 15000;

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-codex-daemon-'));
}

function readLog(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function sentMethods(file) {
  return readLog(file).filter((entry) => entry.dir === 'in').map((entry) => entry.message.method || `answer:${entry.message.id}`);
}

function fakeConnect(logFile, script = {}, extra = {}) {
  return connectCodexDaemon({
    bin: process.execPath,
    args: [FAKE_PROXY, '--serve'],
    env: { ...process.env, FAKE_CODEX_LOG: logFile, FAKE_CODEX_SCRIPT: JSON.stringify(script) },
    connectTimeoutMs: CHILD_BOOT_MS,
    ...extra,
  });
}

// A client wired to an in-memory child, for frame-level checks.
function memoryClient() {
  const written = [];
  const child = new EventEmitter();
  child.stdin = { destroyed: false, write: (bytes) => { written.push(Buffer.from(bytes)); return true; }, end() {}, on() {} };
  child.exitCode = 0;
  child.signalCode = null;
  const client = new CodexDaemonClient({ child, mask: () => Buffer.from([1, 2, 3, 4]) });
  const sent = () => written.map((bytes) => {
    const [frame] = new FrameReader().push(bytes);
    return frame;
  });
  return { client, written, sent };
}

test('websocket handshake matches RFC 6455 and always targets "/"', () => {
  // RFC 6455 section 1.3 sample key and accept value.
  assert.equal(websocketAccept('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  const request = upgradeRequest('dGhlIHNhbXBsZSBub25jZQ==');
  assert.equal(UPGRADE_PATH, '/');
  assert.match(request, /^GET \/ HTTP\/1\.1\r\n/);
  assert.match(request, /\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n/);
  assert.match(request, /\r\nSec-WebSocket-Version: 13\r\n/);
  assert.match(request, /\r\n\r\n$/);
  // The daemon reads this path as a stop request; the client must never send it.
  assert.doesNotMatch(request, /daemon\/shutdown/);
});

test('upgrade response parsing waits for the blank line and keeps trailing frame bytes', () => {
  const key = 'dGhlIHNhbXBsZSBub25jZQ==';
  const head = `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${websocketAccept(key)}\r\n\r\n`;
  assert.equal(parseUpgradeResponse(Buffer.from(head.slice(0, 40))), null);
  const frameBytes = Buffer.from([0x81, 0x02, 0x7b, 0x7d]);
  const parsed = parseUpgradeResponse(Buffer.concat([Buffer.from(head), frameBytes]));
  assert.equal(parsed.status, 101);
  assert.deepEqual([...parsed.rest], [...frameBytes]);
  verifyUpgradeResponse(parsed, key);

  assert.throws(() => verifyUpgradeResponse({ ...parsed, headers: { ...parsed.headers, 'sec-websocket-accept': 'wrong' } }, key), /wrong websocket accept key/);
  assert.throws(() => verifyUpgradeResponse({ status: 403, statusText: 'Forbidden', headers: {} }, key), (error) => error.reason === 'handshake_failed' && /403/.test(error.message));
});

test('client frames are masked and server frames decode across any chunking', () => {
  // RFC 6455 section 5.7: a masked "Hello" with mask 37 fa 21 3d.
  const masked = encodeFrame(OPCODE.TEXT, 'Hello', Buffer.from([0x37, 0xfa, 0x21, 0x3d]));
  assert.deepEqual([...masked], [0x81, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58]);

  // The unmasked server "Hello", fed one byte at a time.
  const reader = new FrameReader();
  const unmasked = Buffer.from([0x81, 0x05, 0x48, 0x65, 0x6c, 0x6c, 0x6f]);
  const frames = [];
  for (const byte of unmasked) frames.push(...reader.push(Buffer.from([byte])));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].payload.toString(), 'Hello');
  assert.equal(frames[0].fin, true);

  // 16-bit and 64-bit lengths round trip through the masked encoder.
  for (const size of [125, 126, 300, 65535, 65536, 70000]) {
    const payload = Buffer.alloc(size, 0x61);
    const [decoded] = new FrameReader().push(encodeFrame(OPCODE.TEXT, payload));
    assert.equal(decoded.payload.length, size, `size ${size}`);
    assert.ok(decoded.payload.equals(payload));
  }

  // Two frames in one chunk come out as two frames.
  const pair = Buffer.concat([Buffer.from([0x81, 0x01, 0x61]), Buffer.from([0x81, 0x01, 0x62])]);
  assert.deepEqual(new FrameReader().push(pair).map((frame) => frame.payload.toString()), ['a', 'b']);
});

test('fragmented messages assemble and pings get pongs', () => {
  const { client, sent } = memoryClient();
  const seen = [];
  client.on('notification', (message) => seen.push(message));
  const text = JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: 't', delta: 'hi' } });
  client.receive(Buffer.from([0x89, 0x02, 0x70, 0x6f]));
  client.receive(Buffer.concat([Buffer.from([0x01, 10]), Buffer.from(text.slice(0, 10))]));
  client.receive(Buffer.concat([Buffer.from([0x80, text.length - 10]), Buffer.from(text.slice(10))]));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].params.delta, 'hi');
  const [pong] = sent();
  assert.equal(pong.opcode, OPCODE.PONG);
  assert.equal(pong.payload.toString(), 'po');
});

test('the client refuses every method that could change the shared daemon', async () => {
  const { client, written } = memoryClient();
  for (const method of ['config/value/write', 'config/batchWrite', 'thread/archive', 'thread/delete', 'plugin/install', 'account/logout', 'experimentalFeature/enablement/set']) {
    await assert.rejects(client.request(method, {}), (error) => error.reason === 'method_not_allowed', method);
  }
  assert.equal(written.length, 0, 'nothing reaches the daemon');
  assert.deepEqual([...CLIENT_METHODS].sort(), ['initialize', 'thread/name/set', 'thread/resume', 'thread/start', 'turn/interrupt', 'turn/start']);
});

test('approval and input requests from codex get a no, never a hang', () => {
  assert.deepEqual(serverRequestDecline('item/commandExecution/requestApproval'), { decision: 'decline' });
  assert.deepEqual(serverRequestDecline('item/fileChange/requestApproval'), { decision: 'decline' });
  assert.deepEqual(serverRequestDecline('execCommandApproval'), { decision: 'denied' });
  assert.deepEqual(serverRequestDecline('mcpServer/elicitation/request'), { action: 'decline' });
  assert.equal(serverRequestDecline('item/tool/requestUserInput'), null);

  const { client, sent } = memoryClient();
  client.dispatch({ id: 7, method: 'item/tool/requestUserInput', params: {} });
  client.dispatch({ id: 8, method: 'item/fileChange/requestApproval', params: {} });
  const [first, second] = sent().map((frame) => JSON.parse(frame.payload.toString()));
  assert.deepEqual(first, { id: 7, error: { code: -32601, message: 'atris does not answer item/tool/requestUserInput' } });
  assert.deepEqual(second, { id: 8, result: { decision: 'decline' } });
});

test('tool steps become short plain lines', () => {
  assert.equal(activityLine({ type: 'commandExecution', command: 'git   status' }), 'ran: git status');
  assert.equal(activityLine({ type: 'mcpToolCall', server: 'cua_repl', tool: 'js' }), 'tool: cua_repl js');
  assert.equal(activityLine({ type: 'fileChange', changes: [{}, {}] }), 'edit: 2 files');
  assert.equal(activityLine({ type: 'reasoning' }), '');
  assert.equal(activityLine({ type: 'commandExecution', command: 'x'.repeat(300) }).length, 'ran: '.length + 140);
});

test('a real child proxy: handshake, initialize, thread start, and a streamed turn', async () => {
  const dir = tempDir();
  const logFile = path.join(dir, 'fake.jsonl');
  const client = await fakeConnect(logFile, { reply: ['Hel', 'lo ', 'there'], fragment: true });
  try {
    assert.equal(client.serverInfo.userAgent, 'fake-codex/0.0.0');
    const thread = await startCodexThread(client, { cwd: dir, approvalPolicy: 'never', sandbox: 'read-only' });
    assert.equal(thread.thread_id, 'thread-new-1');
    const chunks = [];
    const activity = [];
    const result = await runCodexTurn(client, {
      threadId: thread.thread_id,
      prompt: 'say hello',
      effort: 'medium',
      timeoutMs: CHILD_BOOT_MS,
      onText: (chunk) => chunks.push(chunk),
      onActivity: (line) => activity.push(line),
    });
    assert.equal(result.status, 'completed');
    assert.equal(result.turn_id, 'turn-1');
    assert.equal(result.text, 'Hello there');
    assert.deepEqual(chunks, ['Hel', 'lo ', 'there'], 'deltas stream in order, and the other thread\'s LEAK never shows');
    assert.deepEqual(activity, ['ran: ls -la']);
  } finally {
    await client.close();
  }
  const entries = readLog(logFile);
  assert.deepEqual(entries.find((entry) => entry.dir === 'handshake'), { dir: 'handshake', requestLine: 'GET / HTTP/1.1' });
  assert.deepEqual(sentMethods(logFile), ['initialize', 'initialized', 'thread/start', 'turn/start']);
  const turnStart = entries.find((entry) => entry.dir === 'in' && entry.message.method === 'turn/start').message;
  assert.deepEqual(turnStart.params, { threadId: 'thread-new-1', input: [{ type: 'text', text: 'say hello' }], effort: 'medium' });
  assert.ok(entries.some((entry) => entry.dir === 'pong'), 'the ping got a pong');
  assert.ok(entries.some((entry) => entry.dir === 'close'), 'close sends a websocket close frame');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a turn whose message arrives only as a completed item still prints it', async () => {
  const dir = tempDir();
  const logFile = path.join(dir, 'fake.jsonl');
  const client = await fakeConnect(logFile, { reply: ['whole answer'], noDeltas: true });
  try {
    const resumed = await resumeCodexThread(client, { threadId: 'thread-old-9' });
    assert.equal(resumed.thread_id, 'thread-old-9');
    const chunks = [];
    const result = await runCodexTurn(client, { threadId: 'thread-old-9', prompt: 'x', onText: (chunk) => chunks.push(chunk), timeoutMs: CHILD_BOOT_MS });
    assert.equal(result.text, 'whole answer');
    assert.deepEqual(chunks, ['whole answer']);
  } finally {
    await client.close();
  }
  const resume = readLog(logFile).find((entry) => entry.dir === 'in' && entry.message.method === 'thread/resume').message;
  assert.equal(resume.params.excludeTurns, true, 'a resume skips the history it does not need');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a mid-turn approval request is answered no and the turn goes on', async () => {
  const dir = tempDir();
  const logFile = path.join(dir, 'fake.jsonl');
  const notices = [];
  const client = await fakeConnect(logFile, { approvalRequest: true });
  client.on('notice', (line) => notices.push(line));
  try {
    const result = await runCodexTurn(client, { threadId: 't1', prompt: 'x', timeoutMs: CHILD_BOOT_MS });
    assert.equal(result.status, 'completed');
  } finally {
    await client.close();
  }
  const answer = readLog(logFile).find((entry) => entry.dir === 'answer').answer;
  assert.deepEqual(answer.result, { decision: 'decline' });
  assert.match(notices.join('\n'), /atris answered no/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a deadline interrupts the turn on the daemon and reports a timeout', async () => {
  const dir = tempDir();
  const logFile = path.join(dir, 'fake.jsonl');
  const client = await fakeConnect(logFile, { hangTurn: true });
  try {
    const result = await runCodexTurn(client, { threadId: 't1', prompt: 'x', timeoutMs: 300 });
    assert.equal(result.status, 'timeout');
    assert.match(result.error, /time limit/);
  } finally {
    await client.close();
  }
  const interrupt = readLog(logFile).find((entry) => entry.dir === 'in' && entry.message.method === 'turn/interrupt');
  assert.deepEqual(interrupt.message.params, { threadId: 't1', turnId: 'turn-1' });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an abort signal (ctrl-c) interrupts the turn and reports interrupted', async () => {
  const dir = tempDir();
  const logFile = path.join(dir, 'fake.jsonl');
  const client = await fakeConnect(logFile, { hangTurn: true });
  const abort = new AbortController();
  try {
    const pending = runCodexTurn(client, { threadId: 't1', prompt: 'x', signal: abort.signal, timeoutMs: CHILD_BOOT_MS });
    setTimeout(() => abort.abort(), 200);
    const result = await pending;
    assert.equal(result.status, 'interrupted');
  } finally {
    await client.close();
  }
  assert.ok(sentMethods(logFile).includes('turn/interrupt'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an unreachable daemon rejects with a reason the caller can fall back on', async () => {
  const dir = tempDir();
  const logFile = path.join(dir, 'fake.jsonl');
  await assert.rejects(fakeConnect(logFile, { exitImmediately: true }), (error) => {
    assert.equal(error.reason, 'proxy_exited');
    assert.match(error.message, /failed to connect to socket/);
    return true;
  });
  await assert.rejects(fakeConnect(logFile, { silent: true }, { connectTimeoutMs: 400 }), (error) => error.reason === 'connect_timeout');
  await assert.rejects(connectCodexDaemon({ bin: path.join(dir, 'no-such-codex'), connectTimeoutMs: CHILD_BOOT_MS }), (error) => error.reason === 'not_installed');
  fs.rmSync(dir, { recursive: true, force: true });
});
