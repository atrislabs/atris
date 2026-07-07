'use strict';

// The improve fallback (and older automation) spawns
// `atris autopilot --auto --iterations=1` and means exactly one leg.
// The front loop must honor that cap instead of running unbounded.

const test = require('node:test');
const assert = require('node:assert');

const { maxLegsFlag } = require('../commands/autopilot-front');

test('maxLegsFlag parses --iterations=N and --iterations N', () => {
  assert.equal(maxLegsFlag(['--auto', '--iterations=1']), 1);
  assert.equal(maxLegsFlag(['--iterations', '3']), 3);
  assert.equal(maxLegsFlag(['--auto']), null);
  assert.equal(maxLegsFlag(['--iterations=0']), null);
  assert.equal(maxLegsFlag(['--iterations=junk']), null);
});
