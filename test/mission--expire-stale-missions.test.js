'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function fixture(t, missions = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-expire-missions-'));
  const savedEnv = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) delete process.env[key];
  }
  process.env.HOME = root;
  t.after(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
    fs.rmSync(root, { recursive: true, force: true });
  });
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2025-06-15T12:00:00.000Z') });
  const ledger = path.join(root, '.atris', 'state', 'missions.jsonl');
  fs.mkdirSync(path.dirname(ledger), { recursive: true });
  fs.writeFileSync(ledger, missions.map(m => JSON.stringify(m)).join('\n'));
  const { expireStaleMissions } = require('../commands/mission');
  return { root, ledger, expireStaleMissions };
}

test('previews stale missions using activity rather than updated or paused dates', t => {
  const missions = [
    { id: 'old', owner: 'tester', status: 'READY', objective: 'x'.repeat(130),
      created_at: '2025-06-01T12:00:00Z', updated_at: '2025-06-15T12:00:00Z',
      paused_at: '2025-06-15T12:00:00Z' },
    { id: 'recent-tick', status: 'ready', created_at: '2025-06-01T12:00:00Z', last_tick_at: '2025-06-14T12:00:00Z' },
    { id: 'running', status: 'running', created_at: '2025-06-01T12:00:00Z' },
    { id: 'complete', status: 'complete', created_at: '2025-06-01T12:00:00Z' },
  ];
  const { root, ledger, expireStaleMissions } = fixture(t, missions);
  const before = fs.readFileSync(ledger, 'utf8');
  const result = expireStaleMissions(root, { idleDays: 7, dryRun: true });
  assert.deepStrictEqual(result, [{ id: 'old', owner: 'tester', previous_status: 'ready',
    objective: 'x'.repeat(120), reason: 'ready-idle' }]);
  assert.deepStrictEqual(result.held, []);
  assert.strictEqual(fs.readFileSync(ledger, 'utf8'), before);
  assert.deepStrictEqual(fs.readdirSync(path.dirname(ledger)), ['missions.jsonl']);
});

test('hour cutoff includes the boundary and respects custom statuses and missing dates', t => {
  const { root, expireStaleMissions } = fixture(t, [
    { id: 'boundary', status: 'planning', created_at: '2025-06-13T12:00:00Z', stop_reason: '  parked  ' },
    { id: 'newer', status: 'planning', created_at: '2025-06-13T12:00:00.001Z' },
    { id: 'invalid', status: 'planning', created_at: 'invalid' },
    { id: 'missing', status: 'planning' },
    { id: 'excluded', status: 'ready', created_at: '2025-06-01T12:00:00Z' },
  ]);
  const result = expireStaleMissions(root, {
    idleDays: 100, idleHours: 48, dryRun: true, statuses: new Set(['planning']),
  });
  assert.deepStrictEqual(result, [{ id: 'boundary', owner: undefined,
    previous_status: 'planning', objective: '', reason: 'parked' }]);
  assert.deepStrictEqual(result.held, []);
});

test('empty mission storage returns an empty result with a hidden held list', t => {
  const { root, ledger, expireStaleMissions } = fixture(t);
  fs.unlinkSync(ledger);
  const result = expireStaleMissions(root, { idleDays: 7, dryRun: true });
  assert.deepStrictEqual(result, []);
  assert.deepStrictEqual(result.held, []);
  assert.strictEqual(Object.prototype.propertyIsEnumerable.call(result, 'held'), false);
  assert.strictEqual(fs.existsSync(ledger), false);
});

test('stale pauses requiring operator login are held instead of expired', t => {
  const { root, expireStaleMissions } = fixture(t, [{
    id: 'login', owner: 'tester', objective: 'Resume after login', status: 'paused',
    created_at: '2025-06-01T12:00:00Z', stop_reason: 'auth-required',
  }]);
  const result = expireStaleMissions(root, { idleDays: 7, dryRun: true });
  assert.deepStrictEqual(result, []);
  assert.deepStrictEqual(result.held, [{
    id: 'login', owner: 'tester', previous_status: 'paused',
    objective: 'Resume after login', reason: 'auth-required',
    cause: 'the runner needs the operator to log in before it can continue',
    resume_command: 'atris mission run login',
  }]);
});
