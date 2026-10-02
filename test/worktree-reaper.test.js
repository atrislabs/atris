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
  git(root, ['add', 'README.md']);
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

test('lock reasons: Claude Code agent locks name their owner pid and start time', () => {
  const parsed = reaper.parseLockReason('claude agent agent-a2f9ac607e775e821 (pid 39829 start Thu Oct  1 09:34:10 2026)');
  assert.equal(parsed.pid, 39829);
  assert.equal(parsed.start, 'Thu Oct 1 09:34:10 2026');
  assert.equal(reaper.parseLockReason('night shift live run (pid 123)').pid, 123);
  assert.equal(reaper.parseLockReason('Active vault live verification').pid, null);

  assert.deepEqual(reaper.lockState(undefined), { locked: false });
  assert.equal(reaper.lockState('kept by hand').live, true);
  assert.equal(reaper.lockState(true).live, true);
  assert.equal(reaper.lockState('claude agent x (pid 5 start y)', { isAlive: () => false }).live, false);
  assert.equal(reaper.lockState('claude agent x (pid 5 start y)', { isAlive: () => true }).live, true);
  assert.equal(reaper.pidAlive(process.pid), true);
  assert.equal(reaper.pidAlive(process.pid, { start: 'Mon Jan  1 00:00:00 1990' }), false);
});

test('a copy locked by an agent that has exited is put away; live and hand locks are kept', () => {
  const arena = makeArena();
  try {
    const root = makeRepo(arena);
    const dead = addCopy(root, arena, 'dead-agent');
    const live = addCopy(root, arena, 'live-agent');
    const hand = addCopy(root, arena, 'hand-lock');
    git(root, ['worktree', 'lock', '--reason', 'claude agent agent-dead (pid 999999 start Thu Oct  1 09:34:10 2026)', dead.path]);
    git(root, ['worktree', 'lock', '--reason', `claude agent agent-live (pid ${process.pid})`, live.path]);
    git(root, ['worktree', 'lock', '--reason', 'Active review, keep', hand.path]);

    const result = cleanupWorktrees({ root, base: 'origin/master', apply: true, activeCwds: [] });
    assert.deepEqual(result.removed.map((row) => path.basename(row.path)), ['dead-agent']);
    assert.equal(fs.existsSync(dead.path), false);
    const reasons = Object.fromEntries(result.kept.map((row) => [path.basename(row.path), row.reason]));
    assert.equal(reasons['live-agent'], 'locked_by_live_agent');
    assert.equal(reasons['hand-lock'], 'locked');
    // Branches are never deleted.
    assert.ok(git(root, ['rev-parse', '--verify', 'refs/heads/dead-agent']));
  } finally {
    fs.rmSync(arena, { recursive: true, force: true });
  }
});

test('a squash-merged PR counts as landed only when every commit is on GitHub', () => {
  const arena = makeArena();
  try {
    const root = makeRepo(arena);
    const squashed = addCopy(root, arena, 'squashed', { commit: true, push: true });
    const open = addCopy(root, arena, 'still-open', { commit: true, push: true });
    const unpushed = addCopy(root, arena, 'unpushed', { commit: true });
    const closed = addCopy(root, arena, 'closed', { commit: true, push: true });
    const prLookup = lookupReturning({
      squashed: { state: 'merged', prs: [{ number: 7, state: 'MERGED', headRefOid: squashed.head }] },
      'still-open': { state: 'open', prs: [{ number: 8, state: 'OPEN', headRefOid: open.head }] },
      unpushed: { state: 'merged', prs: [{ number: 9, state: 'MERGED', headRefOid: 'f'.repeat(40) }] },
      closed: { state: 'closed', prs: [{ number: 10, state: 'CLOSED', headRefOid: closed.head }] },
    });

    const dry = cleanupWorktrees({ root, base: 'origin/master', activeCwds: [], prLookup });
    const verdicts = Object.fromEntries([
      ...dry.candidates.map((row) => [path.basename(row.path), row.reason]),
      ...dry.kept.map((row) => [path.basename(row.path), `keep:${row.reason}`]),
    ]);
    assert.equal(verdicts.squashed, 'pr_merged');
    assert.equal(verdicts.closed, 'pr_closed');
    assert.equal(verdicts['still-open'], 'keep:unmerged');
    assert.equal(verdicts.unpushed, 'keep:unmerged');
    assert.match(dry.kept.find((row) => row.path === unpushed.path).detail, /not on GitHub/);
    assert.equal(fs.existsSync(squashed.path), true, 'dry run removes nothing');
  } finally {
    fs.rmSync(arena, { recursive: true, force: true });
  }
});

