'use strict';

// The second check and the landing re-check run against the job's own code,
// in a scratch copy that is removed after. They used to run in the main
// folder, so a job whose test lives only on its own branch failed every hour
// because the test file was not there. Real repo, real job database.

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

// master has no copy of the job's test; the job's branch adds it.
function project() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-certify-job-code-')));
  const repo = path.join(base, 'repo');
  fs.mkdirSync(path.join(repo, 'atris'), { recursive: true });
  git(['init', '-q', '-b', 'master'], repo);
  git(['config', 'user.email', 'test@example.com'], repo);
  git(['config', 'user.name', 'Test'], repo);
  fs.writeFileSync(path.join(repo, '.gitignore'), '.atris/\natris/runs/\n');
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
  git(['add', '.'], repo);
  git(['commit', '-qm', 'init'], repo);
  const start = git(['rev-parse', 'HEAD'], repo);
  git(['checkout', '-q', '-b', 'codex/builder-branch-only'], repo);
  fs.mkdirSync(path.join(repo, 'test'));
  fs.writeFileSync(path.join(repo, 'test', 'branch-only.test.js'), 'require("node:test")("lives on the branch", () => {});\n');
  git(['add', '.'], repo);
  git(['commit', '-qm', 'member work with its own test'], repo);
  const work = git(['rev-parse', 'HEAD'], repo);
  git(['checkout', '-q', 'master'], repo);
  const dbPath = path.join(base, 'tasks.db');
  taskDb.close();
  const db = taskDb.open(dbPath);
  return { base, repo, start, work, db, dbPath };
}

function reviewJob(fx) {
  const verify = 'node --test test/branch-only.test.js';
  const id = taskDb.addTask(fx.db, { title: 'Branch-only check', workspaceRoot: fx.repo, tag: 'test', metadata: { verify } }).id;
  assert.equal(taskDb.claimTask(fx.db, { id, claimedBy: 'codex' }).claimed, true);
  const proof = `${'context '.repeat(35)}Checks: ${verify} passed.`;
  assert.equal(taskDb.readyTask(fx.db, { id, actor: 'codex', proof }).ready, true);
  // The builder worked on its branch: its commit is the job's own code.
  const row = taskDb.getTask(fx.db, id);
  fx.db.prepare('UPDATE tasks SET metadata = ? WHERE id = ?')
    .run(JSON.stringify({ ...row.metadata, start_commit: fx.start, work_commit: fx.work }), id);
  return id;
}

function cli(fx, args) {
  const env = { ...process.env, ATRIS_TASKS_DB: fx.dbPath, ATRIS_SKIP_UPDATE_CHECK: '1', NODE_NO_WARNINGS: '1', ATRIS_AGENT_PROOF_ONLY: '0' };
  delete env.NODE_TEST_CONTEXT;
  const res = spawnSync(process.execPath, [CLI, ...args], { cwd: fx.repo, encoding: 'utf8', env, timeout: 240000 });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  return JSON.parse(res.stdout);
}

const scratchDirs = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('atris-job-check-')).sort();

test('the second check runs the test that lives only on the job\'s branch, then cleans up', () => {
  const fx = project();
  const before = scratchDirs();
  try {
    const id = reviewJob(fx);
    const out = cli(fx, ['task', 'certify-verified', '--json']);
    const row = out.results.find((r) => r.verify === 'node --test test/branch-only.test.js');
    assert.ok(row && ['certified', 'pass_recorded'].includes(row.action), JSON.stringify(out.results));
    const cache = taskDb.getTask(fx.db, id).metadata.verify_cache;
    assert.equal(cache.ok, true);
    assert.equal(cache.code_sha, fx.work, 'the check names the code it ran on');
    assert.equal(git(['worktree', 'list', '--porcelain'], fx.repo).split('\n').filter((l) => l.startsWith('worktree ')).length, 1);
    assert.deepEqual(scratchDirs().filter((n) => !before.includes(n)), [], 'no scratch copy left behind');
    assert.equal(fs.existsSync(path.join(fx.repo, 'test', 'branch-only.test.js')), false, 'the main folder is untouched');
  } finally {
    taskDb.close();
    fs.rmSync(fx.base, { recursive: true, force: true });
  }
});

// Codex review, 2026-10-22.
test('a recorded commit this repo no longer holds is a check that cannot run, not a main-folder run', () => {
  const fx = project();
  try {
    const id = reviewJob(fx);
    const row = taskDb.getTask(fx.db, id);
    fx.db.prepare('UPDATE tasks SET metadata = ? WHERE id = ?')
      .run(JSON.stringify({ ...row.metadata, work_commit: 'f'.repeat(40) }), id);
    // Even with the test on master, the job is not judged by the main folder.
    git(['merge', '-q', '--no-ff', '-m', 'merge', 'codex/builder-branch-only'], fx.repo);
    const out = cli(fx, ['task', 'certify-verified', '--json']);
    assert.equal(out.results[0].action, 'verify_failed', JSON.stringify(out.results));
    assert.equal(taskDb.getTask(fx.db, id).metadata.verify_cache.reason, 'verify_unrunnable');
  } finally {
    taskDb.close();
    fs.rmSync(fx.base, { recursive: true, force: true });
  }
});

