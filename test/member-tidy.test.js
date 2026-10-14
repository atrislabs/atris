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
    const removals = fs.readFileSync(path.join(fx.repo, '.atris/state/worktree_removals.jsonl'), 'utf8')
      .trim().split('\n').map(JSON.parse);
    assert.equal(removals.length, 2);
    assert.ok(removals.some((line) => line.path === clean && line.branch === 'landed-clean'));
    assert.ok(removals.every((line) => line.by === 'atris member tidy' && line.reason === 'branch_landed'));

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

test('tidy names private and shared locks even when the work has not landed', () => {
  const fx = makeFixture();
  try {
    const copy = addCopy(fx, 'unlanded-locked', { commit: true });
    runGit(['worktree', 'lock', '--reason', 'unfinished work', copy], fx.repo);
    const privateDir = runGit(['rev-parse', '--absolute-git-dir'], copy);
    const locks = [
      path.join(privateDir, 'index.lock'),
      path.join(privateDir, 'locked'),
      path.join(fx.repo, '.git', 'refs', 'heads', 'master.lock'),
    ];
    const now = Date.now();
    for (const [index, lock] of locks.entries()) {
      fs.writeFileSync(lock, 'unfinished git work\n');
      const aged = new Date(now - (7200 + index * 60) * 1000);
      fs.utimesSync(lock, aged, aged);
    }
    for (const dryRun of [true, false]) {
      const result = tidyMemberCopies({ repoRoot: fx.repo, dryRun, now });
      assert.equal(result.aborted, null);
      assert.equal(result.removed, 0);
      assert.equal(byName(result, 'unlanded-locked').action, 'kept');
      assert.match(byName(result, 'unlanded-locked').reason, /^work not landed yet, \d+m old; git locks:/);
      for (const [index, lock] of locks.entries()) {
        assert.ok(formatTidy(result).includes(`${lock} (${7200 + index * 60}s old)`), formatTidy(result));
      }

      const args = [path.resolve(__dirname, '../bin/atris.js'), 'member', 'tidy', '--dir', fx.copies];
      if (dryRun) args.push('--dry-run');
      const cli = spawnSync(process.execPath, args, {
        cwd: fx.repo, encoding: 'utf8', timeout: 90000,
        env: { ...process.env, ATRIS_NO_UPDATE_CHECK: '1' },
      });
      console.log(`command: node ${args.join(' ')}\n${cli.stdout.trim()}\nexit: ${cli.status}`);
      assert.equal(cli.status, 0, cli.stderr || cli.stdout);
      assert.match(cli.stdout, /kept\s+unlanded-locked\s+work not landed yet/);
      for (const lock of locks) {
        assert.ok(cli.stdout.includes(`${lock} (`), cli.stdout);
        const age = Number(cli.stdout.split(`${lock} (`)[1].match(/^(\d+)s old\)/)?.[1]);
        const elapsed = Math.floor((Date.now() - fs.statSync(lock).mtimeMs) / 1000);
        assert.ok(age <= elapsed && elapsed - age <= 5, cli.stdout);
        assert.ok(fs.existsSync(lock));
      }
      assert.ok(fs.existsSync(path.join(copy, 'unlanded-locked.txt')));
      assert.ok(branchExists(fx.repo, 'unlanded-locked'));
      assert.equal(fs.existsSync(path.join(fx.repo, '.atris/state/worktree_removals.jsonl')), false);
    }
  } finally {
    fs.rmSync(fx.base, { recursive: true, force: true });
  }
});

