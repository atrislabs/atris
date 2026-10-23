const test = require('node:test');
const assert = require('node:assert');
const { createOfficialCliCommand, printHelp } = require('../lib/official-cli-integration');

function config(summarize = false) {
  return {
    name: 'sample',
    binary: 'unused-help-only-binary',
    installHint: 'install sample locally',
    commands: [{
      match: ['items', 'list'],
      forward: ['list'],
      usage: 'items list',
      description: 'list saved items',
      summarize,
    }],
  };
}

function captureOutput(fn) {
  const stdout = [];
  const stderr = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => stdout.push(args.join(' '));
  console.error = (...args) => stderr.push(args.join(' '));
  try {
    return { result: fn(), stdout, stderr };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

test('printHelp renders configured commands and conditionally advertises raw output', () => {
  const expected = [
    '',
    'usage: atris sample <command> [args]',
    '',
    'commands:',
    '  doctor        detect the cli binary and auth state',
    '  auth          check auth state',
    `  ${'items list'.padEnd(13)} list saved items`,
    '',
    'binary: unused-help-only-binary',
    'install: install sample locally',
    '',
  ];
  const plain = captureOutput(() => printHelp(config()));
  assert.deepStrictEqual(plain.stdout, expected);
  assert.deepStrictEqual(plain.stderr, []);

  const summarized = captureOutput(() => printHelp(config(true)));
  assert.deepStrictEqual(summarized.stdout, [
    ...expected.slice(0, 7),
    '',
    '  --raw         print the full cli output instead of the grouped summary',
    ...expected.slice(7),
  ]);
  assert.deepStrictEqual(summarized.stderr, []);
});

test('empty arguments and help flags return help before dispatching a command', () => {
  const command = createOfficialCliCommand(config());
  const expected = captureOutput(() => printHelp(config())).stdout;
  for (const args of [[], ['--help'], ['-h'], ['help', 'items'], ['doctor', '--help'], ['items', 'list', '-h']]) {
    const output = captureOutput(() => command(args));
    assert.strictEqual(output.result, 0);
    assert.deepStrictEqual(output.stdout, expected);
    assert.deepStrictEqual(output.stderr, []);
  }
  const defaultArgs = captureOutput(() => command());
  assert.strictEqual(defaultArgs.result, 0);
  assert.deepStrictEqual(defaultArgs.stdout, expected);
  const variadic = captureOutput(() => command('items', 'list', '--help'));
  assert.strictEqual(variadic.result, 0);
  assert.deepStrictEqual(variadic.stdout, expected);
});

test('unknown and incomplete commands fail with an actionable error', () => {
  const command = createOfficialCliCommand(config());
  for (const args of [['items'], ['items', 'remove'], ['items', 'list-extra'], ['unknown', 'help']]) {
    const output = captureOutput(() => command(args));
    assert.strictEqual(output.result, 1);
    assert.deepStrictEqual(output.stdout, []);
    assert.deepStrictEqual(output.stderr, [
      `unknown sample command: ${args.join(' ')}`,
      'run: atris sample --help',
    ]);
  }
  const variadic = captureOutput(() => command('items', 'remove'));
  assert.strictEqual(variadic.result, 1);
  assert.deepStrictEqual(variadic.stderr, [
    'unknown sample command: items remove',
    'run: atris sample --help',
  ]);
});
