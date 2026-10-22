'use strict';

// The second check never starves the review queue. It used to take the six
// most recently touched review jobs, and a failed check stamped the job as
// touched, so the same six failing jobs won every hour and the rest of the
// queue was never checked (2026-10-22: all 28 atris-cli review jobs at
// not_agent_certified). Real repo, real job database, real checks.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const taskDb = require('../lib/task-db');

const CLI = path.join(__dirname, '..', 'bin', 'atris.js');

function git(args, cwd) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout.trim();
}

function project() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-certify-starve-')));
  const repo = path.join(base, 'repo');
  fs.mkdirSync(path.join(repo, 'test'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'atris'), { recursive: true });
  git(['init', '-q', '-b', 'master'], repo);
  git(['config', 'user.email', 'test@example.com'], repo);
  git(['config', 'user.name', 'Test'], repo);
  fs.writeFileSync(path.join(repo, '.gitignore'), '.atris/\n');
  fs.writeFileSync(path.join(repo, 'test', 'pass.test.js'), 'require("node:test")("passes", () => {});\n');
  fs.writeFileSync(path.join(repo, 'test', 'fail.test.js'), 'require("node:test")("fails", () => { throw new Error("red"); });\n');
  git(['add', '.'], repo);
  git(['commit', '-qm', 'init'], repo);
  const dbPath = path.join(base, 'tasks.db');
  taskDb.close();
  const db = taskDb.open(dbPath);
  return { base, repo, db, dbPath };
}

// A review job a builder finished with one pass, waiting on a second check.
function reviewJob(fx, title, verify, updatedAt) {
  const id = taskDb.addTask(fx.db, { title, workspaceRoot: fx.repo, tag: 'test', metadata: { verify } }).id;
  assert.equal(taskDb.claimTask(fx.db, { id, claimedBy: 'codex' }).claimed, true);
  const proof = `${'context '.repeat(35)}Checks: ${verify} passed.`;
  assert.equal(taskDb.readyTask(fx.db, { id, actor: 'codex', proof }).ready, true);
  fx.db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(updatedAt, id);
  return id;
}

function certify(fx) {
  const env = { ...process.env, ATRIS_TASKS_DB: fx.dbPath, ATRIS_SKIP_UPDATE_CHECK: '1', NODE_NO_WARNINGS: '1', ATRIS_AGENT_PROOF_ONLY: '0' };
  delete env.NODE_TEST_CONTEXT;
  const res = spawnSync(process.execPath, [CLI, 'task', 'certify-verified', '--json'], { cwd: fx.repo, encoding: 'utf8', env, timeout: 240000 });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  return JSON.parse(res.stdout);
}

const meta = (fx, id) => taskDb.getTask(fx.db, id).metadata || {};

test('two hourly passes reach every job: oldest checks first, a failure on the same code waits', () => {
  const fx = project();
  try {
    const now = Date.now();
    const passing = [0, 1].map((i) => reviewJob(fx, `Older passing job ${i}`, 'node --test test/pass.test.js', now - 3 * 60 * 60 * 1000 - i));
    const failing = Array.from({ length: 8 }, (_, i) => reviewJob(fx, `Newer failing job ${i}`, 'node --test test/fail.test.js', now - i * 1000));
    const before = new Map(failing.map((id) => [id, taskDb.getTask(fx.db, id).updated_at]));

    const first = certify(fx);
    const second = certify(fx);

    for (const id of passing) {
      assert.equal(meta(fx, id).verify_cache?.ok, true, `passing job ${id} was never checked: ${JSON.stringify([first.results, second.results])}`);
    }
    const checked = failing.filter((id) => meta(fx, id).verify_cache);
    assert.equal(checked.length, 8, 'every failing job got its turn within two passes');
    // A failed check is not a touch: it does not jump the job to the front.
    for (const id of failing) assert.equal(taskDb.getTask(fx.db, id).updated_at, before.get(id));
    // The second pass did not rerun a job that already failed on this code.
    const reran = second.results.filter((r) => r.action === 'verify_failed');
    assert.equal(reran.length, 4, JSON.stringify(second.results));
    assert.ok(second.results.some((r) => r.reason === 'failed_on_this_code'));
  } finally {
    taskDb.close();
    fs.rmSync(fx.base, { recursive: true, force: true });
  }
});

test('a job that failed is checked again once its code changes', () => {
  const fx = project();
  try {
    const id = reviewJob(fx, 'Failing then fixed', 'node --test test/fail.test.js', Date.now());
    assert.equal(certify(fx).results.find((r) => r.action === 'verify_failed')?.verify, 'node --test test/fail.test.js');
    assert.equal(certify(fx).results[0].reason, 'failed_on_this_code');
    fs.writeFileSync(path.join(fx.repo, 'test', 'fail.test.js'), 'require("node:test")("fixed", () => {});\n');
    git(['commit', '-qam', 'fix'], fx.repo);
    certify(fx);
    assert.equal(meta(fx, id).verify_cache.ok, true);
  } finally {
    taskDb.close();
    fs.rmSync(fx.base, { recursive: true, force: true });
  }
});
