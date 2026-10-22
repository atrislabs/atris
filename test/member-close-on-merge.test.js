const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { autolandMemberRun, requeueDroppedAutolands } = require('../lib/member-autoland');
const taskDb = require('../lib/task-db');

// A member's job closes itself once its own pull request merges. These run
// the real sweep against a real git origin and a real job database; only gh
// is faked.

function git(args, cwd) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout.trim();
}

function writeFakeGh(bin, log, config) {
  fs.writeFileSync(path.join(bin, 'gh'), [
    '#!/usr/bin/env node',
    "const fs = require('fs');",
    `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
    `const cfg = JSON.parse(fs.readFileSync(${JSON.stringify(config)}, 'utf8'));`,
    "const [a, b] = process.argv.slice(2);",
    "const n = process.argv[4];",
    "if (a === 'pr' && b === 'view') { const v = (cfg.views && cfg.views[n]) || cfg.view; if (!v) process.exit(1); console.log(JSON.stringify(v)); }",
    "if (a === 'pr' && b === 'list') console.log(JSON.stringify(cfg.list || []));",
    "if (a === 'pr' && b === 'create') console.log(cfg.createUrl || 'https://github.com/acme/repo/pull/7');",
  ].join('\n'), { mode: 0o755 });
}

const BRANCH = 'codex/member-work';

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-close-on-merge-'));
  const origin = path.join(base, 'origin.git');
  const main = path.join(base, 'main');
  git(['init', '--bare', '-b', 'master', origin], base);
  git(['init', '-b', 'master', main], base);
  git(['config', 'user.email', 'test@example.com'], main);
  git(['config', 'user.name', 'Test'], main);
  fs.writeFileSync(path.join(main, 'README.md'), '# fixture\n');
  fs.writeFileSync(path.join(main, '.gitignore'), '.atris/\natris/runs/\natris/logs/\n');
  git(['add', '.'], main);
  git(['commit', '-qm', 'init'], main);
  git(['remote', 'add', 'origin', origin], main);
  git(['push', '-q', 'origin', 'master'], main);
  fs.mkdirSync(path.join(main, '.atris', 'policy'), { recursive: true });
  fs.writeFileSync(path.join(main, '.atris', 'policy', 'autoland.json'), '{"enabled":true}');
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
  const db = taskDb.open(path.join(base, 'tasks.db'));
  const fx = { base, main, worktree, bin, log, config, pushed, db };
  setView(fx, {});
  return fx;
}

const queuePath = (fx) => path.join(fx.main, '.atris', 'state', 'autoland-queue.json');
const readQueue = (fx) => JSON.parse(fs.readFileSync(queuePath(fx), 'utf8')).entries;

function queue(fx, taskIds) {
  git(['push', '-q', 'origin', BRANCH], fx.worktree);
  fs.mkdirSync(path.dirname(queuePath(fx)), { recursive: true });
  fs.writeFileSync(queuePath(fx), JSON.stringify({
    schema: 'atris.autoland_queue.v1',
    entries: { [BRANCH]: { branch: BRANCH, base: 'master', number: 7, pushed: fx.pushed, requeues: 0, task_ids: taskIds } },
  }));
}

function setView(fx, overrides) {
  fs.writeFileSync(fx.config, JSON.stringify({
    view: {
      number: 7, state: 'OPEN', headRefName: BRANCH, baseRefName: 'master',
      headRefOid: fx.pushed, isCrossRepository: false, autoMergeRequest: null, ...overrides,
    },
  }));
}

function job(fx, status = 'review') {
  return taskDb.addTask(fx.db, {
    title: 'Tidy the member board', workspaceRoot: fx.main, status, claimedBy: 'generalist',
  }).id;
}

const statusOf = (fx, id) => taskDb.getTask(fx.db, id).status;

// gh on PATH and the job database pointed at the fixture for the whole test.
function withFixture(fn) {
  const fx = fixture();
  const saved = { PATH: process.env.PATH, ATRIS_TASKS_DB: process.env.ATRIS_TASKS_DB };
  process.env.PATH = `${fx.bin}${path.delimiter}${saved.PATH}`;
  process.env.ATRIS_TASKS_DB = path.join(fx.base, 'tasks.db');
  try {
    return fn(fx);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(fx.base, { recursive: true, force: true });
  }
}

test('queueing a member run remembers which jobs it finishes', () => {
  withFixture((fx) => {
    const dir = path.join(fx.worktree, 'atris', 'runs');
    fs.mkdirSync(dir, { recursive: true });
    const tree = git(['rev-parse', 'HEAD^{tree}'], fx.worktree);
    const at = new Date().toISOString();
    fs.writeFileSync(path.join(dir, `mission-m-1-${at.replace(/[:.]/g, '-')}.json`), JSON.stringify({
      schema: 'atris.mission_receipt.v1', tree_hash: 'x', clean: true, git_tree: tree, mission_id: 'm-1', at,
      result: { kind: 'mission_run_summary', tick_count: 1, ticks: [{
        status: 'ran', tick_index: 1, engine_id: 'claude', verifier_passed: true, reviewed_git_tree: tree,
        referee_result: { passed: true, mode: 'engine', engine: 'codex', output: 'VERDICT: PASS' },
      }] },
    }));
    const out = autolandMemberRun({
      mission: {
        id: 'm-1', objective: 'Tidy the member board so finished work reads plainly',
        runner: 'claude', lane: 'workspace', metadata: {}, task_ids: ['job-a'],
        verifier_result: { passed: true }, worktree: { branch: BRANCH },
        last_tick_at: '2000-01-01T00:00:00.000Z', last_tick_status: 'ran', last_tick_index: 1,
      },
      cwd: fx.worktree,
      loadTask: (id) => ({ id, title: 'Tidy the member board', status: 'review', metadata: {} }),
    });
    assert.equal(out.auto_merge, true, out.line);
    assert.deepEqual(readQueue(fx)[BRANCH].task_ids, ['job-a']);
  });
});

test('a job taken off the list rides to the merge line without gating it', () => {
  withFixture((fx) => {
    const dir = path.join(fx.worktree, 'atris', 'runs');
    fs.mkdirSync(dir, { recursive: true });
    const tree = git(['rev-parse', 'HEAD^{tree}'], fx.worktree);
    const at = new Date().toISOString();
    fs.writeFileSync(path.join(dir, `mission-m-2-${at.replace(/[:.]/g, '-')}.json`), JSON.stringify({
      schema: 'atris.mission_receipt.v1', tree_hash: 'x', clean: true, git_tree: tree, mission_id: 'm-2', at,
      result: { kind: 'mission_run_summary', tick_count: 1, ticks: [{
        status: 'ran', tick_index: 1, engine_id: 'claude', verifier_passed: true, reviewed_git_tree: tree,
        referee_result: { passed: true, mode: 'engine', engine: 'codex', output: 'VERDICT: PASS' },
      }] },
    }));
    // The mission was started from the job's text, so it links no tasks.
    // The job was sent back once; the rework must still land.
    const out = autolandMemberRun({
      mission: {
        id: 'm-2', objective: 'Tidy the member board so finished work reads plainly',
        runner: 'claude', lane: 'workspace', metadata: {},
        verifier_result: { passed: true }, worktree: { branch: BRANCH },
        last_tick_at: '2000-01-01T00:00:00.000Z', last_tick_status: 'ran', last_tick_index: 1,
      },
      cwd: fx.worktree,
      closeTaskIds: ['pulled-job', ' ', 7],
      loadTask: (id) => ({ id, title: 'Tidy the member board', status: 'claimed', metadata: { approval_status: 'revise' } }),
    });
    assert.equal(out.auto_merge, true, out.line);
    assert.deepEqual(readQueue(fx)[BRANCH].task_ids, ['pulled-job']);
  });
});

test('its own change merged: the job closes with no approval and leaves the merge line', () => {
  withFixture((fx) => {
    const a = job(fx, 'review');
    const b = job(fx, 'claimed');
    queue(fx, [a, b]);
    setView(fx, { state: 'MERGED' });
    const out = requeueDroppedAutolands({ cwd: fx.main });
    assert.equal(out.closed, 2, out.line);
    assert.equal(statusOf(fx, a), 'done');
    assert.equal(statusOf(fx, b), 'done');
    assert.match(out.results[0].line, /merged; closed its 2 jobs/);
    assert.match(out.line, /2 finished jobs closed after merging/);
    assert.deepEqual(readQueue(fx), {});
    const event = fx.db.prepare("SELECT actor, payload FROM task_events WHERE task_id = ? AND event_type = 'completed'").get(a);
    assert.equal(event.actor, 'autoland');
    assert.equal(JSON.parse(event.payload).auto_accepted, true);
  });
});

test('merged with someone else\'s push on top: the job stays open for a person', () => {
  withFixture((fx) => {
    const a = job(fx);
    queue(fx, [a]);
    setView(fx, { state: 'MERGED', headRefOid: 'f'.repeat(40) });
    const out = requeueDroppedAutolands({ cwd: fx.main });
    assert.equal(out.closed, 0);
    assert.equal(statusOf(fx, a), 'review');
    assert.match(out.results[0].line, /its job is left for you/);
  });
});

test('still waiting to merge, or closed without merging: the job is not touched', () => {
  for (const view of [{ autoMergeRequest: { enabledAt: 'now' } }, { state: 'CLOSED' }]) {
    withFixture((fx) => {
      const a = job(fx);
      queue(fx, [a]);
      setView(fx, view);
      const out = requeueDroppedAutolands({ cwd: fx.main });
      assert.equal(out.closed, 0);
      assert.equal(statusOf(fx, a), 'review');
    });
  }
});

test('a job a person held while the change waited is not closed by the merge', () => {
  withFixture((fx) => {
    const held = job(fx, 'review');
    const free = job(fx, 'review');
    taskDb.tagTask(fx.db, { id: held, actor: 'keshav', add: ['needs-human'] });
    // Proof prose that names a protected word is not a hold.
    fx.db.prepare('UPDATE tasks SET metadata = ? WHERE id = ?')
      .run(JSON.stringify({ latest_agent_proof: 'confirmed no invoice text changed' }), free);
    queue(fx, [held, free]);
    setView(fx, { state: 'MERGED' });
    const out = requeueDroppedAutolands({ cwd: fx.main });
    assert.equal(out.closed, 1, out.line);
    assert.equal(statusOf(fx, held), 'review');
    assert.equal(statusOf(fx, free), 'done');
  });
});

test('a hold the job picker honors also keeps the job open at merge', () => {
  withFixture((fx) => {
    const held = job(fx, 'review');
    const hashed = job(fx, 'review');
    const lane = job(fx, 'review');
    fx.db.prepare('UPDATE tasks SET metadata = ? WHERE id = ?').run(JSON.stringify({ tag: 'needs-human' }), held);
    fx.db.prepare('UPDATE tasks SET metadata = ? WHERE id = ?').run(JSON.stringify({ tag: '#needs-human' }), hashed);
    fx.db.prepare('UPDATE tasks SET metadata = ? WHERE id = ?').run(JSON.stringify({ body: 'Rotate the stripe refund webhook secret' }), lane);
    queue(fx, [held, hashed, lane]);
    setView(fx, { state: 'MERGED' });
    const out = requeueDroppedAutolands({ cwd: fx.main });
    assert.equal(out.closed, 0, out.line);
    for (const id of [held, hashed, lane]) assert.equal(statusOf(fx, id), 'review');
  });
});

test('member wrap-up reports a job the merge already closed as done', () => {
  withFixture((fx) => {
    const { memberGoFinishTask } = require('../commands/member');
    const id = job(fx, 'claimed');
    taskDb.doneTask(fx.db, { id, actor: 'autoland', allowReview: true, autoAccepted: true, action: 'merged', proof: 'merged' });
    const result = { started: true, mission_id: 'm-3', mission: { status: 'complete', verifier_result: { passed: true } } };
    const out = memberGoFinishTask('generalist', taskDb.getTask(fx.db, id), result);
    assert.equal(out.outcome, 'done');
    assert.equal(statusOf(fx, id), 'done');
  });
});

test('a job already closed, or one that is missing, is not counted twice', () => {
  withFixture((fx) => {
    const done = job(fx, 'done');
    queue(fx, [done, 'no-such-job']);
    setView(fx, { state: 'MERGED' });
    const out = requeueDroppedAutolands({ cwd: fx.main });
    assert.equal(out.closed, 0);
    assert.equal(out.results[0].line, 'pull request #7 (codex/member-work): merged');
    assert.deepEqual(readQueue(fx), {});
  });
});

// The main branch takes a different work.txt, so the member's change clashes.
function clashOnMaster(fx) {
  fs.writeFileSync(path.join(fx.main, 'work.txt'), 'someone else\n');
  git(['add', '.'], fx.main);
  git(['commit', '-qm', 'other work'], fx.main);
  git(['push', '-q', 'origin', 'master'], fx.main);
}

test('a change that clashes with the main branch sends its job back on the list', () => {
  withFixture((fx) => {
    const a = job(fx, 'review');
    queue(fx, [a]);
    clashOnMaster(fx);
    const out = requeueDroppedAutolands({ cwd: fx.main });
    assert.equal(out.results[0].state, 'clash', out.line);
    assert.match(out.results[0].line, /clashes with the main branch in work\.txt; its job went back on the list$/);
    const row = taskDb.getTask(fx.db, a);
    assert.equal(row.status, 'open');
    assert.equal(row.claimed_by, null);
    assert.equal(row.metadata.clash_restarts, 1);
    assert.match(row.metadata.reopen_reason, /pull request #7 could not merge: .*work\.txt; start again/);
    assert.deepEqual(readQueue(fx), {});
  });
});

test('a clash leaves held jobs, jobs not in review, and twice-restarted jobs for a person', () => {
  withFixture((fx) => {
    const held = job(fx, 'review');
    taskDb.tagTask(fx.db, { id: held, actor: 'keshav', add: ['needs-human'] });
    const claimed = job(fx, 'claimed');
    const tired = job(fx, 'review');
    fx.db.prepare('UPDATE tasks SET metadata = ? WHERE id = ?').run(JSON.stringify({ clash_restarts: 2 }), tired);
    queue(fx, [held, claimed, tired, 'no-such-job']);
    clashOnMaster(fx);
    const out = requeueDroppedAutolands({ cwd: fx.main });
    assert.equal(out.results[0].state, 'clash', out.line);
    assert.match(out.results[0].line, /; left for you$/);
    assert.equal(statusOf(fx, held), 'review');
    assert.equal(statusOf(fx, claimed), 'claimed');
    assert.equal(statusOf(fx, tired), 'review');
  });
});

const ghCalls = (fx) => fs.readFileSync(fx.log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));

// The job's redo merges as pull request #8 while the clashing #7 still sits open.
function redoMerges(fx, id, oldView) {
  fs.writeFileSync(queuePath(fx), JSON.stringify({
    schema: 'atris.autoland_queue.v1',
    entries: { [BRANCH]: { branch: BRANCH, base: 'master', number: 8, pushed: fx.pushed, requeues: 0, task_ids: [id] } },
  }));
  const merged = { number: 8, state: 'MERGED', headRefName: BRANCH, baseRefName: 'master', headRefOid: fx.pushed, isCrossRepository: false };
  fs.writeFileSync(fx.config, JSON.stringify({ views: { 8: merged, 7: oldView } }));
  taskDb.claimTask(fx.db, { id, claimedBy: 'generalist' });
  return requeueDroppedAutolands({ cwd: fx.main });
}

test('the clashing change closes itself once its job\'s redo merges', () => {
  withFixture((fx) => {
    const a = job(fx, 'review');
    queue(fx, [a]);
    clashOnMaster(fx);
    requeueDroppedAutolands({ cwd: fx.main });
    assert.deepEqual(taskDb.getTask(fx.db, a).metadata.replaced_pull_requests, [{ number: 7, pushed: fx.pushed }]);
    const out = redoMerges(fx, a, { state: 'OPEN', headRefOid: fx.pushed });
    assert.equal(statusOf(fx, a), 'done', out.line);
    assert.deepEqual(out.results[0].replaced, [7]);
    assert.match(out.results[0].line, /merged; closed its job; closed the clashing change it replaced \(#7\)$/);
    const close = ghCalls(fx).find((args) => args[0] === 'pr' && args[1] === 'close');
    assert.deepEqual(close.slice(0, 3), ['pr', 'close', '7']);
    assert.match(close[4], /Replaced by #8, which merged/);
  });
});

test('a clashing change someone else pushed to, or already closed, stays as it is', () => {
  for (const oldView of [{ state: 'OPEN', headRefOid: 'f'.repeat(40) }, { state: 'CLOSED', headRefOid: null }]) {
    withFixture((fx) => {
      const a = job(fx, 'review');
      queue(fx, [a]);
      clashOnMaster(fx);
      requeueDroppedAutolands({ cwd: fx.main });
      const out = redoMerges(fx, a, oldView);
      assert.equal(statusOf(fx, a), 'done', out.line);
      assert.deepEqual(out.results[0].replaced, []);
      assert.equal(ghCalls(fx).some((args) => args[1] === 'close'), false);
    });
  }
});

// 2026-10-15: the team loop swept for the last time at 07:03 UTC. The
// builder's change #1319 merged at its own commit at 07:05, and its job
// (01M4Z4YVHB) sat in review for a week while 46 mission runs came and went.
// A finished mission run now looks at the merge line too.
const MERGED_1319 = '2026-10-15T07:05:48Z';
const AFTER_1319 = Date.parse('2026-10-15T07:20:00Z');

function builderJob(fx) {
  return taskDb.addTask(fx.db, {
    title: 'next step toward: Members work for hours without a person stepping in.',
    workspaceRoot: fx.main, status: 'review', claimedBy: 'builder',
  }).id;
}

test('a mission run closes a member job whose own change merged while the team loop was down', () => {
  withFixture((fx) => {
    const { sweepAfterMissionRun } = require('../lib/member-autoland');
    const id = builderJob(fx);
    queue(fx, [id]);
    setView(fx, { state: 'MERGED', mergedAt: MERGED_1319 });
    const out = sweepAfterMissionRun({ cwd: fx.worktree, now: AFTER_1319 });
    assert.equal(out.closed, 1, out && out.line);
    assert.equal(statusOf(fx, id), 'done');
    assert.deepEqual(readQueue(fx), {});
  });
});

test('back-to-back mission runs read GitHub once per five minutes', () => {
  withFixture((fx) => {
    const { sweepAfterMissionRun } = require('../lib/member-autoland');
    queue(fx, [builderJob(fx)]);
    sweepAfterMissionRun({ cwd: fx.main, now: AFTER_1319 });
    const reads = () => fs.readFileSync(fx.log, 'utf8').trim().split('\n').length;
    const first = reads();
    assert.equal(sweepAfterMissionRun({ cwd: fx.main, now: AFTER_1319 + 60 * 1000 }).results.length, 0);
    assert.equal(reads(), first);
  });
});

test('a mission run with nothing in the merge line, or self-landing off, never calls GitHub', () => {
  withFixture((fx) => {
    const { sweepAfterMissionRun } = require('../lib/member-autoland');
    assert.equal(sweepAfterMissionRun({ cwd: fx.main, now: AFTER_1319 }), null);
    queue(fx, [builderJob(fx)]);
    fs.writeFileSync(path.join(fx.main, '.atris', 'policy', 'autoland.json'), '{"enabled":false}');
    assert.equal(sweepAfterMissionRun({ cwd: fx.main, now: AFTER_1319 }), null);
    assert.equal(fs.existsSync(fx.log), false);
  });
});

test('a merge more than a day old is left for a person, so old work is not counted as this week\'s', () => {
  withFixture((fx) => {
    const id = builderJob(fx);
    queue(fx, [id]);
    setView(fx, { state: 'MERGED', mergedAt: MERGED_1319 });
    const out = requeueDroppedAutolands({ cwd: fx.main, now: Date.parse('2026-10-22T09:00:00Z') });
    assert.equal(out.closed, 0, out.line);
    assert.equal(statusOf(fx, id), 'review');
    assert.match(out.results[0].line, /merged over a day ago; its job is left for you/);
    assert.deepEqual(readQueue(fx), {});
  });
});

test('a mission run keeps its own timer, so the team loop still gets its turn right after', () => {
  withFixture((fx) => {
    const { sweepAfterMissionRun } = require('../lib/member-autoland');
    const { memberMaintenance } = require('../lib/member-up');
    queue(fx, [builderJob(fx)]);
    sweepAfterMissionRun({ cwd: fx.main, now: AFTER_1319 });
    const state = path.join(fx.main, '.atris', 'state');
    assert.equal(fs.existsSync(path.join(state, 'member-up-maintenance.json')), false);
    let loopRan = false;
    memberMaintenance({ cwd: fx.main, now: AFTER_1319 + 1000, requeueDropped: () => { loopRan = true; return { results: [] }; } });
    assert.equal(loopRan, true);
    assert.equal(fs.existsSync(path.join(state, 'member-up-maintenance.lock')), false);
  });
});
