'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');
const { parseInboxItems } = require('../lib/file-ops');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const TIMEOUT_MS = 8000;
const WIZARD_RE = /Describe the desired outcome|Craft the Story|Choice \(1-2\)|Log this brainstorm session/i;

function makeTempDir(prefix = 'atris-brainstorm-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function baseEnv(extra = {}) {
  const env = {
    ...scrubAgentEnv(),
    ATRIS_SKIP_UPDATE_CHECK: '1',
    ...extra,
  };
  delete env.ATRIS_NO_INTERACTIVE;
  delete env.ATRIS_NONINTERACTIVE;
  return env;
}

function runCli(args, { cwd, env, timeout = TIMEOUT_MS, input } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    input,
    encoding: 'utf8',
    timeout,
    env: baseEnv(env),
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

function initWorkspace(dir, home) {
  const init = runCli(['init', '--yes', '--minimal'], {
    cwd: dir,
    env: { HOME: home },
    timeout: 60000,
  });
  assert.equal(init.status, 0, init.stderr || init.stdout);
}

test('brainstorm with an idea captures inbox and exits without a wizard', () => {
  const dir = makeTempDir();
  const home = makeTempDir('atris-brainstorm-home-');
  try {
    initWorkspace(dir, home);
    const res = runCli(['brainstorm', 'add search to the lane CLI'], {
      cwd: dir,
      env: { HOME: home },
      input: '',
    });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /captured I\d+: add search to the lane CLI/);
    assert.match(res.stdout, /Next: atris plan/);
    assert.doesNotMatch(res.stdout + res.stderr, WIZARD_RE);

    const journal = fs.readFileSync(todayJournal(dir), 'utf8');
    const items = parseInboxItems(journal);
    assert.ok(items.some((item) => item.text.includes('add search to the lane CLI')));
  } finally {
    cleanupTempDir(dir);
    cleanupTempDir(home);
  }
});

test('brainstorm with ATRIS_NO_INTERACTIVE=1 captures and exits', () => {
  const dir = makeTempDir();
  const home = makeTempDir('atris-brainstorm-home-');
  try {
    initWorkspace(dir, home);
    const res = runCli(['brainstorm', 'one sentence idea'], {
      cwd: dir,
      env: { HOME: home, ATRIS_NO_INTERACTIVE: '1' },
      input: '',
    });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /captured I\d+: one sentence idea/);
    assert.doesNotMatch(res.stdout + res.stderr, WIZARD_RE);
  } finally {
    cleanupTempDir(dir);
    cleanupTempDir(home);
  }
});

test('brainstorm --json with an idea prints real JSON', () => {
  const dir = makeTempDir();
  const home = makeTempDir('atris-brainstorm-home-');
  try {
    initWorkspace(dir, home);
    const res = runCli(['brainstorm', 'ship a tiny kanban', '--json'], {
      cwd: dir,
      env: { HOME: home },
      input: '',
    });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.action, 'captured');
    assert.equal(payload.text, 'ship a tiny kanban');
    assert.match(String(payload.inbox_id), /^I\d+$/);
    assert.equal(payload.next_command, 'atris plan');
    assert.doesNotMatch(res.stdout, WIZARD_RE);
  } finally {
    cleanupTempDir(dir);
    cleanupTempDir(home);
  }
});

test('brainstorm without an idea exits and does not hang', () => {
  const dir = makeTempDir();
  const home = makeTempDir('atris-brainstorm-home-');
  try {
    initWorkspace(dir, home);
    const res = runCli(['brainstorm'], {
      cwd: dir,
      env: { HOME: home, ATRIS_NO_INTERACTIVE: '1' },
      input: '',
    });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /Next: atris brainstorm/);
    assert.doesNotMatch(res.stdout + res.stderr, WIZARD_RE);
  } finally {
    cleanupTempDir(dir);
    cleanupTempDir(home);
  }
});

test('brainstorm --json without an idea prints real JSON', () => {
  const dir = makeTempDir();
  const home = makeTempDir('atris-brainstorm-home-');
  try {
    initWorkspace(dir, home);
    const res = runCli(['brainstorm', '--json'], {
      cwd: dir,
      env: { HOME: home },
      input: '',
    });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.reason, 'idea_required');
    assert.match(String(payload.next_command), /atris brainstorm/);
  } finally {
    cleanupTempDir(dir);
    cleanupTempDir(home);
  }
});

test('brainstorm with an idea returns even when stdin looks like a TTY', async () => {
  const dir = makeTempDir();
  const home = makeTempDir('atris-brainstorm-home-');
  const prevArgv = process.argv;
  const prevCwd = process.cwd();
  const prevHome = process.env.HOME;
  const prevNoInteractive = process.env.ATRIS_NO_INTERACTIVE;
  const prevNonInteractive = process.env.ATRIS_NONINTERACTIVE;
  const prevTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const logs = [];
  const origLog = console.log;
  try {
    initWorkspace(dir, home);
    process.chdir(dir);
    process.env.HOME = home;
    delete process.env.ATRIS_NO_INTERACTIVE;
    delete process.env.ATRIS_NONINTERACTIVE;
    process.argv = [process.execPath, cliPath, 'brainstorm', 'add search to the lane CLI'];
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    console.log = (...parts) => {
      logs.push(parts.map(String).join(' '));
    };

    const { brainstormAtris } = require('../commands/brainstorm');
    await Promise.race([
      brainstormAtris(),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('brainstorm hung on a TTY prompt')), 3000);
      }),
    ]);

    const out = logs.join('\n');
    assert.match(out, /captured I\d+: add search to the lane CLI/);
    assert.doesNotMatch(out, WIZARD_RE);
  } finally {
    console.log = origLog;
    process.argv = prevArgv;
    process.chdir(prevCwd);
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevNoInteractive === undefined) delete process.env.ATRIS_NO_INTERACTIVE;
    else process.env.ATRIS_NO_INTERACTIVE = prevNoInteractive;
    if (prevNonInteractive === undefined) delete process.env.ATRIS_NONINTERACTIVE;
    else process.env.ATRIS_NONINTERACTIVE = prevNonInteractive;
    if (prevTty) Object.defineProperty(process.stdin, 'isTTY', prevTty);
    else delete process.stdin.isTTY;
    cleanupTempDir(dir);
    cleanupTempDir(home);
  }
});
