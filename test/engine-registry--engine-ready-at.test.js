'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { engineReadyAt } = require('../lib/engine-registry');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-engine-ready-at-test-'));
process.env.HOME = tmpDir;

function clearAtrisEnv() {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) {
      delete process.env[key];
    }
  }
}

clearAtrisEnv();

test.after(() => {
  clearAtrisEnv();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('engineReadyAt handles normal ready and cooling statuses', () => {
  const fixedNow = new Date('2026-10-23T12:00:00.000Z');

  assert.strictEqual(
    engineReadyAt({ health: { status: 'ready' } }, fixedNow),
    true,
    'ready engine should be ready at fixed date',
  );

  assert.strictEqual(
    engineReadyAt({ health: { status: 'ready' } }, '2026-10-23T12:00:00.000Z'),
    true,
    'ready engine should accept ISO string timestamp',
  );

  assert.strictEqual(
    engineReadyAt(
      { health: { status: 'cooling', cooling_until: '2026-10-23T12:15:00.000Z' } },
      fixedNow,
    ),
    false,
    'cooling engine whose cooldown is in the future should not be ready',
  );

  assert.strictEqual(
    engineReadyAt(
      { health: { status: 'cooling', cooling_until: '2026-10-23T11:45:00.000Z' } },
      fixedNow,
    ),
    true,
    'cooling engine whose cooldown has passed should be ready',
  );

  assert.strictEqual(
    engineReadyAt(
      { health: { status: 'cooling', cooling_until: '2026-10-23T12:00:00.000Z' } },
      fixedNow,
    ),
    true,
    'cooling engine whose cooldown boundary equals now should be ready',
  );
});

test('engineReadyAt handles edge cases for cooling stamps and error cooldowns', () => {
  clearAtrisEnv();
  const fixedNow = new Date('2026-10-23T12:00:00.000Z');

  assert.strictEqual(
    engineReadyAt({ health: { status: 'cooling', cooling_until: '' } }, fixedNow),
    true,
    'cooling engine with empty stamp routes immediately',
  );

  assert.strictEqual(
    engineReadyAt({ health: { status: 'cooling', cooling_until: 'invalid-date' } }, fixedNow),
    true,
    'cooling engine with invalid stamp routes immediately',
  );

  assert.strictEqual(
    engineReadyAt({ health: { status: 'error' } }, fixedNow),
    true,
    'errored engine without failure timestamp routes immediately',
  );

  assert.strictEqual(
    engineReadyAt({ health: { status: 'error', last_failure_ts: 'not-a-stamp' } }, fixedNow),
    true,
    'errored engine with invalid timestamp routes immediately',
  );

  const failureTs = '2026-10-23T11:40:00.000Z'; // 20 minutes before fixedNow (default cooldown is 30m)
  assert.strictEqual(
    engineReadyAt({ health: { status: 'error', last_failure_ts: failureTs } }, fixedNow),
    false,
    'errored engine within 30-minute cooldown window should not be ready',
  );

  const exactExpiredFailureTs = '2026-10-23T11:30:00.000Z'; // exactly 30 minutes before fixedNow
  assert.strictEqual(
    engineReadyAt({ health: { status: 'error', last_failure_ts: exactExpiredFailureTs } }, fixedNow),
    true,
    'errored engine at exact 30-minute cooldown boundary should be ready',
  );

  try {
    process.env.ATRIS_ENGINE_COOLDOWN_MINUTES = '15';
    assert.strictEqual(
      engineReadyAt({ health: { status: 'error', last_failure_ts: failureTs } }, fixedNow),
      true,
      'custom ATRIS_ENGINE_COOLDOWN_MINUTES should be respected when cooldown window expires',
    );
  } finally {
    clearAtrisEnv();
  }
});

test('engineReadyAt handles empty inputs, missing health, and non-ready statuses', () => {
  const fixedNow = new Date('2026-10-23T12:00:00.000Z');

  assert.strictEqual(engineReadyAt(null, fixedNow), false, 'null engine should not be ready');
  assert.strictEqual(engineReadyAt(undefined, fixedNow), false, 'undefined engine should not be ready');
  assert.strictEqual(engineReadyAt({}, fixedNow), false, 'engine without health should not be ready');
  assert.strictEqual(engineReadyAt({ health: {} }, fixedNow), false, 'engine with empty health should not be ready');
  assert.strictEqual(
    engineReadyAt({ health: { status: 'not_installed' } }, fixedNow),
    false,
    'not_installed status should not be ready',
  );
  assert.strictEqual(
    engineReadyAt({ health: { status: 'credit_out' } }, fixedNow),
    false,
    'credit_out status should not be ready',
  );
  assert.strictEqual(
    engineReadyAt({ health: { status: 'unknown_status' } }, fixedNow),
    false,
    'unrecognized status should not be ready',
  );
});
