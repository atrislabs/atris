'use strict';

// Repeating message schedules on Element:
// A schedule is just a repeating message posted to an agent on the board.
// Idempotent per time slot so double-ticks never double-post.
// Zero third-party dependencies.

const fs = require('fs');
const path = require('path');
const feed = require('./feed-core');
const ops = require('./element-ops');

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,48}$/i;

function storePath(root) {
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

function addSchedule(root, { id = null, every, to, message, nowMs = Date.now() } = {}) {
  const intervalMs = ops.parseDuration(every, 0);
  if (intervalMs < 1000) {
    throw new feed.FeedError(400, 'schedule interval must be at least 1s (use e.g. 15m, 1h, 24h)');
  }
  const target = String(to || '').trim().replace(/^@+/, '');
  if (!SLUG_RE.test(target)) {
    throw new feed.FeedError(400, 'usage: atris element schedule add --every 1h --to <member> "<message>"');
  }
  const text = String(message || '').trim().slice(0, 500);
  if (!text) {
    throw new feed.FeedError(400, 'usage: atris element schedule add --every 1h --to <member> "<message>"');
  }
  const schedId = id ? String(id).trim() : `${target}-${Math.floor(nowMs).toString(36)}`;
  if (!SLUG_RE.test(schedId)) {
    throw new feed.FeedError(400, `invalid schedule id: ${schedId}`);
  }
  const file = storePath(root);
  const map = readJson(file, {});
  const nextMs = nowMs + intervalMs;
  const entry = {
    id: schedId,
    to: target,
    message: text,
    every: String(every),
    every_ms: intervalMs,
    created_at: new Date(nowMs).toISOString(),
    next_run_ms: nextMs,
    next_run_at: new Date(nextMs).toISOString(),
    last_run_at: null,
    run_count: 0,
  };
  map[schedId] = entry;
  writeJsonAtomic(file, map);
  return { version: feed.FEED_VERSION, schedule: entry };
}

function removeSchedule(root, id) {
  const clean = String(id || '').trim();
  if (!clean) throw new feed.FeedError(400, 'usage: atris element schedule remove <id>');
  const file = storePath(root);
  const map = readJson(file, {});
  const existed = Object.prototype.hasOwnProperty.call(map, clean);
  if (existed) {
    delete map[clean];
    writeJsonAtomic(file, map);
  }
  return { version: feed.FEED_VERSION, removed: existed, id: clean };
}

function listSchedules(root) {
  const map = readJson(storePath(root), {});
  const schedules = Object.values(map).sort((a, b) => (a.next_run_ms || 0) - (b.next_run_ms || 0));
  return { version: feed.FEED_VERSION, schedules };
}

function tickSchedules(root, { nowMs = Date.now(), env = process.env, deps = {} } = {}) {
  const file = storePath(root);
  const map = readJson(file, {});
  const fired = [];
  let changed = false;

  for (const entry of Object.values(map)) {
    if (!entry || !entry.every_ms || Number(entry.next_run_ms) > nowMs) continue;
    const slot = Math.floor(nowMs / entry.every_ms);
    const slotKey = `sched:${entry.id}:${slot}`;
    const stamp = new Date(nowMs).toISOString().slice(0, 16).replace('T', ' ');
    const body = `@${entry.to} ${entry.message} (${stamp} UTC)`;
    let cardId = entry.last_card_id || null;
    let replayed = entry.last_slot === slot;
    if (!replayed) {
      if (cardId) {
        try {
          require('./feed-room').reply(root, cardId, body, { env, deps });
        } catch {
          const posted = ops.postIdempotent(root, { text: body, idKey: slotKey, env, deps });
          cardId = posted.card_id;
          replayed = Boolean(posted.replayed);
        }
      } else {
        const posted = ops.postIdempotent(root, { text: body, idKey: slotKey, env, deps });
        cardId = posted.card_id;
        replayed = Boolean(posted.replayed);
      }
    }
    let nextMs = Number(entry.next_run_ms);
    while (nextMs <= nowMs) nextMs += entry.every_ms;
    entry.next_run_ms = nextMs;
    entry.next_run_at = new Date(nextMs).toISOString();
    entry.last_run_at = new Date(nowMs).toISOString();
    entry.last_card_id = cardId;
    entry.last_slot = slot;
    if (!replayed) entry.run_count = (Number(entry.run_count) || 0) + 1;
    changed = true;
    fired.push({
      id: entry.id,
      to: entry.to,
      card_id: cardId,
      run_count: entry.run_count,
      replayed,
      next_run_at: entry.next_run_at,
    });
  }

  if (changed) writeJsonAtomic(file, map);
  return { version: feed.FEED_VERSION, now: new Date(nowMs).toISOString(), fired, count: fired.length };
}

module.exports = { addSchedule, listSchedules, removeSchedule, tickSchedules };
