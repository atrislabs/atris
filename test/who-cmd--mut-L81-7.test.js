'use strict';
require('./helpers/clean-temp');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { whoCommand } = require('../commands/who');

test('workspace presence uses the supplied process directory lookup', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'presence-directory-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  const previousExit = process.exit;
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const output = [];
  try {
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
    process.env.HOME = root;
    process.chdir(root);
    process.exit = (code) => { throw new Error(`unexpected exit ${code}`); };
    whoCommand(['--json'], {
      root,
      now: () => Date.parse('2026-08-16T00:45:00.000Z'),
      execFile: () => '765432 1 Sat Aug 15 17:40:00 2026 /usr/local/bin/codex exec task',
      readlink: () => root,
      write: (value) => output.push(value),
    });
    const payload = JSON.parse(output.join(''));
    assert.equal(payload.unowned[0]?.pid, 765432);
  } finally {
    Object.defineProperty(process, 'platform', platform);
    process.exit = previousExit;
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
