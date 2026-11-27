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

async function safeRequest(request, method, url, body = null, headers = {}) {
  try {
    return await request(method, url, body, headers);
  } catch (error) {
    return { status: 0, data: { error: error && error.message ? error.message : String(error) } };
  }
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
  const res = await safeRequest(request, 'POST', `${hubBase(server)}/api/register`, body, headers);
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
  const res = await safeRequest(
    request,
    'POST',
    `${hubBase(server)}/api/${encodeURIComponent(hub)}/channels/${encodeURIComponent(channel)}/posts`,
    body,
    { Authorization: `Bearer ${token}` },
  );
  return { ok: res.status >= 200 && res.status < 300, status: res.status, data: res.data };
}

async function claimFileNote({ server, hub, channel, filePath, content, token, memberId, memberName }, { request = swarloRequest } = {}) {
  const body = { file_path: filePath, content: content || `Frozen module: ${filePath}` };
  if (memberId) body.member_id = memberId;
  if (memberName) body.member_name = memberName;
  const res = await safeRequest(
    request,
    'POST',
    `${hubBase(server)}/api/${encodeURIComponent(hub)}/channels/${encodeURIComponent(channel)}/claim-file`,
    body,
    { Authorization: `Bearer ${token}` },
  );
  return { ok: res.status >= 200 && res.status < 300, status: res.status, data: res.data };
}

async function postTaskNote({ server, hub, channel, taskKey, content, dependsOn, priority = 0, metadata, token, memberId, memberName }, { request = swarloRequest } = {}) {
  const body = { content, kind: 'message', task_key: taskKey, priority: Number(priority) || 0 };
  if (Array.isArray(dependsOn) && dependsOn.length) body.depends_on = dependsOn;
  if (metadata && typeof metadata === 'object') body.metadata = metadata;
  if (memberId) body.member_id = memberId;
  if (memberName) body.member_name = memberName;
  const res = await safeRequest(
    request,
    'POST',
    `${hubBase(server)}/api/${encodeURIComponent(hub)}/channels/${encodeURIComponent(channel)}/posts`,
    body,
    { Authorization: `Bearer ${token}` },
  );
  return { ok: res.status >= 200 && res.status < 300, status: res.status, data: res.data };
}

async function claimTaskNote({ server, hub, channel, taskKey, content, dependsOn, token, memberId, memberName }, { request = swarloRequest } = {}) {
  const body = { task_key: taskKey, content: content || `Claiming ${taskKey}` };
  if (Array.isArray(dependsOn) && dependsOn.length) body.depends_on = dependsOn;
  if (memberId) body.member_id = memberId;
  if (memberName) body.member_name = memberName;
  const res = await safeRequest(
    request,
    'POST',
    `${hubBase(server)}/api/${encodeURIComponent(hub)}/channels/${encodeURIComponent(channel)}/claim`,
    body,
    { Authorization: `Bearer ${token}` },
  );
  return {
    ok: res.status >= 200 && res.status < 300,
    status: res.status,
    conflict: res.status === 409,
    data: res.data,
  };
}

async function touchClaimNote({ server, hub, channel, taskKey, token, memberId, memberName }, { request = swarloRequest } = {}) {
  const body = { task_key: taskKey };
  if (memberId) body.member_id = memberId;
  if (memberName) body.member_name = memberName;
  const res = await safeRequest(
    request,
    'POST',
    `${hubBase(server)}/api/${encodeURIComponent(hub)}/channels/${encodeURIComponent(channel)}/touch`,
    body,
    { Authorization: `Bearer ${token}` },
  );
  return { ok: res.status >= 200 && res.status < 300, status: res.status, data: res.data };
}

async function reportTaskNote({ server, hub, channel, taskKey, status, content, includeNext = false, idempotencyKey = '', token, memberId, memberName }, { request = swarloRequest } = {}) {
  const body = {
    task_key: taskKey,
    status,
    content: content || `${status}: ${taskKey}`,
    include_next: Boolean(includeNext),
  };
  if (idempotencyKey) body.idempotency_key = idempotencyKey;
  if (memberId) body.member_id = memberId;
  if (memberName) body.member_name = memberName;
  const headers = { Authorization: `Bearer ${token}` };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const suffix = idempotencyKey ? '/once' : '';
  const res = await safeRequest(
    request,
    'POST',
    `${hubBase(server)}/api/${encodeURIComponent(hub)}/channels/${encodeURIComponent(channel)}/report${suffix}`,
    body,
    headers,
  );
  return { ok: res.status >= 200 && res.status < 300, status: res.status, data: res.data };
}

