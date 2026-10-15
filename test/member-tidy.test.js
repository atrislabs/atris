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
const { cleanupWorktrees, describeGitHold, describeRemovalResult } = require('../commands/worktree');
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

    // Copies still at work share one count line; only copies that need a
    // person, or that were removed, get their own line.
    const text = formatTidy(result);
    assert.deepEqual(text.split('\n').map((line) => line.split(/\s{2,}/).slice(0, 2).join(' | ')), [
      'removed | landed-clean',
      'kept | landed-dirty',
      'removed | landed-pushed',
      'kept | linked',
      'left alone | 1 something still running inside, 1 work not landed yet',
      `tidy: removed 2, kept 4, of 6 copies in ${result.worktreesDir}`,
    ]);
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

for (const [mode, surface] of ['pin', 'signal'].flatMap((m) => ['tidy', 'cleanup', 'reap', 'autopilot', 'autopilot-failed'].map((s) => [m, s]))) {
  const what = mode === 'pin' ? 'a pin acquired after preflight' : 'a removal stopped by a signal';
  test(`${surface} reports ${what} and leaves the copy registered`, () => {
    const fx = makeFixture();
    try {
      const automatic = surface.startsWith('autopilot');
      const pass = surface !== 'autopilot-failed';
      const hash = runGit(['rev-parse', 'HEAD'], fx.repo);
      const copy = automatic
        ? path.join(fx.repo, `.regression-worktree-${hash.slice(0, 8)}`)
        : addCopy(fx, 'landed-late-pin');
      if (automatic) {
        fs.mkdirSync(path.join(fx.repo, 'atris'));
        fs.writeFileSync(path.join(fx.repo, 'atris', 'tick-registry.json'), JSON.stringify([
          { hash, verifyCmd: pass ? 'true' : 'exit 1', slug: 'late-pin-proof' },
        ]));
      }
      const aged = new Date(Date.now() - 3 * 60 * 60 * 1000);
      if (!automatic) fs.utimesSync(copy, aged, aged);
      const realGit = spawnSync('which', ['git'], { encoding: 'utf8' });
      assert.equal(realGit.status, 0, realGit.stderr);
      const bin = path.join(fx.base, 'bin');
      fs.mkdirSync(bin);
      const attempt = path.join(fx.base, 'remove-attempt.json');
      const reason = 'agent started\n  writing\tplease wait';
      // Only schedule the race here. The real git creates the pin and decides
      // whether removal is allowed, after the command has completed its own
      // checks; in signal mode the removal is stopped before git runs at all.
      fs.writeFileSync(path.join(bin, 'git'), `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const args = process.argv.slice(2);
const git = ${JSON.stringify(realGit.stdout.trim())};
const removing = args[0] === 'worktree' && args[1] === 'remove';
if (removing) fs.writeFileSync(${JSON.stringify(attempt)}, JSON.stringify(args));
if (removing && ${JSON.stringify(mode)} === 'signal') {
  process.kill(process.pid, 'SIGTERM');
  setTimeout(() => process.exit(1), 5000);
} else {
  if (removing) {
    const pin = spawnSync(git, ['worktree', 'lock', '--reason', ${JSON.stringify(reason)}, ${JSON.stringify(copy)}], { encoding: 'utf8' });
    if (pin.status !== 0) { process.stderr.write(pin.stderr); process.exit(1); }
  }
  const result = spawnSync(git, args, { stdio: 'inherit' });
  process.exit(result.status === null ? 1 : result.status);
}
`, { mode: 0o755 });
      const args = surface === 'tidy'
        ? ['member', 'tidy', '--dir', fx.copies]
        : surface === 'cleanup'
          ? ['worktree', 'cleanup', '--base', 'HEAD', '--apply']
          : ['land', '--reap', '--base', 'HEAD', '--no-remote', '--json'];
      const invocation = automatic
        ? ['-e', `console.log(JSON.stringify(require(${JSON.stringify(path.resolve(__dirname, '../commands/autopilot.js'))}).regressionCheck(process.cwd(), { activeCwds: [] })))`]
        : [path.resolve(__dirname, '../bin/atris.js'), ...args];
      const cli = spawnSync(process.execPath, invocation,
        { cwd: fx.repo, encoding: 'utf8', timeout: 30000,
          env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
      const command = automatic
        ? `node -e ${JSON.stringify(invocation[1])}`
        : `node bin/atris.js ${surface === 'tidy' ? 'member tidy --dir <fixture copies>' : args.join(' ')}`;
      console.log(`command: ${command} (${mode === 'pin' ? 'late-pin' : 'stopped-removal'} git wrapper)`);
      console.log(cli.stdout.trim());
      console.log(`exit: ${cli.status}`);
      assert.equal(cli.status, 0, cli.stderr);
      assert.deepEqual(JSON.parse(fs.readFileSync(attempt, 'utf8')),
        ['worktree', 'remove', ...(surface === 'reap' ? ['--force'] : []), copy, ...(automatic ? ['--force'] : [])]);
      const words = mode === 'pin'
        ? 'pinned by git worktree lock, under a minute old: agent started writing please wait'
        : 'git removal stopped by SIGTERM';
      if (automatic) {
        assert.deepEqual(JSON.parse(cli.stdout), [{
          hash, slug: 'late-pin-proof', pass, kept: 'remove_failed', held: words, path: copy,
        }]);
        const lessonPath = path.join(fx.repo, 'atris', 'lessons.md');
        if (pass) assert.equal(fs.existsSync(lessonPath), false);
        else {
          const lesson = fs.readFileSync(lessonPath, 'utf8');
          assert.ok(lesson.includes('regression-late-pin-proof** - fail -'), lesson);
          assert.ok(lesson.includes(`verify command for tick ${hash.slice(0, 7)} (late-pin-proof) now fails`), lesson);
          console.log('held copy preserved; disposable lesson stayed on disk');
        }
      } else if (surface === 'reap') {
        const receipt = JSON.parse(cli.stdout);
        assert.deepEqual(receipt.removedWorktrees, []);
        assert.deepEqual(receipt.deletedBranches, []);
        assert.ok(receipt.keptWorktrees.includes(`${copy} (${words})`), cli.stdout);
      } else {
        const expected = surface === 'tidy'
          ? `kept  landed-late-pin  landed, but git refused: ${words}\ntidy: removed 0, kept 1, of 1 copy in ${fx.copies}`
          : `cleanup: applied base=HEAD\nremoveds: 0\ncache_pruneds: 0\nkept: 2\nleft alone: primary_checkout=1\nkept: ${copy} branch=landed-late-pin reason=remove_failed\nrefused: ${copy} ${words}`;
        assert.equal(cli.stdout.trim(), expected);
      }
      const gitDir = runGit(['rev-parse', '--absolute-git-dir'], copy);
      if (mode === 'pin') assert.equal(fs.readFileSync(path.join(gitDir, 'locked'), 'utf8'), `${reason}\n`);
      else assert.equal(fs.existsSync(path.join(gitDir, 'locked')), false);
      assert.ok(fs.existsSync(path.join(copy, 'README.md')));
      if (!automatic) assert.ok(branchExists(fx.repo, 'landed-late-pin'));
      else assert.equal(runGit(['rev-parse', 'HEAD'], copy), hash);
      assert.ok(runGit(['worktree', 'list', '--porcelain'], fx.repo).includes(`worktree ${copy}\n`));
      assert.deepEqual(removalLines(fx.repo), []);
    } finally {
      fs.rmSync(fx.base, { recursive: true, force: true });
    }
  });
}

// Tidy gives git a time limit. A removal killed at that limit did run, so the
// shared line names the timeout, not a launch failure or Node's error code.
test('a removal stopped at its time limit reads as a timeout, even after partial output', () => {
  for (const script of ['setTimeout(() => {}, 5000)', 'process.stderr.write("fatal: still working\\n"); setTimeout(() => {}, 5000)']) {
    const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 300 });
    assert.equal(result.error && result.error.code, 'ETIMEDOUT');
    assert.equal(describeRemovalResult('/nowhere', result), 'git removal timed out');
  }
});

