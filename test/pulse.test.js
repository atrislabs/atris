'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pulse = require('../lib/pulse');

function tmpRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-test-'));
  fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
  return dir;
}

// --- scoreTick: reward gating mirrors the improve.js tick-5 lesson ---

test('classifyActorFailure names a logged-out claude instead of a bare error', () => {
  const { reason, detail } = pulse.classifyActorFailure({
    status: 1,
    signal: null,
    stdout: 'Not logged in · Please run /login',
    stderr: '',
  });
  assert.strictEqual(reason, 'auth-required');
  assert.match(detail, /Not logged in/);
});

test('classifyActorFailure names a spawn timeout', () => {
  const { reason } = pulse.classifyActorFailure({ status: null, signal: 'SIGTERM', stdout: '', stderr: '' });
  assert.strictEqual(reason, 'timeout');
});

test('classifyActorFailure keeps a stderr tail as detail for plain errors', () => {
  const { reason, detail } = pulse.classifyActorFailure({
    status: 1,
    signal: null,
    stdout: '',
    stderr: 'x'.repeat(500) + '\nEADDRINUSE: port already bound',
  });
  assert.strictEqual(reason, 'error');
  assert.match(detail, /EADDRINUSE/);
  assert.ok(detail.length <= 300);
});

test('buildPulseReceipt carries the failed actor detail', () => {
  const receipt = pulse.buildPulseReceipt({ actor: 'autopilot', actorOk: false, actorReason: 'error', actorDetail: 'boom' });
  assert.strictEqual(receipt.actor_detail, 'boom');
  const clean = pulse.buildPulseReceipt({ actor: 'autopilot', actorOk: true, actorReason: 'completed' });
  assert.strictEqual(clean.actor_detail, null);
});

test('autopilotTickArgs runs one bounded leg that fits inside the spawn timeout', () => {
  const args = pulse.autopilotTickArgs(600000);
  assert.deepStrictEqual(args, ['autopilot', '--once', '--leg-wall', '480']);
  // never below the 60s floor, even for tiny timeouts
  assert.deepStrictEqual(pulse.autopilotTickArgs(30000), ['autopilot', '--once', '--leg-wall', '60']);
});

test('diffWorkspaceSnapshots credits work that landed in a worktree', () => {
  const before = {
    '/repo': { head: 'aaa', dirty: ['pre-existing.txt'] },
    '/repo-wt/m1': { head: 'aaa', dirty: [] },
  };
  const after = {
    '/repo': { head: 'aaa', dirty: ['pre-existing.txt'] },
    '/repo-wt/m1': { head: 'aaa', dirty: ['src/fix.js'] },
  };
  const diff = pulse.diffWorkspaceSnapshots('/repo', before, after);
  assert.deepStrictEqual(diff.changedFiles, ['m1:src/fix.js']);
  assert.strictEqual(diff.committed, false);
  assert.deepStrictEqual(diff.changedRoots, ['/repo-wt/m1']);
});

test('diffWorkspaceSnapshots counts a worktree created by the tick as its contribution', () => {
  const before = { '/repo': { head: 'aaa', dirty: [] } };
  const after = {
    '/repo': { head: 'aaa', dirty: [] },
    '/repo-wt/new': { head: 'aaa', dirty: ['atris/state.json'] },
  };
  const diff = pulse.diffWorkspaceSnapshots('/repo', before, after);
  assert.deepStrictEqual(diff.changedFiles, ['new:atris/state.json']);
});

test('diffWorkspaceSnapshots detects commits in any checkout and excludes pre-existing dirt', () => {
  const before = {
    '/repo': { head: 'aaa', dirty: ['noise.md'] },
    '/repo-wt/m1': { head: 'bbb', dirty: [] },
  };
  const after = {
    '/repo': { head: 'aaa', dirty: ['noise.md'] },
    '/repo-wt/m1': { head: 'ccc', dirty: [] },
  };
  const diff = pulse.diffWorkspaceSnapshots('/repo', before, after);
  assert.strictEqual(diff.committed, true);
  assert.deepStrictEqual(diff.changedFiles, []);
  assert.deepStrictEqual(diff.changedRoots, ['/repo-wt/m1']);
});

