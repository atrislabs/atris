const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const { withMissionFullJson, jsonErrorDetail } = require('./helpers/mission-json');

function makeTempDir() {
  // Worktrees land in <parent>/.agent-worktrees/<repo>/..., so give the repo a
  // parent we control and clean up in one shot.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mission-worktree-start-test-'));
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  return { base, repo };
}

function cleanupTempDir(base) {
  fs.rmSync(base, { recursive: true, force: true });
}

function runCli(args, { cwd, env = {} } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...withMissionFullJson(args)], {
    cwd,
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      ...env,
    },
  });
  if (result.error) throw result.error;
  return result;
}

function runGit(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

function initWorkspace(repo) {
  runGit(['init'], repo);
  runGit(['config', 'user.email', 'test@example.com'], repo);
  runGit(['config', 'user.name', 'Test User'], repo);
  fs.mkdirSync(path.join(repo, 'atris'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'base.txt'), 'committed\n');
  fs.writeFileSync(path.join(repo, 'atris', '.gitkeep'), '');
  runGit(['add', '.'], repo);
  runGit(['commit', '-m', 'clean baseline'], repo);
}

test('mission start --worktree creates an isolated checkout holding the mission state', () => {
  const { base, repo } = makeTempDir();
  try {
    initWorkspace(repo);
    // Dirty the main checkout: this noise must never reach the mission baseline.
    fs.writeFileSync(path.join(repo, 'main-dirt.txt'), 'noise\n');

    const res = runCli(['mission', 'start', '--no-verify', 'isolated mission', '--owner', 'mission-lead', '--worktree', '--json'], { cwd: repo });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const payload = JSON.parse(res.stdout);
    const mission = payload.mission;

    assert.equal(mission.objective, 'isolated mission', 'flag must not leak into the objective');
    assert.ok(mission.worktree, 'mission must record its worktree');
    const wtPath = mission.worktree.path;
    assert.ok(fs.existsSync(wtPath), `worktree must exist at ${wtPath}`);
    assert.notEqual(path.resolve(wtPath), path.resolve(repo));
    assert.ok(mission.worktree.branch, 'mission must record its branch');

    // Mission state lives inside the worktree, not the main checkout.
    assert.ok(fs.existsSync(path.join(wtPath, '.atris', 'state', 'missions.jsonl')));
    assert.ok(!fs.existsSync(path.join(repo, '.atris', 'state', 'missions.jsonl')));

    // Baseline sidecar lives inside the worktree and excludes main-checkout dirt.
    const sidecar = path.join(wtPath, '.atris', 'state', 'mission-baselines', `${mission.id}.json`);
    assert.ok(fs.existsSync(sidecar));
    const baseline = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
    assert.ok(!baseline.paths.includes('main-dirt.txt'),
      'main checkout dirt must not appear in the worktree baseline');
  } finally {
    cleanupTempDir(base);
  }
});

test('mission worktree links existing dependencies from the source checkout', () => {
  const { base, repo } = makeTempDir();
  try {
    initWorkspace(repo);
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ dependencies: { example: '1.0.0' } }));
    fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n.atris/\natris/status/\n');
    runGit(['add', 'package.json', '.gitignore'], repo);
    runGit(['commit', '-m', 'add package manifest'], repo);
    fs.mkdirSync(path.join(repo, 'node_modules', 'example'), { recursive: true });

    const res = runCli(['mission', 'start', '--no-verify', 'linked dependency mission', '--owner', 'mission-lead', '--worktree', '--json'], { cwd: repo });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const payload = JSON.parse(res.stdout);
    const link = path.join(payload.mission.worktree.path, 'node_modules');
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    assert.equal(fs.realpathSync(link), fs.realpathSync(path.join(repo, 'node_modules')));
    assert.equal(payload.node_modules_linked, true);
    assert.equal(runGit(['status', '--porcelain'], payload.mission.worktree.path).stdout, '');
    const commonDir = runGit(['rev-parse', '--git-common-dir'], repo).stdout.trim();
    const exclude = fs.readFileSync(path.join(repo, commonDir, 'info', 'exclude'), 'utf8');
    assert.equal(exclude.split(/\r?\n/).filter((line) => line === '/node_modules').length, 1);

    const second = runCli(['mission', 'start', '--no-verify', 'second linked mission', '--owner', 'mission-lead', '--worktree', '--json'], { cwd: repo });
    assert.equal(second.status, 0, second.stderr || second.stdout);
    const secondWorktree = JSON.parse(second.stdout).mission.worktree.path;
    assert.equal(runGit(['status', '--porcelain'], secondWorktree).stdout, '');
    const updatedExclude = fs.readFileSync(path.join(repo, commonDir, 'info', 'exclude'), 'utf8');
    assert.equal(updatedExclude.split(/\r?\n/).filter((line) => line === '/node_modules').length, 1);
  } finally {
    cleanupTempDir(base);
  }
});

