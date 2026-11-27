'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');
const { hasNodeSqlite } = require('./helpers/node-sqlite');
const taskDb = require('../lib/task-db');
const picker = require('../lib/member-task-pick');
const switches = require('../lib/member-switches');
const missionCore = require('../lib/mission-core');
require('../commands/task');
const { createTaskApiServer } = require('../commands/task/api/api');

const cliPath = path.join(__dirname, '..', 'bin', 'atris.js');

function makeTempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runCli(dir, args, env = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...scrubAgentEnv(),
      ATRIS_SKIP_UPDATE_CHECK: '1',
      NODE_NO_WARNINGS: '1',
      ...env,
    },
  });
  if (result.error) throw result.error;
  return result;
}

function writeMember(root, name, role = 'Builder', extraFrontmatter = '') {
  const dir = path.join(root, 'atris', 'team', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'MEMBER.md'), [
    '---',
    `name: ${name}`,
    `role: ${role}`,
    ...(extraFrontmatter ? [extraFrontmatter] : []),
    '---',
    '',
    `# ${name}`,
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(dir, 'MISSION.md'), [
    '# Mission',
    '',
    '## North Star',
    '',
    `Ship clean bounded changes for ${name}.`,
    '',
  ].join('\n'), 'utf8');
  return dir;
}

