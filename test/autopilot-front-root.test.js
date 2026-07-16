'use strict';

// Footgun (a), autopilot writer: `atris autopilot` stores its loop state
// (autopilot.json / autopilot.stop) under <root>/.atris/state. That root used
// to be the raw process.cwd(), so running from a subdirectory split the state
// into a nested .atris and a later `autopilot stop`/`status` from the workspace
// root could not see the running loop. autopilotFront must resolve the shared
// workspace root before it touches state.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'commands', 'autopilot-front.js'), 'utf8');

test('autopilotFront resolves the workspace root, not raw process.cwd()', () => {
  // The state root must flow through the shared resolver.
  assert.match(SRC, /resolveWorkspaceRoot\(process\.cwd\(\)\)/);
  // And it must NOT bind root directly to a bare process.cwd() in the entry.
  assert.doesNotMatch(SRC, /const root = process\.cwd\(\);/);
});

test('the shared resolver it uses maps a subdir to the workspace root', () => {
  const { resolveWorkspaceRoot } = require('../lib/mission-root');
  const os = require('node:os');
  const cp = require('node:child_process');
  const repo = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'atris-ap-root-'));
  try {
    cp.execSync('git init -q', { cwd: repo });
    const sub = path.join(repo, 'backend');
    fs.mkdirSync(sub, { recursive: true });
    assert.equal(fs.realpathSync(resolveWorkspaceRoot(sub)), fs.realpathSync(repo));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
