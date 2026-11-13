'use strict';

// atris agent signin <agent> [--key-file <path>]: an agent proves it holds
// its own Ed25519 private key and gets a short-lived token, with no owner
// login. Backend: POST /api/agents/{id}/signin/challenge, then
// POST /api/agents/{id}/signin with {challenge, signature}
// (atrisos-backend services/agent_signin_service.py).
//
// Keys travel as standard base64 of the raw 32 byte private key, the same
// encoding `atris agent spawn` saves to ~/.atris/agents/<name>.json. The key
// is never printed, logged, written, or taken as an argument. On success
// stdout carries only the token, so TOKEN=$(atris agent signin ...) works.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { buildApiUrl, httpRequest, DEFAULT_CLIENT_ID, DEFAULT_USER_AGENT } = require('../utils/api');
const { oneLine } = require('../lib/developer-api');
const { parseArgs } = require('../lib/business-target');
const home = require('../lib/agent-home');

// The fixed first line of every sign-in message (MESSAGE_PREFIX on the server).
const MESSAGE_PREFIX = 'atris-agent-signin-v1';
// DER header of a PKCS#8 Ed25519 private key; the 32 byte seed follows it.
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const UUID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
const KEY_B64_RE = /^[A-Za-z0-9+/]{43}=$/;

function signinHelp(log) {
  log(`usage: atris agent signin <agent> [--key-file <path>] [--json]

Sign in as an agent with its own private key and print a token for it.
Only the token goes to stdout, so this works:  TOKEN=$(atris agent signin scout)

<agent> is an agent id, or a name saved by atris agent spawn.
--key-file   a file holding the private key: the JSON file spawn saves, or the
             base64 key on its own. Left off, the key spawn saved for that
             agent in ~/.atris/agents is used.
--json       print the server's whole answer as JSON instead of the token.
The key is never taken on the command line and never printed.`);
}

function compactId(value) {
  return String(value || '').toLowerCase().replace(/[^0-9a-f]/g, '');
}

// Saved spawn records in ~/.atris/agents: [{ file, record }].
function savedKeys(env) {
  const dir = path.dirname(home.keyPath('x', env));
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort(); } catch { return []; }
  const out = [];
  for (const name of names) {
    const file = path.join(dir, name);
    try { out.push({ file, record: JSON.parse(fs.readFileSync(file, 'utf8')) }); } catch {}
  }
  return out;
}

// { id, label, keyFile } for the word the user typed, or { error }.
function resolveAgent(ref, flags, cwd, env) {
  const handle = home.handleOf(ref);
  const saved = handle ? home.readKeyFile(handle, env) : null;
  let id = ref;
  let label = ref;
  let keyFile = typeof flags.key_file === 'string' ? path.resolve(cwd, flags.key_file) : null;
  if (saved && saved.agent_id && !UUID_RE.test(ref)) {
    id = String(saved.agent_id);
    label = handle;
    if (!keyFile) keyFile = home.keyPath(handle, env);
  }
  if (!UUID_RE.test(id)) return { error: `${ref} is not an agent id or a name saved by atris agent spawn` };
  if (!keyFile) {
    const match = savedKeys(env).find(({ record }) => record && compactId(record.agent_id) === compactId(id) && record.private_key);
    if (match) keyFile = match.file;
  }
  if (!keyFile) return { error: `no private key for ${label}. pass --key-file <path>` };
  return { id, label, keyFile };
}

// The base64 private key from a key file, or { error } that never quotes the file.
function readPrivateKey(keyFile, agentId) {
  let text;
  try {
    text = fs.readFileSync(keyFile, 'utf8').trim();
  } catch (e) {
    if (e && e.code === 'ENOENT') return { error: `the key file ${keyFile} does not exist` };
    return { error: `could not read the key file ${keyFile}` };
  }
  let key = text;
  if (text.startsWith('{')) {
    let record = null;
    try { record = JSON.parse(text); } catch {}
    if (!record || typeof record.private_key !== 'string') {
      return { error: `${keyFile} holds no private key${record && record.status === 'pending' ? ' (its spawn never finished)' : ''}` };
    }
    if (record.agent_id && compactId(record.agent_id) !== compactId(agentId)) {
      return { error: `${keyFile} holds the key of another agent (${oneLine(record.agent_id)})` };
    }
    key = record.private_key.trim();
  }
  if (!KEY_B64_RE.test(key) || Buffer.from(key, 'base64').length !== 32) {
    return { error: `${keyFile} does not hold a valid agent private key (expected base64 of 32 bytes)` };
  }
  return { key };
}

// Standard base64 Ed25519 signature over the UTF-8 message, as agent_keys.sign does.
function sign(privateB64, message) {
  const der = Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(privateB64, 'base64')]);
  const keyObject = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  return crypto.sign(null, Buffer.from(message, 'utf8'), keyObject).toString('base64');
}

