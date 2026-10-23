'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { whoCommand } = require('../commands/who');

test('who reports processes returned by the supplied command runner', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-who-runner-'));
  const oldHome = process.env.HOME;
  const oldCwd = process.cwd();
  const output = [];
  try {
    process.env.HOME = root;
    process.chdir(root);
    const code = whoCommand(['--json', '--global'], {
      root,
      now: () => Date.parse('2026-08-16T00:45:00.000Z'),
      receipts: [],
      tasks: [],
      missions: [],
      execFile: () => '765432 1 Sat Aug 15 17:40:00 2026 /usr/local/bin/codex exec supplied-runner-fixture\n',
      write: (text) => output.push(text),
    });
    assert.equal(code, 0);
    const presence = JSON.parse(output.join(''));
    const processRow = presence.unowned.find((row) => row.pid === 765432);
    assert.ok(processRow, 'the supplied runner process must be visible in workforce presence');
    assert.equal(processRow.command, '/usr/local/bin/codex exec supplied-runner-fixture');
  } finally {
    process.chdir(oldCwd);
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  }
});
