'use strict';

// A failed second check is tried again once anything it depends on moves.
//
// CLI-1473 (2026-11-12): the second check of a job failed once on a loaded
// machine. The skip key was the job's own commit, which never changes after
// hand-in, so every hourly pass after said "failed on this code" and nobody
// was asked again, while the same check passed on the same commit (22 of 22
// on 2026-11-15) and the work was already merged. Real repo, real job
// database, real checks, the real command the hourly pass runs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const taskDb = require('../lib/task-db');

const CLI = path.join(__dirname, '..', 'bin', 'atris.js');
const VERIFY = 'node --test test/motion.test.js';

function git(args, cwd) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout.trim();
}

// A repo whose job lives on its own branch. Its test fails only while a
// marker file outside the repo exists: the slow machine of that night.
function project() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-failed-check-')));
  const repo = path.join(base, 'repo');
  const slow = path.join(base, 'slow-machine');
  fs.mkdirSync(path.join(repo, 'test'), { recursive: true });
  git(['init', '-q', '-b', 'master'], repo);
  git(['config', 'user.email', 'test@example.com'], repo);
  git(['config', 'user.name', 'Test'], repo);
  fs.writeFileSync(path.join(repo, '.gitignore'), '.atris/\n');
  fs.writeFileSync(path.join(repo, 'README.md'), 'start\n');
  git(['add', '.'], repo);
  git(['commit', '-qm', 'init'], repo);
  const start = git(['rev-parse', 'HEAD'], repo);
  git(['checkout', '-q', '-b', 'job'], repo);
  fs.writeFileSync(path.join(repo, 'test', 'motion.test.js'),
    `require("node:test")("frames hold", () => { if (require("node:fs").existsSync(${JSON.stringify(slow)})) throw new Error("slow frame"); });\n`);
  git(['add', '.'], repo);
  git(['commit', '-qm', 'job work'], repo);
  const work = git(['rev-parse', 'HEAD'], repo);
  git(['checkout', '-q', 'master'], repo);
  const dbPath = path.join(base, 'tasks.db');
  taskDb.close();
  const db = taskDb.open(dbPath);
  return { base, repo, slow, start, work, db, dbPath };
}

function reviewJob(fx, title = 'Motion checks stop failing on slow runs') {
  const id = taskDb.addTask(fx.db, { title, workspaceRoot: fx.repo, tag: 'test', metadata: { verify: VERIFY } }).id;
  assert.equal(taskDb.claimTask(fx.db, { id, claimedBy: 'builder' }).claimed, true);
  const proof = `${'context '.repeat(35)}Checks: ${VERIFY} passed.`;
  assert.equal(taskDb.readyTask(fx.db, { id, actor: 'builder', proof }).ready, true);
  taskDb.updateTaskMetadata(fx.db, id, (metadata) => {
    metadata.work_commit = fx.work;
    metadata.start_commit = fx.start;
  });
  return id;
}

function certify(fx) {
  const env = { ...process.env, ATRIS_TASKS_DB: fx.dbPath, ATRIS_SKIP_UPDATE_CHECK: '1', NODE_NO_WARNINGS: '1', ATRIS_AGENT_PROOF_ONLY: '0' };
  delete env.NODE_TEST_CONTEXT;
  const res = spawnSync(process.execPath, [CLI, 'task', 'certify-verified', '--json'], { cwd: fx.repo, encoding: 'utf8', env, timeout: 240000 });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  return JSON.parse(res.stdout).results;
}

const cache = (fx, id) => (taskDb.getTask(fx.db, id).metadata || {}).verify_cache || {};

test('a check that failed on a slow night is checked again once the main line moves', () => {
  const fx = project();
  try {
    const id = reviewJob(fx);
    fs.writeFileSync(fx.slow, '1');
    assert.equal(certify(fx)[0].action, 'verify_failed');
    assert.equal(cache(fx, id).code_sha, fx.work, 'the check ran on the job\'s own commit');
    fs.rmSync(fx.slow);

    // Nothing moved: the failure still stands, no rerun every hour.
    assert.equal(certify(fx)[0].reason, 'failed_on_this_code');

    // The work merges and the main line moves. The job's commit is the same.
    git(['merge', '-q', '--no-ff', 'job', '-m', 'merge job'], fx.repo);
    const results = certify(fx);
    assert.equal(results[0].action, 'certified', JSON.stringify(results));
    assert.equal(cache(fx, id).ok, true);
    assert.equal(cache(fx, id).code_sha, fx.work);
  } finally {
    taskDb.close();
    fs.rmSync(fx.base, { recursive: true, force: true });
  }
});

test('a failure recorded before the main line was kept, or over a day ago, is checked again', () => {
  const fx = project();
  try {
    const id = reviewJob(fx);
    const old = { command: VERIFY, ok: false, reason: 'verify_failed', ran_by: 'autoland-verifier', code_sha: fx.work, code_source: 'work_commit' };
    // The exact shape CLI-1473 carried: no main line on the failure.
    taskDb.updateTaskMetadata(fx.db, id, (metadata) => { metadata.verify_cache = { ...old, ran_at: new Date().toISOString() }; }, { touch: false });
    assert.equal(certify(fx)[0].action, 'certified');

    const again = reviewJob(fx, 'Motion checks hold on the second phone too');
    const main = git(['rev-parse', 'master'], fx.repo);
    const dayAgo = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    taskDb.updateTaskMetadata(fx.db, again, (metadata) => { metadata.verify_cache = { ...old, main_sha: main, ran_at: dayAgo }; }, { touch: false });
    const results = certify(fx);
    assert.equal(results.find((r) => r.action === 'certified')?.verify, VERIFY, JSON.stringify(results));
    assert.equal(cache(fx, again).ok, true);
  } finally {
    taskDb.close();
    fs.rmSync(fx.base, { recursive: true, force: true });
  }
});
