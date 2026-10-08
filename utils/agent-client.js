'use strict';

// Agent clients: an agent signs itself in with a client id and secret
// (OAuth client_credentials) instead of borrowing a person's login.
//
// The owner creates the client once with `atris agent-client create`. The
// agent runs `atris login --client-id atc_... --client-secret-file <path>`
// (or sets ATRIS_CLIENT_ID + ATRIS_CLIENT_SECRET / ATRIS_CLIENT_SECRET_FILE).
// There is no refresh token: when the short token runs out, the CLI asks
// again with the secret. The secret and tokens never reach stdout, stderr,
// or error text.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { stateHome } = require('../lib/state-home');
const { getApiBaseUrl, httpRequest, DEFAULT_CLIENT_ID, DEFAULT_USER_AGENT } = require('./api');

const AUTH_TYPE = 'agent_client';
const CLIENT_ID_PREFIX = 'atc_';
const RENEW_BEFORE_EXPIRY_MS = 60 * 1000;

function privateDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch {}
  return dir;
}

function clientsDir() {
  return privateDir(path.join(privateDir(path.join(stateHome(), '.atris')), 'agent-clients'));
}

function safeClientId(clientId) {
  return String(clientId).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 96);
}

function tokenCachePath(clientId) {
  return path.join(clientsDir(), `${safeClientId(clientId)}.token.json`);
}

function managedSecretPath(clientId) {
  return path.join(clientsDir(), `${safeClientId(clientId)}.secret`);
}

// Write through a private temp file and rename over the target, so a second
// CLI process never reads half a file and the content is never world readable.
function writeFileAtomic(filePath, content) {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, content, { mode: 0o600, flag: 'wx' });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, filePath);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
  try { fs.chmodSync(filePath, 0o600); } catch {}
}

function isAgentClientCredential(credentials) {
  return Boolean(credentials
    && credentials.auth_type === AUTH_TYPE
    && typeof credentials.client_id === 'string'
    && credentials.client_id.trim());
}

function scopeList(scope) {
  if (Array.isArray(scope)) return scope.map(String).filter(Boolean);
  if (typeof scope !== 'string') return [];
  return scope.split(/[\s,]+/).map((part) => part.trim()).filter(Boolean);
}

function readTokenCache(clientId) {
  try {
    const parsed = JSON.parse(fs.readFileSync(tokenCachePath(clientId), 'utf8'));
    if (!parsed || parsed.client_id !== clientId) return null;
    if (typeof parsed.access_token !== 'string' || !parsed.access_token) return null;
    const expiresMs = Date.parse(parsed.expires_at);
    if (!Number.isFinite(expiresMs)) return null;
    return { ...parsed, expires_ms: expiresMs };
  } catch {
    return null;
  }
}

function writeTokenCache(clientId, entry) {
  writeFileAtomic(tokenCachePath(clientId), JSON.stringify({ client_id: clientId, ...entry }, null, 2));
}

function deleteAgentClientFiles(clientId) {
  if (!clientId) return;
  for (const filePath of [tokenCachePath(clientId), managedSecretPath(clientId)]) {
    try { fs.unlinkSync(filePath); } catch {}
  }
}

// The agent client named by env, if any. ATRIS_TOKEN still wins over this
// (readCredentials checks it first), so existing headless boxes are unchanged.
function envAgentClient(env = process.env) {
  const clientId = typeof env.ATRIS_CLIENT_ID === 'string' ? env.ATRIS_CLIENT_ID.trim() : '';
  if (!clientId) return null;
  const secretFile = typeof env.ATRIS_CLIENT_SECRET_FILE === 'string' ? env.ATRIS_CLIENT_SECRET_FILE.trim() : '';
  return {
    auth_type: AUTH_TYPE,
    client_id: clientId,
    client_secret_file: secretFile ? path.resolve(secretFile) : null,
    client_secret_env: secretFile ? null : 'ATRIS_CLIENT_SECRET',
    scope: null,
    provider: AUTH_TYPE,
    email: null,
    user_id: null,
    from_env: true,
  };
}

