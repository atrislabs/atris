const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  buildManifest,
  computeLocalHashes,
  threeWayCompare,
  formatLocalDate,
  collectSnapshot,
  parseLiveOptions,
  shouldIgnore,
  snapshotsDiffer,
  buildPullConflictReviewPacket,
  mergeSmartPullFiles,
  normalizePullFilePath,
  analyzePushSafety,
  basenameOfManifestPath,
  buildCloudHashMap,
  buildPushChangePlan,
  isBusinessWorkspaceRoot,
  resolvePushSourceDir,
  shouldRetrySyncIndividually,
  collectState,
  buildBusinessSyncPlan,
  canPreviewPush,
  collectBrainSnapshot,
  collectConflictResolutionEntries,
  collectLocalSyncStatus,
  collectWorkspaceWarnings,
  describeWatchFailure,
  parseBusinessSyncArgs,
  renderBusinessSyncHelp,
  renderLatestConflictReview,
  renderLocalSyncStatus,
  resolveLatestConflict,
  resolveBusinessSyncOptions,
  safeLineMerge,
  safeMarkdownMerge,
  shouldIgnoreWatchPath,
  brainSnapshotsDiffer,
  writeSyncStatus,
  writeBaseContents,
  writeConflictReviewPacket,
  cliPath,
  makeTempDir,
  cleanupTempDir,
  runCli,
  hasNodeSqlite,
  runGit,
  seedBrainWorkspace,
  assertAdvertisedAtrisPathsExist,
} = require('./helpers/commands-shared');

test('mission start tick complete writes durable member-owned state', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'mission-lead'], { cwd: dir }).status, 0);

    const start = runCli([
      'mission', 'start', '--no-verify', 'Make Mission real',
      '--owner', 'mission-lead',
      '--runner', 'codex_goal',
      '--lane', 'code',
      '--cadence', 'manual',
      '--verify', 'node -e "process.exit(0)"',
      '--stop', 'verifier passes',
      '--json',
      '--full',
    ], { cwd: dir });
    assert.equal(start.status, 0, start.stderr || start.stdout);
    const startPayload = JSON.parse(start.stdout);
    assert.equal(startPayload.action, 'mission_started');
    assert.equal(startPayload.mission.owner, 'mission-lead');
    assert.equal(startPayload.mission.runner, 'codex_goal');
    assert.ok(fs.existsSync(path.join(dir, '.atris', 'state', 'missions.jsonl')));
    assert.ok(fs.existsSync(path.join(dir, '.atris', 'state', 'mission_events.jsonl')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'team', 'mission-lead', 'MISSION.md')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'team', 'mission-lead', 'now.md')));
	    assert.equal(fs.existsSync(path.join(dir, 'atris', 'team', 'mission-lead', 'missions.md')), false);
	    assert.equal(fs.existsSync(path.join(dir, 'atris', 'team', 'mission-lead', 'missions.json')), false);
	    assert.match(fs.readFileSync(path.join(dir, 'atris', 'team', 'mission-lead', 'now.md'), 'utf8'), /Make Mission real/);
	    const ack = runCli([
	      'mission', 'goal', 'ack', startPayload.mission.id,
	      '--runtime', 'codex',
	      '--status', 'active',
	      '--objective', 'Make Mission real',
	      '--json',
	    ], { cwd: dir });
	    assert.equal(ack.status, 0, ack.stderr || ack.stdout);

	    const tick = runCli(['mission', 'tick', startPayload.mission.id, '--verify', '--json', '--full'], { cwd: dir });
    assert.equal(tick.status, 0, tick.stderr || tick.stdout);
    const tickPayload = JSON.parse(tick.stdout);
    assert.equal(tickPayload.action, 'mission_tick');
    assert.equal(tickPayload.mission.status, 'ready');
    assert.equal(tickPayload.verifier_result.passed, true);
    assert.ok(fs.existsSync(path.join(dir, tickPayload.receipt_path)));

    const complete = runCli(['mission', 'complete', startPayload.mission.id, '--proof', tickPayload.receipt_path, '--json', '--full'], { cwd: dir });
    assert.equal(complete.status, 0, complete.stderr || complete.stdout);
    const completePayload = JSON.parse(complete.stdout);
    assert.equal(completePayload.mission.status, 'complete');

    const status = runCli(['mission', 'status', startPayload.mission.id, '--json'], { cwd: dir });
    assert.equal(status.status, 0, status.stderr || status.stdout);
    const statusPayload = JSON.parse(status.stdout);
    assert.equal(statusPayload.missions[0].status, 'complete');
    assert.match(fs.readFileSync(path.join(dir, 'atris', 'status', 'now.md'), 'utf8'), /Make Mission real/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('always-on mission run keeps ticking after verifier passes', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'mission-lead'], { cwd: dir }).status, 0);

    const start = runCli([
      'mission', 'start', '--no-verify', 'Keep the loop alive',
      '--owner', 'mission-lead',
      '--runner', 'codex_goal',
      '--cadence', 'manual',
      '--verify', 'node -e "process.exit(0)"',
      '--always-on',
      '--json',
    ], { cwd: dir });
	    assert.equal(start.status, 0, start.stderr || start.stdout);
	    const mission = JSON.parse(start.stdout).mission;
	    assert.equal(mission.always_on, true);
	    const ack = runCli([
	      'mission', 'goal', 'ack', mission.id,
	      '--runtime', 'codex',
	      '--status', 'active',
	      '--objective', 'Keep the loop alive',
	      '--json',
	    ], { cwd: dir });
	    assert.equal(ack.status, 0, ack.stderr || ack.stdout);

	    const firstRun = runCli([
      'mission', 'run', mission.id,
      '--max-ticks', '2',
      '--complete-on-pass',
      '--json',
    ], { cwd: dir });
    assert.equal(firstRun.status, 0, firstRun.stderr || firstRun.stdout);
    const firstPayload = JSON.parse(firstRun.stdout);
    assert.equal(firstPayload.ran_ticks, 1);
    assert.equal(firstPayload.tick_count, 1);
    assert.equal(firstPayload.mission.status, 'ready');
    assert.match(firstPayload.mission.next_action, /mission run/);

	    const secondRun = runCli([
      'mission', 'run', mission.id,
      '--max-ticks', '2',
      '--complete-on-pass',
      '--json',
    ], { cwd: dir });
    assert.equal(secondRun.status, 0, secondRun.stderr || secondRun.stdout);
    const payload = JSON.parse(secondRun.stdout);
    assert.equal(payload.ran_ticks, 1);
    assert.equal(payload.tick_count, 1);
    assert.equal(payload.ticks[0].tick_index, 2);
    assert.equal(payload.mission.status, 'ready');
    assert.match(payload.mission.next_action, /mission run/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('mission run bounds errored claude ticks with max-ticks', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'mission-lead'], { cwd: dir }).status, 0);

    const fakeBin = path.join(dir, 'fake-bin');
    fs.mkdirSync(fakeBin, { recursive: true });
    const fakeClaude = path.join(fakeBin, 'claude');
    fs.writeFileSync(fakeClaude, [
      '#!/bin/sh',
      'if [ "$1" = "--help" ]; then',
      '  echo "--output-format --permission-mode --resume --session-id --include-partial-messages"',
      '  exit 0',
      'fi',
      'echo "{\"type\":\"result\",\"is_error\":true,\"result\":\"boom\"}"',
      'exit 1',
      '',
    ].join('\n'), 'utf8');
    fs.chmodSync(fakeClaude, 0o755);
    const env = { PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}` };

    const start = runCli([
      'mission', 'start', '--no-verify', 'Bound failed worker attempts',
      '--owner', 'mission-lead',
      '--runner', 'claude',
      '--cadence', 'manual',
      '--verify', 'node -e "process.exit(0)"',
      '--always-on',
      '--json',
    ], { cwd: dir, env });
    assert.equal(start.status, 0, start.stderr || start.stdout);
    const mission = JSON.parse(start.stdout).mission;

    const run = runCli([
      'mission', 'run', mission.id,
      '--max-ticks', '1',
      '--json',
    ], { cwd: dir, env });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const payload = JSON.parse(run.stdout);
    assert.equal(payload.ran_ticks, 0);
    assert.equal(payload.tick_count, 1);
    assert.equal(payload.ticks[0].status, 'errored');
    assert.equal(payload.ticks[0].reason, 'claude-error');
    assert.equal(payload.pause_reason, 'max-ticks-reached');
    assert.equal(payload.mission.status, 'paused');
    assert.equal(payload.mission.stop_reason, 'max-ticks-reached');
  } finally {
    cleanupTempDir(dir);
  }
});


test('member run --minutes scales max-ticks past a single tick, untimed stays at one', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'mission-lead'], { cwd: dir }).status, 0);

    const fakeBin = path.join(dir, 'fake-bin');
    fs.mkdirSync(fakeBin, { recursive: true });
    const fakeClaude = path.join(fakeBin, 'claude');
    // Runner succeeds every tick; the verifier always fails. That drives the
    // 'consecutive-verifier-fails' breaker (trips at 2) with no error-backoff
    // sleep, so the loop is fast and its tick count is fully observable.
    fs.writeFileSync(fakeClaude, [
      '#!/bin/sh',
      'if [ "$1" = "--help" ]; then',
      '  echo "--output-format --permission-mode --resume --session-id --include-partial-messages"',
      '  exit 0',
      'fi',
      'echo "{\"type\":\"result\",\"is_error\":false,\"result\":\"did work\"}"',
      'exit 0',
      '',
    ].join('\n'), 'utf8');
    fs.chmodSync(fakeClaude, 0o755);
    const env = { PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}` };

    const startMission = (title) => {
      const start = runCli([
        'mission', 'start', '--no-verify', title,
        '--owner', 'mission-lead',
        '--runner', 'claude',
        '--cadence', 'manual',
        '--verify', 'node -e "process.exit(1)"',
        '--json',
      ], { cwd: dir, env });
      assert.equal(start.status, 0, start.stderr || start.stdout);
      return JSON.parse(start.stdout).mission;
    };

    // The verifier fails each tick, so the loop stops at min(max-ticks, 2):
    //   max-ticks 1 -> exactly 1 tick (a lone tick can never break the streak)
    //   max-ticks >1 -> 2 ticks, then 'consecutive-verifier-fails'
    // An untimed run keeps the single-tick default; a timed run must loop.
    const untimed = startMission('untimed member run defaults to one tick');
    const untimedRun = runCli(['member', 'run', 'mission-lead', '--mission-id', untimed.id, '--json'], { cwd: dir, env });
    // The check fails on purpose, so the run exits 1 and says so.
    assert.equal(untimedRun.status, 1, untimedRun.stderr || untimedRun.stdout);
    assert.equal(JSON.parse(untimedRun.stdout).check_failed, true);
    const untimedPayload = JSON.parse(untimedRun.stdout);
    // With max-ticks 1 it is impossible to tick more than once.
    assert.equal(untimedPayload.tick_count, 1);
    assert.equal(untimedPayload.ran_ticks, 1);

    const timed = startMission('timed member run loops for the budget');
    const timedRun = runCli(['member', 'run', 'mission-lead', '--mission-id', timed.id, '--minutes', '10', '--json'], { cwd: dir, env, timeout: 60000 });
    // The check fails on purpose, so the run exits 1 and says so.
    assert.equal(timedRun.status, 1, timedRun.stderr || timedRun.stdout);
    assert.equal(JSON.parse(timedRun.stdout).check_failed, true);
    const timedPayload = JSON.parse(timedRun.stdout);
    // max(4, ceil(600/300)) = 4 > 1, so it ticks past one before the breaker trips.
    // The old default of max-ticks 1 could never reach a second tick.
    assert.equal(timedPayload.tick_count, 2);
    assert.equal(timedPayload.ran_ticks, 2);
    assert.equal(timedPayload.pause_reason, 'consecutive-verifier-fails');
  } finally {
    cleanupTempDir(dir);
  }
});


test('allowed rate-limit info with a future resetsAt does not pause a timed run', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'mission-lead'], { cwd: dir }).status, 0);

    const fakeBin = path.join(dir, 'fake-bin');
    fs.mkdirSync(fakeBin, { recursive: true });
    const fakeClaude = path.join(fakeBin, 'claude');
    // Claude reports the five-hour window's resetsAt on every turn even when
    // status is "allowed" (resetsAt here is year 2100, far past any wall).
    // Only a non-allowed status is a real cooldown; an allowed one must not
    // pause the run with rate-limit-exceeded-wall after tick 1.
    fs.writeFileSync(fakeClaude, [
      '#!/bin/sh',
      'if [ "$1" = "--help" ]; then',
      '  echo "--output-format --permission-mode --resume --session-id --include-partial-messages"',
      '  exit 0',
      'fi',
      "echo '{\"type\":\"rate_limit_event\",\"rate_limit_info\":{\"status\":\"allowed\",\"resetsAt\":4102444800,\"rateLimitType\":\"five_hour\"}}'",
      "echo '{\"type\":\"result\",\"is_error\":false,\"result\":\"did work\"}'",
      'exit 0',
      '',
    ].join('\n'), 'utf8');
    fs.chmodSync(fakeClaude, 0o755);
    const env = { PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}` };

    const start = runCli([
      'mission', 'start', '--no-verify', 'timed run survives allowed rate-limit info',
      '--owner', 'mission-lead',
      '--runner', 'claude',
      '--cadence', 'manual',
      '--json',
    ], { cwd: dir, env });
    assert.equal(start.status, 0, start.stderr || start.stdout);
    const mission = JSON.parse(start.stdout).mission;

    const run = runCli(['member', 'run', 'mission-lead', '--mission-id', mission.id, '--minutes', '10', '--no-verify', '--json'], { cwd: dir, env });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const payload = JSON.parse(run.stdout);
    // The allowed-status window must never become a rate-limit pause. This
    // fixture repeats the same result, so the independent repeated-summary
    // breaker stops it after three attempts.
    assert.notEqual(payload.pause_reason, 'rate-limit-exceeded-wall');
    assert.equal(payload.tick_count, 3);
    assert.equal(payload.ran_ticks, 3);
    assert.equal(payload.pause_reason, 'stuck-repeating');
  } finally {
    cleanupTempDir(dir);
  }
});


test('member ping reaches the next tick prompt exactly once', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'mission-lead'], { cwd: dir }).status, 0);

    const fakeBin = path.join(dir, 'fake-bin');
    fs.mkdirSync(fakeBin, { recursive: true });
    const fakeClaude = path.join(fakeBin, 'claude');
    const promptDump = path.join(dir, 'tick-prompt.txt');
    // Dump the -p prompt so the test can assert what the tick actually saw.
    fs.writeFileSync(fakeClaude, [
      '#!/bin/sh',
      'if [ "$1" = "--help" ]; then',
      '  echo "--output-format --permission-mode --resume --session-id --include-partial-messages"',
      '  exit 0',
      'fi',
      `printf '%s' "$2" > "${promptDump}"`,
      "echo '{\"type\":\"result\",\"is_error\":false,\"result\":\"did work\"}'",
      'exit 0',
      '',
    ].join('\n'), 'utf8');
    fs.chmodSync(fakeClaude, 0o755);
    const env = { PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}` };

    const start = runCli([
      'mission', 'start', '--no-verify', 'always-on member you can text',
      '--owner', 'mission-lead',
      '--runner', 'claude',
      '--cadence', 'manual',
      '--json',
    ], { cwd: dir, env });
    assert.equal(start.status, 0, start.stderr || start.stdout);
    const mission = JSON.parse(start.stdout).mission;

    // ping by member name — it must resolve to the live mission
    const ping = runCli(['member', 'ping', 'mission-lead', 'ship the login fix first'], { cwd: dir, env });
    assert.equal(ping.status, 0, ping.stderr || ping.stdout);
    assert.match(ping.stdout, /1 unread/);

    const run = runCli(['member', 'run', 'mission-lead', '--mission-id', mission.id, '--max-ticks', '1', '--json'], { cwd: dir, env });
    assert.equal(run.status, 0, run.stderr || run.stdout);

    const prompt = fs.readFileSync(promptDump, 'utf8');
    assert.match(prompt, /Operator pings \(read these first\)/);
    assert.match(prompt, /ship the login fix first/);

    // consumed: a second run's prompt must not repeat it
    const run2 = runCli(['member', 'run', 'mission-lead', '--mission-id', mission.id, '--max-ticks', '1', '--json'], { cwd: dir, env });
    assert.equal(run2.status, 0, run2.stderr || run2.stdout);
    const prompt2 = fs.readFileSync(promptDump, 'utf8');
    assert.doesNotMatch(prompt2, /ship the login fix first/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('stale session lock rotates to a fresh session instead of grinding the error breaker', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'mission-lead'], { cwd: dir }).status, 0);

    const fakeBin = path.join(dir, 'fake-bin');
    fs.mkdirSync(fakeBin, { recursive: true });
    const fakeClaude = path.join(fakeBin, 'claude');
    const busyMarker = path.join(dir, 'resume-failed-once');
    // The first --resume fails the way a killed tick's stale lock does; every
    // other call succeeds and confirms the requested session id. A run that
    // rotates recovers on the next tick; one that keeps resuming the locked id
    // would have died here before the rotation existed.
    fs.writeFileSync(fakeClaude, [
      '#!/bin/sh',
      'if [ "$1" = "--help" ]; then',
      '  echo "--output-format --permission-mode --resume --session-id --include-partial-messages"',
      '  exit 0',
      'fi',
      'mode=""; sid=""; prev=""',
      'for a in "$@"; do',
      '  if [ "$prev" = "--session-id" ]; then mode=set; sid="$a"; fi',
      '  if [ "$prev" = "--resume" ]; then mode=resume; sid="$a"; fi',
      '  prev="$a"',
      'done',
      `if [ "$mode" = "resume" ] && [ ! -f "${busyMarker}" ]; then`,
      `  touch "${busyMarker}"`,
      '  echo "Error: Session ID $sid is already in use." >&2',
      '  exit 1',
      'fi',
      'echo "{\\"type\\":\\"result\\",\\"is_error\\":false,\\"result\\":\\"did work\\",\\"session_id\\":\\"$sid\\"}"',
      'exit 0',
      '',
    ].join('\n'), 'utf8');
    fs.chmodSync(fakeClaude, 0o755);
    const env = { PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}` };

    const start = runCli([
      'mission', 'start', '--no-verify', 'stale session lock rotates instead of pausing',
      '--owner', 'mission-lead',
      '--runner', 'claude',
      '--cadence', 'manual',
      '--verify', 'node -e "process.exit(1)"',
      '--json',
    ], { cwd: dir, env });
    assert.equal(start.status, 0, start.stderr || start.stdout);
    const mission = JSON.parse(start.stdout).mission;

    const run = runCli(['member', 'run', 'mission-lead', '--mission-id', mission.id, '--minutes', '10', '--json'], { cwd: dir, env });
    // The check fails on purpose, so the run exits 1 and says so.
    assert.equal(run.status, 1, run.stderr || run.stdout);
    assert.equal(JSON.parse(run.stdout).check_failed, true);
    const payload = JSON.parse(run.stdout);
    // Tick 1 ran with a verifier failure. Tick 2 hit the stale lock, retried
    // immediately on a fresh session, then ran with the second verifier
    // failure. The failed resume is not recorded as its own errored tick.
    assert.equal(payload.pause_reason, 'consecutive-verifier-fails');
    assert.equal(payload.tick_count, 2);
    assert.equal(payload.ran_ticks, 2);

    // The rotation is visible as a retry event, while mission tick history has
    // no standalone claude-session-busy error row.
    const stateLog = fs.readFileSync(path.join(dir, '.atris', 'state', 'missions.jsonl'), 'utf8');
    assert.doesNotMatch(stateLog, /"last_tick_reason":"claude-session-busy"/);
    const eventLog = fs.readFileSync(path.join(dir, '.atris', 'state', 'mission_events.jsonl'), 'utf8');
    assert.match(eventLog, /session-lock-busy-retry/);
    const sessionIds = new Set([...stateLog.matchAll(/"claude_session_id":"([0-9a-f-]+)"/g)].map((m) => m[1]));
    assert.equal(sessionIds.size, 2, `expected a rotated second session id, saw: ${[...sessionIds].join(', ')}`);
  } finally {
    cleanupTempDir(dir);
  }
});


test('a resume against a vanished session rotates instead of grinding the error breaker', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'mission-lead'], { cwd: dir }).status, 0);

    const fakeBin = path.join(dir, 'fake-bin');
    fs.mkdirSync(fakeBin, { recursive: true });
    const fakeClaude = path.join(fakeBin, 'claude');
    const goneMarker = path.join(dir, 'resume-failed-once');
    // The first --resume fails the way a cleaned-up session does: the stored id
    // resolves to no conversation. Every other call succeeds. Without the
    // rotation the run would grind claude-error until the breaker paused it.
    fs.writeFileSync(fakeClaude, [
      '#!/bin/sh',
      'if [ "$1" = "--help" ]; then',
      '  echo "--output-format --permission-mode --resume --session-id --include-partial-messages"',
      '  exit 0',
      'fi',
      'mode=""; sid=""; prev=""',
      'for a in "$@"; do',
      '  if [ "$prev" = "--session-id" ]; then mode=set; sid="$a"; fi',
      '  if [ "$prev" = "--resume" ]; then mode=resume; sid="$a"; fi',
      '  prev="$a"',
      'done',
      `if [ "$mode" = "resume" ] && [ ! -f "${goneMarker}" ]; then`,
      `  touch "${goneMarker}"`,
      '  echo "No conversation found with session ID: $sid" >&2',
      '  exit 1',
      'fi',
      'echo "{\\"type\\":\\"result\\",\\"is_error\\":false,\\"result\\":\\"did work\\",\\"session_id\\":\\"$sid\\"}"',
      'exit 0',
      '',
    ].join('\n'), 'utf8');
    fs.chmodSync(fakeClaude, 0o755);
    const env = { PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}` };

    const start = runCli([
      'mission', 'start', '--no-verify', 'vanished session rotates instead of pausing',
      '--owner', 'mission-lead',
      '--runner', 'claude',
      '--cadence', 'manual',
      '--verify', 'node -e "process.exit(1)"',
      '--json',
    ], { cwd: dir, env });
    assert.equal(start.status, 0, start.stderr || start.stdout);
    const mission = JSON.parse(start.stdout).mission;

    const run = runCli(['member', 'run', 'mission-lead', '--mission-id', mission.id, '--minutes', '10', '--json'], { cwd: dir, env });
    // The check fails on purpose, so the run exits 1 and says so.
    assert.equal(run.status, 1, run.stderr || run.stdout);
    assert.equal(JSON.parse(run.stdout).check_failed, true);
    const payload = JSON.parse(run.stdout);
    assert.equal(payload.pause_reason, 'consecutive-verifier-fails');

    const stateLog = fs.readFileSync(path.join(dir, '.atris', 'state', 'missions.jsonl'), 'utf8');
    assert.match(stateLog, /claude-session-busy/);
    const sessionIds = new Set([...stateLog.matchAll(/"claude_session_id":"([0-9a-f-]+)"/g)].map((m) => m[1]));
    assert.equal(sessionIds.size, 2, `expected a rotated second session id, saw: ${[...sessionIds].join(', ')}`);
  } finally {
    cleanupTempDir(dir);
  }
});


