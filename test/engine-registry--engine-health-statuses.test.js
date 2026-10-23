'use strict';

// ENGINE_HEALTH_STATUSES is the closed list of health words an engine can carry.
// The resolver trusts a saved status only when it appears here, and
// `atris engine health --set` rejects anything outside it. These tests pin the
// list itself, so a renamed or dropped status fails here before it reaches a roster.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Keep the module off this machine: state and env reads go to a throwaway HOME.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-health-home-'));
process.env.HOME = tmpHome;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}

const { ENGINE_HEALTH_STATUSES, setEngineHealth } = require('../lib/engine-registry');

test('lists the five health statuses in the order the registry reads them', () => {
  assert.deepStrictEqual(
    [...ENGINE_HEALTH_STATUSES],
    ['ready', 'not_installed', 'credit_out', 'error', 'cooling'],
  );
});

test('is frozen, so a caller cannot add, remove, or rewrite a status', () => {
  assert.equal(Object.isFrozen(ENGINE_HEALTH_STATUSES), true);
  assert.throws(() => ENGINE_HEALTH_STATUSES.push('unknown'), TypeError);
  assert.equal(ENGINE_HEALTH_STATUSES.length, 5);
  assert.equal(Reflect.set(ENGINE_HEALTH_STATUSES, 0, 'broken'), false);
  assert.equal(ENGINE_HEALTH_STATUSES[0], 'ready');
});

test('matches only the exact lowercase names, so a loose or empty word is rejected', () => {
  assert.equal(ENGINE_HEALTH_STATUSES.includes('ready'), true);
  assert.equal(ENGINE_HEALTH_STATUSES.includes('cooling'), true);
  assert.equal(ENGINE_HEALTH_STATUSES.includes('READY'), false);
  assert.equal(ENGINE_HEALTH_STATUSES.includes(' ready'), false);
  assert.equal(ENGINE_HEALTH_STATUSES.includes(''), false);
  assert.equal(ENGINE_HEALTH_STATUSES.includes('unknown'), false);
});

test('setEngineHealth rejects a status outside the list and names every valid one', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-health-root-'));
  try {
    assert.throws(
      () => setEngineHealth('claude', 'bogus', root),
      (err) => {
        assert.match(err.message, /Unknown health "bogus"/);
        assert.ok(
          err.message.endsWith(`Known health statuses: ${ENGINE_HEALTH_STATUSES.join(', ')}`),
          err.message,
        );
        return true;
      },
    );
    // The check throws before any registry read or write, so nothing lands on disk.
    assert.deepStrictEqual(fs.readdirSync(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test.after(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});
