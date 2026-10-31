'use strict';

// Work in a protected lane (feedback, billing, security, ...) is never merged
// by a flight. It goes to a person as an open pull request and the job waits in
// Review under the builder's name. Before this, the ship gate refused the whole
// ship, the flight released the claim with no reason, and `atris rating` scored
// good work as a drop while no pull request existed for anyone to review.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const tasks = require('../lib/task-db');
const fleet = require('../lib/fleet');
const { loadSeason, rosterRows } = require('../lib/gm-season');
const { readRosterRuns, summarizeRuns, OUTCOMES } = require('../lib/roster-runs');
const { attachStaleModels } = require('../lib/roster-stale');
const { scrubAgentEnv } = require('./helpers/agent-env');

const CLI = path.resolve(__dirname, '..', 'bin', 'atris.js');
const PR_URL = 'https://github.example/repo/pull/77';
const COMMIT = '93b6d4bcf66276bbd6a53aebe72ab48bf9a7b136';
const DAY = 86400000;

const BLOCKED = (taskId, lane) => `blocked: this branch carries ${taskId} which sits in the protected ${lane} lane; a human lands it (or pass --allow-denied-lane on written order)`;

// ---------------------------------------------------------------------------
// The ship gate: real git, a fake `gh`. It guards landing, not review.