test('tidy names private and shared locks when a landed copy is still running', () => {
  const fx = makeFixture();
  try {
    const copy = addCopy(fx, 'busy-locked', {});
    runGit(['worktree', 'lock', '--reason', 'unfinished work', copy], fx.repo);
    const privateDir = runGit(['rev-parse', '--absolute-git-dir'], copy);
    const locks = [
      path.join(privateDir, 'index.lock'),
      path.join(privateDir, 'locked'),
      path.join(fx.repo, '.git', 'refs', 'heads', 'master.lock'),
    ];
    const now = Date.now();
    for (const [index, lock] of locks.entries()) {
      fs.writeFileSync(lock, 'unfinished git work\n');
      const aged = new Date(now - (7200 + index * 60) * 1000);
      fs.utimesSync(lock, aged, aged);
    }
    for (const dryRun of [true, false]) {
      const result = tidyMemberCopies({ repoRoot: fx.repo, cwd: copy, dryRun, now });
      assert.equal(result.aborted, null);
      assert.equal(result.removed, 0);
      assert.equal(byName(result, 'busy-locked').action, 'kept');
      assert.match(byName(result, 'busy-locked').reason, /^landed, but something is still running inside it; git locks:/);
      for (const [index, lock] of locks.entries()) {
        assert.ok(formatTidy(result).includes(`${lock} (${7200 + index * 60}s old)`), formatTidy(result));
      }

      const args = [path.resolve(__dirname, '../bin/atris.js'), 'member', 'tidy', '--dir', fx.copies];
      if (dryRun) args.push('--dry-run');
      const cli = spawnSync(process.execPath, args, {
        cwd: copy, encoding: 'utf8', timeout: 90000,
        env: { ...process.env, ATRIS_NO_UPDATE_CHECK: '1' },
      });
      console.log(`command: node ${args.join(' ')}\n${cli.stdout.trim()}\nexit: ${cli.status}`);
      assert.equal(cli.status, 0, cli.stderr || cli.stdout);
      assert.match(cli.stdout, /kept\s+busy-locked\s+landed, but something is still running inside it; git locks:/);
      for (const lock of locks) {
        assert.ok(cli.stdout.includes(`${lock} (`), cli.stdout);
        const age = Number(cli.stdout.split(`${lock} (`)[1].match(/^(\d+)s old\)/)?.[1]);
        const elapsed = Math.floor((Date.now() - fs.statSync(lock).mtimeMs) / 1000);
        assert.ok(age <= elapsed && elapsed - age <= 5, cli.stdout);
        assert.ok(fs.existsSync(lock));
      }
      assert.ok(fs.existsSync(path.join(copy, 'README.md')));
      assert.ok(branchExists(fx.repo, 'busy-locked'));
      assert.equal(fs.existsSync(path.join(fx.repo, '.atris/state/worktree_removals.jsonl')), false);
    }
  } finally {
    fs.rmSync(fx.base, { recursive: true, force: true });
  }
});

test('tidy keeps old private and shared git locks and reports every path and age', () => {
  const fx = makeFixture();
  try {
    const copy = addCopy(fx, 'landed-locked');
    const privateDir = runGit(['rev-parse', '--absolute-git-dir'], copy);
    const locks = [path.join(privateDir, 'index.lock'), path.join(fx.repo, '.git', 'refs', 'heads', 'master.lock')];
    const now = Date.now();
    const aged = new Date(now - 7200000);
    for (const lock of locks) {
      fs.writeFileSync(lock, 'unfinished git work\n');
      fs.utimesSync(lock, aged, aged);
    }
    for (const dryRun of [true, false]) {
      const result = tidyMemberCopies({ repoRoot: fx.repo, dryRun, now });
      assert.equal(result.aborted, null);
      assert.equal(result.removed, 0);
      assert.equal(byName(result, 'landed-locked').action, 'kept');
      for (const lock of locks) {
        assert.ok(formatTidy(result).includes(`${lock} (7200s old)`), formatTidy(result));
        assert.ok(fs.existsSync(lock));
      }
      assert.ok(fs.existsSync(copy));
      assert.ok(branchExists(fx.repo, 'landed-locked'));
      assert.equal(fs.existsSync(path.join(fx.repo, '.atris/state/worktree_removals.jsonl')), false);
    }
  } finally {
    fs.rmSync(fx.base, { recursive: true, force: true });
  }
});

