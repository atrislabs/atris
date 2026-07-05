'use strict';

// Persistent permission grants (CLI-831, play 1).
// A grant lets an exact approved command pattern auto-redeem its workspace
// approval instead of re-asking. Local store only; backend sync comes later.
// Design brief: atris/designs/permission-grants-cli-831.md

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const GRANTS_SCHEMA = 'atris.permission_grants.v1';

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

module.exports = {
  GRANTS_SCHEMA,
  grantsFilePath,
  parseArgv,
  commandIsGrantable,
  loadGrants,
  saveGrants,
  addGrant,
  revokeGrant,
  matchGrant,
  recordUse,
};
