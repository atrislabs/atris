const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const {
  tickMadeProgress,
  consecutiveNoProgressTicks,
  consecutiveIdenticalSummaryTicks,
  buildTickPrompt,
  missionJudgmentCard,
  missionShippedCard,
  appendMissionJudgmentCard,
} = require('../commands/mission');

// BCK-1324: a mission run loop that keeps ticking after there is nothing left
// to do burns the whole tick budget on "holding" ticks — live evidence is the
// 2026-07-11 run of mission-2026-07-10-revenue-bounded-customer-mis-e7b93c4d,
// which sat at worktree.new_since_baseline_count=4 for 15 consecutive ticks,
// every one self-reporting status=ran/reason=tick-ok. `atris mission run`
// must now stop itself honestly (status=stopped, receipt written) after two
// consecutive ticks that leave no structural trace, instead of grinding to
// max-ticks or max-wall on manufactured busywork.

function makeRepo() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-idle-stop-'));
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  spawnSync('git', ['init', '-q', '-b', 'master'], { cwd: repo });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repo });
  spawnSync('git', ['config', 'user.name', 'test'], { cwd: repo });
  return { base, repo };
}

function runCli(args, cwd) {
  const env = { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' };
  delete env.ATRIS_RUNNER_PROFILE;
  return spawnSync(process.execPath, [cliPath, ...args], { cwd, encoding: 'utf8', env, timeout: 30000 });
}

function startMission(repo, objective, owner, extraArgs = []) {
  const res = runCli(['mission', 'start', '--no-verify', objective, '--owner', owner, '--json', ...extraArgs], repo);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  return JSON.parse(res.stdout).mission;
}

// ---------------------------------------------------------------------------
// Unit coverage on the structural no-progress signal itself: the worktree
// diff and verifier result are ground truth, not the claude summary text —
// a tick that self-labels "holding tick, no drift" and a tick that never
// says anything about progress must be treated identically if their
// worktree/verifier shape is identical.
// ---------------------------------------------------------------------------

test('tickMadeProgress: no new/cleared dirty files and no verifier pass is not progress', () => {
  const idleTick = {
    status: 'ran',
    reason: 'tick-ok',
    worktree: { available: true, new_dirty_count: 0, cleared_dirty_count: 0 },
  };
  assert.equal(tickMadeProgress(idleTick), false);
});

test('tickMadeProgress: a new dirty file counts as progress even if verifier did not run', () => {
  const tick = {
    status: 'ran',
    reason: 'tick-ok',
    worktree: { available: true, new_dirty_count: 1, cleared_dirty_count: 0 },
  };
  assert.equal(tickMadeProgress(tick), true);
});

test('tickMadeProgress: a cleared dirty file (e.g. a commit landed) counts as progress', () => {
  const tick = {
    status: 'ran',
    reason: 'tick-ok',
    worktree: { available: true, new_dirty_count: 0, cleared_dirty_count: 3 },
  };
  assert.equal(tickMadeProgress(tick), true);
});

test('tickMadeProgress: verifier newly passing counts as progress even with a flat worktree', () => {
  const tick = {
    status: 'ran',
    reason: 'tick-ok',
    verifier_passed: true,
    worktree: { available: true, new_dirty_count: 0, cleared_dirty_count: 0 },
  };
  assert.equal(tickMadeProgress(tick), true);
});

test('tickMadeProgress: an errored or skipped tick is never counted as idle (other breakers own those)', () => {
  assert.equal(tickMadeProgress({ status: 'errored', reason: 'claude-timeout' }), true);
  assert.equal(tickMadeProgress({ status: 'skipped', reason: 'quiet-hours' }), true);
});

test('consecutiveNoProgressTicks: only counts the trailing idle streak, resets on any progressing tick', () => {
  const ticks = [
    { status: 'ran', worktree: { available: true, new_dirty_count: 1, cleared_dirty_count: 0 } }, // progress
    { status: 'ran', worktree: { available: true, new_dirty_count: 0, cleared_dirty_count: 0 } }, // idle 1
    { status: 'ran', worktree: { available: true, new_dirty_count: 1, cleared_dirty_count: 0 } }, // progress -> resets
    { status: 'ran', worktree: { available: true, new_dirty_count: 0, cleared_dirty_count: 0 } }, // idle 1
    { status: 'ran', worktree: { available: true, new_dirty_count: 0, cleared_dirty_count: 0 } }, // idle 2
  ];
  assert.equal(consecutiveNoProgressTicks(ticks), 2);
});

test('consecutiveIdenticalSummaryTicks: only counts matching non-empty summaries at the tail', () => {
  const ticks = [
    { claude: { summary: 'first result' } },
    { drill: { summary: 'same result' } },
    { drill: { summary: 'same result' } },
    { drill: { summary: 'same result' } },
  ];
  assert.equal(consecutiveIdenticalSummaryTicks(ticks), 3);
  assert.equal(consecutiveIdenticalSummaryTicks([{ drill: { summary: '' } }]), 0);
});

test('missionJudgmentCard turns objective and tick context into one plain decision card', () => {
  const mission = {
    id: 'mission-2026-07-19-hold-judgment-a1b2c3d4',
    objective: '**Hold judgment** — for BCK-1324 01ARZ3NDEKTSV4RRFFQ69G5FAV without another heartbeat',
  };
  const ticks = [
    { summary: '**Waiting** for human approval on CLI-245' },
    { summary: 'Still waiting for a decision from `mission-2026-07-19-hidden-deadbeef`' },
  ];
  const card = missionJudgmentCard(mission, ticks, 'atris/runs/mission-stop.json');
  const decisionLines = card.split('\n').slice(0, 4).join('\n');

  assert.match(card, /^## Hold judgment for without another heartbeat/m);
  assert.match(card, /- stuck: The last two attempts still needed a decision or new input/);
  assert.match(card, /- recommend: Talk through the missing decision/);
  assert.match(card, /- reply: go \/ park \/ talk/);
  assert.doesNotMatch(decisionLines, /\*\*|—|BCK-1324|CLI-245|01ARZ3NDEKTSV4RRFFQ69G5FAV|mission-2026/);
  assert.match(card, /<small>mission: mission-2026-07-19-hold-judgment-a1b2c3d4; receipt: atris\/runs\/mission-stop\.json<\/small>$/);
});

test('missionJudgmentCard titles end on a real word, never a dangling function word', () => {
  const danglers = [
    'when I switch a mission\'s runner away from codex, the old codex approval gate lingers',
    'the mission report should never say work is continuing when no worker has checked',
    'refresh the pack credentials so the install can keep going after',
  ];
  for (const objective of danglers) {
    const title = missionJudgmentCard({ objective }, []).split('\n')[0].replace(/^##\s+/, '');
    const lastWord = title.trim().split(/\s+/).pop().toLowerCase();
    const danglers2 = ['from', 'is', 'after', 'away', 'the', 'a', 'an', 'to', 'of', 'and', 'when'];
    assert.ok(
      !danglers2.includes(lastWord),
      `title "${title}" dangles on "${lastWord}"`,
    );
  }
});

test('appendMissionJudgmentCard preserves the existing for-you page and appends one section', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-judgment-card-'));
  try {
    const file = path.join(root, 'atris', 'status', 'for-you.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '# For you\n\n## Earlier decision\n- reply: park', 'utf8');

    appendMissionJudgmentCard({ objective: 'finish the useful change' }, [], root);

    const page = fs.readFileSync(file, 'utf8');
    assert.match(page, /^# For you\n\n## Earlier decision\n- reply: park\n\n## Finish the useful change/m);
    assert.equal((page.match(/^## /gm) || []).length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('buildTickPrompt gives idle workers a proof-backed self-landing backstop ladder', () => {
  const prompt = buildTickPrompt(
    {
      id: 'mission-backstop-ladder',
      objective: 'Keep useful work moving',
      owner: 'alice',
      cadence: 'manual',
      status: 'running',
    },
    1,
    4,
    { lane: 'code', verifier: 'node --test test/mission-idle-stop.test.js' },
  );

  assert.match(prompt, /## No claimable work\? Work the backstop ladder/);
  assert.match(prompt, /Pick the FIRST rung with real fuel and do ONE bounded slice/);
  assert.match(prompt, /1\. A failing or flaky test in this repo: fix it\./);
  assert.match(prompt, /2\. One stale or unproven feature in atris\/features\//);
  assert.match(prompt, /3\. One unblocked item from the atris\/TODO\.md backlog\./);
  assert.match(prompt, /4\. Debloat: remove dead code or docs, with grep proof/);
  assert.match(prompt, /## Proof rule/);
  assert.match(prompt, /Run the actual CLI command or endpoint and paste the command, an output excerpt, and its exit code\./);
  assert.match(prompt, /Self-description such as "it works now" is never proof\./);
  assert.match(prompt, /## Landing rule/);
  assert.match(prompt, /Safe-lane work \(internal code, tests, docs, and proofs\) must be committed and pushed or landed WITHOUT asking a human\./);
  assert.match(prompt, /Protected lanes \(external sends, payments, credentials, auth\/CSP\/iframe\/sandbox surfaces, and deletes of user data\) are never self-landed/);
  assert.match(prompt, /After landing a ladder-sourced slice, append a judge card to atris\/status\/for-you\.md in this SHIPPED format:/);
  assert.ok(prompt.includes(missionShippedCard()));
  assert.doesNotMatch(prompt, /If you can't make progress this tick/);
});

// ---------------------------------------------------------------------------
// End-to-end: drive the real `atris mission run` loop with --no-claude, which
// never touches the worktree, so every tick is structurally idle by
// construction. This is the same shape as the live incident's tail — status
// ran/reason tick-ok, flat worktree, repeated N times.
// ---------------------------------------------------------------------------

test('mission run stops honestly after two idle ticks and writes one judgment card', () => {
  const { base, repo } = makeRepo();
  try {
    const mission = startMission(repo, 'idle stop threshold test', 'alice');
    const res = runCli(
      ['mission', 'run', mission.id, '--no-claude', '--no-verify', '--max-ticks', '10', '--max-idle-ticks', '3', '--json'],
      repo,
    );
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const payload = JSON.parse(res.stdout);

    assert.equal(payload.ok, true);
    assert.equal(payload.pause_reason, 'no-progress');
    assert.equal(payload.mission.status, 'stopped', 'a no-progress stop must be a clean stop, not a resumable pause');
    assert.match(payload.mission.stop_reason, /no-progress/);
    // Stopped after two idle attempts, well short of the 10-tick budget.
    assert.equal(payload.tick_count, 2);
    assert.ok(payload.mission.receipt_path, 'a no-progress stop must still write a receipt like other stop paths');
    assert.ok(fs.existsSync(path.join(repo, payload.mission.receipt_path)), 'the receipt file must actually exist on disk');

    const cardPath = path.join(repo, 'atris', 'status', 'for-you.md');
    assert.ok(fs.existsSync(cardPath), 'the early stop must leave a judgment card for the operator');
    const card = fs.readFileSync(cardPath, 'utf8');
    assert.match(card, /^# For you\n\n## Idle stop threshold test/m);
    assert.match(card, /- stuck: The last two attempts on "idle stop threshold test" produced no change and passed no check/);
    assert.match(card, /- recommend: Park this mission and restart only with new context or one concrete next step\./);
    assert.match(card, /- reply: go \/ park \/ talk/);
    assert.match(card, new RegExp(`mission: ${mission.id}`));
    assert.match(card, new RegExp(`receipt: ${payload.mission.receipt_path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.equal((card.match(/^## /gm) || []).length, 1, 'one early stop must append exactly one judgment card');

    // A self-drive run must treat no-progress as a clean stop, never a
    // dispatchable blocker — handleMissionBlocker must not fire for it.
    assert.equal(payload.blocker, null);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('--max-idle-ticks no longer delays or disables the two-tick stop', () => {
  const { base, repo } = makeRepo();
  try {
    const mission = startMission(repo, 'idle stop disabled test', 'alice');
    const res = runCli(
      ['mission', 'run', mission.id, '--no-claude', '--no-verify', '--max-ticks', '5', '--max-idle-ticks', '0', '--json'],
      repo,
    );
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const payload = JSON.parse(res.stdout);

    assert.equal(payload.ok, true);
    assert.equal(payload.pause_reason, 'no-progress');
    assert.equal(payload.tick_count, 2, 'the hard early stop must ignore the old idle-tick override');
    assert.equal(payload.mission.status, 'stopped');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('--due (self-drive) mode stops on no-progress without filing or dispatching a blocker task', () => {
  const { base, repo } = makeRepo();
  try {
    const mission = startMission(repo, 'idle stop self-drive test', 'alice');
    const res = runCli(
      ['mission', 'run', mission.id, '--no-claude', '--no-verify', '--due', '--max-ticks', '10', '--max-idle-ticks', '2', '--json'],
      repo,
    );
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const payload = JSON.parse(res.stdout);

    assert.equal(payload.pause_reason, 'no-progress');
    assert.equal(payload.mission.status, 'stopped');
    assert.equal(payload.blocker, null, 'no-progress must never route through handleMissionBlocker');

    // No mission-blocker task should have been filed for this mission.
    const tasksList = runCli(['task', 'list', '--json'], repo);
    if (tasksList.status === 0) {
      const tasks = JSON.parse(tasksList.stdout).tasks || [];
      const blockerTasks = tasks.filter((t) => t.metadata?.mission_id === mission.id);
      assert.equal(blockerTasks.length, 0);
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a single idle tick does not stop the mission', () => {
  const { base, repo } = makeRepo();
  try {
    const mission = startMission(repo, 'idle stop reset test', 'alice');
    const res = runCli(
      ['mission', 'run', mission.id, '--no-claude', '--no-verify', '--max-ticks', '1', '--json'],
      repo,
    );
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.tick_count, 1);
    assert.notEqual(payload.pause_reason, 'no-progress', 'one idle tick must not trip the two-tick stop');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('mission run pauses when the drill worker repeats the same summary 3 times', () => {
  const { base, repo } = makeRepo();
  try {
    const mission = startMission(repo, 'stuck repeating test', 'alice', ['--runner', 'drill', '--always-on']);
    const res = runCli([
      'mission', 'run', mission.id, '--max-ticks', '10', '--max-idle-ticks', '10', '--json',
    ], repo);
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const payload = JSON.parse(res.stdout);

    assert.equal(payload.pause_reason, 'stuck-repeating');
    assert.equal(payload.tick_count, 3);
    assert.equal(payload.mission.status, 'paused');
    assert.equal(payload.mission.stop_reason, 'stuck-repeating');
    assert.equal(payload.mission.next_action, 'stopped: the worker kept reporting the same thing 3 times in a row');
    assert.deepEqual(payload.ticks.map((tick) => tick.drill.summary), [
      'drill runner touched .atris/state/drill-runner-touch.txt',
      'drill runner touched .atris/state/drill-runner-touch.txt',
      'drill runner touched .atris/state/drill-runner-touch.txt',
    ]);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
