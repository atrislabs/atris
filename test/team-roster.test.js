'use strict';

// One team view: atris team merges member folders (atris/team/*/MEMBER.md)
// with active/rest sections. Active = engine frontmatter, awake presence, or now.md focus.

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { collectTeamRoster, renderTeamRoster, teamCommand } = require('../commands/team');
const { collectEarnedTeamPulse } = require('../lib/team-pulse');

const MEMBERS = [
  { name: 'linguist', role: 'Linguist - operator language and understanding' },
  { name: 'orb', role: 'Final Validator & CEO Brief' },
  { name: 'scout', role: '' },
];

function rosterDeps(overrides = {}) {
  return {
    root: '/fake/root',
    members: MEMBERS,
    missions: [],
    presence: { members: [] },
    ...overrides,
  };
}

test('roster renders active team and rest of the team sections', () => {
  const roster = collectTeamRoster(rosterDeps());
  const rendered = renderTeamRoster(roster);

  assert.match(rendered, /active team:/);
  assert.match(rendered, /rest of the team:/);
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

test('heading-only now.md renders dash in now field', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-now-'));
  const memberDir = path.join(tmpDir, 'testmember');
  fs.mkdirSync(memberDir);
  fs.writeFileSync(path.join(memberDir, 'now.md'), '# Now\n\n## Another heading\n');

  const members = [{ name: 'testmember', role: 'test role', dir: memberDir }];
  const roster = collectTeamRoster(rosterDeps({ members, root: tmpDir }));
  assert.equal(roster[0].now, '-');
  assert.equal(roster[0].active, false);
});

test('member with engine frontmatter appears in active section with engine string', () => {
  const members = [
    {
      name: 'coder',
      role: 'builder',
      frontmatter: { engine: 'codex gpt-5.6-sol' },
    },
    { name: 'scout', role: '' },
  ];
  const roster = collectTeamRoster(rosterDeps({ members }));
  const coder = roster.find((entry) => entry.name === 'coder');
  assert.equal(coder.engine, 'codex gpt-5.6-sol');
  assert.equal(coder.active, true);

  const rendered = renderTeamRoster(roster);
  assert.match(rendered, /active team:/);
  assert.match(rendered, /coder\s+\|\s+codex gpt-5\.6-sol\s+\|\s+assigned\s+\|\s+-/);
  assert.match(rendered, /rest of the team:/);
  assert.match(rendered, /scout/);
  assert.ok(!rendered.match(/active team:[\s\S]*scout \|/));
});

test('bare member without engine, presence, or now lands in rest section', () => {
  const members = [{ name: 'quiet', role: 'idle member' }];
  const roster = collectTeamRoster(rosterDeps({ members }));
  assert.equal(roster[0].active, false);

  const rendered = renderTeamRoster(roster);
  assert.match(rendered, /rest of the team:\nquiet/);
  assert.match(rendered, /active team:\n\(none\)/);
});

test('awake member is active with dash engine and live focus suffix', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-awake-'));
  const memberDir = path.join(tmpDir, 'scout');
  fs.mkdirSync(memberDir, { recursive: true });
  fs.writeFileSync(path.join(memberDir, 'now.md'), 'watch the perimeter');

  const members = [{ name: 'scout', role: 'scout role', dir: memberDir }];
  const roster = collectTeamRoster(rosterDeps({
    members,
    root: tmpDir,
    presence: { members: [{ name: 'scout' }] },
  }));
  const scout = roster.find((entry) => entry.name === 'scout');
  assert.equal(scout.active, true);
  assert.equal(scout.engine, '');
  assert.equal(scout.focus, 'watch the perimeter (live)');

  const rendered = renderTeamRoster(roster);
  assert.match(rendered, /scout\s+\|\s+-\s+\|\s+live\s+\|\s+watch the perimeter \(live\)/);
});

test('alwayson member with no now task shows always on focus when active', () => {
  const members = [{
    name: 'daemon',
    role: 'always running',
    frontmatter: { alwayson: true, engine: 'codex' },
  }];
  const roster = collectTeamRoster(rosterDeps({ members }));
  assert.equal(roster[0].active, true);
  assert.equal(roster[0].focus, 'always on');

  const rendered = renderTeamRoster(roster);
  assert.match(rendered, /daemon\s+\|\s+codex\s+\|\s+assigned\s+\|\s+always on/);
});

