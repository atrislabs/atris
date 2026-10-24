'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { attachSuggestions } = require('../lib/roster-suggest');

test('uses run timestamps when history arrives newest first', () => {
  const row = {
    job: 'build',
    pick: { engine: 'codex' },
    workers: [{ engine: 'codex' }, { engine: 'claude' }],
  };
  // Imported history can arrive in descending timestamp order.
  const history = [8, 7, 6, 5, 4, 3, 2, 1].map((day) => ({
    at: `2024-01-0${day}T12:00:00.000Z`,
    job: 'build',
    engine: 'codex',
    outcome: day >= 4 ? 'failed' : 'landed',
  }));
  history.push(...[7, 8].map((day) => ({
    at: `2024-01-0${day}T12:00:00.000Z`,
    job: 'build',
    engine: 'claude',
    outcome: 'landed',
  })));

  attachSuggestions([row], history);

  assert.equal(row.suggestion?.lead.landed, 0);
});
