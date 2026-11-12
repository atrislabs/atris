'use strict';

// Every team member has a model and a place it runs on. "on: atris computer"
// or "on: grok bot" on a team line keeps a member's work off this machine;
// "on: muse" or no place runs it here. Muse is an engine like grok.

process.env.ATRIS_MACHINE_NAME = 'Test Mac';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'bin', 'atris.js');
const { readRunsOn, splitRunsOn, runsOnText } = require('../lib/runs-on');
const { canonicalEngineName } = require('../lib/engine-registry');

const ENV_KEYS = ['HOME', 'ATRIS_MACHINE_ROSTER_PATH', 'ATRIS_MACHINE_ROSTER_MD_PATH', 'ATRIS_ROSTER_SESSION', 'ATRIS_ROSTER_SESSIONS_DIR', 'ATRIS_RUNNER_PROFILE', 'ATRIS_RUNNER_MODEL', 'ATRIS_ROUTER_EXPLAIN'];

// A workspace with five member cards, claude, codex and muse ready, a team
// block, and a scratch HOME whose all-projects roster is empty.
function withTeam(team, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-runs-on-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-runs-on-home-'));
  const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  const machineRoster = path.join(home, '.atris', 'ROSTER.md');
  fs.mkdirSync(path.dirname(machineRoster), { recursive: true });
  fs.writeFileSync(machineRoster, '# roster\n\n## build\n- codex, model: gpt-6.1-sol\n');
  for (const name of ['cosmo', 'amara', 'walsh', 'benji', 'arjun']) {
    fs.mkdirSync(path.join(root, 'atris', 'team', name), { recursive: true });
    fs.writeFileSync(path.join(root, 'atris', 'team', name, 'MEMBER.md'), `---\nname: ${name}\nrole: Helper\n---\n`);
  }
  fs.writeFileSync(path.join(root, 'atris', 'ROSTER.md'), `# roster\n\n## team\n${team.map((line) => `- ${line}`).join('\n')}\n`);
  const checked = new Date().toISOString();
  const ids = Object.keys(require('../lib/runner-command').RUNNER_PROFILE_DEFS);
  const engines = ids.map((id) => (['claude', 'codex', 'muse'].includes(id)
    ? { id, health: { status: 'ready', checked_at: checked } }
    : { id, installed: false, health: { status: 'not_installed', checked_at: checked } }));
  fs.mkdirSync(path.join(root, '.atris', 'state'), { recursive: true });
  fs.writeFileSync(path.join(root, '.atris', 'state', 'engines.json'), `${JSON.stringify({ engines })}\n`);
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.HOME = home;
  process.env.ATRIS_MACHINE_ROSTER_MD_PATH = machineRoster;
  process.env.ATRIS_ROUTER_EXPLAIN = '0';
  const env = { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', NO_COLOR: '1', ATRIS_MACHINE_NAME: 'Test Mac' };
  const cli = (...args) => {
    const res = spawnSync(process.execPath, [CLI, 'engine', 'roster', ...args], { cwd: root, env, encoding: 'utf8' });
    return { exit: res.status, out: res.stdout.trim(), err: res.stderr.trim() };
  };
  const teamLines = () => fs.readFileSync(path.join(root, 'atris', 'ROSTER.md'), 'utf8').split('\n').filter((line) => /^- [a-z]+:/.test(line));
  try {
    return fn({ root, cli, teamLines });
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const isEngine = (words) => canonicalEngineName(words);

// --- place names -------------------------------------------------------------

test('every way of saying the hosted computer becomes "Atris computer"', () => {
  for (const words of ['atris computer', 'Atris Cloud', 'cloud', 'computer', 'business computer']) {
    assert.deepEqual(readRunsOn(words, { isEngine }), { id: 'atris computer', label: 'Atris computer', here: false }, words);
  }
});

test('local words and this machine\'s own name mean here, shown by the machine name', () => {
  for (const words of ['local', 'here', 'this mac', 'Test Mac', '']) {
    assert.deepEqual(readRunsOn(words, { isEngine }), { id: 'local', label: 'Test Mac', here: true }, words);
  }
});

test('an engine installed here means that engine, locally; any other name is a bot on another machine', () => {
  assert.deepEqual(readRunsOn('muse', { isEngine }), { id: 'local', label: 'Test Mac', here: true, engine: 'muse' });
  assert.deepEqual(readRunsOn('Grok bot', { isEngine }), { id: 'grok bot', label: 'Grok bot', here: false });
  assert.deepEqual(readRunsOn('claude duet', { isEngine }), { id: 'claude duet', label: 'Claude Duet', here: false });
  assert.deepEqual(readRunsOn('hermes', { isEngine }), { id: 'hermes', label: 'Hermes', here: false });
  assert.throws(() => readRunsOn('a, b'), /is not a place/);
});

test('the on: part splits off a team line and a second one is refused', () => {
  assert.deepEqual(splitRunsOn('claude, model: opus 5.5, on: atris computer'), { rest: 'claude, model: opus 5.5', on: 'atris computer' });
  assert.deepEqual(splitRunsOn('on: grok bot'), { rest: '', on: 'grok bot' });
  assert.deepEqual(splitRunsOn('build'), { rest: 'build', on: '' });
  assert.throws(() => splitRunsOn('on: a, on: b'), /two places/);
  assert.equal(runsOnText({ id: 'local', label: 'Test Mac', here: true }, 'muse'), 'muse on Test Mac');
  assert.equal(runsOnText({ id: 'grok bot', label: 'Grok bot', here: false }, 'codex'), 'Grok bot');
});

// --- team lines --------------------------------------------------------------

test('team lines carry a model and a place; members elsewhere show their own model', () => withTeam([
  'cosmo: claude, model: opus 5.5, on: atris computer',
  'amara: on: grok bot',
  'walsh: on: muse',
  'benji: muse wonder',
], ({ root }) => {
  const { teamRosterView } = require('../lib/member-engine');
  const view = teamRosterView(root);
  const row = (name) => view.rows.find((entry) => entry.member === name);
  assert.deepEqual(view.warnings, []);
  assert.deepEqual([row('cosmo').engine, row('cosmo').model, row('cosmo').runs_on, row('cosmo').runs_here], ['claude', 'claude-opus-5-5', 'atris computer', false]);
  // no engine named: whatever the grok bot's machine runs
  assert.deepEqual([row('amara').engine, row('amara').model, row('amara').runs_on_label, row('amara').runs_here], [null, null, 'Grok bot', false]);
  assert.deepEqual([row('walsh').engine, row('walsh').runs_on, row('walsh').runs_here], ['muse', 'local', true]);
  assert.deepEqual([row('benji').engine, row('benji').model, row('benji').runs_on_label], ['muse', 'muse-wonder-1.0', 'Test Mac']);
  assert.deepEqual([row('arjun').runs_on, row('arjun').runs_here, row('arjun').source], ['local', true, 'auto']);
}));

test('a mission owned by a member on another machine is left for that machine', () => withTeam([
  'cosmo: claude, model: opus 5.5, on: atris computer',
  'benji: muse wonder',
], ({ root }) => {
  const { resolveMissionTickRunner } = require('../lib/mission-core');
  const away = resolveMissionTickRunner({ runner: 'auto', owner: 'cosmo' }, root);
  assert.equal(away.runs_elsewhere, 'Atris computer');
  assert.equal(away.engine_id, null);
  const here = resolveMissionTickRunner({ runner: 'auto', owner: 'benji' }, root);
  assert.equal(here.runs_elsewhere, undefined);
  assert.equal(here.engine_id, 'muse');
  assert.equal(here.mission.model, 'muse-wonder-1.0');
}));

// --- the CLI -----------------------------------------------------------------

test('roster set --on moves a member and keeps its engine; a swap keeps its place', () => withTeam([
  'cosmo: claude, model: opus 5.5',
], ({ cli, teamLines }) => {
  let res = cli('set', '--member', 'cosmo', '--on', 'atris cloud');
  assert.equal(res.exit, 0, res.err);
  assert.equal(res.out, 'cosmo now works on Atris computer.');
  assert.deepEqual(teamLines(), ['- cosmo: claude, model: opus 5.5, on: atris computer']);

  res = cli('set', '--member', 'cosmo', 'muse', 'wonder');
  assert.equal(res.exit, 0, res.err);
  assert.match(teamLines()[0], /^- cosmo: muse, model: muse-wonder-1\.0, .*on: atris computer$/);

  res = cli('set', '--member', 'amara', '--on', 'Grok bot');
  assert.equal(res.exit, 0, res.err);
  assert.equal(res.out, 'amara now works on Grok bot.');
  assert.ok(teamLines().includes('- amara: on: grok bot'));

  res = cli('set', '--member', 'cosmo', '--on', 'local');
  assert.equal(res.exit, 0, res.err);
  assert.match(teamLines()[0], /^- cosmo: muse, model: muse-wonder-1\.0(, backup [^,]+)?$/);
}));

test('roster set --on refuses a member that does not exist and words that are not a place', () => withTeam([], ({ cli }) => {
  let res = cli('set', '--member', 'nobody', '--on', 'dots');
  assert.equal(res.exit, 2);
  assert.match(res.err, /no team member named nobody/);
  res = cli('set', '--member', 'cosmo', '--on', 'a, b');
  assert.equal(res.exit, 2);
  assert.match(res.err, /is not a place/);
  res = cli('set', '--on', 'dots');
  assert.equal(res.exit, 2);
}));

test('the team table adds RUNS ON only once a member works on another machine', () => {
  withTeam(['benji: muse wonder'], ({ cli }) => {
    const res = cli();
    assert.equal(res.exit, 0, res.err);
    assert.ok(!res.out.includes('RUNS ON'), res.out);
  });
  withTeam(['benji: muse wonder', 'amara: on: grok bot'], ({ cli }) => {
    const res = cli();
    assert.equal(res.exit, 0, res.err);
    const team = res.out.slice(res.out.indexOf('\nteam\n'));
    assert.match(team, /MEMBER\s+JOB\s+ENGINE · MODEL\s+RUNS ON\s+SOURCE/);
    assert.match(team, /amara\s+build\s+its own model\s+Grok bot/);
    assert.match(team, /benji\s+build\s+muse · muse-wonder-1\.0\s+Test Mac/);
  });
});

// --- muse --------------------------------------------------------------------

test('muse builds headless with network on, takes only muse models, and asks read-only', () => {
  const { RUNNER_PROFILE_DEFS, buildRunnerCommand } = require('../lib/runner-command');
  const { normalizeRosterModel } = require('../lib/model-names');
  const { buildReadOnlyEngineInvocation } = require('../lib/engine-ask');
  const def = RUNNER_PROFILE_DEFS.muse;
  assert.equal(def.bin, 'muse');
  assert.equal(def.ownModelsOnly, true);
  const saved = { profile: process.env.ATRIS_RUNNER_PROFILE, model: process.env.ATRIS_RUNNER_MODEL, bin: process.env.ATRIS_RUNNER_BIN };
  delete process.env.ATRIS_RUNNER_MODEL;
  delete process.env.ATRIS_RUNNER_BIN;
  process.env.ATRIS_RUNNER_PROFILE = 'muse';
  try {
    assert.equal(buildRunnerCommand({ promptFile: '/tmp/p.tmp' }), 'muse exec --sandbox-network enabled --trust-workspace "$(cat /tmp/p.tmp)"');
    assert.equal(buildRunnerCommand({ promptFile: '/tmp/p.tmp', model: 'muse-spark-1.3' }), 'muse exec --sandbox-network enabled --trust-workspace --model muse-spark-1.3 "$(cat /tmp/p.tmp)"');
  } finally {
    for (const [key, env] of [['profile', 'ATRIS_RUNNER_PROFILE'], ['model', 'ATRIS_RUNNER_MODEL'], ['bin', 'ATRIS_RUNNER_BIN']]) {
      if (saved[key] === undefined) delete process.env[env];
      else process.env[env] = saved[key];
    }
  }
  assert.equal(normalizeRosterModel('muse', 'wonder'), 'muse-wonder-1.0');
  assert.equal(normalizeRosterModel('muse', 'Muse Spark'), 'muse-spark-1.3');
  assert.equal(normalizeRosterModel('muse', 'muse-spark-2.0'), 'muse-spark-2.0');
  assert.throws(() => normalizeRosterModel('muse', 'opus 5.5'), /muse does not know/);
  const ask = buildReadOnlyEngineInvocation('muse', 'say hi', 'muse-wonder-1.0');
  assert.equal(ask.bin, 'muse');
  assert.deepEqual(ask.args.slice(0, 6), ['exec', '--sandbox-network', 'enabled', '--disable-write', '--model', 'muse-wonder-1.0']);
});

test('a running muse exec is seen as a muse engine run', () => {
  const { parseEngineProcess } = require('../lib/engine-processes');
  const run = parseEngineProcess({ pid: 1, ppid: 0, elapsed_seconds: 5, command: '/Users/k/.local/bin/muse exec --sandbox-network enabled --trust-workspace --model muse-wonder-1.0 fix the bug' });
  assert.equal(run && run.engine, 'muse');
  assert.equal(parseEngineProcess({ pid: 2, ppid: 0, elapsed_seconds: 5, command: 'muse skills list' }), null);
});