test('real pins and locks take precedence over interrupted removal details', () => {
  const fx = makeFixture();
  try {
    const copy = addCopy(fx, 'held-copy');
    const lock = path.join(runGit(['rev-parse', '--absolute-git-dir'], copy), 'index.lock');
    const interrupted = spawnSync(process.execPath, ['-e', "process.kill(process.pid, 'SIGTERM')"], { encoding: 'utf8' });
    assert.equal(interrupted.status, null);
    assert.equal(interrupted.signal, 'SIGTERM');
    const timedOut = spawnSync(process.execPath, ['-e', 'process.stderr.write("partial progress"); setInterval(() => {}, 1000)'], { encoding: 'utf8', timeout: 1000 });
    assert.equal(timedOut.error?.code, 'ETIMEDOUT');
    assert.equal(timedOut.stderr, 'partial progress');
    runGit(['worktree', 'lock', '--reason', 'writer still active', copy], fx.repo);
    fs.writeFileSync(lock, '');
    const now = Date.now();
    for (const result of [interrupted, timedOut]) {
      assert.equal(describeRemovalResult(copy, result, now),
        'pinned by git worktree lock, under a minute old: writer still active');
    }
    runGit(['worktree', 'unlock', copy], fx.repo);
    for (const result of [interrupted, timedOut]) {
      assert.equal(describeRemovalResult(copy, result, now), `git holds ${lock}, under a minute old`);
    }
    assert.ok(fs.existsSync(lock));
    assert.equal(fs.readFileSync(path.join(copy, 'README.md'), 'utf8'), '# fixture\n');
    assert.ok(runGit(['worktree', 'list', '--porcelain'], fx.repo).includes(`worktree ${copy}\n`));
    assert.deepEqual(removalLines(fx.repo), []);
  } finally {
    fs.rmSync(fx.base, { recursive: true, force: true });
  }
});

