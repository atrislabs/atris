'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pulse = require('../lib/pulse');
const pulseCommand = require('../commands/pulse');

function tmpRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-test-'));
  fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
  return dir;
}

// --- scoreTick: reward gating mirrors the improve.js tick-5 lesson ---

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

test('pulse value flags accept spaced and inline forms', () => {
  assert.equal(pulseCommand.readFlag(['--model', 'sonnet'], '--model', 'opus'), 'sonnet');
  assert.equal(pulseCommand.readFlag(['--model=sonnet'], '--model', 'opus'), 'sonnet');
  assert.equal(pulseCommand.readFlag(['--runner-profile=atris-fast'], '--runner-profile', ''), 'atris-fast');
  assert.equal(pulseCommand.readFlag(['--model='], '--model', 'opus'), 'opus');
});

test('pulse run strips spaced and inline --max-ticks before tick passthrough', () => {
  assert.deepEqual(
    pulseCommand.withoutValueFlag(['--max-ticks', '2', '--no-verify'], '--max-ticks'),
    ['--no-verify']
  );
  assert.deepEqual(
    pulseCommand.withoutValueFlag(['--max-ticks=2', '--no-verify'], '--max-ticks'),
    ['--no-verify']
  );
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

test('buildCrontabLine requires a scriptPath', () => {
  assert.throws(() => pulse.buildCrontabLine({}), /scriptPath is required/);
});
