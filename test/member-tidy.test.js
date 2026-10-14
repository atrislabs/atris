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
