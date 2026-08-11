'use strict';

// Per-run loopback secret-swap gateway for one-lap. Holds one real credential
// outside the sandbox, hands the engine a random placeholder plus a loopback
// base url, and forwards only grant-matched GET/HEAD requests.

const fs = require('fs');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const net = require('net');
const { spawn, spawnSync } = require('child_process');

const ALLOWED_METHODS = new Set(['GET', 'HEAD']);
const STRIP_RESPONSE_HEADERS = new Set([
  'set-cookie',
  'set-cookie2',
  'www-authenticate',
  'authorization',
  'proxy-authenticate',
  'proxy-authorization',
]);
const PROXY_ENV_KEYS = [
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
];

function createPlaceholder() {
  return crypto.randomBytes(32).toString('base64url');
}

function normalizeGrant(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const id = String(src.id || '').trim();
  const host = String(src.host || '').trim().toLowerCase();
  const secretEnv = String(src.secretEnv || src.secret_env || '').trim();
  const credentialHeader = String(src.credentialHeader || src.credential_header || '').trim().toLowerCase();
  const placeholderEnv = String(src.placeholderEnv || src.placeholder_env || '').trim();
  const baseUrlEnv = String(src.baseUrlEnv || src.base_url_env || '').trim();
  const pathPrefixes = Array.isArray(src.pathPrefixes)
    ? src.pathPrefixes
    : (Array.isArray(src.path_prefixes) ? src.path_prefixes : []);
  const methods = Array.isArray(src.methods) ? src.methods : ['GET', 'HEAD'];

  if (!id) throw new Error('secret grant requires id');
  if (!host || host.includes(':') || host.includes('/') || /[A-Z]/.test(String(src.host || '').trim())) {
    throw new Error('secret grant host must be an exact lowercase hostname');
  }
  if (!secretEnv) throw new Error('secret grant requires secretEnv');
  if (!credentialHeader) throw new Error('secret grant requires credentialHeader');
  if (!placeholderEnv) throw new Error('secret grant requires placeholderEnv');
  if (!baseUrlEnv) throw new Error('secret grant requires baseUrlEnv');
  if (!pathPrefixes.length) throw new Error('secret grant requires pathPrefixes');

  const normalizedPrefixes = pathPrefixes.map((prefix) => {
    const value = String(prefix || '');
    if (!value.startsWith('/') || value.includes('?') || value.includes('#') || value.includes('\\') || value.includes('//')) {
      throw new Error('secret grant path prefix must be a canonical absolute path');
    }
    if (value.includes('%') || value.includes('.') && /(^|\/)\.\.?(\/|$)/.test(value)) {
      throw new Error('secret grant path prefix must be canonical');
    }
    return value;
  });

  const normalizedMethods = [...new Set(methods.map((method) => String(method || '').trim().toUpperCase()))];
  if (!normalizedMethods.length || normalizedMethods.some((method) => !ALLOWED_METHODS.has(method))) {
    throw new Error('secret grant methods are limited to GET and HEAD');
  }

  return {
    id,
    host,
    secretEnv,
    credentialHeader,
    placeholderEnv,
    baseUrlEnv,
    pathPrefixes: normalizedPrefixes,
    methods: normalizedMethods,
  };
}

function pathMatchesGrant(pathname, prefixes) {
  for (const prefix of prefixes) {
    if (pathname === prefix) return true;
    const boundary = prefix.endsWith('/') ? prefix : `${prefix}/`;
    if (pathname.startsWith(boundary)) return true;
  }
  return false;
}

