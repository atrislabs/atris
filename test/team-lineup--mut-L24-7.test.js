'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { bootTeamLine } = require('../lib/team-lineup');

test('a job with no available engine does not advertise a tool', () => {
  const line = bootTeamLine('.', {
    width: 200,
    jobs: [{ job: 'build', engine: null, model: null, runs: null, backup_runs: null, now_runs: null }],
    now: new Date('2026-09-27T12:00:00Z'),
  });
  assert.strictEqual(line, '');
});