// Attach the cached token (if any) so sync readers still see `token`.
function withCachedToken(stored) {
  const cache = readTokenCache(stored.client_id);
  return {
    ...stored,
    provider: stored.provider || AUTH_TYPE,
    source: AUTH_TYPE,
    token: cache ? cache.access_token : null,
    token_expires_at: cache ? cache.expires_at : null,
    scopes: cache ? scopeList(cache.scope) : scopeList(stored.scope),
  };
}

function needsRenewal(credentials, now = Date.now()) {
  if (!credentials || !credentials.token) return true;
  const expiresMs = Date.parse(credentials.token_expires_at);
  if (!Number.isFinite(expiresMs)) return true;
  return expiresMs - now <= RENEW_BEFORE_EXPIRY_MS;
}

class AgentClientError extends Error {
  constructor(message, code, status) {
    super(message);
    this.code = code;
    this.status = status || 0;
  }
}

function readClientSecret(client, env = process.env) {
  if (client.client_secret_file) {
    let raw;
    try {
      raw = fs.readFileSync(client.client_secret_file, 'utf8');
    } catch (error) {
      throw new AgentClientError(`could not read the client secret file ${client.client_secret_file}${error.code ? ` (${error.code})` : ''}`, 'secret_missing');
    }
    const secret = raw.trim();
    if (!secret) throw new AgentClientError(`the client secret file ${client.client_secret_file} is empty`, 'secret_missing');
    return secret;
  }
  const envName = client.client_secret_env || 'ATRIS_CLIENT_SECRET';
  const secret = typeof env[envName] === 'string' ? env[envName].trim() : '';
  if (!secret) {
    throw new AgentClientError('no client secret found. set ATRIS_CLIENT_SECRET or ATRIS_CLIENT_SECRET_FILE, or run atris login --client-id <id> --client-secret-file <path>', 'secret_missing');
  }
  return secret;
}

function getOAuthTokenUrl() {
  // The token endpoint lives at the server root, not under /api.
  return `${getApiBaseUrl().replace(/\/api$/, '')}/oauth/token`;
}

function scrub(text, secrets) {
  let out = String(text == null ? '' : text);
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join('[redacted]');
  }
  // Belt and braces: anything shaped like a client secret or a JWT goes too.
  return out
    .replace(/atcs_[A-Za-z0-9_\-.~+/=]+/g, '[redacted]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

// POST /oauth/token with grant_type=client_credentials (client_secret_post).
async function requestClientToken({ clientId, secret, scope }, deps = {}) {
  const request = deps.httpRequest || httpRequest;
  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: secret,
  });
  const wantedScope = scopeList(scope).join(' ');
  if (wantedScope) params.set('scope', wantedScope);
  const body = params.toString();

  let result;
  try {
    result = await request(getOAuthTokenUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        'User-Agent': DEFAULT_USER_AGENT,
        'X-Atris-Client': DEFAULT_CLIENT_ID,
      },
      body,
      timeoutMs: 30000,
    });
  } catch (error) {
    throw new AgentClientError(`could not reach the token endpoint: ${scrub(error && error.message, [secret])}`, 'network');
  }

  const text = Buffer.isBuffer(result.body) ? result.body.toString('utf8') : String(result.body || '');
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  const status = result.status || 0;

  if (status < 200 || status >= 300 || !data || typeof data.access_token !== 'string' || !data.access_token) {
    const code = (data && typeof data.error === 'string' && data.error) || (status >= 200 && status < 300 ? 'missing_token' : 'token_request_failed');
    const leaked = data && typeof data.access_token === 'string' ? data.access_token : null;
    const detail = data && (data.error_description || data.detail || data.message);
    const parts = [`agent client sign-in failed (${status || 'no response'}${code ? `, ${code}` : ''})`];
    if (detail) parts.push(scrub(typeof detail === 'string' ? detail : JSON.stringify(detail), [secret, leaked]));
    throw new AgentClientError(parts.join(': '), code, status);
  }

  const expiresIn = Number(data.expires_in);
  const ttlMs = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : 0;
  const now = deps.now ? deps.now() : Date.now();
  return {
    access_token: data.access_token,
    token_type: data.token_type || 'Bearer',
    scope: typeof data.scope === 'string' ? data.scope : wantedScope,
    expires_at: new Date(now + ttlMs).toISOString(),
    obtained_at: new Date(now).toISOString(),
  };
}

