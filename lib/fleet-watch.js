'use strict';

// `atris fleet watch`: the doorbell for the members `atris fleet up`
// launched. Each poll it asks every launched member's hub what is waiting —
// new posts in the member's channels, open work the hub assigns to it
// (/mine), and unclaimed tasks that @mention it — and when something is
// pending it rings once: a board post that @mentions the member. That post
// bumps the member's own /ping badge (new_mentions -> action_needed), the
// same signal the member's poll loop already checks each tick.
//
// Why a board mention and not the feed-team wake path: feed-team's ping()
// plans a think run and spawns `atris feed think` engine processes, which a
// watcher must never do, and it refuses to run inside an agent. The member
// awake switch (lib/member-switches.js, the one `atris wake` flips) is a
// local boolean that tells the hub nothing, so the command layer still flips
// it on each nudge, but the board mention is the actual doorbell.
//
// State lives in ~/.swarlo/fleet-watch.json, shaped like fleet-launched.json:
//   { <hub>: { <member>: { server, since, signature, nudged_at, error,
//   nudge_error } } }
// `since` is the read watermark, advanced every poll. `signature` is the set
// of pending item ids already rung for, so unchanged work never rings twice
// inside NUDGE_REMIND_MS. The nudge posts as the watcher's own per-hub
// identity (member_id "fleet-watch", the same ~/.swarlo/identities layout
// `fleet up` writes), falling back to the member's own token when the hub
// will not register the watcher.

const fs = require('fs');
const os = require('os');
const path = require('path');
const swarlo = require('./swarlo-members');

const WATCHER_ID = 'fleet-watch';
const WATCHER_NAME = 'Fleet Watch';
const DEFAULT_HUB_URL = 'http://localhost:8090';
const DEFAULT_INTERVAL_MS = 30000;
const NUDGE_REMIND_MS = 15 * 60 * 1000;
const POSTS_LIMIT = 25;
const UNCLAIMED_LIMIT = 50;
const MAX_PENDING_IDS = 500;
const MAX_SIGNATURE = 8000;

// ── state ────────────────────────────────────────────────

function watchStatePath(home) {
  return path.join(home || os.homedir(), '.swarlo', 'fleet-watch.json');
}

