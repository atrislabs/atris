'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const TIMEOUT_MS = 15000;

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-log-inbox-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function seedWorkspace(dir) {
  fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
}

function localJournal(dir) {
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return path.join(dir, 'atris', 'logs', year, `${year}-${month}-${day}.md`);
}

function runCli(args, { cwd, env, timeout = TIMEOUT_MS, input = '' } = {}) {
  const home = env && env.HOME ? env.HOME : makeTempDir();
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    input,
    encoding: 'utf8',
    timeout,
    env: {
      ...process.env,
      HOME: home,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      ATRIS_NO_INTERACTIVE: '1',
      ATRIS_NONINTERACTIVE: '1',
      ...(env || {}),
    },
  });
  if (result.error && result.error.code === 'ETIMEDOUT') {
    assert.fail(`cli hung past ${timeout}ms (args: ${args.join(' ')})`);
  }
  if (result.error) throw result.error;
  return result;
}

function writeFakeLogin(home) {
  const credDir = path.join(home, '.atris');
  fs.mkdirSync(credDir, { recursive: true });
  fs.writeFileSync(path.join(credDir, 'credentials.json'), JSON.stringify({
    token: 'test-token',
    email: 'dogfood@example.com',
    user_id: 'u-1',
    provider: 'manual',
  }));
}

test('atris log text captures a one-word idea locally', () => {
  const dir = makeTempDir();
  const home = makeTempDir();
  try {
    seedWorkspace(dir);
    writeFakeLogin(home);
    const res = runCli(['log', 'friction'], { cwd: dir, env: { HOME: home } });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /captured I1: friction/);
    assert.doesNotMatch(`${res.stdout}\n${res.stderr}`, /Business .*not found/i);
    assert.doesNotMatch(`${res.stdout}\n${res.stderr}`, /Not logged in/i);

    const journal = fs.readFileSync(localJournal(dir), 'utf8');
    assert.match(journal, /## Inbox/);
    assert.match(journal, /- \*\*I1:\*\* friction/);
  } finally {
    cleanupTempDir(dir);
    cleanupTempDir(home);
  }
});

test('atris log text --json emits real JSON and writes inbox', () => {
  const dir = makeTempDir();
  const home = makeTempDir();
  try {
    seedWorkspace(dir);
    writeFakeLogin(home);
    const res = runCli(['log', 'capture', '--json'], { cwd: dir, env: { HOME: home } });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.action, 'inbox_capture');
    assert.equal(payload.id, 'I1');
    assert.equal(payload.note, 'capture');
    assert.equal(payload.next_command, 'atris logs');
    assert.match(String(payload.journal), /atris\/logs\/\d{4}\/\d{4}-\d{2}-\d{2}\.md/);
    assert.doesNotMatch(`${res.stdout}\n${res.stderr}`, /Business .*not found/i);

    const journal = fs.readFileSync(localJournal(dir), 'utf8');
    assert.match(journal, /- \*\*I1:\*\* capture/);
  } finally {
    cleanupTempDir(dir);
    cleanupTempDir(home);
  }
});

test('atris log --json without a note is real JSON', () => {
  const dir = makeTempDir();
  try {
    seedWorkspace(dir);
    const res = runCli(['log', '--json'], { cwd: dir, input: '' });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /Daily log REPL needs a terminal/);
    assert.equal(payload.next_command, 'atris log "note"');
  } finally {
    cleanupTempDir(dir);
  }
});

test('log help names local inbox, not a live business slug', () => {
  const res = runCli(['log', '--help'], { cwd: makeTempDir() });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Usage: atris log/);
  assert.match(res.stdout, /--json/);
  assert.match(res.stdout, /No live business required/);
  assert.doesNotMatch(res.stdout, /business-slug|business log history/i);
});

test('atris log in an uninitialized folder talks like first-minute', () => {
  const dir = makeTempDir();
  const home = makeTempDir();
  try {
    const minute = runCli([], { cwd: dir, env: { HOME: home, USER: 'keshav' } });
    const res = runCli(['log', 'friction'], { cwd: dir, env: { HOME: home, USER: 'keshav' } });
    assert.equal(minute.status, 0, minute.stderr || minute.stdout);
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.equal(res.stdout.trim(), minute.stdout.trim());
    assert.match(res.stdout, /this folder is empty/);
    assert.match(res.stdout, /^next: atris "what do you want here\?"$/m);
    assert.doesNotMatch(`${res.stdout}\n${res.stderr}`, /folder not found|Run "atris init"|captured I/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
    assert.equal(fs.existsSync(path.join(dir, 'atris', 'logs')), false);

    const json = runCli(['log', 'friction', '--json'], { cwd: dir, env: { HOME: home, USER: 'keshav' } });
    const jsonMinute = runCli(['--json'], { cwd: dir, env: { HOME: home, USER: 'keshav' } });
    assert.equal(json.status, jsonMinute.status);
    assert.deepEqual(JSON.parse(json.stdout), JSON.parse(jsonMinute.stdout));
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
    assert.equal(fs.existsSync(path.join(dir, 'atris', 'logs')), false);
  } finally {
    cleanupTempDir(dir);
    cleanupTempDir(home);
  }
});
