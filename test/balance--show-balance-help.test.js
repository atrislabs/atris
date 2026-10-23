'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { showBalanceHelp } = require('../commands/balance');

const HELP_LINES = [
  'usage: atris balance [--json]',
  'show your credit balance in dollars, with credits on the next line.',
];

function captureLog(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.map((part) => String(part)).join(' '));
  try {
    return { value: fn(), lines };
  } finally {
    console.log = original;
  }
}

test('showBalanceHelp prints the usage line and the balance description', () => {
  const { value, lines } = captureLog(() => showBalanceHelp());
  assert.strictEqual(value, undefined);
  assert.deepStrictEqual(lines, HELP_LINES);
  assert.ok(lines.every((line) => line.length > 0));
});

test('showBalanceHelp ignores empty and extra arguments', () => {
  const cases = [
    [],
    [undefined],
    [null],
    [''],
    ['--json'],
    ['help', '--help', '-h'],
  ];
  for (const args of cases) {
    const { value, lines } = captureLog(() => showBalanceHelp(...args));
    assert.strictEqual(value, undefined, JSON.stringify(args));
    assert.deepStrictEqual(lines, HELP_LINES, JSON.stringify(args));
  }
});

test('showBalanceHelp lets a logging failure surface and prints nothing after it', () => {
  const lines = [];
  const original = console.log;
  console.log = () => {
    lines.push('attempt');
    throw new Error('log failed');
  };
  try {
    assert.throws(() => showBalanceHelp(), { message: 'log failed' });
    assert.deepStrictEqual(lines, ['attempt']);
  } finally {
    console.log = original;
  }
});