test('healthy claude sessions rotate for context refresh after N ran ticks', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'mission-lead'], { cwd: dir }).status, 0);

    const fakeBin = path.join(dir, 'fake-bin');
    fs.mkdirSync(fakeBin, { recursive: true });
    const fakeClaude = path.join(fakeBin, 'claude');
    // Every call succeeds and confirms the requested session id — no failures.
    // Rotation must come from the context-refresh counter alone.
    fs.writeFileSync(fakeClaude, [
      '#!/bin/sh',
      'if [ "$1" = "--help" ]; then',
      '  echo "--output-format --permission-mode --resume --session-id --include-partial-messages"',
      '  exit 0',
      'fi',
      'sid=""; prev=""',
      'for a in "$@"; do',
      '  if [ "$prev" = "--session-id" ]; then sid="$a"; fi',
      '  if [ "$prev" = "--resume" ]; then sid="$a"; fi',
      '  prev="$a"',
      'done',
      'echo "{\\"type\\":\\"result\\",\\"is_error\\":false,\\"result\\":\\"did work\\",\\"session_id\\":\\"$sid\\"}"',
      'exit 0',
      '',
    ].join('\n'), 'utf8');
    fs.chmodSync(fakeClaude, 0o755);
    const env = {
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
      ATRIS_CLAUDE_SESSION_ROTATE_TICKS: '2',
    };

    // Explicitly skip the fallback verifier so ticks keep running to max-ticks
    // and the third tick can mint the fresh session the rotation cleared for.
    const start = runCli([
      'mission', 'start', '--no-verify', 'healthy sessions rotate for context refresh',
      '--owner', 'mission-lead',
      '--runner', 'claude',
      '--cadence', 'manual',
      '--json',
    ], { cwd: dir, env });
    assert.equal(start.status, 0, start.stderr || start.stdout);
    const mission = JSON.parse(start.stdout).mission;

    const run = runCli(['mission', 'run', mission.id, '--max-ticks', '3', '--max-wall', '120', '--no-verify', '--json'], { cwd: dir, env });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const payload = JSON.parse(run.stdout);
    assert.equal(payload.ran_ticks, 3, run.stdout);

    // Rotation event: fires after tick 2 (threshold 2) with the context reason.
    const eventsLog = fs.readFileSync(path.join(dir, '.atris', 'state', 'mission_events.jsonl'), 'utf8');
    assert.match(eventsLog, /mission_session_rotated/);
    assert.match(eventsLog, /context-refresh/);

    // Tick 2's record zeroes the counter and drops the session; tick 3 runs on
    // a fresh id, so two distinct session ids appear despite zero failures.
    const stateLog = fs.readFileSync(path.join(dir, '.atris', 'state', 'missions.jsonl'), 'utf8');
    const sessionIds = new Set([...stateLog.matchAll(/"claude_session_id":"([0-9a-f-]+)"/g)].map((m) => m[1]));
    assert.equal(sessionIds.size, 2, `expected a fresh session after rotation, saw: ${[...sessionIds].join(', ')}`);
  } finally {
    cleanupTempDir(dir);
  }
});


// ============================================
// version
// ============================================

test('version prints atris v<semver>', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['version'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout.trim(), /^atris v\d+\.\d+\.\d+$/);
  } finally {
    cleanupTempDir(dir);
  }
});


// ============================================
// live
// ============================================

test('live help exposes fresh brain command', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['live', '--help'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Usage: atris live \[business\]/);
    assert.match(res.stdout, /Keeps a business brain fresh/);
    assert.match(res.stdout, /--debounce/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('live dry-run prints doctor pull push plan without credentials', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['live', 'acme', '--dry-run', '--once', '--only', 'atris/MAP.md'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Atris Live: acme/);
    assert.match(res.stdout, /dry-run: atris business doctor --fix/);
    assert.match(res.stdout, /dry-run: atris push acme --from/);
    assert.match(res.stdout, /dry-run: atris pull acme --timeout 600 --only atris\/MAP\.md/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('live options infer slug from business workspace and parse timing', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, '.atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.atris', 'business.json'), JSON.stringify({ slug: 'parked' }), 'utf8');
    const options = parseLiveOptions(['--once', '--interval=7', '--debounce', '3', '--timeout=44'], dir);
    assert.equal(options.slug, 'parked');
    assert.equal(options.once, true);
    assert.equal(options.intervalSec, 7);
    assert.equal(options.debounceSec, 3);
    assert.equal(options.timeoutSec, 44);
  } finally {
    cleanupTempDir(dir);
  }
});


test('live options resolve explicit slug to child workspace from portfolio root', () => {
  const dir = makeTempDir();
  try {
    const child = path.join(dir, 'acme');
    fs.mkdirSync(path.join(child, '.atris'), { recursive: true });
    fs.mkdirSync(path.join(child, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(child, '.atris', 'business.json'), JSON.stringify({ slug: 'acme' }), 'utf8');

    const options = parseLiveOptions(['acme', '--once'], dir);
    assert.equal(options.slug, 'acme');
    assert.equal(options.cwd, child);
    assert.equal(options.root, dir);
  } finally {
    cleanupTempDir(dir);
  }
});


test('live snapshot detects meaningful file changes and ignores runtime state', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'MAP.md'), '# Map\n', 'utf8');
    fs.writeFileSync(path.join(dir, '.atris', 'state', '_sync.json'), '{}', 'utf8');

    const before = collectSnapshot(dir);
    fs.writeFileSync(path.join(dir, '.atris', 'state', '_sync.json'), '{"x":1}', 'utf8');
    assert.equal(snapshotsDiffer(before, collectSnapshot(dir)), false);

    fs.writeFileSync(path.join(dir, 'atris', 'MAP.md'), '# Map\n\nupdated\n', 'utf8');
    assert.equal(snapshotsDiffer(before, collectSnapshot(dir)), true);
    assert.equal(shouldIgnore(path.join('.atris', 'state', '_sync.json')), true);
    assert.equal(shouldIgnore(path.join('atris', 'MAP.md')), false);
  } finally {
    cleanupTempDir(dir);
  }
});


// ============================================
// push
// ============================================

test('push source resolver keeps pulled business folder as root', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, '.atris'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.atris', 'business.json'), JSON.stringify({ slug: 'example-co' }), 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'MAP.md'), '# Map\n', 'utf8');

    assert.equal(
      resolvePushSourceDir({ slug: 'example-co', cwd: dir, argv: ['node', 'atris', 'push', 'example-co'] }),
      dir
    );
  } finally {
    cleanupTempDir(dir);
  }
});


test('push source resolver honors explicit --from path', () => {
  const dir = makeTempDir();
  try {
    const source = path.join(dir, 'custom-root');
    fs.mkdirSync(source, { recursive: true });

    assert.equal(
      resolvePushSourceDir({ slug: 'example-co', cwd: dir, argv: ['node', 'atris', 'push', 'example-co', '--from', './custom-root'] }),
      source
    );
  } finally {
    cleanupTempDir(dir);
  }
});


test('push ignores dotfile basenames when considering cloud deletes', () => {
  assert.equal(basenameOfManifestPath('/journal/.gitkeep'), '.gitkeep');
  assert.equal(basenameOfManifestPath('/atris/MAP.md'), 'MAP.md');
});


test('sync hash walker keeps dot-directory workspace files without scanning state dirs', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.next', 'cache'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.git', 'objects'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'build'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'tmp'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.github', 'workflows', 'ci.yml'), 'name: ci\n', 'utf8');
    fs.writeFileSync(path.join(dir, '.claude', 'settings.local.json'), '{"private":true}\n', 'utf8');
    fs.writeFileSync(path.join(dir, '.next', 'cache', 'artifact.txt'), 'ignored\n', 'utf8');
    fs.writeFileSync(path.join(dir, '.git', 'config'), 'ignored\n', 'utf8');
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'tasks.json'), 'ignored\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'dist', 'app.js'), 'ignored\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'build', 'app.js'), 'ignored\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'tmp', 'scratch.md'), 'ignored\n', 'utf8');
    fs.writeFileSync(path.join(dir, '.env'), 'ignored\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'assets', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]));

    const hashes = computeLocalHashes(dir);
    assert.ok(hashes['/.github/workflows/ci.yml']);
    assert.ok(hashes['/README.md']);
    assert.equal(hashes['/.claude/settings.local.json'], undefined);
    assert.equal(hashes['/.next/cache/artifact.txt'], undefined);
    assert.equal(hashes['/.git/config'], undefined);
    assert.equal(hashes['/.atris/state/tasks.json'], undefined);
    assert.equal(hashes['/dist/app.js'], undefined);
    assert.equal(hashes['/build/app.js'], undefined);
    assert.equal(hashes['/tmp/scratch.md'], undefined);
    assert.equal(hashes['/.env'], undefined);
    assert.equal(hashes['/assets/logo.png'], undefined);
  } finally {
    cleanupTempDir(dir);
  }
});


test('sync comparison filters ignored generated paths from remote and manifest', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'wiki'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'wiki', 'doc.md'), 'hello\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'dist', 'app.js'), 'generated\n', 'utf8');

    const localFiles = computeLocalHashes(dir);
    const doc = localFiles['/atris/wiki/doc.md'];
    const legacyManifest = {
      files: {
        '/atris/wiki/doc.md': doc,
        '/dist/app.js': { hash: 'old-generated', size: 9 },
      },
    };
    const remoteFiles = {
      '/atris/wiki/doc.md': doc,
      '/dist/app.js': { hash: 'remote-generated', size: 10 },
    };

    const diff = threeWayCompare(localFiles, remoteFiles, legacyManifest);
    assert.deepEqual(diff.deletedLocal, []);
    assert.deepEqual(diff.conflicts, []);
    assert.deepEqual(diff.unchanged, ['/atris/wiki/doc.md']);

    const manifest = buildManifest(remoteFiles, 'commit123', { workspaceRoot: dir });
    assert.equal(manifest.files['/dist/app.js'], undefined);
    assert.deepEqual(Object.keys(manifest.files), ['/atris/wiki/doc.md']);
  } finally {
    cleanupTempDir(dir);
  }
});


test('push normalizes cloud snapshot paths before drift checks', () => {
  assert.deepEqual(buildCloudHashMap([
    { path: 'atris/wiki/a.md', hash: 'one' },
    { path: '/README.md', hash: 'two' },
  ]), {
    '/atris/wiki/a.md': 'one',
    '/README.md': 'two',
  });
});


test('push planner publishes only scoped local brain creates and updates', () => {
  const plan = buildPushChangePlan({
    onlyPrefixes: ['/atris/'],
    baseFiles: {
      '/atris/wiki/existing.md': { hash: 'base', size: 4 },
      '/README.md': { hash: 'outside-base', size: 12 },
    },
    localFiles: {
      '/atris/wiki/existing.md': { hash: 'changed', size: 7 },
      '/atris/wiki/new.md': { hash: 'new', size: 3 },
      '/README.md': { hash: 'outside-changed', size: 15 },
    },
    readFileContent: (filePath) => `content:${filePath}`,
  });

  assert.deepEqual(plan.filesToPush.map(file => file.path).sort(), [
    '/atris/wiki/existing.md',
    '/atris/wiki/new.md',
  ]);
  assert.equal(plan.filesToPush[0].content.startsWith('content:/atris/'), true);
  assert.deepEqual(plan.deletedPaths, []);
  assert.equal(plan.unchangedCount, 0);
});


test('push planner reports unchanged scoped files when already up to date', () => {
  const plan = buildPushChangePlan({
    onlyPrefixes: ['/atris/wiki/'],
    baseFiles: {
      '/atris/wiki/index.md': { hash: 'same', size: 10 },
      '/atris/TODO.md': { hash: 'outside', size: 8 },
    },
    localFiles: {
      '/atris/wiki/index.md': { hash: 'same', size: 10 },
      '/atris/TODO.md': { hash: 'changed-outside', size: 14 },
    },
    readFileContent: () => '',
  });

  assert.deepEqual(plan.filesToPush, []);
  assert.deepEqual(plan.deletedPaths, []);
  assert.equal(plan.unchangedCount, 1);
});


test('push planner treats scoped local deletes as gated deletes and ignores parent junk', () => {
  const plan = buildPushChangePlan({
    onlyPrefixes: ['/atris/'],
    baseFiles: {
      '/atris/wiki/delete-me.md': { hash: 'base', size: 4 },
      '/atris/.shadow': { hash: 'dot', size: 3 },
      '/TODO.md': { hash: 'parent', size: 6 },
    },
    localFiles: {
      '/TODO.md': { hash: 'parent-changed', size: 9 },
    },
    readFileContent: () => '',
  });

  assert.deepEqual(plan.filesToPush, []);
  assert.deepEqual(plan.deletedPaths, ['/atris/wiki/delete-me.md']);
  assert.equal(plan.unchangedCount, 0);
});


test('push planner ignores stale manifest entries from skipped local dirs', () => {
  const plan = buildPushChangePlan({
    baseFiles: {
      '/dist/app.js': { hash: 'old-dist', size: 9 },
      '/build/app.js': { hash: 'old-build', size: 10 },
      '/tmp/scratch.md': { hash: 'old-tmp', size: 11 },
      '/.atris/state/tasks.projection.json': { hash: 'old-state', size: 12 },
      '/assets/logo.png': { hash: 'old-binary', size: 12 },
      '/atris/wiki/delete-me.md': { hash: 'base', size: 4 },
    },
    localFiles: {},
    readFileContent: () => '',
    isLocalFilePresent: (filePath) => filePath === '/assets/logo.png',
  });

  assert.deepEqual(plan.filesToPush, []);
  assert.deepEqual(plan.deletedPaths, ['/atris/wiki/delete-me.md']);
});


test('push retries multi-file server failures individually but not access or sleeping states', () => {
  assert.equal(shouldRetrySyncIndividually({ ok: false, status: 500 }, [{ path: '/a.md' }, { path: '/b.md' }]), true);
  assert.equal(shouldRetrySyncIndividually({ ok: false, status: 502 }, [{ path: '/a.md' }, { path: '/b.md' }]), true);
  assert.equal(shouldRetrySyncIndividually({ ok: false, status: 500 }, [{ path: '/a.md' }]), false);
  assert.equal(shouldRetrySyncIndividually({ ok: false, status: 403 }, [{ path: '/a.md' }, { path: '/b.md' }]), false);
  assert.equal(shouldRetrySyncIndividually({ ok: false, status: 409 }, [{ path: '/a.md' }, { path: '/b.md' }]), false);
  assert.equal(shouldRetrySyncIndividually({ ok: true, status: 200 }, [{ path: '/a.md' }, { path: '/b.md' }]), false);
});


test('push safety blocks nested workspace pollution and sync artifacts', () => {
  const report = analyzePushSafety({
    slug: 'acme',
    filesToPush: [
      { path: '/acme/atris/now.md' },
      { path: '/CLAUDE.md.remote' },
    ],
    unchangedCount: 30,
  });

  assert.equal(report.ok, false);
  assert.match(report.reasons.join('\n'), /nested workspace folder/);
  assert.match(report.reasons.join('\n'), /sync review artifacts/);
});


test('push safety blocks large unscoped dirty workspace plans', () => {
  const report = analyzePushSafety({
    slug: 'acme',
    filesToPush: Array.from({ length: 30 }, (_, i) => ({ path: `/atris/wiki/file-${i}.md` })),
    unchangedCount: 296,
  });

  assert.equal(report.ok, false);
  assert.match(report.reasons.join('\n'), /large unscoped workspace change/);
});


test('push safety allows exact scoped repair pushes', () => {
  const report = analyzePushSafety({
    slug: 'acme',
    onlyPrefixes: ['/atris/now.md'],
    filesToPush: [{ path: '/atris/now.md' }],
    unchangedCount: 1,
  });

  assert.equal(report.ok, true);
});


test('business workspace root detection requires .atris binding and atris folder', () => {
  const dir = makeTempDir();
  try {
    assert.equal(isBusinessWorkspaceRoot(dir), false);
    fs.mkdirSync(path.join(dir, '.atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.atris', 'business.json'), '{}', 'utf8');
    assert.equal(isBusinessWorkspaceRoot(dir), false);
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(isBusinessWorkspaceRoot(dir), true);
  } finally {
    cleanupTempDir(dir);
  }
});


test('manifest records workspace root metadata', () => {
  const manifest = buildManifest({ '/atris/MAP.md': { hash: 'abc', size: 3 } }, 'commit123', {
    workspaceRoot: '/tmp/example-co',
  });

  assert.equal(manifest.workspace_root, '/tmp/example-co');
  assert.equal(manifest.last_commit, 'commit123');
  assert.equal(manifest.files['/atris/MAP.md'].hash, 'abc');
});


test('business sync plan pulls safely then pushes wiki scope through normal push', () => {
  const options = parseBusinessSyncArgs(['example-co']);
  assert.deepEqual(options, {
    slug: 'example-co',
    dryRun: false,
    timeout: '120',
    allowDelete: false,
    watch: false,
    intervalSec: 60,
    debounceSec: 5,
    status: false,
    review: false,
    resolve: null,
    resolvePath: null,
    take: null,
    showOrphans: false,
    help: false,
  });
  assert.deepEqual(buildBusinessSyncPlan(options), {
    pullArgs: ['pull', 'example-co', '--keep-local', '--fail-on-conflict', '--timeout', '120'],
    pushArgs: ['push', 'example-co'],
  });
});


test('business sync auto-detects slug from business workspace', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, '.atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.atris', 'business.json'), JSON.stringify({ slug: 'example-co' }), 'utf8');
    const options = resolveBusinessSyncOptions(['--dry-run'], dir);
    assert.equal(options.slug, 'example-co');
    assert.equal(options.dryRun, true);
  } finally {
    cleanupTempDir(dir);
  }
});


test('business sync plan supports dry-run and explicit delete opt-in', () => {
  const options = parseBusinessSyncArgs(['example-co', '--timeout', '240', '--dry-run', '--delete', '--watch', '--interval=30', '--debounce', '2']);
  assert.equal(options.watch, true);
  assert.equal(options.intervalSec, 30);
  assert.equal(options.debounceSec, 2);
  assert.equal(options.status, false);
  assert.equal(options.review, false);
  assert.equal(options.resolve, null);
  assert.equal(options.help, false);
  assert.deepEqual(buildBusinessSyncPlan(options), {
    pullArgs: ['pull', 'example-co', '--keep-local', '--fail-on-conflict', '--timeout', '240', '--dry-run'],
    pushArgs: ['push', 'example-co', '--dry-run', '--delete'],
  });
});


test('business sync resolve applies local or cloud conflict artifacts to workspace files', () => {
  const dir = makeTempDir();
  try {
    const conflictRoot = path.join(dir, '.atris', 'sync', 'conflicts', '2026-05-01T12-00-00Z');
    const packetDir = path.join(conflictRoot, 'atris', 'wiki');

    function writePacket(overrides = {}) {
      const packet = {
        aBase: 'base copy\n',
        aLocal: 'local copy\n',
        aRemote: 'cloud copy\n',
        readmeBase: 'base readme\n',
        readmeLocal: 'local readme\n',
        readmeRemote: 'cloud readme\n',
        ...overrides,
      };
      fs.rmSync(conflictRoot, { recursive: true, force: true });
      fs.mkdirSync(packetDir, { recursive: true });
      fs.writeFileSync(path.join(packetDir, 'a.md.base'), packet.aBase, 'utf8');
      fs.writeFileSync(path.join(packetDir, 'a.md.local'), packet.aLocal, 'utf8');
      fs.writeFileSync(path.join(packetDir, 'a.md.remote'), packet.aRemote, 'utf8');
      fs.writeFileSync(path.join(conflictRoot, 'README.md.base'), packet.readmeBase, 'utf8');
      fs.writeFileSync(path.join(conflictRoot, 'README.md.local'), packet.readmeLocal, 'utf8');
      fs.writeFileSync(path.join(conflictRoot, 'README.md.remote'), packet.readmeRemote, 'utf8');
      fs.writeFileSync(path.join(conflictRoot, 'summary.md'), '# Review\n', 'utf8');
      fs.mkdirSync(path.join(dir, 'atris', 'wiki'), { recursive: true });
      for (const rel of ['atris/wiki/a.md.remote', 'atris/wiki/a.md.local', 'README.md.remote']) {
        fs.writeFileSync(path.join(dir, rel), 'workspace sidecar\n', 'utf8');
      }
    }

    writePacket();
    const entries = collectConflictResolutionEntries(dir);
    assert.deepEqual(entries.map((entry) => entry.targetRel).sort(), ['README.md', 'atris/wiki/a.md']);

    const local = resolveLatestConflict(dir, 'local');
    assert.deepEqual(local.resolved.sort(), ['README.md', 'atris/wiki/a.md']);
    assert.equal(fs.readFileSync(path.join(dir, 'atris', 'wiki', 'a.md'), 'utf8'), 'local copy\n');
    assert.equal(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), 'local readme\n');
    assert.equal(fs.existsSync(path.join(dir, 'atris', 'wiki', 'a.md.remote')), false);
    assert.equal(fs.existsSync(path.join(dir, 'atris', 'wiki', 'a.md.local')), false);
    assert.equal(fs.existsSync(path.join(dir, 'README.md.remote')), false);
    assert.equal(fs.existsSync(path.join(conflictRoot, 'summary.md')), false);

    writePacket();
    const cloud = resolveLatestConflict(dir, 'cloud');
    assert.deepEqual(cloud.resolved.sort(), ['README.md', 'atris/wiki/a.md']);
    assert.equal(fs.readFileSync(path.join(dir, 'atris', 'wiki', 'a.md'), 'utf8'), 'cloud copy\n');
    assert.equal(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), 'cloud readme\n');
    assert.match(cloud.message, /atris sync --dry-run/);

    writePacket();
    const both = resolveLatestConflict(dir, 'both');
    assert.deepEqual(both.resolved.sort(), ['README.md', 'atris/wiki/a.md']);
    assert.equal(fs.readFileSync(path.join(dir, 'atris', 'wiki', 'a.md'), 'utf8'), 'local copy\n');
    assert.equal(fs.readFileSync(path.join(dir, 'atris', 'wiki', 'a.md.cloud'), 'utf8'), 'cloud copy\n');
    assert.equal(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), 'local readme\n');
    assert.equal(fs.readFileSync(path.join(dir, 'README.md.cloud'), 'utf8'), 'cloud readme\n');
    assert.match(both.message, /both versions/);

    writePacket({
      aBase: 'A\nB\nC\n',
      aLocal: 'A\nB local\nC\n',
      aRemote: 'A\nB\nC cloud\n',
      readmeBase: 'A\nB\nC\n',
      readmeLocal: 'A\nB local\nC\n',
      readmeRemote: 'A\nB\nC cloud\n',
    });
    const merge = resolveLatestConflict(dir, 'merge');
    assert.deepEqual(merge.resolved.sort(), ['README.md', 'atris/wiki/a.md']);
    assert.equal(fs.readFileSync(path.join(dir, 'atris', 'wiki', 'a.md'), 'utf8'), 'A\nB local\nC cloud\n');
    assert.equal(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), 'A\nB local\nC cloud\n');
    assert.match(merge.message, /safe merge/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('business sync safe merge refuses overlapping conflict artifacts', () => {
  const merge = safeLineMerge(
    'A\nB\nC\n',
    'A\nlocal B\nC\n',
    'A\ncloud B\nC\n'
  );
  assert.equal(merge.ok, false);
  assert.match(merge.reason, /overlap/);
});


test('business sync markdown merge accepts different section edits', () => {
  const base = '# Ops\n\n## Sales\n\nOld sales.\n\nMiddle note.\n\n## Support\n\nOld support.\n';
  const local = '# Ops\n\n## Sales\n\nNew sales.\n\nMiddle note.\n\n## Support\n\nOld support.\n';
  const remote = '# Ops\n\n## Sales\n\nOld sales.\n\nMiddle note changed.\n\n## Support\n\nNew support.\n';

  const merge = safeMarkdownMerge(base, local, remote);
  assert.equal(merge.ok, true);
  assert.equal(merge.content, '# Ops\n\n## Sales\n\nNew sales.\n\nMiddle note changed.\n\n## Support\n\nNew support.\n');
});


test('business sync markdown merge refuses same section edits', () => {
  const base = '# Ops\n\n## Sales\n\nOld sales.\n';
  const local = '# Ops\n\n## Sales\n\nLocal sales.\n';
  const remote = '# Ops\n\n## Sales\n\nCloud sales.\n';

  const merge = safeMarkdownMerge(base, local, remote);
  assert.equal(merge.ok, false);
  assert.match(merge.reason, /sales/);
});


test('business sync resolve command is local-only and works without credentials', () => {
  const dir = makeTempDir();
  try {
    const packetDir = path.join(dir, '.atris', 'sync', 'conflicts', '2026-05-01T12-00-00Z', 'atris', 'wiki');
    fs.mkdirSync(packetDir, { recursive: true });
    fs.mkdirSync(path.join(dir, '.atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.atris', 'business.json'), JSON.stringify({ slug: 'example-co' }), 'utf8');
    fs.writeFileSync(path.join(packetDir, 'a.md.base'), 'A\nB\nC\n', 'utf8');
    fs.writeFileSync(path.join(packetDir, 'a.md.local'), 'A\nB local\nC\n', 'utf8');
    fs.writeFileSync(path.join(packetDir, 'a.md.remote'), 'A\nB\nC cloud\n', 'utf8');
    fs.writeFileSync(path.join(dir, '.atris', 'sync', 'conflicts', '2026-05-01T12-00-00Z', 'summary.md'), '# Review\n', 'utf8');

    const res = runCli(['sync', '--resolve', 'merge'], { cwd: dir, env: { ATRIS_TOKEN: '' } });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Resolved 1 conflict/);
    assert.match(res.stdout, /safe merge/);
    assert.equal(fs.readFileSync(path.join(dir, 'atris', 'wiki', 'a.md'), 'utf8'), 'A\nB local\nC cloud\n');
  } finally {
    cleanupTempDir(dir);
  }
});