test('mission start continues when creating the dependency link fails', () => {
  const { base, repo } = makeTempDir();
  try {
    initWorkspace(repo);
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ dependencies: { example: '1.0.0' } }));
    fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
    runGit(['add', 'package.json', '.gitignore'], repo);
    runGit(['commit', '-m', 'add package manifest'], repo);
    fs.mkdirSync(path.join(repo, 'node_modules'));
    const hook = path.join(base, 'fail-link.cjs');
    fs.writeFileSync(hook, [
      "const fs = require('node:fs');",
      'const original = fs.symlinkSync;',
      "fs.symlinkSync = function(source, target, type) { if (target.endsWith('/node_modules')) throw new Error('link refused'); return original(source, target, type); };",
      '',
    ].join('\n'));

    const res = runCli(['mission', 'start', '--no-verify', 'link error mission', '--owner', 'mission-lead', '--worktree', '--json'],
      { cwd: repo, env: { NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require=${hook}`.trim() } });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const payload = JSON.parse(res.stdout);
    assert.ok(fs.existsSync(payload.mission.worktree.path));
    assert.equal(payload.node_modules_linked, false);
    assert.equal(res.stderr.trim().split(/\r?\n/).filter((line) => line.includes('node_modules')).length, 1);
    assert.match(res.stderr, /warning: could not link node_modules: link refused/);
  } finally {
    cleanupTempDir(base);
  }
});

test('mission start keeps its worktree when the source package manifest is invalid', () => {
  const { base, repo } = makeTempDir();
  try {
    initWorkspace(repo);
    fs.writeFileSync(path.join(repo, 'package.json'), '{broken');
    fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
    runGit(['add', 'package.json', '.gitignore'], repo);
    runGit(['commit', '-m', 'add invalid manifest'], repo);
    fs.mkdirSync(path.join(repo, 'node_modules'));

    const res = runCli(['mission', 'start', '--no-verify', 'invalid manifest mission', '--owner', 'mission-lead', '--worktree', '--json'], { cwd: repo });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const payload = JSON.parse(res.stdout);
    assert.ok(fs.existsSync(payload.mission.worktree.path));
    assert.equal(payload.node_modules_linked, false);
    assert.match(res.stderr, /warning:.*node_modules/i);
  } finally {
    cleanupTempDir(base);
  }
});

test('mission start leaves an existing dead node_modules link alone', () => {
  const { base, repo } = makeTempDir();
  try {
    initWorkspace(repo);
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ dependencies: { example: '1.0.0' } }));
    fs.symlinkSync('missing-modules', path.join(repo, 'node_modules'));
    runGit(['add', 'package.json', 'node_modules'], repo);
    runGit(['commit', '-m', 'add existing link'], repo);
    const source = path.join(base, 'source-modules');
    fs.mkdirSync(source);
    fs.unlinkSync(path.join(repo, 'node_modules'));
    fs.symlinkSync(source, path.join(repo, 'node_modules'));

    const res = runCli(['mission', 'start', '--no-verify', 'existing link mission', '--owner', 'mission-lead', '--worktree', '--json'], { cwd: repo });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const payload = JSON.parse(res.stdout);
    assert.equal(fs.readlinkSync(path.join(payload.mission.worktree.path, 'node_modules')), 'missing-modules');
    assert.equal(payload.node_modules_linked, false);
  } finally {
    cleanupTempDir(base);
  }
});

test('ticks inside the mission worktree run against a clean mission_start baseline', () => {
  const { base, repo } = makeTempDir();
  try {
    initWorkspace(repo);
    const started = runCli(['mission', 'start', '--no-verify', 'tickable isolated mission', '--owner', 'mission-lead', '--worktree', '--json'], { cwd: repo });
    assert.equal(started.status, 0, started.stderr || started.stdout);
    const mission = JSON.parse(started.stdout).mission;
    const wtPath = mission.worktree.path;

    const cleanTick = runCli(['mission', 'tick', mission.id, '--json'], { cwd: wtPath });
    assert.equal(cleanTick.status, 0, cleanTick.stderr || cleanTick.stdout);
    const cleanWorktree = JSON.parse(cleanTick.stdout).tick.worktree;
    assert.equal(cleanWorktree.baseline_source, 'mission_start');
    assert.equal(cleanWorktree.new_since_baseline_count, 0);
    assert.equal(cleanWorktree.unverified_dirty, false);

    // Real work inside the worktree is attributed to the mission.
    fs.writeFileSync(path.join(wtPath, 'mission-work.txt'), 'real change\n');
    const dirtyTick = runCli(['mission', 'tick', mission.id, '--json'], { cwd: wtPath });
    assert.equal(dirtyTick.status, 0, dirtyTick.stderr || dirtyTick.stdout);
    const dirtyWorktree = JSON.parse(dirtyTick.stdout).tick.worktree;
    assert.equal(dirtyWorktree.new_since_baseline_count, 1);
    assert.ok(dirtyWorktree.new_since_baseline_sample.includes('mission-work.txt'));
  } finally {
    cleanupTempDir(base);
  }
});

test('mission start --worktree outside a git repo fails with a clear error', () => {
  const { base, repo } = makeTempDir();
  try {
    // No git init: worktree creation has nothing to attach to.
    fs.mkdirSync(path.join(repo, 'atris'), { recursive: true });
    const res = runCli(['mission', 'start', '--no-verify', 'no repo mission', '--owner', 'mission-lead', '--worktree', '--json'], { cwd: repo });
    assert.notEqual(res.status, 0, 'must fail outside a git repo');
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.ok, false);
    assert.match(jsonErrorDetail(payload), /worktree/i);
  } finally {
    cleanupTempDir(base);
  }
});

test('mission start without --worktree keeps the current-directory behavior', () => {
  const { base, repo } = makeTempDir();
  try {
    initWorkspace(repo);
    const res = runCli(['mission', 'start', '--no-verify', 'plain mission', '--owner', 'mission-lead', '--json'], { cwd: repo });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const mission = JSON.parse(res.stdout).mission;
    assert.equal(mission.worktree ?? null, null);
    assert.ok(fs.existsSync(path.join(repo, '.atris', 'state', 'missions.jsonl')));
  } finally {
    cleanupTempDir(base);
  }
});
