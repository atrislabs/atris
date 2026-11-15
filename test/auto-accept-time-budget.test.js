'use strict';

// The accept step keeps to the time it is given and carries the rest into the
// next hour. 2026-11-15: in the web project every check is a vitest run of one
// to two and a half minutes on a busy machine. The second check ran up to six
// of them before any accept, the hourly pass killed the run at 300s, the
// receipt said only "timed out", and four jobs ready to land never landed.
// Real repo, real job database, real checks that take real time.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const taskDb = require('../lib/task-db');
const { acceptCommandArgs } = require('../commands/autoland');

const CLI = path.join(__dirname, '..', 'bin', 'atris.js');
const CHECK_MS = 1500;

function git(args, cwd) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout.trim();
}

function project(jobs) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-accept-budget-')));
  const repo = path.join(base, 'repo');
  fs.mkdirSync(path.join(repo, 'test'), { recursive: true });
  git(['init', '-q', '-b', 'master'], repo);
  git(['config', 'user.email', 'test@example.com'], repo);
  git(['config', 'user.name', 'Test'], repo);
  fs.writeFileSync(path.join(repo, '.gitignore'), '.atris/\natris/runs/\natris/logs/\n');
  for (let i = 0; i < jobs; i += 1) {
    fs.writeFileSync(path.join(repo, 'test', `slow-${i}.test.js`),
      `require('node:test')('slow ${i}', () => new Promise((resolve) => setTimeout(resolve, ${CHECK_MS})));\n`);
  }
  git(['add', '.'], repo);
  git(['commit', '-qm', 'init'], repo);
  fs.mkdirSync(path.join(repo, '.atris', 'policy'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.atris', 'policy', 'autoland.json'), JSON.stringify({ enabled: true, enabled_by: 'keshav', accept_all: true }));
  const dbPath = path.join(base, 'tasks.db');
  const tmp = path.join(base, 'tmp');
  fs.mkdirSync(tmp);
  taskDb.close();
  const db = taskDb.open(dbPath);
  const ids = [];
  for (let i = 0; i < jobs; i += 1) {
    const verify = `node --test test/slow-${i}.test.js`;
    const id = taskDb.addTask(db, { title: `slow job ${i}`, workspaceRoot: repo, tag: 'test', metadata: { verify } }).id;
    assert.equal(taskDb.claimTask(db, { id, claimedBy: 'codex' }).claimed, true);
    assert.equal(taskDb.readyTask(db, { id, actor: 'codex', proof: `${'context '.repeat(35)}Checks: ${verify} passed.` }).ready, true);
    ids.push(id);
  }
  return { base, repo, db, dbPath, tmp, ids };
}

function accept(fx, extra = []) {
  const env = { ...process.env, TMPDIR: fx.tmp, ATRIS_TASKS_DB: fx.dbPath, ATRIS_SKIP_UPDATE_CHECK: '1', NODE_NO_WARNINGS: '1', ATRIS_AGENT_PROOF_ONLY: '0' };
  delete env.NODE_TEST_CONTEXT;
  const started = Date.now();
  const res = spawnSync(process.execPath, [CLI, 'task', 'auto-accept-certified', '--json', '--certify-first', '--all', ...extra],
    { cwd: fx.repo, encoding: 'utf8', env, timeout: 240000 });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  return { out: JSON.parse(res.stdout), ms: Date.now() - started };
}

const status = (fx) => fx.ids.map((id) => taskDb.getTask(fx.db, id).status);

test('a run given a time budget stops starting checks in time, answers, and the next run finishes the rest', () => {
  const fx = project(4);
  try {
    const { out } = accept(fx, ['--budget-ms', String(CHECK_MS)]);
    const deferred = Number(out.deferred || 0) + Number(out.certification?.deferred || 0);
    assert.ok(deferred >= 1, `checks past the budget wait for the next run: ${JSON.stringify(out.certification?.results)}`);
    const certifyRuns = (out.certification?.results || []).filter((r) => ['certified', 'pass_recorded', 'verify_failed'].includes(r.action)).length;
    assert.ok(certifyRuns < fx.ids.length, 'not every check ran inside the budget');
    // Every job the accept step looked at is named: accepted, skipped with a reason, or left for later.
    assert.equal(out.results.length, out.scanned);
    assert.ok(out.results.every((r) => r.action && r.reason), JSON.stringify(out.results));
    // The next hour carries on. With time to spare, everything lands.
    for (let hour = 0; hour < 3 && status(fx).includes('review'); hour += 1) accept(fx);
    assert.deepEqual(status(fx), fx.ids.map(() => 'done'));
  } finally {
    taskDb.close();
    fs.rmSync(fx.base, { recursive: true, force: true });
  }
});

test('the hourly pass hands the accept step its time limit, less room to answer', () => {
  const args = acceptCommandArgs({ accept_all: true }, 300000);
  const at = args.indexOf('--budget-ms');
  assert.ok(at > 0, JSON.stringify(args));
  assert.equal(Number(args[at + 1]), 240000);
  assert.ok(!acceptCommandArgs({}, 0).includes('--budget-ms'));
});
