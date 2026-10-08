'use strict';

// Owner side of agent self-login. A person creates an agent client once and
// hands its id and secret to the agent; the agent then signs itself in with
// `atris login --client-id ... --client-secret-file ...`.
//
// The secret is shown exactly once, at create or rotate, or written to a
// private file with --secret-file. It never goes to stderr or error text.

const fs = require('fs');
const path = require('path');
const { apiRequestJson } = require('../utils/api');
const { ensureValidCredentials, readActiveCredentials } = require('../utils/auth');
const agentClient = require('../utils/agent-client');
const { readFlag } = require('../lib/arg-parser');
const { wantsJson, wantsHelp, oneLine } = require('../lib/developer-api');

const BASE_PATH = '/auth/agent-clients';
const ACTIONS = new Set(['create', 'list', 'revoke', 'rotate']);
const VALUE_FLAGS = ['--name', '--scopes', '--daily-credit-cap', '--ttl', '--secret-file'];
const SHOWN_ONCE = 'store this secret now, it will not be shown again:';
const AGENT_CLIENT_CANNOT_MANAGE = 'agent clients are managed with your own login, not an agent client. run: atris switch <you> or atris login --force';

function showAgentClientHelp(log = console.log) {
  log('usage: atris agent-client create --name <name> --scopes <a,b> [--daily-credit-cap N] [--ttl SECONDS] [--secret-file <path>]');
  log('       atris agent-client list');
  log('       atris agent-client revoke <client_id>');
  log('       atris agent-client rotate <client_id> [--secret-file <path>]');
  log('');
  log('an agent client lets an agent sign itself in, with no person in the loop.');
  log('create and rotate show the secret once. --secret-file writes it to a private file instead.');
  log('the agent then runs: atris login --client-id <atc_...> --client-secret-file <path>');
  log('needs your own login. add --json for machine output.');
}

function positiveInt(raw, label) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) return { error: `${label} must be a positive whole number` };
  return { value };
}

function parseAgentClientArgs(args = []) {
  const positionals = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i]);
    if (arg === '--json') continue;
    const valueFlag = VALUE_FLAGS.find((flag) => arg === flag || arg.startsWith(`${flag}=`));
    if (valueFlag) {
      if (arg === valueFlag) {
        const next = args[i + 1];
        if (next == null || String(next).startsWith('--')) return { error: `${valueFlag} needs a value` };
        i += 1;
      }
      continue;
    }
    if (arg.startsWith('--')) return { error: `unknown agent-client option: ${arg}` };
    positionals.push(arg);
  }

  const parsed = {
    action: positionals[0] || '',
    clientId: positionals[1] || '',
    name: readFlag(args, '--name', ''),
    scopes: agentClient.scopeList(readFlag(args, '--scopes', '')),
    secretFile: readFlag(args, '--secret-file', ''),
    dailyCreditCap: null,
    ttlSeconds: null,
  };
  const cap = readFlag(args, '--daily-credit-cap', '');
  if (cap) {
    const checked = positiveInt(cap, '--daily-credit-cap');
    if (checked.error) return checked;
    parsed.dailyCreditCap = checked.value;
  }
  const ttl = readFlag(args, '--ttl', '');
  if (ttl) {
    const checked = positiveInt(ttl, '--ttl');
    if (checked.error) return checked;
    parsed.ttlSeconds = checked.value;
  }

  if (!ACTIONS.has(parsed.action)) return { error: 'usage: atris agent-client create|list|revoke|rotate' };
  if (parsed.action === 'create') {
    if (!parsed.name) return { error: 'create needs --name <name>' };
    if (parsed.scopes.length === 0) return { error: 'create needs --scopes <a,b>' };
  }
  if ((parsed.action === 'revoke' || parsed.action === 'rotate') && !parsed.clientId) {
    return { error: `usage: atris agent-client ${parsed.action} <client_id>` };
  }
  if (parsed.clientId && !parsed.clientId.startsWith(agentClient.CLIENT_ID_PREFIX)) {
    return { error: `client ids start with ${agentClient.CLIENT_ID_PREFIX}` };
  }
  if (parsed.secretFile && parsed.action !== 'create' && parsed.action !== 'rotate') {
    return { error: '--secret-file only works with create and rotate' };
  }
  return parsed;
}

// Check before calling the backend: a secret that cannot be saved is lost.
function checkSecretFileTarget(filePath) {
  const resolved = path.resolve(filePath);
  try {
    if (fs.statSync(resolved).isDirectory()) return { error: `${resolved} is a folder, not a file` };
  } catch (error) {
    if (error.code !== 'ENOENT') return { error: `cannot use ${resolved} (${error.code})` };
  }
  const dir = path.dirname(resolved);
  try {
    fs.accessSync(dir, fs.constants.W_OK);
  } catch {
    return { error: `cannot write to ${dir}` };
  }
  return { path: resolved };
}

function clientsFrom(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];
  for (const key of ['clients', 'agent_clients', 'items', 'data']) {
    if (Array.isArray(data[key])) return data[key];
  }
  return [];
}

function scopesText(scopes) {
  const list = agentClient.scopeList(scopes);
  return list.length ? list.join(', ') : 'none';
}

function listText(data) {
  const clients = clientsFrom(data);
  if (clients.length === 0) return 'no agent clients yet. make one: atris agent-client create --name <name> --scopes <a,b>';
  return clients.map((client) => {
    const parts = [client.client_id || client.id || '?', client.name || 'unnamed', `scopes: ${scopesText(client.scopes)}`];
    if (client.revoked_at) parts.push('revoked');
    else if (client.last_used_at) parts.push(`last used ${client.last_used_at}`);
    return parts.join('  ');
  }).join('\n');
}

