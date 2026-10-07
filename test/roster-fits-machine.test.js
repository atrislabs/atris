'use strict';

// The roster fits each machine: with no pick, every job goes to the best tool
// installed here, search to haiku when claude code is installed, and the
// hosted atris-fast takes the search or review no installed tool can, only
// for someone logged in. A missing tool is looked for again after a minute. A job that
// lands somewhere other than its pick says so in one line.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  readEngineRegistry,
  engineRegistryFile,
  resolveEngineForRoleRanked,
  setRosterPick,
  engineDoctorReport,
} = require('../lib/engine-registry');
const { resolveMissionTickRunner } = require('../commands/mission');

// A fresh room on a machine that has only the named tools: a scratch bin
// folder of stub scripts and a PATH that sees nothing else.
function onMachine(tools, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-fits-room-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-fits-home-'));
  const bin = path.join(home, 'bin');
  fs.mkdirSync(path.join(root, 'atris'));
  fs.mkdirSync(bin);
  for (const tool of tools) fs.writeFileSync(path.join(bin, tool), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const saved = { PATH: process.env.PATH, roster: process.env.ATRIS_MACHINE_ROSTER_PATH };
  process.env.PATH = `${bin}${path.delimiter}/usr/bin${path.delimiter}/bin`;
  process.env.ATRIS_MACHINE_ROSTER_PATH = path.join(home, '.atris', 'roster.json');
  try {
    return fn(root, bin);
  } finally {
    process.env.PATH = saved.PATH;
    if (saved.roster === undefined) delete process.env.ATRIS_MACHINE_ROSTER_PATH;
    else process.env.ATRIS_MACHINE_ROSTER_PATH = saved.roster;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// What each job picks and the notice it carries, with stderr kept quiet.
function jobs(root, loggedIn) {
  const out = {};
  for (const [job, role] of [['search', 'navigator'], ['build', 'executor'], ['review', 'validator']]) {
    const picked = resolveEngineForRoleRanked(role, root, { loggedIn, quiet: true });
    out[job] = { engine: picked.engine ? picked.engine.id : null, notice: picked.notice };
  }
  return out;
}

test('only claude code: haiku searches, claude builds and reviews, nothing switches', () => onMachine(['claude'], (root) => {
  const picked = jobs(root, false);
  assert.deepEqual(picked, {
    search: { engine: 'haiku', notice: '' },
    build: { engine: 'claude', notice: '' },
    review: { engine: 'claude', notice: '' },
  });
  // Logged in changes nothing while an installed tool can take the job.
  assert.deepEqual(jobs(root, true), picked);
}));

test('only codex: codex builds, atris-fast takes search and review only when logged in', () => onMachine(['codex', 'ax'], (root) => {
  const out = jobs(root, true);
  assert.equal(out.build.engine, 'codex');
  assert.equal(out.build.notice, '');
  assert.equal(out.search.engine, 'atris-fast');
  assert.equal(out.search.notice, 'search: claude code is not installed, so atris 2.5 fast took it (uses your atris tokens).');
  assert.equal(out.review.engine, 'atris-fast');
  assert.equal(out.review.notice, 'review: no tool here can take it, so atris 2.5 fast took it (uses your atris tokens).');
  const loggedOut = jobs(root, false);
  assert.equal(loggedOut.build.engine, 'codex');
  assert.equal(loggedOut.search.engine, null);
  assert.equal(loggedOut.search.notice, 'search: no tool here can take it. install claude code, or run atris login so atris 2.5 fast can take it.');
}));

test('nothing installed but logged in: atris-fast takes search and review, never build, which says it plainly', () => onMachine(['ax'], (root) => {
  const out = jobs(root, true);
  assert.equal(out.search.engine, 'atris-fast');
  assert.equal(out.review.engine, 'atris-fast');
  assert.equal(out.review.notice, 'review: no tool here can take it, so atris 2.5 fast took it (uses your atris tokens).');
  // The hosted relay cannot write files here, so a hosted build would change
  // nothing. Build stays unpicked and says so.
  assert.equal(out.build.engine, null);
  assert.equal(out.build.notice, 'build: no tool here can take it. install claude code or codex; atris 2.5 fast cannot edit files yet.');
  const tick = resolveMissionTickRunner({ runner: 'auto' }, root, { loggedIn: true, quiet: true });
  assert.equal(tick.engine_id, null);
}));

test('nothing installed and not logged in: no job is picked, and each says what to install or atris login', () => onMachine(['ax'], (root) => {
  const out = jobs(root, false);
  assert.deepEqual(Object.values(out).map((job) => job.engine), [null, null, null]);
  assert.equal(out.search.notice, 'search: no tool here can take it. install claude code, or run atris login so atris 2.5 fast can take it.');
  assert.equal(out.build.notice, 'build: no tool here can take it. install claude code or codex; atris 2.5 fast cannot edit files yet.');
  const tick = resolveMissionTickRunner({ runner: 'auto' }, root, { loggedIn: false, quiet: true });
  assert.equal(tick.engine_id, null);
}));

test('an explicit roster pick wins over haiku and atris-fast, and a missing pick says who took it', () => onMachine(['claude', 'codex', 'ax'], (root) => {
  setRosterPick('search', 'claude', { model: 'claude-opus-5-5', days: 30 }, root);
  setRosterPick('build', 'codex', { days: 30 }, root);
  const picked = resolveEngineForRoleRanked('navigator', root, { loggedIn: true, quiet: true });
  assert.equal(picked.engine.id, 'claude');
  assert.equal(picked.engine.roster_model, 'claude-opus-5-5');
  assert.equal(picked.notice, '');
  assert.equal(resolveEngineForRoleRanked('executor', root, { loggedIn: true, quiet: true }).engine.id, 'codex');

  // The same roster on a machine where claude code is gone.
  const file = engineRegistryFile(root);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const entry of saved.engines) {
    if (['claude', 'haiku', 'fable'].includes(entry.id)) {
      entry.installed = false;
      entry.health = { status: 'not_installed', checked_at: new Date().toISOString() };
    }
  }
  fs.writeFileSync(file, `${JSON.stringify(saved)}\n`);
  const switched = resolveEngineForRoleRanked('navigator', root, { loggedIn: true, quiet: true });
  assert.equal(switched.engine.id, 'atris-fast');
  assert.equal(switched.notice, 'search: claude code is not installed, so atris 2.5 fast took it (uses your atris tokens).');
}));

test('a notice prints once per run, on stderr, however often the job resolves', () => onMachine(['ax'], (root) => {
  const lines = [];
  const original = console.error;
  console.error = (line) => lines.push(String(line));
  try {
    for (let i = 0; i < 3; i += 1) resolveEngineForRoleRanked('validator', root, { loggedIn: true, job: 'second look review' });
  } finally {
    console.error = original;
  }
  const notices = lines.filter((line) => line.includes('atris 2.5 fast took it'));
  assert.deepEqual(notices, ['second look review: no tool here can take it, so atris 2.5 fast took it (uses your atris tokens).']);
}));

test('a saved not_installed is rechecked once its check is a minute old, and doctor clears it', () => onMachine([], (root, bin) => {
  readEngineRegistry(root);
  const file = engineRegistryFile(root);
  const codexHealth = () => JSON.parse(fs.readFileSync(file, 'utf8')).engines.find((entry) => entry.id === 'codex').health;
  assert.equal(codexHealth().status, 'not_installed');
  assert.ok(codexHealth().checked_at, 'the first look is stamped');

  // Codex arrives. Within the minute the saved answer stands, no probe.
  fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  assert.equal(readEngineRegistry(root).engines.find((entry) => entry.id === 'codex').health.status, 'not_installed');

  // A minute later the next read looks again and finds it.
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  saved.engines.find((entry) => entry.id === 'codex').health.checked_at = new Date(Date.now() - 61000).toISOString();
  fs.writeFileSync(file, `${JSON.stringify(saved)}\n`);
  assert.equal(resolveEngineForRoleRanked('executor', root, { loggedIn: false, quiet: true }).engine.id, 'codex');
  assert.equal(codexHealth().status, 'ready');

  // Doctor clears a fresh not_installed at once when the tool is there.
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).engines.find((entry) => entry.id === 'claude').health.status, 'not_installed');
  const doctored = engineDoctorReport(root).find((entry) => entry.id === 'claude');
  assert.equal(doctored.installed, true);
  assert.equal(doctored.health.status, 'ready');
}));
