'use strict';

// One team view: atris team merges member folders (atris/team/*/MEMBER.md)
// with active/rest sections. Active = awake presence or real work in the
// last 7 days; an engine in MEMBER.md or a now.md focus line is not work.

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
  return {
    root: '/fake/root',
    members: MEMBERS,
    missions: [],
    presence: { members: [] },
    liveRuns: [],
    ...overrides,
  };
}

test('the team renders as one table with a header row and two copyable commands', () => {
  const roster = collectTeamRoster(rosterDeps());
  const rendered = renderTeamRoster(roster);
  const lines = rendered.split('\n');
  assert.match(lines[0], /^MEMBER +JOB +ENGINE · MODEL +STATUS +DOING +LAST$/);
  for (const name of ['linguist', 'orb', 'scout']) assert.match(rendered, new RegExp(`^${name} +`, 'm'));
  assert.equal(lines[lines.length - 2], 'change who does a job: atris engine assign <job> <tool> --model <model>');
  assert.equal(lines[lines.length - 1], 'launch a member: atris member run <member> "<goal>" --minutes 30');
  assert.ok(!rendered.includes('|'), 'no pipes');
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

test('an engine in MEMBER.md alone does not make a member active', () => {
  const members = [
    {
      name: 'coder',
      role: 'builder',
      frontmatter: { engine: 'codex gpt-5.6-sol' },
    },
    { name: 'scout', role: '' },
  ];
  const roster = collectTeamRoster(rosterDeps({ members, activity: [] }));
  const coder = roster.find((entry) => entry.name === 'coder');
  assert.equal(coder.engine, 'codex gpt-5.6-sol');
  assert.equal(coder.active, false);

  const rendered = renderTeamRoster(roster);
  assert.match(rendered, /^coder +- +- +quiet +- +-$/m);
  assert.match(rendered, /^scout +- +- +quiet +- +-$/m);
  assert.ok(!rendered.includes('codex'), 'the frontmatter engine is not the roster');
});

test('a member with work in the last 7 days is active with its facts on one line', () => {
  const members = [
    { name: 'coder', role: 'builder', frontmatter: { engine: 'codex' } },
    { name: 'scout', role: '' },
  ];
  const activity = [{
    name: 'coder', status: 'active', last_active: '2026-09-28', days_since: 2, runs_7d: 3,
    engine: 'codex', model: 'gpt-6.1-sol', landed: 2, failed: 1, reverted: 0,
  }];
  const roster = collectTeamRoster(rosterDeps({ members, activity }));
  assert.equal(roster.find((entry) => entry.name === 'coder').active, true);
  const rendered = renderTeamRoster(roster, { termWidth: 200 });
  assert.match(rendered, /^coder +- +- +this week +3 runs this week, 2 landed, 1 failed +2d$/m);
  const lines = rendered.split('\n');
  assert.ok(lines.findIndex((line) => line.startsWith('coder')) < lines.findIndex((line) => line.startsWith('scout')), 'this week sorts above quiet');
  assert.match(rendered, /^scout +- +- +quiet +- +-$/m);
  assert.ok(!rendered.includes('\u2014'));
});

test('bare member without engine, presence, or now lands in rest section', () => {
  const members = [{ name: 'quiet', role: 'idle member' }];
  const roster = collectTeamRoster(rosterDeps({ members, activity: [] }));
  assert.equal(roster[0].active, false);

  const rendered = renderTeamRoster(roster);
  assert.match(rendered, /^quiet +- +- +quiet +- +-$/m);
});

test('quiet and idle members each get a row, longest-quiet last, with days since', () => {
  const members = ['alpha', 'beta', 'gamma', 'delta'].map((name) => ({ name, role: '' }));
  const activity = [
    { name: 'alpha', status: 'quiet', last_active: '2026-09-20', days_since: 10, runs_7d: 0 },
    { name: 'beta', status: 'quiet', last_active: '2026-09-19', days_since: 11, runs_7d: 0 },
    { name: 'gamma', status: 'idle', last_active: '2026-07-01', days_since: 91, runs_7d: 0 },
  ];
  const rendered = renderTeamRoster(collectTeamRoster(rosterDeps({ members, activity })), { termWidth: 200 });
  const rows = rendered.split('\n').filter((line) => /^(alpha|beta|gamma|delta) /.test(line));
  assert.deepEqual(rows.map((line) => line.split(/\s+/)[0]), ['alpha', 'beta', 'gamma', 'delta']);
  assert.match(rendered, /^alpha +- +- +quiet +- +10d$/m);
  assert.match(rendered, /^gamma +- +- +quiet +- +91d$/m);
  assert.match(rendered, /^delta +- +- +quiet +- +-$/m);
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
    activity: [],
  }));
  const scout = roster.find((entry) => entry.name === 'scout');
  assert.equal(scout.active, true);
  assert.equal(scout.engine, '');
  assert.equal(scout.focus, 'watch the perimeter (live)');

  const rendered = renderTeamRoster(roster);
  assert.match(rendered, /^scout +- +- +this week +watch the perimeter +-$/m);
});

