'use strict';

// The sectioned ROSTER.md: each "## job" lists its workers in order by tool
// and model, the first ready one leads, and a session file can change a job
// for one shell only. Every room is a scratch project with a scratch home,
// so the real ~/.atris and ~/.codex are never read or written.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { engineCommand } = require('../commands/engine');
const {
  readEngineRegistry,
  readRosterState,
  resolveEngineForRoleRanked,
  resolveJobTeam,
  setEngineHealth,
  setRosterPick,
} = require('../lib/engine-registry');
const { resolveEngineForMember } = require('../lib/member-engine');

const NOW = new Date('2026-09-24T12:00:00.000Z');
const ENV_KEYS = [
  'ATRIS_MACHINE_ROSTER_PATH', 'ATRIS_MACHINE_ROSTER_MD_PATH', 'ATRIS_ROUTER_EXPLAIN', 'ATRIS_ROSTER_SESSION',
  'ATRIS_ROSTER_SESSIONS_DIR', 'ATRIS_CODEX_MODELS_CACHE_PATH', 'ATRIS_CODEX_CONFIG_PATH',
  'ATRIS_RUNNER_PROFILE', 'ATRIS_RUNNER_MODEL', 'ATRIS_RUNNER_BIN', 'ATRIS_RUNNER_COMMAND_TEMPLATE',
  'ATRIS_CLAUDE_MODEL', 'ATRIS_CLAUDE_BIN', 'ATRIS_CLAUDE_COMMAND_TEMPLATE',
];

const EXAMPLE = `# roster

## build
- claude code, model: opus 5.5

## review
- codex, model: gpt-6-astra, effort: medium
- claude code, model: opus 5.5

## search
- claude code, model: haiku 4.5
- devin, model: swe-1.7-lightning
- atris fast

## small build
- devin, model: swe-2-max, until 2026-10-24
- grok, model: grok 4.7 fast, max: 20 min

## team
- researcher: claude code, model: opus 5.5
`;

const OLD_EXAMPLE = `# roster

build: opus 5.5
small build: devin swe-2-max, backup grok, max 20 min, until 2026-10-24
review: codex gpt-6-astra medium, backup opus 5.5
search: haiku

## team
researcher: search
`;