test('diffWorkspaceSnapshots ignores the loop\'s own bookkeeping files', () => {
  const before = { '/repo': { head: 'aaa', dirty: [] } };
  const after = {
    '/repo': { head: 'aaa', dirty: ['atris/runs/mission-x-receipt.json', '.atris/state/missions.jsonl', 'atris/logs/2026/2026-07-03.md', 'atris/status/now.md'] },
  };
  const diff = pulse.diffWorkspaceSnapshots('/repo', before, after);
  assert.deepStrictEqual(diff.changedFiles, [], 'receipts/state/logs are not work');
  assert.deepStrictEqual(diff.changedRoots, []);
  // real work alongside bookkeeping still counts
  after['/repo'].dirty.push('src/real-change.js');
  const diff2 = pulse.diffWorkspaceSnapshots('/repo', before, after);
  assert.deepStrictEqual(diff2.changedFiles, ['src/real-change.js']);
});

test('verifyOutcome treats a missing test script as unverifiable, not failed', () => {
  const outcome = pulse.verifyOutcome({ status: 1, stdout: '', stderr: 'npm error Missing script: "test"' });
  assert.strictEqual(outcome.passed, null);
  assert.strictEqual(outcome.reason, 'verifier_missing');
  // scoreTick: unverifiable work scores 0, never -1
  assert.strictEqual(pulse.scoreTick({ verifyPassed: outcome.passed, producedWork: true }), 0);
});

test('verifyOutcome keeps an output tail for real failures and none for passes', () => {
  const fail = pulse.verifyOutcome({ status: 1, stdout: 'x'.repeat(400) + '\n2 tests failed', stderr: '' });
  assert.strictEqual(fail.passed, false);
  assert.match(fail.detail, /2 tests failed/);
  assert.ok(fail.detail.length <= 300);
  const pass = pulse.verifyOutcome({ status: 0, stdout: 'all green', stderr: '' });
  assert.strictEqual(pass.passed, true);
  assert.strictEqual(pass.detail, null);
});

test('pulse workspace scoping: two repos get distinct state homes and cron markers', () => {
  assert.strictEqual(pulse.pulseWorkspaceKey('/Users/x/arena/atris-cli'), 'atris-cli');
  assert.strictEqual(pulse.pulseWorkspaceKey('/Users/x/arena/AtrisOS Backend!'), 'atrisos-backend');
  assert.notStrictEqual(
    pulse.pulseWorkspaceMarker('/a/repo-one'),
    pulse.pulseWorkspaceMarker('/a/repo-two'),
    'two workspaces must not share a cron marker',
  );
});

test('crontabLineBelongsToWorkspace: own scoped line and legacy bare line match, others survive', () => {
  const mine = `*/13 * * * * /home/u/.atris/overnight/repo-a-self-improve/tick.sh # ${pulse.PULSE_MARKER}:repo-a`;
  const theirs = `*/13 * * * * /home/u/.atris/overnight/repo-b-self-improve/tick.sh # ${pulse.PULSE_MARKER}:repo-b`;
  const legacy = `*/13 * * * * /home/u/.atris/overnight/atris-cli-self-improve/tick.sh # ${pulse.PULSE_MARKER}`;
  assert.strictEqual(pulse.crontabLineBelongsToWorkspace(mine, '/x/repo-a'), true);
  assert.strictEqual(pulse.crontabLineBelongsToWorkspace(theirs, '/x/repo-a'), false, 'must not kill another workspace heartbeat');
  assert.strictEqual(pulse.crontabLineBelongsToWorkspace(legacy, '/x/repo-a'), true, 'legacy shared-singleton lines migrate away');
});

test('buildCrontabLine and buildTickScript carry the workspace-scoped marker', () => {
  const marker = pulse.pulseWorkspaceMarker('/x/repo-a');
  const line = pulse.buildCrontabLine({ cron: '*/13 * * * *', scriptPath: '/tmp/tick.sh', marker });
  assert.ok(line.endsWith(`# ${marker}`));
  const script = pulse.buildTickScript({
    root: '/x/repo-a',
    atrisBin: '/usr/local/bin/atris',
    stateHome: '/home/u/.atris/overnight/repo-a-self-improve',
    deadlineEpoch: 2000000000,
    marker,
  });
  assert.ok(script.includes(`MARKER="${marker}"`), 'tick.sh must self-remove only its own scoped line');
});

