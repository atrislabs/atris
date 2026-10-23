'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { zenCommand } = require('../commands/zen');

test('apply does not claim a repo without an upstream matches origin', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-command-no-upstream-'));
  const originalLog = console.log;
  const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  const lines = [];
  try {
    const init = spawnSync('git', ['init', '--quiet', '--initial-branch=main', root], {
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull },
    });
    assert.equal(init.status, 0, init.stderr);
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
    console.log = (...args) => lines.push(args.join(' '));

    assert.equal(zenCommand(['--no-fetch'], root), 1);
    assert.deepEqual(lines, [
      '',
      '  atris zen',
      '',
      `  ${'─'.repeat(34)}`,
      '',
      '  code',
      '',
      '  almost zen. still out of place:',
      '  - no origin main branch to compare against',
      '  no unsaved team notes.',
      '',
    ]);
  } finally {
    console.log = originalLog;
    if (ttyDescriptor) Object.defineProperty(process.stdout, 'isTTY', ttyDescriptor);
    else delete process.stdout.isTTY;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
