const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function makeRepo() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-state-root-'));
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

// Proven footgun (2026-07-16): `atris mission ...` run from a subdirectory
// created a nested .atris store there (seen under atris/features/food-ordering),
// splitting the mission book the fleet reads. State must anchor to the git
// toplevel no matter which subdir the caller stood in.
test('mission start from a subdirectory anchors state at the workspace root', () => {
  const { base, repo } = makeRepo();
  try {
    const subdir = path.join(repo, 'atris', 'features', 'food-ordering');
    fs.mkdirSync(subdir, { recursive: true });

    const started = runCli(
      ['mission', 'start', '--no-verify', 'prove the ordering path installs', '--owner', 'app-pm', '--json'],
      subdir,
    );
    assert.equal(started.status, 0, started.stderr || started.stdout);

    // State lands at the repo root, not in the subdirectory.
    assert.ok(
      fs.existsSync(path.join(repo, '.atris', 'state', 'missions.jsonl')),
      'mission store must exist at the workspace root',
    );
    assert.ok(
      !fs.existsSync(path.join(subdir, '.atris')),
      'no nested .atris store may be created in the subdirectory',
    );

    // The redirect announces itself on stderr so it is never silent.
    assert.match(started.stderr, /anchoring mission state to the workspace root/);

    // The mission is visible from the root store.
    const status = runCli(['mission', 'status', '--json'], repo);
    assert.equal(status.status, 0, status.stderr || status.stdout);
    assert.match(status.stdout, /prove the ordering path installs/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// Running from the root itself must not warn or move anything.
test('mission start from the workspace root does not redirect', () => {
  const { base, repo } = makeRepo();
  try {
    const started = runCli(
      ['mission', 'start', '--no-verify', 'work at the root', '--owner', 'app-pm', '--json'],
      repo,
    );
    assert.equal(started.status, 0, started.stderr || started.stdout);
    assert.doesNotMatch(started.stderr, /anchoring mission state/);
    assert.ok(fs.existsSync(path.join(repo, '.atris', 'state', 'missions.jsonl')));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
