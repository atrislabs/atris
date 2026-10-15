// `atris member tidy` puts away member copies whose work landed, and only by
// asking git to do it (worktree remove without --force, branch -d). These run
// against a real fake remote, real worktrees, and real lsof, so the guarantees
// are git's own refusals, not mocks.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const { tidyMemberCopies, formatTidy } = require('../lib/member-tidy');
const { reap } = require('../commands/land');
const { cleanupWorktrees, describeGitHold } = require('../commands/worktree');
const { disposeReviewSandbox } = require('../lib/fleet');
const { regressionCheck } = require('../commands/autopilot');

function runGit(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function configure(repo) {
  runGit(['config', 'user.email', 'test@example.com'], repo);
  runGit(['config', 'user.name', 'Test'], repo);
}

// <base>/remote.git is origin; <base>/arena/repo is the clone; member copies
// live in <base>/arena/.agent-worktrees/repo, the folder tidy looks in.
function makeFixture() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-member-tidy-')));
  const remote = path.join(base, 'remote.git');
  const seed = path.join(base, 'seed');
  runGit(['init', '-q', '--bare', '-b', 'master', remote], base);
  runGit(['init', '-q', '-b', 'master', seed], base);
  configure(seed);
  fs.writeFileSync(path.join(seed, 'README.md'), '# fixture\n');
  runGit(['add', '.'], seed);
  runGit(['commit', '-q', '-m', 'init'], seed);
  runGit(['push', '-q', remote, 'master'], seed);
  const arena = path.join(base, 'arena');
  fs.mkdirSync(arena);
  const repo = path.join(arena, 'repo');
  runGit(['clone', '-q', remote, repo], arena);
  configure(repo);
  const copies = path.join(arena, '.agent-worktrees', 'repo');
  fs.mkdirSync(copies, { recursive: true });
  return { base, repo, copies };
}

function addCopy(fx, name, { commit = false, pushToOrigin = false } = {}) {
  const wt = path.join(fx.copies, name);
  runGit(['worktree', 'add', '-q', '-b', name, wt, 'master'], fx.repo);
  if (commit) {
    fs.writeFileSync(path.join(wt, `${name}.txt`), 'work\n');
    runGit(['add', '.'], wt);
    runGit(['commit', '-q', '-m', `${name} work`], wt);
    if (pushToOrigin) runGit(['push', '-q', 'origin', `${name}:master`], wt);
  }
  return wt;
}

function branchExists(repo, name) {
  return spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], { cwd: repo }).status === 0;
}

function byName(result, name) {
  return result.copies.find((copy) => copy.name === name);
}

test('tidy removes landed clean copies and leaves everything else to git and the rules', async () => {
  const fx = makeFixture();
  let busyProcess;
  try {
    const clean = addCopy(fx, 'landed-clean');
    const dirty = addCopy(fx, 'landed-dirty');
    fs.writeFileSync(path.join(dirty, 'notes.txt'), 'unsaved thoughts\n');
    const pushed = addCopy(fx, 'landed-pushed', { commit: true, pushToOrigin: true });
    const open = addCopy(fx, 'not-landed', { commit: true });
    const busy = addCopy(fx, 'landed-busy');
    busyProcess = spawn('sleep', ['30'], { cwd: busy, stdio: 'ignore' });

    // A copy whose folder was swapped for a link to somewhere outside.
    const outside = path.join(fx.base, 'outside');
    fs.mkdirSync(outside);
    const linked = addCopy(fx, 'linked');
    fs.renameSync(linked, path.join(outside, 'linked'));
    fs.symlinkSync(path.join(outside, 'linked'), linked);

    // Dry run changes nothing.
    const preview = tidyMemberCopies({ repoRoot: fx.repo, dryRun: true });
    assert.equal(preview.aborted, null);
    assert.equal(byName(preview, 'landed-clean').action, 'would remove');
    assert.ok(fs.existsSync(clean));
    assert.ok(branchExists(fx.repo, 'landed-clean'));

    const result = tidyMemberCopies({ repoRoot: fx.repo });
    assert.equal(result.aborted, null);
    assert.equal(result.copies.length, 6);

    assert.equal(byName(result, 'landed-clean').action, 'removed');
    assert.equal(fs.existsSync(clean), false);
    assert.equal(branchExists(fx.repo, 'landed-clean'), false);

    // Landed on origin but the local master is behind: git removes the copy
    // and `branch -d` keeps the branch.
    assert.equal(byName(result, 'landed-pushed').action, 'removed');
    assert.equal(fs.existsSync(pushed), false);
    assert.match(byName(result, 'landed-pushed').reason, /branch kept/);
    assert.ok(branchExists(fx.repo, 'landed-pushed'));

    assert.equal(byName(result, 'landed-dirty').action, 'kept');
    assert.match(byName(result, 'landed-dirty').reason, /git refused/);
    assert.ok(fs.existsSync(path.join(dirty, 'notes.txt')));

    assert.equal(byName(result, 'not-landed').action, 'kept');
    assert.match(byName(result, 'not-landed').reason, /work not landed yet, \d+m old/);
    assert.ok(fs.existsSync(path.join(open, 'not-landed.txt')));

    assert.equal(byName(result, 'landed-busy').action, 'kept');
    assert.match(byName(result, 'landed-busy').reason, /still running/);
    assert.ok(fs.existsSync(busy));

    assert.equal(byName(result, 'linked').action, 'kept');
    assert.match(byName(result, 'linked').reason, /outside/);
    assert.ok(fs.existsSync(path.join(outside, 'linked', 'README.md')));

    const text = formatTidy(result);
    assert.equal(text.split('\n').length, 7);
    assert.match(text, /tidy: removed 2, kept 4, of 6 copies/);
  } finally {
    if (busyProcess) busyProcess.kill();
    fs.rmSync(fx.base, { recursive: true, force: true });
  }
});

