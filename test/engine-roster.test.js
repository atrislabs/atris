'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { engineCommand } = require('../commands/engine');
const { resolveMissionTickRunner } = require('../commands/mission');
const { readyExecutor, readyValidators, lapModelPins } = require('../commands/one-lap');
const { buildEngineCommand } = require('../lib/fleet');
const { handleMissionBlocker } = require('../lib/self-drive');
const {
  normalizeRosterModel,
  parseRosterUntil,
  rosterPickExpired,
  engineRegistryFile,
  readEngineRegistry,
  resolveEngineForRoleRanked,
  setEngineHealth,
  setRosterPick,
  confirmRoster,
  resolveEngineForRoleWithPreference,
  readRosterState,
} = require('../lib/engine-registry');
const { auditWish, inferBudgetTier } = require('../lib/wish-audit');

const NOW = new Date('2026-09-24T12:00:00.000Z');

// Every room gets its own scratch home, so the all-projects roster file is
// never the real ~/.atris/roster.json.
function withRoom(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-roster-test-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-roster-home-'));
  fs.mkdirSync(path.join(root, 'atris'));
  const previous = process.env.ATRIS_MACHINE_ROSTER_PATH;
  process.env.ATRIS_MACHINE_ROSTER_PATH = path.join(home, '.atris', 'roster.json');
  try { return fn(root, process.env.ATRIS_MACHINE_ROSTER_PATH); } finally {
    if (previous === undefined) delete process.env.ATRIS_MACHINE_ROSTER_PATH;
    else process.env.ATRIS_MACHINE_ROSTER_PATH = previous;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// Picks now live in ROSTER.md; these read them the way routing does.
function projectPicks(root) {
  return readRosterState(root, { now: NOW }).project.picks;
}

function machinePicks(root) {
  return readRosterState(root, { now: NOW }).machine.picks;
}

function projectRosterText(root) {
  return fs.readFileSync(path.join(root, 'atris', 'ROSTER.md'), 'utf8');
}

function ready(root, ...names) {
  readEngineRegistry(root);
  for (const name of names) setEngineHealth(name, 'ready', root);
}

// The job and team lines of a roster view, without the closing hint.
function viewLines(out) {
  return out.trim().split('\n').filter((line) => !line.startsWith('see which tools') && line.trim());
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
    assert.equal(typeof exit, 'number');
    return { exit, out: logs.join('\n'), err: errors.join('\n') };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

test('assign pins the selected engine and threads its model into an automatic mission', () => withRoom((root) => {
  ready(root, 'codex', 'claude');
  const assigned = command(root, ['assign', 'builder', 'claude', '--model', 'claude-opus-5-5', '--backup', 'codex']);
  assert.equal(assigned.exit, 0, assigned.err);
  const saved = projectPicks(root).executor;
  assert.equal(saved.engine, 'claude');
  assert.equal(saved.model, 'claude-opus-5-5');
  assert.equal(saved.backup, 'codex');
  assert.equal(saved.until, '');
  assert.match(projectRosterText(root), /^## build\n- claude code, model: opus 5\.5\n- codex$/m);
  assert.equal(readEngineRegistry(root).roster, undefined);
  const chosen = resolveEngineForRoleRanked('executor', root, { now: NOW });
  assert.equal(chosen.engine.id, 'claude');
  assert.equal(chosen.engine.roster_model, 'claude-opus-5-5');
  assert.equal(chosen.reason, 'roster pick for build: claude');
  assert.equal(chosen.ranked[0].id, 'claude');
  const mission = resolveMissionTickRunner({ runner: 'auto' }, root, { now: NOW }).mission;
  assert.equal(mission.runner, 'claude');
  assert.equal(mission.model, 'claude-opus-5-5');
}));

test('expired and unavailable picks use backup, then router when backup is unavailable', () => withRoom((root) => {
  ready(root, 'codex', 'claude', 'cursor');
  setRosterPick('build', 'claude', { backup: 'cursor', days: 1, now: NOW }, root);
  const expired = resolveEngineForRoleRanked('executor', root, { now: '2026-09-27T00:00:00Z' });
  assert.equal(expired.engine.id, 'cursor');
  assert.match(expired.reason, /expired, using backup: cursor/);
  setRosterPick('build', 'claude', { backup: 'cursor', now: NOW }, root);
  setEngineHealth('claude', 'credit_out', root);
  const unavailable = resolveEngineForRoleRanked('executor', root, { now: NOW });
  assert.equal(unavailable.engine.id, 'cursor');
  assert.match(unavailable.reason, /not ready, using backup: cursor/);
  setEngineHealth('cursor', 'credit_out', root);
  assert.equal(resolveEngineForRoleRanked('executor', root, { now: NOW }).engine.id, 'codex');
}));

test('clear restores router behavior and invalid jobs or wrong-role engines fail clearly', () => withRoom((root) => {
  ready(root, 'codex', 'claude');
  setRosterPick('build', 'claude', { now: NOW }, root);
  const cleared = command(root, ['assign', 'executor', '--clear']);
  assert.equal(cleared.exit, 0, cleared.err);
  assert.equal(projectPicks(root).executor, undefined);
  assert.equal(resolveEngineForRoleRanked('executor', root, { now: NOW }).engine.id, 'codex');
  assert.match(command(root, ['assign', 'fishing', 'codex']).err, /say what kind of job "fishing" is: add --like search, --like build, or --like review/);
  assert.match(command(root, ['assign', 'search', 'codex']).err, /codex cannot do search/);
  assert.match(command(root, ['assign', 'build', 'unknown']).err, /unknown engine/);
}));

test('a registry normalization rewrite preserves roster, unknown keys, and engine entries', () => withRoom((root) => {
  ready(root, 'codex');
  const file = engineRegistryFile(root);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  saved.roster = { executor: { engine: 'codex', model: '', backup: '', until: '2026-10-24' } };
  saved.other_policy = { keep: true };
  saved.engines.find((entry) => entry.id === 'codex').custom_field = 'keep';
  saved.engines.pop();
  fs.writeFileSync(file, `${JSON.stringify(saved)}\n`);
  readEngineRegistry(root);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(after.roster, saved.roster);
  assert.deepEqual(after.other_policy, { keep: true });
  assert.equal(after.engines.find((entry) => entry.id === 'codex').custom_field, 'keep');
}));

test('confirm renews all picks for thirty days and roster views show three jobs', () => withRoom((root) => {
  ready(root, 'atris-fast', 'codex', 'claude', 'haiku');
  setRosterPick('build', 'claude', { model: 'claude-opus-5-5', backup: 'codex', days: 1, now: NOW }, root);
  setRosterPick('review', 'haiku', { backup: 'claude', days: 1, now: NOW }, root);
  const before = command(root, ['roster']);
  assert.equal(before.exit, 0, before.err);
  assert.equal(viewLines(before.out).length, 3);
  assert.match(before.out, /search\s+no pick, router decides: atris-fast \(atris:fast, atris default\)/);
  assert.match(before.out, /build\s+claude \(opus 5\.5\).*backup codex.*until sep 25, this project/);
  const json = command(root, ['roster', '--json']);
  assert.equal(json.exit, 0, json.err);
  assert.equal(JSON.parse(json.out).jobs.length, 3);
  const confirmed = command(root, ['roster', 'confirm'], '2026-09-27T12:00:00Z');
  assert.equal(confirmed.exit, 0, confirmed.err);
  assert.equal(projectPicks(root).executor.until, '2026-10-27');
  assert.equal(projectPicks(root).validator.until, '2026-10-27');
  const bare = command(root, []);
  assert.ok(bare.out.indexOf('search') < bare.out.indexOf('engines:'));
  confirmRoster(root, '2026-10-01T12:00:00Z');
  assert.equal(projectPicks(root).executor.until, '2026-10-31');
}));

test('assign saves the model id the claude cli accepts, whatever the spelling', () => withRoom((root) => {
  ready(root, 'claude', 'fable', 'haiku', 'codex');
  const cases = [
    ['claude', 'opus 5.5', 'claude-opus-5-5', 'opus 5.5'],
    ['claude', 'opus-5.5', 'claude-opus-5-5', 'opus 5.5'],
    ['claude', 'opus5.5', 'claude-opus-5-5', 'opus 5.5'],
    ['claude', 'claude-opus-5-5', 'claude-opus-5-5', 'opus 5.5'],
    ['claude', 'sonnet 5', 'claude-sonnet-5', 'sonnet 5'],
    ['haiku', 'haiku 4.5', 'claude-haiku-4-5-20251001', 'haiku 4.5'],
    ['fable', 'fable 5.1', 'claude-fable-5-1', 'fable 5.1'],
    ['claude', 'opus', 'opus', 'opus'],
    ['claude', 'sonnet', 'sonnet', 'sonnet'],
    ['haiku', 'haiku', 'haiku', 'haiku'],
    ['claude', 'claude-sonnet-4-6[1m]', 'claude-sonnet-4-6[1m]', 'claude-sonnet-4-6[1m]'],
  ];
  for (const [engine, typed, saved, shown] of cases) {
    const result = command(root, ['assign', 'review', engine, '--model', typed]);
    assert.equal(result.exit, 0, `${typed}: ${result.err}`);
    assert.equal(projectPicks(root).validator.model, saved, typed);
    assert.ok(result.out.includes(`${engine} (${shown})`), `${typed}: ${result.out}`);
  }
}));

test('a claude model the cli would reject is refused at assign, other engines save as typed', () => withRoom((root) => {
  ready(root, 'claude', 'codex');
  const refused = command(root, ['assign', 'build', 'claude', '--model', 'gpt-6-sol']);
  assert.equal(refused.exit, 2);
  assert.match(refused.err, /claude does not know the model "gpt-6-sol"\. use opus, sonnet, haiku/);
  assert.equal(fs.existsSync(path.join(root, 'atris', 'ROSTER.md')), false);
  assert.throws(() => normalizeRosterModel('fable', 'opus five'), /fable does not know the model/);
  const codex = command(root, ['assign', 'build', 'codex', '--model', 'gpt-6-sol']);
  assert.equal(codex.exit, 0, codex.err);
  assert.equal(projectPicks(root).executor.model, 'gpt-6-sol');
  assert.match(projectRosterText(root), /^## build\n- codex, model: gpt-6-sol$/m);
}));

test('an until date that is not a real YYYY-MM-DD day counts as expired; the until day itself still holds', () => withRoom((root) => {
  ready(root, 'codex', 'claude');
  for (const until of ['garbage', '2026-9-1', '9999', '2026-02-30', '', '2026-09-23']) {
    const registry = readEngineRegistry(root);
    registry.roster = { executor: { engine: 'claude', model: '', backup: '', until } };
    fs.writeFileSync(engineRegistryFile(root), `${JSON.stringify(registry)}\n`);
    assert.equal(rosterPickExpired({ until }, NOW), true, until);
    assert.equal(resolveEngineForRoleRanked('executor', root, { now: NOW }).engine.id, 'codex', until);
  }
  assert.equal(parseRosterUntil('2026-02-29'), null);
  assert.equal(rosterPickExpired({ until: '2026-09-24' }, new Date(2026, 8, 24, 23, 59)), false);
  assert.equal(rosterPickExpired({ until: '2026-09-24' }, new Date(2026, 8, 25, 0, 1)), true);
  const roster = command(root, ['roster']);
  assert.match(roster.out, /build\s+claude.*expired, router decides: codex \(its own default\), this project/);
}));

test('an all-projects pick applies where the project has none', () => withRoom((root, machineFile) => {
  ready(root, 'codex', 'claude', 'cursor');
  const assigned = command(root, ['assign', 'build', 'claude', '--model', 'opus 5.5', '--backup', 'cursor', '--everywhere']);
  assert.equal(assigned.exit, 0, assigned.err);
  assert.equal(fs.existsSync(path.join(root, 'atris', 'ROSTER.md')), false);
  assert.equal(fs.existsSync(machineFile), false);
  assert.match(fs.readFileSync(path.join(path.dirname(machineFile), 'ROSTER.md'), 'utf8'), /^## build\n- claude code, model: opus 5\.5\n- cursor$/m);
  assert.equal(machinePicks(root).executor.model, 'claude-opus-5-5');
  assert.equal(machinePicks(root).executor.until, '');
  const chosen = resolveEngineForRoleRanked('executor', root, { now: NOW });
  assert.equal(chosen.engine.id, 'claude');
  assert.equal(chosen.engine.roster_model, 'claude-opus-5-5');
  assert.equal(chosen.source, 'machine');
  assert.equal(chosen.reason, 'roster pick for build (all projects): claude');
  assert.match(assigned.out, /build\s+claude \(opus 5\.5\).*backup cursor.*no end date, all projects/);
  // A second project on this machine gets the same pick with no extra step.
  withRoom((other) => {
    process.env.ATRIS_MACHINE_ROSTER_PATH = machineFile;
    ready(other, 'codex', 'claude');
    assert.equal(resolveEngineForRoleRanked('executor', other, { now: NOW }).engine.id, 'claude');
  });
  setEngineHealth('claude', 'credit_out', root);
  const backup = resolveEngineForRoleRanked('executor', root, { now: NOW });
  assert.equal(backup.engine.id, 'cursor');
  assert.match(backup.reason, /all projects\) is not ready, using backup: cursor/);
}));

test('a project pick beats the all-projects pick, and clear --everywhere only clears the machine pick', () => withRoom((root, machineFile) => {
  ready(root, 'codex', 'claude', 'cursor');
  assert.equal(command(root, ['assign', 'build', 'claude', '--model', 'sonnet 5', '--everywhere']).exit, 0);
  assert.equal(command(root, ['assign', 'build', 'cursor']).exit, 0);
  const chosen = resolveEngineForRoleRanked('executor', root, { now: NOW });
  assert.equal(chosen.engine.id, 'cursor');
  assert.equal(chosen.source, 'project');
  const view = command(root, ['roster', '--json']);
  const build = JSON.parse(view.out).jobs.find((row) => row.job === 'build');
  assert.equal(build.from, 'this project');
  assert.equal(build.machine_pick.engine, 'claude');
  const cleared = command(root, ['assign', 'build', '--clear', '--everywhere']);
  assert.equal(cleared.exit, 0, cleared.err);
  assert.equal(machinePicks(root).executor, undefined);
  assert.equal(projectPicks(root).executor.engine, 'cursor');
  assert.equal(command(root, ['assign', 'build', '--clear']).exit, 0);
  assert.equal(resolveEngineForRoleRanked('executor', root, { now: NOW }).source, 'router');
}));

test('roster confirm renews this project and the all-projects picks', () => withRoom((root, machineFile) => {
  ready(root, 'codex', 'claude', 'haiku');
  setRosterPick('build', 'claude', { days: 1, now: NOW }, root);
  setRosterPick('review', 'haiku', { days: 1, now: NOW, everywhere: true }, root);
  assert.equal(command(root, ['roster', 'confirm'], '2026-09-27T12:00:00Z').exit, 0);
  assert.equal(projectPicks(root).executor.until, '2026-10-27');
  assert.equal(machinePicks(root).validator.until, '2026-10-27');
}));

test('the pinned model reaches one-lap builds and reviews and missions that already named the engine', () => withRoom((root) => {
  ready(root, 'codex', 'claude', 'haiku');
  setRosterPick('build', 'claude', { model: 'opus 5.5', now: NOW }, root);
  setRosterPick('review', 'haiku', { model: 'haiku 4.5', now: NOW }, root);
  const routed = readyExecutor(root);
  assert.equal(routed.id, 'claude');
  assert.equal(routed.roster_model, 'claude-opus-5-5');
  const named = readyExecutor(root, 'claude');
  assert.equal(named.roster_model, 'claude-opus-5-5');
  assert.equal(readyExecutor(root, 'codex').roster_model, undefined);
  const validators = readyValidators(root, '', 'claude');
  assert.equal(validators[0].id, 'haiku');
  assert.deepEqual(lapModelPins(routed, validators), {
    model: 'claude-opus-5-5',
    validatorModels: { haiku: 'claude-haiku-4-5-20251001' },
  });
  const spawn = buildEngineCommand('claude', '/tmp/prompt.md', { model: 'claude-opus-5-5' });
  assert.match(spawn, /--model claude-opus-5-5 /);
  const preferred = resolveMissionTickRunner({ runner: 'auto', preferred_engine: 'claude' }, root, { now: NOW }).mission;
  assert.equal(preferred.runner, 'claude');
  assert.equal(preferred.model, 'claude-opus-5-5');
  const other = resolveMissionTickRunner({ runner: 'auto', preferred_engine: 'codex' }, root, { now: NOW }).mission;
  assert.equal(other.model, undefined);
  const kept = resolveMissionTickRunner({ runner: 'auto', preferred_engine: 'claude', model: 'sonnet' }, root, { now: NOW }).mission;
  assert.equal(kept.model, 'sonnet');
}));

test('self-drive hands the pinned model to the dispatch', () => {
  const dispatched = [];
  const rows = [];
  const taskDb = {
    open: () => ({}),
    workspaceRoot: (root) => root,
    listTasks: () => rows,
    withTaskDisplayRefs: (tasks) => tasks.map((task, index) => ({ ...task, display_id: `CLI-${index + 1}` })),
    addTask: (_db, input) => {
      rows.push({ id: `task-${rows.length + 1}`, status: 'open', created_at: Date.now(), updated_at: Date.now(), ...input });
      return { id: rows[rows.length - 1].id, inserted: true };
    },
    getTask: (_db, id) => rows.find((row) => row.id === id),
    noteTask: () => ({ noted: true }),
    claimTask: (_db, { id, claimedBy }) => {
      const row = rows.find((item) => item.id === id);
      Object.assign(row, { status: 'claimed', claimed_by: claimedBy });
      return { claimed: true, row };
    },
  };
  const result = handleMissionBlocker({
    mission: { id: 'mission-1', objective: 'ship reliable missions', status: 'paused' },
    stopReason: 'repeated-error:runner-failed',
    workspaceRoot: '/tmp/workspace',
    appendEvent: () => {},
  }, {
    taskDb,
    resolveEngineForRole: () => ({ id: 'claude', roster_model: 'claude-opus-5-5' }),
    createAgentWorktree: () => ({ path: '/tmp/self-drive-worktree' }),
    dispatchToEngine: (args) => { dispatched.push(args); return { exitCode: 0 }; },
    loadSwarloApiKey: () => null,
    httpPost: () => { throw new Error('unexpected network call in test'); },
  });
  assert.equal(result.dispatched, true, result.reason);
  assert.equal(dispatched[0].model, 'claude-opus-5-5');
});

test('claude and haiku can own search, and with no roster search still goes to atris-fast', () => withRoom((root) => {
  ready(root, 'atris-fast', 'composer', 'claude', 'haiku');
  assert.equal(resolveEngineForRoleRanked('navigator', root, { now: NOW }).engine.id, 'atris-fast');
  setEngineHealth('atris-fast', 'credit_out', root);
  assert.notEqual(resolveEngineForRoleRanked('navigator', root, { now: NOW }).engine, null);
  setEngineHealth('atris-fast', 'ready', root);
  const assigned = command(root, ['assign', 'search', 'claude', '--model', 'haiku', '--backup', 'atris-fast']);
  assert.equal(assigned.exit, 0, assigned.err);
  assert.match(assigned.out, /search\s+claude \(haiku\)\s+backup atris-fast/);
  const chosen = resolveEngineForRoleRanked('navigator', root, { now: NOW });
  assert.equal(chosen.engine.id, 'claude');
  assert.equal(chosen.engine.roster_model, 'haiku');
  assert.equal(command(root, ['assign', 'search', 'haiku']).exit, 0);
}));

test('a registry saved before claude learned search still lets search be assigned to it', () => withRoom((root) => {
  ready(root, 'atris-fast', 'claude');
  const file = engineRegistryFile(root);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  saved.engines.find((entry) => entry.id === 'claude').roles = ['validator', 'executor'];
  fs.writeFileSync(file, `${JSON.stringify(saved)}\n`);
  assert.equal(resolveEngineForRoleRanked('navigator', root, { now: NOW }).engine.id, 'atris-fast');
  assert.equal(command(root, ['assign', 'search', 'claude']).exit, 0);
  assert.equal(resolveEngineForRoleRanked('navigator', root, { now: NOW }).engine.id, 'claude');
}));

test('every model name the claude cli takes is accepted, and garbage is still refused', () => withRoom((root) => {
  ready(root, 'claude', 'fable', 'haiku');
  const cases = [
    ['claude', 'fable', 'fable'],
    ['claude', 'opusplan', 'opusplan'],
    ['claude', 'default', 'default'],
    ['claude', 'Opus[1m]', 'opus[1m]'],
    ['claude', 'sonnet[1m]', 'sonnet[1m]'],
    ['claude', 'opus 5.5[1m]', 'claude-opus-5-5[1m]'],
    ['fable', 'fable', 'fable'],
  ];
  for (const [engine, typed, saved] of cases) {
    assert.equal(normalizeRosterModel(engine, typed), saved, typed);
    const result = command(root, ['assign', 'review', engine, '--model', typed]);
    assert.equal(result.exit, 0, `${typed}: ${result.err}`);
    assert.equal(projectPicks(root).validator.model, saved, typed);
  }
  for (const typed of ['gpt-9', 'gpt-9[1m]', '[1m]']) {
    assert.throws(() => normalizeRosterModel('claude', typed), /claude does not know the model/, typed);
  }
  const refused = command(root, ['assign', 'review', 'claude', '--model', 'gpt-9']);
  assert.equal(refused.exit, 2);
  assert.match(refused.err, /claude does not know the model "gpt-9"/);
}));

test('saved picks are normalized when read, from this project and from all projects', () => withRoom((root, machineFile) => {
  ready(root, 'codex', 'claude', 'cursor');
  const registry = readEngineRegistry(root);
  registry.roster = { executor: { engine: 'claude', model: 'opus 5.5', backup: '', until: '2026-10-24' } };
  fs.writeFileSync(engineRegistryFile(root), `${JSON.stringify(registry)}\n`);
  fs.mkdirSync(path.dirname(machineFile), { recursive: true });
  fs.writeFileSync(machineFile, `${JSON.stringify({ roster: { validator: { engine: 'claude', model: 'opus-5.5', backup: '', until: '2026-10-24' } } })}\n`);
  const build = resolveEngineForRoleRanked('executor', root, { now: NOW });
  assert.equal(build.engine.id, 'claude');
  assert.equal(build.engine.roster_model, 'claude-opus-5-5');
  const review = resolveEngineForRoleRanked('validator', root, { now: NOW });
  assert.equal(review.engine.id, 'claude');
  assert.equal(review.source, 'machine');
  assert.equal(review.engine.roster_model, 'claude-opus-5-5');
  const mission = resolveMissionTickRunner({ runner: 'auto' }, root, { now: NOW }).mission;
  assert.equal(mission.model, 'claude-opus-5-5');
}));

test('a saved claude model that cannot be normalized skips to the backup, then the next layer', () => withRoom((root, machineFile) => {
  ready(root, 'codex', 'claude', 'cursor');
  const registry = readEngineRegistry(root);
  registry.roster = { executor: { engine: 'claude', model: 'gpt-9', backup: 'cursor', until: '2026-10-24' } };
  fs.writeFileSync(engineRegistryFile(root), `${JSON.stringify(registry)}\n`);
  const backup = resolveEngineForRoleRanked('executor', root, { now: NOW });
  assert.equal(backup.engine.id, 'cursor');
  assert.equal(backup.engine.roster_model, undefined);
  assert.match(backup.reason, /names a model claude cannot run, using backup: cursor/);
  registry.roster.executor.backup = '';
  fs.writeFileSync(engineRegistryFile(root), `${JSON.stringify(registry)}\n`);
  fs.mkdirSync(path.dirname(machineFile), { recursive: true });
  fs.writeFileSync(machineFile, `${JSON.stringify({ roster: { executor: { engine: 'codex', model: '', backup: '', until: '2026-10-24' } } })}\n`);
  const next = resolveEngineForRoleRanked('executor', root, { now: NOW });
  assert.equal(next.engine.id, 'codex');
  assert.equal(next.source, 'machine');
}));

test('with no roster and atris-fast not ready, search goes to composer, fresh or saved', () => withRoom((root) => {
  ready(root, 'composer', 'claude', 'haiku');
  setEngineHealth('atris-fast', 'credit_out', root);
  const fresh = resolveEngineForRoleRanked('navigator', root, { now: NOW });
  assert.equal(fresh.engine.id, 'composer');
  assert.deepEqual(fresh.ranked.map((engine) => engine.id), ['composer']);
  const file = engineRegistryFile(root);
  for (const shape of [['validator', 'executor', 'navigator'], ['validator', 'executor']]) {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    saved.engines.find((entry) => entry.id === 'claude').roles = shape;
    saved.engines.find((entry) => entry.id === 'haiku').roles = shape.filter((role) => role !== 'executor');
    fs.writeFileSync(file, `${JSON.stringify(saved)}\n`);
    const chosen = resolveEngineForRoleRanked('navigator', root, { now: NOW });
    assert.deepEqual(chosen.ranked.map((engine) => engine.id), ['composer'], shape.join(','));
  }
  assert.equal(command(root, ['assign', 'search', 'haiku']).exit, 0);
  assert.equal(resolveEngineForRoleRanked('navigator', root, { now: NOW }).engine.id, 'haiku');
}));

test('a pick saved as a string or a list shows as no pick', () => withRoom((root, machineFile) => {
  ready(root, 'codex', 'claude');
  const registry = readEngineRegistry(root);
  registry.roster = { executor: 'claude' };
  fs.writeFileSync(engineRegistryFile(root), `${JSON.stringify(registry)}\n`);
  fs.mkdirSync(path.dirname(machineFile), { recursive: true });
  fs.writeFileSync(machineFile, `${JSON.stringify({ roster: { validator: ['claude'], navigator: 'haiku' } })}\n`);
  const view = command(root, ['roster']);
  assert.equal(view.exit, 0, view.err);
  assert.doesNotMatch(view.out, /undefined/);
  for (const job of ['search', 'build', 'review']) assert.match(view.out, new RegExp(`${job}\\s+no pick, router decides`));
  const json = JSON.parse(command(root, ['roster', '--json']).out);
  for (const row of json.jobs) {
    assert.equal(row.pick, null);
    assert.equal(row.project_pick, null);
    assert.equal(row.machine_pick, null);
  }
}));

test('codex can be picked as the reviewer here or everywhere, and one-lap reviews with it', () => withRoom((root, machineFile) => {
  ready(root, 'codex', 'claude', 'haiku');
  const everywhere = command(root, ['assign', 'review', 'codex', '--everywhere']);
  assert.equal(everywhere.exit, 0, everywhere.err);
  assert.equal(machinePicks(root).validator.engine, 'codex');
  const machine = resolveEngineForRoleRanked('validator', root, { now: NOW });
  assert.equal(machine.engine.id, 'codex');
  assert.equal(machine.source, 'machine');
  const assigned = command(root, ['assign', 'review', 'codex', '--backup', 'claude']);
  assert.equal(assigned.exit, 0, assigned.err);
  const chosen = resolveEngineForRoleRanked('validator', root, { now: NOW });
  assert.equal(chosen.engine.id, 'codex');
  assert.equal(chosen.reason, 'roster pick for review: codex');
  assert.deepEqual(chosen.ranked.map((engine) => engine.id), ['codex', 'claude', 'fable', 'haiku', 'commandcode']);
  const validators = readyValidators(root, '', 'claude');
  assert.equal(validators[0].id, 'codex');
  assert.match(buildEngineCommand('codex', '/tmp/prompt.md', { sealed: true }), /codex exec --sandbox workspace-write /);
  // The builder is never its own reviewer: a codex build skips the codex pick.
  assert.equal(readyValidators(root, '', 'codex')[0].id, 'claude');
}));

test('with no roster, review routing is unchanged and codex stays out, fresh or saved', () => withRoom((root) => {
  ready(root, 'codex', 'claude', 'haiku');
  const before = ['claude', 'fable', 'haiku', 'commandcode'];
  const fresh = resolveEngineForRoleRanked('validator', root, { now: NOW });
  assert.equal(fresh.source, 'router');
  assert.deepEqual(fresh.ranked.map((engine) => engine.id), before);
  assert.deepEqual(readyValidators(root, '', 'cursor').map((engine) => engine.id), before);
  const file = engineRegistryFile(root);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  saved.engines.find((entry) => entry.id === 'codex').roles = ['executor'];
  fs.writeFileSync(file, `${JSON.stringify(saved)}\n`);
  const reread = resolveEngineForRoleRanked('validator', root, { now: NOW });
  assert.deepEqual(reread.ranked.map((engine) => engine.id), before);
  assert.deepEqual(readyValidators(root, '', 'cursor').map((engine) => engine.id), before);
  assert.equal(command(root, ['assign', 'review', 'codex']).exit, 0);
  assert.equal(resolveEngineForRoleRanked('validator', root, { now: NOW }).engine.id, 'codex');
  assert.equal(readyValidators(root, '', 'cursor')[0].id, 'codex');
}));

test('any job name can be assigned: the name says its kind or --like does, and clear, view, json, and confirm cover it', () => withRoom((root, machineFile) => {
  ready(root, 'codex', 'claude', 'devin', 'grok', 'haiku');
  const small = command(root, ['assign', 'small build', 'devin', '--model', 'swe-2-max', '--backup', 'grok', '--days', '30', '--everywhere']);
  assert.equal(small.exit, 0, small.err);
  const smallPick = machinePicks(root)['small-build'];
  assert.deepEqual([smallPick.engine, smallPick.model, smallPick.backup, smallPick.until, smallPick.like], ['devin', 'swe-2-max', 'grok', '2026-10-24', 'build']);
  const quick = command(root, ['assign', 'Quick Fixes', 'codex', '--like', 'build']);
  assert.equal(quick.exit, 0, quick.err);
  assert.equal(projectPicks(root)['quick-fixes'].like, 'build');
  assert.match(projectRosterText(root), /^## quick fixes \(like build\)\n- codex$/m);
  // A later assign of the same job keeps its saved kind without --like.
  assert.equal(command(root, ['assign', 'quick fixes', 'claude']).exit, 0);
  assert.equal(projectPicks(root)['quick-fixes'].engine, 'claude');

  const vague = command(root, ['assign', 'hotfix', 'codex']);
  assert.equal(vague.exit, 2);
  assert.match(vague.err, /say what kind of job "hotfix" is: add --like search, --like build, or --like review/);
  const badKind = command(root, ['assign', 'hotfix', 'codex', '--like', 'painting']);
  assert.equal(badKind.exit, 2);
  assert.match(badKind.err, /unknown kind "painting"\. use --like search, build, or review/);
  assert.match(command(root, ['assign', 'deep search', 'codex']).err, /codex cannot do search work, so it cannot take deep search/);
  // roster-only jobs follow the kind: claude takes search only by pick.
  assert.equal(command(root, ['assign', 'deep search', 'claude', '--model', 'haiku']).exit, 0);
  assert.equal(projectPicks(root)['deep-search'].like, 'search');
  assert.equal(projectPicks(root)['deep-search'].model, 'haiku');

  const view = command(root, ['roster']);
  assert.equal(view.exit, 0, view.err);
  const lines = viewLines(view.out);
  const order = ['search', 'build', 'review', 'quick fixes', 'deep search', 'small build'];
  assert.equal(lines.length, order.length);
  order.forEach((label, index) => assert.ok(lines[index].startsWith(`${label} `), lines[index]));
  assert.match(view.out, /small build\s+devin \(swe-2-max\)\s+backup grok \(its own default\)\s+until oct 24, all projects/);
  assert.match(view.out, /quick fixes\s+claude \(opus 5\.5, atris default\)\s+no backup\s+no end date, this project/);
  const json = JSON.parse(command(root, ['roster', '--json']).out).jobs;
  assert.equal(json.length, 6);
  const row = json.find((entry) => entry.job === 'small build');
  assert.equal(row.key, 'small-build');
  assert.equal(row.like, 'build');
  assert.equal(row.role, 'executor');
  assert.equal(row.engine, 'devin');
  assert.equal(row.model, 'swe-2-max');
  assert.equal(row.status, 'picked');
  assert.equal(row.from, 'all projects');
  assert.equal(json.find((entry) => entry.job === 'build').like, undefined);

  // Confirm renews dated lines only; a line with no until never expires.
  assert.equal(command(root, ['roster', 'confirm'], '2026-09-27T12:00:00Z').exit, 0);
  assert.equal(machinePicks(root)['small-build'].until, '2026-10-27');
  assert.equal(projectPicks(root)['quick-fixes'].until, '');

  assert.equal(command(root, ['assign', 'small build', '--clear', '--everywhere']).exit, 0);
  assert.equal(machinePicks(root)['small-build'], undefined);
  assert.equal(command(root, ['assign', 'quick fixes', '--clear']).exit, 0);
  assert.equal(projectPicks(root)['quick-fixes'], undefined);
  assert.equal(viewLines(command(root, ['roster']).out).length, 4);
}));

test('the job option asks for a job by name, then falls back to its kind, then the router', () => withRoom((root) => {
  ready(root, 'codex', 'claude', 'devin', 'haiku');
  setRosterPick('build', 'claude', { model: 'opus 5.5', now: NOW }, root);
  setRosterPick('small build', 'devin', { model: 'swe-2-max', now: NOW }, root);
  setRosterPick('deep review', 'haiku', { now: NOW }, root);
  const picked = resolveEngineForRoleRanked('executor', root, { now: NOW, job: 'small build' });
  assert.equal(picked.engine.id, 'devin');
  assert.equal(picked.engine.roster_model, 'swe-2-max');
  assert.equal(picked.job, 'small build');
  assert.equal(picked.reason, 'roster pick for small build: devin');
  assert.equal(picked.ranked[0].id, 'devin');
  // A review job never answers a build question.
  assert.equal(resolveEngineForRoleRanked('executor', root, { now: NOW, job: 'deep review' }).engine.id, 'claude');
  assert.equal(resolveEngineForRoleRanked('validator', root, { now: NOW, job: 'deep review' }).engine.id, 'haiku');
  const resolved = command(root, ['resolve', 'small build']);
  assert.equal(resolved.exit, 0, resolved.err);
  assert.equal(resolved.out.trim(), 'devin');
  assert.equal(command(root, ['resolve', 'build']).out.trim(), 'claude');
  assert.equal(command(root, ['resolve', 'poet']).exit, 2);

  setEngineHealth('devin', 'credit_out', root);
  const kind = resolveEngineForRoleRanked('executor', root, { now: NOW, job: 'small build' });
  assert.equal(kind.engine.id, 'claude');
  assert.equal(kind.engine.roster_model, 'claude-opus-5-5');
  assert.equal(kind.reason, 'roster pick for build: claude');
  const view = JSON.parse(command(root, ['roster', '--json']).out).jobs.find((entry) => entry.job === 'small build');
  assert.equal(view.status, 'not ready');
  assert.match(command(root, ['roster']).out, /small build\s+devin \(swe-2-max\).*not ready, falls back to build: claude \(opus 5\.5\), this project/);

  assert.equal(command(root, ['assign', 'build', '--clear']).exit, 0);
  assert.equal(resolveEngineForRoleRanked('executor', root, { now: NOW, job: 'small build' }).source, 'router');
}));

test('a low-stakes build prefers the small build pick and a normal build ignores it', () => withRoom((root) => {
  ready(root, 'codex', 'claude', 'devin', 'grok');
  setRosterPick('build', 'claude', { model: 'opus 5.5', now: NOW }, root);
  setRosterPick('small build', 'devin', { model: 'swe-2-max', backup: 'grok', now: NOW, everywhere: true }, root);
  const small = resolveEngineForRoleRanked('executor', root, { now: NOW, lowStakes: true });
  assert.equal(small.engine.id, 'devin');
  assert.equal(small.engine.roster_model, 'swe-2-max');
  assert.equal(small.reason, 'roster pick for small build (all projects): devin');
  const big = resolveEngineForRoleRanked('executor', root, { now: NOW });
  assert.equal(big.engine.id, 'claude');
  assert.equal(big.engine.roster_model, 'claude-opus-5-5');
  // Only builds read the small build pick.
  assert.notEqual(resolveEngineForRoleRanked('validator', root, { now: NOW, lowStakes: true }).engine.id, 'devin');
  // A caller that already named devin still gets the small build model.
  assert.equal(resolveEngineForRoleWithPreference('executor', root, 'devin', { now: NOW, lowStakes: true }).engine.roster_model, 'swe-2-max');
  assert.equal(resolveEngineForRoleWithPreference('executor', root, 'devin', { now: NOW }).engine.roster_model, undefined);
  // A quick wish asks for the small build pick; a bigger one does not.
  assert.equal(inferBudgetTier('quick fix the typo in the readme'), 'quick');
  assert.equal(auditWish('quick fix the typo in the readme', root).executor.id, 'devin');
  assert.equal(auditWish('quick fix the typo in the readme', root).executor.roster_model, 'swe-2-max');
  assert.notEqual(inferBudgetTier('rewrite the whole router architecture'), 'quick');
  assert.equal(auditWish('rewrite the whole router architecture', root).executor.id, 'claude');
  // The backup never inherits the pick's model.
  setEngineHealth('devin', 'credit_out', root);
  const backup = resolveEngineForRoleRanked('executor', root, { now: NOW, lowStakes: true });
  assert.equal(backup.engine.id, 'grok');
  assert.equal(backup.engine.roster_model, undefined);
  assert.match(backup.reason, /small build \(all projects\) is not ready, using backup: grok/);
}));

test('devin and grok launch with the pinned model, and without --model when nothing is pinned', () => {
  assert.match(buildEngineCommand('devin', '/tmp/prompt.md', { model: 'swe-2-max' }), /^devin -p --permission-mode dangerous --model swe-2-max -- /);
  assert.match(buildEngineCommand('devin', '/tmp/prompt.md', { sealed: true, model: 'swe-2-max' }), /^devin -p --sandbox --permission-mode accept-edits --model swe-2-max -- /);
  assert.doesNotMatch(buildEngineCommand('devin', '/tmp/prompt.md'), /--model/);
  assert.match(buildEngineCommand('grok', '/tmp/prompt.md', { model: 'grok-4.7-build-fast' }), /^grok --always-approve --model grok-4\.7-build-fast -p /);
  assert.match(buildEngineCommand('grok', '/tmp/prompt.md', { sealed: true, model: 'grok-4.7' }), /^grok --model grok-4\.7 -p .*--sandbox enabled/);
  assert.doesNotMatch(buildEngineCommand('grok', '/tmp/prompt.md'), /--model|grok-4\.6/);
});

test('grok friendly names save as grok ids, devin names save as typed, and names an engine cannot take are refused', () => withRoom((root) => {
  ready(root, 'codex', 'devin', 'grok');
  assert.equal(normalizeRosterModel('grok', 'grok 4.7 fast'), 'grok-4.7-build-fast');
  assert.equal(normalizeRosterModel('grok', 'Grok 4.7'), 'grok-4.7');
  assert.equal(normalizeRosterModel('grok', 'grok-4.7-build-fast'), 'grok-4.7-build-fast');
  assert.equal(normalizeRosterModel('grok', 'grok-4.5-xhigh'), 'grok-4.5-xhigh');
  assert.equal(normalizeRosterModel('devin', 'SWE-2 max'), 'SWE-2 max');
  assert.throws(() => normalizeRosterModel('grok', 'opus 5.5'), /grok does not know the model "opus 5\.5"\. use grok 4\.7 fast, grok 4\.7, or a full grok- id/);
  const assigned = command(root, ['assign', 'small build', 'grok', '--model', 'grok 4.7 fast']);
  assert.equal(assigned.exit, 0, assigned.err);
  assert.equal(projectPicks(root)['small-build'].model, 'grok-4.7-build-fast');
  assert.match(projectRosterText(root), /^## small build\n- grok, model: grok 4\.7 fast$/m);
  assert.match(assigned.out, /small build\s+grok \(grok 4\.7 fast\)/);
  const refused = command(root, ['assign', 'build', 'grok', '--model', 'sonnet 5']);
  assert.equal(refused.exit, 2);
  assert.match(refused.err, /grok does not know the model "sonnet 5"/);
  assert.equal(projectPicks(root).executor, undefined);
  const engines = JSON.parse(command(root, ['list', '--json']).out).engines;
  assert.deepEqual(engines.find((engine) => engine.id === 'grok').models, ['grok 4.7 fast', 'grok 4.7']);
}));

test('a roster saved before custom jobs reads, routes, and renders the same', () => withRoom((root) => {
  ready(root, 'codex', 'claude', 'haiku');
  const registry = readEngineRegistry(root);
  registry.roster = {
    executor: { engine: 'claude', model: 'claude-opus-5-5', backup: 'codex', until: '2026-10-24', set_at: NOW.toISOString() },
    validator: { engine: 'haiku', model: '', backup: '', until: '2026-10-24', set_at: NOW.toISOString() },
    notes: 'kept by hand',
    'odd-job': { engine: 'codex', model: '', backup: '', until: '2026-10-24', like: 'painting' },
  };
  fs.writeFileSync(engineRegistryFile(root), `${JSON.stringify(registry)}\n`);
  const build = resolveEngineForRoleRanked('executor', root, { now: NOW });
  assert.equal(build.engine.id, 'claude');
  assert.equal(build.reason, 'roster pick for build: claude');
  assert.equal(resolveEngineForRoleRanked('validator', root, { now: NOW }).engine.id, 'haiku');
  const view = command(root, ['roster']);
  assert.equal(viewLines(view.out).length, 3);
  assert.match(view.out, /build\s+claude \(opus 5\.5\)\s+backup codex \(its own default\)\s+until oct 24, this project/);
  // A normal build and a low-stakes build with no small build pick match.
  assert.equal(resolveEngineForRoleRanked('executor', root, { now: NOW, lowStakes: true }).engine.id, 'claude');
  assert.equal(command(root, ['roster', 'confirm'], '2026-09-27T12:00:00Z').exit, 0);
  const renewed = readEngineRegistry(root).roster;
  assert.equal(renewed.executor.until, '2026-10-27');
  assert.equal(renewed.notes, 'kept by hand');
  assert.equal(renewed.executor.like, undefined);
}));

test('with no roster, a job or low-stakes build routes exactly like a plain build', () => withRoom((root) => {
  ready(root, 'codex', 'claude', 'devin', 'grok');
  const plain = resolveEngineForRoleRanked('executor', root, { now: NOW, lowStakes: true });
  const job = resolveEngineForRoleRanked('executor', root, { now: NOW, lowStakes: true, job: 'small build' });
  assert.equal(plain.source, 'router');
  assert.equal(job.source, 'router');
  assert.deepEqual(job.ranked.map((engine) => engine.id), plain.ranked.map((engine) => engine.id));
  const normal = resolveEngineForRoleRanked('executor', root, { now: NOW });
  const normalJob = resolveEngineForRoleRanked('executor', root, { now: NOW, job: 'small build' });
  assert.deepEqual(normalJob.ranked.map((engine) => engine.id), normal.ranked.map((engine) => engine.id));
  assert.equal(readEngineRegistry(root).roster, undefined);
}));
