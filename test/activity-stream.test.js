'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  buildActivityStream,
  buildHeartbeat,
  normalizePulse,
  normalizeScorecard,
  normalizeTaskEpisode,
  normalizeXp,
} = require('../lib/activity-stream');

// --- normalizers ---

test('normalizePulse only emits finished ticks, maps reward to status', () => {
  assert.equal(normalizePulse({ phase: 'started', ts: '2026-06-16T10:00:00Z' }), null);
  const good = normalizePulse({ phase: 'finished', ts: '2026-06-16T10:00:00Z', what: 'shipped X', verify_passed: true, reward: 1, actor: 'mission_run_due' });
  assert.equal(good.source, 'pulse');
  assert.equal(good.status, 'good');
  assert.equal(good.reward, 1);
  const bad = normalizePulse({ phase: 'finished', ts: '2026-06-16T10:00:00Z', verify_passed: false, reward: -1 });
  assert.equal(bad.status, 'bad');
});

test('normalizePulse tags autopilot (goal-authoring) ticks distinctly', () => {
  const e = normalizePulse({ phase: 'finished', ts: '2026-06-16T10:00:00Z', actor: 'autopilot', what: 'authored a goal' });
  assert.equal(e.kind, 'autopilot');
});

test('normalizeScorecard surfaces reward sign', () => {
  assert.equal(normalizeScorecard({ ts: '2026-06-16T10:00:00Z', reward: 1, what_shipped: 'x' }).status, 'good');
  assert.equal(normalizeScorecard({ ts: '2026-06-16T10:00:00Z', reward: -1 }).status, 'bad');
  assert.equal(normalizeScorecard({ ts: '2026-06-16T10:00:00Z', reward: 0 }).status, 'neutral');
});

test('normalizeTaskEpisode reads nested state + timestamp', () => {
  const e = normalizeTaskEpisode({ created_at: '2026-06-16T10:00:00Z', state: { title: 'fix bug', status: 'review' }, action: 'reviewed' });
  assert.equal(e.source, 'task');
  assert.equal(e.title, 'fix bug');
  assert.equal(e.status, 'review');
});

test('normalizeXp formats the XP award', () => {
  const e = normalizeXp({ accepted_at: '2026-06-16T10:00:00Z', title: 'shipped feature', xp: 1, actor: 'keshavrao' });
  assert.equal(e.source, 'xp');
  assert.equal(e.status, 'good');
  assert.match(e.detail, /\+1 XP/);
});

// --- feed assembly ---

test('buildActivityStream merges channels and sorts newest-first', () => {
  const events = buildActivityStream({
    pulseReceipts: [{ phase: 'finished', ts: '2026-06-16T10:00:00Z', what: 'tick A', reward: 1 }],
    scorecards: [{ ts: '2026-06-16T12:00:00Z', reward: 1, what_shipped: 'card' }],
    xpReceipts: [{ accepted_at: '2026-06-16T11:00:00Z', title: 'xp', xp: 1 }],
  });
  assert.equal(events.length, 3);
  assert.equal(events[0].ms >= events[1].ms, true);
  assert.equal(events[1].ms >= events[2].ms, true);
  assert.equal(events[0].source, 'reward'); // 12:00 newest
});

test('buildActivityStream drops rows with no usable timestamp', () => {
  const events = buildActivityStream({ scorecards: [{ reward: 1 }, { ts: 'not-a-date', reward: 1 }] });
  assert.equal(events.length, 0);
});

test('buildActivityStream respects the limit', () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ ts: `2026-06-16T${String(i % 24).padStart(2, '0')}:00:00Z`, reward: 0 }));
  assert.equal(buildActivityStream({ scorecards: rows }, { limit: 10 }).length, 10);
});

// --- heartbeat ---

test('buildHeartbeat reports alive with last-tick details for a fresh finished tick', () => {
  const now = Date.parse('2026-06-16T10:05:00Z');
  const hb = buildHeartbeat([
    { phase: 'started', tick_index: 1, ts: '2026-06-16T10:00:00Z' },
    { phase: 'finished', tick_index: 1, ts: '2026-06-16T10:01:00Z', what: 'shipped X', reward: 1, verify_passed: true },
  ], now);
  assert.equal(hb.state, 'alive');
  assert.equal(hb.alive, true);
  assert.equal(hb.last_what, 'shipped X');
  assert.equal(hb.last_reward, 1);
  assert.equal(hb.total_ticks, 1);
});

test('buildHeartbeat reports stale when a tick started but never finished', () => {
  const hb = buildHeartbeat([{ phase: 'started', tick_index: 9, ts: '2026-06-16T10:00:00Z' }]);
  assert.equal(hb.state, 'stale');
  assert.equal(hb.stale_reason, 'started_without_finish');
});

test('buildHeartbeat reports idle for an empty channel', () => {
  const hb = buildHeartbeat([]);
  assert.equal(hb.state, 'idle');
  assert.equal(hb.total_ticks, 0);
});

test('buildHeartbeat stays alive after a recovered crash (latest tick is what counts)', () => {
  const now = Date.parse('2026-06-16T10:05:00Z');
  const hb = buildHeartbeat([
    { phase: 'started', tick_index: 2, ts: '2026-06-16T08:00:00Z' }, // crashed earlier
    { phase: 'started', tick_index: 3, ts: '2026-06-16T10:01:00Z' },
    { phase: 'finished', tick_index: 3, ts: '2026-06-16T10:02:00Z', reward: 1, verify_passed: true },
  ], now);
  assert.equal(hb.state, 'alive');
  assert.deepEqual(hb.orphan_ticks, [2]); // still surfaced, just not fatal
});
