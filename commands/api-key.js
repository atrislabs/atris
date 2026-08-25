'use strict';

const { apiRequestJson } = require('../utils/api');
const { loadCredentials } = require('../utils/auth');
const {
  NOT_LOGGED_IN,
  ROLLOUT_MESSAGE,
  wantsHelp,
  wantsJson,
  tokenFrom,
  isNotFound,
  oneLine,
  printResult,
} = require('../lib/developer-api');

const ACTIONS = new Set(['create', 'list', 'rotate', 'revoke']);

function showApiKeyHelp() {
  console.log('usage: atris api-key create [name] [--cap usd]');
  console.log('       atris api-key list');
  console.log('       atris api-key rotate <id>');
  console.log('       atris api-key revoke <id>');
  console.log('create, list, rotate, or revoke a developer api key. add --json for machine output.');
}

function parseApiKeyArgs(args = []) {
  const positionals = [];
  let cap = null;
  let name = null;
  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i]);
    if (arg === '--json' || arg === '--help' || arg === '-h' || arg === 'help') continue;
    if (arg === '--cap' || arg.startsWith('--cap=')) {
      const value = arg.startsWith('--cap=') ? arg.slice('--cap='.length) : args[++i];
      if (value == null || String(value).startsWith('--')) {
        return { error: '--cap needs a dollar amount' };
      }
      cap = Number(value);
      continue;
    }
    if (arg === '--name' || arg.startsWith('--name=')) {
      const value = arg.startsWith('--name=') ? arg.slice('--name='.length) : args[++i];
      if (value == null || String(value).startsWith('--')) {
        return { error: '--name needs a label' };
      }
      name = String(value);
      continue;
    }
    if (arg.startsWith('--')) {
      return { error: `unknown api-key option: ${arg}` };
    }
    positionals.push(arg);
  }

  const action = positionals[0] || '';
  const rest = positionals[1] || '';
  if (cap != null && (!Number.isFinite(cap) || cap <= 0)) {
    return { error: '--cap must be a positive dollar amount' };
  }
  return {
    action,
    id: rest,
    name: name || rest || 'cli',
    cap,
  };
}

function listKeys(data = {}) {
  const raw = data && typeof data === 'object' ? data : {};
  const keys = Array.isArray(raw.keys) ? raw.keys : Array.isArray(raw) ? raw : [];
  if (keys.length === 0) return 'no api keys yet.';
  return keys.map((key) => {
    const id = key.id || key.agent_id || '';
    const label = key.name || key.label || key.agent_name || 'api key';
    const prefix = key.api_key || key.api_key_prefix || '';
    return `${id}  ${label}${prefix ? `  ${prefix}` : ''}`;
  }).join('\n');
}

function createdKeyText(data = {}) {
  const key = data.api_key || data.new_api_key || '';
  const id = data.agent_id || data.id || '';
  if (!key) return oneLine(data.message || 'api key created.');
  return `store this key now; it will not be shown again.\n${id ? `${id}\n` : ''}${key}`;
}

async function apiKeyCommand(args = [], deps = {}) {
  if (wantsHelp(args) || args.length === 0) {
    showApiKeyHelp();
    return args.length === 0 ? 1 : 0;
  }

  const json = wantsJson(args);
  const io = { log: deps.log || console.log, err: deps.err || console.error };
  const parsed = parseApiKeyArgs(args);
  if (parsed.error) {
    printResult({ json, ok: false, error: parsed.error, payload: { ok: false, error: parsed.error } }, io);
    return 1;
  }
  if (!ACTIONS.has(parsed.action)) {
    const error = 'usage: atris api-key create|list|rotate|revoke';
    printResult({ json, ok: false, error, payload: { ok: false, error } }, io);
    return 1;
  }
  if ((parsed.action === 'rotate' || parsed.action === 'revoke') && !parsed.id) {
    const error = `usage: atris api-key ${parsed.action} <id>`;
    printResult({ json, ok: false, error, payload: { ok: false, error } }, io);
    return 1;
  }

  const load = deps.loadCredentials || loadCredentials;
  const request = deps.apiRequestJson || apiRequestJson;
  const token = tokenFrom(load());
  if (!token) {
    printResult({ json, ok: false, error: NOT_LOGGED_IN, payload: { ok: false, error: NOT_LOGGED_IN } }, io);
    return 1;
  }

  try {
    let result;
    if (parsed.action === 'list') {
      result = await request('/developer/keys', { method: 'GET', token });
    } else if (parsed.action === 'create') {
      const body = { name: parsed.name };
      if (parsed.cap != null) body.monthly_spend_cap_usd = parsed.cap;
      result = await request('/developer/create-key', { method: 'POST', token, body });
    } else if (parsed.action === 'rotate') {
      result = await request(`/developer/keys/${encodeURIComponent(parsed.id)}/rotate`, {
        method: 'POST',
        token,
      });
    } else {
      result = await request(`/developer/keys/${encodeURIComponent(parsed.id)}`, {
        method: 'DELETE',
        token,
      });
    }

    const developerRoute = parsed.action === 'list' || parsed.action === 'create';
    if (developerRoute && isNotFound(result)) {
      printResult({
        json,
        ok: false,
        error: ROLLOUT_MESSAGE,
        payload: { ok: false, error: ROLLOUT_MESSAGE, status: 404 },
      }, io);
      return 1;
    }
    if (!result || !result.ok) {
      const error = oneLine(result && result.error);
      printResult({ json, ok: false, error, payload: { ok: false, error, status: result && result.status } }, io);
      return 1;
    }

    const data = result.data || {};
    let text = '';
    if (parsed.action === 'list') text = listKeys(data);
    else if (parsed.action === 'create' || parsed.action === 'rotate') text = createdKeyText(data);
    else text = oneLine(data.message || `api key revoked for ${parsed.id}.`);

    printResult({ json, ok: true, text, payload: { ok: true, ...data } }, io);
    return 0;
  } catch (error) {
    const message = oneLine(error && error.message);
    printResult({ json, ok: false, error: message, payload: { ok: false, error: message } }, io);
    return 1;
  }
}

module.exports = { apiKeyCommand, showApiKeyHelp, parseApiKeyArgs, listKeys };