function runGit(dir, args) {
  const res = spawnSync('git', args, { cwd: dir, encoding: 'utf8', timeout: 15000 });
  assert.equal(res.status, 0, `git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout.trim();
}

// --- Bug 2 (CLI-1522): Unapproved plan must not be picked, claimed, or approved by background agents ---

test('heldForPerson and pickTaskForMember skip open tasks in plan stage awaiting approval', (t) => {
  const dir = makeTempDir(t, 'atris-bug2-pick-');
  const planned = {
    id: 'task-plan-1',
    title: 'Wire retry backoff',
    status: 'open',
    metadata: { stage: 'plan', verify: 'node --test test/retry.test.js' },
  };
  const openPlain = {
    id: 'task-open-2',
    title: 'Fix typo in help text',
    status: 'open',
    metadata: { verify: 'node --test test/help.test.js' },
  };

  assert.equal(picker.isPlanAwaitingApproval(planned), true);
  assert.equal(picker.isPlanAwaitingApproval(openPlain), false);
  assert.equal(picker.heldForPerson(planned), 'plan_awaiting_approval');
  assert.equal(picker.skipReason(planned, 'build', { member: 'executor' }), 'plan_awaiting_approval');

  if (!hasNodeSqlite()) return;
  taskDb.close();
  const db = taskDb.open(path.join(dir, 'tasks.db'));
  try {
    const ws = taskDb.workspaceRoot(dir);
    taskDb.addTask(db, {
      title: 'Planned task waiting on owner yes',
      workspaceRoot: ws,
      metadata: { stage: 'plan', verify: 'node --test test/plan.test.js', assigned_to: 'executor' },
    });
    const plain = taskDb.addTask(db, {
      title: 'Approved regular open task',
      workspaceRoot: ws,
      metadata: { verify: 'node --test test/open.test.js' },
    });
    const picked = picker.pickTaskForMember(taskDb, db, { workspaceRoot: ws, member: 'executor', job: 'build', requireCheck: true });
    assert.equal(picked.id, plain.id, 'picker must skip unapproved plan even when assigned to executor');
  } finally {
    taskDb.close();
  }
});

test('member wake skips unapproved planned tasks, and agent mode refuses task do and task claim on unapproved plans', { skip: !hasNodeSqlite() }, (t) => {
  const dir = makeTempDir(t, 'atris-bug2-cli-');
  const dbPath = path.join(dir, 'tasks.db');
  const baseEnv = { ATRIS_TASKS_DB: dbPath };
  const execDir = writeMember(dir, 'executor');
  fs.writeFileSync(path.join(execDir, 'goals.json'), JSON.stringify({
    schema: 'atris.member_goals.v1',
    member: 'executor',
    updated_at: '2026-11-26T00:00:00.000Z',
    goals: [{
      id: 'goal-2026-11-26-exec',
      title: 'Ship clean bounded changes',
      status: 'active',
      cadence: 'manual',
      source: 'mission',
      created_at: '2026-11-26T00:00:00.000Z',
      experiments: [],
      history: [],
    }],
  }, null, 2), 'utf8');

  const added = runCli(dir, ['task', 'add', 'Refactor billing cache', '--to', 'executor', '--json'], baseEnv);
  assert.equal(added.status, 0, added.stderr || added.stdout);
  const ref = JSON.parse(added.stdout).task.display_id;

  const planned = runCli(dir, [
    'task', 'plan', ref,
    '--as', 'executor',
    '--owner', 'executor',
    '--goal', 'Speed up cache lookup',
    '--exit', 'cache tests pass',
    '--proof-needed', 'node --test test/cache.test.js',
    '--first-move', 'add cache key helper',
    '--json',
  ], baseEnv);
  assert.equal(planned.status, 0, planned.stderr || planned.stdout);
  assert.equal(JSON.parse(planned.stdout).task.metadata.stage, 'plan');

  // member wake must NOT suggest claiming an unapproved plan
  const wake = runCli(dir, ['member', 'wake', 'executor', '--plan', '--json'], baseEnv);
  assert.equal(wake.status, 0, wake.stderr || wake.stdout);
  const wakeJson = JSON.parse(wake.stdout);
  assert.doesNotMatch(String(wakeJson.next_command || ''), new RegExp(`atris task claim ${ref}`),
    `wake must not hand out claim for unapproved plan: ${wake.stdout}`);

  // Agent proof-only mode cannot approve a plan via `atris task do`
  const agentDo = runCli(dir, [
    'task', 'do', ref,
    '--as', 'executor',
    '--first-move', 'start anyway',
    '--json',
  ], { ...baseEnv, ATRIS_AGENT_PROOF_ONLY: '1' });
  assert.equal(agentDo.status, 2, agentDo.stderr || agentDo.stdout);
  assert.match(`${agentDo.stdout}\n${agentDo.stderr}`, /only a person can approve a plan/i);

  // Agent proof-only mode cannot claim an unapproved plan via `atris task claim`
  const agentClaim = runCli(dir, [
    'task', 'claim', ref,
    '--as', 'executor',
    '--json',
  ], { ...baseEnv, ATRIS_AGENT_PROOF_ONLY: '1' });
  assert.equal(agentClaim.status, 2, agentClaim.stderr || agentClaim.stdout);
  assert.match(`${agentClaim.stdout}\n${agentClaim.stderr}`, /plan is waiting on a person to approve before claiming/i);

  // A person (interactive mode) can still approve the plan via `atris task do`
  const humanDo = runCli(dir, [
    'task', 'do', ref,
    '--as', 'executor',
    '--first-move', 'approved by owner',
    '--json',
  ], baseEnv);
  assert.equal(humanDo.status, 0, humanDo.stderr || humanDo.stdout);
  assert.equal(JSON.parse(humanDo.stdout).task.metadata.stage, 'do');
});

// --- Bug 3: Autonomous agents cannot bypass mission verifier or completion gates ---

test('mission set-verifier blocks agent mode, empty verifier, and lint-failing verifier; mission complete --force blocks agent mode', (t) => {
  const dir = makeTempDir(t, 'atris-bug3-mission-gates-');
  const stateDir = path.join(dir, '.atris', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const mission = {
    schema: 'atris.mission.v1',
    id: 'mission-2026-11-26-gate-guard',
    owner: 'executor',
    objective: 'Ship hardened mission gates',
    status: 'running',
    verifier: 'node --test test/real.test.js',
    created_at: '2026-11-26T00:00:00.000Z',
    updated_at: '2026-11-26T00:00:00.000Z',
  };
  fs.writeFileSync(path.join(stateDir, 'missions.jsonl'), `${JSON.stringify(mission)}\n`, 'utf8');

  // 1. Agent mode cannot run mission set-verifier
  const agentSet = runCli(dir, [
    'mission', 'set-verifier', mission.id, 'node --test test/other.test.js', '--json',
  ], { ATRIS_AGENT_PROOF_ONLY: '1' });
  assert.equal(agentSet.status, 2, agentSet.stderr || agentSet.stdout);
  assert.match(`${agentSet.stdout}\n${agentSet.stderr}`, /only a person can change a mission verifier/i);

  // 2. Empty verifier string is rejected even for a person
  const emptySet = runCli(dir, [
    'mission', 'set-verifier', mission.id, '', '--json',
  ]);
  assert.equal(emptySet.status, 2, emptySet.stderr || emptySet.stdout);
  assert.match(`${emptySet.stdout}\n${emptySet.stderr}`, /verifier command cannot be empty/i);

  // 3. Expanded static numeric verifier is rejected by lintMissionVerifier
  const lintSet = runCli(dir, [
    'mission', 'set-verifier', mission.id, 'test 476 -ge 478', '--json',
  ]);
  assert.equal(lintSet.status, 2, lintSet.stderr || lintSet.stdout);
  assert.match(`${lintSet.stdout}\n${lintSet.stderr}`, /shell substitution expanded/i);

  // 4. Trivial no-op verifier is rejected
  const noopSet = runCli(dir, [
    'mission', 'set-verifier', mission.id, 'true', '--json',
  ]);
  assert.equal(noopSet.status, 2, noopSet.stderr || noopSet.stdout);

  // 5. Agent mode cannot bypass mission complete gates with --force
  const agentForceComplete = runCli(dir, [
    'mission', 'complete', mission.id, '--proof', 'self-forced bypass', '--force', '--json',
  ], { ATRIS_AGENT_PROOF_ONLY: '1' });
  assert.equal(agentForceComplete.status, 2, agentForceComplete.stderr || agentForceComplete.stdout);
  assert.match(`${agentForceComplete.stdout}\n${agentForceComplete.stderr}`, /only a person can override completion gates with --force/i);

  // Verify the mission was NOT altered or completed
  const saved = fs.readFileSync(path.join(stateDir, 'missions.jsonl'), 'utf8')
    .trim().split(/\r?\n/).map((l) => JSON.parse(l)).at(-1);
  assert.equal(saved.verifier, 'node --test test/real.test.js');
  assert.equal(saved.status, 'running');
});

// --- Bug 4: `atris member sleep` flips switches, pauses worktree missions, signals live drivers, and rests member up ---

test('member sleep flips member-switches, pauses worktree missions, terminates live driver PIDs, and rests member up', async (t) => {
  const base = makeTempDir(t, 'atris-bug4-sleep-');
  const root = path.join(base, 'repo');
  const worktree = path.join(base, 'wt-executor');
  fs.mkdirSync(root, { recursive: true });

  runGit(root, ['init', '-q', '-b', 'master']);
  runGit(root, ['config', 'user.email', 'test@example.com']);
  runGit(root, ['config', 'user.name', 'Test User']);
  writeMember(root, 'executor', 'Builder');
  writeMember(root, 'navigator', 'Navigator');
  writeMember(root, 'keshav', 'Founder', 'type: human');
  fs.writeFileSync(path.join(root, 'README.md'), '# fixture\n', 'utf8');
  runGit(root, ['add', '.']);
  runGit(root, ['commit', '-qm', 'init']);
  runGit(root, ['worktree', 'add', '-q', '-b', 'wt/executor', worktree]);

  // Spawn a real dummy sleep child process with an Atris driver marker in argv so
  // the real `ps` command-line verification works end-to-end with zero mocks.
  const dummyDriver = spawn(
    process.execPath,
    ['-e', 'setInterval(() => {}, 60000)', '--', 'atris-mission-driver'],
    { stdio: 'ignore' },
  );
  t.after(() => {
    try { dummyDriver.kill('SIGKILL'); } catch {}
  });

  // Record an active mission inside the worktree's own missions.jsonl AND the
  // real driver state path (`mission-driver-${shortId}.json`) WITHOUT setting
  // `driver_pid` on the mission row so `missionDriverHealth` is genuinely exercised.
  const wtStateDir = path.join(worktree, '.atris', 'state');
  fs.mkdirSync(wtStateDir, { recursive: true });
  const wtMissionId = 'mission-2026-11-26-wt-live';
  const shortId = wtMissionId.slice(-8).replace(/[^a-zA-Z0-9_-]/g, '');
  fs.writeFileSync(path.join(wtStateDir, 'missions.jsonl'), `${JSON.stringify({
    schema: 'atris.mission.v1',
    id: wtMissionId,
    owner: 'executor',
    objective: 'Worktree task in flight',
    status: 'running',
    runner: 'codex',
    created_at: '2026-11-26T00:00:00.000Z',
    updated_at: '2026-11-26T00:00:00.000Z',
  })}\n`, 'utf8');
  fs.writeFileSync(path.join(wtStateDir, `mission-driver-${shortId}.json`), JSON.stringify({
    mission_id: wtMissionId,
    pid: dummyDriver.pid,
    started_at: '2026-11-26T00:00:00.000Z',
  }), 'utf8');

  const exitPromise = new Promise((resolve) => {
    dummyDriver.once('exit', (code, signal) => resolve({ code, signal }));
  });

  // Sleep executor specifically
  const sleepExec = runCli(root, ['member', 'sleep', 'executor', '--json']);
  assert.equal(sleepExec.status, 0, sleepExec.stderr || sleepExec.stdout);
  const sleepPayload = JSON.parse(sleepExec.stdout);
  assert.equal(sleepPayload.ok, true);
  assert.equal(sleepPayload.slept_count, 1);
  assert.equal(sleepPayload.slept[0].mission_id, wtMissionId);

  // 1. Live driver received SIGTERM
  const driverExit = await Promise.race([
    exitPromise,
    new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 3000)),
  ]);
  assert.equal(driverExit.timeout, undefined, 'live detached driver should exit after SIGTERM');

  // 2. member-switches.json now records executor as asleep, while navigator stays awake
  assert.equal(switches.isMemberAwake('executor', root), false);
  assert.equal(switches.isMemberAwake('navigator', root), true);

  // 3. Worktree missions.jsonl now records the mission as paused
  const wtRows = fs.readFileSync(path.join(wtStateDir, 'missions.jsonl'), 'utf8')
    .trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.equal(wtRows.at(-1).status, 'paused');
  assert.equal(wtRows.at(-1).stop_reason, 'member-sleep');

  // 4. member wake honors the sleep switch
  const wakeExec = runCli(root, ['member', 'wake', 'executor', '--plan', '--json']);
  assert.equal(wakeExec.status, 0, wakeExec.stderr || wakeExec.stdout);
  assert.equal(JSON.parse(wakeExec.stdout).reason, 'asleep');

  // 5. member up --dry-run honors the sleep switch and does NOT start executor
  if (hasNodeSqlite()) {
    const dbPath = path.join(base, 'tasks.db');
    const added = runCli(root, [
      'task', 'add', 'Ship urgent executor fix', '--to', 'executor',
      '--verify', 'node --test test/example.test.js', '--json',
    ], { ATRIS_TASKS_DB: dbPath });
    assert.equal(added.status, 0, added.stderr || added.stdout);
    const upDry = runCli(root, ['member', 'up', '--dry-run'], { ATRIS_TASKS_DB: dbPath });
    assert.equal(upDry.status, 0, upDry.stderr || upDry.stdout);
    assert.doesNotMatch(upDry.stdout, /would start executor/i, 'sleeping member must not be started by member up');
  }

  // 6. Sleeping all flips all non-human members asleep and leaves human members untouched
  const sleepAll = runCli(root, ['member', 'sleep', '--all', '--json']);
  assert.equal(sleepAll.status, 0, sleepAll.stderr || sleepAll.stdout);
  assert.equal(switches.isMemberAwake('navigator', root), false);
  const rawSwitches = switches.loadMemberSwitches(root);
  assert.equal(rawSwitches.members.keshav, undefined, 'human member should not be written into sleep switches');
});

// --- Audit Fixes 1-4 Regression Tests ---

test('isPlanAwaitingApproval covers open and review plans until plan_approved_at, and allowPlanned opts in cleanly', () => {
  const openPlan = { id: 'p1', title: 'Plan task', status: 'open', metadata: { stage: 'plan' } };
  const reviewPlan = { id: 'p2', title: 'Review plan', status: 'review', metadata: { stage: 'plan' } };
  const approvedPlan = {
    id: 'p3',
    title: 'Approved plan',
    status: 'open',
    metadata: { stage: 'plan', plan_approved_at: '2026-11-26T00:00:00.000Z' },
  };
  assert.equal(picker.isPlanAwaitingApproval(openPlan), true);
  assert.equal(picker.isPlanAwaitingApproval(reviewPlan), true);
  assert.equal(picker.isPlanAwaitingApproval(approvedPlan), false);

  assert.equal(picker.heldForPerson(openPlan), 'plan_awaiting_approval');
  assert.equal(picker.heldForPerson(openPlan, { allowPlanned: true }), '');
  assert.equal(picker.skipReason(openPlan, 'build', { member: 'executor' }), 'plan_awaiting_approval');
  assert.equal(picker.skipReason(openPlan, 'build', { member: 'executor', allowPlanned: true }), '');
});

test('all 5 unapproved-plan CLI bypasses and ATRIS_AGENT_PROOF_ONLY=0 bypass are closed in worker sessions', { skip: !hasNodeSqlite() }, (t) => {
  const dir = makeTempDir(t, 'atris-audit-plan-bypasses-');
  fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'atris', 'atris.md'), '# protocol\n', 'utf8');
  const dbPath = path.join(dir, 'tasks.db');
  const baseEnv = { ATRIS_TASKS_DB: dbPath };
  const workerWithOverrideZero = {
    ...baseEnv,
    CODEX_SANDBOX: '1',
    ATRIS_AGENT_PROOF_ONLY: '0',
  };

  const added = runCli(dir, ['task', 'add', 'Ship plan-gated change', '--to', 'executor', '--json'], baseEnv);
  assert.equal(added.status, 0, added.stderr || added.stdout);
  const ref = JSON.parse(added.stdout).task.display_id;

  const planned = runCli(dir, [
    'task', 'plan', ref,
    '--as', 'executor',
    '--owner', 'executor',
    '--goal', 'Keep plan gated',
    '--exit', 'gate holds',
    '--proof-needed', 'node --test test/gate.test.js',
    '--first-move', 'wire gate',
    '--json',
  ], baseEnv);
  assert.equal(planned.status, 0, planned.stderr || planned.stdout);

  // 1. task do blocked even when ATRIS_AGENT_PROOF_ONLY=0 inside a worker session
  const doRes = runCli(dir, ['task', 'do', ref, '--as', 'executor', '--first-move', 'bypass', '--json'], workerWithOverrideZero);
  assert.equal(doRes.status, 2, doRes.stderr || doRes.stdout);
  assert.match(`${doRes.stdout}\n${doRes.stderr}`, /only a person can approve a plan/i);

  // 2. task claim blocked even with ATRIS_AGENT_PROOF_ONLY=0 inside a worker session
  const claimRes = runCli(dir, ['task', 'claim', ref, '--as', 'executor', '--json'], workerWithOverrideZero);
  assert.equal(claimRes.status, 2, claimRes.stderr || claimRes.stdout);
  assert.match(`${claimRes.stdout}\n${claimRes.stderr}`, /plan is waiting on a person to approve before claiming/i);

  // 3. task backlog blocked on unapproved plan in worker session
  const backlogRes = runCli(dir, ['task', 'backlog', ref, '--json'], workerWithOverrideZero);
  assert.equal(backlogRes.status, 2, backlogRes.stderr || backlogRes.stdout);
  assert.match(`${backlogRes.stdout}\n${backlogRes.stderr}`, /only a person can backlog or clear a plan waiting on approval/i);

  // 4. task clear-plan blocked in worker session
  const clearPlanRes = runCli(dir, ['task', 'clear-plan', '--yes', '--json'], workerWithOverrideZero);
  assert.equal(clearPlanRes.status, 2, clearPlanRes.stderr || clearPlanRes.stdout);
  assert.match(`${clearPlanRes.stdout}\n${clearPlanRes.stderr}`, /only a person can clear plans waiting on approval/i);

  // 5. task step advancing plan -> do blocked in worker session
  const stepRes = runCli(dir, ['task', 'step', ref, '--as', 'executor', '--first-move', 'bypass step', '--json'], workerWithOverrideZero);
  assert.equal(stepRes.status, 2, stepRes.stderr || stepRes.stdout);
  assert.match(`${stepRes.stdout}\n${stepRes.stderr}`, /only a person can approve a plan/i);

  // 6. task next --human --create-next skips unapproved plans and held tasks
  const nextRes = runCli(dir, ['task', 'next', '--human', '--create-next', '--as', 'executor', '--json'], workerWithOverrideZero);
  assert.equal(nextRes.status, 0, nextRes.stderr || nextRes.stdout);
  const nextPayload = JSON.parse(nextRes.stdout);
  assert.equal(nextPayload.action, 'none', `expected --create-next to skip unapproved plan, got: ${nextRes.stdout}`);
  assert.equal(nextPayload.task_id, null);

  // Confirm the task is still open in plan stage
  const shown = JSON.parse(runCli(dir, ['task', 'show', ref, '--json'], baseEnv).stdout);
  assert.equal(shown.status, 'open');
  assert.equal(shown.metadata.stage, 'plan');
});

test('task HTTP API blocks do, claim, backlog, ready, step, and clear-plan on unapproved plans in worker sessions', { skip: !hasNodeSqlite() }, async (t) => {
  const dir = makeTempDir(t, 'atris-audit-api-bypasses-');
  const dbPath = path.join(dir, 'tasks.db');
  taskDb.close();
  const db = taskDb.open(dbPath);
  const ws = taskDb.workspaceRoot(dir);
  const added = taskDb.addTask(db, {
    title: 'API plan-gated task',
    workspaceRoot: ws,
    metadata: {
      stage: 'plan',
      task_goal: 'Keep API plan gated',
      exit_condition: 'API returns 403',
      first_move: 'check worker marker',
      verify: 'node --test test/api.test.js',
    },
  });

  const server = createTaskApiServer({ taskDb, db });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    taskDb.close();
  });

  const post = (urlPath, body) => new Promise((resolve, reject) => {
    const raw = JSON.stringify(body || {});
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method: 'POST',
      headers: {
        host: `127.0.0.1:${port}`,
        'x-atris-token': server.taskToken,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(raw),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data || '{}') }));
    });
    req.on('error', reject);
    req.write(raw);
    req.end();
  });

  const prevSandbox = process.env.CODEX_SANDBOX;
  const prevProofOnly = process.env.ATRIS_AGENT_PROOF_ONLY;
  process.env.CODEX_SANDBOX = '1';
  process.env.ATRIS_AGENT_PROOF_ONLY = '0';
  try {
    const encoded = encodeURIComponent(added.id);
    for (const [label, urlPath, payload] of [
      ['do', `/api/tasks/${encoded}/do`, { actor: 'executor', first_move: 'bypass' }],
      ['claim', `/api/tasks/${encoded}/claim`, { actor: 'executor' }],
      ['backlog', `/api/tasks/${encoded}/backlog`, { actor: 'executor' }],
      ['ready', `/api/tasks/${encoded}/ready`, { actor: 'executor', proof: 'Receipt saved at atris/runs/p.json' }],
      ['step', `/api/tasks/${encoded}/step`, { actor: 'executor', first_move: 'bypass' }],
      ['clear-plan', '/api/tasks/clear-plan', { confirm: true, actor: 'executor' }],
    ]) {
      const res = await post(urlPath, payload);
      assert.equal(res.status, 403, `${label}: expected 403, got ${res.status} (${JSON.stringify(res.body)})`);
      assert.equal(res.body.ok, false);
    }
  } finally {
    if (prevSandbox === undefined) delete process.env.CODEX_SANDBOX;
    else process.env.CODEX_SANDBOX = prevSandbox;
    if (prevProofOnly === undefined) delete process.env.ATRIS_AGENT_PROOF_ONLY;
    else process.env.ATRIS_AGENT_PROOF_ONLY = prevProofOnly;
  }
});

test('mission tick --verify override, ATRIS_AGENT_PROOF_ONLY=0 bypass, and trivial no-op verifiers are rejected', (t) => {
  const dir = makeTempDir(t, 'atris-audit-mission-noop-');
  const stateDir = path.join(dir, '.atris', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const mission = {
    schema: 'atris.mission.v1',
    id: 'mission-2026-11-26-freeze-guard',
    owner: 'executor',
    objective: 'Protect frozen verifier during tick',
    status: 'running',
    verifier: 'node --test test/real.test.js',
    created_at: '2026-11-26T00:00:00.000Z',
    updated_at: '2026-11-26T00:00:00.000Z',
  };
  fs.writeFileSync(path.join(stateDir, 'missions.jsonl'), `${JSON.stringify(mission)}\n`, 'utf8');

  const workerWithOverrideZero = {
    CODEX_SANDBOX: '1',
    ATRIS_AGENT_PROOF_ONLY: '0',
  };

  // Worker with ATRIS_AGENT_PROOF_ONLY=0 still cannot change verifier, force complete, or override during tick
  const setBlocked = runCli(dir, ['mission', 'set-verifier', mission.id, 'node --test test/other.test.js', '--json'], workerWithOverrideZero);
  assert.equal(setBlocked.status, 2, setBlocked.stderr || setBlocked.stdout);

  const forceBlocked = runCli(dir, ['mission', 'complete', mission.id, '--proof', 'bypass', '--force', '--json'], workerWithOverrideZero);
  assert.equal(forceBlocked.status, 2, forceBlocked.stderr || forceBlocked.stdout);

  const tickOverrideBlocked = runCli(dir, [
    'mission', 'tick', mission.id, '--verify', 'node --test test/other.test.js', '--json',
  ], workerWithOverrideZero);
  assert.equal(tickOverrideBlocked.status, 2, tickOverrideBlocked.stderr || tickOverrideBlocked.stdout);
  assert.match(`${tickOverrideBlocked.stdout}\n${tickOverrideBlocked.stderr}`, /only a person can override a frozen mission verifier during tick/i);

  const tickTrueBlocked = runCli(dir, [
    'mission', 'tick', mission.id, '--verify', 'true', '--json',
  ], workerWithOverrideZero);
  assert.equal(tickTrueBlocked.status, 2, tickTrueBlocked.stderr || tickTrueBlocked.stdout);

  // Even for a human, trivial no-op verifiers are rejected everywhere (lint, start, set-verifier, tick)
  const trivialNoops = [
    '',
    '   ',
    'true',
    '/bin/true',
    '/usr/bin/true',
    'true # looks legit',
    'true;',
    ':',
    ': ok',
    'exit 0',
    'exit 0 # fine',
    'true && true',
    'true; true',
    'echo ok',
    'printf "ok\\n"',
    'node -e ""',
    "node -e ''",
    'node -e "0"',
    'python -c ""',
    'sh -c ""',
    'sh -c "true"',
  ];
  for (const cmd of trivialNoops) {
    assert.ok(missionCore.lintMissionVerifier(cmd), `expected trivial verifier to fail lint: ${JSON.stringify(cmd)}`);
  }
  for (const legit of [
    'node --test test/real.test.js',
    'git diff --check',
    'echo hi | grep hi',
    'node -e "process.exit(0)"',
    'test $(wc -l < atris/learnings.jsonl) -ge 478',
  ]) {
    assert.equal(missionCore.lintMissionVerifier(legit), null, `expected legitimate verifier to pass lint: ${legit}`);
  }

  // Human CLI checks on start, set-verifier, and tick --verify
  for (const cmd of ['true # ok', 'echo all good', 'node -e ""', 'sh -c "true"']) {
    const startFail = runCli(dir, ['mission', 'start', 'reject noop', '--owner', 'executor', '--verify', cmd, '--json']);
    assert.equal(startFail.status, 2, `mission start should reject ${cmd}: ${startFail.stdout}`);
    const setFail = runCli(dir, ['mission', 'set-verifier', mission.id, cmd, '--json']);
    assert.equal(setFail.status, 2, `mission set-verifier should reject ${cmd}: ${setFail.stdout}`);
    const tickFail = runCli(dir, ['mission', 'tick', mission.id, '--verify', cmd, '--json']);
    assert.equal(tickFail.status, 2, `mission tick should reject ${cmd}: ${tickFail.stdout}`);
  }
});

test('member sleep refuses to kill unrelated PIDs, never recreates deleted worktrees, and member go wakes slept members', (t) => {
  const base = makeTempDir(t, 'atris-audit-sleep-safety-');
  const root = path.join(base, 'repo');
  fs.mkdirSync(root, { recursive: true });
  writeMember(root, 'executor', 'Builder');

  // Spawn an unrelated non-Atris process (`sleep 60`) and plant its PID in a mission driver file
  const unrelated = spawn('sleep', ['60'], { stdio: 'ignore' });
  t.after(() => {
    try { unrelated.kill('SIGKILL'); } catch {}
  });

  const deletedWorktree = path.join(base, 'deleted-worktree');
  const stateDir = path.join(root, '.atris', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const mId = 'mission-2026-11-26-deleted-wt';
  const shortId = mId.slice(-8).replace(/[^a-zA-Z0-9_-]/g, '');
  fs.writeFileSync(path.join(stateDir, 'missions.jsonl'), `${JSON.stringify({
    schema: 'atris.mission.v1',
    id: mId,
    owner: 'executor',
    objective: 'Mission whose worktree was removed',
    status: 'running',
    worktree_root: deletedWorktree,
    driver_pid: unrelated.pid,
    created_at: '2026-11-26T00:00:00.000Z',
    updated_at: '2026-11-26T00:00:00.000Z',
  })}\n`, 'utf8');
  fs.writeFileSync(path.join(stateDir, `mission-driver-${shortId}.json`), JSON.stringify({
    mission_id: mId,
    pid: unrelated.pid,
    started_at: '2026-11-26T00:00:00.000Z',
  }), 'utf8');

  const sleepRes = runCli(root, ['member', 'sleep', 'executor', '--json']);
  assert.equal(sleepRes.status, 0, sleepRes.stderr || sleepRes.stdout);

  // 1. Unrelated `sleep 60` process MUST still be alive
  assert.equal(unrelated.exitCode, null, 'member sleep must NOT kill an unrelated process PID');
  assert.doesNotThrow(() => process.kill(unrelated.pid, 0), 'unrelated PID must still be alive');

  // 2. Deleted worktree directory MUST NOT be recreated as a ghost directory
  assert.equal(fs.existsSync(deletedWorktree), false, 'member sleep must NOT recreate a deleted worktree directory');

  // 3. Mission in root missions.jsonl WAS still paused cleanly
  const rootRows = fs.readFileSync(path.join(stateDir, 'missions.jsonl'), 'utf8')
    .trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.equal(rootRows.at(-1).status, 'paused');
  assert.equal(rootRows.at(-1).stop_reason, 'member-sleep');
  assert.equal(switches.isMemberAwake('executor', root), false);

  // 4. `atris member go executor` wakes an explicitly slept member back to awake: true
  const goRes = runCli(root, [
    'member', 'go', 'executor', 'check wake switch', '--engine', 'manual', '--max-ticks', '1', '--json',
  ], {
    ATRIS_RUNNER_BIN: process.execPath,
    ATRIS_RUNNER_COMMAND_TEMPLATE: `${process.execPath} -e "process.stdout.write('ok\\n')"`,
  });
  assert.equal(switches.isMemberAwake('executor', root), true,
    `atris member go executor must flip awake back to true (status=${goRes.status}, out=${goRes.stdout}, err=${goRes.stderr})`);
});
