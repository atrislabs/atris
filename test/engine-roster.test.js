'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { engineCommand } = require('../commands/engine');
const { resolveMissionTickRunner } = require('../commands/mission');
const {
  engineRegistryFile,
  readEngineRegistry,
  resolveEngineForRoleRanked,
  setEngineHealth,
  setRosterPick,
  confirmRoster,
} = require('../lib/engine-registry');

const NOW = new Date('2026-09-24T12:00:00.000Z');

function withRoom(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-roster-test-'));
  fs.mkdirSync(path.join(root, 'atris'));
  try { return fn(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
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
  assert.match(before.out, /build\s+claude \(opus 5\.5\).*backup codex.*until sep 25/);
  const json = command(root, ['roster', '--json']);
  assert.equal(json.exit, 0, json.err);
  assert.equal(JSON.parse(json.out).jobs.length, 3);
  const confirmed = command(root, ['roster', 'confirm'], '2026-09-27T12:00:00Z');
  assert.equal(confirmed.exit, 0, confirmed.err);
  assert.equal(readEngineRegistry(root).roster.executor.until, '2026-10-27');
  assert.equal(readEngineRegistry(root).roster.validator.until, '2026-10-27');
  const bare = command(root, []);
  assert.ok(bare.out.indexOf('search') < bare.out.indexOf('engines:'));
  confirmRoster(root, '2026-10-01T00:00:00Z');
  assert.equal(readEngineRegistry(root).roster.executor.until, '2026-10-31');
}));
