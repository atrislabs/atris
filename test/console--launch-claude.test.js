'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { launchClaude } = require('../commands/console');

// Run the real launcher in a child, since it deliberately calls process.exit.
if (process.env.CONSOLE_LAUNCH_CASE) {
  const config = JSON.parse(process.env.CONSOLE_LAUNCH_CASE);
  launchClaude(config.prompt, config.args, {
    ...config.options,
    onRunnerExit(receipt) {
      fs.writeFileSync(config.receipt, JSON.stringify(receipt));
      if (config.throwInReceipt) throw new Error('receipt unavailable');
    },
  });
} else {
  function run(t, config = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'console-launch-claude-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const runner = path.join(root, 'local-runner');
    const output = path.join(root, 'output.json');
    const receipt = path.join(root, 'receipt.json');
    const cleanup = path.join(root, 'cleanup');
    fs.mkdirSync(cleanup);
    fs.writeFileSync(path.join(cleanup, 'nested.txt'), 'temporary');
    fs.writeFileSync(runner, `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(process.env.LAUNCH_OUTPUT, JSON.stringify({
  args: process.argv.slice(2),
  input: process.argv.includes('--print') ? fs.readFileSync(0, 'utf8') : null,
  cwd: process.cwd(),
  home: process.env.HOME,
  nestedSession: process.env.CLAUDECODE || null,
  custom: process.env.LAUNCH_CUSTOM || null,
}));
process.exit(${config.status || 0});
`, { mode: 0o700 });
    // A fresh environment excludes all inherited ATRIS_* settings and config.
    const child = spawnSync(process.execPath, [__filename], {
      cwd: root,
      encoding: 'utf8',
      env: {
        HOME: root,
        ATRIS_RUNNER_BIN: config.missing ? path.join(root, 'missing-runner') : runner,
        CLAUDECODE: 'parent-session',
        LAUNCH_OUTPUT: output,
        CONSOLE_LAUNCH_CASE: JSON.stringify({
          prompt: config.prompt === undefined ? 'System context\nwith "quotes"' : config.prompt,
          args: config.args || [],
          options: { ...config.options, cleanupPaths: [cleanup] },
          receipt,
          throwInReceipt: config.throwInReceipt,
        }),
      },
    });
    assert.ifError(child.error);
    assert.strictEqual(child.signal, null);
    assert.strictEqual(fs.existsSync(cleanup), false);
    return {
      child, root,
      receipt: JSON.parse(fs.readFileSync(receipt, 'utf8')),
      output: fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, 'utf8')) : null,
    };
  }

  test('launchClaude forwards arguments, stdin and environment to a real local runner', (t) => {
    const result = run(t, {
      args: ['--model', 'local model', 'literal; $(no-shell)'],
      options: { promptStdin: 'User request\nsecond line', runnerEnv: { LAUNCH_CUSTOM: 'override', CLAUDECODE: 'cannot-leak' } },
    });
    assert.strictEqual(result.child.status, 0);
    assert.strictEqual(result.child.stderr, '');
    assert.deepStrictEqual(result.output, {
      args: ['--dangerously-skip-permissions', '--print', '--append-system-prompt', 'System context\nwith "quotes"', '--model', 'local model', 'literal; $(no-shell)'],
      input: 'User request\nsecond line', cwd: fs.realpathSync(result.root), home: result.root,
      nestedSession: null, custom: 'override',
    });
    assert.deepStrictEqual(result.receipt, { status: 0, signal: null });
  });

  test('launchClaude accepts empty prompts, keeps permissions and preserves a failed runner exit', (t) => {
    const result = run(t, {
      prompt: '', status: 7, throwInReceipt: true,
      options: { skipPermissions: false, promptStdin: '' },
    });
    assert.strictEqual(result.child.status, 7);
    assert.deepStrictEqual(result.output.args, ['--print', '--append-system-prompt', '']);
    assert.strictEqual(result.output.input, '');
    assert.deepStrictEqual(result.receipt, { status: 7, signal: null });
    assert.match(result.child.stderr, /warning: could not finalize runner receipt: receipt unavailable/);
  });

  test('launchClaude reports a missing runner and cleans up before exiting', (t) => {
    const result = run(t, { missing: true });
    assert.strictEqual(result.child.status, 1);
    assert.strictEqual(result.output, null);
    assert.deepStrictEqual(result.receipt, { status: 1, signal: null });
    assert.match(result.child.stderr, /Failed to start .*missing-runner: .*ENOENT/);
  });
}