test('the PR head proves the push even after the remote branch was deleted', () => {
  const arena = makeArena();
  try {
    const root = makeRepo(arena);
    const copy = addCopy(root, arena, 'deleted-remote', { commit: true, push: true });
    git(root, ['push', '-q', 'origin', '--delete', 'deleted-remote']);
    git(root, ['fetch', '-q', '--prune', 'origin']);
    const prLookup = lookupReturning({
      'deleted-remote': { state: 'merged', prs: [{ number: 11, state: 'MERGED', headRefOid: copy.head }] },
    });
    const result = cleanupWorktrees({ root, base: 'origin/master', apply: true, activeCwds: [], prLookup });
    assert.deepEqual(result.removed.map((row) => row.reason), ['pr_merged']);
  } finally {
    fs.rmSync(arena, { recursive: true, force: true });
  }
});

test('a copy with a file open inside it, uncommitted tracked edits, or unlanded detached work is kept', () => {
  const arena = makeArena();
  try {
    const root = makeRepo(arena);
    const busy = addCopy(root, arena, 'busy');
    const edited = addCopy(root, arena, 'edited');
    fs.writeFileSync(path.join(edited.path, 'README.md'), 'changed\n');
    backdate(edited.path);
    const detached = path.join(arena, '.agent-worktrees', 'repo', 'detached');
    git(root, ['worktree', 'add', '-q', '--detach', detached, 'origin/master']);
    fs.writeFileSync(path.join(detached, 'note.txt'), 'x\n');
    git(detached, ['add', 'note.txt']);
    git(detached, ['commit', '-qm', 'detached work']);
    const output = path.join(detached, '.codex-last-message.txt');
    fs.writeFileSync(output, 'done\n');
    backdate(output);
    backdate(detached);

    const result = cleanupWorktrees({
      root,
      base: 'origin/master',
      apply: true,
      activeCwds: [path.join(busy.path, 'README.md')],
      prLookup: lookupReturning({}),
    });
    assert.equal(result.removed.length, 0);
    const reasons = Object.fromEntries(result.kept.map((row) => [path.basename(row.path), row.reason]));
    assert.equal(reasons.busy, 'active_process');
    assert.equal(reasons.edited, 'dirty');
    assert.equal(reasons.detached, 'unmerged');
    assert.equal(fs.existsSync(detached), true);
  } finally {
    fs.rmSync(arena, { recursive: true, force: true });
  }
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
    assert.equal(fs.existsSync(finished.path), true);

    const applied = reaper.reapArena({ arena, apply: true, openPaths: [], prLookup: lookupReturning({}) });
    assert.equal(applied.removed, 1);
    assert.equal(fs.existsSync(finished.path), false);
    assert.equal(fs.existsSync(outside), true);
  } finally {
    fs.rmSync(arena, { recursive: true, force: true });
  }
});

test('disk room: plenty of space does nothing, low space sweeps first, still too low refuses', () => {
  const GB = reaper.GB;
  let sweeps = 0;
  const reap = () => { sweeps += 1; return { removed: 2 }; };

  const plenty = reaper.ensureDiskRoom({ force: true, free: () => 40 * GB, reap });
  assert.equal(plenty.ok, true);
  assert.equal(sweeps, 0);

  const readings = [10 * GB, 20 * GB];
  const recovered = reaper.ensureDiskRoom({ force: true, free: () => readings.shift(), reap });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.reaped, 2);
  assert.equal(sweeps, 1);

  const refused = reaper.ensureDiskRoom({ force: true, free: () => 3 * GB, reap });
  assert.equal(refused.ok, false);
  assert.match(refused.message, /only 3\.0 GB of disk is free/);
  assert.equal(sweeps, 2);

  // Inside a test run the guard never sweeps the real arena unless forced.
  const skipped = reaper.ensureDiskRoom({ free: () => 1 * GB, reap });
  assert.equal(skipped.skipped, true);
  assert.equal(sweeps, 2);
});

test('after a landing the copy is put away at once, even inside the fresh-copy hour', () => {
  const arena = makeArena();
  try {
    const root = makeRepo(arena);
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
  } finally {
    fs.rmSync(arena, { recursive: true, force: true });
  }
});

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
