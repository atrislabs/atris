'use strict';

// Codex app-server daemon client: one warm Codex for many turns.
//
// A plain Atris Codex call is a cold `codex exec`: a new process loads config,
// auth, plugins, and MCP servers before the model reads a word. The owner's
// Mac already runs one shared Codex app-server daemon (the Codex desktop app
// uses it too), so a thread there answers without paying that boot again.
//
// Transport, read from the codex source and checked against codex-cli 0.166.0:
//   - `codex app-server proxy` relays raw stdio bytes to the daemon's control
//     socket (codex-rs/stdio-to-uds), and that socket speaks WebSocket
//     (codex-rs/app-server-transport/src/transport/unix_socket.rs). So this
//     client sends the HTTP upgrade itself, masks every frame it writes, and
//     carries one JSON-RPC message per text frame.
//   - Method and notification names come from `codex app-server
//     generate-json-schema`, not from guesses.
//
// The daemon is shared, so this client never stops, restarts, or reconfigures
// it. The upgrade path is always "/" because the daemon reads
// "/daemon/shutdown" as a stop request, and request() refuses any method that
// is not in CLIENT_METHODS (no config writes, no plugin installs, no logout).

const crypto = require('crypto');
const { EventEmitter } = require('events');
const { spawn } = require('child_process');

const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const UPGRADE_PATH = '/';
const OPCODE = Object.freeze({ CONTINUATION: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa });
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
const MAX_HANDSHAKE_BYTES = 64 * 1024;
const CONNECT_TIMEOUT_MS = 15000;
const REQUEST_TIMEOUT_MS = 120000;
const CLOSE_GRACE_MS = 1500;
const INTERRUPT_GRACE_MS = 3000;

// Everything this client may ask the daemon to do. Each one acts on this
// connection or on a thread this client started or named; none changes the
// daemon's own settings.
const CLIENT_METHODS = Object.freeze([
  'initialize',
  'thread/start',
  'thread/resume',
  'thread/name/set',
  'turn/start',
  'turn/interrupt',
]);
const CLIENT_NOTIFICATIONS = Object.freeze(['initialized']);
const TERMINAL_TURN_STATUSES = new Set(['completed', 'interrupted', 'failed']);

function daemonError(reason, message, extra = {}) {
  const error = new Error(message);
  error.reason = reason;
  Object.assign(error, extra);
  return error;
}

// ---------------------------------------------------------------------------
// WebSocket framing (RFC 6455), client side.

function websocketKey(randomBytes = crypto.randomBytes) {
  return randomBytes(16).toString('base64');
}

function websocketAccept(key) {
  return crypto.createHash('sha1').update(`${key}${WEBSOCKET_GUID}`).digest('base64');
}

function upgradeRequest(key) {
  return [
    `GET ${UPGRADE_PATH} HTTP/1.1`,
    'Host: localhost',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13',
    '',
    '',
  ].join('\r\n');
}

// The HTTP answer to the upgrade. Returns null until the blank line arrives;
// `rest` is whatever frame bytes came in the same chunk.
function parseUpgradeResponse(buffer) {
  const end = buffer.indexOf('\r\n\r\n');
  if (end < 0) {
    if (buffer.length > MAX_HANDSHAKE_BYTES) throw daemonError('handshake_failed', 'the daemon sent an oversized handshake');
    return null;
  }
  const lines = buffer.subarray(0, end).toString('latin1').split('\r\n');
  const status = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/.exec(lines[0] || '');
  const headers = {};
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':');
    if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return {
    status: status ? Number(status[1]) : 0,
    statusText: status ? String(status[2] || '') : String(lines[0] || ''),
    headers,
    rest: buffer.subarray(end + 4),
  };
}

