'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// consoleCommand shells out, so drive it in a child process with a controlled
// PATH: `which` resolves but finds no claude binary, and a stub npm returns a
// chosen exit status for the `npm install -g @anthropic-ai/claude-code` step.
if (process.env.CONSOLE_MUT_L282_CASE) {
  const { consoleCommand } = require('../commands/console');
  process.argv = ['node', 'atris', 'console', 'claude'];
  consoleCommand();
} else {
  function run(t, npmStatus) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'console-mut-l282-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, 'npm'),
      '#!/bin/sh\nexit ' + npmStatus + '\n',
      { mode: 0o755 }
    );
    const child = spawnSync(process.execPath, [__filename], {
      cwd: root,
      encoding: 'utf8',
      input: 'y\n',
      timeout: 30000,
      env: {
        HOME: root,
        PATH: bin + path.delimiter + '/usr/bin' + path.delimiter + '/bin',
        CONSOLE_MUT_L282_CASE: '1',
      },
    });
    assert.ifError(child.error);
    assert.strictEqual(child.signal, null);
    return child;
  }

  test('a failed backend install reports the failure and stops before launch', (t) => {
    const child = run(t, 7);
    assert.match(
      child.stderr,
      /Install failed\. Try: npm install -g @anthropic-ai\/claude-code/
    );
    assert.strictEqual(child.status, 1);
    assert.strictEqual(child.stdout.includes('claude installed'), false);
  });

  test('a successful backend install reports success instead of failure', (t) => {
    const child = run(t, 0);
    assert.match(child.stdout, /claude installed\./);
    assert.strictEqual(child.stderr.includes('Install failed'), false);
  });
}