test('business sync resolve can target one conflict path at a time', () => {
  const dir = makeTempDir();
  try {
    const conflictRoot = path.join(dir, '.atris', 'sync', 'conflicts', '2026-05-01T12-00-00Z');
    const packetDir = path.join(conflictRoot, 'atris', 'wiki');
    fs.mkdirSync(packetDir, { recursive: true });
    fs.writeFileSync(path.join(conflictRoot, 'summary.md'), '# Review\n', 'utf8');
    fs.writeFileSync(path.join(packetDir, 'a.md.local'), 'a local\n', 'utf8');
    fs.writeFileSync(path.join(packetDir, 'a.md.remote'), 'a cloud\n', 'utf8');
    fs.writeFileSync(path.join(packetDir, 'b.md.local'), 'b local\n', 'utf8');
    fs.writeFileSync(path.join(packetDir, 'b.md.remote'), 'b cloud\n', 'utf8');

    const cloud = runCli(['sync', '--resolve', 'cloud', '--path', 'atris/wiki/a.md'], { cwd: dir, env: { ATRIS_TOKEN: '' } });
    assert.equal(cloud.status, 0, cloud.stderr);
    assert.match(cloud.stdout, /Resolved 1 conflict/);
    assert.match(cloud.stdout, /atris\/wiki\/a\.md/);
    assert.doesNotMatch(cloud.stdout, /atris\/wiki\/b\.md/);
    assert.equal(fs.readFileSync(path.join(dir, 'atris', 'wiki', 'a.md'), 'utf8'), 'a cloud\n');
    assert.equal(fs.existsSync(path.join(packetDir, 'a.md.local')), false);
    assert.equal(fs.existsSync(path.join(packetDir, 'a.md.remote')), false);
    assert.ok(fs.existsSync(path.join(packetDir, 'b.md.local')));
    assert.ok(fs.existsSync(path.join(conflictRoot, 'summary.md')));
    assert.match(renderLatestConflictReview(dir), /Latest sync conflict review/);

    const local = runCli(['sync', '--resolve', 'local', '--path', 'atris/wiki/b.md'], { cwd: dir, env: { ATRIS_TOKEN: '' } });
    assert.equal(local.status, 0, local.stderr);
    assert.match(local.stdout, /Resolved 1 conflict/);
    assert.match(local.stdout, /atris\/wiki\/b\.md/);
    assert.equal(fs.readFileSync(path.join(dir, 'atris', 'wiki', 'b.md'), 'utf8'), 'b local\n');
    assert.equal(fs.existsSync(path.join(conflictRoot, 'summary.md')), false);
    assert.equal(renderLatestConflictReview(dir), 'No sync conflicts need review.\n');
  } finally {
    cleanupTempDir(dir);
  }
});


test('business sync final resolve records pending pull manifest', () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  try {
    const conflictRoot = path.join(dir, '.atris', 'sync', 'conflicts', '2026-05-01T12-00-00Z');
    const packetDir = path.join(conflictRoot, 'atris', 'wiki');
    fs.mkdirSync(packetDir, { recursive: true });
    fs.mkdirSync(path.join(dir, '.atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.atris', 'business.json'), JSON.stringify({ slug: 'acme' }), 'utf8');
    fs.writeFileSync(path.join(conflictRoot, 'summary.md'), '# Review\n', 'utf8');
    fs.writeFileSync(path.join(packetDir, 'a.md.local'), 'a local\n', 'utf8');
    fs.writeFileSync(path.join(packetDir, 'a.md.remote'), 'a cloud\n', 'utf8');
    fs.writeFileSync(path.join(packetDir, 'b.md.local'), 'b local\n', 'utf8');
    fs.writeFileSync(path.join(packetDir, 'b.md.remote'), 'b cloud\n', 'utf8');
    fs.writeFileSync(path.join(conflictRoot, 'manifest.json'), `${JSON.stringify({
      slug: 'acme',
      manifest: {
        last_sync: '2026-05-01T12:00:00.000Z',
        last_commit: 'commit123',
        workspace_root: dir,
        files: {
          '/atris/wiki/a.md': { hash: 'cloud-a', size: 8 },
          '/atris/wiki/b.md': { hash: 'cloud-b', size: 8 },
        },
      },
      baseContents: {
        '/atris/wiki/a.md': 'a cloud\n',
        '/atris/wiki/b.md': 'b cloud\n',
      },
      deletedRemote: ['/atris/wiki/old.md'],
    }, null, 2)}\n`, 'utf8');
    const oldBase = path.join(dir, '.atris', 'sync', 'base', 'atris', 'wiki', 'old.md');
    fs.mkdirSync(path.dirname(oldBase), { recursive: true });
    fs.writeFileSync(oldBase, 'old base\n', 'utf8');

    const first = runCli(['sync', '--resolve', 'cloud', '--path', 'atris/wiki/a.md'], { cwd: dir, env: { HOME: home, ATRIS_TOKEN: '' } });
    assert.equal(first.status, 0, first.stderr);
    assert.ok(fs.existsSync(path.join(conflictRoot, 'summary.md')));
    assert.equal(fs.existsSync(path.join(home, '.atris', 'businesses', 'acme', 'manifest.json')), false);

    const second = runCli(['sync', '--resolve', 'local', '--path', 'atris/wiki/b.md'], { cwd: dir, env: { HOME: home, ATRIS_TOKEN: '' } });
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /Updated sync manifest for acme/);
    assert.equal(fs.existsSync(path.join(conflictRoot, 'summary.md')), false);
    const manifest = JSON.parse(fs.readFileSync(path.join(home, '.atris', 'businesses', 'acme', 'manifest.json'), 'utf8'));
    assert.equal(manifest.files['/atris/wiki/a.md'].hash, 'cloud-a');
    assert.equal(manifest.files['/atris/wiki/b.md'].hash, 'cloud-b');
    assert.equal(fs.readFileSync(path.join(dir, '.atris', 'sync', 'base', 'atris', 'wiki', 'a.md'), 'utf8'), 'a cloud\n');
    assert.equal(fs.readFileSync(path.join(dir, '.atris', 'sync', 'base', 'atris', 'wiki', 'b.md'), 'utf8'), 'b cloud\n');
    assert.equal(fs.existsSync(oldBase), false);
  } finally {
    cleanupTempDir(dir);
  }
});


test('business sync local safety commands do not require business slug detection', () => {
  const dir = makeTempDir();
  try {
    const packetDir = path.join(dir, '.atris', 'sync', 'conflicts', '2026-05-01T12-00-00Z', 'atris', 'wiki');
    fs.mkdirSync(packetDir, { recursive: true });
    fs.mkdirSync(path.join(dir, 'atris', 'wiki'), { recursive: true });
    fs.writeFileSync(path.join(packetDir, 'a.md.local'), 'local copy\n', 'utf8');
    fs.writeFileSync(path.join(packetDir, 'a.md.remote'), 'cloud copy\n', 'utf8');
    fs.writeFileSync(path.join(dir, '.atris', 'sync', 'conflicts', '2026-05-01T12-00-00Z', 'summary.md'), '# Review\n\n- atris/wiki/a.md\n', 'utf8');

    const status = runCli(['sync', '--status'], { cwd: dir, env: { ATRIS_TOKEN: '' } });
    assert.equal(status.status, 0, status.stderr);
    assert.doesNotMatch(status.stdout, /skills updated/);
    assert.match(status.stdout, /business: not detected/);
    assert.match(status.stdout, /conflicts: 1 review packet/);

    const review = runCli(['sync', '--review'], { cwd: dir, env: { ATRIS_TOKEN: '' } });
    assert.equal(review.status, 0, review.stderr);
    assert.doesNotMatch(review.stdout, /skills updated/);
    assert.match(review.stdout, /Latest sync conflict review/);

    const resolve = runCli(['sync', '--resolve', 'both'], { cwd: dir, env: { ATRIS_TOKEN: '' } });
    assert.equal(resolve.status, 0, resolve.stderr);
    assert.doesNotMatch(resolve.stdout, /skills updated/);
    assert.match(resolve.stdout, /both versions/);
    assert.equal(fs.readFileSync(path.join(dir, 'atris', 'wiki', 'a.md'), 'utf8'), 'local copy\n');
    assert.equal(fs.readFileSync(path.join(dir, 'atris', 'wiki', 'a.md.cloud'), 'utf8'), 'cloud copy\n');
  } finally {
    cleanupTempDir(dir);
  }
});


test('business sync review prints the latest conflict packet without cloud calls', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, '.atris', 'sync', 'conflicts', '2026-05-01T12-00-00Z'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.atris', 'sync', 'conflicts', '2026-05-01T12-00-00Z', 'summary.md'), '# Review\n\n- atris/wiki/a.md\n', 'utf8');

    const rendered = renderLatestConflictReview(dir);
    assert.match(rendered, /Latest sync conflict review/);
    assert.match(rendered, /# Review/);
    assert.match(rendered, /atris\/wiki\/a\.md/);
    assert.match(rendered, /atris sync --dry-run/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('business pull conflict packet includes base, local, and remote artifacts', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'wiki'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'wiki', 'a.md'), 'local edit\n', 'utf8');
    writeBaseContents(dir, { '/atris/wiki/a.md': 'base copy\n' });

    const packet = buildPullConflictReviewPacket(
      dir,
      [{ path: '/atris/wiki/a.md', status: 'conflict_updated', action: 'review' }],
      { '/atris/wiki/a.md': 'cloud edit\n' },
      '2026-05-01T12-00-00Z'
    );
    writeConflictReviewPacket(dir, packet);

    const packetDir = path.join(dir, '.atris', 'sync', 'conflicts', '2026-05-01T12-00-00Z', 'atris', 'wiki');
    assert.equal(fs.readFileSync(path.join(packetDir, 'a.md.base'), 'utf8'), 'base copy\n');
    assert.equal(fs.readFileSync(path.join(packetDir, 'a.md.local'), 'utf8'), 'local edit\n');
    assert.equal(fs.readFileSync(path.join(packetDir, 'a.md.remote'), 'utf8'), 'cloud edit\n');
    assert.match(
      fs.readFileSync(path.join(dir, '.atris', 'sync', 'conflicts', '2026-05-01T12-00-00Z', 'summary.md'), 'utf8'),
      /a\.md\.base/
    );
  } finally {
    cleanupTempDir(dir);
  }
});


test('pull normalizes cloud file paths to manifest keys', () => {
  assert.equal(normalizePullFilePath('atris/now.md'), '/atris/now.md');
  assert.equal(normalizePullFilePath('/atris/now.md'), '/atris/now.md');
  assert.equal(normalizePullFilePath('///workspace/sales/notes.md'), '/workspace/sales/notes.md');
  assert.equal(normalizePullFilePath(''), null);
});


test('pull smart merge fails closed when batch omits changed content', () => {
  const merged = mergeSmartPullFiles(
    [
      { path: 'atris/wiki/a.md', hash: 'hash-a', size: 10 },
      { path: 'atris/wiki/b.md', hash: 'hash-b', size: 10 },
    ],
    [
      { path: 'atris/wiki/a.md', content: 'A\n' },
    ],
    ['/atris/wiki/a.md', '/atris/wiki/b.md'],
  );

  assert.equal(merged.ok, false);
  assert.deepEqual(merged.missingContent, ['/atris/wiki/b.md']);

  const complete = mergeSmartPullFiles(
    [
      { path: 'atris/wiki/a.md', hash: 'hash-a', size: 10 },
      { path: 'atris/wiki/b.md', hash: 'hash-b', size: 10 },
    ],
    [
      { path: 'atris/wiki/a.md', content: 'A\n' },
      { path: 'atris/wiki/b.md', content: '' },
    ],
    ['/atris/wiki/a.md', '/atris/wiki/b.md'],
  );
  assert.equal(complete.ok, true);
  assert.equal(complete.files[1].content, '');
});


test('business sync review command is local-only and works without credentials', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, '.atris', 'sync', 'conflicts', '2026-05-01T12-00-00Z'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.atris', 'business.json'), JSON.stringify({ slug: 'example-co' }), 'utf8');
    fs.writeFileSync(path.join(dir, '.atris', 'sync', 'conflicts', '2026-05-01T12-00-00Z', 'summary.md'), '# Review\n\n- atris/wiki/a.md\n', 'utf8');

    const res = runCli(['sync', '--review'], { cwd: dir, env: { ATRIS_TOKEN: '' } });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Latest sync conflict review/);
    assert.match(res.stdout, /# Review/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('business sync status renders a nonengineer-safe local brain readout', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, '.atris'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'atris', 'wiki'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.atris', 'sync', 'conflicts', '2026-05-01T12-00-00Z'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.atris', 'business.json'), JSON.stringify({ slug: 'example-co' }), 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'wiki', 'index.md'), '# Index\n', 'utf8');
    fs.writeFileSync(path.join(dir, '.atris', 'sync', 'conflicts', '2026-05-01T12-00-00Z', 'summary.md'), '# Review\n', 'utf8');
    writeSyncStatus(dir, { slug: 'example-co', state: 'current', mode: 'watch' });

    const status = collectLocalSyncStatus(dir, { slug: 'example-co' });
    assert.equal(status.slug, 'example-co');
    assert.equal(status.brainExists, true);
    assert.equal(status.brainFileCount, 1);
    assert.equal(status.conflictCount, 1);
    assert.match(status.latestConflict, /summary\.md$/);

    const rendered = renderLocalSyncStatus(status);
    assert.match(rendered, /Business workspace sync status/);
    assert.match(rendered, /business: example-co/);
    assert.match(rendered, /workspace: 1 file \(atris\/ present\)/);
    assert.match(rendered, /conflicts: 1 review packet/);
    assert.match(rendered, /warnings: none/);
    assert.match(rendered, /watcher: last heartbeat/);
    assert.match(rendered, /atris sync --dry-run/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('business sync status warns about nested workspace pollution', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'acme', 'atris'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'acme', 'atris', 'now.md'), '# now\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'CLAUDE.md.remote'), 'cloud copy\n', 'utf8');

    const warnings = collectWorkspaceWarnings(dir, 'acme');
    assert.equal(warnings.length, 2);
    assert.match(warnings[0], /nested workspace folder: acme\//);
    assert.match(warnings[1], /sync review artifacts/);

    const rendered = renderLocalSyncStatus({
      slug: 'acme',
      cwd: dir,
      workspaceFileCount: 3,
      brainExists: true,
      lastSync: null,
      manifestRoot: dir,
      manifestRootMatches: true,
      conflictCount: 0,
      warnings,
    });
    assert.match(rendered, /warnings: 2/);
    assert.match(rendered, /nested workspace folder/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('business sync status command is local-only and works without credentials', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, '.atris'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'atris', 'wiki'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.atris', 'business.json'), JSON.stringify({ slug: 'example-co' }), 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'wiki', 'index.md'), '# Index\n', 'utf8');

    const res = runCli(['sync', '--status'], { cwd: dir, env: { ATRIS_TOKEN: '' } });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Business workspace sync status/);
    assert.match(res.stdout, /business: example-co/);
    assert.match(res.stdout, /Next: run `atris sync --dry-run`/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('business sync help is read-only and names the safety gates', () => {
  const help = renderBusinessSyncHelp();
  assert.match(help, /Pull -> Review -> Publish/);
  assert.match(help, /Large unscoped pushes/);

  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, '.atris'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.atris', 'business.json'), JSON.stringify({ slug: 'example-co' }), 'utf8');

    const res = runCli(['sync', '--help'], { cwd: dir, env: { ATRIS_TOKEN: '' } });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Usage: atris sync/);
    assert.match(res.stdout, /Pull -> Review -> Publish/);
    assert.doesNotMatch(res.stdout, /Syncing .* business workspace/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('business sync watch failures retry instead of killing the alive loop', () => {
  const transient = describeWatchFailure(new Error('network timeout'));
  assert.equal(transient.state, 'retrying');
  assert.match(transient.detail, /still running/);

  const conflictErr = new Error('atris pull example-co exited 2');
  conflictErr.status = 2;
  const conflict = describeWatchFailure(conflictErr);
  assert.equal(conflict.state, 'conflict');
  assert.match(conflict.detail, /review packet/);
});


test('business sync watch snapshot detects workspace changes and ignores runtime state', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'wiki'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'workspace', 'sales'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'wiki', 'a.md'), 'one\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'workspace', 'sales', 'notes.md'), 'one\n', 'utf8');
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'ignored.json'), '{}', 'utf8');

    const before = collectBrainSnapshot(dir);
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'ignored.json'), '{"x":1}', 'utf8');
    assert.equal(brainSnapshotsDiffer(before, collectBrainSnapshot(dir)), false);

    fs.writeFileSync(path.join(dir, 'atris', 'wiki', 'a.md'), 'two longer\n', 'utf8');
    assert.equal(brainSnapshotsDiffer(before, collectBrainSnapshot(dir)), true);

    const afterAtris = collectBrainSnapshot(dir);
    fs.writeFileSync(path.join(dir, 'workspace', 'sales', 'notes.md'), 'two longer\n', 'utf8');
    assert.equal(brainSnapshotsDiffer(afterAtris, collectBrainSnapshot(dir)), true);
  } finally {
    cleanupTempDir(dir);
  }
});


test('business sync watch ignore rules skip runtime and OS files', () => {
  assert.equal(shouldIgnoreWatchPath(path.join('.atris', 'state.json')), true);
  assert.equal(shouldIgnoreWatchPath(path.join('.next', 'cache', 'bundle.js')), true);
  assert.equal(shouldIgnoreWatchPath(path.join('dist', 'bundle.js')), true);
  assert.equal(shouldIgnoreWatchPath(path.join('venv', 'bin', 'python')), true);
  assert.equal(shouldIgnoreWatchPath('.DS_Store'), true);
  assert.equal(shouldIgnoreWatchPath(path.join('wiki', 'index.md')), false);
});


test('business sync push preview is skipped when manifest belongs to another folder', () => {
  const dir = makeTempDir();
  try {
    assert.equal(canPreviewPush(dir, 'definitely-missing-test-business'), true);
  } finally {
    cleanupTempDir(dir);
  }
});


test('brain compile writes loadable status and ledger artifacts', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    const res = runCli(['brain', 'compile', '--yes', '--root', dir, '--verify'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Atris brain compiled/);
    assert.match(res.stdout, /State rows: 1 raw \/ 1 valid/);
    assert.equal(fs.existsSync(path.join(dir, 'atris', 'brain', 'STATUS.md')), true);
    assert.equal(fs.existsSync(path.join(dir, 'atris', 'brain', 'self_improvement_ledger.md')), true);
    assert.equal(fs.existsSync(path.join(dir, 'atris', 'now.md')), true);
    const status = fs.readFileSync(path.join(dir, 'atris', 'brain', 'STATUS.md'), 'utf8');
    assert.match(status, /Now loaded: yes \(now\)/);
    assert.match(status, /atris\/MAP\.md/);
    assert.match(status, /atris\/TODO\.md/);
    assert.doesNotMatch(status, /sync-language\.md|activation\/SKILL\.md/);
    assert.match(status, /First-message rule/);
    assertAdvertisedAtrisPathsExist(dir, status);
    const agents = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
    assert.match(agents, /Atris Brain Compile/);
    assert.doesNotMatch(agents, /sync-language\.md|activation\/SKILL\.md/);
    assertAdvertisedAtrisPathsExist(dir, agents);
    const state = collectState(dir);
    assert.equal(state.totalRows, 1);
    assert.equal(state.validRows, 1);
    assert.equal(state.hasNow, true);
  } finally {
    cleanupTempDir(dir);
  }
});


test('brain compile includes chat scan load pointer when present', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'chat_scan.latest.json'), JSON.stringify({
      generated_at: '2026-06-28T00:00:00.000Z',
      next_command: 'atris member wake auto-improver --execute --confirm-autonomy-policy',
    }) + '\n', 'utf8');
    const res = runCli(['brain', 'compile', '--yes', '--root', dir, '--verify'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    const claude = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
    assert.match(claude, /`\.atris\/state\/chat_scan\.latest\.json`/);
    const agents = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
    assert.match(agents, /`\.atris\/state\/chat_scan\.latest\.json`/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('brain compile includes primary checkout chat scan pointer from worktrees', () => {
  const dir = makeTempDir();
  let worktreePath;
  try {
    seedBrainWorkspace(dir);
    assert.equal(runGit(['init', '-b', 'main'], dir).status, 0);
    assert.equal(runGit(['config', 'user.email', 'test@example.com'], dir).status, 0);
    assert.equal(runGit(['config', 'user.name', 'Test User'], dir).status, 0);
    assert.equal(runGit(['add', '.'], dir).status, 0);
    assert.equal(runGit(['commit', '-m', 'seed'], dir).status, 0);
    fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'chat_scan.latest.json'), JSON.stringify({
      generated_at: '2026-06-28T00:00:00.000Z',
      next_command: 'atris member wake auto-improver --execute --confirm-autonomy-policy',
    }) + '\n', 'utf8');
    worktreePath = path.join(dir, '..', `${path.basename(dir)}-brain-load-order-worktree`);
    assert.equal(runGit(['worktree', 'add', '-q', '--detach', worktreePath, 'HEAD'], dir).status, 0);

    const res = runCli(['brain', 'compile', '--yes', '--root', worktreePath, '--verify'], { cwd: worktreePath });
    assert.equal(res.status, 0, res.stderr);
    const agents = fs.readFileSync(path.join(worktreePath, 'AGENTS.md'), 'utf8');
    assert.match(agents, /`\.atris\/state\/chat_scan\.latest\.json`/);
    const status = fs.readFileSync(path.join(worktreePath, 'atris', 'brain', 'STATUS.md'), 'utf8');
    assert.match(status, /`\.atris\/state\/chat_scan\.latest\.json`/);
  } finally {
    if (worktreePath) cleanupTempDir(worktreePath);
    cleanupTempDir(dir);
  }
});


test('brain compile refreshes stale now.md before collecting state', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), [
      '# TODO.md',
      '',
      '## Backlog',
      '',
      '- **[P-1]** Fresh task [probe]',
      '',
    ].join('\n'), 'utf8');
    const today = formatLocalDate(new Date());
    const journalDir = path.join(dir, 'atris', 'logs', today.slice(0, 4));
    fs.mkdirSync(journalDir, { recursive: true });
    fs.writeFileSync(path.join(journalDir, `${today}.md`), [
      '# Log',
      '',
      '## Notes',
      '',
      '- 9:00 am',
      '  Proof: compiled fresh now state.',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'now.md'), [
      '# now',
      '',
      'Last updated: 1999-01-01',
      '',
      'Open TODO items: 0',
      'Completed receipts today: 0',
      '',
    ].join('\n'), 'utf8');

    const res = runCli(['brain', 'compile', '--yes', '--root', dir, '--verify'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    const now = fs.readFileSync(path.join(dir, 'atris', 'now.md'), 'utf8');
    assert.match(now, new RegExp(`Last updated: ${today}`));
    assert.match(now, /Open TODO items: 1/);
    assert.match(now, /Completed receipts today: 1/);
    assert.doesNotMatch(now, /1999-01-01|Open TODO items: 0|Completed receipts today: 0/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('brain compile preserves a custom now.md front door', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    const customNow = [
      '# FairPlay Now',
      '',
      '## What Matters Now',
      '',
      'FairPlay should feel like a playable autonomous org.',
      '',
      '## Current Priority',
      '',
      'Run the overnight readiness gate before deploying tokens.',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'atris', 'now.md'), customNow, 'utf8');

    const res = runCli(['brain', 'compile', '--yes', '--root', dir, '--verify'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);

    const now = fs.readFileSync(path.join(dir, 'atris', 'now.md'), 'utf8');
    assert.equal(now, customNow);

    const status = fs.readFileSync(path.join(dir, 'atris', 'brain', 'STATUS.md'), 'utf8');
    assert.match(status, /Now loaded: yes \(FairPlay Now\)/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('brain compile --json returns machine-readable missing-workspace errors', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['brain', 'compile', '--yes', '--root', dir, '--verify', '--json'], { cwd: dir });
    assert.notEqual(res.status, 0);
    assert.equal(res.stderr, '');
    const body = JSON.parse(res.stdout);
    assert.equal(body.ok, false);
    assert.match(body.error, /atris\/ folder not found/);
    assert.doesNotMatch(res.stdout + res.stderr, /at ensureAtrisDir|Node\.js/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('brain unknown --json returns machine-readable usage errors', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    const res = runCli(['brain', 'nope', '--root', dir, '--json'], { cwd: dir });
    assert.notEqual(res.status, 0);
    assert.equal(res.stderr, '');
    const body = JSON.parse(res.stdout);
    assert.equal(body.ok, false);
    assert.equal(body.error, 'unknown brain subcommand: nope');
    assert.ok(Array.isArray(body.usage));
    assert.ok(body.usage.some(line => line.includes('atris brain compile')));
  } finally {
    cleanupTempDir(dir);
  }
});


test('brain state counts rendered executable TODO rows without counting blocked or completed rows', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), [
      '# TODO.md',
      '',
      '## Backlog',
      '',
      '(Empty)',
      '',
      '## In Progress',
      '',
      '- **[CLI-2]** Active task [brain]',
      '',
      '## Blocked',
      '',
      '- **[CLI-3]** Blocked task [brain]',
      '',
      '## Completed',
      '',
      '- **[CLI-1]** Completed task [brain]',
      '',
    ].join('\n'), 'utf8');

    const state = collectState(dir);

    assert.equal(state.todo.open, 1);
    assert.equal(state.todo.done, 1);
    assert.equal(state.todo.titled, 3);
  } finally {
    cleanupTempDir(dir);
  }
});


