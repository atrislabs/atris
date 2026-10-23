'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { caretakerCommand } = require('../commands/caretaker');

const helpLines = [
  'usage: atris caretaker scan',
  'classify open pull requests on origin. detection only; no fix, comment, or merge.',
];

function captureOutput(t) {
  const stdout = [];
  const stderr = [];
  t.mock.method(console, 'log', (...args) => stdout.push(args));
  t.mock.method(console, 'error', (...args) => stderr.push(args));
  return { stdout, stderr };
}

test('caretaker defaults to help without reporting an error', (t) => {
  const output = captureOutput(t);

  assert.strictEqual(caretakerCommand(), 0);
  assert.deepStrictEqual(output.stdout, helpLines.map((line) => [line]));
  assert.deepStrictEqual(output.stderr, []);
});

test('caretaker help flags take precedence over scan and unknown arguments', (t) => {
  const output = captureOutput(t);

  for (const args of [['help'], ['scan', '--help'], ['unknown', '-h'], ['--']]) {
    output.stdout.length = 0;
    output.stderr.length = 0;

    assert.strictEqual(caretakerCommand(args), 0);
    assert.deepStrictEqual(output.stdout, helpLines.map((line) => [line]));
    assert.deepStrictEqual(output.stderr, []);
  }
});

test('caretaker rejects an unknown command after filtering argument separators', (t) => {
  const output = captureOutput(t);

  assert.strictEqual(caretakerCommand(['--', 'merge']), 1);
  assert.deepStrictEqual(output.stderr, [['unknown caretaker command: merge']]);
  assert.deepStrictEqual(output.stdout, helpLines.map((line) => [line]));
});
