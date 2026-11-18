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
  git(['remote', 'add', 'origin', 'git@github.com:atrislabs/repo.git'], repo);
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

// The branch a builder opens its pull request from: the job's title as a
// slug, cut at 40 letters, then the day and a short random tail.
const branchFor = (title) => `atris/${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)}-20261114-2153-98b4`;

function pull(fx, url, { state, mergedAt = null, base = 'master', number, title = null, head = null, canonical = null }) {
  const [, owner, name] = /github\.com\/([^/]+)\/([^/]+)\/pull/.exec(url);
  fx.pulls[url] = {
    state,
    number: number || Number(url.split('/').pop().replace(/#.*$/, '')),
    url: canonical || url,
    mergeCommit: state === 'MERGED' ? { oid: 'a'.repeat(40) } : null,
    mergedAt,
    mergedBy: state === 'MERGED' ? { login: 'someone' } : null,
    headRefName: head || (title ? branchFor(title) : 'atris/the-fix-20261114-2153-98b4'),
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

function tick(fx, args = [], { outage = false, expectStatus = 0, seen = null } = {}) {
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
  assert.equal(res.status, expectStatus, res.stderr || res.stdout);
  if (seen) seen.stderr = res.stderr;
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
    pull(fx, LINK('ai-leaderboards', 28), { state: 'MERGED', mergedAt: '2026-11-10T09:14:20Z', title: 'The Best value section opens with a wall of lists' });
    pull(fx, LINK('atris', 1877), { state: 'CLOSED', title: 'A desktop feed card stays on working forever' });
    pull(fx, LINK('repo', 5487), { state: 'OPEN', title: 'grpcio is hit by an advisory' });
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
    pull(fx, LINK('repo', 10), { state: 'MERGED', mergedAt: '2026-11-15T09:00:00Z', base: 'feature-x', title: 'merged into a feature branch' });
    pull(fx, LINK('repo', 11), { state: 'MERGED', mergedAt: '2026-11-08T09:00:00Z', title: 'merged before the job was written' });
    pull(fx, LINK('repo', 12), { state: 'MERGED', mergedAt: '2026-11-15T09:00:00Z', title: 'first job naming one pull request' });
    pull(fx, LINK('repo', 13), { state: 'MERGED', mergedAt: '2026-11-15T09:00:00Z', title: 'proof naming two pull requests' });
    pull(fx, LINK('repo', 14), { state: 'MERGED', mergedAt: '2026-11-15T09:00:00Z', title: 'Stripe checkout fix' });
    // GitHub answers for some other pull request than the one asked about.
    pull(fx, LINK('repo', 15), { state: 'MERGED', mergedAt: '2026-11-15T09:00:00Z', number: 99, title: 'github answered for another number' });
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
    pull(fx, LINK('repo', 20), { state: 'MERGED', mergedAt: '2026-11-15T09:00:00Z', title: 'merged work on the feed card' });
    pull(fx, LINK('repo', 21), { state: 'CLOSED', title: 'dropped work on the menu' });
    const merged = reviewJob(fx, { title: 'merged work on the feed card', proof: ready(LINK('repo', 20)) });
    const closed = reviewJob(fx, { title: 'dropped work on the menu', proof: ready(LINK('repo', 21)) });
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
    pull(fx, LINK('repo', 30), { state: 'MERGED', mergedAt: '2026-11-15T09:00:00Z', title: 'merged work' });
    const merged = reviewJob(fx, { title: 'merged work', proof: ready(LINK('repo', 30)) });
    // gh that cannot start (a shim exiting 127) fails the run out loud.
    const seen = {};
    const receipt = tick(fx, [], { outage: true, expectStatus: 1, seen });
    assert.equal(statusOf(fx, merged), 'review');
    assert.ok(receipt.merged_close.github_outage, JSON.stringify(receipt.merged_close));
    assert.equal(seen.stderr.split('\n').filter((l) => /gh not found/.test(l)).length, 1, seen.stderr);
  } finally {
    cleanup(fx);
  }
});

// Reviewer repros, 2026-11-15. A pull request link in a proof is only the
// job's own when GitHub's answer ties it to this one job: its branch carries
// the job's id, or is named from the job's title the way builders name them.

test('a pull request the proof only mentions merges, and the job stays in review', () => {
  const fx = project();
  try {
    pull(fx, LINK('repo', 40), { state: 'MERGED', mergedAt: '2026-11-15T09:00:00Z', head: 'someone/shared-fix' });
    const id = reviewJob(fx, {
      title: 'Fix the feed card',
      proof: `Not finished. Branch codex/my-fix is pushed but has no pull request yet. It needs the shared fix in ${LINK('repo', 40)} to land first.`,
    });
    const receipt = tick(fx);
    assert.equal(statusOf(fx, id), 'review', JSON.stringify(receipt.merged_close));
    assert.deepEqual(receipt.merged_close.closed, []);
  } finally {
    cleanup(fx);
  }
});

test('a link to a comment on a closed pull request never sends landed work back or wipes its proof', () => {
  const fx = project();
  try {
    // The real job's shape: its work merged as #1832; its only link is a
    // comment on the stale pull request it replaced, which GitHub says is closed.
    const link = 'https://github.com/atrislabs/repo/pull/1570#issuecomment-4650678260';
    pull(fx, link, { state: 'CLOSED', number: 1570, canonical: LINK('repo', 1570), title: 'Restack product launch preview' });
    const proof = `Inspected changed files in commit 6754cd357 and merged PR #1832 at a884276c6. Verifier commands passed before merge. Stale PR #1570 closed with replacement comment ${link}.`;
    const id = reviewJob(fx, { title: 'Restack product launch preview', proof, metadata: { agent_certified: true, agent_review_pass_count: 2 } });
    const receipt = tick(fx);
    const row = taskDb.getTask(fx.db, id);
    assert.equal(row.status, 'review', JSON.stringify(receipt.merged_close));
    assert.equal(row.metadata.latest_agent_proof, proof);
    assert.equal(row.metadata.agent_certified, true);
    assert.deepEqual(receipt.merged_close.sent_back, []);
  } finally {
    cleanup(fx);
  }
});

test('a closed pull request on a branch that is not this job\'s never sends the job back', () => {
  const fx = project();
  try {
    pull(fx, LINK('repo', 41), { state: 'CLOSED', head: 'person/abandoned-idea' });
    const id = reviewJob(fx, { title: 'Keep the menu open on tap', proof: ready(LINK('repo', 41)) });
    const receipt = tick(fx);
    assert.equal(statusOf(fx, id), 'review', JSON.stringify(receipt.merged_close));
  } finally {
    cleanup(fx);
  }
});

test('a held job is settled only on the held sweep\'s own proofs', () => {
  const fx = project();
  try {
    const hourAgo = new Date(Date.now() - 3600000).toISOString().replace(/\.\d+Z$/, 'Z');
    const created = new Date(Date.now() - 6 * 3600000).toISOString();
    pull(fx, LINK('repo', 77), { state: 'MERGED', mergedAt: hourAgo, head: 'person/unrelated-change' });
    const unrelated = reviewJob(fx, { title: 'Held job', proof: 'Done, waiting on a person to land it.', createdAt: created,
      metadata: { pull_request: { state: 'open', number: 77, url: LINK('repo', 77) } } });
    fx.db.prepare('UPDATE tasks SET claimed_at = ? WHERE id = ?').run(Date.now() - 5 * 3600000, unrelated);
    // Same shape, but the branch carries this job's id: that one is its build.
    const own = reviewJob(fx, { title: 'Held job with its own branch', proof: 'Done, waiting on a person to land it.', createdAt: created,
      metadata: { pull_request: { state: 'open', number: 78, url: LINK('repo', 78) } } });
    fx.db.prepare('UPDATE tasks SET claimed_at = ? WHERE id = ?').run(Date.now() - 5 * 3600000, own);
    pull(fx, LINK('repo', 78), { state: 'MERGED', mergedAt: hourAgo, head: `codex/held-${own.toLowerCase()}` });
    const receipt = tick(fx);
    assert.equal(statusOf(fx, unrelated), 'review', JSON.stringify(receipt.merged_close));
    assert.equal(statusOf(fx, own), 'done', JSON.stringify(receipt.merged_close));
  } finally {
    cleanup(fx);
  }
});

test('each pass asks about the jobs it has not asked about yet, so a merge behind a long list is reached', () => {
  const { closeMergedReviewJobs } = require('../lib/merged-review-close');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-merged-pr-cursor-')));
  try {
    const t0 = Date.parse('2026-11-01T00:00:00Z');
    const link = (n) => `https://github.com/acme/widgets/pull/${n}`;
    const tasks = [];
    for (let i = 1; i <= 7; i += 1) {
      tasks.push({ id: `job${i}`, title: `job number ${i} fixes a thing`, status: 'review', created_at: t0 + i * 1000, updated_at: t0 + i * 1000,
        metadata: { approval_status: 'pending', latest_agent_proof: `Fixed. Pull request ready in 2m. ${link(i)}` } });
    }
    const closed = [];
    const askedFor = [];
    for (let pass = 1; pass <= 3 && !closed.length; pass += 1) {
      closeMergedReviewJobs({
        root, tasks, now: t0 + 86400000, pullRequestLimit: 3,
        ask: (url) => {
          const n = Number(url.split('/').pop());
          askedFor.push(n);
          return { answer: { state: n === 7 ? 'merged' : 'open', number: n, url, repo: 'acme/widgets', head_repo: 'acme/widgets',
            head_ref: `atris/job-number-${n}-fixes-a-thing-20261101-0000-abcd`, base_ref: 'main',
            merge_commit: n === 7 ? 'a'.repeat(40) : null, merged_at: n === 7 ? '2026-11-01T06:00:00Z' : null } };
        },
        askBranch: () => ({ branch: 'main' }),
        taken: () => null,
        closePullRequest: (id) => { closed.push(id); return { updated: true }; },
        rememberAsked: (id, at) => { tasks.find((t) => t.id === id).metadata.pull_request_asked_at = new Date(at).toISOString(); },
      });
    }
    assert.deepEqual(closed, ['job7'], `asked in order: ${askedFor.join(',')}`);
    const untilMerged = askedFor.slice(0, askedFor.indexOf(7) + 1);
    assert.equal(new Set(untilMerged).size, untilMerged.length, `no job is asked twice before every job is asked once: ${askedFor.join(',')}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