for (const reason of ['agent still writing', 'agent still\n  writing\tplease wait']) {
  test(`tidy, reap and the regression check flatten a pin reason: ${JSON.stringify(reason)}`, () => {
    const fx = makeFixture();
    try {
      const copy = addCopy(fx, 'landed-pinned');
      runGit(['worktree', 'lock', '--reason', reason, copy], fx.repo);
      const pin = path.join(runGit(['rev-parse', '--absolute-git-dir'], copy), 'locked');
      const now = Date.now();
      const aged = new Date(now - 3 * 60 * 60 * 1000);
      fs.utimesSync(pin, aged, aged);
      fs.utimesSync(copy, aged, aged);
      const flatReason = reason.replace(/\s+/g, ' ').trim();
      const words = `pinned by git worktree lock, 3 h old: ${flatReason}`;

      const preview = tidyMemberCopies({ repoRoot: fx.repo, now, dryRun: true });
      assert.equal(byName(preview, 'landed-pinned').action, 'kept');
      assert.equal(byName(preview, 'landed-pinned').reason, `landed, but ${words}`);
      const tidy = tidyMemberCopies({ repoRoot: fx.repo, now });
      assert.equal(byName(tidy, 'landed-pinned').action, 'kept');
      assert.equal(byName(tidy, 'landed-pinned').reason, `landed, but ${words}`);
      const cliArgs = [path.resolve(__dirname, '../bin/atris.js'), 'member', 'tidy', '--dir', fx.copies];
      const cli = spawnSync(process.execPath, cliArgs, { cwd: fx.repo, encoding: 'utf8', timeout: 15000 });
      console.log('command: node bin/atris.js member tidy --dir <fixture copies> (fixture cwd)');
      console.log(cli.stdout.trim());
      console.log(`exit: ${cli.status}`);
      assert.equal(cli.status, 0, cli.stderr);
      assert.ok(cli.stdout.includes(`kept  landed-pinned  landed, but ${words}`), cli.stdout);
      assert.equal(cli.stdout.trim().split('\n').length, 2);
      const landed = reap(fx.repo, { remote: false, force: true, activeCwds: [] });
      assert.ok(landed.keptWorktrees.includes(`${copy} (${words})`), JSON.stringify(landed.keptWorktrees));
      assert.ok(fs.existsSync(copy));
      assert.ok(branchExists(fx.repo, 'landed-pinned'));

      // The real regression command pins its own copy, and git refuses it the same way.
      const hash = runGit(['rev-parse', 'HEAD'], fx.repo);
      const folder = path.join(fx.repo, `.regression-worktree-${hash.slice(0, 8)}`);
      fs.mkdirSync(path.join(fx.repo, 'atris'));
      fs.writeFileSync(path.join(fx.repo, 'atris', 'tick-registry.json'), JSON.stringify([
        { hash, verifyCmd: `git worktree lock --reason '${reason}' "$PWD"`, slug: 'fixture' },
      ]));
      const [row] = regressionCheck(fx.repo, { activeCwds: [] });
      assert.equal(row.kept, 'remove_failed', JSON.stringify(row));
      assert.equal(row.pass, true);
      assert.equal(row.held, `pinned by git worktree lock, under a minute old: ${flatReason}`);
      assert.equal(fs.readFileSync(pin, 'utf8'), `${reason}\n`);
      const regressionPin = path.join(runGit(['rev-parse', '--absolute-git-dir'], folder), 'locked');
      assert.equal(fs.readFileSync(regressionPin, 'utf8'), `${reason}\n`);
      assert.ok(runGit(['worktree', 'list', '--porcelain'], fx.repo).includes(folder));
      assert.ok(fs.existsSync(folder));
      assert.deepEqual(removalLines(fx.repo), []);
    } finally {
      fs.rmSync(fx.base, { recursive: true, force: true });
    }
  });
}


test('tidy names pinned unfinished work beside the count of ordinary ongoing work', () => {
  const fx = makeFixture();
  try {
    const pinned = addCopy(fx, 'unfinished-pinned', { commit: true });
    const ordinary = addCopy(fx, 'unfinished-ordinary', { commit: true });
    const reason = 'writer still active\n  keep these notes';
    runGit(['worktree', 'lock', '--reason', reason, pinned], fx.repo);
    const pin = path.join(runGit(['rev-parse', '--absolute-git-dir'], pinned), 'locked');
    const now = Date.now();
    const aged = new Date(now - 3 * 60 * 60 * 1000);
    fs.utimesSync(pin, aged, aged);
    const words = 'work not landed yet, pinned by git worktree lock, 3 h old: writer still active keep these notes';
    const before = new Map();
    for (const copy of [pinned, ordinary]) {
      fs.writeFileSync(path.join(copy, 'draft.txt'), `notes for ${path.basename(copy)}\n`);
      fs.appendFileSync(path.join(copy, `${path.basename(copy)}.txt`), 'unsaved edits\n');
      fs.writeFileSync(path.join(copy, 'staged.txt'), 'prepared notes\n');
      runGit(['add', 'staged.txt'], copy);
      fs.appendFileSync(path.join(copy, 'staged.txt'), 'later edits\n');
      const status = runGit(['status', '--porcelain'], copy);
      assert.ok(status.includes('?? draft.txt'));
      assert.ok(status.includes(`M ${path.basename(copy)}.txt`));
      assert.ok(status.includes('AM staged.txt'));
      assert.equal(runGit(['show', ':staged.txt'], copy), 'prepared notes');
      before.set(copy, { status, patch: runGit(['diff', '--cached', '--binary'], copy) });
    }

    const preview = tidyMemberCopies({ repoRoot: fx.repo, now, dryRun: true });
    assert.equal(preview.aborted, null);
    assert.equal(preview.removed, 0);
    assert.equal(preview.kept, 2);
    assert.equal(byName(preview, 'unfinished-pinned').reason, words);
    assert.equal(byName(preview, 'unfinished-pinned').quiet, undefined);
    assert.equal(byName(preview, 'unfinished-ordinary').quiet, 'work not landed yet');

    for (const extra of [['--dry-run'], []]) {
      const args = [path.resolve(__dirname, '../bin/atris.js'), 'member', 'tidy', '--dir', fx.copies, ...extra];
      const cli = spawnSync(process.execPath, args, { cwd: fx.repo, encoding: 'utf8', timeout: 15000 });
      console.log(`command: node bin/atris.js member tidy --dir <fixture copies>${extra.length ? ' --dry-run' : ''} (fixture cwd)`);
      console.log(cli.stdout.trim());
      console.log(`exit: ${cli.status}`);
      assert.equal(cli.status, 0, cli.stderr);
      assert.deepEqual(cli.stdout.trim().split('\n'), [
        `kept  unfinished-pinned  ${words}`,
        'left alone  1 work not landed yet',
        `tidy: ${extra.length ? 'would remove' : 'removed'} 0, kept 2, of 2 copies in ${fx.copies}`,
      ]);
      assert.equal(fs.readFileSync(pin, 'utf8'), `${reason}\n`);
      const registered = runGit(['worktree', 'list', '--porcelain'], fx.repo);
      for (const copy of [pinned, ordinary]) {
        const name = path.basename(copy);
        assert.equal(fs.readFileSync(path.join(copy, `${name}.txt`), 'utf8'), 'work\nunsaved edits\n');
        assert.equal(fs.readFileSync(path.join(copy, 'draft.txt'), 'utf8'), `notes for ${name}\n`);
        assert.equal(fs.readFileSync(path.join(copy, 'staged.txt'), 'utf8'), 'prepared notes\nlater edits\n');
        assert.equal(runGit(['show', ':staged.txt'], copy), 'prepared notes');
        assert.equal(runGit(['diff', '--cached', '--binary'], copy), before.get(copy).patch);
        assert.equal(runGit(['status', '--porcelain'], copy), before.get(copy).status);
        assert.ok(branchExists(fx.repo, name));
        assert.ok(registered.includes(`worktree ${copy}\n`));
      }
      assert.deepEqual(removalLines(fx.repo), []);
    }
  } finally {
    fs.rmSync(fx.base, { recursive: true, force: true });
  }
});


