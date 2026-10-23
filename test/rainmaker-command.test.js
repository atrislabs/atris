'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { rainmakerCommand } = require('../commands/rainmaker');

const expectedHelp = 'Usage: atris rainmaker [args...]\n\nPassthrough to python3 scripts/rainmaker.py in atrisos-backend.';

test('--help prints usage and returns success', (t) => {
  const output = [];
  const errors = [];
  t.mock.method(console, 'log', (...args) => output.push(args));
  t.mock.method(console, 'error', (...args) => errors.push(args));

  assert.strictEqual(rainmakerCommand(['--help']), 0);
  assert.deepStrictEqual(output, [[expectedHelp]]);
  assert.deepStrictEqual(errors, []);
});

test('-h prints help even when more arguments follow', (t) => {
  const output = [];
  const errors = [];
  t.mock.method(console, 'log', (...args) => output.push(args));
  t.mock.method(console, 'error', (...args) => errors.push(args));
  const args = ['-h', 'instinct'];

  assert.strictEqual(rainmakerCommand(args), 0);
  assert.deepStrictEqual(output, [[expectedHelp]]);
  assert.deepStrictEqual(errors, []);
  assert.deepStrictEqual(args, ['-h', 'instinct']);
});
