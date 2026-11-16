'use strict';

// Regression: the README must document engines and the fleet flight so
// operators can discover `atris engine`, `--engine <name>`, and the
// parallel-build / serial-land fleet run without reading the source.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const README = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');

test('README has an Engines section', () => {
  assert.match(README, /^## Engines$/m, 'expected a "## Engines" heading');
});

test('README documents the engine roster commands', () => {
  assert.match(README, /atris engine\b/, 'expected `atris engine` (roster + default)');
  assert.match(README, /atris engine cursor/, 'expected `atris engine <name>` example');
  assert.match(README, /--engine <name>/, 'expected the per-run `--engine <name>` flag');
});

test('README documents mission run --fleet with an example', () => {
  // Mirrors the task check: grep -q 'mission run --fleet' README.md
  assert.match(README, /mission run --fleet/, 'expected `mission run --fleet`');
  assert.match(README, /atris mission run --fleet --dry-run/, 'expected a --fleet example');
});
