'use strict';

// Clear any ATRIS_* vars so module load sees the same empty environment the
// check harness runs under.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}

const test = require('node:test');
const assert = require('node:assert/strict');
const { ENGINE_DUTIES } = require('../lib/engine-registry');

test('ENGINE_DUTIES lists the three known duties in order', () => {
  assert.deepEqual([...ENGINE_DUTIES], ['leader', 'errands', 'learning']);
});

test('ENGINE_DUTIES is frozen and cannot be mutated', () => {
  assert.equal(Object.isFrozen(ENGINE_DUTIES), true);
  assert.throws(() => {
    ENGINE_DUTIES.push('overseer');
  }, TypeError);
  assert.throws(() => {
    ENGINE_DUTIES[0] = 'boss';
  }, TypeError);
  assert.equal(ENGINE_DUTIES.length, 3);
});

test('ENGINE_DUTIES membership matches the duties the CLI accepts', () => {
  // The `atris engine set --duty` gate and the engine chart bucketing both
  // rely on exact membership in this list.
  for (const duty of ['leader', 'errands', 'learning']) {
    assert.equal(ENGINE_DUTIES.includes(duty), true, `expected ${duty} to be a known duty`);
  }
});

test('ENGINE_DUTIES rejects empty, unknown, and lookalike values', () => {
  // Anything not in the list must fail the same includes() check the
  // validators run: empty input, roles that are not duties, wrong case,
  // and padded spellings all stay unknown.
  for (const value of ['', 'executor', 'navigator', 'LEADER', 'Leader', ' errands ', 'overseer']) {
    assert.equal(ENGINE_DUTIES.includes(value), false, `expected ${JSON.stringify(value)} to be rejected`);
  }
});
