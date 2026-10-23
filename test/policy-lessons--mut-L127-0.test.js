const test = require('node:test');
const assert = require('node:assert/strict');
const { mineProofPolicy } = require('../lib/policy-lessons');

test('a recent failed orb improvement produces a failing lesson', () => {
  const mined = mineProofPolicy({
    scorecards: [{
      schema: 'atris.improve_tick.v1',
      ts: '2026-06-09T12:00:00Z',
      source: 'orb',
      reward: 0,
      orb_exit_code: 1,
      orb_engine: 'codex',
      what_shipped: 'orb job failed: repair command routing',
      orb_log_path: '.atris/state/orb-runs/repair.log',
    }],
  }, { now: new Date('2026-06-10T12:00:00Z') });

  assert.equal(mined.lessons.find((lesson) => lesson.id === 'orb-job-failures')?.status, 'fail');
});
