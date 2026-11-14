'use strict';

// The town's two doors, for `atris town`.
//
// Facts door: plain GETs on the normal API with your sign-in (the streets, who
// is around, last night). Text door: the remote tool server at <origin>/mcp
// (town_look, town_go, ...). The text door never takes a plain sign-in. It
// takes a developer key (atris api-key create) or an agent token that carries a
// town permission. Nothing here costs credits.

const { getApiBaseUrl, httpRequest, DEFAULT_CLIENT_ID, DEFAULT_USER_AGENT } = require('../utils/api');
const { decodeJwtClaims } = require('../utils/auth');
const { resolveDesignKey } = require('./design-api');
const { oneLine } = require('./developer-api');

const TOWN_SCOPES = ['mcp:plaza', 'mcp:town:build'];
const TIMEOUT_MS = 20000;

const NEEDS_KEY = [
  "The town's walking door needs a developer key. A sign-in alone is not accepted there.",
  'Make one: atris api-key create',
  'Then run: ATRIS_API_KEY=<the key> atris town',
  '(or save the key in ~/.atris/design-api-key)',
].join('\n');
const NEEDS_LOGIN_AND_KEY = `Sign in first: atris login\n${NEEDS_KEY}`;

function hasTownScope(scopes) {
  return Array.isArray(scopes) && scopes.some((scope) => TOWN_SCOPES.includes(scope));
}

// The key for the text door, or null. An explicit key in the environment wins;
// then the agent's own token when it carries a town permission; then a key
// saved by hand. The sign-in token is never sent: the door refuses it.
function townKey(creds, env = process.env, deps = {}) {
  const fromEnv = String((env && env.ATRIS_API_KEY) || '').trim();
  if (fromEnv) return fromEnv;
  const own = creds && typeof creds === 'object' ? creds : {};
  const claims = decodeJwtClaims(own.token);
  if (claims && claims.type === 'agent_access' && hasTownScope(claims.scopes)) return String(own.token).trim();
  const leftover = typeof own.agent_token === 'string' ? own.agent_token.trim() : '';
  if (leftover && hasTownScope(own.agent_token_scopes)) return leftover;
  return resolveDesignKey({}, { ...deps, loadCredentials: () => null });
}

// https://api.atris.ai/api -> https://api.atris.ai/mcp. The same base-URL
// overrides the rest of the CLI honours (ATRIS_API_URL, ATRIS_BACKEND_URL).
function textDoorUrl(base = getApiBaseUrl()) {
  return `${String(base).replace(/\/+$/, '').replace(/\/api$/, '')}/mcp`;
}

// The door answers JSON, or one server-sent event holding the same JSON.
function parseBody(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const candidates = [raw];
  for (const line of raw.split('\n')) {
    if (line.startsWith('data:')) candidates.push(line.slice(5).trim());
  }
  for (const candidate of candidates.reverse()) {
    try { return JSON.parse(candidate); } catch { /* try the next one */ }
  }
  return null;
}

function blockText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

function toolError(text) {
  return String(text || '').replace(/^Error executing tool [\w:-]+:\s*/i, '').trim();
}

function looksUnknown(message) {
  return /unknown tool|no such tool|tool .* not (found|available)/i.test(String(message || ''));
}

// One JSON-RPC call to the text door. Never throws. Resolves
// { ok, status, text, data, error, unknownTool }.
async function rpc(method, params, options = {}) {
  const key = options.key;
  const send = options.httpRequest || httpRequest;
  const url = textDoorUrl(options.base);
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  let res;
  try {
    res = await send(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'User-Agent': DEFAULT_USER_AGENT,
        'X-Atris-Client': DEFAULT_CLIENT_ID,
      },
      body,
      timeoutMs: options.timeoutMs != null ? options.timeoutMs : TIMEOUT_MS,
    });
  } catch (error) {
    return { ok: false, status: 0, error: `could not reach the town: ${oneLine(error && error.message)}` };
  }
  const parsed = parseBody(res.body ? res.body.toString('utf8') : '');
  if (res.status < 200 || res.status >= 300) {
    const detail = parsed && typeof parsed === 'object' ? parsed.error || parsed.detail || parsed.message : null;
    const message = detail && typeof detail === 'object' ? detail.message : detail;
    return { ok: false, status: res.status, error: oneLine(message || `the town answered ${res.status}`) };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, status: res.status, error: 'the town sent back something unreadable' };
  }
  if (parsed.error) {
    const message = oneLine(parsed.error.message || parsed.error);
    return { ok: false, status: res.status, error: message, unknownTool: looksUnknown(message) };
  }
  const result = parsed.result && typeof parsed.result === 'object' ? parsed.result : {};
  if (result.tools) return { ok: true, status: res.status, tools: result.tools };
  const text = blockText(result.content);
  if (result.isError) {
    const message = toolError(text) || 'the town refused that';
    return { ok: false, status: res.status, error: oneLine(message), unknownTool: looksUnknown(message) };
  }
  const structured = result.structuredContent && typeof result.structuredContent === 'object' ? result.structuredContent : null;
  let data = null;
  if (structured) {
    data = Object.keys(structured).length === 1 && 'result' in structured ? structured.result : structured;
  } else if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  return { ok: true, status: res.status, text, data };
}

function callTool(name, args, options) {
  return rpc('tools/call', { name, arguments: args || {} }, options);
}

function listTools(options) {
  return rpc('tools/list', {}, options);
}

// What a refused door call means, in plain words.
function doorMessage(result) {
  const status = Number(result && result.status);
  if (status === 401) return 'The town did not accept that key. Make a fresh one: atris api-key create';
  if (status === 429) return 'Too many requests. Wait a minute and try again.';
  return oneLine(result && result.error);
}

module.exports = {
  NEEDS_KEY,
  NEEDS_LOGIN_AND_KEY,
  townKey,
  textDoorUrl,
  callTool,
  listTools,
  doorMessage,
};
