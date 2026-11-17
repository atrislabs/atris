'use strict';

// The run at 2026-11-15T19:56Z on a private repo, version 3.83.8: a branch
// passed its local check in 145 seconds, its pull request was opened, and
// "gh pr merge --auto" came back with "Auto merge is not allowed for this
// repository". That repo has no required hosted checks, no merge queue and
// auto-merge off, which is how every new GitHub repo starts, so the lander
// had never landed anything there. With nothing on GitHub to wait for, the
// checked commit merges now, pinned with --match-head-commit.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { landStaleGreenBranches, summaryLine } = require('../lib/land-green');
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-land-direct-'));
  git(root, ['init', '-q', '-b', 'master']);
  git(root, ['config', 'user.name', 'Bench Author']);
  git(root, ['config', 'user.email', 'bench@example.com']);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.0' }));
  fs.writeFileSync(path.join(root, 'README.md'), 'fixture\n');
  commitAll(root, 'base', daysAgo(10));
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-land-direct-origin-'));
  git(bare, ['init', '-q', '--bare', '-b', 'master']);
  git(root, ['remote', 'add', 'origin', bare]);
  git(root, ['push', '-q', 'origin', 'master']);
  git(root, ['fetch', '-q', 'origin']);
  git(root, ['checkout', '-q', '-b', 'member/green']);
  fs.writeFileSync(path.join(root, 'feature.txt'), 'shipped\n');
  commitAll(root, 'member/green work');
  git(root, ['checkout', '-q', 'master']);
  return { root, bare };
}

function cleanup(...dirs) {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
}

const AUTO_OFF = 'GraphQL: Auto merge is not allowed for this repository (enablePullRequestAutoMerge)';
const CLEAN_STATUS = 'GraphQL: Pull request Pull request is in clean status (enablePullRequestAutoMerge)';
const NOT_READY = 'GraphQL: Pull Request is not mergeable (mergePullRequest)';
// The rules atrislabs/atris master had on 2026-11-15.
const GUARDED_RULES = JSON.stringify([
  { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'test' }] } },
  { type: 'merge_queue', parameters: { merge_method: 'MERGE', grouping_strategy: 'ALLGREEN' } },
]);

// A GitHub that keeps one pull request, #41, and merges it for real into the
// bare origin when a plain merge is accepted.
function fakeGithub(bare, {
  rules = '[]',
  auto = () => ({ ok: true, stdout: '', stderr: '' }),
  plain = () => ({ ok: true, stdout: '', stderr: '' }),
  open = null,
} = {}) {
  const calls = [];
  const state = { merged: '', created: 0, open: open ? { ...open } : null };
  const runGh = (args) => {
    calls.push(args);
    if (isPullRequestLookup(args)) {
      return pullRequestAnswer(args, (branch) => (state.merged && branch === 'member/green'
        ? [pr({ number: 41, state: 'MERGED', headRefName: branch, headRefOid: state.merged })]
        : []));
    }
    if (args[0] === 'api' && /\/rules\/branches\//.test(args[1])) {
      return rules === null ? { ok: false, stdout: '', stderr: 'HTTP 403: Upgrade to GitHub Pro or make this repository public to enable this feature.' } : { ok: true, stdout: rules, stderr: '' };
    }
    if (args[0] === 'api' && /\/protection/.test(args[1])) return { ok: false, stdout: '', stderr: 'HTTP 404: Branch not protected' };
    if (args[0] === 'pr' && args[1] === 'list') return { ok: true, stdout: JSON.stringify(state.open && !state.merged ? [state.open] : []), stderr: '' };
    if (args[0] === 'pr' && args[1] === 'create') {
      state.created += 1;
      state.open = { number: 41, headRefName: 'member/green', baseRefName: 'master', isCrossRepository: false, url: 'https://github.com/acme/repo/pull/41', isDraft: false, labels: [] };
      return { ok: true, stdout: 'https://github.com/acme/repo/pull/41', stderr: '' };
    }
    if (args[0] === 'pr' && args[1] === 'merge') {
      if (args.includes('--admin')) throw new Error('the lander must never use --admin');
      if (args.includes('--auto')) return auto(args);
      const answer = plain(args);
      if (answer.ok) {
        const sha = args[args.indexOf('--match-head-commit') + 1];
        git(bare, ['update-ref', 'refs/heads/master', sha]);
        state.merged = sha;
      }
      return answer;
    }
    if (args[0] === 'pr' && args[1] === 'view') {
      return { ok: true, stdout: JSON.stringify(state.merged
        ? { state: 'MERGED', headRefOid: state.merged, mergeCommit: { oid: state.merged } }
        : { state: 'OPEN', headRefOid: '', mergeCommit: null }), stderr: '' };
    }
    return { ok: false, stdout: '', stderr: 'unexpected gh call' };
  };
  return { calls, runGh, state };
}

