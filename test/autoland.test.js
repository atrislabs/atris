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
function runCli(args, cwd, extraEnv = null) {
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
  if (extraEnv) Object.assign(env, extraEnv);
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
  // The jargon-heavy result shows de-jargoned instead of hiding: content
  // always ships. Held count = clean-stop fold only.
  assert.match(digest, /- add hourly flag so users save time/);
  assert.match(digest, /1 more result when you want them: atris autoland digest/);
  // v5: no self-news ("you approved N") and no separate workers tally; each
  // result carries its author inline instead.
  assert.doesNotMatch(digest, /you approved|workers:/);
  // Waiting items are the ask, so they carry names, not counts.
  assert.match(digest, /waiting on you \(approve or bounce: atris task reviews\):/);
  assert.match(digest, /- Send invoice \(30h\)/);
  assert.match(digest, /in the air: 2 pieces, 1 overdue/);
  assert.match(digest, /next, if you agree:/);
  assert.match(digest, /taste filters.*\(best fit: auto-improver\)/);
  assert.match(digest, /stuck codex mission/);
  assert.match(digest, /- 2 more ideas that can't explain themselves yet \(atris now\)/);
  // One tail pointer: the 'more results' line already names the command, so
  // the closing line only appears when nothing else pointed there.
  assert.equal((digest.match(/atris autoland digest/g) || []).length, 1);
  assert.doesNotMatch(digest, /branch|worktree|ttl|certif(?!ied)|--hourly/i);

  const quiet = autoland.composeDigest({
    accepted: { auto: [], human: [] },
    waiting: [],
    landed: { branches: 2, due: 0 },
    project: 'atris-cli',
  });
  assert.match(quiet, /waiting on you: nothing/);
  assert.match(quiet, /in the air: 2 pieces, all fresh/);
  assert.match(quiet, /the full story: atris autoland digest/);
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

test('clarify: the gate strips agent jargon and closes the thought before an operator reads it', () => {
  const { clarify } = autoland;
  // Flag dashes, task ids, and snake_case are what an operator cannot act on;
  // the gate removes them so a borrowed title reads as plain language.
  const cleaned = clarify('CLI-844 add --inspect flag so agent_state parsers stop burning tokens');
  assert.doesNotMatch(cleaned, /CLI-\d+/);
  assert.doesNotMatch(cleaned, /--[a-z]/);
  assert.doesNotMatch(cleaned, /[a-z]_[a-z]/);
  assert.match(cleaned, /inspect flag/);
  assert.match(cleaned, /agent state parsers/);
  // A cleaned title with a real why now passes the operator gate it failed raw.
  assert.ok(!autoland.operatorReady('Add --inspect flag so users save time'));
  assert.ok(autoland.operatorReady(clarify('Add --inspect flag so users save time')));
  // Long lines close on a whole clause inside the budget: the sentence ends at
  // its last complete clause, reads whole, and drops no ellipsis mid-thought.
  const long = clarify('Cache the workspace scan so slow boot stops making every demo start with an apology, which costs trust', 95);
  assert.ok(long.endsWith('apology'), long);
  assert.doesNotMatch(long, /which costs trust/);
  assert.doesNotMatch(long, /\.\.\.$/);
  // A clean sentence passes through untouched.
  assert.equal(clarify('Slow boot makes every demo start with an apology'), 'Slow boot makes every demo start with an apology');
});

test('live update: a landing texts its capability sentence the moment it lands', () => {
  const tasks = [
    { display_id: 'CLI-1', title: 'Fix onboarding', claimed_by: 'onboarding', metadata: { landing_happened: 'A new user now reaches task setup before any proof tick, so Atris avoids a fake first receipt.' } },
    { display_id: 'CLI-2', title: 'Mission XP: Decide and start the next useful mission after: x', metadata: { landing_happened: 'Stopped with reason: no concrete follow-up mission found.' } },
  ];
  const text = autoland.composeLiveUpdate({ landedRefs: ['CLI-1', 'CLI-2'], tasks, project: 'atris-cli' });
  assert.match(text, /atris atris-cli: just landed/);
  assert.match(text, /- a new user now reaches task setup before any proof tick/);
  assert.match(text, /\(onboarding\)/);
  // Clean-stop check-offs never page the operator.
  assert.doesNotMatch(text, /no concrete follow-up/);
  // A landing that is nothing but clean stops sends no text at all.
  assert.equal(autoland.composeLiveUpdate({ landedRefs: ['CLI-2'], tasks, project: 'atris-cli' }), '');
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
    // default is ON with an inferred owner; only an explicit off blocks
    const defaultAuth = autoland.liveAcceptAuthorization(repo);
    assert.equal(defaultAuth.ok, true);
    assert.ok(defaultAuth.actor);
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

test('autoland help forms are read-only and do not run a heartbeat', () => {
  const { base, repo } = makeTempRepo();
  try {
    const codeTask = certifiedTask(repo, 'Help must not land work', { tag: 'code' });
    autoland.writePolicy(repo, { enabled: true, enabled_by: 'keshav', strict_verify: false });

    for (const args of [
      ['autoland', '--help'],
      ['autoland', 'tick', '--help'],
      ['autoland', 'tick', 'help'],
      ['autoland', 'bogus', '--help'],
    ]) {
      const help = runCli(args, repo);
      assert.equal(help.status, 0, help.stderr || help.stdout);
      assert.match(help.stdout, /atris autoland — you approve the policy once/);
      assert.match(help.stdout, /atris autoland tick \[--json\]/);
      assert.match(help.stdout, /tick --help never lands work/);
      assert.doesNotMatch(help.stdout, /autoland tick:/);
    }

    const projection = JSON.parse(fs.readFileSync(path.join(repo, '.atris', 'state', 'tasks.projection.json'), 'utf8'));
    const byRef = Object.fromEntries(projection.tasks.map((t) => [t.display_id, t]));
    assert.equal(byRef[codeTask].status, 'review');
    assert.equal(byRef[codeTask].metadata.accepted_by, undefined);
    assert.equal(fs.existsSync(path.join(repo, '.atris', 'state', 'autoland.json')), false);
  } finally {
    cleanupTempDir(base);
  }
});

test('live auto-accept refuses without policy, lands with it, blocks denied lanes', () => {
  const { base, repo } = makeTempRepo();
  try {
    const codeTask = certifiedTask(repo, 'Fix the flaky moves test', { tag: 'code' });
    const billingTask = certifiedTask(repo, 'Send the June invoice', { tag: 'billing' });

    // explicit off: live refuses
    autoland.writePolicy(repo, { enabled: false, enabled_by: 'keshav' });
    const refused = runCli(['task', 'auto-accept-certified', '--json'], repo);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stdout + refused.stderr, /human_accept_confirmation_required/);

    // owner flips the policy back on: the code task lands, billing stays for the human
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

test('tick from an agent session lands under the standing policy with a real-number receipt', () => {
  const { base, repo } = makeTempRepo();
  const agentEnv = { CLAUDECODE: '1' };
  try {
    // a proof-backed row: runnable check, NOT yet agent_certified — the tick
    // must certify it via strict verify and land it in one heartbeat
    const codeTask = proofBackedTask(repo, 'Agent-session landing', { tag: 'code' });

    // guard intact: without the standing policy, an agent env cannot
    // live-accept even with a per-run human-confirmation claim
    const refused = runCli(['task', 'auto-accept-certified', '--confirm-human-accept', '--as', 'keshavrao', '--json'], repo, agentEnv);
    assert.equal(JSON.parse(refused.stdout).reason, 'agent_proof_only_human_accept_blocked');

    autoland.writePolicy(repo, { enabled: true, enabled_by: 'keshav', strict_verify: false });
    // the tick invoked WITH agent markers (a Claude session running
    // `atris autoland tick`): before the fix, the spawned sweep failTask'd
    // on agentProofOnlyMode and the receipt showed landed:[] with null
    // certified/scanned — a blind heartbeat that looked like "no work".
    const tick = runCli(['autoland', 'tick', '--json'], repo, agentEnv);
    assert.equal(tick.status, 0, tick.stderr || tick.stdout);
    const receipt = JSON.parse(tick.stdout.trim().split('\n').pop());
    assert.equal(receipt.accept_error, undefined, JSON.stringify(receipt));
    assert.deepEqual(receipt.landed, [codeTask]);
    // the receipt carries the sweep's real numbers, never nulls when rows exist
    assert.equal(typeof receipt.certified, 'number');
    assert.equal(typeof receipt.scanned, 'number');
    assert.ok(receipt.scanned >= 1, JSON.stringify(receipt));

    const projection = JSON.parse(fs.readFileSync(path.join(repo, '.atris', 'state', 'tasks.projection.json'), 'utf8'));
    const byRef = Object.fromEntries(projection.tasks.map((t) => [t.display_id, t]));
    assert.equal(byRef[codeTask].status, 'done');
    // the accept actor is the policy owner, not the agent
    assert.equal(byRef[codeTask].metadata.accepted_by, 'keshav');
  } finally {
    cleanupTempDir(base);
  }
});

test('tick still certifies when policy contains drain_reviews false', () => {
  const { base, repo } = makeTempRepo();
  try {
    const id = proofBackedTask(repo, 'Drain reviews ignored', { tag: 'code' });
    autoland.writePolicy(repo, {
      enabled: true,
      enabled_by: 'keshav',
      strict_verify: false,
      drain_reviews: false,
    });
    const tick = runCli(['autoland', 'tick', '--json'], repo);
    assert.equal(tick.status, 0, tick.stderr || tick.stdout);
    const receipt = JSON.parse(tick.stdout.trim().split('\n').pop());
    assert.equal(receipt.reviews_certified, 1);
    assert.deepEqual(receipt.landed, [id]);
  } finally {
    cleanupTempDir(base);
  }
});

test('two passes from one actor cannot land until the tick independently re-runs the check', () => {
  const { base, repo } = makeTempRepo();
  try {
    const id = proofBackedTask(repo, 'Same reviewer twice', { tag: 'code' });
    // second pass by the SAME actor: not certified and not landable
    // (needs_independent_reviewer) until a distinct actor re-runs the check
    const proof = 'Command passed: git diff --check. Evidence inspected: clean tree, change verified in place.';
    assert.equal(runCli(['task', 'ready', String(id), '--proof', proof, '--as', 'builder'], repo).status, 0);

    autoland.writePolicy(repo, { enabled: true, enabled_by: 'keshav', strict_verify: false });
    const tick = runCli(['autoland', 'tick', '--json'], repo);
    assert.equal(tick.status, 0, tick.stderr || tick.stdout);
    const receipt = JSON.parse(tick.stdout.trim().split('\n').pop());
    assert.equal(receipt.reviews_certified, 1);
    assert.deepEqual(receipt.landed, [id]);
  } finally {
    cleanupTempDir(base);
  }
});

test('tick drains the landing daily: landed branches reap themselves, once per day', () => {
  const { base, repo } = makeTempRepo();
  try {
    // a branch with no commits ahead of master is residue — the exact thing
    // that piles into "N overdue" on the boot banner when no human reaps
    runGit(['branch', 'residue-branch'], repo);
    autoland.writePolicy(repo, { enabled: true, enabled_by: 'keshav', strict_verify: false });

    const tick = runCli(['autoland', 'tick', '--json'], repo);
    assert.equal(tick.status, 0, tick.stderr || tick.stdout);
    const receipt = JSON.parse(tick.stdout.trim().split('\n').pop());
    assert.equal(receipt.reaped.branches, 1);
    const branches = runGit(['branch', '--list', 'residue-branch'], repo);
    assert.equal(branches.stdout.trim(), '');

    // same day, second tick: the date gate holds, no second reap
    const again = runCli(['autoland', 'tick', '--json'], repo);
    const receipt2 = JSON.parse(again.stdout.trim().split('\n').pop());
    assert.equal(receipt2.reaped, undefined);
    const state = JSON.parse(fs.readFileSync(path.join(repo, '.atris', 'state', 'autoland.json'), 'utf8'));
    assert.equal(state.last_reap_date, new Date().toISOString().slice(0, 10));
  } finally {
    cleanupTempDir(base);
  }
});

test('accept_all policy: uncertified work lands on the tick, protected lanes wait', () => {
  const { base, repo } = makeTempRepo();
  try {
    // one pass, one actor, no runnable check — never lands under the certified bar
    const created = runCli(['task', 'new', 'Loose bar lands this', '--tag', 'code', '--json'], repo);
    const id = String(JSON.parse(created.stdout).task?.display_id);
    assert.equal(runCli(['task', 'claim', id, '--as', 'builder'], repo).status, 0);
    assert.equal(runCli(['task', 'ready', id, '--proof', 'Receipt saved at atris/runs/demo-receipt.json, reviewed the rendered output end to end.', '--as', 'builder'], repo).status, 0);
    const billingTask = certifiedTask(repo, 'Wire the vendor payment', { tag: 'billing' });

    autoland.writePolicy(repo, { enabled: true, enabled_by: 'keshav', accept_all: true });
    const tick = runCli(['autoland', 'tick', '--json'], repo);
    assert.equal(tick.status, 0, tick.stderr || tick.stdout);
    const receipt = JSON.parse(tick.stdout.trim().split('\n').pop());
    assert.ok(receipt.landed.includes(id), `expected ${id} in ${JSON.stringify(receipt.landed)}`);
    assert.ok(!receipt.landed.includes(billingTask));

    const projection = JSON.parse(fs.readFileSync(path.join(repo, '.atris', 'state', 'tasks.projection.json'), 'utf8'));
    const byRef = Object.fromEntries(projection.tasks.map((t) => [t.display_id, t]));
    assert.equal(byRef[id].status, 'done');
    assert.equal(byRef[billingTask].status, 'review');
  } finally {
    cleanupTempDir(base);
  }
});

test('tick is a no-op when the policy is off', () => {
  const { base, repo } = makeTempRepo();
  try {
    certifiedTask(repo, 'Some certified work', { tag: 'code' });
    autoland.writePolicy(repo, { enabled: false, enabled_by: 'keshav' });
    const tick = runCli(['autoland', 'tick', '--json'], repo);
    assert.equal(tick.status, 0);
    const receipt = JSON.parse(tick.stdout.trim().split('\n').pop());
    assert.equal(receipt.enabled, false);
    assert.deepEqual(receipt.landed, []);
  } finally {
    cleanupTempDir(base);
  }
});

test('tick lock: a live concurrent tick is skipped, a stale lock is not', () => {
  const { base, repo } = makeTempRepo();
  try {
    autoland.writePolicy(repo, { enabled: true, enabled_by: 'keshav', accept_all: true });
    const lockPath = path.join(repo, '.atris', 'state', 'autoland.tick.lock');
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    // live: this test process's pid, fresh timestamp
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: Date.now() }));
    const skipped = runCli(['autoland', 'tick', '--json'], repo);
    const receipt = JSON.parse(skipped.stdout.trim().split('\n').pop());
    assert.equal(receipt.skipped_reason, 'tick_already_running');
    assert.deepEqual(receipt.landed, []);
    // stale: same pid but an hour old — the tick runs and clears the lock
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: Date.now() - 60 * 60 * 1000 }));
    const ran = runCli(['autoland', 'tick', '--json'], repo);
    const receipt2 = JSON.parse(ran.stdout.trim().split('\n').pop());
    assert.equal(receipt2.skipped_reason, undefined);
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    cleanupTempDir(base);
  }
});

