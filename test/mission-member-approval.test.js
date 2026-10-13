'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');
const {
  memberApprovalAsks,
  objectiveNamesCategory,
  parseApprovalRequired,
  runBlockingAsks,
} = require('../lib/member-approval');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function memberText(permissions) {
  return `---\nname: gm\nrole: Game Manager\ntype: ai\npermissions:\n  can-read: true\n${permissions}\ntools: []\n---\n\n# GM\n`;
}

function makeWorkspace(approval) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-member-approval-'));
  const memberDir = path.join(dir, 'atris', 'team', 'game-manager');
  fs.mkdirSync(memberDir, { recursive: true });
  fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), memberText(approval));
  return dir;
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runCli(dir, args) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...scrubAgentEnv(),
      ATRIS_TASKS_DB: path.join(dir, 'tasks.db'),
      ATRIS_SKIP_UPDATE_CHECK: '1',
      NODE_NO_WARNINGS: '1',
    },
  });
  if (result.error) throw result.error;
  return result;
}

function startMission(dir, objective) {
  const start = runCli(dir, ['mission', 'start', '--no-verify', objective, '--owner', 'game-manager', '--runner', 'manual', '--json']);
  assert.equal(start.status, 0, start.stderr || start.stdout);
  return JSON.parse(start.stdout).mission;
}

test('parseApprovalRequired reads inline, block, nested and top-level lists and tolerates junk', () => {
  assert.deepEqual(parseApprovalRequired(memberText('  approval-required: [merge, "delete", \'publish\']')), ['merge', 'delete', 'publish']);
  assert.deepEqual(parseApprovalRequired(memberText('  approval-required:\n    - merge\n    - spend  # money')), ['merge', 'spend']);
  assert.deepEqual(parseApprovalRequired(memberText('  approval-required: []')), []);
  assert.deepEqual(parseApprovalRequired(memberText('  can-approve: false')), []);
  assert.deepEqual(parseApprovalRequired('# no frontmatter'), []);
  assert.deepEqual(parseApprovalRequired(memberText('  approval-required: [merge, delete]').replace(/\n/g, '\r\n')), ['merge', 'delete']);
  assert.deepEqual(parseApprovalRequired('---\napproval-required: [send]\n---\n'), ['send']);
});

test('objectiveNamesCategory matches the head word of a category as a stem', () => {
  assert.equal(objectiveNamesCategory('delete the old logs', 'delete'), true);
  assert.equal(objectiveNamesCategory('deleting stale files', 'delete'), true);
  assert.equal(objectiveNamesCategory('Publish the post', 'publish'), true);
  assert.equal(objectiveNamesCategory('clean up destructive scripts', 'destructive-file-action'), true);
  assert.equal(objectiveNamesCategory('fix the bug', 'delete'), false);
  assert.equal(objectiveNamesCategory('anything', ''), false);
});

// Seen live 2026-10-13: "report the baseline read-only; do not edit files"
// seeded an approval ask for edit-production-texting-router and the run never
// started. A forbidden action is not a request for it.
test('objectiveNamesCategory ignores a category the objective forbids', () => {
  const category = 'edit-production-texting-router-without-texting-review';
  assert.equal(objectiveNamesCategory('report the baseline read-only; do not edit files', category), false);
  assert.equal(objectiveNamesCategory("don't edit anything, just read", category), false);
  assert.equal(objectiveNamesCategory('summarize the logs without deleting them', 'delete'), false);
  assert.equal(objectiveNamesCategory('never publish drafts', 'publish'), false);
  assert.equal(objectiveNamesCategory('do not edit the docs, but edit the router', category), true);
  assert.equal(objectiveNamesCategory('edit the router copy', category), true);
});

test('memberApprovalAsks seeds one open ask for the categories the objective names, nothing otherwise', () => {
  const dir = makeWorkspace('  approval-required: [merge, delete, publish]');
  try {
    const asks = memberApprovalAsks('game-manager', dir, 'merge the branch and delete the temp files');
    assert.equal(asks.length, 1);
    assert.deepEqual(asks[0].categories, ['merge', 'delete']);
    assert.equal(asks[0].answered_at, null);
    assert.deepEqual(memberApprovalAsks('game-manager', dir, 'fix the typo in the readme'), []);
    assert.deepEqual(memberApprovalAsks('nobody', dir, 'merge it'), []);
    assert.deepEqual(memberApprovalAsks('../etc', dir, 'merge it'), []);
  } finally {
    cleanup(dir);
  }
});

