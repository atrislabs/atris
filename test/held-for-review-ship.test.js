'use strict';

const {
  CLI,
  PR_URL,
  COMMIT,
  FEEDBACK_TASK,
  flyWith,
  planeFor,
  callsTo,
  sandboxDb,
  heldJob,
  seasonOf,
  playsOf,
  cliWorkspace,
} = require('./helpers/held-review-fixtures');

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
const { scrubAgentEnv } = require('./helpers/agent-env');

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