for (const unfinished of [false, true]) {
test(`tidy names pinned busy ${unfinished ? 'unfinished' : 'landed'} copies beside the ordinary ongoing count`, async () => {
  const fx = makeFixture();
  const children = [];
  try {
    const pinned = addCopy(fx, 'busy-pinned', { commit: unfinished });
    const ordinary = addCopy(fx, 'busy-ordinary', { commit: unfinished });
    const reason = 'writer still active\n  keep these notes';
    runGit(['worktree', 'lock', '--reason', reason, pinned], fx.repo);
    const pin = path.join(runGit(['rev-parse', '--absolute-git-dir'], pinned), 'locked');
    const now = Date.now();
    const aged = new Date(now - 3 * 60 * 60 * 1000);
    fs.utimesSync(pin, aged, aged);
    const words = `${unfinished ? 'work not landed yet,' : 'landed, but'} pinned by git worktree lock, 3 h old: writer still active keep these notes`;
    const group = unfinished ? 'work not landed yet' : 'something still running inside';
    const unsaved = new Map();
    const staged = new Map();
    for (const copy of [pinned, ordinary]) {
      if (unfinished) {
        fs.writeFileSync(path.join(copy, 'draft.txt'), `notes for ${path.basename(copy)}\n`);
        fs.appendFileSync(path.join(copy, `${path.basename(copy)}.txt`), 'unsaved edits\n');
        fs.writeFileSync(path.join(copy, 'staged.txt'), 'prepared notes\n');
        runGit(['add', 'staged.txt'], copy);
        fs.appendFileSync(path.join(copy, 'staged.txt'), 'later edits\n');
        staged.set(copy, runGit(['diff', '--cached', '--binary'], copy));
        assert.equal(runGit(['show', ':staged.txt'], copy), 'prepared notes');
        unsaved.set(copy, runGit(['status', '--porcelain'], copy));
        assert.ok(unsaved.get(copy).includes('?? draft.txt'));
        assert.ok(unsaved.get(copy).includes(`M ${path.basename(copy)}.txt`));
        assert.ok(unsaved.get(copy).includes('AM staged.txt'));
      }
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: copy, stdio: 'ignore' });
      children.push(child);
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    }
    const preview = tidyMemberCopies({ repoRoot: fx.repo, now, dryRun: true });
    assert.equal(preview.aborted, null);
    assert.equal(byName(preview, 'busy-pinned').reason, words);
    assert.equal(byName(preview, 'busy-pinned').quiet, undefined);
    assert.equal(byName(preview, 'busy-ordinary').quiet, group);

    for (const extra of [['--dry-run'], []]) {
      const args = [path.resolve(__dirname, '../bin/atris.js'), 'member', 'tidy', '--dir', fx.copies, ...extra];
      const cli = spawnSync(process.execPath, args, { cwd: fx.repo, encoding: 'utf8', timeout: 15000 });
      console.log(`command: node bin/atris.js member tidy --dir <fixture copies>${extra.length ? ' --dry-run' : ''} (fixture cwd)`);
      console.log(cli.stdout.trim());
      console.log(`exit: ${cli.status}`);
      assert.equal(cli.status, 0, cli.stderr);
      assert.deepEqual(cli.stdout.trim().split('\n'), [
        `kept  busy-pinned  ${words}`,
        `left alone  1 ${group}`,
        `tidy: ${extra.length ? 'would remove' : 'removed'} 0, kept 2, of 2 copies in ${fx.copies}`,
      ]);
      assert.equal(fs.readFileSync(pin, 'utf8'), `${reason}\n`);
      const registered = runGit(['worktree', 'list', '--porcelain'], fx.repo);
      for (const copy of [pinned, ordinary]) {
        assert.equal(fs.readFileSync(path.join(copy, 'README.md'), 'utf8'), '# fixture\n');
        if (unfinished) {
          assert.equal(fs.readFileSync(path.join(copy, `${path.basename(copy)}.txt`), 'utf8'), 'work\nunsaved edits\n');
          assert.equal(fs.readFileSync(path.join(copy, 'draft.txt'), 'utf8'), `notes for ${path.basename(copy)}\n`);
          assert.equal(fs.readFileSync(path.join(copy, 'staged.txt'), 'utf8'), 'prepared notes\nlater edits\n');
          assert.equal(runGit(['show', ':staged.txt'], copy), 'prepared notes');
          assert.equal(runGit(['diff', '--cached', '--binary'], copy), staged.get(copy));
          assert.equal(runGit(['status', '--porcelain'], copy), unsaved.get(copy));
        }
        assert.ok(branchExists(fx.repo, path.basename(copy)));
        assert.ok(registered.includes(`worktree ${copy}\n`));
      }
      for (const child of children) assert.doesNotThrow(() => process.kill(child.pid, 0));
      assert.deepEqual(removalLines(fx.repo), []);
    }
  } finally {
    await Promise.all(children.map((child) => new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once('exit', resolve);
      child.kill();
    })));
    fs.rmSync(fx.base, { recursive: true, force: true });
  }
});
}