test('runBlockingAsks keeps open asks and a denied approval ask, drops answered ones', () => {
  const approval = { text: 'a', source: 'member_approval_required', answered_at: null };
  assert.equal(runBlockingAsks([approval]).length, 1);
  assert.equal(runBlockingAsks([{ ...approval, answered_at: 'x', answer: 'yes' }]).length, 0);
  assert.equal(runBlockingAsks([{ ...approval, answered_at: 'x', answer: 'no' }]).length, 1);
  assert.equal(runBlockingAsks([{ text: 'plain', answered_at: 'x', answer: 'no' }]).length, 0);
  assert.equal(runBlockingAsks(['plain string ask']).length, 1);
  assert.equal(runBlockingAsks([{ text: '  ', answered_at: null }]).length, 0);
});

test('mission start seeds a human ask from the owner MEMBER.md approval-required', () => {
  const dir = makeWorkspace('  approval-required: [merge, delete]');
  try {
    const mission = startMission(dir, 'Merge the thing and delete the scratch files');
    assert.equal(mission.human_asks.length, 1);
    assert.match(mission.human_asks[0].text, /game-manager acting on: merge, delete/);
    assert.equal(mission.human_asks[0].answered_at, null);
  } finally {
    cleanup(dir);
  }
});

test('an objective that names no approval category seeds no ask, so default members keep running', () => {
  const dir = makeWorkspace('  approval-required: [delete, refactor-outside-scope]');
  try {
    const mission = startMission(dir, 'Add a version flag to the cli');
    assert.deepEqual(mission.human_asks, []);
  } finally {
    cleanup(dir);
  }
});

test('a member with approval-required: [] seeds no ask', () => {
  const dir = makeWorkspace('  approval-required: []');
  try {
    const mission = startMission(dir, 'Ship the thing that needs nothing');
    assert.deepEqual(mission.human_asks, []);
  } finally {
    cleanup(dir);
  }
});

test('explicit mission run stops on an open human ask without ticking, and resumes after yes', () => {
  const dir = makeWorkspace('  approval-required: [merge]');
  try {
    const mission = startMission(dir, 'Merge the gated thing');
    const blocked = runCli(dir, ['mission', 'run', mission.id, '--max-ticks', '1', '--json']);
    assert.equal(blocked.status, 2, blocked.stderr || blocked.stdout);
    const payload = JSON.parse(blocked.stdout);
    assert.equal(payload.reason, 'human_asks_open');
    assert.equal(payload.ok, false);
    assert.equal(payload.next_command, 'atris decide');

    const text = runCli(dir, ['mission', 'run', mission.id, '--max-ticks', '1']);
    assert.equal(text.status, 2);
    assert.match(text.stderr, /waiting on 1 human ask; not ticking/);
    assert.match(text.stderr, /atris decide/);
    const listed = JSON.parse(runCli(dir, ['mission', 'list', '--json']).stdout).missions.find((m) => m.id === mission.id);
    assert.equal(listed.status, 'planning', 'the blocked run did not tick or change the mission');

    const yes = runCli(dir, ['decide', '1', 'y', '--json']);
    assert.equal(yes.status, 0, yes.stderr || yes.stdout);
    const after = runCli(dir, ['mission', 'run', mission.id, '--max-ticks', '1', '--no-claude', '--json']);
    assert.doesNotMatch(`${after.stdout}${after.stderr}`, /human_asks_open|not ticking/);
  } finally {
    cleanup(dir);
  }
});

test('answering no does not clear a seeded approval ask for an explicit run', () => {
  const dir = makeWorkspace('  approval-required: [delete]');
  try {
    const mission = startMission(dir, 'Delete the denied thing');
    const no = runCli(dir, ['decide', '1', 'n', '--json']);
    assert.equal(no.status, 0, no.stderr || no.stdout);
    const blocked = runCli(dir, ['mission', 'run', mission.id, '--max-ticks', '1', '--json']);
    assert.equal(blocked.status, 2, blocked.stderr || blocked.stdout);
    assert.equal(JSON.parse(blocked.stdout).reason, 'human_asks_open');
  } finally {
    cleanup(dir);
  }
});

test('a mission with an operator --ask and no approval-required is also held by explicit run', () => {
  const dir = makeWorkspace('  approval-required: []');
  try {
    const start = runCli(dir, ['mission', 'start', '--no-verify', 'Ship asked thing', '--owner', 'game-manager', '--runner', 'manual', '--ask', 'ok to touch billing?', '--json']);
    assert.equal(start.status, 0, start.stderr || start.stdout);
    const mission = JSON.parse(start.stdout).mission;
    const blocked = runCli(dir, ['mission', 'run', mission.id, '--max-ticks', '1', '--json']);
    assert.equal(blocked.status, 2, blocked.stderr || blocked.stdout);
    assert.equal(JSON.parse(blocked.stdout).reason, 'human_asks_open');
  } finally {
    cleanup(dir);
  }
});
