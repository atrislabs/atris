const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function makeTempRepo() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-land-test-'));
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  runGit(['init', '-b', 'master'], repo);
  runGit(['config', 'user.email', 'test@example.com'], repo);
  runGit(['config', 'user.name', 'Test'], repo);
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
  runGit(['add', '.'], repo);
  runGit(['commit', '-m', 'init'], repo);
  return { base, repo };
}

function cleanupTempDir(base) {
  fs.rmSync(base, { recursive: true, force: true });
}

function runGit(args, cwd, env = {}) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, ...env },
  });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr || result.stdout}`);
  return result;
}

function runCli(args, cwd) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' },
  });
  if (result.error) throw result.error;
  return result;
}

function commitOnBranch(repo, branch, file, { backdate = '' } = {}) {
  runGit(['checkout', '-q', '-b', branch, 'master'], repo);
  fs.writeFileSync(path.join(repo, file), `${branch}\n`);
  runGit(['add', '.'], repo);
  const env = backdate ? { GIT_AUTHOR_DATE: backdate, GIT_COMMITTER_DATE: backdate } : {};
  runGit(['commit', '-m', `work on ${branch}`], repo, env);
  runGit(['checkout', '-q', 'master'], repo);
}

test('land board classifies active, due, and landed branches', () => {
  const { base, repo } = makeTempRepo();
  try {
    commitOnBranch(repo, 'fresh-work', 'fresh.txt');
    commitOnBranch(repo, 'stale-work', 'stale.txt', { backdate: '2026-05-01T00:00:00' });
    commitOnBranch(repo, 'residue', 'residue.txt');
    runGit(['merge', '-q', '--ff-only', 'residue'], repo);

    const result = runCli(['land', '--json'], repo);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const board = JSON.parse(result.stdout);

    const byName = Object.fromEntries(board.branches.map((b) => [b.name, b]));
    assert.equal(byName['fresh-work'].state, 'active');
    assert.equal(byName['stale-work'].state, 'due');
    assert.equal(byName['residue'].state, 'landed');
    assert.equal(byName['residue'].ahead, 0);
    assert.ok(byName['stale-work'].ageDays > 7);
    assert.equal(board.summary.unlanded, 3);
    assert.equal(board.summary.due, 1);
  } finally {
    cleanupTempDir(base);
  }
});

test('land --reap salvages then deletes due and landed branches, keeps active', () => {
  const { base, repo } = makeTempRepo();
  try {
    commitOnBranch(repo, 'fresh-work', 'fresh.txt');
    commitOnBranch(repo, 'stale-work', 'stale.txt', { backdate: '2026-05-01T00:00:00' });
    commitOnBranch(repo, 'residue', 'residue.txt');
    runGit(['merge', '-q', '--ff-only', 'residue'], repo);

    const result = runCli(['land', '--reap', '--json'], repo);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const receipt = JSON.parse(result.stdout);

    assert.deepEqual(receipt.deletedBranches.sort(), ['residue', 'stale-work']);
    assert.deepEqual(receipt.kept, ['fresh-work']);
    assert.ok(receipt.bundle, 'stale unlanded commits must be salvaged to a bundle');
    assert.ok(fs.existsSync(receipt.bundle));

    const branches = runGit(['branch', '--format=%(refname:short)'], repo)
      .stdout.split(/\r?\n/).filter(Boolean).sort();
    assert.deepEqual(branches, ['fresh-work', 'master']);

    // salvage bundle must actually contain the reaped commits
    const verify = spawnSync('git', ['bundle', 'verify', receipt.bundle], { cwd: repo, encoding: 'utf8' });
    assert.equal(verify.status, 0, verify.stderr);
  } finally {
    cleanupTempDir(base);
  }
});

test('land --reap --dry-run deletes nothing', () => {
  const { base, repo } = makeTempRepo();
  try {
    commitOnBranch(repo, 'stale-work', 'stale.txt', { backdate: '2026-05-01T00:00:00' });

    const result = runCli(['land', '--reap', '--dry-run', '--json'], repo);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const receipt = JSON.parse(result.stdout);
    assert.ok(receipt.dryRun);
    assert.deepEqual(receipt.deletedBranches, ['stale-work']);

    const branches = runGit(['branch', '--format=%(refname:short)'], repo)
      .stdout.split(/\r?\n/).filter(Boolean).sort();
    assert.deepEqual(branches, ['master', 'stale-work']);
    assert.ok(!fs.existsSync(path.join(repo, '.atris', 'salvage')));
  } finally {
    cleanupTempDir(base);
  }
});

test('land --reap removes a stale dirty worktree and saves its diff as a patch', () => {
  const { base, repo } = makeTempRepo();
  try {
    commitOnBranch(repo, 'stale-work', 'stale.txt', { backdate: '2026-05-01T00:00:00' });
    const wtPath = path.join(base, 'wt-stale');
    runGit(['worktree', 'add', wtPath, 'stale-work'], repo);
    fs.writeFileSync(path.join(wtPath, 'stale.txt'), 'uncommitted edit\n');

    const result = runCli(['land', '--reap', '--json'], repo);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const receipt = JSON.parse(result.stdout);

    // macOS reports /var/... worktrees back as /private/var/...
    const normalize = (p) => p.replace(/^\/private\//, '/');
    assert.deepEqual(receipt.removedWorktrees.map(normalize), [normalize(wtPath)]);
    assert.ok(receipt.deletedBranches.includes('stale-work'));
    assert.equal(receipt.patches.length, 1);
    assert.match(fs.readFileSync(receipt.patches[0], 'utf8'), /uncommitted edit/);
    assert.ok(!fs.existsSync(wtPath));
  } finally {
    cleanupTempDir(base);
  }
});

test('land --help prints usage without touching the repo', () => {
  const { base, repo } = makeTempRepo();
  try {
    const result = runCli(['land', '--help'], repo);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /still in the air/);
    assert.match(result.stdout, /--reap/);
  } finally {
    cleanupTempDir(base);
  }
});

test('land <name> tells the story: landed-elsewhere vs unique changes', () => {
  const { base, repo } = makeTempRepo();
  try {
    // backdate so the later cherry-pick can never hash to the identical
    // commit (same tree + same second would collide into one object)
    commitOnBranch(repo, 'mixed-work', 'a.txt', { backdate: '2026-06-30T00:00:00' });
    runGit(['checkout', '-q', 'mixed-work'], repo);
    fs.writeFileSync(path.join(repo, 'b.txt'), 'unique\n');
    runGit(['add', '.'], repo);
    runGit(['commit', '-m', 'unique change'], repo, {
      GIT_AUTHOR_DATE: '2026-06-30T00:01:00',
      GIT_COMMITTER_DATE: '2026-06-30T00:01:00',
    });
    runGit(['checkout', '-q', 'master'], repo);
    // replay only the first change onto master so it counts as landed elsewhere
    const first = runGit(['rev-list', '--reverse', 'master..mixed-work'], repo)
      .stdout.split(/\r?\n/).filter(Boolean)[0];
    runGit(['cherry-pick', first], repo);

    const result = runCli(['land', 'mixed-work', '--json'], repo);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const story = JSON.parse(result.stdout);
    assert.equal(story.changes.length, 2);
    assert.equal(story.landedElsewhere, 1);
    assert.equal(story.uniqueChanges, 1);

    const missing = runCli(['land', 'no-such-thing'], repo);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /in the air/);
  } finally {
    cleanupTempDir(base);
  }
});

test('land --reap --ttl 0 clears yesterday-old work (0 is not the default)', () => {
  const { base, repo } = makeTempRepo();
  try {
    const yesterday = new Date(Date.now() - 26 * 3600 * 1000).toISOString();
    commitOnBranch(repo, 'day-old', 'a.txt', { backdate: yesterday });

    const result = runCli(['land', '--reap', '--ttl', '0', '--json'], repo);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.ttlDays, 0);
    assert.deepEqual(receipt.deletedBranches, ['day-old']);
  } finally {
    cleanupTempDir(base);
  }
});
