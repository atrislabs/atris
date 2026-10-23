'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { attachSuggestions } = require('../lib/roster-suggest');

test('ignores workers with text when computing suggestions', () => {
  const row = {
    job: 'build',
    pick: { engine: 'codex' },
    workers: [
      { engine: 'codex', model: 'lead' },
      { engine: 'claude', model: 'challenger', text: '- claude, invalid' },
    ],
  };

  const history = [
    { at: '2024-01-01T12:00:00.000Z', job: 'build', engine: 'codex', model: 'lead', outcome: 'stalled' },
    { at: '2024-01-02T12:00:00.000Z', job: 'build', engine: 'codex', model: 'lead', outcome: 'stalled' },
    { at: '2024-01-03T12:00:00.000Z', job: 'build', engine: 'codex', model: 'lead', outcome: 'stalled' },
    { at: '2024-01-04T12:00:00.000Z', job: 'build', engine: 'claude', model: 'challenger', outcome: 'landed' },
    { at: '2024-01-05T12:00:00.000Z', job: 'build', engine: 'claude', model: 'challenger', outcome: 'landed' },
  ];

  assert.strictEqual(attachSuggestions([row], history), 0);
  assert.strictEqual(row.suggestion, undefined);
});