// Everything the backend sent, minus the secret.
function withoutSecret(data) {
  const { client_secret, ...rest } = data && typeof data === 'object' ? data : {};
  return rest;
}

async function agentClientCommand(args = [], deps = {}) {
  const log = deps.log || console.log;
  const err = deps.err || console.error;
  if (args.length === 0 || wantsHelp(args)) {
    showAgentClientHelp(log);
    return args.length === 0 ? 1 : 0;
  }

  const json = wantsJson(args);
  const fail = (message, extra = {}) => {
    if (json) log(JSON.stringify({ ok: false, error: message, ...extra }));
    else err(message);
    return 1;
  };

  const parsed = parseAgentClientArgs(args);
  if (parsed.error) return fail(parsed.error);

  let secretTarget = null;
  if (parsed.secretFile) {
    secretTarget = checkSecretFileTarget(parsed.secretFile);
    if (secretTarget.error) return fail(secretTarget.error);
  }

  const readActive = deps.readActiveCredentials || readActiveCredentials;
  if (agentClient.isAgentClientCredential(readActive())) {
    return fail(AGENT_CLIENT_CANNOT_MANAGE);
  }

  const request = deps.apiRequestJson || apiRequestJson;
  const ensure = deps.ensureValidCredentials || ((opts) => ensureValidCredentials(request, opts));
  const ensured = await ensure();
  if (!ensured || ensured.error || !ensured.credentials || !ensured.credentials.token) {
    return fail('not logged in. run: atris login');
  }
  if (ensured.source === agentClient.AUTH_TYPE || agentClient.isAgentClientCredential(ensured.credentials)) {
    return fail(AGENT_CLIENT_CANNOT_MANAGE);
  }
  const token = ensured.credentials.token;

  let result;
  try {
    if (parsed.action === 'list') {
      result = await request(BASE_PATH, { method: 'GET', token });
    } else if (parsed.action === 'create') {
      const body = { name: parsed.name, scopes: parsed.scopes };
      if (parsed.dailyCreditCap != null) body.daily_credit_cap = parsed.dailyCreditCap;
      if (parsed.ttlSeconds != null) body.token_ttl_seconds = parsed.ttlSeconds;
      result = await request(BASE_PATH, { method: 'POST', token, body, retries: 0 });
    } else if (parsed.action === 'revoke') {
      result = await request(`${BASE_PATH}/${encodeURIComponent(parsed.clientId)}`, { method: 'DELETE', token });
    } else {
      result = await request(`${BASE_PATH}/${encodeURIComponent(parsed.clientId)}/rotate-secret`, {
        method: 'POST',
        token,
        retries: 0,
      });
    }
  } catch (error) {
    return fail(agentClient.scrub(error && error.message, [token]));
  }

  if (!result || !result.ok) {
    const status = result && result.status;
    const secret = result && result.data && result.data.client_secret;
    const message = status === 404 && parsed.action !== 'revoke' && parsed.action !== 'rotate'
      ? 'agent clients are not live on the server yet. try again after the backend update.'
      : agentClient.scrub(oneLine(result && (result.data || result.error)), [token, secret]);
    return fail(message, { status: status || 0 });
  }

  const data = result.data && typeof result.data === 'object' ? result.data : {};

  if (parsed.action === 'list') {
    if (json) log(JSON.stringify({ ok: true, clients: clientsFrom(data).map(withoutSecret) }));
    else log(listText(data));
    return 0;
  }

  if (parsed.action === 'revoke') {
    if (json) log(JSON.stringify({ ok: true, client_id: parsed.clientId, revoked: true, ...withoutSecret(data) }));
    else log(`revoked ${parsed.clientId}. its tokens stop working now.`);
    return 0;
  }

  // create or rotate: the one moment the secret exists outside the server.
  const secret = typeof data.client_secret === 'string' ? data.client_secret : '';
  const clientId = data.client_id || parsed.clientId;
  if (!secret) return fail('the server did not return a client secret');

  if (secretTarget) {
    try {
      agentClient.writeFileAtomic(secretTarget.path, `${secret}\n`);
    } catch (error) {
      return fail(`could not write ${secretTarget.path}${error.code ? ` (${error.code})` : ''}. run atris agent-client rotate ${clientId} --secret-file <other path> to get a new secret.`);
    }
  }

  if (json) {
    const payload = { ok: true, ...withoutSecret(data), client_id: clientId };
    if (secretTarget) payload.secret_file = secretTarget.path;
    else payload.client_secret = secret;
    log(JSON.stringify(payload));
    return 0;
  }

  log(parsed.action === 'create' ? `created agent client ${data.name || parsed.name}` : `new secret for ${clientId}. the old one stops working.`);
  log(`client id: ${clientId}`);
  if (data.scopes) log(`scopes: ${scopesText(data.scopes)}`);
  if (secretTarget) {
    log(`secret saved to ${secretTarget.path} (only you can read it). it will not be shown again.`);
  } else {
    log(SHOWN_ONCE);
    log(secret);
  }
  log(`agent sign-in: atris login --client-id ${clientId} --client-secret-file ${secretTarget ? secretTarget.path : '<file holding the secret>'}`);
  return 0;
}

module.exports = { agentClientCommand, parseAgentClientArgs };
