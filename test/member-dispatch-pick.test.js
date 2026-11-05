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

// Member lab 2026-10-24: on a fresh `atris init` team, these plain jobs went to
// the wrong member. The validator took a fix job its own rules forbid (judge
// never patches) and left the fix uncommitted; the customer lead took a
// find-the-line question.
function freshInitTeam() {
  const root = workspace();
  for (const name of ['customer-lead', 'executor', 'improver', 'mission-lead', 'navigator', 'validator']) {
    const src = path.join(__dirname, '..', 'atris', 'team', name);
    const dest = path.join(root, 'atris', 'team', name);
    fs.mkdirSync(dest, { recursive: true });
    for (const file of ['MEMBER.md', 'MISSION.md']) {
      if (fs.existsSync(path.join(src, file))) fs.copyFileSync(path.join(src, file), path.join(dest, file));
    }
  }
  return root;
}

test('fix and find jobs on a fresh team go to a builder or the navigator, never the judge', () => {
  const root = freshInitTeam();
  try {
    // The shipped improver proposes workflow changes; the builder fixes code.
    const builders = new Set(['executor']);
    for (const job of [
      'fix the failing shipping tests.\n\nyou may only modify shipping.js.',
      'cli.js crashes when scanning a file that has no headings.\n\nfix scan.js.',
      'make npm test pass.\n\ndo not edit checks/cart.js.',
    ]) {
      const pick = pickMemberForIdea(job, root);
      assert.ok(builders.has(pick.member), `${JSON.stringify(job.slice(0, 40))} went to ${pick.member}`);
    }
    assert.equal(pickMemberForIdea('find the bug line.\n\ndo not edit source files.', root).member, 'navigator');
    assert.equal(pickMemberForIdea('review the diff for security holes', root).member, 'validator');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('review of PR 1650: the first job word names the job, and renamed researchers keep research', () => {
  const root = workspace();
  try {
    writeMember(root, 'executor', 'Ship product changes.\n', 'Builder');
    writeMember(root, 'validator', 'Review diffs.\n', 'Validator');
    writeMember(root, 'auto-improver', 'Fix recurring errors.\n', 'Auto Improver');
    writeMember(root, 'navigator', 'Map the codebase.\n', 'Navigator');
    writeMember(root, 'analyst', 'Look into options.\n', 'Researcher');
    assert.equal(pickMemberForIdea('review the bug fix for security holes', root).member, 'validator');
    assert.equal(pickMemberForIdea('Find and fix the parser error', root).member, 'auto-improver');
    assert.equal(pickMemberForIdea('research alternatives to SQLite', root).member, 'analyst');
    assert.equal(pickMemberForIdea('find the bug line. do not edit source files.', root).member, 'navigator');
    // Second review round.
    assert.equal(pickMemberForIdea('code review for security holes', root).member, 'validator');
    assert.equal(pickMemberForIdea('find the bug line; do not change source files', root).member, 'navigator');
    // Third review round: a find that also asks for changes is a build job.
    assert.notEqual(pickMemberForIdea('Find all callers and update them to the new API', root).member, 'navigator');
    assert.equal(pickMemberForIdea("find the bug line; don't edit source files", root).member, 'navigator');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Member lab 10/26: two code jobs went to members that never change code. One
// told a story about a reviewer timing out ("on its first review"), one named
// a script but no job word. A review is asked for, not mentioned.
test('a review word inside the story names no job; a review asked for still does', () => {
  const root = workspace();
  try {
    for (const name of ['validator', 'executor', 'navigator', 'customer-lead', 'task-planner', 'researcher', 'mission-lead', 'auto-improver']) {
      writeMember(root, name, name === 'mission-lead' ? 'Coordinates bounded mission runs from state to proof.\n' : '');
    }
    const cases = [
      ['executor', 'When a second reviewer times out, runEngineVerifier in commands/mission.js benches it in that project only. Every other project still waited the full five minutes on its first review. Done looks like: a later successful review clears it.'],
      ['executor', 'node scripts/member-lab.js --help starts a real lab run instead of printing usage. Stop when that is checked.'],
      ['navigator', 'Find the line that causes the crash in src/range.js. Do not edit any file; write the file and line to answers.json.'],
      ['customer-lead', 'Draft a reply email to the customer and add the pricing link.'],
      ['task-planner', 'Write a plan for adding offline mode to the app.'],
      ['researcher', 'Research how competitors update their pricing pages.'],
      ['validator', 'Review PR 1674 and say if it is safe to merge.'],
      ['validator', 'The PR is up. Please review it before merge.'],
      ['validator', 'PR 1680 is open. Code review it and say if it is safe.'],
      ['validator', 'review the bug fix in parser.js'],
      ['auto-improver', 'fix the review page so the button works'],
    ];
    for (const [member, text] of cases) assert.equal(pickMemberForIdea(text, root).member, member, text);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
