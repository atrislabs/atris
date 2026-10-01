'use strict';

// Shared plumbing for business-scoped HTTP commands (`atris hire`, `atris hires`,
// `atris mail`): parse flags, find which business to act on, get a login token.
// These commands are HTTP clients of /api/business/{id}/...; no backend code here.

const { apiRequestJson } = require('../utils/api');
const { ensureValidCredentials } = require('../utils/auth');
const { findBusiness } = require('../commands/feed');
const { oneLine } = require('./developer-api');

const NO_BUSINESS = 'no business here. run this inside a business folder, or add --business <slug>';

// --help, --json and --business are allowed on every command.
const COMMON_SWITCHES = ['help', 'json'];
const COMMON_VALUES = ['business'];

// --key value, --key=value, and yes/no switches that never take a value.
// `spec` is { switches: [...], values: [...] }: the only flags the command
// takes, beyond the common ones. Anything else comes back as `error`, and
// the command must stop before making any request:
//   an unknown flag (--dry-run on a command without it),
//   a value on a switch (--yes=false is refused, never read as yes),
//   a value flag with nothing after it (--business ""),
//   the same value flag twice.
// A plain array is the old lenient form (switch names only), kept for callers
// that want it; it never reports errors.
function parseArgs(argv = [], spec = []) {
  const strict = !Array.isArray(spec);
  const switchNames = strict ? (spec.switches || []) : spec;
  const valueNames = strict ? (spec.values || []) : [];
  const switches = new Set([...switchNames, ...COMMON_SWITCHES, 'yes']);
  const allowed = new Set([...switchNames, ...valueNames, ...COMMON_SWITCHES, ...COMMON_VALUES]);
  const flags = {};
  const pos = [];
  let error = '';
  const fail = (message) => { if (!error) error = message; };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i]);
    if (arg === '-h') { flags.help = true; continue; }
    if (arg === '-y') {
      if (strict && !allowed.has('yes')) fail('unknown option -y');
      else flags.yes = true;
      continue;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const raw = eq > 0 ? arg.slice(0, eq) : arg;
      const key = raw.slice(2).replace(/-/g, '_');
      if (strict && !allowed.has(key)) { fail(`unknown option ${raw}`); continue; }
      if (switches.has(key)) {
        if (eq < 0) flags[key] = true;
        else if (strict) fail(`${raw} is a switch and takes no value: use ${raw} on its own, or leave it off`);
        else flags[key] = arg.slice(eq + 1);
        continue;
      }
      let value = true;
      if (eq > 0) value = arg.slice(eq + 1);
      else if (argv[i + 1] != null && !String(argv[i + 1]).startsWith('--')) { value = String(argv[i + 1]); i += 1; }
      if (strict && (typeof value !== 'string' || !value.trim())) { fail(`${raw} needs a value`); continue; }
      if (strict && Object.prototype.hasOwnProperty.call(flags, key)) { fail(`${raw} was given twice`); continue; }
      flags[key] = value;
      continue;
    }
    if (strict && arg.length > 1 && arg.startsWith('-')) { fail(`unknown option ${arg}`); continue; }
    pos.push(arg);
  }
  return strict ? { flags, pos, error } : { flags, pos };
}

// A --business that was given must name a business. An empty or missing
// value is an error and never falls back to the current folder's business.
// Without --business: the nearest .atris/business.json above the current
// folder. Returns { id, name }, { error }, or null when none is found.
function resolveBusiness(flags = {}, deps = {}) {
  if (Object.prototype.hasOwnProperty.call(flags, 'business')) {
    const given = typeof flags.business === 'string' ? flags.business.trim() : '';
    if (!given) return { error: '--business needs a business slug or id' };
    return { id: given, name: given };
  }
  const found = (deps.findBusiness || findBusiness)(deps.cwd || process.cwd());
  return found && found.businessId ? { id: found.businessId, name: found.name || 'this business' } : null;
}

// The business to act on, or says why not (through `err`) and returns null.
function businessOrSay(flags, deps, err) {
  const business = resolveBusiness(flags, deps);
  if (!business) { err(NO_BUSINESS); return null; }
  if (business.error) { err(business.error); return null; }
  return business;
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

module.exports = { NO_BUSINESS, parseArgs, resolveBusiness, businessOrSay, loginToken, errorText, relativeTime, dollars, clip };
