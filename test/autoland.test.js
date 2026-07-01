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
        { ref: 'CLI-1', title: 'Mission XP: Fix mission budget inference', happened: 'Fixed full-duration mission budget inference.' },
        { ref: 'CLI-2', title: 'Add hourly member loop' },
        { ref: 'CLI-4', title: 'Mission XP: Decide and start the next useful mission after: x', happened: 'Stopped with reason: no concrete follow-up mission found.' },
        { ref: 'CLI-5', title: 'Mission XP: Decide and start the next useful mission after: y', happened: 'The continuation did not start fake work.' },
      ],
      human: [{ ref: 'CLI-3', title: 'Ship release' }],
    },
    waiting: [{ ref: 'CLI-9', title: 'Send invoice', tag: 'billing', hours: 30 }],
    landed: { branches: 2, due: 1 },
    project: 'atris-cli',
  });
  assert.match(digest, /got their final sign-off on their own/);
  assert.match(digest, /- fixed full-duration mission budget inference/);
  assert.match(digest, /- add hourly member loop/);
  assert.match(digest, /- 2 checks that the loop stops cleanly instead of inventing work/);
  assert.match(digest, /you approved 1 piece yourself/);
  assert.match(digest, /waiting on you: 1 \(oldest 30h\)/);
  assert.match(digest, /2 pieces of work still in the air, 1 overdue/);
  assert.match(digest, /the full story: atris autoland digest/);
  assert.doesNotMatch(digest, /branch|worktree|ttl|certif/i);

  const alarm = autoland.composeAlarm({
    waiting: [{ ref: 'CLI-9', title: 'Send invoice', hours: 30 }],
    project: 'atris-cli',
    alarmHours: 24,
  });
  assert.match(alarm, /1 piece of finished work has been waiting on you for over 24h/);
  assert.match(alarm, /CLI-9 \(30h\)/);
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