// `git worktree lock` writes a `locked` file in the copy's private metadata.
// Tidy must name that file and its age, not just git's refusal text.
test('tidy keeps a copy git itself locked and reports the lock file and age', () => {
  const fx = makeFixture();
  try {
    const copy = addCopy(fx, 'landed-git-locked');
    runGit(['worktree', 'lock', '--reason', 'operator hold', copy], fx.repo);
    const lock = path.join(runGit(['rev-parse', '--absolute-git-dir'], copy), 'locked');
    const now = Date.now();
    const aged = new Date(now - 7200000);
    fs.utimesSync(lock, aged, aged);
    for (const dryRun of [true, false]) {
      const result = tidyMemberCopies({ repoRoot: fx.repo, dryRun, now });
      assert.equal(result.aborted, null);
      assert.equal(result.removed, 0);
      assert.equal(byName(result, 'landed-git-locked').action, 'kept');
      assert.ok(formatTidy(result).includes(`${lock} (7200s old)`), formatTidy(result));
      assert.ok(fs.existsSync(lock));
      assert.ok(fs.existsSync(copy));
      assert.ok(branchExists(fx.repo, 'landed-git-locked'));
      assert.equal(fs.existsSync(path.join(fx.repo, '.atris/state/worktree_removals.jsonl')), false);
    }
  } finally {
    fs.rmSync(fx.base, { recursive: true, force: true });
  }
});

