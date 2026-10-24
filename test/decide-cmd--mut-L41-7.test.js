'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { decideCommand } = require('../commands/decide');

test('an open mission decision identifies its assigned owner', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-decision-owner-'));
  const previousCwd = process.cwd();
  const previousHome = process.env.HOME;
  const previousLog = console.log;
  const previousExit = process.exit;
  const previousExitCode = process.exitCode;
  const output = [];
  try {
    process.env.HOME = root;
    process.chdir(root);
    const state = path.join(root, '.atris', 'state');
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'missions.jsonl'), JSON.stringify({
      id: 'mission-owner-fixture',
      objective: 'Review the proposed change',
      owner: 'release-lead',
      status: 'paused',
      created_at: '2024-01-02T03:04:05.000Z',
      updated_at: '2024-01-02T03:04:05.000Z',
      human_asks: [{ text: 'Publish the release?', category: 'approval' }],
    }) + '\n');
    console.log = (...parts) => output.push(parts.join(' '));
    process.exit = (code) => { throw new Error(`unexpected exit: ${code}`); };
    decideCommand(['--json']);
    assert.strictEqual(JSON.parse(output.join('\n')).decisions[0].owner, 'release-lead');
  } finally {
    console.log = previousLog;
    process.exit = previousExit;
    process.exitCode = previousExitCode;
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
