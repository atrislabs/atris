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
