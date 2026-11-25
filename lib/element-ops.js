'use strict';

// Headless Element swarm primitives (inspired by vercel/board + Paradigm):
// - parseDuration: "5m", "30s", "500ms", "2h" -> ms
// - waitCard: wait on a thread reply (after an optional reply id, no race window) or state change
// - tailEvents: stream Element events as NDJSON or plain lines, with optional --follow
// - postIdempotent: post a card/note once per --id key (retry-safe) and return its card id
// - claimCard / completeCard: leased task claiming so two swarm agents never hold one card
// - lossCurve: rolling loss, spend, p95 speed, bottleneck and sparkline from CodeOps/Element runs

const fs = require('fs');
const path = require('path');
const feed = require('./feed-core');

function room() { return require('./feed-room'); }
function team() { return require('./feed-team'); }

const SPARK_CHARS = '▁▂▃▄▅▆▇█';
const STAGE_KEYS = ['pr_closure_ms', 'observe_ms', 'auth_ms', 'gates_ms', 'dispatch_ms'];

function parseDuration(raw, fallbackMs = 30000) {
  if (raw === undefined || raw === null || raw === '') return fallbackMs;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return raw;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i.exec(String(raw).trim());
  if (!match) throw new feed.FeedError(400, `invalid duration: ${raw} (use e.g. 500ms, 30s, 5m, 1h)`);
  const amount = Number(match[1]);
  const unit = (match[2] || 's').toLowerCase();
  const mult = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60000 : 3600000;
  return Math.max(0, Math.round(amount * mult));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stateFile(root, name) {
  return path.join(root, '.atris', 'state', 'feed', name);
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

function findCardById(root, cardId, { env = process.env } = {}) {
  const listed = feed.listCards(root, { filter: 'all', limit: 200, env });
  const match = listed.cards.find((c) => c && c.id === cardId);
  if (match) return match;
  for (const filter of ['done', 'dismissed', 'parked']) {
    const extra = feed.listCards(root, { filter, limit: 200, env });
    const found = extra.cards.find((c) => c && c.id === cardId);
    if (found) return found;
  }
  return null;
}

function repliesFor(root, cardId, { env = process.env } = {}) {
  try {
    const out = room().replies(root, cardId, { limit: 500, env });
    return Array.isArray(out && out.replies) ? out.replies : [];
  } catch {
    return [];
  }
}

// Wait until a reply lands after `after` (or after current replies when omitted)
// or the card changes state/needs_decision. Replies already present after `after`
// return immediately so there is never a race window.
async function waitCard(root, cardId, {
  after = null,
  timeoutMs = 300000,
  intervalMs = 200,
  env = process.env,
  now = () => Date.now(),
} = {}) {
  const initialCard = findCardById(root, cardId, { env });
  const initialReplies = repliesFor(root, cardId, { env });
  const baselineIds = new Set(initialReplies.map((r) => r.id));
  const baselineState = initialCard ? `${initialCard.state}:${Boolean(initialCard.needs_decision)}` : null;

  function checkOnce() {
    const currentReplies = repliesFor(root, cardId, { env });
    if (after) {
      const idx = currentReplies.findIndex((r) => r.id === after);
      if (idx >= 0 && idx < currentReplies.length - 1) {
        return { waited: true, reason: 'reply', card_id: cardId, reply: currentReplies[idx + 1], replies_after: currentReplies.slice(idx + 1) };
      }
      if (idx < 0 && currentReplies.length > 0 && !baselineIds.has(currentReplies[currentReplies.length - 1].id)) {
        return { waited: true, reason: 'reply', card_id: cardId, reply: currentReplies[currentReplies.length - 1], replies_after: [currentReplies[currentReplies.length - 1]] };
      }
    } else {
      const added = currentReplies.filter((r) => !baselineIds.has(r.id));
      if (added.length) {
        return { waited: true, reason: 'reply', card_id: cardId, reply: added[0], replies_after: added };
      }
    }

    const currentCard = findCardById(root, cardId, { env });
    const currentState = currentCard ? `${currentCard.state}:${Boolean(currentCard.needs_decision)}` : null;
    if (baselineState !== null && currentState !== baselineState) {
      return { waited: true, reason: 'state', card_id: cardId, card: currentCard };
    }
    return null;
  }

  const immediate = checkOnce();
  if (immediate) return { version: feed.FEED_VERSION, ...immediate };

  const deadline = now() + Math.max(0, timeoutMs);
  const step = Math.max(20, Math.min(intervalMs, 2000));
  while (now() < deadline) {
    await sleep(Math.min(step, Math.max(10, deadline - now())));
    const hit = checkOnce();
    if (hit) return { version: feed.FEED_VERSION, ...hit };
  }
  return { version: feed.FEED_VERSION, waited: false, timeout: true, card_id: cardId };
}

function eventKey(ev, idx) {
  return ev && (ev.id || `${ev.at || ''}|${ev.type || ''}|${ev.member || ''}|${ev.card_id || ''}|${ev.text || ''}|${idx}`);
}

async function tailEvents(root, {
  limit = 20,
  since = null,
  follow = false,
  timeoutMs = 30000,
  intervalMs = 250,
  onEvent = null,
  now = () => Date.now(),
} = {}) {
  const seen = new Set();
  const emitted = [];
  const sinceMs = since ? Date.parse(since) : NaN;

  function scan() {
    const raw = team().readEvents(root, { limit: Math.max(limit, 50) });
    const items = Array.isArray(raw) ? raw.slice(-limit) : [];
    for (let i = 0; i < items.length; i += 1) {
      const ev = items[i];
      if (!Number.isNaN(sinceMs) && ev.at && Date.parse(ev.at) <= sinceMs) continue;
      const key = eventKey(ev, i);
      if (seen.has(key)) continue;
      seen.add(key);
      emitted.push(ev);
      if (onEvent) onEvent(ev);
    }
  }

  scan();
  if (!follow) return { version: feed.FEED_VERSION, events: emitted };

  const deadline = now() + Math.max(0, timeoutMs);
  const step = Math.max(25, Math.min(intervalMs, 2000));
  while (now() < deadline) {
    await sleep(Math.min(step, Math.max(10, deadline - now())));
    scan();
  }
  return { version: feed.FEED_VERSION, events: emitted };
}

function postIdempotent(root, {
  text,
  as = null,
  ask = false,
  idKey = null,
  env = process.env,
  deps = {},
} = {}) {
  const cleanText = String(text || '').trim();
  if (!cleanText) throw new feed.FeedError(400, 'usage: atris element post "<words>" [--as <member>] [--id <key>] [--id-only]');
  const key = idKey ? String(idKey).trim() : '';
  const idxFile = stateFile(root, 'idempotency.json');

  if (key) {
    const index = readJson(idxFile, {});
    const existing = index[key];
    if (existing && existing.card_id) {
      return { version: feed.FEED_VERSION, card_id: existing.card_id, card: existing.card || null, replayed: true, id_key: key };
    }
  }

  const out = room().say(root, { as: as || undefined, text: cleanText, ask: Boolean(ask), env, deps });
  const card = out.card || out.post || null;
  const cardId = (card && card.id) || out.id || null;

  if (key && cardId) {
    const index = readJson(idxFile, {});
    index[key] = { card_id: cardId, at: new Date().toISOString() };
    const keys = Object.keys(index);
    if (keys.length > 500) {
      for (const old of keys.slice(0, keys.length - 500)) delete index[old];
    }
    writeJsonAtomic(idxFile, index);
  }
  return { version: feed.FEED_VERSION, card_id: cardId, card, replayed: false, ...(key ? { id_key: key } : {}) };
}

function activeLeases(raw, nowMs) {
  const out = {};
  for (const [cardId, lease] of Object.entries(raw || {})) {
    if (lease && Number(lease.expires_at_ms) > nowMs) out[cardId] = lease;
  }
  return out;
}

function releaseLease(root, cardId) {
  const leaseFile = stateFile(root, 'leases.json');
  const leases = readJson(leaseFile, {});
  if (leases[cardId]) {
    delete leases[cardId];
    writeJsonAtomic(leaseFile, leases);
  }
}

function sparkline(values) {
  const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (!nums.length) return '';
  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  const span = hi - lo;
  return nums.map((v) => {
    if (span <= 1e-9) return SPARK_CHARS[3];
    const idx = Math.max(0, Math.min(SPARK_CHARS.length - 1, Math.round(((v - lo) / span) * (SPARK_CHARS.length - 1))));
    return SPARK_CHARS[idx];
  }).join('');
}

function percentile(values, pct) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((pct / 100) * (sorted.length - 1))));
  return Math.round(sorted[idx] * 100) / 100;
}