test('tidy says a locked copy is missing and still names the lock file and age', () => {
  const fx = makeFixture();
  try {
    const copy = addCopy(fx, 'landed-locked-gone');
    runGit(['worktree', 'lock', '--reason', 'on an unplugged drive', copy], fx.repo);
    const lock = path.join(runGit(['rev-parse', '--absolute-git-dir'], copy), 'locked');
    const now = Date.now();
    const aged = new Date(now - 7200000);
    fs.utimesSync(lock, aged, aged);
    fs.rmSync(copy, { recursive: true, force: true });
    for (const dryRun of [true, false]) {
      const result = tidyMemberCopies({ repoRoot: fx.repo, dryRun, now });
      assert.equal(result.removed, 0);
      const kept = byName(result, 'landed-locked-gone');
      assert.equal(kept.action, 'kept');
      assert.equal(kept.reason, `folder is missing; git lock: ${lock} (7200s old)`);
      assert.ok(fs.existsSync(lock));
      assert.ok(branchExists(fx.repo, 'landed-locked-gone'));
      assert.equal(fs.existsSync(path.join(fx.repo, '.atris/state/worktree_removals.jsonl')), false);
    }
  } finally {
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

test('tidy names locks and keeps every copy when the running-program scan fails', () => {
  const fx = makeFixture();
  try {
    const clean = addCopy(fx, 'landed-clean');
    const copy = addCopy(fx, 'scan-failed-locked');
    runGit(['worktree', 'lock', '--reason', 'unfinished work', copy], fx.repo);
    const privateDir = runGit(['rev-parse', '--absolute-git-dir'], copy);
    const locks = [
      path.join(privateDir, 'index.lock'),
      path.join(privateDir, 'locked'),
      path.join(fx.repo, '.git', 'refs', 'heads', 'master.lock'),
    ];
    const now = Date.now();
    for (const [index, lock] of locks.entries()) {
      fs.writeFileSync(lock, 'unfinished git work\n');
      const aged = new Date(now - (7200 + index * 60) * 1000);
      fs.utimesSync(lock, aged, aged);
    }
    const failingLsof = path.join(fx.base, 'lsof');
    fs.writeFileSync(failingLsof, '#!/bin/sh\necho "lsof broke" >&2\nexit 1\n', { mode: 0o755 });

    for (const dryRun of [true, false]) {
      const result = tidyMemberCopies({ repoRoot: fx.repo, lsofBin: failingLsof, dryRun, now });
      assert.equal(result.aborted, 'could not check for running programs: lsof broke');
      assert.equal(result.removed, 0);
      assert.equal(result.kept, 2);
      assert.equal(byName(result, 'landed-clean').action, 'kept');
      assert.equal(byName(result, 'scan-failed-locked').action, 'kept');
      assert.match(byName(result, 'scan-failed-locked').reason, /^could not check for running programs: lsof broke; git locks:/);
      assert.match(formatTidy(result), /every copy is kept/);
      for (const [index, lock] of locks.entries()) {
        assert.ok(formatTidy(result).includes(`${lock} (${7200 + index * 60}s old)`), formatTidy(result));
      }
      assert.ok(!byName(result, 'landed-clean').reason.includes(locks[0]));
      assert.ok(!byName(result, 'landed-clean').reason.includes(locks[1]));

      const args = [path.resolve(__dirname, '../bin/atris.js'), 'member', 'tidy', '--dir', fx.copies];
      if (dryRun) args.push('--dry-run');
      const cli = spawnSync(process.execPath, args, {
        cwd: fx.repo, encoding: 'utf8', timeout: 90000,
        env: { ...process.env, PATH: `${fx.base}${path.delimiter}${process.env.PATH}`, ATRIS_NO_UPDATE_CHECK: '1' },
      });
      console.log(`command: PATH=${fx.base}:$PATH node ${args.join(' ')}\n${cli.stdout.trim()}\nexit: ${cli.status}`);
      assert.equal(cli.status, 1, cli.stderr || cli.stdout);
      assert.match(cli.stdout, /kept\s+scan-failed-locked\s+could not check for running programs: lsof broke; git locks:/);
      assert.match(cli.stdout, /tidy: removed 0, kept 2|tidy: would remove 0, kept 2/);
      for (const lock of locks) {
        assert.ok(cli.stdout.includes(`${lock} (`), cli.stdout);
        const age = Number(cli.stdout.split(`${lock} (`)[1].match(/^(\d+)s old\)/)?.[1]);
        const elapsed = Math.floor((Date.now() - fs.statSync(lock).mtimeMs) / 1000);
        assert.ok(age <= elapsed && elapsed - age <= 5, cli.stdout);
        assert.ok(fs.existsSync(lock));
      }
      for (const folder of [clean, copy]) {
        assert.ok(fs.existsSync(path.join(folder, 'README.md')));
        assert.ok(branchExists(fx.repo, path.basename(folder)));
      }
      assert.equal(fs.existsSync(path.join(fx.repo, '.atris/state/worktree_removals.jsonl')), false);
    }
  } finally {
    fs.rmSync(fx.base, { recursive: true, force: true });
  }
});

test('tidy names locks and keeps every copy when origin lookup fails', () => {
  const fx = makeFixture();
  try {
    const clean = addCopy(fx, 'landed-clean');
    const copy = addCopy(fx, 'origin-failed-locked');
    runGit(['worktree', 'lock', '--reason', 'unfinished work', copy], fx.repo);
    const privateDir = runGit(['rev-parse', '--absolute-git-dir'], copy);
    const locks = [
      path.join(privateDir, 'index.lock'),
      path.join(privateDir, 'locked'),
      path.join(fx.repo, '.git', 'refs', 'heads', 'master.lock'),
    ];
    const now = Date.now();
    for (const [index, lock] of locks.entries()) {
      fs.writeFileSync(lock, 'unfinished git work\n');
      const aged = new Date(now - (7200 + index * 60) * 1000);
      fs.utimesSync(lock, aged, aged);
    }
    runGit(['remote', 'set-url', 'origin', path.join(fx.base, 'gone.git')], fx.repo);

    for (const dryRun of [true, false]) {
      const result = tidyMemberCopies({ repoRoot: fx.repo, dryRun, now });
      assert.match(result.aborted, /^could not ask origin for its main branch:/);
      assert.equal(result.removed, 0);
      assert.equal(result.kept, 2);
      assert.equal(byName(result, 'landed-clean').action, 'kept');
      assert.equal(byName(result, 'origin-failed-locked').action, 'kept');
      assert.match(byName(result, 'origin-failed-locked').reason, /^could not ask origin for its main branch: .*; git locks:/);
      assert.match(formatTidy(result), /every copy is kept/);
      for (const [index, lock] of locks.entries()) {
        assert.ok(formatTidy(result).includes(`${lock} (${7200 + index * 60}s old)`), formatTidy(result));
      }
      assert.ok(!byName(result, 'landed-clean').reason.includes(locks[0]));
      assert.ok(!byName(result, 'landed-clean').reason.includes(locks[1]));

      const args = [path.resolve(__dirname, '../bin/atris.js'), 'member', 'tidy', '--dir', fx.copies];
      if (dryRun) args.push('--dry-run');
      const cli = spawnSync(process.execPath, args, {
        cwd: fx.repo, encoding: 'utf8', timeout: 90000,
        env: { ...process.env, ATRIS_NO_UPDATE_CHECK: '1' },
      });
      console.log(`command: node ${args.join(' ')}\n${cli.stdout.trim()}\nexit: ${cli.status}`);
      assert.equal(cli.status, 1, cli.stderr || cli.stdout);
      assert.match(cli.stdout, /kept\s+origin-failed-locked\s+could not ask origin for its main branch: .*; git locks:/);
      assert.match(cli.stdout, /tidy: removed 0, kept 2|tidy: would remove 0, kept 2/);
      for (const lock of locks) {
        assert.ok(cli.stdout.includes(`${lock} (`), cli.stdout);
        const age = Number(cli.stdout.split(`${lock} (`)[1].match(/^(\d+)s old\)/)?.[1]);
        const elapsed = Math.floor((Date.now() - fs.statSync(lock).mtimeMs) / 1000);
        assert.ok(age <= elapsed && elapsed - age <= 5, cli.stdout);
        assert.ok(fs.existsSync(lock));
      }
      for (const folder of [clean, copy]) {
        assert.ok(fs.existsSync(path.join(folder, 'README.md')));
        assert.ok(branchExists(fx.repo, path.basename(folder)));
      }
      assert.equal(fs.existsSync(path.join(fx.repo, '.atris/state/worktree_removals.jsonl')), false);
    }
  } finally {
    fs.rmSync(fx.base, { recursive: true, force: true });
  }
});

test('tidy names locks when git cannot determine whether a copy landed', () => {
  const fx = makeFixture();
  try {
    const copy = addCopy(fx, 'branch-missing-locked');
    runGit(['worktree', 'lock', '--reason', 'unfinished work', copy], fx.repo);
    const privateDir = runGit(['rev-parse', '--absolute-git-dir'], copy);
    const locks = [
      path.join(privateDir, 'index.lock'),
      path.join(privateDir, 'locked'),
      path.join(fx.repo, '.git', 'refs', 'heads', 'master.lock'),
    ];
    const now = Date.now();
    for (const [index, lock] of locks.entries()) {
      fs.writeFileSync(lock, 'unfinished git work\n');
      const aged = new Date(now - (7200 + index * 60) * 1000);
      fs.utimesSync(lock, aged, aged);
    }
    // A registered copy can outlive its branch reference. Use real Git to
    // reproduce merge-base failing without changing the cleanup helpers.
    runGit(['update-ref', '-d', 'refs/heads/branch-missing-locked'], fx.repo);

    for (const dryRun of [true, false]) {
      const result = tidyMemberCopies({ repoRoot: fx.repo, dryRun, now });
      assert.equal(result.aborted, null);
      assert.equal(result.removed, 0);
      assert.equal(result.kept, 1);
      assert.equal(byName(result, 'branch-missing-locked').action, 'kept');
      assert.match(byName(result, 'branch-missing-locked').reason, /^git could not tell if it landed: .*; git locks:/);
      for (const [index, lock] of locks.entries()) {
        assert.ok(formatTidy(result).includes(`${lock} (${7200 + index * 60}s old)`), formatTidy(result));
      }

      const args = [path.resolve(__dirname, '../bin/atris.js'), 'member', 'tidy', '--dir', fx.copies];
      if (dryRun) args.push('--dry-run');
      const cli = spawnSync(process.execPath, args, {
        cwd: fx.repo, encoding: 'utf8', timeout: 90000,
        env: { ...process.env, ATRIS_NO_UPDATE_CHECK: '1' },
      });
      console.log(`command: node ${args.join(' ')}\n${cli.stdout.trim()}\nexit: ${cli.status}`);
      assert.equal(cli.status, 0, cli.stderr || cli.stdout);
      assert.match(cli.stdout, /kept\s+branch-missing-locked\s+git could not tell if it landed: .*; git locks:/);
      assert.match(cli.stdout, /tidy: removed 0, kept 1|tidy: would remove 0, kept 1/);
      for (const lock of locks) {
        assert.ok(cli.stdout.includes(`${lock} (`), cli.stdout);
        const age = Number(cli.stdout.split(`${lock} (`)[1].match(/^(\d+)s old\)/)?.[1]);
        const elapsed = Math.floor((Date.now() - fs.statSync(lock).mtimeMs) / 1000);
        assert.ok(age <= elapsed && elapsed - age <= 5, cli.stdout);
        assert.ok(fs.existsSync(lock));
      }
      assert.ok(fs.existsSync(path.join(copy, 'README.md')));
      assert.equal(branchExists(fx.repo, 'branch-missing-locked'), false);
      assert.ok(runGit(['worktree', 'list', '--porcelain'], fx.repo).includes(`worktree ${copy}`));
      assert.equal(fs.existsSync(path.join(fx.repo, '.atris/state/worktree_removals.jsonl')), false);
    }
  } finally {
    fs.rmSync(fx.base, { recursive: true, force: true });
  }
});

