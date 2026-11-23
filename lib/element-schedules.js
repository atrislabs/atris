'use strict';

// Repeating Element posts: a person schedules "@<member> <words>" to land on a
// cadence, and tickSchedules fires the due ones through ops.postIdempotent so a
// repeated tick inside the same slot can never double-post. State is one small
// JSON map under .atris/state/feed/, same folder and atomic write style as
// idempotency.json and leases.json in element-ops.

const fs = require('fs');
const path = require('path');
const feed = require('./feed-core');
const ops = require('./element-ops');

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,48}$/i;
const MIN_EVERY_MS = 1000;
const MESSAGE_MAX = 500;

function schedulesFile(root) {
  return path.join(root, '.atris', 'state', 'feed', 'schedules.json');
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function atMs(nowMs) {
  const n = Number(nowMs);
  return Number.isFinite(n) ? n : Date.now();
}

// The file is a map keyed by schedule id; an older array shape still reads.
function loadSchedules(root) {
  const raw = readJson(schedulesFile(root), {});
  const list = Array.isArray(raw) ? raw : Object.values(raw && typeof raw === 'object' ? raw : {});
  const map = {};
  for (const entry of list) {
    if (entry && typeof entry === 'object' && typeof entry.id === 'string' && entry.id) {
      map[entry.id] = entry;
    }
  }
  return map;
}

function saveSchedules(root, map) {
  writeJsonAtomic(schedulesFile(root), map);
}

function addSchedule(root, { id = null, every, to, message, nowMs = Date.now() } = {}) {
  const at = atMs(nowMs);
  const intervalMs = ops.parseDuration(every, 0);
  if (!Number.isFinite(intervalMs) || intervalMs < MIN_EVERY_MS) {
    throw new feed.FeedError(400, 'every must be a duration of at least 1s (use e.g. 30s, 5m, 1h)');
  }
  const member = String(to === null || to === undefined ? '' : to).trim().replace(/^@+/, '');
  if (!SLUG_RE.test(member)) {
    throw new feed.FeedError(400, 'schedule needs a member to post to, like builder or @builder');
  }
  const text = String(message === null || message === undefined ? '' : message).trim();
  if (!text) throw new feed.FeedError(400, 'schedule needs a message to post');
  if (text.length > MESSAGE_MAX) {
    throw new feed.FeedError(400, `schedule message is too long (max ${MESSAGE_MAX} characters)`);
  }

  const map = loadSchedules(root);
  const provided = id === null || id === undefined ? '' : String(id).trim();
  let scheduleId;
  if (provided) {
    if (!SLUG_RE.test(provided)) throw new feed.FeedError(400, `invalid schedule id: ${id}`);
    scheduleId = provided;
  } else {
    const base = `${member}-${at.toString(36)}`;
    scheduleId = base;
    for (let n = 2; map[scheduleId]; n += 1) scheduleId = `${base}-${n}`;
  }

  const nextRunMs = at + intervalMs;
  const entry = {
    id: scheduleId,
    to: member,
    message: text,
    every: String(every),
    every_ms: intervalMs,
    created_at: new Date(at).toISOString(),
    next_run_ms: nextRunMs,
    next_run_at: new Date(nextRunMs).toISOString(),
    last_run_at: null,
    run_count: 0,
  };
  map[scheduleId] = entry;
  saveSchedules(root, map);
  return { version: feed.FEED_VERSION, schedule: entry };
}

function removeSchedule(root, id) {
  const cleanId = String(id === null || id === undefined ? '' : id).trim();
  const map = loadSchedules(root);
  const existed = Object.prototype.hasOwnProperty.call(map, cleanId);
  if (existed) {
    delete map[cleanId];
    saveSchedules(root, map);
  }
  return { version: feed.FEED_VERSION, removed: existed, id: cleanId };
}

function listSchedules(root) {
  const runMs = (entry) => {
    const n = Number(entry && entry.next_run_ms);
    return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
  };
  const schedules = Object.values(loadSchedules(root))
    .sort((a, b) => runMs(a) - runMs(b) || String(a.id).localeCompare(String(b.id)));
  return { version: feed.FEED_VERSION, schedules };
}

function tickSchedules(root, { nowMs = Date.now(), env = process.env, deps = {} } = {}) {
  const at = atMs(nowMs);
  const map = loadSchedules(root);
  const due = Object.values(map)
    .filter((entry) => {
      const everyMs = Number(entry.every_ms);
      const runMs = Number(entry.next_run_ms);
      return typeof entry.id === 'string' && entry.id
        && typeof entry.to === 'string' && entry.to
        && typeof entry.message === 'string' && entry.message
        && Number.isFinite(everyMs) && everyMs > 0
        && Number.isFinite(runMs) && runMs <= at;
    })
    .sort((a, b) => Number(a.next_run_ms) - Number(b.next_run_ms));

  const fired = [];
  for (const entry of due) {
    const everyMs = Number(entry.every_ms);
    const runMs = Number(entry.next_run_ms);
    const slot = Math.floor(at / everyMs);
    const slotKey = `sched:${entry.id}:${slot}`;
    const stamp = new Date(at).toISOString().slice(0, 16).replace('T', ' ');
    const nextCount = (Number(entry.run_count) || 0) + 1;
    const body = `@${entry.to} ${entry.message} (${stamp} UTC)`;
    const repeatBody = `Scheduled run #${nextCount} for @${entry.to} (${stamp} UTC).`;
    let cardId = entry.last_card_id || null;
    let replayed = entry.last_slot === slot;
    if (!replayed) {
      if (cardId) {
        try {
          require('./feed-room').reply(root, cardId, repeatBody, { env, deps });
        } catch {
          const posted = ops.postIdempotent(root, { text: body, idKey: slotKey, env, deps });
          cardId = posted.card_id ?? null;
          replayed = Boolean(posted.replayed);
        }
      } else {
        const posted = ops.postIdempotent(root, { text: body, idKey: slotKey, env, deps });
        cardId = posted.card_id ?? null;
        replayed = Boolean(posted.replayed);
      }
    }
    // Smallest next_run_ms + k * every_ms strictly past now, so a schedule that
    // slept through several slots fires once and resumes on its own phase.
    const missed = Math.floor((at - runMs) / everyMs) + 1;
    const nextRunMs = runMs + missed * everyMs;
    entry.next_run_ms = nextRunMs;
    entry.next_run_at = new Date(nextRunMs).toISOString();
    entry.last_run_at = new Date(at).toISOString();
    entry.last_card_id = cardId;
    entry.last_slot = slot;
    if (!replayed) entry.run_count = nextCount;
    fired.push({
      id: entry.id,
      to: entry.to,
      card_id: cardId,
      run_count: entry.run_count,
      replayed,
      next_run_at: entry.next_run_at,
    });
  }

  saveSchedules(root, map);
  return { version: feed.FEED_VERSION, now: new Date(at).toISOString(), fired, count: fired.length };
}

module.exports = { addSchedule, listSchedules, removeSchedule, tickSchedules };
