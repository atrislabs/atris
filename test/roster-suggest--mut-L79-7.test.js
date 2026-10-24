'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { attachSuggestions } = require('../lib/roster-suggest');

test('a pinned lead is judged on its own model despite successes on another model', () => {
  const row = {
    job: 'build',
    pick: { engine: 'codex' },
    workers: [
      { engine: 'codex', model: 'gpt-5' },
      { engine: 'claude', model: 'sonnet' },
    ],
  };
  const runs = [
    ...['failed', 'stalled', 'failed'].map((outcome) => ({
      at: '2026-06-10T10:00:00.000Z', job: 'build', engine: 'codex', model: 'gpt-5', outcome,
    })),
    ...['landed', 'landed'].map((outcome) => ({
      at: '2026-06-10T11:00:00.000Z', job: 'build', engine: 'claude', model: 'sonnet', outcome,
    })),
    ...['landed', 'landed', 'landed'].map((outcome) => ({
      at: '2026-06-10T12:00:00.000Z', job: 'build', engine: 'codex', model: 'gpt-5-mini', outcome,
    })),
  ];

  attachSuggestions([row], runs);

  assert.equal(row.suggestion?.challenger.model, 'sonnet');
});
