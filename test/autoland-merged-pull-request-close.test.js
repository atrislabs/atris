'use strict';

// A job whose own pull request merged closes itself on the next hourly pass,
// in any project, from what GitHub says about that exact pull request.
//
// 2026-11-15: 26 backend jobs sat in review after their pull requests were
// settled on GitHub (23 merged, 2 closed unmerged). The jobs name their pull
// request in their proof, often in another repository and squash merged, so
// the git pass could never see them land. Real git repo, real job database,
// real tick; only gh is a stand-in, a small script first on the PATH.

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

// gh answers `pr view <link>` and `repo view <link>` from a file of answers;
// anything else fails, the way gh does for a question it cannot answer.
const FAKE_GH = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + '\\n');
const answers = JSON.parse(fs.readFileSync(process.env.FAKE_GH_ANSWERS, 'utf8'));
if (answers.outage) { process.stderr.write('gh: command not found\\n'); process.exit(127); }
if (args[0] === 'pr' && args[1] === 'view' && answers.pulls[args[2]]) {
  process.stdout.write(JSON.stringify(answers.pulls[args[2]]));
  process.exit(0);
}
if (args[0] === 'repo' && args[1] === 'view') {
  process.stdout.write(JSON.stringify({ defaultBranchRef: { name: 'master' } }));
  process.exit(0);
}
process.stderr.write('no such pull request\\n');
process.exit(1);
`;

function project() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-tick-merged-pr-')));
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo);
  git(['init', '-q', '-b', 'master'], repo);
  git(['config', 'user.email', 'test@example.com'], repo);
  git(['config', 'user.name', 'Test'], repo);
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), '.atris/\natris/runs/\natris/logs/\n');
  git(['add', '.'], repo);
  git(['commit', '-qm', 'init'], repo);
  fs.mkdirSync(path.join(repo, '.atris', 'policy'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.atris', 'policy', 'autoland.json'), JSON.stringify({
    enabled: true, enabled_by: 'keshav', daily_experiment: false, janitor: false, green_landing: false, map_fold: false,
  }));
  const bin = path.join(base, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), FAKE_GH, { mode: 0o755 });
  const dbPath = path.join(base, 'tasks.db');
  taskDb.close();
  const db = taskDb.open(dbPath);
  return { base, repo, bin, db, dbPath, answers: path.join(base, 'answers.json'), log: path.join(base, 'gh.log'), pulls: {} };
}

function pull(fx, url, { state, mergedAt = null, base = 'master', number }) {
  const [, owner, name] = /github\.com\/([^/]+)\/([^/]+)\/pull/.exec(url);
  fx.pulls[url] = {
    state,
    number: number || Number(url.split('/').pop()),
    url,
    mergeCommit: state === 'MERGED' ? { oid: 'a'.repeat(40) } : null,
    mergedAt,
    mergedBy: state === 'MERGED' ? { login: 'someone' } : null,
    headRefName: 'atris/the-fix-20261114-2153-98b4',
    headRepository: { name },
    headRepositoryOwner: { login: owner },
    baseRefName: base,
  };
}

function reviewJob(fx, { title, proof, metadata = {}, tag = null, createdAt = '2026-11-09T20:00:00Z' }) {
  const id = taskDb.addTask(fx.db, {
    title, tag, workspaceRoot: fx.repo, status: 'review', claimedBy: 'executor',
    metadata: { approval_status: 'pending', latest_agent_proof: proof, ...metadata },
  }).id;
  fx.db.prepare('UPDATE tasks SET created_at = ? WHERE id = ?').run(Date.parse(createdAt), id);
  return id;
}

const statusOf = (fx, id) => taskDb.getTask(fx.db, id).status;

function lastEvent(fx, id, type) {
  const events = taskDb.listTaskEvents(fx.db, { taskId: id }).filter((e) => e.event_type === type);
  return events.length ? events[events.length - 1].payload : null;
}

function tick(fx, args = [], { outage = false } = {}) {
  fs.writeFileSync(fx.answers, JSON.stringify({ pulls: fx.pulls, outage }));
  const env = {
    ...process.env,
    PATH: `${fx.bin}${path.delimiter}${process.env.PATH}`,
    ATRIS_TASKS_DB: fx.dbPath,
    ATRIS_SKIP_UPDATE_CHECK: '1',
    FAKE_GH_ANSWERS: fx.answers,
    FAKE_GH_LOG: fx.log,
  };
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

const LINK = (repo, n) => `https://github.com/atrislabs/${repo}/pull/${n}`;
const ready = (url) => `Fixed: the feed card is no longer stuck. Pull request ready in 2m 4s. ${url}`;

