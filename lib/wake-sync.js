'use strict';

// One switch for a team member, in two places: the local feed switch
// (atris feed member on|off) and the cloud note-wake switch (atris tell wake).
// Flipping either one also flips the other when this folder is a business
// project and the member lives in both. The other side is best effort: it
// never stops the side the person asked for, and a failure is one plain line.

const { apiRequestJson } = require('../utils/api');
const { loginToken } = require('./business-target');
const { boundBusiness } = require('./team-board');

const CLOUD_TIMEOUT_MS = 3000;

function memberNotFound(res) {
  const detail = res && res.data && res.data.detail;
  return Boolean(res && res.status === 404 && /\b(agent|member) not found\b/i.test(String(detail || '')));
}

function slugOf(name) {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// The cloud side of `atris feed member on|off <name>`. Returns
// { status, line }: status is set, not_bound, not_in_cloud, not_logged_in or
// failed; line is the one thing to print, or ''.
async function setCloudWake(root, name, on, deps = {}) {
  const business = boundBusiness(root);
  if (!business) return { status: 'not_bound', line: '' };
  let token = '';
  try { token = await loginToken(deps); } catch { token = ''; }
  if (!token) return { status: 'not_logged_in', line: `Waking on notes in ${business.slug} did not change: you are not logged in (atris login).` };
  const request = deps.apiRequestJson || apiRequestJson;
  let res = null;
  try {
    res = await request(`/business/${encodeURIComponent(business.id)}/team/${encodeURIComponent(name)}`, {
      method: 'PATCH', body: { wake_on_mention: Boolean(on) }, token, timeoutMs: CLOUD_TIMEOUT_MS, retries: 0,
    });
  } catch {
    res = null;
  }
  if (memberNotFound(res)) return { status: 'not_in_cloud', line: '' };
  const updated = res && res.ok && res.data && res.data.updated;
  if (!updated || !Object.prototype.hasOwnProperty.call(updated, 'wake_on_mention')) {
    return { status: 'failed', line: `Waking on notes in ${business.slug} did not change for ${name}. Try: atris tell wake ${name} ${on ? 'on' : 'off'}` };
  }
  return { status: 'set', line: '' };
}

// Each cloud member's note-wake switch, by slug and by lowercased name, or
// null when the folder is not a business project or the cloud did not answer.
async function cloudSwitches(root, deps = {}) {
  const business = boundBusiness(root);
  if (!business) return null;
  let token = '';
  try { token = await loginToken(deps); } catch { token = ''; }
  if (!token) return null;
  const request = deps.apiRequestJson || apiRequestJson;
  let res = null;
  try {
    res = await request(`/swarlo/${encodeURIComponent(business.id)}/wake-switches`, {
      method: 'GET', token, timeoutMs: CLOUD_TIMEOUT_MS, retries: 0,
    });
  } catch {
    return null;
  }
  const rows = res && res.ok && res.data && Array.isArray(res.data.members) ? res.data.members : null;
  if (!rows) return null;
  const map = new Map();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const on = row.wake_on_mention === true;
    for (const key of [row.slug, slugOf(row.name)]) if (key && !map.has(String(key))) map.set(String(key), on);
  }
  return map;
}

// Adds cloud_on (true, false, or null when the member is not in the cloud)
// and switch_mismatch to each listed member.
function markMembers(out, cloud) {
  if (!out || !Array.isArray(out.members)) return out;
  for (const m of out.members) {
    const has = cloud && cloud.has(m.name);
    m.cloud_on = has ? cloud.get(m.name) : null;
    m.switch_mismatch = has ? m.on !== m.cloud_on : false;
  }
  return out;
}

function mismatchMark(m) {
  if (!m || !m.switch_mismatch) return '';
  return m.cloud_on ? '  [cloud on]' : '  [cloud off]';
}

// The local side of `atris tell wake <member> on|off`: flips the feed switch
// when run inside that business's project folder and the member is on the
// local team. Returns { status, line }: status is set, not_bound, not_local
// or failed.
function setLocalSwitch(cwd, business, target, on, deps = {}) {
  let root = '';
  let feedTeam;
  try {
    root = require('./feed-core').projectRoot(cwd);
    feedTeam = deps.feedTeam || require('./feed-team');
  } catch {
    return { status: 'not_bound', line: '' };
  }
  const bound = boundBusiness(root);
  if (!bound || !business || bound.id !== business.id) return { status: 'not_bound', line: '' };
  let names = [];
  try { names = require('./feed-core')._internal.teamMembers(root); } catch { names = []; }
  const slug = names.includes(target) ? target : (names.includes(slugOf(target)) ? slugOf(target) : '');
  if (!slug) return { status: 'not_local', line: '' };
  try {
    feedTeam.setOn(root, slug, on, { env: deps.env || process.env });
    return { status: 'set', line: '' };
  } catch (error) {
    const why = String((error && error.message) || error || 'unknown error').split('\n')[0];
    return { status: 'failed', line: `The feed switch for ${slug} here did not change: ${why}` };
  }
}

module.exports = { setCloudWake, cloudSwitches, markMembers, mismatchMark, setLocalSwitch, CLOUD_TIMEOUT_MS };
