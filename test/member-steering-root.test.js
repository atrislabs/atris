'use strict';

// Footgun (a), member steering read path: memberPaths().steeringJsonl pointed
// at <process.cwd()>/.atris/state/steering.jsonl, so a member run from a
// subdirectory read steering from a nonexistent nested .atris and silently got
// no steering signals. It must resolve the shared workspace root.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'commands', 'member.js'), 'utf8');

test('memberPaths resolves the workspace root for the steering store', () => {
  // steering.jsonl must be built from the resolved root, not raw process.cwd().
  assert.match(SRC, /steeringJsonl: path\.join\(workspaceRoot, '\.atris', 'state', 'steering\.jsonl'\)/);
  assert.doesNotMatch(SRC, /steeringJsonl: path\.join\(process\.cwd\(\), '\.atris', 'state', 'steering\.jsonl'\)/);
});

test('the shared resolver maps a subdir to the workspace root', () => {
  const { resolveWorkspaceRoot } = require('../lib/mission-root');
  const os = require('node:os');
  const cp = require('node:child_process');
  const repo = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'atris-member-root-'));
  try {
    cp.execSync('git init -q', { cwd: repo });
    const sub = path.join(repo, 'backend');
    fs.mkdirSync(sub, { recursive: true });
    assert.equal(fs.realpathSync(resolveWorkspaceRoot(sub)), fs.realpathSync(repo));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
