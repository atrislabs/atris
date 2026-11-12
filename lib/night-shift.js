'use strict';

// Shared helpers for `atris night`, `atris morning`, and `atris join --name`.
// The joined agent is kept next to the login in credentials (field
// `joined_agent`), so night and morning act for that agent by default.

function parseFlags(args = [], valueFlags = [], boolFlags = []) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i]);
    const eq = arg.indexOf('=');
    const name = arg.startsWith('--') && eq > 2 ? arg.slice(0, eq) : arg;
    if (valueFlags.includes(name)) {
      const key = name.slice(2);
      if (eq > 2 && arg.startsWith('--')) {
        flags[key] = arg.slice(eq + 1);
      } else {
        const next = args[i + 1];
        flags[key] = next === undefined ? '' : String(next);
        i += 1;
      }
    } else if (boolFlags.includes(arg)) {
      flags[arg.slice(2)] = true;
    } else {
      positionals.push(arg);
    }
  }
  return { flags, positionals };
}

function wantsHelp(args = []) {
  return Array.isArray(args) && (args.includes('--help') || args.includes('-h') || args[0] === 'help');
}

function formatUsd(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '$0';
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

function joinedAgentFrom(creds) {
  const agent = creds && typeof creds === 'object' ? creds.joined_agent : null;
  if (!agent || typeof agent !== 'object' || !agent.agent_id) return null;
  return agent;
}

// --business accepts a business id or a connected business slug.
function resolveBusinessId(value, deps = {}) {
  const wanted = String(value || '').trim();
  if (!wanted) return null;
  let businesses = {};
  try {
    const load = deps.loadBusinesses || require('./business-core').loadBusinesses;
    businesses = load() || {};
  } catch {
    businesses = {};
  }
  const lower = wanted.toLowerCase();
  for (const [slug, entry] of Object.entries(businesses)) {
    if (!entry || typeof entry !== 'object') continue;
    if (slug.toLowerCase() === lower || String(entry.slug || '').toLowerCase() === lower) {
      return entry.business_id || entry.id || wanted;
    }
  }
  return wanted;
}

// Who the call is for: explicit flags win, then the agent this login joined as.
function resolveTarget(flags = {}, creds = null, deps = {}) {
  const businessId = flags.business ? resolveBusinessId(flags.business, deps) : null;
  let agentId = flags.agent ? String(flags.agent).trim() : null;
  let business = businessId;
  if (!agentId) {
    const joined = joinedAgentFrom(creds);
    if (joined && (!businessId || joined.business_id === businessId)) {
      agentId = joined.agent_id;
      if (!business && joined.business_id) business = joined.business_id;
    }
  }
  return { agentId: agentId || null, businessId: business || null };
}

function oneLine(value) {
  if (value && typeof value === 'object') {
    const detail = value.detail || value.error || value.message;
    if (detail) return oneLine(detail);
    try { return JSON.stringify(value); } catch { return 'request failed'; }
  }
  return String(value == null ? 'request failed' : value).replace(/\s+/g, ' ').trim() || 'request failed';
}

function errorText(result) {
  if (!result) return 'no answer from Atris';
  return oneLine(result.error || (result.data && (result.data.detail || result.data.error)) || `request failed (${result.status})`);
}

module.exports = {
  parseFlags,
  wantsHelp,
  formatUsd,
  resolveBusinessId,
  resolveTarget,
  oneLine,
  errorText,
};
