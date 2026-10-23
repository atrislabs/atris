'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isConductorArtifact } = require('../lib/conductor-artifacts');

test('recognizes a conductor run output as an artifact', () => {
  assert.strictEqual(isConductorArtifact('atris/runs/example.json'), true);
});
