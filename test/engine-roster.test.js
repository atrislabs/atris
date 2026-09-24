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
} = require('../lib/engine-registry');

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

function ready(root, ...names) {
  readEngineRegistry(root);
  for (const name of names) setEngineHealth(name, 'ready', root);
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
  const saved = readEngineRegistry(root).roster.executor;
  assert.deepEqual(saved, { engine: 'claude', model: 'claude-opus-5-5', backup: 'codex', until: '2026-10-24', set_at: NOW.toISOString() });
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
  assert.equal(readEngineRegistry(root).roster.executor, undefined);
  assert.equal(resolveEngineForRoleRanked('executor', root, { now: NOW }).engine.id, 'codex');
  assert.match(command(root, ['assign', 'fishing', 'codex']).err, /unknown job.*search, build, review/);
  assert.match(command(root, ['assign', 'search', 'codex']).err, /codex cannot do search/);
  assert.match(command(root, ['assign', 'build', 'unknown']).err, /unknown engine/);
}));

test('a registry normalization rewrite preserves roster, unknown keys, and engine entries', () => withRoom((root) => {
  ready(root, 'codex');
  setRosterPick('build', 'codex', { now: NOW }, root);
  const file = engineRegistryFile(root);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
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
  assert.equal(before.out.trim().split('\n').length, 3);
  assert.match(before.out, /search\s+no pick, router decides \(atris-fast\)/);
  assert.match(before.out, /build\s+claude \(opus 5\.5\).*backup codex.*until sep 25, this project/);
  const json = command(root, ['roster', '--json']);
  assert.equal(json.exit, 0, json.err);
  assert.equal(JSON.parse(json.out).jobs.length, 3);
  const confirmed = command(root, ['roster', 'confirm'], '2026-09-27T12:00:00Z');
  assert.equal(confirmed.exit, 0, confirmed.err);
  assert.equal(readEngineRegistry(root).roster.executor.until, '2026-10-27');
  assert.equal(readEngineRegistry(root).roster.validator.until, '2026-10-27');
  const bare = command(root, []);
  assert.ok(bare.out.indexOf('search') < bare.out.indexOf('engines:'));
  confirmRoster(root, '2026-10-01T12:00:00Z');
  assert.equal(readEngineRegistry(root).roster.executor.until, '2026-10-31');
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
    assert.equal(readEngineRegistry(root).roster.validator.model, saved, typed);
    assert.ok(result.out.includes(`${engine} (${shown})`), `${typed}: ${result.out}`);
  }
}));

test('a claude model the cli would reject is refused at assign, other engines save as typed', () => withRoom((root) => {
  ready(root, 'claude', 'codex');
  const refused = command(root, ['assign', 'build', 'claude', '--model', 'gpt-6-sol']);
  assert.equal(refused.exit, 2);
  assert.match(refused.err, /claude does not know the model "gpt-6-sol"\. use opus, sonnet, haiku/);
  assert.equal(readEngineRegistry(root).roster, undefined);
  assert.throws(() => normalizeRosterModel('fable', 'opus five'), /fable does not know the model/);
  const codex = command(root, ['assign', 'build', 'codex', '--model', 'gpt-6-sol']);
  assert.equal(codex.exit, 0, codex.err);
  assert.equal(readEngineRegistry(root).roster.executor.model, 'gpt-6-sol');
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
  assert.match(roster.out, /build\s+claude.*expired, router decides \(codex\), this project/);
}));

test('an all-projects pick applies where the project has none', () => withRoom((root, machineFile) => {
  ready(root, 'codex', 'claude', 'cursor');
  const assigned = command(root, ['assign', 'build', 'claude', '--model', 'opus 5.5', '--backup', 'cursor', '--everywhere']);
  assert.equal(assigned.exit, 0, assigned.err);
  assert.equal(readEngineRegistry(root).roster, undefined);
  const machine = JSON.parse(fs.readFileSync(machineFile, 'utf8'));
  assert.equal(machine.roster.executor.model, 'claude-opus-5-5');
  assert.equal(machine.roster.executor.until, '2026-10-24');
  const chosen = resolveEngineForRoleRanked('executor', root, { now: NOW });
  assert.equal(chosen.engine.id, 'claude');
  assert.equal(chosen.engine.roster_model, 'claude-opus-5-5');
  assert.equal(chosen.source, 'machine');
  assert.equal(chosen.reason, 'roster pick for build (all projects): claude');
  assert.match(assigned.out, /build\s+claude \(opus 5\.5\).*backup cursor.*until oct 24, all projects/);
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
  assert.equal(JSON.parse(fs.readFileSync(machineFile, 'utf8')).roster.executor, undefined);
  assert.equal(readEngineRegistry(root).roster.executor.engine, 'cursor');
  assert.equal(command(root, ['assign', 'build', '--clear']).exit, 0);
  assert.equal(resolveEngineForRoleRanked('executor', root, { now: NOW }).source, 'router');
}));

test('roster confirm renews this project and the all-projects picks', () => withRoom((root, machineFile) => {
  ready(root, 'codex', 'claude', 'haiku');
  setRosterPick('build', 'claude', { days: 1, now: NOW }, root);
  setRosterPick('review', 'haiku', { days: 1, now: NOW, everywhere: true }, root);
  assert.equal(command(root, ['roster', 'confirm'], '2026-09-27T12:00:00Z').exit, 0);
  assert.equal(readEngineRegistry(root).roster.executor.until, '2026-10-27');
  assert.equal(JSON.parse(fs.readFileSync(machineFile, 'utf8')).roster.validator.until, '2026-10-27');
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