test('tidy names its own pinned landed copy from the root and a nested folder', () => {
  const fx = makeFixture();
  try {
    const copy = addCopy(fx, 'current-pinned');
    const nested = path.join(copy, 'notes');
    fs.mkdirSync(nested);
    const notes = path.join(nested, 'draft.txt');
    fs.writeFileSync(notes, 'unfinished notes\n');
    const reason = 'writer still active\n  keep these notes';
    runGit(['worktree', 'lock', '--reason', reason, copy], fx.repo);
    const pin = path.join(runGit(['rev-parse', '--absolute-git-dir'], copy), 'locked');
    const aged = new Date(Date.now() - 3 * 60 * 60 * 1000);
    fs.utimesSync(pin, aged, aged);
    const words = 'landed, but pinned by git worktree lock, 3 h old: writer still active keep these notes';

    for (const cwd of [copy, nested]) {
      for (const extra of [['--dry-run'], []]) {
        const args = [path.resolve(__dirname, '../bin/atris.js'), 'member', 'tidy', '--dir', fx.copies, ...extra];
        const cli = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 15000 });
        console.log(`command: node bin/atris.js member tidy --dir <fixture copies>${extra.length ? ' --dry-run' : ''} (cwd: ${cwd === copy ? 'pinned copy' : 'nested notes folder'})`);
        console.log(cli.stdout.trim());
        console.log(`exit: ${cli.status}`);
        assert.equal(cli.status, 0, cli.stderr);
        assert.deepEqual(cli.stdout.trim().split('\n'), [
          `kept  current-pinned  ${words}`,
          `tidy: ${extra.length ? 'would remove' : 'removed'} 0, kept 1, of 1 copy in ${fx.copies}`,
        ]);
        assert.equal(fs.readFileSync(pin, 'utf8'), `${reason}\n`);
        assert.equal(fs.readFileSync(notes, 'utf8'), 'unfinished notes\n');
        assert.equal(fs.readFileSync(path.join(copy, 'README.md'), 'utf8'), '# fixture\n');
        assert.ok(branchExists(fx.repo, 'current-pinned'));
        assert.ok(runGit(['worktree', 'list', '--porcelain'], fx.repo).includes(`worktree ${copy}\n`));
        assert.deepEqual(removalLines(fx.repo), []);
      }
    }
  } finally {
    fs.rmSync(fx.base, { recursive: true, force: true });
  }
});