// Origin switched its default branch, but the local origin/HEAD note still
// points at the old one. Work that only lives on the old branch is not landed.
test('tidy asks origin for its current default branch instead of the stale local note', () => {
  const fx = makeFixture();
  try {
    const remote = path.join(fx.base, 'remote.git');
    runGit(['push', '-q', remote, 'master:main'], path.join(fx.base, 'seed'));
    const oldOnly = addCopy(fx, 'old-default-only', { commit: true, pushToOrigin: true });
    runGit(['symbolic-ref', 'HEAD', 'refs/heads/main'], remote);
    assert.equal(runGit(['symbolic-ref', 'refs/remotes/origin/HEAD'], fx.repo), 'refs/remotes/origin/master');

    const result = tidyMemberCopies({ repoRoot: fx.repo });
    assert.equal(result.aborted, null);
    assert.equal(byName(result, 'old-default-only').action, 'kept');
    assert.match(byName(result, 'old-default-only').reason, /work not landed yet/);
    assert.ok(fs.existsSync(path.join(oldOnly, 'old-default-only.txt')));
    assert.ok(branchExists(fx.repo, 'old-default-only'));
  } finally {
    fs.rmSync(fx.base, { recursive: true, force: true });
  }
});

test('tidy keeps every copy when the running-program scan fails', () => {
  const fx = makeFixture();
  try {
    const clean = addCopy(fx, 'landed-clean');
    const failingLsof = path.join(fx.base, 'lsof-fails');
    fs.writeFileSync(failingLsof, '#!/bin/sh\necho "lsof broke" >&2\nexit 1\n', { mode: 0o755 });

    const result = tidyMemberCopies({ repoRoot: fx.repo, lsofBin: failingLsof });
    assert.match(result.aborted, /could not check for running programs: lsof broke/);
    assert.equal(result.removed, 0);
    assert.equal(byName(result, 'landed-clean').action, 'kept');
    assert.ok(fs.existsSync(clean));
    assert.ok(branchExists(fx.repo, 'landed-clean'));
    assert.match(formatTidy(result), /every copy is kept/);
  } finally {
    fs.rmSync(fx.base, { recursive: true, force: true });
  }
});

test('tidy keeps every copy when origin cannot be fetched', () => {
  const fx = makeFixture();
  try {
    const clean = addCopy(fx, 'landed-clean');
    runGit(['remote', 'set-url', 'origin', path.join(fx.base, 'gone.git')], fx.repo);
    const result = tidyMemberCopies({ repoRoot: fx.repo });
    assert.match(result.aborted, /could not ask origin for its main branch/);
    assert.equal(byName(result, 'landed-clean').action, 'kept');
    assert.ok(fs.existsSync(clean));
  } finally {
    fs.rmSync(fx.base, { recursive: true, force: true });
  }
});

