const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const autoland = require('../lib/autoland');

function makeTempRepo() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-autoland-test-'));
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  runGit(['init', '-b', 'master'], repo);
  runGit(['config', 'user.email', 'test@example.com'], repo);
  runGit(['config', 'user.name', 'Test'], repo);
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
  runGit(['add', '.'], repo);
  runGit(['commit', '-m', 'init'], repo);
  return { base, repo };
}

function cleanupTempDir(base) {
  fs.rmSync(base, { recursive: true, force: true });
}

function runGit(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr || result.stdout}`);
  return result;
}

// Live accepts refuse to run inside an agent session, so the fixture CLI
// runs with the agent env markers stripped — same as a cron tick. The task
// db is isolated per fixture repo (the real one lives in ~/.atris).
function runCli(args, cwd) {
  const env = {
    ...process.env,
    ATRIS_SKIP_UPDATE_CHECK: '1',
    CI: 'true',
    ATRIS_TASKS_DB: path.join(cwd, '.atris', 'fixture-tasks.db'),
  };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.CLAUDE_CODE_SSE_PORT;
  delete env.CODEX_SANDBOX;
  delete env.CURSOR_AGENT;
  delete env.DEVIN_SESSION_ID;
  delete env.ATRIS_AGENT_PROOF_ONLY;
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 30000,
    env,
  });
  if (result.error) throw result.error;
  return result;
}

// Create a task and walk it to certified: proof from the builder, then a
// second proof pass from an independent reviewer (2 passes, 2 actors).
function certifiedTask(repo, title, { tag = 'code' } = {}) {
  const created = runCli(['task', 'new', title, '--tag', tag, '--json'], repo);
  assert.equal(created.status, 0, created.stderr || created.stdout);
  const id = JSON.parse(created.stdout).task?.display_id
    || JSON.parse(created.stdout).task?.id
    || JSON.parse(created.stdout).display_id
    || JSON.parse(created.stdout).id;
  assert.ok(id, `no task id in: ${created.stdout.slice(0, 200)}`);
  assert.equal(runCli(['task', 'claim', String(id), '--as', 'builder'], repo).status, 0);
  const proof = 'Command passed: git diff --check. Evidence inspected: clean tree, change verified in place.';
  assert.equal(runCli(['task', 'ready', String(id), '--proof', proof, '--as', 'builder'], repo).status, 0);
  assert.equal(runCli(['task', 'ready', String(id), '--proof', proof, '--as', 'codex-review'], repo).status, 0);
  return String(id);
}

test('digest and alarm compose in plain language', () => {
  const digest = autoland.composeDigest({
    accepted: {
      auto: [
        { ref: 'CLI-1', title: 'Mission XP: Fix mission budget inference', happened: 'Slow mission budgets cost users trust, so long runs now keep using the promised time.' },
        { ref: 'CLI-2', title: 'Manual member checks waste users time: hourly loops keep work moving' },
        { ref: 'CLI-6', title: 'Add --hourly flag so users save time' },
        { ref: 'CLI-4', title: 'Mission XP: Decide and start the next useful mission after: x', happened: 'Stopped with reason: no concrete follow-up mission found.' },
        { ref: 'CLI-5', title: 'Mission XP: Decide and start the next useful mission after: y', happened: 'The continuation did not start fake work.' },
      ],
      human: [{ ref: 'CLI-3', title: 'Ship release' }],
    },
    waiting: [{ ref: 'CLI-9', title: 'Send invoice', tag: 'billing', hours: 30 }],
    landed: { branches: 2, due: 1 },
    project: 'atris-cli',
    nextMoves: {
      moves: [
        { title: 'Finish the taste filters: scores should use the role weights', owner: 'auto-improver' },
        { title: 'Give the stuck codex mission an engine or stop it', owner: null },
      ],
      unexplained: 2,
    },
  });
  assert.match(digest, /landed on their own \(verified twice, proof on file\)/);
  assert.match(digest, /- slow mission budgets cost users trust/);
  assert.match(digest, /- manual member checks waste users time/);
  // Clean-stop check-offs fold into the on-ask count; results get air between
  // them so the whole message fits a laptop screen with no scrolling.
  assert.match(digest, /\n\n- slow mission budgets/);
  assert.match(digest, /2 more results when you want them: atris autoland digest/);
  assert.match(digest, /you approved 1 piece yourself/);
  assert.match(digest, /waiting on you: 1 \(oldest 30h\)/);
  assert.match(digest, /in the air: 2 pieces, 1 overdue/);
  assert.match(digest, /next, if you agree:/);
  assert.match(digest, /taste filters.*\(best fit: auto-improver\)/);
  assert.match(digest, /stuck codex mission/);
  assert.match(digest, /- 2 more ideas that can't explain themselves yet \(atris now\)/);
  assert.match(digest, /the full story: atris autoland digest/);
  assert.doesNotMatch(digest, /branch|worktree|ttl|certif(?!ied)|--hourly/i);

  const quiet = autoland.composeDigest({
    accepted: { auto: [], human: [] },
    waiting: [],
    landed: { branches: 2, due: 0 },
    project: 'atris-cli',
  });
  assert.match(quiet, /waiting on you: nothing/);
  assert.match(quiet, /in the air: 2 pieces, all fresh/);
  assert.doesNotMatch(quiet, /next, if you agree/);

  const alarm = autoland.composeAlarm({
    waiting: [{ ref: 'CLI-9', title: 'Send invoice', hours: 30 }],
    project: 'atris-cli',
    alarmHours: 24,
  });
  assert.match(alarm, /1 piece of finished work has been waiting on you for over 24h/);
  assert.match(alarm, /CLI-9 \(30h\)/);
});

test('operatorReady: a queue sentence earns its digest surface with a why, no agent jargon', () => {
  const { operatorReady } = require('../commands/autoland');
  // Carries a cost the operator can feel, no identifiers.
  assert.ok(operatorReady('Agents burn tokens hand-rolling state parsers: add one shared inspect view'));
  assert.ok(operatorReady('Slow boot makes every demo start with an apology: cache the workspace scan'));
  // No why an operator can use.
  assert.ok(!operatorReady('Novel goal-chain demo: prove 4 child goals can validate a mission'));
  // Why present but written in agent vocabulary (snake_case, flags, ids).
  assert.ok(!operatorReady('Make codex_goal slot handoff faster for users'));
  assert.ok(!operatorReady('Add --inspect flag so users save time'));
  assert.ok(!operatorReady('CLI-788 failed because the continuation stopped'));
});

test('alarm dedupe: a task pings once per window', () => {
  const now = Date.now();
  const waiting = [{ ref: 'CLI-9', hours: 30 }, { ref: 'CLI-8', hours: 10 }];
  const state = { alerts: {} };
  const due = autoland.dueForAlarm(waiting, state, { alarmHours: 24, now });
  assert.deepEqual(due.map((d) => d.ref), ['CLI-9']);
  autoland.markAlerted(state, due, now);
  assert.deepEqual(autoland.dueForAlarm(waiting, state, { alarmHours: 24, now: now + 3600000 }), []);
  const later = now + 25 * 3600000;
  assert.deepEqual(autoland.dueForAlarm(waiting, state, { alarmHours: 24, now: later }).map((d) => d.ref), ['CLI-9']);
});

test('policy file gates live accept authorization', () => {
  const { base, repo } = makeTempRepo();
  try {
    assert.equal(autoland.liveAcceptAuthorization(repo).ok, false);
    autoland.writePolicy(repo, { enabled: true, enabled_by: 'keshav' });
    const auth = autoland.liveAcceptAuthorization(repo);
    assert.equal(auth.ok, true);
    assert.equal(auth.actor, 'keshav');
    autoland.writePolicy(repo, { enabled: false, enabled_by: 'keshav' });
    assert.equal(autoland.liveAcceptAuthorization(repo).ok, false);
  } finally {
    cleanupTempDir(base);
  }
});

test('cron line is labeled and removable', () => {
  const line = autoland.buildCronLine('/tmp/some-project');
  assert.match(line, /# ATRIS_AUTOLAND_SOME_PROJECT$/);
  assert.match(line, /autoland tick/);
});

test('live auto-accept refuses without policy, lands with it, blocks denied lanes', () => {
  const { base, repo } = makeTempRepo();
  try {
    const codeTask = certifiedTask(repo, 'Fix the flaky moves test', { tag: 'code' });
    const billingTask = certifiedTask(repo, 'Send the June invoice', { tag: 'billing' });

    // no policy: live refuses
    const refused = runCli(['task', 'auto-accept-certified', '--json'], repo);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stdout + refused.stderr, /human_accept_confirmation_required/);

    // owner flips the policy: the code task lands, billing stays for the human
    autoland.writePolicy(repo, { enabled: true, enabled_by: 'keshav', strict_verify: false });
    const tick = runCli(['autoland', 'tick', '--json'], repo);
    assert.equal(tick.status, 0, tick.stderr || tick.stdout);
    const receipt = JSON.parse(tick.stdout.trim().split('\n').pop());
    assert.deepEqual(receipt.landed, [codeTask]);

    const status = runCli(['task', 'status', '--json'], repo);
    const projection = JSON.parse(fs.readFileSync(path.join(repo, '.atris', 'state', 'tasks.projection.json'), 'utf8'));
    const byRef = Object.fromEntries(projection.tasks.map((t) => [t.display_id, t]));
    assert.equal(byRef[codeTask].status, 'done');
    assert.equal(byRef[codeTask].metadata.accepted_by, 'keshav');
    assert.ok(byRef[codeTask].metadata.auto_accepted_at);
    assert.equal(byRef[billingTask].status, 'review');
    assert.equal(status.status, 0);
  } finally {
    cleanupTempDir(base);
  }
});

// Walk a task only to first proof: builder ready, no second reviewer. The tick
// must supply the second-actor check itself by re-running the proof's command.
function proofBackedTask(repo, title, { tag = 'code' } = {}) {
  const created = runCli(['task', 'new', title, '--tag', tag, '--json'], repo);
  assert.equal(created.status, 0, created.stderr || created.stdout);
  const id = JSON.parse(created.stdout).task?.display_id || JSON.parse(created.stdout).task?.id;
  assert.ok(id, `no task id in: ${created.stdout.slice(0, 200)}`);
  assert.equal(runCli(['task', 'claim', String(id), '--as', 'builder'], repo).status, 0);
  const proof = 'Command passed: git diff --check. Evidence inspected: clean tree, change verified in place.';
  assert.equal(runCli(['task', 'ready', String(id), '--proof', proof, '--as', 'builder'], repo).status, 0);
  return String(id);
}

test('tick certifies proof-backed reviews by re-running their check, then lands them', () => {
  const { base, repo } = makeTempRepo();
  try {
    const codeTask = proofBackedTask(repo, 'One-tick landing', { tag: 'code' });
    const securityTask = proofBackedTask(repo, 'Rotate the signing key', { tag: 'security' });
    const noCheckCreated = runCli(['task', 'new', 'No runnable check', '--tag', 'code', '--json'], repo);
    const noCheckTask = String(JSON.parse(noCheckCreated.stdout).task?.display_id);
    assert.equal(runCli(['task', 'claim', noCheckTask, '--as', 'builder'], repo).status, 0);
    // meaningful proof (receipt path) but no runnable command to re-run
    assert.equal(runCli(['task', 'ready', noCheckTask, '--proof', 'Receipt saved at atris/runs/demo-receipt.json, reviewed the rendered output end to end.', '--as', 'builder'], repo).status, 0);

    autoland.writePolicy(repo, { enabled: true, enabled_by: 'keshav', strict_verify: false });
    const tick = runCli(['autoland', 'tick', '--json'], repo);
    assert.equal(tick.status, 0, tick.stderr || tick.stdout);
    const receipt = JSON.parse(tick.stdout.trim().split('\n').pop());
    // one heartbeat: the code task is certified by the re-run check AND landed
    assert.equal(receipt.reviews_certified, 1);
    assert.deepEqual(receipt.landed, [codeTask]);

    const projection = JSON.parse(fs.readFileSync(path.join(repo, '.atris', 'state', 'tasks.projection.json'), 'utf8'));
    const byRef = Object.fromEntries(projection.tasks.map((t) => [t.display_id, t]));
    assert.equal(byRef[codeTask].status, 'done');
    // the protected lane and the check-less proof both keep waiting for a human
    assert.equal(byRef[securityTask].status, 'review');
    assert.equal(byRef[securityTask].review.agent_certified, false);
    assert.equal(byRef[noCheckTask].status, 'review');
    assert.equal(byRef[noCheckTask].review.agent_certified, false);
  } finally {
    cleanupTempDir(base);
  }
});

test('tick is a no-op when the policy is off', () => {
  const { base, repo } = makeTempRepo();
  try {
    certifiedTask(repo, 'Some certified work', { tag: 'code' });
    const tick = runCli(['autoland', 'tick', '--json'], repo);
    assert.equal(tick.status, 0);
    const receipt = JSON.parse(tick.stdout.trim().split('\n').pop());
    assert.equal(receipt.enabled, false);
    assert.deepEqual(receipt.landed, []);
  } finally {
    cleanupTempDir(base);
  }
});
