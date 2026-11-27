'use strict';

// Per-member Swarlo identities for `atris fleet up`. Each activated team
// member gets its own key under
//   ~/.swarlo/identities/<server-host-slug>/<hub>/<member>/config.json
// so board posts and claims are attributed to the member instead of the
// shared machine config. lib/self-drive.js reads the same layout when a
// mission blocker needs the owning member's escalation key, so the path and
// token rules live here once.
//
// The config file keeps the swarlo CLI's field names (server, hub,
// member_id, api_key) plus `token`, the name `atris fleet up` writes first.
// Both token fields always hold the same key.

const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');

const DEFAULT_HUB_ID = 'atris';

function swarloHome(home) {
  return path.join(home || os.homedir(), '.swarlo');
}

// 'http://localhost:8090' -> 'localhost-8090'. Only the host (port included)
// is used, slugged so it is a safe directory name on every platform.
function serverSlug(server) {
  let host = '';
  try {
    host = new URL(String(server || '')).host;
  } catch {
    host = '';
  }
  if (!host) host = String(server || 'default');
  return host.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'default';
}

function identityDirFor({ server, hub, member }, home) {
  const hubSlug = String(hub || DEFAULT_HUB_ID).replace(/[^a-zA-Z0-9._-]+/g, '-');
  return path.join(swarloHome(home), 'identities', serverSlug(server), hubSlug, String(member || ''));
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// The bearer key inside an identity config, under either field name.
function identityToken(config) {
  if (!config || typeof config !== 'object') return '';
  return String(config.token || config.api_key || '').trim();
}

// { dir, config, token } for one member identity dir, or null when there is
// no readable config.json. token is '' when the file carries no key.
function loadIdentity(dir) {
  const config = readJsonFile(path.join(dir, 'config.json'));
  if (!config || typeof config !== 'object') return null;
  return { dir, config, token: identityToken(config) };
}

// Write config.json owner-only. mode only applies at creation, so chmod
// runs every time to repair a file that exists with wider permissions.
function saveIdentity(dir, fields) {
  fs.mkdirSync(dir, { recursive: true });
  const config = { ...(fields || {}) };
  const token = String(config.token || config.api_key || '').trim();
  if (token) {
    config.token = token;
    config.api_key = token;
  }
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {}
  return config;
}

// Every identity dir on this machine that belongs to `member`, as
// { dir, config, token, hub, server_dir }. token may be ''.
function listMemberIdentities(member, home) {
  const name = String(member || '').trim();
  const found = [];
  if (!name) return found;
  const root = path.join(swarloHome(home), 'identities');
  let serverEntries = [];
  try {
    serverEntries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const serverEntry of serverEntries) {
    if (!serverEntry.isDirectory()) continue;
    const serverDir = path.join(root, serverEntry.name);
    let hubEntries = [];
    try {
      hubEntries = fs.readdirSync(serverDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const hubEntry of hubEntries) {
      if (!hubEntry.isDirectory()) continue;
      const ident = loadIdentity(path.join(serverDir, hubEntry.name, name));
      if (ident) found.push({ ...ident, hub: hubEntry.name, server_dir: serverEntry.name });
    }
  }
  return found;
}

// The member's identity for this server+hub. When several servers or hubs
// hold a key for the same member name, the one matching the requested hub
// and server wins; ties break on path so the answer is stable. env fills in
// server/hub when the caller does not pass them. null when the member has
// no identity anywhere.
function findMemberIdentity(member, { server = '', hub = '', home } = {}) {
  const name = String(member || '').trim();
  if (!name) return null;
  const wantedHub = String(hub || process.env.SWARLO_HUB_ID || DEFAULT_HUB_ID);
  const wantedServerSlug = serverSlug(server || process.env.SWARLO_HUB_URL || process.env.SWARLO_HUB || '');
  const candidates = listMemberIdentities(name, home).filter((ident) => ident.token);
  if (!candidates.length) return null;
  const score = (ident) => {
    let value = 0;
    if (String(ident.config.hub || ident.hub || '') === wantedHub) value += 2;
    if (serverSlug(ident.config.server || '') === wantedServerSlug) value += 1;
    return value;
  };
  candidates.sort((a, b) => score(b) - score(a) || a.dir.localeCompare(b.dir));
  return candidates[0];
}

// Just the key, for callers that only need to authenticate (self-drive).
function findMemberToken(member, options = {}) {
  const ident = findMemberIdentity(member, options);
  return ident ? ident.token : '';
}

// Channels a hub config asks members to join: `channels` list or a single
// `channel` string. Empty means the caller's default applies.
function configuredChannels(config) {
  const out = [];
  if (config && Array.isArray(config.channels)) {
    for (const entry of config.channels) {
      const name = String(entry || '').trim();
      if (name) out.push(name);
    }
  } else if (config && config.channel) {
    const name = String(config.channel).trim();
    if (name) out.push(name);
  }
  return out;
}

// ── HTTP ─────────────────────────────────────────────────

// Same shape as commands/fleet.js request(): resolves { status, data } with
// data parsed as JSON when possible. Rejects only on transport errors.
function swarloRequest(method, urlStr, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const mod = url.protocol === 'https:' ? https : http;
    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
    };
    const req = mod.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function hubBase(server) {
  return String(server || '').replace(/\/+$/, '');
}

async function hubHealth(server, { request = swarloRequest } = {}) {
  try {
    const res = await request('GET', `${hubBase(server)}/api/health`);
    return { ok: res.status >= 200 && res.status < 300, status: res.status };
  } catch (error) {
    return { ok: false, status: 0, error: error.message || String(error) };
  }
}

// POST /api/register, the same call `swarlo join` makes. Returns the issued
// key as `token` (swarlo calls it api_key). A 409 means the member id is
// already registered on that hub; the caller needs a stored key or an
// invite to recover.
async function registerMember({ server, hub, memberId, memberName, inviteToken, sponsorKey }, { request = swarloRequest } = {}) {
  const headers = {};
  if (sponsorKey) headers.Authorization = `Bearer ${sponsorKey}`;
  const body = {
    hub_id: hub,
    member_id: memberId,
    member_name: memberName || memberId,
    member_type: 'agent',
  };
  if (inviteToken) body.invite_token = inviteToken;
  const res = await request('POST', `${hubBase(server)}/api/register`, body, headers);
  const data = res && res.data && typeof res.data === 'object' ? res.data : {};
  const token = String(data.api_key || data.token || '').trim();
  return {
    ok: res.status >= 200 && res.status < 300 && Boolean(token),
    status: res.status,
    data: res.data,
    token,
  };
}

// One board post as the member. Swarlo has no channel-membership API:
// channels are implicit, so "joining" a channel is leaving the member's
// ready note where the team reads it.
async function postChannelNote({ server, hub, channel, content, kind = 'status', token, memberId, memberName }, { request = swarloRequest } = {}) {
  const body = { content, kind };
  if (memberId) body.member_id = memberId;
  if (memberName) body.member_name = memberName;
  const res = await request(
    'POST',
    `${hubBase(server)}/api/${encodeURIComponent(hub)}/channels/${encodeURIComponent(channel)}/posts`,
    body,
    { Authorization: `Bearer ${token}` },
  );
  return { ok: res.status >= 200 && res.status < 300, status: res.status, data: res.data };
}

// ── Launched tracking ────────────────────────────────────

// ~/.swarlo/fleet-launched.json: { <hub>: { <member>: {server, engine,
// channels, member_name, launched_at} } }. Machine-level state because the
// identities it points at are machine-level.
function launchedPath(home) {
  return path.join(swarloHome(home), 'fleet-launched.json');
}

function loadLaunched(home) {
  const state = readJsonFile(launchedPath(home));
  return state && typeof state === 'object' && !Array.isArray(state) ? state : {};
}

function saveLaunched(state, home) {
  const dir = swarloHome(home);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(launchedPath(home), `${JSON.stringify(state || {}, null, 2)}\n`, 'utf8');
  return state || {};
}

module.exports = {
  DEFAULT_HUB_ID,
  serverSlug,
  swarloRequest,
  identityDirFor,
  loadIdentity,
  saveIdentity,
  findMemberToken,
  configuredChannels,
  hubHealth,
  registerMember,
  postChannelNote,
  loadLaunched,
  saveLaunched,
};
