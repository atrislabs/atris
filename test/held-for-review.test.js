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
const { ratingCommand } = require('../commands/rating');
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
  // `gh` answers the way the real one does. A test gives the branch its pull
  // requests, makes gh fail, or makes it print something that is not JSON.
  // `pr view` shows ONE pull request for the branch (an open one first), as the
  // real one does even when several are open; `pr list` shows every one that
  // matches --head and --state. With no pull request, view exits 1 and says so
  // on stderr, and list prints an empty list. Creating a pull request prints
  // its link. Every call is written down so a test can say what was never asked
  // for.
  const prsSetup = path.join(root, 'prs.json');
  fs.writeFileSync(path.join(bin, 'gh'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(ghLog)}, args.join(' ') + '\\n');
const setup = fs.existsSync(${JSON.stringify(prsSetup)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(prsSetup)}, 'utf8')) : {};
const prs = setup.prs || [];
const isOpen = (pr) => String(pr.state || 'OPEN').toUpperCase() === 'OPEN';
const after = (flag) => args[args.indexOf(flag) + 1];
if (args[0] === 'pr' && (args[1] === 'view' || args[1] === 'list')) {
  if (setup.fail) { console.error(setup.fail); process.exit(1); }
  if (setup.raw !== undefined) { process.stdout.write(setup.raw); process.exit(0); }
}
if (args[0] === 'pr' && args[1] === 'view') {
  const shown = prs.find(isOpen) || prs[0];
  if (!shown) { console.error('no pull requests found for branch "bck-1934-fix"'); process.exit(1); }
  if (args.includes('--jq')) console.log(shown.number + ' ' + shown.url + ' ' + shown.state);
  else console.log(JSON.stringify(shown));
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'list') {
  const listed = prs.filter((pr) => (pr.headRefName || 'bck-1934-fix') === after('--head') && (after('--state') !== 'open' || isOpen(pr)));
  console.log(JSON.stringify(listed.map(({ headRefName, state, ...shown }) => shown)));
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'create') { console.log(${JSON.stringify(PR_URL)}); process.exit(0); }
process.exit(1);
`, { mode: 0o755 });
  const setPrs = (setup) => fs.writeFileSync(prsSetup, JSON.stringify(setup));
  const ship = (...extra) => spawnSync(process.execPath, [CLI, 'worktree', 'ship', '--message', 'Fix the form (BCK-1934, built by codex)', '--no-map-refresh', ...extra], {
    cwd: work,
    encoding: 'utf8',
    timeout: 30000,
    env: { ...scrubAgentEnv(), PATH: `${bin}${path.delimiter}${process.env.PATH}`, ATRIS_SKIP_UPDATE_CHECK: '1' },
  });
  const onRemote = () => git(['--git-dir', remote, 'show-ref', '--verify', '--quiet', 'refs/heads/bck-1934-fix'], root).status === 0;
  const ghCalls = () => (fs.existsSync(ghLog) ? fs.readFileSync(ghLog, 'utf8').split('\n').filter(Boolean) : []);
  return { ship, onRemote, ghCalls, setPrs, work };
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
// One branch can have several open pull requests (one per base), and a single
// push feeds every one of them, so every one is asked about. `gh pr view` shows
// only one of them.

const AUTO_MERGE_ON = { enabledAt: '2026-10-30T10:00:00Z', mergeMethod: 'MERGE' };
const pullRequestAt = (number) => `https://github.example/repo/pull/${number}`;
const pullRequest = (number, baseRefName, autoMergeRequest = null, state = 'OPEN') => ({ number, url: pullRequestAt(number), baseRefName, state, autoMergeRequest });
const openPullRequest = (autoMergeRequest) => ({ prs: [pullRequest(77, 'master', autoMergeRequest)] });
const LIST_CALL = 'pr list --head bck-1934-fix --state open --json number,url,baseRefName,autoMergeRequest';
const noHarm = (run, { onRemote, ghCalls }, label = '') => {
  assert.doesNotMatch(run.stdout, /push:|pr:|done: worktree shipped/, label);
  assert.equal(onRemote(), false, `${label}: the branch never reached the remote`);
  assert.equal(ghCalls().some((call) => call.startsWith('pr create ') || call.startsWith('pr merge')), false, label);
};

test('a protected-lane push is refused when the branch already has an open pull request with auto-merge on, and nothing is pushed', (t) => {
  const setup = shipSetup(t);
  setup.setPrs(openPullRequest(AUTO_MERGE_ON));
  const run = setup.ship();
  assert.equal(run.status, 2, `${run.stdout}${run.stderr}`);
  assert.equal(run.stderr.trim(), `blocked: pull request ${pullRequestAt(77)} (into master) has auto-merge on, so pushing bck-1934-fix would land it with no person; turn auto-merge off first (gh pr merge 77 --disable-auto), then ship again`);
  noHarm(run, setup);
});

test('every open pull request for the branch is checked, so one with auto-merge on is found even when gh pr view would show another', (t) => {
  // Two open pull requests from the same branch, to different bases. `gh pr view`
  // shows the first (auto-merge off) and the push was allowed; the second would
  // have merged itself the moment the push landed.
  const setup = shipSetup(t);
  setup.setPrs({ prs: [pullRequest(78, 'release', null), pullRequest(77, 'master', AUTO_MERGE_ON)] });
  const run = setup.ship();
  assert.equal(run.status, 2, `${run.stdout}${run.stderr}`);
  assert.equal(run.stderr.trim(), `blocked: pull request ${pullRequestAt(77)} (into master) has auto-merge on, so pushing bck-1934-fix would land it with no person; turn auto-merge off first (gh pr merge 77 --disable-auto), then ship again`);
  assert.doesNotMatch(run.stderr, /pull\/78/, 'only the one that would land is named');
  noHarm(run, setup);
  const asked = setup.ghCalls().filter((call) => call.startsWith(LIST_CALL));
  assert.equal(asked.length, 1, `the list was asked for once:\n${setup.ghCalls().join('\n')}`);

  // The one that has auto-merge on may come first too, and may be the only one.
  const first = shipSetup(t);
  first.setPrs({ prs: [pullRequest(77, 'master', AUTO_MERGE_ON), pullRequest(78, 'release', null)] });
  assert.equal(first.ship().status, 2);
  assert.equal(first.onRemote(), false);
});