test('a job whose recorded pull request merged closes; one closed unmerged goes back on the list, never done', () => {
  const fx = project();
  try {
    // Another repository, squash merged: git in this repo can never see it.
    pull(fx, LINK('ai-leaderboards', 28), { state: 'MERGED', mergedAt: '2026-11-10T09:14:20Z' });
    pull(fx, LINK('atris', 1877), { state: 'CLOSED' });
    pull(fx, LINK('repo', 5487), { state: 'OPEN' });
    const merged = reviewJob(fx, { title: 'The Best value section opens with a wall of lists', proof: ready(LINK('ai-leaderboards', 28)) });
    const closedUnmerged = reviewJob(fx, { title: 'A desktop feed card stays on working forever', proof: ready(LINK('atris', 1877)) });
    const open = reviewJob(fx, { title: 'grpcio is hit by an advisory', proof: ready(LINK('repo', 5487)) });

    const receipt = tick(fx);
    const mc = receipt.merged_close;
    assert.equal(statusOf(fx, merged), 'done', JSON.stringify(mc));
    assert.equal(lastEvent(fx, merged, 'completed').action, 'merged_earlier', 'a merge over a day old is not a new landing');
    assert.equal(taskDb.getTask(fx.db, merged).metadata.pull_request.state, 'merged', 'the merge is written on the row');
    assert.deepEqual(mc.closed.map((c) => c.id), [merged]);

    assert.notEqual(statusOf(fx, closedUnmerged), 'done', 'a pull request closed without merging never counts as done');
    assert.equal(statusOf(fx, closedUnmerged), 'open');
    assert.match(lastEvent(fx, closedUnmerged, 'reopened').reason, /closed without landing: https:\/\/github\.com\/atrislabs\/atris\/pull\/1877/);
    assert.deepEqual(mc.sent_back.map((c) => c.id), [closedUnmerged]);

    assert.equal(statusOf(fx, open), 'review');
  } finally {
    cleanup(fx);
  }
});

test('a merge GitHub does not tie to this one job never closes it', () => {
  const fx = project();
  try {
    pull(fx, LINK('repo', 10), { state: 'MERGED', mergedAt: '2026-11-15T09:00:00Z', base: 'feature-x' });
    pull(fx, LINK('repo', 11), { state: 'MERGED', mergedAt: '2026-11-08T09:00:00Z' });
    pull(fx, LINK('repo', 12), { state: 'MERGED', mergedAt: '2026-11-15T09:00:00Z' });
    pull(fx, LINK('repo', 13), { state: 'MERGED', mergedAt: '2026-11-15T09:00:00Z' });
    pull(fx, LINK('repo', 14), { state: 'MERGED', mergedAt: '2026-11-15T09:00:00Z' });
    // GitHub answers for some other pull request than the one asked about.
    pull(fx, LINK('repo', 15), { state: 'MERGED', mergedAt: '2026-11-15T09:00:00Z', number: 99 });
    const intoFeature = reviewJob(fx, { title: 'merged into a feature branch', proof: ready(LINK('repo', 10)) });
    const beforeJob = reviewJob(fx, { title: 'merged before the job was written', proof: ready(LINK('repo', 11)) });
    const sharedA = reviewJob(fx, { title: 'first job naming one pull request', proof: ready(LINK('repo', 12)) });
    const sharedB = reviewJob(fx, { title: 'second job naming the same pull request', proof: ready(LINK('repo', 12)) });
    const twoLinks = reviewJob(fx, { title: 'proof naming two pull requests', proof: `${ready(LINK('repo', 13))} and ${LINK('repo', 14)}` });
    const protectedLane = reviewJob(fx, { title: 'Stripe checkout fix', tag: 'billing', proof: ready(LINK('repo', 14)) });
    const wrongAnswer = reviewJob(fx, { title: 'github answered for another number', proof: ready(LINK('repo', 15)) });

    const receipt = tick(fx);
    for (const id of [intoFeature, beforeJob, sharedA, sharedB, twoLinks, protectedLane, wrongAnswer]) {
      assert.equal(statusOf(fx, id), 'review', `${taskDb.getTask(fx.db, id).title}: ${JSON.stringify(receipt.merged_close)}`);
    }
    assert.deepEqual(receipt.merged_close.closed, []);
  } finally {
    cleanup(fx);
  }
});

test('the dry run names what would close and would go back, and writes nothing', () => {
  const fx = project();
  try {
    pull(fx, LINK('repo', 20), { state: 'MERGED', mergedAt: '2026-11-15T09:00:00Z' });
    pull(fx, LINK('repo', 21), { state: 'CLOSED' });
    const merged = reviewJob(fx, { title: 'merged work', proof: ready(LINK('repo', 20)) });
    const closed = reviewJob(fx, { title: 'dropped work', proof: ready(LINK('repo', 21)) });
    const receipt = tick(fx, ['--dry-run']);
    const mc = receipt.merged_close || receipt.preview?.merged_close || {};
    assert.equal(statusOf(fx, merged), 'review');
    assert.equal(statusOf(fx, closed), 'review');
    assert.deepEqual((mc.would_close || []).map((c) => c.id), [merged], JSON.stringify(receipt));
    assert.deepEqual((mc.would_send_back || []).map((c) => c.id), [closed]);
  } finally {
    cleanup(fx);
  }
});

test('with GitHub unreachable nothing is closed or sent back', () => {
  const fx = project();
  try {
    pull(fx, LINK('repo', 30), { state: 'MERGED', mergedAt: '2026-11-15T09:00:00Z' });
    const merged = reviewJob(fx, { title: 'merged work', proof: ready(LINK('repo', 30)) });
    const receipt = tick(fx, [], { outage: true });
    assert.equal(statusOf(fx, merged), 'review');
    assert.ok(receipt.merged_close.github_outage, JSON.stringify(receipt.merged_close));
  } finally {
    cleanup(fx);
  }
});
