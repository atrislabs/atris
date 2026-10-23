'use strict';

// ROSTER_LAYERS is the order roster picks are read in: this session first,
// then this project, then the whole machine. A pick in an earlier layer wins,
// so the order and the frozen shape are what the resolvers depend on.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-layers-home-'));
process.env.HOME = home;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}

const { ROSTER_LAYERS, rosterDecided } = require('../lib/engine-registry');

test('roster layers read in order: session, then project, then machine', () => {
  assert.deepStrictEqual([...ROSTER_LAYERS], ['session', 'project', 'machine']);
  assert.equal(ROSTER_LAYERS.length, 3);
});

test('roster layers are frozen so a caller cannot reorder or extend them', () => {
  assert.equal(Object.isFrozen(ROSTER_LAYERS), true);
  assert.throws(() => ROSTER_LAYERS.push('router'), TypeError);
  assert.throws(() => { ROSTER_LAYERS[0] = 'machine'; }, TypeError);
  assert.deepStrictEqual([...ROSTER_LAYERS], ['session', 'project', 'machine']);
});

test('rosterDecided is true only for a roster layer name', () => {
  for (const layer of ROSTER_LAYERS) {
    assert.equal(rosterDecided(layer), true, `${layer} should count as a roster decision`);
  }
  assert.equal(rosterDecided('router'), false);
  assert.equal(rosterDecided('default'), false);
  assert.equal(rosterDecided(''), false);
  assert.equal(rosterDecided(undefined), false);
});
