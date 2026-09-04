'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { INTENTS, matchIntent } = require('../lib/intents');
const { knownCommands } = require('../lib/known-commands');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-guide-test-'));

test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-guide-test-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runCli(args, { cwd = scratch } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' },
  });
  if (result.error) throw result.error;
  return result;
}

function runGuide(args) {
  return runCli(['guide', ...args]);
}

test('fresh init boot offers the say row while keeping seeded backlog work', () => {
  const dir = makeTempDir();
  try {
    const git = spawnSync('git', ['init'], { cwd: dir, encoding: 'utf8' });
    assert.equal(git.status, 0, `stdout:\n${git.stdout}\nstderr:\n${git.stderr}`);

    const init = runCli(['init', '--yes'], { cwd: dir });
    assert.equal(init.status, 0, `stdout:\n${init.stdout}\nstderr:\n${init.stderr}`);

    const boot = runCli(['atris.md'], { cwd: dir });
    assert.equal(boot.status, 0, `stdout:\n${boot.stdout}\nstderr:\n${boot.stderr}`);
    assert.match(boot.stdout, /^  say\b.*what should i do next/m);
    assert.match(boot.stdout, /^  next\b/m);
  } finally {
    cleanupTempDir(dir);
  }
});

test('guide --json returns the shared intent map', () => {
  const result = runGuide(['--json']);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload, { intents: INTENTS });
  assert.ok(payload.intents.length >= 16);
  payload.intents.forEach((intent) => {
    assert.equal(typeof intent.id, 'string');
    assert.ok(intent.say.length >= 3 && intent.say.length <= 6);
    intent.say.forEach((phrase) => assert.equal(phrase, phrase.toLowerCase()));
    assert.equal(typeof intent.do, 'string');
    assert.equal(typeof intent.plain, 'string');
    assert.equal(intent.plain, intent.plain.toLowerCase());
    assert.ok(['boot_empty', 'after_landing', 'always'].includes(intent.offer));
  });
});

test('every command in the intent map is registered', () => {
  INTENTS.forEach((intent) => {
    if (intent.file) {
      assert.equal(intent.do, 'read atris/MAP.md');
      return;
    }
    const words = intent.do.split(/\s+/);
    assert.equal(words[0], 'atris', intent.id);
    assert.ok(knownCommands.includes(words[1]), `${intent.id} uses unknown command ${words[1]}`);
  });
});

test('intent commands cannot skip consent', () => {
  INTENTS.forEach((intent) => {
    ['--yes', '--force', '-y'].forEach((flag) => {
      assert.equal(intent.do.includes(flag), false, `${intent.id} contains ${flag}`);
    });
  });
});

test('matchIntent finds everyday requests by token overlap', () => {
  const cases = [
    ['what should i do next', 'next_work'],
    ['run overnight', 'keep_going'],
    ['please make this faster for me', 'improve_one_thing'],
    ['could you catch me up on recent work', 'catch_up'],
    ['do not burn my credits', 'use_fewer_credits'],
    ['have someone else take this work', 'hand_off_work'],
    ['where does this live', 'find_or_explain'],
    ['we are trying to reduce support time', 'set_goal'],
  ];
  cases.forEach(([phrase, expected]) => {
    assert.equal(matchIntent(phrase).intent?.id, expected, phrase);
  });
  assert.equal(matchIntent('purple elephant').intent, null);
  assert.equal(matchIntent('purple elephant').alternatives.length, 3);
});

test('guide output stays lowercase and plain', () => {
  const result = runGuide([]);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /\u2014/);
  result.stdout.split(/\r?\n/).filter(Boolean).forEach((line) => {
    const letters = line.replace(/[^a-zA-Z]/g, '');
    assert.ok(!letters || letters !== letters.toUpperCase(), `all caps line: ${line}`);
  });
});

test('guide marks keep-going work as asking first', () => {
  const result = runGuide(['run overnight']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /asks you first/);
});

test('guide match prints one command and no more than two alternatives', () => {
  const result = runGuide(['please make this faster for me']);
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split(/\r?\n/);
  assert.equal(lines[0], INTENTS.find((intent) => intent.id === 'improve_one_thing').plain);
  assert.equal(lines[1], 'atris improve tick');
  assert.ok(lines.filter((line) => line.startsWith('"')).length <= 2);
});
