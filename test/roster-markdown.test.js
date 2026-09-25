'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { engineCommand } = require('../commands/engine');
const { resolveMissionTickRunner } = require('../commands/mission');
const { buildMemberRunStartArgs } = require('../commands/member');
const { buildPhaseRunnerCommand } = require('../commands/autopilot');
const { buildRunnerCommand } = require('../lib/runner-command');
const {
  engineRegistryFile,
  readEngineRegistry,
  readRosterState,
  resolveEngineForRoleRanked,
  rosterJobKey,
  rosterJobRole,
  setEngineHealth,
  setRosterPick,
} = require('../lib/engine-registry');
const { autoJobForMember, resolveEngineForMember } = require('../lib/member-engine');

const NOW = new Date('2026-09-24T12:00:00.000Z');
const RUNNER_ENV = ['ATRIS_RUNNER_PROFILE', 'ATRIS_RUNNER_MODEL', 'ATRIS_RUNNER_BIN', 'ATRIS_RUNNER_COMMAND_TEMPLATE', 'ATRIS_CLAUDE_MODEL', 'ATRIS_CLAUDE_BIN', 'ATRIS_CLAUDE_COMMAND_TEMPLATE'];

const EXAMPLE = `# roster

build: opus 5.5
small build: devin swe-2-max, backup grok
review: codex, backup opus 5.5
search: haiku

## team
researcher: search
judge: opus 5.5
`;

// Every room gets a scratch project and a scratch home, so neither the real
// ~/.atris/roster.json nor ~/.atris/ROSTER.md is ever read or written.
function withRoom(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-roster-md-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-roster-md-home-'));
  fs.mkdirSync(path.join(root, 'atris'));
  const saved = new Map(['ATRIS_MACHINE_ROSTER_PATH', 'ATRIS_MACHINE_ROSTER_MD_PATH', 'ATRIS_ROUTER_EXPLAIN', ...RUNNER_ENV].map((key) => [key, process.env[key]]));
  for (const key of RUNNER_ENV) delete process.env[key];
  delete process.env.ATRIS_MACHINE_ROSTER_MD_PATH;
  process.env.ATRIS_MACHINE_ROSTER_PATH = path.join(home, '.atris', 'roster.json');
  process.env.ATRIS_ROUTER_EXPLAIN = '0';
  const machine = { json: process.env.ATRIS_MACHINE_ROSTER_PATH, md: path.join(home, '.atris', 'ROSTER.md') };
  try { return fn(root, machine); } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function ready(root, ...names) {
  readEngineRegistry(root);
  for (const name of names) setEngineHealth(name, 'ready', root);
}

function writeRoster(root, text) {
  fs.writeFileSync(path.join(root, 'atris', 'ROSTER.md'), text);
}

// Year-less dates count from when the file was written; pin that moment.
function writtenAt(file, when = NOW) {
  fs.utimesSync(file, when, when);
}

function readRoster(root) {
  return fs.readFileSync(path.join(root, 'atris', 'ROSTER.md'), 'utf8');
}

function writeMachine(machine, text) {
  fs.mkdirSync(path.dirname(machine.md), { recursive: true });
  fs.writeFileSync(machine.md, text);
}

function addMember(root, name, role) {
  const dir = path.join(root, 'atris', 'team', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'MEMBER.md'), `---\nname: ${name}\nrole: ${role}\ndescription: test member\n---\n\n# ${name}\n`);
}

function state(root, now = NOW) {
  return readRosterState(root, { now });
}

