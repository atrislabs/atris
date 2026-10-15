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

// Release notices must not change the output of cleanup checks.
process.env.ATRIS_SKIP_UPDATE_CHECK = '1';

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

// Keep the local default note stale while the remote renames its default
// and removes the old branch. Only the current default decides what landed.
test('tidy keeps staged and unsaved notes after the remote default branch is renamed', () => {
  const fx = makeFixture();
  try {
    const remote = path.join(fx.base, 'remote.git');
    const clean = addCopy(fx, 'landed-clean');
    const base = runGit(['rev-parse', 'HEAD'], clean);
    runGit(['push', '-q', remote, 'master:main'], path.join(fx.base, 'seed'));
    const kept = addCopy(fx, 'old-default-only', { commit: true, pushToOrigin: true });
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
    runGit(['symbolic-ref', 'HEAD', 'refs/heads/main'], remote);
    runGit(['push', '-q', 'origin', '--delete', 'master'], fx.repo);
    // Recreate the stale tracking ref that another client may still have.
    runGit(['update-ref', 'refs/remotes/origin/master', tip], fx.repo);
    assert.equal(branchExists(remote, 'master'), false);

    for (const extra of [['--dry-run'], []]) {
      const args = [path.resolve(__dirname, '../bin/atris.js'), 'member', 'tidy', '--dir', fx.copies, ...extra];
      const cli = spawnSync(process.execPath, args, { cwd: fx.repo, encoding: 'utf8', timeout: 15000 });
      console.log(`command: node bin/atris.js member tidy --dir <fixture copies>${extra.length ? ' --dry-run' : ''} (renamed remote default)`);
      console.log(cli.stdout.trim());
      console.log(`exit: ${cli.status}`);
      assert.equal(cli.status, 0, cli.stderr);
      const lines = cli.stdout.trim().split('\n').map((line) => line.replace(/ {2,}/g, '  '));
      assert.ok(lines.includes('left alone  1 work not landed yet'), lines.join('\n'));
      assert.ok(lines.some((line) => line.startsWith(`${extra.length ? 'would remove' : 'removed'}  landed-clean  work landed`)));
      assert.equal(lines.at(-1), `tidy: ${extra.length ? 'would remove' : 'removed'} 1, kept 1, of 2 copies in ${fx.copies}`);
      assert.equal(runGit(['rev-parse', 'FETCH_HEAD'], fx.repo), base);
      assert.equal(runGit(['symbolic-ref', 'refs/remotes/origin/HEAD'], fx.repo), 'refs/remotes/origin/master');
      assert.equal(runGit(['rev-parse', 'origin/master'], fx.repo), tip);
      assert.equal(runGit(['rev-parse', 'HEAD'], kept), tip);
      assert.equal(fs.readFileSync(path.join(kept, 'old-default-only.txt'), 'utf8'), 'work\n');
      assert.equal(fs.readFileSync(path.join(kept, 'draft.txt'), 'utf8'), 'unsaved notes\n');
      assert.equal(fs.readFileSync(path.join(kept, 'README.md'), 'utf8'), '# fixture\nunsaved edits\n');
      assert.equal(fs.readFileSync(path.join(kept, 'staged.txt'), 'utf8'), 'prepared notes\nlater edits\n');
      assert.equal(runGit(['show', ':staged.txt'], kept), 'prepared notes');
      assert.equal(runGit(['diff', '--cached', '--binary'], kept), patch);
      assert.equal(runGit(['status', '--porcelain'], kept), status);
      assert.ok(branchExists(fx.repo, 'old-default-only'));
      assert.ok(runGit(['worktree', 'list', '--porcelain'], fx.repo).includes(`worktree ${kept}\n`));
      assert.deepEqual(removalLines(fx.repo).map((line) => line.path), extra.length ? [] : [clean]);
    }
    assert.equal(fs.existsSync(clean), false);
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

test('tidy keeps staged and unsaved notes when the remote default points to a missing branch', () => {
  const fx = makeFixture();
  try {
    const remote = path.join(fx.base, 'remote.git');
    const clean = addCopy(fx, 'landed-clean');
    const cleanStatus = runGit(['status', '--porcelain'], clean);
    const kept = addCopy(fx, 'stale-default', { commit: true, pushToOrigin: true });
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
    const registered = runGit(['worktree', 'list', '--porcelain'], fx.repo);
    const fetched = runGit(['rev-parse', 'FETCH_HEAD'], fx.repo);
    runGit(['symbolic-ref', 'HEAD', 'refs/heads/absent'], remote);
    assert.equal(branchExists(remote, 'absent'), false);
    const advertised = runGit(['ls-remote', '--symref', 'origin', 'HEAD'], fx.repo);
    assert.equal(advertised, '');

    for (const extra of [['--dry-run'], []]) {
      const args = [path.resolve(__dirname, '../bin/atris.js'), 'member', 'tidy', '--dir', fx.copies, ...extra];
      const cli = spawnSync(process.execPath, args, { cwd: fx.repo, encoding: 'utf8', timeout: 15000 });
      console.log(`command: node bin/atris.js member tidy --dir <fixture copies>${extra.length ? ' --dry-run' : ''} (missing remote default)`);
      console.log(cli.stdout.trim());
      console.log(`exit: ${cli.status}`);
      assert.equal(cli.status, 1, cli.stderr);
      const lines = cli.stdout.trim().split('\n').map((line) => line.replace(/ {2,}/g, '  '));
      const reason = 'could not tell which branch origin ships from';
      assert.equal(lines[0], `tidy: ${reason}, so every copy is kept`);
      assert.ok(lines.includes(`kept  landed-clean  ${reason}`), lines.join('\n'));
      assert.ok(lines.includes(`kept  stale-default  ${reason}`), lines.join('\n'));
      assert.equal(lines.at(-1), `tidy: ${extra.length ? 'would remove' : 'removed'} 0, kept 2, of 2 copies in ${fx.copies}`);
      assert.equal(runGit(['rev-parse', 'FETCH_HEAD'], fx.repo), fetched);
      assert.equal(fs.readFileSync(path.join(clean, 'README.md'), 'utf8'), '# fixture\n');
      assert.equal(runGit(['status', '--porcelain'], clean), cleanStatus);
      assert.ok(branchExists(fx.repo, 'landed-clean'));
      assert.equal(runGit(['worktree', 'list', '--porcelain'], fx.repo), registered);
      assert.equal(runGit(['symbolic-ref', 'refs/remotes/origin/HEAD'], fx.repo), 'refs/remotes/origin/master');
      assert.equal(runGit(['rev-parse', 'origin/master'], fx.repo), tip);
      assert.equal(runGit(['rev-parse', 'HEAD'], kept), tip);
      assert.equal(fs.readFileSync(path.join(kept, 'stale-default.txt'), 'utf8'), 'work\n');
      assert.equal(fs.readFileSync(path.join(kept, 'draft.txt'), 'utf8'), 'unsaved notes\n');
      assert.equal(fs.readFileSync(path.join(kept, 'README.md'), 'utf8'), '# fixture\nunsaved edits\n');
      assert.equal(fs.readFileSync(path.join(kept, 'staged.txt'), 'utf8'), 'prepared notes\nlater edits\n');
      assert.equal(runGit(['show', ':staged.txt'], kept), 'prepared notes');
      assert.equal(runGit(['diff', '--cached', '--binary'], kept), patch);
      assert.equal(runGit(['status', '--porcelain'], kept), status);
      assert.ok(branchExists(fx.repo, 'stale-default'));
      assert.ok(runGit(['worktree', 'list', '--porcelain'], fx.repo).includes(`worktree ${kept}\n`));
      assert.deepEqual(removalLines(fx.repo), []);
    }
    assert.equal(fs.existsSync(clean), true);
  } finally {
    fs.rmSync(fx.base, { recursive: true, force: true });
  }
});

test('tidy keeps staged and unsaved notes when the remote repository becomes unavailable', () => {
  const fx = makeFixture();
  try {
    const remote = path.join(fx.base, 'remote.git');
    const clean = addCopy(fx, 'landed-clean');
    const cleanStatus = runGit(['status', '--porcelain'], clean);
    const kept = addCopy(fx, 'remote-unavailable', { commit: true, pushToOrigin: true });
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
    const registered = runGit(['worktree', 'list', '--porcelain'], fx.repo);
    const fetched = runGit(['rev-parse', 'FETCH_HEAD'], fx.repo);
    const origin = runGit(['remote', 'get-url', 'origin'], fx.repo);
    fs.renameSync(remote, path.join(fx.base, 'remote-offline.git'));
    const unavailable = spawnSync('git', ['ls-remote', '--symref', 'origin', 'HEAD'], { cwd: fx.repo, encoding: 'utf8' });
    assert.notEqual(unavailable.status, 0);
    assert.match(unavailable.stderr, /does not appear to be a git repository/);

    for (const extra of [['--dry-run'], []]) {
      const args = [path.resolve(__dirname, '../bin/atris.js'), 'member', 'tidy', '--dir', fx.copies, ...extra];
      const cli = spawnSync(process.execPath, args, { cwd: fx.repo, encoding: 'utf8', timeout: 15000 });
      console.log(`command: node bin/atris.js member tidy --dir <fixture copies>${extra.length ? ' --dry-run' : ''} (unavailable remote)`);
      console.log(cli.stdout.trim());
      console.log(`exit: ${cli.status}`);
      assert.equal(cli.status, 1, cli.stderr);
      const lines = cli.stdout.trim().split('\n').map((line) => line.replace(/ {2,}/g, '  '));
      const reason = `could not ask origin for its main branch: fatal: '${remote}' does not appear to be a git repository`;
      assert.equal(lines[0], `tidy: ${reason}, so every copy is kept`);
      assert.ok(lines.includes(`kept  landed-clean  ${reason}`), lines.join('\n'));
      assert.ok(lines.includes(`kept  remote-unavailable  ${reason}`), lines.join('\n'));
      assert.equal(lines.at(-1), `tidy: ${extra.length ? 'would remove' : 'removed'} 0, kept 2, of 2 copies in ${fx.copies}`);
      assert.equal(runGit(['rev-parse', 'FETCH_HEAD'], fx.repo), fetched);
      assert.equal(runGit(['remote', 'get-url', 'origin'], fx.repo), origin);
      assert.equal(fs.existsSync(remote), false);
      assert.equal(fs.readFileSync(path.join(clean, 'README.md'), 'utf8'), '# fixture\n');
      assert.equal(runGit(['status', '--porcelain'], clean), cleanStatus);
      assert.ok(branchExists(fx.repo, 'landed-clean'));
      assert.equal(runGit(['worktree', 'list', '--porcelain'], fx.repo), registered);
      assert.equal(runGit(['symbolic-ref', 'refs/remotes/origin/HEAD'], fx.repo), 'refs/remotes/origin/master');
      assert.equal(runGit(['rev-parse', 'origin/master'], fx.repo), tip);
      assert.equal(runGit(['rev-parse', 'HEAD'], kept), tip);
      assert.equal(fs.readFileSync(path.join(kept, 'remote-unavailable.txt'), 'utf8'), 'work\n');
      assert.equal(fs.readFileSync(path.join(kept, 'draft.txt'), 'utf8'), 'unsaved notes\n');
      assert.equal(fs.readFileSync(path.join(kept, 'README.md'), 'utf8'), '# fixture\nunsaved edits\n');
      assert.equal(fs.readFileSync(path.join(kept, 'staged.txt'), 'utf8'), 'prepared notes\nlater edits\n');
      assert.equal(runGit(['show', ':staged.txt'], kept), 'prepared notes');
      assert.equal(runGit(['diff', '--cached', '--binary'], kept), patch);
      assert.equal(runGit(['status', '--porcelain'], kept), status);
      assert.ok(branchExists(fx.repo, 'remote-unavailable'));
      assert.ok(runGit(['worktree', 'list', '--porcelain'], fx.repo).includes(`worktree ${kept}\n`));
      assert.deepEqual(removalLines(fx.repo), []);
    }
    assert.equal(fs.existsSync(clean), true);
  } finally {
    fs.rmSync(fx.base, { recursive: true, force: true });
  }
});

test('tidy keeps staged and unsaved notes when the remote default exists but cannot be fetched', () => {
  const fx = makeFixture();
  try {
    const remote = path.join(fx.base, 'remote.git');
    const clean = addCopy(fx, 'landed-clean');
    const cleanStatus = runGit(['status', '--porcelain'], clean);
    const kept = addCopy(fx, 'unfetchable-default', { commit: true, pushToOrigin: true });
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
    const registered = runGit(['worktree', 'list', '--porcelain'], fx.repo);
    const fetchRecord = path.join(fx.repo, '.git', 'FETCH_HEAD');
    assert.match(fs.readFileSync(fetchRecord, 'utf8'), new RegExp(`^${tip}\t`));
    // Another writer moves the default forward, then the remote loses that
    // commit: origin still names the branch, but cannot send it.
    const other = path.join(fx.base, 'other');
    runGit(['clone', '-q', remote, other], fx.base);
    configure(other);
    fs.writeFileSync(path.join(other, 'later.txt'), 'later work\n');
    runGit(['add', 'later.txt'], other);
    runGit(['commit', '-q', '-m', 'later work'], other);
    runGit(['push', '-q', 'origin', 'master'], other);
    const lost = runGit(['rev-parse', 'HEAD'], other);
    fs.rmSync(path.join(remote, 'objects', lost.slice(0, 2), lost.slice(2)));
    const advertised = runGit(['ls-remote', '--symref', 'origin', 'HEAD'], fx.repo);
    assert.equal(advertised, `ref: refs/heads/master\tHEAD\n${lost}\tHEAD`);
    const unfetchable = spawnSync('git', ['fetch', '--quiet', 'origin', 'refs/heads/master'], { cwd: fx.repo, encoding: 'utf8' });
    assert.notEqual(unfetchable.status, 0);
    assert.match(unfetchable.stderr, /not our ref/);
    // git empties its fetch record when a fetch fails; tidy must not refill it.
    assert.equal(fs.readFileSync(fetchRecord, 'utf8'), '');

    for (const extra of [['--dry-run'], []]) {
      const args = [path.resolve(__dirname, '../bin/atris.js'), 'member', 'tidy', '--dir', fx.copies, ...extra];
      const cli = spawnSync(process.execPath, args, { cwd: fx.repo, encoding: 'utf8', timeout: 15000 });
      console.log(`command: node bin/atris.js member tidy --dir <fixture copies>${extra.length ? ' --dry-run' : ''} (unfetchable remote default)`);
      console.log(cli.stdout.trim());
      console.log(`exit: ${cli.status}`);
      assert.equal(cli.status, 1, cli.stderr);
      const lines = cli.stdout.trim().split('\n').map((line) => line.replace(/ {2,}/g, '  '));
      const reason = `could not fetch origin: fatal: git upload-pack: not our ref ${lost}`;
      assert.equal(lines[0], `tidy: ${reason}, so every copy is kept`);
      assert.ok(lines.includes(`kept  landed-clean  ${reason}`), lines.join('\n'));
      assert.ok(lines.includes(`kept  unfetchable-default  ${reason}`), lines.join('\n'));
      assert.equal(lines.at(-1), `tidy: ${extra.length ? 'would remove' : 'removed'} 0, kept 2, of 2 copies in ${fx.copies}`);
      assert.equal(fs.readFileSync(fetchRecord, 'utf8'), '');
      assert.equal(spawnSync('git', ['cat-file', '-e', lost], { cwd: fx.repo }).status === 0, false);
      assert.equal(fs.readFileSync(path.join(clean, 'README.md'), 'utf8'), '# fixture\n');
      assert.equal(runGit(['status', '--porcelain'], clean), cleanStatus);
      assert.ok(branchExists(fx.repo, 'landed-clean'));
      assert.equal(runGit(['worktree', 'list', '--porcelain'], fx.repo), registered);
      assert.equal(runGit(['symbolic-ref', 'refs/remotes/origin/HEAD'], fx.repo), 'refs/remotes/origin/master');
      assert.equal(runGit(['rev-parse', 'origin/master'], fx.repo), tip);
      assert.equal(runGit(['rev-parse', 'HEAD'], kept), tip);
      assert.equal(fs.readFileSync(path.join(kept, 'unfetchable-default.txt'), 'utf8'), 'work\n');
      assert.equal(fs.readFileSync(path.join(kept, 'draft.txt'), 'utf8'), 'unsaved notes\n');
      assert.equal(fs.readFileSync(path.join(kept, 'README.md'), 'utf8'), '# fixture\nunsaved edits\n');
      assert.equal(fs.readFileSync(path.join(kept, 'staged.txt'), 'utf8'), 'prepared notes\nlater edits\n');
      assert.equal(runGit(['show', ':staged.txt'], kept), 'prepared notes');
      assert.equal(runGit(['diff', '--cached', '--binary'], kept), patch);
      assert.equal(runGit(['status', '--porcelain'], kept), status);
      assert.ok(branchExists(fx.repo, 'unfetchable-default'));
      assert.ok(runGit(['worktree', 'list', '--porcelain'], fx.repo).includes(`worktree ${kept}\n`));
      assert.deepEqual(removalLines(fx.repo), []);
    }
    assert.equal(fs.existsSync(clean), true);
  } finally {
    fs.rmSync(fx.base, { recursive: true, force: true });
  }
});

test('tidy keeps staged and unsaved notes when the fetched remote default is not a commit', () => {
  const fx = makeFixture();
  try {
    const remote = path.join(fx.base, 'remote.git');
    const clean = addCopy(fx, 'landed-clean');
    const cleanStatus = runGit(['status', '--porcelain'], clean);
    const kept = addCopy(fx, 'non-commit-default', { commit: true, pushToOrigin: true });
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
    const registered = runGit(['worktree', 'list', '--porcelain'], fx.repo);
    // git refuses to point a branch at a plain file through its own tools, so
    // the disposable remote's branch file is damaged directly: origin names
    // its default and sends it, but what arrives is not a commit.
    const blob = spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: remote, input: 'not a commit\n', encoding: 'utf8' }).stdout.trim();
    assert.match(blob, /^[0-9a-f]{40,64}$/);
    fs.writeFileSync(path.join(remote, 'refs', 'heads', 'master'), `${blob}\n`);
    assert.equal(runGit(['ls-remote', '--symref', 'origin', 'HEAD'], fx.repo), `ref: refs/heads/master\tHEAD\n${blob}\tHEAD`);
    const fetchRecord = path.join(fx.repo, '.git', 'FETCH_HEAD');

    for (const extra of [['--dry-run'], []]) {
      const args = [path.resolve(__dirname, '../bin/atris.js'), 'member', 'tidy', '--dir', fx.copies, ...extra];
      const cli = spawnSync(process.execPath, args, { cwd: fx.repo, encoding: 'utf8', timeout: 15000 });
      console.log(`command: node bin/atris.js member tidy --dir <fixture copies>${extra.length ? ' --dry-run' : ''} (non-commit remote default)`);
      console.log(cli.stdout.trim());
      console.log(`exit: ${cli.status}`);
      assert.equal(cli.status, 1, cli.stderr);
      const lines = cli.stdout.trim().split('\n').map((line) => line.replace(/ {2,}/g, '  '));
      const reason = 'could not read the fetched main branch';
      assert.equal(lines[0], `tidy: ${reason}, so every copy is kept`);
      assert.ok(lines.includes(`kept  landed-clean  ${reason}`), lines.join('\n'));
      assert.ok(lines.includes(`kept  non-commit-default  ${reason}`), lines.join('\n'));
      assert.equal(lines.at(-1), `tidy: ${extra.length ? 'would remove' : 'removed'} 0, kept 2, of 2 copies in ${fx.copies}`);
      // The fetch itself worked, so git's record names the plain file.
      assert.match(fs.readFileSync(fetchRecord, 'utf8'), new RegExp(`^${blob}\t`));
      assert.equal(fs.readFileSync(path.join(clean, 'README.md'), 'utf8'), '# fixture\n');
      assert.equal(runGit(['status', '--porcelain'], clean), cleanStatus);
      assert.ok(branchExists(fx.repo, 'landed-clean'));
      assert.equal(runGit(['worktree', 'list', '--porcelain'], fx.repo), registered);
      assert.equal(runGit(['symbolic-ref', 'refs/remotes/origin/HEAD'], fx.repo), 'refs/remotes/origin/master');
      // The check only reads origin: the local copy of its branch keeps the
      // last good commit instead of following the damaged one.
      assert.equal(runGit(['rev-parse', 'origin/master'], fx.repo), tip);
      assert.equal(runGit(['rev-parse', 'HEAD'], kept), tip);
      assert.equal(fs.readFileSync(path.join(kept, 'non-commit-default.txt'), 'utf8'), 'work\n');
      assert.equal(fs.readFileSync(path.join(kept, 'draft.txt'), 'utf8'), 'unsaved notes\n');
      assert.equal(fs.readFileSync(path.join(kept, 'README.md'), 'utf8'), '# fixture\nunsaved edits\n');
      assert.equal(fs.readFileSync(path.join(kept, 'staged.txt'), 'utf8'), 'prepared notes\nlater edits\n');
      assert.equal(runGit(['show', ':staged.txt'], kept), 'prepared notes');
      assert.equal(runGit(['diff', '--cached', '--binary'], kept), patch);
      assert.equal(runGit(['status', '--porcelain'], kept), status);
      assert.ok(branchExists(fx.repo, 'non-commit-default'));
      assert.ok(runGit(['worktree', 'list', '--porcelain'], fx.repo).includes(`worktree ${kept}\n`));
      assert.deepEqual(removalLines(fx.repo), []);
    }
    assert.equal(fs.existsSync(clean), true);
  } finally {
    fs.rmSync(fx.base, { recursive: true, force: true });
  }
});

test('tidy judges against the newest remote commit without moving the local record of it', () => {
  const fx = makeFixture();
  try {
    const base = runGit(['rev-parse', 'origin/master'], fx.repo);
    const landed = addCopy(fx, 'landed-elsewhere', { commit: true, pushToOrigin: true });
    const tip = runGit(['rev-parse', 'HEAD'], landed);
    assert.notEqual(tip, base);
    // The push moved the local record; put it back so it lags origin, the
    // way it does when someone else lands the work.
    runGit(['update-ref', 'refs/remotes/origin/master', base], fx.repo);
    const open = addCopy(fx, 'not-landed', { commit: true });
    fs.writeFileSync(path.join(open, 'draft.txt'), 'unsaved notes\n');
    const openStatus = runGit(['status', '--porcelain'], open);
    const openTip = runGit(['rev-parse', 'HEAD'], open);

    for (const extra of [['--dry-run'], []]) {
      const args = [path.resolve(__dirname, '../bin/atris.js'), 'member', 'tidy', '--dir', fx.copies, ...extra];
      const cli = spawnSync(process.execPath, args, { cwd: fx.repo, encoding: 'utf8', timeout: 15000 });
      console.log(`command: node bin/atris.js member tidy --dir <fixture copies>${extra.length ? ' --dry-run' : ''} (local record behind origin)`);
      console.log(cli.stdout.trim());
      console.log(`exit: ${cli.status}`);
      assert.equal(cli.status, 0, cli.stderr);
      const lines = cli.stdout.trim().split('\n').map((line) => line.replace(/ {2,}/g, '  '));
      assert.ok(lines.some((line) => line.startsWith(`${extra.length ? 'would remove' : 'removed'}  landed-elsewhere  work landed`)), lines.join('\n'));
      assert.ok(lines.includes('left alone  1 work not landed yet'), lines.join('\n'));
      assert.equal(lines.at(-1), `tidy: ${extra.length ? 'would remove' : 'removed'} 1, kept 1, of 2 copies in ${fx.copies}`);
      assert.equal(runGit(['rev-parse', 'FETCH_HEAD'], fx.repo), tip);
      assert.equal(runGit(['rev-parse', 'origin/master'], fx.repo), base);
      assert.equal(fs.existsSync(landed), extra.length > 0);
      // Local master is behind too, so git keeps the branch itself.
      assert.ok(branchExists(fx.repo, 'landed-elsewhere'));
      assert.equal(runGit(['rev-parse', 'HEAD'], open), openTip);
      assert.equal(fs.readFileSync(path.join(open, 'draft.txt'), 'utf8'), 'unsaved notes\n');
      assert.equal(runGit(['status', '--porcelain'], open), openStatus);
      assert.deepEqual(removalLines(fx.repo).map((line) => line.path), extra.length ? [] : [landed]);
    }
  } finally {
    fs.rmSync(fx.base, { recursive: true, force: true });
  }
});

test('worktree cleanup refreshes the local record of origin only to a real commit', () => {
  const fx = makeFixture();
  try {
    const remote = path.join(fx.base, 'remote.git');
    const copy = addCopy(fx, 'still-here');
    fs.writeFileSync(path.join(copy, 'draft.txt'), 'unsaved notes\n');
    const old = runGit(['rev-parse', 'origin/master'], fx.repo);
    const other = path.join(fx.base, 'other');
    runGit(['clone', '-q', remote, other], fx.base);
    configure(other);
    fs.writeFileSync(path.join(other, 'later.txt'), 'later work\n');
    runGit(['add', 'later.txt'], other);
    runGit(['commit', '-q', '-m', 'later work'], other);
    runGit(['push', '-q', 'origin', 'master'], other);
    const newer = runGit(['rev-parse', 'HEAD'], other);

    // Healthy origin: starting and shipping rely on this refresh, so it still
    // moves the local record forward.
    assert.equal(cleanupWorktrees({ root: fx.repo, activeCwds: [] }).staleBase, '');
    assert.equal(runGit(['rev-parse', 'origin/master'], fx.repo), newer);
    assert.notEqual(newer, old);

    // Damaged origin: the branch file names a plain file. The record keeps
    // the last good commit and the copy keeps its draft.
    const blob = spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: remote, input: 'not a commit\n', encoding: 'utf8' }).stdout.trim();
    fs.writeFileSync(path.join(remote, 'refs', 'heads', 'master'), `${blob}\n`);
    assert.match(runGit(['ls-remote', 'origin', 'refs/heads/master'], fx.repo), new RegExp(`^${blob}\t`));
    for (const apply of [false, true]) {
      const result = cleanupWorktrees({ root: fx.repo, apply, activeCwds: [] });
      assert.deepEqual(result.removed, []);
      assert.equal(result.staleBase, 'origin sent origin/master as something other than a commit');
      assert.equal(runGit(['rev-parse', 'origin/master'], fx.repo), newer);
      assert.equal(runGit(['cat-file', '-t', 'refs/remotes/origin/master'], fx.repo), 'commit');
      assert.equal(fs.readFileSync(path.join(copy, 'draft.txt'), 'utf8'), 'unsaved notes\n');
      assert.ok(runGit(['worktree', 'list', '--porcelain'], fx.repo).includes(`worktree ${copy}\n`));
    }
    // The real command says the base could not be refreshed instead of
    // judging against the last saved copy in silence.
    const cli = spawnSync(process.execPath, [path.resolve(__dirname, '../bin/atris.js'), 'worktree', 'cleanup'], { cwd: fx.repo, encoding: 'utf8', timeout: 30000 });
    console.log('command: node bin/atris.js worktree cleanup (damaged remote default)');
    console.log(cli.stdout.trim());
    console.log(`exit: ${cli.status}`);
    assert.equal(cli.status, 0, cli.stderr);
    const lines = cli.stdout.trim().split('\n');
    assert.equal(lines[0], 'cleanup: dry-run base=origin/master');
    assert.equal(lines[1], 'warning: could not refresh origin/master (origin sent origin/master as something other than a commit); cleanup judged against the local copy, which may be behind');
    assert.equal(runGit(['rev-parse', 'origin/master'], fx.repo), newer);
  } finally {
    fs.rmSync(fx.base, { recursive: true, force: true });
  }
});


