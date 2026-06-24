const fs = require('fs');
const os = require('os');
const path = require('path');

const MEMBER_SLUG = 'ax';
const PREFS_PATH = path.join(os.homedir(), '.atris', 'ax.json');
const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

function truthy(value) {
  return TRUTHY.has(String(value || '').trim().toLowerCase());
}

function loadAxPrefs() {
  try {
    if (!fs.existsSync(PREFS_PATH)) {
      return { member_slug: MEMBER_SLUG, bypass_permissions: false };
    }
    const parsed = JSON.parse(fs.readFileSync(PREFS_PATH, 'utf8'));
    return {
      member_slug: MEMBER_SLUG,
      bypass_permissions: parsed.bypass_permissions === true,
    };
  } catch {
    return { member_slug: MEMBER_SLUG, bypass_permissions: false };
  }
}

function saveAxPrefs(prefs) {
  fs.mkdirSync(path.dirname(PREFS_PATH), { recursive: true });
  fs.writeFileSync(PREFS_PATH, `${JSON.stringify({
    member_slug: MEMBER_SLUG,
    bypass_permissions: prefs.bypass_permissions === true,
    updated_at: new Date().toISOString(),
  }, null, 2)}\n`);
  return loadAxPrefs();
}

function setBypassPermissions(enabled, { persist = true } = {}) {
  const next = { member_slug: MEMBER_SLUG, bypass_permissions: enabled === true };
  return persist ? saveAxPrefs(next) : next;
}

function resolveBypassPermissions(options = {}) {
  if (options.bypassPermissions === true) return true;
  if (options.bypassPermissions === false) return false;
  if (truthy(process.env.AX_BYPASS_PERMISSIONS)) return true;
  if (truthy(process.env.AX_SAFE_PERMISSIONS)) return false;
  return loadAxPrefs().bypass_permissions === true;
}

function permissionsLabel(options = {}) {
  return resolveBypassPermissions(options) ? 'bypass' : 'safe';
}

module.exports = {
  MEMBER_SLUG,
  PREFS_PATH,
  loadAxPrefs,
  saveAxPrefs,
  setBypassPermissions,
  resolveBypassPermissions,
  permissionsLabel,
};