function verifyUpgradeResponse(response, key) {
  if (response.status !== 101) {
    throw daemonError('handshake_failed', `the daemon refused the connection (${response.status || 'no status'} ${response.statusText}`.trim() + ')');
  }
  if (String(response.headers.upgrade || '').toLowerCase() !== 'websocket') {
    throw daemonError('handshake_failed', 'the daemon did not switch to websocket');
  }
  if (response.headers['sec-websocket-accept'] !== websocketAccept(key)) {
    throw daemonError('handshake_failed', 'the daemon answered with the wrong websocket accept key');
  }
}

// One frame, FIN set. Client frames must be masked (RFC 6455 5.3).
function encodeFrame(opcode, payload = Buffer.alloc(0), mask = crypto.randomBytes(4)) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const length = data.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | (opcode & 0x0f);
  const masked = Buffer.alloc(length);
  for (let index = 0; index < length; index += 1) masked[index] = data[index] ^ mask[index & 3];
  return Buffer.concat([header, mask, masked]);
}

// Turns a byte stream into frames. Server frames arrive unmasked, but a
// masked one is unmasked too so a test peer can be lazy.
class FrameReader {
  constructor({ maxBytes = MAX_MESSAGE_BYTES } = {}) {
    this.buffer = Buffer.alloc(0);
    this.maxBytes = maxBytes;
  }

  push(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : Buffer.from(chunk);
    const frames = [];
    for (let frame = this.next(); frame; frame = this.next()) frames.push(frame);
    return frames;
  }

