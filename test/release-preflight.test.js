'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const releaseSrc = fs.readFileSync(path.join(repoRoot, 'commands', 'release.js'), 'utf8');

function runCli(args, cwd, extraEnv = {}) {
  const env = {
    ...process.env,
    ATRIS_SKIP_UPDATE_CHECK: '1',
    ...extraEnv,
  };
  delete env.CI;

  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    env,
    timeout: 30000,
  });
  if (result.error) throw result.error;
  return result;
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function makeReleaseRepo({
  branch = 'master',
  dirty = false,
  version = '1.2.3',
  tagged = false,
  localAhead = false,
  testScript = "node -e \"process.exit(process.env.CI === 'true' ? 0 : 1)\"",
} = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-release-preflight-'));
  const origin = path.join(base, 'origin.git');
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo);

  execFileSync('git', ['init', '--bare', '--initial-branch=master', origin]);
  execFileSync('git', ['init', '--initial-branch=master'], { cwd: repo });
  git(repo, 'config', 'user.email', 'preflight@test.invalid');
  git(repo, 'config', 'user.name', 'preflight test');
  git(repo, 'config', 'commit.gpgsign', 'false');

  fs.writeFileSync(path.join(repo, 'package.json'), `${JSON.stringify({
    name: 'release-preflight-fixture',
    version,
    scripts: { test: testScript },
  }, null, 2)}\n`);
  git(repo, 'add', 'package.json');
  git(repo, 'commit', '-m', 'seed');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-u', 'origin', 'master');

  if (tagged) git(repo, 'tag', `v${version}`);
  if (localAhead) {
    git(repo, 'commit', '--allow-empty', '-m', 'local ahead');
  }
  if (branch !== 'master') git(repo, 'checkout', '-b', branch);
  if (dirty) fs.writeFileSync(path.join(repo, 'dirty.txt'), 'dirt\n');

  return { base, repo };
}

test('release help names preflight', () => {
  const top = runCli(['help', '--all'], repoRoot);
  assert.equal(top.status, 0, top.stderr);
  assert.match(top.stdout, /release preflight/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-release-help-'));
  try {
    const res = runCli(['release', '--help'], dir);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /atris release preflight/);
    assert.match(res.stdout, /CI=true/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('release preflight refuses off-master', () => {
  const { base, repo } = makeReleaseRepo({ branch: 'feature' });
  try {
    const res = runCli(['release', 'preflight'], repo);
    assert.equal(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stdout, /fail: current branch is feature, need master/);
    assert.match(res.stdout, /skip: test suite \(earlier checks failed\)/);
    assert.match(res.stdout, /release preflight failed/);
    assert.doesNotMatch(res.stdout, /\u2014/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('release preflight refuses a dirty tree', () => {
  const { base, repo } = makeReleaseRepo({ dirty: true });
  try {
    const res = runCli(['release', 'preflight'], repo);
    assert.equal(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stdout, /fail: working tree is not clean/);
    assert.match(res.stdout, /release preflight failed/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('release preflight refuses when the version tag already exists', () => {
  const { base, repo } = makeReleaseRepo({ tagged: true });
  try {
    const res = runCli(['release', 'preflight'], repo);
    assert.equal(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stdout, /fail: tag v1\.2\.3 already exists/);
    assert.match(res.stdout, /release preflight failed/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('release preflight refuses when local master does not match origin/master', () => {
  const { base, repo } = makeReleaseRepo({ localAhead: true });
  try {
    const res = runCli(['release', 'preflight'], repo);
    assert.equal(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stdout, /fail: local master does not match origin\/master/);
    assert.match(res.stdout, /release preflight failed/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('release preflight passes on a clean master with CI=true tests', () => {
  const { base, repo } = makeReleaseRepo();
  try {
    const res = runCli(['release', 'preflight'], repo);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /pass: current branch is master/);
    assert.match(res.stdout, /pass: working tree is clean/);
    assert.match(res.stdout, /pass: local master matches origin\/master/);
    assert.match(res.stdout, /pass: no tag v1\.2\.3/);
    assert.match(res.stdout, /pass: test suite/);
    assert.match(res.stdout, /release preflight passed/);
    assert.doesNotMatch(res.stdout, /\u2014/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('release preflight uses the real test-suite exit code', () => {
  const { base, repo } = makeReleaseRepo({
    testScript: 'node -e "process.exit(2)"',
  });
  try {
    const res = runCli(['release', 'preflight'], repo);
    assert.equal(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stdout, /fail: test suite exited 2/);
    assert.match(res.stdout, /release preflight failed/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('release preflight runs npm test with CI=true', () => {
  assert.match(releaseSrc, /spawnSync\('npm', \['test'\]/);
  assert.match(releaseSrc, /CI:\s*'true'/);
});