function inspectRequestTarget(requestUrl) {
  const raw = String(requestUrl || '');
  if (!raw) return { ok: false, reason: 'empty_target' };
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) return { ok: false, reason: 'absolute_form' };
  if (raw.includes('\\')) return { ok: false, reason: 'backslash' };
  if (raw.includes('#') || /%23/i.test(raw)) return { ok: false, reason: 'fragment' };
  if (raw.includes('@')) return { ok: false, reason: 'userinfo' };

  const queryIndex = raw.indexOf('?');
  const pathPart = queryIndex === -1 ? raw : raw.slice(0, queryIndex);
  const search = queryIndex === -1 ? '' : raw.slice(queryIndex);
  if (!pathPart.startsWith('/')) return { ok: false, reason: 'relative_target' };
  if (/%2f/i.test(pathPart) || /%5c/i.test(pathPart)) return { ok: false, reason: 'encoded_separator' };
  if (/%2e/i.test(pathPart)) return { ok: false, reason: 'dot_segment' };

  let decoded;
  try {
    decoded = decodeURIComponent(pathPart);
  } catch {
    return { ok: false, reason: 'bad_encoding' };
  }
  if (decoded.includes('\0') || decoded.includes('\\') || decoded.includes('#') || decoded.includes('?')) {
    return { ok: false, reason: 'ambiguous_path' };
  }
  if (!decoded.startsWith('/')) return { ok: false, reason: 'relative_target' };
  for (const segment of decoded.split('/')) {
    if (segment === '.' || segment === '..') return { ok: false, reason: 'dot_segment' };
  }
  return { ok: true, pathname: decoded, search };
}

function headerValue(headers, name) {
  const wanted = String(name || '').toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (String(key).toLowerCase() === wanted) {
      return Array.isArray(value) ? String(value[0] || '') : String(value || '');
    }
  }
  return '';
}

