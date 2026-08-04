'use strict';

// One team view: atris team merges member folders (atris/team/*/MEMBER.md)
// with engine assignments read from live missions. Contract: one plain
// lowercase sentence per member, no ULIDs, no hashes, no shouting.

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

test('members render one lowercase sentence each from MEMBER.md role lines', () => {
  const roster = collectTeamRoster(rosterDeps());
  assert.deepEqual(roster, [
    { name: 'linguist', role: 'operator language and understanding', engine: '' },
    { name: 'orb', role: 'final validator & ceo brief', engine: '' },
    { name: 'scout', role: 'no role written yet', engine: '' },
  ]);

  const rendered = renderTeamRoster(roster);
  assert.equal(rendered, [
    'linguist - operator language and understanding.',
    'orb - final validator & ceo brief.',
    'scout - no role written yet.',
  ].join('\n'));
  assert.equal(rendered, rendered.toLowerCase(), 'output stays lowercase');
  assert.ok(!rendered.includes('\u2014'), 'no em dashes in output');
});

test('engine assignments merge from live missions onto their owners', () => {
  const missions = [
    // Newest live mission wins for linguist.
    { id: 'm1', owner: 'linguist', runner: 'codex', status: 'running' },
    { id: 'm2', owner: 'linguist', runner: 'cursor', status: 'running' },
    // Finished missions are not assignments.
    { id: 'm3', owner: 'orb', runner: 'grok', status: 'complete' },
    // Native runners are not engines.
    { id: 'm4', owner: 'scout', runner: 'manual', status: 'running' },
  ];
  const roster = collectTeamRoster(rosterDeps({ missions }));
  assert.deepEqual(roster.map((m) => [m.name, m.engine]), [
    ['linguist', 'codex'],
    ['orb', ''],
    ['scout', ''],
  ]);
  assert.match(renderTeamRoster(roster), /^linguist - operator language and understanding, on codex\.$/m);
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
  assert.match(out, /^linguist - operator language and understanding\.$/m);

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
