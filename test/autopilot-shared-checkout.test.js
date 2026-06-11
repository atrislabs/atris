const { test } = require('node:test');
const assert = require('node:assert');

const { buildPrompt } = require('../commands/autopilot');

// T35a (endgame loop-self-repair): lesson 39 — a concurrent tick's `git reset`
// destroyed a sibling repo's uncommitted work. The do-phase prompt must carry
// the shared-checkout git-safety contract (COORDINATION.md Rule 4): sibling-repo
// edits ride per-tick worktrees, destructive git on the shared checkout is
// forbidden. The benchmark do prompt never commits, so it stays contract-free.

const WORKTREE_INSTRUCTION = /atris worktree start[\s\S]*atris worktree ship/;
const FORBIDDEN_COMMANDS = ['git reset', 'git checkout --', 'git clean', 'stash'];

function assertContract(prompt, variant) {
  assert.match(
    prompt,
    WORKTREE_INSTRUCTION,
    `${variant} do prompt must route sibling-repo edits through atris worktree start/ship`
  );
  assert.match(
    prompt,
    /COORDINATION\.md Rule 4/,
    `${variant} do prompt must cite COORDINATION.md Rule 4`
  );
  for (const cmd of FORBIDDEN_COMMANDS) {
    assert.ok(
      prompt.includes(cmd),
      `${variant} do prompt must forbid "${cmd}" on the shared checkout`
    );
  }
}

test('default executor do prompt carries the shared-checkout git contract', () => {
  const prompt = buildPrompt('do', { task: 'fixture task', kind: 'endgame' });
  assertContract(prompt, 'default executor');
});

test('self-heal do prompt carries the shared-checkout git contract', () => {
  const prompt = buildPrompt(
    'do',
    { task: 'fixture self-heal', kind: 'self-heal' },
    {}
  );
  assertContract(prompt, 'self-heal');
});

test('benchmark do prompt stays contract-free (it never commits)', () => {
  const prompt = buildPrompt(
    'do',
    { task: 'fixture benchmark', kind: 'benchmark' },
    { benchmarkStrategy: 'single' }
  );
  assert.doesNotMatch(
    prompt,
    WORKTREE_INSTRUCTION,
    'benchmark do prompt must not instruct worktree usage — it never commits'
  );
  assert.ok(
    !prompt.includes('git reset'),
    'benchmark do prompt must not carry the destructive-git rule'
  );
});