function placeholderMatches(provided, expected) {
  const left = Buffer.from(String(provided || ''), 'utf8');
  const right = Buffer.from(String(expected || ''), 'utf8');
  if (left.length !== right.length) {
    const fill = Buffer.alloc(right.length);
    crypto.timingSafeEqual(fill, right);
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function requestHasBody(req) {
  if (req.headers['transfer-encoding']) return true;
  const length = req.headers['content-length'];
  if (length === undefined) return false;
  const n = Number(length);
  return !Number.isFinite(n) || n > 0;
}

function parseGatewaySession(raw) {
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
  const grant = normalizeGrant(parsed.grant);
  const placeholder = String(parsed.placeholder || '');
  const secret = String(parsed.secret || '');
  if (!placeholder) throw new Error('gateway session requires placeholder');
  if (!secret) throw new Error('gateway session requires secret');
  return {
    grant,
    placeholder,
    secret,
    upstreamPort: Number.isInteger(parsed.upstreamPort) ? parsed.upstreamPort : 443,
    upstreamAddress: parsed.upstreamAddress ? String(parsed.upstreamAddress) : grant.host,
    rejectUnauthorized: parsed.rejectUnauthorized !== false,
  };
}

function applySecretGrantEnvironment(environment, grantInput, options = {}) {
  const grant = normalizeGrant(grantInput);
  const placeholder = options.placeholder || createPlaceholder();
  environment[grant.placeholderEnv] = placeholder;
  for (const key of PROXY_ENV_KEYS) {
    if (key.toUpperCase() === 'NO_PROXY' || key === 'no_proxy') environment[key] = '127.0.0.1,localhost';
    else environment[key] = '';
  }
  const plan = {
    grant,
    placeholder,
  };
  if (options.upstreamPort !== undefined) plan.upstreamPort = options.upstreamPort;
  if (options.upstreamAddress !== undefined) plan.upstreamAddress = options.upstreamAddress;
  if (options.rejectUnauthorized !== undefined) plan.rejectUnauthorized = options.rejectUnauthorized;
  environment.ATRIS_ONE_LAP_SECRET_GATEWAY = JSON.stringify(plan);
  return { grant, placeholder, plan };
}

function childEnvironmentWithGateway(baseEnv, session, gateway) {
  const env = { ...baseEnv };
  delete env.ATRIS_ONE_LAP_SECRET_GATEWAY;
  delete env.ATRIS_ONE_LAP_SECRET_GATEWAY_STDIN;
  if (session.grant.secretEnv !== session.grant.placeholderEnv) {
    delete env[session.grant.secretEnv];
  }
  env[session.grant.placeholderEnv] = session.placeholder;
  env[session.grant.baseUrlEnv] = gateway.baseUrl;
  return env;
}

function recordReceipt(receipts, entry) {
  receipts.push({
    grant_id: entry.grant_id,
    decision: entry.decision,
    method: entry.method,
    host: entry.host,
    path: entry.path,
    upstream_status: entry.upstream_status == null ? null : entry.upstream_status,
    request_bytes: entry.request_bytes || 0,
    response_bytes: entry.response_bytes || 0,
    reason: entry.reason || null,
  });
}

function rejectClient(res, receipts, meta, status, reason) {
  recordReceipt(receipts, {
    grant_id: meta.grant_id,
    decision: 'deny',
    method: meta.method,
    host: meta.host,
    path: meta.path || '',
    reason,
  });
  res.statusCode = status;
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  res.end('gateway denied\n');
}

function hostHeaderAllowed(hostHeader, listenPort) {
  const raw = String(hostHeader || '').trim().toLowerCase();
  if (!raw) return false;
  const allowed = new Set([
    '127.0.0.1',
    `127.0.0.1:${listenPort}`,
    'localhost',
    `localhost:${listenPort}`,
  ]);
  return allowed.has(raw);
}

function startSecretGateway(sessionInput) {
  const session = parseGatewaySession(sessionInput);
  const receipts = [];
  let listening = false;
  let listenPort = 0;

  const server = http.createServer((req, res) => {
    const method = String(req.method || '').toUpperCase();
    const meta = {
      grant_id: session.grant.id,
      method,
      host: session.grant.host,
      path: '',
    };

    if (!session.grant.methods.includes(method) || !ALLOWED_METHODS.has(method)) {
      rejectClient(res, receipts, meta, 405, 'method');
      return;
    }
    if (requestHasBody(req)) {
      rejectClient(res, receipts, meta, 400, 'body');
      return;
    }
    if (!hostHeaderAllowed(headerValue(req.headers, 'host'), listenPort)) {
      rejectClient(res, receipts, meta, 400, 'host_override');
      return;
    }

    const target = inspectRequestTarget(req.url);
    if (!target.ok) {
      rejectClient(res, receipts, meta, 400, target.reason);
      return;
    }
    meta.path = target.pathname;
    if (!pathMatchesGrant(target.pathname, session.grant.pathPrefixes)) {
      rejectClient(res, receipts, meta, 403, 'path');
      return;
    }

    const provided = headerValue(req.headers, session.grant.credentialHeader);
    if (!placeholderMatches(provided, session.placeholder)) {
      rejectClient(res, receipts, meta, 401, 'placeholder');
      return;
    }

    const requestHeaders = {};
    for (const [key, value] of Object.entries(req.headers || {})) {
      const lower = String(key).toLowerCase();
      if (lower === 'host' || lower === 'connection' || lower === session.grant.credentialHeader) continue;
      if (lower === 'content-length' || lower === 'transfer-encoding') continue;
      requestHeaders[key] = value;
    }
    requestHeaders.Host = session.grant.host;
    requestHeaders[session.grant.credentialHeader] = session.secret;

    const upstreamReq = https.request({
      protocol: 'https:',
      hostname: session.upstreamAddress,
      port: session.upstreamPort,
      servername: session.grant.host,
      path: `${target.pathname}${target.search}`,
      method,
      headers: requestHeaders,
      rejectUnauthorized: session.rejectUnauthorized,
    }, (upstreamRes) => {
      const status = Number(upstreamRes.statusCode || 0);
      if (status >= 300 && status < 400) {
        upstreamRes.resume();
        recordReceipt(receipts, {
          grant_id: session.grant.id,
          decision: 'deny',
          method,
          host: session.grant.host,
          path: target.pathname,
          upstream_status: status,
          reason: 'redirect',
        });
        res.statusCode = 502;
        res.setHeader('content-type', 'text/plain; charset=utf-8');
        res.end('gateway denied redirect\n');
        return;
      }

      let responseBytes = 0;
      res.statusCode = status || 502;
      for (const [key, value] of Object.entries(upstreamRes.headers || {})) {
        const lower = String(key).toLowerCase();
        if (STRIP_RESPONSE_HEADERS.has(lower)) continue;
        if (lower === 'connection' || lower === 'transfer-encoding') continue;
        if (value !== undefined) res.setHeader(key, value);
      }
      upstreamRes.on('data', (chunk) => {
        responseBytes += chunk.length;
        res.write(chunk);
      });
      upstreamRes.on('end', () => {
        recordReceipt(receipts, {
          grant_id: session.grant.id,
          decision: 'allow',
          method,
          host: session.grant.host,
          path: target.pathname,
          upstream_status: status,
          response_bytes: responseBytes,
        });
        res.end();
      });
      upstreamRes.on('error', () => {
        if (!res.headersSent) {
          rejectClient(res, receipts, meta, 502, 'upstream_error');
        } else {
          res.destroy();
        }
      });
    });

    upstreamReq.on('error', () => {
      rejectClient(res, receipts, meta, 502, 'upstream_connect');
    });
    upstreamReq.end();
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      listening = true;
      const address = server.address();
      listenPort = address && address.port;
      resolve({
        port: listenPort,
        baseUrl: `http://127.0.0.1:${listenPort}`,
        receipts,
        isListening: () => listening && server.listening,
        close: () => new Promise((closeResolve, closeReject) => {
          if (!server.listening) {
            listening = false;
            closeResolve();
            return;
          }
          server.close((error) => {
            listening = false;
            if (error) closeReject(error);
            else closeResolve();
          });
        }),
      });
    });
  });
}

