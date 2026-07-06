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

/**
 * Get the base URL for the Atris API.
 * @returns {string} API base URL
 */
function getApiBaseUrl() {
  const backend = process.env.ATRIS_BACKEND_URL
    ? process.env.ATRIS_BACKEND_URL.replace(/\/+$/, '')
    : '';
  const raw = process.env.ATRIS_API_URL
    || (backend ? (backend.endsWith('/api') ? backend : `${backend}/api`) : 'https://api.atris.ai/api');
  return raw.replace(/\/$/, '');
}

/**
 * Get the base URL for the Atris web app.
 * @returns {string} App base URL
 */
function getAppBaseUrl() {
  const raw = process.env.ATRIS_APP_URL || 'https://atris.ai';
  return raw.replace(/\/$/, '');
}

/**
 * Build a full API URL from a path.
 * @param {string} pathname - API endpoint path
 * @returns {string} Full API URL
 */
function buildApiUrl(pathname) {
  const base = getApiBaseUrl();
  const normalizedPath = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return `${base}${normalizedPath}`;
}

/**
 * Make an HTTP/HTTPS request.
 * @param {string} urlString - Full URL to request
 * @param {Object} options - Request options (method, headers, body, timeoutMs)
 * @returns {Promise<Object>} Response with statusCode, headers, and data
 */
function httpRequest(urlString, options) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlString);
    const isHttps = parsed.protocol === 'https:';
    const transport = isHttps ? https : http;
    const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : 30000;

    const requestOptions = {
      method: options.method || 'GET',
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: `${parsed.pathname}${parsed.search}`,
      headers: { ...(options.headers || {}) },
    };

    const req = transport.request(requestOptions, (res) => {
      // Follow redirects (301, 302, 307, 308)
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, urlString).toString();
        resolve(httpRequest(redirectUrl, options));
        return;
      }

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
    // Socket idle timeout (fires if no data received for this duration)
    if (timeoutMs > 0) {
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`Request timeout after ${Math.round(timeoutMs / 1000)}s — try --timeout=300`));
      });
    }
    // Hard deadline — kill request after 2x the timeout regardless of activity
    const hardDeadline = timeoutMs > 0
      ? setTimeout(() => { req.destroy(new Error(`Hard deadline exceeded (${Math.round(timeoutMs * 2 / 1000)}s)`)); }, timeoutMs * 2)
      : null;
    // Clear hard deadline when response completes
    req.on('close', () => { if (hardDeadline) clearTimeout(hardDeadline); });

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

  const maxRetries = options.retries != null ? options.retries : 1;
  const retryableStatus = new Set([0, 502, 503, 504]);

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await httpRequest(url, {
        method: options.method || 'GET',
        headers,
        body: bodyPayload,
        timeoutMs: options.timeoutMs,
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

      // Retry on transient server errors
      if (!ok && retryableStatus.has(result.status) && attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }

      const errorMessage = !ok
        ? (data && typeof data === 'object' && (data.detail || data.error || data.message)) || text || 'Request failed'
        : undefined;

      return { ok, status: result.status, data, text, error: errorMessage };
    } catch (error) {
      // Retry on network errors (timeout, connection reset)
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      return { ok: false, status: 0, data: null, text: '', error: error.message || 'Network error' };
    }
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
      let emittedText = false;

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
              } else if (msg.type === 'text_delta') {
                if (msg.content) {
                  emittedText = true;
                  process.stdout.write(msg.content);
                }
              } else if (msg.type === 'assistant') {
                if (msg.content && Array.isArray(msg.content)) {
                  for (const block of msg.content) {
                    if (block.type === 'text') {
                      emittedText = true;
                      process.stdout.write(block.text);
                    }
                  }
                }
              } else if (msg.type === 'tool_use' && showTools) {
                console.log(`\n[⚙️  Executing: ${msg.tool_name}]`);
              } else if (msg.type === 'tool_result' && showTools) {
                const preview = msg.content?.substring(0, 100) || '';
                console.log(`[✓ Result]: ${preview}${msg.content?.length > 100 ? '...' : ''}`);
              } else if (msg.type === 'result' && !emittedText) {
                if (msg.result) {
                  process.stdout.write(msg.result);
                }
              } else if (msg.type === 'error') {
                reject(new Error(msg.error || 'Atris stream error'));
              } else if (msg.chunk) {
                emittedText = true;
                process.stdout.write(msg.chunk);
              }
            } catch (e) {
              // Ignore parse errors
            }
          }
        }
      });

      res.on('end', () => {
        // Flush any remaining buffered data
        if (buffer.trim()) {
          const line = buffer.trim();
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            if (data && data !== '[DONE]') {
              try {
                const msg = JSON.parse(data);
                if (msg.chunk) {
                  process.stdout.write(msg.chunk);
                } else if (msg.type === 'text_delta' && msg.content) {
                  process.stdout.write(msg.content);
                } else if (msg.type === 'result' && msg.result && !emittedText) {
                  process.stdout.write(msg.result);
                }
              } catch (e) {
                // Ignore parse errors on final flush
              }
            }
          }
        }
        resolve();
      });

      res.on('error', (err) => {
        reject(err);
      });
    });

    // Timeout after 2 minutes of no response
    req.setTimeout(120000, () => {
      req.destroy(new Error('SSE stream timed out after 120s'));
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
