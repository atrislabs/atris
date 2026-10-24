'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { rosterWorkerWalk } = require('../lib/engine-registry');

const NOW = '2026-04-15T12:00:00.000Z';
const ready = (id, roles = ['executor']) => ({ id, roles, health: { status: 'ready' } });
const worker = (engine, extra = {}) => ({ engine, never_expires: true, ...extra });

test('walk preserves worker order and pins settings without changing the registry', () => {
  const codex = ready('codex');
  const claude = ready('claude');
  const registry = { engines: [claude, codex] };
  const before = JSON.parse(JSON.stringify(registry));
  const workers = [worker('codex', {
    model: 'gpt-6.1', effort: 'high', max_seconds: '120', prep: 'read the brief',
  }), worker('claude')];

  const walk = rosterWorkerWalk({ workers }, 'executor', registry, NOW);

  assert.deepStrictEqual(walk.map((step) => step.skip), ['', '']);
  assert.strictEqual(walk[0].worker, workers[0]);
  assert.strictEqual(walk[0].raw, codex);
  assert.deepStrictEqual(walk[0].engine, {
    ...codex, roster_model: 'gpt-6.1', roster_effort: 'high',
    roster_max_seconds: 120, roster_prep: 'read the brief',
  });
  assert.notStrictEqual(walk[0].engine, codex);
  assert.strictEqual(walk[1].engine, claude);
  assert.deepStrictEqual(registry, before);
});

test('walk reports bad lines, expired picks, invalid models, and unavailable workers', () => {
  const workers = [
    worker('claude', { error: 'invalid line', until: '2026-04-01' }),
    { engine: 'claude', until: '2026-04-01' },
    worker('claude', { model: 'not-a-claude-model' }),
    worker('codex'),
    worker('unknown-engine'),
  ];
  const registry = { engines: [ready('claude'), {
    ...ready('codex'), health: { status: 'credit_out' },
  }] };

  const walk = rosterWorkerWalk({ workers }, 'executor', registry, NOW);

  assert.deepStrictEqual(walk, workers.map((entry, index) => ({
    worker: entry,
    skip: ['bad line', 'expired', 'bad model', 'not ready', 'not ready'][index],
    engine: null, raw: null,
  })));
});

test('cooling ends exactly at the supplied instant and anyEngine bypasses only the role check', () => {
  const cooling = {
    ...ready('codex'),
    health: { status: 'cooling', cooling_until: NOW, cooling_reason: 'stalled' },
  };
  const registry = { engines: [cooling, ready('opencode')] };
  const pick = { workers: [worker('codex'), worker('opencode')] };
  const before = rosterWorkerWalk(pick, 'navigator', registry, '2026-04-15T11:59:59.000Z', { anyEngine: true });
  assert.strictEqual(before[0].skip, 'cooling');
  assert.strictEqual(before[0].engine, null);
  assert.strictEqual(before[0].raw, null);
  // The display clock is local, so assert its stable data rather than its text.
  assert.strictEqual(before[0].cooling.until, NOW);
  assert.strictEqual(before[0].cooling.reason, 'stalled');
  assert.strictEqual(before[1].skip, '');

  const restricted = rosterWorkerWalk(pick, 'navigator', registry, NOW);
  assert.deepStrictEqual(restricted.map((step) => step.skip), ['not ready', 'not ready']);
  const unrestricted = rosterWorkerWalk(pick, 'navigator', registry, NOW, { anyEngine: true });
  assert.deepStrictEqual(unrestricted.map((step) => step.skip), ['', '']);
  assert.strictEqual(unrestricted[0].engine, cooling);
});

test('legacy backup survives an expired lead and ignores an invalid backup model', () => {
  const claude = ready('claude');
  const pick = {
    engine: 'codex', model: 'lead-model', effort: 'high', prep: 'lead preparation',
    until: '2026-04-01', max_seconds: '60', backup: 'claude',
    backup_model: 'not-a-claude-model', backup_effort: 'low',
  };
  const walk = rosterWorkerWalk(pick, 'executor', { engines: [ready('codex'), claude] }, NOW);
  assert.strictEqual(walk[0].skip, 'expired');
  assert.strictEqual(walk[1].skip, '');
  assert.strictEqual(walk[1].worker.backup, true);
  assert.deepStrictEqual(walk[1].engine, {
    ...claude, roster_effort: 'low', roster_max_seconds: 60,
  });
  assert.strictEqual(walk[1].raw, claude);
});

test('missing picks and explicitly empty worker lists produce empty walks', () => {
  const registry = { engines: [] };
  assert.deepStrictEqual(rosterWorkerWalk(null, 'executor', registry, NOW), []);
  assert.deepStrictEqual(rosterWorkerWalk({ workers: [] }, 'executor', registry, NOW), []);
});
