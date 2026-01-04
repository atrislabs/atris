const https = require('https');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');

const PACKAGE_JSON_PATH = path.join(__dirname, '..', 'package.json');

let CLI_VERSION = 'unknown';
try {
  const pkgRaw = fs.readFileSync(PACKAGE_JSON_PATH, 'utf8');
  const pkg = JSON.parse(pkgRaw);
  if (pkg && typeof pkg.version === 'string') {
    CLI_VERSION = pkg.version;
  }
} catch {
  // Ignore parse errors; fall back to unknown
}

const DEFAULT_CLIENT_ID = `AtrisCLI/${CLI_VERSION}`;
const DEFAULT_USER_AGENT = `${DEFAULT_CLIENT_ID} (node ${process.version}; ${os.platform()} ${os.release()} ${os.arch()})`;

function getApiBaseUrl() {
  const raw = process.env.ATRIS_API_URL || 'https://api.atris.ai/api';
  return raw.replace(/\/$/, '');
}

function getAppBaseUrl() {
  const raw = process.env.ATRIS_APP_URL || 'https://atris.ai';
  return raw.replace(/\/$/, '');
}

function buildApiUrl(pathname) {
  const base = getApiBaseUrl();
  const normalizedPath = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return `${base}${normalizedPath}`;
}

function httpRequest(urlString, options) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlString);
    const isHttps = parsed.protocol === 'https:';
    const transport = isHttps ? https : http;
    const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : 10000;

    const requestOptions = {
      method: options.method || 'GET',
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: `${parsed.pathname}${parsed.search}`,
      headers: { ...(options.headers || {}) },
    };

    const req = transport.request(requestOptions, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode || 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
    });

    req.on('error', reject);
    if (timeoutMs > 0) {
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error('Request timeout'));
      });
    }

    if (options.body) {
      if (!req.hasHeader('Content-Length')) {
        req.setHeader('Content-Length', Buffer.byteLength(options.body));
      }
      req.write(options.body);
    }

    req.end();
  });
}

async function apiRequestJson(pathname, options = {}) {
  const url = buildApiUrl(pathname);
  const headers = { ...(options.headers || {}) };
  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }
  if (!headers['User-Agent'] && !headers['user-agent']) {
    headers['User-Agent'] = DEFAULT_USER_AGENT;
  }
  if (!headers['X-Atris-Client']) {
    headers['X-Atris-Client'] = DEFAULT_CLIENT_ID;
  }

  let bodyPayload;
  if (options.body !== undefined && options.body !== null) {
    if (typeof options.body === 'string' || Buffer.isBuffer(options.body)) {
      bodyPayload = options.body;
    } else {
      bodyPayload = JSON.stringify(options.body);
      if (!headers['Content-Type']) {
        headers['Content-Type'] = 'application/json';
      }
    }
  }

  try {
    const result = await httpRequest(url, {
      method: options.method || 'GET',
      headers,
      body: bodyPayload,
    });

    const text = result.body.toString('utf8');
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }

    const ok = result.status >= 200 && result.status < 300;
    const errorMessage = !ok
      ? (data && typeof data === 'object' && (data.detail || data.error || data.message)) || text || 'Request failed'
      : undefined;

    return {
      ok,
      status: result.status,
      data,
      text,
      error: errorMessage,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      data: null,
      text: '',
      error: error.message || 'Network error',
    };
  }
}

function streamProChat(url, token, body, showTools = false) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === 'https:';
    const transport = isHttps ? https : http;

    const requestOptions = {
      method: 'POST',
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Accept': 'text/event-stream',
      },
    };

    const req = transport.request(requestOptions, (res) => {
      if (res.statusCode !== 200) {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          reject(new Error(`HTTP ${res.statusCode}: ${text}`));
        });
        return;
      }

      let buffer = '';

      res.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            if (!data || data === '[DONE]') continue;

            try {
              const msg = JSON.parse(data);

              if (msg.type === 'system_init' && showTools) {
                console.log(`[System] Tools available: ${msg.tools?.join(', ') || 'none'}`);
              } else if (msg.type === 'assistant') {
                if (msg.content && Array.isArray(msg.content)) {
                  for (const block of msg.content) {
                    if (block.type === 'text') {
                      process.stdout.write(block.text);
                    }
                  }
                }
              } else if (msg.type === 'tool_use' && showTools) {
                console.log(`\n[⚙️  Executing: ${msg.tool_name}]`);
              } else if (msg.type === 'tool_result' && showTools) {
                const preview = msg.content?.substring(0, 100) || '';
                console.log(`[✓ Result]: ${preview}${msg.content?.length > 100 ? '...' : ''}`);
              } else if (msg.type === 'result') {
                if (msg.result) {
                  process.stdout.write(msg.result);
                }
              } else if (msg.chunk) {
                process.stdout.write(msg.chunk);
              }
            } catch (e) {
              // Ignore parse errors
            }
          }
        }
      });

      res.on('end', () => {
        resolve();
      });

      res.on('error', (err) => {
        reject(err);
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.write(body);
    req.end();
  });
}

function spawnClaudeCodeSession(url, token, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === 'https:';
    const transport = isHttps ? https : http;

    const requestOptions = {
      method: 'POST',
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = transport.request(requestOptions, (res) => {
      if (res.statusCode !== 200) {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          reject(new Error(`HTTP ${res.statusCode}: ${text}`));
        });
        return;
      }

      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try {
          const response = JSON.parse(Buffer.concat(chunks).toString());
          resolve(response);
        } catch (e) {
          resolve({ status: 'session_initiated' });
        }
      });

      res.on('error', (err) => {
        reject(err);
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.write(body);
    req.end();
  });
}

module.exports = {
  getApiBaseUrl,
  getAppBaseUrl,
  buildApiUrl,
  httpRequest,
  apiRequestJson,
  streamProChat,
  spawnClaudeCodeSession,
  DEFAULT_CLIENT_ID,
  DEFAULT_USER_AGENT,
};
