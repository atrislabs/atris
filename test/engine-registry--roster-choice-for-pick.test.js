'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { rosterChoiceForPick } = require('../lib/engine-registry');

// These calls use only in-memory policy, ready health, and an explicit date.
// They never load saved rosters, probe installed tools, or read environment settings.
const now = new Date('2026-06-15T12:00:00.000Z');
const options = { key: 'executor', label: 'build', source: 'project', now };

function registry() {
  return {
    engines: ['codex', 'claude'].map((id) => ({
      id, roles: ['executor'], health: { status: 'ready' },
    })),
  };
}

test('chooses the lead and preserves independent worker pins in team order', () => {
  const engines = registry();
  const pick = {
    engine: 'codex',
    workers: [
      { engine: 'codex', never_expires: true, effort: 'high', max_seconds: 120, prep: 'search' },
      { engine: 'claude', never_expires: true, effort: 'low', max_seconds: 45 },
    ],
  };
  const choice = rosterChoiceForPick(pick, 'executor', engines, options);

  assert.deepStrictEqual(choice.team, [
    { ...engines.engines[0], roster_effort: 'high', roster_max_seconds: 120, roster_prep: 'search' },
    { ...engines.engines[1], roster_effort: 'low', roster_max_seconds: 45 },
  ]);
  assert.strictEqual(choice.engine, choice.team[0]);
  assert.strictEqual(choice.backup, engines.engines[1]);
  assert.strictEqual(choice.lead_index, 0);
  assert.strictEqual(choice.pick, pick);
  assert.strictEqual(choice.source, 'project');
  assert.strictEqual(choice.job, 'build');
  assert.strictEqual(choice.reason, 'roster pick for build: codex');
  assert.deepStrictEqual(choice.walk.map((step) => step.skip), ['', '']);
  assert.strictEqual(engines.engines[0].roster_effort, undefined);
  assert.strictEqual(engines.engines[1].roster_max_seconds, undefined);
});

test('an expired lead falls back to the legacy backup without inheriting its effort', () => {
  const engines = registry();
  const choice = rosterChoiceForPick({
    engine: 'codex', until: '2026-06-13', effort: 'high',
    backup: 'claude', backup_effort: 'low', max_seconds: 90,
  }, 'executor', engines, options);

  assert.deepStrictEqual(choice.engine, {
    ...engines.engines[1], roster_effort: 'low', roster_max_seconds: 90,
  });
  assert.deepStrictEqual(choice.team, [choice.engine]);
  assert.strictEqual(choice.lead_index, 1);
  assert.strictEqual(choice.backup, null);
  assert.deepStrictEqual(choice.walk.map((step) => step.skip), ['expired', '']);
  assert.strictEqual(choice.reason, 'roster pick for build expired, using backup: claude');
});

test('returns null for empty picks, mismatched job kinds, or no usable workers', () => {
  const engines = registry();
  for (const pick of [null, undefined, {}, { engine: 'codex', workers: [] }]) {
    assert.strictEqual(rosterChoiceForPick(pick, 'executor', engines, options), null);
  }
  assert.strictEqual(rosterChoiceForPick({
    engine: 'codex', never_expires: true, like: 'search',
  }, 'executor', engines, { ...options, key: 'custom-job' }), null);
  assert.strictEqual(rosterChoiceForPick({
    engine: 'codex',
    workers: [
      { engine: 'codex', error: 'invalid worker line' },
      { engine: 'claude', until: '2026-06-13' },
    ],
  }, 'executor', engines, options), null);
  assert.strictEqual(rosterChoiceForPick({
    engine: 'codex', never_expires: true,
  }, 'executor', { engines: [] }, options), null);
});
