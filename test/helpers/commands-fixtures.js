// Shared imports and fixture helpers for test/commands-*.test.js.
const assert = require('node:assert/strict');

const fs = require('node:fs');

const os = require('node:os');

const path = require('node:path');

const http = require('node:http');

const { spawn, spawnSync } = require('node:child_process');

const { buildManifest, computeLocalHashes, threeWayCompare } = require('../../lib/manifest');

const { acceptedInLastDay, writePolicy } = require('../../lib/autoland');

const taskStore = require('../../lib/task-db');

const { branchName, cleanupWorktrees, createOrFindPr, defaultStartBase, normalizeTargetRef, parseWorktrees, slugify, swarloClaim } = require('../../commands/worktree');

const { ensureWikiScaffold, normalizeWikiOnlyPrefix, validateAgentReadableWikiPages } = require('../../lib/wiki');

const { formatLocalDate } = require('../../commands/now');

const {
  analyzeBusinessDoctor,
  businessMatchesSlug,
  collectBusinessShareState,
  createCanonicalBusinessWorkspace,
  onboardBusiness,
  renderBusinessCreatedNextSteps,
  shareBusinessWorkspace,
  recordBusinessRun
} = require('../../commands/business');

const {
  collectSnapshot,
  parseLiveOptions,
  shouldIgnore,
  snapshotsDiffer,
} = require('../../commands/live');

const { buildPullConflictReviewPacket, mergeSmartPullFiles, normalizePullFilePath } = require('../../commands/pull');

const {
  analyzePushSafety,
  basenameOfManifestPath,
  buildCloudHashMap,
  buildPushChangePlan,
  isBusinessWorkspaceRoot,
  resolvePushSourceDir,
  shouldRetrySyncIndividually,
} = require('../../commands/push');

const { collectState } = require('../../commands/brain');

const {
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
  snapshotsDiffer: brainSnapshotsDiffer,
  writeSyncStatus,
} = require('../../commands/business-sync');

const { writeBaseContents, writeConflictReviewPacket } = require('../../lib/company-brain-sync');

const { getScorecardsPath, readScorecards } = require('../../lib/scorecard');

const {
  computeTickReward,
  verifyJudgeIntegrity,
  getVerifyCommand,
  getRecentSignals,
  maybeWriteCompletedEndgameScorecard,
  renderHumanSuggestion,
  renderHumanTickIntro,
  scoreEndgameCandidates,
  suggestNextTask,
  writeLesson
} = require('../../commands/autopilot');

const { REWARD_CONFIG, REWARD_CHECKSUM } = require('../../lib/reward-config');

const { scrubAgentEnv } = require('./agent-env');

const repoRoot = path.resolve(__dirname, '..', '..');

const cliPath = path.join(repoRoot, 'bin', 'atris.js');

const FIXTURE_RESULT_SENTENCE = 'Operators can now understand completed test work faster because the result is named.';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-cmd-test-'));
}

// Date stamp for log fixtures inside the scanner's recency window (7 days).
// Hardcoded dates rot as the calendar moves; this keeps wake-scan fixtures
// permanently "recent" without pinning tests to today's date at author time.
function recentLogDate(daysAgo = 0) {
  const d = new Date(Date.now() - daysAgo * 864e5);
  return d.toISOString().slice(0, 10);
}

// Year segment for a recent date's log path (atris/logs/<year>/<date>.md).
function recentLogYear(daysAgo = 0) {
  return recentLogDate(daysAgo).slice(0, 4);
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function seedBusinessOsState(dir) {
  const stateDir = path.join(dir, '.atris', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'tasks.projection.json'), JSON.stringify({
    tasks: [
      { display_id: 'BIZ-1', title: 'Work next loop', status: 'open', metadata: {} },
      { display_id: 'BIZ-2', title: 'Ship handoff proof', status: 'claimed', metadata: { assigned_to: 'operator' } },
      { display_id: 'BIZ-3', title: 'Review proof', status: 'review', metadata: { agent_certified: true } },
    ],
  }, null, 2));
  fs.writeFileSync(path.join(stateDir, 'missions.jsonl'), `${JSON.stringify({
    id: 'mission-biz-loop',
    objective: 'Keep the business loop moving',
    status: 'running',
    always_on: true,
    verifier: 'atris business check',
    last_tick_at: new Date().toISOString(),
  })}\n`);
  fs.writeFileSync(path.join(stateDir, 'mission_events.jsonl'), `${JSON.stringify({
    type: 'mission_tick',
    at: new Date().toISOString(),
  })}\n`);
  fs.writeFileSync(path.join(stateDir, 'codex_goal.json'), JSON.stringify({
    goal: { objective: 'Keep the business loop moving', mission_id: 'mission-biz-loop' },
  }, null, 2));
  fs.writeFileSync(path.join(stateDir, 'career_xp.projection.json'), JSON.stringify({
    metric_label: 'AgentXP',
    total_agent_xp: 12,
    today_agent_xp: 2,
    integrity_status: 'ok',
  }, null, 2));
  fs.writeFileSync(path.join(stateDir, 'career_xp_receipts.jsonl'), `${JSON.stringify({
    task_ref: 'BIZ-0',
    reward: 2,
  })}\n`);
  const goalsPath = path.join(dir, 'atris', 'team', 'operator', 'goals.json');
  fs.writeFileSync(goalsPath, JSON.stringify({
    goals: [{ title: 'Run first customer loop', status: 'active' }],
  }, null, 2));
}

