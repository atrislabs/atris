'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { searchCommand: run } = require('../commands/search');

test('resolves team member file owner', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-team-'));
  const teamDir = path.join(dir, 'atris', 'team');
  fs.mkdirSync(teamDir, { recursive: true });
  fs.writeFileSync(path.join(teamDir, 'MEMBER.md'), 'lead developer\n');

  const origCwd = process.cwd();
  const origHome = process.env.HOME;
  const origExit = process.exit;
  const origLog = console.log;

  let output = '';
  process.chdir(dir);
  process.env.HOME = dir;
  process.exit = (code) => {
    throw new Error(`exit ${code}`);
  };
  console.log = (...args) => {
    output += args.join(' ') + '\n';
  };

  try {
    run(['developer'], { root: dir });
    assert.match(output, /Owner: atris\/team\/MEMBER\.md/);
  } finally {
    console.log = origLog;
    process.exit = origExit;
    if (origHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = origHome;
    }
    process.chdir(origCwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
