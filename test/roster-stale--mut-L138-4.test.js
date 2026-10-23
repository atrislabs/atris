'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { attachStaleModels } = require('../lib/roster-stale');

test('renewing a lead whose assignment ends today omits a zero-day duration', () => {
  const report = {
    jobs: [{
      job: 'review',
      from: 'this project',
      file: 'atris/ROSTER.md',
      workers: [{
        engine: 'codex',
        model: 'gpt-6-astra',
        status: 'leads',
        why: '',
        until: '2026-09-30',
        ends_in_days: 0,
        runs: { engine: 'codex', model: 'gpt-6-astra', model_source: 'roster' },
      }],
    }],
    team: [],
  };
  const result = attachStaleModels(report, {
    catalog: { codex: ['gpt-6.1-sol'] },
    runs: [],
    now: new Date(2026, 8, 30, 12),
  });
  const renewal = result.stale.find((item) => item.job === 'review').text;
  assert.doesNotMatch(renewal, /--days\b/);
});
