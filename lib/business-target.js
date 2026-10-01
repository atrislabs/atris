'use strict';

// Shared plumbing for business-scoped HTTP commands (`atris hire`, `atris hires`,
// `atris mail`): parse flags, find which business to act on, get a login token.
// These commands are HTTP clients of /api/business/{id}/...; no backend code here.

const { apiRequestJson } = require('../utils/api');
const { ensureValidCredentials } = require('../utils/auth');
const { findBusiness } = require('../commands/feed');
const { oneLine } = require('./developer-api');

const NO_BUSINESS = 'no business here. run this inside a business folder, or add --business <slug>';

// --key value, --key=value, and boolean flags that never take a value.
function parseArgs(argv = [], boolFlags = []) {
  const bools = new Set(boolFlags);
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i]);
    if (arg === '-h') { flags.help = true; continue; }
    if (arg === '-y') { flags.yes = true; continue; }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const key = (eq > 0 ? arg.slice(2, eq) : arg.slice(2)).replace(/-/g, '_');
      if (eq > 0) { flags[key] = arg.slice(eq + 1); continue; }
      if (bools.has(key) || key === 'help' || key === 'json' || key === 'yes') { flags[key] = true; continue; }
      const next = argv[i + 1];
      if (next != null && !String(next).startsWith('--')) { flags[key] = String(next); i += 1; } else flags[key] = true;
      continue;
    }
    pos.push(arg);
  }
  return { flags, pos };
}

// --business wins (the backend takes a slug or an id), else the nearest
// .atris/business.json above the current folder.
function resolveBusiness(flags = {}, deps = {}) {
  if (typeof flags.business === 'string' && flags.business.trim()) {
    return { id: flags.business.trim(), name: flags.business.trim() };
  }
  const found = (deps.findBusiness || findBusiness)(deps.cwd || process.cwd());
  return found ? { id: found.businessId, name: found.name || 'this business' } : null;
}

async function loginToken(deps = {}) {
  if (deps.token) return deps.token;
  const ensure = deps.ensureCredentials || (() => ensureValidCredentials(apiRequestJson));
  const auth = await ensure();
  return auth && !auth.error && auth.credentials && auth.credentials.token ? auth.credentials.token : '';
}

// FastAPI errors arrive as {"detail": "..."}; keep them to one plain line.
function errorText(result) {
  if (!result) return 'request failed';
  if (Number(result.status) === 404 && !(result.data && result.data.detail)) {
    return 'backend rolling out, try again shortly';
  }
  return oneLine((result.data && (result.data.detail || result.data.error)) || result.error || `request failed (${result.status})`);
}

// "2026-10-02T09:00:00+00:00" -> "in 9 h" / "6 h ago"
function relativeTime(iso, now = Date.now()) {
  const at = Date.parse(iso || '');
  if (!Number.isFinite(at)) return '';
  const mins = Math.round((at - now) / 60000);
  const abs = Math.abs(mins);
  const span = abs < 1 ? 'now' : abs < 90 ? `${abs} min` : abs < 48 * 60 ? `${Math.round(abs / 60)} h` : `${Math.round(abs / 1440)} days`;
  if (span === 'now') return 'just now';
  return mins >= 0 ? `in ${span}` : `${span} ago`;
}

function dollars(value) {
  if (value == null || !Number.isFinite(Number(value))) return '-';
  const n = Number(value);
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

function clip(text, width) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return s.length > width ? `${s.slice(0, width - 1)}…` : s;
}

module.exports = { NO_BUSINESS, parseArgs, resolveBusiness, loginToken, errorText, relativeTime, dollars, clip };
