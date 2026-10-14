// `atris member tidy` puts away member copies of a repo. A merged copy goes
// with its local branch, an old unmerged copy is pushed to origin as
// backup/<branch> before it goes, and a copy with uncommitted changes stays.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { tidyMemberCopies, formatTidy } = require('../lib/member-tidy');

const CLI = path.join(__dirname, '..', 'bin', 'atris.js');

function runGit(args, cwd, env = {}) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 15000, env: { ...process.env, ...env } });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function commit(cwd, file, text, env = {}) {
  fs.writeFileSync(path.join(cwd, file), text);
  runGit(['add', file], cwd);
  runGit(['commit', '-q', '-m', `add ${file}`], cwd, env);
}

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-member-tidy-'));
  const remote = path.join(base, 'remote.git');
  const repo = path.join(base, 'repo');
  runGit(['init', '-q', '--bare', '-b', 'master', remote], base);
  runGit(['init', '-q', '-b', 'master', repo], base);
  runGit(['config', 'user.email', 'test@example.com'], repo);
  runGit(['config', 'user.name', 'Test'], repo);
  commit(repo, 'README.md', '# fixture\n');
  runGit(['remote', 'add', 'origin', remote], repo);
  runGit(['push', '-q', '-u', 'origin', 'master'], repo);

  const folder = path.join(base, '.agent-worktrees', 'repo');
  const copy = (name) => {
    const wt = path.join(folder, name);
    runGit(['worktree', 'add', '-q', '-b', `codex/${name}`, wt, 'origin/master'], repo);
    return wt;
  };

  const merged = copy('architect-merged-20261001-000000');
  commit(merged, 'merged.txt', 'landed\n');
  runGit(['push', '-q', 'origin', 'HEAD:master'], merged);

  const old = copy('scout-old-20261001-000000');
  const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  commit(old, 'old.txt', 'never landed\n', { GIT_AUTHOR_DATE: tenDaysAgo, GIT_COMMITTER_DATE: tenDaysAgo });

  const dirty = copy('lead-dirty-20261001-000000');
  fs.writeFileSync(path.join(dirty, 'draft.txt'), 'half done\n');
  fs.writeFileSync(path.join(dirty, 'README.md'), '# edited\n');

  runGit(['fetch', '-q', 'origin'], repo);
  return { base, remote, repo, folder, merged, old, dirty };
}

function byName(result, wt) {
  return result.rows.find((row) => row.name === path.basename(wt));
}

test('dry run lists what tidy would do and touches nothing', () => {
  const fx = fixture();
  const result = tidyMemberCopies(fx.repo, { dryRun: true, noFetch: true });

  assert.equal(byName(result, fx.merged).action, 'removed');
  assert.equal(byName(result, fx.old).action, 'backed up');
  assert.equal(byName(result, fx.dirty).action, 'skipped');
  assert.match(byName(result, fx.dirty).reason, /uncommitted changes: README\.md, draft\.txt$/);

  const text = formatTidy(result);
  assert.match(text, /^would remove architect-merged-20261001-000000: merged into master$/m);
  assert.match(text, /^would back up and remove scout-old-20261001-000000: not merged, 10 days old, saved to origin as backup\/codex\/scout-old-20261001-000000$/m);
  assert.match(text, /^total: 3 member copies, 1 to remove, 1 to back up, 0 kept, 1 skipped$/m);

  for (const wt of [fx.merged, fx.old, fx.dirty]) assert.ok(fs.existsSync(wt), `${wt} should still exist`);
  const remoteBranches = runGit(['branch', '--list', 'backup/*'], fx.remote);
  assert.equal(remoteBranches, '');
});

test('tidy removes merged, backs up old unmerged, and leaves dirty alone', () => {
  const fx = fixture();
  const result = tidyMemberCopies(fx.repo, { noFetch: true });

  assert.equal(result.totals.failed, 0, formatTidy(result));
  assert.equal(fs.existsSync(fx.merged), false);
  assert.equal(runGit(['branch', '--list', 'codex/architect-merged-20261001-000000'], fx.repo), '');

  assert.equal(fs.existsSync(fx.old), false);
  const backupSha = runGit(['rev-parse', 'refs/heads/backup/codex/scout-old-20261001-000000'], fx.remote);
  assert.equal(backupSha, runGit(['rev-parse', 'codex/scout-old-20261001-000000'], fx.repo));

  assert.ok(fs.existsSync(path.join(fx.dirty, 'draft.txt')));
  assert.match(byName(result, fx.dirty).reason, /draft\.txt/);
  assert.match(formatTidy(result), /^total: 3 member copies, 1 removed, 1 backed up, 0 kept, 1 skipped$/m);
});