test('a failed daily sweep is not a secret: receipt, state, status, digest all carry it', () => {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-autoland-test-'));
  const repo = path.join(outer, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  runGit(['init', '-b', 'trunk'], repo); // no master/main: the sweep throws
  runGit(['config', 'user.email', 'test@example.com'], repo);
  runGit(['config', 'user.name', 'Test'], repo);
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
  runGit(['add', '.'], repo);
  runGit(['commit', '-m', 'init'], repo);
  try {
    autoland.writePolicy(repo, { enabled: true, enabled_by: 'keshav', accept_all: true });
    const tick = runCli(['autoland', 'tick', '--json'], repo);
    const receipt = JSON.parse(tick.stdout.trim().split('\n').pop());
    assert.match(String(receipt.reap_error), /master|main/);
    const state = JSON.parse(fs.readFileSync(path.join(repo, '.atris', 'state', 'autoland.json'), 'utf8'));
    assert.match(state.last_reap_error.error, /master|main/);
    const status = runCli(['autoland', 'status'], repo);
    assert.match(status.stdout, /cleanup trouble/);
    const digest = runCli(['autoland', 'digest'], repo);
    assert.match(digest.stdout, /cleanup trouble: the daily sweep failed/);
  } finally {
    cleanupTempDir(outer);
  }
});

test('daily tick expires missions parked for a week, keeps fresh and running ones', () => {
  const { base, repo } = makeTempRepo();
  try {
    autoland.writePolicy(repo, { enabled: true, enabled_by: 'keshav', accept_all: true });
    const stateDir = path.join(repo, '.atris', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const missions = [
      // updated_at fresh on purpose: machine re-saves bump it daily, so
      // expiry must key off last_tick_at/created_at, never updated_at.
      { schema: 'atris.mission.v1', id: 'mission-old-paused', owner: 'neo', objective: 'ancient smoke test', status: 'paused', created_at: old, last_tick_at: old, updated_at: new Date().toISOString() },
      { schema: 'atris.mission.v1', id: 'mission-old-running', owner: 'neo', objective: 'long haul, still ticking', status: 'running', created_at: old, updated_at: old },
      { schema: 'atris.mission.v1', id: 'mission-fresh-paused', owner: 'neo', objective: 'paused yesterday', status: 'paused', created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
    ];
    fs.writeFileSync(path.join(stateDir, 'missions.jsonl'), missions.map((m) => JSON.stringify(m)).join('\n') + '\n');
    const tick = runCli(['autoland', 'tick', '--json'], repo);
    const receipt = JSON.parse(tick.stdout.trim().split('\n').pop());
    assert.equal(receipt.mission_expiry_error, undefined);
    // the hourly janitor (48h paused leash) reaches the old paused mission
    // before the daily 7-day expiry does
    assert.equal(receipt.missions_stopped, 1);
    const { loadMissionMap } = require('../commands/mission');
    const map = loadMissionMap(repo);
    assert.equal(map.get('mission-old-paused').status, 'stopped');
    assert.match(map.get('mission-old-paused').stop_reason, /expired after 48\+ idle hours/);
    assert.match(map.get('mission-old-paused').stop_reason, /revive with: atris mission tick/);
    assert.equal(map.get('mission-old-running').status, 'running');
    assert.equal(map.get('mission-fresh-paused').status, 'paused');
  } finally {
    cleanupTempDir(base);
  }
});

// CLI-810: the janitor folds `mission stop` (paused > 48h) and
// `worktree cleanup --apply` (merged into base) into every hourly tick,
// with counts on the tick line and an off switch in the policy json.
test('janitor: a zombie paused mission and a merged worktree disappear on the next tick', () => {
  const { base, repo } = makeTempRepo();
  try {
    autoland.writePolicy(repo, { enabled: true, enabled_by: 'keshav', accept_all: true });
    const stateDir = path.join(repo, '.atris', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const missions = [
      { schema: 'atris.mission.v1', id: 'mission-zombie', owner: 'neo', objective: 'left paused', status: 'paused', created_at: threeDaysAgo, last_tick_at: threeDaysAgo, updated_at: new Date().toISOString() },
      { schema: 'atris.mission.v1', id: 'mission-alive', owner: 'neo', objective: 'still running', status: 'running', created_at: threeDaysAgo, updated_at: threeDaysAgo },
    ];
    fs.writeFileSync(path.join(stateDir, 'missions.jsonl'), missions.map((m) => JSON.stringify(m)).join('\n') + '\n');
    // a clean worktree whose head is already merged into base
    const wtPath = path.join(base, 'merged-wt');
    runGit(['worktree', 'add', '-b', 'task/merged-fixture', wtPath], repo);
    const tick = runCli(['autoland', 'tick', '--json'], repo);
    assert.equal(tick.status, 0, tick.stderr || tick.stdout);
    const receipt = JSON.parse(tick.stdout.trim().split('\n').pop());
    assert.equal(receipt.janitor_mission_error, undefined);
    assert.equal(receipt.janitor_worktree_error, undefined);
    assert.equal(receipt.missions_stopped, 1);
    assert.deepEqual(receipt.missions_stopped_refs, ['mission-zombie']);
    assert.equal(receipt.worktrees_reaped, 1);
    const { loadMissionMap } = require('../commands/mission');
    const map = loadMissionMap(repo);
    assert.equal(map.get('mission-zombie').status, 'stopped');
    assert.match(map.get('mission-zombie').stop_reason, /expired after 48\+ idle hours \(was paused\)/);
    assert.equal(map.get('mission-alive').status, 'running');
    assert.equal(fs.existsSync(wtPath), false, 'merged worktree should be removed');
    // counts accumulate for the daily digest
    const state = autoland.readState(repo);
    assert.equal(state.janitor.missions_stopped, 1);
    assert.equal(state.janitor.worktrees_reaped, 1);
    // human tick line carries both counts
    const plain = runCli(['autoland', 'tick'], repo);
    assert.match(plain.stdout, /janitor stopped \d+ missions? \+ reaped \d+ worktrees?/);
  } finally {
    cleanupTempDir(base);
  }
});

test('janitor: policy janitor:false leaves the zombie mission and merged worktree alone', () => {
  const { base, repo } = makeTempRepo();
  try {
    autoland.writePolicy(repo, { enabled: true, enabled_by: 'keshav', accept_all: true, janitor: false });
    const stateDir = path.join(repo, '.atris', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(path.join(stateDir, 'missions.jsonl'), JSON.stringify(
      { schema: 'atris.mission.v1', id: 'mission-zombie', owner: 'neo', objective: 'left paused', status: 'paused', created_at: threeDaysAgo, last_tick_at: threeDaysAgo, updated_at: threeDaysAgo }
    ) + '\n');
    const wtPath = path.join(base, 'merged-wt');
    runGit(['worktree', 'add', '-b', 'task/merged-fixture', wtPath], repo);
    // pin today's daily land-reap as already done, so only the janitor is under test
    autoland.writeState(repo, { alerts: {}, last_reap_date: new Date().toISOString().slice(0, 10) });
    const tick = runCli(['autoland', 'tick', '--json'], repo);
    assert.equal(tick.status, 0, tick.stderr || tick.stdout);
    const receipt = JSON.parse(tick.stdout.trim().split('\n').pop());
    assert.equal(receipt.missions_stopped, 0);
    assert.equal(receipt.worktrees_reaped, 0);
    const { loadMissionMap } = require('../commands/mission');
    assert.equal(loadMissionMap(repo).get('mission-zombie').status, 'paused');
    assert.equal(fs.existsSync(wtPath), true, 'worktree must survive with janitor off');
  } finally {
    cleanupTempDir(base);
  }
});

test('digest carries the janitor tally in plain language, silent when it did nothing', () => {
  const baseArgs = {
    accepted: { auto: [], human: [] },
    waiting: [],
    landed: null,
    project: 'demo',
  };
  const withTally = autoland.composeDigest({ ...baseArgs, janitor: { missions_stopped: 2, worktrees_reaped: 1 } });
  assert.match(withTally, /tidied up: 2 stale missions stopped, 1 merged worktree cleared/);
  const without = autoland.composeDigest({ ...baseArgs, janitor: null });
  assert.doesNotMatch(without, /tidied up/);
});

test('daily tick verifies planning missions after all linked repair tasks close', () => {
  const { base, repo } = makeTempRepo();
  try {
    const missionId = 'mission-closed-task-planning';
    fs.writeFileSync(path.join(repo, 'proof.txt'), 'verifier can pass\n', 'utf8');
    const add = runCli([
      'task',
      'add',
      'Repair the golden path blocker',
      '--tag',
      'golden-path',
      '--goal-id',
      missionId,
      '--json',
    ], repo);
    assert.equal(add.status, 0, add.stderr || add.stdout);
    const ref = JSON.parse(add.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', ref, '--as', 'builder'], repo).status, 0);
    assert.equal(runCli([
      'task',
      'ready',
      ref,
      '--proof',
      'Command passed: git diff --check. Evidence inspected: repair task can close before the mission verifier re-runs.',
      '--as',
      'builder',
      '--json',
    ], repo).status, 0);

    const stateDir = path.join(repo, '.atris', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'missions.jsonl'), `${JSON.stringify({
      schema: 'atris.mission.v1',
      id: missionId,
      owner: 'onboarding',
      objective: 'Golden path closure smoke',
      status: 'planning',
      runner: 'manual',
      cadence: 'manual',
      verifier: 'test -f proof.txt',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })}\n`);

    autoland.writePolicy(repo, { enabled: true, enabled_by: 'keshav', accept_all: true });
    const tick = runCli(['autoland', 'tick', '--json'], repo);
    assert.equal(tick.status, 0, tick.stderr || tick.stdout);
    const receipt = JSON.parse(tick.stdout.trim().split('\n').pop());
    assert.deepEqual(receipt.verified_missions.map((mission) => mission.id), [missionId]);
    assert.equal(receipt.verified_missions[0].result, 'passed');
    assert.equal(receipt.mission_verify_errors, undefined, JSON.stringify(receipt.mission_verify_errors));

    const projection = JSON.parse(fs.readFileSync(path.join(repo, '.atris', 'state', 'tasks.projection.json'), 'utf8'));
    const repairTask = projection.tasks.find((task) => task.display_id === ref);
    assert.equal(repairTask.status, 'done');
    const { loadMissionMap } = require('../commands/mission');
    const mission = loadMissionMap(repo).get(missionId);
    assert.equal(mission.status, 'ready');
    assert.equal(mission.verifier_result.passed, true);
  } finally {
    cleanupTempDir(base);
  }
});
