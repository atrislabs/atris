const { test } = require('node:test');
const assert = require('node:assert');
const { consoleCommand } = require('../commands/console');

// These early-exit paths never inspect the workspace, home, or installed engines.
// Throw on exit so execution cannot fall through into backend detection.
function invoke(args) {
  const originalArgv = process.argv;
  const originalExit = process.exit;
  const originalLog = console.log;
  const originalError = console.error;
  const logs = [];
  const errors = [];
  const stopped = new Error('console command exited');
  let exitCode;

  try {
    process.argv = ['node', 'atris', 'console', ...args];
    console.log = (...values) => logs.push(values.join(' '));
    console.error = (...values) => errors.push(values.join(' '));
    process.exit = (code) => {
      exitCode = code;
      throw stopped;
    };
    assert.throws(() => consoleCommand(), (error) => error === stopped);
    return { logs, errors, exitCode };
  } finally {
    process.argv = originalArgv;
    process.exit = originalExit;
    console.log = originalLog;
    console.error = originalError;
  }
}

test('help prints usage and supported backend examples, then exits successfully', () => {
  const result = invoke(['help']);

  assert.strictEqual(result.exitCode, 0);
  assert.deepStrictEqual(result.errors, []);
  assert.strictEqual(result.logs[0], 'Usage: atris console [claude|codex] [...args]\n');
  assert.ok(result.logs.includes('Launch a coding agent wrapped in Atris context.\n'));
  assert.ok(result.logs.includes('  atris console claude       Launch with Claude Code'));
  assert.ok(result.logs.includes('  atris console codex        Launch with Codex'));
});

test('--help ignores trailing arguments and produces the same help as the help alias', () => {
  const expected = invoke(['help']);
  const result = invoke(['--help', 'unknown-backend', '--extra']);

  assert.deepStrictEqual(result, expected);
  assert.strictEqual(result.exitCode, 0);
  assert.strictEqual(result.logs.length, 8);
});

test('an unknown backend reports the offending value and exits with failure', () => {
  const result = invoke(['unknown-backend']);

  assert.strictEqual(result.exitCode, 1);
  assert.deepStrictEqual(result.logs, []);
  assert.deepStrictEqual(result.errors, [
    '✗ Unknown backend: unknown-backend',
    '  Usage: atris console [claude|codex]',
  ]);
});