test('scoreTick punishes verify failure with -1', () => {
  assert.equal(pulse.scoreTick({ verifyPassed: false, producedWork: true }), -1);
});

test('scoreTick rewards a verified, work-producing tick with +1', () => {
  assert.equal(pulse.scoreTick({ verifyPassed: true, producedWork: true }), 1);
});

test('scoreTick scores a tick that produced no work as 0 (no reward inflation)', () => {
  assert.equal(pulse.scoreTick({ verifyPassed: null, producedWork: false }), 0);
  // a "completed" engine tick that changed nothing must NOT earn reward —
  // this is the inflation bug: pre-existing dirt is not this tick's work.
  assert.equal(pulse.scoreTick({ verifyPassed: true, producedWork: false }), 0);
});

test('scoreTick does not reward unverified work', () => {
  assert.equal(pulse.scoreTick({ verifyPassed: null, producedWork: true }), 0);
});

test('shouldWriteScorecard gates pure no-op ticks out of the reward channel', () => {
  assert.equal(pulse.shouldWriteScorecard({ reward: 0 }), false);
  assert.equal(pulse.shouldWriteScorecard({ reward: 1 }), true);
  assert.equal(pulse.shouldWriteScorecard({ reward: -1 }), true);
});

// --- engine composition: mission first, then author-a-goal autopilot fallback ---

test('shouldFallbackToAutopilot fires only when no mission is due', () => {
  assert.equal(pulse.shouldFallbackToAutopilot({ missionReason: 'no_due_mission' }), true);
  assert.equal(pulse.shouldFallbackToAutopilot({ missionReason: 'completed' }), false);
  assert.equal(pulse.shouldFallbackToAutopilot({ missionReason: 'error' }), false);
});

test('shouldFallbackToAutopilot is suppressed by --no-autopilot and --no-claude', () => {
  // no worker available → can't author a goal
  assert.equal(pulse.shouldFallbackToAutopilot({ missionReason: 'no_due_mission', noClaude: true }), false);
  // fallback explicitly disabled
  assert.equal(pulse.shouldFallbackToAutopilot({ missionReason: 'no_due_mission', autopilotFallback: false }), false);
});

// --- ghost / stale detection: the silent-runner-death failure mode ---

test('findOrphanStarts flags a started tick with no matching finish', () => {
  const receipts = [
    pulse.buildPulseReceipt({ tickIndex: 1, phase: 'started' }),
    pulse.buildPulseReceipt({ tickIndex: 1, phase: 'finished' }),
    pulse.buildPulseReceipt({ tickIndex: 2, phase: 'started' }), // crashed here
  ];
  assert.deepEqual(pulse.findOrphanStarts(receipts), [2]);
});

test('detectStaleTick reports a crashed (started-without-finish) tick', () => {
  const receipts = [pulse.buildPulseReceipt({ tickIndex: 7, phase: 'started' })];
  const stale = pulse.detectStaleTick(receipts);
  assert.equal(stale.stale, true);
  assert.equal(stale.reason, 'started_without_finish');
  assert.equal(stale.tick_index, 7);
});

test('detectStaleTick reports a last tick that is too old (beyond the liveness window)', () => {
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(); // 3h > 150m liveness window
  const receipts = [pulse.buildPulseReceipt({ tickIndex: 1, phase: 'finished', ts: old })];
  const stale = pulse.detectStaleTick(receipts, Date.now());
  assert.equal(stale.stale, true);
  assert.equal(stale.reason, 'last_tick_too_old');
});

test('detectStaleTick does NOT flap stale between hourly ticks (under the liveness window)', () => {
  // last tick 70 min ago — mid-cadence for an hourly loop, must read fresh
  const recent = new Date(Date.now() - 70 * 60 * 1000).toISOString();
  const receipts = [pulse.buildPulseReceipt({ tickIndex: 1, phase: 'finished', ts: recent })];
  assert.equal(pulse.detectStaleTick(receipts, Date.now()).stale, false);
});

