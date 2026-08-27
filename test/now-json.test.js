'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const TIMEOUT_MS = 20000;
const WIZARD_RE = /Describe the desired outcome|Craft the Story|Choice \(1-2\)|Log this brainstorm session/i;
const ANSI_RE = /\u001b\[/;
const MARKDOWN_NOW_RE = /^# now|## Current Priority|## What Matters Now/m;

function makeTempDir(prefix = 'atris-now-json-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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
      ...scrubAgentEnv(),
      ATRIS_SKIP_UPDATE_CHECK: '1',
      ATRIS_NO_INTERACTIVE: '1',
      ATRIS_NONINTERACTIVE: '1',
      NODE_NO_WARNINGS: '1',
      ...(env || {}),
    },
  });
  if (result.error && result.error.code === 'ETIMEDOUT') {
    assert.fail(`cli hung past ${timeout}ms (args: ${args.join(' ')})`);
  }
  if (result.error) throw result.error;
  return result;
}

function assertNowJson(result, { ok }) {
  assert.doesNotMatch(`${result.stdout || ''}\n${result.stderr || ''}`, WIZARD_RE);
  assert.doesNotMatch(result.stdout, ANSI_RE);
  assert.doesNotMatch(result.stdout, MARKDOWN_NOW_RE);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, ok);
  assert.ok(payload.next || payload.current);
  if (payload.next) assert.equal(typeof payload.next, 'string');
  if (payload.current) assert.equal(typeof payload.current, 'string');
  return payload;
}

test('now --json in a file folder names the file and does not mint', () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(dir, 'notes.md'), 'already writing\n', 'utf8');
  try {
    const spoken = runCli(['now'], {
      cwd: dir,
      env: { HOME: home, USER: 'keshav' },
      input: '',
    });
    assert.equal(spoken.status, 0, spoken.stderr || spoken.stdout);
    assert.match(spoken.stdout, /^hey keshav, notes.md is already here\.$/m);
    assert.match(spoken.stdout, /^next: atris do$/m);
    assert.doesNotMatch(spoken.stdout + spoken.stderr, /Run "atris init"|folder not found|# now|Current operating truth/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);

    const res = runCli(['now', '--json'], {
      cwd: dir,
      env: { HOME: home, USER: 'keshav' },
      input: '',
    });
    assert.equal(res.status, 2, res.stderr || res.stdout);
    const payload = assertNowJson(res, { ok: false });
    assert.equal(payload.current, 'notes.md is already here');
    assert.equal(payload.next, 'atris do');
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
    assert.equal(fs.existsSync(path.join(dir, '.atris')), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('now --json in an empty folder prints real JSON and does not mint', () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  try {
    const res = runCli(['now', '--json'], {
      cwd: dir,
      env: { HOME: home, USER: 'keshav' },
      input: '',
    });
    assert.equal(res.status, 2, res.stderr || res.stdout);
    const payload = assertNowJson(res, { ok: false });
    assert.match(String(payload.next || payload.current), /atris /);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
    assert.equal(fs.existsSync(path.join(dir, '.atris')), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('now --json after init prints ok plus next or current', () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const env = { HOME: home, USER: 'keshav' };
  try {
    assert.equal(runCli(['init', '--yes'], { cwd: dir, env, timeout: 60000 }).status, 0);
    const spoken = runCli(['now'], { cwd: dir, env });
    const minute = runCli([], { cwd: dir, env });
    assert.equal(spoken.status, 0, spoken.stderr || spoken.stdout);
    assert.equal(minute.status, 0, minute.stderr || minute.stdout);
    assert.equal(spoken.stdout.trim(), minute.stdout.trim());
    assert.doesNotMatch(spoken.stdout, MARKDOWN_NOW_RE);

    const res = runCli(['now', '--json'], { cwd: dir, env, input: '' });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const payload = assertNowJson(res, { ok: true });
    assert.ok(payload.next || payload.current);
    assert.notEqual(res.stdout.trim(), spoken.stdout.trim());
  } finally {
    cleanupTempDir(dir);
  }
});