test('tidy names private and shared locks when a copy is detached', () => {
  const fx = makeFixture();
  try {
    const copy = addCopy(fx, 'detached-locked');
    runGit(['checkout', '--detach', '-q'], copy);
    runGit(['worktree', 'lock', '--reason', 'unfinished work', copy], fx.repo);
    const privateDir = runGit(['rev-parse', '--absolute-git-dir'], copy);
    const locks = [
      path.join(privateDir, 'index.lock'),
      path.join(privateDir, 'locked'),
      path.join(fx.repo, '.git', 'refs', 'heads', 'master.lock'),
    ];
    const now = Date.now();
    for (const [index, lock] of locks.entries()) {
      fs.writeFileSync(lock, 'unfinished git work\n');
      const aged = new Date(now - (7200 + index * 60) * 1000);
      fs.utimesSync(lock, aged, aged);
    }

    for (const dryRun of [true, false]) {
      const result = tidyMemberCopies({ repoRoot: fx.repo, dryRun, now });
      assert.equal(result.aborted, null);
      assert.equal(result.removed, 0);
      assert.equal(result.kept, 1);
      assert.equal(byName(result, 'detached-locked').action, 'kept');
      assert.match(byName(result, 'detached-locked').reason, /^not on a branch; git locks:/);
      for (const [index, lock] of locks.entries()) {
        assert.ok(formatTidy(result).includes(`${lock} (${7200 + index * 60}s old)`), formatTidy(result));
      }

      const args = [path.resolve(__dirname, '../bin/atris.js'), 'member', 'tidy', '--dir', fx.copies];
      if (dryRun) args.push('--dry-run');
      const cli = spawnSync(process.execPath, args, {
        cwd: fx.repo, encoding: 'utf8', timeout: 90000,
        env: { ...process.env, ATRIS_NO_UPDATE_CHECK: '1' },
      });
      console.log(`command: node ${args.join(' ')}\n${cli.stdout.trim()}\nexit: ${cli.status}`);
      assert.equal(cli.status, 0, cli.stderr || cli.stdout);
      assert.match(cli.stdout, /kept\s+detached-locked\s+not on a branch; git locks:/);
      assert.match(cli.stdout, /tidy: removed 0, kept 1|tidy: would remove 0, kept 1/);
      for (const lock of locks) {
        assert.ok(cli.stdout.includes(`${lock} (`), cli.stdout);
        const age = Number(cli.stdout.split(`${lock} (`)[1].match(/^(\d+)s old\)/)?.[1]);
        const elapsed = Math.floor((Date.now() - fs.statSync(lock).mtimeMs) / 1000);
        assert.ok(age <= elapsed && elapsed - age <= 5, cli.stdout);
        assert.ok(fs.existsSync(lock));
      }
      assert.ok(fs.existsSync(path.join(copy, 'README.md')));
      assert.ok(branchExists(fx.repo, 'detached-locked'));
      assert.equal(byName(result, 'detached-locked').branch, null);
      assert.ok(runGit(['worktree', 'list', '--porcelain'], fx.repo).includes(`worktree ${copy}`));
      assert.equal(fs.existsSync(path.join(fx.repo, '.atris/state/worktree_removals.jsonl')), false);
    }
  } finally {
    fs.rmSync(fx.base, { recursive: true, force: true });
  }
});

