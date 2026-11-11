'use strict';

// When the owner's engine gives a campaign nothing, the stall names the
// engine and says why, then ends in one next step. These run the real atris
// binary in a scratch project with a stand-in codex on PATH and a clean home.
// Engine resolution and the ask runner are the real ones.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const cliPath = path.resolve(__dirname, '..', 'bin', 'atris.js');

function project(t, codexScript) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-engine-stall-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  const home = path.join(base, 'home');
  const bin = path.join(base, 'bin');
  for (const dir of [root, home, bin]) fs.mkdirSync(dir, { recursive: true });
  if (codexScript) {
    fs.writeFileSync(path.join(bin, 'codex'), codexScript, 'utf8');
    fs.chmodSync(path.join(bin, 'codex'), 0o755);
  }
  // Only the stand-in bin and the system folders: no real engine is found.
  const env = {
    HOME: home,
    PATH: [bin, '/usr/bin', '/bin'].join(path.delimiter),
    TMPDIR: os.tmpdir(),
    ATRIS_SKIP_UPDATE_CHECK: '1',
    NODE_NO_WARNINGS: '1',
  };
  spawnSync('git', ['init', '-q'], { cwd: root, env });
  const atris = (args) => spawnSync(process.execPath, [cliPath, ...args], { cwd: root, env, encoding: 'utf8', timeout: 60000 });
  return { root, atris };
}

const EMPTY_CODEX = '#!/bin/sh\nexit 0\n';

test('campaign new names the engine that sent back nothing and how to go on by hand', (t) => {
  const { atris } = project(t, EMPTY_CODEX);
  const ran = atris(['campaign', 'new', 'make the tests pass']);
  assert.equal(ran.status, 1, ran.stdout + ran.stderr);
  assert.match(ran.stderr, /mission-lead's engine is codex and codex ran but sent back nothing/);
  assert.match(ran.stderr, /next: write the judge yourself: atris campaign start 'make the tests pass' --judge "<command that fails today>" --budget 20/);

  const json = JSON.parse(atris(['campaign', 'new', 'make the tests pass', '--json']).stdout.trim().split('\n').pop());
  assert.equal(json.ok, false);
  assert.equal(json.engine, 'codex');
  assert.equal(json.cause, 'empty');
  assert.match(json.next, /^write the judge yourself: atris campaign start /);
});

test('campaign new says when the engine is not signed in and how to sign in', (t) => {
  const { atris } = project(t, '#!/bin/sh\necho "Not logged in. Run codex login." >&2\nexit 1\n');
  const ran = atris(['campaign', 'new', 'make the tests pass']);
  assert.equal(ran.status, 1, ran.stdout + ran.stderr);
  assert.match(ran.stderr, /mission-lead's engine is codex and codex is not signed in/);
  assert.match(ran.stderr, /next: run codex login, then run atris campaign new again/);
});

test('campaign new says when no engine is installed at all', (t) => {
  const { atris } = project(t, null);
  const ran = atris(['campaign', 'new', 'make the tests pass']);
  assert.equal(ran.status, 1, ran.stdout + ran.stderr);
  assert.match(ran.stderr, /no engine on this computer is ready to do mission-lead's work and the fallback claude is not installed/);
  assert.match(ran.stderr, /next: install codex or claude code, then run atris campaign new again/);
});

test('propose and step name the engine and give the command to add a mission by hand', (t) => {
  const { atris } = project(t, EMPTY_CODEX);
  const started = atris(['campaign', 'start', 'Tests pass', '--judge', 'exit 1', '--budget', '5', '--id', 'cmp-stall', '--json']);
  assert.equal(started.status, 0, started.stdout + started.stderr);

  const proposed = atris(['campaign', 'propose', 'cmp-stall']);
  assert.equal(proposed.status, 1, proposed.stdout + proposed.stderr);
  assert.match(proposed.stdout, /nothing usable was proposed: mission-lead's engine is codex and codex ran but sent back nothing/);
  assert.match(proposed.stdout, /next: add one yourself: atris mission start "<what to do next>" --campaign cmp-stall --owner mission-lead/);

  const stepped = JSON.parse(atris(['campaign', 'step', 'cmp-stall', '--json']).stdout.trim().split('\n').pop());
  assert.match(stepped.reason, /^mission-lead proposed nothing usable/);
  assert.match(stepped.reason, /codex ran but sent back nothing\. next: add one yourself: atris mission start /);
  assert.equal(stepped.engine, 'codex');
});
