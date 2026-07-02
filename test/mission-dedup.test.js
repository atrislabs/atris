const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function makeRepo() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-dedup-'));
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  spawnSync('git', ['init', '-q', '-b', 'master'], { cwd: repo });
  return { base, repo };
}

function runCli(args, cwd) {
  const env = { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' };
  delete env.ATRIS_RUNNER_PROFILE;
  return spawnSync(process.execPath, [cliPath, ...args], { cwd, encoding: 'utf8', env });
}

// Born 2026-07-02: an hourly alive loop started six identical missions in one
// day. Same objective + same active owner must reuse, never clone.
test('mission start reuses an active twin instead of cloning it', () => {
  const { base, repo } = makeRepo();
  try {
    const first = runCli(['mission', 'start', 'improve the widget pipeline', '--owner', 'auto-improver', '--json'], repo);
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const firstId = JSON.parse(first.stdout).mission.id;

    const clone = runCli(['mission', 'start', 'Improve   the widget pipeline', '--owner', 'auto-improver', '--json'], repo);
    assert.equal(clone.status, 0, clone.stderr || clone.stdout);
    const parsed = JSON.parse(clone.stdout);
    assert.equal(parsed.action, 'mission_reused');
    assert.equal(parsed.mission.id, firstId, 'must point at the existing mission');

    const status = runCli(['mission', 'status', '--status', 'active', '--json'], repo);
    const actives = (JSON.parse(status.stdout).missions || []).filter((m) => /widget pipeline/i.test(m.objective));
    assert.equal(actives.length, 1, 'still exactly one active mission');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('--duplicate forces a second mission; a different owner is not a twin', () => {
  const { base, repo } = makeRepo();
  try {
    runCli(['mission', 'start', 'improve the widget pipeline', '--owner', 'auto-improver', '--json'], repo);

    const otherOwner = runCli(['mission', 'start', 'improve the widget pipeline', '--owner', 'validator', '--json'], repo);
    assert.equal(JSON.parse(otherOwner.stdout).action, 'mission_started', 'different owner is a different mission');

    const forced = runCli(['mission', 'start', 'improve the widget pipeline', '--owner', 'auto-improver', '--duplicate', '--json'], repo);
    assert.equal(JSON.parse(forced.stdout).action, 'mission_started', '--duplicate must bypass the gate');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a stopped or completed mission is not a twin — restart is allowed', () => {
  const { base, repo } = makeRepo();
  try {
    const first = runCli(['mission', 'start', 'improve the widget pipeline', '--owner', 'auto-improver', '--json'], repo);
    const id = JSON.parse(first.stdout).mission.id;
    assert.equal(runCli(['mission', 'stop', id, '--reason', 'test'], repo).status, 0);

    const again = runCli(['mission', 'start', 'improve the widget pipeline', '--owner', 'auto-improver', '--json'], repo);
    assert.equal(JSON.parse(again.stdout).action, 'mission_started', 'stopped twin must not block a fresh start');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