function slowestStage(timings) {
  if (!timings || typeof timings !== 'object') return null;
  let best = null;
  let bestMs = 0;
  for (const key of STAGE_KEYS) {
    const val = Number(timings[key]);
    if (Number.isFinite(val) && val > bestMs) {
      bestMs = val;
      best = key.replace(/_ms$/, '');
    }
  }
  return best;
}

function computeCurve(episodes, { window = 10 } = {}) {
  const win = Math.max(1, Math.min(Number(window) || 10, 200));
  const points = [];
  const rewards = [];
  const totals = [];
  const bottlenecks = {};
  let dispatched = 0;
  let failed = 0;
  let cumulativeSpend = 0;

  for (const ep of episodes || []) {
    if (!ep || typeof ep !== 'object') continue;
    const action = ep.action && typeof ep.action === 'object' ? ep.action : {};
    const rewardBlock = ep.reward && typeof ep.reward === 'object' ? ep.reward : {};
    const timings = ep.timings_ms && typeof ep.timings_ms === 'object' ? ep.timings_ms : {};
    if (action.dispatched) dispatched += 1;
    if (action.error) failed += 1;
    const spendRaw = action.cost_usd !== undefined && action.cost_usd !== null ? action.cost_usd : action.budget_reserved_usd;
    const spend = Math.max(0, Number(spendRaw || 0));
    cumulativeSpend = Math.round((cumulativeSpend + spend) * 10000) / 10000;

    let reward = null;
    let loss = null;
    if (typeof rewardBlock.value === 'number' && Number.isFinite(rewardBlock.value)) {
      reward = Math.round(Math.max(0, Math.min(1, rewardBlock.value)) * 10000) / 10000;
      loss = Math.round((1 - reward) * 10000) / 10000;
      rewards.push(reward);
    }
    const recent = rewards.slice(-win);
    const rollingReward = recent.length ? Math.round((recent.reduce((a, b) => a + b, 0) / recent.length) * 10000) / 10000 : null;
    const rollingLoss = rollingReward !== null ? Math.round((1 - rollingReward) * 10000) / 10000 : null;

    const totalMs = typeof timings.total_ms === 'number' && Number.isFinite(timings.total_ms) ? Math.round(timings.total_ms * 100) / 100 : null;
    if (totalMs !== null) totals.push(totalMs);
    const stage = slowestStage(timings);
    if (stage) bottlenecks[stage] = (bottlenecks[stage] || 0) + 1;

    points.push({
      episode_id: ep.episode_id || null,
      ts: ep.ts || null,
      reward,
      loss,
      rolling_loss: rollingLoss,
      spend_usd: spend,
      cumulative_spend_usd: cumulativeSpend,
      total_ms: totalMs,
      bottleneck: stage,
    });
  }

  let trend = 'insufficient_data';
  if (rewards.length >= 4) {
    const mid = Math.floor(rewards.length / 2);
    const earlyLoss = 1 - rewards.slice(0, mid).reduce((a, b) => a + b, 0) / mid;
    const lateLoss = 1 - rewards.slice(mid).reduce((a, b) => a + b, 0) / (rewards.length - mid);
    const delta = lateLoss - earlyLoss;
    trend = delta <= -0.05 ? 'improving' : delta >= 0.05 ? 'degrading' : 'flat';
  }

  const topBottleneck = Object.keys(bottlenecks).sort((a, b) => (bottlenecks[b] - bottlenecks[a]) || a.localeCompare(b))[0] || null;
  const rollingSeries = points.map((p) => p.rolling_loss).filter((v) => v !== null);
  const latestLoss = rollingSeries.length ? rollingSeries[rollingSeries.length - 1] : null;

  return {
    version: feed.FEED_VERSION,
    window: win,
    sparkline: sparkline(rollingSeries.slice(-30)),
    points,
    summary: {
      total_episodes: points.length,
      scored_episodes: rewards.length,
      dispatched_count: dispatched,
      failed_count: failed,
      latest_rolling_loss: latestLoss,
      total_spend_usd: cumulativeSpend,
      p95_total_ms: percentile(totals, 95),
      top_bottleneck: topBottleneck,
      trend,
    },
  };
}

function loadCurve(root, { file = null, limit = 100, window = 10 } = {}) {
  const candidates = file
    ? [path.resolve(root, file)]
    : [
      path.join(root, 'backend', 'rl', 'data', 'codeops_episodes.jsonl'),
      path.join(root, '.atris', 'state', 'codeops_episodes.jsonl'),
    ];
  const chosen = candidates.find((p) => fs.existsSync(p)) || null;
  const cap = Math.max(1, Math.min(Number(limit) || 100, 500));
  const rows = [];
  if (chosen) {
    const lines = fs.readFileSync(chosen, 'utf8').split('\n').filter((l) => l.trim()).slice(-cap);
    for (const line of lines) {
      try { rows.push(JSON.parse(line)); } catch { /* skip corrupt line */ }
    }
  }
  return { source: chosen, ...computeCurve(rows, { window }) };
}

module.exports = {
  activeLeases,
  readJson,
  releaseLease,
  repliesFor,
  stateFile,
  writeJsonAtomic,
  loadCurve,
  parseDuration,
  postIdempotent,
  tailEvents,
  waitCard,
};
