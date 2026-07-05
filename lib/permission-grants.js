'use strict';

// Persistent permission grants (CLI-831).
// A grant lets an exact approved command pattern auto-redeem its workspace
// approval instead of re-asking. syncGrants() pushes the local store to the
// backend and pulls back grants created or revoked from atrisos-web, so the
// same grants can be reviewed and revoked from the web.
// Design brief: atris/designs/permission-grants-cli-831.md

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const GRANTS_SCHEMA = 'atris.permission_grants.v1';

// Backend reconciliation endpoint. The CLI POSTs its local grants and the
// backend echoes the authoritative set (including web-created/revoked grants).
const GRANTS_SYNC_ENDPOINT = '/workspace/permission-grants/sync';

// Shell metacharacters change the meaning of a command after matching, so a
// command containing any of them is never grantable and never matchable.
const SHELL_META = /[;&|<>`$(){}\[\]*?~\\\n\r]|\r|\n/;

// Commands that must always re-ask, no matter what the operator granted.
const NEVER_GRANTABLE = [
  /^sudo\b/,
  /\brm\s+(-\w*[rf]\w*\s+)+/,
  /\bgit\s+push\s+.*--force/,
  /\bgit\s+reset\s+--hard/,
  /\b(sh|bash|zsh)\s+-c\b/,
  /\bnode\s+-e\b/,
  /\bpython3?\s+-c\b/,
  /\bchmod\b|\bchown\b/,
  /credentials\.json|\.ssh\b|\.env\b/,
  /\batris\s+task\s+accept\b/,
  /\bautoland\b.*polic/,
];

function grantsFilePath() {
  return process.env.ATRIS_PERMISSION_GRANTS_FILE
    || path.join(os.homedir(), '.atris', 'permission-grants.json');
}

function parseArgv(command) {
  const text = String(command || '').trim();
  if (!text || SHELL_META.test(text)) return null;
  const argv = text.split(/\s+/).filter(Boolean);
  return argv.length ? argv : null;
}

function commandIsGrantable(command) {
  const text = String(command || '').trim();
  if (!text) return { ok: false, reason: 'empty command' };
  if (SHELL_META.test(text)) return { ok: false, reason: 'shell metacharacters are never grantable' };
  for (const rule of NEVER_GRANTABLE) {
    if (rule.test(text)) return { ok: false, reason: `never grantable: matches ${rule}` };
  }
  return { ok: true };
}

function loadGrants(file = grantsFilePath()) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data && data.schema === GRANTS_SCHEMA && Array.isArray(data.grants)) return data;
  } catch {
    // Missing or unreadable store means no grants; fail closed to re-asking.
  }
  return { schema: GRANTS_SCHEMA, grants: [] };
}

function saveGrants(store, file = grantsFilePath()) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function canonicalRoot(workspaceRoot) {
  try {
    return fs.realpathSync(String(workspaceRoot || ''));
  } catch {
    return String(workspaceRoot || '');
  }
}

function addGrant({ command, workspaceRoot, createdVia = 'cli', expiresInDays = 30, file } = {}) {
  const grantable = commandIsGrantable(command);
  if (!grantable.ok) return { ok: false, reason: grantable.reason };
  const argv = parseArgv(command);
  if (!argv) return { ok: false, reason: 'command does not parse to a plain argv' };
  const root = canonicalRoot(workspaceRoot);
  if (!root || root === '/') return { ok: false, reason: 'grants must be scoped to a workspace root' };
  const store = loadGrants(file);
  const now = new Date();
  const grant = {
    grant_id: `grant-${crypto.randomBytes(6).toString('hex')}`,
    status: 'active',
    scope: { kind: 'workspace', workspace_root: root },
    principal: { created_via: createdVia },
    action_type: 'local_command',
    pattern: {
      type: 'exact_argv',
      argv,
      display: argv.join(' '),
      normalized_hash: crypto.createHash('sha256').update(argv.join(' ')).digest('hex'),
    },
    constraints: {
      expires_at: new Date(now.getTime() + expiresInDays * 24 * 60 * 60 * 1000).toISOString(),
      cwd_must_be_within_workspace: true,
    },
    audit: { created_at: now.toISOString(), last_used_at: null, use_count: 0 },
  };
  store.grants.push(grant);
  saveGrants(store, file);
  return { ok: true, grant };
}

function revokeGrant(grantId, file) {
  const store = loadGrants(file);
  const grant = store.grants.find(g => g.grant_id === grantId || String(g.grant_id).startsWith(String(grantId)));
  if (!grant) return { ok: false, reason: 'grant not found' };
  grant.status = 'revoked';
  grant.sync = { ...(grant.sync || {}), revoked_at: new Date().toISOString() };
  saveGrants(store, file);
  return { ok: true, grant };
}

function matchGrant({ command, workspaceRoot, now = new Date(), file } = {}) {
  const argv = parseArgv(command);
  if (!argv) return null;
  if (!commandIsGrantable(command).ok) return null;
  const root = canonicalRoot(workspaceRoot);
  const store = loadGrants(file);
  for (const grant of store.grants) {
    if (grant.status !== 'active') continue;
    if (grant.action_type !== 'local_command') continue;
    if (!grant.scope || grant.scope.workspace_root !== root) continue;
    const expiresAt = grant.constraints && grant.constraints.expires_at;
    if (expiresAt && new Date(expiresAt).getTime() <= now.getTime()) continue;
    const maxUses = grant.constraints && grant.constraints.max_uses;
    if (maxUses && (grant.audit?.use_count || 0) >= maxUses) continue;
    const pattern = grant.pattern || {};
    if (pattern.type === 'exact_argv') {
      if (Array.isArray(pattern.argv)
        && pattern.argv.length === argv.length
        && pattern.argv.every((token, i) => token === argv[i])) return grant;
    } else if (pattern.type === 'argv_prefix') {
      if (Array.isArray(pattern.argv)
        && pattern.argv.length <= argv.length
        && pattern.argv.every((token, i) => token === argv[i])) return grant;
    }
  }
  return null;
}

function recordUse(grantId, file) {
  const store = loadGrants(file);
  const grant = store.grants.find(g => g.grant_id === grantId);
  if (!grant) return null;
  grant.audit = grant.audit || {};
  grant.audit.use_count = (grant.audit.use_count || 0) + 1;
  grant.audit.last_used_at = new Date().toISOString();
  saveGrants(store, file);
  return grant;
}

// A grant pulled from the backend is only trusted if it would itself have been
// grantable locally. This is the fail-closed seam for sync: a compromised or
// buggy backend can never inject an auto-approvable dangerous pattern, because
// its command must survive the same NEVER_GRANTABLE / metacharacter gate that
// addGrant() applies. Malformed or non-command grants are dropped.
function normalizeRemoteGrant(remote) {
  if (!remote || typeof remote !== 'object') return null;
  if (String(remote.action_type || '') !== 'local_command') return null;
  const grantId = String(remote.grant_id || '');
  if (!grantId) return null;
  const pattern = remote.pattern || {};
  const type = pattern.type;
  if (type !== 'exact_argv' && type !== 'argv_prefix') return null;
  if (!Array.isArray(pattern.argv) || !pattern.argv.length) return null;
  if (!pattern.argv.every(token => typeof token === 'string' && token.length)) return null;
  const display = typeof pattern.display === 'string' && pattern.display
    ? pattern.display
    : pattern.argv.join(' ');
  if (!commandIsGrantable(display).ok) return null;
  const root = String((remote.scope && remote.scope.workspace_root) || '');
  if (!root || root === '/') return null;
  return {
    grant_id: grantId,
    status: remote.status === 'revoked' ? 'revoked' : 'active',
    scope: { kind: 'workspace', workspace_root: root },
    principal: (remote.principal && typeof remote.principal === 'object')
      ? remote.principal
      : { created_via: 'web' },
    action_type: 'local_command',
    pattern: {
      type,
      argv: pattern.argv.slice(),
      display,
      normalized_hash: crypto.createHash('sha256').update(pattern.argv.join(' ')).digest('hex'),
    },
    constraints: (remote.constraints && typeof remote.constraints === 'object')
      ? remote.constraints
      : {},
    audit: (remote.audit && typeof remote.audit === 'object')
      ? remote.audit
      : { created_at: null, last_used_at: null, use_count: 0 },
    sync: (remote.sync && typeof remote.sync === 'object')
      ? remote.sync
      : { source: 'web' },
  };
}

// Merge the backend's authoritative grants into the local store in place.
// - New grants (created/managed from web) are pulled down so the CLI can redeem
//   them locally.
// - Revocation always wins: a grant revoked on the web is revoked locally, and a
//   grant we already revoked is never resurrected. Permission state fails closed.
function mergeRemoteGrants(store, remoteGrants = [], now = new Date()) {
  const byId = new Map(store.grants.map(g => [g.grant_id, g]));
  let pulled = 0;
  let revoked = 0;
  let rejected = 0;
  for (const raw of Array.isArray(remoteGrants) ? remoteGrants : []) {
    const remote = normalizeRemoteGrant(raw);
    if (!remote) { rejected += 1; continue; }
    const local = byId.get(remote.grant_id);
    if (!local) {
      store.grants.push(remote);
      byId.set(remote.grant_id, remote);
      if (remote.status === 'revoked') revoked += 1;
      else pulled += 1;
      continue;
    }
    if (remote.status === 'revoked' && local.status !== 'revoked') {
      local.status = 'revoked';
      local.sync = {
        ...(local.sync || {}),
        revoked_at: (remote.sync && remote.sync.revoked_at) || now.toISOString(),
        revoked_by: 'web',
      };
      revoked += 1;
    }
  }
  return { pulled, revoked, rejected };
}

// Push the local grants to the backend and merge back the authoritative set.
// apiRequestJson is injected (utils/api) so this stays offline-testable. The
// call is best-effort: on any transport/HTTP failure the local store is left
// untouched and { ok: false, reason } is returned — grants keep working locally.
async function syncGrants({ apiRequestJson, token, file, endpoint = GRANTS_SYNC_ENDPOINT, now = new Date() } = {}) {
  if (typeof apiRequestJson !== 'function') {
    return { ok: false, reason: 'no api client' };
  }
  const store = loadGrants(file);
  let response;
  try {
    response = await apiRequestJson(endpoint, {
      method: 'POST',
      token,
      body: { schema: GRANTS_SCHEMA, grants: store.grants },
    });
  } catch (error) {
    return { ok: false, reason: (error && error.message) || 'sync request failed', pushed: store.grants.length };
  }
  if (!response || !response.ok) {
    return { ok: false, reason: (response && response.error) || 'sync request failed', pushed: store.grants.length };
  }
  const remoteGrants = (response.data && Array.isArray(response.data.grants)) ? response.data.grants : [];
  const merged = mergeRemoteGrants(store, remoteGrants, now);
  saveGrants(store, file);
  return { ok: true, pushed: store.grants.length, ...merged };
}

module.exports = {
  GRANTS_SCHEMA,
  GRANTS_SYNC_ENDPOINT,
  grantsFilePath,
  parseArgv,
  commandIsGrantable,
  loadGrants,
  saveGrants,
  addGrant,
  revokeGrant,
  matchGrant,
  recordUse,
  normalizeRemoteGrant,
  mergeRemoteGrants,
  syncGrants,
};