async function fetchPullQueue({ server, hub, channel, memberId, token }, { request = swarloRequest } = {}) {
  const base = `${hubBase(server)}/api/${encodeURIComponent(hub)}`;
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const ch = encodeURIComponent(channel);
  const mem = encodeURIComponent(memberId);
  const [ready, unclaimed, posts] = await Promise.all([
    request('GET', `${base}/ready/${mem}`, null, headers).catch((e) => ({ status: 0, error: e.message })),
    request('GET', `${base}/unclaimed?channel=${ch}&limit=100`, null, headers).catch((e) => ({ status: 0, error: e.message })),
    request('GET', `${base}/channels/${ch}/posts?limit=200`, null, headers).catch((e) => ({ status: 0, error: e.message })),
  ]);
  const isOk = (r) => Boolean(r && r.status >= 200 && r.status < 300);
  return {
    ok: [ready, unclaimed, posts].some(isOk),
    ready: isOk(ready) && Array.isArray(ready.data && ready.data.tasks) ? ready.data.tasks : [],
    unclaimed: isOk(unclaimed) && Array.isArray(unclaimed.data && unclaimed.data.tasks) ? unclaimed.data.tasks : [],
    posts: isOk(posts) && Array.isArray(posts.data && posts.data.posts) ? posts.data.posts : [],
  };
}

async function fetchBriefing({ server, hub, task, limit = 10, scorer = 'tfidf', token }, { request = swarloRequest } = {}) {
  const res = await safeRequest(
    request,
    'POST',
    `${hubBase(server)}/api/${encodeURIComponent(hub)}/briefing`,
    { task, limit: Number(limit) || 10, scorer: scorer || 'tfidf' },
    token ? { Authorization: `Bearer ${token}` } : {},
  );
  return { ok: res.status >= 200 && res.status < 300, status: res.status, data: res.data };
}

async function fetchHubSnapshot({ server, hub, token, staleMinutes = 10, autoExpire = false }, { request = swarloRequest } = {}) {
  const base = `${hubBase(server)}/api/${encodeURIComponent(hub)}`;
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const qs = `stale_minutes=${encodeURIComponent(String(staleMinutes))}&auto_expire=${autoExpire ? 'true' : 'false'}`;
  const idleQs = `idle_minutes=${encodeURIComponent(String(staleMinutes))}`;
  const [liveness, idle, claims, unclaimed, members] = await Promise.all([
    request('GET', `${base}/liveness?${qs}`, null, headers).catch((e) => ({ status: 0, error: e.message })),
    request('GET', `${base}/idle?${idleQs}`, null, headers).catch((e) => ({ status: 0, error: e.message })),
    request('GET', `${base}/claims`, null, headers).catch((e) => ({ status: 0, error: e.message })),
    request('GET', `${base}/unclaimed`, null, headers).catch((e) => ({ status: 0, error: e.message })),
    request('GET', `${base}/members`, null, headers).catch((e) => ({ status: 0, error: e.message })),
  ]);
  const isOk = (r) => Boolean(r && r.status >= 200 && r.status < 300);
  const ok = [liveness, claims, members].some(isOk);
  return {
    ok,
    liveness: isOk(liveness) ? liveness.data : null,
    idle: isOk(idle) ? idle.data : null,
    claims: isOk(claims) ? claims.data : null,
    unclaimed: isOk(unclaimed) ? unclaimed.data : null,
    members: isOk(members) ? members.data : null,
  };
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
  claimFileNote,
  postTaskNote,
  claimTaskNote,
  touchClaimNote,
  reportTaskNote,
  fetchPullQueue,
  fetchBriefing,
  fetchHubSnapshot,
  loadLaunched,
  saveLaunched,
};
