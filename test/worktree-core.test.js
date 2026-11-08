const test = require('node:test');
const assert = require('node:assert/strict');
const worktreeCore = require('../lib/worktree-core');
const worktreeCommandModule = require('../commands/worktree');

test('worktree-core exports shared git, flight, cleanup, and sweep helpers', () => {
  assert.equal(typeof worktreeCore.createAgentWorktree, 'function');
  assert.equal(typeof worktreeCore.cleanupWorktrees, 'function');
  assert.equal(typeof worktreeCore.sweepWorkspace, 'function');
  assert.equal(typeof worktreeCore.parseWorktrees, 'function');
  assert.equal(typeof worktreeCore.collidingFlights, 'function');
  assert.equal(worktreeCommandModule.createAgentWorktree, worktreeCore.createAgentWorktree);
  assert.equal(worktreeCommandModule.cleanupWorktrees, worktreeCore.cleanupWorktrees);
});

test('worktree-core parses porcelain worktree output and agent flight branch names', () => {
  const parsed = worktreeCore.parseWorktrees([
    'worktree /tmp/repo',
    'HEAD 0123456789abcdef0123456789abcdef01234567',
    'branch refs/heads/master',
    '',
    'worktree /tmp/wt-1',
    'HEAD 89abcdef0123456789abcdef0123456789abcdef',
    'branch refs/heads/codex/executor-fix-auth-20261108-030000',
    'locked',
    '',
  ].join('\n'));
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].branch, 'master');
  assert.equal(parsed[1].branch, 'codex/executor-fix-auth-20261108-030000');
  assert.equal(parsed[1].locked, true);

  const flight = worktreeCore.parseAgentFlightName('codex/executor-fix-auth-20261108-030000');
  assert.equal(flight.owner, 'executor');
  assert.equal(flight.taskSlug, 'fix-auth');
  assert.equal(worktreeCore.collidingFlights([flight], 'fix-auth').length, 1);
  assert.equal(worktreeCore.collidingFlights([flight], 'fix-auth-login').length, 0);
});
