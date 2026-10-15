'use strict';

// `atris member roster` is the clean team list: every member's full name,
// what it does, working or idle, and the engine it really runs on. It used
// to cut names at 16 characters, run columns together ("System
// Navigatordir"), and show file counts instead of who is doing what.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'bin', 'atris.js');
const { memberRosterRows, renderMemberRoster } = require('../commands/team');

const LONG_NAME = 'roster-objective-generator';

function writeMember(root, name, content) {
  const dir = path.join(root, 'atris', 'team', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'MEMBER.md'), content, 'utf8');
}

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'member-roster-clean-'));
  writeMember(root, LONG_NAME, `---\nname: ${LONG_NAME}\nrole: Objective Generator With A Long Title\ndescription: Finds the next useful goal from project evidence.\n---\n# x\n`);
  // The role only repeats the name, so the description has to say what it does.
  writeMember(root, 'roster-builder', '---\nname: roster-builder\nrole: Roster-builder\ndescription: Builds one slice at a time.\n---\n# x\n');
  // No header block at all: the opening sentence says what it does.
  writeMember(root, 'roster-judge', '# roster judge\n\nrole: feature gatekeeper. Activated in any chat.\n\n## more\n');
  writeMember(root, 'roster-parked', '---\nname: roster-parked\nstatus: parked\ndescription: Sleeps.\n---\n# x\n');
  return root;
}

// The engine column names tools found on this computer. Stand-ins keep the
// test the same on a machine with none installed, like GitHub's.
function fakeEngines(root) {
  const bin = path.join(root, 'fake-bin');
  fs.mkdirSync(bin, { recursive: true });
  for (const name of ['codex', 'claude']) {
    fs.writeFileSync(path.join(bin, name), '#!/bin/sh\necho "$0 1.0.0"\n', { mode: 0o755 });
  }
  return bin;
}

function runRoster(root, args = []) {
  return spawnSync(process.execPath, [CLI, 'member', 'roster', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, HOME: root, ATRIS_SKIP_UPDATE_CHECK: '1', PATH: `${fakeEngines(root)}${path.delimiter}/usr/bin${path.delimiter}/bin` },
    timeout: 60000,
  });
}

test('the roster lists full names, what each does, idle, and a real engine', () => {
  const root = makeWorkspace();
  try {
    const result = runRoster(root);
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.split('\n');
    assert.match(lines[0], /^MEMBER\s+STATUS\s+ENGINE\s+WHAT IT DOES$/);
    assert.doesNotMatch(result.stdout, /Format|Skills|Context|Version/);

    const row = (name) => lines.find((line) => line.startsWith(`${name} `));
    const long = row(LONG_NAME);
    assert.ok(long, `full name missing:\n${result.stdout}`);
    assert.match(long, /\sidle\s/);
    // A long description wraps under its own column; read it back as one line.
    assert.match(result.stdout.replace(/\s+/g, ' '), /idle \S+ · .*? finds the next useful goal from project evidence /);
    assert.match(row('roster-builder'), /builds one slice at a time$/);
    assert.match(row('roster-judge'), /feature gatekeeper$/);
    for (const name of [LONG_NAME, 'roster-builder', 'roster-judge']) {
      // The engine column names a tool and its model, never a blank.
      assert.match(row(name), /\s\S+ · \S.*\s{2}/, `no engine on ${name}:\n${result.stdout}`);
      assert.doesNotMatch(row(name), /not set|no role written yet/);
    }

    // Parked members leave the table and come back as one line.
    assert.equal(row('roster-parked'), undefined);
    assert.match(result.stdout, /3 members, 0 working now\./);
    assert.match(result.stdout, /parked \(1\): roster-parked · atris member roster --all to show them/);

    const all = runRoster(root, ['--all']);
    assert.equal(all.status, 0, all.stderr);
    assert.match(all.stdout, /^roster-parked\s+parked\s/m);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the roster json carries the same four facts per member', () => {
  const root = makeWorkspace();
  try {
    const result = runRoster(root, ['--json']);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.count, 4);
    const byName = Object.fromEntries(payload.members.map((m) => [m.name, m]));
    assert.equal(byName[LONG_NAME].state, 'idle');
    assert.equal(byName[LONG_NAME].does, 'finds the next useful goal from project evidence');
    assert.match(byName[LONG_NAME].engine, / · /);
    assert.equal(byName['roster-parked'].state, 'parked');
    assert.equal(byName['roster-parked'].parked, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a member with a live run in the project shows working on the run engine', () => {
  const members = [
    { name: 'scout', description: 'Looks around.', role: 'Scout', frontmatter: {} },
    { name: 'builder', description: 'Builds things.', role: 'Builder', frontmatter: {} },
  ];
  const lineup = { ok: true, team: [
    { member: 'scout', job: 'search', engine: 'claude', model: 'haiku' },
    { member: 'builder', job: 'build', engine: 'claude', model: 'opus' },
  ] };
  const liveRuns = [{ pid: 42, engine: 'codex', model: 'gpt-6.1-sol', member: 'builder', doing: 'x', elapsed_seconds: 30 }];
  const rows = memberRosterRows(members, { lineup, liveRuns });
  assert.deepEqual(rows.map((row) => [row.name, row.state]), [['builder', 'working'], ['scout', 'idle']]);
  assert.match(rows[0].engine, /^codex · /);
  assert.match(rows[1].engine, /^claude · /);

  const text = renderMemberRoster(members, { lineup, liveRuns, termWidth: 100 });
  assert.match(text, /^builder\s+working\s+codex · \S+.*builds things$/m);
  assert.match(text, /2 members, 1 working now\./);
});