const green = () => ({ status: 0, failing: [], command: 'node check.js', duration_ms: 1, timed_out: false, tail: '' });
const noTasks = () => { throw new Error('no job expected'); };
const merges = (gh) => gh.calls.filter((c) => c[0] === 'pr' && c[1] === 'merge');

function run(root, gh, extra = {}) {
  const recorded = [];
  const closed = [];
  const result = landStaleGreenBranches(root, {
    mergePath: 'pull_request',
    runVerifyFn: green,
    runGh: gh.runGh,
    recordQueued: (cwd, fields) => recorded.push(fields),
    readQueued: () => null,
    readEntries: () => ({}),
    fileConflictTask: noTasks,
    closeCatchUpJobs: (cwd, job) => { closed.push(job); return []; },
    openFlags: false,
    handBack: true,
    mergeRetry: { tries: 4, waitMs: 0, sleep: () => {} },
    ...extra,
  });
  return { result, recorded, closed };
}

test('auto-merge switched off on the repo: the checked commit merges now and is reported landed, not queued', () => {
  const { root, bare } = makeRepo();
  try {
    // The branch rules cannot be read (a private repo on a free plan), so
    // the lander asks for auto-merge first, as it does today.
    const gh = fakeGithub(bare, { rules: null, auto: () => ({ ok: false, stdout: '', stderr: AUTO_OFF }) });
    const { result, recorded, closed } = run(root, gh);
    const verdict = result.verdicts[0];
    assert.equal(verdict.action, 'landed', JSON.stringify(verdict));
    assert.equal(verdict.pr, 41);
    assert.equal(verdict.merged_through, 'pull_request');
    assert.deepEqual(result.landed, ['member/green']);
    assert.deepEqual(result.queued, []);
    const [first, second] = merges(gh);
    assert.deepEqual(first, ['pr', 'merge', '41', '--auto', '--merge', '--match-head-commit', verdict.sha]);
    assert.deepEqual(second, ['pr', 'merge', '41', '--merge', '--match-head-commit', verdict.sha]);
    assert.equal(merges(gh).length, 2);
    assert.equal(recorded.length, 0, 'no queued record that would never resolve');
    assert.equal(git(bare, ['rev-parse', 'master']), verdict.sha, 'the checked commit is what merged');
    assert.equal(closed.length, 1, 'its catch-up jobs close');
    assert.equal(closed[0].pr, 41);
    assert.match(summaryLine(result), /landed member\/green/);
    assert.doesNotMatch(summaryLine(result), /merge queue|error/);
    // The next run does not try it again.
    const again = run(root, gh);
    assert.deepEqual(again.result.landed, []);
    assert.equal(merges(gh).length, 2, 'no merge call on the next run');
    assert.equal(gh.state.created, 1, 'no second pull request');
  } finally {
    cleanup(root, bare);
  }
});