function withRoom(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-roster-sections-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-roster-sections-home-'));
  fs.mkdirSync(path.join(root, 'atris'));
  const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.ATRIS_MACHINE_ROSTER_PATH = path.join(home, '.atris', 'roster.json');
  process.env.ATRIS_ROUTER_EXPLAIN = '0';
  const paths = {
    home,
    machine: path.join(home, '.atris', 'ROSTER.md'),
    sessions: path.join(home, '.atris', 'sessions'),
  };
  try { return fn(root, paths); } finally {
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

function readRoster(root) {
  return fs.readFileSync(path.join(root, 'atris', 'ROSTER.md'), 'utf8');
}

// A session file name: a readable part of the key plus a hash of the key.
function sessionName(readable, key) {
  return `roster-${readable}-${crypto.createHash('sha256').update(key).digest('hex').slice(0, 12)}.md`;
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function addMember(root, name, role) {
  write(path.join(root, 'atris', 'team', name, 'MEMBER.md'), `---\nname: ${name}\nrole: ${role}\ndescription: test member\n---\n\n# ${name}\n`);
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

function project(root, now = NOW) {
  return readRosterState(root, { now }).project;
}

// A worker without where it was written, for comparing meaning.
function bare(worker) {
  const { line, text, ...rest } = worker;
  return rest;
}

function resolveAll(root, now = NOW) {
  const pick = (role, options = {}) => {
    const resolved = resolveEngineForRoleRanked(role, root, { now, ...options });
    return [resolved.engine && resolved.engine.id, resolved.engine && (resolved.engine.roster_model || ''), resolved.engine && (resolved.engine.roster_effort || ''), resolved.engine && (resolved.engine.roster_max_seconds || 0), resolved.source];
  };
  return {
    build: pick('executor'),
    small: pick('executor', { job: 'small build' }),
    review: pick('validator'),
    search: pick('navigator'),
  };
}

// --- reading the sectioned shape ---------------------------------------------

test('the example roster parses exactly: every worker names its tool and model, in order', () => withRoom((root) => {
  writeRoster(root, EXAMPLE);
  const layer = project(root);
  assert.equal(layer.format, 'markdown');
  assert.deepEqual(layer.warnings, []);
  assert.deepEqual(Object.keys(layer.picks), ['executor', 'validator', 'navigator', 'small-build']);
  assert.deepEqual(layer.picks.executor.workers.map(bare), [
    { engine: 'claude', model: 'claude-opus-5-5', until: '', never_expires: true },
  ]);
  assert.deepEqual(layer.picks.validator.workers.map(bare), [
    { engine: 'codex', model: 'gpt-6-astra', effort: 'medium', until: '', never_expires: true },
    { engine: 'claude', model: 'claude-opus-5-5', until: '', never_expires: true },
  ]);
  assert.deepEqual(layer.picks.navigator.workers.map(bare), [
    { engine: 'claude', model: 'claude-haiku-4-5-20251001', until: '', never_expires: true },
    { engine: 'devin', model: 'swe-1.7-lightning', until: '', never_expires: true },
    { engine: 'atris-fast', model: '', until: '', never_expires: true },
  ]);
  assert.deepEqual(layer.picks['small-build'].workers.map(bare), [
    { engine: 'devin', model: 'swe-2-max', until: '2026-10-24' },
    { engine: 'grok', model: 'grok-4.7-build-fast', max_seconds: 1200, until: '', never_expires: true },
  ]);
  assert.equal(layer.picks['small-build'].like, 'build');
  assert.deepEqual(layer.picks.navigator.workers.map((worker) => worker.line), [11, 12, 13]);
  assert.deepEqual(layer.team.map(({ member, value }) => ({ member, value })), [{ member: 'researcher', value: 'claude code, model: opus 5.5' }]);
  // The team line names a tool and model directly.
  ready(root, 'claude');
  addMember(root, 'researcher', 'Deep Researcher');
  const researcher = resolveEngineForMember('researcher', root, { now: NOW });
  assert.equal(researcher.engine.id, 'claude');
  assert.equal(researcher.model, 'claude-opus-5-5');
}));

test('friendly tool names read as their engines, in lines and in assign', () => withRoom((root) => {
  ready(root, 'claude', 'atris-fast', 'agy', 'codex');
  writeRoster(root, [
    '# roster',
    '## build',
    '- ccs, model: sonnet 5',
    '- gemini, model: gemini-3.8-flash-high',
    '- antigravity',
    '- claude code opus 5.5',
    '## search',
    '- atris fast',
    '',
  ].join('\n'));
  const layer = project(root);
  assert.deepEqual(layer.warnings, []);
  assert.deepEqual(layer.picks.executor.workers.map((worker) => [worker.engine, worker.model]), [
    ['claude', 'claude-sonnet-5'],
    ['agy', 'gemini-3.8-flash-high'],
    ['agy', ''],
    ['claude', 'claude-opus-5-5'],
  ]);
  assert.equal(layer.picks.navigator.engine, 'atris-fast');
  // A tool of several words works unquoted on the command line.
  const assigned = command(root, ['assign', 'review', 'claude', 'code', '--model', 'haiku 4.5']);
  assert.equal(assigned.exit, 0, assigned.err);
  assert.match(readRoster(root), /^## review\n- claude code, model: haiku 4\.5$/m);
  assert.equal(project(root).picks.validator.model, 'claude-haiku-4-5-20251001');
}));

test('the one-line shape still parses exactly as before, with no worker list', () => withRoom((root) => {
  writeRoster(root, OLD_EXAMPLE);
  const layer = project(root);
  assert.deepEqual(layer.warnings, []);
  const { file, line, ...build } = layer.picks.executor;
  assert.deepEqual(build, { engine: 'claude', model: 'claude-opus-5-5', backup: '', until: '', never_expires: true });
  const { file: f2, line: l2, ...small } = layer.picks['small-build'];
  assert.deepEqual(small, { engine: 'devin', model: 'swe-2-max', backup: 'grok', max_seconds: 1200, until: '2026-10-24', like: 'build' });
  assert.equal(layer.picks.validator.workers, undefined);
  assert.deepEqual(layer.team.map((entry) => entry.value), ['search']);
}));

test('the first assign turns the one-line shape into sections with the same meaning and keeps notes', () => withRoom((root) => {
  ready(root, 'codex', 'claude', 'haiku', 'devin', 'grok', 'atris-fast');
  const original = [
    '# roster',
    '',
    '> my own note',
    '<!-- builds moved to opus in june -->',
    'build: opus 5.5',
    'small build: devin swe-2-max, backup grok, max 20 min, until 2026-10-24 <!-- trial -->',
    'review: codex gpt-6-astra medium, backup opus 5.5',
    'search: haiku',
    'review: claude',
    'fishing: codex',
    '',
    '## notes',
    'keep: this line',
    '',
    '## team',
    'researcher: search',
    '',
  ].join('\n');
  writeRoster(root, original);
  const before = resolveAll(root);
  const warningsBefore = project(root).warnings.map((warning) => warning.message);
  // Clearing a job nobody set still converts the file.
  assert.equal(command(root, ['assign', 'deep review', '--clear']).exit, 0);
  assert.equal(readRoster(root), [
    '# roster',
    '',
    '> my own note',
    '<!-- builds moved to opus in june -->',
    '<!-- never used, review was set on another line: review: claude -->',
    'fishing: codex',
    '',
    '## build',
    '- claude code, model: opus 5.5',
    '',
    '## small build <!-- trial -->',
    '- devin, model: swe-2-max, max: 20 min, until 2026-10-24',
    '- grok, max: 20 min',
    '',
    '## review',
    '- codex, model: gpt-6-astra, effort: medium',
    '- claude code, model: opus 5.5',
    '',
    '## search',
    '- haiku',
    '',
    '## notes',
    'keep: this line',
    '',
    '## team',
    '- researcher: search',
    '',
  ].join('\n'));
  assert.deepEqual(resolveAll(root), before);
  // An expired lead still hands off to the second worker, as the backup did.
  assert.deepEqual(resolveAll(root, new Date('2026-10-25T12:00:00Z')).small.slice(0, 2), ['grok', '']);
  // The line that could not be used still warns; the duplicate never counted.
  const warningsAfter = project(root).warnings.map((warning) => warning.message);
  assert.deepEqual(warningsAfter, warningsBefore.filter((message) => !/a second time/.test(message)));
  assert.equal(resolveEngineForMember('researcher', root, { now: NOW }).job, 'search');
}));

// --- teams --------------------------------------------------------------------

test('the lead falls to the next worker when it is down, expired, or a bad line', () => withRoom((root) => {
  ready(root, 'codex', 'claude', 'cursor', 'devin');
  writeRoster(root, [
    '# roster',
    '## build',
    '- claude code, model: opus 5.5',
    '- codex, until 2026-09-01',
    '- cursor, model: nonsense words, effort: loud',
    '- devin, model: swe-2-max',
    '',
  ].join('\n'));
  const layer = project(root);
  assert.equal(layer.warnings.length, 1);
  assert.match(layer.warnings[0].message, /build skips this worker$/);
  assert.equal(layer.warnings[0].line, 5);
  const lead = resolveEngineForRoleRanked('executor', root, { now: NOW });
  assert.equal(lead.engine.id, 'claude');
  assert.deepEqual(lead.team.map((engine) => engine.id), ['claude', 'devin']);
  assert.deepEqual(lead.ranked.slice(0, 2).map((engine) => engine.id), ['claude', 'devin']);
  setEngineHealth('claude', 'credit_out', root);
  const fallen = resolveEngineForRoleRanked('executor', root, { now: NOW });
  assert.equal(fallen.engine.id, 'devin');
  assert.equal(fallen.engine.roster_model, 'swe-2-max');
  assert.equal(fallen.reason, 'roster pick for build is not ready, using backup: devin');
  assert.equal(fallen.source, 'project');
  setEngineHealth('devin', 'credit_out', root);
  assert.equal(resolveEngineForRoleRanked('executor', root, { now: NOW }).source, 'router');
}));

test('the view shows every worker in order with who leads and why others are skipped, in text and json', () => withRoom((root) => {
  ready(root, 'atris-fast', 'codex', 'claude', 'devin');
  setEngineHealth('claude', 'credit_out', root);
  writeRoster(root, [
    '# roster',
    '## search',
    '- claude code, model: haiku 4.5',
    '- atris fast, until 2026-09-01',
    '- devin, model: swe-1.7-lightning',
    '- pizza oven',
    '',
  ].join('\n'));
  const view = command(root, ['roster']);
  assert.equal(view.exit, 0, view.err);
  assert.match(view.out, /^search\s+claude \(haiku 4\.5\)\s+backup atris-fast .*not ready, using devin \(swe-1\.7-lightning\), this project/m);
  assert.match(view.out, /^ {2}1\. claude \(haiku 4\.5\)\s+skipped, down$/m);
  assert.match(view.out, /^ {2}2\. atris-fast \(atris:fast, atris default\)\s+skipped, expired, until 2026-09-01$/m);
  assert.match(view.out, /^ {2}3\. devin \(swe-1\.7-lightning\)\s+leads now$/m);
  assert.match(view.out, /^ {2}4\. - pizza oven\s+skipped, bad line: "pizza oven" is not an engine or a model atris knows$/m);
  assert.match(view.out, /^see which tools and models this machine has: atris engine roster --available$/m);
  const row = JSON.parse(command(root, ['roster', '--json']).out).jobs.find((entry) => entry.job === 'search');
  assert.deepEqual(row.workers.map((worker) => [worker.engine, worker.status, worker.why]), [
    ['claude', 'skipped', 'down'],
    ['atris-fast', 'skipped', 'expired'],
    ['devin', 'leads', ''],
    [null, 'skipped', 'bad line: "pizza oven" is not an engine or a model atris knows'],
  ]);
  assert.equal(row.engine, 'devin');
  assert.equal(row.lead, 'later');
  const team = resolveJobTeam('search', root, { now: NOW });
  assert.deepEqual(team.team.map((engine) => engine.id), ['devin']);
  assert.equal(team.lead.roster_model, 'swe-1.7-lightning');
}));

test('assign sets the lead and keeps the rest; --add, --remove, --backup, and --clear edit the list', () => withRoom((root) => {
  ready(root, 'codex', 'claude', 'devin', 'atris-fast', 'haiku');
  writeRoster(root, EXAMPLE);
  assert.equal(command(root, ['assign', 'search', 'haiku']).exit, 0);
  assert.match(readRoster(root), /^## search\n- haiku\n- devin, model: swe-1\.7-lightning\n- atris fast\n\n## small build/m);
  assert.equal(command(root, ['assign', 'search', 'claude', '--model', 'haiku 4.5', '--add']).exit, 0);
  assert.match(readRoster(root), /^- atris fast\n- claude code, model: haiku 4\.5\n\n## small build/m);
  assert.deepEqual(resolveJobTeam('search', root, { now: NOW }).team.map((engine) => engine.id), ['haiku', 'devin', 'atris-fast', 'claude']);
  const removed = command(root, ['assign', 'search', '--remove', 'devin']);
  assert.equal(removed.exit, 0, removed.err);
  assert.match(readRoster(root), /^## search\n- haiku\n- atris fast\n- claude code, model: haiku 4\.5\n/m);
  assert.match(command(root, ['assign', 'search', '--remove', 'grok']).err, /^search has no grok worker to remove$/);
  // --backup replaces the second worker, the way it replaced a one-line backup.
  assert.equal(command(root, ['assign', 'search', 'haiku', '--add']).exit, 0);
  assert.equal(command(root, ['assign', 'search', 'atris', 'fast', '--backup', 'claude haiku']).exit, 0);
  assert.match(readRoster(root), /^## search\n- atris fast\n- claude code, model: haiku\n- haiku\n\n/m);
  // Setting the lead to a worker already further down does not repeat it.
  assert.equal(command(root, ['assign', 'review', 'claude', '--model', 'opus 5.5', '--effort', 'high', '--max', '30 min', '--days', '3']).exit, 0);
  assert.match(readRoster(root), /^## review\n- claude code, model: opus 5\.5, effort: high, max: 30 min, until 2026-09-27\n\n/m);
  assert.equal(command(root, ['assign', 'review', 'codex', '--model', 'gpt-6-astra']).exit, 0);
  assert.equal(command(root, ['assign', 'review', 'claude', '--model', 'opus 5.5', '--add']).exit, 0);
  assert.match(readRoster(root), /^## review\n- codex, model: gpt-6-astra\n- claude code, model: opus 5\.5\n\n/m);
  // Removing the last worker removes the job.
  assert.equal(command(root, ['assign', 'build', '--remove', 'claude code']).exit, 0);
  assert.doesNotMatch(readRoster(root), /^## build/m);
  assert.equal(command(root, ['assign', 'small build', '--clear']).exit, 0);
  assert.doesNotMatch(readRoster(root), /^## small build/m);
  assert.match(readRoster(root), /\n## team\n- researcher: claude code, model: opus 5\.5\n$/);
  assert.equal(command(root, ['assign', 'search', 'codex', '--add']).exit, 2);
  assert.equal(command(root, ['assign', 'search', 'haiku', '--add', '--backup', 'claude']).exit, 2);
  assert.equal(command(root, ['assign', 'search', '--remove', 'haiku', '--model', 'x']).exit, 2);
  assert.deepEqual(project(root).warnings, []);
}));

test('a new custom job gets its own section before the team, with its kind in the heading when the name does not say it', () => withRoom((root) => {
  ready(root, 'codex', 'claude');
  writeRoster(root, EXAMPLE);
  assert.equal(command(root, ['assign', 'quick fixes', 'codex', '--like', 'build']).exit, 0);
  assert.match(readRoster(root), /\n## quick fixes \(like build\)\n- codex\n\n## team\n/);
  assert.equal(project(root).picks['quick-fixes'].like, 'build');
  assert.equal(command(root, ['assign', 'quick fixes', 'claude', '--add']).exit, 0);
  assert.match(readRoster(root), /\n## quick fixes \(like build\)\n- codex\n- claude code\n\n## team\n/);
}));

// --- sessions -----------------------------------------------------------------

test('a session change beats this project and all projects for that job only', () => withRoom((root, paths) => {
  ready(root, 'codex', 'claude', 'cursor', 'haiku', 'atris-fast');
  writeRoster(root, EXAMPLE);
  write(paths.machine, '# roster\n\n## review\n- cursor\n\n## deep search (like search)\n- haiku\n');
  process.env.ATRIS_ROSTER_SESSION = 'agent one';
  const assigned = command(root, ['assign', 'build', 'codex', '--model', 'gpt-6-sol', '--session']);
  assert.equal(assigned.exit, 0, assigned.err);
  const file = path.join(paths.sessions, sessionName('agent-one', 'agent one'));
  assert.match(fs.readFileSync(file, 'utf8'), /^## build\n- codex, model: gpt-6-sol$/m);
  // The shared roster did not change.
  assert.equal(readRoster(root), EXAMPLE);
  const build = resolveEngineForRoleRanked('executor', root, { now: NOW });
  assert.deepEqual([build.engine.id, build.engine.roster_model, build.source], ['codex', 'gpt-6-sol', 'session']);
  assert.equal(build.reason, 'roster pick for build (this session): codex');
  assert.equal(resolveEngineForRoleRanked('validator', root, { now: NOW }).engine.id, 'codex');
  assert.equal(resolveEngineForRoleRanked('validator', root, { now: NOW }).source, 'project');
  assert.equal(resolveEngineForRoleRanked('navigator', root, { now: NOW, job: 'deep search' }).source, 'machine');
  assert.match(assigned.out, /^build\s+codex \(gpt-6-sol\)\s+no backup\s+no end date, this session \(/m);
  assert.match(assigned.out, /^review\s+codex \(gpt-6-astra, medium\).*this project/m);
  // A session list replaces the job's whole list, not just its lead.
  assert.deepEqual(resolveJobTeam('build', root, { now: NOW }).team.map((engine) => engine.id), ['codex']);
  // When nothing in the session list can run, the project decides again.
  setEngineHealth('codex', 'credit_out', root);
  assert.equal(resolveEngineForRoleRanked('executor', root, { now: NOW }).source, 'project');
  setEngineHealth('codex', 'ready', root);

  const shown = command(root, ['roster', 'session']);
  assert.equal(shown.exit, 0, shown.err);
  assert.match(shown.out, /^this session \(agent one\) changes, from /m);
  assert.match(shown.out, /^build\s+codex \(gpt-6-sol\)/m);
  assert.doesNotMatch(shown.out, /^review/m);
  assert.deepEqual(JSON.parse(command(root, ['roster', 'session', '--json']).out).jobs.map((row) => row.job), ['build']);
  const cleared = command(root, ['roster', 'session', 'clear']);
  assert.equal(cleared.exit, 0, cleared.err);
  assert.equal(fs.existsSync(file), false);
  assert.equal(resolveEngineForRoleRanked('executor', root, { now: NOW }).engine.id, 'claude');
  assert.match(command(root, ['roster', 'session']).out, /has no roster changes/);
}));

test('ATRIS_ROSTER_SESSION keys the session file, so two agent shells keep their own changes', () => withRoom((root, paths) => {
  ready(root, 'codex', 'claude', 'cursor');
  process.env.ATRIS_ROSTER_SESSION = 'shell-a';
  setRosterPick('build', 'codex', { session: true, now: NOW }, root);
  process.env.ATRIS_ROSTER_SESSION = 'shell/b';
  setRosterPick('build', 'cursor', { session: true, now: NOW }, root);
  assert.deepEqual(fs.readdirSync(paths.sessions).sort(), [sessionName('shell-a', 'shell-a'), sessionName('shell-b', 'shell/b')]);
  assert.equal(resolveEngineForRoleRanked('executor', root, { now: NOW }).engine.id, 'cursor');
  process.env.ATRIS_ROSTER_SESSION = 'shell-a';
  assert.equal(resolveEngineForRoleRanked('executor', root, { now: NOW }).engine.id, 'codex');
  delete process.env.ATRIS_ROSTER_SESSION;
  assert.notEqual(resolveEngineForRoleRanked('executor', root, { now: NOW }).source, 'session');
  // A session team line wins over the project's for that member.
  addMember(root, 'judge', 'Architect');
  writeRoster(root, '# roster\n\n## team\n- judge: codex\n');
  process.env.ATRIS_ROSTER_SESSION = 'shell-a';
  write(path.join(paths.sessions, sessionName('shell-a', 'shell-a')), '# roster\n\n## team\n- judge: claude code, model: opus 5.5\n');
  const judge = resolveEngineForMember('judge', root, { now: NOW });
  assert.deepEqual([judge.engine.id, judge.model], ['claude', 'claude-opus-5-5']);
}));

test('a session file nobody read for a day is ignored and removed on the next read', () => withRoom((root, paths) => {
  ready(root, 'codex', 'claude');
  process.env.ATRIS_ROSTER_SESSION = 'old';
  const file = path.join(paths.sessions, sessionName('old', 'old'));
  write(file, '# roster\n\n## build\n- codex\n');
  const fresh = new Date(Date.now() - 23 * 3600 * 1000);
  fs.utimesSync(file, fresh, fresh);
  assert.equal(resolveEngineForRoleRanked('executor', root, { now: NOW }).source, 'session');
  // Reading it marked it used just now.
  assert.ok(Date.now() - fs.statSync(file).mtimeMs < 60 * 1000);
  const stale = new Date(Date.now() - 25 * 3600 * 1000);
  fs.utimesSync(file, stale, stale);
  assert.equal(resolveEngineForRoleRanked('executor', root, { now: NOW }).source, 'router');
  assert.equal(fs.existsSync(file), false);
  // Writing a session sweeps other stale session files too.
  const other = path.join(paths.sessions, 'roster-gone.md');
  write(other, '# roster\n\n## build\n- codex\n');
  fs.utimesSync(other, stale, stale);
  setRosterPick('build', 'claude', { session: true, now: NOW }, root);
  assert.equal(fs.existsSync(other), false);
  assert.equal(fs.existsSync(file), true);
}));

test('--session with no session key fails with one plain line naming ATRIS_ROSTER_SESSION', () => withRoom((root, paths) => {
  ready(root, 'codex');
  const refused = command(root, ['assign', 'build', 'codex', '--session']);
  assert.equal(refused.exit, 2);
  assert.equal(refused.err, 'this shell has no session to attach changes to; set ATRIS_ROSTER_SESSION=<name> and run it again');
  assert.equal(fs.existsSync(paths.sessions), false);
  assert.equal(fs.existsSync(path.join(root, 'atris', 'ROSTER.md')), false);
  assert.equal(command(root, ['roster', 'session', 'clear']).exit, 2);
  process.env.ATRIS_ROSTER_SESSION = 'x';
  assert.match(command(root, ['assign', 'build', 'codex', '--session', '--everywhere']).err, /pick one: --session or --everywhere/);
}));

// --- this machine ---------------------------------------------------------------

test('--available lists installed tools and their models from local files only', () => withRoom((root, paths) => {
  ready(root, 'codex', 'claude', 'grok');
  const cache = path.join(paths.home, '.codex', 'models_cache.json');
  write(cache, JSON.stringify({ fetched_at: '2026-09-20', models: [{ slug: 'gpt-6-astra', display_name: 'astra' }, { slug: 'gpt-6-sol' }, { slug: 'gpt-6-luna' }, { slug: 'gpt-6-sol' }] }));
  process.env.ATRIS_CODEX_MODELS_CACHE_PATH = cache;
  const view = command(root, ['roster', '--available']);
  assert.equal(view.exit, 0, view.err);
  assert.match(view.out, /^on this machine$/m);
  assert.match(view.out, /^codex\s+gpt-6-astra, gpt-6-sol, gpt-6-luna\s+\(from .*models_cache\.json\)$/m);
  assert.match(view.out, /^claude code\s+opus 5\.5, opus 5, sonnet 5, haiku 4\.5, fable 5\.1\s+\(known names\)$/m);
  assert.match(view.out, /^grok\s+grok 4\.7 fast, grok 4\.7\s+\(known names\)$/m);
  const json = JSON.parse(command(root, ['roster', '--available', '--json']).out).tools;
  assert.deepEqual(json.find((row) => row.engine === 'codex').models, ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna']);
  // No cache: codex falls back to its known names.
  process.env.ATRIS_CODEX_MODELS_CACHE_PATH = path.join(paths.home, 'missing.json');
  assert.match(command(root, ['roster', '--available']).out, /^codex\s+codex\s+\(known names\)$/m);
  assert.equal(command(root, ['roster', 'confirm', '--available']).exit, 2);
}));

// --- nothing set ------------------------------------------------------------------

test('with no roster anywhere and no session file, routing is unchanged', () => withRoom((root, paths) => {
  ready(root, 'atris-fast', 'codex', 'claude', 'cursor', 'devin', 'haiku');
  const route = () => ['executor', 'validator', 'navigator'].map((role) => {
    const resolved = resolveEngineForRoleRanked(role, root, { now: NOW });
    return [resolved.source, resolved.engine && resolved.engine.id, resolved.ranked.map((engine) => engine.id).join(',')];
  });
  const plain = route();
  process.env.ATRIS_ROSTER_SESSION = 'nobody';
  assert.deepEqual(route(), plain);
  assert.deepEqual(plain.map((entry) => entry[0]), ['router', 'router', 'router']);
  // The router never hands devin search on its own.
  assert.ok(!plain[2][2].split(',').includes('devin'));
  assert.equal(fs.existsSync(paths.sessions), false);
  assert.equal(fs.existsSync(path.join(root, 'atris', 'ROSTER.md')), false);
  assert.deepEqual(resolveJobTeam('build', root, { now: NOW }).team.map((engine) => engine.id), [plain[0][1]]);
}));
