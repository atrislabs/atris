// Campaign cloud sync: a campaign on this computer and its copy in the Atris
// cloud trade events by id, so web and iOS show it and a person's answer from
// a phone reaches a running loop. Contract: atris/features/campaign/api.md.
//
// Push sends the events the cloud lacks; pull ingests the ones this computer
// lacks (answers and actions from screens). Both are idempotent by event id.
// A 403 or 409 is the cloud saying no on purpose, so it is reported plainly
// and never retried.

'use strict';

const { apiRequestJson, getApiBaseUrl } = require('../utils/api');
const { loadCredentials } = require('../utils/auth');

const PUSH_BATCH = 200;
const PULL_LIMIT = 500;
const REQUEST_TIMEOUT_MS = 15000;
// Only a person's screen may send these to the cloud (api.md, Write). A local
// copy stays local; a person answers on the phone, the web, or with
// atris campaign answer, which goes to the cloud for a synced campaign.
const PERSON_ONLY = new Set(['ask_answered', 'budget_added', 'done']);

const metaKey = (campaignId) => `campaign_sync:${campaignId}`;

function readState(store, campaignId) {
  const raw = store.getMeta(metaKey(campaignId));
  if (!raw) return null;
  try {
    const state = JSON.parse(raw);
    return state && typeof state === 'object' ? state : null;
  } catch {
    return null;
  }
}

function writeState(store, campaignId, state) {
  store.setMeta(metaKey(campaignId), JSON.stringify(state));
}

// The cloud link for a campaign, or null when it has never been synced.
function cloudLink(store, campaignId) {
  const state = readState(store, campaignId);
  return state && state.link ? state : null;
}

function plainError(response) {
  const status = response && response.status;
  const said = response && (response.error || (response.data && (response.data.error || response.data.detail)));
  if (!status) return `could not reach the Atris cloud${said ? ` (${said})` : ''}`;
  if (status === 401) return 'the Atris cloud did not accept your login. run: atris login';
  if (status === 403) return `the Atris cloud refused this (403)${said ? `: ${said}` : ''}`;
  if (status === 409) return `the Atris cloud holds a different event at the same place (409)${said ? `: ${said}` : ''}`;
  return `the Atris cloud answered ${status}${said ? `: ${said}` : ''}`;
}

function failure(result, response) {
  return { ...result, ok: false, status: (response && response.status) || 0, error: plainError(response) };
}

function tokenFrom(load) {
  try {
    const credentials = load();
    const token = credentials && String(credentials.token || '').trim();
    return token || null;
  } catch {
    return null;
  }
}

// One sync of one campaign. Never throws for cloud trouble; returns
// { ok, pushed, duplicates, held, pulled, last_seq, link, error?, status? }.
async function syncCampaign(store, campaignId, deps = {}) {
  const request = deps.apiRequestJson || apiRequestJson;
  const now = deps.now || (() => new Date().toISOString());
  const base = `/campaigns/${encodeURIComponent(campaignId)}`;
  const state = readState(store, campaignId) || { pushed: 0, last_seq: 0 };
  if (!state.link) {
    // Linked from the first try, so a computer that is offline now keeps
    // trying on every later run step.
    state.link = { url: `${getApiBaseUrl()}${base}`, linked_at: now() };
    writeState(store, campaignId, state);
  }
  const result = { ok: true, campaign_id: campaignId, pushed: 0, duplicates: 0, held: 0, pulled: 0, last_seq: state.last_seq || 0, link: state.link.url };

  const token = tokenFrom(deps.loadCredentials || loadCredentials);
  if (!token) return { ...result, ok: false, status: 401, error: 'not logged in to Atris. run: atris login' };
  const call = (path, options) => request(path, { token, retries: 0, timeoutMs: REQUEST_TIMEOUT_MS, ...options });

  // Push: every local event past the last one the cloud is known to hold.
  const events = store.read(campaignId);
  if (!events.length) return { ...result, ok: false, error: `no campaign ${campaignId} on this computer` };
  const known = new Set();
  const outgoing = [];
  for (const event of events.slice(state.pushed || 0)) {
    if (event.origin === 'cloud') { known.add(event.id); continue; }
    if (PERSON_ONLY.has(event.type)) { result.held += 1; known.add(event.id); continue; }
    outgoing.push(event);
  }
  for (let i = 0; i < outgoing.length; i += PUSH_BATCH) {
    const batch = outgoing.slice(i, i + PUSH_BATCH);
    const response = await call(`${base}/events`, { method: 'POST', body: { events: batch } });
    if (!response || !response.ok) return failure(result, response);
    const data = response.data || {};
    result.pushed += Number(data.accepted) || 0;
    result.duplicates += Number(data.duplicates) || 0;
    for (const event of batch) known.add(event.id);
  }

  // Pull: everything the cloud took in after the last seq seen here.
  let after = state.last_seq || 0;
  for (;;) {
    const response = await call(`${base}/events?after=${after}&limit=${PULL_LIMIT}`, { method: 'GET' });
    if (!response || !response.ok) {
      state.pushed = advance(events, state.pushed || 0, known);
      writeState(store, campaignId, state);
      return failure(result, response);
    }
    const data = response.data || {};
    const incoming = Array.isArray(data.events) ? data.events : [];
    for (const event of incoming) {
      if (!event || event.campaign_id !== campaignId) continue;
      try {
        if (store.ingest(event)) result.pulled += 1;
      } catch (error) {
        state.pushed = advance(events, state.pushed || 0, known);
        writeState(store, campaignId, state);
        return { ...result, ok: false, status: 0, error: `a cloud event could not be taken in: ${error.message}` };
      }
      known.add(event.id);
    }
    const seq = Number(data.last_event_seq);
    if (Number.isInteger(seq) && seq > after) after = seq;
    state.last_seq = after;
    if (incoming.length < PULL_LIMIT) break;
  }
  result.last_seq = after;

  // Everything the cloud now holds, including what was just pulled.
  state.pushed = advance(store.read(campaignId), state.pushed || 0, known);
  state.synced_at = now();
  writeState(store, campaignId, state);
  return result;
}

// Move the pushed mark forward over events the cloud is known to hold, and
// stop at the first one it may not have, so an event written mid-sync is sent
// next time.
function advance(events, from, known) {
  let mark = from;
  while (mark < events.length && known.has(events[mark].id)) mark += 1;
  return mark;
}

// A person's answer or action on a synced campaign goes through the cloud's
// person routes, then comes back down by pull. Returns { ok, error?, status? }.
async function sendPersonAction(store, campaignId, action, deps = {}) {
  const request = deps.apiRequestJson || apiRequestJson;
  const token = tokenFrom(deps.loadCredentials || loadCredentials);
  if (!token) return { ok: false, status: 401, error: 'not logged in to Atris. run: atris login' };
  const base = `/campaigns/${encodeURIComponent(campaignId)}`;
  const route = action.ask_id ? `${base}/asks/${encodeURIComponent(action.ask_id)}/answer` : `${base}/actions`;
  const body = action.ask_id ? { answer: action.answer } : { action: action.action, amount_usd: action.amount_usd };
  const response = await request(route, { method: 'POST', token, retries: 0, timeoutMs: REQUEST_TIMEOUT_MS, body });
  if (!response || !response.ok) return failure({}, response);
  const synced = await syncCampaign(store, campaignId, deps);
  return synced.ok ? { ok: true, sync: synced } : { ok: true, sync: synced, warning: synced.error };
}

module.exports = { cloudLink, sendPersonAction, syncCampaign };