test('tidy names private and shared locks when a copy points outside the copies folder', () => {
  const fx = makeFixture();
  try {
    const copy = addCopy(fx, 'outside-locked');
    runGit(['worktree', 'lock', '--reason', 'unfinished work', copy], fx.repo);
    const privateDir = runGit(['rev-parse', '--absolute-git-dir'], copy);
    const locks = [
      path.join(privateDir, 'index.lock'),
      path.join(privateDir, 'locked'),
      path.join(fx.repo, '.git', 'refs', 'heads', 'master.lock'),
    ];
    const now = Date.now();
    for (const [index, lock] of locks.entries()) {
      fs.writeFileSync(lock, 'unfinished git work\n');
      const aged = new Date(now - (7200 + index * 60) * 1000);
      fs.utimesSync(lock, aged, aged);
    }

    const outside = path.join(fx.base, 'outside');
    fs.renameSync(copy, outside);
    fs.symlinkSync(outside, copy);

    for (const dryRun of [true, false]) {
      const result = tidyMemberCopies({ repoRoot: fx.repo, dryRun, now });
      assert.equal(result.aborted, null);
      assert.equal(result.removed, 0);
      assert.equal(result.kept, 1);
      assert.equal(byName(result, 'outside-locked').action, 'kept');
      assert.match(byName(result, 'outside-locked').reason, /^points outside the copies folder, left alone; git locks:/);
      for (const [index, lock] of locks.entries()) {
        assert.ok(formatTidy(result).includes(`${lock} (${7200 + index * 60}s old)`), formatTidy(result));
      }

      const args = [path.resolve(__dirname, '../bin/atris.js'), 'member', 'tidy', '--dir', fx.copies];
      if (dryRun) args.push('--dry-run');
      const cli = spawnSync(process.execPath, args, {
        cwd: fx.repo, encoding: 'utf8', timeout: 90000,
        env: { ...process.env, ATRIS_NO_UPDATE_CHECK: '1' },
      });
      console.log(`command: node ${args.join(' ')}\n${cli.stdout.trim()}\nexit: ${cli.status}`);
      assert.equal(cli.status, 0, cli.stderr || cli.stdout);
      assert.match(cli.stdout, /kept\s+outside-locked\s+points outside the copies folder, left alone; git locks:/);
      assert.match(cli.stdout, /tidy: removed 0, kept 1|tidy: would remove 0, kept 1/);
      for (const lock of locks) {
        assert.ok(cli.stdout.includes(`${lock} (`), cli.stdout);
        const age = Number(cli.stdout.split(`${lock} (`)[1].match(/^(\d+)s old\)/)?.[1]);
        const elapsed = Math.floor((Date.now() - fs.statSync(lock).mtimeMs) / 1000);
        assert.ok(age <= elapsed && elapsed - age <= 5, cli.stdout);
        assert.ok(fs.existsSync(lock));
      }
      assert.ok(fs.existsSync(path.join(copy, 'README.md')));
      assert.ok(branchExists(fx.repo, 'outside-locked'));
      assert.equal(byName(result, 'outside-locked').branch, 'outside-locked');
      assert.ok(fs.lstatSync(copy).isSymbolicLink());
      assert.equal(fs.realpathSync(copy), outside);
      assert.ok(fs.existsSync(path.join(outside, 'README.md')));
      assert.ok(runGit(['worktree', 'list', '--porcelain'], fx.repo).includes(`worktree ${copy}`));
      assert.equal(fs.existsSync(path.join(fx.repo, '.atris/state/worktree_removals.jsonl')), false);
    }
  } finally {
    fs.rmSync(fx.base, { recursive: true, force: true });
  }
});

// Move generated folders or add locks at the final check; calls use real git.
test('tidy keeps late locks and keep markers whether the folder disappears or stays present, and folders moved after a passing check', () => {
  const audit = spawnSync(process.execPath, [path.resolve(__dirname, '../atris/receipts/2026-10-14-tidy-vanishing-folder-check.js')], {
    encoding: 'utf8', timeout: 120000,
  });
  const fixture = audit.stdout?.match(/^fixture: (.+)$/m)?.[1];
  try {
    assert.equal(audit.status, 0, audit.stderr || audit.stdout);
    assert.match(audit.stdout, /all eight timing cases passed; Git refusal after a passing check named three locks and distinct ages, also when the folder moved/);
  } finally {
    if (fixture && path.basename(fixture).startsWith('atris-tidy-vanishing-')
      && path.dirname(fixture) === fs.realpathSync(os.tmpdir())) {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  }
});
