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
    "if (a === 'pr' && b === 'view') { if (!cfg.view) process.exit(1); console.log(JSON.stringify(cfg.view)); }",
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
    queue(fx, [held, free]);
    setView(fx, { state: 'MERGED' });
    const out = requeueDroppedAutolands({ cwd: fx.main });
    assert.equal(out.closed, 1, out.line);
    assert.equal(statusOf(fx, held), 'review');
    assert.equal(statusOf(fx, free), 'done');
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