test('alwayson member with no now task keeps its always on focus but needs work to be active', () => {
  const members = [{
    name: 'daemon',
    role: 'always running',
    frontmatter: { alwayson: true, engine: 'codex' },
  }];
  const roster = collectTeamRoster(rosterDeps({ members, activity: [] }));
  assert.equal(roster[0].active, false);
  assert.equal(roster[0].focus, 'always on');

  const live = collectTeamRoster(rosterDeps({ members, activity: [], presence: { members: [{ name: 'daemon' }] } }));
  assert.equal(live[0].active, true);
  assert.match(renderTeamRoster(live), /^daemon +- +- +this week +always on +-$/m);
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
  assert.match(out, /^MEMBER +JOB +ENGINE · MODEL +STATUS +DOING +LAST$/m);

  let jsonOut = '';
  const jsonCode = teamCommand(['roster', '--json'], rosterDeps({ write: (s) => { jsonOut += s; } }));
  assert.equal(jsonCode, 0);
  const parsed = JSON.parse(jsonOut);
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0].name, 'linguist');
  assert.equal(typeof parsed[0].active, 'boolean');
  assert.ok('engine' in parsed[0]);
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

// --- the lineup: which job, tool, and model each member runs ---------------

const LINEUP_ENV = ['ATRIS_MACHINE_ROSTER_PATH', 'ATRIS_MACHINE_ROSTER_MD_PATH', 'ATRIS_ROSTER_SESSION', 'ATRIS_ROSTER_SESSIONS_DIR', 'ATRIS_CODEX_CONFIG_PATH', 'ATRIS_ROUTER_EXPLAIN', 'ATRIS_RUNNER_MODEL'];

// A scratch project with a scratch home, so the real ~/.atris is never read.
function withLineupRoom(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-lineup-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'team-lineup-home-'));
  const saved = new Map(LINEUP_ENV.map((key) => [key, process.env[key]]));
  for (const key of LINEUP_ENV) delete process.env[key];
  process.env.ATRIS_MACHINE_ROSTER_PATH = path.join(home, '.atris', 'roster.json');
  process.env.ATRIS_ROUTER_EXPLAIN = '0';
  try {
    fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(root, 'atris', 'ROSTER.md'), [
      '# roster',
      '## build',
      '- claude code, model: opus 5.5',
      '## review',
      '- codex, model: gpt-6-astra, effort: medium',
      '## search',
      '- claude code, model: haiku 5.5',
      '## team',
      '- researcher: claude code, model: opus 5.5',
      '',
    ].join('\n'));
    const { readEngineRegistry, setEngineHealth } = require('../lib/engine-registry');
    readEngineRegistry(root);
    for (const name of ['claude', 'codex']) setEngineHealth(name, 'ready', root);
    for (const [name, role] of [['coder', 'builder'], ['alpha-judge', 'judge'], ['navigator', 'navigator'], ['researcher', 'deep researcher']]) {
      fs.mkdirSync(path.join(root, 'atris', 'team', name), { recursive: true });
      fs.writeFileSync(path.join(root, 'atris', 'team', name, 'MEMBER.md'), `---\nname: ${name}\nrole: ${role}\n---\n`);
    }
    return fn(root);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function lineupMembers() {
  return ['coder', 'alpha-judge', 'navigator', 'researcher'].map((name) => ({ name, role: 'test' }));
}

