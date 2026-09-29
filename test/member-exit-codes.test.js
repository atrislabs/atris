'use strict';

// `atris member <sub>` used to force exit 0 for every subcommand except `run`,
// so a blocked alive install looked like success to scripts and agents.
// These spawn the real CLI in a temp workspace and read the real exit status.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'bin', 'atris.js');

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'member-exit-'));
  const memberDir = path.join(root, 'atris', 'team', 'demo');
  fs.mkdirSync(memberDir, { recursive: true });
  fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), '---\nname: demo\nrole: tester\n---\n# demo\n', 'utf8');
  return root;
}

function runMember(root, args) {
  return spawnSync(process.execPath, [CLI, 'member', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, HOME: root, ATRIS_SKIP_UPDATE_CHECK: '1' },
    timeout: 60000,
  });
}

test('blocked alive install exits 1', () => {
  const root = makeWorkspace();
  try {
    const result = runMember(root, ['alive', 'demo', '--install', '--hourly', '--forever', '--execute', '--json']);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 'blocked');
    assert.equal(payload.reason, 'execute_requires_confirm_autonomy_policy');
    assert.equal(result.status, 1, result.stderr);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('unknown member name exits 1', () => {
  const root = makeWorkspace();
  try {
    const result = runMember(root, ['wake', 'nosuchmember', '--json']);
    assert.match(result.stderr, /not found/);
    assert.equal(result.status, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('successful member list exits 0', () => {
  const root = makeWorkspace();
  try {
    const result = runMember(root, ['list', '--json']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /demo/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
