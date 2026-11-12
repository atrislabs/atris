const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { autolandMemberRun, recordQueuedPullRequest, requeueDroppedAutolands } = require('../lib/member-autoland');

function git(args, cwd) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout.trim();
}

// A fake gh that logs each call and serves pull request JSON from a config
// file: `view` for `gh pr view`, `list` and `createUrl` for the first landing.
function writeFakeGh(bin, log, config) {
  fs.writeFileSync(path.join(bin, 'gh'), [
    '#!/usr/bin/env node',
    "const fs = require('fs');",
    `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
    `const cfg = JSON.parse(fs.readFileSync(${JSON.stringify(config)}, 'utf8'));`,
    "const [a, b] = process.argv.slice(2);",
    "if (a === 'pr' && b === 'view') { if (!cfg.view) process.exit(1); console.log(JSON.stringify(cfg.view)); }",
    "if (a === 'pr' && b === 'list') console.log(JSON.stringify(cfg.list || []));",
    "if (a === 'pr' && b === 'create') console.log(cfg.createUrl || 'https://github.com/acme/repo/pull/7');",
    "if (a === 'pr' && b === 'merge' && cfg.mergeFails) process.exit(1);",
    "if (a === 'pr' && b === 'checks') { console.log(JSON.stringify(cfg.checks || [])); if ((cfg.checks || []).some((c) => c.bucket === 'fail')) process.exit(8); }",
    "if (a === 'run' && b === 'rerun' && cfg.rerunFails) process.exit(1);",
    "if (a === 'api' && b === 'graphql') console.log(cfg.inQueue ? 'true' : 'false');",
  ].join('\n'), { mode: 0o755 });
}

const BRANCH = 'codex/member-work';

// A main checkout with a bare origin and self-landing on, a member worktree
// whose commit was pushed and queued, and the fake gh on PATH.
function fixture({ policy = '{"enabled":true}', queued = true } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-requeue-'));
  const origin = path.join(base, 'origin.git');
  const main = path.join(base, 'main');
  git(['init', '--bare', '-b', 'master', origin], base);
  git(['init', '-b', 'master', main], base);
  git(['config', 'user.email', 'test@example.com'], main);
  git(['config', 'user.name', 'Test'], main);
  fs.writeFileSync(path.join(main, 'README.md'), '# fixture\n');
  fs.writeFileSync(path.join(main, '.gitignore'), '.atris/\natris/runs/\n');
  git(['add', '.'], main);
  git(['commit', '-qm', 'init'], main);
  git(['remote', 'add', 'origin', origin], main);
  git(['push', '-q', 'origin', 'master'], main);
  if (policy !== null) {
    fs.mkdirSync(path.join(main, '.atris', 'policy'), { recursive: true });
    fs.writeFileSync(path.join(main, '.atris', 'policy', 'autoland.json'), policy);
  }
  const worktree = path.join(base, 'wt');
  git(['worktree', 'add', '-q', '-b', BRANCH, worktree, 'master'], main);
  fs.writeFileSync(path.join(worktree, 'work.txt'), 'done\n');
  git(['add', '.'], worktree);
  git(['commit', '-qm', 'member work'], worktree);
  const pushed = git(['rev-parse', 'HEAD'], worktree);

  const bin = path.join(base, 'bin');
  fs.mkdirSync(bin);
  const log = path.join(base, 'gh-calls.jsonl');
  const config = path.join(base, 'gh-config.json');
  writeFakeGh(bin, log, config);
  const fx = { base, origin, main, worktree, bin, log, config, pushed };
  setView(fx, {});
  if (queued) {
    git(['push', '-q', 'origin', `${BRANCH}`], worktree);
    writeQueue(fx, { [BRANCH]: { branch: BRANCH, base: 'master', number: 7, pushed, requeues: 0 } });
  }
  return fx;
}

const queuePath = (fx) => path.join(fx.main, '.atris', 'state', 'autoland-queue.json');

function writeQueue(fx, entries) {
  fs.mkdirSync(path.dirname(queuePath(fx)), { recursive: true });
  fs.writeFileSync(queuePath(fx), JSON.stringify({ schema: 'atris.autoland_queue.v1', entries }));
}

const readQueue = (fx) => JSON.parse(fs.readFileSync(queuePath(fx), 'utf8')).entries;

// The pull request as GitHub reports it once auto-merge was dropped.
function setView(fx, overrides, extra = {}) {
  const view = overrides === null ? null : {
    number: 7, state: 'OPEN', headRefName: BRANCH, baseRefName: 'master',
    headRefOid: fx.pushed, isCrossRepository: false, autoMergeRequest: null, ...overrides,
  };
  fs.writeFileSync(fx.config, JSON.stringify({ view, ...extra }));
}

// Someone lands other work on master after the member change was queued.
function moveMaster(fx, file = 'other.txt', text = 'other\n') {
  fs.writeFileSync(path.join(fx.main, file), text);
  git(['add', file], fx.main);
  git(['commit', '-qm', `master moves ${file}`], fx.main);
  git(['push', '-q', 'origin', 'master'], fx.main);
  return git(['rev-parse', 'HEAD'], fx.main);
}

function ghCalls(fx) {
  if (!fs.existsSync(fx.log)) return [];
  return fs.readFileSync(fx.log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

const remoteBranch = (fx) => git(['ls-remote', fx.origin, `refs/heads/${BRANCH}`], fx.base).split('\t')[0];

function withFakeGh(fx, fn) {
  const saved = process.env.PATH;
  process.env.PATH = `${fx.bin}${path.delimiter}${saved}`;
  try {
    return fn();
  } finally {
    process.env.PATH = saved;
    fs.rmSync(fx.base, { recursive: true, force: true });
  }
}

test('dropped while master moved: merges master in, pushes, and queues the new commit again', () => {
  const fx = fixture();
  withFakeGh(fx, () => {
    setView(fx, {});
    const masterSha = moveMaster(fx);
    const out = requeueDroppedAutolands({ cwd: fx.main });
    assert.equal(out.requeued, 1, out.line);
    assert.equal(out.results[0].state, 'requeued');
    assert.match(out.results[0].line, /caught up with the main branch and queued again/);

    const head = remoteBranch(fx);
    assert.notEqual(head, fx.pushed);
    assert.deepEqual(git(['rev-list', '--parents', '-n', '1', head], fx.main).split(' ').slice(1), [fx.pushed, masterSha]);
    assert.equal(git(['show', `${head}:work.txt`], fx.main), 'done');
    assert.equal(git(['show', `${head}:other.txt`], fx.main), 'other');

    const merges = ghCalls(fx).filter((c) => c[1] === 'merge');
    assert.deepEqual(merges, [['pr', 'merge', '7', '--auto', '--merge', '--match-head-commit', head]]);
    const entry = readQueue(fx)[BRANCH];
    assert.equal(entry.pushed, head);
    assert.equal(entry.requeues, 1);
  });
});

test('dropped with master unmoved: queues the same commit again without a push', () => {
  const fx = fixture();
  withFakeGh(fx, () => {
    const out = requeueDroppedAutolands({ cwd: fx.main });
    assert.equal(out.results[0].state, 'requeued');
    assert.match(out.results[0].line, /queued again$/);
    assert.equal(remoteBranch(fx), fx.pushed);
    assert.deepEqual(ghCalls(fx).filter((c) => c[1] === 'merge'),
      [['pr', 'merge', '7', '--auto', '--merge', '--match-head-commit', fx.pushed]]);
  });
});

test('catch-up pushed but github slow to queue it: the next look still knows the commit is ours', () => {
  const fx = fixture();
  withFakeGh(fx, () => {
    setView(fx, {}, { mergeFails: true });
    moveMaster(fx);
    const first = requeueDroppedAutolands({ cwd: fx.main });
    assert.equal(first.results[0].state, 'auto-merge');
    const head = remoteBranch(fx);
    assert.notEqual(head, fx.pushed, 'the catch-up reached github');
    assert.equal(readQueue(fx)[BRANCH].pushed, head);
    assert.equal(readQueue(fx)[BRANCH].requeues, 1);

    setView(fx, { headRefOid: head });
    const second = requeueDroppedAutolands({ cwd: fx.main });
    assert.equal(second.results[0].state, 'requeued', second.results[0].line);
    assert.match(second.results[0].line, /queued again$/);
    assert.equal(remoteBranch(fx), head, 'no second catch-up push');
    assert.deepEqual(ghCalls(fx).filter((c) => c[1] === 'merge').at(-1),
      ['pr', 'merge', '7', '--auto', '--merge', '--match-head-commit', head]);
    assert.equal(readQueue(fx)[BRANCH].pushed, head);
  });
});

test('still queued on github: nothing is pushed or re-queued', () => {
  const fx = fixture();
  withFakeGh(fx, () => {
    setView(fx, { autoMergeRequest: { enabledAt: '2026-10-14T00:00:00Z' } });
    moveMaster(fx);
    const out = requeueDroppedAutolands({ cwd: fx.main });
    assert.equal(out.results[0].state, 'queued');
    assert.equal(remoteBranch(fx), fx.pushed);
    assert.equal(ghCalls(fx).filter((c) => c[1] === 'merge').length, 0);
    assert.ok(readQueue(fx)[BRANCH], 'still tracked');
  });
});

test('already in github\'s merge line: no catch-up push, left to the line', () => {
  const fx = fixture();
  withFakeGh(fx, () => {
    setView(fx, {}, { inQueue: true });
    moveMaster(fx);
    const out = requeueDroppedAutolands({ cwd: fx.main });
    assert.equal(out.results[0].state, 'queued', out.results[0].line);
    assert.match(out.results[0].line, /in github's merge line/);
    assert.equal(remoteBranch(fx), fx.pushed);
    assert.equal(ghCalls(fx).filter((c) => c[1] === 'merge').length, 0);
    assert.ok(readQueue(fx)[BRANCH], 'still tracked');
  });
});

const FAILED_CHECKS = [
  { bucket: 'pass', link: 'https://github.com/acme/repo/actions/runs/111/job/1' },
  { bucket: 'fail', link: 'https://github.com/acme/repo/actions/runs/222/job/2' },
  { bucket: 'fail', link: 'https://github.com/acme/repo/actions/runs/222/job/3' },
];

test('queued with a failed check: the failed checks run again once, then it waits for a fix', () => {
  const fx = fixture();
  withFakeGh(fx, () => {
    setView(fx, { autoMergeRequest: { enabledAt: '2026-10-14T00:00:00Z' } }, { checks: FAILED_CHECKS });
    const first = requeueDroppedAutolands({ cwd: fx.main });
    assert.equal(first.results[0].state, 'rerun', first.results[0].line);
    assert.equal(first.rerun, 1);
    assert.match(first.line, /1 failed check run again/);
    assert.deepEqual(ghCalls(fx).filter((c) => c[0] === 'run'), [['run', 'rerun', '222', '--failed']]);
    assert.equal(readQueue(fx)[BRANCH].reran, fx.pushed);
    assert.equal(readQueue(fx)[BRANCH].requeues, 0);

    const second = requeueDroppedAutolands({ cwd: fx.main });
    assert.equal(second.results[0].state, 'failing');
    assert.match(second.results[0].line, /failed again after one retry/);
    assert.equal(ghCalls(fx).filter((c) => c[0] === 'run').length, 1, 'never retried twice');
    assert.ok(readQueue(fx)[BRANCH], 'still tracked');
    assert.equal(remoteBranch(fx), fx.pushed);
  });
});

test('queued with every check passing or a rerun github refuses: nothing is marked as retried', () => {
  const fx = fixture();
  withFakeGh(fx, () => {
    setView(fx, { autoMergeRequest: { enabledAt: '2026-10-14T00:00:00Z' } }, { checks: [FAILED_CHECKS[0]] });
    assert.equal(requeueDroppedAutolands({ cwd: fx.main }).results[0].state, 'queued');
    setView(fx, { autoMergeRequest: { enabledAt: '2026-10-14T00:00:00Z' } }, { checks: FAILED_CHECKS, rerunFails: true });
    const out = requeueDroppedAutolands({ cwd: fx.main });
    assert.equal(out.results[0].state, 'queued');
    assert.match(out.results[0].line, /could not be run again/);
    assert.equal(readQueue(fx)[BRANCH].reran, undefined);
  });
});

// GitHub keeps auto-merge switched on when master moves under a queued change
// and the two clash, so the change waits forever unless the sweep notices.
const QUEUED = { autoMergeRequest: { enabledAt: '2026-10-14T00:00:00Z' }, mergeable: 'CONFLICTING' };

test('still queued but clashing in a member log only: caught up and queued again', () => {
  const fx = fixture({ queued: false });
  withFakeGh(fx, () => {
    const log = 'atris/team/builder/logs/2026-10-14.md';
    fs.mkdirSync(path.join(fx.worktree, path.dirname(log)), { recursive: true });
    fs.writeFileSync(path.join(fx.worktree, log), '- member line\n');
    git(['add', '.'], fx.worktree);
    git(['commit', '-qm', 'member log'], fx.worktree);
    fx.pushed = git(['rev-parse', 'HEAD'], fx.worktree);
    git(['push', '-q', 'origin', BRANCH], fx.worktree);
    writeQueue(fx, { [BRANCH]: { branch: BRANCH, base: 'master', number: 7, pushed: fx.pushed, requeues: 0 } });
    setView(fx, QUEUED);
    fs.mkdirSync(path.join(fx.main, path.dirname(log)), { recursive: true });
    moveMaster(fx, log, '- master line\n');

    const out = requeueDroppedAutolands({ cwd: fx.main });
    assert.equal(out.results[0].state, 'requeued', out.results[0].line);
    const head = remoteBranch(fx);
    assert.notEqual(head, fx.pushed);
    const merged = git(['show', `${head}:${log}`], fx.main);
    assert.match(merged, /member line/);
    assert.match(merged, /master line/);
    assert.deepEqual(ghCalls(fx).filter((c) => c[1] === 'merge'),
      [['pr', 'merge', '7', '--auto', '--merge', '--match-head-commit', head]]);
    assert.equal(readQueue(fx)[BRANCH].pushed, head);
  });
});

test('still queued but clashing in real code: left for a person instead of waiting forever', () => {
  const fx = fixture();
  withFakeGh(fx, () => {
    setView(fx, QUEUED);
    moveMaster(fx, 'work.txt', 'master wrote this instead\n');
    const out = requeueDroppedAutolands({ cwd: fx.main });
    assert.equal(out.results[0].state, 'clash');
    assert.match(out.results[0].line, /clashes with the main branch in work\.txt/);
    assert.equal(remoteBranch(fx), fx.pushed);
    assert.equal(ghCalls(fx).filter((c) => c[1] === 'merge').length, 0);
    assert.equal(readQueue(fx)[BRANCH], undefined);
  });
});

test('still queued and github has not worked out a clash yet: left queued', () => {
  const fx = fixture();
  withFakeGh(fx, () => {
    setView(fx, { ...QUEUED, mergeable: 'UNKNOWN' });
    moveMaster(fx, 'work.txt', 'master wrote this instead\n');
    const out = requeueDroppedAutolands({ cwd: fx.main });
    assert.equal(out.results[0].state, 'queued');
    assert.ok(readQueue(fx)[BRANCH], 'still tracked');
  });
});

test('someone else pushed to the branch: left for a person and no longer tracked', () => {
  const fx = fixture();
  withFakeGh(fx, () => {
    setView(fx, { headRefOid: 'a'.repeat(40) });
    const out = requeueDroppedAutolands({ cwd: fx.main });
    assert.equal(out.results[0].state, 'changed');
    assert.match(out.results[0].line, /left for you/);
    assert.equal(ghCalls(fx).filter((c) => c[1] === 'merge').length, 0);
    assert.equal(readQueue(fx)[BRANCH], undefined);
  });
});

test('a real clash with master: nothing is pushed and the branch is left for a person', () => {
  const fx = fixture();
  withFakeGh(fx, () => {
    moveMaster(fx, 'work.txt', 'master wrote this instead\n');
    const out = requeueDroppedAutolands({ cwd: fx.main });
    assert.equal(out.results[0].state, 'clash');
    assert.match(out.results[0].line, /clashes with the main branch in work\.txt/);
    assert.equal(remoteBranch(fx), fx.pushed);
    assert.equal(ghCalls(fx).filter((c) => c[1] === 'merge').length, 0);
  });
});

test('merged or closed: dropped from the list and never touched', () => {
  for (const state of ['MERGED', 'CLOSED']) {
    const fx = fixture();
    withFakeGh(fx, () => {
      setView(fx, { state });
      const out = requeueDroppedAutolands({ cwd: fx.main });
      assert.equal(out.results[0].state, state === 'MERGED' ? 'merged' : 'closed');
      assert.equal(ghCalls(fx).filter((c) => c[1] === 'merge').length, 0);
      assert.equal(readQueue(fx)[BRANCH], undefined);
    });
  }
});

test('dropped again after the catch-up limit: left for a person instead of looping', () => {
  const fx = fixture();
  withFakeGh(fx, () => {
    writeQueue(fx, { [BRANCH]: { branch: BRANCH, base: 'master', number: 7, pushed: fx.pushed, requeues: 3 } });
    const out = requeueDroppedAutolands({ cwd: fx.main });
    assert.equal(out.results[0].state, 'gave-up');
    assert.equal(ghCalls(fx).filter((c) => c[1] === 'merge').length, 0);
  });
});

test('github unreadable: kept for the next look, nothing pushed', () => {
  const fx = fixture();
  withFakeGh(fx, () => {
    setView(fx, null);
    const out = requeueDroppedAutolands({ cwd: fx.main });
    assert.equal(out.results[0].state, 'unreadable');
    assert.ok(readQueue(fx)[BRANCH]);
    assert.equal(ghCalls(fx).filter((c) => c[1] === 'merge').length, 0);
  });
});

test('self-landing switched off: gh is never called', () => {
  const fx = fixture({ policy: '{"enabled":false}' });
  withFakeGh(fx, () => {
    const out = requeueDroppedAutolands({ cwd: fx.main });
    assert.equal(out.checked, 0);
    assert.match(out.line, /not switched on/);
    assert.deepEqual(ghCalls(fx), []);
  });
});

test('a first landing writes the queued commit down so a later sweep can find it', () => {
  const fx = fixture({ queued: false });
  withFakeGh(fx, () => {
    const runs = path.join(fx.worktree, 'atris', 'runs');
    fs.mkdirSync(runs, { recursive: true });
    const at = new Date(Date.now() + 1000).toISOString();
    const tree = git(['rev-parse', 'HEAD^{tree}'], fx.worktree);
    fs.writeFileSync(path.join(runs, `mission-mission-test-${at.replace(/[:.]/g, '-')}.json`), JSON.stringify({
      clean: true, git_tree: tree, mission_id: 'mission-test', at,
      result: { kind: 'mission_run_summary', tick_count: 1, ticks: [{
        status: 'ran', tick_index: 1, engine_id: 'claude', verifier_passed: true, reviewed_git_tree: tree,
        referee_result: { passed: true, mode: 'engine', engine: 'codex' },
      }] },
    }));
    const out = autolandMemberRun({
      mission: {
        id: 'mission-test', objective: 'Tidy the member board so finished work reads plainly', owner: 'executor',
        runner: 'claude', lane: 'workspace', metadata: {}, task_ids: [], worktree: { branch: BRANCH },
        verifier_result: { passed: true }, last_tick_at: '2000-01-01T00:00:00.000Z', last_tick_status: 'ran', last_tick_index: 1,
      },
      cwd: fx.worktree,
      loadTask: () => null,
    });
    assert.equal(out.auto_merge, true, out.line);
    const entry = readQueue(fx)[BRANCH];
    assert.equal(entry.number, 7);
    assert.equal(entry.pushed, fx.pushed);
    assert.equal(entry.base, 'master');
    assert.equal(entry.requeues, 0);
  });
});

// `atris worktree ship --merge` records a pull request GitHub left open for its
// checks. The entry has no mission or job ids. The sweep must still treat it
// like any other dropped change.
test('a pull request recorded by worktree ship is queued again once github drops it', () => {
  const fx = fixture({ queued: false });
  withFakeGh(fx, () => {
    git(['push', '-q', 'origin', BRANCH], fx.worktree);
    // Recorded from the build copy, the way ship does it.
    recordQueuedPullRequest(fx.worktree, { branch: BRANCH, base: 'master', number: 7, pushed: fx.pushed });
    const recorded = readQueue(fx)[BRANCH];
    assert.deepEqual(Object.keys(recorded).sort(), ['base', 'branch', 'number', 'pushed', 'queued_at', 'requeues', 'reran']);

    // The merge-line run failed: open, no auto-merge, not in the line.
    setView(fx, { state: 'OPEN', autoMergeRequest: null, headRefOid: recorded.pushed }, { inQueue: false });
    const out = requeueDroppedAutolands({ cwd: fx.main });
    assert.equal(out.requeued, 1, out.line);
    assert.equal(out.results[0].state, 'requeued', out.results[0].line);
    assert.deepEqual(ghCalls(fx).filter((c) => c[1] === 'merge'),
      [['pr', 'merge', '7', '--auto', '--merge', '--match-head-commit', fx.pushed]]);
    assert.equal(readQueue(fx)[BRANCH].requeues, 1);
    assert.equal(readQueue(fx)[BRANCH].pushed, fx.pushed);
  });
});

test('a pull request recorded by worktree ship that is still in the merge line is left alone', () => {
  const fx = fixture({ queued: false });
  withFakeGh(fx, () => {
    git(['push', '-q', 'origin', BRANCH], fx.worktree);
    recordQueuedPullRequest(fx.worktree, { branch: BRANCH, base: 'master', number: 7, pushed: fx.pushed });
    setView(fx, { autoMergeRequest: null }, { inQueue: true });
    const out = requeueDroppedAutolands({ cwd: fx.main });
    assert.equal(out.results[0].state, 'queued', out.results[0].line);
    assert.equal(ghCalls(fx).filter((c) => c[1] === 'merge').length, 0);
    assert.equal(readQueue(fx)[BRANCH].requeues, 0);
  });
});

test('a pull request recorded by worktree ship still stops at the catch-up cap', () => {
  const fx = fixture({ queued: false });
  withFakeGh(fx, () => {
    git(['push', '-q', 'origin', BRANCH], fx.worktree);
    recordQueuedPullRequest(fx.worktree, { branch: BRANCH, base: 'master', number: 7, pushed: fx.pushed });
    const states = [];
    for (let i = 0; i < 4; i += 1) {
      setView(fx, { autoMergeRequest: null }, { inQueue: false });
      states.push(requeueDroppedAutolands({ cwd: fx.main }).results[0].state);
    }
    assert.deepEqual(states, ['requeued', 'requeued', 'requeued', 'gave-up']);
    assert.equal(readQueue(fx)[BRANCH], undefined);
  });
});

test('recording a pull request creates the entry in the main checkout from any copy', () => {
  const fx = fixture({ queued: false });
  withFakeGh(fx, () => {
    const entry = recordQueuedPullRequest(fx.worktree, { branch: BRANCH, base: 'master', number: 7, pushed: fx.pushed });
    const ledger = JSON.parse(fs.readFileSync(queuePath(fx), 'utf8'));
    assert.equal(ledger.schema, 'atris.autoland_queue.v1');
    assert.deepEqual(ledger.entries[BRANCH], entry);
    assert.deepEqual({ ...entry, queued_at: null }, {
      branch: BRANCH, base: 'master', number: 7, pushed: fx.pushed, requeues: 0, reran: false, queued_at: null,
    });
    assert.ok(Number.isFinite(Date.parse(entry.queued_at)));
  });
});

test('recording the same commit again keeps its catch-up count, its retry mark and its job ids', () => {
  const fx = fixture({ queued: false });
  withFakeGh(fx, () => {
    writeQueue(fx, { [BRANCH]: {
      branch: BRANCH, base: 'master', number: 7, pushed: fx.pushed, requeues: 2, reran: fx.pushed,
      mission_id: 'mission-1', task_ids: ['task-1'], queued_at: '2026-11-01T00:00:00.000Z',
    } });
    const entry = recordQueuedPullRequest(fx.worktree, { branch: BRANCH, base: 'master', number: 7, pushed: fx.pushed });
    assert.equal(entry.requeues, 2);
    assert.equal(entry.reran, fx.pushed);
    assert.equal(entry.mission_id, 'mission-1');
    assert.deepEqual(entry.task_ids, ['task-1']);
    assert.notEqual(entry.queued_at, '2026-11-01T00:00:00.000Z');
  });
});

test('recording a new commit or pull request starts the catch-up count and retry mark over', () => {
  const fx = fixture({ queued: false });
  withFakeGh(fx, () => {
    const seeded = { branch: BRANCH, base: 'master', number: 7, pushed: fx.pushed, requeues: 2, reran: fx.pushed, task_ids: ['task-1'] };
    writeQueue(fx, { [BRANCH]: seeded });
    const next = 'b'.repeat(40);
    const moved = recordQueuedPullRequest(fx.worktree, { branch: BRANCH, base: 'master', number: 7, pushed: next });
    assert.equal(moved.pushed, next);
    assert.equal(moved.requeues, 0);
    assert.equal(moved.reran, false);
    assert.deepEqual(moved.task_ids, ['task-1'], 'job ids stay with the branch');

    writeQueue(fx, { [BRANCH]: seeded });
    const reopened = recordQueuedPullRequest(fx.worktree, { branch: BRANCH, base: 'master', number: 9, pushed: fx.pushed });
    assert.equal(reopened.number, 9);
    assert.equal(reopened.requeues, 0);
    assert.equal(reopened.reran, false);
    assert.equal(Object.keys(readQueue(fx)).length, 1);
  });
});

test('recording leaves other branches in the list alone', () => {
  const fx = fixture();
  withFakeGh(fx, () => {
    const other = { branch: 'codex/other', base: 'master', number: 8, pushed: 'c'.repeat(40), requeues: 1 };
    writeQueue(fx, { ...readQueue(fx), 'codex/other': other });
    recordQueuedPullRequest(fx.worktree, { branch: 'codex/third', base: 'master', number: 9, pushed: 'd'.repeat(40) });
    const entries = readQueue(fx);
    assert.deepEqual(Object.keys(entries).sort(), [BRANCH, 'codex/other', 'codex/third'].sort());
    assert.deepEqual(entries['codex/other'], other);
  });
});

test('recording refuses details it cannot trust and writes nothing', () => {
  const fx = fixture({ queued: false });
  withFakeGh(fx, () => {
    const good = { branch: BRANCH, base: 'master', number: 7, pushed: fx.pushed };
    for (const bad of [{ number: 0 }, { number: undefined }, { number: '7' }, { pushed: 'abc123' }, { base: '' }, { branch: '' }]) {
      assert.throws(() => recordQueuedPullRequest(fx.worktree, { ...good, ...bad }), /could not be read/);
    }
    assert.equal(fs.existsSync(queuePath(fx)), false);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-not-git-'));
    try {
      assert.throws(() => recordQueuedPullRequest(outside, good), /not inside a git checkout/);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