test('atris team shows each member with its job, tool, and model from the roster in one table', () => withLineupRoom((root) => {
  let out = '';
  const code = teamCommand([], rosterDeps({ root, members: lineupMembers(), termWidth: 80, write: (s) => { out += s; } }));
  assert.equal(code, 0);
  const lines = out.split('\n');
  assert.match(lines[0], /^MEMBER +JOB +ENGINE · MODEL +STATUS +DOING +LAST$/);
  assert.match(out, /^coder +build +claude · opus 5\.5 +quiet +- +-$/m);
  assert.match(out, /^alpha-judge +review +codex · gpt-6-astra +quiet +- +-$/m);
  assert.match(out, /^navigator +search +claude · haiku 5\.5 +quiet +- +-$/m);
  // researcher's team line puts it on a different model than its job.
  assert.match(out, /^researcher +search +claude · opus 5\.5 +quiet +- +-$/m);
  assert.ok(!out.includes('who does each job'), 'the old lineup blocks are gone');
  assert.ok(!out.includes('active team:'), 'the old active list is gone');
  lines.forEach((line) => assert.ok(line.length <= 80, `too wide: ${line}`));
  assert.ok(!out.includes('—'));
}));

test('atris team --json carries job, engine, model, and source per member', () => withLineupRoom((root) => {
  let out = '';
  const code = teamCommand(['--json'], rosterDeps({ root, members: lineupMembers(), write: (s) => { out += s; } }));
  assert.equal(code, 0);
  const parsed = JSON.parse(out);
  const by = Object.fromEntries(parsed.map((entry) => [entry.name, entry]));
  assert.deepEqual(by.coder.lineup, { job: 'build', engine: 'claude', model: 'claude-opus-5-5', effort: null, source: 'automatic', file: null });
  assert.equal(by['alpha-judge'].lineup.job, 'review');
  assert.equal(by['alpha-judge'].lineup.engine, 'codex');
  assert.equal(by['alpha-judge'].lineup.model, 'gpt-6-astra');
  assert.equal(by.researcher.lineup.job, 'search');
  assert.equal(by.researcher.lineup.model, 'claude-opus-5-5');
  assert.equal(by.researcher.lineup.source, 'roster');
  assert.ok('active' in by.coder, 'today\'s fields stay');
}));

test('a lineup that cannot be read still prints today\'s team plus one plain line', () => {
  let out = '';
  const code = teamCommand([], rosterDeps({ lineup: { ok: false, error: 'boom', jobs: [], team: [] }, write: (s) => { out += s; } }));
  assert.equal(code, 0);
  assert.match(out, /^MEMBER +JOB/m);
  assert.match(out, /^linguist +- +- +quiet/m);
  const lines = out.trim().split('\n');
  assert.ok(lines.includes('could not read who does each job, so tools and models are not shown. try: atris engine roster'), out);
  assert.equal(lines.filter((line) => line.includes('could not read')).length, 1);

  let json = '';
  teamCommand(['--json'], rosterDeps({ lineup: { ok: false, error: 'boom', jobs: [], team: [] }, write: (s) => { json += s; } }));
  assert.equal(JSON.parse(json)[0].lineup, null);
});

// --- working now: live engine runs on this machine -------------------------

const LIVE_RUNS = [
  { pid: 11, engine: 'codex', model: 'gpt-6.1-sol', effort: 'medium', member: 'alpha-judge', doing: 'second-round review of PR 3972', elapsed_seconds: 75 },
  { pid: 12, engine: 'devin', model: 'swe-2-max', effort: null, member: null, doing: 'You are the night shift for the Atris backend. You have this one run, with no human awake, to land ONE real, verified improvement.', elapsed_seconds: 380 },
];

test('a member named by a live run is working now, first, on the engine it really runs', () => withLineupRoom((root) => {
  let out = '';
  const activity = [{ name: 'coder', status: 'active', last_active: '2026-09-29', days_since: 2, runs_7d: 4, landed: 1 }];
  const code = teamCommand([], rosterDeps({ root, members: lineupMembers(), activity, liveRuns: LIVE_RUNS, termWidth: 120, write: (s) => { out += s; } }));
  assert.equal(code, 0);
  const rows = out.split('\n').slice(1, 6);
  assert.match(rows[0], /^alpha-judge +review +codex · gpt-6\.1-sol +working now +second-round review of PR 3972 +1m$/);
  assert.match(rows[1], /^\(no member\) +- +devin · swe-2-max +working now +You are the night shift.*… +6m$/);
  assert.match(rows[2], /^coder +build +claude · opus 5\.5 +this week +4 runs this week, 1 landed +2d$/);
  assert.match(rows[3], /^navigator +search +claude · haiku 5\.5 +quiet +- +-$/);
  out.split('\n').forEach((line) => assert.ok(line.length <= 120, `too wide: ${line}`));
}));