  next() {
    const bytes = this.buffer;
    if (bytes.length < 2) return null;
    const fin = (bytes[0] & 0x80) !== 0;
    const opcode = bytes[0] & 0x0f;
    const masked = (bytes[1] & 0x80) !== 0;
    let length = bytes[1] & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (bytes.length < 4) return null;
      length = bytes.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (bytes.length < 10) return null;
      const big = bytes.readBigUInt64BE(2);
      if (big > BigInt(this.maxBytes)) throw daemonError('protocol_error', 'the daemon sent a frame larger than this client accepts');
      length = Number(big);
      offset = 10;
    }
    if (length > this.maxBytes) throw daemonError('protocol_error', 'the daemon sent a frame larger than this client accepts');
    let mask = null;
    if (masked) {
      if (bytes.length < offset + 4) return null;
      mask = bytes.subarray(offset, offset + 4);
      offset += 4;
    }
    if (bytes.length < offset + length) return null;
    const payload = Buffer.from(bytes.subarray(offset, offset + length));
    if (mask) for (let index = 0; index < length; index += 1) payload[index] ^= mask[index & 3];
    this.buffer = bytes.subarray(offset + length);
    return { fin, opcode, payload };
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC over the WebSocket, over the proxy's stdio.

class CodexDaemonClient extends EventEmitter {
  constructor({ child, mask = () => crypto.randomBytes(4), onDebug = null, requestTimeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    super();
    this.child = child;
    this.mask = mask;
    this.onDebug = onDebug;
    this.requestTimeoutMs = requestTimeoutMs;
    this.reader = new FrameReader();
    this.nextId = 1;
    this.pending = new Map();
    this.parts = null;
    this.partsOpcode = 0;
    this.partsBytes = 0;
    this.closed = false;
    this.closeReason = '';
  }

  debug(direction, text) {
    if (this.onDebug) {
      try { this.onDebug(direction, text); } catch {}
    }
  }

  writeFrame(opcode, payload) {
    if (this.closed || !this.child.stdin || this.child.stdin.destroyed) return false;
    try {
      this.child.stdin.write(encodeFrame(opcode, payload, this.mask()));
      return true;
    } catch {
      return false;
    }
  }

  send(message) {
    const text = JSON.stringify(message);
    this.debug('->', text);
    if (!this.writeFrame(OPCODE.TEXT, text)) throw daemonError('connection_closed', `the daemon connection is closed${this.closeReason ? ` (${this.closeReason})` : ''}`);
  }

  request(method, params = undefined, { timeoutMs = this.requestTimeoutMs } = {}) {
    if (!CLIENT_METHODS.includes(method)) {
      return Promise.reject(daemonError('method_not_allowed', `atris does not send ${method} to the shared codex daemon`));
    }
    if (this.closed) {
      return Promise.reject(daemonError('connection_closed', `the daemon connection is closed${this.closeReason ? ` (${this.closeReason})` : ''}`));
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.pending.delete(id);
        reject(daemonError('request_timeout', `${method} got no answer from the daemon in ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs) : null;
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.send(params === undefined ? { id, method } : { id, method, params });
      } catch (error) {
        if (timer) clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params = undefined) {
    if (!CLIENT_NOTIFICATIONS.includes(method)) throw daemonError('method_not_allowed', `atris does not send ${method} to the shared codex daemon`);
    this.send(params === undefined ? { method } : { method, params });
  }

  // Bytes from the proxy's stdout after the handshake.
  receive(chunk) {
    let frames;
    try {
      frames = this.reader.push(chunk);
    } catch (error) {
      this.shutdown(error.message);
      return;
    }
    for (const frame of frames) this.handleFrame(frame);
  }

  handleFrame(frame) {
    if (frame.opcode === OPCODE.PING) {
      this.writeFrame(OPCODE.PONG, frame.payload);
      return;
    }
    if (frame.opcode === OPCODE.PONG) return;
    if (frame.opcode === OPCODE.CLOSE) {
      this.writeFrame(OPCODE.CLOSE, frame.payload.subarray(0, 2));
      this.shutdown('the daemon closed the connection');
      return;
    }
    if (frame.opcode === OPCODE.TEXT || frame.opcode === OPCODE.BINARY) {
      this.parts = [frame.payload];
      this.partsOpcode = frame.opcode;
      this.partsBytes = frame.payload.length;
    } else if (frame.opcode === OPCODE.CONTINUATION && this.parts) {
      this.parts.push(frame.payload);
      this.partsBytes += frame.payload.length;
    } else {
      return;
    }
    if (this.partsBytes > MAX_MESSAGE_BYTES) {
      this.shutdown('the daemon sent a message larger than this client accepts');
      return;
    }
    if (!frame.fin) return;
    const data = Buffer.concat(this.parts);
    const opcode = this.partsOpcode;
    this.parts = null;
    this.partsBytes = 0;
    // Binary frames only carry compressed traffic, which this client never
    // asks for, so they are skipped like the daemon skips unexpected ones.
    if (opcode !== OPCODE.TEXT) return;
    const text = data.toString('utf8');
    this.debug('<-', text);
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      this.emit('notice', 'the daemon sent a message that is not json; skipped it');
      return;
    }
    this.dispatch(message);
  }

  dispatch(message) {
    if (!message || typeof message !== 'object') return;
    const hasId = message.id !== undefined && message.id !== null;
    if (hasId && !message.method) {
      const waiting = this.pending.get(message.id);
      if (!waiting) return;
      this.pending.delete(message.id);
      if (waiting.timer) clearTimeout(waiting.timer);
      if (message.error) {
        const detail = message.error && message.error.message ? message.error.message : 'unknown error';
        waiting.reject(daemonError('rpc_error', `${waiting.method} failed: ${detail}`, { code: message.error.code, data: message.error.data }));
      } else {
        waiting.resolve(message.result);
      }
      return;
    }
    if (hasId && message.method) {
      this.answerServerRequest(message);
      return;
    }
    if (message.method) this.emit('notification', message);
  }

  // The daemon asks the client something (approvals, user input). Threads
  // here run with approvalPolicy "never", so these should not come; if one
  // does, the safe answer is no, never a silent hang.
  answerServerRequest(message) {
    const decline = serverRequestDecline(message.method);
    this.emit('notice', `codex asked "${message.method}"; atris answered no`);
    try {
      if (decline) this.send({ id: message.id, result: decline });
      else this.send({ id: message.id, error: { code: -32601, message: `atris does not answer ${message.method}` } });
    } catch {}
  }

  shutdown(reason) {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason || 'closed';
    for (const [id, waiting] of this.pending) {
      if (waiting.timer) clearTimeout(waiting.timer);
      waiting.reject(daemonError('connection_closed', `${waiting.method} got no answer: ${this.closeReason}`));
      this.pending.delete(id);
    }
    this.emit('close', this.closeReason);
  }

  // Ends this connection only. The daemon and its threads keep running.
  close({ graceMs = CLOSE_GRACE_MS } = {}) {
    const child = this.child;
    if (!this.closed) {
      const code = Buffer.alloc(2);
      code.writeUInt16BE(1000, 0);
      this.writeFrame(OPCODE.CLOSE, code);
      this.shutdown('closed by atris');
    }
    return new Promise((resolve) => {
      if (!child || child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        try { child.kill('SIGTERM'); } catch {}
        resolve();
      }, graceMs);
      if (typeof timer.unref === 'function') timer.unref();
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      try { child.stdin.end(); } catch {}
    });
  }
}

function serverRequestDecline(method) {
  if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') return { decision: 'decline' };
  if (method === 'execCommandApproval' || method === 'applyPatchApproval') return { decision: 'denied' };
  if (method === 'mcpServer/elicitation/request') return { action: 'decline' };
  return null;
}

function packageVersion() {
  try {
    return String(require('../package.json').version || '0.0.0');
  } catch {
    return '0.0.0';
  }
}

// Spawns `codex app-server proxy`, upgrades to WebSocket, and runs the
// initialize handshake. Rejects with error.reason set when the daemon cannot
// be reached, so the caller can fall back to `codex exec`.
function connectCodexDaemon({
  bin = 'codex',
  args = ['app-server', 'proxy'],
  spawnProcess = spawn,
  env = process.env,
  cwd = process.cwd(),
  connectTimeoutMs = CONNECT_TIMEOUT_MS,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
  randomBytes = crypto.randomBytes,
  clientName = 'atris',
  clientVersion = packageVersion(),
  onDebug = null,
} = {}) {
  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    let handshakeBuffer = Buffer.alloc(0);
    let client = null;
    const key = websocketKey(randomBytes);
    const startedAt = Date.now();

    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (client) client.shutdown(error.message);
      if (child && child.exitCode === null && child.signalCode === null) {
        try { child.kill('SIGTERM'); } catch {}
      }
      reject(error);
    };

    const timer = setTimeout(() => {
      fail(daemonError('connect_timeout', `the codex daemon did not answer within ${Math.round(connectTimeoutMs / 1000)}s`));
    }, connectTimeoutMs);

    try {
      // Own process group: a Ctrl-C in the terminal reaches atris, which can
      // interrupt the turn cleanly, instead of killing the proxy mid-turn.
      // The proxy still exits on its own when atris goes away, because its
      // stdin closes.
      child = spawnProcess(bin, args, {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      fail(daemonError('spawn_error', `could not start ${bin} app-server proxy: ${error.message}`));
      return;
    }

    let stderr = '';
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4000);
      });
    }
    if (child.stdin) child.stdin.on('error', () => {});
    child.once('error', (error) => {
      const reason = error && error.code === 'ENOENT' ? 'not_installed' : 'spawn_error';
      fail(daemonError(reason, reason === 'not_installed' ? `${bin} is not installed` : `could not start ${bin} app-server proxy: ${error.message}`));
      if (client) client.shutdown(`proxy error: ${error.message}`);
    });
    child.once('exit', (code, signal) => {
      const detail = stderr.trim().split(/\r?\n/).filter(Boolean).pop() || `exit ${code === null ? signal : code}`;
      if (!settled) fail(daemonError('proxy_exited', `codex app-server proxy stopped: ${detail}`, { exit_code: code, stderr }));
      if (client) client.shutdown(`the proxy stopped (${detail})`);
    });

    child.stdout.on('data', (chunk) => {
      if (client) {
        client.receive(chunk);
        return;
      }
      handshakeBuffer = Buffer.concat([handshakeBuffer, chunk]);
      let response;
      try {
        response = parseUpgradeResponse(handshakeBuffer);
        if (!response) return;
        verifyUpgradeResponse(response, key);
      } catch (error) {
        fail(error.reason ? error : daemonError('handshake_failed', error.message));
        return;
      }
      client = new CodexDaemonClient({ child, onDebug, requestTimeoutMs, mask: () => randomBytes(4) });
      if (response.rest.length) client.receive(response.rest);
      const remaining = Math.max(1, connectTimeoutMs - (Date.now() - startedAt));
      client.request('initialize', {
        clientInfo: { name: clientName, title: 'Atris CLI', version: clientVersion },
      }, { timeoutMs: remaining }).then((result) => {
        if (settled) return;
        client.notify('initialized');
        client.serverInfo = result || {};
        settled = true;
        clearTimeout(timer);
        resolve(client);
      }, (error) => {
        fail(daemonError(error.reason === 'request_timeout' ? 'connect_timeout' : 'initialize_failed', `the codex daemon did not finish initialize: ${error.message}`));
      });
    });

    try {
      child.stdin.write(upgradeRequest(key));
    } catch (error) {
      fail(daemonError('spawn_error', `could not write to ${bin} app-server proxy: ${error.message}`));
    }
  });
}

// ---------------------------------------------------------------------------
// Threads and turns.

function textInput(prompt) {
  return [{ type: 'text', text: String(prompt) }];
}

async function startCodexThread(client, params = {}) {
  const result = await client.request('thread/start', params);
  const thread = result && result.thread;
  if (!thread || !thread.id) throw daemonError('protocol_error', 'thread/start answered without a thread id');
  return { thread_id: thread.id, model: result.model || thread.model || '', result };
}

async function resumeCodexThread(client, params = {}) {
  const result = await client.request('thread/resume', { excludeTurns: true, ...params });
  const thread = result && result.thread;
  if (!thread || !thread.id) throw daemonError('protocol_error', 'thread/resume answered without a thread id');
  return { thread_id: thread.id, model: result.model || thread.model || '', result };
}

// A short plain line for a tool step, or '' for steps worth no line.
function activityLine(item) {
  if (!item || typeof item !== 'object') return '';
  const clip = (value, size = 140) => {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return text.length > size ? `${text.slice(0, size - 3)}...` : text;
  };
  if (item.type === 'commandExecution') return `ran: ${clip(item.command)}`;
  if (item.type === 'mcpToolCall') return `tool: ${clip([item.server, item.tool].filter(Boolean).join(' '))}`;
  if (item.type === 'dynamicToolCall') return `tool: ${clip(item.tool)}`;
  if (item.type === 'fileChange') {
    const count = Array.isArray(item.changes) ? item.changes.length : 0;
    return `edit: ${count} ${count === 1 ? 'file' : 'files'}`;
  }
  if (item.type === 'webSearch') return `search: ${clip(item.query)}`;
  if (item.type === 'imageGeneration') return 'image: generating';
  return '';
}

// Sends one turn and streams the agent's words through onText as they land.
// Resolves when the daemon says the turn is over, or a few seconds after a
// stop (deadline or Ctrl-C) is sent; rejects only when the turn could not
// start at all.
function runCodexTurn(client, {
  threadId,
  prompt,
  model = '',
  effort = '',
  timeoutMs = 0,
  onText = () => {},
  onActivity = () => {},
  onNotice = () => {},
  signal = null,
} = {}) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const streamedItems = new Set();
    let turnId = '';
    let started = false;
    let settled = false;
    let text = '';
    let currentItem = '';
    let lastError = '';
    let stopStatus = '';
    let stopTimer = null;
    let deadline = null;

    const stopMessage = (status) => (status === 'timeout' ? 'the turn ran past its time limit' : 'stopped');
    const cleanup = () => {
      client.removeListener('notification', onNotification);
      client.removeListener('close', onClose);
      if (deadline) clearTimeout(deadline);
      if (stopTimer) clearTimeout(stopTimer);
      if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
    };
    const finish = (status, error = '') => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        thread_id: threadId,
        turn_id: turnId,
        status,
        text,
        error: error || (status === 'completed' ? '' : lastError),
        duration_ms: Date.now() - startedAt,
      });
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const emitText = (itemId, chunk) => {
      if (!chunk) return;
      if (currentItem && itemId !== currentItem && text && !text.endsWith('\n')) {
        text += '\n\n';
        onText('\n\n');
      }
      currentItem = itemId;
      text += chunk;
      onText(chunk);
    };
    // The daemon gets a few seconds to confirm the stop; past that the turn
    // is reported stopped anyway so the terminal never hangs.
    const sendInterrupt = () => {
      if (stopTimer) clearTimeout(stopTimer);
      client.request('turn/interrupt', { threadId, turnId }, { timeoutMs: INTERRUPT_GRACE_MS }).catch(() => {});
      stopTimer = setTimeout(() => finish(stopStatus, stopMessage(stopStatus)), INTERRUPT_GRACE_MS);
    };
    const requestStop = (status) => {
      if (settled || stopStatus) return;
      stopStatus = status;
      if (turnId) sendInterrupt();
      else stopTimer = setTimeout(() => finish(stopStatus, stopMessage(stopStatus)), INTERRUPT_GRACE_MS * 2);
    };

    const onNotification = (message) => {
      const params = message.params || {};
      if (params.threadId && params.threadId !== threadId) return;
      if (turnId && params.turnId && params.turnId !== turnId) return;
      switch (message.method) {
        case 'item/agentMessage/delta':
          streamedItems.add(params.itemId);
          emitText(params.itemId, String(params.delta || ''));
          break;
        case 'item/started': {
          const line = activityLine(params.item);
          if (line) onActivity(line, params.item);
          break;
        }
        case 'item/completed': {
          const item = params.item || {};
          if (item.type === 'agentMessage' && !streamedItems.has(item.id)) emitText(item.id, String(item.text || ''));
          break;
        }
        case 'error': {
          lastError = params.error && params.error.message ? params.error.message : 'codex reported an error';
          if (!params.willRetry) onNotice(lastError);
          break;
        }
        case 'turn/completed': {
          const turn = params.turn || {};
          if (turnId && turn.id && turn.id !== turnId) break;
          if (!turnId && turn.id) turnId = turn.id;
          const errorText = turn.error && turn.error.message ? turn.error.message : '';
          if (stopStatus && turn.status !== 'completed') finish(stopStatus, errorText || stopMessage(stopStatus));
          else finish(turn.status || 'completed', errorText);
          break;
        }
        default:
          break;
      }
    };
    const onClose = (reason) => {
      if (!started) fail(daemonError('connection_closed', `the daemon connection closed: ${reason}`));
      else finish('closed', `the daemon connection closed before the turn finished (${reason})`);
    };
    const onAbort = () => requestStop('interrupted');

    if (signal && signal.aborted) {
      resolve({ thread_id: threadId, turn_id: '', status: 'interrupted', text: '', error: 'stopped', duration_ms: 0 });
      return;
    }
    client.on('notification', onNotification);
    client.on('close', onClose);
    if (signal && typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort, { once: true });
    if (timeoutMs > 0) deadline = setTimeout(() => requestStop('timeout'), timeoutMs);

    const params = { threadId, input: textInput(prompt) };
    if (model) params.model = model;
    if (effort) params.effort = effort;
    client.request('turn/start', params).then((result) => {
      started = true;
      const turn = result && result.turn;
      if (turn && turn.id && !turnId) turnId = turn.id;
      if (turn && TERMINAL_TURN_STATUSES.has(turn.status)) {
        finish(turn.status, turn.error && turn.error.message ? turn.error.message : '');
        return;
      }
      if (stopStatus && turnId && !settled) sendInterrupt();
    }, fail);
  });
}

module.exports = {
  CLIENT_METHODS,
  OPCODE,
  UPGRADE_PATH,
  CodexDaemonClient,
  FrameReader,
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
};