function withFixtureReadyResult(args) {
  if (!Array.isArray(args) || args[0] !== 'task') return args;
  let next = args;
  if (args[1] === 'ready' && !args.includes('--result')) {
    next = [...next, '--result', FIXTURE_RESULT_SENTENCE];
  }
  if ((args[1] === 'ready' || args[1] === 'current-step') && next.includes('--json') && !next.includes('--full')) {
    next = [...next, '--full'];
  }
  return next;
}

function runCli(args, { cwd, input, env, timeout = 15000 } = {}) {
  const cliArgs = withFixtureReadyResult(args);
  const result = spawnSync(process.execPath, [cliPath, ...cliArgs], {
    cwd,
    input,
    encoding: 'utf8',
    timeout,
    env: {
      ...scrubAgentEnv(),
      ATRIS_SKIP_UPDATE_CHECK: '1',
      ...(env || {}),
    },
  });
  if (result.error) throw result.error;
  return result;
}

function fakeMemberRunClaude(dir) {
  const bin = path.join(dir, 'fake-bin');
  fs.mkdirSync(bin, { recursive: true });
  const executable = path.join(bin, 'claude');
  fs.writeFileSync(executable, [
    '#!/bin/sh',
    'if [ "$1" = "--help" ]; then echo "--output-format --permission-mode --resume --session-id --include-partial-messages"; exit 0; fi',
    'echo \'{"type":"result","is_error":false,"result":"finished bounded work"}\'',
    '',
  ].join('\n'));
  fs.chmodSync(executable, 0o755);
  return { PATH: `${bin}${path.delimiter}${process.env.PATH || ''}` };
}

// A worktree branch reused across more than one `worktree ship` call (the
// exact shape of this session: several commits landed one at a time from the
// same worktree) hits a real `gh` quirk: `gh pr view` with no --state filter
// returns ANY pr for the branch name, including one already MERGED or
// CLOSED, and `gh pr merge <already-merged-pr>` exits 0 with just a warning
// instead of failing. Together those silently no-op the landing of new
// commits while `worktree ship` still reports success. This fake `gh`
// stands in for the real CLI so the state-filter fix is provable without a
// live GitHub repo.
function makeFakeGh(dir, { viewState = 'OPEN', viewNumber = 42, createNumber = 99, mergeAlreadyMerged = false } = {}) {
  const binDir = path.join(dir, 'fake-bin');
  fs.mkdirSync(binDir, { recursive: true });
  const ghPath = path.join(binDir, 'gh');
  fs.writeFileSync(ghPath, `#!/bin/sh
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  echo "${viewNumber} https://example.com/pull/${viewNumber} ${viewState}"
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "create" ]; then
  echo "https://example.com/pull/${createNumber}"
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "merge" ]; then
  if [ "${mergeAlreadyMerged}" = "true" ]; then
    echo "! Pull request already merged" 1>&2
    exit 0
  fi
  echo "merged"
  exit 0
fi
exit 1
`, { mode: 0o755 });
  return binDir;
}

function seedSupervisorWakeFixture(dir) {
  fs.mkdirSync(path.join(dir, 'atris', 'team', 'supervisor'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'atris', 'team', 'supervisor', 'MEMBER.md'), [
    '---',
    'name: supervisor',
    'role: Meta-cognition Layer',
    'description: Monitors member performance and adjusts coordination',
    'skills: []',
    'permissions:',
    '  can-read: true',
    '  can-execute: true',
    '  can-approve: false',
    '---',
    '',
    '# Supervisor',
    '',
    'Monitor all member performance, identify patterns, suggest coordination adjustments.',
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(dir, 'atris', 'team', 'supervisor', 'MISSION.md'), [
    '# Mission',
    '',
    '## North Star',
    '',
    'Optimize member coordination through data-driven meta-cognition.',
    '',
  ].join('\n'), 'utf8');
  fs.mkdirSync(path.join(dir, 'atris', 'runs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'atris', 'runs', 'member-wake-signal-scout-2026-06-04T09-00-00-000Z.json'), JSON.stringify({
    schema: 'atris.member_wake.v1',
    created_at: new Date().toISOString(),
    member: 'signal-scout',
    ok: true,
    decision: 'wait',
    reason: 'tick_executed_experiment_proposed',
    duration_ms: 1200,
  }, null, 2), 'utf8');
}

