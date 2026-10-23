'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { ROSTER_SOURCES, ROSTER_LAYERS } = require('../lib/engine-registry');

// ROSTER_SOURCES is a frozen lookup table (layer name to the plain words a
// person sees), not a function, so these tests read it directly.

test('ROSTER_SOURCES maps each roster layer to its plain-words label', () => {
  assert.strictEqual(typeof ROSTER_SOURCES, 'object');
  assert.deepStrictEqual({ ...ROSTER_SOURCES }, {
    session: 'this session',
    project: 'this project',
    machine: 'all projects',
  });
  assert.strictEqual(ROSTER_SOURCES.session, 'this session');
  assert.strictEqual(ROSTER_SOURCES.project, 'this project');
  assert.strictEqual(ROSTER_SOURCES.machine, 'all projects');
});

test('ROSTER_SOURCES has exactly one distinct non-empty label per layer in ROSTER_LAYERS', () => {
  assert.deepStrictEqual(Object.keys(ROSTER_SOURCES), [...ROSTER_LAYERS]);
  const labels = ROSTER_LAYERS.map((layer) => ROSTER_SOURCES[layer]);
  for (const label of labels) {
    assert.strictEqual(typeof label, 'string');
    assert.ok(label.trim().length > 0, 'label is not blank');
    assert.strictEqual(label, label.toLowerCase(), 'label stays lowercase');
  }
  assert.strictEqual(new Set(labels).size, labels.length);
});

test('ROSTER_SOURCES is frozen: edits, additions, and deletes are refused', () => {
  assert.ok(Object.isFrozen(ROSTER_SOURCES));
  assert.throws(() => { ROSTER_SOURCES.session = 'somewhere else'; }, TypeError);
  assert.throws(() => { ROSTER_SOURCES.team = 'the team'; }, TypeError);
  assert.throws(() => { delete ROSTER_SOURCES.machine; }, TypeError);
  assert.strictEqual(ROSTER_SOURCES.session, 'this session');
  assert.strictEqual(ROSTER_SOURCES.machine, 'all projects');
  assert.strictEqual(Object.hasOwn(ROSTER_SOURCES, 'team'), false);
});

test('ROSTER_SOURCES has no label for an unknown or empty layer', () => {
  for (const scope of ['team', 'global', 'Session', '', undefined, null]) {
    assert.strictEqual(ROSTER_SOURCES[scope], undefined, `no label for ${String(scope)}`);
  }
  assert.strictEqual(Object.hasOwn(ROSTER_SOURCES, 'team'), false);
});
