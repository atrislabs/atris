'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

test('workspace presence includes an engine working in the current folder', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-who-cwd-'));
  const root = path.join(home, 'project');
  fs.mkdirSync(root);
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  const originalExec = childProcess.execFileSync;
  process.env.HOME = home;
  process.chdir(root);
  childProcess.execFileSync = (command) => {
    if (command === 'ps') {
      return '101 1 Sat Aug 15 17:40:00 2026 /usr/local/bin/codex exec task\n';
    }
    if (command === 'lsof') return `p101\nn${root}\n`;
    throw new Error(`unexpected command: ${command}`);
  };
  try {
    const { whoCommand } = require('../commands/who');
    let output = '';
    whoCommand(['--json'], {
      root,
      now: () => Date.parse('2026-08-16T01:00:00.000Z'),
      write: (text) => { output += text; },
    });
    assert.strictEqual(JSON.parse(output).unowned.some((row) => row.pid === 101), true);
  } finally {
    childProcess.execFileSync = originalExec;
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
