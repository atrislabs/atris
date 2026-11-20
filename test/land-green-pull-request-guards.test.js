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
function fakeGh(prs = {}, { lookup, list } = {}) {
  const calls = [];
  let next = 50;
  const runGh = (args) => {
    calls.push(args);
    if (isPullRequestLookup(args)) return lookup ? lookup(args) : pullRequestAnswer(args, (branch) => prs[branch] || []);
    if (args[0] === 'api') return { ok: true, stdout: '[]', stderr: '' };
    if (args[0] === 'pr' && args[1] === 'list') return { ok: true, stdout: JSON.stringify(list ? list(args[args.indexOf('--head') + 1]) : []), stderr: '' };
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
    assert.match(v.detail, /#12 was closed without merging and the branch has no new work since/);
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

// Review round one. Each test below failed on the first version of these guards.

function moveMaster(root, file = 'master-move.txt', text = 'moved\n') {
  fs.writeFileSync(path.join(root, file), text);
  const sha = commitAll(root, `master moves ${file}`, daysAgo(2));
  git(root, ['push', '-q', 'origin', 'master']);
  return sha;
}

// A second clone: a builder on another computer, or GitHub's own buttons.
function otherClone(bare) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-land-guards-clone-'));
  git(dir, ['clone', '-q', bare, '.']);
  git(dir, ['config', 'user.name', 'Elsewhere']);
  git(dir, ['config', 'user.email', 'else@example.com']);
  return dir;
}

const at = (when) => ({ GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when });
const originTip = (bare, branch) => {
  const r = spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: bare, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
};

test('closed stays closed after a catch-up: merging the base in is not new work, and its catch-up job closes', () => {
  const { root, bare } = makeRepo();
  try {
    const tip = branchWith(root, 'feat/shut', 'shut.txt');
    git(root, ['push', '-q', 'origin', 'feat/shut']);
    const taskDb = require('../lib/task-db');
    const { fileConflictTask } = require('../lib/land-green');
    const job = fileConflictTask(root, { branch: 'feat/shut', base: 'master', head: tip, files: ['shared.txt'] });
    const prs = { 'feat/shut': [pr({ number: 5118, state: 'CLOSED', headRefName: 'feat/shut', headRefOid: tip })] };

    // The run after the close closes the job nobody wants.
    const first = landStaleGreenBranches(root, {
      mergePath: 'pull_request', localCheck: true, runGh: fakeGh(prs).runGh, runVerifyFn: green,
      recordQueued: () => {}, readQueued: () => null, readEntries: () => ({}), runCli: noFlags, fileConflictTask: noTasks, stateFile: null,
    }).verdicts[0];
    assert.equal(first.reason, 'pull_request_closed', JSON.stringify(first));
    assert.deepEqual(first.closed_jobs, [job.id]);
    const row = taskDb.open().prepare('SELECT status, metadata FROM tasks WHERE id = ?').get(job.id);
    assert.equal(row.status, 'archived');
    assert.match(JSON.parse(row.metadata).archived_reason, /pull request #5118 for feat\/shut was closed without merging/);

    // A builder catches it up anyway: merges master in and pushes.
    moveMaster(root);
    git(root, ['checkout', '-q', 'feat/shut']);
    git(root, ['merge', '-q', '--no-ff', 'master', '-m', 'Merge master into feat/shut'], at(daysAgo(2)));
    git(root, ['push', '-q', 'origin', 'feat/shut']);
    git(root, ['checkout', '-q', 'master']);
    const gh = fakeGh(prs);
    const v = run(root, gh).verdicts[0];
    assert.equal(v.reason, 'pull_request_closed', JSON.stringify(v));
    assert.deepEqual(writes(gh), [], 'no fresh pull request, no auto-merge');

    // A rebase onto master copies the same commit: still no new work.
    git(root, ['checkout', '-q', '-b', 'feat/shut-rebased', 'master']);
    git(root, ['cherry-pick', tip], at(daysAgo(2)));
    git(root, ['branch', '-f', 'feat/shut', 'HEAD']);
    git(root, ['checkout', '-q', 'master']);
    git(root, ['branch', '-D', 'feat/shut-rebased']);
    const rebased = run(root, fakeGh(prs)).verdicts[0];
    assert.equal(rebased.reason, 'pull_request_closed', JSON.stringify(rebased));
  } finally {
    cleanup(root, bare);
  }
});

test('closed is read against what github has: heads made on github, pruned heads, and pushes from elsewhere', () => {
  const { root, bare } = makeRepo();
  const clones = [];
  try {
    // a. GitHub's Update branch made the closed head; this clone never fetched it.
    branchWith(root, 'feat/webfix', 'w.txt');
    git(root, ['push', '-q', 'origin', 'feat/webfix']);
    moveMaster(root);
    const web = otherClone(bare); clones.push(web);
    git(web, ['checkout', '-q', 'feat/webfix']);
    git(web, ['merge', '-q', '--no-ff', 'origin/master', '-m', 'Merge branch master into feat/webfix'], at(daysAgo(2)));
    const webHead = git(web, ['rev-parse', 'HEAD']);
    git(web, ['push', '-q', 'origin', 'feat/webfix']);
    git(bare, ['update-ref', 'refs/pull/21/head', webHead]);
    assert.notEqual(spawnSync('git', ['cat-file', '-e', `${webHead}^{commit}`], { cwd: root }).status, 0, 'the clone lacks the head');

    // b. Closed at the lander's own catch-up, branch deleted on GitHub, pruned and gc'd here.
    branchWith(root, 'feat/gone', 'g.txt');
    moveMaster(root, 'master-move-2.txt');
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-land-guards-scratch-'));
    fs.rmdirSync(scratch);
    git(root, ['worktree', 'add', '-q', '--detach', scratch, 'feat/gone']);
    git(scratch, ['merge', '-q', '--no-ff', 'master', '-m', 'land: catch up'], at(daysAgo(2)));
    const goneHead = git(scratch, ['rev-parse', 'HEAD']);
    git(root, ['push', '-q', 'origin', `${goneHead}:refs/pull/31/head`]);
    git(root, ['worktree', 'remove', '--force', scratch]);
    git(root, ['fetch', '-q', '--prune', 'origin']);
    git(root, ['reflog', 'expire', '--expire=now', '--all']);
    git(root, ['gc', '-q', '--prune=now']);
    assert.notEqual(spawnSync('git', ['cat-file', '-e', `${goneHead}^{commit}`], { cwd: root }).status, 0, 'the clone lost the head');

    // c. Closed at the tip, then answered from another computer: that is new work.
    const laterTip = branchWith(root, 'feat/later', 'l.txt');
    git(root, ['push', '-q', 'origin', 'feat/later']);
    const away = otherClone(bare); clones.push(away);
    git(away, ['checkout', '-q', 'feat/later']);
    fs.writeFileSync(path.join(away, 'l2.txt'), 'answer\n');
    commitAll(away, 'answer the review from elsewhere');
    git(away, ['push', '-q', 'origin', 'feat/later']);

    // d. Squash merged, then more work pushed from another computer: not done.
    // Two commits, so git cherry cannot match the squash.
    branchWith(root, 'feat/sq', 'sq.txt');
    git(root, ['checkout', '-q', 'feat/sq']);
    fs.writeFileSync(path.join(root, 'sq1.txt'), 'half\n');
    const sqTip = commitAll(root, 'second half');
    git(root, ['checkout', '-q', 'master']);
    git(root, ['push', '-q', 'origin', 'feat/sq']);
    fs.writeFileSync(path.join(root, 'sq.txt'), 'feat/sq\n');
    fs.writeFileSync(path.join(root, 'sq1.txt'), 'half\n');
    commitAll(root, 'feat/sq (#61)', daysAgo(2));
    git(root, ['push', '-q', 'origin', 'master']);
    git(away, ['fetch', '-q', 'origin']);
    git(away, ['checkout', '-q', 'feat/sq']);
    fs.writeFileSync(path.join(away, 'sq2.txt'), 'more\n');
    commitAll(away, 'more after the squash');
    git(away, ['push', '-q', 'origin', 'feat/sq']);

    const prs = {
      'feat/webfix': [pr({ number: 21, state: 'CLOSED', headRefName: 'feat/webfix', headRefOid: webHead })],
      'feat/gone': [pr({ number: 31, state: 'CLOSED', headRefName: 'feat/gone', headRefOid: goneHead })],
      'feat/later': [pr({ number: 41, state: 'CLOSED', headRefName: 'feat/later', headRefOid: laterTip })],
      'feat/sq': [pr({ number: 61, state: 'MERGED', headRefName: 'feat/sq', headRefOid: sqTip })],
    };
    const before = { webfix: originTip(bare, 'feat/webfix'), gone: originTip(bare, 'feat/gone') };
    const gh = fakeGh(prs);
    const result = run(root, gh, { limit: 10, localSuites: 10 });
    const by = Object.fromEntries(result.verdicts.map((v) => [v.branch, v]));
    assert.equal(by['feat/webfix'].reason, 'pull_request_closed', JSON.stringify(by['feat/webfix']));
    assert.equal(by['feat/gone'].reason, 'pull_request_closed', JSON.stringify(by['feat/gone']));
    assert.equal(originTip(bare, 'feat/webfix'), before.webfix, 'nothing pushed');
    assert.equal(originTip(bare, 'feat/gone'), before.gone, 'the deleted branch is not pushed again');
    assert.equal(by['feat/later'].action, 'queued', JSON.stringify(by['feat/later']));
    assert.deepEqual(result.merged_by_pull_request, [], 'new work after a squash is not merged');
    assert.equal(by['feat/sq'].action, 'queued', JSON.stringify(by['feat/sq']));

    // A closed head that cannot be fetched is could-not-tell, not moved.
    git(bare, ['update-ref', '-d', 'refs/pull/31/head']);
    fs.rmSync(path.join(root, '.git', 'FETCH_HEAD'), { force: true });
    git(root, ['reflog', 'expire', '--expire=now', '--all']);
    git(root, ['gc', '-q', '--prune=now']);
    const blind = run(root, fakeGh({ 'feat/gone': prs['feat/gone'] }), { limit: 10, localSuites: 10 }).verdicts.find((v) => v.branch === 'feat/gone');
    assert.equal(blind.action, 'unknown', JSON.stringify(blind));
    assert.equal(blind.reason, 'pull_request_unreadable');
  } finally {
    cleanup(root, bare, ...clones);
  }
});

test('a close or a hold during the local check stops the push and the auto-merge', () => {
  const { root, bare } = makeRepo();
  try {
    const tip = branchWith(root, 'feat/race', 'race.txt');
    const prs = { 'feat/race': [] };
    let gh = fakeGh(prs);
    // Opened by the lander earlier, then closed by a person mid-check.
    const closing = () => { prs['feat/race'] = [pr({ number: 70, state: 'CLOSED', headRefName: 'feat/race', headRefOid: tip })]; return green(); };
    const closed = run(root, gh, { runVerifyFn: closing }).verdicts[0];
    assert.equal(closed.reason, 'pull_request_closed', JSON.stringify(closed));
    assert.match(closed.detail, /read again just before the push/);
    assert.deepEqual(writes(gh), []);
    assert.equal(originTip(bare, 'feat/race'), '', 'nothing pushed');

    // An open pull request gets needs-human mid-check.
    prs['feat/race'] = [pr({ number: 71, headRefName: 'feat/race', headRefOid: tip })];
    gh = fakeGh(prs);
    const holding = () => { prs['feat/race'] = [pr({ number: 71, headRefName: 'feat/race', headRefOid: tip, labels: { nodes: [{ name: 'needs-human' }] } })]; return green(); };
    const held = run(root, gh, { runVerifyFn: holding }).verdicts[0];
    assert.equal(held.reason, 'pull_request_held', JSON.stringify(held));
    assert.deepEqual(writes(gh), []);

    // The label lands in the seconds after the second read: the last list still sees it.
    prs['feat/race'] = [pr({ number: 72, headRefName: 'feat/race', headRefOid: tip })];
    gh = fakeGh(prs, { list: () => [{ number: 72, headRefName: 'feat/race', baseRefName: 'master', isCrossRepository: false, url: 'u', isDraft: false, labels: [{ name: 'do-not-merge' }] }] });
    const late = run(root, gh).verdicts[0];
    assert.equal(late.reason, 'pull_request_held', JSON.stringify(late));
    assert.equal(gh.calls.filter((c) => c[0] === 'pr' && c[1] === 'merge').length, 0, 'no auto-merge');
  } finally {
    cleanup(root, bare);
  }
});

test('only pull requests into the base say closed; any open draft or held one holds; a reopened one goes', () => {
  const { root, bare } = makeRepo();
  try {
    const tips = {
      'feat/other-base': branchWith(root, 'feat/other-base', 'o.txt'),
      'feat/reopened': branchWith(root, 'feat/reopened', 'r.txt'),
      'feat/draft-dev': branchWith(root, 'feat/draft-dev', 'd.txt'),
    };
    const prs = {
      'feat/other-base': [
        pr({ number: 7, headRefName: 'feat/other-base', headRefOid: tips['feat/other-base'], baseRefName: 'develop' }),
        pr({ number: 6, state: 'CLOSED', headRefName: 'feat/other-base', headRefOid: tips['feat/other-base'] }),
      ],
      'feat/reopened': [
        pr({ number: 12, state: 'CLOSED', headRefName: 'feat/reopened', headRefOid: tips['feat/reopened'] }),
        pr({ number: 10, headRefName: 'feat/reopened', headRefOid: tips['feat/reopened'] }),
      ],
      'feat/draft-dev': [pr({ number: 14, isDraft: true, headRefName: 'feat/draft-dev', headRefOid: tips['feat/draft-dev'], baseRefName: 'develop' })],
    };
    const gh = fakeGh(prs, { list: (branch) => (branch === 'feat/reopened' ? [{ number: 10, headRefName: branch, baseRefName: 'master', isCrossRepository: false, url: 'https://github.com/acme/repo/pull/10' }] : []) });
    const by = Object.fromEntries(run(root, gh, { limit: 10, localSuites: 10 }).verdicts.map((v) => [v.branch, v]));
    assert.equal(by['feat/other-base'].reason, 'pull_request_closed', JSON.stringify(by['feat/other-base']));
    assert.equal(by['feat/reopened'].action, 'queued', JSON.stringify(by['feat/reopened']));
    assert.equal(by['feat/reopened'].pr, 10);
    assert.equal(by['feat/draft-dev'].reason, 'pull_request_held', JSON.stringify(by['feat/draft-dev']));
  } finally {
    cleanup(root, bare);
  }
});

test('a branch name with more pull requests or labels than one read holds is could-not-tell', () => {
  const { root, bare } = makeRepo();
  try {
    const tip = branchWith(root, 'feat/crowded', 'c.txt');
    const tip2 = branchWith(root, 'feat/labelled', 'l.txt');
    const lookup = (args) => {
      const answer = JSON.parse(pullRequestAnswer(args, () => []).stdout);
      for (const [alias, conn] of Object.entries(answer.data.repository)) {
        const branch = args.find((a) => a === `h${alias.slice(1)}=feat/crowded`) ? 'feat/crowded' : 'feat/labelled';
        if (branch === 'feat/crowded') {
          conn.pageInfo.hasNextPage = true;
          conn.nodes = [pr({ number: 99, headRefName: 'feat/crowded', isCrossRepository: true, headRefOid: tip })];
        } else {
          conn.nodes = [pr({ number: 98, headRefName: 'feat/labelled', headRefOid: tip2, labels: { totalCount: 60, nodes: [{ name: 'size-s' }] } })];
        }
      }
      return { ok: true, stdout: JSON.stringify(answer), stderr: '' };
    };
    const gh = fakeGh({}, { lookup });
    const by = Object.fromEntries(run(root, gh, { limit: 10, localSuites: 10 }).verdicts.map((v) => [v.branch, v]));
    assert.equal(by['feat/crowded'].reason, 'pull_request_unreadable', JSON.stringify(by['feat/crowded']));
    assert.match(by['feat/crowded'].detail, /more than 30 pull requests use this branch name/);
    assert.equal(by['feat/labelled'].reason, 'pull_request_unreadable', JSON.stringify(by['feat/labelled']));
    assert.deepEqual(writes(gh), []);
  } finally {
    cleanup(root, bare);
  }
});

test('hold words match whole words: apostrophes and spaces are read, threshold and unblocked are not holds', () => {
  const { root, bare } = makeRepo();
  try {
    const names = { 'feat/l1': "don't-merge", 'feat/l2': "Don't Merge", 'feat/l3': 'decision', 'feat/l4': 'threshold', 'feat/l5': 'unblocked', 'feat/l6': 'codex-rejected' };
    const prs = {};
    let n = 80;
    for (const [branch, label] of Object.entries(names)) {
      const sha = branchWith(root, branch, `${branch.slice(5)}.txt`);
      n += 1;
      prs[branch] = [pr({ number: n, headRefName: branch, headRefOid: sha, labels: { nodes: [{ name: label }] } })];
    }
    const gh = fakeGh(prs);
    const by = Object.fromEntries(run(root, gh, { limit: 10, localSuites: 10 }).verdicts.map((v) => [v.branch, v]));
    for (const b of ['feat/l1', 'feat/l2', 'feat/l3', 'feat/l6']) assert.equal(by[b].reason, 'pull_request_held', `${names[b]}: ${JSON.stringify(by[b])}`);
    for (const b of ['feat/l4', 'feat/l5']) assert.equal(by[b].action, 'queued', `${names[b]}: ${JSON.stringify(by[b])}`);
  } finally {
    cleanup(root, bare);
  }
});

// 2026-11-19: in 7 days the hourly lander rechecked unchanged clashes 11,569 times, closed pull requests 5,842,
// protected branches 2,492, and closed the jobs of merged branches 5,734 times (28 closed anything).
test('a clash, a closed pull request, a protected branch and a merged one are not redone until something moves, and still show', () => {
  const { root, bare } = makeRepo();
  try {
    const state = path.join(bare, 'land-state.json');
    branchWith(root, 'feat/clash', 'shared.txt', 'branch side\n');
    const shut = branchWith(root, 'feat/shut', 'shut.txt');
    fs.mkdirSync(path.join(root, 'auth'));
    branchWith(root, 'feat/guard', 'auth/login.js', 'module.exports = 1;\n');
    const masterCommit = (file) => { fs.writeFileSync(path.join(root, file), `master ${Date.now()}\n`); commitAll(root, `master ${file}`); git(root, ['push', '-q', 'origin', 'master']); };
    masterCommit('shared.txt');
    const done = branchWith(root, 'feat/done', 'done.txt');
    const prs = { 'feat/shut': [pr({ number: 12, state: 'CLOSED', headRefName: 'feat/shut', headRefOid: shut })], 'feat/done': [pr({ number: 13, state: 'MERGED', headRefName: 'feat/done', headRefOid: done })] };
    const jobs = [];
    const go = () => {
      const result = run(root, fakeGh(prs), {
        stateFile: state, limit: 10, fileConflictTask: (cwd, job) => { jobs.push('clash'); return { id: 'T1', inserted: true }; },
        closeCatchUpJobs: (cwd, job) => { jobs.push(job.branch); return []; },
      });
      return Object.assign(Object.fromEntries(result.verdicts.map((v) => [v.branch, v])), { result });
    };
    const one = go();
    assert.deepEqual([one['feat/clash'].reason, one['feat/shut'].reason, one['feat/guard'].reason], ['merge_conflict', 'pull_request_closed', 'protected_surface']);
    masterCommit('elsewhere.txt');
    const two = go();
    assert.deepEqual([two['feat/clash'].reason, two['feat/clash'].was], ['waiting_for_change', 'merge_conflict']);
    assert.match(two['feat/clash'].detail, /merge conflict in shared\.txt; tries again once the branch moves or master changes those files/);
    assert.deepEqual([two['feat/shut'].reason, two['feat/shut'].was], ['waiting_for_change', 'pull_request_closed']);
    assert.match(two['feat/guard'].detail, /protected surface \(.+\) in the same changes; tries again once the branch moves or master takes in its commits/);
    assert.deepEqual(two.result.not_rechecked, { merge_conflict: 1, pull_request_closed: 1, protected_surface: 1 });
    assert.ok(two.result.merged_by_pull_request[0].jobs_closed_before, 'merged: its jobs are not closed twice');
    assert.deepEqual(jobs.sort(), ['clash', 'feat/done', 'feat/shut'], 'no job work on the run where nothing moved');
    // Master changing the clashing file, a push to origin's copy and a reopen are all moves.
    masterCommit('shared.txt');
    assert.equal(go()['feat/clash'].reason, 'merge_conflict');
    git(root, ['push', '-q', 'origin', 'feat/clash']);
    git(root, ['push', '-q', 'origin', 'feat/guard']);
    prs['feat/shut'] = [pr({ number: 12, headRefName: 'feat/shut', headRefOid: shut })];
    const three = go();
    assert.deepEqual([three['feat/clash'].reason, three['feat/shut'].action, three['feat/guard'].reason], ['merge_conflict', 'queued', 'protected_surface']);
  } finally {
    cleanup(root, bare);
  }
});

test.after(() => cleanup(tmpTasks));