// Fetch a new token for this client, cache it, and return the credential with
// the new token attached.
async function renewAgentClientToken(credentials, deps = {}) {
  const secret = readClientSecret(credentials, deps.env || process.env);
  const entry = await requestClientToken({
    clientId: credentials.client_id,
    secret,
    scope: credentials.scope,
  }, deps);
  writeTokenCache(credentials.client_id, entry);
  return {
    ...credentials,
    source: AUTH_TYPE,
    token: entry.access_token,
    token_expires_at: entry.expires_at,
    scopes: scopeList(entry.scope),
  };
}

// Before a call: renew when the token is missing or within 60s of expiry.
// Another process may have renewed already, so look at the cache first.
async function ensureAgentClientToken(credentials, deps = {}) {
  if (!needsRenewal(credentials)) return credentials;
  const cached = withCachedToken(credentials);
  if (!needsRenewal(cached)) return cached;
  return renewAgentClientToken(credentials, deps);
}

// Which cached client (if any) issued this exact token. Cheap: one small
// directory, usually holding zero or one file.
function cachedClientIdForToken(token) {
  if (!token) return null;
  let dir;
  try {
    dir = path.join(stateHome(), '.atris', 'agent-clients');
    if (!fs.existsSync(dir)) return null;
  } catch {
    return null;
  }
  let names;
  try { names = fs.readdirSync(dir); } catch { return null; }
  for (const name of names) {
    if (!name.endsWith('.token.json')) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (parsed && parsed.access_token === token && typeof parsed.client_id === 'string') return parsed.client_id;
    } catch {}
  }
  return null;
}

// The active agent client credential for this token, or null when the token
// belongs to anything else (a person's login, an API key, ATRIS_TOKEN).
function activeClientForToken(token, readActive) {
  const clientId = cachedClientIdForToken(token);
  if (!clientId) return null;
  const active = readActive();
  if (!isAgentClientCredential(active) || active.client_id !== clientId) return null;
  return active;
}

function defaultReadActive() {
  return require('./auth').readActiveCredentials();
}

// Used by the shared API helper right before it sets the Authorization header.
// Never throws: on any problem the original token goes out unchanged.
async function freshTokenFor(token, deps = {}) {
  try {
    const active = activeClientForToken(token, deps.readActive || defaultReadActive);
    if (!active || active.token !== token || !needsRenewal(active)) return token;
    const renewed = await renewAgentClientToken(active, deps);
    return renewed.token || token;
  } catch {
    return token;
  }
}

// Used by the shared API helper after a 401. Returns a different token to
// retry with once, or null. Never throws.
async function tokenAfterUnauthorized(token, deps = {}) {
  try {
    const active = activeClientForToken(token, deps.readActive || defaultReadActive);
    if (!active) return null;
    if (active.token && active.token !== token && !needsRenewal(active)) {
      // Another process already renewed; use its token.
      return active.token;
    }
    const renewed = await renewAgentClientToken(active, deps);
    return renewed.token && renewed.token !== token ? renewed.token : null;
  } catch {
    return null;
  }
}

module.exports = {
  AUTH_TYPE,
  CLIENT_ID_PREFIX,
  AgentClientError,
  isAgentClientCredential,
  envAgentClient,
  withCachedToken,
  needsRenewal,
  readClientSecret,
  requestClientToken,
  renewAgentClientToken,
  ensureAgentClientToken,
  freshTokenFor,
  tokenAfterUnauthorized,
  writeFileAtomic,
  writeTokenCache,
  readTokenCache,
  managedSecretPath,
  tokenCachePath,
  deleteAgentClientFiles,
  scopeList,
  scrub,
  getOAuthTokenUrl,
};