test('tidy preserves staged and unsaved notes in idle landed copies', () => {
  const fx = makeFixture();
  try {
    const pinned = addCopy(fx, 'idle-pinned');
    const ordinary = addCopy(fx, 'idle-ordinary');
    const reason = 'writer still active\n  keep these notes';
    runGit(['worktree', 'lock', '--reason', reason, pinned], fx.repo);
    const pin = path.join(runGit(['rev-parse', '--absolute-git-dir'], pinned), 'locked');
    const now = Date.now();
    const aged = new Date(now - 3 * 60 * 60 * 1000);
    fs.utimesSync(pin, aged, aged);
    const words = 'landed, but pinned by git worktree lock, 3 h old: writer still active keep these notes';
    const before = new Map();
    for (const copy of [pinned, ordinary]) {
      fs.writeFileSync(path.join(copy, 'draft.txt'), `notes for ${path.basename(copy)}\n`);
      fs.appendFileSync(path.join(copy, 'README.md'), 'unsaved edits\n');
      fs.writeFileSync(path.join(copy, 'staged.txt'), 'prepared notes\n');
      runGit(['add', 'staged.txt'], copy);
      fs.appendFileSync(path.join(copy, 'staged.txt'), 'later edits\n');
      const status = runGit(['status', '--porcelain'], copy);
      assert.ok(status.includes('?? draft.txt'));
      assert.ok(status.includes('M README.md'));
      assert.ok(status.includes('AM staged.txt'));
      assert.equal(runGit(['show', ':staged.txt'], copy), 'prepared notes');
      before.set(copy, { status, patch: runGit(['diff', '--cached', '--binary'], copy) });
    }

    for (const extra of [['--dry-run'], []]) {
      const args = [path.resolve(__dirname, '../bin/atris.js'), 'member', 'tidy', '--dir', fx.copies, ...extra];
      const cli = spawnSync(process.execPath, args, { cwd: fx.repo, encoding: 'utf8', timeout: 15000 });
      console.log(`command: node bin/atris.js member tidy --dir <fixture copies>${extra.length ? ' --dry-run' : ''} (fixture cwd)`);
      console.log(cli.stdout.trim());
      console.log(`exit: ${cli.status}`);
      assert.equal(cli.status, 0, cli.stderr);
      const lines = cli.stdout.trim().split('\n');
      assert.ok(lines.some((line) => line.replace(/ {2,}/g, '  ') === `kept  idle-pinned  ${words}`));
      if (extra.length) {
        assert.ok(lines.includes('kept  idle-ordinary  landed, but has unsaved work'));
        assert.equal(lines.at(-1), `tidy: would remove 0, kept 2, of 2 copies in ${fx.copies}`);
      } else {
        assert.ok(lines.some((line) => /^kept  idle-ordinary  landed, but git refused:/.test(line)));
        assert.equal(lines.at(-1), `tidy: removed 0, kept 2, of 2 copies in ${fx.copies}`);
      }
      assert.equal(fs.readFileSync(pin, 'utf8'), `${reason}\n`);
      const registered = runGit(['worktree', 'list', '--porcelain'], fx.repo);
      for (const copy of [pinned, ordinary]) {
        const name = path.basename(copy);
        assert.equal(fs.readFileSync(path.join(copy, 'README.md'), 'utf8'), '# fixture\nunsaved edits\n');
        assert.equal(fs.readFileSync(path.join(copy, 'draft.txt'), 'utf8'), `notes for ${name}\n`);
        assert.equal(fs.readFileSync(path.join(copy, 'staged.txt'), 'utf8'), 'prepared notes\nlater edits\n');
        assert.equal(runGit(['show', ':staged.txt'], copy), 'prepared notes');
        assert.equal(runGit(['diff', '--cached', '--binary'], copy), before.get(copy).patch);
        assert.equal(runGit(['status', '--porcelain'], copy), before.get(copy).status);
        assert.ok(branchExists(fx.repo, name));
        assert.ok(registered.includes(`worktree ${copy}\n`));
      }
      assert.deepEqual(removalLines(fx.repo), []);
    }
  } finally {
    fs.rmSync(fx.base, { recursive: true, force: true });
  }
});

