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

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-member-switches-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runCli(args, { cwd, env } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...scrubAgentEnv(),
      ATRIS_SKIP_UPDATE_CHECK: '1',
      ATRIS_NO_INTERACTIVE: '1',
      ...(env || {}),
    },
  });
  if (result.error) throw result.error;
  return result;
}

function writeMember(root, name) {
  const dir = path.join(root, 'atris', 'team', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'MEMBER.md'), [
    '---',
    `name: ${name}`,
    'role: Test Member',
    '---',
    '',
    `# ${name}`,
    '',
  ].join('\n'), 'utf8');
  return dir;
}

function readSwitches(root) {
  const file = path.join(root, '.atris', 'state', 'member-switches.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('sleep and wake a member flips member-switches.json', () => {
  const root = makeTempDir();
  try {
    writeMember(root, 'maze');

    const sleep = runCli(['sleep', 'maze'], { cwd: root });
    assert.equal(sleep.status, 0, sleep.stderr || sleep.stdout);
    assert.match(sleep.stdout.toLowerCase(), /maze is asleep/);
    assert.doesNotMatch(sleep.stdout, /\u2014/);

    let state = readSwitches(root);
    assert.equal(state.members.maze.awake, false);

    const wake = runCli(['wake', 'maze'], { cwd: root });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    assert.match(wake.stdout.toLowerCase(), /maze is awake/);

    state = readSwitches(root);
    assert.equal(state.members.maze.awake, true);
  } finally {
    cleanupTempDir(root);
  }
});

test('sleep and wake with --loop flips the per-loop entry', () => {
  const root = makeTempDir();
  try {
    writeMember(root, 'growth');

    const sleep = runCli(['sleep', 'growth', '--loop', 'feedback'], { cwd: root });
    assert.equal(sleep.status, 0, sleep.stderr || sleep.stdout);
    assert.match(sleep.stdout.toLowerCase(), /growth loop feedback is asleep/);

    let state = readSwitches(root);
    assert.equal(state.members.growth.loops.feedback, false);
    // member itself stays awake unless explicitly slept
    assert.equal(state.members.growth.awake, true);

    const wake = runCli(['wake', 'growth', '--loop', 'feedback'], { cwd: root });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    assert.match(wake.stdout.toLowerCase(), /growth loop feedback is awake/);

    state = readSwitches(root);
    assert.equal(state.members.growth.loops.feedback, true);
  } finally {
    cleanupTempDir(root);
  }
});

test('asleep member blocks gm dispatch with one lowercase line and exit 0', () => {
  const root = makeTempDir();
  try {
    writeMember(root, 'maze');
    const sleep = runCli(['sleep', 'maze'], { cwd: root });
    assert.equal(sleep.status, 0, sleep.stderr || sleep.stdout);

    const gm = runCli(['gm', 'maze'], {
      cwd: root,
      env: { ATRIS_TASKS_DB: path.join(root, 'tasks.db'), NODE_NO_WARNINGS: '1' },
    });
    assert.equal(gm.status, 0, gm.stderr || gm.stdout);
    const line = gm.stdout.trim().toLowerCase();
    assert.equal(line, 'maze is asleep');
    assert.doesNotMatch(gm.stdout, /waking up|AgentXP General Manager/i);
    assert.doesNotMatch(gm.stdout, /\u2014/);
  } finally {
    cleanupTempDir(root);
  }
});

test('no-arg sleep keeps business-level help and does not write member switches', () => {
  const root = makeTempDir();
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  try {
    // no team members, no credentials, no business.json
    const res = runCli(['sleep'], {
      cwd: root,
      env: { HOME: home },
    });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /Usage: atris sleep/);
    assert.equal(fs.existsSync(path.join(root, '.atris', 'state', 'member-switches.json')), false);
  } finally {
    cleanupTempDir(root);
  }
});

test('non-member sleep arg does not write member switches (business path)', () => {
  const root = makeTempDir();
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  try {
    writeMember(root, 'maze');
    const res = runCli(['sleep', 'acme-not-a-member'], {
      cwd: root,
      env: { HOME: home },
    });
    // business path requires login
    assert.notEqual(res.status, 0);
    assert.match(res.stderr || res.stdout, /Not logged in/i);
    assert.equal(fs.existsSync(path.join(root, '.atris', 'state', 'member-switches.json')), false);
  } finally {
    cleanupTempDir(root);
  }
});