function buildGatewaySupervisorScript(gatewayModulePath) {
  return [
    "'use strict';",
    "const fs = require('node:fs');",
    "const { spawn, spawnSync } = require('node:child_process');",
    `const sg = require(${JSON.stringify(gatewayModulePath)});`,
    "const [exitFile, stateFile, leaseFile, statusFile, executable, ...args] = process.argv.slice(2);",
    "const leaseFd = fs.openSync(leaseFile, 'w', 0o600);",
    "const statusFd = fs.openSync(statusFile, 'w', 0o600);",
    'function writeExit(code) {',
    '  const exitCode = Number.isInteger(code) ? code : 128;',
    "  try { fs.writeFileSync(exitFile, String(exitCode) + '\\n', { mode: 0o600 }); } catch {}",
    '  process.exit(exitCode);',
    '}',
    '',
    'async function main() {',
    "  const session = sg.parseGatewaySession(fs.readFileSync(0, 'utf8'));",
    '  const gateway = await sg.startSecretGateway(session);',
    '  try { process.stdin.pause(); process.stdin.destroy(); } catch {}',
    '  const childEnv = sg.childEnvironmentWithGateway(process.env, session, gateway);',
    "  const child = spawn(executable, args, { cwd: process.cwd(), env: childEnv, detached: true, stdio: ['ignore', 'inherit', 'inherit', leaseFd, statusFd] });",
    '  fs.closeSync(leaseFd);',
    '  fs.closeSync(statusFd);',
    "  fs.writeFileSync(stateFile, JSON.stringify({ pgid: child.pid, cwd: process.cwd() }) + '\\n', { mode: 0o600 });",
    '  let stopping = false;',
    '  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));',
    '  function trackedPids() {',
    '    const pids = new Set();',
    "    for (const [bin, argv] of [['/usr/bin/pgrep', ['-g', String(child.pid)]], ['/usr/sbin/lsof', ['-t', leaseFile]], ['/usr/sbin/lsof', ['-a', '-d', 'cwd', '+D', process.cwd(), '-t']]]) {",
    "      const found = spawnSync(bin, argv, { encoding: 'utf8' });",
    "      for (const value of String(found.stdout || '').trim().split(/\\s+/)) {",
    '        const pid = Number(value);',
    '        if (Number.isInteger(pid) && pid > 0) pids.add(pid);',
    '      }',
    '    }',
    '    pids.delete(process.pid);',
    '    return [...pids];',
    '  }',
    '  async function stop(code) {',
    '    if (stopping) return;',
    '    stopping = true;',
    "    if (executable === '/usr/bin/sandbox-exec' && args[0] === '-p' && args[1]) {",
    "      spawnSync(executable, ['-p', args[1], '/bin/kill', '-KILL', '-1'], { cwd: process.cwd(), env: process.env, stdio: 'ignore', timeout: 5000 });",
    '    }',
    "    for (const [signal, delay] of [['SIGTERM', 100], ['SIGKILL', 100], ['SIGKILL', 100]]) {",
    '      try { process.kill(-child.pid, signal); } catch {}',
    '      for (const pid of trackedPids()) { try { process.kill(pid, signal); } catch {} }',
    '      await wait(delay);',
    '    }',
    '    try { await gateway.close(); } catch {}',
    '    let exitCode = Number.isInteger(code) ? code : 128;',
    '    try {',
    "      const savedText = fs.readFileSync(statusFile, 'utf8').trim();",
    '      const saved = Number(savedText);',
    '      if (savedText && Number.isInteger(saved) && saved >= 0 && saved <= 255) exitCode = saved;',
    '    } catch {}',
    '    writeExit(exitCode);',
    '  }',
    "  child.once('error', () => { void stop(1); });",
    "  child.once('exit', (code) => { void stop(code); });",
    "  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => { void stop(143); });",
    '}',
    '',
    'main().catch(() => { writeExit(1); });',
    '',
  ].join('\n');
}

