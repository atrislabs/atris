'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { landFinishedMemberRun } = require('../lib/member-autoland');

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

// A primary checkout with a bare origin, plus the member's own branch in a
// linked checkout carrying one finished commit.
function setup({ policyOn = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-member-autoland-'));
  const origin = path.join(dir, 'origin.git');
  const root = path.join(dir, 'root');
  const worktree = path.join(dir, 'member-work');
  git(['init', '--bare', '-b', 'master', origin], dir);
  git(['clone', origin, root], dir);
  git(['config', 'user.name', 'Test'], root);
  git(['config', 'user.email', 'test@example.com'], root);
  git(['checkout', '-B', 'master'], root);
  fs.writeFileSync(path.join(root, 'README.md'), 'hello\n');
  git(['add', 'README.md'], root);
  git(['commit', '-m', 'initial'], root);
  git(['push', '-u', 'origin', 'master'], root);
  git(['remote', 'set-head', 'origin', 'master'], root);

  fs.mkdirSync(path.join(root, '.atris', 'state'), { recursive: true });
  fs.writeFileSync(path.join(root, '.atris', 'state', 'experiments-daily.json'),
    JSON.stringify({ last_run_date: new Date().toISOString() }));
  // A missing policy file reads as on, so off is always written explicitly.
  fs.mkdirSync(path.join(root, '.atris', 'policy'), { recursive: true });
  fs.writeFileSync(path.join(root, '.atris', 'policy', 'autoland.json'),
    JSON.stringify(policyOn ? { enabled: true, enabled_by: 'operator' } : { enabled: false }));

  git(['worktree', 'add', '-b', 'member/greeting', worktree, 'origin/master'], root);
  fs.writeFileSync(path.join(worktree, 'greeting.txt'), 'hi\n');
  git(['add', 'greeting.txt'], worktree);
  git(['commit', '-m', 'add greeting'], worktree);

  // Stand-in for GitHub: no open PR, create prints a url, merge pushes the
  // rebased branch onto origin master the way a merged PR would.
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), [
    '#!/bin/sh',
    'if [ "$1 $2" = "pr view" ]; then exit 1; fi',
    'if [ "$1 $2" = "pr create" ]; then echo "https://example.test/pr/1"; exit 0; fi',
    'if [ "$1 $2" = "pr merge" ]; then git push -q origin HEAD:refs/heads/master || exit 1; echo "merged"; exit 0; fi',
    'exit 1',
    '',
  ].join('\n'), { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  return { dir, origin, root, worktree, env };
}

function originHasGreeting(ctx) {
  const tree = git(['--git-dir', ctx.origin, 'ls-tree', '--name-only', 'master'], ctx.dir);
  return tree.split('\n').includes('greeting.txt');
}

function mission(ctx, overrides = {}) {
  return {
    status: 'complete',
    owner: 'executor',
    objective: 'add a greeting file',
    lane: 'workspace',
    verifier: 'test -f greeting.txt',
    worktree: { path: ctx.worktree, branch: 'member/greeting' },
    ...overrides,
  };
}

function land(ctx, overrides) {
  const log = console.log;
  console.log = () => {};
  try {
    return landFinishedMemberRun({ root: ctx.root, mission: mission(ctx, overrides), env: ctx.env });
  } finally {
    console.log = log;
  }
}

test('switch off: nothing lands and the run reports nothing new', () => {
  const ctx = setup({ policyOn: false });
  try {
    const result = land(ctx);
    assert.equal(result.attempted, false);
    assert.equal(result.line, '');
    assert.equal(originHasGreeting(ctx), false);
  } finally {
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test('switch on and the check passes: the branch merges into origin master', () => {
  const ctx = setup();
  try {
    // origin moved after the member branched, so the rebase is real.
    fs.writeFileSync(path.join(ctx.root, 'other.txt'), 'x\n');
    git(['add', 'other.txt'], ctx.root);
    git(['commit', '-m', 'someone else landed'], ctx.root);
    git(['push', 'origin', 'master'], ctx.root);

    const result = land(ctx);
    assert.equal(result.landed, true, result.line);
    assert.equal(result.line, 'landed: merged into master after its check passed again');
    assert.equal(originHasGreeting(ctx), true);
    const log = git(['--git-dir', ctx.origin, 'log', '--format=%s', 'master'], ctx.dir).split('\n');
    assert.deepEqual(log.slice(0, 2), ['add greeting', 'someone else landed']);
  } finally {
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test('a protected mission stays on its branch with one plain reason', () => {
  const ctx = setup();
  try {
    const billing = land(ctx, { lane: 'billing' });
    assert.equal(billing.landed, false);
    assert.equal(billing.reason, 'protected_lane');
    assert.equal(billing.line, 'left on its branch: it sits in the protected billing lane, so a human lands it');

    const declared = land(ctx, { objective: 'add a greeting file. human must accept.' });
    assert.equal(declared.reason, 'protected_lane');
    assert.match(declared.line, /human must accept/);

    const sniffed = land(ctx, { objective: 'add a greeting to the stripe receipt' });
    assert.equal(sniffed.reason, 'protected_lane');
    assert.match(sniffed.line, /protected billing lane/);

    assert.equal(originHasGreeting(ctx), false);
  } finally {
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test('the check fails after the rebase: nothing merges and the branch is left', () => {
  const ctx = setup();
  try {
    fs.writeFileSync(path.join(ctx.root, 'poison.txt'), 'x\n');
    git(['add', 'poison.txt'], ctx.root);
    git(['commit', '-m', 'origin gains a file the check rejects'], ctx.root);
    git(['push', 'origin', 'master'], ctx.root);

    const result = land(ctx, { verifier: 'test ! -f poison.txt' });
    assert.equal(result.landed, false);
    assert.equal(result.reason, 'ship_failed');
    assert.equal(result.line, 'left on its branch: its check failed after the rebase');
    assert.equal(originHasGreeting(ctx), false);
    assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], ctx.worktree), 'member/greeting');
  } finally {
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  }
});
