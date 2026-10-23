const { test } = require('node:test');
const assert = require('node:assert');
const { vercelCommand } = require('../commands/vercel');

function captureOutput(run) {
  const stdout = [];
  const stderr = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => stdout.push(args.join(' '));
  console.error = (...args) => stderr.push(args.join(' '));
  try {
    return { status: run(), stdout: stdout.join('\n'), stderr: stderr.join('\n') };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

test('vercel without arguments prints its supported commands and installation help', () => {
  const result = captureOutput(() => vercelCommand());

  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stderr, '');
  assert.match(result.stdout, /usage: atris vercel <command> \[args\]/);
  for (const command of ['doctor', 'auth', 'deploy', 'ls', 'logs', 'inspect']) {
    assert.match(result.stdout, new RegExp(`^  ${command} +\\S`, 'm'));
  }
  assert.match(result.stdout, /--raw +print the full cli output instead of the grouped summary/);
  assert.match(result.stdout, /^binary: vercel$/m);
  assert.match(result.stdout, /^install: https:\/\/vercel\.com\/docs\/cli$/m);
});

test('vercel help aliases take priority over executable commands', () => {
  const expected = captureOutput(() => vercelCommand([]));

  for (const args of [['--help'], ['-h'], ['help'], ['deploy', '--help'], ['auth', '-h']]) {
    const result = captureOutput(() => vercelCommand(args));
    assert.deepStrictEqual(result, expected, JSON.stringify(args));
  }
});

test('vercel rejects unknown commands with an error and a help hint', () => {
  for (const run of [
    () => vercelCommand(['unknown-command', 'example']),
    () => vercelCommand('unknown-command', 'example'),
  ]) {
    const result = captureOutput(run);

    assert.strictEqual(result.status, 1);
    assert.strictEqual(result.stdout, '');
    assert.strictEqual(result.stderr,
      'unknown vercel command: unknown-command example\nrun: atris vercel --help');
  }
});