test('the commit autoland queued wins over the builder\'s stamp, and a job in a subfolder runs there', () => {
  const fx = project();
  try {
    // The queued catch-up adds the subfolder project's own test.
    git(['checkout', '-q', 'codex/builder-branch-only'], fx.repo);
    fs.mkdirSync(path.join(fx.repo, 'backend', 'test'), { recursive: true });
    fs.writeFileSync(path.join(fx.repo, 'backend', 'test', 'branch-only.test.js'), 'require("node:test")("backend copy", () => {});\n');
    git(['add', '.'], fx.repo);
    git(['commit', '-qm', 'catch-up with the backend test'], fx.repo);
    const queued = git(['rev-parse', 'HEAD'], fx.repo);
    git(['checkout', '-q', 'master'], fx.repo);
    // A nested project of its own inside the repo.
    fs.mkdirSync(path.join(fx.repo, 'backend', 'atris'), { recursive: true });
    fs.writeFileSync(path.join(fx.repo, 'backend', 'atris', 'atris.md'), '# backend\n');
    fs.mkdirSync(path.join(fx.repo, '.atris', 'state'), { recursive: true });
    const verify = 'node --test test/branch-only.test.js';
    const backend = path.join(fx.repo, 'backend');
    const id = taskDb.addTask(fx.db, { title: 'Backend check', workspaceRoot: backend, tag: 'test', metadata: { verify } }).id;
    taskDb.claimTask(fx.db, { id, claimedBy: 'codex' });
    taskDb.readyTask(fx.db, { id, actor: 'codex', proof: `${'context '.repeat(35)}Checks: ${verify} passed.` });
    const row = taskDb.getTask(fx.db, id);
    fx.db.prepare('UPDATE tasks SET metadata = ? WHERE id = ?')
      .run(JSON.stringify({ ...row.metadata, start_commit: fx.start, work_commit: fx.work }), id);
    fs.writeFileSync(path.join(fx.repo, '.atris', 'state', 'autoland-queue.json'), JSON.stringify({
      schema: 'atris.autoland_queue.v1',
      entries: { 'codex/builder-branch-only': { branch: 'codex/builder-branch-only', base: 'master', number: 7, pushed: queued, task_ids: [id] } },
    }));
    const env = { ...process.env, ATRIS_TASKS_DB: fx.dbPath, ATRIS_SKIP_UPDATE_CHECK: '1', NODE_NO_WARNINGS: '1', ATRIS_AGENT_PROOF_ONLY: '0' };
    delete env.NODE_TEST_CONTEXT;
    const res = spawnSync(process.execPath, [CLI, 'task', 'certify-verified', '--json'], { cwd: backend, encoding: 'utf8', env, timeout: 240000 });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const cache = taskDb.getTask(fx.db, id).metadata.verify_cache;
    assert.equal(cache.ok, true, JSON.stringify(JSON.parse(res.stdout).results));
    assert.equal(cache.code_sha, queued);
    assert.equal(cache.code_source, 'queued_branch');
  } finally {
    taskDb.close();
    fs.rmSync(fx.base, { recursive: true, force: true });
  }
});

test('a scratch copy left by a killed pass is cleaned up by the next one', () => {
  const fx = project();
  try {
    const stale = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-job-check-'));
    git(['worktree', 'add', '-q', '--detach', stale, fx.work], fx.repo);
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    fs.utimesSync(stale, old, old);
    reviewJob(fx);
    cli(fx, ['task', 'certify-verified', '--json']);
    assert.equal(fs.existsSync(stale), false);
    assert.equal(git(['worktree', 'list', '--porcelain'], fx.repo).split('\n').filter((l) => l.startsWith('worktree ')).length, 1);
  } finally {
    taskDb.close();
    fs.rmSync(fx.base, { recursive: true, force: true });
  }
});

test('the landing pass checks and lands the job against its own code too', () => {
  const fx = project();
  try {
    reviewJob(fx);
    fs.mkdirSync(path.join(fx.repo, '.atris', 'policy'), { recursive: true });
    fs.writeFileSync(path.join(fx.repo, '.atris', 'policy', 'autoland.json'), JSON.stringify({ enabled: true, enabled_by: 'keshav', strict_verify: true }));
    const out = cli(fx, ['task', 'auto-accept-certified', '--json', '--certify-first']);
    const accepted = out.results.find((r) => r.action === 'accepted');
    assert.ok(accepted, JSON.stringify({ results: out.results, certification: out.certification && out.certification.results }));
  } finally {
    taskDb.close();
    fs.rmSync(fx.base, { recursive: true, force: true });
  }
});