function command(root, args, now = NOW) {
  const logs = [];
  const errors = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...parts) => logs.push(parts.join(' '));
  console.error = (...parts) => errors.push(parts.join(' '));
  try {
    const exit = engineCommand(args, { root, now });
    return { exit, out: logs.join('\n'), err: errors.join('\n') };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

function pickOf(pick) {
  const { file, line, ...rest } = pick;
  return rest;
}

test('the example roster parses exactly', () => withRoom((root) => {
  writeRoster(root, EXAMPLE);
  const project = state(root).project;
  assert.equal(project.format, 'markdown');
  assert.equal(project.file, path.join('atris', 'ROSTER.md'));
  assert.deepEqual(project.warnings, []);
  assert.deepEqual(pickOf(project.picks.executor), { engine: 'claude', model: 'claude-opus-5-5', backup: '', until: '', never_expires: true });
  assert.deepEqual(pickOf(project.picks['small-build']), { engine: 'devin', model: 'swe-2-max', backup: 'grok', until: '', never_expires: true, like: 'build' });
  assert.deepEqual(pickOf(project.picks.validator), { engine: 'codex', model: '', backup: 'claude', backup_model: 'claude-opus-5-5', until: '', never_expires: true });
  assert.deepEqual(pickOf(project.picks.navigator), { engine: 'haiku', model: '', backup: '', until: '', never_expires: true });
  assert.equal(project.picks.executor.line, 3);
  assert.deepEqual(project.team.map((line) => [line.member, line.value, line.line]), [['researcher', 'search', 9], ['judge', 'opus 5.5', 10]]);
}));

test('model words alone pick the engine by family, and an engine word takes the rest as its model', () => withRoom((root) => {
  writeRoster(root, [
    '# roster',
    'build: sonnet 5',
    'small build: grok 4.7 fast',
    'tiny build: swe-2-max',
    'big build: claude haiku',
    'odd build: devin swe-2-max',
    'wide build: grok 4.7',
    'long build: opus[1m]',
    '',
  ].join('\n'));
  const picks = state(root).project.picks;
  assert.deepEqual(state(root).project.warnings, []);
  assert.deepEqual([picks.executor.engine, picks.executor.model], ['claude', 'claude-sonnet-5']);
  assert.deepEqual([picks['small-build'].engine, picks['small-build'].model], ['grok', 'grok-4.7-build-fast']);
  assert.deepEqual([picks['tiny-build'].engine, picks['tiny-build'].model], ['devin', 'swe-2-max']);
  assert.deepEqual([picks['big-build'].engine, picks['big-build'].model], ['claude', 'haiku']);
  assert.deepEqual([picks['odd-build'].engine, picks['odd-build'].model], ['devin', 'swe-2-max']);
  assert.deepEqual([picks['wide-build'].engine, picks['wide-build'].model], ['grok', 'grok-4.7']);
  assert.deepEqual([picks['long-build'].engine, picks['long-build'].model], ['claude', 'opus[1m]']);
}));

test('backup and until: dates in either spelling, the nearest one not past, and the backup keeps its own model', () => withRoom((root) => {
  ready(root, 'codex', 'claude', 'cursor');
  writeRoster(root, [
    '# roster',
    'build: codex, backup opus 5.5, until oct 24',
    'review: claude, until 2026-10-01',
    'deep build: cursor, until sep 1',
    'wide build: cursor, until oct 24, 2027',
    '',
  ].join('\n'));
  writtenAt(path.join(root, 'atris', 'ROSTER.md'));
  const picks = state(root).project.picks;
  assert.equal(picks.executor.until, '2026-10-24');
  assert.equal(picks.validator.until, '2026-10-01');
  assert.equal(picks['deep-build'].until, '2027-09-01');
  assert.equal(picks['wide-build'].until, '2027-10-24');
  const live = resolveEngineForRoleRanked('executor', root, { now: NOW });
  assert.equal(live.engine.id, 'codex');
  const later = resolveEngineForRoleRanked('executor', root, { now: '2026-10-25T12:00:00Z' });
  assert.equal(later.engine.id, 'claude');
  assert.equal(later.engine.roster_model, 'claude-opus-5-5');
  assert.match(later.reason, /roster pick for build expired, using backup: claude/);
  // A rewrite by atris pins "oct 24" to the date it meant, so a passed date
  // stays passed instead of rolling into next year.
  assert.equal(command(root, ['assign', 'search', 'claude'], '2026-10-25T12:00:00Z').exit, 0);
  assert.match(readRoster(root), /^build: codex, backup opus 5\.5, until 2026-10-24$/m);
  assert.match(readRoster(root), /^deep build: cursor, until 2027-09-01$/m);
  assert.match(readRoster(root), /^wide build: cursor, until oct 24, 2027$/m);
  assert.equal(resolveEngineForRoleRanked('executor', root, { now: '2026-10-25T12:00:00Z' }).engine.id, 'claude');
}));

test('blank lines, other headings, notes, bullets, and comments are ignored', () => withRoom((root) => {
  writeRoster(root, [
    '# roster',
    '',
    '> a note for me: build is the big one',
    '- a bullet about something',
    '<!-- a comment',
    'build: codex',
    'still in the comment -->',
    'build: claude <!-- inline note -->',
    '',
    '## notes',
    'anything: goes here, and so does prose without a colon',
    '',
    '### jobs',
    '',
  ].join('\n'));
  const project = state(root).project;
  assert.deepEqual(project.warnings, []);
  assert.deepEqual(Object.keys(project.picks), ['executor']);
  assert.equal(project.picks.executor.engine, 'claude');
  assert.equal(project.picks.executor.line, 8);
}));

test('each kind of bad line gives one plain warning with its file and line, and the job falls back', () => withRoom((root) => {
  ready(root, 'atris-fast', 'codex', 'claude', 'haiku');
  writeRoster(root, [
    '# roster',
    'build: pizza oven',
    'review: claude gpt-9',
    'search: codex',
    'small build: codex, until someday',
    'fishing: codex',
    'builder!: haiku',
    'just words with no colon',
    'deep build: codex, sometimes',
    '',
    '## team',
    'judge: pizza',
    '',
  ].join('\n'));
  addMember(root, 'judge', 'Reviewer');
  let project;
  assert.doesNotThrow(() => { project = state(root).project; });
  assert.deepEqual(project.picks, {});
  const byLine = Object.fromEntries(project.warnings.map((warning) => [warning.line, warning.message]));
  assert.match(byLine[2], /"pizza oven" is not an engine or a model atris knows, so build uses the next pick in line/);
  assert.match(byLine[3], /claude cannot take the model "gpt-9", so review uses the next pick in line/);
  assert.match(byLine[4], /codex cannot do search work, so search uses the next pick in line/);
  assert.match(byLine[5], /"someday" is not a date/);
  assert.match(byLine[6], /say what kind of job "fishing" is/);
  assert.match(byLine[7], /too close to the built-in build job/);
  assert.match(byLine[8], /is not "job: engine"/);
  assert.match(byLine[9], /does not understand "sometimes"/);
  for (const role of ['executor', 'validator', 'navigator']) {
    assert.equal(resolveEngineForRoleRanked(role, root, { now: NOW }).source, 'router', role);
  }
  const view = command(root, ['roster']);
  assert.equal(view.exit, 0, view.err);
  assert.match(view.out, /^warning: atris\/ROSTER\.md line 4 "search: codex" codex cannot do search work, so search uses the next pick in line\.$/m);
  assert.match(view.out, /^warning: atris\/ROSTER\.md line 12 "judge: pizza" .*so judge picks automatically\.$/m);
  const json = JSON.parse(command(root, ['roster', '--json']).out);
  assert.equal(json.warnings.length, 9);
  assert.equal(json.warnings.every((warning) => warning.file === path.join('atris', 'ROSTER.md')), true);
  assert.equal(resolveEngineForMember('judge', root, { now: NOW }).source, 'auto');
}));

test('assign edits only its own line and keeps comments, order, and notes; clear removes only that line', () => withRoom((root) => {
  ready(root, 'codex', 'claude', 'haiku', 'cursor');
  const original = [
    '# roster',
    '',
    '> my picks, edited by hand',
    'search: haiku',
    '<!-- build was codex last week -->',
    'build: opus 5.5',
    'review: codex',
    '',
    '## notes',
    'keep this: exactly as written',
    '',
    '## team',
    'researcher: search',
    '',
  ].join('\n');
  writeRoster(root, original);
  assert.equal(command(root, ['assign', 'build', 'cursor']).exit, 0);
  assert.equal(readRoster(root), original.replace('build: opus 5.5', 'build: cursor'));
  assert.equal(command(root, ['assign', 'small build', 'codex', '--days', '3']).exit, 0);
  const lines = readRoster(root).split('\n');
  assert.equal(lines[lines.indexOf('review: codex') + 1], 'small build: codex, until 2026-09-27');
  assert.equal(command(root, ['assign', 'review', '--clear']).exit, 0);
  const cleared = readRoster(root);
  assert.doesNotMatch(cleared, /^review:/m);
  assert.match(cleared, /<!-- build was codex last week -->\nbuild: cursor\nsmall build: codex, until 2026-09-27\n/);
  assert.match(cleared, /## notes\nkeep this: exactly as written\n\n## team\nresearcher: search\n$/);
  assert.equal(state(root).project.picks.validator, undefined);
}));

test('a job name that only looks like a built-in job is refused, and the real build pick stays', () => withRoom((root) => {
  ready(root, 'codex', 'claude');
  assert.equal(command(root, ['assign', 'build', 'claude']).exit, 0);
  assert.equal(rosterJobKey('builder!'), '');
  assert.equal(rosterJobKey('Builder'), 'executor');
  assert.equal(rosterJobKey(' BUILD '), 'executor');
  const refused = command(root, ['assign', 'builder!', 'codex']);
  assert.equal(refused.exit, 2);
  assert.match(refused.err, /"builder!" is too close to the built-in build job/);
  const clear = command(root, ['assign', 'build!', '--clear']);
  assert.equal(clear.exit, 2);
  assert.throws(() => setRosterPick('Review!', 'claude', { now: NOW }, root), /too close to the built-in review job/);
  assert.equal(state(root).project.picks.executor.engine, 'claude');
}));

test('an expired project pick does not decide a custom job kind or hide a live all-projects pick', () => withRoom((root, machine) => {
  ready(root, 'codex', 'claude', 'haiku');
  writeRoster(root, '# roster\ndeep work (like build): codex, until 2026-09-01\n');
  writeMachine(machine, '# roster\ndeep work (like review): haiku\n');
  assert.equal(rosterJobRole('deep work', root, { now: NOW }), 'validator');
  const chosen = resolveEngineForRoleRanked('validator', root, { now: NOW, job: 'deep work' });
  assert.equal(chosen.engine.id, 'haiku');
  assert.equal(chosen.source, 'machine');
  // While the project pick is live it decides.
  assert.equal(rosterJobRole('deep work', root, { now: '2026-08-30T12:00:00Z' }), 'executor');
  const json = JSON.parse(command(root, ['roster', '--json']).out);
  const row = json.jobs.find((entry) => entry.job === 'deep work');
  assert.equal(row.role, 'validator');
  assert.equal(row.engine, 'haiku');
}));

test('a project line beats the all-projects line per job, and the view names each file', () => withRoom((root, machine) => {
  ready(root, 'codex', 'claude', 'cursor', 'haiku');
  writeMachine(machine, '# roster\nbuild: opus 5.5\nreview: codex\n');
  writeRoster(root, '# roster\nbuild: cursor\n');
  assert.equal(resolveEngineForRoleRanked('executor', root, { now: NOW }).engine.id, 'cursor');
  const review = resolveEngineForRoleRanked('validator', root, { now: NOW });
  assert.equal(review.engine.id, 'codex');
  assert.equal(review.source, 'machine');
  const view = command(root, ['roster']);
  assert.match(view.out, /build\s+cursor\s+no backup\s+no end date, this project \(atris\/ROSTER\.md\)/);
  assert.match(view.out, /review\s+codex\s+no backup\s+no end date, all projects \(.*ROSTER\.md\)/);
  const json = JSON.parse(command(root, ['roster', '--json']).out);
  assert.equal(json.files.project, path.join('atris', 'ROSTER.md'));
  assert.equal(json.files.machine.endsWith('ROSTER.md'), true);
  // The markdown override moves the all-projects file on its own.
  const other = path.join(path.dirname(machine.md), 'other', 'ROSTER.md');
  fs.mkdirSync(path.dirname(other), { recursive: true });
  fs.writeFileSync(other, '# roster\nreview: haiku\n');
  process.env.ATRIS_MACHINE_ROSTER_MD_PATH = other;
  assert.equal(resolveEngineForRoleRanked('validator', root, { now: NOW }).engine.id, 'haiku');
}));

test('with no markdown the JSON rosters keep working, and a markdown file wins over its JSON', () => withRoom((root, machine) => {
  ready(root, 'codex', 'claude', 'cursor', 'haiku');
  const registry = readEngineRegistry(root);
  registry.roster = { executor: { engine: 'claude', model: 'claude-opus-5-5', backup: '', until: '2026-10-24' } };
  fs.writeFileSync(engineRegistryFile(root), `${JSON.stringify(registry)}\n`);
  fs.mkdirSync(path.dirname(machine.json), { recursive: true });
  fs.writeFileSync(machine.json, `${JSON.stringify({ roster: { validator: { engine: 'haiku', model: '', backup: '', until: '2026-10-24' } } })}\n`);
  assert.equal(resolveEngineForRoleRanked('executor', root, { now: NOW }).engine.id, 'claude');
  assert.equal(resolveEngineForRoleRanked('validator', root, { now: NOW }).engine.id, 'haiku');
  const view = command(root, ['roster']);
  assert.match(view.out, /build\s+claude \(opus 5\.5\).*until oct 24, this project \(\.atris\/state\/engines\.json\)/);
  assert.match(view.out, /review\s+haiku.*until oct 24, all projects \(.*roster\.json\)/);
  writeRoster(root, '# roster\nbuild: cursor\n');
  assert.equal(resolveEngineForRoleRanked('executor', root, { now: NOW }).engine.id, 'cursor');
  writeRoster(root, '# roster\n');
  assert.equal(resolveEngineForRoleRanked('executor', root, { now: NOW }).source, 'router');
}));

test('the first assign writes ROSTER.md with the JSON picks carried over and leaves the JSON untouched', () => withRoom((root, machine) => {
  ready(root, 'codex', 'claude', 'cursor', 'haiku');
  const registry = readEngineRegistry(root);
  registry.roster = {
    executor: { engine: 'claude', model: 'claude-opus-5-5', backup: 'codex', until: '2026-10-24', set_at: NOW.toISOString() },
    'quick-fixes': { engine: 'cursor', model: '', backup: '', until: '2026-10-20', like: 'build' },
  };
  fs.writeFileSync(engineRegistryFile(root), `${JSON.stringify(registry)}\n`);
  const jsonBefore = fs.readFileSync(engineRegistryFile(root), 'utf8');
  fs.mkdirSync(path.dirname(machine.json), { recursive: true });
  const machineJson = `${JSON.stringify({ roster: { validator: { engine: 'haiku', model: '', backup: '', until: '2026-10-22' } } })}\n`;
  fs.writeFileSync(machine.json, machineJson);

  assert.equal(command(root, ['assign', 'search', 'haiku']).exit, 0);
  assert.equal(readRoster(root).split('\n').filter((line) => /^[a-z ]+(\(like [a-z]+\))?:/.test(line)).join('\n'), [
    'build: opus 5.5, backup codex, until 2026-10-24',
    'quick fixes (like build): cursor, until 2026-10-20',
    'search: haiku',
  ].join('\n'));
  assert.equal(fs.readFileSync(engineRegistryFile(root), 'utf8'), jsonBefore);
  assert.equal(resolveEngineForRoleRanked('executor', root, { now: NOW }).engine.id, 'claude');

  assert.equal(command(root, ['assign', 'build', 'cursor', '--everywhere']).exit, 0);
  assert.match(fs.readFileSync(machine.md, 'utf8'), /^review: haiku, until 2026-10-22\nbuild: cursor$/m);
  assert.equal(fs.readFileSync(machine.json, 'utf8'), machineJson);
}));

test('roster confirm renews only lines that carry an until date', () => withRoom((root) => {
  ready(root, 'codex', 'claude');
  writeRoster(root, '# roster\n> keep me\nbuild: codex, until 2026-09-25\nreview: claude\n');
  assert.equal(command(root, ['roster', 'confirm'], '2026-09-27T12:00:00Z').exit, 0);
  assert.equal(readRoster(root), '# roster\n> keep me\nbuild: codex, until 2026-10-27\nreview: claude\n');
}));

test('team members pick a job from their name or role, and anything else builds', () => {
  assert.equal(autoJobForMember('navigator', 'System Navigator'), 'search');
  assert.equal(autoJobForMember('researcher', 'Deep Researcher'), 'search');
  assert.equal(autoJobForMember('signal-scout', ''), 'search');
  assert.equal(autoJobForMember('validator', 'Reviewer'), 'review');
  assert.equal(autoJobForMember('alpha-judge', ''), 'review');
  assert.equal(autoJobForMember('executor', 'Builder'), 'build');
  assert.equal(autoJobForMember('helper', 'Deep Researcher'), 'search');
  assert.equal(autoJobForMember('closer', 'Closer'), 'build');
  assert.equal(autoJobForMember('mystery', ''), 'build');
});

test('each member resolves to its job pick automatically, and the view shows the team', () => withRoom((root) => {
  ready(root, 'atris-fast', 'codex', 'claude', 'devin', 'grok', 'haiku');
  writeRoster(root, EXAMPLE.replace('search: haiku', 'search: claude haiku'));
  addMember(root, 'navigator', 'System Navigator');
  addMember(root, 'validator', 'Reviewer');
  addMember(root, 'executor', 'Builder');
  addMember(root, 'researcher', 'Deep Researcher');
  addMember(root, 'closer', 'Closer');
  addMember(root, 'judge', 'Architect');
  const pick = (name) => resolveEngineForMember(name, root, { now: NOW });
  assert.equal(pick('navigator').reason, 'navigator does search: claude haiku');
  assert.equal(pick('navigator').source, 'auto');
  assert.equal(pick('validator').engine.id, 'codex');
  assert.equal(pick('executor').reason, 'executor does build: claude opus 5.5');
  assert.equal(pick('closer').engine.id, 'claude');
  assert.equal(pick('researcher').reason, 'researcher does search: claude haiku');
  assert.equal(pick('researcher').source, 'file');
  const view = command(root, ['roster']);
  assert.match(view.out, /^team$/m);
  assert.match(view.out, /^navigator\s+search\s+claude \(haiku\)\s+automatic$/m);
  assert.match(view.out, /^researcher\s+search\s+claude \(haiku\)\s+from atris\/ROSTER\.md$/m);
  assert.match(view.out, /^judge\s+review\s+claude \(opus 5\.5\)\s+from atris\/ROSTER\.md$/m);
  const json = JSON.parse(command(root, ['roster', '--json']).out);
  assert.deepEqual(json.team.find((row) => row.member === 'closer'), {
    member: 'closer', job: 'build', engine: 'claude', model: 'claude-opus-5-5', source: 'auto', file: null, reason: 'closer does build: claude opus 5.5',
  });
}));

test('a team line can name a job, a custom job, or engine and model words', () => withRoom((root, machine) => {
  ready(root, 'atris-fast', 'codex', 'claude', 'devin', 'grok', 'haiku');
  writeRoster(root, [
    '# roster',
    'build: codex',
    'small build: devin swe-2-max',
    '',
    '## team',
    'researcher: build',
    'fixer: small build',
    'judge: opus 5.5',
    'scout: deep review',
    '',
  ].join('\n'));
  writeMachine(machine, '# roster\n\n## team\ncloser: haiku\nfixer: codex\n');
  addMember(root, 'researcher', 'Deep Researcher');
  addMember(root, 'fixer', 'Builder');
  addMember(root, 'judge', 'Reviewer');
  addMember(root, 'scout', 'Signal Scout');
  addMember(root, 'closer', 'Reviewer');
  const pick = (name) => resolveEngineForMember(name, root, { now: NOW });
  assert.equal(pick('researcher').reason, 'researcher does build: codex');
  assert.equal(pick('fixer').reason, 'fixer does small build: devin swe-2-max');
  assert.equal(pick('judge').reason, 'judge does review: claude opus 5.5');
  assert.equal(pick('judge').pick_source, 'team');
  // A custom job with no pick falls back to its kind, then the router.
  assert.equal(pick('scout').job, 'deep review');
  assert.equal(pick('scout').role, 'validator');
  // The all-projects team line applies where this project has none.
  assert.equal(pick('closer').engine.id, 'haiku');
  assert.equal(pick('closer').file.endsWith('ROSTER.md'), true);
}));

test('member run and a mission with an owner run on the member pick; an explicit engine still wins', () => withRoom((root) => {
  ready(root, 'atris-fast', 'codex', 'claude', 'haiku');
  writeRoster(root, '# roster\nsearch: claude haiku\nbuild: codex\n');
  addMember(root, 'researcher', 'Deep Researcher');
  const runnerOf = (args) => args[args.indexOf('--runner') + 1];
  assert.equal(runnerOf(buildMemberRunStartArgs('researcher', 'find the gap', [], root)), 'auto');
  assert.equal(runnerOf(buildMemberRunStartArgs('researcher', 'find the gap', ['--engine', 'codex'], root)), 'claude');
  assert.equal(runnerOf(buildMemberRunStartArgs('researcher', 'find the gap', ['--runner', 'codex'], root)), 'codex');
  assert.equal(runnerOf(buildMemberRunStartArgs('stranger', 'find the gap', [], root)), 'claude');

  const tick = resolveMissionTickRunner({ runner: 'auto', owner: 'researcher' }, root, { now: NOW });
  assert.equal(tick.mission.runner, 'claude');
  assert.equal(tick.mission.model, 'haiku');
  assert.equal(tick.member_engine_reason, 'researcher does search: claude haiku');
  const kept = resolveMissionTickRunner({ runner: 'auto', owner: 'researcher', model: 'sonnet' }, root, { now: NOW });
  assert.equal(kept.mission.model, 'sonnet');
  const preferred = resolveMissionTickRunner({ runner: 'auto', owner: 'researcher', preferred_engine: 'codex' }, root, { now: NOW });
  assert.equal(preferred.mission.runner, 'codex');
  assert.equal(preferred.requested_engine, 'codex');
  const pinned = resolveMissionTickRunner({ runner: 'codex', owner: 'researcher' }, root, { now: NOW });
  assert.equal(pinned.mission.runner, 'codex');
  const noOwner = resolveMissionTickRunner({ runner: 'auto' }, root, { now: NOW });
  assert.equal(noOwner.mission.runner, 'codex');
}));

test('autopilot plan, do, and review run on their member picks; a runner in the environment still wins', () => withRoom((root) => {
  ready(root, 'atris-fast', 'codex', 'claude', 'haiku');
  const prompt = path.join(root, 'prompt.md');
  writeRoster(root, '# roster\nreview: codex\n\n## team\nnavigator: haiku\n');
  assert.match(buildPhaseRunnerCommand('review', prompt, root), /^codex exec /);
  assert.match(buildPhaseRunnerCommand('plan', prompt, root), /^claude -p .*--model claude-haiku-4-5 /);
  assert.equal(buildPhaseRunnerCommand('do', prompt, root), buildRunnerCommand({ promptFile: prompt, allowedTools: 'Bash,Read,Write,Edit,Glob,Grep' }));
  process.env.ATRIS_RUNNER_PROFILE = 'claude';
  assert.match(buildPhaseRunnerCommand('review', prompt, root), /^claude -p /);
  delete process.env.ATRIS_RUNNER_PROFILE;
  assert.equal(process.env.ATRIS_RUNNER_PROFILE, undefined);
}));

test('with no roster anywhere, member runs, owned missions, and autopilot route exactly as before', () => withRoom((root) => {
  ready(root, 'atris-fast', 'codex', 'claude', 'haiku');
  addMember(root, 'researcher', 'Deep Researcher');
  addMember(root, 'validator', 'Reviewer');
  const runnerOf = (args) => args[args.indexOf('--runner') + 1];
  assert.equal(runnerOf(buildMemberRunStartArgs('researcher', 'find the gap', [], root)), 'claude');
  const owned = resolveMissionTickRunner({ runner: 'auto', owner: 'researcher' }, root, { now: NOW });
  const plain = resolveMissionTickRunner({ runner: 'auto' }, root, { now: NOW });
  assert.deepEqual({ ...owned.mission, owner: undefined }, { ...plain.mission, owner: undefined });
  assert.equal(owned.member_engine_reason, undefined);
  const prompt = path.join(root, 'prompt.md');
  const base = buildRunnerCommand({ promptFile: prompt, allowedTools: 'Bash,Read,Write,Edit,Glob,Grep' });
  for (const phase of ['plan', 'do', 'review']) assert.equal(buildPhaseRunnerCommand(phase, prompt, root), base, phase);
  assert.equal(fs.existsSync(path.join(root, 'atris', 'ROSTER.md')), false);
  const view = command(root, ['roster']);
  assert.match(view.out, /^researcher\s+search\s+atris-fast\s+automatic$/m);
}));
