'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

test('the completed mission owner gets the next member run', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-owner-selection-'));
  const originalHome = process.env.HOME;
  const originalCwd = process.cwd();
  const originalSpawn = childProcess.spawn;
  const originalExit = process.exit;
  const originalLog = console.log;
  const launchStopped = new Error('captured member launch');
  let selectedMember;

  try {
    process.env.HOME = root;
    process.chdir(root);
    for (const name of ['alpha', 'bravo']) {
      const memberDir = path.join(root, 'atris', 'team', name);
      fs.mkdirSync(memberDir, { recursive: true });
      fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), `---\nname: ${name}\n---\n`);
    }
    const stateDir = path.join(root, '.atris', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'missions.jsonl'), JSON.stringify({
      id: 'previous-mission',
      status: 'completed',
      owner: 'bravo',
      objective: 'repair login',
      runner: 'atris2',
      updated_at: '2026-01-01T00:00:00Z',
    }) + '\n');

    // Capture the real command decision before any engine can be launched.
    childProcess.spawn = (_command, args) => {
      selectedMember = args[3];
      throw launchStopped;
    };
    process.exit = (code) => { throw new Error(`unexpected exit: ${code}`); };
    console.log = () => {};
    const { autopilotFront } = require('../commands/autopilot-front');
    try {
      await autopilotFront(['--yes', '--once']);
    } catch (error) {
      if (error !== launchStopped) throw error;
    }
    assert.strictEqual(selectedMember, 'bravo');
  } finally {
    childProcess.spawn = originalSpawn;
    process.exit = originalExit;
    console.log = originalLog;
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});
