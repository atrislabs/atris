'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { bootTeamLine } = require('../lib/team-lineup');

test('boot summary keeps the selected model when its label differs from the tool', () => {
  const runs = {
    engine: 'codex', model: 'gpt-6-astra', model_source: 'roster',
    effort: 'medium', effort_source: 'roster',
    text: 'codex (gpt-6-astra, medium)',
  };
  const line = bootTeamLine('/unused', {
    width: 200,
    jobs: [{ job: 'build', engine: 'codex', runs, now_runs: runs, status: 'picked', lead: 'first' }],
  });
  assert.match(line, /\bgpt-6-astra\b/);
});
