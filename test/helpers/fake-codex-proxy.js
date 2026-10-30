'use strict';

// A stand-in for `codex app-server proxy` plus the daemon behind it: a
// WebSocket server on stdio that answers the app-server JSON-RPC calls with
// scripted results. Its framing is written separately from lib/codex-daemon.js
// on purpose, so a bug shared by both sides cannot hide.
//
// Serves only when run directly with --serve. `node --test` runs every .js
// under test/, and the pre-commit load check require()s staged files; both
// must find a module that does nothing and exits on its own.
//
// env FAKE_CODEX_LOG     jsonl file; every message in and out is appended
// env FAKE_CODEX_SCRIPT  json options:
//   exitImmediately  print a socket error and exit 1 before the handshake
//   silent           never answer the handshake
//   reply            text chunks streamed as agent message deltas
//   resumeError      thread/resume fails with this message
//   startError       thread/start fails with this message
//   hangTurn         the turn runs until turn/interrupt arrives
//   fragment         split one delta across frames and send a ping first
//   approvalRequest  ask an approval mid-turn and wait for the answer
//   noDeltas         send the agent message only as a completed item

const crypto = require('crypto');
const fs = require('fs');

function serve() {
  const script = JSON.parse(process.env.FAKE_CODEX_SCRIPT || '{}');
  const logFile = process.env.FAKE_CODEX_LOG || '';
  const log = (entry) => {
    if (logFile) fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
  };

  if (script.exitImmediately) {
    process.stderr.write('Error: failed to connect to socket at /fake/app-server-control.sock\n');
    process.exit(1);
  }

  let buffer = Buffer.alloc(0);
  let upgraded = false;
  let parts = null;
  let turnCount = 0;
  let liveTurn = null;
  let serverRequestId = 1000;
  const waitingAnswers = new Map();

  function frame(opcode, payload) {
    const data = Buffer.from(payload);
    let header;
    if (data.length < 126) header = Buffer.from([0x80 | opcode, data.length]);
    else if (data.length < 65536) {
      header = Buffer.from([0x80 | opcode, 126, 0, 0]);
      header.writeUInt16BE(data.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(data.length), 2);
    }
    return Buffer.concat([header, data]);
  }

  function send(message) {
    log({ dir: 'out', message });
    process.stdout.write(frame(0x1, JSON.stringify(message)));
  }

  function notify(method, params) {
    send({ method, params });
  }

  function handshake() {
    const end = buffer.indexOf('\r\n\r\n');
    if (end < 0) return;
    const head = buffer.subarray(0, end).toString('latin1');
    buffer = buffer.subarray(end + 4);
    const lines = head.split('\r\n');
    const requestLine = lines[0];
    log({ dir: 'handshake', requestLine });
    if (requestLine !== 'GET / HTTP/1.1') {
      log({ dir: 'error', error: `unexpected upgrade path: ${requestLine}` });
      process.exit(3);
    }
    const keyLine = lines.find((line) => /^sec-websocket-key:/i.test(line)) || '';
    const key = keyLine.split(':').slice(1).join(':').trim();
    const accept = crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    if (script.silent) return;
    process.stdout.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '',
      '',
    ].join('\r\n'));
    upgraded = true;
  }

  function readFrames() {
    for (;;) {
      if (buffer.length < 2) return;
      const fin = (buffer[0] & 0x80) !== 0;
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (!masked) {
        log({ dir: 'error', error: 'client frame was not masked' });
        process.exit(4);
      }
      if (buffer.length < offset + 4 + length) return;
      const mask = buffer.subarray(offset, offset + 4);
      const payload = Buffer.alloc(length);
      for (let index = 0; index < length; index += 1) payload[index] = buffer[offset + 4 + index] ^ mask[index % 4];
      buffer = buffer.subarray(offset + 4 + length);
      if (opcode === 0x8) {
        log({ dir: 'close' });
        process.stdout.write(frame(0x8, payload.subarray(0, 2)));
        setTimeout(() => process.exit(0), 20);
        return;
      }
      if (opcode === 0xa) {
        log({ dir: 'pong', payload: payload.toString('utf8') });
        continue;
      }
      if (opcode === 0x1) parts = [payload];
      else if (opcode === 0x0 && parts) parts.push(payload);
      else continue;
      if (!fin) continue;
      const text = Buffer.concat(parts).toString('utf8');
      parts = null;
      const message = JSON.parse(text);
      log({ dir: 'in', message });
      handle(message);
    }
  }

  function threadResult(id, params = {}) {
    return {
      thread: { id, cwd: params.cwd || '/fake', model: params.model || 'gpt-fake', status: { type: 'idle' }, turns: [] },
      model: params.model || 'gpt-fake',
      modelProvider: 'openai',
      cwd: params.cwd || '/fake',
      approvalPolicy: params.approvalPolicy || 'never',
      approvalsReviewer: 'user',
      sandbox: { type: params.sandbox === 'read-only' ? 'readOnly' : 'dangerFullAccess' },
    };
  }

  function completeTurn(threadId, turnId, status = 'completed', error = null) {
    notify('turn/completed', { threadId, turn: { id: turnId, items: [], status, error } });
    liveTurn = null;
  }

  function streamTurn(threadId, turnId) {
    const chunks = Array.isArray(script.reply) ? script.reply : ['O', 'K'];
    const itemId = `msg-${turnId}`;
    notify('turn/started', { threadId, turn: { id: turnId, items: [], status: 'inProgress' } });
    notify('item/started', { threadId, turnId, item: { type: 'commandExecution', id: `cmd-${turnId}`, command: 'ls -la', commandActions: [], cwd: '/fake', status: 'inProgress' } });
    notify('item/started', { threadId, turnId, item: { type: 'agentMessage', id: itemId, text: '' } });
    if (script.noDeltas) {
      notify('item/completed', { threadId, turnId, item: { type: 'agentMessage', id: itemId, text: chunks.join('') } });
      completeTurn(threadId, turnId);
      return;
    }
    chunks.forEach((delta, index) => {
      const message = { method: 'item/agentMessage/delta', params: { threadId, turnId, itemId, delta } };
      if (script.fragment && index === 0) {
        process.stdout.write(frame(0x9, 'are you there'));
        const raw = Buffer.from(JSON.stringify(message));
        const cut = Math.floor(raw.length / 2);
        log({ dir: 'out', message, fragmented: true });
        process.stdout.write(Buffer.concat([Buffer.from([0x01, cut]), raw.subarray(0, cut)]));
        process.stdout.write(Buffer.concat([Buffer.from([0x80, raw.length - cut]), raw.subarray(cut)]));
        return;
      }
      send(message);
    });
    notify('item/completed', { threadId, turnId, item: { type: 'agentMessage', id: itemId, text: chunks.join('') } });
    completeTurn(threadId, turnId);
  }

  function handle(message) {
    if (message.id !== undefined && !message.method) {
      const waiting = waitingAnswers.get(message.id);
      if (waiting) {
        waitingAnswers.delete(message.id);
        waiting(message);
      }
      return;
    }
    const { id, method, params = {} } = message;
    if (id === undefined) return;
    if (method === 'initialize') {
      send({ id, result: { userAgent: 'fake-codex/0.0.0', codexHome: '/fake/.codex', platformFamily: 'unix', platformOs: 'macos' } });
      return;
    }
    if (method === 'thread/start') {
      if (script.startError) {
        send({ id, error: { code: -32600, message: script.startError } });
        return;
      }
      send({ id, result: threadResult('thread-new-1', params) });
      notify('thread/started', { thread: { id: 'thread-new-1' } });
      return;
    }
    if (method === 'thread/resume') {
      if (script.resumeError) {
        send({ id, error: { code: -32600, message: script.resumeError } });
        return;
      }
      send({ id, result: threadResult(params.threadId, params) });
      return;
    }
    if (method === 'thread/name/set') {
      send({ id, result: {} });
      return;
    }
    if (method === 'turn/start') {
      turnCount += 1;
      const turnId = `turn-${turnCount}`;
      liveTurn = { threadId: params.threadId, turnId };
      send({ id, result: { turn: { id: turnId, items: [], status: 'inProgress', error: null } } });
      // A notification for some other thread must not leak into this turn.
      notify('item/agentMessage/delta', { threadId: 'someone-else', turnId: 'other', itemId: 'x', delta: 'LEAK' });
      if (script.hangTurn) {
        notify('turn/started', { threadId: params.threadId, turn: { id: turnId, items: [], status: 'inProgress' } });
        return;
      }
      if (script.approvalRequest) {
        const requestId = serverRequestId;
        serverRequestId += 1;
        waitingAnswers.set(requestId, (answer) => {
          log({ dir: 'answer', answer });
          streamTurn(params.threadId, turnId);
        });
        send({ id: requestId, method: 'item/commandExecution/requestApproval', params: { threadId: params.threadId, turnId, itemId: 'cmd-1', command: 'rm -rf /' } });
        return;
      }
      setTimeout(() => streamTurn(params.threadId, turnId), 5);
      return;
    }
    if (method === 'turn/interrupt') {
      send({ id, result: {} });
      if (liveTurn) completeTurn(liveTurn.threadId, liveTurn.turnId, 'interrupted', null);
      return;
    }
    send({ id, error: { code: -32601, message: `fake does not know ${method}` } });
  }

  process.stdin.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (!upgraded) handshake();
    if (upgraded) readFrames();
  });
  process.stdin.on('end', () => process.exit(0));
}

if (require.main === module && process.argv[2] === '--serve') serve();
