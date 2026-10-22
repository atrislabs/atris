'use strict';

// The hourly landing pass closes jobs whose change already merged, with no
// team loop running. Real git repos and a real job database; nothing faked
// except GitHub where a pull request is read.
//
// 2026-10-22: four atris-cli jobs sat in review a week after their change
// merged. Two were still on the autoland list (#1318, #1319, merged
// 2026-10-15 07:05 UTC); two had left it, and only git could say they landed
// (01M4YP603G added test/member-close-on-merge.test.js, 01M4X3XRV8 added
// test/member-steer-short-job.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const taskDb = require('../lib/task-db');

const CLI = path.join(__dirname, '..', 'bin', 'atris.js');

function git(args, cwd, env = {}) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout.trim();
}

const at = (iso) => ({ GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso });

// A repo whose master took one member change through a merge commit.
function project() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-tick-merged-')));
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo);
  git(['init', '-q', '-b', 'master'], repo);
  git(['config', 'user.email', 'test@example.com'], repo);
  git(['config', 'user.name', 'Test'], repo);
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), '.atris/\natris/runs/\natris/logs/\n');
  fs.mkdirSync(path.join(repo, 'test'));
  fs.writeFileSync(path.join(repo, 'test', 'old.test.js'), 'require("node:test")("old", () => {});\n');
  git(['add', '.'], repo);
  git(['commit', '-qm', 'init'], repo, at('2026-10-14T00:00:00Z'));
  const start = git(['rev-parse', 'HEAD'], repo);
  fs.mkdirSync(path.join(repo, '.atris', 'policy'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.atris', 'policy', 'autoland.json'), JSON.stringify({
    enabled: true, enabled_by: 'keshav', daily_experiment: false, janitor: false, green_landing: false, map_fold: false,
  }));
  const dbPath = path.join(base, 'tasks.db');
  taskDb.close();
  const db = taskDb.open(dbPath);
  return { base, repo, start, db, dbPath };
}

// A member branch with one commit, merged into master with a merge commit.
function mergeMemberWork(fx, { file, branch, when }) {
  git(['checkout', '-q', '-b', branch, fx.start], fx.repo);
  fs.mkdirSync(path.dirname(path.join(fx.repo, file)), { recursive: true });
  fs.writeFileSync(path.join(fx.repo, file), 'require("node:test")("new", () => {});\n');
  git(['add', '.'], fx.repo);
  git(['commit', '-qm', `member work ${branch}`], fx.repo, at(when));
  const work = git(['rev-parse', 'HEAD'], fx.repo);
  git(['checkout', '-q', 'master'], fx.repo);
  git(['merge', '-q', '--no-ff', '-m', `Merge ${branch}`, branch], fx.repo, at(when));
  return work;
}

function reviewJob(fx, { title, metadata, createdAt }) {
  const id = taskDb.addTask(fx.db, {
    title, workspaceRoot: fx.repo, status: 'review', claimedBy: 'builder', metadata: { approval_status: 'pending', ...metadata },
  }).id;
  if (createdAt) fx.db.prepare('UPDATE tasks SET created_at = ? WHERE id = ?').run(Date.parse(createdAt), id);
  return id;
}

function done(fx, id) {
  const row = taskDb.getTask(fx.db, id);
  return row.status;
}

function lastAction(fx, id) {
  const events = taskDb.listTaskEvents(fx.db, { taskId: id }).filter((e) => e.event_type === 'completed');
  return events.length ? events[events.length - 1].payload.action : null;
}

function tick(fx, args = []) {
  const env = { ...process.env, ATRIS_TASKS_DB: fx.dbPath, ATRIS_SKIP_UPDATE_CHECK: '1' };
  delete env.NODE_TEST_CONTEXT;
  delete env.ATRIS_AGENT_PROOF_ONLY;
  const res = spawnSync(process.execPath, [CLI, 'autoland', 'tick', '--json', ...args], { cwd: fx.repo, encoding: 'utf8', env, timeout: 240000 });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  return JSON.parse(res.stdout.trim().split('\n').pop());
}

function cleanup(fx) {
  taskDb.close();
  fs.rmSync(fx.base, { recursive: true, force: true });
}