test('brain state prefers task projection for executable work counts', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), [
      '# TODO.md',
      '',
      '## Backlog',
      '',
      '(Empty)',
      '',
      '## Blocked',
      '',
      '- **[CLI-3]** Blocked fallback row [brain]',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'tasks.projection.json'), JSON.stringify({
      tasks: [
        { display_id: 'CLI-1', status: 'open' },
        { display_id: 'CLI-2', status: 'claimed' },
        { display_id: 'CLI-3', status: 'blocked' },
        { display_id: 'CLI-4', status: 'review' },
        { display_id: 'CLI-5', status: 'done' },
      ],
    }), 'utf8');

    const state = collectState(dir);

    assert.equal(state.todo.open, 2);
    assert.equal(state.todo.done, 1);
    assert.equal(state.todo.titled, 5);
  } finally {
    cleanupTempDir(dir);
  }
});


test('brain compile counts task review episodes as learning state', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    seedBrainWorkspace(dir);
    fs.rmSync(path.join(dir, '.atris', 'state', 'agent_mail.jsonl'), { force: true });

    const add = runCli(['task', 'add', 'Teach brain about reviewed tasks', '--json'], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const ref = JSON.parse(add.stdout).task.display_id;
    assert.equal(runCli(['task', 'done', ref, '--proof', 'node --test test/commands.test.js passed'], { cwd: dir, env }).status, 0);

    const review = runCli([
      'task', 'review', ref,
      '--reward', '1',
      '--lesson', 'Task episodes should feed brain compile',
      '--proof', 'node --test',
      '--as', 'codex',
    ], { cwd: dir, env });
    assert.equal(review.status, 0, review.stderr);

    const res = runCli(['brain', 'compile', '--yes', '--root', dir, '--verify'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /State rows: \d+ raw \/ \d+ valid/);
    assert.match(res.stdout, /Turn existing episode rows into the first scorecard/);

    const state = JSON.parse(fs.readFileSync(path.join(dir, 'atris', 'brain', 'state.json'), 'utf8'));
    const taskEpisodes = state.stateFiles.find(item => item.path.endsWith('task_episodes.jsonl'));
    assert.equal(taskEpisodes.rows, 2);
    assert.equal(taskEpisodes.validRows, 2);

    const status = fs.readFileSync(path.join(dir, 'atris', 'brain', 'STATUS.md'), 'utf8');
    assert.match(status, /2 episode row\(s\) are available/);
    assert.doesNotMatch(status, /Capture one operator approval/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('brain scorecard derives deduped scorecards from task review episodes', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    seedBrainWorkspace(dir);
    fs.rmSync(path.join(dir, '.atris', 'state', 'agent_mail.jsonl'), { force: true });

    const add = runCli(['task', 'add', 'Score reviewed task episodes', '--tag', 'rsi', '--json'], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const ref = JSON.parse(add.stdout).task.display_id;
    assert.equal(runCli(['task', 'done', ref, '--proof', 'node --test test/commands.test.js passed'], { cwd: dir, env }).status, 0);

    const review = runCli([
      'task', 'review', ref,
      '--reward', '2',
      '--lesson', 'Scorecards need task episode rewards',
      '--proof', 'node --test',
      '--as', 'codex',
    ], { cwd: dir, env });
    assert.equal(review.status, 0, review.stderr);

    const scorecard = runCli(['brain', 'scorecard', '--root', dir, '--verify', '--json'], { cwd: dir });
    assert.equal(scorecard.status, 0, scorecard.stderr);
    const payload = JSON.parse(scorecard.stdout);
    assert.equal(payload.taskEpisodes, 2);
    assert.equal(payload.written, 1);
    assert.equal(payload.scorecards[0].schema, 'atris.brain.task_scorecard.v1');
    assert.equal(payload.scorecards[0].type, 'scorecard');
    assert.equal(payload.scorecards[0].reward, 2);
    assert.equal(payload.scorecards[0].source, 'task_review_episode');
    assert.equal(payload.scorecards[0].task_title, 'Score reviewed task episodes');
    assert.equal(payload.scorecards[0].workspace, 'demo-lab');

    const repeat = runCli(['brain', 'scorecard', '--root', dir, '--verify', '--json'], { cwd: dir });
    assert.equal(repeat.status, 0, repeat.stderr);
    assert.equal(JSON.parse(repeat.stdout).written, 0);

    const compile = runCli(['brain', 'compile', '--yes', '--root', dir, '--verify'], { cwd: dir });
    assert.equal(compile.status, 0, compile.stderr);
    assert.match(compile.stdout, /State rows: \d+ raw \/ \d+ valid/);
    assert.doesNotMatch(compile.stdout, /Turn existing episode rows into the first scorecard/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('brain scorecard carries task landing quality and human outcome', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    seedBrainWorkspace(dir);
    fs.rmSync(path.join(dir, '.atris', 'state', 'agent_mail.jsonl'), { force: true });

    const acceptedAdd = runCli(['task', 'add', 'Landing accepted task', '--tag', 'approval', '--json'], { cwd: dir, env });
    assert.equal(acceptedAdd.status, 0, acceptedAdd.stderr);
    const acceptedRef = JSON.parse(acceptedAdd.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', acceptedRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const acceptedReady = runCli([
      'task', 'ready', acceptedRef,
      '--proof', 'node --check test/commands.test.js passed and diff reviewed',
      '--happened', 'Operators can now read the approval receipt without opening raw proof, saving time at the human gate.',
      '--checked', 'I checked the task page Result block.',
      '--tested', 'I ran the focused regression.',
      '--decision', 'Accept if the receipt is clear.',
      '--as', 'codex',
      '--json',
    ], { cwd: dir, env });
    assert.equal(acceptedReady.status, 0, acceptedReady.stderr);
    const accepted = runCli(['task', 'accept', acceptedRef, '--as', 'keshav', '--json'], { cwd: dir, env });
    assert.equal(accepted.status, 0, accepted.stderr);
    const acceptedPayload = JSON.parse(accepted.stdout);
    assert.equal(acceptedPayload.episode.review_landing.happened, 'Operators can now read the approval receipt without opening raw proof, saving time at the human gate.');
    assert.equal(acceptedPayload.episode.landing_quality.completeness, 1);
    assert.equal(acceptedPayload.episode.human_feedback.approval_status, 'accepted');
    const episodePath = path.join(dir, '.atris', 'state', 'task_episodes.jsonl');
    const episodeRows = fs.readFileSync(episodePath, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
    for (const row of episodeRows) {
      if (row.task_id !== acceptedPayload.task_id) continue;
      delete row.review_landing;
      delete row.landing_quality;
      delete row.human_feedback;
      if (row.rl) {
        delete row.rl.landing_completeness;
        delete row.rl.approval_status;
      }
    }
	    fs.writeFileSync(episodePath, `${episodeRows.map(row => JSON.stringify(row)).join('\n')}\n`, 'utf8');

    const revisedAdd = runCli(['task', 'add', 'Landing reworked task', '--tag', 'approval', '--json'], { cwd: dir, env });
    assert.equal(revisedAdd.status, 0, revisedAdd.stderr);
    const revisedRef = JSON.parse(revisedAdd.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', revisedRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const revisedReady = runCli([
      'task', 'ready', revisedRef,
      '--proof', 'node --check test/commands.test.js passed but receipt was vague',
      '--happened', 'Operators can now inspect the updated result before approval, reducing the risk of accepting vague proof.',
      '--checked', 'I checked something.',
      '--tested', 'I ran tests.',
      '--decision', 'Accept if useful.',
      '--as', 'codex',
      '--json',
    ], { cwd: dir, env });
    assert.equal(revisedReady.status, 0, revisedReady.stderr);
    const revised = runCli(['task', 'revise', revisedRef, '--as', 'keshav', '--note', 'Decision line was too vague', '--json'], { cwd: dir, env });
    assert.equal(revised.status, 0, revised.stderr);
	    const revisedPayload = JSON.parse(revised.stdout);
	    assert.equal(revisedPayload.episode.rl.label, 'rework_requested');
	    assert.equal(revisedPayload.episode.review_landing.decision, 'Accept if useful.');
	    assert.equal(revisedPayload.episode.human_feedback.human_revision_note, 'Decision line was too vague');
	    const scorecardsPath = path.join(dir, '.atris', 'state', 'scorecards.jsonl');
	    const scorecardRows = fs.readFileSync(scorecardsPath, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line))
	      .filter(row => row.task_id !== acceptedPayload.task_id && row.task_id !== revisedPayload.task_id);
	    fs.writeFileSync(scorecardsPath, `${scorecardRows.map(row => JSON.stringify(row)).join('\n')}\n`, 'utf8');

	    const scorecard = runCli(['brain', 'scorecard', '--root', dir, '--verify', '--json'], { cwd: dir });
    assert.equal(scorecard.status, 0, scorecard.stderr);
    const payload = JSON.parse(scorecard.stdout);
    const acceptedCard = payload.scorecards.find(row => row.task_title === 'Landing accepted task');
    const revisedCard = payload.scorecards.find(row => row.task_title === 'Landing reworked task');
    assert.equal(acceptedCard.review_landing.happened, 'Operators can now read the approval receipt without opening raw proof.');
    assert.equal(acceptedCard.review_landing.reason, 'it saves time at the human gate.');
    assert.equal(acceptedCard.landing_quality.completeness, 1);
    assert.equal(acceptedCard.approval_status, 'accepted');
    assert.equal(acceptedCard.rl_label, 'accepted');
    assert.equal(revisedCard.review_landing.decision, 'Accept if useful.');
    assert.equal(revisedCard.human_feedback.human_revision_note, 'Decision line was too vague');
    assert.equal(revisedCard.approval_status, 'revise');
    assert.equal(revisedCard.rl_label, 'rework_requested');
  } finally {
    cleanupTempDir(dir);
  }
});


test('brain scorecard uses latest review episode per task', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    seedBrainWorkspace(dir);
    fs.rmSync(path.join(dir, '.atris', 'state', 'agent_mail.jsonl'), { force: true });

    const add = runCli(['task', 'add', 'Avoid duplicate task scorecards', '--json'], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const ref = JSON.parse(add.stdout).task.display_id;

    const done = runCli(['task', 'done', ref, '--proof', 'first validation passed'], { cwd: dir, env });
    assert.equal(done.status, 0, done.stderr);

    const review = runCli([
      'task', 'review', ref,
      '--reward', '5',
      '--lesson', 'Latest review is the task outcome',
      '--proof', 'final validation passed',
      '--next', 'Draft the Acme Co operator one-pager from the latest recap',
      '--as', 'codex',
    ], { cwd: dir, env });
    assert.equal(review.status, 0, review.stderr);

    const scorecard = runCli(['brain', 'scorecard', '--root', dir, '--verify', '--json'], { cwd: dir });
    assert.equal(scorecard.status, 0, scorecard.stderr);
    const payload = JSON.parse(scorecard.stdout);
    assert.equal(payload.taskEpisodes, 2);
    assert.equal(payload.written, 1);
    assert.equal(payload.scorecards[0].reward, 5);
    assert.equal(payload.scorecards[0].lesson, 'Latest review is the task outcome');
    assert.equal(payload.scorecards[0].proof, 'final validation passed');
    assert.equal(payload.scorecards[0].next_task_suggestion, 'Draft the Acme Co operator one-pager from the latest recap');

    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), '# TODO\n\n## Backlog\n\n(empty)\n', 'utf8');
    const compile = runCli(['brain', 'compile', '--yes', '--root', dir, '--verify'], { cwd: dir });
    assert.equal(compile.status, 0, compile.stderr);
    assert.match(compile.stdout, /Draft the Acme Co operator one-pager from the latest recap/);
    assert.doesNotMatch(compile.stdout, /Run a business loop/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('brain scorecard uses primary checkout state from thin worktrees', () => {
  const dir = makeTempDir();
  let worktreePath;
  try {
    seedBrainWorkspace(dir);
    assert.equal(runGit(['init', '-q'], dir).status, 0);
    assert.equal(runGit(['config', 'user.email', 'test@example.com'], dir).status, 0);
    assert.equal(runGit(['config', 'user.name', 'Test User'], dir).status, 0);
    assert.equal(runGit(['add', '.'], dir).status, 0);
    assert.equal(runGit(['commit', '-qm', 'init'], dir).status, 0);

    worktreePath = path.join(dir, '..', `${path.basename(dir)}-brain-worktree`);
    assert.equal(runGit(['worktree', 'add', '-q', '--detach', worktreePath, 'HEAD'], dir).status, 0);

    const taskEpisodes = [
      {
        schema: 'atris.task_episode.v1',
        episode_id: 'episode-done',
        task_id: 'task-primary-state',
        created_at: '2026-06-01T00:00:00.000Z',
        state: { title: 'Score worktree brain state', tag: 'brain' },
        action: { actor: 'researcher', type: 'done' },
        reward: { value: 0, source: 'task_done' },
        proof: 'initial proof',
      },
      {
        schema: 'atris.task_episode.v1',
        episode_id: 'episode-review',
        task_id: 'task-primary-state',
        created_at: '2026-06-01T00:01:00.000Z',
        state: { title: 'Score worktree brain state', tag: 'brain' },
        action: { actor: 'validator', type: 'review' },
        reward: { value: 4, source: 'task_review' },
        lesson: 'Thin worktrees should read the primary state ledger.',
        proof: 'review proof',
        next_task_suggestion: 'Use the primary state root for brain reward signals',
      },
    ];
    fs.writeFileSync(
      path.join(dir, '.atris', 'state', 'task_episodes.jsonl'),
      taskEpisodes.map(row => JSON.stringify(row)).join('\n') + '\n',
      'utf8'
    );
    const localStateDir = path.join(worktreePath, '.atris', 'state');
    fs.mkdirSync(localStateDir, { recursive: true });
    fs.writeFileSync(
      path.join(localStateDir, 'task_episodes.jsonl'),
      [
        {
          schema: 'atris.task_episode.v1',
          episode_id: 'episode-local-duplicate',
          task_id: 'task-primary-state',
          created_at: '2026-06-01T00:02:00.000Z',
          state: { title: 'Score worktree brain state', tag: 'brain' },
          action: { actor: 'local', type: 'review' },
          reward: { value: 1, source: 'local_duplicate' },
          proof: 'stale local duplicate',
        },
        {
          schema: 'atris.task_episode.v1',
          episode_id: 'episode-local-review',
          task_id: 'task-local-state',
          created_at: '2026-06-01T00:03:00.000Z',
          state: { title: 'Score local worktree-only state', tag: 'brain' },
          action: { actor: 'local', type: 'review' },
          reward: { value: 3, source: 'task_review' },
          proof: 'local worktree proof',
        },
      ].map(row => JSON.stringify(row)).join('\n') + '\n',
      'utf8'
    );

    const scorecard = runCli(['brain', 'scorecard', '--root', worktreePath, '--verify', '--json'], { cwd: worktreePath });
    assert.equal(scorecard.status, 0, scorecard.stderr);
    const payload = JSON.parse(scorecard.stdout);
    assert.equal(fs.realpathSync(payload.stateRoot), fs.realpathSync(dir));
    assert.equal(payload.taskEpisodes, 4);
    assert.equal(payload.written, 2);
    assert.equal(payload.scorecards[0].source_episode_id, 'episode-review');
    assert.equal(payload.scorecards[0].reward, 4);
    assert.equal(payload.scorecards[1].source_episode_id, 'episode-local-review');
    assert.equal(payload.scorecards[1].reward, 3);
    assert.equal(payload.scorecards[0].workspace, 'demo-lab');

    assert.equal(fs.existsSync(path.join(dir, '.atris', 'state', 'scorecards.jsonl')), true);
    assert.equal(fs.existsSync(path.join(worktreePath, '.atris', 'state', 'scorecards.jsonl')), false);

    const compile = runCli(['brain', 'compile', '--yes', '--root', worktreePath, '--verify'], { cwd: worktreePath });
    assert.equal(compile.status, 0, compile.stderr);
    assert.match(compile.stdout, /State rows: 8 raw \/ 8 valid/);
    assert.doesNotMatch(compile.stdout, /Turn existing episode rows into the first scorecard/);

    const status = fs.readFileSync(path.join(worktreePath, 'atris', 'brain', 'STATUS.md'), 'utf8');
    assert.match(status, new RegExp(`State root: ${payload.stateRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(primary checkout\\)`));
    const state = collectState(worktreePath);
    assert.equal(fs.realpathSync(state.stateRoot), fs.realpathSync(dir));
    assert.deepEqual(
      state.stateRoots.map(item => fs.realpathSync(item)),
      [fs.realpathSync(worktreePath), fs.realpathSync(dir)]
    );
    assert.equal(state.totalRows, 8);
  } finally {
    if (worktreePath) cleanupTempDir(worktreePath);
    cleanupTempDir(dir);
  }
});


test('brain compile rejects meta scorecard next suggestions', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    fs.rmSync(path.join(dir, '.atris', 'state', 'agent_mail.jsonl'), { force: true });
    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), '# TODO\n\n## Backlog\n\n(empty)\n', 'utf8');

    fs.writeFileSync(path.join(dir, '.atris', 'state', 'episodes.jsonl'), JSON.stringify({
      schema: 'atris.brain.episode.v1',
      type: 'episode',
      ts: '2026-05-10T00:00:00.000Z',
      summary: 'previous business loop',
    }) + '\n', 'utf8');

    const metaSuggestion = 'Run the compiled business reward next task instead of repeating the completed business loop.';
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'scorecards.jsonl'), JSON.stringify({
      schema: 'atris.brain.scorecard.v1',
      type: 'scorecard',
      ts: '2026-05-10T00:01:00.000Z',
      reward: 5,
      task_title: 'Previous business loop',
      next_task_suggestion: metaSuggestion,
    }) + '\n', 'utf8');

    const compile = runCli(['brain', 'compile', '--yes', '--root', dir, '--verify'], { cwd: dir });
    assert.equal(compile.status, 0, compile.stderr);
    assert.doesNotMatch(compile.stdout, /Run the compiled business reward next task/);
    assert.match(compile.stdout, /atris brain activate --member <name>/);
    assert.doesNotMatch(compile.stdout, /Run a business loop/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('brain compile rejects brain housekeeping next suggestions', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    fs.rmSync(path.join(dir, '.atris', 'state', 'agent_mail.jsonl'), { force: true });
    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), '# TODO\n\n## Backlog\n\n(empty)\n', 'utf8');
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'episodes.jsonl'), JSON.stringify({
      type: 'episode',
      ts: '2026-05-10T00:00:00.000Z',
    }) + '\n', 'utf8');

    const suggestion = 'Run brain scorecard and compile, then pick the next bounded verifier-backed mission step.';
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'scorecards.jsonl'), JSON.stringify({
      type: 'scorecard',
      ts: '2026-05-10T00:01:00.000Z',
      reward: 5,
      next_task_suggestion: suggestion,
    }) + '\n', 'utf8');

    const compile = runCli(['brain', 'compile', '--yes', '--root', dir, '--verify'], { cwd: dir });
    assert.equal(compile.status, 0, compile.stderr);
    assert.doesNotMatch(compile.stdout, /Run brain scorecard and compile/);
    assert.match(compile.stdout, /atris brain activate --member <name>/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('brain compile rejects completion-audit next suggestions', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    fs.rmSync(path.join(dir, '.atris', 'state', 'agent_mail.jsonl'), { force: true });
    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), '# TODO\n\n## Backlog\n\n(empty)\n', 'utf8');
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'episodes.jsonl'), JSON.stringify({
      type: 'episode',
      ts: '2026-05-10T00:00:00.000Z',
    }) + '\n', 'utf8');

    const suggestion = 'Run one final completion audit across pull state, task queue, verifier, front-door signals, and dirty worktree before taking new work.';
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'scorecards.jsonl'), JSON.stringify({
      type: 'scorecard',
      ts: '2026-05-10T00:01:00.000Z',
      reward: 5,
      next_task_suggestion: suggestion,
    }) + '\n', 'utf8');

    const compile = runCli(['brain', 'compile', '--yes', '--root', dir, '--verify'], { cwd: dir });
    assert.equal(compile.status, 0, compile.stderr);
    assert.doesNotMatch(compile.stdout, /Run one final completion audit/);
    assert.match(compile.stdout, /atris brain activate --member <name>/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('brain compile rejects process-work next suggestions', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    fs.rmSync(path.join(dir, '.atris', 'state', 'agent_mail.jsonl'), { force: true });
    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), '# TODO\n\n## Backlog\n\n(empty)\n', 'utf8');
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'episodes.jsonl'), JSON.stringify({
      type: 'episode',
      ts: '2026-05-10T00:00:00.000Z',
    }) + '\n', 'utf8');

    const suggestion = 'Activate the validator/reviewer path only when there is a new concrete artifact to review; otherwise stop creating process work.';
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'scorecards.jsonl'), JSON.stringify({
      type: 'scorecard',
      ts: '2026-05-10T00:01:00.000Z',
      reward: 5,
      next_task_suggestion: suggestion,
    }) + '\n', 'utf8');

    const compile = runCli(['brain', 'compile', '--yes', '--root', dir, '--verify'], { cwd: dir });
    assert.equal(compile.status, 0, compile.stderr);
    assert.doesNotMatch(compile.stdout, /Activate the validator\/reviewer path/);
    assert.match(compile.stdout, /atris brain activate --member <name>/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('brain compile accepts concrete replace or retire next suggestions', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    fs.rmSync(path.join(dir, '.atris', 'state', 'agent_mail.jsonl'), { force: true });
    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), '# TODO\n\n## Backlog\n\n(empty)\n', 'utf8');
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'episodes.jsonl'), JSON.stringify({
      type: 'episode',
      ts: '2026-05-10T00:00:00.000Z',
    }) + '\n', 'utf8');

    const suggestion = 'Replace or retire placeholder member profiles before assigning them work';
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'scorecards.jsonl'), JSON.stringify({
      type: 'scorecard',
      ts: '2026-05-10T00:01:00.000Z',
      reward: 5,
      next_task_suggestion: suggestion,
    }) + '\n', 'utf8');

    const compile = runCli(['brain', 'compile', '--yes', '--root', dir, '--verify'], { cwd: dir });
    assert.equal(compile.status, 0, compile.stderr);
    assert.match(compile.stdout, /Replace or retire placeholder member profiles before assigning them work/);
    assert.doesNotMatch(compile.stdout, /atris brain activate --member <name>/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('brain compile lets newer operator feedback supersede stale task next moves', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    fs.rmSync(path.join(dir, '.atris', 'state', 'agent_mail.jsonl'), { force: true });
    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), '# TODO\n\n## Backlog\n\n(empty)\n', 'utf8');
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'episodes.jsonl'), JSON.stringify({
      type: 'episode',
      ts: '2026-05-10T00:00:00.000Z',
    }) + '\n', 'utf8');

    const staleSuggestion = 'Run one final completion audit across pull state, task queue, verifier, front-door signals, and dirty worktree before taking new work.';
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'scorecards.jsonl'), [
      JSON.stringify({
        type: 'scorecard',
        ts: '2026-05-10T00:01:00.000Z',
        reward: 5,
        next_task_suggestion: staleSuggestion,
      }),
      JSON.stringify({
        schema: 'atris.brain.scorecard.v1',
        ts: '2026-05-10T00:02:00.000Z',
        recommendation: staleSuggestion,
        human_rating: 'approve',
        human_note: 'Audit completed with verifier proof.',
        reward: 1,
        source: 'operator_feedback',
      }),
      '',
    ].join('\n'), 'utf8');

    const compile = runCli(['brain', 'compile', '--yes', '--root', dir, '--verify'], { cwd: dir });
    assert.equal(compile.status, 0, compile.stderr);
    assert.doesNotMatch(compile.stdout, /Run one final completion audit/);
    assert.match(compile.stdout, /atris brain activate --member <name>/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('brain activate prints a mission card from the compiled brain', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    const res = runCli(['brain', 'activate', '--yes', '--root', dir, '--verify'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /CONTEXT: Demo Lab Brain/);
    assert.match(res.stdout, /OPERATOR: unknown/);
    assert.match(res.stdout, /NEXT MOVE: Tell Atris who is operating/);
    assert.match(res.stdout, /PROOF: Activation re-runs with a known operator/);
    assert.match(res.stdout, /FEEDBACK: yes \/ edit \/ no/);
    assert.match(res.stdout, /VERIFY: brain artifacts present/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('brain activate can target a member and print their next work block', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    runCli(['brain', 'compile', '--yes', '--root', dir, '--verify'], { cwd: dir });
    const res = runCli(['brain', 'activate', '--yes', '--member', 'justin', '--root', dir, '--verify'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /CONTEXT: Demo Lab Brain/);
    assert.match(res.stdout, /OPERATOR: Justin McDonald/);
    assert.match(res.stdout, /NEXT MOVE: Justin McDonald: run one customer-moving GTM rep/);
    assert.match(res.stdout, /FEEDBACK: yes \/ edit \/ no/);
    const remembered = JSON.parse(fs.readFileSync(path.join(dir, '.atris', 'state', 'operator.json'), 'utf8'));
    assert.equal(remembered.member, 'justin');
  } finally {
    cleanupTempDir(dir);
  }
});


test('brain activate --verify fails with a missing member setup card instead of scorecard next move', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    fs.rmSync(path.join(dir, '.atris', 'state', 'agent_mail.jsonl'), { force: true });
    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), '# TODO\n\n## Backlog\n\n(empty)\n', 'utf8');
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'episodes.jsonl'), JSON.stringify({
      type: 'episode',
      ts: '2026-05-10T00:00:00.000Z',
    }) + '\n', 'utf8');
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'scorecards.jsonl'), JSON.stringify({
      type: 'scorecard',
      ts: '2026-05-10T00:01:00.000Z',
      reward: 5,
      next_task_suggestion: 'Draft the customer one-pager from the latest recap',
    }) + '\n', 'utf8');

    const res = runCli(['brain', 'activate', '--yes', '--member', 'missing-one', '--root', dir, '--verify'], { cwd: dir });
    assert.notEqual(res.status, 0);
    assert.match(res.stdout, /OPERATOR: missing-one \(missing\)/);
    assert.match(res.stdout, /NEXT MOVE: Create atris\/team\/missing-one\/MEMBER\.md or rerun with an existing member/);
    assert.match(res.stdout, /AVAILABLE MEMBERS: justin, keshav/);
    assert.doesNotMatch(res.stdout, /Draft the customer one-pager/);
    assert.match(res.stderr, /brain activate non-executable member activation card: missing-one \(missing\)/);
    assert.doesNotMatch(res.stderr, /at verifyActivationCard|Node\.js/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('brain activate --json --verify returns machine-readable readiness failures', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);

    const missing = runCli(['brain', 'activate', '--yes', '--member', 'missing-one', '--root', dir, '--verify', '--json'], { cwd: dir });
    assert.notEqual(missing.status, 0);
    assert.equal(missing.stderr, '');
    const missingBody = JSON.parse(missing.stdout);
    assert.equal(missingBody.ok, false);
    assert.match(missingBody.error, /brain activate non-executable member activation card: missing-one \(missing\)/);
    assert.match(missingBody.card, /OPERATOR: missing-one \(missing\)/);
    assert.match(missingBody.card, /AVAILABLE MEMBERS: justin, keshav/);

    const memberDir = path.join(dir, 'atris', 'team', 'placeholder');
    fs.mkdirSync(memberDir, { recursive: true });
    fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), [
      '# Placeholder Member',
      '',
      '## Persona',
      '',
      '(Define how this member communicates, their tone, and decision-making style)',
      '',
    ].join('\n'), 'utf8');

    const notReady = runCli(['brain', 'activate', '--yes', '--member', 'placeholder', '--root', dir, '--verify', '--json'], { cwd: dir });
    assert.notEqual(notReady.status, 0);
    assert.equal(notReady.stderr, '');
    const notReadyBody = JSON.parse(notReady.stdout);
    assert.equal(notReadyBody.ok, false);
    assert.match(notReadyBody.error, /brain activate non-executable member activation card: Placeholder Member \(not ready\)/);
    assert.match(notReadyBody.card, /PROFILE ISSUES: persona is still template text/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('brain activate --verify fails with a placeholder member readiness card', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    const memberDir = path.join(dir, 'atris', 'team', 'placeholder');
    fs.mkdirSync(memberDir, { recursive: true });
    fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), [
      '# Placeholder Member',
      '',
      '## Persona',
      '',
      '(Define how this member communicates, their tone, and decision-making style)',
      '',
      '## Workflow',
      '',
      '1. Step one',
      '',
      '## Rules',
      '',
      '1. Rule one',
      '',
    ].join('\n'), 'utf8');

    const res = runCli(['brain', 'activate', '--yes', '--member', 'placeholder', '--root', dir, '--verify'], { cwd: dir });
    assert.notEqual(res.status, 0);
    assert.match(res.stdout, /OPERATOR: Placeholder Member \(not ready\)/);
    assert.match(res.stdout, /NEXT MOVE: Replace placeholder sections in atris\/team\/placeholder\/MEMBER\.md/);
    assert.match(res.stdout, /PROFILE ISSUES: persona is still template text; workflow is still template text; rules are still template text/);
    assert.doesNotMatch(res.stdout, /use your START_HERE/);
    assert.match(res.stderr, /brain activate non-executable member activation card: Placeholder Member \(not ready\)/);
    assert.doesNotMatch(res.stderr, /at verifyActivationCard|Node\.js/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('brain activate --verify fails with a member missing START_HERE readiness card', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    const memberDir = path.join(dir, 'atris', 'team', 'executor');
    fs.mkdirSync(memberDir, { recursive: true });
    fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), '# Executor\n\nBuilder with real workflow text.\n', 'utf8');

    const res = runCli(['brain', 'activate', '--yes', '--member', 'executor', '--root', dir, '--verify'], { cwd: dir });
    assert.notEqual(res.status, 0);
    assert.match(res.stdout, /OPERATOR: Executor \(not ready\)/);
    assert.match(res.stdout, /NEXT MOVE: Create atris\/team\/executor\/START_HERE\.md/);
    assert.match(res.stdout, /first concrete work block, verifier, and proof target/);
    assert.doesNotMatch(res.stdout, /use your START_HERE/);
    assert.match(res.stderr, /brain activate non-executable member activation card: Executor \(not ready\)/);
    assert.doesNotMatch(res.stderr, /at verifyActivationCard|Node\.js/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('brain activate routes validator members to concrete review work', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    const memberDir = path.join(dir, 'atris', 'team', 'validator');
    fs.mkdirSync(memberDir, { recursive: true });
    fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), '# Validator — Reviewer\n\nValidates execution and blocks weak proof.\n', 'utf8');
    fs.writeFileSync(path.join(memberDir, 'START_HERE.md'), 'Review the highest-risk task and name residual risk.\n', 'utf8');

    const res = runCli(['brain', 'activate', '--yes', '--member', 'validator', '--root', dir, '--verify'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Validator — Reviewer: review the highest-risk open or recently completed task/);
    assert.match(res.stdout, /name residual risk/);
    assert.doesNotMatch(res.stdout, /\(not ready\)/);
    assert.doesNotMatch(res.stdout, /use your START_HERE/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('brain activate routes validator away from fake review work when nothing is reviewable', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), '# TODO\n\n## Backlog\n\n(empty)\n', 'utf8');
    const memberDir = path.join(dir, 'atris', 'team', 'validator');
    fs.mkdirSync(memberDir, { recursive: true });
    fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), '# Validator — Reviewer\n\nValidates execution and blocks weak proof.\n', 'utf8');
    fs.writeFileSync(path.join(memberDir, 'START_HERE.md'), 'Review the highest-risk task and name residual risk.\n', 'utf8');

    const res = runCli(['brain', 'activate', '--yes', '--member', 'validator', '--root', dir, '--verify'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Validator — Reviewer: wait for one concrete artifact or ask Navigator to create a reviewable task/);
    assert.doesNotMatch(res.stdout, /review the highest-risk open or recently completed task/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('brain activate routes executor members to concrete build work', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    const memberDir = path.join(dir, 'atris', 'team', 'executor');
    fs.mkdirSync(memberDir, { recursive: true });
    fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), '# Executor — Builder\n\nBuilds scoped tasks from proof targets.\n', 'utf8');
    fs.writeFileSync(path.join(memberDir, 'START_HERE.md'), 'Execute one scoped patch and run the verifier.\n', 'utf8');

    const res = runCli(['brain', 'activate', '--yes', '--member', 'executor', '--root', dir, '--verify'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Executor — Builder: execute the highest-leverage claimed task one scoped step at a time/);
    assert.match(res.stdout, /hand off proof for review/);
    assert.doesNotMatch(res.stdout, /\(not ready\)/);
    assert.doesNotMatch(res.stdout, /use your START_HERE/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('brain activate routes executor away from fake build work when no task is open', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), '# TODO\n\n## Backlog\n\n(empty)\n', 'utf8');
    const memberDir = path.join(dir, 'atris', 'team', 'executor');
    fs.mkdirSync(memberDir, { recursive: true });
    fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), '# Executor — Builder\n\nBuilds scoped tasks from proof targets.\n', 'utf8');
    fs.writeFileSync(path.join(memberDir, 'START_HERE.md'), 'Execute one scoped patch and run the verifier.\n', 'utf8');

    const res = runCli(['brain', 'activate', '--yes', '--member', 'executor', '--root', dir, '--verify'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Executor — Builder: ask Navigator to create one bounded task with files, verifier, and stop rule before making a patch/);
    assert.doesNotMatch(res.stdout, /execute the highest-leverage claimed task/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('brain activate routes executor to certified review before creating work', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), '# TODO\n\n## Backlog\n\n(empty)\n', 'utf8');
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'tasks.projection.json'), JSON.stringify({
      tasks: [
        {
          display_id: 'CLI-9',
          title: 'Certified checkpoint',
          status: 'review',
          metadata: {
            agent_certified: true,
            agent_review_pass_count: 2,
          },
        },
      ],
    }), 'utf8');
    const memberDir = path.join(dir, 'atris', 'team', 'executor');
    fs.mkdirSync(memberDir, { recursive: true });
    fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), '# Executor — Builder\n\nBuilds scoped tasks from proof targets.\n', 'utf8');
    fs.writeFileSync(path.join(memberDir, 'START_HERE.md'), 'Execute one scoped patch and run the verifier.\n', 'utf8');

    const res = runCli(['brain', 'activate', '--yes', '--member', 'executor', '--root', dir, '--verify'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Executor — Builder: hand off certified review CLI-9 to the operator/);
    assert.match(res.stdout, /atris task accept CLI-9/);
    assert.match(res.stdout, /atris task revise CLI-9 --note "<what must change>"/);
    assert.doesNotMatch(res.stdout, /ask Navigator to create one bounded task/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('brain activate lets codex executor continue when review is human-only', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), [
      '# TODO',
      '',
      '## Endgame',
      '',
      '**Slug:** runner-swap-safe',
      '**Horizon:** runner swaps should be config-only, not overnight outages',
      '',
      '## Backlog',
      '',
      '(empty)',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'tasks.projection.json'), JSON.stringify({
      tasks: [
        {
          display_id: 'CLI-9',
          title: 'Certified checkpoint',
          status: 'review',
          metadata: {
            approval_status: 'pending',
            agent_certified: true,
            agent_review_pass_count: 2,
          },
        },
      ],
    }), 'utf8');
    const memberDir = path.join(dir, 'atris', 'team', 'codex-executor');
    fs.mkdirSync(memberDir, { recursive: true });
    fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), '# Codex Executor — Builder\n\nBuilds scoped tasks from proof targets.\n', 'utf8');
    fs.writeFileSync(path.join(memberDir, 'START_HERE.md'), 'Execute one scoped patch and run the verifier.\n', 'utf8');

    const res = runCli(['brain', 'activate', '--yes', '--member', 'codex-executor', '--root', dir, '--verify'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Codex Executor — Builder: certified reviews CLI-9 are human-only/);
    assert.match(res.stdout, /Create the next bounded Codex task from Endgame runner-swap-safe/);
    assert.match(res.stdout, /runner swaps should be config-only/);
    assert.match(res.stdout, /do not accept XP/);
    assert.doesNotMatch(res.stdout, /atris task accept CLI-9/);
    assert.doesNotMatch(res.stdout, /do not create new work until this checkpoint is clear/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('brain activate routes executor to agent-safe review before human accept rows', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), '# TODO\n\n## Backlog\n\n(empty)\n', 'utf8');
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'tasks.projection.json'), JSON.stringify({
      tasks: [
        {
          display_id: 'CLI-8',
          title: 'Needs agent review',
          status: 'review',
          metadata: {
            approval_status: 'pending',
            agent_review_pass_count: 1,
          },
        },
        {
          display_id: 'CLI-9',
          title: 'Certified checkpoint',
          status: 'review',
          metadata: {
            approval_status: 'pending',
            agent_certified: true,
            agent_review_pass_count: 2,
          },
        },
      ],
    }), 'utf8');
    const memberDir = path.join(dir, 'atris', 'team', 'executor');
    fs.mkdirSync(memberDir, { recursive: true });
    fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), '# Executor — Builder\n\nBuilds scoped tasks from proof targets.\n', 'utf8');
    fs.writeFileSync(path.join(memberDir, 'START_HERE.md'), 'Execute one scoped patch and run the verifier.\n', 'utf8');

    const res = runCli(['brain', 'activate', '--yes', '--member', 'executor', '--root', dir, '--verify'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Executor — Builder: run the agent-safe review lane for CLI-8/);
    assert.match(res.stdout, /atris task review-chat CLI-8 --as codex-review/);
    assert.doesNotMatch(res.stdout, /hand off certified review CLI-9/);
    assert.doesNotMatch(res.stdout, /atris task accept CLI-9/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('brain activate routes navigator members to concrete planning work', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    const memberDir = path.join(dir, 'atris', 'team', 'navigator');
    fs.mkdirSync(memberDir, { recursive: true });
    fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), '# Navigator — Planner\n\nPlans scoped work from MAP evidence.\n', 'utf8');
    fs.writeFileSync(path.join(memberDir, 'START_HERE.md'), 'Plan one scoped task with files, exit, verify, and rollback.\n', 'utf8');

    const res = runCli(['brain', 'activate', '--yes', '--member', 'navigator', '--root', dir, '--verify'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Navigator — Planner: turn one messy or unclaimed intent into a MAP-backed plan/);
    assert.match(res.stdout, /review-ready task/);
    assert.doesNotMatch(res.stdout, /\(not ready\)/);
    assert.doesNotMatch(res.stdout, /use your START_HERE/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('brain activate routes launcher members to concrete closeout work', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), [
      '# TODO.md',
      '',
      '## Completed',
      '',
      '- **[CLI-1]** Completed task [brain]',
      '',
    ].join('\n'), 'utf8');
    const memberDir = path.join(dir, 'atris', 'team', 'launcher');
    fs.mkdirSync(memberDir, { recursive: true });
    fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), '# Launcher — The Closer\n\nCloses validated work into release notes and proof.\n', 'utf8');
    fs.writeFileSync(path.join(memberDir, 'START_HERE.md'), 'Close one validated task into release-ready proof.\n', 'utf8');

    const res = runCli(['brain', 'activate', '--yes', '--member', 'launcher', '--root', dir, '--verify'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Launcher — The Closer: close one validated task into release-ready proof/);
    assert.match(res.stdout, /name the publish step/);
    assert.doesNotMatch(res.stdout, /\(not ready\)/);
    assert.doesNotMatch(res.stdout, /use your START_HERE/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('brain activate routes launcher away from fake closeout work when no task receipt exists', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), '# TODO\n\n## Backlog\n\n(empty)\n', 'utf8');
    const memberDir = path.join(dir, 'atris', 'team', 'launcher');
    fs.mkdirSync(memberDir, { recursive: true });
    fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), '# Launcher — The Closer\n\nCloses validated work into release notes and proof.\n', 'utf8');
    fs.writeFileSync(path.join(memberDir, 'START_HERE.md'), 'Close one validated task into release-ready proof.\n', 'utf8');

    const res = runCli(['brain', 'activate', '--yes', '--member', 'launcher', '--root', dir, '--verify'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Launcher — The Closer: wait for one validated task receipt before closeout/);
    assert.doesNotMatch(res.stdout, /close one validated task into release-ready proof/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('brain activate routes launcher to certified review before closeout fallback', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), '# TODO\n\n## Backlog\n\n(empty)\n', 'utf8');
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'tasks.projection.json'), JSON.stringify({
      tasks: [
        {
          display_id: 'CLI-10',
          title: 'Certified launch checkpoint',
          status: 'review',
          review: {
            agent_certified: true,
            agent_review_pass_count: 2,
          },
        },
      ],
    }), 'utf8');
    const memberDir = path.join(dir, 'atris', 'team', 'launcher');
    fs.mkdirSync(memberDir, { recursive: true });
    fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), '# Launcher — The Closer\n\nCloses validated work into release notes and proof.\n', 'utf8');
    fs.writeFileSync(path.join(memberDir, 'START_HERE.md'), 'Close one validated task into release-ready proof.\n', 'utf8');

    const res = runCli(['brain', 'activate', '--yes', '--member', 'launcher', '--root', dir, '--verify'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Launcher — The Closer: hand off certified review CLI-10 to the operator/);
    assert.match(res.stdout, /atris task accept CLI-10/);
    assert.doesNotMatch(res.stdout, /wait for one validated task receipt before closeout/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('brain activate routes brainstormer members to concrete idea-shaping work', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    const memberDir = path.join(dir, 'atris', 'team', 'brainstormer');
    fs.mkdirSync(memberDir, { recursive: true });
    fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), '# Brainstormer — Idea & Reality Shaper\n\nShapes raw ideas before planning.\n', 'utf8');
    fs.writeFileSync(path.join(memberDir, 'START_HERE.md'), 'Shape one raw idea into a navigator-ready vision.\n', 'utf8');

    const res = runCli(['brain', 'activate', '--yes', '--member', 'brainstormer', '--root', dir, '--verify'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Brainstormer — Idea & Reality Shaper: shape one raw idea into a concise vision/);
    assert.match(res.stdout, /navigator-ready next step/);
    assert.doesNotMatch(res.stdout, /\(not ready\)/);
    assert.doesNotMatch(res.stdout, /use your START_HERE/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('brain activate routes researcher members to concrete research work', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    const memberDir = path.join(dir, 'atris', 'team', 'researcher');
    fs.mkdirSync(memberDir, { recursive: true });
    fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), '# Researcher — Deep Researcher\n\nFinds primary-source truth.\n', 'utf8');
    fs.writeFileSync(path.join(memberDir, 'START_HERE.md'), 'Answer one explicit research question with sources.\n', 'utf8');

    const res = runCli(['brain', 'activate', '--yes', '--member', 'researcher', '--root', dir, '--verify'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Researcher — Deep Researcher: answer one explicit research question with primary sources/);
    assert.match(res.stdout, /unverified gaps/);
    assert.doesNotMatch(res.stdout, /\(not ready\)/);
    assert.doesNotMatch(res.stdout, /use your START_HERE/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('brain activate routes mission and overnight members to concrete work blocks', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    const missionDir = path.join(dir, 'atris', 'team', 'mission-lead');
    fs.mkdirSync(missionDir, { recursive: true });
    fs.writeFileSync(path.join(missionDir, 'MEMBER.md'), '# Mission Lead\n\nCoordinates bounded mission ticks.\n', 'utf8');
    fs.writeFileSync(path.join(missionDir, 'START_HERE.md'), 'Pick one bounded mission step with a verifier and proof target.\n', 'utf8');

    const opusDir = path.join(dir, 'atris', 'team', 'opus-overnight');
    fs.mkdirSync(opusDir, { recursive: true });
    fs.writeFileSync(path.join(opusDir, 'MEMBER.md'), '# Opus Overnight Worker\n\nRuns the rl-exp2 loop without spending money.\n', 'utf8');
    fs.writeFileSync(path.join(opusDir, 'START_HERE.md'), 'Pick the next zero-spend rl-exp2 tick and name the 1% delta.\n', 'utf8');

    const mission = runCli(['brain', 'activate', '--yes', '--member', 'mission-lead', '--root', dir, '--verify'], { cwd: dir });
    assert.equal(mission.status, 0, mission.stderr);
    assert.match(mission.stdout, /Mission Lead: choose or create one bounded mission step, run its verifier/);

    const opus = runCli(['brain', 'activate', '--yes', '--member', 'opus-overnight', '--root', dir, '--verify'], { cwd: dir });
    assert.equal(opus.status, 0, opus.stderr);
    assert.match(opus.stdout, /Opus Overnight Worker: run the next zero-spend `rl-exp2` tick/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('brain activate remembers the last operator after the first member run', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    runCli(['brain', 'activate', '--yes', '--member', 'justin', '--root', dir, '--verify'], { cwd: dir });
    const res = runCli(['brain', 'activate', '--yes', '--root', dir, '--verify'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /OPERATOR: Justin McDonald/);
    assert.match(res.stdout, /NEXT MOVE: Justin McDonald: run one customer-moving GTM rep/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('brain gallery previews activation cards for every team member', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    const res = runCli(['brain', 'gallery', '--yes', '--root', dir, '--verify'], { cwd: dir, env: { ATRIS_OPERATOR: 'keshav' } });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /OPERATOR: Justin McDonald/);
    assert.match(res.stdout, /OPERATOR: Keshav Rao/);
    assert.match(res.stdout, /Justin McDonald: run one customer-moving GTM rep/);
    assert.match(res.stdout, /Keshav Rao: act as Customer 0/);
    assert.match(res.stdout, /---/);
    assert.match(res.stdout, /VERIFY: brain artifacts and member readiness present/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('brain activation does not treat a generic operator member as the owner', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    const memberDir = path.join(dir, 'atris', 'team', 'operator');
    fs.mkdirSync(memberDir, { recursive: true });
    fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), '# Operator\n\nBusiness operator\n');
    fs.writeFileSync(path.join(memberDir, 'START_HERE.md'), '# Start Here\n\nRun the business loop.\n');
    const result = runCli(['brain', 'activate', '--yes', '--member', 'operator', '--root', dir], {
      cwd: dir,
      env: { ATRIS_OPERATOR: 'alex' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /Operator: act as Customer 0/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('brain gallery does not overwrite the remembered operator', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    const operatorPath = path.join(dir, '.atris', 'state', 'operator.json');
    const activate = runCli(['brain', 'activate', '--yes', '--member', 'justin', '--root', dir, '--verify'], { cwd: dir });
    assert.equal(activate.status, 0, activate.stderr);
    assert.equal(JSON.parse(fs.readFileSync(operatorPath, 'utf8')).member, 'justin');

    const res = runCli(['brain', 'gallery', '--yes', '--root', dir, '--verify'], { cwd: dir, env: { ATRIS_OPERATOR: 'keshav' } });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /OPERATOR: Keshav Rao/);
    assert.equal(JSON.parse(fs.readFileSync(operatorPath, 'utf8')).member, 'justin');
  } finally {
    cleanupTempDir(dir);
  }
});


test('brain gallery --verify fails on not-ready member cards', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    const memberDir = path.join(dir, 'atris', 'team', 'executor');
    fs.mkdirSync(memberDir, { recursive: true });
    fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), '# Executor\n\nBuilder with real workflow text.\n', 'utf8');

    const res = runCli(['brain', 'gallery', '--yes', '--root', dir, '--verify'], { cwd: dir });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /brain gallery not-ready member activation cards: Executor/);
    assert.doesNotMatch(res.stderr, /at verifyActivationGallery|Node\.js/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('brain gallery --json --verify returns machine-readable readiness failures', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    const memberDir = path.join(dir, 'atris', 'team', 'executor');
    fs.mkdirSync(memberDir, { recursive: true });
    fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), '# Executor\n\nBuilder with real workflow text.\n', 'utf8');

    const res = runCli(['brain', 'gallery', '--yes', '--root', dir, '--verify', '--json'], { cwd: dir });
    assert.notEqual(res.status, 0);
    assert.equal(res.stderr, '');
    const body = JSON.parse(res.stdout);
    assert.equal(body.ok, false);
    assert.match(body.error, /brain gallery not-ready member activation cards: Executor \(not ready\)/);
    assert.deepEqual(body.members, ['executor', 'justin', 'keshav']);
    assert.match(body.gallery, /OPERATOR: Executor \(not ready\)/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('brain activate shows Keshav Customer 0 score context when present', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    fs.mkdirSync(path.join(dir, 'atris', 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'state', 'contribution-score.md'), `# Contribution Score

| Operator | Mode | Visible score signal | Current signal | Needed to count today |
|---|---|---|---|---|
| Keshav | Customer 0 / system leverage | Level 1: Customer 0 loop started | Member surface defines the first-run loop | Close one receipt with proof and next owner |

## Keshav Profile Scoring Contract

Source profile: atris/team/keshav/MEMBER.md

## Keshav Customer 0 Card

\`\`\`text
operator: Keshav
current_score_signal: Level 1 - Customer 0 loop started
why: member identity, first screen, and score surface agree
next_rep: log one receipt with evidence and next owner
proof_needed: leave a receipt in contribution-score
\`\`\`
`, 'utf8');
    const res = runCli(['brain', 'activate', '--yes', '--member', 'keshav', '--root', dir, '--verify'], { cwd: dir, env: { ATRIS_OPERATOR: 'keshav' } });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /OPERATOR: Keshav Rao/);
    assert.match(res.stdout, /NEXT MOVE: Keshav Rao: act as Customer 0/);
    assert.match(res.stdout, /SCORE: Level 1 - Customer 0 loop started/);
    assert.match(res.stdout, /NEXT REP: log one receipt with evidence and next owner/);
    assert.match(res.stdout, /PROOF: leave a receipt in contribution-score/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('brain activate supports founder lab mode for Keshav', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    const res = runCli([
      'brain', 'activate',
      '--member', 'keshav',
      '--mode', 'founder-lab',
      '--root', dir,
      '--verify',
      '--yes',
    ], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /OPERATOR: Keshav Rao/);
    assert.match(res.stdout, /MODE: founder lab/);
    assert.match(res.stdout, /crazy company idea/);
    assert.match(res.stdout, /customer wedge hypothesis/);
    assert.match(res.stdout, /delegated next action/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('brain feedback appends linked scorecard and episode rows', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    runCli(['brain', 'compile', '--yes', '--root', dir, '--verify'], { cwd: dir });
    const res = runCli([
      'brain', 'feedback',
      '--root', dir,
      '--rating', 'edit',
      '--recommendation', 'Send the customer follow-up',
      '--note', 'Tone was right, pricing was stale',
      '--verify',
    ], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Atris brain feedback recorded/);

    const scorecard = JSON.parse(fs.readFileSync(path.join(dir, '.atris', 'state', 'scorecards.jsonl'), 'utf8').trim());
    const episode = JSON.parse(fs.readFileSync(path.join(dir, '.atris', 'state', 'episodes.jsonl'), 'utf8').trim());
    assert.equal(scorecard.human_rating, 'edit');
    assert.equal(scorecard.reward, 0.5);
    assert.equal(episode.episode_id, scorecard.decision_id);
    assert.equal(episode.feedback.note, 'Tone was right, pricing was stale');
  } finally {
    cleanupTempDir(dir);
  }
});


test('brain yes records approval with a plain note', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    runCli(['brain', 'compile', '--yes', '--root', dir, '--verify'], { cwd: dir });
    const res = runCli([
      'brain', 'yes',
      'ship the simple version',
      '--root', dir,
      '--verify',
    ], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Rating: approve/);
    assert.match(res.stdout, /Next: atris brain compile/);

    const scorecard = JSON.parse(fs.readFileSync(path.join(dir, '.atris', 'state', 'scorecards.jsonl'), 'utf8').trim());
    assert.equal(scorecard.human_rating, 'approve');
    assert.equal(scorecard.human_note, 'ship the simple version');
    assert.equal(scorecard.reward, 1);
  } finally {
    cleanupTempDir(dir);
  }
});


test('brain go records an approval row without writing feedback rows', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    runCli(['brain', 'compile', '--yes', '--root', dir, '--verify'], { cwd: dir });
    const res = runCli([
      'brain', 'go',
      'proceed with contract engineering unblock',
      '--root', dir,
      '--recommendation', 'Justin: unblock contract engineering',
      '--verify',
    ], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Atris brain approval recorded/);
    assert.match(res.stdout, /Decision: go/);
    assert.match(res.stdout, /Status: approved_to_proceed/);

    const approval = JSON.parse(fs.readFileSync(path.join(dir, '.atris', 'state', 'approvals.jsonl'), 'utf8').trim());
    assert.equal(approval.human_decision, 'go');
    assert.equal(approval.recommendation, 'Justin: unblock contract engineering');
    assert.equal(approval.human_note, 'proceed with contract engineering unblock');
    assert.equal(fs.existsSync(path.join(dir, '.atris', 'state', 'scorecards.jsonl')), false);
    assert.equal(fs.existsSync(path.join(dir, '.atris', 'state', 'episodes.jsonl')), false);
  } finally {
    cleanupTempDir(dir);
  }
});


test('brain approval edit records approval edit without changing brain edit feedback', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    runCli(['brain', 'compile', '--yes', '--root', dir, '--verify'], { cwd: dir });
    const res = runCli([
      'brain', 'approval', 'edit',
      'change the owner before proceeding',
      '--root', dir,
      '--recommendation', 'Justin: unblock contract engineering',
      '--verify',
    ], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Decision: edit/);
    assert.match(res.stdout, /Status: needs_adjustment_before_action/);

    const approval = JSON.parse(fs.readFileSync(path.join(dir, '.atris', 'state', 'approvals.jsonl'), 'utf8').trim());
    assert.equal(approval.human_decision, 'edit');
    assert.equal(approval.human_note, 'change the owner before proceeding');

    const feedback = runCli([
      'brain', 'edit',
      'tone needs work',
      '--root', dir,
      '--verify',
    ], { cwd: dir });
    assert.equal(feedback.status, 0, feedback.stderr);
    assert.match(feedback.stdout, /Atris brain feedback recorded/);
    assert.match(feedback.stdout, /Rating: edit/);
    assert.equal(fs.existsSync(path.join(dir, '.atris', 'state', 'scorecards.jsonl')), true);
  } finally {
    cleanupTempDir(dir);
  }
});


// ============================================
// task
// ============================================

test('task command adds, claims, and completes workspace-scoped rows', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const add = runCli(['task', 'add', 'Ship task plane', '--tag', 'launch', '--json'], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const addPayload = JSON.parse(add.stdout);
    const id = addPayload.task_id;
    const ref = addPayload.task.display_id;
    assert.match(id, /^[0-9A-Z]{26}$/);
    assert.match(ref, /^[A-Z0-9]{3}-1$/);

    const open = runCli(['task', 'list'], { cwd: dir, env });
    assert.equal(open.status, 0, open.stderr);
    assert.match(open.stdout, /^What changes: Ship task plane\./);
    assert.match(open.stdout, new RegExp(`open\\s+${ref}`));
    assert.match(open.stdout, new RegExp(`open\\s+${ref}\\s+#launch`));
    assert.match(open.stdout, new RegExp(`Technical details: atris task show ${ref}`));

    const claim = runCli(['task', 'claim', ref, '--as', 'codex'], { cwd: dir, env });
    assert.equal(claim.status, 0, claim.stderr);
    assert.match(claim.stdout, new RegExp(`claimed ${ref} as codex`));
    assert.match(claim.stdout, new RegExp(`Next: make the change, then run: atris task ready ${ref} --verify "git diff --check"`));
    assert.match(claim.stdout, /--landing "<what someone can do now>"/);
    assert.match(claim.stdout, /Use a different verifier only if autoland can rerun it/);
    assert.match(claim.stdout, /Then: atris autoland tick/);

    const claimed = runCli(['task', 'list', '--status', 'claimed'], { cwd: dir, env });
    assert.equal(claimed.status, 0, claimed.stderr);
    assert.match(claimed.stdout, new RegExp(`claimed\\s+${ref}\\s+\\[codex\\]`));

    const done = runCli(['task', 'done', id.slice(0, 8), '--proof', 'node --test test/commands.test.js passed'], { cwd: dir, env });
    assert.equal(done.status, 0, done.stderr);
    assert.match(done.stdout, new RegExp(`done ${ref}`));

    const completed = runCli(['task', 'list', '--status', 'done'], { cwd: dir, env });
    assert.equal(completed.status, 0, completed.stderr);
    assert.match(completed.stdout, new RegExp(`done\\s+${ref}`));

    const events = runCli(['task', 'events', id], { cwd: dir, env });
    assert.equal(events.status, 0, events.stderr);
    assert.match(events.stdout, new RegExp(`1\\tcreated\\t${ref}`));
    assert.match(events.stdout, new RegExp(`2\\tclaimed\\t${ref}`));
    assert.match(events.stdout, new RegExp(`3\\tcompleted\\t${ref}`));

    const todoPath = path.join(dir, 'atris', 'TODO.md');
    fs.writeFileSync(todoPath, 'clobbered\n', 'utf8');
    const render = runCli(['task', 'render', '--out', 'atris/TODO.md'], { cwd: dir, env });
    assert.equal(render.status, 0, render.stderr);
    assert.match(render.stdout, /rendered TODO\.md/);
    assert.match(render.stdout, /Backlog: empty/);
    assert.match(render.stdout, /Done saved: 1/);
    const regenerated = fs.readFileSync(todoPath, 'utf8');
    assert.match(regenerated, /Regenerated from durable Atris task state/);
    assert.match(regenerated, new RegExp(`\\*\\*\\[${ref}\\]\\*\\* Ship task plane`));
    assert.match(regenerated, /## Completed/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('task next and list honor tag scope before mutating tasks', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const loopCreated = runCli([
      'task',
      'new',
      'Loop janitor keeps unrelated work visible to operators',
      '--tag',
      'loop',
      '--json',
    ], { cwd: dir, env });
    assert.equal(loopCreated.status, 0, loopCreated.stderr);
    const loopTask = JSON.parse(loopCreated.stdout).task;
    const loopClaim = runCli(['task', 'claim', loopTask.display_id, '--as', 'onboarding'], { cwd: dir, env });
    assert.equal(loopClaim.status, 0, loopClaim.stderr);

    const noMatch = runCli(['task', 'next', '--tag', 'golden-path', '--as', 'onboarding', '--json'], { cwd: dir, env });
    assert.equal(noMatch.status, 0, noMatch.stderr);
    const noMatchPayload = JSON.parse(noMatch.stdout);
    assert.equal(noMatchPayload.action, 'none');
    assert.equal(noMatchPayload.command, 'atris task new');
    assert.equal(noMatchPayload.task_id, null);
    assert.equal(noMatchPayload.scope.tag, 'golden-path');

    const loopAfterNoMatch = JSON.parse(runCli(['task', 'show', loopTask.display_id, '--json'], { cwd: dir, env }).stdout);
    assert.equal(loopAfterNoMatch.status, 'claimed');
    assert.equal(loopAfterNoMatch.claimed_by, 'onboarding');
    assert.equal(loopAfterNoMatch.tag, 'loop');

    const goldenCreated = runCli([
      'task',
      'new',
      'Golden path work keeps first-run onboarding focused',
      '--tag',
      'golden-path',
      '--json',
    ], { cwd: dir, env });
    assert.equal(goldenCreated.status, 0, goldenCreated.stderr);
    const goldenTask = JSON.parse(goldenCreated.stdout).task;

    const scopedNext = runCli(['task', 'next', '--tag', 'golden-path', '--as', 'onboarding', '--json'], { cwd: dir, env });
    assert.equal(scopedNext.status, 0, scopedNext.stderr);
    const scopedNextPayload = JSON.parse(scopedNext.stdout);
    assert.equal(scopedNextPayload.action, 'claim');
    assert.equal(scopedNextPayload.command, `atris task claim ${goldenTask.display_id} --as onboarding`);
    assert.equal(scopedNextPayload.task_id, goldenTask.id);
    assert.equal(scopedNextPayload.task.tag, 'golden-path');
    assert.equal(JSON.parse(runCli(['task', 'show', goldenTask.display_id, '--json'], { cwd: dir, env }).stdout).status, 'open');

    const filteredList = runCli(['task', 'list', '--tag', 'golden-path'], { cwd: dir, env });
    assert.equal(filteredList.status, 0, filteredList.stderr);
    assert.match(filteredList.stdout, /#golden-path/);
    assert.match(filteredList.stdout, /Golden path work keeps first-run onboarding focused/);
    assert.doesNotMatch(filteredList.stdout, /Loop janitor/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('task current picks earlier golden-path pass step over a later one touched more recently', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const pass1aCreated = runCli([
      'task',
      'new',
      'Golden path pass 1a: fresh install prints one next command',
      '--tag',
      'golden-path',
      '--json',
    ], { cwd: dir, env });
    assert.equal(pass1aCreated.status, 0, pass1aCreated.stderr);
    const pass1aTask = JSON.parse(pass1aCreated.stdout).task;

    const pass1aPlanned = runCli(['task', 'plan', pass1aTask.display_id, '--goal', 'ship pass 1a', '--exit', 'pass 1a lands', '--proof-needed', 'node --test', '--as', 'onboarding', '--json'], { cwd: dir, env });
    assert.equal(pass1aPlanned.status, 0, pass1aPlanned.stderr);

    const pass2Created = runCli([
      'task',
      'new',
      'Golden path pass 2: mission tick recovery is actionable',
      '--tag',
      'golden-path',
      '--json',
    ], { cwd: dir, env });
    assert.equal(pass2Created.status, 0, pass2Created.stderr);
    const pass2Task = JSON.parse(pass2Created.stdout).task;

    // Plan the later pass step *after* pass 1a, so it has a newer updated_at.
    // This mirrors the real report: a later pass step gets planned/re-touched
    // after the fact and would win under newest-first ordering.
    const pass2Planned = runCli(['task', 'plan', pass2Task.display_id, '--goal', 'ship pass 2', '--exit', 'pass 2 lands', '--proof-needed', 'node --test', '--as', 'onboarding', '--json'], { cwd: dir, env });
    assert.equal(pass2Planned.status, 0, pass2Planned.stderr);

    const scopedCurrent = runCli(['task', 'current', '--tag', 'golden-path', '--as', 'onboarding', '--json'], { cwd: dir, env });
    assert.equal(scopedCurrent.status, 0, scopedCurrent.stderr);
    const scopedPayload = JSON.parse(scopedCurrent.stdout);
    assert.equal(scopedPayload.current.selected_reason, 'plan_ready');
    assert.equal(scopedPayload.current.selected_task_id, pass1aTask.id);
    assert.equal(scopedPayload.current.selected_ref, pass1aTask.display_id);
  } finally {
    cleanupTempDir(dir);
  }
});


test('task add warns when title lacks operator-ready plain why', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const warned = runCli(['task', 'add', 'Refactor task title warning', '--json'], { cwd: dir, env });
    assert.equal(warned.status, 0, warned.stderr);
    assert.match(warned.stderr, /Warning: put the why in this task title in plain words/);
    const warnedPayload = JSON.parse(warned.stdout);
    assert.equal(warnedPayload.action, 'created');
    assert.match(warnedPayload.operator_title_warning, /what it buys or costs/);

    const quiet = runCli(['task', 'add', 'Slow setup costs users time: cache the workspace scan', '--json'], { cwd: dir, env });
    assert.equal(quiet.status, 0, quiet.stderr);
    assert.equal(quiet.stderr, '');
    const quietPayload = JSON.parse(quiet.stdout);
    assert.equal(quietPayload.action, 'created');
    assert.equal(quietPayload.operator_title_warning, null);
  } finally {
    cleanupTempDir(dir);
  }
});


test('task display refs use semantic IDs and collision-safe legacy prefixes', () => {
  if (!hasNodeSqlite()) return;
  const taskDb = require('../lib/task-db');
  const rows = taskDb.withTaskDisplayRefs([
    { id: '01KQMBKFFGKW9T4DGQ5BKW9T4D', title: 'First collision', workspace_root: '/tmp/project-obelisk', created_at: 1 },
    { id: '01KQMBKFFGCMZQVCDFPECMZQVC', title: 'Second collision', workspace_root: '/tmp/project-obelisk', created_at: 2 },
    { id: '01ABCDE1FGCMZQVCDFPECMZQVC', title: 'Plain legacy', workspace_root: '/tmp/project-obelisk', created_at: 3 },
    { id: '01CUST01FGCMZQVCDFPECMZQVC', title: 'Other obelisk', workspace_root: '/tmp/customer-obelisk', created_at: 1 },
  ]);

  assert.deepEqual(rows.map(row => row.display_id), ['OBL-1', 'OBL-2', 'OBL-3', 'COB-1']);
  assert.equal(rows[2].legacy_ref, '01ABCDE1');
  assert.notEqual(rows[0].legacy_ref, rows[1].legacy_ref);
  assert.ok(rows[0].legacy_ref.startsWith('01KQMBKF'));
  assert.ok(rows[1].legacy_ref.startsWith('01KQMBKF'));
});


test('task render preserves Endgame metadata and drops markdown-only rows', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const todoPath = path.join(dir, 'atris', 'TODO.md');
    fs.writeFileSync(todoPath, [
      '# TODO.md',
      '',
      '## Endgame',
      '',
      '**Slug:** renderer-horizon',
      '**Picked:** 2026-05-15 10:00',
      '**Horizon:** Keep the playable horizon visible.',
      '**Source:** test',
      '',
      '## Backlog',
      '',
      '- **T1:** Keep markdown horizon [endgame] [execute]',
      '  **Verify:** test -f horizon.txt',
      '',
      '## In Progress',
      '',
      '## Review',
      '',
      '- **[T2]** Pending human approval [agent]',
      '  **Verify:** test -f approval.txt',
      '',
      '## Completed',
      '',
    ].join('\n'), 'utf8');
    const created = runCli(['task', 'new', 'DB state task', '--tag', 'agent', '--json'], { cwd: dir, env });
    assert.equal(created.status, 0, created.stderr);
    const createdTask = JSON.parse(created.stdout).task;

    const render = runCli(['task', 'render', '--out', 'atris/TODO.md'], { cwd: dir, env });
    assert.equal(render.status, 0, render.stderr);
    const regenerated = fs.readFileSync(todoPath, 'utf8');
    assert.match(regenerated, /## Endgame/);
    assert.match(regenerated, /\*\*Slug:\*\* renderer-horizon/);
    assert.doesNotMatch(regenerated, /Keep markdown horizon|Pending human approval|horizon\.txt|approval\.txt/);
    assert.match(regenerated, /DB state task \[agent\]/);
    assert.match(regenerated, new RegExp(`\\*\\*\\[${createdTask.display_id}\\]\\*\\* DB state task \\[agent\\]`));
    assert.doesNotMatch(regenerated, /Technical details:/);
    const showByRenderedRef = runCli(['task', 'show', createdTask.display_id, '--json'], { cwd: dir, env });
    assert.equal(showByRenderedRef.status, 0, showByRenderedRef.stderr);
    assert.equal(JSON.parse(showByRenderedRef.stdout).id, createdTask.id);

    const renderAgain = runCli(['task', 'render', '--out', 'atris/TODO.md'], { cwd: dir, env });
    assert.equal(renderAgain.status, 0, renderAgain.stderr);
    const second = fs.readFileSync(todoPath, 'utf8');
    assert.equal((second.match(/## Endgame/g) || []).length, 1);
    assert.equal((second.match(/Keep markdown horizon/g) || []).length, 0);
    assert.equal((second.match(/Pending human approval/g) || []).length, 0);
    assert.equal((second.match(/DB state task/g) || []).length, 1);
    assert.match(second, new RegExp(`\\*\\*\\[${createdTask.display_id}\\]\\*\\* DB state task \\[agent\\]`));
    assert.doesNotMatch(second, /Technical details:/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('task render drops stale generated markdown rows for DB-backed tasks', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const todoPath = path.join(dir, 'atris', 'TODO.md');
    const created = runCli(['task', 'new', 'Move review work forward', '--tag', 'task-plane', '--json'], { cwd: dir, env });
    assert.equal(created.status, 0, created.stderr);
    const ref = JSON.parse(created.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', ref, '--as', 'codex'], { cwd: dir, env }).status, 0);
    assert.equal(runCli(['task', 'ready', ref, '--proof', 'render smoke passed', '--as', 'codex'], { cwd: dir, env }).status, 0);

    fs.writeFileSync(todoPath, [
      '# TODO.md',
      '',
      '## Backlog',
      '',
      '- **[T9]** Legacy migration row [agent-xp]',
      '',
      '## In Progress',
      '',
      `- **[${ref}]** Move review work forward [task-plane]`,
      '  **Claimed by:** codex',
      '',
      '## Review',
      '',
      `- **[${ref}]** Move review work forward [task-plane]`,
      '',
      '## Completed',
      '',
    ].join('\n'), 'utf8');

    const legacyRender = runCli(['task', 'render', '--out', 'atris/TODO.md'], { cwd: dir, env });
    assert.equal(legacyRender.status, 0, legacyRender.stderr);
    const legacy = fs.readFileSync(todoPath, 'utf8');
    assert.match(legacy, /Legacy migration row \[agent-xp\]/);
    assert.doesNotMatch(legacy, /Technical details:/);
    assert.equal((legacy.match(new RegExp(`\\*\\*\\[${ref}\\]\\*\\* Move review work forward`, 'g')) || []).length, 1);
    assert.doesNotMatch(legacy, new RegExp(`## In Progress\\n\\n- \\*\\*\\[${ref}\\]\\*\\* Move review work forward`));

    const generatedRender = runCli(['task', 'render', '--out', 'atris/TODO.md'], { cwd: dir, env });
    assert.equal(generatedRender.status, 0, generatedRender.stderr);
    assert.match(generatedRender.stdout, /Backlog: empty/);
    assert.match(generatedRender.stdout, /Review: 1/);
    const generated = fs.readFileSync(todoPath, 'utf8');
    assert.match(generated, /## Backlog\n\n\(Empty\)/);
    assert.doesNotMatch(generated, /Legacy migration row/);
    assert.equal((generated.match(new RegExp(`\\*\\*\\[${ref}\\]\\*\\* Move review work forward`, 'g')) || []).length, 1);
    assert.match(generated, new RegExp(`## Review\\n\\n- \\*\\*\\[${ref}\\]\\*\\* Move review work forward ·`));
    assert.match(generated, /\*\*Done looks like:\*\*/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('task import preserves markdown Review rows as review tasks', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const todoPath = path.join(dir, 'atris', 'TODO.md');
    fs.writeFileSync(todoPath, [
      '# TODO.md',
      '',
      '## Backlog',
      '',
      '## In Progress',
      '',
      '(Empty)',
      '',
      '## Review',
      '',
      '- **[T9]** Pending human proof [agent]',
      '  **Claimed by:** codex',
      '  **Verify:** npm test',
      '',
      '## Completed',
      '',
    ].join('\n'), 'utf8');

    const imported = runCli(['task', 'import', 'atris/TODO.md', '--json'], { cwd: dir, env });
    assert.equal(imported.status, 0, imported.stderr);
    assert.equal(JSON.parse(imported.stdout).inserted, 1);

    const review = runCli(['task', 'list', '--status', 'review', '--json'], { cwd: dir, env });
    assert.equal(review.status, 0, review.stderr);
    const payload = JSON.parse(review.stdout);
    assert.equal(payload.tasks.length, 1);
    assert.equal(payload.tasks[0].status, 'review');
    assert.equal(payload.tasks[0].title, 'Pending human proof');
    assert.equal(payload.tasks[0].claimed_by, 'codex');
    assert.equal(payload.tasks[0].metadata.verify, 'npm test');

    const revise = runCli(['task', 'revise', payload.tasks[0].display_id, '--note', 'tighten proof', '--json'], { cwd: dir, env });
    assert.equal(revise.status, 0, revise.stderr);
    assert.equal(JSON.parse(revise.stdout).task.status, 'claimed');
  } finally {
    cleanupTempDir(dir);
  }
});


test('task display refs stay stable in filtered list views', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const older = JSON.parse(runCli(['task', 'add', 'Older closed task', '--json'], { cwd: dir, env }).stdout);
    const current = JSON.parse(runCli(['task', 'add', 'Current open task', '--json'], { cwd: dir, env }).stdout);
    assert.equal(runCli(['task', 'done', older.task.display_id, '--proof', 'node --test test/commands.test.js passed'], { cwd: dir, env }).status, 0);

    const open = runCli(['task', 'list', '--status', 'open'], { cwd: dir, env });
    assert.equal(open.status, 0, open.stderr);
    assert.match(open.stdout, /^What changes: Current open task\./);
    assert.match(open.stdout, new RegExp(`open\\s+${current.task.display_id}`));
    assert.match(open.stdout, new RegExp(`Technical details: atris task show ${current.task.display_id}`));
    assert.doesNotMatch(open.stdout, new RegExp(older.task.display_id));

    const done = runCli(['task', 'list', '--status', 'done'], { cwd: dir, env });
    assert.equal(done.status, 0, done.stderr);
    assert.match(done.stdout, /^What changes: Older closed task\./);
    assert.match(done.stdout, new RegExp(`done\\s+${older.task.display_id}`));
    assert.match(done.stdout, new RegExp(`Technical details: atris task show ${older.task.display_id}`));

    const openJson = runCli(['task', 'list', '--status', 'open', '--json'], { cwd: dir, env });
    assert.equal(openJson.status, 0, openJson.stderr);
    assert.equal(JSON.parse(openJson.stdout).tasks[0].display_id, current.task.display_id);
  } finally {
    cleanupTempDir(dir);
  }
});


test('task display refs stay stable when compact projection is capped', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const taskDb = require('../lib/task-db');
  taskDb.close();
  try {
    const db = taskDb.open(dbPath);
    const ws = path.join(dir, 'project-obelisk');
    const createdIds = [];
    for (let i = 0; i < 505; i += 1) {
      createdIds.push(taskDb.addTask(db, {
        title: `Task ${i + 1}`,
        workspaceRoot: ws,
      }).id);
    }

    const newestId = createdIds[createdIds.length - 1];
    const fullRefById = new Map(taskDb.withTaskDisplayRefs(
      taskDb.listTasks(db, { workspaceRoot: ws })
    ).map(task => [task.id, task.display_id]));
    const compact = taskDb.taskProjection(db, { workspaceRoot: ws, limit: 500 });
    assert.equal(compact.tasks.length, 500);
    const newestCompact = compact.tasks.find(task => task.id === newestId);
    assert.ok(newestCompact, 'newest task should be present in capped compact projection');
    assert.equal(newestCompact.display_id, fullRefById.get(newestId));

    const direct = taskDb.taskProjection(db, { taskId: newestId }).tasks[0];
    assert.equal(direct.display_id, newestCompact.display_id);
    assert.equal(direct.legacy_ref, newestCompact.legacy_ref);
  } finally {
    taskDb.close();
    cleanupTempDir(dir);
  }
});


test('task render keeps display refs stable when compact TODO view is capped', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const taskDb = require('../lib/task-db');
  taskDb.close();
  try {
    fs.mkdirSync(path.join(dir, 'project-obelisk', 'atris'), { recursive: true });
    const db = taskDb.open(dbPath);
    const ws = fs.realpathSync(path.join(dir, 'project-obelisk'));
    for (let i = 0; i < 505; i += 1) {
      taskDb.addTask(db, {
        title: `Task ${i + 1}`,
        workspaceRoot: ws,
      });
    }
    const compactRows = taskDb.listTasks(db, { workspaceRoot: ws, limit: 500 });
    const fullById = new Map(taskDb.withTaskDisplayRefs(
      taskDb.listTasks(db, { workspaceRoot: ws })
    ).map(task => [task.id, task.display_id]));
    const compactOnlyById = new Map(taskDb.withTaskDisplayRefs(compactRows)
      .map(task => [task.id, task.display_id]));
    const target = compactRows.find(task => fullById.get(task.id) !== compactOnlyById.get(task.id));
    assert.ok(target, 'fixture should expose a compact-row display ref drift');
    const expectedRef = fullById.get(target.id);
    const staleRef = compactOnlyById.get(target.id);
    taskDb.close();

    const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
    const render = runCli(['task', 'render', '--out', 'atris/TODO.md'], { cwd: ws, env });
    assert.equal(render.status, 0, render.stderr);
    const regenerated = fs.readFileSync(path.join(ws, 'atris', 'TODO.md'), 'utf8');
    assert.match(regenerated, new RegExp(`\\*\\*\\[${expectedRef}\\]\\*\\* ${target.title}`));
    assert.doesNotMatch(regenerated, new RegExp(`\\*\\*\\[${staleRef}\\]\\*\\* ${target.title}`));
  } finally {
    taskDb.close();
    cleanupTempDir(dir);
  }
});


test('task help flags never render the live desk', () => {
  const dir = makeTempDir();
  try {
    const rootHelp = runCli(['task', '--help'], { cwd: dir });
    assert.equal(rootHelp.status, 0, rootHelp.stderr);
    assert.match(rootHelp.stdout, /atris task - durable local task state/);
    assert.match(rootHelp.stdout, /atris task capabilities \[--json\]/);
    assert.match(rootHelp.stdout, /atris task capabilities-check \[--json\]/);
    assert.match(rootHelp.stdout, /atris task review-lane-drain \[--json\]/);
    assert.match(rootHelp.stdout, /atris task review-lane-act \[--json\]/);
    assert.match(rootHelp.stdout, /atris task review-lane-loop \[--json\]/);
    assert.match(rootHelp.stdout, /atris task review-lane-run \[--json\]/);
    assert.match(rootHelp.stdout, /atris task list \[--all\] \[--everywhere\] \[--status <s>\]/);
    assert.match(rootHelp.stdout, /--all stays in this workspace; --everywhere spans workspaces/);
    assert.match(rootHelp.stdout, /atris task reviews \[--all\|--limit <n>\] \[--verbose\]/);
    assert.match(rootHelp.stdout, /atris task current .*--review-state <lane>/);
    assert.match(rootHelp.stdout, /atris task queue .*--review-state <lane>/);
    assert.match(rootHelp.stdout, /atris task current-step .*--review-state <lane>/);
    assert.match(rootHelp.stdout, /review-state lanes: needs-agent, continue-work, human-accept-waiting, certified/);
    assert.doesNotMatch(rootHelp.stdout, /TASK DESK/);

    const eventsHelp = runCli(['task', 'events', '--help'], { cwd: dir });
    assert.equal(eventsHelp.status, 0, eventsHelp.stderr);
    assert.match(eventsHelp.stdout, /atris task events --all/);
    assert.match(eventsHelp.stdout, /atris task events --everywhere/);
    assert.doesNotMatch(eventsHelp.stdout, /TASK EVENTS/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('task capabilities returns the standalone read-only task capability contract', () => {
  const dir = makeTempDir();
  try {
    const caps = runCli(['task', 'capabilities', '--json'], { cwd: dir });
    assert.equal(caps.status, 0, caps.stderr);
    const payload = JSON.parse(caps.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.action, 'capabilities');
    assert.equal(payload.capabilities.schema, 'atris.task_capabilities.v1');
    assert.match(payload.capabilities.read_only_semantics, /no task DB mutation/);
    assert.equal(payload.safety.read_only, true);
    assert.equal(payload.safety.claims_work, false);
    assert.equal(payload.safety.human_accept, false);
    assert.equal(payload.safety.xp_after_human_accept, true);
    assert.equal(payload.capabilities.surfaces.capabilities.read_only, true);
    assert.deepEqual(payload.capabilities.surfaces.capabilities.api, { method: 'GET', path: '/api/tasks/capabilities' });
    assert.equal(payload.capabilities.surfaces.capabilities.mutates_task_db, false);
    assert.equal(payload.capabilities.surfaces.capabilities.writes_projection, false);
    assert.deepEqual(payload.capabilities.surfaces.capabilities.requires_task_db, {
      cli: false,
      api_route_handler: false,
      api_server: true,
    });
    assert.equal(payload.capabilities.surfaces.capabilities_check.read_only, true);
    assert.equal(payload.capabilities.surfaces.capabilities_check.mutates_task_db, false);
    assert.equal(payload.capabilities.surfaces.capabilities_check.writes_projection, true);
    assert.equal(payload.capabilities.surfaces.capabilities_check.requires_task_db, true);
    assert.deepEqual(payload.capabilities.surfaces.capabilities_check.api, { method: 'GET', path: '/api/tasks/capabilities/check' });
    assert.equal(payload.capabilities.surfaces.review_lane_drain.read_only, true);
    assert.equal(payload.capabilities.surfaces.review_lane_drain.mutates_task_db, false);
    assert.equal(payload.capabilities.surfaces.review_lane_drain.writes_projection, true);
    assert.equal(payload.capabilities.surfaces.review_lane_drain.requires_task_db, true);
    assert.equal(payload.capabilities.surfaces.review_lane_drain.skips_existing_follow_up_children, true);
    assert.deepEqual(payload.capabilities.surfaces.review_lane_drain.output_fields.identity, ['selected_task_id', 'selected_ref', 'selected_next_key']);
    assert.deepEqual(payload.capabilities.surfaces.review_lane_drain.api, { method: 'GET', path: '/api/tasks/review-lane-drain' });
    assert.equal(payload.capabilities.surfaces.review_lane_act.read_only, false);
    assert.equal(payload.capabilities.surfaces.review_lane_act.mutates_task_db, 'conditional');
    assert.equal(payload.capabilities.surfaces.review_lane_act.writes_projection, true);
    assert.equal(payload.capabilities.surfaces.review_lane_act.requires_task_db, true);
    assert.equal(payload.capabilities.surfaces.review_lane_act.dry_run_flag, '--dry-run');
    assert.deepEqual(payload.capabilities.surfaces.review_lane_act.api, { method: 'POST', path: '/api/tasks/review-lane-act' });
    assert.deepEqual(payload.capabilities.surfaces.review_lane_act.allowed_actions, ['review_chat', 'continue_work']);
    assert.ok(payload.capabilities.surfaces.review_lane_act.blocked_actions.includes('human_accept_waiting'));
    assert.deepEqual(payload.capabilities.surfaces.review_lane_act.output_fields.identity, ['selected_task_id', 'selected_ref', 'selected_next_key']);
    assert.equal(payload.capabilities.surfaces.review_lane_loop.read_only, false);
    assert.equal(payload.capabilities.surfaces.review_lane_loop.mutates_task_db, 'conditional');
    assert.equal(payload.capabilities.surfaces.review_lane_loop.writes_projection, true);
    assert.equal(payload.capabilities.surfaces.review_lane_loop.requires_task_db, true);
    assert.equal(payload.capabilities.surfaces.review_lane_loop.dry_run_flag, '--dry-run');
    assert.equal(payload.capabilities.surfaces.review_lane_loop.max_steps_flag, '--max-steps <n>');
    assert.equal(payload.capabilities.surfaces.review_lane_loop.default_max_steps, 3);
    assert.equal(payload.capabilities.surfaces.review_lane_loop.max_steps_cap, 10);
    assert.equal(payload.capabilities.surfaces.review_lane_loop.orchestrates, 'review_lane_act');
    assert.deepEqual(payload.capabilities.surfaces.review_lane_loop.api, { method: 'POST', path: '/api/tasks/review-lane-loop' });
    assert.deepEqual(payload.capabilities.surfaces.review_lane_loop.allowed_actions, ['review_chat', 'continue_work']);
    assert.ok(payload.capabilities.surfaces.review_lane_loop.stopped_by.includes('human_accept_waiting_is_human_only'));
    assert.ok(payload.capabilities.surfaces.review_lane_loop.stopped_by.includes('pending_review_chat_waiting_for_agent_review'));
    assert.ok(payload.capabilities.surfaces.review_lane_loop.stopped_by.includes('capabilities_check_failed'));
    assert.ok(payload.capabilities.surfaces.review_lane_loop.stopped_by.includes('repeat_selection'));
    assert.equal(payload.capabilities.surfaces.review_lane_run.read_only, false);
    assert.equal(payload.capabilities.surfaces.review_lane_run.mutates_task_db, 'conditional');
    assert.equal(payload.capabilities.surfaces.review_lane_run.writes_projection, true);
    assert.equal(payload.capabilities.surfaces.review_lane_run.writes_receipt, true);
    assert.equal(payload.capabilities.surfaces.review_lane_run.requires_task_db, true);
    assert.equal(payload.capabilities.surfaces.review_lane_run.dry_run_flag, '--dry-run');
    assert.equal(payload.capabilities.surfaces.review_lane_run.max_runs_flag, '--max-runs <n>');
    assert.equal(payload.capabilities.surfaces.review_lane_run.max_steps_flag, '--max-steps <n>');
    assert.equal(payload.capabilities.surfaces.review_lane_run.default_max_runs, 3);
    assert.equal(payload.capabilities.surfaces.review_lane_run.max_runs_cap, 20);
    assert.equal(payload.capabilities.surfaces.review_lane_run.default_max_steps, 3);
    assert.equal(payload.capabilities.surfaces.review_lane_run.max_steps_cap, 10);
    assert.equal(payload.capabilities.surfaces.review_lane_run.orchestrates, 'review_lane_loop');
    assert.deepEqual(payload.capabilities.surfaces.review_lane_run.api, { method: 'POST', path: '/api/tasks/review-lane-run' });
    assert.deepEqual(payload.capabilities.surfaces.review_lane_run.allowed_actions, ['review_chat', 'continue_work']);
    assert.equal(payload.capabilities.surfaces.review_lane_run.receipt_path, '.atris/state/review-lane-runs.jsonl');
    assert.equal(payload.capabilities.surfaces.review_lane_run.latest_receipt_path, '.atris/state/review-lane-run.latest.json');
    assert.ok(payload.capabilities.surfaces.review_lane_run.stopped_by.includes('continue_work_reused_existing_follow_up'));
    assert.ok(payload.capabilities.surfaces.review_lane_run.stopped_by.includes('human_accept_waiting_is_human_only'));
    assert.ok(payload.capabilities.surfaces.review_lane_run.stopped_by.includes('pending_review_chat_waiting_for_agent_review'));
    assert.ok(payload.capabilities.surfaces.review_lane_run.stopped_by.includes('capabilities_check_failed'));
    assert.ok(payload.capabilities.surfaces.review_lane_run.stopped_by.includes('max_runs_reached'));
    assert.equal(payload.capabilities.surfaces.current.read_only, true);
    assert.equal(payload.capabilities.surfaces.current.mutates_task_db, false);
    assert.equal(payload.capabilities.surfaces.current.writes_projection, true);
    assert.equal(payload.capabilities.surfaces.current.requires_task_db, true);
    assert.deepEqual(payload.capabilities.surfaces.current.output_fields.identity, ['selected_task_id', 'selected_ref', 'selected_next_key']);
    assert.equal(payload.capabilities.surfaces.queue.read_only, true);
    assert.equal(payload.capabilities.surfaces.queue.mutates_task_db, false);
    assert.equal(payload.capabilities.surfaces.queue.writes_projection, true);
    assert.equal(payload.capabilities.surfaces.queue.requires_task_db, true);
    assert.deepEqual(payload.capabilities.surfaces.queue.output_fields.identity, ['selected_task_id', 'selected_ref', 'selected_next_key']);
    assert.deepEqual(payload.capabilities.filters.review_state.accepted, ['needs-agent', 'continue-work', 'proof-boundary-blocked', 'human-accept-waiting', 'certified']);
    assert.equal(payload.capabilities.commands.capabilities, 'atris task capabilities --json');
    assert.equal(payload.capabilities.commands.capabilities_check, 'atris task capabilities-check --json');
    assert.equal(payload.capabilities.commands.review_lane_drain, 'atris task review-lane-drain --json');
    assert.equal(payload.capabilities.commands.review_lane_act, 'atris task review-lane-act --json');
    assert.equal(payload.capabilities.commands.review_lane_loop, 'atris task review-lane-loop --json');
    assert.equal(payload.capabilities.commands.review_lane_run, 'atris task review-lane-run --json');
    assert.equal(payload.capabilities.commands.current, 'atris task current --review-state <lane> --json');
    assert.equal(payload.capabilities.commands.queue, 'atris task queue --review-state <lane> --json');
    assert.equal(payload.capabilities.commands.current_step, 'atris task current-step --review-state <lane> --json');
    assert.equal(payload.capabilities.current_step.api.path, '/api/tasks/current/step?review_state=<lane>');
    assert.deepEqual(payload.capabilities.current_step.output_fields.identity, ['selected_task_id', 'selected_ref', 'selected_next_key']);
    assert.equal(payload.capabilities.current_step.safety.claims_work, 'conditional');
    assert.equal(payload.capabilities.current_step.lanes['continue-work'].creates_or_reuses_follow_up, true);
    assert.equal(payload.capabilities.current_step.lanes['human-accept-waiting'].safe_for_agent, false);
    assert.equal(payload.projection_path, undefined);

    const home = path.join(dir, 'home');
    fs.mkdirSync(path.join(home, '.atris'), { recursive: true });
    fs.writeFileSync(path.join(home, '.atris', '.update-check'), JSON.stringify({
      lastCheck: new Date().toISOString(),
      latestVersion: '99.99.99',
    }, null, 2));
    const noisyEnv = { ...process.env, HOME: home };
    delete noisyEnv.ATRIS_SKIP_UPDATE_CHECK;
    delete noisyEnv.NO_UPDATE_NOTIFIER;
    const cleanJsonCaps = spawnSync(process.execPath, [cliPath, 'task', 'capabilities', '--json'], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 15000,
      env: noisyEnv,
    });
    assert.equal(cleanJsonCaps.status, 0, cleanJsonCaps.stderr);
    assert.doesNotMatch(cleanJsonCaps.stdout, /Update available/);
    assert.deepEqual(JSON.parse(cleanJsonCaps.stdout).capabilities, payload.capabilities);

    const textCaps = runCli(['task', 'caps'], { cwd: dir });
    assert.equal(textCaps.status, 0, textCaps.stderr);
    assert.match(textCaps.stdout, /atris.task_capabilities.v1/);
    assert.match(textCaps.stdout, /review-state lanes: needs-agent, continue-work, proof-boundary-blocked, human-accept-waiting, certified/);
    assert.doesNotMatch(textCaps.stdout, /TASK QUEUE|TASK CURRENT/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('task capabilities-check reports contract drift without mutating task truth', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex', ATRIS_SKIP_UPDATE_CHECK: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const created = runCli(['task', 'add', 'Check capability conformance without mutating tasks', '--tag', 'agent', '--json'], { cwd: dir, env });
    assert.equal(created.status, 0, created.stderr);
    const task = JSON.parse(created.stdout).task;
    const before = runCli(['task', 'show', task.display_id, '--json'], { cwd: dir, env });
    assert.equal(before.status, 0, before.stderr);
    const beforePayload = JSON.parse(before.stdout);

    const report = runCli(['task', 'capabilities-check', '--json'], { cwd: dir, env });
    assert.equal(report.status, 0, report.stderr);
    const payload = JSON.parse(report.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.action, 'capabilities_check');
    assert.equal(payload.schema, 'atris.task_capabilities_check.v1');
    assert.equal(payload.capabilities.schema, 'atris.task_capabilities.v1');
    assert.equal(payload.summary.failed, 0);
    assert.equal(payload.summary.passed, payload.summary.total);
    assert.ok(payload.checks.some(check => check.name === 'current_capabilities_match_standalone' && check.ok));
    assert.ok(payload.checks.some(check => check.name === 'queue_capabilities_match_standalone' && check.ok));
    assert.ok(payload.checks.some(check => check.name === 'current_step_never_human_accepts' && check.ok));
    assert.ok(payload.checks.some(check => check.name === 'current_step_declares_identity_output_fields' && check.ok));
    assert.ok(payload.checks.some(check => check.name === 'current_and_queue_declare_identity_output_fields' && check.ok));
    assert.ok(payload.checks.some(check => check.name === 'review_lane_drain_declares_identity_output_fields' && check.ok));
    assert.ok(payload.checks.some(check => check.name === 'review_lane_act_declares_identity_output_fields' && check.ok));
    assert.ok(payload.checks.some(check => check.name === 'capabilities_check_surface_declared' && check.ok));
    assert.ok(payload.checks.some(check => check.name === 'review_lane_drain_surface_declared' && check.ok));
    const drainBehaviorCheck = payload.checks.find(check => check.name === 'review_lane_drain_behavior_conforms');
    assert.equal(drainBehaviorCheck.ok, true);
    assert.equal(drainBehaviorCheck.detail.prefers_review_chat, true);
    assert.equal(drainBehaviorCheck.detail.uses_continue_work_from_review_state_actions, true);
    assert.equal(drainBehaviorCheck.detail.selected_human_accept_waiting_is_non_executable, true);
    assert.equal(drainBehaviorCheck.detail.capability_drift_blocks_execution, true);
    assert.equal(drainBehaviorCheck.detail.skips_continue_work_with_existing_follow_up_child, true);
    assert.ok(payload.checks.some(check => check.name === 'review_lane_act_surface_declared' && check.ok));
    const actBehaviorCheck = payload.checks.find(check => check.name === 'review_lane_act_behavior_conforms');
    assert.equal(actBehaviorCheck.ok, true);
    assert.equal(actBehaviorCheck.detail.allows_review_chat, true);
    assert.equal(actBehaviorCheck.detail.allows_continue_work, true);
    assert.equal(actBehaviorCheck.detail.blocks_human_accept_waiting_even_if_marked_safe, true);
    assert.equal(actBehaviorCheck.detail.blocks_capability_drift, true);
    assert.ok(payload.checks.some(check => check.name === 'review_lane_loop_surface_declared' && check.ok));
    const loopBehaviorCheck = payload.checks.find(check => check.name === 'review_lane_loop_behavior_conforms');
    assert.equal(loopBehaviorCheck.ok, true);
    assert.equal(loopBehaviorCheck.detail.dry_run_stops_without_mutation, true);
    assert.equal(loopBehaviorCheck.detail.human_accept_waiting_stops_without_execution, true);
    assert.equal(loopBehaviorCheck.detail.pending_review_chat_stops_without_execution, true);
    assert.equal(loopBehaviorCheck.detail.no_action_stops_without_execution, true);
    assert.equal(loopBehaviorCheck.detail.repeat_selection_stops_before_duplicate_execution, true);
    assert.equal(loopBehaviorCheck.detail.capability_drift_blocks_loop, true);
    assert.equal(loopBehaviorCheck.detail.max_steps_are_bounded, true);
    assert.ok(payload.checks.some(check => check.name === 'review_lane_run_surface_declared' && check.ok));
    const runBehaviorCheck = payload.checks.find(check => check.name === 'review_lane_run_behavior_conforms');
    assert.equal(runBehaviorCheck.ok, true);
    assert.equal(runBehaviorCheck.detail.dry_run_stops_without_receipt, true);
    assert.equal(runBehaviorCheck.detail.human_accept_waiting_stops_without_execution, true);
    assert.equal(runBehaviorCheck.detail.pending_review_chat_stops_without_execution, true);
    assert.equal(runBehaviorCheck.detail.no_action_stops_without_execution, true);
    assert.equal(runBehaviorCheck.detail.repeat_selection_stops_before_duplicate_execution, true);
    assert.equal(runBehaviorCheck.detail.capability_drift_blocks_run, true);
    assert.equal(runBehaviorCheck.detail.max_runs_are_bounded, true);
    assert.equal(payload.safety.mutates_task_db, false);
    assert.equal(payload.safety.writes_projection, true);
    assert.equal(payload.safety.human_accept, false);
    assert.ok(payload.projection_path.endsWith(path.join('.atris', 'state', 'tasks.projection.json')));

    const after = runCli(['task', 'show', task.display_id, '--json'], { cwd: dir, env });
    assert.equal(after.status, 0, after.stderr);
    const afterPayload = JSON.parse(after.stdout);
    assert.equal(afterPayload.current_version, beforePayload.current_version);
    assert.equal(afterPayload.latest_event_type, beforePayload.latest_event_type);
    assert.equal(afterPayload.status, beforePayload.status);

    const textReport = runCli(['task', 'caps-check'], { cwd: dir, env });
    assert.equal(textReport.status, 0, textReport.stderr);
    assert.match(textReport.stdout, /TASK CAPABILITIES CHECK ok/);
    assert.match(textReport.stdout, /ok current_capabilities_match_standalone/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('task review-lane-drain picks safe agent action without mutating human accept rows', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex', ATRIS_SKIP_UPDATE_CHECK: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const continueCreated = runCli([
      'task', 'new', 'Certified drain task with executable continuation',
      '--tag', 'task',
      '--goal-id', 'OBL-928',
      '--json',
    ], { cwd: dir, env });
    assert.equal(continueCreated.status, 0, continueCreated.stderr);
    const continueTask = JSON.parse(continueCreated.stdout).task;
    const continueRef = continueTask.display_id;
    assert.equal(runCli([
      'task', 'ready', continueRef,
      '--as', 'codex',
      '--proof', 'node --check test/commands.test.js passed before review lane drain continuation',
    ], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'review', continueRef,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js passed during review lane drain continuation',
      '--next', 'Add the next safe review drain follow-up',
    ], { cwd: dir, env }).status, 0);

    const waitingCreated = runCli([
      'task', 'new', 'Certified drain task waiting for human accept',
      '--tag', 'task',
      '--goal-id', 'OBL-928',
      '--json',
    ], { cwd: dir, env });
    assert.equal(waitingCreated.status, 0, waitingCreated.stderr);
    const waitingTask = JSON.parse(waitingCreated.stdout).task;
    const waitingRef = waitingTask.display_id;
    assert.equal(runCli([
      'task', 'ready', waitingRef,
      '--as', 'codex',
      '--proof', 'node --check test/commands.test.js passed before review lane drain human gate',
    ], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'review', waitingRef,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js passed during review lane drain human gate',
    ], { cwd: dir, env }).status, 0);
    const beforeWaiting = JSON.parse(runCli(['task', 'show', waitingRef, '--json'], { cwd: dir, env }).stdout);

    const drain = runCli(['task', 'review-lane-drain', '--goal-id', 'OBL-928', '--json'], { cwd: dir, env });
    assert.equal(drain.status, 0, drain.stderr);
    const payload = JSON.parse(drain.stdout);
    const continueCommand = `atris task continue-work ${continueRef} --as codex --json`;
    assert.equal(payload.ok, true);
    assert.equal(payload.action, 'review_lane_drain');
    assert.equal(payload.schema, 'atris.task_review_lane_drain.v1');
    assert.equal(payload.selected_task_id, continueTask.id);
    assert.equal(payload.selected_ref, continueRef);
    assert.equal(payload.selected_next_key, 'continue_work');
    assert.equal(payload.capabilities_check.ok, true);
    assert.equal(payload.capabilities_check.summary.failed, 0);
    assert.ok(payload.capabilities_check.checks.some(check => check.name === 'review_lane_drain_surface_declared' && check.ok));
    assert.ok(payload.capabilities_check.checks.some(check => check.name === 'review_lane_drain_behavior_conforms' && check.ok));
    assert.equal(payload.review_state_counts.continue_work, 1);
    assert.equal(payload.review_state_counts.human_accept_waiting, 1);
    assert.equal(payload.review_state_actions.continue_work.command, continueCommand);
    assert.equal(payload.review_state_actions.human_accept_waiting.command, null);
    assert.equal(payload.review_state_actions.human_accept_waiting.api, null);
    assert.equal(payload.drain.next_action, 'continue_work');
    assert.equal(payload.drain.review_state, 'continue-work');
    assert.equal(payload.drain.safe_for_agent, true);
    assert.equal(payload.drain.command, continueCommand);
    assert.deepEqual(payload.drain.api, { method: 'POST', path: `/api/tasks/${continueTask.id}/continue-work` });
    assert.equal(payload.drain.human_accept_waiting.command, null);
    assert.equal(payload.drain.human_accept_waiting.api, null);
    assert.equal(payload.safety.mutates_task_db, false);
    assert.equal(payload.safety.writes_projection, true);
    assert.equal(payload.safety.human_accept, false);
    assert.equal(payload.safety.safe_to_execute_next_action, true);

    const afterWaiting = JSON.parse(runCli(['task', 'show', waitingRef, '--json'], { cwd: dir, env }).stdout);
    assert.equal(afterWaiting.current_version, beforeWaiting.current_version);
    assert.equal(afterWaiting.latest_event_type, beforeWaiting.latest_event_type);
    assert.equal(afterWaiting.status, beforeWaiting.status);

    const humanOnlyCreated = runCli([
      'task', 'new', 'Only human can accept this certified task',
      '--tag', 'task',
      '--goal-id', 'OBL-929',
      '--json',
    ], { cwd: dir, env });
    assert.equal(humanOnlyCreated.status, 0, humanOnlyCreated.stderr);
    const humanOnlyRef = JSON.parse(humanOnlyCreated.stdout).task.display_id;
    assert.equal(runCli([
      'task', 'ready', humanOnlyRef,
      '--as', 'codex',
      '--proof', 'node --check test/commands.test.js passed before human-only review lane drain',
    ], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'review', humanOnlyRef,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js passed during human-only review lane drain',
    ], { cwd: dir, env }).status, 0);
    const humanOnlyDrain = runCli(['task', 'review-lane-drain', '--goal-id', 'OBL-929', '--json'], { cwd: dir, env });
    assert.equal(humanOnlyDrain.status, 0, humanOnlyDrain.stderr);
    const humanOnlyPayload = JSON.parse(humanOnlyDrain.stdout);
    assert.equal(humanOnlyPayload.drain.next_action, 'human_accept_waiting');
    assert.equal(humanOnlyPayload.drain.safe_for_agent, false);
    assert.equal(humanOnlyPayload.drain.command, null);
    assert.equal(humanOnlyPayload.drain.api, null);
    assert.equal(humanOnlyPayload.drain.reason, 'human_accept_waiting_is_human_only');
    assert.equal(humanOnlyPayload.safety.safe_to_execute_next_action, false);

    const textDrain = runCli(['task', 'review-drain', '--goal-id', 'OBL-928'], { cwd: dir, env });
    assert.equal(textDrain.status, 0, textDrain.stderr);
    assert.match(textDrain.stdout, /TASK REVIEW LANE DRAIN ok/);
    assert.match(textDrain.stdout, /next: continue_work/);
    assert.match(textDrain.stdout, new RegExp(`command: atris task continue-work ${continueRef} --as codex --json`));
  } finally {
    cleanupTempDir(dir);
  }
});


test('task review-lane-act executes safe drain actions and refuses human accept rows', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex', ATRIS_SKIP_UPDATE_CHECK: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const reviewCreated = runCli([
      'task', 'new', 'Review lane act starts verification chat',
      '--tag', 'task',
      '--goal-id', 'OBL-931',
      '--json',
    ], { cwd: dir, env });
    assert.equal(reviewCreated.status, 0, reviewCreated.stderr);
    const reviewTask = JSON.parse(reviewCreated.stdout).task;
    const reviewRef = reviewTask.display_id;
    assert.equal(runCli([
      'task', 'ready', reviewRef,
      '--as', 'codex',
      '--proof', 'node --check test/commands.test.js passed before review-lane-act review chat',
    ], { cwd: dir, env }).status, 0);
    const beforeReviewChat = JSON.parse(runCli(['task', 'show', reviewRef, '--json'], { cwd: dir, env }).stdout);
    const reviewAct = runCli(['task', 'review-lane-act', '--goal-id', 'OBL-931', '--json'], { cwd: dir, env });
    assert.equal(reviewAct.status, 0, reviewAct.stderr);
    const reviewPayload = JSON.parse(reviewAct.stdout);
    assert.equal(reviewPayload.ok, true);
    assert.equal(reviewPayload.action, 'review_lane_act');
    assert.equal(reviewPayload.selected_action, 'review_chat');
    assert.equal(reviewPayload.acted, true);
    assert.equal(reviewPayload.drain.next_action, 'review_chat');
    assert.equal(reviewPayload.decision.step_action, 'review_chat');
    assert.equal(reviewPayload.result.action, 'review_chat');
    assert.equal(reviewPayload.result.appended, true);
    assert.equal(reviewPayload.safety.human_accept, false);
    const afterReviewChat = JSON.parse(runCli(['task', 'show', reviewRef, '--json'], { cwd: dir, env }).stdout);
    assert.equal(afterReviewChat.current_version, beforeReviewChat.current_version + 1);
    assert.ok(afterReviewChat.messages.some(message => message.content.includes('TASK_REVIEW_CHAT')));

    const continueCreated = runCli([
      'task', 'new', 'Review lane act continues certified work',
      '--tag', 'task',
      '--goal-id', 'OBL-932',
      '--json',
    ], { cwd: dir, env });
    assert.equal(continueCreated.status, 0, continueCreated.stderr);
    const continueTask = JSON.parse(continueCreated.stdout).task;
    const continueRef = continueTask.display_id;
    assert.equal(runCli([
      'task', 'ready', continueRef,
      '--as', 'codex',
      '--proof', 'node --check test/commands.test.js passed before review-lane-act continuation',
    ], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'review', continueRef,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js passed during review-lane-act continuation',
      '--next', 'Add the review lane act follow-up task',
    ], { cwd: dir, env }).status, 0);
    const beforeDryRun = JSON.parse(runCli(['task', 'show', continueRef, '--json'], { cwd: dir, env }).stdout);
    const dryRun = runCli(['task', 'review-lane-act', '--goal-id', 'OBL-932', '--dry-run', '--json'], { cwd: dir, env });
    assert.equal(dryRun.status, 0, dryRun.stderr);
    const dryPayload = JSON.parse(dryRun.stdout);
    assert.equal(dryPayload.ok, true);
    assert.equal(dryPayload.dry_run, true);
    assert.equal(dryPayload.acted, false);
    assert.equal(dryPayload.selected_task_id, continueTask.id);
    assert.equal(dryPayload.selected_ref, continueRef);
    assert.equal(dryPayload.selected_next_key, 'continue_work');
    assert.equal(dryPayload.decision.step_action, 'continue_work');
    assert.equal(dryPayload.safety.mutates_task_db, false);
    const afterDryRun = JSON.parse(runCli(['task', 'show', continueRef, '--json'], { cwd: dir, env }).stdout);
    assert.equal(afterDryRun.current_version, beforeDryRun.current_version);
    assert.deepEqual(afterDryRun.lineage.child_task_ids || [], beforeDryRun.lineage.child_task_ids || []);

    const continueAct = runCli(['task', 'review-lane-act', '--goal-id', 'OBL-932', '--json'], { cwd: dir, env });
    assert.equal(continueAct.status, 0, continueAct.stderr);
    const continuePayload = JSON.parse(continueAct.stdout);
    assert.equal(continuePayload.ok, true);
    assert.equal(continuePayload.selected_action, 'continue_work');
    assert.equal(continuePayload.acted, true);
    assert.equal(continuePayload.drain.next_action, 'continue_work');
    assert.equal(continuePayload.result.action, 'continue_work');
    assert.equal(continuePayload.result.created, true);
    assert.ok(continuePayload.result.next_task_id);
    assert.equal(continuePayload.result.safety.human_accept, false);

    const humanOnlyCreated = runCli([
      'task', 'new', 'Review lane act must not accept human-only row',
      '--tag', 'task',
      '--goal-id', 'OBL-933',
      '--json',
    ], { cwd: dir, env });
    assert.equal(humanOnlyCreated.status, 0, humanOnlyCreated.stderr);
    const humanOnlyRef = JSON.parse(humanOnlyCreated.stdout).task.display_id;
    assert.equal(runCli([
      'task', 'ready', humanOnlyRef,
      '--as', 'codex',
      '--proof', 'node --check test/commands.test.js passed before review-lane-act human gate',
    ], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'review', humanOnlyRef,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js passed during review-lane-act human gate',
    ], { cwd: dir, env }).status, 0);
    const blocked = runCli(['task', 'review-lane-act', '--goal-id', 'OBL-933', '--json'], { cwd: dir, env });
    assert.notEqual(blocked.status, 0);
    const blockedPayload = JSON.parse(blocked.stdout);
    assert.equal(blockedPayload.ok, false);
    assert.equal(blockedPayload.acted, false);
    assert.equal(blockedPayload.reason, 'human_accept_waiting_is_human_only');
    assert.equal(blockedPayload.selected_ref, humanOnlyRef);
    assert.equal(blockedPayload.selected_next_key, 'human_accept_waiting');
    assert.equal(blockedPayload.drain.next_action, 'human_accept_waiting');
    assert.equal(blockedPayload.drain.command, null);
    assert.equal(blockedPayload.drain.api, null);
    assert.equal(blockedPayload.safety.human_accept, false);
  } finally {
    cleanupTempDir(dir);
  }
});


test('task review-lane-act executes only safe drain actions and supports dry-run', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex', ATRIS_SKIP_UPDATE_CHECK: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const needsCreated = runCli([
      'task', 'new', 'Review lane act should start verification chat',
      '--tag', 'task',
      '--goal-id', 'OBL-940',
      '--json',
    ], { cwd: dir, env });
    assert.equal(needsCreated.status, 0, needsCreated.stderr);
    const needsTask = JSON.parse(needsCreated.stdout).task;
    const needsRef = needsTask.display_id;
    assert.equal(runCli([
      'task', 'ready', needsRef,
      '--as', 'codex',
      '--proof', 'node --check test/commands.test.js passed before review-lane-act chat',
    ], { cwd: dir, env }).status, 0);
    const beforeNeeds = JSON.parse(runCli(['task', 'show', needsRef, '--json'], { cwd: dir, env }).stdout);

    const dryReviewChat = runCli(['task', 'review-lane-act', '--goal-id', 'OBL-940', '--dry-run', '--json'], { cwd: dir, env });
    assert.equal(dryReviewChat.status, 0, dryReviewChat.stderr);
    const dryReviewChatPayload = JSON.parse(dryReviewChat.stdout);
    assert.equal(dryReviewChatPayload.ok, true);
    assert.equal(dryReviewChatPayload.acted, false);
    assert.equal(dryReviewChatPayload.dry_run, true);
    assert.equal(dryReviewChatPayload.decision.step_action, 'review_chat');
    assert.equal(dryReviewChatPayload.safety.read_only, true);
    assert.equal(dryReviewChatPayload.safety.human_accept, false);
    const afterDryNeeds = JSON.parse(runCli(['task', 'show', needsRef, '--json'], { cwd: dir, env }).stdout);
    assert.equal(afterDryNeeds.current_version, beforeNeeds.current_version);

    const liveReviewChat = runCli(['task', 'review-lane-act', '--goal-id', 'OBL-940', '--json'], { cwd: dir, env });
    assert.equal(liveReviewChat.status, 0, liveReviewChat.stderr);
    const liveReviewChatPayload = JSON.parse(liveReviewChat.stdout);
    assert.equal(liveReviewChatPayload.ok, true);
    assert.equal(liveReviewChatPayload.acted, true);
    assert.equal(liveReviewChatPayload.selected_action, 'review_chat');
    assert.equal(liveReviewChatPayload.result.action, 'review_chat');
    assert.equal(liveReviewChatPayload.result.appended, true);
    assert.equal(liveReviewChatPayload.safety.human_accept, false);
    const afterLiveNeeds = JSON.parse(runCli(['task', 'show', needsRef, '--json'], { cwd: dir, env }).stdout);
    assert.equal(afterLiveNeeds.current_version, beforeNeeds.current_version + 1);
    assert.equal(afterLiveNeeds.latest_event_type, 'message');

    const continueCreated = runCli([
      'task', 'new', 'Review lane act should continue certified task',
      '--tag', 'task',
      '--goal-id', 'OBL-941',
      '--json',
    ], { cwd: dir, env });
    assert.equal(continueCreated.status, 0, continueCreated.stderr);
    const continueTask = JSON.parse(continueCreated.stdout).task;
    const continueRef = continueTask.display_id;
    assert.equal(runCli([
      'task', 'ready', continueRef,
      '--as', 'codex',
      '--proof', 'node --check test/commands.test.js passed before review-lane-act continuation',
    ], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'review', continueRef,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js passed during review-lane-act continuation',
      '--next', 'Add a follow-up created by review lane act',
    ], { cwd: dir, env }).status, 0);

    const waitingCreated = runCli([
      'task', 'new', 'Review lane act should leave human accept alone',
      '--tag', 'task',
      '--goal-id', 'OBL-941',
      '--json',
    ], { cwd: dir, env });
    assert.equal(waitingCreated.status, 0, waitingCreated.stderr);
    const waitingRef = JSON.parse(waitingCreated.stdout).task.display_id;
    assert.equal(runCli([
      'task', 'ready', waitingRef,
      '--as', 'codex',
      '--proof', 'node --check test/commands.test.js passed before review-lane-act human gate',
    ], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'review', waitingRef,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js passed during review-lane-act human gate',
    ], { cwd: dir, env }).status, 0);
    const beforeWaiting = JSON.parse(runCli(['task', 'show', waitingRef, '--json'], { cwd: dir, env }).stdout);
    const beforeContinue = JSON.parse(runCli(['task', 'show', continueRef, '--json'], { cwd: dir, env }).stdout);

    const dryContinue = runCli(['task', 'review-lane-act', '--goal-id', 'OBL-941', '--dry-run', '--json'], { cwd: dir, env });
    assert.equal(dryContinue.status, 0, dryContinue.stderr);
    const dryContinuePayload = JSON.parse(dryContinue.stdout);
    assert.equal(dryContinuePayload.ok, true);
    assert.equal(dryContinuePayload.acted, false);
    assert.equal(dryContinuePayload.decision.step_action, 'continue_work');
    assert.equal(dryContinuePayload.safety.read_only, true);
    const afterDryContinue = JSON.parse(runCli(['task', 'show', continueRef, '--json'], { cwd: dir, env }).stdout);
    assert.equal(afterDryContinue.current_version, beforeContinue.current_version);

    const liveContinue = runCli(['task', 'review-lane-act', '--goal-id', 'OBL-941', '--json'], { cwd: dir, env });
    assert.equal(liveContinue.status, 0, liveContinue.stderr);
    const liveContinuePayload = JSON.parse(liveContinue.stdout);
    assert.equal(liveContinuePayload.ok, true);
    assert.equal(liveContinuePayload.acted, true);
    assert.equal(liveContinuePayload.selected_action, 'continue_work');
    assert.equal(liveContinuePayload.result.action, 'continue_work');
    assert.equal(liveContinuePayload.result.parent_task_id, continueTask.id);
    assert.equal(liveContinuePayload.result.next_task.title, 'Add a follow-up created by review lane act');
    assert.equal(liveContinuePayload.safety.human_accept, false);
    const afterWaiting = JSON.parse(runCli(['task', 'show', waitingRef, '--json'], { cwd: dir, env }).stdout);
    assert.equal(afterWaiting.current_version, beforeWaiting.current_version);
    assert.equal(afterWaiting.latest_event_type, beforeWaiting.latest_event_type);

    const humanOnlyCreated = runCli([
      'task', 'new', 'Review lane act must not human accept',
      '--tag', 'task',
      '--goal-id', 'OBL-942',
      '--json',
    ], { cwd: dir, env });
    assert.equal(humanOnlyCreated.status, 0, humanOnlyCreated.stderr);
    const humanOnlyRef = JSON.parse(humanOnlyCreated.stdout).task.display_id;
    assert.equal(runCli([
      'task', 'ready', humanOnlyRef,
      '--as', 'codex',
      '--proof', 'node --check test/commands.test.js passed before review-lane-act human only',
    ], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'review', humanOnlyRef,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js passed during review-lane-act human only',
    ], { cwd: dir, env }).status, 0);
    const beforeHumanOnly = JSON.parse(runCli(['task', 'show', humanOnlyRef, '--json'], { cwd: dir, env }).stdout);
    const blockedHumanOnly = runCli(['task', 'review-lane-act', '--goal-id', 'OBL-942', '--json'], { cwd: dir, env });
    assert.equal(blockedHumanOnly.status, 1);
    const blockedPayload = JSON.parse(blockedHumanOnly.stdout);
    assert.equal(blockedPayload.ok, false);
    assert.equal(blockedPayload.acted, false);
    assert.equal(blockedPayload.reason, 'human_accept_waiting_is_human_only');
    assert.equal(blockedPayload.safety.human_accept, false);
    assert.equal(blockedPayload.drain.command, null);
    assert.equal(blockedPayload.drain.api, null);
    const afterHumanOnly = JSON.parse(runCli(['task', 'show', humanOnlyRef, '--json'], { cwd: dir, env }).stdout);
    assert.equal(afterHumanOnly.current_version, beforeHumanOnly.current_version);
  } finally {
    cleanupTempDir(dir);
  }
});