test('a repo with no branch rules at all merges straight away, with no auto-merge ask', () => {
  const { root, bare } = makeRepo();
  try {
    const gh = fakeGithub(bare, { rules: '[]', auto: () => { throw new Error('nothing to wait for, so no auto-merge ask'); } });
    const { result, recorded } = run(root, gh);
    const verdict = result.verdicts[0];
    assert.equal(verdict.action, 'landed', JSON.stringify(verdict));
    assert.deepEqual(merges(gh), [['pr', 'merge', '41', '--merge', '--match-head-commit', verdict.sha]]);
    assert.equal(recorded.length, 0);
    const create = gh.calls.find((c) => c[1] === 'create');
    assert.doesNotMatch(create[create.indexOf('--body') + 1], /merge queue/);
  } finally {
    cleanup(root, bare);
  }
});

test('a pull request in clean status merges now when the owner forced the local check on', () => {
  const { root, bare } = makeRepo();
  try {
    const gh = fakeGithub(bare, { rules: '[]', auto: () => ({ ok: false, stdout: '', stderr: CLEAN_STATUS }) });
    const { result } = run(root, gh, { localCheck: true });
    const verdict = result.verdicts[0];
    assert.equal(verdict.action, 'landed', JSON.stringify(verdict));
    assert.equal(merges(gh).length, 2);
    assert.ok(merges(gh)[0].includes('--auto'));
    assert.ok(!merges(gh)[1].includes('--auto'));
  } finally {
    cleanup(root, bare);
  }
});

test('protected branch rules not configured is the same answer: merge now', () => {
  const { root, bare } = makeRepo();
  try {
    const gh = fakeGithub(bare, { rules: null, auto: () => ({ ok: false, stdout: '', stderr: 'GraphQL: Protected branch rules not configured for this branch (enablePullRequestAutoMerge)' }) });
    const verdict = run(root, gh).result.verdicts[0];
    assert.equal(verdict.action, 'landed', JSON.stringify(verdict));
  } finally {
    cleanup(root, bare);
  }
});

test('seconds after the push GitHub may not know yet: the merge is tried again after a short pause', () => {
  const { root, bare } = makeRepo();
  try {
    let tries = 0;
    const gh = fakeGithub(bare, { plain: () => ((tries += 1) < 3 ? { ok: false, stdout: '', stderr: NOT_READY } : { ok: true, stdout: '', stderr: '' }) });
    const pauses = [];
    const { result } = run(root, gh, { mergeRetry: { tries: 4, waitMs: 7, sleep: (ms) => pauses.push(ms) } });
    const verdict = result.verdicts[0];
    assert.equal(verdict.action, 'landed', JSON.stringify(verdict));
    assert.equal(tries, 3);
    assert.deepEqual(pauses, [7, 7]);
    for (const call of merges(gh)) assert.deepEqual(call, ['pr', 'merge', '41', '--merge', '--match-head-commit', verdict.sha]);
  } finally {
    cleanup(root, bare);
  }
});

test('still not ready after every try: a plain row that says next run, and the next run reuses the open pull request', () => {
  const { root, bare } = makeRepo();
  try {
    let ready = false;
    const gh = fakeGithub(bare, { plain: () => (ready ? { ok: true, stdout: '', stderr: '' } : { ok: false, stdout: '', stderr: NOT_READY }) });
    const pauses = [];
    const first = run(root, gh, { mergeRetry: { tries: 3, waitMs: 5, sleep: (ms) => pauses.push(ms) } });
    const verdict = first.result.verdicts[0];
    assert.equal(verdict.action, 'unknown', JSON.stringify(verdict));
    assert.equal(verdict.reason, 'merge_not_ready');
    assert.equal(verdict.pr, 41);
    assert.match(verdict.detail, /next run/);
    assert.equal(merges(gh).length, 3);
    assert.deepEqual(pauses, [5, 5]);
    assert.equal(first.recorded.length, 0);
    assert.deepEqual(first.result.landed, []);
    assert.deepEqual(first.result.could_not_tell, ['member/green']);
    assert.match(summaryLine(first.result), /could not tell member\/green \(github had not yet worked out whether its pull request can merge\); tries again next run/);
    ready = true;
    const second = run(root, gh);
    assert.equal(second.result.verdicts[0].action, 'landed', JSON.stringify(second.result.verdicts[0]));
    assert.equal(second.result.verdicts[0].pr, 41);
    assert.equal(gh.state.created, 1, 'the open pull request is reused, not a second one opened');
  } finally {
    cleanup(root, bare);
  }
});

