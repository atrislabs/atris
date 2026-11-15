'use strict';

// On 2026-11-15 the hourly merger treated every quiet branch as finished
// work. In atrisos-web two branches whose pull requests were closed without
// merging were about to get fresh pull requests and land; pull requests
// labelled jev-hold, needs-human and needs-review would have landed too; and
// 32 of 47 reported clashes across three projects were branches already
// squash merged, each with a catch-up job for work that was in. These tests
// hold the merger to what each branch's own pull requests say.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const tmpTasks = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-land-guards-tasks-'));
process.env.ATRIS_TASKS_DB = path.join(tmpTasks, 'tasks.db');

const { landStaleGreenBranches, summaryLine, holdLabelSetting } = require('../lib/land-green');
const { isPullRequestLookup, pullRequestAnswer, pr } = require('./helpers/branch-pull-requests');

const daysAgo = (n) => new Date(Date.now() - n * 24 * 3600 * 1000).toISOString();

function git(cwd, args, env = {}) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function commitAll(cwd, message, when = daysAgo(3)) {
  git(cwd, ['add', '-A']);
  git(cwd, ['-c', 'user.name=Bench Author', '-c', 'user.email=bench@example.com', 'commit', '-q', '-m', message], {
    GIT_AUTHOR_DATE: when,
    GIT_COMMITTER_DATE: when,
  });
  return git(cwd, ['rev-parse', 'HEAD']);
}

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-land-guards-'));
  git(root, ['init', '-q', '-b', 'master']);
  git(root, ['config', 'user.name', 'Bench Author']);
  git(root, ['config', 'user.email', 'bench@example.com']);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.0' }));
  fs.writeFileSync(path.join(root, 'shared.txt'), 'base\n');
  commitAll(root, 'base', daysAgo(10));
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-land-guards-origin-'));
  git(bare, ['init', '-q', '--bare', '-b', 'master']);
  git(root, ['remote', 'add', 'origin', bare]);
  git(root, ['push', '-q', 'origin', 'master']);
  git(root, ['fetch', '-q', 'origin']);
  return { root, bare };
}

function branchWith(root, name, file, text = `${name}\n`, when = daysAgo(3)) {
  git(root, ['checkout', '-q', '-b', name]);
  fs.writeFileSync(path.join(root, file), text);
  const sha = commitAll(root, `${name} work`, when);
  git(root, ['checkout', '-q', 'master']);
  return sha;
}

// A gh that answers the one pull request lookup from `prs` and otherwise
// behaves like a repo with no open pull request on the branch.
function fakeGh(prs = {}, { lookup } = {}) {
  const calls = [];
  let next = 50;
  const runGh = (args) => {
    calls.push(args);
    if (isPullRequestLookup(args)) return lookup ? lookup(args) : pullRequestAnswer(args, (branch) => prs[branch] || []);
    if (args[0] === 'api') return { ok: true, stdout: '[]', stderr: '' };
    if (args[0] === 'pr' && args[1] === 'list') return { ok: true, stdout: '[]', stderr: '' };
    if (args[0] === 'pr' && args[1] === 'create') { next += 1; return { ok: true, stdout: `https://github.com/acme/repo/pull/${next}`, stderr: '' }; }
    if (args[0] === 'pr' && args[1] === 'merge') return { ok: true, stdout: '', stderr: '' };
    return { ok: false, stdout: '', stderr: 'unexpected gh call' };
  };
  return { calls, runGh };
}

const noTasks = () => { throw new Error('no clash job expected'); };
const noFlags = () => { throw new Error('no flag expected'); };
const green = () => ({ status: 0, stdout: 'ok\n', stderr: '', failing: [], duration_ms: 1, command: 'npm test' });
const writes = (gh) => gh.calls.filter((c) => c[0] === 'pr' && (c[1] === 'create' || c[1] === 'merge'));

