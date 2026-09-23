const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const { withMissionFullJson } = require('./helpers/mission-json');

function runCli(args, cwd, extraEnv = {}) {
  const env = { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', ...extraEnv };
  delete env.ATRIS_RUNNER_PROFILE;
  return spawnSync(process.execPath, [cliPath, ...withMissionFullJson(args)], { cwd, encoding: 'utf8', env });
}

function fakeClaude(base) {
  const bin = path.join(base, 'bin');
  fs.mkdirSync(bin);
  const executable = path.join(bin, 'claude');
  fs.writeFileSync(executable, [
    '#!/bin/sh',
    'if [ "$1" = "--help" ]; then echo "--output-format --permission-mode --resume --session-id --include-partial-messages"; exit 0; fi',
    'echo \'{"type":"result","is_error":false,"result":"finished bounded work"}\'',
    '',
  ].join('\n'));
  fs.chmodSync(executable, 0o755);
  return { PATH: `${bin}${path.delimiter}${process.env.PATH || ''}` };
}

function makeRepo() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-run-runner-'));
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const git = (a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
  git(['init', '-q', '-b', 'master']);
  git(['config', 'user.email', 'test@atris.dev']);
  git(['config', 'user.name', 'test']);
  runCli(['member', 'create', 'growth'], repo);
  git(['add', '.']);
  git(['commit', '-qm', 'baseline']);
  return { base, repo };
}

// Proven footgun (2026-07-16): the run-objective path (`member run` /
// `atris mission run "<objective>"`) defaulted its runner to codex_goal, which
// hands the mission to a live codex session's native goal slot. Run unattended
// (cron/fleet/plain shell) there is no such session, so the mission stalls
// forever. Default to claude, which drives itself headless.
test('run-objective without a live codex session defaults to the claude runner', () => {
  const { base, repo } = makeRepo();
  try {
    const res = runCli(['member', 'run', 'growth', 'improve onboarding proof', '--minutes', '10', '--max-ticks', '1', '--no-verify', '--json'], repo, fakeClaude(base));
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.equal(JSON.parse(res.stdout).started, true);
    assert.equal(JSON.parse(res.stdout).mission.runner, 'claude', res.stdout);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// A live codex session announces itself with --native-goal-status; keep
// codex_goal so the native goal slot still drives the mission.
test('run-objective with a live codex session keeps the codex_goal runner', () => {
  const { base, repo } = makeRepo();
  try {
    const res = runCli([
      'member', 'run', 'growth', 'improve onboarding proof', '--minutes', '10', '--no-verify',
      '--max-ticks', '1', '--native-goal-status', 'active', '--native-goal-objective', 'improve onboarding proof', '--json',
    ], repo);
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.equal(JSON.parse(res.stdout).started, true);
    assert.equal(JSON.parse(res.stdout).mission.runner, 'codex_goal', res.stdout);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// An explicit --runner always wins over the default.
test('explicit --runner overrides the default', () => {
  const { base, repo } = makeRepo();
  try {
    const res = runCli(['member', 'run', 'growth', 'improve onboarding proof', '--minutes', '10', '--max-ticks', '1', '--no-verify', '--runner', 'codex_goal', '--json'], repo);
    assert.notEqual(res.status, 0);
    assert.equal(JSON.parse(res.stdout).started, false);
    assert.equal(JSON.parse(res.stdout).mission.runner, 'codex_goal', res.stdout);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
