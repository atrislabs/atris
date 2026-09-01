'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mission-plain-start-'));
  const memberDir = path.join(root, 'atris', 'team', 'mission-lead');
  fs.mkdirSync(memberDir, { recursive: true });
  fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), '# Mission Lead\n', 'utf8');
  return root;
}

function runMission(root, extraArgs = []) {
  return spawnSync(process.execPath, [
    cliPath,
    'mission',
    'run',
    'Make missions reliable and easy to understand',
    '--owner',
    'mission-lead',
    ...extraArgs,
  ], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      NODE_NO_WARNINGS: '1',
    },
  });
}

test('a sentence starts a checked mission with a plain next step', () => {
  const root = makeWorkspace();
  try {
    const result = runMission(root);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /^Mission started\.$/m);
    assert.match(result.stdout, /Goal: Make missions reliable and easy to understand/);
    assert.match(result.stdout, /Done when: the first result is checked and ready to review\./);
    assert.match(result.stdout, /Saved: Atris will remember this mission and its progress\./);
    assert.match(result.stdout, /How it will be checked: Atris will check the changed files for formatting problems before the result is ready\./);
    assert.match(result.stdout, /Next: Start the first piece of work in this chat\./);
    assert.doesNotMatch(result.stdout, /verifier|visible goal|task spine|receipt|\.atris|jsonl|mission room/i);

    const rows = fs.readFileSync(path.join(root, '.atris', 'state', 'missions.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const mission = rows.at(-1);
    assert.equal(mission.objective, 'Make missions reliable and easy to understand');
    assert.equal(mission.verifier, 'git diff --check');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('machine output keeps the exact runner instructions behind the plain screen', () => {
  const root = makeWorkspace();
  try {
    const result = runMission(root, ['--json']);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.action, 'mission_run_started');
    assert.equal(payload.mission.objective, 'Make missions reliable and easy to understand');
    assert.equal(payload.mission.verifier, 'git diff --check');
    assert.equal(payload.warnings.some((warning) => warning.code === 'missing_verifier'), false);
    assert.equal(payload.requires_native_goal_start, true);
    assert.equal(payload.native_goal_action.tool, 'create_goal');
    assert.match(payload.next_command, /create_goal/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