test('detectStaleTick is fresh for a recent finished tick', () => {
  const receipts = [pulse.buildPulseReceipt({ tickIndex: 1, phase: 'finished' })];
  assert.equal(pulse.detectStaleTick(receipts).stale, false);
});

// Regression: a historical crash that was RECOVERED by later ticks must not
// make the loop read as dead forever — liveness is about the latest tick.
test('detectStaleTick recovers: old orphan + later finished tick is not stale', () => {
  const receipts = [
    pulse.buildPulseReceipt({ tickIndex: 2, phase: 'started' }), // crashed long ago
    pulse.buildPulseReceipt({ tickIndex: 3, phase: 'started' }),
    pulse.buildPulseReceipt({ tickIndex: 3, phase: 'finished' }), // recovered
  ];
  assert.equal(pulse.detectStaleTick(receipts).stale, false);
  // the orphan is still surfaced for the feed, just not as a liveness failure
  assert.deepEqual(pulse.findOrphanStarts(receipts), [2]);
});

test('detectStaleTick handles an empty channel', () => {
  assert.equal(pulse.detectStaleTick([]).stale, false);
  assert.equal(pulse.detectStaleTick([]).reason, 'no_receipts');
});

// --- summarize ---

test('summarizePulse aggregates reward, verify counts, and last tick', () => {
  const receipts = [
    pulse.buildPulseReceipt({ tickIndex: 1, phase: 'started' }),
    pulse.buildPulseReceipt({ tickIndex: 1, phase: 'finished', verifyPassed: true, reward: 1 }),
    pulse.buildPulseReceipt({ tickIndex: 2, phase: 'started' }),
    pulse.buildPulseReceipt({ tickIndex: 2, phase: 'finished', verifyPassed: false, reward: -1 }),
  ];
  const s = pulse.summarizePulse(receipts);
  assert.equal(s.total_ticks, 2);
  assert.equal(s.reward_sum, 0);
  assert.equal(s.verify_pass, 1);
  assert.equal(s.verify_fail, 1);
  assert.equal(s.last_verify_passed, false);
});

// --- receipt + scorecard schemas ---

test('buildPulseReceipt stamps the pulse schema and defaults phase to finished', () => {
  const r = pulse.buildPulseReceipt({ tickIndex: 3 });
  assert.equal(r.schema, 'atris.pulse_tick.v1');
  assert.equal(r.phase, 'finished');
  assert.equal(r.tick_index, 3);
  assert.ok(r.ts);
});

test('buildPulseScorecardRow reuses the improve_tick schema so the brain sees it', () => {
  const row = pulse.buildPulseScorecardRow({ reward: 1, verifyPassed: true, what: 'shipped X' });
  assert.equal(row.schema, 'atris.improve_tick.v1');
  assert.equal(row.source, 'pulse');
  assert.equal(row.member, 'pulse');
  assert.equal(row.reward, 1);
  assert.equal(row.verify_passed, true);
});

test('buildInterruptedPulseReceipt closes interrupted ticks as failed instead of ghosting', () => {
  const receipt = pulse.buildInterruptedPulseReceipt({
    tickIndex: 120,
    signal: 'SIGINT',
    elapsedMs: 2500,
    prevTickStale: true,
  });
  assert.equal(receipt.phase, 'finished');
  assert.equal(receipt.actor, 'pulse_signal');
  assert.equal(receipt.actor_ok, false);
  assert.equal(receipt.actor_reason, 'sigint');
  assert.equal(receipt.what, 'tick interrupted by SIGINT');
  assert.equal(receipt.reward, -1);
  assert.equal(receipt.prev_tick_stale, true);
});

// --- IO round-trips ---