function hasNodeSqlite() {
  const result = spawnSync(process.execPath, ['-e', 'require("node:sqlite")'], {
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  return result.status === 0;
}

function waitForOutput(child, pattern, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${pattern}; output=${output}`)), timeoutMs);
    const onData = (chunk) => {
      output += chunk.toString();
      const match = output.match(pattern);
      if (match) {
        clearTimeout(timer);
        resolve({ output, match });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`process exited ${code}; output=${output}`));
    });
  });
}

function runGit(args, cwd) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  return result;
}

function initWorkspace(dir) {
  runCli(['init'], { cwd: dir, input: '\n' });
}

function writeLiveMission(dir) {
  const stateDir = path.join(dir, '.atris', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(stateDir, 'missions.jsonl'), `${JSON.stringify({
    schema: 'atris.mission.v1',
    id: 'mission-live',
    objective: 'Keep the live mission visible',
    owner: 'executor',
    status: 'running',
    created_at: now,
    updated_at: now,
  })}\n`);
}

function writeTodayLog(dir, content) {
  const now = new Date();
  const yyyy = now.getFullYear().toString();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const dateStr = `${yyyy}-${mm}-${dd}`;
  const yearDir = path.join(dir, 'atris', 'logs', yyyy);
  fs.mkdirSync(yearDir, { recursive: true });
  const logFile = path.join(yearDir, `${dateStr}.md`);
  fs.writeFileSync(logFile, content, 'utf8');
  return logFile;
}

// ============================================
// brain
// ============================================

function seedBrainWorkspace(dir) {
  fs.mkdirSync(path.join(dir, 'atris', 'wiki'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'atris', 'team', 'justin'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.atris', 'business.json'), JSON.stringify({
    slug: 'demo-lab',
    business_id: 'biz_123',
    workspace_id: 'ws_123',
    name: 'Demo Lab',
  }), 'utf8');
  fs.writeFileSync(path.join(dir, 'atris', 'MAP.md'), '# Demo Map\n\n| Path | What |\n|---|---|\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), '# TODO\n\n- [ ] Ship one thing\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'atris', 'team', 'justin', 'MEMBER.md'), '# Justin McDonald\n\nForward Deployed GTM Operator\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'atris', 'team', 'justin', 'START_HERE.md'), '# Justin Start Here\n\nPick one customer-moving GTM rep.\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'atris', 'team', 'justin', 'goals.md'), '# Goals\n\nRun one customer-moving rep each work block.\n', 'utf8');
  fs.mkdirSync(path.join(dir, 'atris', 'team', 'keshav'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'atris', 'team', 'keshav', 'MEMBER.md'), '# Keshav Rao\n\nCEO and Builder\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'atris', 'team', 'keshav', 'START_HERE.md'), '# Keshav Start Here\n\nOpen the CEO lab loop.\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'atris', 'wiki', 'STATUS.md'), '# Wiki Status\n\n- Health: seeded\n', 'utf8');
  fs.writeFileSync(path.join(dir, '.atris', 'state', 'agent_mail.jsonl'), JSON.stringify({
    ts: '2026-04-29T00:00:00Z',
    subject: 'hello',
  }) + '\n', 'utf8');
}

function advertisedAtrisPaths(text) {
  return Array.from(String(text || '').matchAll(/`(atris\/[^`\s]+)`/g), match => match[1]);
}

function assertAdvertisedAtrisPathsExist(dir, text) {
  const missing = advertisedAtrisPaths(text)
    .filter(rel => !fs.existsSync(path.join(dir, rel)));
  assert.deepEqual(missing, []);
}

module.exports = {
  assert,
  fs,
  os,
  path,
  http,
  spawn,
  spawnSync,
  buildManifest,
  computeLocalHashes,
  threeWayCompare,
  acceptedInLastDay,
  writePolicy,
  taskStore,
  branchName,
  cleanupWorktrees,
  createOrFindPr,
  defaultStartBase,
  normalizeTargetRef,
  parseWorktrees,
  slugify,
  swarloClaim,
  ensureWikiScaffold,
  normalizeWikiOnlyPrefix,
  validateAgentReadableWikiPages,
  formatLocalDate,
  analyzeBusinessDoctor,
  businessMatchesSlug,
  collectBusinessShareState,
  createCanonicalBusinessWorkspace,
  onboardBusiness,
  renderBusinessCreatedNextSteps,
  shareBusinessWorkspace,
  recordBusinessRun,
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
  getScorecardsPath,
  readScorecards,
  computeTickReward,
  verifyJudgeIntegrity,
  getVerifyCommand,
  getRecentSignals,
  maybeWriteCompletedEndgameScorecard,
  renderHumanSuggestion,
  renderHumanTickIntro,
  scoreEndgameCandidates,
  suggestNextTask,
  writeLesson,
  REWARD_CONFIG,
  REWARD_CHECKSUM,
  scrubAgentEnv,
  repoRoot,
  cliPath,
  FIXTURE_RESULT_SENTENCE,
  makeTempDir,
  recentLogDate,
  recentLogYear,
  cleanupTempDir,
  seedBusinessOsState,
  withFixtureReadyResult,
  runCli,
  fakeMemberRunClaude,
  makeFakeGh,
  seedSupervisorWakeFixture,
  hasNodeSqlite,
  waitForOutput,
  runGit,
  initWorkspace,
  writeLiveMission,
  writeTodayLog,
  seedBrainWorkspace,
  advertisedAtrisPaths,
  assertAdvertisedAtrisPathsExist,
};