test('tidy names the git lock file and its age when it keeps a landed copy', () => {
  const fx = makeFixture();
  try {
    const locked = addCopy(fx, 'landed-locked');
    const gitDir = runGit(['rev-parse', '--path-format=absolute', '--git-dir'], locked);
    const lockFile = path.join(gitDir, 'index.lock');
    fs.writeFileSync(lockFile, '');
    const now = Date.now();
    const aged = new Date(now - 3 * 60 * 60 * 1000);
    fs.utimesSync(lockFile, aged, aged);

    const result = tidyMemberCopies({ repoRoot: fx.repo, now });
    const kept = byName(result, 'landed-locked');
    assert.equal(kept.action, 'kept');
    assert.equal(kept.reason, `landed, but git holds ${lockFile}, 3 h old`);
    assert.ok(fs.existsSync(locked));
  } finally {
    fs.rmSync(fx.base, { recursive: true, force: true });
  }
});

function removalLines(repo) {
  const file = path.join(repo, '.atris', 'state', 'worktree_removals.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

test('all five cleanup paths report paused git work in the same words and keep it', () => {
  const fx = makeFixture();
  try {
    const copy = addCopy(fx, 'landed-paused');
    const gitDir = runGit(['rev-parse', '--absolute-git-dir'], copy);
    const hash = runGit(['rev-parse', 'HEAD'], fx.repo);
    const folder = path.join(fx.repo, `.regression-worktree-${hash.slice(0, 8)}`);
    const boundary = {
      trustedRoot: fx.repo, worktreePath: copy,
      sandboxRoot: path.join(fx.base, 'review'),
      gitDir: path.join(fx.base, 'review.git'),
      quarantine: path.join(fx.base, 'quarantine.git'),
    };
    fs.mkdirSync(boundary.quarantine);
    fs.mkdirSync(path.join(fx.repo, 'atris'));
    for (const [marker, operation] of [
      ['rebase-merge', 'rebase'], ['rebase-apply', 'rebase'],
      ['MERGE_HEAD', 'merge'], ['CHERRY_PICK_HEAD', 'cherry-pick'],
      ['REVERT_HEAD', 'revert'], ['BISECT_LOG', 'bisect'],
    ]) {
      const words = `a ${operation} is paused`;
      const markerPath = path.join(gitDir, marker);
      const directory = marker.startsWith('rebase-');
      if (directory) fs.mkdirSync(markerPath);
      else fs.writeFileSync(markerPath, `${hash}\n`);

      const tidy = tidyMemberCopies({ repoRoot: fx.repo });
      assert.equal(tidy.aborted, null);
      assert.equal(byName(tidy, 'landed-paused').action, 'kept');
      assert.equal(byName(tidy, 'landed-paused').reason, `landed, but ${words}`);
      const landed = reap(fx.repo, { remote: false, force: true, activeCwds: [] });
      assert.ok(landed.keptWorktrees.some((line) => line.startsWith(`${copy} (`) && line.endsWith(`: ${words})`)), marker);
      assert.ok(branchExists(fx.repo, 'landed-paused'));
      const cleaned = cleanupWorktrees({ root: fx.repo, base: 'HEAD', apply: true, activeCwds: [] });
      assert.deepEqual(cleaned.removed, []);
      assert.equal(describeGitHold(cleaned.kept.find((item) => item.path === copy)), words);
      const disposed = disposeReviewSandbox(boundary);
      assert.equal(disposed.removed, false);
      assert.equal(describeGitHold(disposed), words);
      assert.ok([copy, boundary.quarantine].every((item) => fs.existsSync(item)));

      // The real regression command leaves the same marker in its own copy.
      const verifyCmd = directory
        ? `mkdir "$(git rev-parse --git-dir)/${marker}"`
        : `git rev-parse HEAD > "$(git rev-parse --git-dir)/${marker}"`;
      fs.writeFileSync(path.join(fx.repo, 'atris', 'tick-registry.json'), JSON.stringify([{ hash, verifyCmd, slug: 'paused-proof' }]));
      const [row] = regressionCheck(fx.repo, { activeCwds: [] });
      assert.equal(row.pass, true);
      assert.equal(row.held, words);
      assert.equal(row.kept, disposed.reason);
      assert.equal(row.path, folder);
      assert.ok(fs.existsSync(folder));
      assert.deepEqual(removalLines(fx.repo), []);

      // Remove only this fixture's marker so the next case starts idle.
      fs.rmSync(path.join(runGit(['rev-parse', '--absolute-git-dir'], folder), marker), { recursive: directory });
      runGit(['worktree', 'remove', folder], fx.repo);
      fs.rmSync(markerPath, { recursive: directory });
    }
  } finally {
    fs.rmSync(fx.base, { recursive: true, force: true });
  }
});

test('tidy keeps a landed copy while git is paused mid-rebase in it, and logs what it removes', () => {
  const fx = makeFixture();
  try {
    const paused = addCopy(fx, 'landed-paused');
    const gitDir = runGit(['rev-parse', '--path-format=absolute', '--git-dir'], paused);
    fs.mkdirSync(path.join(gitDir, 'rebase-merge'));
    const clean = addCopy(fx, 'landed-clean');

    const result = tidyMemberCopies({ repoRoot: fx.repo });
    assert.equal(byName(result, 'landed-paused').action, 'kept');
    assert.equal(byName(result, 'landed-paused').reason, 'landed, but a rebase is paused');
    assert.ok(fs.existsSync(paused));
    assert.equal(byName(result, 'landed-clean').action, 'removed');

    const lines = removalLines(fx.repo);
    assert.deepEqual(lines.map((line) => line.path), [clean]);
    assert.equal(lines[0].branch, 'landed-clean');
    assert.equal(lines[0].by, 'atris member tidy');
    assert.equal(lines[0].reason, 'work_landed');
  } finally {
    fs.rmSync(fx.base, { recursive: true, force: true });
  }
});

test('tidy, reap and the regression check name a pinned folder in the same words', () => {
  const fx = makeFixture();
  try {
    const copy = addCopy(fx, 'landed-pinned');
    runGit(['worktree', 'lock', '--reason', 'agent still writing', copy], fx.repo);
    const pin = path.join(runGit(['rev-parse', '--absolute-git-dir'], copy), 'locked');
    const now = Date.now();
    const aged = new Date(now - 3 * 60 * 60 * 1000);
    fs.utimesSync(pin, aged, aged);
    fs.utimesSync(copy, aged, aged);
    const words = 'pinned by git worktree lock, 3 h old: agent still writing';

    const preview = tidyMemberCopies({ repoRoot: fx.repo, now, dryRun: true });
    assert.equal(byName(preview, 'landed-pinned').action, 'kept');
    assert.equal(byName(preview, 'landed-pinned').reason, `landed, but ${words}`);
    const tidy = tidyMemberCopies({ repoRoot: fx.repo, now });
    assert.equal(byName(tidy, 'landed-pinned').action, 'kept');
    assert.equal(byName(tidy, 'landed-pinned').reason, `landed, but ${words}`);
    const landed = reap(fx.repo, { remote: false, force: true, activeCwds: [] });
    assert.ok(landed.keptWorktrees.includes(`${copy} (${words})`), JSON.stringify(landed.keptWorktrees));
    assert.ok(fs.existsSync(copy));
    assert.ok(branchExists(fx.repo, 'landed-pinned'));

    // The real regression command pins its own copy, and git refuses it the same way.
    const hash = runGit(['rev-parse', 'HEAD'], fx.repo);
    const folder = path.join(fx.repo, `.regression-worktree-${hash.slice(0, 8)}`);
    fs.mkdirSync(path.join(fx.repo, 'atris'));
    fs.writeFileSync(path.join(fx.repo, 'atris', 'tick-registry.json'), JSON.stringify([
      { hash, verifyCmd: 'git worktree lock --reason "agent still writing" "$PWD"', slug: 'fixture' },
    ]));
    const [row] = regressionCheck(fx.repo, { activeCwds: [] });
    assert.equal(row.kept, 'remove_failed', JSON.stringify(row));
    assert.equal(row.held, 'pinned by git worktree lock, under a minute old: agent still writing');
    assert.ok(fs.existsSync(folder));
    assert.deepEqual(removalLines(fx.repo), []);
  } finally {
    fs.rmSync(fx.base, { recursive: true, force: true });
  }
});
