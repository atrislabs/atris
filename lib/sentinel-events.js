'use strict';

// Sentinel events: what Sentinel did or found between reviews, sent to
// POST /api/sentinel/events (the v2 contract). agents, guard and watch all
// report through here.
//
//   text     every title and detail is a fixed sentence template. The only
//            values put into it are slots that pass a strict shape check
//            (package names, versions, advisory ids, counts). The filled
//            sentence then passes the same plain-prose allowlist and secret
//            scan review uploads use (lib/sentinel-cloud.js plain()).
//   resolve  the last reported open findings per project and kind live in
//            ~/.atris/sentinel/state. A finding that is gone on a later run
//            is sent again as resolved. The state moves only after an upload
//            succeeds, so a failed upload is caught up next time.
//   queue    the guard hook appends blocked events to
//            ~/.atris/sentinel/queue.jsonl. flushQueue() sends them later.
//
// Upload failures never throw: every call returns { ok, reason }.
//
// Zero external deps (Node built-ins only).

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const KINDS = ['blocked', 'threat', 'agent_check', 'scan_started', 'scan_finished'];
const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];
const MAX_EVENTS_PER_CALL = 200;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_TITLE = 300;
const MAX_DETAIL = 1000;

function cloud() {
  return require('./sentinel-cloud');
}

function homeDir(env = process.env) {
  return env.HOME || os.homedir();
}

function sentinelDir(env = process.env) {
  return path.join(homeDir(env), '.atris', 'sentinel');
}

function hash(...parts) {
  return crypto.createHash('sha256').update(parts.map((p) => String(p == null ? '' : p)).join('\u0000')).digest('hex');
}

function fingerprint(...parts) {
  return `f-${hash(...parts).slice(0, 12)}`;
}

// ---------------------------------------------------------------- text

// Shapes a slot value may take. Anything else is replaced by the slot's
// fallback words, never cleaned up and kept.
const SLOT_SHAPES = {
  package: /^(?:@[a-z0-9][a-z0-9._-]{0,80}\/)?[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/,
  module: /^[a-z0-9][a-z0-9._-]{0,80}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,80}){0,6}$/,
  version: /^v?[0-9][0-9A-Za-z.+-]{0,40}$/,
  advisory: /^[A-Z]{2,10}-[A-Za-z0-9-]{3,40}$/,
  count: /^[0-9]{1,7}$/,
  word: /^[A-Za-z][A-Za-z -]{0,60}$/,
};

function slotOk(kind, value) {
  const shape = SLOT_SHAPES[kind];
  if (!shape) return false;
  const v = String(value == null ? '' : value);
  if (!shape.test(v)) return false;
  if (strictSecret(v)) return false;
  return true;
}

function strictSecret(text) {
  let rules = [];
  try { rules = require('./security-scan').SECRET_RULES || []; } catch {}
  return rules.some((rule) => { try { rule.re.lastIndex = 0; return rule.re.test(text); } catch { return true; } });
}

// fillPlain('Version {version} fixes it.', { version: ['version', '1.3.1', 'a newer version'] })
// The template, with each slot swapped for a plain placeholder word, must
// pass plain(). Then each slot goes in only when it matches its shape.
function fillPlain(template, slots = {}, max = MAX_TITLE) {
  const { plain, FALLBACK_SENTENCE } = cloud();
  const names = Object.keys(slots);
  let probe = String(template);
  for (const name of names) probe = probe.split(`{${name}}`).join('slotvalue');
  if (/\{[a-z]+\}/.test(probe)) return FALLBACK_SENTENCE;
  if (plain(probe, max) !== probe.replace(/\s+/g, ' ').trim()) return FALLBACK_SENTENCE;
  let out = String(template);
  for (const name of names) {
    const [kind, value, fallback] = slots[name];
    const v = slotOk(kind, value) ? String(value) : String(fallback || 'one');
    out = out.split(`{${name}}`).join(v);
  }
  out = out.replace(/\s+/g, ' ').trim();
  if (out.length > max) return FALLBACK_SENTENCE;
  return out;
}

// ---------------------------------------------------------------- events

// A project name leaves only when it is a plain folder name: letters,
// digits, dot, dash and underscore, at most 100, and no secret shape.
// Anything else is sent as "project".
const REPO_SHAPE = /^[A-Za-z0-9._-]{1,100}$/;
function cleanRepo(name) {
  const s = String(name == null ? '' : name);
  return REPO_SHAPE.test(s) && !strictSecret(s) ? s : 'project';
}

