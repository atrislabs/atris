'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { cleanupWorktrees, reapLandedWorktree } = require('../commands/worktree');
const reaper = require('../lib/worktree-reaper');
const { putAwayLandedWorktrees } = require('../lib/fleet');

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr || result.stdout}`);
  return String(result.stdout || '').trim();
}

function backdate(target, hours = 2) {
  const stamp = new Date(Date.now() - hours * 60 * 60 * 1000);
  fs.utimesSync(target, stamp, stamp);
}

// arena/<name> with an origin remote (a bare repo), master pushed.
function makeArena() {
  const arena = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-reaper-')));
  return arena;
}

function makeRepo(arena, name = 'repo') {
  const root = path.join(arena, name);
  const bare = path.join(arena, `${name}.remote.git`);
  fs.mkdirSync(root, { recursive: true });
  git(arena, ['init', '-q', '--bare', bare]);
  git(root, ['init', '-q', '-b', 'master']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test User']);
  fs.writeFileSync(path.join(root, 'README.md'), 'hello\n');
  fs.writeFileSync(path.join(root, '.gitignore'), '.derivedData/\n*.env\n');
  git(root, ['add', 'README.md', '.gitignore']);
  git(root, ['commit', '-qm', 'init']);
  git(root, ['remote', 'add', 'origin', bare]);
  git(root, ['push', '-q', 'origin', 'master']);
  git(root, ['fetch', '-q', 'origin']);
  return root;
}

function addCopy(root, arena, name, { commit = false, push = false } = {}) {
  const wt = path.join(arena, '.agent-worktrees', path.basename(root), name);
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  git(root, ['worktree', 'add', '-q', '-b', name, wt, 'origin/master']);
  let head = git(wt, ['rev-parse', 'HEAD']);
  if (commit) {
    fs.writeFileSync(path.join(wt, `${name}.txt`), `${name}\n`);
    git(wt, ['add', `${name}.txt`]);
    git(wt, ['commit', '-qm', `work on ${name}`]);
    head = git(wt, ['rev-parse', 'HEAD']);
  }
  if (push) git(wt, ['push', '-q', 'origin', name]);
  backdate(wt);
  return { path: wt, head };
}

function lookupReturning(answers) {
  return (_root, branch) => answers[branch] || { state: 'none', prs: [] };
}

// The real commands, except where a test makes one fail.
function runnerWith(override) {
  return (cmd, args, options = {}) => {
    const faked = override(cmd, args, options);
    if (faked) return faked;
    return spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
  };
}

const merged = (head, number = 7) => ({ state: 'merged', prs: [{ number, state: 'MERGED', headRefOid: head }] });

function withArena(fn) {
  const arena = makeArena();
  try {
    return fn(arena, makeRepo(arena));
  } finally {
    fs.rmSync(arena, { recursive: true, force: true });
  }
}

test('lock reasons name their owner pid and start time; a lock is stale only with proof', () => {
  const parsed = reaper.parseLockReason('claude agent agent-a2f9ac607e775e821 (pid 39829 start Thu Oct  1 09:34:10 2026)');
  assert.equal(parsed.pid, 39829);
  assert.equal(parsed.start, 'Thu Oct 1 09:34:10 2026');
  assert.equal(reaper.parseLockReason('night shift live run (pid 123 start x)').pid, 123);
  assert.equal(reaper.parseLockReason('Active vault live verification').pid, null);

  assert.equal(reaper.ownerLife({ pid: process.pid, start: '' }), 'alive');
  assert.equal(reaper.ownerLife({ pid: process.pid, start: 'Mon Jan 1 00:00:00 1990' }), 'dead');
  assert.equal(reaper.ownerLife({ pid: 99999999, start: '' }), 'dead');
  const psFails = runnerWith((cmd) => (cmd === 'ps' ? { status: 1, stdout: '', stderr: 'no' } : null));
  assert.equal(reaper.ownerLife({ pid: process.pid, start: 'x' }, { runner: psFails }), 'unknown');
});

test('copies proven finished are put away, with the branch kept', () => withArena((arena, root) => {
  const inMain = addCopy(root, arena, 'in-main', { commit: true });
  git(inMain.path, ['push', '-q', 'origin', 'HEAD:master']);
  backdate(inMain.path);
  const squashed = addCopy(root, arena, 'squashed', { commit: true, push: true });
  const closed = addCopy(root, arena, 'closed', { commit: true, push: true });
  const deadLock = addCopy(root, arena, 'dead-agent');
  git(root, ['worktree', 'lock', '--reason', 'claude agent agent-dead (pid 99999999 start Thu Oct  1 09:34:10 2026)', deadLock.path]);
  const reused = addCopy(root, arena, 'reused-pid');
  git(root, ['worktree', 'lock', '--reason', `night shift live run (pid ${process.pid} start Mon Jan  1 00:00:00 1990)`, reused.path]);
  const junk = addCopy(root, arena, 'junk-only');
  fs.mkdirSync(path.join(junk.path, '__pycache__'));
  fs.writeFileSync(path.join(junk.path, '__pycache__', 'a.pyc'), 'x');
  fs.writeFileSync(path.join(junk.path, '.DS_Store'), 'x');
  fs.mkdirSync(path.join(junk.path, '.atris', 'cache'), { recursive: true });
  fs.writeFileSync(path.join(junk.path, '.atris', 'cache', '.gitignore'), '*\n');
  fs.writeFileSync(path.join(junk.path, '.atris', 'cache', 'map-refs.json'), '{}\n');
  backdate(junk.path);
  const prLookup = lookupReturning({
    squashed: merged(squashed.head),
    closed: { state: 'closed', prs: [{ number: 10, state: 'CLOSED', headRefOid: closed.head }] },
  });

  const result = cleanupWorktrees({ root, base: 'origin/master', apply: true, activeCwds: [], prLookup });

  const reasons = Object.fromEntries(result.removed.map((row) => [path.basename(row.path), row.reason]));
  assert.deepEqual(reasons, {
    'in-main': 'merged_into_base',
    squashed: 'pr_merged',
    closed: 'pr_closed',
    'dead-agent': 'merged_into_base',
    'reused-pid': 'merged_into_base',
    'junk-only': 'merged_into_base',
  }, JSON.stringify(result.kept));
  for (const copy of [inMain, squashed, closed, deadLock, reused, junk]) assert.equal(fs.existsSync(copy.path), false);
  assert.ok(git(root, ['rev-parse', '--verify', 'refs/heads/squashed']), 'branches are never deleted');
}));

// One row per finding from the review of this change. Each copy would have
// been deleted before; now each is kept, with the reason.
const KEEP_CASES = [
  {
    finding: '1: open files could not be listed',
    setup: (arena, root) => ({ copy: addCopy(root, arena, 'lsof-failed'), activeCwds: undefined,
      runner: runnerWith((cmd) => (cmd === 'lsof' ? { status: 1, stdout: '', stderr: 'lsof: no' } : null)) }),
    reason: 'open_files_unknown',
  },
  {
    finding: '1: open files listing came back partial',
    setup: (arena, root) => ({ copy: addCopy(root, arena, 'lsof-partial'), activeCwds: undefined,
      runner: runnerWith((cmd) => (cmd === 'lsof' ? { status: 0, stdout: 'n/garbage\n', stderr: '' } : null)) }),
    reason: 'open_files_unknown',
  },
  {
    finding: 'r2-6: lsof listed one process and warned it could not see the rest',
    setup: (arena, root) => ({ copy: addCopy(root, arena, 'lsof-p123'), activeCwds: undefined,
      runner: runnerWith((cmd) => (cmd === 'lsof'
        ? { status: 0, stdout: 'p123\n', stderr: 'lsof: WARNING: can\'t stat() some file systems; information may be incomplete.\n' }
        : null)) }),
    reason: 'open_files_unknown',
  },
  {
    finding: 'r2-6: lsof output was cut off mid-record',
    setup: (arena, root) => ({ copy: addCopy(root, arena, 'lsof-cut'), activeCwds: undefined,
      runner: runnerWith((cmd) => (cmd === 'lsof' ? { status: 0, stdout: 'p123\nfcwd\nn/Users/some', stderr: '' } : null)) }),
    reason: 'open_files_unknown',
  },
  {
    finding: 'r2-2: an unknown file inside atris\'s cache folder',
    setup: (arena, root) => {
      const copy = addCopy(root, arena, 'cache-patch');
      fs.mkdirSync(path.join(copy.path, '.atris', 'cache'), { recursive: true });
      fs.writeFileSync(path.join(copy.path, '.atris', 'cache', 'map-refs.json'), '{}\n');
      fs.writeFileSync(path.join(copy.path, '.atris', 'cache', 'recovery.patch'), 'the only copy of a fix\n');
      backdate(copy.path);
      return { copy, after: () => assert.equal(fs.existsSync(path.join(copy.path, '.atris', 'cache', 'recovery.patch')), true) };
    },
    reason: 'untracked_files',
  },
  {
    finding: 'r2-3: an edit hidden by assume-unchanged',
    setup: (arena, root) => {
      const copy = addCopy(root, arena, 'assume-unchanged');
      git(copy.path, ['update-index', '--assume-unchanged', 'README.md']);
      fs.writeFileSync(path.join(copy.path, 'README.md'), 'edited and hidden\n');
      backdate(copy.path);
      return { copy, after: () => assert.equal(fs.readFileSync(path.join(copy.path, 'README.md'), 'utf8'), 'edited and hidden\n') };
    },
    reason: 'hidden_changes',
  },
  {
    finding: 'r2-3: an edit hidden by skip-worktree',
    setup: (arena, root) => {
      const copy = addCopy(root, arena, 'skip-worktree');
      git(copy.path, ['update-index', '--skip-worktree', 'README.md']);
      fs.writeFileSync(path.join(copy.path, 'README.md'), 'edited and hidden\n');
      backdate(copy.path);
      return { copy };
    },
    reason: 'hidden_changes',
  },
  {
    finding: 'r2-3: a copy with a submodule git is told to ignore',
    setup: (arena, root) => {
      const copy = addCopy(root, arena, 'submodule');
      git(copy.path, ['update-index', '--add', '--cacheinfo', `160000,${copy.head},vendor/lib`]);
      git(copy.path, ['commit', '-qm', 'add submodule']);
      git(copy.path, ['push', '-q', 'origin', 'HEAD:master']);
      // Told to ignore submodules, git status shows nothing at all.
      git(copy.path, ['config', 'diff.ignoreSubmodules', 'all']);
      assert.equal(git(copy.path, ['status', '--porcelain']), '');
      backdate(copy.path);
      return { copy };
    },
    reason: 'has_submodule',
  },
  {
    finding: 'r2-4: an unpushed commit only in this copy\'s HEAD history',
    setup: (arena, root) => {
      const copy = addCopy(root, arena, 'reflog-only');
      git(copy.path, ['checkout', '-q', '--detach']);
      fs.writeFileSync(path.join(copy.path, 'lost.txt'), 'x\n');
      git(copy.path, ['add', 'lost.txt']);
      git(copy.path, ['commit', '-qm', 'detached work']);
      git(copy.path, ['checkout', '-q', 'origin/master']);
      backdate(copy.path);
      return { copy };
    },
    reason: 'history_not_on_github',
  },
  {
    finding: 'r2-4: an unpushed commit held only by this copy\'s own ref',
    setup: (arena, root) => {
      const copy = addCopy(root, arena, 'worktree-ref');
      const blob = git(copy.path, ['commit-tree', '-m', 'kept by a per-copy ref', `${copy.head}^{tree}`]);
      git(copy.path, ['update-ref', 'refs/worktree/keep', blob]);
      backdate(copy.path);
      return { copy };
    },
    reason: 'history_not_on_github',
  },
  {
    finding: '1: a file is open inside',
    setup: (arena, root) => {
      const copy = addCopy(root, arena, 'busy');
      return { copy, activeCwds: [path.join(copy.path, 'README.md')] };
    },
    reason: 'active_process',
  },
  {
    finding: '6: the lock owner is alive but its start time cannot be read',
    setup: (arena, root) => {
      const copy = addCopy(root, arena, 'owner-unknown');
      git(root, ['worktree', 'lock', '--reason', `claude agent a (pid ${process.pid} start Thu Oct  1 09:34:10 2026)`, copy.path]);
      return { copy, runner: runnerWith((cmd) => (cmd === 'ps' ? { status: 1, stdout: '' } : null)) };
    },
    reason: 'lock_owner_unknown',
  },
  {
    finding: '6: a live agent lock and a hand lock',
    setup: (arena, root) => {
      const copy = addCopy(root, arena, 'live-agent');
      git(root, ['worktree', 'lock', '--reason', `claude agent a (pid ${process.pid})`, copy.path]);
      return { copy };
    },
    reason: 'locked_by_live_agent',
  },
  {
    finding: '6: the lock changed between the check and the removal',
    setup: (arena, root) => {
      const copy = addCopy(root, arena, 'lock-changed');
      git(root, ['worktree', 'lock', '--reason', 'claude agent a (pid 99999998 start Thu Oct  1 09:34:10 2026)', copy.path]);
      const beforeRemove = () => {
        git(root, ['worktree', 'unlock', copy.path]);
        git(root, ['worktree', 'lock', '--reason', 'claude agent b (pid 99999997 start Fri Oct  2 01:00:00 2026)', copy.path]);
      };
      return { copy, beforeRemove, after: () => assert.match(git(root, ['worktree', 'list', '--porcelain']), /agent b \(pid 99999997/) };
    },
    reason: 'lock_changed',
  },
  {
    finding: '2: a merged copy holding only the agent output file',
    setup: (arena, root) => {
      const copy = addCopy(root, arena, 'agent-output');
      fs.writeFileSync(path.join(copy.path, '.codex-last-message.txt'), 'finished\n');
      backdate(copy.path);
      return { copy };
    },
    reason: 'untracked_files',
  },
  {
    finding: 'atris files outside its cache folder are kept',
    setup: (arena, root) => {
      const copy = addCopy(root, arena, 'atris-notes');
      fs.mkdirSync(path.join(copy.path, '.atris', 'cache'), { recursive: true });
      fs.writeFileSync(path.join(copy.path, '.atris', 'cache', 'map-refs.json'), '{}\n');
      fs.writeFileSync(path.join(copy.path, '.atris', 'notes.md'), 'agent notes\n');
      fs.mkdirSync(path.join(copy.path, 'sub', '.atris', 'cache'), { recursive: true });
      fs.writeFileSync(path.join(copy.path, 'sub', '.atris', 'cache', 'x.json'), '{}\n');
      backdate(copy.path);
      return { copy };
    },
    reason: 'untracked_files',
  },
  {
    finding: '2: a staged change',
    setup: (arena, root) => {
      const copy = addCopy(root, arena, 'staged');
      fs.writeFileSync(path.join(copy.path, 'new.txt'), 'x\n');
      git(copy.path, ['add', 'new.txt']);
      backdate(copy.path);
      return { copy };
    },
    reason: 'uncommitted_changes',
  },
  {
    finding: '3: an ignored file that is not a cache, and its cache is left in place',
    setup: (arena, root) => {
      const copy = addCopy(root, arena, 'ignored-work');
      fs.writeFileSync(path.join(copy.path, 'keys.env'), 'SECRET=1\n');
      fs.mkdirSync(path.join(copy.path, '.derivedData'));
      fs.writeFileSync(path.join(copy.path, '.derivedData', 'cache.bin'), 'x');
      backdate(copy.path);
      return { copy, after: () => assert.equal(fs.existsSync(path.join(copy.path, '.derivedData', 'cache.bin')), true) };
    },
    reason: 'ignored_files',
  },
  {
    finding: '4: a finished copy outside the launcher folders',
    setup: (arena, root) => {
      const outside = path.join(arena, 'repo-hand-made');
      git(root, ['worktree', 'add', '-q', '-b', 'hand-made', outside, 'origin/master']);
      backdate(outside);
      return { copy: { path: outside } };
    },
    reason: 'not_agent_copy',
  },
  {
    finding: '4: a copy reached through a link',
    setup: (arena, root) => {
      const real = path.join(arena, 'elsewhere');
      fs.mkdirSync(real);
      fs.mkdirSync(path.join(arena, '.agent-worktrees'), { recursive: true });
      fs.symlinkSync(real, path.join(arena, '.agent-worktrees', 'repo'));
      const linked = path.join(arena, '.agent-worktrees', 'repo', 'via-link');
      git(root, ['worktree', 'add', '-q', '-b', 'via-link', linked, 'origin/master']);
      backdate(path.join(real, 'via-link'));
      return { copy: { path: linked }, reasonIn: ['symlinked_path', 'not_agent_copy'] };
    },
    reason: 'symlinked_path',
  },
  {
    finding: '5: the remote branch was deleted, even though the PR head matches',
    setup: (arena, root) => {
      const copy = addCopy(root, arena, 'deleted-remote', { commit: true, push: true });
      git(root, ['push', '-q', 'origin', '--delete', 'deleted-remote']);
      git(root, ['fetch', '-q', '--prune', 'origin']);
      return { copy, prLookup: lookupReturning({ 'deleted-remote': merged(copy.head, 11) }) };
    },
    reason: 'not_on_github',
  },
  {
    finding: '5: the same change is in main under another commit, but this commit was never pushed',
    setup: (arena, root) => {
      const copy = addCopy(root, arena, 'cherry', { commit: true });
      fs.writeFileSync(path.join(root, 'other.txt'), 'main moved on\n');
      git(root, ['add', 'other.txt']);
      git(root, ['commit', '-qm', 'main moved on']);
      git(root, ['cherry-pick', copy.head]);
      git(root, ['push', '-q', 'origin', 'master']);
      return { copy };
    },
    reason: 'not_on_github',
  },
  {
    finding: '7: GitHub did not answer about the PR',
    setup: (arena, root) => ({ copy: addCopy(root, arena, 'gh-down', { commit: true, push: true }),
      prLookup: () => ({ state: 'unknown', prs: [] }) }),
    reason: 'pr_unknown',
  },
  {
    finding: '7: the PR lookup crashed',
    setup: (arena, root) => ({ copy: addCopy(root, arena, 'gh-crash', { commit: true, push: true }),
      prLookup: () => { throw new Error('boom'); } }),
    reason: 'pr_unknown',
  },
  {
    finding: '7: an agent finished hours ago but its work never landed',
    setup: (arena, root) => {
      const copy = addCopy(root, arena, 'finished-unlanded', { commit: true, push: true });
      const output = path.join(copy.path, '.codex-last-message.txt');
      fs.writeFileSync(output, 'done\n');
      git(copy.path, ['add', '.codex-last-message.txt']);
      git(copy.path, ['commit', '-qm', 'output']);
      git(copy.path, ['push', '-q', 'origin', 'finished-unlanded']);
      backdate(output, 5);
      backdate(copy.path, 5);
      return { copy };
    },
    reason: 'unmerged',
  },
  {
    finding: '9: git status timed out',
    setup: (arena, root) => ({ copy: addCopy(root, arena, 'status-timeout'),
      runner: runnerWith((cmd, args) => (cmd === 'git' && args[0] === 'status'
        ? { status: null, signal: 'SIGTERM', error: Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT' }), stdout: '' }
        : null)) }),
    reason: 'check_failed',
  },
  {
    finding: '9: the sweep ran out of time',
    setup: (arena, root) => {
      const copy = addCopy(root, arena, 'late');
      const deadline = Date.now() + 1500;
      // The clock runs out while git status is running.
      const runner = runnerWith((cmd, args) => {
        if (cmd === 'git' && args[0] === 'status') while (Date.now() <= deadline) { /* wait */ }
        return null;
      });
      return { copy, deadline, runner };
    },
    reason: 'out_of_time',
  },
];

for (const row of KEEP_CASES) {
  test(`keeps, finding ${row.finding}`, () => withArena((arena, root) => {
    const setup = row.setup(arena, root);
    const options = {
      root,
      base: 'origin/master',
      apply: true,
      activeCwds: [],
      prLookup: lookupReturning({}),
      ...setup,
    };
    delete options.copy;
    delete options.after;
    delete options.reasonIn;
    if ('activeCwds' in setup && setup.activeCwds === undefined) delete options.activeCwds;
    const result = cleanupWorktrees(options);
    assert.equal(result.removed.length, 0, JSON.stringify(result.removed));
    assert.equal(fs.existsSync(setup.copy.path), true);
    const kept = result.kept.find((item) => path.basename(item.path) === path.basename(setup.copy.path));
    assert.ok(kept, JSON.stringify(result.kept));
    if (setup.reasonIn) assert.ok(setup.reasonIn.includes(kept.reason), kept.reason);
    else assert.equal(kept.reason, row.reason, JSON.stringify(kept));
    if (setup.after) setup.after();
  }));
}

test('r2-1: a file written just before removal survives, and the stale lock is put back', () => withArena((arena, root) => {
  const copy = addCopy(root, arena, 'late-write');
  fs.mkdirSync(path.join(copy.path, '__pycache__'));
  fs.writeFileSync(path.join(copy.path, '__pycache__', 'a.pyc'), 'x');
  const lock = 'claude agent a (pid 99999996 start Thu Oct  1 09:34:10 2026)';
  git(root, ['worktree', 'lock', '--reason', lock, copy.path]);
  backdate(copy.path);
  // An agent writes real work after the last check, as git is asked to remove.
  const runner = runnerWith((cmd, args) => {
    if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'remove') {
      fs.writeFileSync(path.join(copy.path, 'fix.py'), 'the work\n');
    }
    return null;
  });
  const result = cleanupWorktrees({ root, base: 'origin/master', apply: true, activeCwds: [], prLookup: lookupReturning({}), runner });
  assert.equal(result.removed.length, 0);
  assert.equal(fs.readFileSync(path.join(copy.path, 'fix.py'), 'utf8'), 'the work\n');
  assert.equal(result.kept[0].reason, 'remove_failed');
  assert.match(git(root, ['worktree', 'list', '--porcelain']), /locked claude agent a \(pid 99999996/);
}));

test('r2-6: a lock that changes after the last file check is never unlocked', () => withArena((arena, root) => {
  const copy = addCopy(root, arena, 'relocked');
  git(root, ['worktree', 'lock', '--reason', 'claude agent a (pid 99999996 start Thu Oct  1 09:34:10 2026)', copy.path]);
  backdate(copy.path);
  let flagChecks = 0;
  const runner = runnerWith((cmd, args) => {
    // The third hidden-flag check is the last one before unlocking.
    if (cmd === 'git' && args[0] === 'ls-files' && args[1] === '-v' && ++flagChecks === 3) {
      git(root, ['worktree', 'unlock', copy.path]);
      git(root, ['worktree', 'lock', '--reason', 'claude agent b (pid 99999995 start Fri Oct  2 01:00:00 2026)', copy.path]);
    }
    return null;
  });
  const result = cleanupWorktrees({ root, base: 'origin/master', apply: true, activeCwds: [], prLookup: lookupReturning({}), runner });
  assert.equal(result.removed.length, 0);
  assert.equal(result.kept[0].reason, 'lock_changed');
  assert.equal(fs.existsSync(copy.path), true);
  assert.match(git(root, ['worktree', 'list', '--porcelain']), /agent b \(pid 99999995/);
}));

test('r2-5: putting one copy away never prunes the records of another', () => withArena((arena, root) => {
  addCopy(root, arena, 'finished');
  const moved = addCopy(root, arena, 'moved-away');
  const elsewhere = path.join(arena, 'parked');
  fs.renameSync(moved.path, elsewhere);
  const result = cleanupWorktrees({ root, base: 'origin/master', apply: true, activeCwds: [], prLookup: lookupReturning({}) });
  assert.deepEqual(result.removed.map((row) => path.basename(row.path)), ['finished']);
  assert.match(git(root, ['worktree', 'list', '--porcelain']), /moved-away/);
}));

test('no removal path passes --force or prunes the whole repo', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'worktree-reaper.js'), 'utf8');
  assert.doesNotMatch(source, /'--force'/);
  assert.doesNotMatch(source, /'worktree', 'prune'/);
});

test('keeps, finding 4: the main checkout and folders git does not know about', () => withArena((arena, root) => {
  const stray = path.join(arena, '.agent-worktrees', 'repo', 'stray');
  fs.mkdirSync(stray, { recursive: true });
  fs.writeFileSync(path.join(stray, '.git'), 'gitdir: /nowhere\n');
  const ctx = { repo: root, defaultRef: 'origin/master', openPaths: [], prLookup: lookupReturning({}) };
  assert.equal(reaper.provablySafeToRemove(root, ctx).reason, 'primary_checkout');
  assert.equal(reaper.provablySafeToRemove(stray, ctx).reason, 'not_linked_worktree');
  assert.equal(reaper.provablySafeToRemove(path.join(arena, 'gone'), ctx).reason, 'missing_or_unreadable');
  assert.equal(fs.existsSync(path.join(stray, '.git')), true);
}));

test('finding 8: atris worktree room keeps the 5 GB refusal line when --refuse is absent', () => withArena((arena, root) => {
  const { worktreeCommand } = require('../commands/worktree');
  const saved = process.env.ATRIS_DISK_REFUSE_GB;
  const quiet = { log: console.log, error: console.error };
  console.log = () => {};
  console.error = () => {};
  try {
    process.env.ATRIS_DISK_REFUSE_GB = '100000';
    assert.equal(worktreeCommand(['room', '--need', '100000', '--repo', root]), 3);
    assert.equal(worktreeCommand(['room', '--need', '100000', '--refuse', '0', '--repo', root]), 0);
  } finally {
    console.log = quiet.log;
    console.error = quiet.error;
    if (saved === undefined) delete process.env.ATRIS_DISK_REFUSE_GB;
    else process.env.ATRIS_DISK_REFUSE_GB = saved;
  }
}));

test('finding 9: every git and gh call in a sweep has a time limit', () => withArena((arena, root) => {
  addCopy(root, arena, 'pushed', { commit: true, push: true });
  const seen = [];
  const runner = runnerWith((cmd, args, options) => {
    seen.push({ cmd, args: args.slice(0, 2).join(' '), timeout: options.timeout });
    return null;
  });
  const ghCalls = [];
  const lookup = reaper.createPrLookup({ runner: (cmd, args, options) => { ghCalls.push(options.timeout); return { status: 1 }; } });
  reaper.sweepRepo({ repo: root, apply: false, openPaths: [], runner, prLookup: lookup });
  assert.ok(seen.some((call) => call.args === 'fetch --quiet'), JSON.stringify(seen));
  for (const call of seen) assert.ok(Number.isFinite(call.timeout) && call.timeout > 0, JSON.stringify(call));
  assert.ok(ghCalls.length && ghCalls.every((timeout) => Number.isFinite(timeout) && timeout > 0));
}));

test('finding 9: the low-disk sweep before a launch touches only that repo, for at most a minute', () => {
  const GB = reaper.GB;
  const calls = [];
  const reap = (args) => { calls.push(args); return { removed: 2 }; };

  const plenty = reaper.ensureDiskRoom({ force: true, free: () => 40 * GB, reap, repos: ['/arena/one'] });
  assert.equal(plenty.ok, true);
  assert.equal(calls.length, 0);

  const readings = [10 * GB, 20 * GB];
  const started = Date.now();
  const recovered = reaper.ensureDiskRoom({ force: true, free: () => readings.shift(), reap, repos: ['/arena/one'] });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.reaped, 2);
  assert.deepEqual(calls[0].repos, ['/arena/one']);
  assert.equal(calls[0].arena, undefined);
  assert.ok(calls[0].deadline > started && calls[0].deadline <= Date.now() + 60 * 1000);

  const refused = reaper.ensureDiskRoom({ force: true, free: () => 3 * GB, reap, repos: ['/arena/one'] });
  assert.equal(refused.ok, false);
  assert.match(refused.message, /only 3\.0 GB of disk is free/);

  // No repo named: nothing is swept, the check still refuses.
  const before = calls.length;
  assert.equal(reaper.ensureDiskRoom({ force: true, free: () => 3 * GB, reap }).ok, false);
  assert.equal(calls.length, before);

  // Inside a test run the guard never sweeps unless forced.
  assert.equal(reaper.ensureDiskRoom({ free: () => 1 * GB, reap, repos: ['/arena/one'] }).skipped, true);
});

test('the arena sweep covers every repo, prints sizes, and leaves copies outside agent folders alone', () => {
  const arena = makeArena();
  try {
    const one = makeRepo(arena, 'one');
    const two = makeRepo(arena, 'two');
    const finished = addCopy(one, arena, 'finished');
    addCopy(two, arena, 'in-flight', { commit: true });
    const outside = path.join(arena, 'hand-made-checkout');
    git(two, ['worktree', 'add', '-q', '-b', 'hand-made', outside, 'origin/master']);
    backdate(outside);

    const dry = reaper.reapArena({ arena, openPaths: [], prLookup: lookupReturning({}) });
    assert.deepEqual(dry.repos.map((repo) => path.basename(repo)), ['one', 'two']);
    assert.equal(dry.removable, 1);
    assert.ok(dry.removableBytes > 0);
    const table = reaper.renderReapTable(dry);
    assert.match(table, /PATH\s+SIZE\s+VERDICT\s+REASON/);
    assert.match(table, /would remove 1 of 3 copies/);
    assert.match(table, /outside the agent work folders/);
    assert.match(table, /has commits that are not on GitHub/);
    assert.equal(fs.existsSync(finished.path), true);

    const applied = reaper.reapArena({ arena, apply: true, openPaths: [], prLookup: lookupReturning({}) });
    assert.equal(applied.removed, 1);
    assert.equal(fs.existsSync(finished.path), false);
    assert.equal(fs.existsSync(outside), true);
  } finally {
    fs.rmSync(arena, { recursive: true, force: true });
  }
});

test('after a landing the copy is put away at once, even inside the fresh-copy hour', () => withArena((arena, root) => {
  const wt = path.join(arena, '.agent-worktrees', 'repo', 'just-landed');
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  git(root, ['worktree', 'add', '-q', '-b', 'just-landed', wt, 'origin/master']);
  fs.writeFileSync(path.join(wt, 'feature.txt'), 'feature\n');
  git(wt, ['add', 'feature.txt']);
  git(wt, ['commit', '-qm', 'feature']);
  git(wt, ['push', '-q', 'origin', 'HEAD:master']);

  const swept = cleanupWorktrees({ root, base: 'origin/master', activeCwds: [] });
  assert.equal(swept.kept.find((row) => row.path === wt).reason, 'fresh_worktree_grace');

  const result = reapLandedWorktree(wt, { activeCwds: [] });
  assert.equal(result.removed, true, JSON.stringify(result));
  assert.equal(fs.existsSync(wt), false);
}));

test('a flight puts away only the copies of tasks that landed', () => {
  const calls = [];
  const flight = {
    landed: [{ task: 'T-1' }, { task: 'T-2' }, { task: 'T-3' }],
    paused: [{ task: 'T-2', stage: 'task_ready' }],
  };
  const put = putAwayLandedWorktrees({
    flight,
    worktreeByTask: new Map([['T-1', '/wt/1'], ['T-2', '/wt/2'], ['T-3', '/wt/3']]),
    reap: (wt) => { calls.push(wt); return wt === '/wt/1' ? { removed: true } : { removed: false, reason: 'active_process' }; },
  });
  assert.deepEqual(calls, ['/wt/1', '/wt/3']);
  assert.deepEqual(put, ['/wt/1']);
  assert.deepEqual(flight.worktrees_put_away, ['/wt/1']);
  assert.equal(flight.landed[2].worktree_kept, 'active_process');
});

test('PR lookup asks GitHub once per repo and only per branch when the branch is not in the recent list', () => {
  const calls = [];
  const runner = (_cmd, args) => {
    calls.push(args.includes('--head') ? `head:${args[args.indexOf('--head') + 1]}` : 'recent');
    if (!args.includes('--head')) {
      return { status: 0, stdout: JSON.stringify([
        { number: 1, state: 'MERGED', headRefName: 'done', headRefOid: 'a' },
        { number: 2, state: 'OPEN', headRefName: 'busy', headRefOid: 'b' },
      ]) };
    }
    return { status: 0, stdout: '[]' };
  };
  const lookup = reaper.createPrLookup({ runner });
  assert.equal(lookup('/repo', 'done').state, 'merged');
  assert.equal(lookup('/repo', 'busy').state, 'open');
  assert.equal(lookup('/repo', 'never-opened').state, 'none');
  assert.equal(lookup('/repo', 'never-opened').state, 'none');
  assert.deepEqual(calls, ['recent', 'head:never-opened']);

  const broken = reaper.createPrLookup({ runner: () => ({ status: 1, stderr: 'no network' }) });
  assert.equal(broken('/repo', 'x').state, 'unknown');
});