test('a copy whose recorded run process is alive is skipped', () => {
  const fx = fixture();
  fs.mkdirSync(path.join(fx.merged, '.atris', 'state'), { recursive: true });
  fs.writeFileSync(path.join(fx.repo, '.git', 'info', 'exclude'), '.atris/\n');
  fs.writeFileSync(path.join(fx.merged, '.atris', 'state', 'mission-x.lock'), JSON.stringify({ pid: process.ppid }));

  const result = tidyMemberCopies(fx.repo, { dryRun: true, noFetch: true });
  assert.equal(byName(result, fx.merged).action, 'skipped');
  assert.match(byName(result, fx.merged).reason, new RegExp(`in use by running process ${process.ppid}`));
});

test('the CLI prints one line per copy and a total', () => {
  const fx = fixture();
  const res = spawnSync(process.execPath, [CLI, 'member', 'tidy', '--dry-run', '--no-fetch'], {
    cwd: fx.repo, encoding: 'utf8', timeout: 60000,
  });
  assert.equal(res.status, 0, res.stderr);
  const lines = res.stdout.trim().split('\n').filter((line) => /^(would|kept|skipped|failed|removed|backed|total)/.test(line));
  assert.equal(lines.length, 4, res.stdout);
  assert.match(lines[3], /^total: 3 member copies/);
});

test('tidy follows the remote default branch, not a stale remembered one', () => {
  const fx = fixture();
  // Remember origin's default as master, then switch the remote to a new main
  // that does not contain the merged copy's work.
  runGit(['remote', 'set-head', 'origin', 'master'], fx.repo);
  const firstCommit = runGit(['rev-list', '--max-parents=0', 'master'], fx.remote);
  runGit(['branch', 'main', firstCommit], fx.remote);
  runGit(['symbolic-ref', 'HEAD', 'refs/heads/main'], fx.remote);

  const result = tidyMemberCopies(fx.repo, { dryRun: false });
  assert.equal(result.base, 'origin/main', formatTidy(result));
  assert.equal(byName(result, fx.merged).action, 'kept', formatTidy(result));
  assert.ok(fs.existsSync(fx.merged), 'work not in the new default must survive');
});

test('tidy removes nothing when it cannot ask the remote for its default branch', () => {
  const fx = fixture();
  runGit(['remote', 'set-url', 'origin', path.join(fx.base, 'gone.git')], fx.repo);

  const result = tidyMemberCopies(fx.repo, { dryRun: false });
  assert.match(String(result.error), /could not ask origin/i);
  for (const wt of [fx.merged, fx.old, fx.dirty]) assert.ok(fs.existsSync(wt), `${wt} should still exist`);
});

// Fail-closed checks: when tidy cannot be sure a copy is safe to remove, the
// copy stays.

function fakeBin(fx, name, script) {
  const bin = path.join(fx.base, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, name), script, { mode: 0o755 });
  return bin;
}

