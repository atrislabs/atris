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
function setup({ policyOn = true, policy = null } = {}) {
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
  fs.mkdirSync(path.join(root, '.atris', 'policy'), { recursive: true });
  fs.writeFileSync(path.join(root, '.atris', 'policy', 'autoland.json'),
    policy !== null ? policy : JSON.stringify(policyOn ? { enabled: true, enabled_by: 'operator' } : { enabled: false }));

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
    // merge refuses without an expected head, or when the head moved.
    'if [ "$1 $2" = "pr merge" ]; then',
    '  want=""',
    '  while [ $# -gt 0 ]; do if [ "$1" = "--match-head-commit" ]; then want="$2"; fi; shift; done',
    '  [ -n "$want" ] || { echo "no expected head" >&2; exit 1; }',
    '  [ "$(git rev-parse HEAD)" = "$want" ] || { echo "head moved" >&2; exit 1; }',
    '  git push -q origin "$want:refs/heads/master" || exit 1; echo "merged"; exit 0',
    'fi',
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

function lockPath(ctx) {
  return path.join(ctx.root, '.atris', 'state', 'member-autoland.lock');
}

function cleanup(ctx) {
  fs.rmSync(ctx.dir, { recursive: true, force: true });
}

// A script the check runs that pushes a commit to origin master from the main
// checkout, so the base moves after the check passed. `once` pushes poison.txt
// a single time; otherwise every run pushes a new harmless commit.
function baseMover(ctx, { once }) {
  const script = path.join(ctx.dir, once ? 'poison-once.sh' : 'move-always.sh');
  const lines = once
    ? [
      `cd "${ctx.root}" || exit 1`,
      `[ -f "${ctx.dir}/poisoned" ] && exit 0`,
      `touch "${ctx.dir}/poisoned"`,
      'echo x > poison.txt && git add poison.txt && git commit -qm poison && git push -q origin master',
    ]
    : [
      `cd "${ctx.root}" || exit 1`,
      `n=$(cat "${ctx.dir}/count" 2>/dev/null || echo 0); n=$((n + 1)); echo $n > "${ctx.dir}/count"`,
      'echo $n > moving.txt && git add moving.txt && git commit -qm "move $n" && git push -q origin master',
    ];
  fs.writeFileSync(script, `#!/bin/sh\n${lines.join('\n')}\n`, { mode: 0o755 });
  return script;
}

function mission(ctx, overrides = {}) {
  return {
    status: 'complete',
    owner: 'executor',
    objective: 'add a greeting file',
    lane: 'workspace',
    verifier: 'test -f greeting.txt',
    verifier_result: {
      passed: true,
      command: 'test -f greeting.txt',
      referee: { mode: 'engine', engine: 'codex', passed: true, output: 'ran it\nVERDICT: PASS' },
    },
    worktree: { path: ctx.worktree, branch: 'member/greeting' },
    ...overrides,
  };
}

function land(ctx, overrides, env = ctx.env) {
  const log = console.log;
  console.log = () => {};
  try {
    return landFinishedMemberRun({ mission: mission(ctx, overrides), env });
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
    assert.equal(fs.existsSync(lockPath(ctx)), false, 'the landing lock is released');
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
    assert.equal(result.reason, 'check_failed');
    assert.equal(result.line, 'left on its branch: its check failed after the rebase');
    assert.equal(originHasGreeting(ctx), false);
    assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], ctx.worktree), 'member/greeting');
  } finally {
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test('missing policy file: nothing lands', () => {
  const ctx = setup();
  try {
    fs.rmSync(path.join(ctx.root, '.atris', 'policy', 'autoland.json'));
    const result = land(ctx);
    assert.equal(result.attempted, false);
    assert.equal(result.landed, false);
    assert.equal(originHasGreeting(ctx), false);
  } finally {
    cleanup(ctx);
  }
});

test('unreadable or malformed policy file: nothing lands', (t) => {
  if (process.getuid && process.getuid() === 0) t.skip('root reads any file');
  const ctx = setup();
  const file = path.join(ctx.root, '.atris', 'policy', 'autoland.json');
  try {
    fs.chmodSync(file, 0o000);
    assert.equal(land(ctx).attempted, false);
    fs.chmodSync(file, 0o644);
    fs.writeFileSync(file, '{ "enabled": true,');
    assert.equal(land(ctx).attempted, false);
    fs.writeFileSync(file, JSON.stringify({ enabled: 'true', enabled_by: 'operator' }));
    assert.equal(land(ctx).attempted, false);
    assert.equal(originHasGreeting(ctx), false);
  } finally {
    try { fs.chmodSync(file, 0o644); } catch {}
    cleanup(ctx);
  }
});

test('policy on only in a linked checkout: nothing lands', () => {
  const ctx = setup({ policy: '' });
  fs.rmSync(path.join(ctx.root, '.atris', 'policy', 'autoland.json'));
  const linkedPolicy = path.join(ctx.worktree, '.atris', 'policy');
  fs.mkdirSync(linkedPolicy, { recursive: true });
  fs.writeFileSync(path.join(linkedPolicy, 'autoland.json'), JSON.stringify({ enabled: true, enabled_by: 'operator' }));
  const cwd = process.cwd();
  try {
    process.chdir(ctx.worktree);
    const result = land(ctx);
    assert.equal(result.attempted, false);
    assert.equal(originHasGreeting(ctx), false);
  } finally {
    process.chdir(cwd);
    cleanup(ctx);
  }
});

test('protected_lane_note in mission metadata: nothing lands', () => {
  const ctx = setup();
  try {
    const result = land(ctx, { metadata: { protected_lane_note: 'never self-land: touches the release path' } });
    assert.equal(result.landed, false);
    assert.equal(result.reason, 'protected_lane');
    assert.match(result.line, /never self-land/);
    assert.equal(originHasGreeting(ctx), false);
  } finally {
    cleanup(ctx);
  }
});

test('a linked billing task, or a linked task that cannot be read: nothing lands', () => {
  const ctx = setup();
  const env = { ...ctx.env, ATRIS_TASKS_DB: path.join(ctx.dir, 'tasks.db') };
  try {
    const taskDb = require('../lib/task-db');
    const db = taskDb.open(env.ATRIS_TASKS_DB);
    const { id } = taskDb.addTask(db, { title: 'tidy the greeting copy', tag: 'billing', workspaceRoot: taskDb.workspaceRoot(ctx.root) });

    const billing = land(ctx, { task_ids: [id] }, env);
    assert.equal(billing.landed, false);
    assert.equal(billing.reason, 'protected_lane');
    assert.match(billing.line, /linked task "tidy the greeting copy" sits in the protected billing lane/);

    const missing = land(ctx, { task_ref: 'NOPE-404' }, env);
    assert.equal(missing.reason, 'protected_lane');
    assert.match(missing.line, /could not be read/);
    assert.equal(originHasGreeting(ctx), false);
  } finally {
    cleanup(ctx);
  }
});

test('no independent review verdict, or a failing one: nothing lands', () => {
  const ctx = setup();
  try {
    const none = land(ctx, { verifier_result: { passed: true, command: 'test -f greeting.txt' } });
    assert.equal(none.landed, false);
    assert.equal(none.reason, 'no_review');
    assert.equal(none.line, 'left on its branch: no independent review passed it');

    const failed = land(ctx, {
      verifier_result: { passed: true, referee: { mode: 'engine', passed: false, output: 'VERDICT: FAIL' } },
    });
    assert.equal(failed.reason, 'no_review');
    assert.equal(originHasGreeting(ctx), false);
  } finally {
    cleanup(ctx);
  }
});

test('the base gains a poison file after the check: rechecked on the new base and blocked', () => {
  const ctx = setup();
  try {
    const mover = baseMover(ctx, { once: true });
    const result = land(ctx, { verifier: `test ! -f poison.txt && sh "${mover}"` });
    assert.equal(result.landed, false);
    assert.equal(result.reason, 'check_failed');
    assert.equal(originHasGreeting(ctx), false);
    assert.equal(fs.existsSync(lockPath(ctx)), false);
  } finally {
    cleanup(ctx);
  }
});

test('the base keeps moving after every check: the branch is left with a plain reason', () => {
  const ctx = setup();
  try {
    const mover = baseMover(ctx, { once: false });
    const result = land(ctx, { verifier: `test -f greeting.txt && sh "${mover}"` });
    assert.equal(result.landed, false);
    assert.equal(result.reason, 'base_moved');
    assert.equal(result.line, 'left on its branch: master kept moving while its check ran, so it was not merged');
    assert.equal(originHasGreeting(ctx), false);
  } finally {
    cleanup(ctx);
  }
});

test('another landing holds the lock: nothing lands; a stale lock is taken over', () => {
  const ctx = setup();
  try {
    fs.writeFileSync(lockPath(ctx), '{}');
    const busy = land(ctx);
    assert.equal(busy.reason, 'locked');
    assert.equal(originHasGreeting(ctx), false);

    const old = new Date(Date.now() - 16 * 60 * 1000);
    fs.utimesSync(lockPath(ctx), old, old);
    const result = land(ctx);
    assert.equal(result.landed, true, result.line);
    assert.equal(fs.existsSync(lockPath(ctx)), false);
  } finally {
    cleanup(ctx);
  }
});