function shipSetup(t, { tag = 'feedback', todoTags = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'held-ship-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const remote = path.join(root, 'remote.git');
  const primary = path.join(root, 'primary');
  const work = path.join(root, 'work');
  const bin = path.join(root, 'bin');
  const ghLog = path.join(root, 'gh.log');
  fs.mkdirSync(primary);
  fs.mkdirSync(bin);
  const git = (args, cwd = primary) => spawnSync('git', args, { cwd, encoding: 'utf8' });
  const checked = (args, cwd) => { const run = git(args, cwd); assert.equal(run.status, 0, run.stderr); return run.stdout.trim(); };
  checked(['init', '--bare', '-q', remote]);
  checked(['init', '-q']);
  checked(['config', 'user.name', 'Test User']);
  checked(['config', 'user.email', 'test@example.com']);
  fs.writeFileSync(path.join(primary, '.gitignore'), '.atris/\n');
  fs.writeFileSync(path.join(primary, 'app.js'), 'module.exports = 1;\n');
  checked(['add', '.']);
  checked(['commit', '-qm', 'initial']);
  checked(['branch', '-M', 'master']);
  checked(['remote', 'add', 'origin', remote]);
  checked(['push', '-u', 'origin', 'master']);
  checked(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/master']);
  checked(['worktree', 'add', '-q', '-b', 'bck-1934-fix', work, 'master']);
  fs.writeFileSync(path.join(work, 'app.js'), 'module.exports = 2;\n');
  // The ship gate finds the task through the primary checkout's projection.
  fs.mkdirSync(path.join(primary, '.atris', 'state'), { recursive: true });
  fs.writeFileSync(path.join(primary, '.atris', 'state', 'tasks.projection.json'), JSON.stringify({
    tasks: [{ display_id: 'BCK-1934', tag, metadata: { todo_tags: todoTags } }],
  }));
  // `gh pr view` answers the way the real one does. With no setup the branch has
  // no pull request yet: exit 1 and say so on stderr. A test can give the branch
  // an open pull request, make gh fail, or make it print something that is not
  // JSON. Creating a pull request prints its link. Every call is written down
  // so a test can say what was never asked for.
  const viewSetup = path.join(root, 'pr-view.json');
  fs.writeFileSync(path.join(bin, 'gh'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(ghLog)}, args.join(' ') + '\\n');
if (args[0] === 'pr' && args[1] === 'view') {
  const setup = fs.existsSync(${JSON.stringify(viewSetup)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(viewSetup)}, 'utf8')) : null;
  if (!setup) { console.error('no pull requests found for branch "bck-1934-fix"'); process.exit(1); }
  if (setup.fail) { console.error(setup.fail); process.exit(1); }
  if (setup.raw !== undefined) { process.stdout.write(setup.raw); process.exit(0); }
  if (args.includes('--jq')) console.log(setup.pr.number + ' ' + setup.pr.url + ' ' + setup.pr.state);
  else console.log(JSON.stringify(setup.pr));
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'create') { console.log(${JSON.stringify(PR_URL)}); process.exit(0); }
process.exit(1);
`, { mode: 0o755 });
  const prView = (setup) => fs.writeFileSync(viewSetup, JSON.stringify(setup));
  const ship = (...extra) => spawnSync(process.execPath, [CLI, 'worktree', 'ship', '--message', 'Fix the form (BCK-1934, built by codex)', '--no-map-refresh', ...extra], {
    cwd: work,
    encoding: 'utf8',
    timeout: 30000,
    env: { ...scrubAgentEnv(), PATH: `${bin}${path.delimiter}${process.env.PATH}`, ATRIS_SKIP_UPDATE_CHECK: '1' },
  });
  const onRemote = () => git(['--git-dir', remote, 'show-ref', '--verify', '--quiet', 'refs/heads/bck-1934-fix'], root).status === 0;
  const ghCalls = () => (fs.existsSync(ghLog) ? fs.readFileSync(ghLog, 'utf8').split('\n').filter(Boolean) : []);
  return { ship, onRemote, ghCalls, prView, work };
}

test('without --merge a protected-lane branch is pushed and its pull request is opened for a person', (t) => {
  const { ship, onRemote, ghCalls } = shipSetup(t);
  const run = ship();
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /^push: origin bck-1934-fix$/m);
  assert.match(run.stdout, new RegExp(`^pr: ${PR_URL.replace(/[.]/g, '\\.')}$`, 'm'));
  assert.match(run.stdout, /^done: worktree shipped$/m);
  assert.doesNotMatch(run.stdout, /merge:/);
  assert.equal(onRemote(), true, 'the branch is on the remote for the reviewer');
  assert.equal(ghCalls().some((call) => call.startsWith('pr create ')), true);
  assert.equal(ghCalls().some((call) => call.startsWith('pr merge')), false, 'nothing asked for a merge');
  // The flight reads the link straight off this output.
  assert.deepEqual(fleet.shipPullRequest(run.stdout), { url: PR_URL, number: 77 });
});

test('landing a protected-lane branch (--merge or --local) is still refused with the same words, and nothing is pushed', (t) => {
  const { ship, onRemote, ghCalls } = shipSetup(t);
  for (const flag of ['--merge', '--local']) {
    const run = ship(flag);
    assert.equal(run.status, 2, `${flag}: ${run.stdout}`);
    assert.equal(run.stderr.trim(), BLOCKED('BCK-1934', 'feedback'));
    assert.doesNotMatch(run.stdout, /push:|pr:|done: worktree shipped/);
  }
  assert.equal(onRemote(), false);
  assert.deepEqual(ghCalls(), []);
});

test('--allow-denied-lane still lets a person land it, and a task in a todo tag lane is held to the same rule', (t) => {
  const { ship } = shipSetup(t);
  const allowed = ship('--dry-run', '--merge', '--allow-denied-lane');
  assert.equal(allowed.status, 0, allowed.stderr || allowed.stdout);
  assert.match(allowed.stdout, /^merge: requested$/m);

  const todo = shipSetup(t, { tag: 'code', todoTags: ['Security'] });
  const refused = todo.ship('--dry-run', '--merge');
  assert.equal(refused.status, 2, refused.stdout);
  assert.equal(refused.stderr.trim(), BLOCKED('BCK-1934', 'security'));
  assert.equal(todo.ship('--dry-run').status, 0, 'pushing for review is fine in a todo tag lane too');
});

test('a safe-lane branch is not slowed down by the gate', (t) => {
  const { ship } = shipSetup(t, { tag: 'code' });
  const run = ship('--dry-run', '--merge');
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /^merge: requested$/m);
});

// A pull request with GitHub auto-merge on merges itself the moment its checks
// pass, and a push is all it takes to feed it. Work that shipped earlier with
// --merge and was retagged into a protected lane since would land with no person.

const AUTO_MERGE_ON = { enabledAt: '2026-10-30T10:00:00Z', mergeMethod: 'MERGE' };
const openPullRequest = (autoMergeRequest) => ({ pr: { number: 77, url: PR_URL, state: 'OPEN', autoMergeRequest } });

test('a protected-lane push is refused when the branch already has an open pull request with auto-merge on, and nothing is pushed', (t) => {
  const { ship, onRemote, ghCalls, prView } = shipSetup(t);
  prView(openPullRequest(AUTO_MERGE_ON));
  const run = ship();
  assert.equal(run.status, 2, `${run.stdout}${run.stderr}`);
  assert.equal(run.stderr.trim(), `blocked: pull request ${PR_URL} has auto-merge on, so pushing bck-1934-fix would land it with no person; turn auto-merge off first (gh pr merge 77 --disable-auto), then ship again`);
  assert.doesNotMatch(run.stdout, /push:|pr:|done: worktree shipped/);
  assert.equal(onRemote(), false, 'the branch never reached the remote');
  assert.equal(ghCalls().some((call) => call.startsWith('pr create ') || call.startsWith('pr merge')), false);
});

test('a protected-lane push that cannot be checked is refused too: gh fails, or answers with something that is not JSON', (t) => {
  for (const [label, setup, said] of [
    ['gh is not signed in', { fail: 'HTTP 401: Bad credentials (https://api.github.com/graphql)' }, /Bad credentials/],
    ['gh prints nonsense', { raw: 'this is not json' }, /gh's answer could not be read/],
    ['gh answers with nothing', { raw: '' }, /gh's answer could not be read/],
  ]) {
    const { ship, onRemote, ghCalls, prView } = shipSetup(t);
    prView(setup);
    const run = ship();
    assert.equal(run.status, 2, `${label}: ${run.stdout}${run.stderr}`);
    assert.match(run.stderr, /^blocked: cannot tell whether bck-1934-fix has a pull request with auto-merge on/, label);
    assert.match(run.stderr, said, label);
    assert.match(run.stderr, /nothing was pushed/, label);
    assert.doesNotMatch(run.stdout, /push:|pr:|done: worktree shipped/, label);
    assert.equal(onRemote(), false, label);
    assert.equal(ghCalls().some((call) => call.startsWith('pr create ')), false, label);
  }
});

test('the auto-merge check only guards protected-lane pushes, and only when auto-merge is really on', (t) => {
  // No pull request yet, which is what gh says on a first push: ship goes on.
  const first = shipSetup(t);
  assert.equal(first.ship().status, 0);
  assert.equal(first.onRemote(), true);

  // An open pull request with auto-merge off is the ordinary re-push.
  const off = shipSetup(t);
  off.prView(openPullRequest(null));
  const repush = off.ship();
  assert.equal(repush.status, 0, repush.stderr || repush.stdout);
  assert.match(repush.stdout, /^push: origin bck-1934-fix$/m);
  assert.equal(off.onRemote(), true);

  // A pull request that already merged does not stop a new one, and neither does
  // a closed one that still reports an old auto-merge request.
  const merged = shipSetup(t);
  merged.prView({ pr: { number: 70, url: 'https://github.example/repo/pull/70', state: 'MERGED', autoMergeRequest: null } });
  assert.equal(merged.ship().status, 0);
  const closed = shipSetup(t);
  closed.prView({ pr: { number: 71, url: 'https://github.example/repo/pull/71', state: 'closed', autoMergeRequest: AUTO_MERGE_ON } });
  assert.equal(closed.ship().status, 0);

  // An answer in a shape nobody expected, with auto-merge on, is not let through.
  const odd = shipSetup(t);
  odd.prView({ pr: { number: 72, url: 'https://github.example/repo/pull/72', state: 'REOPENED_SOMEHOW', autoMergeRequest: AUTO_MERGE_ON } });
  assert.equal(odd.ship().status, 2);
  assert.equal(odd.onRemote(), false);

  // A safe-lane branch is never held up by it, whatever gh says.
  const safe = shipSetup(t, { tag: 'code' });
  safe.prView(openPullRequest(AUTO_MERGE_ON));
  assert.equal(safe.ship().status, 0);
  assert.equal(safe.onRemote(), true);

  // A person who lands it on written order is not asked either.
  const ordered = shipSetup(t);
  ordered.prView(openPullRequest(AUTO_MERGE_ON));
  const allowed = ordered.ship('--allow-denied-lane');
  assert.equal(allowed.status, 0, allowed.stderr || allowed.stdout);
  assert.equal(ordered.onRemote(), true);
});

test('without gh, or with a gh that hangs, the auto-merge check refuses instead of guessing', () => {
  const { protectedPushRefusal } = require('../commands/worktree');
  const gone = () => ({ error: Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }), status: null, stdout: '', stderr: '' });
  const refusal = protectedPushRefusal(os.tmpdir(), 'bck-1934-fix', gone);
  assert.match(refusal, /^blocked: cannot tell whether bck-1934-fix has a pull request with auto-merge on \(gh did not run: spawn gh ENOENT\); nothing was pushed$/);
  // A gh that hangs is cut off after a minute and refused in plain words.
  const slow = () => ({ error: Object.assign(new Error('spawnSync gh ETIMEDOUT'), { code: 'ETIMEDOUT' }), status: null, stdout: '', stderr: '' });
  assert.match(protectedPushRefusal(os.tmpdir(), 'bck-1934-fix', slow), /^blocked: cannot tell whether bck-1934-fix has a pull request with auto-merge on \(gh took longer than a minute to answer\); nothing was pushed$/);
  let asked = null;
  protectedPushRefusal(os.tmpdir(), 'x', (command, args, options) => { asked = { command, args, options }; return { status: 1, stdout: '', stderr: 'no pull requests found for branch "x"' }; });
  assert.equal(asked.command, 'gh');
  assert.deepEqual(asked.args.slice(0, 3), ['pr', 'view', 'x']);
  assert.ok(asked.options.timeout > 0 && asked.options.timeout <= 120000, 'the lookup has a time limit');
  // Both spellings of "no pull request yet" are a clear.
  for (const stderr of ['no pull requests found for branch "x"', 'no open pull requests found for branch "x"']) {
    assert.equal(protectedPushRefusal(os.tmpdir(), 'x', () => ({ status: 1, stdout: '', stderr })), '');
  }
});

// ---------------------------------------------------------------------------
// Small pieces the flight and the gate share.

test('protectedLaneOfTask reads the tag and the todo tags, in any case', () => {
  assert.equal(fleet.protectedLaneOfTask({ tag: 'Feedback' }), 'feedback');
  assert.equal(fleet.protectedLaneOfTask({ tag: 'code', metadata: { todo_tags: ['docs', 'BILLING'] } }), 'billing');
  assert.equal(fleet.protectedLaneOfTask({ tag: 'code', metadata: { todo_tags: ['docs'] } }), null);
  assert.equal(fleet.protectedLaneOfTask({ tag: 'code' }), null);
  assert.equal(fleet.protectedLaneOfTask({}), null);
  assert.equal(fleet.protectedLaneOfTask(null), null);
  for (const tag of fleet.DENIED_TAGS) assert.equal(fleet.protectedLaneOfTask({ tag }), tag);
});

test('shipPullRequest reads the link ship printed, and nothing when no pull request was opened', () => {
  assert.deepEqual(fleet.shipPullRequest(`push: origin x\npr: https://github.com/atrislabs/atris/pull/1700\ndone: worktree shipped\n`),
    { url: 'https://github.com/atrislabs/atris/pull/1700', number: 1700 });
  assert.deepEqual(fleet.shipPullRequest('pr: 41 https://github.example/repo/pull/41\ndone: worktree shipped\n'),
    { url: 'https://github.example/repo/pull/41', number: 41 });
  assert.deepEqual(fleet.shipPullRequest('pr: https://git.example/merge-requests/9\n'), { url: 'https://git.example/merge-requests/9' });
  assert.equal(fleet.shipPullRequest('pr: skipped (no commits ahead of base)\npr: \ndone: worktree shipped\n'), null);
  assert.equal(fleet.shipPullRequest('pr: skipped (--no-pr)\n'), null);
  assert.equal(fleet.shipPullRequest(''), null);
  assert.equal(fleet.shipPullRequest(undefined), null);
});

