'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const TIMEOUT_MS = 20000;

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-dogfood-papercuts-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runCli(args, { cwd, env, timeout = TIMEOUT_MS, input } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    input,
    encoding: 'utf8',
    timeout,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      ATRIS_NO_INTERACTIVE: '1',
      ...(env || {}),
    },
  });
  if (result.error && result.error.code === 'ETIMEDOUT') {
    assert.fail(`cli hung past ${timeout}ms (args: ${args.join(' ')})`);
  }
  if (result.error) throw result.error;
  return result;
}

function todayJournal(dir) {
  const year = String(new Date().getFullYear());
  const day = new Date().toISOString().slice(0, 10);
  return path.join(dir, 'atris', 'logs', year, `${day}.md`);
}

test('default help is short; help --all is long; help --json lists commands', () => {
  const shortHelp = runCli(['help']);
  assert.equal(shortHelp.status, 0, shortHelp.stderr);
  const shortLines = shortHelp.stdout.split(/\r?\n/).filter((line) => line.trim()).length;
  assert.ok(shortLines <= 16, `expected <=16 non-empty lines, got ${shortLines}`);
  assert.match(shortHelp.stdout, /already won\. one next step/);
  assert.match(shortHelp.stdout, /atris later "/);
  assert.match(shortHelp.stdout, /atris do\b/);
  assert.match(shortHelp.stdout, /Keep working/);
  assert.match(shortHelp.stdout, /atris mission/);

  const allHelp = runCli(['help', '--all']);
  assert.equal(allHelp.status, 0, allHelp.stderr);
  assert.ok(allHelp.stdout.length > shortHelp.stdout.length * 3);
  assert.match(allHelp.stdout, /^you say what you want\. already won\. one next step\./);
  assert.match(allHelp.stdout, /atris later "/);
  assert.match(allHelp.stdout, /atris recap/);
  assert.match(allHelp.stdout, /atris review/);
  assert.match(allHelp.stdout, /atris stop\b/);
  assert.doesNotMatch(allHelp.stdout, /━|shows you proof|Quick start:|load context \(MAP, tasks, journal\)/);
  assert.match(allHelp.stdout, /golden path \(one tick/);

  const jsonHelp = runCli(['help', '--json']);
  assert.equal(jsonHelp.status, 0, jsonHelp.stderr);
  const payload = JSON.parse(jsonHelp.stdout);
  assert.equal(payload.ok, true);
  assert.ok(Array.isArray(payload.commands));
  assert.ok(payload.commands.some((row) => row.name === 'task' && row.json === true));
  assert.ok(payload.commands.some((row) => row.name === 'log' && row.json === true));
});

test('engine --help prints usage, not the roster', () => {
  const res = runCli(['engine', '--help']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /atris engine/);
  assert.match(res.stdout, /roster \+ current default/);
  assert.doesNotMatch(res.stdout, /engines: \d+ intelligences found/);
  assert.doesNotMatch(res.stdout, /→ atris-fast/);
});

test('log "an idea" lands in today Inbox without business lookup', () => {
  const dir = makeTempDir();
  try {
    assert.equal(runCli(['init', '--yes', '--minimal'], { cwd: dir, timeout: 60000 }).status, 0);
    const res = runCli(['log', 'an idea for later'], {
      cwd: dir,
      env: { ATRIS_NONINTERACTIVE: '1' },
      input: '',
    });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /captured I\d+: an idea for later/);
    assert.doesNotMatch(res.stdout + res.stderr, /Business not found/i);

    const journal = fs.readFileSync(todayJournal(dir), 'utf8');
    assert.match(journal, /## Inbox/);
    assert.match(journal, /an idea for later/);

    const oneWord = runCli(['log', 'friction'], {
      cwd: dir,
      env: { ATRIS_NONINTERACTIVE: '1' },
      input: '',
    });
    assert.equal(oneWord.status, 0, oneWord.stderr || oneWord.stdout);
    assert.match(oneWord.stdout, /captured I\d+: friction/);
    assert.doesNotMatch(oneWord.stdout + oneWord.stderr, /Business not found/i);
    assert.match(fs.readFileSync(todayJournal(dir), 'utf8'), /friction/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('learn log accepts title/detail aliases and prints schema on bad args', () => {
  const dir = makeTempDir();
  try {
    assert.equal(runCli(['init', '--yes', '--minimal'], { cwd: dir, timeout: 60000 }).status, 0);

    const ok = runCli([
      'learn',
      'log',
      JSON.stringify({
        type: 'pattern',
        title: 'map-first',
        detail: 'check MAP.md before grep',
        confidence: 8,
      }),
    ], { cwd: dir });
    assert.equal(ok.status, 0, ok.stderr || ok.stdout);
    assert.match(ok.stdout, /map-first/);

    const help = runCli(['learn', '--help'], { cwd: dir });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /title→key/);
    assert.match(help.stdout, /detail→insight/);
    assert.match(help.stdout, /Schema:/);

    const bad = runCli(['learn', 'log', '{"title":"only-title"}'], { cwd: dir });
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /Schema:/);
    assert.match(bad.stderr, /title→key/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('init --yes --minimal skips skills catalog and root CLAUDE.md', () => {
  const dir = makeTempDir();
  try {
    const init = runCli(['init', '--yes', '--minimal'], { cwd: dir, timeout: 60000 });
    assert.equal(init.status, 0, init.stderr || init.stdout);
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'atris.md')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'MAP.md')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'TODO.md')));
    assert.ok(fs.existsSync(todayJournal(dir)));
    assert.ok(fs.existsSync(path.join(dir, '.atris', 'state')));

    assert.equal(fs.existsSync(path.join(dir, 'CLAUDE.md')), false);
    assert.equal(fs.existsSync(path.join(dir, 'AGENTS.md')), false);
    assert.equal(fs.existsSync(path.join(dir, '.cursorrules')), false);
    assert.equal(fs.existsSync(path.join(dir, '.claude', 'skills')), false);
    assert.equal(fs.existsSync(path.join(dir, 'atris', 'skills')), false);
    assert.equal(fs.existsSync(path.join(dir, 'atris', 'team', 'navigator')), false);

    const skillsInstalled = (init.stdout.match(/skills installed \((\d+)\)/) || [])[1];
    if (skillsInstalled !== undefined) {
      assert.equal(skillsInstalled, '0');
    }
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission start --owner executor keeps existing member owner', () => {
  const dir = makeTempDir();
  try {
    assert.equal(runCli(['init', '--yes'], { cwd: dir, timeout: 60000 }).status, 0);
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'team', 'executor', 'MEMBER.md')));

    const started = runCli([
      'mission', 'start',
      'keep executor as owner for this dogfood check',
      '--owner', 'executor',
      '--no-verify',
      '--json',
    ], { cwd: dir });
    assert.equal(started.status, 0, started.stderr || started.stdout);
    const payload = JSON.parse(started.stdout);
    assert.equal(payload.mission.owner, 'executor');
    assert.equal(payload.mission.owner_resolution, 'explicit_member_owner');
    assert.equal(payload.remap_reason, undefined);
    assert.equal(payload.mission.remap_reason, undefined);
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission start remaps missing engine owner with remap_reason', () => {
  const dir = makeTempDir();
  try {
    assert.equal(runCli(['init', '--yes', '--minimal'], { cwd: dir, timeout: 60000 }).status, 0);
    // minimal has no team members, so engine name "codex" must remap
    const started = runCli([
      'mission', 'start',
      'prove remap reason is documented',
      '--owner', 'codex',
      '--no-verify',
      '--json',
    ], { cwd: dir });
    assert.equal(started.status, 0, started.stderr || started.stdout);
    const payload = JSON.parse(started.stdout);
    assert.notEqual(payload.mission.owner, 'codex');
    assert.equal(payload.mission.requested_owner, 'codex');
    assert.ok(payload.remap_reason || payload.mission.remap_reason);
    assert.match(String(payload.remap_reason || payload.mission.remap_reason), /Override:/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('skill list disables ANSI color when stdout is not a TTY', () => {
  const dir = makeTempDir();
  try {
    assert.equal(runCli(['init', '--yes'], { cwd: dir, timeout: 60000 }).status, 0);
    const res = runCli(['skill', 'list'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.doesNotMatch(res.stdout, /\x1b\[/);
  } finally {
    cleanupTempDir(dir);
  }
});