// Sign only a real sign-in message for this agent and this challenge, so a
// server that is not Atris cannot get the key to sign anything else.
function isSigninMessage(message, agentId, challenge) {
  if (typeof message !== 'string') return false;
  const lines = message.split('\n');
  return lines.length === 3 && lines[0] === MESSAGE_PREFIX
    && compactId(lines[1]) === compactId(agentId) && lines[1] === lines[1].toLowerCase()
    && lines[2] === challenge;
}

async function post(route, body) {
  const headers = { 'User-Agent': DEFAULT_USER_AGENT, 'X-Atris-Client': DEFAULT_CLIENT_ID };
  let payload;
  if (body !== undefined) {
    payload = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }
  try {
    const res = await httpRequest(buildApiUrl(route), { method: 'POST', headers, body: payload, timeoutMs: 30000 });
    let data = null;
    try { data = JSON.parse(res.body.toString('utf8')); } catch {}
    return { status: res.status, headers: res.headers || {}, data };
  } catch (e) {
    return { status: 0, headers: {}, data: null, error: e && e.message ? e.message : 'network error' };
  }
}

// The refusal in one plain sentence.
function why(res) {
  const detail = res.data && typeof res.data === 'object' && typeof res.data.detail === 'string' ? oneLine(res.data.detail) : '';
  if (res.status === 0) return `could not reach the Atris server${res.error ? ` (${oneLine(res.error)})` : ''}`;
  if (res.status === 404) return 'sign-in by key is switched off on this server';
  if (res.status === 401) return 'the server refused this key for that agent. It never says why: a wrong key, an unknown or removed agent, or a used or expired challenge';
  if (res.status === 429) {
    const wait = Number.parseInt(res.headers['retry-after'], 10);
    const when = Number.isFinite(wait) && wait > 0 ? `in ${wait} second${wait === 1 ? '' : 's'}` : 'later';
    return `too many sign-in attempts. Try again ${when}`;
  }
  if (res.status === 503) return `sign-in by key is not set up on this server right now${detail ? ` (${detail.replace(/[.\s]*$/, '')})` : ''}`;
  return detail || `the server answered ${res.status}`;
}

function lasts(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= 0) return null;
  if (s % 3600 === 0) return `${s / 3600} hour${s === 3600 ? '' : 's'}`;
  if (s >= 3600) return `about ${Math.round(s / 3600)} hours`;
  return `${Math.max(1, Math.round(s / 60))} minutes`;
}

async function agentSigninCommand(args = [], deps = {}) {
  const secrets = [];
  const hide = (line) => secrets.reduce((text, s) => (s ? text.split(s).join('[hidden]') : text), String(line));
  const out = deps.out || ((text) => process.stdout.write(text));
  const err = (line) => (deps.err || console.error)(hide(line));
  const cwd = deps.cwd || process.cwd();
  const env = deps.env || process.env;

  const { flags, pos, error } = parseArgs(args, { switches: [], values: ['key_file'] });
  if (flags.help || pos[0] === 'help') { signinHelp((line) => out(`${line}\n`)); return 0; }
  if (error) { err(`atris agent signin: ${error}. see: atris agent signin --help`); return 1; }
  if (pos.length !== 1) { err('atris agent signin takes one agent, like: atris agent signin <agent> --key-file <path>'); return 1; }

  const agent = resolveAgent(pos[0], flags, cwd, env);
  if (agent.error) { err(`could not sign in: ${agent.error}`); return 1; }
  const { key, error: keyError } = readPrivateKey(agent.keyFile, agent.id);
  if (keyError) { err(`could not sign in ${agent.label}: ${keyError}`); return 1; }
  secrets.push(key);

  const base = `/agents/${encodeURIComponent(agent.id)}/signin`;
  const asked = await post(`${base}/challenge`);
  if (asked.status !== 200) { err(`could not sign in ${agent.label}: ${why(asked)}`); return 1; }
  const challenge = asked.data && asked.data.challenge;
  if (typeof challenge !== 'string' || !isSigninMessage(asked.data.message, agent.id, challenge)) {
    err(`could not sign in ${agent.label}: the server sent a challenge that is not an Atris sign-in, so nothing was signed`);
    return 1;
  }

  const signature = sign(key, asked.data.message);
  const res = await post(base, { challenge, signature });
  if (res.status !== 200) { err(`could not sign in ${agent.label}: ${why(res)}`); return 1; }
  const data = res.data || {};
  if (typeof data.token !== 'string' || !data.token) {
    err(`could not sign in ${agent.label}: the server sent an answer this version of atris cannot read`);
    return 1;
  }
  secrets.push(data.token);

  if (flags.json) { out(`${JSON.stringify(data, null, 2)}\n`); return 0; }
  out(`${data.token}\n`);
  const name = data.home && typeof data.home.name === 'string' && data.home.name.trim() ? data.home.name.trim() : agent.label;
  const id = data.agent_id || agent.id;
  const life = lasts(data.expires_in);
  err(`Signed in as ${name}${name === id ? '' : ` (${id})`}.${life ? ` The token lasts ${life}; sign in again for a fresh one.` : ''}`);
  return 0;
}

module.exports = {
  agentSigninCommand,
};