test('mission engines are kept on roster json as mission_engine', () => {
  const missions = [
    { id: 'm1', owner: 'linguist', runner: 'codex', status: 'running' },
    { id: 'm2', owner: 'orb', runner: 'grok', status: 'complete' },
  ];
  const roster = collectTeamRoster(rosterDeps({ missions }));
  const linguist = roster.find((entry) => entry.name === 'linguist');
  assert.equal(linguist.mission_engine, 'codex');
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
  assert.match(out, /active team:/);
  assert.match(out, /rest of the team:/);

  let jsonOut = '';
  const jsonCode = teamCommand(['roster', '--json'], rosterDeps({ write: (s) => { jsonOut += s; } }));
  assert.equal(jsonCode, 0);
  const parsed = JSON.parse(jsonOut);
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0].name, 'linguist');
  assert.equal(typeof parsed[0].active, 'boolean');
  assert.ok('engine' in parsed[0]);
});

test('plain team earns one pulse from fresh claimed work while exported and error surfaces stay quiet', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-pulse-'));
  const nowMs = Date.parse('2026-08-12T18:00:00.000Z');
  fs.mkdirSync(path.join(tmpDir, '.atris', 'state'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.atris', 'state', 'tasks.projection.json'), JSON.stringify({
    tasks: [{
      title: 'Repair the local team handoff',
      status: 'claimed',
      claimed_by: 'culture-lead',
      updated_at: nowMs - 60_000,
    }],
  }), 'utf8');

  try {
    let out = '';
    const deps = rosterDeps({
      root: tmpDir,
      cwd: tmpDir,
      now: () => nowMs,
      write: (s) => { out += s; },
    });
    assert.equal(teamCommand([], deps), 0);
    assert.match(out, /team pulse: culture-lead is moving repair the local team handoff\. keep going\./);
    assert.equal((out.match(/team pulse:/g) || []).length, 1);

    let jsonOut = '';
    assert.equal(teamCommand(['--json'], { ...deps, write: (s) => { jsonOut += s; } }), 0);
    assert.doesNotMatch(jsonOut, /team pulse:/);

    let htmlOut = '';
    assert.equal(teamCommand(['--html'], { ...deps, write: (s) => { htmlOut += s; } }), 0);
    assert.doesNotMatch(fs.readFileSync(htmlOut.trim(), 'utf8'), /team pulse:/);

    let err = '';
    assert.equal(teamCommand(['bogus'], { ...deps, error: (s) => { err += s; } }), 2);
    assert.doesNotMatch(err, /team pulse:/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('team pulse falls back to a recent completed result and ignores stale or unproven work', () => {
  const nowMs = Date.parse('2026-08-12T18:00:00.000Z');
  const pulse = collectEarnedTeamPulse('/unused', {
    now: () => nowMs,
    tasks: [
      {
        title: 'Old claimed work',
        status: 'claimed',
        claimed_by: 'builder',
        updated_at: nowMs - 25 * 60 * 60 * 1000,
      },
      {
        result: 'Local handoffs now name the next useful move',
        status: 'done',
        claimed_by: 'validator',
        done_at: nowMs - 60_000,
      },
    ],
  });
  assert.equal(pulse, 'team pulse: validator finished local handoffs now name the next useful move. nice work.');
  assert.equal(collectEarnedTeamPulse('/unused', {
    now: () => nowMs,
    tasks: [{ status: 'done', done_at: nowMs - 60_000 }],
  }), null);
});

test('unknown subcommands still fail with usage', () => {
  let err = '';
  const code = teamCommand(['bogus'], { error: (s) => { err += s; } });
  assert.equal(code, 2);
  assert.match(err, /usage: atris team/);
});

test('team --html writes board file with active section and member name', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-html-'));
  let out = '';
  const code = teamCommand(['--html'], rosterDeps({
    cwd: tmpDir,
    root: tmpDir,
    write: (s) => { out += s; },
  }));
  assert.equal(code, 0);
  const outPath = path.join(tmpDir, 'atris', 'team', 'team-board.html');
  assert.equal(out.trim(), outPath);
  const html = fs.readFileSync(outPath, 'utf8');
  assert.match(html, /Active team/);
  assert.match(html, /linguist/);
});

test('long now.md focus is not truncated in roster data', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-long-now-'));
  const memberDir = path.join(tmpDir, 'longfocus');
  fs.mkdirSync(memberDir, { recursive: true });
  const longFocus = 'a'.repeat(80);
  fs.writeFileSync(path.join(memberDir, 'now.md'), longFocus);

  const members = [{
    name: 'longfocus',
    role: 'test',
    dir: memberDir,
    frontmatter: { engine: 'codex' },
  }];
  const roster = collectTeamRoster(rosterDeps({ members, root: tmpDir }));
  assert.equal(roster[0].now, longFocus);
  assert.equal(roster[0].focus, longFocus);
});