function probeListening(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.end();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
  });
}

// Spawn the gateway supervisor without spawnSync. Some agent sandboxes deny
// network to every spawnSync descendant, while a normal spawn child can open
// HTTPS. The waiter must also keep this event loop alive: a sync sleep loop
// parks the parent and the sandbox then blocks child TLS too. Poll the exit
// file on a timer, and yield with spawnSync('/bin/sleep', ['0.05']) inside
// each tick only as a short OS pause after the timer has already fired.
function spawnBlocking(command, args, options = {}) {
  const exitFile = options.exitFile;
  if (!exitFile) throw new Error('spawnBlocking requires exitFile');
  try { fs.unlinkSync(exitFile); } catch {}

  // Node may leave child.stdin.fd undefined until the event loop runs. Feed the
  // session through an inherited read fd so stdin is ready before the first tick.
  let stdinStdio = 'ignore';
  let inputFd = null;
  if (options.input != null) {
    const inputPath = `${exitFile}.stdin`;
    fs.writeFileSync(inputPath, String(options.input), { mode: 0o600 });
    inputFd = fs.openSync(inputPath, 'r');
    try { fs.unlinkSync(inputPath); } catch {}
    stdinStdio = inputFd;
  }

  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: [stdinStdio, 'pipe', 'pipe'],
  });
  if (inputFd != null) {
    try { fs.closeSync(inputFd); } catch {}
  }

  const stdoutChunks = [];
  const stderrChunks = [];
  let spawnError = null;
  if (child.stdout) child.stdout.on('data', (chunk) => { stdoutChunks.push(Buffer.from(chunk)); });
  if (child.stderr) child.stderr.on('data', (chunk) => { stderrChunks.push(Buffer.from(chunk)); });
  child.on('error', (error) => { spawnError = error; });

  const encode = (chunks) => {
    const buf = Buffer.concat(chunks);
    if (options.encoding) return buf.toString(options.encoding);
    return buf;
  };

  const started = Date.now();
  const timeout = Number(options.timeout) || 0;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      resolve(result);
    };

    const timer = setInterval(() => {
      // Short OS pause after the timer fires; do not replace the timer with a
      // sync sleep loop or child HTTPS stalls in agent sandboxes.
      spawnSync('/bin/sleep', ['0.05'], { stdio: 'ignore' });

      if (spawnError) {
        finish({
          pid: child.pid,
          status: null,
          signal: null,
          stdout: encode(stdoutChunks),
          stderr: encode(stderrChunks),
          error: spawnError,
        });
        return;
      }
      if (fs.existsSync(exitFile)) {
        let status = 0;
        try {
          const raw = fs.readFileSync(exitFile, 'utf8').trim();
          const parsed = Number(raw);
          if (Number.isInteger(parsed)) status = parsed;
        } catch {}
        try { child.kill('SIGTERM'); } catch {}
        finish({
          pid: child.pid,
          status,
          signal: null,
          stdout: encode(stdoutChunks),
          stderr: encode(stderrChunks),
          error: null,
        });
        return;
      }
      if (timeout && Date.now() - started > timeout) {
        try { child.kill('SIGKILL'); } catch {}
        const error = new Error('spawnBlocking ETIMEDOUT');
        error.code = 'ETIMEDOUT';
        error.errno = -60;
        finish({
          pid: child.pid,
          status: null,
          signal: 'SIGKILL',
          stdout: encode(stdoutChunks),
          stderr: encode(stderrChunks),
          error,
        });
      }
    }, 50);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

module.exports = {
  createPlaceholder,
  normalizeGrant,
  pathMatchesGrant,
  inspectRequestTarget,
  parseGatewaySession,
  applySecretGrantEnvironment,
  childEnvironmentWithGateway,
  startSecretGateway,
  buildGatewaySupervisorScript,
  probeListening,
  spawnBlocking,
  PROXY_ENV_KEYS,
};
