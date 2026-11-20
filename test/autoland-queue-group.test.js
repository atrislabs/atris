'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { recordQueuedPullRequest, queuedPullRequest, requeueDroppedAutolands } = require('../lib/member-autoland');

const branch = 'feat/member-change';
const group = 'c'.repeat(40);
const at = '2026-11-17T12:25:42Z';

// The queue, the two Git branches and the bare remote exercise the normal
// sweep. Only gh is replaced, with the separate PR and merge-group results
// GitHub returns for a PR whose quick tests passed.
function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-queue-group-'));
  const cwd = path.join(temp, 'main');
  const remote = path.join(temp, 'remote.git');
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  fs.mkdirSync(cwd);
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  git('init', '-q', '-b', 'master');
  git('config', 'user.name', 'test');
  git('config', 'user.email', 'test@example.com');
  git('commit', '-q', '--allow-empty', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  git('init', '-q', '--bare', '-b', 'master', remote);
  git('remote', 'add', 'origin', remote);
  git('switch', '-qc', branch);
  git('commit', '-q', '--allow-empty', '-m', 'queued work');
  const head = git('rev-parse', 'HEAD');
  git('push', '-q', 'origin', 'master', branch);
  git('switch', '-q', 'master');
  fs.mkdirSync(path.join(cwd, '.atris/policy'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.atris/policy/autoland.json'), '{"enabled":true}');
  const track = () => recordQueuedPullRequest(cwd, { branch, base: 'master', number: 7, pushed: head, source: 'land-green', requeues: 1 }, { fresh: true });
  track();

  const config = path.join(temp, 'github.json');
  const log = path.join(temp, 'gh-calls');
  fs.writeFileSync(path.join(temp, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const cfg = JSON.parse(fs.readFileSync(${JSON.stringify(config)}, 'utf8'));
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[0] === 'api' && args[1] === 'graphql') {
  if (cfg.apiError) process.exit(1);
  if (args.includes('--jq')) console.log('false');
  else console.log(JSON.stringify({ data: { repository: { pullRequest: cfg.pr } } }));
} else if (args[0] === 'api' && args[1].endsWith('/rules/branches/master')) {
  console.log(JSON.stringify([{ type: 'merge_queue' }, { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'test' }] } }]));
} else if (args[0] === 'pr' && args[1] === 'view') console.log(JSON.stringify(cfg.pr));
else if (args[0] === 'pr' && args[1] === 'checks') console.log(JSON.stringify([{ name: 'test', bucket: 'pass' }]));
else if (args[0] === 'pr' && args[1] === 'merge' && args.includes('--disable-auto')) {
  cfg.pr.autoMergeRequest = null;
  fs.writeFileSync(${JSON.stringify(config)}, JSON.stringify(cfg));
} else process.exit(1);
`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = temp + path.delimiter + oldPath;
  t.after(() => { process.env.PATH = oldPath; });
  function github(reason, { auto = false, apiError = false } = {}) {
    const pr = {
      number: 7, state: 'OPEN', isCrossRepository: false, headRefOid: head, headRefName: branch, baseRefName: 'master',
      mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', isInMergeQueue: false,
      autoMergeRequest: auto ? { enabledAt: '2026-11-17T11:12:13Z' } : null,
      timelineItems: { nodes: [{ __typename: 'RemovedFromMergeQueueEvent', reason, createdAt: at, beforeCommit: {
        oid: group, parents: { nodes: [{ oid: base }, { oid: head }] },
        statusCheckRollup: { contexts: { nodes: [{ name: 'unit (3/8)', conclusion: 'FAILURE', detailsUrl: 'https://github.com/example/repo/actions/runs/12/job/34' }] } },
      } }] },
    };
    fs.writeFileSync(config, JSON.stringify({ pr, apiError }));
  }
  const jobs = [];
  function sweep(dryRun = false) {
    return requeueDroppedAutolands({ cwd, dryRun, fileChecksTask: (root, job) => {
      jobs.push(job);
      return { id: 'fix-the-check', inserted: true };
    } }).results[0];
  }
  const writes = () => fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    .filter(args => args[1] === 'merge' || args[1] === 'rerun');
  return { head, jobs, git, github, sweep, writes, track, entry: () => queuedPullRequest(cwd, branch),
    remoteHead: () => git('ls-remote', remote, 'refs/heads/' + branch).split('\t')[0] };
}

test('failed merge-group checks hand the exact head back once even when its quick tests passed', t => {
  const fx = fixture(t);
  fx.github('failed_checks', { auto: true });
  const before = fx.entry();
  const preview = fx.sweep(true);
  assert.equal(preview.state, 'would-hand-back', preview.line);
  assert.deepEqual(fx.writes(), []);
  assert.deepEqual(fx.jobs, []);
  assert.deepEqual(fx.entry(), before);
  assert.equal(fx.remoteHead(), fx.head);

  const actual = fx.sweep();
  assert.equal(actual.state, 'handed_back', actual.line);
  assert.deepEqual(fx.writes(), [['pr', 'merge', '7', '--disable-auto']]);
  assert.equal(fx.jobs.length, 1);
  assert.equal(fx.jobs[0].pushed, fx.head);
  assert.equal(fx.jobs[0].number, 7);
  assert.equal(fx.entry().checks_task, 'fix-the-check');
  assert.equal(fx.entry().queue_failure.group, group);
  fx.sweep();
  assert.equal(fx.jobs.length, 1);
  assert.equal(fx.writes().length, 1);
  assert.equal(fx.remoteHead(), fx.head);
});

test('manual removals, unknown reasons and unreadable history cannot enable auto-merge or push a catch-up', t => {
  const fx = fixture(t);
  fx.git('commit', '-q', '--allow-empty', '-m', 'main has moved');
  fx.git('push', '-q', 'origin', 'master');
  for (const [reason, apiError] of [['manually_dequeued', false], ['future_reason', false], ['failed_checks', true]]) {
    fx.track();
    fx.github(reason, { apiError });
    const result = fx.sweep();
    assert.notEqual(result.state, 'queued', result.line);
    assert.notEqual(result.state, 'requeued', result.line);
    assert.deepEqual(fx.writes(), []);
    assert.deepEqual(fx.jobs, []);
    assert.equal(fx.remoteHead(), fx.head);
  }
});
