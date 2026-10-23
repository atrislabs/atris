'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { whoCommand } = require('../commands/who');

test('a trailing lsof newline preserves the last engine cwd for workspace membership', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-lsof-newline-'));
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const home = process.env.HOME;
  const cwd = process.cwd();
  let output = '';
  try {
    process.env.HOME = root;
    process.chdir(root);
    Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
    whoCommand(['--json'], {
      root,
      now: () => Date.parse('2026-08-16T00:45:00.000Z'),
      tasks: [],
      missions: [],
      receipts: [],
      execFile(command) {
        if (command === 'ps') {
          return '501 1 Sat Aug 15 17:40:00 2026 /usr/local/bin/codex exec task\n';
        }
        if (command === 'lsof') return `p501\nn${root}\n`;
        throw new Error('unexpected process query');
      },
      write(text) { output += text; },
    });
    assert.equal(JSON.parse(output).unowned[0]?.pid, 501);
  } finally {
    Object.defineProperty(process, 'platform', platform);
    process.chdir(cwd);
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
  }
});
