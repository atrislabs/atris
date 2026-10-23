'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { whoCommand } = require('../commands/who');

test('process working directory keeps an otherwise unlinked engine in its workspace', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-process-cwd-'));
  const oldHome = process.env.HOME;
  const oldCwd = process.cwd();
  const oldExit = process.exit;
  const oldLog = console.log;
  const output = [];
  try {
    process.env.HOME = root;
    process.chdir(root);
    process.exit = (code) => { throw new Error(`unexpected exit ${code}`); };
    console.log = () => {};
    whoCommand(['--json'], {
      root,
      now: () => Date.parse('2026-08-16T12:00:00.000Z'),
      execFile: (program) => {
        if (program === 'ps') return '731 1 Sun Aug 16 11:55:00 2026 codex exec work\n';
        if (program === 'lsof') return `p731\nn${root}\n`;
        throw new Error(`unexpected program ${program}`);
      },
      write: (text) => output.push(text),
    });
    const payload = JSON.parse(output.join(''));
    assert.equal(payload.unowned[0]?.pid, 731);
  } finally {
    console.log = oldLog;
    process.exit = oldExit;
    process.chdir(oldCwd);
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  }
});