test('the flight names an open pull request to task ready without a merge commit, and merges only when told to', () => {
  assert.deepEqual(fleet.openPullRequestFlags({ url: PR_URL, number: 77 }), ['--pr-number', '77', '--pr-url', PR_URL]);
  assert.deepEqual(fleet.openPullRequestFlags({ url: PR_URL }), ['--pr-url', PR_URL]);
  assert.deepEqual(fleet.openPullRequestFlags(null), []);
  const entry = { task: { display_id: 'BCK-1934', title: 'Fix the form. Done: x.' }, engine: 'codex', worktreePath: os.tmpdir() };
  const merging = fleet.fleetShipArgs(entry, 'node --test x.test.js', 'origin/master');
  const reviewing = fleet.fleetShipArgs(entry, 'node --test x.test.js', 'origin/master', { merge: false });
  assert.equal(merging.includes('--merge'), true);
  assert.equal(reviewing.includes('--merge'), false);
  assert.deepEqual(merging.filter((arg) => arg !== '--merge'), reviewing);
});

// ---------------------------------------------------------------------------
// The dispatch flight, with a fake task plane and a fake ship.

const FEEDBACK_TASK = {
  display_id: 'BCK-1934',
  status: 'open',
  tag: 'feedback',
  title: 'Fix the form so people stop retyping. Done: the form keeps what was typed. Check: node --test test/form.test.js.',
};

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'held-flight-'));
  const saved = process.env.ATRIS_TASKS_DB;
  // The flight keeps claim leases in the task db it finds by env; keep it in the sandbox.
  process.env.ATRIS_TASKS_DB = path.join(root, 'tasks.db');
  t.after(() => {
    tasks.close();
    if (saved === undefined) delete process.env.ATRIS_TASKS_DB; else process.env.ATRIS_TASKS_DB = saved;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function fakeTaskPlane({ task, shipOutput, shipStatus = 0, readyStatus = 0, readyError = 'ready failed: nope', releaseStatus = 0 }) {
  const calls = [];
  const cli = (args) => {
    calls.push(args);
    if (args[0] === 'task' && args[1] === 'show') return { status: 0, stdout: JSON.stringify(task), stderr: '' };
    if (args[0] === 'worktree' && args[1] === 'start') return { status: 0, stdout: `next: cd /wt/${args[args.indexOf('--task') + 1]}\n`, stderr: '' };
    if (args[0] === 'worktree' && args[1] === 'ship') return { status: shipStatus, stdout: shipOutput, stderr: shipStatus ? 'ship failed' : '' };
    if (args[0] === 'task' && args[1] === 'ready') return { status: readyStatus, stdout: readyStatus ? '' : 'proof ready', stderr: readyStatus ? readyError : '' };
    if (args[0] === 'task' && args[1] === 'release') return { status: releaseStatus, stdout: releaseStatus ? '' : 'released', stderr: releaseStatus ? 'release failed: busy' : '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  return { cli, calls };
}

async function flyWith(t, plane) {
  const root = tempRoot(t);
  const logs = [];
  const flight = await fleet.runDispatchFlight({
    root,
    taskIds: [plane.task.display_id],
    engine: 'codex',
    ownCli: plane.cli,
    dispatcher: () => Promise.resolve({ exitCode: 0, report: 'engine report' }),
    rebase: () => ({ ok: true, stage: 'rebased' }),
    verifier: () => ({ status: 0, stdout: '# tests 3\n# pass 3\n# fail 0\n', stderr: '' }),
    log: (line = '') => logs.push(String(line)),
  });
  return { flight, logs, root, receipt: JSON.parse(fs.readFileSync(flight.receipt, 'utf8')) };
}

const planeFor = (task, options = {}) => ({ task, ...fakeTaskPlane({ task, shipOutput: `push: origin codex/dispatch\npr: ${PR_URL}\ndone: worktree shipped\n`, ...options }) });
const callsTo = (plane, ...words) => plane.calls.filter((args) => words.every((word, i) => args[i] === word));
const flagValue = (args, flag) => args[args.indexOf(flag) + 1];

for (const [label, task] of [
  ['its tag', FEEDBACK_TASK],
  ['a todo tag', { ...FEEDBACK_TASK, tag: 'code', metadata: { todo_tags: ['billing'] } }],
]) {
  test(`a fix in a protected lane (by ${label}) is shipped without --merge and waits in Review with its pull request`, async (t) => {
    const plane = planeFor(task);
    const { flight, logs, receipt } = await flyWith(t, plane);

    const [ship] = callsTo(plane, 'worktree', 'ship');
    assert.ok(ship, 'ship ran');
    assert.equal(ship.includes('--merge'), false, 'a flight never merges protected-lane work');
    assert.equal(flagValue(ship, '--verify'), 'node --test test/form.test.js');

    assert.deepEqual(flight.landed, []);
    assert.deepEqual(flight.paused, []);
    assert.equal(flight.status, 'completed', 'a fix waiting for review is not a failed flight');
    assert.equal(flight.held_for_review.length, 1);
    const [held] = flight.held_for_review;
    assert.equal(held.task, 'BCK-1934');
    assert.equal(held.engine, 'codex');
    assert.equal(held.lane, task.tag === 'feedback' ? 'feedback' : 'billing');
    assert.deepEqual(held.pull_request, { url: PR_URL, number: 77 });
    assert.equal(held.review_recorded, true);
    assert.equal(held.verifier_result.passed, true);

    // The proof goes to Review under the builder's name with the pull request
    // and no merge commit, so nothing reads it as landed.
    const [ready] = callsTo(plane, 'task', 'ready');
    assert.equal(ready[2], 'BCK-1934');
    assert.equal(flagValue(ready, '--as'), 'fleet-codex');
    assert.equal(flagValue(ready, '--pr-url'), PR_URL);
    assert.equal(flagValue(ready, '--pr-number'), '77');
    for (const flag of ['--merge-commit', '--self-landed', '--merged-at']) assert.equal(ready.includes(flag), false, flag);
    assert.match(flagValue(ready, '--proof'), /not merged: pull request https:\/\/github\.example\/repo\/pull\/77 waits for a person to land it/);
    assert.match(flagValue(ready, '--proof'), /# pass 3/, 'the proof carries the real verifier output');
    assert.match(flagValue(ready, '--checked'), /passed before the pull request was opened/);

    // The claim stays with the builder: no release, and so no drop on the rating.
    assert.deepEqual(callsTo(plane, 'task', 'release'), []);

    assert.ok(logs.includes(`    ⏸ BCK-1934 waits for a person to land it: ${PR_URL}`), logs.join('\n'));
    assert.equal(logs.some((line) => /✓ landed/.test(line)), false);
    assert.ok(logs.some((line) => line.includes('dispatch over: 0 landed, 1 waiting for a person to land, 0 paused')), logs.join('\n'));

    // The receipt tells the held job apart from a landed one and from a failure.
    assert.equal(receipt.status, 'completed');
    assert.deepEqual(receipt.landed, []);
    assert.deepEqual(receipt.paused, []);
    assert.equal(receipt.held_for_review.length, 1);
    assert.equal(receipt.held_for_review[0].pull_request.url, PR_URL);
    assert.equal(receipt.held_for_review[0].review_recorded, true);
    assert.equal(receipt.result.kind, 'dispatch_held_for_review');
    assert.equal(receipt.result.passed, true);
    assert.equal(receipt.result.held_for_review, 1);
  });
}

test('a safe-lane fix is still merged and counted as landed, with no held row', async (t) => {
  const task = { ...FEEDBACK_TASK, tag: 'code' };
  const record = JSON.stringify({ merge_commit: COMMIT, number: 4676, url: 'https://github.example/repo/pull/4676', merged_at: '2026-10-31T02:10:45Z' });
  const plane = planeFor(task, { shipOutput: `merge: merged\nmerge: record ${record}\ndone: worktree shipped\n` });
  const { flight, logs, receipt } = await flyWith(t, plane);

  assert.equal(callsTo(plane, 'worktree', 'ship')[0].includes('--merge'), true);
  assert.deepEqual(flight.landed.map((row) => row.task), ['BCK-1934']);
  assert.deepEqual(flight.held_for_review, []);
  assert.deepEqual(flight.paused, []);
  const [ready] = callsTo(plane, 'task', 'ready');
  assert.equal(flagValue(ready, '--merge-commit'), COMMIT);
  assert.equal(ready.includes('--self-landed'), true);
  assert.ok(logs.includes('    ✓ landed BCK-1934'));
  assert.equal(logs.some((line) => /waits for a person/.test(line)), false);
  assert.equal(receipt.result.kind, 'dispatch_landed');
  assert.equal(receipt.result.held_for_review, undefined);
  assert.deepEqual(receipt.held_for_review, []);
});

test('if saving the proof fails, the claim is let go at once with the pull request link as the reason, so no sweep can expire it as a drop', async (t) => {
  const plane = planeFor(FEEDBACK_TASK, { readyStatus: 1 });
  const { flight, logs, receipt } = await flyWith(t, plane);

  assert.equal(flight.status, 'failed');
  assert.equal(flight.paused.length, 1);
  const [paused] = flight.paused;
  assert.equal(paused.task, 'BCK-1934');
  assert.equal(paused.stage, 'task_ready');
  assert.equal(paused.held_for_review, true);
  assert.equal(paused.landed, undefined);
  assert.match(paused.next_action, /leave the pull request open/);
  assert.deepEqual(paused.pull_request, { url: PR_URL, number: 77 });
  assert.equal(flight.held_for_review[0].review_recorded, false);

  // The claim would otherwise sit on its 60 minute lease and then expire as a
  // plain drop while the pull request is open. It goes now, under the builder's
  // own name, and the reason is where anyone finds the pull request.
  const releases = callsTo(plane, 'task', 'release');
  assert.equal(releases.length, 1, 'one release, made once');
  assert.equal(releases[0][2], 'BCK-1934');
  assert.equal(flagValue(releases[0], '--as'), 'fleet-codex');
  assert.equal(flagValue(releases[0], '--reason'), `PR ${PR_URL} is open but its proof could not be saved: ready failed: nope`);
  assert.equal(paused.claim_released, true);
  assert.ok(plane.calls.indexOf(releases[0]) > plane.calls.indexOf(callsTo(plane, 'task', 'ready')[0]), 'the release follows the failed save');

  assert.ok(logs.some((line) => /the pull request is open, but saving its proof failed/.test(line)), logs.join('\n'));
  assert.equal(receipt.result.passed, false);
  assert.equal(receipt.paused[0].claim_released, true);
  assert.deepEqual(receipt.paused[0].pull_request, { url: PR_URL, number: 77 });
});

test('the release reason carries only the first line of the save error, and a release that fails is said so and not tried again', async (t) => {
  const multiline = planeFor(FEEDBACK_TASK, { readyStatus: 1, readyError: '\n  database is locked\n    at saveProof (task-db.js:12:3)\n' });
  await flyWith(t, multiline);
  assert.equal(flagValue(callsTo(multiline, 'task', 'release')[0], '--reason'), `PR ${PR_URL} is open but its proof could not be saved: database is locked`);

  const long = planeFor(FEEDBACK_TASK, { readyStatus: 1, readyError: `x${'y'.repeat(500)}` });
  await flyWith(t, long);
  const reason = flagValue(callsTo(long, 'task', 'release')[0], '--reason');
  assert.ok(reason.length <= 300, `${reason.length} characters`);
  assert.ok(reason.startsWith(`PR ${PR_URL} is open but its proof could not be saved: x`), 'the link comes first, so a long error never cuts it');

  const stuck = planeFor(FEEDBACK_TASK, { readyStatus: 1, releaseStatus: 1 });
  const { flight, logs } = await flyWith(t, stuck);
  assert.equal(callsTo(stuck, 'task', 'release').length, 1, 'the end-of-flight pass does not retry it');
  assert.equal(flight.paused[0].claim_released, false);
  assert.ok(logs.some((line) => /could not release the claim/.test(line)), logs.join('\n'));
});

test('a protected-lane ship with no pull request link pauses at ship and says why, instead of pretending', async (t) => {
  for (const [shipOutput, wanted] of [
    ['pr: skipped (no commits ahead of base)\npr: \ndone: worktree shipped\n', 'no commits ahead of base, so there was no pull request to open'],
    ['push: origin codex/dispatch\ndone: worktree shipped\n', 'the branch was pushed, but no pull request link came back for the protected feedback lane'],
  ]) {
    const plane = planeFor(FEEDBACK_TASK, { shipOutput });
    const { flight } = await flyWith(t, plane);
    assert.deepEqual(flight.held_for_review, []);
    assert.deepEqual(flight.landed, []);
    assert.equal(flight.paused.length, 1);
    assert.equal(flight.paused[0].stage, 'ship');
    assert.equal(flight.paused[0].detail, wanted);
    assert.deepEqual(callsTo(plane, 'task', 'ready'), []);
    // Nothing is waiting on a person here, so the claim is let go, with the reason saved.
    const [release] = callsTo(plane, 'task', 'release');
    assert.equal(flagValue(release, '--reason'), `paused at ship: ${wanted}`);
  }
});

// ---------------------------------------------------------------------------
// The real task plane and the rating.

function sandboxDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'held-season-'));
  const dbPath = path.join(dir, 'tasks.db');
  const saved = process.env.ATRIS_TASKS_DB;
  process.env.ATRIS_TASKS_DB = dbPath;
  const db = tasks.open(dbPath);
  t.after(() => {
    tasks.close();
    if (saved === undefined) delete process.env.ATRIS_TASKS_DB; else process.env.ATRIS_TASKS_DB = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, dbPath, db };
}

// A job the flight built in a protected lane: claimed, then sent to Review
// with its open pull request and no merge commit.
function heldJob(db, dir, { title = 'Fix the feedback form', builder = 'fleet-codex' } = {}) {
  const { id } = tasks.addTask(db, { title, tag: 'feedback', workspaceRoot: dir });
  assert.equal(tasks.claimTask(db, { id, claimedBy: builder, leaseMinutes: 60, leasePid: process.pid }).claimed, true);
  const ready = tasks.readyTask(db, {
    id,
    actor: builder,
    proof: 'Built and verified; the pull request waits for a person to land it.',
    merge: { number: '77', url: PR_URL },
  });
  assert.equal(ready.ready, true);
  return id;
}

const seasonOf = (dir, dbPath) => {
  const season = loadSeason(dir, { dbPath, now: Date.now() + 1000, lastSeen: null });
  assert.equal(season.error, undefined);
  return season;
};
const playsOf = (season, id) => season.outcomes.filter((o) => o.task_id === id);
const memberRow = (season, name) => rosterRows({ outcomes: season.outcomes, limit: Number.MAX_SAFE_INTEGER }).find((row) => row.name === name);
const proofPayloads = (db, id) => db.prepare("SELECT payload FROM task_events WHERE task_id = ? AND event_type = 'proof_ready' ORDER BY version").all(id).map((row) => JSON.parse(row.payload));

test('a held job sits in Review under the builder with its open pull request on file, and nothing says it landed', (t) => {
  const { dir, db } = sandboxDb(t);
  const id = heldJob(db, dir);
  const row = tasks.getTask(db, id);
  assert.equal(row.status, 'review');
  assert.equal(row.claimed_by, 'fleet-codex');
  assert.equal(row.metadata.lease, undefined, 'a review row carries no claim lease');
  assert.equal(row.metadata.merge_commit, undefined);
  const [payload] = proofPayloads(db, id);
  assert.deepEqual(payload.pull_request, { state: 'open', number: 77, url: PR_URL });
  assert.equal(payload.landing.merge_commit, undefined);
  assert.equal(payload.self_landed, undefined);

  // A pull request with a merge commit is a landing; one without is not, and
  // junk in the link fields is dropped rather than saved.
  const odd = tasks.addTask(db, { title: 'odd link', workspaceRoot: dir }).id;
  tasks.claimTask(db, { id: odd, claimedBy: 'fleet-codex' });
  tasks.readyTask(db, { id: odd, actor: 'fleet-codex', proof: 'ready', merge: { number: 'x', url: 'javascript:alert(1)' } });
  assert.equal(proofPayloads(db, odd)[0].pull_request, undefined);
});

test('a job waiting on its pull request is not an outcome yet: no landing, no drop, and the claim stays open', (t) => {
  const { dir, dbPath, db } = sandboxDb(t);
  const id = heldJob(db, dir);
  const season = seasonOf(dir, dbPath);
  assert.deepEqual(playsOf(season, id).map((o) => o.kind), ['took']);
  const row = memberRow(season, 'fleet-codex');
  assert.deepEqual([row.took, row.landed, row.dropped, row.sent_back, row.abandoned, row.finished], [1, 0, 0, 0, 0, 0]);
});

test('when a person lands the pull request later, the builder is credited as landed by you', (t) => {
  const { dir, dbPath, db } = sandboxDb(t);
  const byMerge = heldJob(db, dir, { title: 'landed by a merge proof' });
  const byAccept = heldJob(db, dir, { title: 'landed by an accept' });
  const stillWaiting = heldJob(db, dir, { title: 'still waiting' });

  // A different actor records the merge: the same command the brief names.
  const landing = tasks.readyTask(db, {
    id: byMerge,
    actor: 'claude',
    proof: 'Merged the pull request by hand after reading it.',
    merge: { merge_commit: COMMIT, number: '77', url: PR_URL, merged_at: '2026-10-31T02:10:45Z' },
  });
  assert.equal(landing.ready, true);
  // Or a person accepts the job in Review.
  assert.equal(tasks.doneTask(db, { id: byAccept, status: 'done', actor: 'keshav', allowReview: true, action: 'accepted' }).updated, true);

  const season = seasonOf(dir, dbPath);
  for (const id of [byMerge, byAccept]) {
    const plays = playsOf(season, id);
    assert.deepEqual(plays.map((o) => o.kind), ['took', 'landed']);
    const landed = plays.find((o) => o.kind === 'landed');
    assert.equal(landed.member, 'fleet-codex', 'the credit goes to the original claimant');
    assert.equal(landed.landed_by, 'you');
  }
  assert.deepEqual(playsOf(season, stillWaiting).map((o) => o.kind), ['took']);
  assert.equal(season.outcomes.some((o) => o.member === 'claude' || o.member === 'keshav'), false, 'the person who landed it takes no credit');
  const row = memberRow(season, 'fleet-codex');
  assert.deepEqual([row.took, row.landed, row.dropped, row.finished], [3, 2, 0, 2]);
});

test('the claim sweep never expires a job waiting in Review, however old', (t) => {
  const { dir, db } = sandboxDb(t);
  const held = heldJob(db, dir);
  // A control the sweep is allowed to take: still claimed, lease long gone.
  const stranded = tasks.addTask(db, { title: 'stranded worker', workspaceRoot: dir }).id;
  assert.equal(tasks.claimTask(db, { id: stranded, claimedBy: 'fleet-codex', leaseMinutes: 60, leasePid: 999999 }).claimed, true);

  const later = Date.now() + 365 * DAY;
  const byLease = tasks.expireLeases(db, { now: later, isAlive: () => false, dryRun: true });
  assert.deepEqual(byLease.map((x) => x.id), [stranded]);
  const byAge = tasks.expireLeases(db, { now: later, staleDays: 1, claimer: 'fleet-codex', dryRun: true, isAlive: () => false });
  assert.deepEqual(byAge.map((x) => x.id), [stranded]);

  const swept = tasks.expireLeases(db, { now: later, staleDays: 1, isAlive: () => false });
  assert.deepEqual(swept.map((x) => x.id), [stranded]);
  assert.equal(tasks.getTask(db, stranded).status, 'open');
  const row = tasks.getTask(db, held);
  assert.equal(row.status, 'review');
  assert.equal(row.claimed_by, 'fleet-codex');
  assert.equal(db.prepare("SELECT count(*) AS n FROM task_events WHERE task_id = ? AND event_type = 'claim_expired'").get(held).n, 0);
});

test('the row keeps the open pull request until a merge is recorded; a later review pass leaves it alone', (t) => {
  const { dir, db } = sandboxDb(t);
  const id = heldJob(db, dir);
  const open = { state: 'open', number: 77, url: PR_URL };
  assert.deepEqual(tasks.getTask(db, id).metadata.pull_request, open);

  // An independent review names no pull request; the one on file stays open.
  assert.equal(tasks.readyTask(db, { id, actor: 'claude', proof: 'Read the diff and reran the check; both are fine.' }).ready, true);
  assert.deepEqual(tasks.getTask(db, id).metadata.pull_request, open);

  // Only a recorded merge changes it.
  const merge = { merge_commit: COMMIT, number: '77', url: PR_URL, merged_at: '2026-10-31T02:10:45Z' };
  assert.equal(tasks.readyTask(db, { id, actor: 'claude', proof: 'Merged the pull request by hand after reading it.', merge }).ready, true);
  assert.deepEqual(tasks.getTask(db, id).metadata.pull_request, { state: 'merged', merge_commit: COMMIT, number: 77, url: PR_URL, merged_at: '2026-10-31T02:10:45Z' });

  // A job that never had a pull request carries no such field.
  const plain = tasks.addTask(db, { title: 'plain job', workspaceRoot: dir }).id;
  tasks.claimTask(db, { id: plain, claimedBy: 'fleet-codex' });
  tasks.readyTask(db, { id: plain, actor: 'fleet-codex', proof: 'ready' });
  assert.equal(tasks.getTask(db, plain).metadata.pull_request, undefined);
});

test('sending a held job back to open drops the pull request on its row, so the next attempt starts clean', (t) => {
  const { dir, db } = sandboxDb(t);
  const id = heldJob(db, dir);
  assert.deepEqual(tasks.getTask(db, id).metadata.pull_request, { state: 'open', number: 77, url: PR_URL });
  const reopened = tasks.reopenTask(db, { id, actor: 'keshav', reason: 'the pull request was closed unmerged', fromReview: true });
  assert.equal(reopened.reopened, true, JSON.stringify(reopened));
  const row = tasks.getTask(db, id);
  assert.equal(row.status, 'open');
  assert.equal(row.metadata.pull_request, undefined, 'a stale open pull request would keep auto-accept away from the next attempt');
});

// ---------------------------------------------------------------------------
// The real command line: what the flight sends is accepted as it is written.

function cliWorkspace(t) {
  // The CLI records the real path of its folder, which is not the /var alias macOS gives mkdtemp.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'held-cli-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'atris'));
  const dbPath = path.join(dir, 'tasks.db');
  const run = (args) => {
    const result = spawnSync(process.execPath, [CLI, ...args], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 30000,
      env: { ...scrubAgentEnv(), ATRIS_TASKS_DB: dbPath, ATRIS_SKIP_UPDATE_CHECK: '1', NODE_NO_WARNINGS: '1' },
    });
    assert.equal(result.status, 0, `${args.join(' ').slice(0, 120)}: ${result.stderr || result.stdout}`);
    return result;
  };
  return { dir, dbPath, run };
}

test('the real task ready takes the flight\'s held proof as written, parks the job in Review, and the sweep leaves it alone', async (t) => {
  // Capture exactly what the flight sends for a held job.
  const plane = planeFor(FEEDBACK_TASK);
  await flyWith(t, plane);
  const sent = callsTo(plane, 'task', 'ready')[0];
  assert.ok(sent, 'the flight sent task ready');

  const { dir, dbPath, run } = cliWorkspace(t);
  const create = (title) => JSON.parse(run(['task', 'new', title, '--tag', 'feedback', '--json']).stdout).task.display_id;
  const held = create('Fix the form so people stop retyping');
  const stranded = create('A worker that walked off');
  run(['task', 'claim', held, '--as', 'fleet-codex']);
  run(['task', 'claim', stranded, '--as', 'fleet-codex']);

  run(['task', 'ready', held, ...sent.slice(3)]);

  const shown = JSON.parse(run(['task', 'show', held, '--json']).stdout);
  assert.equal(shown.status, 'review');
  assert.equal(shown.claimed_by, 'fleet-codex');

  let id;
  const reader = new DatabaseSync(dbPath, { readOnly: true });
  try {
    id = reader.prepare('SELECT id FROM tasks WHERE title = ?').get('Fix the form so people stop retyping').id;
    const payload = JSON.parse(reader.prepare("SELECT payload FROM task_events WHERE task_id = ? AND event_type = 'proof_ready'").get(id).payload);
    assert.deepEqual(payload.pull_request, { state: 'open', number: 77, url: PR_URL });
    assert.equal(payload.landing.merge_commit, undefined);
    assert.equal(payload.self_landed, undefined);
  } finally {
    reader.close();
  }

  // Nothing about the wait reads as a landing or a drop on the rating.
  assert.deepEqual(playsOf(seasonOf(dir, dbPath), id).map((o) => o.kind), ['took']);

  // The real sweep takes the stranded claim and leaves the waiting job.
  const swept = JSON.parse(run(['task', 'sweep', '--stale-days', '0', '--json']).stdout);
  assert.deepEqual(swept.tasks.map((x) => x.title), ['A worker that walked off']);
  assert.equal(JSON.parse(run(['task', 'show', held, '--json']).stdout).status, 'review');
  assert.equal(JSON.parse(run(['task', 'show', stranded, '--json']).stdout).status, 'open');
});

// ---------------------------------------------------------------------------
// Auto-approval. `atris task auto-accept-certified --all --include-protected`
// lands every review that has an independent look and a passing check. A held
// job has both, and its pull request is still open: it must not be completed,
// and so must not count as landed on the rating.

test('auto-approval with --all --include-protected leaves a job whose pull request is still open in Review, and the rating sees no landing', async (t) => {
  const plane = planeFor(FEEDBACK_TASK);
  await flyWith(t, plane);
  const sent = callsTo(plane, 'task', 'ready')[0];
  assert.ok(sent, 'the flight sent task ready');

  const { dir, dbPath, run } = cliWorkspace(t);
  fs.writeFileSync(path.join(dir, 'app.js'), 'module.exports = 1;\n');
  const id = JSON.parse(run(['task', 'new', 'Fix the feedback form so people stop retyping', '--tag', 'feedback', '--verify', 'node --check app.js', '--json']).stdout).task.display_id;
  run(['task', 'claim', id, '--as', 'fleet-codex']);
  // The builder's handoff, exactly as the flight writes it...
  run(['task', 'ready', id, ...sent.slice(3)]);
  // ...then a second reader, who names no pull request.
  run(['task', 'ready', id,
    '--proof', 'Independent review of the diff. Reran the check: node --check app.js exited 0. Verify output: # tests 3 # pass 3 # fail 0. Receipt saved at atris/runs/review.json.',
    '--result', 'Operators can trust the form fix because a second reader confirmed the change.',
    '--as', 'claude']);
  const statusOf = () => JSON.parse(run(['task', 'show', id, '--json']).stdout).status;
  assert.equal(statusOf(), 'review');

  const sweep = (...extra) => JSON.parse(run(['task', 'auto-accept-certified', '--all', '--include-protected', '--json', ...extra]).stdout);
  const preview = sweep('--dry-run');
  assert.equal(preview.would_accept, 0, JSON.stringify(preview.results));
  assert.equal(preview.results.length, 1);
  assert.equal(preview.results[0].eligible, false);
  assert.equal(preview.results[0].reason, 'pull_request_open');
  assert.deepEqual(preview.results[0].pull_request, { state: 'open', number: 77, url: PR_URL });

  const live = sweep('--as', 'keshav', '--confirm-human-accept');
  assert.equal(live.accepted, 0, JSON.stringify(live.results));
  assert.equal(live.results[0].action, 'skipped');
  assert.equal(live.results[0].reason, 'pull_request_open');
  assert.equal(statusOf(), 'review', 'the job is still waiting for a person');
  assert.deepEqual(playsOf(seasonOf(dir, dbPath), JSON.parse(run(['task', 'show', id, '--json']).stdout).id).map((o) => o.kind), ['took']);

  // The gate is for the machine. A person's own accept is untouched, which is
  // the next step the refusal names.
  run(['task', 'accept', id, '--as', 'keshav', '--json']);
  assert.equal(statusOf(), 'done');
});

// ---------------------------------------------------------------------------
// The engine's run history. It counts landed runs and a landed run renews the
// worker's verified date, so a held build, which only waits for a person, must
// not be written down as landed.

const heldRuns = (root) => readRosterRuns(root).filter((run) => run.task === 'BCK-1934');
const PIN_VERIFIED = '2000-01-01';
const pinReport = () => ({
  jobs: [{
    job: 'build',
    from: 'all projects',
    file: '~/.atris/ROSTER.md',
    workers: [{
      engine: 'codex', model: 'gpt-6.1-sol', status: 'leads', why: '', line: 7, verified: PIN_VERIFIED,
      runs: { engine: 'codex', model: 'gpt-6.1-sol', model_source: 'roster', text: 'codex (gpt-6.1-sol)' },
    }],
  }],
  team: [],
});
// The pin's verified date after these runs, for a worker that runs the pinned model.
const verifiedAfter = (runs, now) => attachStaleModels(pinReport(), {
  catalog: { codex: ['gpt-6.1-sol'] },
  runs: runs.map((run) => ({ ...run, model: 'gpt-6.1-sol' })),
  now,
}).jobs[0].workers[0].pin_verified_at;

test('a held attempt is written to the run history as held, not landed, and verifies nothing until a person lands it', async (t) => {
  const { flight, root } = await flyWith(t, planeFor(FEEDBACK_TASK));
  assert.equal(flight.held_for_review.length, 1);

  const runs = heldRuns(root);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].outcome, 'held');
  assert.equal(runs[0].engine, 'codex');
  assert.equal(runs[0].detail, `waiting for a person to land ${PR_URL}`);
  assert.ok(OUTCOMES.includes('held'), 'held is a recorded outcome, not coerced into a failure');

  const summary = summarizeRuns(runs);
  assert.equal(summary.landed, 0);
  assert.equal(summary.held, 1);

  // The verified date of a pinned worker moves only on a landed run.
  const now = new Date(Date.parse(runs[0].at) + 3600000);
  assert.equal(verifiedAfter(runs, now), PIN_VERIFIED);
  assert.notEqual(verifiedAfter([{ ...runs[0], outcome: 'landed' }], now), PIN_VERIFIED, 'a landed run would have renewed it');
});

test('saving the proof failing does not turn a held attempt into a landing or a failure in the run history', async (t) => {
  const { root } = await flyWith(t, planeFor(FEEDBACK_TASK, { readyStatus: 1 }));
  const runs = heldRuns(root);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].outcome, 'held');
  assert.equal(runs[0].detail, `pull request ${PR_URL} is open but its proof could not be saved`);
});

test('a fix that really landed is still written down as landed, and a paused one as failed', async (t) => {
  const record = JSON.stringify({ merge_commit: COMMIT, number: 4676, url: 'https://github.example/repo/pull/4676', merged_at: '2026-10-31T02:10:45Z' });
  const landed = await flyWith(t, planeFor({ ...FEEDBACK_TASK, tag: 'code' }, { shipOutput: `merge: merged\nmerge: record ${record}\ndone: worktree shipped\n` }));
  assert.deepEqual(heldRuns(landed.root).map((run) => run.outcome), ['landed']);

  const paused = await flyWith(t, planeFor(FEEDBACK_TASK, { shipOutput: 'push: origin codex/dispatch\ndone: worktree shipped\n' }));
  assert.deepEqual(heldRuns(paused.root).map((run) => run.outcome), ['failed']);
});
