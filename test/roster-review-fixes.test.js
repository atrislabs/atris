'use strict';

// Five edge cases a reviewer found in the sectioned roster and the Ctrl-C
// guard. Every room is a scratch project with a scratch home, so the real
// ~/.atris and ~/.codex are never read or written.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  readEngineRegistry,
  readRosterState,
  resolveEngineForRoleRanked,
  setEngineHealth,
  setRosterPick,
} = require('../lib/engine-registry');

const NOW = new Date('2026-09-24T12:00:00.000Z');
const ENV_KEYS = [
  'ATRIS_MACHINE_ROSTER_PATH', 'ATRIS_MACHINE_ROSTER_MD_PATH', 'ATRIS_ROUTER_EXPLAIN', 'ATRIS_ROSTER_SESSION',
  'ATRIS_ROSTER_SESSIONS_DIR', 'ATRIS_CODEX_MODELS_CACHE_PATH', 'ATRIS_CODEX_CONFIG_PATH',
  'ATRIS_RUNNER_PROFILE', 'ATRIS_RUNNER_MODEL', 'ATRIS_RUNNER_BIN', 'ATRIS_RUNNER_COMMAND_TEMPLATE',
  'ATRIS_CLAUDE_MODEL', 'ATRIS_CLAUDE_BIN', 'ATRIS_CLAUDE_COMMAND_TEMPLATE',
];

function withRoom(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-roster-fixes-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-roster-fixes-home-'));
  fs.mkdirSync(path.join(root, 'atris'));
  const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.ATRIS_MACHINE_ROSTER_PATH = path.join(home, '.atris', 'roster.json');
  process.env.ATRIS_ROUTER_EXPLAIN = '0';
  const paths = { home, sessions: path.join(home, '.atris', 'sessions') };
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

function project(root) {
  return readRosterState(root, { now: NOW }).project;
}

// 1. Two session keys that clean up to the same text keep separate files.
test('session keys that sanitize the same still get their own files', () => withRoom((root, paths) => {
  ready(root, 'codex', 'claude', 'cursor');
  process.env.ATRIS_ROSTER_SESSION = 'shell/b';
  setRosterPick('build', 'codex', { session: true, now: NOW }, root);
  process.env.ATRIS_ROSTER_SESSION = 'shell-b';
  setRosterPick('build', 'cursor', { session: true, now: NOW }, root);
  const files = fs.readdirSync(paths.sessions).sort();
  assert.equal(files.length, 2, `expected two session files, got ${files.join(', ')}`);
  for (const key of ['shell/b', 'shell-b']) {
    const hash = crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);
    assert.ok(files.includes(`roster-shell-b-${hash}.md`), `missing the file for ${key}`);
  }
  assert.equal(resolveEngineForRoleRanked('executor', root, { now: NOW }).engine.id, 'cursor');
  process.env.ATRIS_ROSTER_SESSION = 'shell/b';
  assert.equal(resolveEngineForRoleRanked('executor', root, { now: NOW }).engine.id, 'codex');
  // Keys that only differ past the readable prefix stay apart too.
  const long = 'x'.repeat(100);
  process.env.ATRIS_ROSTER_SESSION = `${long}1`;
  setRosterPick('build', 'claude', { session: true, now: NOW }, root);
  process.env.ATRIS_ROSTER_SESSION = `${long}2`;
  assert.notEqual(resolveEngineForRoleRanked('executor', root, { now: NOW }).source, 'session');
  // A key full of path parts never leaves the sessions folder.
  process.env.ATRIS_ROSTER_SESSION = '../../escape';
  setRosterPick('build', 'codex', { session: true, now: NOW }, root);
  assert.deepEqual(fs.readdirSync(path.dirname(paths.sessions)).sort(), ['sessions']);
  for (const name of fs.readdirSync(paths.sessions)) assert.match(name, /^roster-[A-Za-z0-9_][A-Za-z0-9_.-]*\.md$/);
}));

// 2. Assign with --like on a job that already has a section writes the new kind.
test('assign --like on an existing job changes its kind, and the new worker resolves', () => withRoom((root) => {
  ready(root, 'codex', 'atris-fast', 'haiku');
  writeRoster(root, '# roster\n\n## quick fixes (like build)\n- codex\n\n## team\n');
  setRosterPick('quick fixes', 'atris-fast', { like: 'search', now: NOW }, root);
  assert.match(readRoster(root), /\n## quick fixes \(like search\)\n- atris fast\n/);
  const pick = project(root).picks['quick-fixes'];
  assert.equal(pick.like, 'search');
  assert.equal(pick.engine, 'atris-fast');
  assert.equal(resolveEngineForRoleRanked('navigator', root, { now: NOW, job: 'quick fixes' }).engine.id, 'atris-fast');
  // Removing a worker keeps the kind the section already has.
  setRosterPick('quick fixes', 'haiku', { add: true, now: NOW }, root);
  setRosterPick('quick fixes', null, { remove: 'haiku', now: NOW }, root);
  assert.match(readRoster(root), /\n## quick fixes \(like search\)\n- atris fast\n/);
}));