test('append + read pulse receipts round-trips through the channel file', () => {
  const root = tmpRoot();
  try {
    pulse.appendPulseReceipt(root, pulse.buildPulseReceipt({ tickIndex: 1, phase: 'finished', reward: 1 }));
    pulse.appendPulseReceipt(root, pulse.buildPulseReceipt({ tickIndex: 2, phase: 'finished', reward: -1 }));
    const back = pulse.readPulseReceipts(root);
    assert.equal(back.length, 2);
    assert.equal(back[0].tick_index, 1);
    assert.equal(pulse.pulseReceiptsPath(root).endsWith('pulse_agi_loop_receipts.jsonl'), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readJsonl skips foreign / partial rows without throwing', () => {
  const root = tmpRoot();
  try {
    const file = pulse.pulseReceiptsPath(root);
    fs.writeFileSync(file, '{"a":1}\nnot json\n{"b":2}\n', 'utf8');
    const rows = pulse.readJsonl(file);
    assert.equal(rows.length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('nextTickIndex increments and persists the counter', () => {
  const root = tmpRoot();
  try {
    assert.equal(pulse.nextTickIndex(root), 1);
    assert.equal(pulse.nextTickIndex(root), 2);
    assert.equal(pulse.nextTickIndex(root), 3);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- lock: prevents overlap, steals stale locks ---

test('acquireLock blocks a second concurrent holder', () => {
  const root = tmpRoot();
  try {
    const a = pulse.acquireLock(root);
    assert.equal(a.acquired, true);
    const b = pulse.acquireLock(root);
    assert.equal(b.acquired, false);
    pulse.releaseLock(root);
    const c = pulse.acquireLock(root);
    assert.equal(c.acquired, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('acquireLock steals a stale lock (surfacing a ghost tick)', () => {
  const root = tmpRoot();
  try {
    pulse.acquireLock(root); // hold it
    // now=far future so the existing lock looks stale
    const stolen = pulse.acquireLock(root, Date.now() + pulse.STALE_TICK_MS + 1000);
    assert.equal(stolen.acquired, true);
    assert.equal(stolen.stale, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- cron script + crontab line generation ---

test('buildTickScript embeds root, bin, deadline, marker, and calls pulse tick', () => {
  const script = pulse.buildTickScript({
    root: '/repo/atris-cli',
    atrisBin: '/usr/local/bin/atris',
    stateHome: '/home/x/.atris/overnight/atris-cli-self-improve',
    deadlineEpoch: 1777568422,
    model: 'opus',
    verifyCmd: 'npm test',
  });
  assert.match(script, /ROOT="\/repo\/atris-cli"/);
  assert.match(script, /ATRIS="\/usr\/local\/bin\/atris"/);
  assert.match(script, /DEADLINE_EPOCH="1777568422"/);
  assert.match(script, /ATRIS_PULSE_SELF_IMPROVE/);
  assert.match(script, /"\$ATRIS" pulse tick --json --verify 'npm test'/);
  // deadline self-removal (the commander tick.sh pattern) must be present
  assert.match(script, /crontab -l .* grep -v "\$MARKER" .* crontab -/);
  // runner-agnostic model default so a retired model can't silently kill the loop
  assert.match(script, /export ATRIS_RUNNER_MODEL='opus'/);
  assert.match(script, /export ATRIS_CLAUDE_MODEL="\$\{ATRIS_RUNNER_MODEL\}"/);
  assert.doesNotMatch(script, /ATRIS_RUNNER_PROFILE=/);
  assert.doesNotMatch(script, /ATRIS_RUNNER_BIN=/);
  assert.doesNotMatch(script, /ATRIS_CLAUDE_BIN=/);
  assert.doesNotMatch(script, /ATRIS_RUNNER_COMMAND_TEMPLATE=/);
  assert.doesNotMatch(script, /ATRIS_CLAUDE_COMMAND_TEMPLATE=/);
});

test('buildTickScript exports a PATH so cron can find bare-name spawns (claude/node)', () => {
  const script = pulse.buildTickScript({
    root: '/r',
    stateHome: '/s',
    deadlineEpoch: 123,
    pathDirs: ['/Users/x/.local/bin', '/opt/homebrew/bin'],
  });
  assert.match(script, /export PATH="/);
  assert.match(script, /\/Users\/x\/\.local\/bin/); // claude location must be present
  assert.match(script, /:\$PATH"/); // preserves the inherited PATH
});

test('buildTickScript preserves configured runner command for cron', () => {
  const script = pulse.buildTickScript({
    root: '/r',
    stateHome: '/s',
    deadlineEpoch: 123,
    runnerBin: '/opt/atris/bin/claude-nightly',
    runnerCommandTemplate: "{bin} --prompt-file {promptFile} --literal $HOME --name 'nightly'",
  });
  assert.ok(script.includes("export ATRIS_RUNNER_BIN='/opt/atris/bin/claude-nightly'"));
  assert.ok(script.includes('export ATRIS_CLAUDE_BIN="${ATRIS_RUNNER_BIN}"'));
  assert.ok(script.includes('export ATRIS_RUNNER_COMMAND_TEMPLATE='));
  assert.ok(script.includes('export ATRIS_CLAUDE_COMMAND_TEMPLATE='));
  assert.ok(script.includes('--literal $HOME'));
  assert.ok(script.includes("'\\''nightly'\\'''"));
});

test('buildTickScript preserves configured runner profile for cron', () => {
  const script = pulse.buildTickScript({
    root: '/r',
    stateHome: '/s',
    deadlineEpoch: 123,
    model: 'atris:fast',
    runnerProfile: 'atris-fast',
  });
  assert.ok(script.includes("export ATRIS_RUNNER_PROFILE='atris-fast'"));
  assert.ok(script.includes("export ATRIS_RUNNER_MODEL='atris:fast'"));
});

test('buildTickScript escapes single quotes in the verify command', () => {
  const script = pulse.buildTickScript({
    root: '/r',
    stateHome: '/s',
    deadlineEpoch: 123,
    verifyCmd: "sh -c 'echo hi'",
  });
  assert.ok(script.includes("'\\''"), 'single quotes in verify cmd should be escaped');
});

test('buildTickScript requires root, stateHome, and deadlineEpoch', () => {
  assert.throws(() => pulse.buildTickScript({ stateHome: '/s', deadlineEpoch: 1 }), /root is required/);
  assert.throws(() => pulse.buildTickScript({ root: '/r', deadlineEpoch: 1 }), /stateHome is required/);
  assert.throws(() => pulse.buildTickScript({ root: '/r', stateHome: '/s' }), /deadlineEpoch is required/);
});

test('buildCrontabLine produces a marked, scheduled line', () => {
  const line = pulse.buildCrontabLine({ cron: '11,40 * * * *', scriptPath: '/x/tick.sh' });
  assert.equal(line, '11,40 * * * * /x/tick.sh # ATRIS_PULSE_SELF_IMPROVE');
});

test('buildCrontabLine accepts human cadence shorthands', () => {
  assert.equal(pulse.normalizeCronCadence('13m'), '*/13 * * * *');
  assert.equal(pulse.normalizeCronCadence('2h'), '23 */2 * * *');
  assert.equal(pulse.normalizeCronCadence('hourly'), pulse.DEFAULT_CADENCE_CRON);
  assert.equal(
    pulse.buildCrontabLine({ cron: '13m', scriptPath: '/x/tick.sh' }),
    '*/13 * * * * /x/tick.sh # ATRIS_PULSE_SELF_IMPROVE',
  );
});

test('buildCrontabLine rejects invalid human cadence shorthands', () => {
  assert.throws(() => pulse.normalizeCronCadence('90m'), /minute cadence/);
  assert.throws(() => pulse.buildCrontabLine({ cron: 'soon', scriptPath: '/x/tick.sh' }), /invalid cadence/);
});

test('normalizeExpiryDuration accepts hours for short overnight runs', () => {
  assert.deepEqual(pulse.normalizeExpiryDuration({ hours: '6', days: '7' }), {
    source: 'hours',
    hours: 6,
    days: null,
    seconds: 21600,
  });
  assert.deepEqual(pulse.normalizeExpiryDuration({ days: '2' }), {
    source: 'days',
    hours: null,
    days: 2,
    seconds: 172800,
  });
});

test('normalizeExpiryDuration rejects invalid expiry values', () => {
  assert.throws(() => pulse.normalizeExpiryDuration({ hours: '0' }), /invalid hours/);
  assert.throws(() => pulse.normalizeExpiryDuration({ days: 'soon' }), /invalid days/);
});

test('buildCrontabLine requires a scriptPath', () => {
  assert.throws(() => pulse.buildCrontabLine({}), /scriptPath is required/);
});
