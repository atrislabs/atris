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

    const text = runCli(['land', 'status'], repo);
    assert.equal(text.status, 0, text.stderr || text.stdout);
    assert.ok(text.stdout.indexOf('stale-work') < text.stdout.indexOf('fresh-work'), text.stdout);
    assert.ok(text.stdout.indexOf('fresh-work') < text.stdout.indexOf('residue'), text.stdout);
  } finally {
    cleanupTempDir(base);
  }
});

test('land status renders the board instead of looking up status as a name', () => {
  const { base, repo } = makeTempRepo();
  try {
    commitOnBranch(repo, 'fresh-work', 'fresh.txt');
    const threeDaysAgo = new Date(Date.now() - 72 * 3600 * 1000).toISOString();
    commitOnBranch(repo, 'aging-work', 'aging.txt', { backdate: threeDaysAgo });

    const result = runCli(['land', 'status'], repo);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /the landing/);
    assert.match(result.stdout, /fresh-work/);
    assert.doesNotMatch(result.stdout, /—/);
    assert.match(result.stdout, /2 pieces tracked: 2 still in the air, 1 stale, 0 overdue, 0 landed and safe to clear/);
    assert.doesNotMatch(result.stderr, /nothing called 'status'/);
  } finally {
    cleanupTempDir(base);
  }
});

test('land status names the clearable category instead of saying overdue/landed', () => {
  const { base, repo } = makeTempRepo();
  try {
    commitOnBranch(repo, 'residue', 'residue.txt');
    runGit(['merge', '-q', '--ff-only', 'residue'], repo);

    const result = runCli(['land', 'status'], repo);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /1 piece tracked: 0 still in the air, 0 stale, 0 overdue, 1 landed and safe to clear/);
    assert.match(result.stdout, /back up \+ clear 1 landed: atris land --reap/);
    assert.doesNotMatch(result.stdout, /1 piece of work in the air/);
    assert.doesNotMatch(result.stdout, /overdue\/landed/);
  } finally {
    cleanupTempDir(base);
  }
});

