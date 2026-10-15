'use strict';

// Regression: on 2026-10-15 `atris engine dispatch <5 ids> --engine codex --yolo`
// landed 0 of 5 tiny tasks on a fresh practice repo while the raw engines
// landed the same work in 29 to 105 seconds. Every engine stopped at the
// guard, and even past it the brief would have failed them:
//   1. the task's own --verify check was ignored for `git diff --check`;
//   2. every brief demanded a new test and `npm run test:fast`, which only
//      exists in our Node repos;
//   3. a yolo engine got the commit-only brief, so it could never land;
//   4. the guard counted .atris/state/engines.json and usage.jsonl, two files
//      atris writes itself, as dirt.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const fleet = require('../lib/fleet');
const { isConductorStatusLine, isConductorUntracked } = require('../lib/conductor-artifacts');

const CLI = path.join(__dirname, '..', 'bin', 'atris.js');

function tempDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

const TYPO_TASK = {
  display_id: 'PR-2',
  status: 'open',
  title: 'Fix the Teh typo in lanes/d1/README.md. Check: git diff --check',
  metadata: {
    verify: "! grep -q 'Teh' lanes/d1/README.md",
    done_looks_like: 'README says The results',
  },
};

test('1. the brief and the landing check use the task\'s own verify field first', () => {
  const root = tempDir('dispatch-brief-');
  try {
    const prompt = fleet.buildFleetPrompt(TYPO_TASK, { worktreePath: root });
    assert.match(prompt, /^Check: ! grep -q 'Teh' lanes\/d1\/README\.md$/m);
    assert.doesNotMatch(prompt, /^Check: git diff --check$/m);
    assert.match(prompt, /Done criteria: README says The results/);
    assert.equal(fleet.dispatchCheck(TYPO_TASK), "! grep -q 'Teh' lanes/d1/README.md");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('2. a repo with no npm scripts gets its own check, and a test only for behavior changes', () => {
  const root = tempDir('dispatch-brief-');
  try {
    const bare = { display_id: 'PR-3', status: 'open', title: 'Add hello.txt' };
    for (const yolo of [false, true]) {
      const prompt = fleet.buildFleetPrompt(bare, { worktreePath: root, yolo });
      assert.doesNotMatch(prompt, /npm run test:fast/);
      assert.doesNotMatch(prompt, /Include or update a focused regression test/);
      assert.match(prompt, /If the task changes how code behaves, add or update a focused regression test/);
      assert.match(prompt, /A text, docs, or config edit needs no new test/);
      // No package.json and no test/ folder: the repo default is git diff --check.
      assert.match(prompt, /^Check: git diff --check$/m);
      assert.match(prompt, /Run the check bare before committing: git diff --check/);
    }
    const yoloPrompt = fleet.buildFleetPrompt(TYPO_TASK, { worktreePath: root, yolo: true });
    assert.match(yoloPrompt, /--verify '! grep -q '\\''Teh'\\'' lanes\/d1\/README\.md' --merge/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('2b. the ship check in the brief survives the shell as one word', () => {
  const root = tempDir('dispatch-brief-');
  try {
    const prompt = fleet.buildFleetPrompt(TYPO_TASK, { worktreePath: root, yolo: true });
    const quoted = prompt.match(/--verify ('(?:[^']|'\\'')*') --merge/)[1];
    const echoed = spawnSync('sh', ['-c', `printf %s ${quoted}`], { encoding: 'utf8' });
    assert.equal(echoed.stdout, TYPO_TASK.metadata.verify);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('3. each mode carries exactly one landing order', () => {
  const root = tempDir('dispatch-brief-');
  try {
    const yolo = fleet.buildFleetPrompt(TYPO_TASK, { worktreePath: root, yolo: true });
    assert.match(yolo, /Land it yourself\./);
    assert.match(yolo, /That ship command is the only push allowed/);
    assert.doesNotMatch(yolo, /NEVER push|Do not push|commit here/i);

    const plain = fleet.buildFleetPrompt(TYPO_TASK, { worktreePath: root });
    assert.match(plain, /Do not push and do not create branches; the conductor lands your commit\./);
    assert.doesNotMatch(plain, /atris worktree ship|Land it yourself/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('3b. a yolo dispatch hands the engine the yolo brief', async () => {
  const root = tempDir('dispatch-root-');
  try {
    const prompts = [];
    const cli = (args) => {
      if (args[0] === 'task' && args[1] === 'show') return { status: 0, stdout: JSON.stringify(TYPO_TASK), stderr: '' };
      if (args[0] === 'worktree' && args[1] === 'start') return { status: 0, stdout: `next: cd ${root}\n`, stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    await fleet.runDispatchFlight({
      root,
      taskIds: ['PR-2'],
      engine: 'codex',
      yolo: true,
      ownCli: cli,
      log: () => {},
      scoutAsk: false,
      startCommitReader: () => 'base-commit',
      dispatcher: (entry) => { prompts.push(entry.prompt); return Promise.resolve({ exitCode: 0, report: 'landed' }); },
      selfLandCheck: () => ({ ok: true, stage: 'self_landed', target: 'origin/main' }),
    });
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /Land it yourself\./);
    assert.doesNotMatch(prompts[0], /Do not push/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}

function guard(cwd) {
  return spawnSync(process.execPath, [CLI, 'worktree', 'guard'], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', NO_COLOR: '1' },
  });
}

const DISPATCH_WRITES = [
  '.atris/agent-worktree.json',
  '.atris/codex-watchdog.js',
  '.atris/fleet-prompt-PR-2.md',
  '.atris/state/briefs.jsonl',
  '.atris/state/engines.json',
  '.atris/state/usage.jsonl',
];

test('4. every file dispatch writes into a work folder is skipped by the guard', () => {
  for (const file of DISPATCH_WRITES) {
    assert.equal(isConductorUntracked(file), true, file);
    assert.equal(isConductorStatusLine(`?? ${file}`), true, file);
  }
  // Real work and tracked .atris edits still count.
  assert.equal(isConductorStatusLine('?? lanes/d1/hello.txt'), false);
  assert.equal(isConductorStatusLine(' M .atris/state/engines.json'), false);
});

test('4b. worktree guard passes in a fresh work folder holding only dispatch files', () => {
  const dir = tempDir('dispatch-guard-');
  try {
    const main = path.join(dir, 'repo');
    fs.mkdirSync(main);
    git(main, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(main, 'README.md'), 'Teh results\n');
    git(main, 'add', 'README.md');
    git(main, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'seed');
    const wt = path.join(dir, 'wt');
    git(main, 'worktree', 'add', '-q', '-b', 'codex/codex-dispatch-pr-2-20261015-000000', wt);
    for (const file of DISPATCH_WRITES) {
      fs.mkdirSync(path.dirname(path.join(wt, file)), { recursive: true });
      fs.writeFileSync(path.join(wt, file), '{}\n');
    }
    const clean = guard(wt);
    assert.equal(clean.status, 0, `${clean.stdout}${clean.stderr}`);
    assert.match(clean.stdout, /atris worktree guard: ok/);

    fs.writeFileSync(path.join(wt, 'hello.txt'), 'hello\n');
    const dirty = guard(wt);
    assert.equal(dirty.status, 3, `${dirty.stdout}${dirty.stderr}`);
    assert.match(dirty.stderr, /untracked=1/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('5. a dispatch retry is not refused by its own earlier finished run', async () => {
  const root = tempDir('dispatch-root-');
  try {
    const calls = [];
    const cli = (args) => {
      calls.push(args.join(' '));
      if (args[0] === 'task' && args[1] === 'show') return { status: 0, stdout: JSON.stringify(TYPO_TASK), stderr: '' };
      if (args[0] === 'worktree' && args[1] === 'start') return { status: 0, stdout: `next: cd ${root}\n`, stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    const flight = await fleet.runDispatchFlight({
      root,
      taskIds: ['PR-2'],
      engine: 'codex',
      yolo: true,
      ownCli: cli,
      log: () => {},
      scoutAsk: false,
      startCommitReader: () => 'base-commit',
      dispatcher: () => Promise.resolve({ exitCode: 0, report: 'guard failed' }),
      selfLandCheck: () => ({ ok: false, stage: 'no_work_landed', target: 'origin/main' }),
    });
    // The claim taken before start is the lock, so start may pass an old branch.
    assert.ok(calls.some((c) => /^worktree start .*--task dispatch-pr-2 .*--force/.test(c)), calls.join('\n'));
    // The failed flight gives its claim back, so the retry's claim can succeed.
    assert.equal(flight.paused[0].stage, 'no_work_landed');
    assert.ok(calls.includes('task release PR-2 --as fleet-codex'), calls.join('\n'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a task whose title names its own file skips the slow scout pass', async () => {
  const dir = tempDir('dispatch-scout-skip-');
  try {
    git(dir, 'init', '-q', '-b', 'main');
    fs.mkdirSync(path.join(dir, 'lanes', 'd1'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'lanes', 'd1', 'README.md'), 'Teh results\n');
    fs.writeFileSync(path.join(dir, 'lanes', 'd1', 'mathy.py'), 'def double(x):\n    return x * 2\n');
    git(dir, 'add', '.');
    git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'seed');
    const { buildVerifiedScoutPack } = require('../lib/dispatch-scout');
    const asks = [];
    const ask = async () => { asks.push(1); return { ok: false }; };
    for (const title of [
      'Fix the Teh typo in lanes/d1/README.md',
      'Add lanes/d1/hello.txt containing the single line hello',
    ]) {
      assert.equal(await buildVerifiedScoutPack({ task: { display_id: 'PR-2', title }, worktreePath: dir, ask }), null);
    }
    assert.equal(asks.length, 0, 'named files need no scout');
    await buildVerifiedScoutPack({ task: { display_id: 'PR-3', title: 'Make the mathy readme double check stricter' }, worktreePath: dir, ask });
    assert.equal(asks.length, 1, 'a task that names no file still gets its scout');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ship retries a merge GitHub refused because the base just moved', () => {
  const { mergePrWithRetry } = require('../commands/worktree');
  const replies = [
    { status: 1, stderr: 'GraphQL: Base branch was modified. Review and try the merge again. (mergePullRequest)' },
    { status: 1, stderr: 'GraphQL: Base branch was modified. Review and try the merge again. (mergePullRequest)' },
    { status: 0, stdout: '' },
  ];
  const waits = [];
  const merged = mergePrWithRetry(['pr', 'merge', '15', '--merge'], '/repo', {
    run: () => replies.shift(),
    wait: (ms) => waits.push(ms),
  });
  assert.equal(merged.status, 0);
  assert.equal(waits.length, 2);

  // Any other refusal is final on the first try.
  const other = [{ status: 1, stderr: 'Pull request is not mergeable: the merge commit cannot be cleanly created.' }];
  const refused = mergePrWithRetry(['pr', 'merge', '16', '--merge'], '/repo', { run: () => other.shift(), wait: () => assert.fail('no wait') });
  assert.equal(refused.status, 1);
});

test('a retry that resumed the last run\'s branch measures from the main line', () => {
  // The 2026-10-15 retry landed all three resumed tasks but reported
  // "no work landed": it measured from the resumed HEAD, not the main line.
  const dir = tempDir('atris-resume-start-');
  try {
    git(dir, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(dir, 'README.md'), 'Teh repo\n');
    git(dir, 'add', '.');
    git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'seed');
    const mainline = git(dir, 'rev-parse', 'HEAD').trim();
    git(dir, 'checkout', '-q', '-b', 'codex/retry');
    fs.writeFileSync(path.join(dir, 'README.md'), 'The repo\n');
    git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-am', 'fix typo');
    const resumedHead = git(dir, 'rev-parse', 'HEAD').trim();

    // A fresh worktree measures from its own HEAD.
    assert.equal(fleet.defaultDispatchStartCommit({ worktreePath: dir }), resumedHead);

    fs.mkdirSync(path.join(dir, '.atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.atris', 'agent-worktree.json'), JSON.stringify({
      resumed_from: 'codex/old-run', checkout_base: 'main',
    }));
    assert.equal(fleet.defaultDispatchStartCommit({ worktreePath: dir }), mainline);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