function run(root, gh, extra = {}) {
  return landStaleGreenBranches(root, {
    mergePath: 'pull_request', localCheck: true, runGh: gh.runGh, runVerifyFn: green,
    recordQueued: () => {}, readQueued: () => null, readEntries: () => ({}), runCli: noFlags,
    fileConflictTask: noTasks, closeCatchUpJobs: () => [], stateFile: null, ...extra,
  });
}

function cleanup(...dirs) {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
}

test('closed means no: a branch whose pull request was closed without merging is left alone until it moves', () => {
  const { root, bare } = makeRepo();
  try {
    const tip = branchWith(root, 'feat/rejected', 'rejected.txt');
    let suites = 0;
    const gh = fakeGh({ 'feat/rejected': [pr({ number: 12, state: 'CLOSED', headRefName: 'feat/rejected', headRefOid: tip })] });
    const result = run(root, gh, { runVerifyFn: () => { suites += 1; return green(); } });
    const v = result.verdicts.find((x) => x.branch === 'feat/rejected');
    assert.equal(v.action, 'skipped', JSON.stringify(v));
    assert.equal(v.reason, 'pull_request_closed');
    assert.match(v.detail, /#12 was closed without merging and the branch has not moved since/);
    assert.equal(suites, 0, 'no check ran');
    assert.deepEqual(writes(gh), [], 'no new pull request and no merge');
    assert.equal(spawnSync('git', ['rev-parse', '--verify', '--quiet', 'refs/heads/feat/rejected'], { cwd: bare }).status, 1, 'nothing pushed');
    assert.match(summaryLine(result), /feat\/rejected held \(pull request closed: pull request #12 was closed without merging/);

    // New work on top of the closed pull request is new work: it goes through as before.
    git(root, ['checkout', '-q', 'feat/rejected']);
    fs.writeFileSync(path.join(root, 'rejected.txt'), 'fixed after review\n');
    commitAll(root, 'answer the review', daysAgo(3));
    git(root, ['checkout', '-q', 'master']);
    const again = run(root, gh).verdicts.find((x) => x.branch === 'feat/rejected');
    assert.equal(again.action, 'queued', JSON.stringify(again));
  } finally {
    cleanup(root, bare);
  }
});

test('held means wait: a draft or a hold label leaves the branch alone; the catch-up label does not', () => {
  const { root, bare } = makeRepo();
  try {
    const tips = {
      'feat/jev': branchWith(root, 'feat/jev', 'a.txt'),
      'feat/human': branchWith(root, 'feat/human', 'b.txt'),
      'feat/draft': branchWith(root, 'feat/draft', 'c.txt'),
      'feat/behind': branchWith(root, 'feat/behind', 'd.txt'),
    };
    const open = (branch, fields) => [pr({ number: 30 + Object.keys(tips).indexOf(branch), headRefName: branch, headRefOid: tips[branch], ...fields })];
    const prs = {
      'feat/jev': open('feat/jev', { labels: { nodes: [{ name: 'jev-hold' }] } }),
      'feat/human': open('feat/human', { labels: { nodes: [{ name: 'Needs Human' }] } }),
      'feat/draft': open('feat/draft', { isDraft: true }),
      'feat/behind': open('feat/behind', { labels: { nodes: [{ name: 'catch-up' }] } }),
    };
    const gh = fakeGh(prs);
    const result = run(root, gh, { limit: 10, localSuites: 10 });
    const by = Object.fromEntries(result.verdicts.map((v) => [v.branch, v]));
    assert.equal(by['feat/jev'].reason, 'pull_request_held');
    assert.match(by['feat/jev'].detail, /labelled jev-hold, so a person acts first/);
    assert.equal(by['feat/human'].reason, 'pull_request_held');
    assert.equal(by['feat/draft'].reason, 'pull_request_held');
    assert.match(by['feat/draft'].detail, /is a draft/);
    assert.equal(by['feat/behind'].action, 'queued', JSON.stringify(by['feat/behind']));

    // The owner's list replaces the default one.
    const custom = run(root, fakeGh({ ...prs, 'feat/behind': open('feat/behind', { labels: { nodes: [{ name: 'parked' }] } }) }), {
      limit: 10, localSuites: 10, holdLabels: holdLabelSetting({ green_landing_hold_labels: ['Parked'] }),
    });
    const after = Object.fromEntries(custom.verdicts.map((v) => [v.branch, v]));
    assert.equal(after['feat/behind'].reason, 'pull_request_held');
    assert.equal(after['feat/jev'].action, 'queued', 'jev-hold is no longer on the list');
    assert.equal(holdLabelSetting({}), undefined, 'no policy key keeps the default list');
  } finally {
    cleanup(root, bare);
  }
});

test('merged means done: a squash merged branch is no candidate, no clash, and its open catch-up job closes', () => {
  const { root, bare } = makeRepo();
  try {
    // Two commits on the branch, squashed into one on master, then master
    // moves the same lines again: git cherry never matches and the merge clashes.
    git(root, ['checkout', '-q', '-b', 'feat/squashed']);
    fs.writeFileSync(path.join(root, 'shared.txt'), 'one\n');
    commitAll(root, 'first half');
    fs.writeFileSync(path.join(root, 'shared.txt'), 'one\ntwo\n');
    const tip = commitAll(root, 'second half');
    git(root, ['checkout', '-q', 'master']);
    fs.writeFileSync(path.join(root, 'shared.txt'), 'one\ntwo\n');
    commitAll(root, 'feat/squashed (#77)', daysAgo(2));
    fs.writeFileSync(path.join(root, 'shared.txt'), 'one\ntwo changed later\n');
    commitAll(root, 'later change', daysAgo(1));
    git(root, ['push', '-q', 'origin', 'master']);

    const { collectBoard } = require('../commands/land');
    assert.equal(collectBoard(root, { light: true }).branches.find((b) => b.name === 'feat/squashed').state, 'active', 'the board alone still calls it active');

    // A catch-up job the merger filed on an earlier run, and one for another branch.
    const taskDb = require('../lib/task-db');
    const { fileConflictTask } = require('../lib/land-green');
    const job = fileConflictTask(root, { branch: 'feat/squashed', base: 'master', head: tip, files: ['shared.txt'] });
    const other = fileConflictTask(root, { branch: 'feat/other', base: 'master', head: 'b'.repeat(40), files: ['shared.txt'] });

    const gh = fakeGh({ 'feat/squashed': [pr({ number: 77, state: 'MERGED', headRefName: 'feat/squashed', headRefOid: tip })] });
    const result = landStaleGreenBranches(root, {
      mergePath: 'pull_request', localCheck: true, runGh: gh.runGh, runVerifyFn: green,
      recordQueued: () => {}, readQueued: () => null, readEntries: () => ({}), runCli: noFlags,
      fileConflictTask: noTasks, stateFile: null,
    });
    assert.deepEqual(result.candidates, [], 'not a candidate');
    assert.equal(result.verdicts.length, 0, 'not a clash row');
    assert.deepEqual(result.merged_by_pull_request.map((r) => [r.branch, r.pr, r.closed_jobs]), [['feat/squashed', 77, [job.id]]]);
    const db = taskDb.open();
    const row = db.prepare('SELECT status, metadata FROM tasks WHERE id = ?').get(job.id);
    assert.equal(row.status, 'archived');
    assert.match(JSON.parse(row.metadata).archived_reason, /pull request #77 already merged feat\/squashed into master/);
    assert.equal(db.prepare('SELECT status FROM tasks WHERE id = ?').get(other.id).status, 'open', 'another branch keeps its job');
    assert.match(summaryLine(result), /1 branch was already merged through a pull request; closed 1 catch-up job/);

    // A dry run says the same and closes nothing.
    const dry = run(root, gh, { dryRun: true, closeCatchUpJobs: noTasks });
    assert.equal(dry.merged_by_pull_request[0].would_close_jobs, true);
  } finally {
    cleanup(root, bare);
  }
});

test('merged at an older commit is not done: work pushed after the merge still lands', () => {
  const { root, bare } = makeRepo();
  try {
    const first = branchWith(root, 'feat/more', 'more.txt');
    git(root, ['checkout', '-q', 'feat/more']);
    fs.writeFileSync(path.join(root, 'more2.txt'), 'after the merge\n');
    commitAll(root, 'more after merge');
    git(root, ['checkout', '-q', 'master']);
    const gh = fakeGh({ 'feat/more': [pr({ number: 8, state: 'MERGED', headRefName: 'feat/more', headRefOid: first })] });
    const result = run(root, gh);
    assert.deepEqual(result.merged_by_pull_request, []);
    assert.equal(result.verdicts[0].action, 'queued', JSON.stringify(result.verdicts[0]));
  } finally {
    cleanup(root, bare);
  }
});

test('cannot read means do not land: a 401 or a missing gh is could-not-tell, with no push and no job', () => {
  const { root, bare } = makeRepo();
  try {
    branchWith(root, 'feat/one', 'one.txt');
    branchWith(root, 'feat/two', 'two.txt', 'base-clash\n');
    for (const failure of [
      { ok: false, stdout: '', stderr: 'HTTP 401: Requires authentication (https://api.github.com/graphql)' },
      { ok: false, stdout: '', stderr: 'gh could not start (ENOENT)' },
    ]) {
      let suites = 0;
      const gh = fakeGh({}, { lookup: () => failure });
      const result = run(root, gh, { runVerifyFn: () => { suites += 1; return green(); } });
      assert.deepEqual(result.verdicts.map((v) => [v.branch, v.action, v.reason]).sort(), [
        ['feat/one', 'unknown', 'pull_request_unreadable'],
        ['feat/two', 'unknown', 'pull_request_unreadable'],
      ]);
      assert.deepEqual(result.could_not_tell.sort(), ['feat/one', 'feat/two']);
      assert.equal(suites, 0);
      assert.deepEqual(writes(gh), []);
      assert.match(summaryLine(result), new RegExp(`could not tell .*${failure.stderr.split(' ')[0]}.*nothing landed blind`));
    }
    assert.equal(spawnSync('git', ['rev-parse', '--verify', '--quiet', 'refs/heads/feat/one'], { cwd: bare }).status, 1, 'nothing pushed');
  } finally {
    cleanup(root, bare);
  }
});

test('cost stays flat: 120 branches are read in two gh calls, not 120', () => {
  const { root, bare } = makeRepo();
  try {
    const when = daysAgo(3);
    const env = { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when, GIT_AUTHOR_NAME: 'Bench Author', GIT_AUTHOR_EMAIL: 'bench@example.com', GIT_COMMITTER_NAME: 'Bench Author', GIT_COMMITTER_EMAIL: 'bench@example.com' };
    const tree = git(root, ['rev-parse', 'master^{tree}']);
    const parent = git(root, ['rev-parse', 'master']);
    const prs = {};
    for (let i = 0; i < 120; i += 1) {
      const name = `feat/many-${i}`;
      const sha = git(root, ['commit-tree', tree, '-p', parent, '-m', `many ${i}`], env);
      git(root, ['update-ref', `refs/heads/${name}`, sha]);
      prs[name] = [pr({ number: 100 + i, state: 'CLOSED', headRefName: name, headRefOid: sha })];
    }
    const gh = fakeGh(prs);
    const result = run(root, gh);
    assert.equal(result.verdicts.length, 120);
    assert.ok(result.verdicts.every((v) => v.reason === 'pull_request_closed'), 'every branch was read');
    assert.equal(gh.calls.filter(isPullRequestLookup).length, 2);
    assert.equal(gh.calls.filter((c) => c[0] === 'pr').length, 0, 'no per-branch pull request call');
  } finally {
    cleanup(root, bare);
  }
});

test.after(() => cleanup(tmpTasks));
