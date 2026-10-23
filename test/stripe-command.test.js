const test = require('node:test');
const assert = require('node:assert');
const { stripeCommand } = require('../commands/stripe');

function captureOutput(run) {
  const logs = [];
  const errors = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => logs.push(args.join(' '));
  console.error = (...args) => errors.push(args.join(' '));
  try {
    return { status: run(), logs, errors };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

test('stripe help lists supported commands and installation details', () => {
  const result = captureOutput(() => stripeCommand());
  assert.strictEqual(result.status, 0);
  assert.deepStrictEqual(result.errors, []);
  const output = result.logs.join('\n');
  assert.match(output, /usage: atris stripe <command> \[args\]/);
  for (const usage of ['doctor', 'auth', 'listen', 'trigger', 'products list', 'products create']) {
    assert.ok(result.logs.some((line) => line.startsWith(`  ${usage} `)), usage);
  }
  assert.ok(result.logs.includes('binary: stripe'));
  assert.ok(result.logs.includes('install: https://docs.stripe.com/stripe-cli'));
});

test('stripe help flags take precedence over command execution', () => {
  const expected = captureOutput(() => stripeCommand([]));
  for (const args of [['--help'], ['-h'], ['help'], ['listen', '--help'], ['products', 'create', '-h']]) {
    assert.deepStrictEqual(captureOutput(() => stripeCommand(args)), expected);
  }
  assert.deepStrictEqual(captureOutput(() => stripeCommand('products', 'list', '--help')), expected);
});

test('stripe rejects unknown and incomplete commands with actionable errors', () => {
  for (const args of [['unknown'], ['products'], ['products', 'delete']]) {
    const result = captureOutput(() => stripeCommand(args));
    assert.strictEqual(result.status, 1);
    assert.deepStrictEqual(result.logs, []);
    assert.deepStrictEqual(result.errors, [
      `unknown stripe command: ${args.join(' ')}`,
      'run: atris stripe --help',
    ]);
  }
});
