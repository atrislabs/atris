'use strict';

// One team view: atris team merges member folders (atris/team/*/MEMBER.md)
// with engine assignments read from live missions. Contract: roster table with
// member, role, engine(model), status, now columns.

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { collectTeamRoster, renderTeamRoster, teamCommand } = require('../commands/team');

const MEMBERS = [
  { name: 'linguist', role: 'Linguist - operator language and understanding' },
  { name: 'orb', role: 'Final Validator & CEO Brief' },
  { name: 'scout', role: '' },
];

function rosterDeps(overrides = {}) {
  return { root: '/fake/root', members: MEMBERS, missions: [], ...overrides };
}

test('roster table has expected headers and known member rows', () => {
  const roster = collectTeamRoster(rosterDeps());
  const rendered = renderTeamRoster(roster);

  assert.match(rendered, /MEMBER/);
  assert.match(rendered, /ROLE/);
  assert.match(rendered, /ENGINE\(MODEL\)/);
  assert.match(rendered, /STATUS/);
  assert.match(rendered, /NOW/);
  assert.match(rendered, /linguist/);
  assert.match(rendered, /operator language/);
  assert.ok(!rendered.includes('\u2014'), 'no em dashes in output');
});

test('template placeholder members are filtered out', () => {
  const members = [
    ...MEMBERS,
    { name: '<name>', role: 'Template role', dir: '/fake/root/atris/team/<name>' },
  ];
  const roster = collectTeamRoster(rosterDeps({ members }));
  assert.ok(!roster.some((entry) => entry.name === '<name>'));
  const rendered = renderTeamRoster(roster);
  assert.ok(!rendered.includes('<name>'));
});

test('heading-only now.md renders dash in NOW column', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-now-'));
  const memberDir = path.join(tmpDir, 'testmember');
  fs.mkdirSync(memberDir);
  fs.writeFileSync(path.join(memberDir, 'now.md'), '# Now\n\n## Another heading\n');

  const members = [{ name: 'testmember', role: 'test role', dir: memberDir }];
  const roster = collectTeamRoster(rosterDeps({ members, root: tmpDir }));
  assert.equal(roster[0].now, '-');
});

test('engine assignments merge from live missions onto their owners', () => {
  const missions = [
    { id: 'm1', owner: 'linguist', runner: 'codex', status: 'running' },
    { id: 'm2', owner: 'linguist', runner: 'cursor', status: 'running' },
    { id: 'm3', owner: 'orb', runner: 'grok', status: 'complete' },
    { id: 'm4', owner: 'scout', runner: 'manual', status: 'running' },
  ];
  const roster = collectTeamRoster(rosterDeps({ missions }));
  assert.deepEqual(roster.map((m) => [m.name, m.engine]), [
    ['linguist', 'codex'],
    ['orb', ''],
    ['scout', ''],
  ]);
  const rendered = renderTeamRoster(roster);
  assert.match(rendered, /linguist.*codex/s);
});

test('empty team renders the create hint and exits 0 through the command', () => {
  let out = '';
  const code = teamCommand([], rosterDeps({ members: [], write: (s) => { out += s; } }));
  assert.equal(code, 0);
  assert.match(out, /no team members yet/);
  assert.match(out, /atris member create/);
});

test('team command renders the roster on bare invocation and roster --json', () => {
  let out = '';
  const code = teamCommand(['roster'], rosterDeps({ write: (s) => { out += s; } }));
  assert.equal(code, 0);
  assert.match(out, /MEMBER/);
  assert.match(out, /linguist/);

  let jsonOut = '';
  const jsonCode = teamCommand(['roster', '--json'], rosterDeps({ write: (s) => { jsonOut += s; } }));
  assert.equal(jsonCode, 0);
  const parsed = JSON.parse(jsonOut);
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0].name, 'linguist');
});

test('unknown subcommands still fail with usage', () => {
  let err = '';
  const code = teamCommand(['bogus'], { error: (s) => { err += s; } });
  assert.equal(code, 2);
  assert.match(err, /usage: atris team/);
});