function repoName(root) {
  return cleanRepo(path.basename(path.resolve(root || process.cwd())));
}

function makeEvent({ kind, repo, severity = 'info', title, detail = '', status, fingerprint: fp, occurredAt = new Date() }) {
  if (!KINDS.includes(kind)) throw new Error(`unknown event kind: ${kind}`);
  const { plain, FALLBACK_SENTENCE } = cloud();
  const sev = SEVERITIES.includes(severity) ? severity : 'info';
  // Titles and details come from fillPlain already. plain() runs again here
  // so no caller can skip the allowlist.
  const cleanTitle = guardText(title, MAX_TITLE) || FALLBACK_SENTENCE;
  const cleanDetail = detail ? guardText(detail, MAX_DETAIL) : '';
  const ev = {
    kind,
    repo: cleanRepo(repo),
    severity: sev,
    title: cleanTitle,
    status: status === 'resolved' ? 'resolved' : (status === 'open' ? 'open' : (kind === 'threat' || kind === 'agent_check' ? 'open' : 'resolved')),
    fingerprint: /^f-[0-9a-f]{12}$/.test(String(fp || '')) ? fp : fingerprint(kind, repo, title),
    occurred_at: (occurredAt instanceof Date ? occurredAt : new Date(occurredAt)).toISOString(),
  };
  if (cleanDetail) ev.detail = cleanDetail;
  // Last pass: the secret scan over every field that leaves.
  for (const k of Object.keys(ev)) {
    if (!strictSecret(String(ev[k]))) continue;
    if (k === 'repo') ev.repo = 'project';
    else if (k === 'title') ev.title = FALLBACK_SENTENCE;
    else if (k === 'detail') delete ev.detail;
    else if (k === 'fingerprint') ev.fingerprint = fingerprint(kind, ev.repo, ev.title);
  }
  return ev;
  function guardText(text, max) {
    const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    if (!s) return '';
    if (s.length > max) return FALLBACK_SENTENCE;
    // Versions (1.3.1) are the one shape plain() refuses that a filled
    // template may hold. Mask them for the check, keep them in the text.
    // Package names sit only in "the <name> package you use", and only
    // when the name has a package or module shape.
    const masked = s
      .replace(/\bthe (\S+) package you use\b/g, (all, name) => (slotOk('package', name) || slotOk('module', name) ? 'the slotvalue package you use' : all))
      .replace(/\bv?[0-9]+(?:\.[0-9A-Za-z+-]+)+\b/g, 'slotvalue');
    if (plain(masked, max) !== masked) return FALLBACK_SENTENCE;
    if (strictSecret(s)) return FALLBACK_SENTENCE;
    return s;
  }
}

// ---------------------------------------------------------------- upload

function chunks(events) {
  const out = [];
  let cur = [];
  const size = (list) => Buffer.byteLength(JSON.stringify({ events: list }));
  for (const ev of events) {
    if (cur.length >= MAX_EVENTS_PER_CALL || (cur.length && size([...cur, ev]) > MAX_BODY_BYTES)) { out.push(cur); cur = []; }
    cur.push(ev);
  }
  if (cur.length) out.push(cur);
  return out;
}

async function postEvents(events, { token, base, timeoutMs = 15000 } = {}) {
  if (!events || !events.length) return { ok: true, saved: 0, calls: 0 };
  if (!token) return { ok: false, reason: 'not logged in', saved: 0 };
  // Every event passes makeEvent once more on the way out, whoever built it.
  events = events.map((e) => makeEvent({ kind: e.kind, repo: e.repo, severity: e.severity, title: e.title, detail: e.detail, status: e.status, fingerprint: e.fingerprint, occurredAt: e.occurred_at || new Date() }));
  const c = cloud();
  let url = base;
  if (!url) { try { url = c.apiBase(); } catch (e) { return { ok: false, reason: e.message, saved: 0 }; } }
  let saved = 0;
  let calls = 0;
  for (const batch of chunks(events)) {
    let res;
    try {
      res = await c.request('POST', `${url}/sentinel/events`, { token, body: { events: batch }, timeoutMs });
    } catch (e) {
      return { ok: false, reason: e.message, saved, calls };
    }
    calls += 1;
    if (res.status < 200 || res.status >= 300) return { ok: false, reason: c.httpError(res), saved, calls };
    saved += Number(res.json && res.json.saved) || batch.length;
  }
  return { ok: true, saved, calls };
}

// ---------------------------------------------------------------- resolve

