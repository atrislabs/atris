'use strict';

// Shared plumbing for the team board on the hosted server (`atris channel`,
// `atris listen`): which business, the plain reason a request failed, and the
// member name -> agent id lookup. HTTP client only; routes live in the backend.

const fs = require('fs');
const path = require('path');
const { oneLine } = require('./developer-api');
const { stateHome } = require('./state-home');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function registeredBusinesses(homeDir) {
  const raw = readJson(path.join(homeDir, '.atris', 'businesses.json'));
  if (!raw || typeof raw !== 'object') return [];
  return Object.entries(raw)
    .filter(([, b]) => b && typeof b === 'object' && b.business_id)
    .map(([key, b]) => ({ id: String(b.business_id), slug: String(b.slug || key), name: String(b.name || b.slug || key) }));
}

function boundBusiness(startDir) {
  let dir = path.resolve(startDir);
  for (;;) {
    const parsed = readJson(path.join(dir, '.atris', 'business.json'));
    if (parsed && parsed.business_id) {
      const slug = String(parsed.slug || parsed.name || parsed.business_id);
      return { id: String(parsed.business_id), slug, name: String(parsed.name || slug) };
    }
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

const PICK = 'add --business <slug>, set ATRIS_BUSINESS=<slug>, or run inside a business folder';

// Which business, in order: --business, ATRIS_BUSINESS, the nearest
// .atris/business.json, then the only one in ~/.atris/businesses.json.
// A slug is looked up locally; one this computer does not know goes to the
// server as is. Returns { id, slug, name } or { error }.
function resolveChannelBusiness(flags = {}, deps = {}) {
  const env = deps.env || process.env;
  const known = registeredBusinesses(deps.homeDir || stateHome());
  const lookup = (value) => known.find((b) => b.slug === value || b.id === value)
    || { id: value, slug: value, name: value };

  if (Object.prototype.hasOwnProperty.call(flags, 'business')) {
    const given = typeof flags.business === 'string' ? flags.business.trim() : '';
    if (!given) return { error: '--business needs a business slug' };
    return lookup(given);
  }
  const fromEnv = String(env.ATRIS_BUSINESS || '').trim();
  if (fromEnv) return lookup(fromEnv);
  const bound = boundBusiness(deps.cwd || process.cwd());
  if (bound) return bound;
  if (known.length === 1) return known[0];
  if (!known.length) return { error: `no business picked: ${PICK}.` };
  const names = known.map((b) => b.slug);
  const shown = names.length > 8 ? `${names.slice(0, 8).join(', ')}, and ${names.length - 8} more` : names.join(', ');
  return { error: `more than one business on this computer (${shown}): ${PICK}.` };
}

// One plain line on why a board request failed.
function boardWhy(res, business) {
  if (!res) return 'no answer from the server';
  const detail = res.data && (res.data.detail || res.data.error);
  if (res.status === 401) return 'your sign-in was refused. run: atris login';
  if (res.status === 403) return `you are not on ${business.slug}'s team`;
  if (res.status === 404 && detail === 'Business not found') return `no business called "${business.slug}"`;
  return oneLine(detail || res.error || `request failed (${res.status})`);
}

// The member named by --as, else ATRIS_AGENT: lowercased, no leading @.
function memberName(flags = {}, env = process.env) {
  return String((typeof flags.as === 'string' ? flags.as : env.ATRIS_AGENT) || '').trim().replace(/^@/, '').toLowerCase();
}

// The server's words for "no such member" ("Agent not found: walsh"). Any
// other 404, like "Business not found", is a different problem.
const MEMBER_MISSING = /\b(agent|member) not found\b/i;

// Member name -> { member: { id, name } }, or { missing: true }, { failed: res },
// or { noId: true }. The caller words the error for its own command.
// `options` adds request settings, like a shorter timeout.
async function lookupMember(request, business, name, token, options = {}) {
  const res = await request(`/business/${encodeURIComponent(business.id)}/team/${encodeURIComponent(name)}`, { method: 'GET', ...options, token });
  const detail = res && res.data && (res.data.detail || res.data.error);
  if (res && res.status === 404 && MEMBER_MISSING.test(String(detail || ''))) return { missing: true };
  if (!res || !res.ok) return { failed: res };
  if (!res.data || !res.data.agent_id) return { noId: true };
  return { member: { id: String(res.data.agent_id), name: String(res.data.name || name) } };
}

module.exports = { resolveChannelBusiness, boardWhy, memberName, lookupMember };