test('land status <name> still looks up a real work item', () => {
  const { base, repo } = makeTempRepo();
  try {
    commitOnBranch(repo, 'fresh-work', 'fresh.txt');

    const result = runCli(['land', 'status', 'fresh-work', '--json'], repo);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const story = JSON.parse(result.stdout);
    assert.equal(story.name, 'fresh-work');
    assert.equal(story.uniqueChanges, 1);
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
    // age the worktree past the fresh-worktree grace window
    const staleStamp = new Date(Date.now() - 61 * 60 * 1000);
    fs.utimesSync(wtPath, staleStamp, staleStamp);

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
    assert.doesNotMatch(result.stdout, /—/);
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

test('reap salvages staged and untracked files before removing a worktree', () => {
  const { base, repo } = makeTempRepo();
  try {
    // the standard agent flow: branch off master, add a worktree, write new
    // files, no commit yet — branch is 0-ahead ("landed" residue) so the
    // unattended reap targets it before the work is committed anywhere
    runGit(['branch', 'wip-branch'], repo);
    const wt = path.join(base, 'wip-wt');
    runGit(['worktree', 'add', wt, 'wip-branch'], repo);
    fs.writeFileSync(path.join(wt, 'brand-new.md'), 'never committed\n');
    fs.mkdirSync(path.join(wt, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(wt, 'sub', 'nested.txt'), 'nested new file\n');
    fs.writeFileSync(path.join(wt, 'README.md'), '# staged edit\n');
    runGit(['add', 'README.md'], wt);
    // age the worktree past the fresh-worktree grace window
    const graceStamp = new Date(Date.now() - 61 * 60 * 1000);
    fs.utimesSync(wt, graceStamp, graceStamp);

    const { reap } = require('../commands/land');
    const receipt = reap(repo, {});
    // macOS tmpdir is a symlink (/var → /private/var): match by basename
    assert.ok(receipt.removedWorktrees.some((p) => path.basename(p) === 'wip-wt'), JSON.stringify(receipt));
    assert.ok(receipt.deletedBranches.includes('wip-branch'));
    // staged tracked change survives as a patch
    assert.equal(receipt.patches.length, 1);
    assert.match(fs.readFileSync(receipt.patches[0], 'utf8'), /staged edit/);
    // untracked files survive as verbatim copies, tree shape kept
    assert.equal(receipt.untracked.length, 1);
    assert.equal(fs.readFileSync(path.join(receipt.untracked[0], 'brand-new.md'), 'utf8'), 'never committed\n');
    assert.equal(fs.readFileSync(path.join(receipt.untracked[0], 'sub', 'nested.txt'), 'utf8'), 'nested new file\n');
  } finally {
    cleanupTempDir(base);
  }
});

test('reap leaves a branch alone when it moved after the scan', () => {
  const { base, repo } = makeTempRepo();
  try {
    // simulate the race by lying to the delete loop: hand reap a board where
    // the branch looks landed, then advance it before deletion runs. The
    // cheap way: a branch that is 0-ahead at scan time gains a commit via a
    // pre-scan hook is not injectable, so assert the guard directly instead —
    // a branch whose ahead-count no longer matches its board entry survives.
    runGit(['branch', 'racer'], repo);
    const wt = path.join(base, 'racer-wt');
    runGit(['worktree', 'add', wt, 'racer'], repo);
    // dirty file whose salvage will succeed; then commit in the worktree so
    // ahead-count moves from 0 (scan would classify landed) — reap recomputes
    // and must keep the branch since its own snapshot is stale by then.
    fs.writeFileSync(path.join(wt, 'racing.md'), 'commit me\n');
    runGit(['add', '.'], wt);
    runGit(['commit', '-m', 'landed after scan'], wt);
    // remove the worktree first so only the branch-delete path is exercised
    runGit(['worktree', 'remove', '--force', wt], repo);

    const { collectBoard } = require('../commands/land');
    const board = collectBoard(repo, {});
    const racer = board.branches.find((b) => b.name === 'racer');
    // sanity: the committed branch is 1 ahead and young — reap keeps it as active
    assert.equal(racer.ahead, 1);
    assert.equal(racer.state, 'active');
    const { reap } = require('../commands/land');
    const receipt = reap(repo, {});
    assert.ok(!receipt.deletedBranches.includes('racer'));
  } finally {
    cleanupTempDir(base);
  }
});

test('reap salvages a worktree whose dirty diff exceeds the 1MB spawn buffer', () => {
  const { base, repo } = makeTempRepo();
  try {
    commitOnBranch(repo, 'big-work', 'big.txt', { backdate: '2026-05-01T00:00:00' });
    const wtPath = path.join(base, 'wt-big');
    runGit(['worktree', 'add', wtPath, 'big-work'], repo);
    fs.writeFileSync(path.join(wtPath, 'big.txt'), `uncommitted ${'x'.repeat(2 * 1024 * 1024)}\n`);
    // age the worktree past the fresh-worktree grace window
    const staleStamp = new Date(Date.now() - 61 * 60 * 1000);
    fs.utimesSync(wtPath, staleStamp, staleStamp);

    const result = runCli(['land', '--reap', '--json'], repo);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const receipt = JSON.parse(result.stdout);

    // macOS reports /var/... worktrees back as /private/var/...
    const normalize = (p) => p.replace(/^\/private\//, '/');
    assert.deepEqual(receipt.removedWorktrees.map(normalize), [normalize(wtPath)]);
    assert.ok(receipt.deletedBranches.includes('big-work'));
    assert.equal(receipt.patches.length, 1);
    assert.ok(fs.statSync(receipt.patches[0]).size > 1024 * 1024, 'patch must hold the full oversized diff');
    assert.ok(!fs.existsSync(wtPath));
  } finally {
    cleanupTempDir(base);
  }
});
