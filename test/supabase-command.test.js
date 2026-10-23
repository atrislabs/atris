const { test } = require('node:test');
const assert = require('node:assert');
const { supabaseCommand } = require('../commands/supabase');

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

test('supabase with no arguments prints its supported commands', () => {
  const result = captureOutput(() => supabaseCommand());
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stderr, '');
  assert.match(result.stdout, /usage: atris supabase <command> \[args\]/);
  assert.match(result.stdout, /status\s+show local project status/);
  assert.match(result.stdout, /db push\s+push local database migrations/);
  assert.match(result.stdout, /functions list\s+list edge functions/);
  assert.match(result.stdout, /functions deploy\s+deploy an edge function/);
  assert.match(result.stdout, /binary: supabase/);
  assert.match(result.stdout, /install: https:\/\/supabase\.com\/docs\/guides\/cli/);
});

test('supabase help aliases take precedence over commands that would run the cli', () => {
  const expected = captureOutput(() => supabaseCommand([]));
  for (const args of [['help'], ['-h'], ['--help'], ['auth', '--help'], ['db', 'push', '-h']]) {
    assert.deepStrictEqual(captureOutput(() => supabaseCommand(args)), expected);
  }
  assert.deepStrictEqual(
    captureOutput(() => supabaseCommand('functions', 'deploy', '--help')),
    expected,
  );
});

test('supabase rejects unknown and incomplete commands with a help hint', () => {
  for (const args of [['unknown'], ['db'], ['functions'], ['db', 'pull']]) {
    const expected = {
      status: 1,
      stdout: '',
      stderr: `unknown supabase command: ${args.join(' ')}\nrun: atris supabase --help`,
    };
    assert.deepStrictEqual(captureOutput(() => supabaseCommand(args)), expected);
    assert.deepStrictEqual(captureOutput(() => supabaseCommand(...args)), expected);
  }
});