function withPath(bin, env, fn) {
  const saved = { PATH: process.env.PATH };
  for (const key of Object.keys(env)) saved[key] = process.env[key];
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  Object.assign(process.env, env);
  try { return fn(); } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

test('an untracked draft is kept even when git is told to hide untracked files', () => {
  const fx = fixture();
  runGit(['config', 'status.showUntrackedFiles', 'no'], fx.repo);
  fs.writeFileSync(path.join(fx.merged, 'draft.md'), 'unsaved idea\n');

  const result = tidyMemberCopies(fx.repo, { noFetch: true });
  assert.equal(byName(result, fx.merged).action, 'skipped', formatTidy(result));
  assert.match(byName(result, fx.merged).reason, /uncommitted changes: draft\.md/);
  assert.equal(fs.readFileSync(path.join(fx.merged, 'draft.md'), 'utf8'), 'unsaved idea\n');
});

test('edits hidden by assume-unchanged or skip-worktree are kept', () => {
  for (const flag of ['--assume-unchanged', '--skip-worktree']) {
    const fx = fixture();
    runGit(['update-index', flag, 'README.md'], fx.merged);
    fs.writeFileSync(path.join(fx.merged, 'README.md'), '# hidden edit\n');
    assert.equal(runGit(['status', '--porcelain'], fx.merged), '', 'git status hides the edit');

    const result = tidyMemberCopies(fx.repo, { noFetch: true });
    assert.equal(byName(result, fx.merged).action, 'skipped', `${flag}: ${formatTidy(result)}`);
    assert.match(byName(result, fx.merged).reason, /README\.md/);
    assert.equal(fs.readFileSync(path.join(fx.merged, 'README.md'), 'utf8'), '# hidden edit\n');
  }
});

test('a failed process scan keeps every copy', () => {
  const fx = fixture();
  const bin = fakeBin(fx, 'lsof', '#!/bin/sh\necho "lsof: broken" >&2\nexit 1\n');

  const result = withPath(bin, {}, () => tidyMemberCopies(fx.repo, { noFetch: true }));
  assert.equal(result.totals.removed + result.totals['backed up'], 0, formatTidy(result));
  assert.equal(byName(result, fx.merged).reason, 'could not check for running processes');
  for (const wt of [fx.merged, fx.old, fx.dirty]) assert.ok(fs.existsSync(wt), `${wt} should still exist`);
  assert.notEqual(runGit(['branch', '--list', 'codex/architect-merged-20261001-000000'], fx.repo), '');
});

test('a copies folder that is a symlink to elsewhere removes nothing', () => {
  const fx = fixture();
  for (const wt of [fx.merged, fx.old, fx.dirty]) runGit(['worktree', 'remove', '--force', wt], fx.repo);
  const outside = path.join(fx.base, 'outside');
  fs.mkdirSync(outside);
  fs.rmSync(fx.folder, { recursive: true, force: true });
  fs.symlinkSync(outside, fx.folder);
  const external = path.join(outside, 'external-copy');
  runGit(['worktree', 'add', '-q', '-b', 'member/outside', external, 'origin/master'], fx.repo);

  const result = tidyMemberCopies(fx.repo, { noFetch: true });
  assert.match(String(result.error), /is a symlink, so nothing was removed/);
  assert.ok(fs.existsSync(path.join(external, 'README.md')), 'outside copy untouched');
  assert.notEqual(runGit(['branch', '--list', 'member/outside'], fx.repo), '');
});

test('a copy that is a symlink pointing outside is kept and the outside is untouched', () => {
  const fx = fixture();
  const outside = path.join(fx.base, 'outside');
  fs.mkdirSync(outside);
  const moved = path.join(outside, path.basename(fx.merged));
  fs.renameSync(fx.merged, moved);
  fs.symlinkSync(moved, fx.merged);

  const result = tidyMemberCopies(fx.repo, { noFetch: true });
  const row = byName(result, fx.merged);
  assert.equal(row.action, 'skipped', formatTidy(result));
  assert.match(row.reason, /outside the member copies folder|symlink/);
  assert.ok(fs.existsSync(path.join(moved, 'merged.txt')), 'outside folder untouched');
  assert.notEqual(runGit(['branch', '--list', 'codex/architect-merged-20261001-000000'], fx.repo), '');
});

test('a commit arriving after the merge check keeps the copy and its branch', () => {
  const fx = fixture();
  const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  // A git that lands a new commit in the copy right after tidy asks whether
  // the copy is merged, the way a member still working would.
  const bin = fakeBin(fx, 'git', [
    '#!/bin/sh',
    '"$REAL_GIT" "$@"; st=$?',
    'if [ "$1" = merge-base ] && [ "$(pwd -P)" = "$RACE_COPY" ] && [ ! -e "$RACE_FLAG" ]; then',
    '  : > "$RACE_FLAG"',
    '  echo late > late.txt',
    '  "$REAL_GIT" add late.txt',
    '  "$REAL_GIT" -c user.email=t@example.com -c user.name=T commit -q -m late',
    'fi',
    'exit $st',
    '',
  ].join('\n'));
  const env = { REAL_GIT: realGit, RACE_COPY: fs.realpathSync(fx.merged), RACE_FLAG: path.join(fx.base, 'raced') };

  const result = withPath(bin, env, () => tidyMemberCopies(fx.repo, { noFetch: true }));
  assert.ok(fs.existsSync(env.RACE_FLAG), 'the late commit landed');
  const row = byName(result, fx.merged);
  assert.equal(row.action, 'kept', formatTidy(result));
  assert.match(row.reason, /new commit arrived after the check/);
  assert.ok(fs.existsSync(path.join(fx.merged, 'late.txt')));
  const branchTip = runGit(['rev-parse', 'refs/heads/codex/architect-merged-20261001-000000'], fx.repo);
  assert.equal(runGit(['log', '-1', '--format=%s', branchTip], fx.repo), 'late');
});
