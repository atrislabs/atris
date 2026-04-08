/**
 * Atris Serve — make this directory a live AI Computer.
 *
 *   atris serve                       Start the bridge in current directory
 *   atris serve --agent <agent_id>    Bind to a specific agent
 *   atris serve --once <op_id>        Apply one queued op and exit (debug)
 *
 * Opens a session with the Atris backend, subscribes via SSE to incoming
 * file operations, and applies them to the local working directory.
 *
 * Cloud agents (or any authenticated caller) can dispatch operations:
 *   POST /api/cli/sessions/{id}/file-op
 *
 * Operations supported:
 *   - write: create or replace a file
 *   - edit:  find/replace in a file
 *   - read:  read a file (returns content via ack)
 *   - delete: remove a file
 *   - bash:  run a shell command
 *
 * Path safety: all paths are resolved against the working directory.
 * Anything that escapes is rejected.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { execSync } = require('child_process');
const { loadCredentials } = require('../utils/auth');
const { apiRequestJson, getApiBaseUrl } = require('../utils/api');

const HEARTBEAT_INTERVAL_MS = 30000;
const RECONNECT_DELAY_MS = 2000;
const MAX_RECONNECT_DELAY_MS = 30000;
// Bash commands are bounded to 10s — long batches won't lock the CLI for hours
const BASH_TIMEOUT_MS = 10000;
// Hard size limits to prevent OOM on large payloads
const MAX_WRITE_BYTES = 10 * 1024 * 1024;  // 10 MB
const MAX_EDIT_BYTES = 1 * 1024 * 1024;    // 1 MB find/replace

function getToken() {
  const creds = loadCredentials();
  if (!creds || !creds.token) {
    console.error('Not logged in. Run: atris login');
    process.exit(1);
  }
  return creds.token;
}

/**
 * Validate a path stays inside the working directory.
 * Returns the absolute resolved path or throws.
 */
function safePath(workingDir, requestedPath) {
  if (!requestedPath || typeof requestedPath !== 'string') {
    throw new Error('path required');
  }
  if (requestedPath.startsWith('/')) {
    throw new Error('path must be relative');
  }
  if (requestedPath.split('/').includes('..')) {
    throw new Error('path may not contain ..');
  }
  const realWd = fs.realpathSync(workingDir);
  const resolved = path.resolve(realWd, requestedPath);
  // Walk up to find a parent that exists, then realpath that
  let parent = path.dirname(resolved);
  while (parent && !fs.existsSync(parent) && parent !== path.dirname(parent)) {
    parent = path.dirname(parent);
  }
  const realParent = fs.existsSync(parent) ? fs.realpathSync(parent) : parent;
  // The realParent must be inside realWd
  if (!realParent.startsWith(realWd + path.sep) && realParent !== realWd) {
    throw new Error('path escapes working directory');
  }
  return resolved;
}

/**
 * Apply a single operation locally. Returns { status, result }.
 */
async function applyOp(workingDir, op) {
  try {
    const type = op.type;

    if (type === 'write') {
      const content = op.content || '';
      const bytes = Buffer.byteLength(content, 'utf8');
      if (bytes > MAX_WRITE_BYTES) {
        return { status: 'error', result: { error: `content exceeds ${MAX_WRITE_BYTES} bytes` } };
      }
      const target = safePath(workingDir, op.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, 'utf8');
      return { status: 'ok', result: { bytes_written: bytes } };
    }

    if (type === 'read') {
      const target = safePath(workingDir, op.path);
      if (!fs.existsSync(target)) {
        return { status: 'error', result: { error: 'file not found' } };
      }
      const content = fs.readFileSync(target, 'utf8');
      return { status: 'ok', result: { content, bytes: Buffer.byteLength(content, 'utf8') } };
    }

    if (type === 'edit') {
      if (Buffer.byteLength(op.find || '', 'utf8') > MAX_EDIT_BYTES ||
          Buffer.byteLength(op.replace || '', 'utf8') > MAX_EDIT_BYTES) {
        return { status: 'error', result: { error: `find/replace exceeds ${MAX_EDIT_BYTES} bytes` } };
      }
      const target = safePath(workingDir, op.path);
      if (!fs.existsSync(target)) {
        return { status: 'error', result: { error: 'file not found' } };
      }
      const stat = fs.statSync(target);
      if (stat.size > MAX_WRITE_BYTES) {
        return { status: 'error', result: { error: `file too large (>${MAX_WRITE_BYTES} bytes)` } };
      }
      const original = fs.readFileSync(target, 'utf8');
      if (!original.includes(op.find)) {
        return { status: 'error', result: { error: 'find string not present' } };
      }
      const updated = original.split(op.find).join(op.replace);
      fs.writeFileSync(target, updated, 'utf8');
      return { status: 'ok', result: { replacements: original.split(op.find).length - 1 } };
    }

    if (type === 'delete') {
      const target = safePath(workingDir, op.path);
      if (!fs.existsSync(target)) {
        return { status: 'error', result: { error: 'file not found' } };
      }
      fs.unlinkSync(target);
      return { status: 'ok', result: { deleted: true } };
    }

    if (type === 'bash') {
      // Execute bash in the working directory with a timeout.
      // Note: This is a powerful op — only the session owner can dispatch it,
      // AND the session must have been created with allow_bash=true.
      try {
        const stdout = execSync(op.command, {
          cwd: workingDir,
          timeout: BASH_TIMEOUT_MS,
          encoding: 'utf8',
          maxBuffer: 10 * 1024 * 1024,
        });
        const truncated = stdout.length > 100000;
        return {
          status: 'ok',
          result: { stdout: stdout.slice(0, 100000), truncated, exit_code: 0 },
        };
      } catch (execErr) {
        const stderr = (execErr.stderr || '').toString();
        const stdout = (execErr.stdout || '').toString();
        return {
          status: 'error',
          result: {
            error: execErr.message,
            stdout: stdout.slice(0, 100000),
            stderr: stderr.slice(0, 100000),
            stdout_truncated: stdout.length > 100000,
            stderr_truncated: stderr.length > 100000,
            exit_code: execErr.status ?? 1,
          },
        };
      }
    }

    return { status: 'error', result: { error: `unknown op type: ${type}` } };
  } catch (err) {
    return { status: 'error', result: { error: err.message } };
  }
}

