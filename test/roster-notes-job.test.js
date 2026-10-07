'use strict';

// The notes job: `atris engine resolve notes` always answers which engine
// writes YouTube notes, from the roster when a notes job is assigned, else
// from the built-in default.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { engineCommand } = require('../commands/engine');
const { RUNNER_PROFILE_DEFS } = require('../lib/runner-command');
const { NOTES_DEFAULT_WORKERS, readEngineRegistry } = require('../lib/engine-registry');

const NOW = new Date('2026-09-24T12:00:00.000Z');
const BIN = path.join(__dirname, '..', 'bin', 'atris.js');

// A scratch room whose engines.json already settles every engine, so no
// machine probe runs and installed is known. overrides: { id: { installed, status } }.
// A missing engine carries a fresh check stamp, so the hourly recheck waits.
function withRoom(fn, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-notes-room-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-notes-home-'));
  fs.mkdirSync(path.join(root, 'atris'));
  fs.mkdirSync(path.join(root, '.atris', 'state'), { recursive: true });
  const engines = Object.keys(RUNNER_PROFILE_DEFS).map((id) => {
    const o = overrides[id] || {};
    const status = o.status || 'ready';
    const health = status === 'not_installed' ? { status, checked_at: new Date().toISOString() } : { status };
    return { id, installed: o.installed !== undefined ? o.installed : true, health };
  });
  fs.writeFileSync(path.join(root, '.atris', 'state', 'engines.json'), JSON.stringify({ engines }, null, 2));
  const machineFile = path.join(home, '.atris', 'roster.json');
  const previous = process.env.ATRIS_MACHINE_ROSTER_PATH;
  process.env.ATRIS_MACHINE_ROSTER_PATH = machineFile;
  try { return fn(root, machineFile); } finally {
    if (previous === undefined) delete process.env.ATRIS_MACHINE_ROSTER_PATH;
    else process.env.ATRIS_MACHINE_ROSTER_PATH = previous;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
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

function resolveNotes(root, now = NOW) {
  const result = command(root, ['resolve', 'notes', '--json'], now);
  assert.equal(result.exit, 0, result.err);
  return JSON.parse(result.out);
}

test('no notes pick answers with the built-in default', () => withRoom((root) => {
  assert.deepEqual(resolveNotes(root), {
    job: 'notes',
    engine: 'agy',
    model: 'gemini-3.8-flash',
    effort: 'low',
    installed: true,
    backup: [{ engine: 'haiku', model: 'haiku', effort: null, installed: true }],
    source: 'default',
  });
}));

test('the default models are names from the agy and haiku catalogs', () => withRoom((root) => {
  const engines = readEngineRegistry(root, { persist: false }).engines;
  for (const worker of NOTES_DEFAULT_WORKERS) {
    const engine = engines.find((entry) => entry.id === worker.engine);
    assert.ok(engine.models.includes(worker.model), `${worker.engine} lists ${worker.model}`);
  }
}));

test('installed reads the saved registry, never a probe', () => withRoom((root) => {
  const answer = resolveNotes(root);
  assert.equal(answer.installed, true);
  assert.equal(answer.backup[0].installed, false);
}, { haiku: { installed: false, status: 'not_installed' } }));

test('an assigned notes job answers with its pick and backup', () => withRoom((root) => {
  const assigned = command(root, ['assign', 'notes', 'agy', '--model', 'gemini-3.8-flash-high', '--backup', 'claude haiku']);
  assert.equal(assigned.exit, 0, assigned.err);
  assert.match(assigned.out, /^notes +agy · gemini-3\.8-flash-high +claude · haiku /m);
  assert.deepEqual(resolveNotes(root), {
    job: 'notes',
    engine: 'agy',
    model: 'gemini-3.8-flash-high',
    effort: null,
    installed: true,
    backup: [{ engine: 'claude', model: 'haiku', effort: null, installed: true }],
    source: 'roster',
    from: 'this project',
  });
  const roster = command(root, ['roster']);
  assert.equal(roster.exit, 0);
  assert.match(roster.out, /^notes\s+agy/m);
}));

test('notes on agy at low effort is accepted and resolves with that effort', () => withRoom((root) => {
  const assigned = command(root, ['assign', 'notes', 'agy', '--model', 'gemini-3.8-flash', '--effort', 'low']);
  assert.equal(assigned.exit, 0, assigned.err);
  assert.match(fs.readFileSync(path.join(root, 'atris', 'ROSTER.md'), 'utf8'), /## notes \(like search\)\n- agy, model: gemini-3\.8-flash, effort: low/);
  const answer = resolveNotes(root);
  assert.equal(answer.source, 'roster');
  assert.equal(answer.engine, 'agy');
  assert.equal(answer.model, 'gemini-3.8-flash');
  assert.equal(answer.effort, 'low');
  assert.deepEqual(answer.backup, []);
}));

test('an expired notes lead is skipped and its backup leads', () => withRoom((root) => {
  const assigned = command(root, ['assign', 'notes', 'agy', '--model', 'gemini-3.8-flash', '--days', '1']);
  assert.equal(assigned.exit, 0, assigned.err);
  const added = command(root, ['assign', 'notes', 'haiku', '--add']);
  assert.equal(added.exit, 0, added.err);
  const later = new Date('2026-10-01T12:00:00.000Z');
  const answer = resolveNotes(root, later);
  assert.equal(answer.source, 'roster');
  assert.equal(answer.engine, 'haiku');
  assert.deepEqual(answer.backup, []);
}));

test('a notes pick with no ready worker falls through to the default', () => withRoom((root) => {
  command(root, ['assign', 'notes', 'agy', '--days', '1']);
  const answer = resolveNotes(root, new Date('2026-10-01T12:00:00.000Z'));
  assert.equal(answer.source, 'default');
  assert.equal(answer.engine, 'agy');
  assert.match(answer.skipped, /this project/);
}));

test('other jobs keep their kind check', () => withRoom((root) => {
  const search = command(root, ['assign', 'search', 'agy']);
  assert.equal(search.exit, 2);
  assert.match(search.err, /agy cannot do search/);
  const custom = command(root, ['assign', 'scribe', 'agy', '--like', 'search']);
  assert.equal(custom.exit, 2);
  assert.match(custom.err, /agy cannot do search work/);
}));

test('the plain answer is one line', () => withRoom((root) => {
  const plain = command(root, ['resolve', 'notes']);
  assert.equal(plain.exit, 0);
  assert.equal(plain.out, 'notes: agy (gemini-3.8-flash, effort low), backup haiku (haiku), built-in default');
  command(root, ['assign', 'notes', 'agy', '--model', 'gemini-3.8-flash', '--effort', 'low', '--backup', 'claude haiku']);
  assert.equal(command(root, ['resolve', 'notes']).out, 'notes: agy (gemini-3.8-flash, effort low), backup claude (haiku), from this project');
}));

test('the real command prints the JSON on stdout and exits 0', () => withRoom((root, machineFile) => {
  const run = spawnSync(process.execPath, [BIN, 'engine', 'resolve', 'notes', '--json'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ATRIS_MACHINE_ROSTER_PATH: machineFile, ATRIS_ROSTER_SESSIONS_DIR: path.join(path.dirname(machineFile), 'sessions') },
  });
  assert.equal(run.status, 0, run.stderr);
  const answer = JSON.parse(run.stdout);
  assert.deepEqual(Object.keys(answer), ['job', 'engine', 'model', 'effort', 'installed', 'backup', 'source']);
  assert.equal(typeof answer.installed, 'boolean');
  assert.equal(answer.source, 'default');
}));

test('build still resolves to the full engine record', () => withRoom((root) => {
  command(root, ['assign', 'build', 'codex']);
  const build = command(root, ['resolve', 'build', '--json']);
  assert.equal(build.exit, 0, build.err);
  const answer = JSON.parse(build.out);
  assert.equal(answer.id, 'codex');
  assert.equal(answer.bin, 'codex');
  assert.ok(Array.isArray(answer.roles));
  assert.match(answer.won_reason, /roster pick for build: codex/);
  assert.equal(answer.source, undefined);
}));