test('a repo with required hosted checks and a merge queue still queues with --auto and never merges directly', () => {
  const { root, bare } = makeRepo();
  try {
    const gh = fakeGithub(bare, { rules: GUARDED_RULES, plain: () => { throw new Error('a guarded repo never merges directly'); } });
    const { result, recorded } = run(root, gh, { runVerifyFn: () => { throw new Error('no local suite behind hosted checks'); } });
    const verdict = result.verdicts[0];
    assert.equal(verdict.action, 'queued', JSON.stringify(verdict));
    assert.deepEqual(merges(gh), [['pr', 'merge', '41', '--auto', '--merge', '--match-head-commit', verdict.sha]]);
    assert.equal(recorded.length, 1);
    // Forced on behind the same rules: checked here, then still queued.
    const forced = fakeGithub(bare, { rules: GUARDED_RULES, plain: () => { throw new Error('a guarded repo never merges directly'); } });
    const on = run(root, forced, { localCheck: true, stateFile: null });
    assert.equal(on.result.verdicts[0].action, 'queued', JSON.stringify(on.result.verdicts[0]));
    assert.equal(merges(forced).length, 1);
    assert.ok(merges(forced)[0].includes('--auto'));
  } finally {
    cleanup(root, bare);
  }
});

test('any other auto-merge refusal stays an error, and a direct merge GitHub blocks is an error too', () => {
  const { root, bare } = makeRepo();
  try {
    const gh = fakeGithub(bare, { rules: null, auto: () => ({ ok: false, stdout: '', stderr: 'GraphQL: Pull request is in unstable status (enablePullRequestAutoMerge)' }) });
    const verdict = run(root, gh, { stateFile: null }).result.verdicts[0];
    assert.equal(verdict.action, 'error', JSON.stringify(verdict));
    assert.equal(verdict.reason, 'merge_queue_refused');
    assert.equal(merges(gh).length, 1);
    const blocked = fakeGithub(bare, { plain: () => ({ ok: false, stdout: '', stderr: 'X Pull request acme/repo#41 is not mergeable: the base branch policy prohibits the merge.' }) });
    const pauses = [];
    const direct = run(root, blocked, { stateFile: null, mergeRetry: { tries: 4, waitMs: 1, sleep: (ms) => pauses.push(ms) } }).result.verdicts[0];
    assert.equal(direct.action, 'error', JSON.stringify(direct));
    assert.equal(direct.reason, 'merge_refused');
    assert.equal(merges(blocked).length, 1, 'a real refusal is not retried');
    assert.deepEqual(pauses, []);
  } finally {
    cleanup(root, bare);
  }
});

test('a draft or held pull request found just before the direct merge is left alone', () => {
  const { root, bare } = makeRepo();
  try {
    const open = { number: 41, headRefName: 'member/green', baseRefName: 'master', isCrossRepository: false, url: 'https://github.com/acme/repo/pull/41', isDraft: false, labels: [{ name: 'needs-human' }] };
    const gh = fakeGithub(bare, { open, plain: () => { throw new Error('held means no merge'); } });
    const verdict = run(root, gh, { stateFile: null }).result.verdicts[0];
    assert.equal(verdict.action, 'skipped', JSON.stringify(verdict));
    assert.equal(verdict.reason, 'pull_request_held');
    assert.equal(merges(gh).length, 0);
  } finally {
    cleanup(root, bare);
  }
});