/**
 * Open an SSE stream to /api/cli/sessions/{id}/events and apply each op.
 */
function streamSession(token, sessionId, workingDir) {
  const baseUrl = getApiBaseUrl();
  const url = new URL(`${baseUrl}/cli/sessions/${sessionId}/events`);
  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? https : http;

  const options = {
    method: 'GET',
    hostname: url.hostname,
    port: url.port || (isHttps ? 443 : 80),
    path: `${url.pathname}${url.search}`,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'text/event-stream',
      'Cache-Control': 'no-cache',
    },
    timeout: 0,
  };

  return new Promise((resolve, reject) => {
    const req = transport.request(options, (res) => {
      if (res.statusCode !== 200) {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => reject(new Error(`SSE failed: ${res.statusCode} ${body}`)));
        return;
      }

      console.log(`● Bridge active — listening for ops on session ${sessionId.slice(0, 8)}...`);

      let buffer = '';
      res.on('data', async (chunk) => {
        buffer += chunk.toString();
        const messages = buffer.split('\n\n');
        buffer = messages.pop() || '';

        for (const msg of messages) {
          if (!msg.startsWith('data: ')) continue;
          const dataStr = msg.slice(6).trim();
          if (!dataStr) continue;

          let event;
          try {
            event = JSON.parse(dataStr);
          } catch {
            continue;
          }

          if (event.type === 'ping' || event.type === 'hello') {
            continue;
          }
          if (event.type === 'close') {
            console.log('  ✓ Session closed by backend');
            res.destroy();
            return;
          }

          // Apply the operation
          const startMs = Date.now();
          const ackPayload = await applyOp(workingDir, event);
          const durationMs = Date.now() - startMs;

          const icon = ackPayload.status === 'ok' ? '✓' : '✗';
          console.log(`  ${icon} ${event.type} ${event.path || event.command || ''} (${durationMs}ms)`);

          // Send the ack
          try {
            await apiRequestJson(`/cli/sessions/${sessionId}/ack`, {
              method: 'POST',
              token,
              body: {
                op_id: event.op_id,
                status: ackPayload.status,
                result: ackPayload.result,
              },
            });
          } catch (ackErr) {
            console.error(`    failed to ack: ${ackErr.message}`);
          }
        }
      });

      res.on('end', () => {
        console.log('  · Stream ended');
        resolve();
      });
      res.on('error', reject);
    });

    req.on('error', reject);
    req.end();
  });
}

async function serveAtris(options = {}) {
  const token = getToken();
  const workingDir = process.cwd();
  const agentId = options.agent || null;
  const allowBash = options.allowBash === true;

  console.log('');
  console.log('╭──────────────────────────────────────────╮');
  console.log('│   ATRIS SERVE — Local AI Computer Bridge │');
  console.log('╰──────────────────────────────────────────╯');
  console.log('');
  console.log(`  📁 Directory: ${workingDir}`);
  console.log(`  🤖 Agent:     ${agentId || '(none)'}`);
  console.log(`  ⚡ Bash:      ${allowBash ? 'enabled (REMOTE BASH ALLOWED)' : 'disabled (read/write/edit/delete only)'}`);
  console.log('');

  // Register the session
  let session;
  try {
    const result = await apiRequestJson('/cli/sessions', {
      method: 'POST',
      token,
      body: {
        working_directory: workingDir,
        agent_id: agentId,
        allow_bash: allowBash,
      },
    });
    if (!result.ok) {
      console.error(`✗ Failed to create session: ${result.errorMessage || result.status}`);
      process.exit(1);
    }
    session = result.data;
  } catch (err) {
    console.error(`✗ Could not register session: ${err.message}`);
    process.exit(1);
  }

  console.log(`  ✓ Session: ${session.session_id}`);
  console.log('');
  console.log('  Cloud agents can now modify files in this directory via:');
  console.log(`    POST /api/cli/sessions/${session.session_id}/file-op`);
  console.log('');
  console.log('  Press Ctrl+C to stop.');
  console.log('');

  // Cleanup on exit
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\n  · Closing session...');
    try {
      await apiRequestJson(`/cli/sessions/${session.session_id}`, {
        method: 'DELETE',
        token,
      });
    } catch {
      // best effort
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Reconnect loop with exponential backoff
  let reconnectDelay = RECONNECT_DELAY_MS;
  while (!shuttingDown) {
    try {
      await streamSession(token, session.session_id, workingDir);
      reconnectDelay = RECONNECT_DELAY_MS; // reset on clean disconnect
    } catch (err) {
      if (shuttingDown) break;
      console.error(`  ⚠ Stream error: ${err.message}, reconnecting in ${reconnectDelay / 1000}s...`);
      await new Promise((r) => setTimeout(r, reconnectDelay));
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
    }
  }
}

module.exports = {
  serveAtris,
  // exported for testing
  safePath,
  applyOp,
};