test('the hourly pass closes a review job whose own commit merged, and leaves the rest', () => {
  const fx = project();
  try {
    const work = mergeMemberWork(fx, { file: 'lib/closer.js', branch: 'codex/builder-closer', when: '2026-10-15T07:05:00Z' });
    const merged = reviewJob(fx, { title: 'A clashing member change closes itself', metadata: { work_commit: work, start_commit: fx.start } });
    // Finished on the commit it started from: no change of its own.
    const noChange = reviewJob(fx, { title: 'next step toward: members work for hours', metadata: { work_commit: fx.start, start_commit: fx.start } });
    // A commit on the main line itself proves nothing: the main folder's head.
    const mainLine = reviewJob(fx, { title: 'built in the main folder', metadata: { work_commit: git(['rev-parse', 'HEAD'], fx.repo), start_commit: fx.start } });
    // Held for a person: never closed by the pass.
    const held = reviewJob(fx, { title: 'Wire the vendor payment', metadata: { work_commit: work, start_commit: fx.start, tags: ['needs-human'] } });

    const receipt = tick(fx);
    assert.equal(done(fx, merged), 'done', JSON.stringify(receipt.merged_close));
    assert.equal(lastAction(fx, merged), 'merged_earlier', 'a week-old merge is not this week\'s landing');
    assert.equal(done(fx, noChange), 'review');
    assert.equal(done(fx, mainLine), 'review');
    assert.equal(done(fx, held), 'review');
    assert.deepEqual(receipt.merged_close.closed.map((c) => c.id), [merged]);
  } finally {
    cleanup(fx);
  }
});

test('a job whose check file landed after it was written closes; an older check file does not count', () => {
  const fx = project();
  try {
    const job = reviewJob(fx, {
      title: 'Read notes that arrive during a short member job',
      metadata: { verify: 'node --test test/member-steer-short-job.test.js' },
      createdAt: '2026-10-14T11:49:22Z',
    });
    const oldCheck = reviewJob(fx, {
      title: 'Avoid repeated task creation in landing tests',
      metadata: { verify: 'node --test test/old.test.js' },
      createdAt: '2026-10-14T07:15:48Z',
    });
    mergeMemberWork(fx, { file: 'test/member-steer-short-job.test.js', branch: 'codex/architect-notes', when: '2026-10-14T12:05:28Z' });

    tick(fx);
    assert.equal(done(fx, job), 'done');
    assert.equal(done(fx, oldCheck), 'review');
  } finally {
    cleanup(fx);
  }
});

test('a merge from the last day counts as merged', () => {
  const fx = project();
  try {
    const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const work = mergeMemberWork(fx, { file: 'lib/fresh.js', branch: 'codex/builder-fresh', when: recent });
    const id = reviewJob(fx, { title: 'fresh work', metadata: { work_commit: work, start_commit: fx.start } });
    tick(fx);
    assert.equal(done(fx, id), 'done');
    assert.equal(lastAction(fx, id), 'merged');
  } finally {
    cleanup(fx);
  }
});

test('the dry run names what would close and closes nothing', () => {
  const fx = project();
  try {
    const work = mergeMemberWork(fx, { file: 'lib/closer.js', branch: 'codex/builder-closer', when: '2026-10-15T07:05:00Z' });
    const id = reviewJob(fx, { title: 'A clashing member change closes itself', metadata: { work_commit: work, start_commit: fx.start } });
    const preview = tick(fx, ['--dry-run']);
    assert.equal(preview.dry_run, true);
    assert.deepEqual(preview.merged_close.would_close.map((c) => c.id), [id]);
    assert.ok(Array.isArray(preview.second_check.would_check), JSON.stringify(preview));
    assert.equal(preview.second_check_error, undefined);
    assert.equal(done(fx, id), 'review');
    assert.equal(fs.existsSync(path.join(fx.repo, '.atris', 'state', 'tasks.projection.json')), false, 'a dry run writes no task list');
    assert.equal(fs.existsSync(path.join(fx.repo, 'atris', 'runs')), false, 'a dry run writes no receipt');
  } finally {
    cleanup(fx);
  }
});