test('tidy keeps a copy whose branch disappeared, in preview and apply', () => {
  const fx = makeFixture();
  try {
    const clean = addCopy(fx, 'landed-clean');
    const kept = addCopy(fx, 'missing-branch');
    const draft = path.join(kept, 'draft.txt');
    fs.writeFileSync(draft, 'unsaved notes\n');
    const gitDir = runGit(['rev-parse', '--absolute-git-dir'], kept);
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8');
    runGit(['update-ref', '-d', 'refs/heads/missing-branch'], fx.repo);
    assert.equal(branchExists(fx.repo, 'missing-branch'), false);

    for (const extra of [['--dry-run'], []]) {
      const args = [path.resolve(__dirname, '../bin/atris.js'), 'member', 'tidy', '--dir', fx.copies, ...extra];
      const cli = spawnSync(process.execPath, args, { cwd: fx.repo, encoding: 'utf8', timeout: 15000 });
      console.log(`command: node bin/atris.js member tidy --dir <fixture copies>${extra.length ? ' --dry-run' : ''} (missing branch)`);
      console.log(cli.stdout.trim());
      console.log(`exit: ${cli.status}`);
      assert.equal(cli.status, 0, cli.stderr);
      const lines = cli.stdout.trim().split('\n').map((line) => line.replace(/ {2,}/g, '  '));
      assert.ok(lines.some((line) => line.startsWith('kept  missing-branch  git could not tell if it landed: ') && line.includes('refs/heads/missing-branch')), lines.join('\n'));
      assert.ok(lines.some((line) => line.startsWith(`${extra.length ? 'would remove' : 'removed'}  landed-clean  work landed`)));
      assert.equal(lines.at(-1), `tidy: ${extra.length ? 'would remove' : 'removed'} 1, kept 1, of 2 copies in ${fx.copies}`);
      assert.equal(fs.readFileSync(draft, 'utf8'), 'unsaved notes\n');
      assert.equal(fs.readFileSync(path.join(kept, 'README.md'), 'utf8'), '# fixture\n');
      assert.equal(fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8'), head);
      assert.equal(branchExists(fx.repo, 'missing-branch'), false);
      assert.ok(runGit(['worktree', 'list', '--porcelain'], fx.repo).includes(`worktree ${kept}\n`));
      assert.deepEqual(removalLines(fx.repo).map((line) => line.path), extra.length ? [] : [clean]);
    }
    assert.equal(fs.existsSync(clean), false);
  } finally {
    fs.rmSync(fx.base, { recursive: true, force: true });
  }
});

test('tidy keeps staged and unsaved notes after upstream moves backward', () => {
  const fx = makeFixture();
  try {
    const clean = addCopy(fx, 'landed-clean');
    const kept = addCopy(fx, 'upstream-rewound', { commit: true, pushToOrigin: true });
    const tip = runGit(['rev-parse', 'HEAD'], kept);
    runGit(['fetch', '-q', 'origin'], fx.repo);
    assert.equal(runGit(['rev-parse', 'origin/master'], fx.repo), tip);
    fs.writeFileSync(path.join(kept, 'draft.txt'), 'unsaved notes\n');
    fs.appendFileSync(path.join(kept, 'README.md'), 'unsaved edits\n');
    fs.writeFileSync(path.join(kept, 'staged.txt'), 'prepared notes\n');
    runGit(['add', 'staged.txt'], kept);
    fs.appendFileSync(path.join(kept, 'staged.txt'), 'later edits\n');
    const status = runGit(['status', '--porcelain'], kept);
    const patch = runGit(['diff', '--cached', '--binary'], kept);
    assert.match(status, /AM staged.txt/);
    const seed = path.join(fx.base, 'seed');
    const base = runGit(['rev-parse', 'HEAD'], seed);
    // Only the disposable remote is rewound. The local tracking ref still
    // says this copy landed, so cleanup must ask the remote again.
    runGit(['push', '-q', '--force', path.join(fx.base, 'remote.git'), 'master'], seed);
    assert.equal(runGit(['rev-parse', 'origin/master'], fx.repo), tip);
    assert.equal(runGit(['rev-parse', 'refs/heads/master'], path.join(fx.base, 'remote.git')), base);

    for (const extra of [['--dry-run'], []]) {
      const args = [path.resolve(__dirname, '../bin/atris.js'), 'member', 'tidy', '--dir', fx.copies, ...extra];
      const cli = spawnSync(process.execPath, args, { cwd: fx.repo, encoding: 'utf8', timeout: 15000 });
      console.log(`command: node bin/atris.js member tidy --dir <fixture copies>${extra.length ? ' --dry-run' : ''} (upstream moved backward)`);
      console.log(cli.stdout.trim());
      console.log(`exit: ${cli.status}`);
      assert.equal(cli.status, 0, cli.stderr);
      const lines = cli.stdout.trim().split('\n').map((line) => line.replace(/ {2,}/g, '  '));
      assert.ok(lines.includes('left alone  1 work not landed yet'), lines.join('\n'));
      assert.ok(lines.some((line) => line.startsWith(`${extra.length ? 'would remove' : 'removed'}  landed-clean  work landed`)));
      assert.equal(lines.at(-1), `tidy: ${extra.length ? 'would remove' : 'removed'} 1, kept 1, of 2 copies in ${fx.copies}`);
      assert.equal(runGit(['rev-parse', 'FETCH_HEAD'], fx.repo), base);
      assert.equal(runGit(['rev-parse', 'HEAD'], kept), tip);
      assert.equal(fs.readFileSync(path.join(kept, 'upstream-rewound.txt'), 'utf8'), 'work\n');
      assert.equal(fs.readFileSync(path.join(kept, 'draft.txt'), 'utf8'), 'unsaved notes\n');
      assert.equal(fs.readFileSync(path.join(kept, 'README.md'), 'utf8'), '# fixture\nunsaved edits\n');
      assert.equal(fs.readFileSync(path.join(kept, 'staged.txt'), 'utf8'), 'prepared notes\nlater edits\n');
      assert.equal(runGit(['show', ':staged.txt'], kept), 'prepared notes');
      assert.equal(runGit(['diff', '--cached', '--binary'], kept), patch);
      assert.equal(runGit(['status', '--porcelain'], kept), status);
      assert.ok(branchExists(fx.repo, 'upstream-rewound'));
      assert.ok(runGit(['worktree', 'list', '--porcelain'], fx.repo).includes(`worktree ${kept}\n`));
      assert.deepEqual(removalLines(fx.repo).map((line) => line.path), extra.length ? [] : [clean]);
    }
    assert.equal(fs.existsSync(clean), false);
  } finally {
    fs.rmSync(fx.base, { recursive: true, force: true });
  }
});

test('tidy keeps staged and unsaved notes after upstream switches to unrelated history', () => {
  const fx = makeFixture();
  try {
    const kept = addCopy(fx, 'upstream-replaced', { commit: true, pushToOrigin: true });
    const tip = runGit(['rev-parse', 'HEAD'], kept);
    runGit(['fetch', '-q', 'origin'], fx.repo);
    assert.equal(runGit(['rev-parse', 'origin/master'], fx.repo), tip);
    fs.writeFileSync(path.join(kept, 'draft.txt'), 'unsaved notes\n');
    fs.appendFileSync(path.join(kept, 'README.md'), 'unsaved edits\n');
    fs.writeFileSync(path.join(kept, 'staged.txt'), 'prepared notes\n');
    runGit(['add', 'staged.txt'], kept);
    fs.appendFileSync(path.join(kept, 'staged.txt'), 'later edits\n');
    const status = runGit(['status', '--porcelain'], kept);
    const patch = runGit(['diff', '--cached', '--binary'], kept);
    assert.match(status, /AM staged.txt/);
    const seed = path.join(fx.base, 'seed');
    // Create a new root only in the disposable seed, then replace its remote
    // default branch. The stale tracking ref still says the old copy landed.
    runGit(['checkout', '-q', '--orphan', 'replacement'], seed);
    fs.writeFileSync(path.join(seed, 'README.md'), '# replacement history\n');
    runGit(['add', 'README.md'], seed);
    runGit(['commit', '-q', '-m', 'new root'], seed);
    const base = runGit(['rev-parse', 'HEAD'], seed);
    runGit(['push', '-q', '--force', path.join(fx.base, 'remote.git'), 'replacement:master'], seed);
    runGit(['fetch', '-q', seed, 'replacement'], fx.repo);
    const clean = path.join(fx.copies, 'landed-clean');
    runGit(['worktree', 'add', '-q', '-b', 'landed-clean', clean, base], fx.repo);
    assert.equal(runGit(['rev-parse', 'origin/master'], fx.repo), tip);
    assert.equal(runGit(['rev-parse', 'refs/heads/master'], path.join(fx.base, 'remote.git')), base);
    const ancestry = spawnSync('git', ['merge-base', tip, base], { cwd: fx.repo, encoding: 'utf8' });
    assert.equal(ancestry.status, 1, ancestry.stderr);
    assert.equal(ancestry.stdout, '');

    for (const extra of [['--dry-run'], []]) {
      const args = [path.resolve(__dirname, '../bin/atris.js'), 'member', 'tidy', '--dir', fx.copies, ...extra];
      const cli = spawnSync(process.execPath, args, { cwd: fx.repo, encoding: 'utf8', timeout: 15000 });
      console.log(`command: node bin/atris.js member tidy --dir <fixture copies>${extra.length ? ' --dry-run' : ''} (unrelated upstream history)`);
      console.log(cli.stdout.trim());
      console.log(`exit: ${cli.status}`);
      assert.equal(cli.status, 0, cli.stderr);
      const lines = cli.stdout.trim().split('\n').map((line) => line.replace(/ {2,}/g, '  '));
      assert.ok(lines.includes('left alone  1 work not landed yet'), lines.join('\n'));
      assert.ok(lines.some((line) => line.startsWith(`${extra.length ? 'would remove' : 'removed'}  landed-clean  work landed`)));
      assert.equal(lines.at(-1), `tidy: ${extra.length ? 'would remove' : 'removed'} 1, kept 1, of 2 copies in ${fx.copies}`);
      assert.equal(runGit(['rev-parse', 'FETCH_HEAD'], fx.repo), base);
      assert.equal(runGit(['rev-parse', 'HEAD'], kept), tip);
      assert.equal(fs.readFileSync(path.join(kept, 'upstream-replaced.txt'), 'utf8'), 'work\n');
      assert.equal(fs.readFileSync(path.join(kept, 'draft.txt'), 'utf8'), 'unsaved notes\n');
      assert.equal(fs.readFileSync(path.join(kept, 'README.md'), 'utf8'), '# fixture\nunsaved edits\n');
      assert.equal(fs.readFileSync(path.join(kept, 'staged.txt'), 'utf8'), 'prepared notes\nlater edits\n');
      assert.equal(runGit(['show', ':staged.txt'], kept), 'prepared notes');
      assert.equal(runGit(['diff', '--cached', '--binary'], kept), patch);
      assert.equal(runGit(['status', '--porcelain'], kept), status);
      assert.ok(branchExists(fx.repo, 'upstream-replaced'));
      assert.ok(runGit(['worktree', 'list', '--porcelain'], fx.repo).includes(`worktree ${kept}\n`));
      assert.deepEqual(removalLines(fx.repo).map((line) => line.path), extra.length ? [] : [clean]);
    }
    assert.equal(fs.existsSync(clean), false);
  } finally {
    fs.rmSync(fx.base, { recursive: true, force: true });
  }
});

test('tidy keeps a landed copy whose status git cannot read, in preview and apply', () => {
  const fx = makeFixture();
  try {
    const clean = addCopy(fx, 'landed-clean');
    const broken = addCopy(fx, 'unreadable-status');
    fs.writeFileSync(path.join(broken, 'draft.txt'), 'unsaved notes\n');
    const index = path.join(runGit(['rev-parse', '--absolute-git-dir'], broken), 'index');
    fs.writeFileSync(index, 'not an index');
    const failed = spawnSync('git', ['status', '--porcelain'], { cwd: broken, encoding: 'utf8' });
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /index file/);

    for (const extra of [['--dry-run'], []]) {
      const args = [path.resolve(__dirname, '../bin/atris.js'), 'member', 'tidy', '--dir', fx.copies, ...extra];
      const cli = spawnSync(process.execPath, args, { cwd: fx.repo, encoding: 'utf8', timeout: 15000 });
      console.log(`command: node bin/atris.js member tidy --dir <fixture copies>${extra.length ? ' --dry-run' : ''} (broken index)`);
      console.log(cli.stdout.trim());
      console.log(`exit: ${cli.status}`);
      assert.equal(cli.status, 0, cli.stderr);
      const lines = cli.stdout.trim().split('\n').map((line) => line.replace(/ {2,}/g, '  '));
      const words = extra.length ? 'landed, but git could not check for unsaved work: ' : 'landed, but git refused: ';
      assert.ok(lines.some((line) => line.startsWith(`kept  unreadable-status  ${words}`) && /index file/.test(line)), lines.join('\n'));
      assert.ok(lines.some((line) => line.startsWith(`${extra.length ? 'would remove' : 'removed'}  landed-clean  work landed`)));
      assert.equal(lines.at(-1), `tidy: ${extra.length ? 'would remove' : 'removed'} 1, kept 1, of 2 copies in ${fx.copies}`);
      assert.equal(fs.readFileSync(index, 'utf8'), 'not an index');
      assert.equal(fs.readFileSync(path.join(broken, 'draft.txt'), 'utf8'), 'unsaved notes\n');
      assert.equal(fs.readFileSync(path.join(broken, 'README.md'), 'utf8'), '# fixture\n');
      assert.ok(branchExists(fx.repo, 'unreadable-status'));
      assert.ok(runGit(['worktree', 'list', '--porcelain'], fx.repo).includes(`worktree ${broken}\n`));
      assert.deepEqual(removalLines(fx.repo).map((line) => line.path), extra.length ? [] : [clean]);
    }
    assert.equal(fs.existsSync(clean), false);
  } finally {
    fs.rmSync(fx.base, { recursive: true, force: true });
  }
});