test('worktree cleanup quietly refreshes an outdated base and keeps staged notes and drafts', () => {
  const fx = makeFixture();
  try {
    const copy = addCopy(fx, 'healthy-draft');
    const replaced = path.join(copy, 'outline.txt');
    fs.writeFileSync(replaced, 'original outline\n');
    fs.writeFileSync(path.join(copy, 'guide.txt'), 'original guide\n');
    fs.writeFileSync(path.join(copy, 'manual.txt'), 'original manual pages\n');
    fs.writeFileSync(path.join(copy, 'chapter.txt'), 'original chapter text\n');
    fs.writeFileSync(path.join(copy, 'appendix.txt'), 'original appendix text\n');
    fs.writeFileSync(path.join(copy, 'glossary.txt'), 'original glossary terms\n');
    fs.writeFileSync(path.join(copy, 'index.txt'), 'original index entries\n');
    fs.writeFileSync(path.join(copy, 'summary.txt'), 'original summary lines\n');
    fs.writeFileSync(path.join(copy, 'preface.txt'), 'original preface one\noriginal preface two\noriginal preface three\n');
    runGit(['add', 'outline.txt', 'guide.txt', 'manual.txt', 'chapter.txt', 'appendix.txt', 'glossary.txt', 'index.txt', 'summary.txt', 'preface.txt'], copy);
    runGit(['commit', '-q', '-m', 'add outline'], copy);
    runGit(['rm', 'outline.txt'], copy);
    fs.writeFileSync(replaced, 'replacement outline\n');
    assert.match(runGit(['diff', '--cached', '--', 'outline.txt'], copy), /deleted file mode/);
    const tracked = path.join(copy, 'README.md');
    const committed = runGit(['show', 'HEAD:README.md'], copy);
    fs.writeFileSync(tracked, '# fixture\nstaged tracked edits\n');
    runGit(['add', 'README.md'], copy);
    const stagedTracked = runGit(['show', ':README.md'], copy);
    assert.notEqual(stagedTracked, committed);
    fs.writeFileSync(tracked, '# fixture\nstaged tracked edits\nlater tracked edits\n');
    const draft = path.join(copy, 'draft.txt');
    fs.writeFileSync(draft, 'keep these notes\n');
    const note = path.join(copy, 'note.txt');
    fs.writeFileSync(note, 'staged notes\n');
    runGit(['add', 'note.txt'], copy);
    fs.writeFileSync(note, 'staged notes\nlater edits\n');
    const link = path.join(copy, 'outline-link');
    fs.symlinkSync('saved-outline.txt', link);
    runGit(['add', 'outline-link'], copy);
    fs.unlinkSync(link);
    fs.symlinkSync('later-outline.txt', link);
    assert.equal(runGit(['show', ':outline-link'], copy), 'saved-outline.txt');
    const converted = path.join(copy, 'saved-outline.txt');
    fs.writeFileSync(converted, 'saved regular outline\n');
    runGit(['add', 'saved-outline.txt'], copy);
    fs.unlinkSync(converted);
    fs.symlinkSync('replacement-outline.txt', converted);
    assert.match(runGit(['ls-files', '--stage', '--', 'saved-outline.txt'], copy), /^100644 /);
    assert.match(runGit(['status', '--porcelain', '--', 'saved-outline.txt'], copy), /^AT /);
    const restored = path.join(copy, 'saved-link');
    fs.symlinkSync('first-outline.txt', restored);
    runGit(['add', 'saved-link'], copy);
    fs.unlinkSync(restored);
    fs.writeFileSync(restored, 'later regular outline\n');
    assert.match(runGit(['ls-files', '--stage', '--', 'saved-link'], copy), /^120000 /);
    assert.match(runGit(['status', '--porcelain', '--', 'saved-link'], copy), /^AT /);
    const runnable = path.join(copy, 'outline-tool');
    fs.writeFileSync(runnable, 'saved runnable outline\n', { mode: 0o755 });
    runGit(['add', 'outline-tool'], copy);
    fs.unlinkSync(runnable);
    fs.writeFileSync(runnable, 'later plain outline\n', { mode: 0o644 });
    assert.match(runGit(['ls-files', '--stage', '--', 'outline-tool'], copy), /^100755 /);
    assert.equal(fs.statSync(runnable).mode & 0o111, 0);
    const plain = path.join(copy, 'outline-check');
    fs.writeFileSync(plain, 'saved plain outline\n', { mode: 0o644 });
    runGit(['add', 'outline-check'], copy);
    fs.unlinkSync(plain);
    fs.writeFileSync(plain, 'later runnable outline\n', { mode: 0o755 });
    assert.match(runGit(['ls-files', '--stage', '--', 'outline-check'], copy), /^100644 /);
    assert.equal(fs.statSync(plain).mode & 0o111, 0o111);
    const expanded = path.join(copy, 'outline-folder');
    fs.writeFileSync(expanded, 'saved outline before folder\n');
    runGit(['add', 'outline-folder'], copy);
    fs.unlinkSync(expanded);
    fs.mkdirSync(expanded);
    const nestedDraft = path.join(expanded, 'draft.txt');
    fs.writeFileSync(nestedDraft, 'later draft inside folder\n');
    assert.match(runGit(['ls-files', '--stage', '--', 'outline-folder'], copy), /^100644 /);
    const expandedLink = path.join(copy, 'outline-link-folder');
    fs.symlinkSync('saved-folder-outline.txt', expandedLink);
    runGit(['add', 'outline-link-folder'], copy);
    fs.unlinkSync(expandedLink);
    fs.mkdirSync(expandedLink);
    const linkedDraft = path.join(expandedLink, 'draft.txt');
    fs.writeFileSync(linkedDraft, 'later draft after link\n');
    assert.match(runGit(['ls-files', '--stage', '--', 'outline-link-folder'], copy), /^120000 /);
    const renamed = path.join(copy, 'renamed-guide');
    const renameSource = runGit(['show', 'HEAD:guide.txt'], copy);
    runGit(['mv', 'guide.txt', 'renamed-guide'], copy);
    const recreatedSource = path.join(copy, 'guide.txt');
    fs.writeFileSync(recreatedSource, 'new draft at original name\n');
    const savedRename = runGit(['show', ':renamed-guide'], copy);
    assert.equal(savedRename, renameSource);
    assert.match(runGit(['diff', '--cached', '--summary', '--', 'guide.txt', 'renamed-guide'], copy), /rename guide.txt => renamed-guide/);
    fs.unlinkSync(renamed);
    fs.mkdirSync(renamed);
    const renamedDraft = path.join(renamed, 'draft.txt');
    fs.writeFileSync(renamedDraft, 'draft inside renamed destination\n');
    const movedManual = path.join(copy, 'renamed-manual');
    const manualSource = runGit(['show', 'HEAD:manual.txt'], copy);
    runGit(['mv', 'manual.txt', 'renamed-manual'], copy);
    const linkedSource = path.join(copy, 'manual.txt');
    fs.symlinkSync('later-manual.txt', linkedSource);
    const savedManual = runGit(['show', ':renamed-manual'], copy);
    assert.equal(savedManual, manualSource);
    assert.match(runGit(['diff', '--cached', '--summary', '--', 'manual.txt', 'renamed-manual'], copy), /rename manual.txt => renamed-manual/);
    const movedChapter = path.join(copy, 'renamed-chapter');
    const chapterSource = runGit(['show', 'HEAD:chapter.txt'], copy);
    runGit(['mv', 'chapter.txt', 'renamed-chapter'], copy);
    const foldedSource = path.join(copy, 'chapter.txt');
    fs.mkdirSync(foldedSource);
    const foldedDraft = path.join(foldedSource, 'draft.txt');
    fs.writeFileSync(foldedDraft, 'draft inside original chapter name\n');
    const savedChapter = runGit(['show', ':renamed-chapter'], copy);
    assert.equal(savedChapter, chapterSource);
    assert.match(runGit(['diff', '--cached', '--summary', '--', 'chapter.txt', 'renamed-chapter'], copy), /rename chapter.txt => renamed-chapter/);
    const movedAppendix = path.join(copy, 'renamed-appendix');
    const appendixSource = runGit(['show', 'HEAD:appendix.txt'], copy);
    runGit(['mv', 'appendix.txt', 'renamed-appendix'], copy);
    const scriptSource = path.join(copy, 'appendix.txt');
    fs.writeFileSync(scriptSource, '#!/bin/sh\necho later appendix script\n');
    fs.chmodSync(scriptSource, 0o755);
    const savedAppendix = runGit(['show', ':renamed-appendix'], copy);
    assert.equal(savedAppendix, appendixSource);
    assert.match(runGit(['diff', '--cached', '--summary', '--', 'appendix.txt', 'renamed-appendix'], copy), /rename appendix.txt => renamed-appendix/);
    const linkedGlossary = path.join(copy, 'renamed-glossary');
    const glossarySource = runGit(['show', 'HEAD:glossary.txt'], copy);
    runGit(['mv', 'glossary.txt', 'renamed-glossary'], copy);
    fs.unlinkSync(linkedGlossary);
    fs.symlinkSync('later-glossary.txt', linkedGlossary);
    const savedGlossary = runGit(['show', ':renamed-glossary'], copy);
    assert.equal(savedGlossary, glossarySource);
    assert.match(runGit(['diff', '--cached', '--summary', '--', 'glossary.txt', 'renamed-glossary'], copy), /rename glossary.txt => renamed-glossary/);
    const runnableIndex = path.join(copy, 'renamed-index');
    const indexSource = runGit(['show', 'HEAD:index.txt'], copy);
    runGit(['mv', 'index.txt', 'renamed-index'], copy);
    fs.writeFileSync(runnableIndex, '#!/bin/sh\necho later index script\n');
    fs.chmodSync(runnableIndex, 0o755);
    const savedIndex = runGit(['show', ':renamed-index'], copy);
    assert.equal(savedIndex, indexSource);
    assert.match(runGit(['diff', '--cached', '--summary', '--', 'index.txt', 'renamed-index'], copy), /rename index.txt => renamed-index/);
    const removedSummary = path.join(copy, 'renamed-summary');
    const summarySource = runGit(['show', 'HEAD:summary.txt'], copy);
    runGit(['mv', 'summary.txt', 'renamed-summary'], copy);
    fs.unlinkSync(removedSummary);
    const savedSummary = runGit(['show', ':renamed-summary'], copy);
    assert.equal(savedSummary, summarySource);
    assert.match(runGit(['diff', '--cached', '--summary', '--', 'summary.txt', 'renamed-summary'], copy), /rename summary.txt => renamed-summary/);
    const editedPreface = path.join(copy, 'renamed-preface');
    const prefaceSource = runGit(['show', 'HEAD:preface.txt'], copy);
    runGit(['mv', 'preface.txt', 'renamed-preface'], copy);
    fs.writeFileSync(editedPreface, 'original preface one\noriginal preface two\noriginal preface three\nsaved preface edit\n');
    runGit(['add', 'renamed-preface'], copy);
    const savedPreface = runGit(['show', ':renamed-preface'], copy);
    assert.notEqual(savedPreface, prefaceSource);
    assert.match(runGit(['diff', '--cached', '--summary', '--', 'preface.txt', 'renamed-preface'], copy), /rename preface.txt => renamed-preface \(\d+%\)/);
    // Git quotes newlines in status output. Neither cleanup pass may split
    // that name or lose the different saved and later versions.
    const unusualName = 'chapter\nnotes.txt';
    const unusualFile = path.join(copy, unusualName);
    fs.writeFileSync(unusualFile, 'saved chapter notes\n');
    runGit(['add', '--', unusualName], copy);
    fs.writeFileSync(unusualFile, 'later chapter notes\n');
    const tabbedName = 'chapter\toutline.txt';
    const tabbedFile = path.join(copy, tabbedName);
    fs.writeFileSync(tabbedFile, 'saved chapter outline\n');
    runGit(['add', '--', tabbedName], copy);
    fs.writeFileSync(tabbedFile, 'later chapter outline\n');
    const binary = path.join(copy, 'drawing.bin');
    const savedBytes = Buffer.from([0, 255, 10, 128, 13]);
    const laterBytes = Buffer.from([0, 254, 10, 129, 13, 0]);
    fs.writeFileSync(binary, savedBytes);
    runGit(['add', 'drawing.bin'], copy);
    fs.writeFileSync(binary, laterBytes);
    assert.notDeepEqual(savedBytes, laterBytes);
    const staged = runGit(['diff', '--cached', '--binary'], copy);
    const indexTree = runGit(['write-tree'], copy);
    assert.notEqual(indexTree, runGit(['rev-parse', 'HEAD^{tree}'], copy));
    const saved = runGit(['rev-parse', 'origin/master'], fx.repo);
    const other = path.join(fx.base, 'other');
    runGit(['clone', '-q', path.join(fx.base, 'remote.git'), other], fx.base);
    configure(other);
    fs.writeFileSync(path.join(other, 'later.txt'), 'later work\n');
    runGit(['add', 'later.txt'], other);
    runGit(['commit', '-q', '-m', 'later work'], other);
    runGit(['push', '-q', 'origin', 'master'], other);
    const newer = runGit(['rev-parse', 'HEAD'], other);
    assert.notEqual(newer, saved);
    const status = runGit(['status', '--porcelain'], copy);
    for (const extra of [[], ['--apply']]) {
      runGit(['update-ref', 'refs/remotes/origin/master', saved], fx.repo);
      assert.equal(runGit(['rev-parse', 'origin/master'], fx.repo), saved);
      const cli = spawnSync(process.execPath, [path.resolve(__dirname, '../bin/atris.js'), 'worktree', 'cleanup', ...extra], { cwd: fx.repo, encoding: 'utf8', timeout: 30000 });
      console.log(`command: node bin/atris.js worktree cleanup${extra.length ? ' --apply' : ''} (healthy origin, local base behind)`);
      console.log(cli.stdout.trim());
      console.log(`exit: ${cli.status}`);
      assert.equal(cli.status, 0, cli.stderr);
      assert.equal(cli.stderr, '');
      const lines = cli.stdout.trim().split('\n');
      assert.equal(lines[0], `cleanup: ${extra.length ? 'applied' : 'dry-run'} base=origin/master`);
      assert.equal(lines[1], extra.length ? 'removeds: 0' : 'candidates: 0');
      assert.doesNotMatch(cli.stdout, /warning:|could not refresh|may be behind/);
      assert.equal(fs.readFileSync(unusualFile, 'utf8'), 'later chapter notes\n');
      assert.equal(runGit(['show', `:${unusualName}`], copy), 'saved chapter notes');
      assert.equal(fs.readFileSync(tabbedFile, 'utf8'), 'later chapter outline\n');
      assert.equal(runGit(['show', `:${tabbedName}`], copy), 'saved chapter outline');
      assert.equal(fs.readFileSync(replaced, 'utf8'), 'replacement outline\n');
      assert.equal(runGit(['show', 'HEAD:outline.txt'], copy), 'original outline');
      assert.equal(runGit(['ls-files', '--', 'outline.txt'], copy), '');
      assert.equal(fs.readFileSync(tracked, 'utf8'), '# fixture\nstaged tracked edits\nlater tracked edits\n');
      assert.equal(runGit(['show', 'HEAD:README.md'], copy), committed);
      assert.equal(runGit(['show', ':README.md'], copy), stagedTracked);
      assert.equal(fs.readFileSync(draft, 'utf8'), 'keep these notes\n');
      assert.equal(fs.readFileSync(note, 'utf8'), 'staged notes\nlater edits\n');
      assert.equal(runGit(['show', ':note.txt'], copy), 'staged notes');
      assert.equal(runGit(['diff', '--cached', '--binary'], copy), staged);
      assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
      assert.equal(fs.readlinkSync(link), 'later-outline.txt');
      assert.equal(runGit(['show', ':outline-link'], copy), 'saved-outline.txt');
      assert.equal(fs.lstatSync(converted).isSymbolicLink(), true);
      assert.equal(fs.readlinkSync(converted), 'replacement-outline.txt');
      assert.equal(runGit(['show', ':saved-outline.txt'], copy), 'saved regular outline');
      assert.match(runGit(['ls-files', '--stage', '--', 'saved-outline.txt'], copy), /^100644 /);
      assert.equal(fs.lstatSync(restored).isFile(), true);
      assert.equal(fs.readFileSync(restored, 'utf8'), 'later regular outline\n');
      assert.equal(runGit(['show', ':saved-link'], copy), 'first-outline.txt');
      assert.match(runGit(['ls-files', '--stage', '--', 'saved-link'], copy), /^120000 /);
      assert.equal(fs.readFileSync(runnable, 'utf8'), 'later plain outline\n');
      assert.equal(fs.statSync(runnable).mode & 0o111, 0);
      assert.equal(runGit(['show', ':outline-tool'], copy), 'saved runnable outline');
      assert.match(runGit(['ls-files', '--stage', '--', 'outline-tool'], copy), /^100755 /);
      assert.equal(fs.readFileSync(plain, 'utf8'), 'later runnable outline\n');
      assert.equal(fs.statSync(plain).mode & 0o111, 0o111);
      assert.equal(runGit(['show', ':outline-check'], copy), 'saved plain outline');
      assert.match(runGit(['ls-files', '--stage', '--', 'outline-check'], copy), /^100644 /);
      assert.equal(fs.lstatSync(expanded).isDirectory(), true);
      assert.equal(fs.readFileSync(nestedDraft, 'utf8'), 'later draft inside folder\n');
      assert.equal(runGit(['show', ':outline-folder'], copy), 'saved outline before folder');
      assert.match(runGit(['ls-files', '--stage', '--', 'outline-folder'], copy), /^100644 /);
      assert.equal(fs.lstatSync(expandedLink).isDirectory(), true);
      assert.equal(fs.readFileSync(linkedDraft, 'utf8'), 'later draft after link\n');
      assert.equal(runGit(['show', ':outline-link-folder'], copy), 'saved-folder-outline.txt');
      assert.match(runGit(['ls-files', '--stage', '--', 'outline-link-folder'], copy), /^120000 /);
      assert.equal(fs.readFileSync(recreatedSource, 'utf8'), 'new draft at original name\n');
      assert.equal(runGit(['show', 'HEAD:guide.txt'], copy), renameSource);
      assert.equal(runGit(['ls-files', '--', 'guide.txt'], copy), '');
      assert.equal(runGit(['show', ':renamed-guide'], copy), savedRename);
      assert.match(runGit(['ls-files', '--stage', '--', 'renamed-guide'], copy), /^100644 /);
      assert.equal(fs.lstatSync(renamed).isDirectory(), true);
      assert.equal(fs.readFileSync(renamedDraft, 'utf8'), 'draft inside renamed destination\n');
      assert.equal(fs.lstatSync(linkedSource).isSymbolicLink(), true);
      assert.equal(fs.readlinkSync(linkedSource), 'later-manual.txt');
      assert.equal(runGit(['show', 'HEAD:manual.txt'], copy), manualSource);
      assert.equal(runGit(['ls-files', '--', 'manual.txt'], copy), '');
      assert.equal(runGit(['show', ':renamed-manual'], copy), savedManual);
      assert.match(runGit(['ls-files', '--stage', '--', 'renamed-manual'], copy), /^100644 /);
      assert.equal(fs.readFileSync(movedManual, 'utf8'), 'original manual pages\n');
      assert.equal(fs.lstatSync(foldedSource).isDirectory(), true);
      assert.equal(fs.readFileSync(foldedDraft, 'utf8'), 'draft inside original chapter name\n');
      assert.equal(runGit(['show', 'HEAD:chapter.txt'], copy), chapterSource);
      assert.equal(runGit(['ls-files', '--', 'chapter.txt'], copy), '');
      assert.equal(runGit(['show', ':renamed-chapter'], copy), savedChapter);
      assert.match(runGit(['ls-files', '--stage', '--', 'renamed-chapter'], copy), /^100644 /);
      assert.equal(fs.readFileSync(movedChapter, 'utf8'), 'original chapter text\n');
      assert.equal(fs.lstatSync(scriptSource).isFile(), true);
      assert.equal(fs.readFileSync(scriptSource, 'utf8'), '#!/bin/sh\necho later appendix script\n');
      assert.equal(fs.statSync(scriptSource).mode & 0o111, 0o111);
      assert.equal(runGit(['show', 'HEAD:appendix.txt'], copy), appendixSource);
      assert.equal(runGit(['ls-files', '--', 'appendix.txt'], copy), '');
      assert.equal(runGit(['show', ':renamed-appendix'], copy), savedAppendix);
      assert.match(runGit(['ls-files', '--stage', '--', 'renamed-appendix'], copy), /^100644 /);
      assert.equal(fs.readFileSync(movedAppendix, 'utf8'), 'original appendix text\n');
      assert.equal(fs.lstatSync(linkedGlossary).isSymbolicLink(), true);
      assert.equal(fs.readlinkSync(linkedGlossary), 'later-glossary.txt');
      assert.equal(runGit(['show', 'HEAD:glossary.txt'], copy), glossarySource);
      assert.equal(runGit(['ls-files', '--', 'glossary.txt'], copy), '');
      assert.equal(fs.existsSync(path.join(copy, 'glossary.txt')), false);
      assert.equal(runGit(['show', ':renamed-glossary'], copy), savedGlossary);
      assert.match(runGit(['ls-files', '--stage', '--', 'renamed-glossary'], copy), /^100644 /);
      assert.equal(fs.readFileSync(runnableIndex, 'utf8'), '#!/bin/sh\necho later index script\n');
      assert.equal(fs.statSync(runnableIndex).mode & 0o111, 0o111);
      assert.equal(runGit(['show', 'HEAD:index.txt'], copy), indexSource);
      assert.equal(runGit(['ls-files', '--', 'index.txt'], copy), '');
      assert.equal(fs.existsSync(path.join(copy, 'index.txt')), false);
      assert.equal(runGit(['show', ':renamed-index'], copy), savedIndex);
      assert.match(runGit(['ls-files', '--stage', '--', 'renamed-index'], copy), /^100644 /);
      assert.equal(fs.existsSync(removedSummary), false);
      assert.equal(fs.existsSync(path.join(copy, 'summary.txt')), false);
      assert.equal(runGit(['show', 'HEAD:summary.txt'], copy), summarySource);
      assert.equal(runGit(['ls-files', '--', 'summary.txt'], copy), '');
      assert.equal(runGit(['show', ':renamed-summary'], copy), savedSummary);
      assert.match(runGit(['ls-files', '--stage', '--', 'renamed-summary'], copy), /^100644 /);
      assert.equal(fs.readFileSync(editedPreface, 'utf8'), 'original preface one\noriginal preface two\noriginal preface three\nsaved preface edit\n');
      assert.equal(fs.existsSync(path.join(copy, 'preface.txt')), false);
      assert.equal(runGit(['show', 'HEAD:preface.txt'], copy), prefaceSource);
      assert.equal(runGit(['ls-files', '--', 'preface.txt'], copy), '');
      assert.equal(runGit(['show', ':renamed-preface'], copy), savedPreface);
      assert.match(runGit(['ls-files', '--stage', '--', 'renamed-preface'], copy), /^100644 /);
      assert.deepEqual(fs.readFileSync(binary), laterBytes);
      const savedBinary = spawnSync('git', ['show', ':drawing.bin'], { cwd: copy });
      assert.equal(savedBinary.status, 0);
      assert.deepEqual(savedBinary.stdout, savedBytes);
      assert.equal(runGit(['write-tree'], copy), indexTree);
      assert.equal(runGit(['status', '--porcelain'], copy), status);
      assert.equal(runGit(['rev-parse', 'origin/master'], fx.repo), newer);
      assert.equal(runGit(['rev-parse', 'FETCH_HEAD'], fx.repo), newer);
      assert.ok(branchExists(fx.repo, 'healthy-draft'));
      assert.ok(runGit(['worktree', 'list', '--porcelain'], fx.repo).includes(`worktree ${copy}\n`));
      assert.equal(fs.existsSync(path.join(fx.repo, '.atris/state/worktree_removals.jsonl')), false);
    }
  } finally {
    fs.rmSync(fx.base, { recursive: true, force: true });
  }
});