test('when several open pull requests have auto-merge on, all of them are named', (t) => {
  const setup = shipSetup(t);
  setup.setPrs({ prs: [pullRequest(78, 'release', AUTO_MERGE_ON), pullRequest(79, 'staging', null), pullRequest(77, 'master', AUTO_MERGE_ON)] });
  const run = setup.ship();
  assert.equal(run.status, 2, `${run.stdout}${run.stderr}`);
  assert.equal(run.stderr.trim(), `blocked: pull requests ${pullRequestAt(78)} (into release) and ${pullRequestAt(77)} (into master) have auto-merge on, so pushing bck-1934-fix would land them with no person; turn auto-merge off on each first (gh pr merge 78 --disable-auto, gh pr merge 77 --disable-auto), then ship again`);
  noHarm(run, setup);
});

test('a protected-lane push that cannot be checked is refused too: gh fails, or answers with something that is not a list of pull requests', (t) => {
  for (const [label, setup, said] of [
    ['gh is not signed in', { fail: 'HTTP 401: Bad credentials (https://api.github.com/graphql)' }, /Bad credentials/],
    ['gh prints nonsense', { raw: 'this is not json' }, /gh's answer could not be read/],
    ['gh answers with nothing', { raw: '' }, /gh's answer could not be read/],
    ['gh answers with one pull request, not a list', { raw: JSON.stringify(pullRequest(77, 'master', null)) }, /gh's answer could not be read/],
    ['gh lists something that is not a pull request', { raw: '[null]' }, /gh's answer could not be read/],
    ['gh leaves out whether auto-merge is on', { raw: JSON.stringify([{ number: 77, url: pullRequestAt(77), baseRefName: 'master' }]) }, /gh's answer could not be read/],
  ]) {
    const harness = shipSetup(t);
    harness.setPrs(setup);
    const run = harness.ship();
    assert.equal(run.status, 2, `${label}: ${run.stdout}${run.stderr}`);
    assert.match(run.stderr, /^blocked: cannot tell whether bck-1934-fix has a pull request with auto-merge on/, label);
    assert.match(run.stderr, said, label);
    assert.match(run.stderr, /nothing was pushed/, label);
    noHarm(run, harness, label);
  }
});

test('the auto-merge check only guards protected-lane pushes, and only when auto-merge is really on', (t) => {
  // No pull request yet, which is what an empty list says on a first push: ship goes on.
  const first = shipSetup(t);
  assert.equal(first.ship().status, 0);
  assert.equal(first.onRemote(), true);
  assert.ok(first.ghCalls().some((call) => call.startsWith(LIST_CALL)), 'a protected-lane push asks for the list');

  // An open pull request with auto-merge off is the ordinary re-push, and so are
  // two of them, one to each base.
  const off = shipSetup(t);
  off.setPrs(openPullRequest(null));
  const repush = off.ship();
  assert.equal(repush.status, 0, repush.stderr || repush.stdout);
  assert.match(repush.stdout, /^push: origin bck-1934-fix$/m);
  assert.equal(off.onRemote(), true);
  const two = shipSetup(t);
  two.setPrs({ prs: [pullRequest(78, 'release', null), pullRequest(77, 'master', null)] });
  assert.equal(two.ship().status, 0);
  assert.equal(two.onRemote(), true);

  // A pull request that already merged does not stop a new one, and neither does
  // a closed one that still reports an old auto-merge request: gh lists open ones only.
  const merged = shipSetup(t);
  merged.setPrs({ prs: [pullRequest(70, 'master', null, 'MERGED')] });
  assert.equal(merged.ship().status, 0);
  const closed = shipSetup(t);
  closed.setPrs({ prs: [pullRequest(71, 'master', AUTO_MERGE_ON, 'CLOSED')] });
  assert.equal(closed.ship().status, 0);

  // A pull request from some other branch is not this branch's business.
  const other = shipSetup(t);
  other.setPrs({ prs: [{ ...pullRequest(72, 'master', AUTO_MERGE_ON), headRefName: 'some-other-branch' }] });
  assert.equal(other.ship().status, 0);

  // A safe-lane branch is never held up by it, whatever gh says.
  const safe = shipSetup(t, { tag: 'code' });
  safe.setPrs(openPullRequest(AUTO_MERGE_ON));
  assert.equal(safe.ship().status, 0);
  assert.equal(safe.onRemote(), true);
  assert.equal(safe.ghCalls().some((call) => call.startsWith('pr list')), false, 'a safe lane is not even asked about');

  // A person who lands it on written order is not asked either.
  const ordered = shipSetup(t);
  ordered.setPrs(openPullRequest(AUTO_MERGE_ON));
  const allowed = ordered.ship('--allow-denied-lane');
  assert.equal(allowed.status, 0, allowed.stderr || allowed.stdout);
  assert.equal(ordered.onRemote(), true);
});

test('without gh, with a gh that hangs, or with a list that may have been cut short, the auto-merge check refuses instead of guessing', () => {
  const { protectedPushRefusal } = require('../commands/worktree');
  const gone = () => ({ error: Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }), status: null, stdout: '', stderr: '' });
  const refusal = protectedPushRefusal(os.tmpdir(), 'bck-1934-fix', gone);
  assert.match(refusal, /^blocked: cannot tell whether bck-1934-fix has a pull request with auto-merge on \(gh did not run: spawn gh ENOENT\); nothing was pushed$/);
  // A gh that hangs is cut off after a minute and refused in plain words.
  const slow = () => ({ error: Object.assign(new Error('spawnSync gh ETIMEDOUT'), { code: 'ETIMEDOUT' }), status: null, stdout: '', stderr: '' });
  assert.match(protectedPushRefusal(os.tmpdir(), 'bck-1934-fix', slow), /^blocked: cannot tell whether bck-1934-fix has a pull request with auto-merge on \(gh took longer than a minute to answer\); nothing was pushed$/);
  let asked = null;
  assert.equal(protectedPushRefusal(os.tmpdir(), 'x', (command, args, options) => { asked = { command, args, options }; return { status: 0, stdout: '[]', stderr: '' }; }), '');
  assert.equal(asked.command, 'gh');
  assert.deepEqual(asked.args.slice(0, 6), ['pr', 'list', '--head', 'x', '--state', 'open']);
  assert.equal(asked.args[asked.args.indexOf('--json') + 1], 'number,url,baseRefName,autoMergeRequest');
  assert.ok(asked.options.timeout > 0 && asked.options.timeout <= 120000, 'the lookup has a time limit');
  // A failed lookup is never a clear, whatever it says, so no wording of "none found" can let a push through.
  for (const stderr of ['no pull requests found for branch "x"', 'no open pull requests in atrislabs/atris', '']) {
    assert.match(protectedPushRefusal(os.tmpdir(), 'x', () => ({ status: 1, stdout: '', stderr })), /^blocked: cannot tell whether x has a pull request with auto-merge on/, stderr);
  }
  // gh stops at its limit: a full page may be only part of the list, so it is not a clear.
  const limit = Number(asked.args[asked.args.indexOf('--limit') + 1]);
  assert.ok(limit >= 30, `the limit is ${limit}`);
  const page = (n) => JSON.stringify(Array.from({ length: n }, (_, i) => ({ number: i + 1, url: `https://github.example/repo/pull/${i + 1}`, baseRefName: 'master', autoMergeRequest: null })));
  assert.equal(protectedPushRefusal(os.tmpdir(), 'x', () => ({ status: 0, stdout: page(limit - 1), stderr: '' })), '');
  assert.match(protectedPushRefusal(os.tmpdir(), 'x', () => ({ status: 0, stdout: page(limit), stderr: '' })), /may have been cut short/);
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

async function flyWith(t, plane, { root = tempRoot(t) } = {}) {
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

// The flight lets an unsaved held proof go itself, in its own process, through the
// task store it already holds its claim leases in. So the store needs the claim the
// flight would hold: a real job, claimed by the builder, with the same name and
// lease the command line would have given it. The task the fake plane shows carries
// that job's real id, and its display id is the one a person would read.
function claimedForFlight(t, { builder = 'fleet-codex' } = {}) {
  const root = tempRoot(t);
  const workspace = tasks.workspaceRoot(root);
  const db = tasks.open();
  const { id } = tasks.addTask(db, { title: FEEDBACK_TASK.title, tag: 'feedback', workspaceRoot: workspace });
  assert.equal(tasks.claimTask(db, { id, claimedBy: builder, leaseMinutes: 60, leasePid: process.pid }).claimed, true);
  const [shown] = tasks.withTaskDisplayRefs(tasks.listTasks(db, { workspaceRoot: workspace }));
  assert.notEqual(shown.display_id, id, 'a person reads the display id, which is not the row id');
  return { root, workspace, db, id, dbPath: process.env.ATRIS_TASKS_DB, task: { ...FEEDBACK_TASK, id, display_id: shown.display_id } };
}

// The shell a flight can inherit: an agent tool's marker, a mission driver's, a codex sandbox's.
const AGENT_SESSION = { CLAUDECODE: '1', CODEX_SANDBOX: 'seatbelt', ATRIS_MISSION_DRIVER_DETACHED: '1' };
async function withEnv(vars, run) {
  const saved = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  Object.assign(process.env, vars);
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

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

// Saving the proof of a held job failed. The pull request is open for a person, so the
// claim must not sit on its lease and then expire as a plain drop. The flight lets it
// go itself, in its own process, through the task store it already holds its leases
// in, and the event carries the kind and the pull request as fields. That is the only
// way to record it: `atris task release` takes no such flags, because any worker could
// pass them to excuse its own miss.

const heldRelease = () => ({
  released_by: 'fleet-codex',
  previous_claimed_by: 'fleet-codex',
  reason: `PR ${PR_URL} is open but its proof could not be saved: ready failed: nope`,
  kind: 'proof_not_saved',
  pull_request: { state: 'open', number: 77, url: PR_URL },
});

test('if saving the proof fails, the flight lets the claim go itself with the pull request link as the reason, and the event carries the kind and the pull request', async (t) => {
  const seeded = claimedForFlight(t);
  const plane = planeFor(seeded.task, { readyStatus: 1 });
  const { flight, logs, receipt } = await flyWith(t, plane, { root: seeded.root });

  // Not through the command line, where a flag is all it would take to say it.
  assert.deepEqual(callsTo(plane, 'task', 'release'), [], 'the flight records this release in its own process');
  assert.equal(plane.calls.some((args) => args.includes('--kind')), false);

  assert.equal(flight.status, 'failed');
  assert.equal(flight.paused.length, 1);
  const [paused] = flight.paused;
  assert.equal(paused.task, seeded.task.display_id);
  assert.equal(paused.stage, 'task_ready');
  assert.equal(paused.held_for_review, true);
  assert.equal(paused.landed, undefined);
  assert.match(paused.next_action, /leave the pull request open/);
  assert.deepEqual(paused.pull_request, { url: PR_URL, number: 77 });
  assert.equal(flight.held_for_review[0].review_recorded, false);

  // The claim opens again under the builder's own name, and the reason is where anyone finds the pull request.
  const row = tasks.getTask(seeded.db, seeded.id);
  assert.equal(row.status, 'open');
  assert.equal(row.claimed_by, null);
  assert.deepEqual(releaseEvents(seeded.db, seeded.id), [heldRelease()]);
  assert.equal(paused.claim_released, true);

  assert.ok(logs.some((line) => /the pull request is open, but saving its proof failed/.test(line)), logs.join('\n'));
  assert.ok(logs.includes(`    released the claim on ${seeded.task.display_id} with the pull request link as the reason`), logs.join('\n'));
  assert.equal(receipt.result.passed, false);
  assert.equal(receipt.paused[0].claim_released, true);
  assert.deepEqual(receipt.paused[0].pull_request, { url: PR_URL, number: 77 });
});

test('the rating shows the flight\'s own unsaved-proof release as waiting on a person, not as a drop', async (t) => {
  const seeded = claimedForFlight(t);
  await flyWith(t, planeFor(seeded.task, { readyStatus: 1 }), { root: seeded.root });

  const season = seasonOf(seeded.workspace, seeded.dbPath);
  assert.deepEqual(playsOf(season, seeded.id).map((o) => o.kind), ['took', 'held']);
  const member = memberRow(season, 'fleet-codex');
  assert.deepEqual([member.held, member.dropped, member.finished], [1, 0, 0]);
});

test('the same release is recorded when the flight inherits an agent session, a codex sandbox, and a mission driver: nothing in its shell can stop it', async (t) => {
  const seeded = claimedForFlight(t);
  const plane = planeFor(seeded.task, { readyStatus: 1 });
  const { flight } = await withEnv(AGENT_SESSION, () => flyWith(t, plane, { root: seeded.root }));

  assert.equal(flight.paused[0].claim_released, true);
  assert.equal(tasks.getTask(seeded.db, seeded.id).status, 'open');
  assert.deepEqual(releaseEvents(seeded.db, seeded.id), [heldRelease()]);
  const season = seasonOf(seeded.workspace, seeded.dbPath);
  assert.deepEqual(playsOf(season, seeded.id).map((o) => o.kind), ['took', 'held']);
  assert.equal(memberRow(season, 'fleet-codex').held, 1);
});

test('the flight hands the release the display id a person reads, and the store finds the job', async (t) => {
  // No row id in what the task command showed, so only the display id is left to go on.
  const seeded = claimedForFlight(t);
  const { id, ...withoutId } = seeded.task;
  assert.ok(id);
  const plane = planeFor(withoutId, { readyStatus: 1 });
  const { flight } = await flyWith(t, plane, { root: seeded.root });

  assert.equal(flight.paused[0].task, seeded.task.display_id);
  assert.equal(flight.paused[0].claim_released, true);
  assert.equal(tasks.getTask(seeded.db, seeded.id).status, 'open');
  assert.deepEqual(releaseEvents(seeded.db, seeded.id), [heldRelease()]);
});

test('after the flight lets the claim go, the task list file shows the job open again, as the release command leaves it', async (t) => {
  const seeded = claimedForFlight(t);
  const file = path.join(seeded.root, '.atris', 'state', 'tasks.projection.json');
  const shown = () => JSON.parse(fs.readFileSync(file, 'utf8')).tasks.find((task) => task.id === seeded.id);
  // The file as the claim left it.
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(tasks.taskProjection(seeded.db, { workspaceRoot: seeded.workspace, limit: 500 }), null, 2)}\n`);
  assert.equal(shown().status, 'claimed');
  assert.equal(shown().claimed_by, 'fleet-codex');

  await flyWith(t, planeFor(seeded.task, { readyStatus: 1 }), { root: seeded.root });

  assert.equal(shown().status, 'open', 'the list file shows the released job as open again');
  assert.equal(shown().claimed_by || null, null);

  // The flight writes it with the command's own writer, into its own folder.
  const written = fs.readFileSync(file, 'utf8');
  const { writeDefaultProjection } = require('../commands/task');
  writeDefaultProjection(tasks, seeded.db, { root: seeded.root });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).tasks, JSON.parse(written).tasks);
});

test('a task list file that cannot be written does not undo a release that is already saved', async (t) => {
  const seeded = claimedForFlight(t);
  // A folder where the list file goes: the write fails, after the release is saved.
  fs.mkdirSync(path.join(seeded.root, '.atris', 'state', 'tasks.projection.json'), { recursive: true });
  const { flight, logs, receipt } = await flyWith(t, planeFor(seeded.task, { readyStatus: 1 }), { root: seeded.root });

  assert.equal(tasks.getTask(seeded.db, seeded.id).status, 'open', 'the claim is let go');
  assert.deepEqual(releaseEvents(seeded.db, seeded.id), [heldRelease()]);
  assert.equal(flight.paused[0].claim_released, true, 'the row does not say the release failed when it was saved');
  assert.equal(receipt.paused[0].claim_released, true);
  assert.ok(logs.includes(`    released the claim on ${seeded.task.display_id} with the pull request link as the reason`), logs.join('\n'));
  assert.equal(logs.some((line) => /could not release/.test(line)), false, logs.join('\n'));
});

test('a release the store refuses or fails on is tried once and the row says so; a job the store does not know is said plainly', async (t) => {
  for (const [label, release, wanted] of [
    ['refuses', () => ({ released: false, reason: 'stale_task_state', claimed_by: 'fleet-codex' }), /could not release the claim on \S+: release failed: stale_task_state \(held by fleet-codex\)/],
    ['throws', () => { throw new Error('database is locked'); }, /could not release the claim on \S+: database is locked/],
    ['throws with nothing to say', () => { throw new Error(''); }, /could not release the claim on \S+: unknown/],
  ]) {
    const seeded = claimedForFlight(t);
    const plane = planeFor(seeded.task, { readyStatus: 1 });
    let attempts = 0;
    const real = tasks.releaseTask;
    tasks.releaseTask = (...args) => { attempts += 1; return release(...args); };
    let flown;
    try { flown = await flyWith(t, plane, { root: seeded.root }); } finally { tasks.releaseTask = real; }
    assert.equal(attempts, 1, `${label}: the end-of-flight pass does not retry it`);
    assert.deepEqual(callsTo(plane, 'task', 'release'), [], label);
    assert.equal(flown.flight.paused[0].claim_released, false, label);
    assert.equal(flown.receipt.paused[0].claim_released, false, label);
    assert.ok(flown.logs.some((line) => wanted.test(line)), `${label}: ${flown.logs.join('\n')}`);
    assert.equal(tasks.getTask(seeded.db, seeded.id).status, 'claimed', `${label}: it stays held until its lease runs out`);
  }

  const unknown = planeFor(FEEDBACK_TASK, { readyStatus: 1 });
  const { flight, logs } = await flyWith(t, unknown);
  assert.equal(flight.paused[0].claim_released, false);
  assert.ok(logs.some((line) => /could not release the claim on BCK-1934: task not found: BCK-1934/.test(line)), logs.join('\n'));
  assert.deepEqual(callsTo(unknown, 'task', 'release'), [], 'nothing is sent through the command line instead');
});

test('the release reason carries only the first line of the save error, with the link first, and never more than 300 characters', async (t) => {
  for (const [readyError, check] of [
    ['\n  database is locked\n    at saveProof (task-db.js:12:3)\n', (reason) => assert.equal(reason, `PR ${PR_URL} is open but its proof could not be saved: database is locked`)],
    [`x${'y'.repeat(500)}`, (reason) => {
      assert.ok(reason.length <= 300, `${reason.length} characters`);
      assert.ok(reason.startsWith(`PR ${PR_URL} is open but its proof could not be saved: x`), 'the link comes first, so a long error never cuts it');
    }],
  ]) {
    const seeded = claimedForFlight(t);
    await flyWith(t, planeFor(seeded.task, { readyStatus: 1, readyError }), { root: seeded.root });
    const events = releaseEvents(seeded.db, seeded.id);
    assert.equal(events.length, 1, 'the flight recorded one release');
    const [payload] = events;
    check(payload.reason);
    assert.equal(payload.kind, 'proof_not_saved');
  }
});

test('every other release a flight makes goes through the command line as a plain release: no kind, no pull request', async (t) => {
  const noLink = planeFor(FEEDBACK_TASK, { shipOutput: 'push: origin codex/dispatch\ndone: worktree shipped\n' });
  await flyWith(t, noLink);
  const [plain] = callsTo(noLink, 'task', 'release');
  assert.ok(plain, 'that flight let its claim go');
  for (const flag of ['--kind', '--pr-url', '--pr-number']) assert.equal(plain.includes(flag), false, flag);
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
// A claim let go because saving the proof failed. The builder did the work and a
// pull request is open for a person; only the record failed. That is neither a
// landing nor a miss, and the rating has to know it from a field, not from the words.

const landedJob = (db, dir, n, builder = 'fleet-codex') => {
  const { id } = tasks.addTask(db, { title: `Landed job ${n}`, workspaceRoot: dir });
  assert.equal(tasks.claimTask(db, { id, claimedBy: builder }).claimed, true);
  assert.equal(tasks.readyTask(db, { id, actor: builder, proof: 'Merged.', merge: { merge_commit: `${n}`.repeat(40).slice(0, 40), number: String(100 + n), url: `https://github.example/repo/pull/${100 + n}`, merged_at: '2026-10-31T02:10:45Z' } }).ready, true);
  return id;
};
const unsavedJob = (db, dir, { title = 'Fix the feedback form', builder = 'fleet-codex', release = {} } = {}) => {
  const { id } = tasks.addTask(db, { title, tag: 'feedback', workspaceRoot: dir });
  assert.equal(tasks.claimTask(db, { id, claimedBy: builder }).claimed, true);
  const released = tasks.releaseTask(db, {
    id,
    actor: builder,
    reason: `PR ${PR_URL} is open but its proof could not be saved: database is locked`,
    kind: 'proof_not_saved',
    pullRequest: { number: 77, url: PR_URL },
    ...release,
  });
  assert.equal(released.released, true, JSON.stringify(released));
  return id;
};
const releaseEvents = (db, id) => db.prepare("SELECT payload FROM task_events WHERE task_id = ? AND event_type = 'claim_released' ORDER BY version").all(id).map((row) => JSON.parse(row.payload));

test('a release can say its proof was not saved, with the pull request, as fields on the event; a plain release says nothing of the kind', (t) => {
  const { dir, db } = sandboxDb(t);
  const id = unsavedJob(db, dir);
  assert.deepEqual(releaseEvents(db, id), [{
    released_by: 'fleet-codex',
    previous_claimed_by: 'fleet-codex',
    reason: `PR ${PR_URL} is open but its proof could not be saved: database is locked`,
    kind: 'proof_not_saved',
    pull_request: { state: 'open', number: 77, url: PR_URL },
  }]);
  assert.equal(tasks.getTask(db, id).status, 'open', 'the claim is let go all the same');

  const plain = tasks.addTask(db, { title: 'plain', workspaceRoot: dir }).id;
  tasks.claimTask(db, { id: plain, claimedBy: 'fleet-codex' });
  tasks.releaseTask(db, { id: plain, actor: 'fleet-codex', reason: 'paused at ship: blocked' });
  assert.deepEqual(releaseEvents(db, plain), [{ released_by: 'fleet-codex', previous_claimed_by: 'fleet-codex', reason: 'paused at ship: blocked' }]);

  // Only one kind exists, and it needs a real link: anything else leaves the claim held.
  for (const [label, extra] of [
    ['an unknown kind', { kind: 'looks_fine' }],
    ['no pull request', { pullRequest: undefined }],
    ['a link that is not a link', { pullRequest: { url: 'javascript:alert(1)' } }],
    ['a pull request with no kind', { kind: undefined }],
  ]) {
    const odd = tasks.addTask(db, { title: label, workspaceRoot: dir }).id;
    tasks.claimTask(db, { id: odd, claimedBy: 'fleet-codex' });
    const refused = tasks.releaseTask(db, { id: odd, actor: 'fleet-codex', kind: 'proof_not_saved', pullRequest: { url: PR_URL }, ...extra });
    assert.equal(refused.released, false, label);
    assert.equal(refused.reason, 'invalid_release_marker', label);
    assert.equal(tasks.getTask(db, odd).status, 'claimed', label);
    assert.deepEqual(releaseEvents(db, odd), [], label);
  }
});

test('the rating reads a release as waiting on a person only from the fields, and only when they are whole', () => {
  const { isProofNotSaved } = require('../lib/release-kind');
  const open = { state: 'open', number: 77, url: PR_URL };
  const whole = { released_by: 'fleet-codex', reason: 'anything at all', kind: 'proof_not_saved', pull_request: open };
  assert.equal(isProofNotSaved(whole), true);
  assert.equal(isProofNotSaved({ ...whole, pull_request: { state: 'open', number: 77 } }), true, 'a number is enough');
  assert.equal(isProofNotSaved({ ...whole, pull_request: { state: 'OPEN', url: PR_URL } }), true, 'a link is enough, in any case');
  for (const [label, payload] of [
    ['nothing', null],
    ['a list', [whole]],
    ['the same words and no fields', { released_by: 'fleet-codex', reason: `PR ${PR_URL} is open but its proof could not be saved: nope` }],
    ['another kind', { ...whole, kind: 'looks_fine' }],
    ['no kind', { reason: 'x', pull_request: open }],
    ['no pull request', { kind: 'proof_not_saved' }],
    ['a pull request that is only a link in a string', { kind: 'proof_not_saved', pull_request: PR_URL }],
    ['a merged pull request', { ...whole, pull_request: { ...open, state: 'merged' } }],
    ['no link and no number', { ...whole, pull_request: { state: 'open' } }],
    ['a link that is not a link', { ...whole, pull_request: { state: 'open', url: 'javascript:alert(1)' } }],
  ]) assert.equal(isProofNotSaved(payload), false, label);
});

test('a claim let go because its proof was not saved is neither a landing nor a miss on the rating, and it is the field that says so, not the words', (t) => {
  const { dir, dbPath, db } = sandboxDb(t);
  for (const n of [1, 2, 3]) landedJob(db, dir, n);
  const before = memberRow(seasonOf(dir, dbPath), 'fleet-codex');
  assert.deepEqual([before.landed, before.dropped, before.finished], [3, 0, 3]);

  const unsaved = unsavedJob(db, dir);
  // The same words in the reason with no field: that is a plain drop.
  const wordsOnly = unsavedJob(db, dir, { title: 'Same words, no field', release: { kind: undefined, pullRequest: undefined } });
  const season = seasonOf(dir, dbPath);
  assert.deepEqual(playsOf(season, unsaved).map((o) => o.kind), ['took', 'held']);
  assert.deepEqual(playsOf(season, wordsOnly).map((o) => o.kind), ['took', 'dropped']);

  const row = memberRow(season, 'fleet-codex');
  assert.deepEqual([row.took, row.landed, row.dropped, row.sent_back, row.abandoned], [5, 3, 1, 0, 0]);
  assert.equal(row.held, 1);
  assert.equal(row.finished, 4, 'only the plain drop is a finished job beside the three landings');
  // Take the plain drop away and the rating is exactly what it was before the held one.
  const withoutWords = season.outcomes.filter((o) => o.task_id !== wordsOnly);
  const clean = rosterRows({ outcomes: withoutWords, limit: 99 }).find((r) => r.name === 'fleet-codex');
  assert.equal(clean.ovr, before.ovr, 'a held job moves the rating by nothing');
  assert.equal(clean.finished, 3);
  assert.equal(clean.held, 1);
  assert.ok(row.ovr < clean.ovr, 'the plain drop still costs');
});

test('a held play shows on the board by its own word and takes no place in a member\'s form, hours, or rating', () => {
  const { form, lastPlays, memberRatings } = require('../lib/gm-season');
  const HOUR = 3600000;
  const play = (kind, n) => ({ event_id: `e${n}`, task_id: `t${n}`, member: 'delta', title: `Job ${n}`, kind, at: n * HOUR, claimed_at: (n - 1) * HOUR });
  const plays = [1, 2, 3, 4, 5].map((n) => play('landed', n)).concat([play('held', 6)]);
  // Five landings and then a held job: the form is still all five landings.
  assert.equal(form(plays), 'kkkkk');
  const [newest, before] = lastPlays(plays, 2);
  assert.equal(newest.kind, 'held');
  assert.equal(newest.play, 'held');
  assert.equal(newest.hours, null, 'a held job did not finish, so it has no hours');
  assert.equal(before.hours, 1, 'a finished job still does');
  assert.deepEqual(memberRatings(plays).get('delta').finished, 5);
});

test('a held release stays held when a person later accepts the job: the claim it closed is not reopened for credit', (t) => {
  const { dir, dbPath, db } = sandboxDb(t);
  const id = unsavedJob(db, dir);
  // A person lands the pull request and closes the job by hand.
  assert.equal(tasks.doneTask(db, { id, status: 'done', actor: 'keshav', allowReview: true, action: 'accepted' }).updated, true);
  const season = seasonOf(dir, dbPath);
  assert.deepEqual(playsOf(season, id).map((o) => o.kind), ['took', 'held']);
  assert.equal(season.outcomes.some((o) => o.kind === 'landed' || o.kind === 'dropped'), false);
});

test('atris rating shows jobs waiting on a pull request on their own line, outside the finished count and the miss reasons', (t) => {
  const { dir, dbPath, db } = sandboxDb(t);
  for (const n of [1, 2, 3]) landedJob(db, dir, n, 'alpha');
  for (const n of [4, 5, 6]) landedJob(db, dir, n, 'beta');
  unsavedJob(db, dir, { title: 'Held one', builder: 'alpha' });
  unsavedJob(db, dir, { title: 'Held two', builder: 'alpha' });
  unsavedJob(db, dir, { title: 'Only held', builder: 'gamma' });
  const season = seasonOf(dir, dbPath);
  const ask = (...args) => {
    let out = '';
    assert.equal(ratingCommand(args, { root: dir, season, lineup: null, write: (s) => { out += s; } }), 0);
    return out;
  };

  const text = ask('alpha');
  assert.match(text, /landed 3 of 3 finished jobs/);
  assert.match(text, /waiting on a pull request: 2 \(the work is done and a person has to land it, so they do not count either way\)/);
  assert.doesNotMatch(text, /top miss reasons/, 'the held release is not a miss reason');
  assert.doesNotMatch(text, /could not be saved/);
  const member = JSON.parse(ask('alpha', '--json')).member;
  assert.equal(member.held, 2);
  assert.equal(member.finished, 3);
  assert.equal(member.miss_reasons, undefined);

  // A member whose only job is waiting on a pull request still has somewhere to see it.
  const gamma = ask('gamma');
  assert.match(gamma, /landed 0 of 0 finished jobs/);
  assert.match(gamma, /waiting on a pull request: 1 \(the work is done and a person has to land it, so it does not count either way\)/);
  assert.equal(JSON.parse(ask('gamma', '--json')).member.finished, 0);

  // A member with nothing waiting has no such line and no such field.
  assert.doesNotMatch(ask('beta'), /waiting on a pull request/);
  assert.equal('held' in JSON.parse(ask('beta', '--json')).member, false);
});

// ---------------------------------------------------------------------------
// The real command line: what the flight sends is accepted as it is written.

function cliWorkspace(t) {
  // The CLI records the real path of its folder, which is not the /var alias macOS gives mkdtemp.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'held-cli-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'atris'));
  const dbPath = path.join(dir, 'tasks.db');
  const run = (args, { env = {} } = {}) => {
    const result = spawnSync(process.execPath, [CLI, ...args], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 30000,
      env: { ...scrubAgentEnv(), ...env, ATRIS_TASKS_DB: dbPath, ATRIS_SKIP_UPDATE_CHECK: '1', NODE_NO_WARNINGS: '1' },
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

// The release command takes no kind and no pull request link. A worker holding a job it
// failed can still type them, and what it gets is what typing a flag nobody defined
// gets: the claim is let go, plainly, and the rating counts the miss. Only the flight,
// in its own process, can say a proof was not saved.
const MADE_UP_LINK = 'https://made-up.example/pr/123';

for (const [where, env] of [['a plain shell', {}], ['an agent session with a mission driver', AGENT_SESSION]]) {
  test(`a worker cannot excuse its own miss by releasing with a kind and a pull request link (${where}): it is a plain drop on the rating`, (t) => {
    const { dir, dbPath, run } = cliWorkspace(t);
    const inputs = [
      ['the reviewer\'s exact input', ['--kind', 'proof_not_saved', '--pr-url', MADE_UP_LINK]],
      ['a pull request number in place of the link', ['--kind', 'proof_not_saved', '--pr-number', '123']],
      ['both, the way the flight used to send them', ['--kind', 'proof_not_saved', '--pr-url', MADE_UP_LINK, '--pr-number', '123']],
      ['a flag nobody ever defined', ['--bogus', 'yes']],
    ];
    const jobs = inputs.map(([label, extra], n) => {
      const title = `Fix the feedback form ${n}`;
      const ref = JSON.parse(run(['task', 'new', title, '--tag', 'feedback', '--json']).stdout).task.display_id;
      run(['task', 'claim', ref, '--as', 'fleet-codex']);
      const released = JSON.parse(run(['task', 'release', ref, '--as', 'fleet-codex', ...extra, '--json'], { env }).stdout);
      assert.equal(released.ok, true, label);
      assert.equal(released.action, 'released', label);
      assert.equal(released.kind, undefined, label);
      assert.equal(released.pull_request, undefined, label);
      return { label, title };
    });

    const reader = new DatabaseSync(dbPath, { readOnly: true });
    const ids = [];
    try {
      for (const job of jobs) {
        const id = reader.prepare('SELECT id FROM tasks WHERE title = ?').get(job.title).id;
        ids.push(id);
        const payloads = reader.prepare("SELECT payload FROM task_events WHERE task_id = ? AND event_type = 'claim_released'").all(id).map((row) => JSON.parse(row.payload));
        assert.equal(payloads.length, 1, job.label);
        assert.equal(payloads[0].kind, undefined, job.label);
        assert.equal(payloads[0].pull_request, undefined, job.label);
      }
    } finally {
      reader.close();
    }

    // The rating counts every one of them as a miss, and none as waiting.
    const season = seasonOf(dir, dbPath);
    for (const id of ids) assert.deepEqual(playsOf(season, id).map((o) => o.kind), ['took', 'dropped']);
    const member = memberRow(season, 'fleet-codex');
    assert.deepEqual([member.dropped, member.held, member.finished], [jobs.length, 0, jobs.length]);

    // And the task list file shows each of them open again.
    const projection = JSON.parse(fs.readFileSync(path.join(dir, '.atris', 'state', 'tasks.projection.json'), 'utf8'));
    for (const id of ids) assert.equal(projection.tasks.find((task) => task.id === id).status, 'open');
  });
}

test('the release help offers a reason and nothing about a kind or a pull request', (t) => {
  const { run } = cliWorkspace(t);
  const lines = run(['task', 'help']).stdout.split('\n');
  const at = lines.findIndex((line) => /atris task release <id>/.test(line));
  assert.ok(at >= 0, 'the release line is in the help');
  assert.match(lines[at], /--reason/);
  assert.doesNotMatch(lines.slice(at, at + 2).join('\n'), /proof_not_saved|--kind|--pr-url|--pr-number/);
  assert.match(lines[at + 1], /atris task capabilities/, 'the release entry is one line');
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

// The sweep is a second way to auto-accept: `atris task sweep --auto-accept` runs the
// job's stored check and accepts on a pass. It must read the open pull request the same
// way, or a held job whose stored check passes is completed with nobody having landed it.

test('task sweep --auto-accept --include-protected leaves a job whose pull request is still open, even with a passing stored check, and still accepts an ordinary job', async (t) => {
  const plane = planeFor(FEEDBACK_TASK);
  await flyWith(t, plane);
  const sent = callsTo(plane, 'task', 'ready')[0];
  assert.ok(sent, 'the flight sent task ready');

  const { dir, dbPath, run } = cliWorkspace(t);
  fs.writeFileSync(path.join(dir, 'app.js'), 'module.exports = 1;\n');
  const create = (title, ...extra) => JSON.parse(run(['task', 'new', title, '--verify', 'node --check app.js', ...extra, '--json']).stdout).task.display_id;
  const held = create('Fix the feedback form so people stop retyping', '--tag', 'feedback');
  const ordinary = create('Tidy the notes page');
  for (const ref of [held, ordinary]) run(['task', 'claim', ref, '--as', 'fleet-codex']);
  // The builder's handoff for the held job, exactly as the flight writes it.
  run(['task', 'ready', held, ...sent.slice(3)]);
  run(['task', 'ready', ordinary, '--proof', 'Reran the check: node --check app.js exited 0. Verify output: # tests 3 # pass 3 # fail 0. Receipt saved at atris/runs/notes.json.', '--result', 'Operators can trust the notes page because the change was checked again.', '--as', 'fleet-codex']);
  const show = (ref) => JSON.parse(run(['task', 'show', ref, '--json']).stdout);
  assert.equal(show(held).status, 'review');
  assert.equal(show(ordinary).status, 'review');

  const swept = JSON.parse(run(['task', 'sweep', '--auto-accept', '--include-protected', '--json']).stdout);
  const outcomeOf = (ref) => swept.results.find((row) => row.ref === ref);
  assert.equal(outcomeOf(held).action, 'skipped', JSON.stringify(swept.results));
  assert.equal(outcomeOf(held).reason, 'pull_request_open');
  assert.deepEqual(outcomeOf(held).pull_request, { state: 'open', number: 77, url: PR_URL });
  assert.match(outcomeOf(held).next_action, /a person lands the pull request/);
  assert.equal(show(held).status, 'review', 'the job is still waiting for a person');
  assert.equal(show(held).claimed_by, 'fleet-codex');
  assert.deepEqual(playsOf(seasonOf(dir, dbPath), show(held).id).map((o) => o.kind), ['took'], 'the rating sees no landing');

  // The gate is the open pull request and nothing wider: the other job in the same sweep is accepted.
  assert.equal(outcomeOf(ordinary).action, 'accepted', JSON.stringify(swept.results));
  assert.equal(show(ordinary).status, 'done');
  assert.equal(swept.accepted, 1);
  assert.equal(swept.skipped, 1);

  // Running it again changes nothing for the held job.
  const again = JSON.parse(run(['task', 'sweep', '--auto-accept', '--include-protected', '--json']).stdout);
  assert.equal(again.accepted, 0);
  assert.equal(show(held).status, 'review');

  // A person's own accept is untouched, which is the next step the refusal names.
  run(['task', 'accept', held, '--as', 'keshav', '--json']);
  assert.equal(show(held).status, 'done');
});

test('the sweep refuses an open pull request before it runs any check, and the same job with none is eligible', (t) => {
  const { evaluateSweepAutoAccept } = require('../commands/task');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'held-sweep-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'app.js'), 'module.exports = 1;\n');
  const PROOF = `Built by codex engine. Pull request ${PR_URL} waits for a person to land it. The declared verifier passed (exit 0).`;
  const job = ({ pullRequest = null, verify = 'node --check app.js', events = [], tag = 'feedback' } = {}) => ({
    id: 'task-held-1',
    display_id: 'HC-1',
    status: 'review',
    tag,
    workspace_root: root,
    metadata: { approval_status: 'pending', verify, latest_agent_proof: PROOF, ...(pullRequest ? { pull_request: pullRequest } : {}) },
    review: { approval_status: 'pending', proof: PROOF },
    events,
  });
  const open = { state: 'open', number: 77, url: PR_URL };

  // The reviewer's scenario: the stored check passes, and the job is still not accepted.
  const control = evaluateSweepAutoAccept(job(), root, true);
  assert.equal(control.eligible, true, JSON.stringify(control));
  assert.equal(control.reason, 'verified_command');
  const held = evaluateSweepAutoAccept(job({ pullRequest: open }), root, true);
  assert.deepEqual(held, {
    eligible: false,
    ref: 'HC-1',
    reason: 'pull_request_open',
    pull_request: open,
    next_action: 'a person lands the pull request, then accepts the job with `atris task accept <ref> --as <human>`',
  });

  // It answers before the stored check is run: a check that would fail still reports the pull request.
  assert.equal(evaluateSweepAutoAccept(job({ verify: 'node --check missing.js' }), root, true).reason, 'verify_failed');
  assert.equal(evaluateSweepAutoAccept(job({ pullRequest: open, verify: 'node --check missing.js' }), root, true).reason, 'pull_request_open');

  // The sweep's own protected lanes (money, deploy, ...) are still refused first, so the
  // "waiting on you" list reads the same. Its lane list does not include feedback, so there
  // the open pull request is what stops a held job, with or without --include-protected.
  assert.equal(evaluateSweepAutoAccept(job({ pullRequest: open, tag: 'deploy' }), root, false).reason, 'protected_lane');
  assert.equal(evaluateSweepAutoAccept(job({ pullRequest: open }), root, false).reason, 'pull_request_open');

  // The same rules as the other auto-accept: the history is read when the row names none, only
  // from the attempt that is still going; a merge on the row frees the job.
  const proofReady = (pull_request) => ({ event_type: 'proof_ready', actor: 'fleet-codex', payload: pull_request ? { pull_request } : {} });
  const reopened = { event_type: 'reopened', actor: 'keshav', payload: { previous_status: 'review' } };
  assert.equal(evaluateSweepAutoAccept(job({ events: [proofReady(open)] }), root, true).reason, 'pull_request_open');
  assert.equal(evaluateSweepAutoAccept(job({ events: [proofReady(open), reopened, proofReady(null)] }), root, true).eligible, true);
  assert.equal(evaluateSweepAutoAccept(job({ pullRequest: { state: 'merged', number: 77, url: PR_URL, merge_commit: COMMIT } }), root, true).eligible, true);
});

test('the shared acceptor is the last door: handed a job whose pull request is open, it refuses to complete it for the machine, and writes nothing', (t) => {
  const { acceptReviewTask } = require('../commands/task');
  const { dir, db } = sandboxDb(t);
  const id = heldJob(db, dir);
  const before = tasks.getTask(db, id);
  const refused = acceptReviewTask(tasks, db, id, { actor: 'orb-autoaccept', proof: 'The stored check passed.', reward: 1, autoAccepted: true });
  assert.deepEqual(refused, { ok: false, reason: 'pull_request_open', pull_request: { state: 'open', number: 77, url: PR_URL } });
  const after = tasks.getTask(db, id);
  assert.equal(after.status, 'review');
  assert.equal(after.updated_at, before.updated_at, 'the row was not touched');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM task_events WHERE task_id = ? AND event_type = 'completed'").get(id).n, 0);
  assert.deepEqual(playsOf(seasonOf(dir, path.join(dir, 'tasks.db')), id).map((o) => o.kind), ['took']);
});

// A held job whose pull request is closed without merging is sent back to open. The next
// attempt may name no pull request at all. The old open one, still in the job's history,
// must not block it.

test('after a held job is reopened and tried again with no pull request, auto-approval no longer sees the old open one', async (t) => {
  const plane = planeFor(FEEDBACK_TASK);
  await flyWith(t, plane);
  const sent = callsTo(plane, 'task', 'ready')[0];
  assert.ok(sent, 'the flight sent task ready');

  const { dir, dbPath, run } = cliWorkspace(t);
  fs.writeFileSync(path.join(dir, 'app.js'), 'module.exports = 1;\n');
  const id = JSON.parse(run(['task', 'new', 'Fix the feedback form so people stop retyping', '--tag', 'feedback', '--verify', 'node --check app.js', '--json']).stdout).task.display_id;
  const show = () => JSON.parse(run(['task', 'show', id, '--json']).stdout);
  const rowPullRequest = () => {
    const reader = new DatabaseSync(dbPath, { readOnly: true });
    try {
      return JSON.parse(reader.prepare('SELECT metadata FROM tasks WHERE id = ?').get(show().id).metadata).pull_request;
    } finally {
      reader.close();
    }
  };
  // The flight's own ready arguments, naming the pull request it opened.
  const heldReady = (number = 77, url = PR_URL) => {
    const args = sent.slice(3);
    args[args.indexOf('--pr-number') + 1] = String(number);
    args[args.indexOf('--pr-url') + 1] = url;
    return args;
  };
  const independentLook = () => run(['task', 'ready', id,
    '--proof', 'Independent review of the diff. Reran the check: node --check app.js exited 0. Verify output: # tests 3 # pass 3 # fail 0. Receipt saved at atris/runs/review.json.',
    '--result', 'Operators can trust the form fix because a second reader confirmed the change.',
    '--as', 'claude']);
  const preview = () => {
    const out = JSON.parse(run(['task', 'auto-accept-certified', '--all', '--include-protected', '--dry-run', '--json']).stdout);
    assert.equal(out.results.length, 1, JSON.stringify(out.results));
    return out.results[0];
  };

  // The held case: an open pull request, so auto-approval keeps its hands off.
  run(['task', 'claim', id, '--as', 'fleet-codex']);
  run(['task', 'ready', id, ...heldReady()]);
  independentLook();
  assert.equal(preview().reason, 'pull_request_open');
  assert.deepEqual(rowPullRequest(), { state: 'open', number: 77, url: PR_URL });

  // Its pull request is closed without merging and a person sends the job back.
  run(['task', 'reopen', id, '--as', 'keshav', '--reason', 'the pull request was closed without merging']);
  assert.equal(show().status, 'open');
  assert.equal(rowPullRequest(), undefined, 'the reopen cleared the row');

  // The next attempt names no pull request, and gets a second look.
  run(['task', 'claim', id, '--as', 'fleet-codex']);
  run(['task', 'ready', id, '--proof', 'Redid the form fix on a fresh branch. Reran the check: node --check app.js exited 0. Verify output: # tests 3 # pass 3 # fail 0. Receipt saved at atris/runs/redo.json.', '--result', 'Operators can trust the form fix because it was redone and checked again.', '--as', 'fleet-codex']);
  independentLook();
  assert.equal(show().status, 'review');

  const now = preview();
  assert.notEqual(now.reason, 'pull_request_open', JSON.stringify(now));
  assert.equal(now.action, 'would_accept', JSON.stringify(now));

  // And a new attempt that opens a pull request of its own is held again.
  run(['task', 'reopen', id, '--as', 'keshav', '--reason', 'try once more']);
  run(['task', 'claim', id, '--as', 'fleet-codex']);
  run(['task', 'ready', id, ...heldReady(78, 'https://github.example/repo/pull/78')]);
  independentLook();
  const reheld = preview();
  assert.equal(reheld.reason, 'pull_request_open');
  assert.equal(reheld.pull_request.number, 78);
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