function statePath(root, kind, env = process.env) {
  let real = path.resolve(root);
  try { real = fs.realpathSync(real); } catch {}
  return path.join(sentinelDir(env), 'state', `${hash(real).slice(0, 16)}-${kind}.json`);
}

function readState(root, kind, env) {
  try {
    const s = JSON.parse(fs.readFileSync(statePath(root, kind, env), 'utf8'));
    return s && typeof s.open === 'object' && s.open ? s.open : {};
  } catch { return {}; }
}

function writeState(root, kind, open, env) {
  const file = statePath(root, kind, env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ root: path.resolve(root), kind, open, updated_at: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// The open events of this run, plus a resolved copy of each finding the
// last upload reported open that is gone now.
function withResolved(root, kind, openEvents, { env = process.env, now = new Date() } = {}) {
  const before = readState(root, kind, env);
  const current = new Set(openEvents.map((e) => e.fingerprint));
  const resolved = [];
  for (const [fp, prev] of Object.entries(before)) {
    if (current.has(fp)) continue;
    resolved.push(makeEvent({ kind, repo: prev.repo, severity: prev.severity, title: prev.title, detail: prev.detail, status: 'resolved', fingerprint: fp, occurredAt: now }));
  }
  const next = {};
  for (const e of openEvents) next[e.fingerprint] = { repo: e.repo, severity: e.severity, title: e.title, detail: e.detail || '' };
  return { events: [...openEvents, ...resolved], resolved, commit: () => writeState(root, kind, next, env) };
}

// Upload one run's findings of one kind and move the state on success.
async function reportFindings(root, kind, openEvents, { token, base, env = process.env, upload = true, extra = [] } = {}) {
  const plan = withResolved(root, kind, openEvents, { env });
  if (!upload) return { ok: true, skipped: 'no-upload', sent: 0, resolved: plan.resolved.length };
  if (!token) return { ok: false, skipped: 'not-logged-in', reason: 'not logged in', sent: 0, resolved: plan.resolved.length };
  const res = await postEvents([...extra, ...plan.events], { token, base });
  if (res.ok) {
    try { plan.commit(); } catch {}
    try { await flushQueue({ token, base, env }); } catch {}
  }
  return { ...res, sent: res.ok ? plan.events.length + extra.length : 0, resolved: plan.resolved.length };
}

// ---------------------------------------------------------------- queue

function queuePath(env = process.env) {
  return path.join(sentinelDir(env), 'queue.jsonl');
}

function readQueueFile(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      if (ev && KINDS.includes(ev.kind)) out.push(ev);
    } catch {}
  }
  return out;
}

function queueSize(env = process.env) {
  return readQueueFile(queuePath(env)).length;
}

// Send every queued event. The queue is moved aside first so the hook can
// keep appending; on failure the unsent events go back.
async function flushQueue({ token, base, env = process.env } = {}) {
  const file = queuePath(env);
  if (!fs.existsSync(file)) return { ok: true, sent: 0 };
  if (!token) return { ok: false, reason: 'not logged in', sent: 0, waiting: queueSize(env) };
  const sending = `${file}.sending-${process.pid}-${Date.now()}`;
  try { fs.renameSync(file, sending); } catch (e) { return { ok: false, reason: e.message, sent: 0 }; }
  // Rebuild each event through makeEvent so a hand-edited queue line still
  // leaves only plain prose.
  const events = [];
  for (const raw of readQueueFile(sending)) {
    try { events.push(makeEvent({ kind: raw.kind, repo: raw.repo, severity: raw.severity, title: raw.title, detail: raw.detail, status: raw.status, fingerprint: raw.fingerprint, occurredAt: raw.occurred_at || new Date() })); } catch {}
  }
  const res = await postEvents(events, { token, base });
  if (res.ok) {
    try { fs.unlinkSync(sending); } catch {}
    return { ok: true, sent: events.length };
  }
  try {
    const back = fs.readFileSync(sending, 'utf8');
    fs.appendFileSync(file, back.endsWith('\n') || !back ? back : `${back}\n`, { mode: 0o600 });
    fs.unlinkSync(sending);
  } catch {}
  return { ok: false, reason: res.reason, sent: 0, waiting: events.length };
}

module.exports = {
  KINDS,
  SEVERITIES,
  fingerprint,
  fillPlain,
  slotOk,
  repoName,
  makeEvent,
  postEvents,
  chunks,
  reportFindings,
  readState,
  statePath,
  queuePath,
  queueSize,
  flushQueue,
  sentinelDir,
};