test('worktree cleanup warns and keeps drafts when origin is unavailable', () => {
  const fx = makeFixture();
  try {
    const copy = addCopy(fx, 'offline-draft');
    const draft = path.join(copy, 'draft.txt');
    fs.writeFileSync(draft, 'keep these notes\n');
    const tracked = path.join(copy, 'README.md');
    const committed = runGit(['show', 'HEAD:README.md'], copy);
    runGit(['rm', 'README.md'], copy);
    const staged = runGit(['diff', '--cached', '--binary'], copy);
    assert.match(staged, /deleted file mode/);
    const saved = runGit(['rev-parse', 'origin/master'], fx.repo);
    const status = runGit(['status', '--porcelain'], copy);
    fs.renameSync(path.join(fx.base, 'remote.git'), path.join(fx.base, 'remote-offline.git'));
    for (const extra of [[], ['--apply']]) {
      const cli = spawnSync(process.execPath, [path.resolve(__dirname, '../bin/atris.js'), 'worktree', 'cleanup', ...extra], { cwd: fx.repo, encoding: 'utf8', timeout: 30000 });
      console.log(`command: node bin/atris.js worktree cleanup${extra.length ? ' --apply' : ''} (unavailable origin)`);
      console.log(cli.stdout.trim());
      console.log(`exit: ${cli.status}`);
      assert.equal(cli.status, 0, cli.stderr);
      const lines = cli.stdout.trim().split('\n');
      assert.equal(lines[0], `cleanup: ${extra.length ? 'applied' : 'dry-run'} base=origin/master`);
      assert.match(lines[1], /^warning: could not refresh origin\/master \(fatal: .*remote\.git.*does not appear to be a git repository\); cleanup judged against the local copy, which may be behind$/);
      assert.ok(lines.includes(extra.length ? 'removeds: 0' : 'candidates: 0'), cli.stdout);
      assert.equal(fs.readFileSync(draft, 'utf8'), 'keep these notes\n');
      assert.equal(fs.existsSync(tracked), false);
      assert.equal(runGit(['show', 'HEAD:README.md'], copy), committed);
      assert.equal(runGit(['ls-files', '--', 'README.md'], copy), '');
      assert.equal(runGit(['diff', '--cached', '--binary'], copy), staged);
      assert.equal(runGit(['status', '--porcelain'], copy), status);
      assert.equal(runGit(['rev-parse', 'origin/master'], fx.repo), saved);
      assert.ok(branchExists(fx.repo, 'offline-draft'));
      assert.ok(runGit(['worktree', 'list', '--porcelain'], fx.repo).includes(`worktree ${copy}\n`));
      assert.equal(fs.existsSync(path.join(fx.repo, '.atris/state/worktree_removals.jsonl')), false);
    }
  } finally {
    fs.rmSync(fx.base, { recursive: true, force: true });
  }
});
test('worktree cleanup keeps a staged rename and later edits when origin is unavailable', () => {
  const fx = makeFixture();
  try {
    const copy = addCopy(fx, 'offline-rename');
    const moved = path.join(copy, 'GUIDE.md');
    const committed = runGit(['show', 'HEAD:README.md'], copy);
    runGit(['mv', 'README.md', 'GUIDE.md'], copy);
    fs.writeFileSync(moved, 'later guide edits\n');
    const staged = runGit(['diff', '--cached', '-M', '--binary'], copy);
    assert.match(staged, /rename from README\.md\nrename to GUIDE\.md/);
    const later = runGit(['diff', '--binary'], copy);
    const status = runGit(['status', '--porcelain'], copy);
    assert.equal(status, 'RM README.md -> GUIDE.md');
    const saved = runGit(['rev-parse', 'origin/master'], fx.repo);
    fs.renameSync(path.join(fx.base, 'remote.git'), path.join(fx.base, 'remote-offline.git'));
    for (const extra of [[], ['--apply']]) {
      const cli = spawnSync(process.execPath, [path.resolve(__dirname, '../bin/atris.js'), 'worktree', 'cleanup', ...extra], { cwd: fx.repo, encoding: 'utf8', timeout: 30000 });
      console.log(`command: node bin/atris.js worktree cleanup${extra.length ? ' --apply' : ''} (unavailable origin, staged rename)`);
      console.log(cli.stdout.trim());
      console.log(`exit: ${cli.status}`);
      assert.equal(cli.status, 0, cli.stderr);
      const lines = cli.stdout.trim().split('\n');
      assert.equal(lines[0], `cleanup: ${extra.length ? 'applied' : 'dry-run'} base=origin/master`);
      assert.match(lines[1], /^warning: could not refresh origin\/master /);
      assert.ok(lines.includes(extra.length ? 'removeds: 0' : 'candidates: 0'), cli.stdout);
      assert.equal(fs.existsSync(path.join(copy, 'README.md')), false);
      assert.equal(fs.readFileSync(moved, 'utf8'), 'later guide edits\n');
      assert.equal(runGit(['show', ':GUIDE.md'], copy), committed);
      assert.equal(runGit(['show', 'HEAD:README.md'], copy), committed);
      assert.equal(runGit(['diff', '--cached', '-M', '--binary'], copy), staged);
      assert.equal(runGit(['diff', '--binary'], copy), later);
      assert.equal(runGit(['status', '--porcelain'], copy), status);
      assert.equal(runGit(['rev-parse', 'origin/master'], fx.repo), saved);
      assert.ok(branchExists(fx.repo, 'offline-rename'));
      assert.ok(runGit(['worktree', 'list', '--porcelain'], fx.repo).includes(`worktree ${copy}\n`));
      assert.equal(fs.existsSync(path.join(fx.repo, '.atris/state/worktree_removals.jsonl')), false);
    }
  } finally {
    fs.rmSync(fx.base, { recursive: true, force: true });
  }
});
test('worktree cleanup keeps a staged new file and later edits when origin is unavailable', () => {
  const fx = makeFixture();
  try {
    const copy = addCopy(fx, 'offline-added');
    const added = path.join(copy, 'PLAN.md');
    fs.writeFileSync(added, 'first plan\n');
    runGit(['add', 'PLAN.md'], copy);
    fs.writeFileSync(added, 'first plan\nlater plan edits\n');
    const staged = runGit(['diff', '--cached', '--binary'], copy);
    assert.match(staged, /new file mode 100644/);
    const later = runGit(['diff', '--binary'], copy);
    const status = runGit(['status', '--porcelain'], copy);
    assert.equal(status, 'AM PLAN.md');
    const saved = runGit(['rev-parse', 'origin/master'], fx.repo);
    fs.renameSync(path.join(fx.base, 'remote.git'), path.join(fx.base, 'remote-offline.git'));
    for (const extra of [[], ['--apply']]) {
      const cli = spawnSync(process.execPath, [path.resolve(__dirname, '../bin/atris.js'), 'worktree', 'cleanup', ...extra], { cwd: fx.repo, encoding: 'utf8', timeout: 30000 });
      console.log(`command: node bin/atris.js worktree cleanup${extra.length ? ' --apply' : ''} (unavailable origin, staged new file)`);
      console.log(cli.stdout.trim());
      console.log(`exit: ${cli.status}`);
      assert.equal(cli.status, 0, cli.stderr);
      const lines = cli.stdout.trim().split('\n');
      assert.equal(lines[0], `cleanup: ${extra.length ? 'applied' : 'dry-run'} base=origin/master`);
      assert.match(lines[1], /^warning: could not refresh origin\/master /);
      assert.ok(lines.includes(extra.length ? 'removeds: 0' : 'candidates: 0'), cli.stdout);
      assert.ok(lines.includes(`kept: ${copy} branch=offline-added reason=dirty staged=1 unstaged=1 untracked=0`), cli.stdout);
      assert.equal(fs.readFileSync(added, 'utf8'), 'first plan\nlater plan edits\n');
      assert.equal(runGit(['show', ':PLAN.md'], copy), 'first plan');
      assert.equal(runGit(['ls-tree', '--name-only', 'HEAD', '--', 'PLAN.md'], copy), '');
      assert.equal(runGit(['diff', '--cached', '--binary'], copy), staged);
      assert.equal(runGit(['diff', '--binary'], copy), later);
      assert.equal(runGit(['status', '--porcelain'], copy), status);
      assert.equal(runGit(['rev-parse', 'origin/master'], fx.repo), saved);
      assert.ok(branchExists(fx.repo, 'offline-added'));
      assert.ok(runGit(['worktree', 'list', '--porcelain'], fx.repo).includes(`worktree ${copy}\n`));
      assert.equal(fs.existsSync(path.join(fx.repo, '.atris/state/worktree_removals.jsonl')), false);
    }
  } finally {
    fs.rmSync(fx.base, { recursive: true, force: true });
  }
});
test('worktree cleanup keeps a staged new file deleted before saving when origin is unavailable', () => {
  const fx = makeFixture();
  try {
    const copy = addCopy(fx, 'offline-vanished');
    const added = path.join(copy, 'PLAN.md');
    fs.writeFileSync(added, 'only staged plan\n');
    runGit(['add', 'PLAN.md'], copy);
    fs.rmSync(added);
    const staged = runGit(['diff', '--cached', '--binary'], copy);
    assert.match(staged, /new file mode 100644/);
    const later = runGit(['diff', '--binary'], copy);
    assert.match(later, /deleted file mode 100644/);
    const status = runGit(['status', '--porcelain'], copy);
    assert.equal(status, 'AD PLAN.md');
    const saved = runGit(['rev-parse', 'origin/master'], fx.repo);
    fs.renameSync(path.join(fx.base, 'remote.git'), path.join(fx.base, 'remote-offline.git'));
    for (const extra of [[], ['--apply']]) {
      const cli = spawnSync(process.execPath, [path.resolve(__dirname, '../bin/atris.js'), 'worktree', 'cleanup', ...extra], { cwd: fx.repo, encoding: 'utf8', timeout: 30000 });
      console.log(`command: node bin/atris.js worktree cleanup${extra.length ? ' --apply' : ''} (unavailable origin, staged new file deleted)`);
      console.log(cli.stdout.trim());
      console.log(`exit: ${cli.status}`);
      assert.equal(cli.status, 0, cli.stderr);
      const lines = cli.stdout.trim().split('\n');
      assert.equal(lines[0], `cleanup: ${extra.length ? 'applied' : 'dry-run'} base=origin/master`);
      assert.match(lines[1], /^warning: could not refresh origin\/master /);
      assert.ok(lines.includes(extra.length ? 'removeds: 0' : 'candidates: 0'), cli.stdout);
      assert.ok(lines.includes(`kept: ${copy} branch=offline-vanished reason=dirty staged=1 unstaged=1 untracked=0`), cli.stdout);
      assert.equal(fs.existsSync(added), false);
      assert.equal(runGit(['show', ':PLAN.md'], copy), 'only staged plan');
      assert.equal(runGit(['ls-tree', '--name-only', 'HEAD', '--', 'PLAN.md'], copy), '');
      assert.equal(runGit(['diff', '--cached', '--binary'], copy), staged);
      assert.equal(runGit(['diff', '--binary'], copy), later);
      assert.equal(runGit(['status', '--porcelain'], copy), status);
      assert.equal(runGit(['rev-parse', 'origin/master'], fx.repo), saved);
      assert.ok(branchExists(fx.repo, 'offline-vanished'));
      assert.ok(runGit(['worktree', 'list', '--porcelain'], fx.repo).includes(`worktree ${copy}\n`));
      assert.equal(fs.existsSync(path.join(fx.repo, '.atris/state/worktree_removals.jsonl')), false);
    }
  } finally {
    fs.rmSync(fx.base, { recursive: true, force: true });
  }
});
test('worktree cleanup keeps a staged mode-only change when origin is unavailable', () => {
  const fx = makeFixture();
  try {
    const copy = addCopy(fx, 'offline-mode');
    const readme = path.join(copy, 'README.md');
    const committed = runGit(['show', 'HEAD:README.md'], copy);
    runGit(['config', 'core.fileMode', 'true'], copy);
    fs.chmodSync(readme, 0o755);
    runGit(['add', 'README.md'], copy);
    const staged = runGit(['diff', '--cached', '--binary'], copy);
    assert.match(staged, /old mode 100644\nnew mode 100755/);
    assert.doesNotMatch(staged, /^@@/m);
    assert.equal(runGit(['diff', '--binary'], copy), '');
    const status = runGit(['status', '--porcelain'], copy);
    assert.equal(status, 'M  README.md');
    const saved = runGit(['rev-parse', 'origin/master'], fx.repo);
    fs.renameSync(path.join(fx.base, 'remote.git'), path.join(fx.base, 'remote-offline.git'));
    for (const extra of [[], ['--apply']]) {
      const cli = spawnSync(process.execPath, [path.resolve(__dirname, '../bin/atris.js'), 'worktree', 'cleanup', ...extra], { cwd: fx.repo, encoding: 'utf8', timeout: 30000 });
      console.log(`command: node bin/atris.js worktree cleanup${extra.length ? ' --apply' : ''} (unavailable origin, staged mode-only change)`);
      console.log(cli.stdout.trim());
      console.log(`exit: ${cli.status}`);
      assert.equal(cli.status, 0, cli.stderr);
      const lines = cli.stdout.trim().split('\n');
      assert.equal(lines[0], `cleanup: ${extra.length ? 'applied' : 'dry-run'} base=origin/master`);
      assert.match(lines[1], /^warning: could not refresh origin\/master /);
      assert.ok(lines.includes(extra.length ? 'removeds: 0' : 'candidates: 0'), cli.stdout);
      assert.ok(lines.includes(`kept: ${copy} branch=offline-mode reason=dirty staged=1 unstaged=0 untracked=0`), cli.stdout);
      assert.equal(fs.statSync(readme).mode & 0o777, 0o755);
      assert.equal(fs.readFileSync(readme, 'utf8').trim(), committed);
      assert.match(runGit(['ls-files', '--stage', '--', 'README.md'], copy), /^100755 /);
      assert.match(runGit(['ls-tree', 'HEAD', '--', 'README.md'], copy), /^100644 /);
      assert.equal(runGit(['diff', '--cached', '--binary'], copy), staged);
      assert.equal(runGit(['status', '--porcelain'], copy), status);
      assert.equal(runGit(['rev-parse', 'origin/master'], fx.repo), saved);
      assert.ok(branchExists(fx.repo, 'offline-mode'));
      assert.ok(runGit(['worktree', 'list', '--porcelain'], fx.repo).includes(`worktree ${copy}\n`));
      assert.equal(fs.existsSync(path.join(fx.repo, '.atris/state/worktree_removals.jsonl')), false);
    }
  } finally {
    fs.rmSync(fx.base, { recursive: true, force: true });
  }
});