test('a narrow terminal clips DOING with an ellipsis and never clips MEMBER or ENGINE', () => withLineupRoom((root) => {
  let out = '';
  teamCommand([], rosterDeps({ root, members: lineupMembers(), liveRuns: LIVE_RUNS, termWidth: 80, write: (s) => { out += s; } }));
  const row = out.split('\n').find((line) => line.startsWith('alpha-judge'));
  assert.ok(row.length <= 80, row);
  assert.match(row, /^alpha-judge +review +codex · gpt-6\.1-sol +working now +second-round re.*… +1m$/);
}));

test('several live runs for one member make one row that counts them', () => {
  const runs = [
    { pid: 1, engine: 'codex', model: 'gpt-6.1-sol', member: 'orb', doing: 'newest', elapsed_seconds: 30 },
    { pid: 2, engine: 'codex', model: 'gpt-6.1-sol', member: 'orb', doing: 'older', elapsed_seconds: 900 },
  ];
  const rendered = renderTeamRoster(collectTeamRoster(rosterDeps({ activity: [] })), { liveRuns: runs, termWidth: 200 });
  assert.match(rendered, /^orb +- +codex · gpt-6\.1-sol +working now +2 runs: newest +now$/m);
  assert.equal(rendered.split('\n').filter((line) => line.startsWith('orb ')).length, 1);
});

test('a live run that names no member of this team is unattached and keeps the name it gave', () => {
  const runs = [{ pid: 1, engine: 'claude', model: 'claude-opus-5-5', member: 'visitor', doing: 'fix the docs', elapsed_seconds: 120 }];
  const rendered = renderTeamRoster(collectTeamRoster(rosterDeps({ activity: [] })), { liveRuns: runs, termWidth: 200 });
  assert.match(rendered, /^\(no member\) +- +claude · opus 5\.5 +working now +as visitor: fix the docs +2m$/m);
  assert.ok(!/^visitor /m.test(rendered));
});

test('atris team --json gives agents the same rows, plus runs that name no member', () => withLineupRoom((root) => {
  let out = '';
  teamCommand(['--json'], rosterDeps({ root, members: lineupMembers(), liveRuns: LIVE_RUNS, write: (s) => { out += s; } }));
  const parsed = JSON.parse(out);
  const judge = parsed.find((entry) => entry.name === 'alpha-judge');
  assert.equal(judge.state, 'working now');
  assert.equal(judge.engine_model, 'codex · gpt-6.1-sol');
  assert.equal(judge.job, 'review');
  assert.equal(judge.last, '1m');
  assert.equal(judge.live_runs.length, 1);
  assert.equal(judge.live_runs[0].pid, 11);
  const loose = parsed.filter((entry) => entry.name === '(no member)');
  assert.equal(loose.length, 1);
  assert.equal(loose[0].member, false);
  assert.equal(loose[0].engine_model, 'devin · swe-2-max');
  assert.equal(parsed.find((entry) => entry.name === 'coder').state, 'quiet');
}));

test('teamCommand reads live runs through deps.runPs, never the real machine, when a test passes one', () => withLineupRoom((root) => {
  const stdout = [
    '  101     1   01:15 node /Users/x/.bun/bin/codex exec --ephemeral -m gpt-6.1-sol -s read-only -o /tmp/r.md You are acting as navigator. Find the auth router',
  ].join('\n');
  let out = '';
  const deps = rosterDeps({ root, members: lineupMembers(), termWidth: 160, write: (s) => { out += s; } });
  delete deps.liveRuns;
  teamCommand([], { ...deps, runPs: () => ({ status: 0, stdout }) });
  assert.match(out, /^navigator +search +codex · gpt-6\.1-sol +working now +Find the auth router +1m$/m);
}));

test('a throwing roster reader is caught by readLineupSafe', () => {
  const lineup = require('../lib/team-lineup');
  const engine = require('../commands/engine');
  const original = engine.rosterReport;
  engine.rosterReport = () => { throw new Error('bad roster'); };
  try {
    const read = lineup.readLineupSafe('/fake/root');
    assert.equal(read.ok, false);
    assert.match(read.error, /bad roster/);
  } finally {
    engine.rosterReport = original;
  }
});
