'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeTrace } = require('../lib/campaign-rsi');

// A mission paused for a person's yes ends held. The learning loop must not
// score that as a failure, count it in a streak, or draw a lesson from it.
function events() {
  const out = [];
  const add = (type, data, actor = 'owner') => {
    const seq = out.length + 1;
    out.push({ id: `held-event-${seq}`, campaign_id: 'cmp-held', origin: 'owned', seq,
      at: new Date(Date.UTC(2026, 9, 26, 10, 0, seq)).toISOString(), type, actor, data });
  };
  add('campaign_started', { title: 'held work', judge: 'exec check', budget: 10, owner: 'owner' });
  add('judge_ran', { passed: false, reading: 0.2 }, 'judge');
  for (const [id, outcome] of [['m1', 'held'], ['m2', 'held'], ['m3', 'failed']]) {
    add('mission_started', { mission_id: id, member: 'builder', objective: 'one slice' });
    add('step', { mission_id: id, engine: 'codex', cost_usd: 0 });
    add('mission_ended', { mission_id: id, outcome, cost_usd: 0.1 });
  }
  return out;
}

test('held missions add no failure, streak, or lesson; a real failure still does', () => {
  const summary = summarizeTrace(events());
  const builder = summary.members.find((row) => row.member === 'builder');
  assert.equal(builder.missions, 3);
  assert.equal(builder.failed, 1, 'only the failed mission counts');
  assert.equal(builder.repeat_failures, 0, 'two holds then one failure is not a streak');
  const lessons = summary.lessons.join('\n');
  assert.doesNotMatch(lessons, /end held/);
  assert.match(lessons, /m3 end failed/);
});
