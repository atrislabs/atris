'use strict';

// A plain request goes to the member whose job it is. A member whose mission
// file happens to share words with the request must not take the job away.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');
const { pickMemberForIdea } = require('../commands/member');

const cliPath = path.join(__dirname, '..', 'bin', 'atris.js');

function workspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-dispatch-pick-'));
}

function writeMember(root, name, mission = '', role = 'Test Member') {
  const dir = path.join(root, 'atris', 'team', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'MEMBER.md'), `---\nname: ${name}\nrole: ${role}\n---\n\n# ${name}\n`);
  if (mission) fs.writeFileSync(path.join(dir, 'MISSION.md'), mission);
}

test('a "where is" question goes to the navigator, not the member sharing the most words', () => {
  const root = workspace();
  try {
    writeMember(root, 'navigator', 'Map the codebase.\n');
    writeMember(root, 'executor', 'Ship product changes.\n');
    // The auto-improver's mission repeats the request's words, which used to
    // win because "code" also matched the builder's pattern it fell back to.
    writeMember(root, 'auto-improver', 'Where the email sender code breaks, find where and fix the code.\n');
    const pick = pickMemberForIdea('where is the email sender code', root);
    assert.equal(pick.member, 'navigator');
    assert.equal(pick.reason, 'maps the codebase and breaks ideas into clear steps');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a build request goes to the builder even when another mission echoes every word', () => {
  const root = workspace();
  try {
    writeMember(root, 'executor', 'Ship product changes.\n');
    writeMember(root, 'researcher', 'Study the export button, export modal, export screen, export header, and export footer.\n');
    const pick = pickMemberForIdea('build the export button, export modal, export screen, export header, export footer', root);
    assert.equal(pick.member, 'executor');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a member that owns the job outranks one that only falls back to it', () => {
  const root = workspace();
  try {
    writeMember(root, 'executor', 'Ship product changes.\n');
    // The auto-improver fixes recurring errors; for a plain build it only
    // borrows the build job, so its matching words should not decide.
    writeMember(root, 'auto-improver', 'Build the timeline export feature and wire the timeline export.\n');
    const pick = pickMemberForIdea('build and wire the timeline export feature', root);
    assert.equal(pick.member, 'executor');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('naming a member still wins over the member whose job it is', () => {
  const root = workspace();
  try {
    writeMember(root, 'executor', 'Ship product changes.\n');
    writeMember(root, 'researcher', 'Research options.\n');
    const pick = pickMemberForIdea('have researcher build the csv export button', root);
    assert.equal(pick.member, 'researcher');
    assert.equal(pick.reason, 'named in the idea');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('member dispatch --dry-run names the job owner through the CLI', () => {
  const root = workspace();
  try {
    writeMember(root, 'navigator', 'Map the codebase.\n');
    writeMember(root, 'auto-improver', 'Where the email sender code breaks, find where and fix the code.\n');
    const result = spawnSync(process.execPath, [cliPath, 'member', 'dispatch', 'where is the email sender code', '--dry-run', '--json'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 20000,
      env: { ...scrubAgentEnv(), ATRIS_SKIP_UPDATE_CHECK: '1' },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.member, 'navigator');
    assert.match(payload.command, /atris member run navigator/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