function loadWatchState(home) {
  try {
    const raw = JSON.parse(fs.readFileSync(watchStatePath(home), 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

function saveWatchState(state, home) {
  const dir = path.join(home || os.homedir(), '.swarlo');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(watchStatePath(home), `${JSON.stringify(state || {}, null, 2)}\n`, 'utf8');
  return state || {};
}

// ── launched rows ────────────────────────────────────────

// fleet-launched.json flattened to [{ hub, member, entry }], sorted so polls
// and reports are stable.
function launchedRows(launched) {
  const rows = [];
  for (const [hub, members] of Object.entries(launched || {})) {
    if (!members || typeof members !== 'object') continue;
    for (const [member, entry] of Object.entries(members)) {
      if (!entry || typeof entry !== 'object') continue;
      rows.push({ hub, member, entry });
    }
  }
  rows.sort((a, b) => a.member.localeCompare(b.member) || a.hub.localeCompare(b.hub));
  return rows;
}

// --hub / --server filters, same matching rules as `fleet down`.
function filterLaunched(launched, { hub = '', server = '' } = {}) {
  const hubFilter = String(hub || '');
  const serverFilter = server ? swarlo.serverSlug(server) : '';
  if (!hubFilter && !serverFilter) return launched || {};
  const out = {};
  for (const [h, members] of Object.entries(launched || {})) {
    if (hubFilter && h !== hubFilter) continue;
    const kept = {};
    for (const [member, entry] of Object.entries(members || {})) {
      if (!entry || typeof entry !== 'object') continue;
      if (serverFilter && swarlo.serverSlug(entry.server || '') !== serverFilter) continue;
      kept[member] = entry;
    }
    if (Object.keys(kept).length) out[h] = kept;
  }
  return out;
}

function entryChannels(entry) {
  const list = entry && Array.isArray(entry.channels) ? entry.channels : [];
  const clean = list.map((c) => String(c || '').trim()).filter(Boolean);
  return clean.length ? clean : ['common'];
}

// ── hub reads ────────────────────────────────────────────

function hubBase(server) {
  return String(server || DEFAULT_HUB_URL).replace(/\/+$/, '');
}

function authHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function hubGet(request, url, token) {
  const res = await request('GET', url, null, authHeaders(token));
  const status = Number(res && res.status) || 0;
  const data = res && res.data;
  return { ok: status >= 200 && status < 300 && Boolean(data) && typeof data === 'object', status, data };
}

// Post timestamps are ISO strings; compare as time when both parse, else as
// text so a watermark still orders correctly.
function postIsNewer(post, since) {
  const created = String((post && post.created_at) || '');
  if (!created) return false;
  if (!since) return true;
  const a = Date.parse(created);
  const b = Date.parse(since);
  if (Number.isFinite(a) && Number.isFinite(b)) return a > b;
  return created > String(since);
}

function escapeRe(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// @-mentions are the hub's own signal: swarlo resolves @name to a member_id
// and /ping counts them. Member ids are single tokens, and a member_name
// with spaces can never be @mentioned, so only token-shaped names get a
// pattern. Bare names are never matched: 'builder' is also an ordinary word.
function mentionRegex(memberId, memberName) {
  const names = [memberId, memberName]
    .map((n) => String(n || '').trim())
    .filter((n) => /^[\w.-]+$/.test(n));
  const unique = [...new Set(names.map((n) => n.toLowerCase()))];
  if (!unique.length) return null;
  return new RegExp(`@(?:${unique.map(escapeRe).join('|')})(?![\\w.-])`, 'i');
}

function postMentions(post, memberId, re) {
  const mentions = post && post.mentions;
  if (Array.isArray(mentions)
    && mentions.some((m) => String(m).toLowerCase() === String(memberId).toLowerCase())) {
    return true;
  }
  const content = String((post && post.content) || '');
  return Boolean(content && re && re.test(content));
}

// One member's waiting work as stable item ids — post ids and task keys, not
// counts — so the signature only changes when the work itself changes.
// Posts authored by the member or by the watcher never count: a member's own
// chatter is not a doorbell, and the nudge post must not ring itself.
async function gatherPending({ server, hub, member, entry, since, token, request }) {
  const items = new Map();
  const base = `${hubBase(server)}/api/${encodeURIComponent(hub)}`;
  const memberName = String((entry && entry.member_name) || member);
  const re = mentionRegex(member, memberName);
  const channels = entryChannels(entry);
  let hardFailures = 0;

  const add = (id, kind, label) => {
    if (items.size < MAX_PENDING_IDS && !items.has(id)) items.set(id, { id, kind, label });
  };

  for (const channel of channels) {
    try {
      const res = await hubGet(request, `${base}/channels/${encodeURIComponent(channel)}/posts?limit=${POSTS_LIMIT}`, token);
      if (!res.ok) { hardFailures += 1; continue; }
      for (const post of (res.data.posts || [])) {
        if (!post || typeof post !== 'object') continue;
        if (!postIsNewer(post, since)) continue;
        const author = String(post.member_id || '');
        if (author === member || author === WATCHER_ID) continue;
        const kind = postMentions(post, member, re) ? 'mention'
          : post.task_key ? 'task' : 'post';
        const id = kind === 'task'
          ? `task:${post.task_key}`
          : `post:${post.post_id || `${post.created_at}:${author}`}`;
        add(id, kind, String(post.content || '').slice(0, 80));
      }
    } catch {
      hardFailures += 1;
    }
  }

  // Open work the hub assigns to the member: its own claims and assign
  // posts. Persistent until reported done, so it rides the remind cooldown.
  try {
    const res = await hubGet(request, `${base}/mine/${encodeURIComponent(member)}`, token);
    if (res.ok) {
      for (const task of (res.data.tasks || [])) {
        if (!task || typeof task !== 'object') continue;
        const key = task.task_key || task.post_id || '';
        if (key) add(`mine:${key}`, 'assigned', String(task.content || '').slice(0, 80));
      }
    }
  } catch {}

  // Unclaimed tasks in the member's channels that @mention it. The unclaimed
  // list carries no resolved mentions, so the content pattern is the check.
  for (const channel of channels) {
    try {
      const res = await hubGet(
        request,
        `${base}/unclaimed?channel=${encodeURIComponent(channel)}&limit=${UNCLAIMED_LIMIT}`,
        token,
      );
      if (!res.ok) continue;
      for (const task of (res.data.tasks || [])) {
        if (!task || typeof task !== 'object') continue;
        const content = String(task.content || '');
        if (!task.task_key || !re || !re.test(content)) continue;
        add(`utask:${task.task_key}`, 'unclaimed', content.slice(0, 80));
      }
    } catch {}
  }

  return { items: [...items.values()], hardFailures, channels };
}

function kindCounts(items) {
  const counts = {};
  for (const item of items) counts[item.kind] = (counts[item.kind] || 0) + 1;
  return counts;
}

const KIND_ORDER = ['mention', 'assigned', 'unclaimed', 'task', 'post'];

function summarizeItems(items) {
  const counts = kindCounts(items);
  const parts = [];
  for (const kind of KIND_ORDER) {
    if (counts[kind]) parts.push(`${counts[kind]} ${kind}${counts[kind] === 1 ? '' : 's'}`);
  }
  return parts.join(', ') || `${items.length} items`;
}

// ── identities ───────────────────────────────────────────

// Any hub member's token can read; the member's own identity is the surest
// one, the watcher's stored key is the fallback.
function hubReadToken({ server, hub, member, home }) {
  const memberIdent = swarlo.loadIdentity(swarlo.identityDirFor({ server, hub, member }, home));
  if (memberIdent && memberIdent.token) return memberIdent.token;
  const watcherIdent = swarlo.loadIdentity(swarlo.identityDirFor({ server, hub, member: WATCHER_ID }, home));
  if (watcherIdent && watcherIdent.token) return watcherIdent.token;
  return '';
}

// The watcher's per-hub identity, registered on first nudge like `fleet up`
// registers members. Returns { token, via } with via one of stored,
// registered, register-failed, error.
async function watcherToken({ server, hub, home, env, sponsorKey, request }) {
  const dir = swarlo.identityDirFor({ server, hub, member: WATCHER_ID }, home);
  const existing = swarlo.loadIdentity(dir);
  if (existing && existing.token) return { token: existing.token, via: 'stored' };
  try {
    const reg = await swarlo.registerMember({
      server,
      hub,
      memberId: WATCHER_ID,
      memberName: WATCHER_NAME,
      inviteToken: (env && env.SWARLO_INVITE_TOKEN) || '',
      sponsorKey: sponsorKey || '',
    }, { request });
    if (!reg.ok) return { token: '', via: 'register-failed', status: reg.status };
    swarlo.saveIdentity(dir, {
      server,
      hub,
      member_id: WATCHER_ID,
      member_name: WATCHER_NAME,
      member_type: 'agent',
      token: reg.token,
    });
    return { token: reg.token, via: 'registered' };
  } catch (error) {
    return { token: '', via: 'error', error: String(error && error.message || error) };
  }
}

// ── one poll ─────────────────────────────────────────────

// Reads every launched member's hub, decides who has pending work, posts the
// mention that rings their doorbell, and returns { at, events, members,
// state }. Pure enough to test with an injected request: nothing here
// spawns a process, claims a task, or posts a heartbeat.
async function pollOnce(options = {}) {
  const {
    launched = {},
    state = {},
    home,
    env = process.env,
    request = swarlo.swarloRequest,
    now,
    sponsorKeyFor = () => '',
  } = options;
  const at = now || new Date().toISOString();
  const ms = Date.parse(at) || Date.now();
  const next = state && typeof state === 'object' && !Array.isArray(state) ? state : {};
  const events = [];
  const members = [];
  const rows = launchedRows(launched);

  // A member that left fleet-launched.json since the last poll (fleet down,
  // or the launch was cleaned up elsewhere) drops out of the watch too.
  for (const [hub, hubMembers] of Object.entries(next)) {
    if (!hubMembers || typeof hubMembers !== 'object') continue;
    for (const member of Object.keys(hubMembers)) {
      if (!rows.some((r) => r.hub === hub && r.member === member)) {
        events.push({ type: 'dropped', member, hub });
        delete hubMembers[member];
      }
    }
    if (!Object.keys(hubMembers).length) delete next[hub];
  }

  // One watcher registration attempt per hub per poll, shared by members.
  const watcherCache = new Map();
  const watcherFor = (server, hub) => {
    const key = `${server}${hub}`;
    if (!watcherCache.has(key)) {
      watcherCache.set(key, watcherToken({
        server, hub, home, env, request,
        sponsorKey: sponsorKeyFor(hub) || '',
      }));
    }
    return watcherCache.get(key);
  };

  for (const row of rows) {
    const { hub, member, entry } = row;
    const server = String(entry.server || (env && env.SWARLO_SERVER) || DEFAULT_HUB_URL).replace(/\/+$/, '');
    const hubMembers = (next[hub] = next[hub] && typeof next[hub] === 'object' ? next[hub] : {});
    const prev = hubMembers[member] && typeof hubMembers[member] === 'object' ? hubMembers[member] : null;
    const rec = {
      server,
      since: (prev && prev.since) || String((entry && entry.launched_at) || '') || at,
      signature: prev ? String(prev.signature || '') : '',
      nudged_at: prev ? String(prev.nudged_at || '') : '',
      error: prev ? String(prev.error || '') : '',
      nudge_error: prev ? String(prev.nudge_error || '') : '',
    };
    hubMembers[member] = rec;

    const summary = { hub, member, server, pending: 0, kinds: {}, nudged: false, error: null };
    members.push(summary);

    try {
      const token = hubReadToken({ server, hub, member, home });
      if (!token) {
        rec.error = 'no hub identity for this member';
        if (!prev || prev.error !== rec.error) {
          events.push({ type: 'error', member, hub, reason: rec.error });
        }
        summary.error = rec.error;
        continue;
      }

      const gathered = await gatherPending({ server, hub, member, entry, since: rec.since, token, request });
      const items = gathered.items.slice(0, MAX_PENDING_IDS);
      const signature = items.map((i) => i.id).sort().join('|').slice(0, MAX_SIGNATURE);
      const prevSignature = rec.signature;
      const prevNudgedMs = Date.parse(rec.nudged_at || '') || 0;

      // Every channel read failing means the hub itself is unreachable (or
      // the member's identity was pruned): say so once, then stay quiet. The
      // watermark holds so the next poll still sees what was missed.
      if (gathered.hardFailures > 0 && !items.length) {
        rec.error = `hub read failed (${gathered.hardFailures} request${gathered.hardFailures === 1 ? '' : 's'})`;
        if (!prev || prev.error !== rec.error) {
          events.push({ type: 'error', member, hub, reason: rec.error });
        }
        summary.error = rec.error;
        continue;
      }
      rec.since = at;
      if (prev && prev.error) events.push({ type: 'recovered', member, hub });
      rec.error = '';

      if (!items.length) {
        rec.signature = '';
        rec.nudge_error = '';
        continue;
      }

      summary.pending = items.length;
      summary.kinds = kindCounts(items);

      // Ring on a new set of pending work, or remind when the same work has
      // waited longer than NUDGE_REMIND_MS. An unchanged signature inside
      // the window stays silent.
      const due = signature !== prevSignature || (ms - prevNudgedMs) > NUDGE_REMIND_MS;
      if (!due) {
        rec.signature = signature;
        continue;
      }

      const watcher = await watcherFor(server, hub);
      const nudgeToken = watcher.token || token;
      const channel = entryChannels(entry)[0];
      const content = `@${member} fleet watch: ${summarizeItems(items)} waiting on the board.`;
      const post = await swarlo.postChannelNote({
        server, hub, channel, content, kind: 'message', token: nudgeToken,
      }, { request });
      if (!post.ok) {
        // Keep the old signature so the next poll retries the ring.
        rec.signature = prevSignature;
        const reason = `nudge post failed (HTTP ${post.status})`;
        if (!prev || prev.nudge_error !== reason) {
          events.push({ type: 'error', member, hub, reason });
        }
        rec.nudge_error = reason;
        summary.error = reason;
        continue;
      }
      rec.signature = signature;
      rec.nudged_at = at;
      rec.nudge_error = '';
      summary.nudged = true;
      events.push({
        type: 'nudge',
        member,
        hub,
        channel,
        pending: items.length,
        kinds: summary.kinds,
        via: watcher.token ? 'watcher' : 'member',
      });
    } catch (error) {
      const reason = String((error && error.message) || error).slice(0, 200);
      rec.error = reason;
      if (!prev || prev.error !== reason) events.push({ type: 'error', member, hub, reason });
      summary.error = reason;
    }
  }

  return { at, events, members, state: next };
}

module.exports = {
  DEFAULT_INTERVAL_MS,
  NUDGE_REMIND_MS,
  watchStatePath,
  loadWatchState,
  saveWatchState,
  launchedRows,
  filterLaunched,
  watcherToken,
  hubReadToken,
  pollOnce,
};
