'use strict';

// Activity stream: normalize the workspace's receipt channels into ONE
// time-ordered feed of what the agent actually did, plus a heartbeat summary.
// The task board shows a static inventory of tasks; this turns the same data
// into "what happened, in order" — the stream you watch for hours.

const TS_KEYS = ['ts', 'at', 'created_at', 'accepted_at', 'timestamp', 'updated_at'];

function pickTs(row) {
  for (const k of TS_KEYS) {
    if (row && row[k]) {
      const ms = Date.parse(row[k]);
      if (Number.isFinite(ms)) return { iso: String(row[k]), ms };
    }
  }
  return { iso: null, ms: 0 };
}

function clip(value, n = 100) {
  const t = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function num(v) {
  return v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v);
}

// --- per-channel normalizers (each returns a uniform event or null) ---

function normalizePulse(row) {
  if (!row || row.phase !== 'finished') return null; // only completed ticks are events
  const { iso, ms } = pickTs(row);
  const reward = num(row.reward);
  return {
    ts: iso, ms,
    source: 'pulse',
    kind: row.actor === 'autopilot' ? 'autopilot' : 'heartbeat',
    title: clip(row.what || `pulse tick #${row.tick_index}`),
    detail: row.verify_passed == null ? '' : (row.verify_passed ? 'verify pass' : 'verify FAIL'),
    status: row.verify_passed === false ? 'bad' : (reward > 0 ? 'good' : 'neutral'),
    reward,
  };
}

function normalizeScorecard(row) {
  if (!row) return null;
  const { iso, ms } = pickTs(row);
  const reward = num(row.reward);
  return {
    ts: iso, ms,
    source: 'reward',
    kind: row.source || row.member || 'tick',
    title: clip(row.what_shipped || 'tick scored'),
    detail: reward == null ? '' : `reward ${reward}`,
    status: reward != null && reward > 0 ? 'good' : (reward != null && reward < 0 ? 'bad' : 'neutral'),
    reward,
  };
}

function normalizeTaskEpisode(row) {
  if (!row) return null;
  const { iso, ms } = pickTs(row);
  const state = row.state || {};
  const action = row.action || state.status || 'updated';
  const reward = num(row.reward);
  return {
    ts: iso, ms,
    source: 'task',
    kind: state.status || action,
    title: clip(state.title || row.task_id),
    detail: row.lesson ? clip(`lesson: ${row.lesson}`, 70) : clip(action, 24),
    status: reward != null && reward < 0 ? 'bad' : (state.status === 'review' ? 'review' : 'neutral'),
    reward,
  };
}

function normalizeXp(row) {
  if (!row) return null;
  const { iso, ms } = pickTs(row);
  return {
    ts: iso, ms,
    source: 'xp',
    kind: row.outcome || 'accepted',
    title: clip(row.title || 'work accepted'),
    detail: `+${row.xp || 0} XP${row.actor ? ` · ${row.actor}` : ''}`,
    status: 'good',
    reward: num(row.reward),
  };
}

function normalizeMissionEvent(row) {
  if (!row) return null;
  const { iso, ms } = pickTs(row);
  const type = row.type || 'event';
  const p = row.payload || {};
  return {
    ts: iso, ms,
    source: 'mission',
    kind: type,
    title: clip(p.summary || p.objective || p.reason || p.next_action || type),
    detail: clip(row.actor || '', 24),
    status: /error|fail|halt|stop|paused/i.test(type) ? 'bad' : 'neutral',
    reward: null,
  };
}

// --- the feed ---

function buildActivityStream(sources = {}, opts = {}) {
  const limit = opts.limit || 60;
  const events = [];
  const push = (rows, fn) => {
    for (const r of rows || []) {
      const e = fn(r);
      if (e && e.ms) events.push(e);
    }
  };
  push(sources.pulseReceipts, normalizePulse);
  push(sources.scorecards, normalizeScorecard);
  push(sources.taskEpisodes, normalizeTaskEpisode);
  push(sources.xpReceipts, normalizeXp);
  push(sources.missionEvents, normalizeMissionEvent);
  events.sort((a, b) => (b.ms - a.ms) || a.source.localeCompare(b.source)); // newest first, stable
  return events.slice(0, limit);
}

// --- heartbeat: is the agent alive, and what did it just do ---

function buildHeartbeat(pulseReceipts, now = Date.now()) {
  const { summarizePulse } = require('./pulse');
  const s = summarizePulse(pulseReceipts || [], now);
  const lastMs = s.last_tick_ts ? Date.parse(s.last_tick_ts) : null;
  const ageMin = Number.isFinite(lastMs) ? Math.max(0, Math.round((now - lastMs) / 60000)) : null;
  const finished = (pulseReceipts || []).filter((r) => r && r.phase === 'finished');
  const last = finished.length ? finished[finished.length - 1] : null;
  let state = 'idle';
  if (s.stale.stale) state = 'stale';
  else if (s.total_ticks > 0) state = 'alive';
  return {
    state, // 'alive' | 'stale' | 'idle'
    alive: state === 'alive',
    stale_reason: s.stale.stale ? s.stale.reason : null,
    last_tick_ts: s.last_tick_ts,
    last_tick_age_min: ageMin,
    last_what: last ? last.what : null,
    last_reward: last ? num(last.reward) : null,
    total_ticks: s.total_ticks,
    reward_sum: s.reward_sum,
    verify_pass: s.verify_pass,
    verify_fail: s.verify_fail,
    orphan_ticks: s.orphan_ticks,
  };
}

module.exports = {
  pickTs,
  clip,
  normalizePulse,
  normalizeScorecard,
  normalizeTaskEpisode,
  normalizeXp,
  normalizeMissionEvent,
  buildActivityStream,
  buildHeartbeat,
};
