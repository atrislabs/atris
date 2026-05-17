const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { buildManifest, computeLocalHashes, threeWayCompare } = require('../lib/manifest');
const { branchName, defaultStartBase, normalizeTargetRef, parseWorktrees, slugify, swarloClaim } = require('../commands/worktree');
const { ensureWikiScaffold, normalizeWikiOnlyPrefix, validateAgentReadableWikiPages } = require('../lib/wiki');
const { formatLocalDate } = require('../commands/now');
const {
  analyzeBusinessDoctor,
  businessMatchesSlug,
  createCanonicalBusinessWorkspace,
  onboardBusiness,
  recordBusinessRun
} = require('../commands/business');
const {
  collectSnapshot,
  parseLiveOptions,
  shouldIgnore,
  snapshotsDiffer,
} = require('../commands/live');
const { buildPullConflictReviewPacket, mergeSmartPullFiles, normalizePullFilePath } = require('../commands/pull');
const {
  analyzePushSafety,
  basenameOfManifestPath,
  buildCloudHashMap,
  buildPushChangePlan,
  isBusinessWorkspaceRoot,
  resolvePushSourceDir,
  shouldRetrySyncIndividually,
} = require('../commands/push');
const { collectState } = require('../commands/brain');
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
} = require('../commands/business-sync');
const { writeBaseContents, writeConflictReviewPacket } = require('../lib/company-brain-sync');
const { getScorecardsPath, readScorecards } = require('../lib/scorecard');
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
} = require('../commands/autopilot');
const { REWARD_CONFIG, REWARD_CHECKSUM } = require('../lib/reward-config');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-cmd-test-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runCli(args, { cwd, input, env } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    input,
    encoding: 'utf8',
    timeout: 15000,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      ...(env || {}),
    },
  });
  if (result.error) throw result.error;
  return result;
}

test('member create initializes MEMBER.md and dated logs', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const res = runCli(['member', 'create', 'member-trainer', '--role="Member Trainer"', '--description="Trains teammates before autonomy"'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const memberPath = path.join(dir, 'atris', 'team', 'member-trainer', 'MEMBER.md');
    const missionPath = path.join(dir, 'atris', 'team', 'member-trainer', 'MISSION.md');
    const logsDir = path.join(dir, 'atris', 'team', 'member-trainer', 'logs');
    assert.ok(fs.existsSync(memberPath));
    assert.ok(fs.existsSync(missionPath));
    assert.match(fs.readFileSync(missionPath, 'utf8'), /# Mission/);
    assert.ok(fs.existsSync(logsDir));
    const logs = fs.readdirSync(logsDir).filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name));
    assert.equal(logs.length, 1);
    const log = fs.readFileSync(path.join(logsDir, logs[0]), 'utf8');
    assert.match(log, /Member initialized/);
    assert.match(log, /Trains teammates before autonomy/);
    assert.match(res.stdout, /logs\/\d{4}-\d{2}-\d{2}\.md/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('worktree helpers keep member identity in branch and parse git worktrees', () => {
  assert.equal(slugify('Security Agent!!'), 'security-agent');
  assert.equal(
    branchName('security', 'OAuth timeout hardening', new Date('2026-05-11T08:09:10Z')),
    'codex/security-oauth-timeout-hardening-20260511-080910'
  );

  const parsed = parseWorktrees(`
worktree /repo/main
HEAD abc123
branch refs/heads/main

worktree /repo/.agent-worktrees/security
HEAD def456
branch refs/heads/codex/security-task
`);
  assert.deepEqual(parsed, [
    { path: '/repo/main', branch: 'main', head: 'abc123' },
    { path: '/repo/.agent-worktrees/security', branch: 'codex/security-task', head: 'def456' },
  ]);
});

test('worktree swarlo claim is best-effort when local bridge is absent', () => {
  const dir = makeTempDir();
  try {
    assert.equal(
      swarloClaim(dir, { channel: 'general', taskKey: 'security-task', content: 'security owns task' }),
      'skip: scripts/swarlo.py not found'
    );
  } finally {
    cleanupTempDir(dir);
  }
});

test('worktree guide prints the agent mission ship recipe', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['worktree', 'guide'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /Atris worktree agent recipe/);
    assert.match(res.stdout, /atris mission start/);
    assert.match(res.stdout, /atris member goal-from-mission/);
    assert.match(res.stdout, /atris worktree ship --message/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('worktree start creates a member-scoped isolated checkout', () => {
  const dir = makeTempDir();
  let worktreePath;
  try {
    const runGit = (args, cwd = dir) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return result.stdout.trim();
    };
    runGit(['init', '-q']);
    runGit(['config', 'user.email', 'test@example.com']);
    runGit(['config', 'user.name', 'Test User']);
    fs.mkdirSync(path.join(dir, 'atris', 'team', 'security'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'team', 'security', 'MEMBER.md'), '# Security\n');
    runGit(['add', '.']);
    runGit(['commit', '-qm', 'init']);

    worktreePath = path.join(dir, '..', `${path.basename(dir)}-security-worktree`);
    const res = runCli([
      'worktree',
      'start',
      '--member',
      'security',
      '--task',
      'Smoke Task',
      '--path',
      worktreePath,
    ], { cwd: dir });

    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, new RegExp(`path: ${worktreePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.equal(fs.existsSync(path.join(worktreePath, 'atris', 'team', 'security', 'MEMBER.md')), true);
    assert.match(runGit(['branch', '--show-current'], worktreePath), /^codex\/security-smoke-task-/);
  } finally {
    if (worktreePath) cleanupTempDir(worktreePath);
    cleanupTempDir(dir);
  }
});

test('worktree start supports generic subagent checkout without a member persona', () => {
  const dir = makeTempDir();
  let worktreePath;
  try {
    const runGit = (args, cwd = dir) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return result.stdout.trim();
    };
    runGit(['init', '-q']);
    runGit(['config', 'user.email', 'test@example.com']);
    runGit(['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(dir, 'README.md'), '# Smoke\n');
    runGit(['add', '.']);
    runGit(['commit', '-qm', 'init']);

    worktreePath = path.join(dir, '..', `${path.basename(dir)}-subagent-worktree`);
    const res = runCli([
      'worktree',
      'start',
      '--agent',
      'codex-reviewer',
      '--task',
      'Smoke Task',
      '--path',
      worktreePath,
    ], { cwd: dir });

    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /agent: codex-reviewer/);
    assert.doesNotMatch(res.stderr, /no member persona/);
    assert.equal(fs.existsSync(path.join(worktreePath, 'README.md')), true);
    assert.match(runGit(['branch', '--show-current'], worktreePath), /^codex\/codex-reviewer-smoke-task-/);
  } finally {
    if (worktreePath) cleanupTempDir(worktreePath);
    cleanupTempDir(dir);
  }
});

test('worktree start defaults to upstream remote base and records ship metadata', () => {
  const dir = makeTempDir();
  let worktreePath;
  try {
    const remote = path.join(dir, 'remote.git');
    const repo = path.join(dir, 'repo');
    const runGit = (args, cwd = repo) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return result.stdout.trim();
    };
    fs.mkdirSync(repo);
    spawnSync('git', ['init', '--bare', '-q', remote], { encoding: 'utf8' });
    runGit(['init', '-q']);
    runGit(['config', 'user.email', 'test@example.com']);
    runGit(['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# Smoke\n');
    runGit(['add', '.']);
    runGit(['commit', '-qm', 'init']);
    runGit(['branch', '-M', 'master']);
    runGit(['remote', 'add', 'origin', remote]);
    runGit(['push', '-u', 'origin', 'master']);
    runGit(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/master']);

    assert.equal(defaultStartBase(repo), 'origin/master');
    assert.equal(normalizeTargetRef(repo, 'master'), 'origin/master');
    worktreePath = path.join(dir, 'agent-worktree');
    const res = runCli([
      'worktree',
      'start',
      '--agent',
      'codex-shipper',
      '--task',
      'Ship Smoke',
      '--path',
      worktreePath,
    ], { cwd: repo });

    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /base: origin\/master/);
    const branch = runGit(['branch', '--show-current'], worktreePath);
    assert.match(branch, /^codex\/codex-shipper-ship-smoke-/);
    assert.equal(runGit(['config', '--get', `branch.${branch}.atris-base`], worktreePath), 'origin/master');
  } finally {
    if (worktreePath) cleanupTempDir(worktreePath);
    cleanupTempDir(dir);
  }
});

test('worktree ship commits verifies and pushes an isolated branch', () => {
  const dir = makeTempDir();
  let worktreePath;
  try {
    const remote = path.join(dir, 'remote.git');
    const repo = path.join(dir, 'repo');
    const runGit = (args, cwd = repo) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return result.stdout.trim();
    };
    fs.mkdirSync(repo);
    spawnSync('git', ['init', '--bare', '-q', remote], { encoding: 'utf8' });
    runGit(['init', '-q']);
    runGit(['config', 'user.email', 'test@example.com']);
    runGit(['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# Smoke\n');
    runGit(['add', '.']);
    runGit(['commit', '-qm', 'init']);
    runGit(['branch', '-M', 'master']);
    runGit(['remote', 'add', 'origin', remote]);
    runGit(['push', '-u', 'origin', 'master']);
    runGit(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/master']);

    worktreePath = path.join(dir, 'ship-worktree');
    const start = runCli([
      'worktree',
      'start',
      '--agent',
      'codex-shipper',
      '--task',
      'Ship Smoke',
      '--path',
      worktreePath,
    ], { cwd: repo });
    assert.equal(start.status, 0, start.stderr || start.stdout);
    fs.appendFileSync(path.join(worktreePath, 'README.md'), 'changed\n');

    const shipped = runCli([
      'worktree',
      'ship',
      '--message',
      'ship smoke',
      '--verify',
      'git status --short',
      '--no-pr',
    ], { cwd: worktreePath });

    assert.equal(shipped.status, 0, shipped.stderr || shipped.stdout);
    assert.match(shipped.stdout, /merge_check: origin\/master clean/);
    assert.match(shipped.stdout, /pr: skipped \(\-\-no-pr\)/);
    assert.match(shipped.stdout, /done: worktree shipped/);
    const branch = runGit(['branch', '--show-current'], worktreePath);
    assert.match(
      runGit(['--git-dir', remote, 'show-ref', '--verify', `refs/heads/${branch}`], dir),
      new RegExp(`refs/heads/${branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)
    );
  } finally {
    if (worktreePath) cleanupTempDir(worktreePath);
    cleanupTempDir(dir);
  }
});

test('worktree ship blocks from primary checkout', () => {
  const dir = makeTempDir();
  try {
    const runGit = (args, cwd = dir) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return result.stdout.trim();
    };
    runGit(['init', '-q']);
    runGit(['config', 'user.email', 'test@example.com']);
    runGit(['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(dir, 'README.md'), '# Smoke\n');
    runGit(['add', '.']);
    runGit(['commit', '-qm', 'init']);
    runGit(['checkout', '-b', 'codex/primary-ship']);

    const res = runCli(['worktree', 'ship', '--message', 'should block', '--dry-run', '--no-pr'], { cwd: dir });

    assert.equal(res.status, 2);
    assert.match(res.stderr, /blocked: ship from an isolated worktree/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('worktree ship requires a message for dirty isolated checkout', () => {
  const dir = makeTempDir();
  let worktreePath;
  try {
    const remote = path.join(dir, 'remote.git');
    const repo = path.join(dir, 'repo');
    const runGit = (args, cwd = repo) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return result.stdout.trim();
    };
    fs.mkdirSync(repo);
    spawnSync('git', ['init', '--bare', '-q', remote], { encoding: 'utf8' });
    runGit(['init', '-q']);
    runGit(['config', 'user.email', 'test@example.com']);
    runGit(['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# Smoke\n');
    runGit(['add', '.']);
    runGit(['commit', '-qm', 'init']);
    runGit(['branch', '-M', 'master']);
    runGit(['remote', 'add', 'origin', remote]);
    runGit(['push', '-u', 'origin', 'master']);
    runGit(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/master']);

    worktreePath = path.join(dir, 'message-worktree');
    assert.equal(runCli([
      'worktree',
      'start',
      '--agent',
      'codex',
      '--task',
      'Message Gate',
      '--path',
      worktreePath,
    ], { cwd: repo }).status, 0);
    fs.appendFileSync(path.join(worktreePath, 'README.md'), 'changed\n');

    const res = runCli(['worktree', 'ship', '--verify', 'git status --short', '--dry-run', '--no-pr'], { cwd: worktreePath });

    assert.equal(res.status, 2);
    assert.match(res.stderr, /--message is required/);
  } finally {
    if (worktreePath) cleanupTempDir(worktreePath);
    cleanupTempDir(dir);
  }
});

test('member create --help prints usage without creating a --help member', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const help = runCli(['member', 'create', '--help'], { cwd: dir });
    assert.equal(help.status, 0, help.stderr || help.stdout);
    assert.match(help.stdout, /Usage: atris member create <name>/);
    assert.equal(fs.existsSync(path.join(dir, 'atris', 'team', '--help')), false);

    const missingName = runCli(['member', 'create', '--role=Member Trainer'], { cwd: dir });
    assert.notEqual(missingName.status, 0);
    assert.match(missingName.stderr, /Usage: atris member create <name>/);
    assert.equal(fs.existsSync(path.join(dir, 'atris', 'team', '--role=Member Trainer')), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('member archive preserves files under _archived', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'old-coach'], { cwd: dir }).status, 0);
    const archive = runCli(['member', 'archive', 'old-coach'], { cwd: dir });
    assert.equal(archive.status, 0, archive.stderr || archive.stdout);
    const activePath = path.join(dir, 'atris', 'team', 'old-coach');
    const archiveRoot = path.join(dir, 'atris', 'team', '_archived');
    const archived = fs.readdirSync(archiveRoot).find((name) => name.startsWith('old-coach-'));
    assert.equal(fs.existsSync(activePath), false);
    assert.ok(archived);
    assert.ok(fs.existsSync(path.join(archiveRoot, archived, 'MEMBER.md')));
    const logs = fs.readdirSync(path.join(archiveRoot, archived, 'logs'));
    assert.ok(logs.some((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name)));
  } finally {
    cleanupTempDir(dir);
  }
});

test('member purge archived requires confirmation and age gate', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'stale-coach'], { cwd: dir }).status, 0);
    assert.equal(runCli(['member', 'archive', 'stale-coach'], { cwd: dir }).status, 0);
    const archiveRoot = path.join(dir, 'atris', 'team', '_archived');
    const archived = fs.readdirSync(archiveRoot).find((name) => name.startsWith('stale-coach-'));
    const archivedPath = path.join(archiveRoot, archived);
    const refused = runCli(['member', 'purge-archived', '--days=60'], { cwd: dir });
    assert.notEqual(refused.status, 0);
    assert.ok(fs.existsSync(archivedPath));
    const recent = runCli(['member', 'purge-archived', '--days=60', '--confirm', 'delete archived members'], { cwd: dir });
    assert.equal(recent.status, 0, recent.stderr || recent.stdout);
    assert.ok(fs.existsSync(archivedPath));
    const old = new Date(Date.now() - 61 * 24 * 60 * 60 * 1000);
    fs.utimesSync(archivedPath, old, old);
    const purged = runCli(['member', 'purge-archived', '--days=60', '--confirm', 'delete archived members'], { cwd: dir });
    assert.equal(purged.status, 0, purged.stderr || purged.stdout);
    assert.equal(fs.existsSync(archivedPath), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('member goal tick review compounds structured goals and logs', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'growth'], { cwd: dir }).status, 0);

    const goal = runCli([
      'member', 'goal', 'growth', 'Recover more customer revenue',
      '--why', 'prove member-owned business progress',
      '--acceptance', 'one verified recovery action',
      '--cadence', 'daily',
      '--json',
    ], { cwd: dir });
    assert.equal(goal.status, 0, goal.stderr || goal.stdout);
    const goalPayload = JSON.parse(goal.stdout);
    assert.equal(goalPayload.action, 'goal_created');
    assert.equal(goalPayload.goal.title, 'Recover more customer revenue');
    assert.deepEqual(goalPayload.goal.acceptance, ['one verified recovery action']);

    const goalsPath = path.join(dir, 'atris', 'team', 'growth', 'goals.json');
    const goalsMdPath = path.join(dir, 'atris', 'team', 'growth', 'goals.md');
    assert.ok(fs.existsSync(goalsPath));
    assert.ok(fs.existsSync(goalsMdPath));
    assert.match(fs.readFileSync(goalsMdPath, 'utf8'), /Recover more customer revenue/);

    const tick = runCli(['member', 'tick', 'growth', '--json'], { cwd: dir });
    assert.equal(tick.status, 0, tick.stderr || tick.stdout);
    const tickPayload = JSON.parse(tick.stdout);
    assert.equal(tickPayload.action, 'tick');
    assert.equal(tickPayload.reused, false);
    assert.equal(tickPayload.experiment.status, 'proposed');
    assert.match(tickPayload.experiment.proof_target, /verified recovery action/);

    const secondTick = runCli(['member', 'tick', 'growth', '--json'], { cwd: dir });
    assert.equal(secondTick.status, 0, secondTick.stderr || secondTick.stdout);
    const secondTickPayload = JSON.parse(secondTick.stdout);
    assert.equal(secondTickPayload.reused, true);
    assert.equal(secondTickPayload.experiment.id, tickPayload.experiment.id);

    const openStatus = runCli(['member', 'status', 'growth', '--json'], { cwd: dir });
    assert.equal(openStatus.status, 0, openStatus.stderr || openStatus.stdout);
    const openStatusPayload = JSON.parse(openStatus.stdout);
    assert.equal(openStatusPayload.state, 'proposed');
    assert.equal(openStatusPayload.current_experiment.id, tickPayload.experiment.id);
    assert.match(openStatusPayload.next_command, /member review growth/);

    const review = runCli([
      'member', 'review', 'growth', tickPayload.experiment.id,
      '--accept',
      '--proof', 'dry run produced a verified recovery action',
      '--value', '5',
      '--lesson', 'small proof targets keep the member honest',
      '--next', 'Prepare the next recovery experiment',
      '--json',
    ], { cwd: dir });
    assert.equal(review.status, 0, review.stderr || review.stdout);
    const reviewPayload = JSON.parse(review.stdout);
    assert.equal(reviewPayload.outcome, 'accepted');
    assert.equal(reviewPayload.value, 5);
    assert.equal(reviewPayload.experiment.proof, 'dry run produced a verified recovery action');
    assert.equal(reviewPayload.experiment.value, 5);
    assert.equal(reviewPayload.next_experiment.status, 'proposed');

    const state = JSON.parse(fs.readFileSync(goalsPath, 'utf8'));
    assert.equal(state.schema, 'atris.member_goals.v1');
    assert.equal(state.goals[0].experiments[0].status, 'accepted');
    assert.equal(state.goals[0].experiments[0].value, 5);
    assert.equal(state.goals[0].experiments[1].title, 'Prepare the next recovery experiment');
    const doneStatus = runCli(['member', 'status', 'growth', '--json'], { cwd: dir });
    assert.equal(doneStatus.status, 0, doneStatus.stderr || doneStatus.stdout);
    const doneStatusPayload = JSON.parse(doneStatus.stdout);
    assert.equal(doneStatusPayload.value.average, 5);
    assert.equal(doneStatusPayload.value.accepted, 1);
    const logsDir = path.join(dir, 'atris', 'team', 'growth', 'logs');
    const logText = fs.readdirSync(logsDir)
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
      .map((name) => fs.readFileSync(path.join(logsDir, name), 'utf8'))
      .join('\n');
    assert.match(logText, /Member goal created/);
    assert.match(logText, /Member tick proposed experiment/);
    assert.match(logText, /Member experiment accepted/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('member goal-from-mission creates a bounded goal without a human title', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'mission-lead', '--description="Make Missions change the world with self-generated goals"'], { cwd: dir }).status, 0);
    assert.equal(runCli([
      'mission', 'start', 'Make Missions change the world with self-generated goals',
      '--owner', 'mission-lead',
      '--json',
    ], { cwd: dir }).status, 0);

    const goal = runCli(['member', 'goal-from-mission', 'mission-lead', '--json'], { cwd: dir });
    assert.equal(goal.status, 0, goal.stderr || goal.stdout);
    const payload = JSON.parse(goal.stdout);
    assert.equal(payload.action, 'goal_from_mission_created');
    assert.equal(payload.goal.source, 'mission');
    assert.match(payload.goal.title, /Prove one bounded step toward/);
    assert.match(payload.goal.why, /Make Missions change the world/);
    assert.equal(payload.goal.mission_file, 'atris/team/mission-lead/MISSION.md');
    assert.equal(payload.goal.now_file, 'atris/team/mission-lead/now.md');
    assert.ok(payload.goal.mission_id);
    assert.match(payload.next_command, /atris member tick mission-lead --goal/);

    const goalsPath = path.join(dir, 'atris', 'team', 'mission-lead', 'goals.json');
    const goalsMdPath = path.join(dir, 'atris', 'team', 'mission-lead', 'goals.md');
    assert.ok(fs.existsSync(goalsPath));
    assert.ok(fs.existsSync(goalsMdPath));
    const state = JSON.parse(fs.readFileSync(goalsPath, 'utf8'));
    assert.equal(state.goals.length, 1);
    assert.equal(state.goals[0].source, 'mission');
    assert.match(fs.readFileSync(goalsMdPath, 'utf8'), /not hand-fed by the human/);

    const tick = runCli(['member', 'tick', 'mission-lead', '--goal', payload.goal.id, '--json'], { cwd: dir });
    assert.equal(tick.status, 0, tick.stderr || tick.stdout);
    const tickPayload = JSON.parse(tick.stdout);
    assert.equal(tickPayload.action, 'tick');
    assert.equal(tickPayload.goal_id, payload.goal.id);
    assert.equal(tickPayload.experiment.status, 'proposed');
    assert.match(tickPayload.experiment.proof_target, /MISSION\.md/);
    assert.match(tickPayload.experiment.next_step, /MISSION\.md/);

    const reused = runCli(['member', 'goal-from-mission', 'mission-lead', '--json'], { cwd: dir });
    assert.equal(reused.status, 0, reused.stderr || reused.stdout);
    const reusedPayload = JSON.parse(reused.stdout);
    assert.equal(reusedPayload.action, 'goal_from_mission_reused');
    assert.equal(reusedPayload.goal.id, payload.goal.id);
  } finally {
    cleanupTempDir(dir);
  }
});

test('member goal-from-mission promotes the mission goal before older active goals', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'mission-lead', '--description="Make Missions change the world with self-generated goals"'], { cwd: dir }).status, 0);
    const scoreGoal = runCli(['member', 'goal', 'mission-lead', 'Older score-derived goal', '--json'], { cwd: dir });
    assert.equal(scoreGoal.status, 0, scoreGoal.stderr || scoreGoal.stdout);
    assert.equal(runCli([
      'mission', 'start', 'Make Missions choose the next bounded goal',
      '--owner', 'mission-lead',
      '--json',
    ], { cwd: dir }).status, 0);

    const created = runCli(['member', 'goal-from-mission', 'mission-lead', '--json'], { cwd: dir });
    assert.equal(created.status, 0, created.stderr || created.stdout);
    const createdPayload = JSON.parse(created.stdout);
    const goalsPath = path.join(dir, 'atris', 'team', 'mission-lead', 'goals.json');
    let state = JSON.parse(fs.readFileSync(goalsPath, 'utf8'));
    assert.equal(state.goals[0].id, createdPayload.goal.id);

    state.goals.reverse();
    fs.writeFileSync(goalsPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    const reused = runCli(['member', 'goal-from-mission', 'mission-lead', '--json'], { cwd: dir });
    assert.equal(reused.status, 0, reused.stderr || reused.stdout);
    const reusedPayload = JSON.parse(reused.stdout);
    state = JSON.parse(fs.readFileSync(goalsPath, 'utf8'));
    assert.equal(reusedPayload.action, 'goal_from_mission_reused');
    assert.equal(state.goals[0].id, createdPayload.goal.id);
    assert.equal(state.goals[1].title, 'Older score-derived goal');
  } finally {
    cleanupTempDir(dir);
  }
});

test('member goal-from-score creates the active self-improvement goal from Team score evidence', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'mission-lead', '--description="Make Missions turn proof into self-generated goals"'], { cwd: dir }).status, 0);
    const oldGoal = runCli(['member', 'goal', 'mission-lead', 'Old broad mission goal', '--json'], { cwd: dir });
    assert.equal(oldGoal.status, 0, oldGoal.stderr || oldGoal.stdout);
    const oldGoalPayload = JSON.parse(oldGoal.stdout);
    const oldTick = runCli(['member', 'tick', 'mission-lead', '--goal', oldGoalPayload.goal.id, '--json'], { cwd: dir });
    assert.equal(oldTick.status, 0, oldTick.stderr || oldTick.stdout);
    const oldExperimentId = JSON.parse(oldTick.stdout).experiment.id;
    const scorePath = path.join(dir, 'team-score.json');
    fs.writeFileSync(scorePath, JSON.stringify({
      score: {
        overall: 74,
        formula: 'Team Overall = Task Output + Knowledge Health + Member Performance',
        nextMove: 'Raise Member Performance: Train the weakest member attribute with one verified loop.',
        weakest: {
          id: 'member_performance',
          label: 'Member Performance',
          score: 60,
          recommendation: 'Train the weakest member attribute with one verified loop.',
          evidence: '14 scored members / proof avg 51 / loop avg 63',
        },
      },
      taskLedger: {
        latestReward: {
          ref: 'OBL-157',
          title: 'Show latest reward receipt in Team score CLI',
          reward: 5,
          proof: 'latestReward present in JSON and text output',
        },
      },
      learningPacket: {
        targetMember: {
          slug: 'brainstormer',
          label: 'brainstormer',
          overall: 60,
          next: 'Upgrade proof: finish one run with receipt, test, review, or artifact evidence.',
          weakestAttribute: {
            id: 'proof',
            label: 'Proof quality',
            score: 48,
            line: 'Proof status: no task proof yet.',
          },
        },
        drill: 'Run one bounded loop for brainstormer: Upgrade proof: finish one run with receipt, test, review, or artifact evidence. Weakest attribute: Proof quality 48.',
        verifier: 'npm run test:team-overall && node scripts/team-overall-score.mjs --json',
      },
    }, null, 2), 'utf8');

    const goal = runCli(['member', 'goal-from-score', 'mission-lead', '--score-json', scorePath, '--json'], { cwd: dir });
    assert.equal(goal.status, 0, goal.stderr || goal.stdout);
    const payload = JSON.parse(goal.stdout);
    assert.equal(payload.action, 'goal_from_score_created');
    assert.equal(payload.goal.source, 'team_score');
    assert.match(payload.goal.title, /Raise Member Performance/);
    assert.equal(payload.goal.team_score.weakest.label, 'Member Performance');
    assert.equal(payload.goal.team_score.latest_reward.ref, 'OBL-157');
    assert.equal(payload.goal.team_score.target_member.slug, 'brainstormer');
    assert.match(payload.goal.team_score.drill, /brainstormer/);
    assert.match(payload.goal.acceptance[0], /score-selected next move/);
    assert.match(payload.goal.acceptance[2], /Target member: brainstormer/);
    assert.equal(payload.superseded_experiments.length, 1);
    assert.equal(payload.superseded_experiments[0].experiment_id, oldExperimentId);
    assert.match(payload.next_command, /atris member tick mission-lead --goal/);

    const goalsPath = path.join(dir, 'atris', 'team', 'mission-lead', 'goals.json');
    const state = JSON.parse(fs.readFileSync(goalsPath, 'utf8'));
    assert.equal(state.goals[0].id, payload.goal.id);
    assert.equal(state.goals[0].source, 'team_score');
    assert.equal(state.goals[1].title, 'Old broad mission goal');
    assert.equal(state.goals[1].experiments[0].status, 'superseded');

    const tick = runCli(['member', 'tick', 'mission-lead', '--goal', payload.goal.id, '--json'], { cwd: dir });
    assert.equal(tick.status, 0, tick.stderr || tick.stdout);
    const tickPayload = JSON.parse(tick.stdout);
    assert.equal(tickPayload.goal_id, payload.goal.id);
    assert.match(tickPayload.experiment.title, /brainstormer drill/);
    assert.match(tickPayload.experiment.proof_target, /Concrete drill: Run one bounded loop for brainstormer/);
    assert.match(tickPayload.experiment.next_step, /Proof quality 48/);
    assert.equal(tickPayload.experiment.target_member.slug, 'brainstormer');
    assert.match(tickPayload.experiment.verifier, /test:team-overall/);

    const reused = runCli(['member', 'goal-from-score', 'mission-lead', '--score-json', scorePath, '--json'], { cwd: dir });
    assert.equal(reused.status, 0, reused.stderr || reused.stdout);
    const reusedPayload = JSON.parse(reused.stdout);
    assert.equal(reusedPayload.action, 'goal_from_score_reused');
    assert.equal(reusedPayload.goal.id, payload.goal.id);
  } finally {
    cleanupTempDir(dir);
  }
});

test('member wake returns one finite decision and refuses to pile onto open work', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'mission-lead', '--description="Make Missions wake up safely"'], { cwd: dir }).status, 0);
    assert.equal(runCli([
      'mission', 'start', 'Make Missions wake up safely',
      '--owner', 'mission-lead',
      '--json',
    ], { cwd: dir }).status, 0);
    const goal = runCli(['member', 'goal-from-mission', 'mission-lead', '--json'], { cwd: dir });
    assert.equal(goal.status, 0, goal.stderr || goal.stdout);
    const goalPayload = JSON.parse(goal.stdout);

    const dryRun = runCli(['member', 'wake', 'mission-lead', '--json'], { cwd: dir });
    assert.equal(dryRun.status, 0, dryRun.stderr || dryRun.stdout);
    const dryRunPayload = JSON.parse(dryRun.stdout);
    assert.equal(dryRunPayload.action, 'wake');
    assert.equal(dryRunPayload.mode, 'dry_run');
    assert.equal(dryRunPayload.decision, 'tick');
    assert.equal(dryRunPayload.executed, false);
    assert.match(dryRunPayload.next_command, new RegExp(`member tick mission-lead --goal ${goalPayload.goal.id}`));
    assert.ok(fs.existsSync(dryRunPayload.receipt_path));
    const dryReceipt = JSON.parse(fs.readFileSync(dryRunPayload.receipt_path, 'utf8'));
    assert.equal(dryReceipt.schema, 'atris.member_wake.v1');
    assert.equal(dryReceipt.decision, 'tick');

    const refused = runCli(['member', 'wake', 'mission-lead', '--execute', '--json'], { cwd: dir });
    assert.equal(refused.status, 0, refused.stderr || refused.stdout);
    const refusedPayload = JSON.parse(refused.stdout);
    assert.equal(refusedPayload.decision, 'stop');
    assert.equal(refusedPayload.reason, 'execute_requires_confirm_autonomy_policy');
    let state = JSON.parse(fs.readFileSync(path.join(dir, 'atris', 'team', 'mission-lead', 'goals.json'), 'utf8'));
    assert.equal(state.goals[0].experiments.length, 0);

    const executed = runCli(['member', 'wake', 'mission-lead', '--execute', '--confirm-autonomy-policy', '--json'], { cwd: dir });
    assert.equal(executed.status, 0, executed.stderr || executed.stdout);
    const executedPayload = JSON.parse(executed.stdout);
    assert.equal(executedPayload.executed, true);
    assert.equal(executedPayload.decision, 'wait');
    assert.equal(executedPayload.reason, 'tick_executed_experiment_proposed');
    assert.equal(executedPayload.current_experiment.status, 'proposed');
    assert.ok(fs.existsSync(executedPayload.receipt_path));

    const wait = runCli(['member', 'wake', 'mission-lead', '--json'], { cwd: dir });
    assert.equal(wait.status, 0, wait.stderr || wait.stdout);
    const waitPayload = JSON.parse(wait.stdout);
    assert.equal(waitPayload.decision, 'wait');
    assert.equal(waitPayload.reason, 'open_experiment_proposed');
    assert.equal(waitPayload.current_experiment.id, executedPayload.current_experiment.id);
    state = JSON.parse(fs.readFileSync(path.join(dir, 'atris', 'team', 'mission-lead', 'goals.json'), 'utf8'));
    assert.equal(state.goals[0].experiments.length, 1);
    const logText = fs.readdirSync(path.join(dir, 'atris', 'team', 'mission-lead', 'logs'))
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
      .map((name) => fs.readFileSync(path.join(dir, 'atris', 'team', 'mission-lead', 'logs', name), 'utf8'))
      .join('\n');
    assert.match(logText, /Member wake decision/);
    assert.match(logText, /Member wake executed tick/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('member wake can change direction from scoped steering memory', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'command-leader', '--description="Keep command loops controlled"'], { cwd: dir }).status, 0);
    assert.equal(runCli(['member', 'goal-from-mission', 'command-leader', '--json'], { cwd: dir }).status, 0);

    const baseline = runCli(['member', 'wake', 'command-leader', '--json'], { cwd: dir });
    assert.equal(baseline.status, 0, baseline.stderr || baseline.stdout);
    const baselinePayload = JSON.parse(baseline.stdout);
    assert.equal(baselinePayload.decision, 'tick');
    assert.equal(baselinePayload.checks.has_steering_directive, false);

    fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'steering.jsonl'), `${JSON.stringify({
      schema: 'atris.steering.v1',
      id: 'steer_test_report_proof',
      created_at: '2026-05-06T00:00:00.000Z',
      scope: { project: 'obelisk', member: 'command-leader' },
      kind: 'operating_rule',
      memory: ['Wake directive: report_proof - OBL-150 "Report the latest loop proof before creating new work."'],
      status: 'active',
    })}\n`, 'utf8');

    const steered = runCli(['member', 'wake', 'command-leader', '--json'], { cwd: dir });
    assert.equal(steered.status, 0, steered.stderr || steered.stdout);
    const steeredPayload = JSON.parse(steered.stdout);
    assert.equal(steeredPayload.decision, 'report_proof');
    assert.equal(steeredPayload.reason, 'steering_directive:steer_test_report_proof');
    assert.equal(steeredPayload.checks.has_steering, true);
    assert.equal(steeredPayload.checks.has_steering_directive, true);
    assert.match(steeredPayload.next_command, /atris task note OBL-150/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('member wake ignores steering directives whose task refs are all closed', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'command-leader', '--description="Keep command loops controlled"'], { cwd: dir }).status, 0);
    assert.equal(runCli(['member', 'goal-from-mission', 'command-leader', '--json'], { cwd: dir }).status, 0);

    fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'tasks.projection.json'), JSON.stringify({
      schema: 'atris.task_projection.v1',
      generated_at: '2026-05-06T00:00:00.000Z',
      tasks: [
        {
          id: 'closed-failed',
          display_id: 'OBL-146',
          title: 'Failed source room proof',
          status: 'failed',
          claimed_by: 'command-leader',
          metadata: { assigned_to: 'command-leader' },
          review: { reward: 0, proof: 'reviewed failure' },
        },
        {
          id: 'closed-done',
          display_id: 'OBL-147',
          title: 'Done source room proof',
          status: 'done',
          claimed_by: 'command-leader',
          metadata: { assigned_to: 'command-leader' },
          review: { reward: 1, proof: 'accepted proof' },
        },
      ],
    }, null, 2), 'utf8');
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'steering.jsonl'), `${JSON.stringify({
      schema: 'atris.steering.v1',
      id: 'steer_closed_refs',
      created_at: '2026-05-06T00:00:00.000Z',
      scope: { project: 'obelisk', member: 'command-leader' },
      kind: 'operating_rule',
      memory: ['Wake directive: close_loop - OBL-146 and OBL-147 were the referenced loops.'],
      status: 'active',
    })}\n`, 'utf8');

    const wake = runCli(['member', 'wake', 'command-leader', '--json'], { cwd: dir });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    assert.equal(payload.decision, 'tick');
    assert.equal(payload.reason, 'safe_next_bounded_step');
    assert.equal(payload.checks.has_steering, true);
    assert.equal(payload.checks.has_steering_directive, false);
    assert.equal(payload.checks.has_satisfied_steering_directive, true);
    assert.equal(payload.evidence.task_projection.candidate_count, 0);
    assert.equal(payload.evidence.nearest_open_loop, null);
    assert.equal(payload.evidence.steering_directive_closure.all_closed, true);
    assert.deepEqual(payload.evidence.steering_directive_closure.closed_refs, ['OBL-146', 'OBL-147']);
    assert.match(payload.next_command, /atris member tick command-leader --goal/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('member wake closes the nearest open task from task projection evidence', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'command-leader', '--description="Keep command loops controlled"'], { cwd: dir }).status, 0);
    assert.equal(runCli(['member', 'goal-from-mission', 'command-leader', '--json'], { cwd: dir }).status, 0);

    fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'tasks.projection.json'), JSON.stringify({
      schema: 'atris.task_projection.v1',
      generated_at: '2026-05-06T00:00:00.000Z',
      tasks: [
        {
          id: 'task-one',
          display_id: 'OBL-200',
          title: 'Close the live command loop',
          status: 'claimed',
          claimed_by: 'command-leader',
          metadata: { assigned_to: 'command-leader' },
          current_version: 2,
          messages: [],
          events: [],
        },
      ],
    }, null, 2), 'utf8');

    const wake = runCli(['member', 'wake', 'command-leader', '--json'], { cwd: dir });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    assert.equal(payload.decision, 'close_loop');
    assert.equal(payload.reason, 'nearest_open_loop:task_projection:OBL-200');
    assert.equal(payload.checks.has_open_loop_evidence, true);
    assert.equal(payload.checks.open_loop_source, 'task_projection');
    assert.equal(payload.evidence.nearest_open_loop.task_ref, 'OBL-200');
    assert.match(payload.next_command, /atris task note OBL-200/);
    const receipt = JSON.parse(fs.readFileSync(payload.receipt_path, 'utf8'));
    assert.equal(receipt.evidence.nearest_open_loop.task_ref, 'OBL-200');
  } finally {
    cleanupTempDir(dir);
  }
});

test('member wake reports proof for completed task evidence missing proof', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'command-leader', '--description="Keep command loops controlled"'], { cwd: dir }).status, 0);
    assert.equal(runCli(['member', 'goal-from-mission', 'command-leader', '--json'], { cwd: dir }).status, 0);

    fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'tasks.projection.json'), JSON.stringify({
      schema: 'atris.task_projection.v1',
      generated_at: '2026-05-06T00:00:00.000Z',
      tasks: [
        {
          id: 'task-two',
          display_id: 'OBL-201',
          title: 'Report the loop closure proof',
          status: 'done',
          claimed_by: 'command-leader',
          metadata: { assigned_to: 'command-leader' },
          review: { reward: null, proof: null },
          current_version: 3,
          messages: [],
          events: [],
        },
      ],
    }, null, 2), 'utf8');

    const wake = runCli(['member', 'wake', 'command-leader', '--json'], { cwd: dir });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    assert.equal(payload.decision, 'report_proof');
    assert.equal(payload.reason, 'nearest_open_loop:task_projection:OBL-201');
    assert.equal(payload.evidence.nearest_open_loop.task_ref, 'OBL-201');
    assert.match(payload.next_command, /atris task note OBL-201/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('member wake creates a missing task from member-room evidence', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'command-leader', '--description="Keep command loops controlled"'], { cwd: dir }).status, 0);
    assert.equal(runCli(['member', 'goal-from-mission', 'command-leader', '--json'], { cwd: dir }).status, 0);

    const threadDir = path.join(dir, '.obelisk', 'threads', 'project-one');
    fs.mkdirSync(threadDir, { recursive: true });
    fs.writeFileSync(path.join(threadDir, 'room.json'), JSON.stringify({
      id: 'room-one',
      updatedAt: Date.now(),
      atrisContext: {
        teamMember: 'command-leader',
        linkedTasks: [],
      },
      messages: [
        { role: 'user', text: 'build a proof card for the newest command loop' },
      ],
    }, null, 2), 'utf8');

    const wake = runCli(['member', 'wake', 'command-leader', '--json'], { cwd: dir });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    assert.equal(payload.decision, 'create_missing_task');
    assert.equal(payload.reason, 'nearest_open_loop:member_room_unlinked_request:missing_task');
    assert.equal(payload.checks.has_member_room_evidence, true);
    assert.match(payload.next_command, /atris task delegate "build a proof card/);
    assert.equal(payload.evidence.nearest_open_loop.source, 'member_room_unlinked_request');
  } finally {
    cleanupTempDir(dir);
  }
});

test('member wake picks nearest open loop from task projection evidence', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'command-leader', '--description="Keep command loops controlled"'], { cwd: dir }).status, 0);
    assert.equal(runCli(['member', 'goal-from-mission', 'command-leader', '--json'], { cwd: dir }).status, 0);
    fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'tasks.projection.json'), JSON.stringify({
      schema: 'atris.task_projection.v1',
      generated_at: '2026-05-06T00:00:00.000Z',
      tasks: [
        {
          id: '01TESTOPENLOOP',
          display_id: 'OBL-999',
          title: 'Close the nearest member loop',
          status: 'claimed',
          claimed_by: 'command-leader',
          metadata: { assigned_to: 'command-leader' },
          updated_at: 1778058000000,
        },
      ],
    }), 'utf8');

    const picked = runCli(['member', 'wake', 'command-leader', '--json'], { cwd: dir });
    assert.equal(picked.status, 0, picked.stderr || picked.stdout);
    const payload = JSON.parse(picked.stdout);
    assert.equal(payload.decision, 'close_loop');
    assert.equal(payload.reason, 'nearest_open_loop:task_projection:OBL-999');
    assert.equal(payload.checks.has_open_loop_evidence, true);
    assert.equal(payload.checks.open_loop_source, 'task_projection');
    assert.equal(payload.evidence.nearest_open_loop.task_ref, 'OBL-999');
    assert.match(payload.next_command, /atris task note OBL-999/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('member loop repeats wake quickly and skips an active lease', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'mission-lead', '--description="Make Missions loop safely"'], { cwd: dir }).status, 0);
    assert.equal(runCli([
      'mission', 'start', 'Make Missions loop safely',
      '--owner', 'mission-lead',
      '--json',
    ], { cwd: dir }).status, 0);
    assert.equal(runCli(['member', 'goal-from-mission', 'mission-lead', '--json'], { cwd: dir }).status, 0);

    const loop = runCli([
      'member', 'loop', 'mission-lead',
      '--ticks', '2',
      '--interval', '0',
      '--execute',
      '--confirm-autonomy-policy',
      '--json',
    ], { cwd: dir });
    assert.equal(loop.status, 0, loop.stderr || loop.stdout);
    const payload = JSON.parse(loop.stdout);
    assert.equal(payload.action, 'loop');
    assert.equal(payload.status, 'completed');
    assert.equal(payload.ticks, 2);
    assert.equal(payload.mode, 'execute');
    assert.equal(payload.decisions['wait:tick_executed_experiment_proposed'], 1);
    assert.equal(payload.decisions['wait:open_experiment_proposed'], 1);
    assert.ok(fs.existsSync(payload.receipt_path));
    assert.ok(fs.existsSync(payload.log_path));
    assert.ok(fs.existsSync(payload.latest_path));
    const latest = JSON.parse(fs.readFileSync(payload.latest_path, 'utf8'));
    assert.equal(latest.receipt_path, payload.receipt_path);
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'atris', 'team', 'mission-lead', 'goals.json'), 'utf8'));
    assert.equal(state.goals[0].experiments.length, 1);

    const status = runCli(['member', 'loop', 'mission-lead', '--status', '--json'], { cwd: dir });
    assert.equal(status.status, 0, status.stderr || status.stdout);
    const statusPayload = JSON.parse(status.stdout);
    assert.equal(statusPayload.active, false);
    assert.equal(statusPayload.latest.receipt_path, payload.receipt_path);

    const loopStateDir = path.join(dir, '.atris', 'state', 'member-loops');
    fs.mkdirSync(loopStateDir, { recursive: true });
    fs.writeFileSync(path.join(loopStateDir, 'mission-lead.lock.json'), JSON.stringify({
      schema: 'atris.member_loop_lease.v1',
      member: 'mission-lead',
      run_id: 'active-run',
      pid: 12345,
      started_at: new Date().toISOString(),
      heartbeat_at: new Date().toISOString(),
      expires_at_ms: Date.now() + 60000,
    }, null, 2));

    const skipped = runCli(['member', 'loop', 'mission-lead', '--ticks', '1', '--interval', '0', '--json'], { cwd: dir });
    assert.equal(skipped.status, 0, skipped.stderr || skipped.stdout);
    const skippedPayload = JSON.parse(skipped.stdout);
    assert.equal(skippedPayload.status, 'skipped');
    assert.equal(skippedPayload.reason, 'loop_already_active');
    assert.equal(skippedPayload.ticks, 0);
    assert.ok(fs.existsSync(skippedPayload.receipt_path));
  } finally {
    cleanupTempDir(dir);
  }
});

test('member status exposes blocked asks before more loop work', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'ops'], { cwd: dir }).status, 0);
    assert.equal(runCli(['member', 'goal', 'ops', 'Keep the business loop moving', '--acceptance', 'one operator-useful action'], { cwd: dir }).status, 0);
    const tick = runCli(['member', 'tick', 'ops', '--json'], { cwd: dir });
    assert.equal(tick.status, 0, tick.stderr || tick.stdout);
    const experimentId = JSON.parse(tick.stdout).experiment.id;

    const blocked = runCli([
      'member', 'block', 'ops', experimentId,
      '--reason', 'needs customer authority',
      '--ask', 'Approve contacting the customer?',
      '--orchestrator', 'team-hub',
      '--json',
    ], { cwd: dir });
    assert.equal(blocked.status, 0, blocked.stderr || blocked.stdout);
    const blockedPayload = JSON.parse(blocked.stdout);
    assert.equal(blockedPayload.needs_user, true);
    assert.equal(blockedPayload.experiment.status, 'blocked');
    assert.equal(blockedPayload.experiment.block.orchestrator, 'team-hub');

    const status = runCli(['member', 'status', 'ops', '--json'], { cwd: dir });
    assert.equal(status.status, 0, status.stderr || status.stdout);
    const statusPayload = JSON.parse(status.stdout);
    assert.equal(statusPayload.state, 'needs_user');
    assert.equal(statusPayload.needs_user, true);
    assert.equal(statusPayload.ask, 'Approve contacting the customer?');
    assert.match(statusPayload.next_command, /member review ops/);
    assert.ok(statusPayload.recent_log.some((line) => /Approve contacting the customer/.test(line)));

    const paused = runCli(['member', 'tick', 'ops', '--json'], { cwd: dir });
    assert.equal(paused.status, 0, paused.stderr || paused.stdout);
    const pausedPayload = JSON.parse(paused.stdout);
    assert.equal(pausedPayload.action, 'blocked');
    assert.equal(pausedPayload.experiment.id, experimentId);
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'atris', 'team', 'ops', 'goals.json'), 'utf8'));
    assert.equal(state.goals[0].experiments.length, 1);
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission start tick complete writes durable member-owned state', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'mission-lead'], { cwd: dir }).status, 0);

    const start = runCli([
      'mission', 'start', 'Make Mission real',
      '--owner', 'mission-lead',
      '--runner', 'codex_goal',
      '--lane', 'code',
      '--cadence', 'manual',
      '--verify', 'node -e "process.exit(0)"',
      '--stop', 'verifier passes',
      '--json',
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

    const tick = runCli(['mission', 'tick', startPayload.mission.id, '--verify', '--json'], { cwd: dir });
    assert.equal(tick.status, 0, tick.stderr || tick.stdout);
    const tickPayload = JSON.parse(tick.stdout);
    assert.equal(tickPayload.action, 'mission_tick');
    assert.equal(tickPayload.mission.status, 'ready');
    assert.equal(tickPayload.verifier_result.passed, true);
    assert.ok(fs.existsSync(path.join(dir, tickPayload.receipt_path)));

    const complete = runCli(['mission', 'complete', startPayload.mission.id, '--proof', tickPayload.receipt_path, '--json'], { cwd: dir });
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
      'mission', 'start', 'Keep the loop alive',
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

    const run = runCli([
      'mission', 'run', mission.id,
      '--max-ticks', '2',
      '--complete-on-pass',
      '--json',
    ], { cwd: dir });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const payload = JSON.parse(run.stdout);
    assert.equal(payload.ran_ticks, 2);
    assert.equal(payload.tick_count, 2);
    assert.equal(payload.mission.status, 'running');
    assert.match(payload.mission.next_action, /mission run/);
  } finally {
    cleanupTempDir(dir);
  }
});

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
    const res = runCli(['live', 'atris-labs', '--dry-run', '--once', '--only', 'atris/MAP.md'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Atris Live: atris-labs/);
    assert.match(res.stdout, /dry-run: atris business doctor --fix/);
    assert.match(res.stdout, /dry-run: atris push atris-labs --from/);
    assert.match(res.stdout, /dry-run: atris pull atris-labs --timeout 600 --only atris\/MAP\.md/);
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
    const child = path.join(dir, 'atris-labs');
    fs.mkdirSync(path.join(child, '.atris'), { recursive: true });
    fs.mkdirSync(path.join(child, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(child, '.atris', 'business.json'), JSON.stringify({ slug: 'atris-labs' }), 'utf8');

    const options = parseLiveOptions(['atris-labs', '--once'], dir);
    assert.equal(options.slug, 'atris-labs');
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
    fs.writeFileSync(path.join(dir, '.atris', 'business.json'), JSON.stringify({ slug: 'doordash' }), 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'MAP.md'), '# Map\n', 'utf8');

    assert.equal(
      resolvePushSourceDir({ slug: 'doordash', cwd: dir, argv: ['node', 'atris', 'push', 'doordash'] }),
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
      resolvePushSourceDir({ slug: 'doordash', cwd: dir, argv: ['node', 'atris', 'push', 'doordash', '--from', './custom-root'] }),
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
    slug: 'atris-labs',
    filesToPush: [
      { path: '/atris-labs/atris/now.md' },
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
    slug: 'atris-labs',
    filesToPush: Array.from({ length: 30 }, (_, i) => ({ path: `/atris/wiki/file-${i}.md` })),
    unchangedCount: 296,
  });

  assert.equal(report.ok, false);
  assert.match(report.reasons.join('\n'), /large unscoped workspace change/);
});

test('push safety allows exact scoped repair pushes', () => {
  const report = analyzePushSafety({
    slug: 'atris-labs',
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
    workspaceRoot: '/tmp/doordash',
  });

  assert.equal(manifest.workspace_root, '/tmp/doordash');
  assert.equal(manifest.last_commit, 'commit123');
  assert.equal(manifest.files['/atris/MAP.md'].hash, 'abc');
});

test('business sync plan pulls safely then pushes wiki scope through normal push', () => {
  const options = parseBusinessSyncArgs(['doordash']);
  assert.deepEqual(options, {
    slug: 'doordash',
    dryRun: false,
    timeout: '120',
    allowDelete: false,
    watch: false,
    intervalSec: 60,
    debounceSec: 5,
    status: false,
    review: false,
    resolve: null,
    help: false,
  });
  assert.deepEqual(buildBusinessSyncPlan(options), {
    pullArgs: ['pull', 'doordash', '--keep-local', '--fail-on-conflict', '--timeout', '120'],
    pushArgs: ['push', 'doordash'],
  });
});

test('business sync auto-detects slug from business workspace', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, '.atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.atris', 'business.json'), JSON.stringify({ slug: 'doordash' }), 'utf8');
    const options = resolveBusinessSyncOptions(['--dry-run'], dir);
    assert.equal(options.slug, 'doordash');
    assert.equal(options.dryRun, true);
  } finally {
    cleanupTempDir(dir);
  }
});

test('business sync plan supports dry-run and explicit delete opt-in', () => {
  const options = parseBusinessSyncArgs(['doordash', '--timeout', '240', '--dry-run', '--delete', '--watch', '--interval=30', '--debounce', '2']);
  assert.equal(options.watch, true);
  assert.equal(options.intervalSec, 30);
  assert.equal(options.debounceSec, 2);
  assert.equal(options.status, false);
  assert.equal(options.review, false);
  assert.equal(options.resolve, null);
  assert.equal(options.help, false);
  assert.deepEqual(buildBusinessSyncPlan(options), {
    pullArgs: ['pull', 'doordash', '--keep-local', '--fail-on-conflict', '--timeout', '240', '--dry-run'],
    pushArgs: ['push', 'doordash', '--dry-run', '--delete'],
  });
});

test('business sync resolve applies local or cloud conflict artifacts to workspace files', () => {
  const dir = makeTempDir();
  try {
    const packetDir = path.join(dir, '.atris', 'sync', 'conflicts', '2026-05-01T12-00-00Z', 'atris', 'wiki');
    fs.mkdirSync(packetDir, { recursive: true });
    fs.writeFileSync(path.join(packetDir, 'a.md.base'), 'base copy\n', 'utf8');
    fs.writeFileSync(path.join(packetDir, 'a.md.local'), 'local copy\n', 'utf8');
	    fs.writeFileSync(path.join(packetDir, 'a.md.remote'), 'cloud copy\n', 'utf8');
	    const rootPacketDir = path.join(dir, '.atris', 'sync', 'conflicts', '2026-05-01T12-00-00Z');
	    fs.writeFileSync(path.join(rootPacketDir, 'README.md.base'), 'base readme\n', 'utf8');
	    fs.writeFileSync(path.join(rootPacketDir, 'README.md.local'), 'local readme\n', 'utf8');
	    fs.writeFileSync(path.join(rootPacketDir, 'README.md.remote'), 'cloud readme\n', 'utf8');
	    fs.writeFileSync(path.join(dir, '.atris', 'sync', 'conflicts', '2026-05-01T12-00-00Z', 'summary.md'), '# Review\n', 'utf8');
	    fs.mkdirSync(path.join(dir, 'atris', 'wiki'), { recursive: true });
	    for (const rel of ['atris/wiki/a.md.remote', 'atris/wiki/a.md.local', 'README.md.remote']) {
	      fs.writeFileSync(path.join(dir, rel), 'workspace sidecar\n', 'utf8');
	    }

    const entries = collectConflictResolutionEntries(dir);
    assert.deepEqual(entries.map(entry => entry.targetRel).sort(), ['README.md', 'atris/wiki/a.md']);

    const local = resolveLatestConflict(dir, 'local');
	    assert.deepEqual(local.resolved.sort(), ['README.md', 'atris/wiki/a.md']);
	    assert.equal(fs.readFileSync(path.join(dir, 'atris', 'wiki', 'a.md'), 'utf8'), 'local copy\n');
	    assert.equal(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), 'local readme\n');
	    assert.equal(fs.existsSync(path.join(dir, 'atris', 'wiki', 'a.md.remote')), false);
	    assert.equal(fs.existsSync(path.join(dir, 'atris', 'wiki', 'a.md.local')), false);
	    assert.equal(fs.existsSync(path.join(dir, 'README.md.remote')), false);

    const cloud = resolveLatestConflict(dir, 'cloud');
    assert.deepEqual(cloud.resolved.sort(), ['README.md', 'atris/wiki/a.md']);
    assert.equal(fs.readFileSync(path.join(dir, 'atris', 'wiki', 'a.md'), 'utf8'), 'cloud copy\n');
    assert.equal(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), 'cloud readme\n');
    assert.match(cloud.message, /atris sync --dry-run/);

    const both = resolveLatestConflict(dir, 'both');
    assert.deepEqual(both.resolved.sort(), ['README.md', 'atris/wiki/a.md']);
    assert.equal(fs.readFileSync(path.join(dir, 'atris', 'wiki', 'a.md'), 'utf8'), 'local copy\n');
    assert.equal(fs.readFileSync(path.join(dir, 'atris', 'wiki', 'a.md.cloud'), 'utf8'), 'cloud copy\n');
    assert.equal(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), 'local readme\n');
    assert.equal(fs.readFileSync(path.join(dir, 'README.md.cloud'), 'utf8'), 'cloud readme\n');
    assert.match(both.message, /both versions/);

    fs.writeFileSync(path.join(packetDir, 'a.md.base'), 'A\nB\nC\n', 'utf8');
    fs.writeFileSync(path.join(packetDir, 'a.md.local'), 'A\nB local\nC\n', 'utf8');
    fs.writeFileSync(path.join(packetDir, 'a.md.remote'), 'A\nB\nC cloud\n', 'utf8');
    fs.writeFileSync(path.join(rootPacketDir, 'README.md.base'), 'A\nB\nC\n', 'utf8');
    fs.writeFileSync(path.join(rootPacketDir, 'README.md.local'), 'A\nB local\nC\n', 'utf8');
    fs.writeFileSync(path.join(rootPacketDir, 'README.md.remote'), 'A\nB\nC cloud\n', 'utf8');
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
    fs.writeFileSync(path.join(dir, '.atris', 'business.json'), JSON.stringify({ slug: 'doordash' }), 'utf8');
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
    fs.writeFileSync(path.join(dir, '.atris', 'business.json'), JSON.stringify({ slug: 'doordash' }), 'utf8');
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
    fs.writeFileSync(path.join(dir, '.atris', 'business.json'), JSON.stringify({ slug: 'doordash' }), 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'wiki', 'index.md'), '# Index\n', 'utf8');
    fs.writeFileSync(path.join(dir, '.atris', 'sync', 'conflicts', '2026-05-01T12-00-00Z', 'summary.md'), '# Review\n', 'utf8');
    writeSyncStatus(dir, { slug: 'doordash', state: 'current', mode: 'watch' });

    const status = collectLocalSyncStatus(dir, { slug: 'doordash' });
    assert.equal(status.slug, 'doordash');
    assert.equal(status.brainExists, true);
    assert.equal(status.brainFileCount, 1);
    assert.equal(status.conflictCount, 1);
    assert.match(status.latestConflict, /summary\.md$/);

    const rendered = renderLocalSyncStatus(status);
    assert.match(rendered, /Business workspace sync status/);
    assert.match(rendered, /business: doordash/);
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
    fs.mkdirSync(path.join(dir, 'atris-labs', 'atris'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris-labs', 'atris', 'now.md'), '# now\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'CLAUDE.md.remote'), 'cloud copy\n', 'utf8');

    const warnings = collectWorkspaceWarnings(dir, 'atris-labs');
    assert.equal(warnings.length, 2);
    assert.match(warnings[0], /nested workspace folder: atris-labs\//);
    assert.match(warnings[1], /sync review artifacts/);

    const rendered = renderLocalSyncStatus({
      slug: 'atris-labs',
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
    fs.writeFileSync(path.join(dir, '.atris', 'business.json'), JSON.stringify({ slug: 'doordash' }), 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'wiki', 'index.md'), '# Index\n', 'utf8');

    const res = runCli(['sync', '--status'], { cwd: dir, env: { ATRIS_TOKEN: '' } });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Business workspace sync status/);
    assert.match(res.stdout, /business: doordash/);
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
    fs.writeFileSync(path.join(dir, '.atris', 'business.json'), JSON.stringify({ slug: 'doordash' }), 'utf8');

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

  const conflictErr = new Error('atris pull doordash exited 2');
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

test('brain compile writes loadable status and ledger artifacts', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    const res = runCli(['brain', 'compile', '--root', dir, '--verify'], { cwd: dir });
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

    const res = runCli(['brain', 'compile', '--root', dir, '--verify'], { cwd: dir });
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

test('brain compile --json returns machine-readable missing-workspace errors', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['brain', 'compile', '--root', dir, '--verify', '--json'], { cwd: dir });
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

test('brain state counts rendered open TODO rows without counting completed rows', () => {
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
      '(Empty)',
      '',
      '## Completed',
      '',
      '- **[CLI-1]** Completed task [brain]',
      '',
    ].join('\n'), 'utf8');

    const state = collectState(dir);

    assert.equal(state.todo.open, 1);
    assert.equal(state.todo.done, 1);
    assert.equal(state.todo.titled, 2);
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
    assert.equal(runCli(['task', 'done', ref], { cwd: dir, env }).status, 0);

    const review = runCli([
      'task', 'review', ref,
      '--reward', '1',
      '--lesson', 'Task episodes should feed brain compile',
      '--proof', 'node --test',
      '--as', 'codex',
    ], { cwd: dir, env });
    assert.equal(review.status, 0, review.stderr);

    const res = runCli(['brain', 'compile', '--root', dir, '--verify'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /State rows: 1 raw \/ 1 valid/);
    assert.match(res.stdout, /Turn existing episode rows into the first scorecard/);

    const state = JSON.parse(fs.readFileSync(path.join(dir, 'atris', 'brain', 'state.json'), 'utf8'));
    const taskEpisodes = state.stateFiles.find(item => item.path.endsWith('task_episodes.jsonl'));
    assert.equal(taskEpisodes.rows, 1);
    assert.equal(taskEpisodes.validRows, 1);

    const status = fs.readFileSync(path.join(dir, 'atris', 'brain', 'STATUS.md'), 'utf8');
    assert.match(status, /1 episode row\(s\) are available/);
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
    assert.equal(runCli(['task', 'done', ref], { cwd: dir, env }).status, 0);

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
    assert.equal(payload.taskEpisodes, 1);
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

    const compile = runCli(['brain', 'compile', '--root', dir, '--verify'], { cwd: dir });
    assert.equal(compile.status, 0, compile.stderr);
    assert.match(compile.stdout, /State rows: 2 raw \/ 2 valid/);
    assert.doesNotMatch(compile.stdout, /Turn existing episode rows into the first scorecard/);
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

    const done = runCli(['task', 'done', ref, '--proof', 'first proof'], { cwd: dir, env });
    assert.equal(done.status, 0, done.stderr);

    const review = runCli([
      'task', 'review', ref,
      '--reward', '5',
      '--lesson', 'Latest review is the task outcome',
      '--proof', 'final proof',
      '--next', 'Draft the Atris Labs operator one-pager from the latest recap',
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
    assert.equal(payload.scorecards[0].proof, 'final proof');
    assert.equal(payload.scorecards[0].next_task_suggestion, 'Draft the Atris Labs operator one-pager from the latest recap');

    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), '# TODO\n\n## Backlog\n\n(empty)\n', 'utf8');
    const compile = runCli(['brain', 'compile', '--root', dir, '--verify'], { cwd: dir });
    assert.equal(compile.status, 0, compile.stderr);
    assert.match(compile.stdout, /Draft the Atris Labs operator one-pager from the latest recap/);
    assert.doesNotMatch(compile.stdout, /Run a business loop/);
  } finally {
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

    const compile = runCli(['brain', 'compile', '--root', dir, '--verify'], { cwd: dir });
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

    const compile = runCli(['brain', 'compile', '--root', dir, '--verify'], { cwd: dir });
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

    const compile = runCli(['brain', 'compile', '--root', dir, '--verify'], { cwd: dir });
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

    const compile = runCli(['brain', 'compile', '--root', dir, '--verify'], { cwd: dir });
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

    const compile = runCli(['brain', 'compile', '--root', dir, '--verify'], { cwd: dir });
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

    const compile = runCli(['brain', 'compile', '--root', dir, '--verify'], { cwd: dir });
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
    const res = runCli(['brain', 'activate', '--root', dir, '--verify'], { cwd: dir });
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
    runCli(['brain', 'compile', '--root', dir, '--verify'], { cwd: dir });
    const res = runCli(['brain', 'activate', '--member', 'justin', '--root', dir, '--verify'], { cwd: dir });
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

    const res = runCli(['brain', 'activate', '--member', 'missing-one', '--root', dir, '--verify'], { cwd: dir });
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

    const missing = runCli(['brain', 'activate', '--member', 'missing-one', '--root', dir, '--verify', '--json'], { cwd: dir });
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

    const notReady = runCli(['brain', 'activate', '--member', 'placeholder', '--root', dir, '--verify', '--json'], { cwd: dir });
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

    const res = runCli(['brain', 'activate', '--member', 'placeholder', '--root', dir, '--verify'], { cwd: dir });
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

    const res = runCli(['brain', 'activate', '--member', 'executor', '--root', dir, '--verify'], { cwd: dir });
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

    const res = runCli(['brain', 'activate', '--member', 'validator', '--root', dir, '--verify'], { cwd: dir });
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

    const res = runCli(['brain', 'activate', '--member', 'validator', '--root', dir, '--verify'], { cwd: dir });
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

    const res = runCli(['brain', 'activate', '--member', 'executor', '--root', dir, '--verify'], { cwd: dir });
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

    const res = runCli(['brain', 'activate', '--member', 'executor', '--root', dir, '--verify'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Executor — Builder: ask Navigator to create one bounded task with files, verifier, and stop rule before making a patch/);
    assert.doesNotMatch(res.stdout, /execute the highest-leverage claimed task/);
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

    const res = runCli(['brain', 'activate', '--member', 'navigator', '--root', dir, '--verify'], { cwd: dir });
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

    const res = runCli(['brain', 'activate', '--member', 'launcher', '--root', dir, '--verify'], { cwd: dir });
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

    const res = runCli(['brain', 'activate', '--member', 'launcher', '--root', dir, '--verify'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Launcher — The Closer: wait for one validated task receipt before closeout/);
    assert.doesNotMatch(res.stdout, /close one validated task into release-ready proof/);
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

    const res = runCli(['brain', 'activate', '--member', 'brainstormer', '--root', dir, '--verify'], { cwd: dir });
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

    const res = runCli(['brain', 'activate', '--member', 'researcher', '--root', dir, '--verify'], { cwd: dir });
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

    const mission = runCli(['brain', 'activate', '--member', 'mission-lead', '--root', dir, '--verify'], { cwd: dir });
    assert.equal(mission.status, 0, mission.stderr);
    assert.match(mission.stdout, /Mission Lead: choose or create one bounded mission step, run its verifier/);

    const opus = runCli(['brain', 'activate', '--member', 'opus-overnight', '--root', dir, '--verify'], { cwd: dir });
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
    runCli(['brain', 'activate', '--member', 'justin', '--root', dir, '--verify'], { cwd: dir });
    const res = runCli(['brain', 'activate', '--root', dir, '--verify'], { cwd: dir });
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
    const res = runCli(['brain', 'gallery', '--root', dir, '--verify'], { cwd: dir });
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

test('brain gallery does not overwrite the remembered operator', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    const operatorPath = path.join(dir, '.atris', 'state', 'operator.json');
    const activate = runCli(['brain', 'activate', '--member', 'justin', '--root', dir, '--verify'], { cwd: dir });
    assert.equal(activate.status, 0, activate.stderr);
    assert.equal(JSON.parse(fs.readFileSync(operatorPath, 'utf8')).member, 'justin');

    const res = runCli(['brain', 'gallery', '--root', dir, '--verify'], { cwd: dir });
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

    const res = runCli(['brain', 'gallery', '--root', dir, '--verify'], { cwd: dir });
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

    const res = runCli(['brain', 'gallery', '--root', dir, '--verify', '--json'], { cwd: dir });
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
    const res = runCli(['brain', 'activate', '--member', 'keshav', '--root', dir, '--verify'], { cwd: dir });
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
    runCli(['brain', 'compile', '--root', dir, '--verify'], { cwd: dir });
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
    runCli(['brain', 'compile', '--root', dir, '--verify'], { cwd: dir });
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
    runCli(['brain', 'compile', '--root', dir, '--verify'], { cwd: dir });
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
    runCli(['brain', 'compile', '--root', dir, '--verify'], { cwd: dir });
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
    assert.match(open.stdout, new RegExp(`open\\s+${ref}`));
    assert.match(open.stdout, /#launch\s+Ship task plane/);

    const claim = runCli(['task', 'claim', ref, '--as', 'codex'], { cwd: dir, env });
    assert.equal(claim.status, 0, claim.stderr);
    assert.match(claim.stdout, new RegExp(`claimed ${ref} as codex`));

    const claimed = runCli(['task', 'list', '--status', 'claimed'], { cwd: dir, env });
    assert.equal(claimed.status, 0, claimed.stderr);
    assert.match(claimed.stdout, new RegExp(`claimed\\s+${ref}\\s+\\[codex\\]`));

    const done = runCli(['task', 'done', id.slice(0, 8)], { cwd: dir, env });
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
    assert.match(render.stdout, /rendered 1 task/);
    const regenerated = fs.readFileSync(todoPath, 'utf8');
    assert.match(regenerated, /Regenerated from durable Atris task state/);
    assert.match(regenerated, new RegExp(`\\*\\*\\[${ref}\\]\\*\\* Ship task plane`));
    assert.match(regenerated, /## Completed/);
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

test('task render preserves Endgame metadata and markdown-only T rows', () => {
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
    assert.match(regenerated, /- \*\*\[T1\]\*\* Keep markdown horizon \[endgame\] \[execute\]/);
    assert.match(regenerated, /\*\*Verify:\*\* test -f horizon\.txt/);
    assert.match(regenerated, /## Review\n\n- \*\*\[T2\]\*\* Pending human approval \[agent\]\n  \*\*Verify:\*\* test -f approval\.txt/);
    assert.match(regenerated, /DB state task \[agent\]/);
    assert.match(regenerated, new RegExp(`\\*\\*\\[${createdTask.display_id}\\]\\*\\* DB state task`));
    const showByRenderedRef = runCli(['task', 'show', createdTask.display_id, '--json'], { cwd: dir, env });
    assert.equal(showByRenderedRef.status, 0, showByRenderedRef.stderr);
    assert.equal(JSON.parse(showByRenderedRef.stdout).id, createdTask.id);

    const renderAgain = runCli(['task', 'render', '--out', 'atris/TODO.md'], { cwd: dir, env });
    assert.equal(renderAgain.status, 0, renderAgain.stderr);
    const second = fs.readFileSync(todoPath, 'utf8');
    assert.equal((second.match(/## Endgame/g) || []).length, 1);
    assert.equal((second.match(/Keep markdown horizon/g) || []).length, 1);
    assert.equal((second.match(/Pending human approval/g) || []).length, 1);
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
    assert.equal(runCli(['task', 'done', older.task.display_id], { cwd: dir, env }).status, 0);

    const open = runCli(['task', 'list', '--status', 'open'], { cwd: dir, env });
    assert.equal(open.status, 0, open.stderr);
    assert.match(open.stdout, new RegExp(`open\\s+${current.task.display_id}\\s+Current open task`));
    assert.doesNotMatch(open.stdout, new RegExp(`open\\s+${older.task.display_id}\\s+Current open task`));

    const done = runCli(['task', 'list', '--status', 'done'], { cwd: dir, env });
    assert.equal(done.status, 0, done.stderr);
    assert.match(done.stdout, new RegExp(`done\\s+${older.task.display_id}\\s+Older closed task`));

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
    assert.doesNotMatch(rootHelp.stdout, /TASK DESK/);

    const eventsHelp = runCli(['task', 'events', '--help'], { cwd: dir });
    assert.equal(eventsHelp.status, 0, eventsHelp.stderr);
    assert.match(eventsHelp.stdout, /atris task events --all/);
    assert.doesNotMatch(eventsHelp.stdout, /TASK EVENTS/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task events defaults to a recent compact view', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const created = runCli(['task', 'new', 'Keep the ledger behind the cockpit', '--json'], { cwd: dir, env });
    assert.equal(created.status, 0, created.stderr);
    const id = JSON.parse(created.stdout).task_id;
    for (let i = 0; i < 30; i += 1) {
      const note = runCli(['task', 'say', id, `status note ${i}`, '--as', 'codex'], { cwd: dir, env });
      assert.equal(note.status, 0, note.stderr);
    }

    const recent = runCli(['task', 'events'], { cwd: dir, env });
    assert.equal(recent.status, 0, recent.stderr);
    assert.match(recent.stdout, /TASK EVENTS/);
    assert.match(recent.stdout, /recent 24 events/);
    assert.match(recent.stdout, /status note 29/);
    assert.doesNotMatch(recent.stdout, /status note 0/);
    assert.doesNotMatch(recent.stdout, /"content"/);

    const recentJson = runCli(['task', 'events', '--json'], { cwd: dir, env });
    assert.equal(recentJson.status, 0, recentJson.stderr);
    const payload = JSON.parse(recentJson.stdout);
    assert.equal(payload.mode, 'recent');
    assert.equal(payload.limit, 24);
    assert.equal(payload.events.length, 24);

    const all = runCli(['task', 'events', '--all'], { cwd: dir, env });
    assert.equal(all.status, 0, all.stderr);
    assert.match(all.stdout, /status note 0/);
    assert.match(all.stdout, /"content":"status note 29"/);

    const out = path.join(dir, '.atris', 'state', 'tasks.projection.json');
    const exported = runCli(['task', 'export', '--out', out], { cwd: dir, env });
    assert.equal(exported.status, 0, exported.stderr);
    const projection = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(projection.surface.compact, true);
    assert.equal(projection.surface.full_task_count, 1);
    assert.equal(projection.surface.full_ledger_command, 'atris task events --all');
    assert.equal(projection.tasks[0].messages.length, 6);
    assert.equal(projection.tasks[0].events.length, 8);
    assert.equal(projection.tasks[0].history.message_count, 30);
    assert.equal(projection.tasks[0].history.event_count, 31);
    assert.equal(projection.tasks[0].history.messages_truncated, true);
    assert.equal(projection.tasks[0].history.events_truncated, true);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task note, show, and export expose a dialogue projection for UI surfaces', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const add = runCli(['task', 'add', 'Design task dialogue cards', '--tag', 'ui', '--json'], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const addPayload = JSON.parse(add.stdout);
    const id = addPayload.task_id;
    const ref = addPayload.task.display_id;

    const note = runCli(['task', 'note', ref, 'User wants Cursor-like task chat', '--as', 'codex'], { cwd: dir, env });
    assert.equal(note.status, 0, note.stderr);
    assert.match(note.stdout, new RegExp(`noted ${ref} v2`));

    const show = runCli(['task', 'show', ref], { cwd: dir, env });
    assert.equal(show.status, 0, show.stderr);
    assert.match(show.stdout, new RegExp(`OPEN ${ref} v2 #ui`));
    assert.match(show.stdout, /Dialogue:/);
    assert.match(show.stdout, /codex: User wants Cursor-like task chat/);

    const showJson = runCli(['task', 'show', id, '--json'], { cwd: dir, env });
    assert.equal(showJson.status, 0, showJson.stderr);
    const task = JSON.parse(showJson.stdout);
    assert.equal(task.current_version, 2);
    assert.equal(task.messages[0].content, 'User wants Cursor-like task chat');

    const largeMessage = `large json pipe proof\n${'x'.repeat(96 * 1024)}`;
    const largeNote = runCli(['task', 'note', ref, largeMessage, '--as', 'codex'], { cwd: dir, env });
    assert.equal(largeNote.status, 0, largeNote.stderr);

    const largeShowJson = runCli(['task', 'show', id, '--json'], { cwd: dir, env });
    assert.equal(largeShowJson.status, 0, largeShowJson.stderr);
    assert.ok(largeShowJson.stdout.length > 64 * 1024, 'large task JSON must exceed a typical pipe buffer');
    const largeTask = JSON.parse(largeShowJson.stdout);
    assert.equal(largeTask.current_version, 3);
    assert.ok(largeTask.messages.at(-1).content.startsWith('large json pipe proof\nxxxxx'));

    const out = path.join(dir, '.atris', 'state', 'tasks.projection.json');
    const exported = runCli(['task', 'export', '--out', out], { cwd: dir, env });
    assert.equal(exported.status, 0, exported.stderr);
    assert.match(exported.stdout, /exported 1 task/);
    const projection = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(projection.schema, 'atris.task_projection.v1');
    assert.equal(projection.tasks[0].id, id);
    assert.equal(projection.tasks[0].display_id, ref);
    assert.equal(projection.tasks[0].messages[0].actor, 'codex');
  } finally {
    cleanupTempDir(dir);
  }
});

test('task delegate creates assigned work and day view groups by owner', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const delegated = runCli([
      'task',
      'delegate',
      'Review launch draft',
      '--to',
      'justin',
      '--tag',
      'launch',
      '--note',
      'Need clear copy before posting',
      '--json',
    ], { cwd: dir, env });
    assert.equal(delegated.status, 0, delegated.stderr);
    const body = JSON.parse(delegated.stdout);
    assert.equal(body.action, 'delegated');
    assert.equal(body.owner, 'justin');
    assert.equal(body.via, 'local');
    assert.equal(body.task.status, 'open');
    assert.equal(body.task.assigned_to, 'justin');
    assert.equal(body.task.metadata.delegate_via, 'local');
    assert.equal(body.task.latest_event_type, 'message');
    assert.match(body.handoff.command, /^atris task claim [A-Z0-9]{3}-1 --as justin$/);

    const day = runCli(['task', 'day', '--json'], { cwd: dir, env });
    assert.equal(day.status, 0, day.stderr);
    const dayBody = JSON.parse(day.stdout);
    assert.equal(dayBody.action, 'day');
    assert.equal(dayBody.counts.active, 1);
    assert.equal(dayBody.groups[0].owner, 'justin');
    assert.equal(dayBody.groups[0].tasks[0].id, body.task_id);

    const textDay = runCli(['task', 'day'], { cwd: dir, env });
    assert.equal(textDay.status, 0, textDay.stderr);
    assert.match(textDay.stdout, /TASK DAY/);
    assert.match(textDay.stdout, /justin/);
    assert.match(textDay.stdout, /Review launch draft/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task delegate can prepare a Swarlo handoff without changing task truth', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const delegated = runCli([
      'task',
      'delegate',
      'Run overnight validation',
      '--to',
      'codex',
      '--via',
      'swarlo',
      '--tag',
      'tasks',
      '--json',
    ], { cwd: dir, env });
    assert.equal(delegated.status, 0, delegated.stderr);
    const body = JSON.parse(delegated.stdout);
    assert.equal(body.task.assigned_to, 'codex');
    assert.equal(body.task.metadata.delegate_via, 'swarlo');
    assert.equal(body.handoff.swarlo.action, 'claim');
    assert.equal(body.handoff.swarlo.channel, 'tasks');
    assert.equal(body.handoff.swarlo.task_key, body.task_id);
  } finally {
    cleanupTempDir(dir);
  }
});

test('play mode opens the assigned AgentXP mission for a player', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const delegated = runCli([
      'task',
      'delegate',
      'AgentXP Mode first rep',
      '--to',
      'justin',
      '--tag',
      'agent-xp',
      '--note',
      'Win condition: one proof-backed customer-motion rep.',
      '--json',
    ], { cwd: dir, env });
    assert.equal(delegated.status, 0, delegated.stderr);

    const play = runCli(['play', '--as', 'justin'], { cwd: dir, env: { ...env, USER: 'keshav' } });
    assert.equal(play.status, 0, play.stderr);
    assert.match(play.stdout, /AgentXP Mode/);
    assert.match(play.stdout, /Player justin/);
    assert.match(play.stdout, /AgentXP Mode first rep/);
    assert.match(play.stdout, /Win condition: one proof-backed customer-motion rep/);
    assert.match(play.stdout, /atris task claim [A-Z0-9]{3}-1 --as game-manager/);
    assert.match(play.stdout, /atris task ready [A-Z0-9]{3}-1 --as game-manager --proof/);
    assert.match(play.stdout, /atris xp card --local/);
    assert.match(play.stdout, /atris xp sync --local --as justin --token <owner-provided-token>/);
    assert.match(play.stdout, /atris login/);
    assert.match(play.stdout, /atris xp sync --local --as justin/);
    assert.match(play.stdout, /Leaderboard: https:\/\/api\.atris\.ai\/api\/agentxp\/leaderboard/);

    const json = runCli(['play', '--as', 'justin', '--json'], { cwd: dir, env: { ...env, USER: 'keshav' } });
    assert.equal(json.status, 0, json.stderr);
    const body = JSON.parse(json.stdout);
    assert.equal(body.schema, 'atris.agentxp_play_mode.v1');
    assert.equal(body.player, 'justin');
    assert.equal(body.player_source, 'flag');
    assert.equal(body.mission.title, 'AgentXP Mode first rep');
    assert.equal(body.mission.assigned_to, 'justin');
    assert.equal(body.global_sync_rule, 'Use the owner-provided sync token first; fallback is atris login before sync.');
    assert.equal(body.leaderboard_url, 'https://api.atris.ai/api/agentxp/leaderboard');
    assert.equal(body.next_commands[0], `atris task claim ${body.mission.ref} --as game-manager`);
    assert.ok(
      body.next_commands.indexOf('atris xp sync --local --as justin --token <owner-provided-token>')
        < body.next_commands.indexOf('atris login')
    );
    assert.equal(body.next_commands.includes('atris login'), true);
  } finally {
    cleanupTempDir(dir);
  }
});

test('play mode defaults to current username instead of another assigned player', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', USER: 'keshav' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const delegated = runCli([
      'task',
      'delegate',
      'Justin AgentXP Mode first rep',
      '--to',
      'justin',
      '--tag',
      'agent-xp',
      '--json',
    ], { cwd: dir, env });
    assert.equal(delegated.status, 0, delegated.stderr);

    const play = runCli(['play', '--no-seed', '--json'], { cwd: dir, env });
    assert.equal(play.status, 0, play.stderr);
    const body = JSON.parse(play.stdout);
    assert.equal(body.player, 'keshav');
    assert.equal(body.player_source, 'local_user');
    assert.equal(body.mission, null);
  } finally {
    cleanupTempDir(dir);
  }
});

test('play mode bootstraps a starter mission on a fresh player workspace', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = {
    ATRIS_TASKS_DB: dbPath,
    NODE_NO_WARNINGS: '1',
    USER: 'justin',
  };
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'team', 'justin'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'team', 'justin', 'START_HERE.md'), '# Justin\n');

    const play = runCli(['play'], { cwd: dir, env });
    assert.equal(play.status, 0, play.stderr);
    assert.match(play.stdout, /AgentXP Mode/);
    assert.match(play.stdout, /Player justin/);
    assert.match(play.stdout, /Starter mission created locally/);
    assert.match(play.stdout, /AgentXP Mode first rep: complete one proof-backed customer-motion mission/);
    assert.match(play.stdout, /atris task claim [A-Z0-9]{3}-1 --as game-manager/);

    const json = runCli(['play', '--json'], { cwd: dir, env });
    assert.equal(json.status, 0, json.stderr);
    const body = JSON.parse(json.stdout);
    assert.equal(body.player, 'justin');
    assert.equal(body.player_source, 'local_user_team_match');
    assert.equal(body.seeded, null);
    assert.equal(body.mission.assigned_to, 'justin');
    assert.equal(body.mission.title, 'AgentXP Mode first rep: complete one proof-backed customer-motion mission');

    const list = runCli(['task', 'list', '--json'], { cwd: dir, env });
    assert.equal(list.status, 0, list.stderr);
    const tasks = JSON.parse(list.stdout).tasks;
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].metadata.assigned_to, 'justin');
    assert.equal(tasks[0].metadata.delegate_via, 'agentxp_play');
  } finally {
    cleanupTempDir(dir);
  }
});

test('play mode makes a plain folder playable on first run', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', USER: 'keshav' };
  try {
    const json = runCli(['play', '--as', 'justin', '--json'], { cwd: dir, env });
    assert.equal(json.status, 0, json.stderr);
    const body = JSON.parse(json.stdout);
    assert.equal(body.player, 'justin');
    assert.equal(body.player_source, 'flag');
    assert.equal(body.workspace_root, fs.realpathSync(dir));
    assert.equal(body.seeded.title, 'AgentXP Mode first rep: complete one proof-backed customer-motion mission');
    assert.equal(body.mission.assigned_to, 'justin');
    assert.deepEqual(body.next_commands.slice(0, 2), [
      `atris task claim ${body.mission.ref} --as game-manager`,
      `atris task ready ${body.mission.ref} --as game-manager --proof "<artifact path + verifier result>"`,
    ]);
    assert.equal(body.next_commands.includes('atris xp sync --local --as justin --token <owner-provided-token>'), true);
    assert.equal(body.next_commands.includes('atris login'), true);
    assert.equal(body.next_commands.includes('atris xp sync --local --as justin'), true);
    assert.ok(fs.existsSync(path.join(dir, 'atris')), 'play should initialize the local game workspace');
  } finally {
    cleanupTempDir(dir);
  }
});

test('play mode help is workspace-free and non-mutating', () => {
  const dir = makeTempDir();
  try {
    const home = path.join(dir, 'home');
    const res = runCli(['play', '--help'], { cwd: dir, env: { HOME: home } });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /Usage: atris play/);
    assert.doesNotMatch(res.stdout + res.stderr, /Run "atris init"|Not logged in|CONTEXT LOADED/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
    assert.equal(fs.existsSync(path.join(home, '.atris')), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task review writes a reviewed event and RSI episode jsonl', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const add = runCli(['task', 'add', 'Close RSI task loop', '--tag', 'rsi', '--json'], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const addPayload = JSON.parse(add.stdout);
    const id = addPayload.task_id;
    const ref = addPayload.task.display_id;
    assert.equal(runCli(['task', 'done', ref], { cwd: dir, env }).status, 0);

    const review = runCli([
      'task', 'review', ref,
      '--reward', '1',
      '--lesson', 'Small task events compound',
      '--next', 'Sync task events to Swarlo',
      '--proof', 'npm test',
      '--as', 'codex',
    ], { cwd: dir, env });
    assert.equal(review.status, 0, review.stderr);
    assert.match(review.stdout, new RegExp(`reviewed ${ref} v3 reward=1`));
    assert.match(review.stdout, /next: Sync task events to Swarlo/);

    const events = runCli(['task', 'events', ref], { cwd: dir, env });
    assert.equal(events.status, 0, events.stderr);
    assert.match(events.stdout, new RegExp(`3\\treviewed\\t${ref}`));

    const episodePath = path.join(dir, '.atris', 'state', 'task_episodes.jsonl');
    const episode = JSON.parse(fs.readFileSync(episodePath, 'utf8').trim());
    assert.equal(episode.schema, 'atris.task_episode.v1');
    assert.equal(episode.task_id, id);
    assert.equal(episode.reward.value, 1);
    assert.equal(episode.action.actor, 'codex');
    assert.equal(episode.lesson, 'Small task events compound');
    assert.equal(episode.proof, 'npm test');
    assert.equal(episode.next_task_suggestion, 'Sync task events to Swarlo');
    assert.equal(episode.goal, null);
    assert.deepEqual(episode.career_xp, {
      eligible: false,
      source: 'task_review',
      reward: 1,
      proof_required: true,
    });
    assert.deepEqual(episode.rl, {
      label: 'accepted',
      source: 'task_review',
      reward: 1,
      has_proof: true,
      has_lesson: true,
      has_next_task: true,
    });
  } finally {
    cleanupTempDir(dir);
  }
});

test('task done with proof writes a reviewed proof event', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const add = runCli(['task', 'add', 'Validate done proof persistence', '--tag', 'rsi'], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const id = add.stdout.trim().split('\t')[0];

    const done = runCli([
      'task', 'done', id,
      '--proof', 'task show exposes reviewed proof',
      '--lesson', 'done with proof should unlock review state',
      '--json',
    ], { cwd: dir, env });
    assert.equal(done.status, 0, done.stderr);
    const donePayload = JSON.parse(done.stdout);
    assert.equal(donePayload.reviewed, true);
    assert.equal(donePayload.reward, 1);
    assert.equal(donePayload.episode.proof, 'task show exposes reviewed proof');
    assert.equal(donePayload.episode.lesson, 'done with proof should unlock review state');
    assert.equal(donePayload.episode.career_xp.eligible, false);
    assert.equal(donePayload.xp_projection.total_xp, 0);
    assert.equal(donePayload.xp_projection.collected_receipts, 0);

    const show = runCli(['task', 'show', id, '--json'], { cwd: dir, env });
    assert.equal(show.status, 0, show.stderr);
    const task = JSON.parse(show.stdout);
    assert.equal(task.status, 'done');
    assert.deepEqual(task.events.map(e => e.event_type), ['created', 'completed', 'reviewed']);
    assert.equal(task.review.proof, 'task show exposes reviewed proof');
    assert.equal(task.review.reward, 1);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task review does not mint AgentXP before the task is done', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const add = runCli(['task', 'add', 'Do not pay XP before accept', '--tag', 'agent-xp', '--json'], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const ref = JSON.parse(add.stdout).task.display_id;

    const review = runCli([
      'task', 'review', ref,
      '--reward', '1',
      '--proof', 'premature proof',
      '--as', 'codex',
      '--json',
    ], { cwd: dir, env });
    assert.equal(review.status, 0, review.stderr);
    const reviewPayload = JSON.parse(review.stdout);
    assert.equal(reviewPayload.task.status, 'open');
    assert.equal(reviewPayload.task.metadata?.approval_status, undefined);
    assert.equal(reviewPayload.episode.career_xp.eligible, false);
    assert.equal(reviewPayload.episode.rl.label, 'accepted');

    const status = runCli(['xp', 'status', '--local', '--json'], { cwd: dir, env });
    assert.equal(status.status, 0, status.stderr);
    const payload = JSON.parse(status.stdout);
    assert.equal(payload.total_xp, 0);
    assert.equal(payload.collected_receipts, 0);

    const accept = runCli(['task', 'accept', ref, '--as', 'keshavrao', '--json'], { cwd: dir, env });
    assert.equal(accept.status, 2);
    assert.match(accept.stderr, /fresh proof_ready proof/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task ready holds work in review until human accept', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const add = runCli([
      'task', 'add', 'Approve autonomous work before XP',
      '--tag', 'agent',
      '--goal-id', 'goal-agent-xp',
      '--goal-objective', 'Make AgentXP recruitable',
      '--json',
    ], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const created = JSON.parse(add.stdout);
    const ref = created.task.display_id;
    assert.equal(created.task.metadata.goal_id, 'goal-agent-xp');
    assert.equal(created.task.metadata.goal_objective, 'Make AgentXP recruitable');
    assert.equal(runCli(['task', 'claim', ref, '--as', 'codex'], { cwd: dir, env }).status, 0);

    const ready = runCli([
      'task', 'ready', ref,
      '--proof', 'typecheck passed and diff reviewed',
      '--as', 'codex',
      '--json',
    ], { cwd: dir, env });
    assert.equal(ready.status, 0, ready.stderr);
    const readyPayload = JSON.parse(ready.stdout);
    assert.equal(readyPayload.action, 'ready');
    assert.equal(readyPayload.approval_status, 'pending');
    assert.equal(readyPayload.review_pass_count, 1);
    assert.equal(readyPayload.agent_certified, false);
    assert.deepEqual(readyPayload.handoff, {
      native_goal_status: 'needs_second_agent_review',
      career_xp_status: 'pending_human_accept',
      next_action: 'agent_review_again',
      rule: 'Proof is in Review; one more agent review pass certifies continuation. AgentXP waits for human accept.',
    });
    assert.equal(readyPayload.task.status, 'review');
    assert.equal(readyPayload.task.review.summary, 'This is AgentXP review: approve autonomous work before XP is agent-complete; accept only if the proof is real.');
    assert.equal(readyPayload.task.review.proof, 'typecheck passed and diff reviewed');
    assert.equal(readyPayload.task.review.reward, null);
    assert.equal(readyPayload.task.review.approval_status, 'pending');
    assert.equal(readyPayload.task.review.agent_certified, undefined);

    const readyShow = runCli(['task', 'show', ref], { cwd: dir, env });
    assert.equal(readyShow.status, 0, readyShow.stderr);
    assert.match(readyShow.stdout, /Summary: This is AgentXP review: approve autonomous work before XP is agent-complete; accept only if the proof is real\./);
    assert.match(readyShow.stdout, /Proof: typecheck passed and diff reviewed/);
    assert.match(readyShow.stdout, /Approval: pending/);
    assert.doesNotMatch(readyShow.stdout, /Agent certified: yes/);

    const prooflessReview = runCli([
      'task', 'review', ref,
      '--reward', '0',
      '--as', 'validator',
      '--json',
    ], { cwd: dir, env });
    assert.equal(prooflessReview.status, 0, prooflessReview.stderr);
    assert.equal(JSON.parse(prooflessReview.stdout).task.review.proof, 'typecheck passed and diff reviewed');

    const nextAfterFirstReview = runCli(['task', 'next', '--as', 'codex', '--json'], { cwd: dir, env });
    assert.equal(nextAfterFirstReview.status, 0, nextAfterFirstReview.stderr);
    const firstNextPayload = JSON.parse(nextAfterFirstReview.stdout);
    assert.equal(firstNextPayload.action, 'agent_review_again');
    assert.equal(firstNextPayload.task_id, readyPayload.task.id);
    assert.equal(firstNextPayload.handoff.career_xp_status, 'pending_human_accept');

    const certified = runCli([
      'task', 'ready', ref,
      '--proof', 'typecheck passed and diff reviewed again',
      '--lesson', 'Double-check proof before awarding XP',
      '--next', 'Queue the next proof loop',
      '--as', 'codex',
      '--json',
    ], { cwd: dir, env });
    assert.equal(certified.status, 0, certified.stderr);
    const certifiedPayload = JSON.parse(certified.stdout);
    assert.equal(certifiedPayload.review_pass_count, 2);
    assert.equal(certifiedPayload.agent_certified, true);
    assert.deepEqual(certifiedPayload.handoff, {
      native_goal_status: 'agent_certified',
      career_xp_status: 'pending_human_accept',
      next_action: 'continue_work',
      rule: 'Agent double-check complete; continue work. AgentXP waits for human accept.',
    });
    assert.equal(certifiedPayload.task.status, 'review');
    assert.equal(certifiedPayload.task.review.approval_status, 'pending');
    assert.equal(certifiedPayload.task.review.agent_review_pass_count, 2);
    assert.equal(certifiedPayload.task.review.agent_certified, true);
    assert.equal(certifiedPayload.task.metadata.agent_certified, true);

    const prematureDone = runCli(['task', 'done', ref, '--as', 'codex', '--json'], { cwd: dir, env });
    assert.equal(prematureDone.status, 1);
    assert.equal(prematureDone.stderr, '');
    const prematureDonePayload = JSON.parse(prematureDone.stdout);
    assert.equal(prematureDonePayload.reason, 'not_open_or_claimed');
    assert.match(prematureDonePayload.detail, /not in open\|claimed/);
    const stillReview = runCli(['task', 'show', ref, '--json'], { cwd: dir, env });
    assert.equal(stillReview.status, 0, stillReview.stderr);
    assert.equal(JSON.parse(stillReview.stdout).status, 'review');

    const certifiedShow = runCli(['task', 'show', ref], { cwd: dir, env });
    assert.equal(certifiedShow.status, 0, certifiedShow.stderr);
	    assert.match(certifiedShow.stdout, /Proof: typecheck passed and diff reviewed again/);
	    assert.match(certifiedShow.stdout, /Approval: pending/);
	    assert.match(certifiedShow.stdout, /Agent certified: yes \(2 reviews\)/);

	    for (let i = 0; i < 10; i += 1) {
	      const note = runCli(['task', 'note', ref, `post-ready context ${i}`, '--as', 'codex'], { cwd: dir, env });
	      assert.equal(note.status, 0, note.stderr);
	    }

    const statusAfterCertification = runCli(['task', 'status', '--json'], { cwd: dir, env });
    assert.equal(statusAfterCertification.status, 0, statusAfterCertification.stderr);
    const statusPayload = JSON.parse(statusAfterCertification.stdout);
    assert.equal(statusPayload.status.needs_review[0].review.proof, 'typecheck passed and diff reviewed again');
    assert.equal(statusPayload.status.needs_review[0].review.lesson, 'Double-check proof before awarding XP');
    assert.equal(statusPayload.status.needs_review[0].review.next_task, 'Queue the next proof loop');
	    assert.equal(statusPayload.status.needs_review[0].review.handoff.next_action, 'continue_work');
    assert.equal(statusPayload.status.needs_review[0].review.handoff.career_xp_status, 'pending_human_accept');

    const omittedGuidanceReview = runCli([
      'task', 'review', ref,
      '--reward', '0',
      '--as', 'validator',
      '--json',
    ], { cwd: dir, env });
    assert.equal(omittedGuidanceReview.status, 0, omittedGuidanceReview.stderr);
    const omittedGuidancePayload = JSON.parse(omittedGuidanceReview.stdout);
    assert.equal(omittedGuidancePayload.task.review.proof, 'typecheck passed and diff reviewed again');
    assert.equal(omittedGuidancePayload.task.review.lesson, 'Double-check proof before awarding XP');
    assert.equal(omittedGuidancePayload.task.review.next_task, 'Queue the next proof loop');

    const nextAfterCertification = runCli(['task', 'next', '--as', 'codex', '--json'], { cwd: dir, env });
    assert.equal(nextAfterCertification.status, 0, nextAfterCertification.stderr);
    const nextPayload = JSON.parse(nextAfterCertification.stdout);
    assert.equal(nextPayload.action, 'continue_work');
    assert.equal(nextPayload.task_id, null);
    assert.equal(nextPayload.handoff.next_action, 'continue_work');
    assert.equal(nextPayload.handoff.career_xp_status, 'pending_human_accept');
    assert.equal(nextPayload.review_task.id, certifiedPayload.task.id);

    const textAdd = runCli(['task', 'add', 'Render native goal handoff copy', '--tag', 'agent', '--json'], { cwd: dir, env });
    assert.equal(textAdd.status, 0, textAdd.stderr);
    const textRef = JSON.parse(textAdd.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', textRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const readyText = runCli([
      'task', 'ready', textRef,
      '--proof', 'second validation pass',
      '--as', 'codex',
    ], { cwd: dir, env });
    assert.equal(readyText.status, 0, readyText.stderr);
    assert.match(readyText.stdout, /ready .* pending approval/);
    assert.match(readyText.stdout, /Proof is in Review; one more agent review pass certifies continuation\. AgentXP waits for human accept\./);

    const accept = runCli([
      'task', 'accept', ref,
      '--as', 'keshavrao',
      '--json',
    ], { cwd: dir, env });
    assert.equal(accept.status, 0, accept.stderr);
    const acceptPayload = JSON.parse(accept.stdout);
    assert.equal(acceptPayload.action, 'accepted');
    assert.equal(acceptPayload.task.status, 'done');
    assert.equal(acceptPayload.task.review.reward, 1);
    assert.equal(acceptPayload.task.review.summary, 'This is accepted AgentXP work: approve autonomous work before XP is done and has a proof receipt.');
    assert.equal(acceptPayload.task.review.proof, 'typecheck passed and diff reviewed again');
    assert.equal(acceptPayload.task.review.lesson, 'Double-check proof before awarding XP');
    assert.equal(acceptPayload.task.review.next_task, 'Queue the next proof loop');
    assert.equal(acceptPayload.task.metadata.approval_status, 'accepted');
    assert.equal(acceptPayload.episode.action.actor, 'keshavrao');
    assert.deepEqual(acceptPayload.episode.goal, {
      goal_id: 'goal-agent-xp',
      objective: 'Make AgentXP recruitable',
    });
    assert.equal(acceptPayload.episode.career_xp.eligible, true);
    assert.equal(acceptPayload.episode.rl.label, 'accepted');
    assert.equal(acceptPayload.xp_projection.schema, 'atris.career_xp_projection.v1');
    assert.equal(acceptPayload.xp_projection.collected_receipts, 1);
    assert.equal(acceptPayload.xp_projection.total_xp, 1);
    assert.equal(acceptPayload.xp_projection.latest_accepted_proof.source_task_id, acceptPayload.task_id);

    const clearCli = runCli(['task', 'add', 'Clear stale CLI review guidance', '--tag', 'agent', '--json'], { cwd: dir, env });
    assert.equal(clearCli.status, 0, clearCli.stderr);
    const clearCliRef = JSON.parse(clearCli.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', clearCliRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const clearCliReady = runCli([
      'task', 'ready', clearCliRef,
      '--proof', 'cli clear proof stays visible',
      '--lesson', 'stale CLI lesson',
      '--next', 'stale CLI next',
      '--as', 'codex',
      '--json',
    ], { cwd: dir, env });
    assert.equal(clearCliReady.status, 0, clearCliReady.stderr);
    const clearCliAccept = runCli([
      'task', 'accept', clearCliRef,
      '--as', 'keshavrao',
      '--lesson', '',
      '--next', '',
      '--json',
    ], { cwd: dir, env });
    assert.equal(clearCliAccept.status, 0, clearCliAccept.stderr);
    const clearCliPayload = JSON.parse(clearCliAccept.stdout);
    assert.equal(clearCliPayload.episode.proof, 'cli clear proof stays visible');
    assert.equal(clearCliPayload.episode.lesson, '');
    assert.equal(clearCliPayload.episode.next_task_suggestion, null);
    assert.equal(clearCliPayload.task.review.proof, 'cli clear proof stays visible');
    assert.equal(Object.prototype.hasOwnProperty.call(clearCliPayload.task.review, 'lesson'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(clearCliPayload.task.review, 'next_task'), false);

	    const events = runCli(['task', 'events', ref, '--json'], { cwd: dir, env });
	    assert.equal(events.status, 0, events.stderr);
	    const eventTypes = JSON.parse(events.stdout).events.map(event => event.event_type);
	    assert.deepEqual(eventTypes.slice(0, 5), ['created', 'claimed', 'proof_ready', 'reviewed', 'proof_ready']);
	    assert.deepEqual(eventTypes.slice(-2), ['completed', 'reviewed']);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task next blocks new claims until required second review pass', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const reviewAdd = runCli(['task', 'add', 'Needs second review before continuing', '--tag', 'agent', '--json'], { cwd: dir, env });
    assert.equal(reviewAdd.status, 0, reviewAdd.stderr);
    const reviewRef = JSON.parse(reviewAdd.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', reviewRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    assert.equal(runCli(['task', 'ready', reviewRef, '--proof', 'first pass proof', '--as', 'codex'], { cwd: dir, env }).status, 0);

    const openAdd = runCli(['task', 'add', 'Open work must wait', '--tag', 'agent', '--json'], { cwd: dir, env });
    assert.equal(openAdd.status, 0, openAdd.stderr);
    const openPayload = JSON.parse(openAdd.stdout);

    const next = runCli(['task', 'next', '--as', 'codex', '--json'], { cwd: dir, env });
    assert.equal(next.status, 0, next.stderr);
    const payload = JSON.parse(next.stdout);
    assert.equal(payload.action, 'agent_review_again');
    assert.equal(payload.task_id, JSON.parse(reviewAdd.stdout).task.id);

    const openShow = runCli(['task', 'show', openPayload.task.display_id, '--json'], { cwd: dir, env });
    assert.equal(openShow.status, 0, openShow.stderr);
    assert.equal(JSON.parse(openShow.stdout).status, 'open');
  } finally {
    cleanupTempDir(dir);
  }
});

test('task review summary does not treat incidental XP wording as AgentXP work', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const add = runCli([
      'task', 'add', 'Clean stale claimed task queue after XP review',
      '--tag', 'hygiene',
      '--json',
    ], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const ref = JSON.parse(add.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', ref, '--as', 'codex'], { cwd: dir, env }).status, 0);

    const ready = runCli([
      'task', 'ready', ref,
      '--proof', 'closed stale duplicate scheduler claims as failed reward 0',
      '--as', 'codex',
      '--json',
    ], { cwd: dir, env });
    assert.equal(ready.status, 0, ready.stderr);
    const readyPayload = JSON.parse(ready.stdout);
    assert.equal(readyPayload.task.review.summary, 'This is the human checkpoint: clean stale claimed task queue after XP review is agent-complete and needs acceptance before it counts as done.');
    assert.equal(readyPayload.task.review.proof, 'closed stale duplicate scheduler claims as failed reward 0');

    const readyShow = runCli(['task', 'show', ref], { cwd: dir, env });
    assert.equal(readyShow.status, 0, readyShow.stderr);
    assert.match(readyShow.stdout, /Summary: This is the human checkpoint/);
    assert.match(readyShow.stdout, /Proof: closed stale duplicate scheduler claims as failed reward 0/);
    assert.doesNotMatch(readyShow.stdout, /AgentXP a real local scoreboard/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task accept automatically projects accepted proof into durable local XP ledger', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const add = runCli([
      'task', 'add', 'Ship local AgentXP projection',
      '--tag', 'agent-xp',
      '--goal-id', 'goal-agent-xp',
      '--goal-objective', 'Make XP collectible anywhere',
      '--json',
    ], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const ref = JSON.parse(add.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', ref, '--as', 'codex'], { cwd: dir, env }).status, 0);
    assert.equal(runCli(['task', 'ready', ref, '--proof', 'xp projection test passed', '--as', 'codex'], { cwd: dir, env }).status, 0);
    const accept = runCli(['task', 'accept', ref, '--reward', '2', '--as', 'keshavrao', '--json'], { cwd: dir, env });
    assert.equal(accept.status, 0, accept.stderr);
    const accepted = JSON.parse(accept.stdout);
    const projection = accepted.xp_projection;
    assert.equal(projection.schema, 'atris.career_xp_projection.v1');
    assert.equal(projection.collected_receipts, 1);
    assert.equal(projection.total_xp, 2);
    assert.equal(projection.today_xp, 2);
    assert.equal(projection.level, 1);
    assert.equal(projection.next_level_progress.current_xp, 2);
    assert.equal(projection.next_level_progress.required_xp, 1000);
    assert.equal(projection.next_level_progress.remaining_xp, 998);
    assert.equal(projection.receipts_count, 1);
    assert.equal(projection.latest_accepted_proof.source_task_id, accepted.task_id);
    assert.equal(projection.latest_accepted_proof.proof, 'xp projection test passed');
    assert.equal(projection.latest_accepted_proof.xp, 2);
    assert.equal(projection.latest_accepted_proof.goal.goal_id, 'goal-agent-xp');
    assert.equal(projection.integrity.status, 'verified');
    assert.equal(projection.integrity.local_trust, 'tamper_evident_not_attested');
    assert.equal(projection.leaderboard_eligible, false);
    assert.ok(projection.integrity.head_hash);
    assert.ok(projection.integrity.cursor.bytes_read > 0);

    const receiptsPath = path.join(dir, '.atris', 'state', 'career_xp_receipts.jsonl');
    const projectionPath = path.join(dir, '.atris', 'state', 'career_xp.projection.json');
    const cursorPath = path.join(dir, '.atris', 'state', 'career_xp.cursor.json');
    assert.ok(fs.existsSync(receiptsPath));
    assert.ok(fs.existsSync(projectionPath));
    assert.ok(fs.existsSync(cursorPath));
    const receipts = fs.readFileSync(receiptsPath, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].receipt_id, `task_review:${accepted.episode.episode_id}`);
    assert.equal(receipts[0].chain_version, 'atris.career_xp_receipt_chain.v1');
    assert.ok(receipts[0].source_episode_hash);
    assert.ok(receipts[0].receipt_hash);

    const collect = runCli(['xp', 'collect', '--json'], { cwd: dir, env });
    assert.equal(collect.status, 0, collect.stderr);
    assert.equal(JSON.parse(collect.stdout).collected_receipts, 0);
    assert.equal(fs.readFileSync(receiptsPath, 'utf8').trim().split(/\r?\n/).length, 1);

    const status = runCli(['xp', 'status', '--local', '--json'], { cwd: dir, env });
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).latest_accepted_proof.proof, 'xp projection test passed');
  } finally {
    cleanupTempDir(dir);
  }
});

test('task accept rejects non-positive rewards before marking done', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const add = runCli(['task', 'add', 'Reject zero reward accept', '--tag', 'career-xp', '--json'], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const ref = JSON.parse(add.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', ref, '--as', 'codex'], { cwd: dir, env }).status, 0);
    assert.equal(runCli(['task', 'ready', ref, '--proof', 'accept proof', '--as', 'codex'], { cwd: dir, env }).status, 0);

    const accept = runCli(['task', 'accept', ref, '--reward', '0', '--as', 'keshavrao', '--json'], { cwd: dir, env });
    assert.equal(accept.status, 2);
    assert.match(accept.stderr, /reward must be a positive number/);

    const show = runCli(['task', 'show', ref, '--json'], { cwd: dir, env });
    assert.equal(show.status, 0, show.stderr);
    const task = JSON.parse(show.stdout);
    assert.equal(task.status, 'review');
    assert.equal(task.metadata.approval_status, 'pending');
  } finally {
    cleanupTempDir(dir);
  }
});

test('task review after acceptance cannot mint duplicate AgentXP', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const add = runCli(['task', 'add', 'Keep accepted XP idempotent', '--tag', 'agent-xp', '--json'], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const ref = JSON.parse(add.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', ref, '--as', 'codex'], { cwd: dir, env }).status, 0);
    assert.equal(runCli(['task', 'ready', ref, '--proof', 'accepted once', '--as', 'codex'], { cwd: dir, env }).status, 0);

    const accept = runCli(['task', 'accept', ref, '--as', 'keshavrao', '--json'], { cwd: dir, env });
    assert.equal(accept.status, 0, accept.stderr);
    assert.equal(JSON.parse(accept.stdout).xp_projection.total_xp, 1);

    const extraReview = runCli(['task', 'review', ref, '--reward', '1', '--proof', 'duplicate review proof', '--as', 'codex', '--json'], { cwd: dir, env });
    assert.equal(extraReview.status, 0, extraReview.stderr);
    const extraReviewPayload = JSON.parse(extraReview.stdout);
    assert.equal(extraReviewPayload.episode.career_xp.eligible, false);
    assert.equal(extraReviewPayload.xp_projection.total_xp, 1);
    assert.equal(extraReviewPayload.xp_projection.collected_receipts, 0);

    const status = runCli(['xp', 'status', '--local', '--json'], { cwd: dir, env });
    assert.equal(status.status, 0, status.stderr);
    const payload = JSON.parse(status.stdout);
    assert.equal(payload.total_xp, 1);
    assert.equal(payload.receipts_count, 1);
  } finally {
    cleanupTempDir(dir);
  }
});

test('xp status repairs exact duplicate local XP receipts', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const add = runCli(['task', 'add', 'Repair duplicate XP receipt', '--tag', 'career-xp', '--json'], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const ref = JSON.parse(add.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', ref, '--as', 'codex'], { cwd: dir, env }).status, 0);
    assert.equal(runCli(['task', 'ready', ref, '--proof', 'duplicate receipt repair proof', '--as', 'codex'], { cwd: dir, env }).status, 0);
    const accept = runCli(['task', 'accept', ref, '--reward', '1', '--as', 'keshavrao', '--json'], { cwd: dir, env });
    assert.equal(accept.status, 0, accept.stderr);

    const receiptsPath = path.join(dir, '.atris', 'state', 'career_xp_receipts.jsonl');
    const original = fs.readFileSync(receiptsPath, 'utf8').trim();
    fs.writeFileSync(receiptsPath, `${original}\n${original}\n`, 'utf8');

    const status = runCli(['xp', 'status', '--local', '--json'], { cwd: dir, env });
    assert.equal(status.status, 0, status.stderr);
    const projection = JSON.parse(status.stdout);
    assert.equal(projection.integrity.status, 'verified');
    assert.equal(projection.total_xp, 1);
    assert.equal(projection.receipts_count, 1);
    assert.equal(fs.readFileSync(receiptsPath, 'utf8').trim().split(/\r?\n/).length, 1);
  } finally {
    cleanupTempDir(dir);
  }
});

test('xp status fails closed on conflicting duplicate receipts with readable labels', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const title = 'Detect conflicting XP receipt';
    const add = runCli(['task', 'add', title, '--tag', 'career-xp', '--json'], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const ref = JSON.parse(add.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', ref, '--as', 'codex'], { cwd: dir, env }).status, 0);
    assert.equal(runCli(['task', 'ready', ref, '--proof', 'conflict proof', '--as', 'codex'], { cwd: dir, env }).status, 0);
    const accept = runCli(['task', 'accept', ref, '--reward', '1', '--as', 'keshavrao', '--json'], { cwd: dir, env });
    assert.equal(accept.status, 0, accept.stderr);

    const receiptsPath = path.join(dir, '.atris', 'state', 'career_xp_receipts.jsonl');
    const receipt = JSON.parse(fs.readFileSync(receiptsPath, 'utf8').trim());
    const conflicting = { ...receipt, proof: 'conflicting proof', xp: 2 };
    fs.writeFileSync(receiptsPath, `${JSON.stringify(receipt)}\n${JSON.stringify(conflicting)}\n`, 'utf8');

    const status = runCli(['xp', 'status', '--local', '--json'], { cwd: dir, env });
    assert.equal(status.status, 0, status.stderr);
    const projection = JSON.parse(status.stdout);
    assert.equal(projection.integrity.status, 'tampered');
    assert.equal(projection.total_xp, 0);
    assert.match(projection.integrity.errors.join('\n'), new RegExp(`conflicting_duplicate_receipt:${title}`));
    assert.doesNotMatch(projection.integrity.errors.join('\n'), /task_review:[A-Z0-9]+/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('xp status fails closed when local receipt ledger is tampered', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const add = runCli(['task', 'add', 'Detect XP tampering', '--tag', 'career-xp', '--json'], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const ref = JSON.parse(add.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', ref, '--as', 'codex'], { cwd: dir, env }).status, 0);
    assert.equal(runCli(['task', 'ready', ref, '--proof', 'tamper test proof', '--as', 'codex'], { cwd: dir, env }).status, 0);
    const accept = runCli(['task', 'accept', ref, '--reward', '1', '--as', 'keshavrao', '--json'], { cwd: dir, env });
    assert.equal(accept.status, 0, accept.stderr);
    assert.equal(JSON.parse(accept.stdout).xp_projection.total_xp, 1);

    const receiptsPath = path.join(dir, '.atris', 'state', 'career_xp_receipts.jsonl');
    const tampered = fs.readFileSync(receiptsPath, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
    tampered[0].xp = 999;
    fs.writeFileSync(receiptsPath, `${JSON.stringify(tampered[0])}\n`, 'utf8');

    const status = runCli(['xp', 'status', '--local', '--json'], { cwd: dir, env });
    assert.equal(status.status, 0, status.stderr);
    const projection = JSON.parse(status.stdout);
    assert.equal(projection.integrity.status, 'tampered');
    assert.equal(projection.total_xp, 0);
    assert.equal(projection.today_xp, 0);
    assert.equal(projection.leaderboard_eligible, false);
    assert.match(projection.integrity.errors.join('\n'), /receipt_hash_mismatch/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task revise sends ready work back to claimed with revision count', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const add = runCli(['task', 'add', 'Revise autonomous work', '--tag', 'agent', '--json'], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const ref = JSON.parse(add.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', ref, '--as', 'codex'], { cwd: dir, env }).status, 0);
    assert.equal(runCli(['task', 'ready', ref, '--proof', 'smoke passed', '--as', 'codex'], { cwd: dir, env }).status, 0);
    assert.equal(runCli(['task', 'ready', ref, '--proof', 'second smoke passed', '--as', 'codex'], { cwd: dir, env }).status, 0);

    const revise = runCli([
      'task', 'revise', ref,
      '--note', 'Proof is good but the user-facing copy is too much.',
      '--as', 'keshavrao',
      '--json',
    ], { cwd: dir, env });
    assert.equal(revise.status, 0, revise.stderr);
    const payload = JSON.parse(revise.stdout);
    assert.equal(payload.action, 'revise');
    assert.equal(payload.task.status, 'claimed');
    assert.equal(payload.task.metadata.approval_status, 'revise');
    assert.equal(payload.task.metadata.human_revision_count, 1);
    assert.equal(payload.task.metadata.human_revision_note, 'Proof is good but the user-facing copy is too much.');
    assert.equal(payload.task.metadata.agent_review_pass_count, undefined);
    assert.equal(payload.task.metadata.agent_certified, undefined);
    assert.equal(payload.task.review.proof, undefined);
    assert.equal(payload.task.review.agent_review_pass_count, undefined);
    assert.equal(payload.task.review.agent_certified, undefined);

    const revisedShow = runCli(['task', 'show', ref, '--json'], { cwd: dir, env });
    assert.equal(revisedShow.status, 0, revisedShow.stderr);
    const revisedTask = JSON.parse(revisedShow.stdout);
    assert.equal(revisedTask.review.proof, null);
    assert.equal(revisedTask.review.agent_review_pass_count, null);
    assert.equal(revisedTask.review.agent_certified, false);

    const staleAccept = runCli(['task', 'accept', ref, '--as', 'keshavrao', '--json'], { cwd: dir, env });
    assert.equal(staleAccept.status, 2);
    assert.match(staleAccept.stderr, /fresh proof_ready proof/);

    const revisedReady = runCli(['task', 'ready', ref, '--proof', 'revised proof passed', '--as', 'codex', '--json'], { cwd: dir, env });
    assert.equal(revisedReady.status, 0, revisedReady.stderr);
    const readyPayload = JSON.parse(revisedReady.stdout);
    assert.equal(readyPayload.review_pass_count, 1);
    assert.equal(readyPayload.agent_certified, false);
    assert.equal(readyPayload.handoff.next_action, 'agent_review_again');
  } finally {
    cleanupTempDir(dir);
  }
});

test('task revise returns unclaimed ready work to open so agents can claim it', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const add = runCli(['task', 'add', 'Revise open ready task', '--tag', 'agent', '--json'], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const ref = JSON.parse(add.stdout).task.display_id;
    assert.equal(runCli(['task', 'ready', ref, '--proof', 'open task proof', '--as', 'codex'], { cwd: dir, env }).status, 0);

    const revise = runCli(['task', 'revise', ref, '--note', 'tighten proof', '--as', 'keshavrao', '--json'], { cwd: dir, env });
    assert.equal(revise.status, 0, revise.stderr);
    const revisedPayload = JSON.parse(revise.stdout);
    assert.equal(revisedPayload.task.status, 'open');
    assert.equal(revisedPayload.task.claimed_by, undefined);

    const claim = runCli(['task', 'claim', ref, '--as', 'codex', '--json'], { cwd: dir, env });
    assert.equal(claim.status, 0, claim.stderr);
    assert.equal(JSON.parse(claim.stdout).task.status, 'claimed');
  } finally {
    cleanupTempDir(dir);
  }
});

test('task revise refuses accepted tasks so XP is not stale', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const add = runCli(['task', 'add', 'Do not revise accepted XP', '--tag', 'career-xp', '--json'], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const ref = JSON.parse(add.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', ref, '--as', 'codex'], { cwd: dir, env }).status, 0);
    assert.equal(runCli(['task', 'ready', ref, '--proof', 'accepted proof', '--as', 'codex'], { cwd: dir, env }).status, 0);
    const accept = runCli(['task', 'accept', ref, '--as', 'keshavrao', '--json'], { cwd: dir, env });
    assert.equal(accept.status, 0, accept.stderr);
    assert.equal(JSON.parse(accept.stdout).xp_projection.total_xp, 1);

    const revise = runCli(['task', 'revise', ref, '--note', 'needs more work', '--as', 'keshavrao', '--json'], { cwd: dir, env });
    assert.equal(revise.status, 1);
    assert.match(revise.stderr, /not_reviewable_done/);

    const status = runCli(['xp', 'status', '--local', '--json'], { cwd: dir, env });
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).total_xp, 1);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task setup initializes projection and can import TODO view', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), [
      '# TODO.md',
      '',
      '## Backlog',
      '',
      '- Make task setup one command',
      '  **Tag:** tasks',
      '',
    ].join('\n'), 'utf8');

    const setup = runCli(['task', 'setup', '--import-todo'], { cwd: dir, env });
    assert.equal(setup.status, 0, setup.stderr);
    assert.match(setup.stdout, /tasks ready: 1 task/);
    assert.match(setup.stdout, /imported 1 new, skipped 0/);

    const projectionPath = path.join(dir, '.atris', 'state', 'tasks.projection.json');
    const projection = JSON.parse(fs.readFileSync(projectionPath, 'utf8'));
    assert.equal(projection.schema, 'atris.task_projection.v1');
    assert.equal(projection.tasks.length, 1);
    assert.equal(projection.tasks[0].title, 'Make task setup one command');
  } finally {
    cleanupTempDir(dir);
  }
});

test('task natural flow creates, picks, talks, finishes, and refreshes projection', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const created = runCli(['task', 'new', 'Make tasks feel natural', '--tag', 'ux', '--json'], { cwd: dir, env });
    assert.equal(created.status, 0, created.stderr);
    const createdPayload = JSON.parse(created.stdout);
    const id = createdPayload.task_id;
    const ref = createdPayload.task.display_id;
    const legacyRef = id.slice(0, 8);

    const desk = runCli(['task'], { cwd: dir, env });
    assert.equal(desk.status, 0, desk.stderr);
    assert.match(desk.stdout, /TASK DESK/);
    assert.match(desk.stdout, new RegExp(`open\\s+${ref}`));
    assert.match(desk.stdout, /next: atris task next/);

    const next = runCli(['task', 'next', '--as', 'codex'], { cwd: dir, env });
    assert.equal(next.status, 0, next.stderr);
    assert.match(next.stdout, new RegExp(`next ${ref} @codex`));

    const said = runCli(['task', 'say', legacyRef, 'This should feel like a tiny task chat', '--as', 'codex'], { cwd: dir, env });
    assert.equal(said.status, 0, said.stderr);
    assert.match(said.stdout, new RegExp(`noted ${ref} v3`));

    const finish = runCli([
      'task', 'finish', ref,
      '--proof', 'npm test',
      '--lesson', 'Natural task verbs reduce coordination tax',
      '--next', 'Show task cards in every surface',
      '--as', 'codex',
    ], { cwd: dir, env });
    assert.equal(finish.status, 0, finish.stderr);
    assert.match(finish.stdout, new RegExp(`finished ${ref} reward=1`));

    const projectionPath = path.join(dir, '.atris', 'state', 'tasks.projection.json');
    const projection = JSON.parse(fs.readFileSync(projectionPath, 'utf8'));
    assert.equal(projection.tasks[0].id, id);
    assert.equal(projection.tasks[0].display_id, ref);
    assert.equal(projection.tasks[0].legacy_ref, legacyRef);
    assert.equal(projection.tasks[0].status, 'done');
    assert.equal(projection.tasks[0].current_version, 5);
    assert.equal(projection.tasks[0].messages[0].content, 'This should feel like a tiny task chat');

    const episodePath = path.join(dir, '.atris', 'state', 'task_episodes.jsonl');
    const episode = JSON.parse(fs.readFileSync(episodePath, 'utf8').trim());
    assert.equal(episode.action.actor, 'codex');
    assert.equal(episode.lesson, 'Natural task verbs reduce coordination tax');
  } finally {
    cleanupTempDir(dir);
  }
});

test('task headless JSON contract supports create, claim, note, finish, and events', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const created = runCli(['task', 'new', 'Headless agents need JSON', '--tag', 'headless', '--json'], { cwd: dir, env });
    assert.equal(created.status, 0, created.stderr);
    const createPayload = JSON.parse(created.stdout);
    assert.equal(createPayload.ok, true);
    assert.equal(createPayload.action, 'created');
    assert.equal(createPayload.task.title, 'Headless agents need JSON');
    assert.ok(fs.existsSync(createPayload.projection_path));
    const id = createPayload.task_id;
    const shortId = id.slice(0, 8);

    const desk = runCli(['task', '--json'], { cwd: dir, env });
    assert.equal(desk.status, 0, desk.stderr);
    const deskPayload = JSON.parse(desk.stdout);
    assert.equal(deskPayload.ok, true);
    assert.equal(deskPayload.active_count, 1);
    assert.equal(deskPayload.projection.tasks[0].id, id);

    const next = runCli(['task', 'next', '--as', 'bot', '--json'], { cwd: dir, env });
    assert.equal(next.status, 0, next.stderr);
    const nextPayload = JSON.parse(next.stdout);
    assert.equal(nextPayload.action, 'next');
    assert.equal(nextPayload.owner, 'bot');
    assert.equal(nextPayload.task.claimed_by, 'bot');

    const claimConflict = runCli(['task', 'claim', shortId, '--as', 'other', '--json'], { cwd: dir, env });
    assert.equal(claimConflict.status, 1);
    assert.equal(claimConflict.stderr, '');
    const claimConflictPayload = JSON.parse(claimConflict.stdout);
    assert.equal(claimConflictPayload.ok, false);
    assert.equal(claimConflictPayload.command, 'atris task claim');
    assert.equal(claimConflictPayload.reason, 'already_claimed');
    assert.equal(claimConflictPayload.claimed_by, 'bot');

    const humanClaimConflict = runCli(['task', 'claim', shortId, '--as', 'other'], { cwd: dir, env });
    assert.equal(humanClaimConflict.status, 1);
    assert.equal(humanClaimConflict.stdout, '');
    assert.match(humanClaimConflict.stderr, /claim failed: already_claimed \(held by bot\)/);

    const note = runCli(['task', 'say', shortId, 'machine-readable context', '--as', 'bot', '--json'], { cwd: dir, env });
    assert.equal(note.status, 0, note.stderr);
    const notePayload = JSON.parse(note.stdout);
    assert.equal(notePayload.action, 'noted');
    assert.equal(notePayload.version, 3);
    assert.equal(notePayload.task.latest_event_type, 'message');

    const shown = runCli(['task', 'show', shortId, '--json'], { cwd: dir, env });
    assert.equal(shown.status, 0, shown.stderr);
    const shownPayload = JSON.parse(shown.stdout);
    assert.equal(shownPayload.messages[0].content, 'machine-readable context');

    const finish = runCli([
      'task', 'finish', shortId,
      '--proof', 'node --test',
      '--lesson', 'Headless workers need JSON, not terminal prose',
      '--next', 'Sync JSON task events to Supabase',
      '--as', 'bot',
      '--json',
    ], { cwd: dir, env });
    assert.equal(finish.status, 0, finish.stderr);
    const finishPayload = JSON.parse(finish.stdout);
    assert.equal(finishPayload.action, 'finished');
    assert.equal(finishPayload.reviewed, true);
    assert.equal(finishPayload.task.status, 'done');
    assert.equal(finishPayload.episode.action.actor, 'bot');

    const doneConflict = runCli(['task', 'done', shortId, '--json'], { cwd: dir, env });
    assert.equal(doneConflict.status, 1);
    assert.equal(doneConflict.stderr, '');
    const doneConflictPayload = JSON.parse(doneConflict.stdout);
    assert.equal(doneConflictPayload.ok, false);
    assert.equal(doneConflictPayload.command, 'atris task done');
    assert.equal(doneConflictPayload.reason, 'not_open_or_claimed');
    assert.equal(doneConflictPayload.task_id, id);

    const finishConflict = runCli(['task', 'finish', shortId, '--json'], { cwd: dir, env });
    assert.equal(finishConflict.status, 1);
    assert.equal(finishConflict.stderr, '');
    const finishConflictPayload = JSON.parse(finishConflict.stdout);
    assert.equal(finishConflictPayload.ok, false);
    assert.equal(finishConflictPayload.command, 'atris task finish');
    assert.equal(finishConflictPayload.reason, 'not_open_or_claimed');
    assert.equal(finishConflictPayload.task_id, id);

    const humanFinishConflict = runCli(['task', 'finish', shortId], { cwd: dir, env });
    assert.equal(humanFinishConflict.status, 1);
    assert.equal(humanFinishConflict.stdout, '');
    assert.match(humanFinishConflict.stderr, /finish failed: .* not in open\|claimed/);

    const events = runCli(['task', 'events', shortId, '--json'], { cwd: dir, env });
    assert.equal(events.status, 0, events.stderr);
    const eventsPayload = JSON.parse(events.stdout);
    assert.deepEqual(eventsPayload.events.map(e => e.event_type), ['created', 'claimed', 'message', 'completed', 'reviewed']);

    const where = runCli(['task', 'where', '--json'], { cwd: dir, env });
    assert.equal(where.status, 0, where.stderr);
    const wherePayload = JSON.parse(where.stdout);
    assert.equal(wherePayload.ok, true);
    assert.equal(wherePayload.db, dbPath);
    assert.equal(wherePayload.workspace, fs.realpathSync(dir));

    const unknown = runCli(['task', 'not-a-subcommand', '--json'], { cwd: dir, env });
    assert.equal(unknown.status, 2);
    assert.equal(unknown.stderr, '');
    const unknownPayload = JSON.parse(unknown.stdout);
    assert.equal(unknownPayload.ok, false);
    assert.equal(unknownPayload.error, 'unknown task subcommand: not-a-subcommand');
    assert.ok(Array.isArray(unknownPayload.usage));
    assert.ok(unknownPayload.usage.some(line => line.includes('atris task add')));

    const humanUnknown = runCli(['task', 'not-a-subcommand'], { cwd: dir, env });
    assert.equal(humanUnknown.status, 2);
    assert.match(humanUnknown.stderr, /atris task: unknown subcommand "not-a-subcommand"/);
    assert.match(humanUnknown.stdout, /atris task - durable local task state/);

    const missingTitle = runCli(['task', 'add', '--json'], { cwd: dir, env });
    assert.equal(missingTitle.status, 2);
    assert.equal(missingTitle.stderr, '');
    const missingTitlePayload = JSON.parse(missingTitle.stdout);
    assert.equal(missingTitlePayload.ok, false);
    assert.equal(missingTitlePayload.command, 'atris task add');
    assert.equal(missingTitlePayload.reason, 'missing_title');

    const missingClaimId = runCli(['task', 'claim', '--json'], { cwd: dir, env });
    assert.equal(missingClaimId.status, 2);
    assert.equal(missingClaimId.stderr, '');
    const missingClaimPayload = JSON.parse(missingClaimId.stdout);
    assert.equal(missingClaimPayload.ok, false);
    assert.equal(missingClaimPayload.command, 'atris task claim');
    assert.equal(missingClaimPayload.reason, 'missing_id');

    const humanMissingTitle = runCli(['task', 'add'], { cwd: dir, env });
    assert.equal(humanMissingTitle.status, 2);
    assert.equal(humanMissingTitle.stdout, '');
    assert.match(humanMissingTitle.stderr, /title required/);

    const missing = runCli(['task', 'show', 'DOESNOTEXIST', '--json'], { cwd: dir, env });
    assert.equal(missing.status, 2);
    assert.equal(missing.stderr, '');
    const missingPayload = JSON.parse(missing.stdout);
    assert.equal(missingPayload.ok, false);
    assert.equal(missingPayload.command, 'atris task show');
    assert.equal(missingPayload.reason, 'not_found');
  } finally {
    cleanupTempDir(dir);
  }
});

test('task status gives web and Swarlo a compact live contract', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'goals.md'), [
      '# Goals',
      '',
      '- Connect tasks to Swarlo and web command surfaces',
      '',
    ].join('\n'), 'utf8');

    const created = runCli(['task', 'new', 'Show live task status in Atris Web', '--tag', 'swarlo', '--json'], { cwd: dir, env });
    assert.equal(created.status, 0, created.stderr);
    const id = JSON.parse(created.stdout).task_id;

    const parked = runCli(['task', 'new', 'Old imported TODO record', '--json'], { cwd: dir, env });
    assert.equal(parked.status, 0, parked.stderr);

    const explicitNext = runCli(['task', 'new', 'Shape explicit agent goal', '--tag', 'agent', '--json'], { cwd: dir, env });
    assert.equal(explicitNext.status, 0, explicitNext.stderr);
    const explicitNextId = JSON.parse(explicitNext.stdout).task_id;

    const claimed = runCli(['task', 'claim', id, '--as', 'codex', '--json'], { cwd: dir, env });
    assert.equal(claimed.status, 0, claimed.stderr);

    const status = runCli(['task', 'status', '--json'], { cwd: dir, env });
    assert.equal(status.status, 0, status.stderr);
    const payload = JSON.parse(status.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.action, 'status');
    assert.equal(payload.status.schema, 'atris.task_status.v1');
    assert.equal(payload.status.counts.active, 2);
    assert.equal(payload.status.counts.backlog, 1);
    assert.equal(payload.status.counts.plan, 1);
    assert.equal(payload.status.counts.do, 1);
    assert.equal(payload.status.current.id, id);
    assert.equal(Object.hasOwn(payload.status.current, 'events'), false);
    assert.equal(Object.hasOwn(payload.status.current, 'messages'), false);
    assert.equal(Object.hasOwn(payload.status.current, 'review'), false);
    assert.equal(Object.hasOwn(payload.status.current, 'lineage'), false);
    assert.equal(Object.hasOwn(payload.status.current, 'metadata'), false);
    assert.equal(Object.hasOwn(payload.status.current, 'workspace_root'), false);
    assert.equal(payload.status.next.id, explicitNextId);
    assert.equal(payload.status.goals.items[0], 'Connect tasks to Swarlo and web command surfaces');
    assert.equal(Object.hasOwn(payload.status, 'last_event'), false);
    assert.equal(Object.hasOwn(payload.status, 'swarlo'), false);

    const text = runCli(['task', 'status'], { cwd: dir, env });
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /TASK STATUS/);
    assert.match(text.stdout, /plan 1 \/ do 1 \/ review 0 \/ backlog 1 \/ done 0/);
    assert.doesNotMatch(text.stdout, /swarlo feed/);

    const history = runCli(['task', 'status', '--json', '--history'], { cwd: dir, env });
    assert.equal(history.status, 0, history.stderr);
    const historyPayload = JSON.parse(history.stdout);
    assert.equal(historyPayload.status.last_event.task.id, id);
    assert.equal(Object.hasOwn(historyPayload.status.last_event.task, 'events'), false);
    assert.equal(historyPayload.status.last_event.event.event_type, 'claimed');
    assert.equal(historyPayload.status.swarlo.feed[0].kind, 'claim');
    assert.equal(historyPayload.status.swarlo.feed[0].metadata.swarlo.task_key, id);
    assert.match(historyPayload.status.swarlo.realtime_contract.web, /atrisos-web/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task status resolves goal_id display refs to parent task objectives', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'goals.md'), [
      '# Goals',
      '',
      '- **Owned by:** chief-of-staff should not become the task objective',
      '',
    ].join('\n'), 'utf8');

    const parentCreated = runCli(['task', 'add', 'GM Desk v0: make Atris Labs open to one playable daily rep', '--tag', 'gm-desk', '--json'], { cwd: dir, env });
    assert.equal(parentCreated.status, 0, parentCreated.stderr);
    const parent = JSON.parse(parentCreated.stdout).task;

    const childCreated = runCli(['task', 'add', 'GM Desk v0 step 2: route Atris Labs open to daily surface, no /flow', '--tag', 'gm-desk', '--goal-id', parent.display_id, '--json'], { cwd: dir, env });
    assert.equal(childCreated.status, 0, childCreated.stderr);
    const child = JSON.parse(childCreated.stdout).task;

    const claimed = runCli(['task', 'claim', child.id, '--as', 'builder', '--json'], { cwd: dir, env });
    assert.equal(claimed.status, 0, claimed.stderr);

    const status = runCli(['task', 'status', '--json'], { cwd: dir, env });
    assert.equal(status.status, 0, status.stderr);
    const payload = JSON.parse(status.stdout);
    assert.equal(payload.status.current.id, child.id);
    assert.equal(payload.status.current.objective, parent.title);
    assert.equal(payload.status.current.lineage.parent_task_id, parent.id);
    assert.equal(payload.status.current.lineage.parent_title, parent.title);
    assert.ok(payload.status.streams.some(stream => stream.objective === parent.title));
  } finally {
    cleanupTempDir(dir);
  }
});

test('task status treats reviewed failures as closed task health', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    const created = runCli(['task', 'new', 'Goal: who r u', '--tag', 'goal', '--json'], { cwd: dir, env });
    assert.equal(created.status, 0, created.stderr);
    const id = JSON.parse(created.stdout).task_id;
    const claimed = runCli(['task', 'claim', id, '--as', 'command-leader', '--json'], { cwd: dir, env });
    assert.equal(claimed.status, 0, claimed.stderr);
    const failed = runCli(['task', 'done', id, '--failed', '--proof', 'Misrouted small talk; fixed by intake triage.', '--json'], { cwd: dir, env });
    assert.equal(failed.status, 0, failed.stderr);
    const failedPayload = JSON.parse(failed.stdout);
    assert.equal(failedPayload.reviewed, true);

    const status = runCli(['task', 'status', '--json', '--history'], { cwd: dir, env });
    assert.equal(status.status, 0, status.stderr);
    const payload = JSON.parse(status.stdout);
    assert.equal(payload.status.counts.active, 0);
    assert.equal(payload.status.counts.review, 0);
    assert.equal(payload.status.counts.done, 1);
    assert.equal(payload.status.current, null);
    assert.deepEqual(payload.status.needs_review, []);
    assert.equal(payload.status.swarlo.feed[0].metadata.swarlo.status, 'done');
  } finally {
    cleanupTempDir(dir);
  }
});

test('task status keeps history out of the default live card', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const created = runCli(['task', 'new', 'Keep operator status compact', '--json'], { cwd: dir, env });
    assert.equal(created.status, 0, created.stderr);
    const id = JSON.parse(created.stdout).task_id;
    const claimed = runCli(['task', 'claim', id, '--as', 'codex', '--json'], { cwd: dir, env });
    assert.equal(claimed.status, 0, claimed.stderr);

    for (let i = 0; i < 8; i += 1) {
      const noted = runCli(['task', 'say', id, `status note ${i}`, '--as', 'codex', '--json'], { cwd: dir, env });
      assert.equal(noted.status, 0, noted.stderr);
    }

    const status = runCli(['task', 'status', '--json'], { cwd: dir, env });
    assert.equal(status.status, 0, status.stderr);
    const payload = JSON.parse(status.stdout);
    assert.equal(Object.hasOwn(payload.status, 'swarlo'), false);
    assert.equal(Object.hasOwn(payload.status, 'last_event'), false);

    const history = runCli(['task', 'status', '--json', '--history'], { cwd: dir, env });
    assert.equal(history.status, 0, history.stderr);
    const historyPayload = JSON.parse(history.stdout);
    assert.equal(historyPayload.status.swarlo.feed.length, 10);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task render archives old completed records from TODO view', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    for (let i = 0; i < 12; i += 1) {
      const created = runCli(['task', 'new', `Completed task ${i}`, '--tag', 'agent', '--json'], { cwd: dir, env });
      assert.equal(created.status, 0, created.stderr);
      const id = JSON.parse(created.stdout).task_id;
      const done = runCli(['task', 'done', id, '--json'], { cwd: dir, env });
      assert.equal(done.status, 0, done.stderr);
    }

    const render = runCli(['task', 'render', '--out', 'atris/TODO.md'], { cwd: dir, env });
    assert.equal(render.status, 0, render.stderr);
    const regenerated = fs.readFileSync(path.join(dir, 'atris', 'TODO.md'), 'utf8');
    const completedLines = regenerated.match(/\*\*\[[^\]]+\]\*\* Completed task/g) || [];
    assert.equal(completedLines.length, 8);
    assert.match(regenerated, /4 older completed tasks archived/);

    const exportOut = path.join(dir, '.atris', 'state', 'tasks.projection.json');
    const exported = runCli(['task', 'export', '--out', exportOut], { cwd: dir, env });
    assert.equal(exported.status, 0, exported.stderr);
    const projection = JSON.parse(fs.readFileSync(exportOut, 'utf8'));
    assert.equal(projection.tasks.length, 8);
    assert.equal(projection.surface.full_task_count, 12);
    assert.equal(projection.surface.visible_task_count, 8);
    assert.equal(projection.surface.hidden_done_count, 4);

    const status = runCli(['task', 'status', '--json'], { cwd: dir, env });
    assert.equal(status.status, 0, status.stderr);
    const statusPayload = JSON.parse(status.stdout);
    assert.equal(statusPayload.status.counts.total, 12);
    assert.equal(statusPayload.status.counts.done, 12);

    const tightRender = runCli(['task', 'render', '--out', 'atris/TODO.md', '--done-limit', '2'], { cwd: dir, env });
    assert.equal(tightRender.status, 0, tightRender.stderr);
    const tight = fs.readFileSync(path.join(dir, 'atris', 'TODO.md'), 'utf8');
    const tightCompletedLines = tight.match(/\*\*\[[^\]]+\]\*\* Completed task/g) || [];
    assert.equal(tightCompletedLines.length, 2);
    assert.match(tight, /10 older completed tasks archived/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task review can create the next RSI task from the review suggestion', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const created = runCli(['task', 'new', 'Improve task loop', '--tag', 'rsi', '--json'], { cwd: dir, env });
    assert.equal(created.status, 0, created.stderr);
    const id = JSON.parse(created.stdout).task_id;

    const finished = runCli([
      'task', 'finish', id,
      '--proof', 'node --test',
      '--lesson', 'Each task review can seed the next sharper task',
      '--next', 'Make the next task editable from UI',
      '--create-next',
      '--as', 'codex',
      '--json',
    ], { cwd: dir, env });
    assert.equal(finished.status, 0, finished.stderr);
    const payload = JSON.parse(finished.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.task.status, 'done');
    assert.equal(Object.hasOwn(payload, 'projection'), false);
    assert.equal(Object.hasOwn(payload.task, 'events'), false);
    assert.equal(payload.episode.career_xp.eligible, false);
    assert.equal(payload.xp_projection.total_xp, 0);
    assert.ok(payload.next_task_id);
    const next = payload.next_task;
    assert.equal(next.title, 'Make the next task editable from UI');
    assert.equal(next.status, 'open');
    assert.equal(next.tag, 'rsi');
    assert.equal(next.lineage.parent_task_id, id);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task serve exposes a local task factory API', async () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_SKIP_UPDATE_CHECK: '1' };
  let child = null;
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    child = spawn(process.execPath, [cliPath, 'task', 'serve', '--host', '127.0.0.1', '--port', '0'], {
      cwd: dir,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const ready = await waitForOutput(child, /Task board: (http:\/\/127\.0\.0\.1:\d+)/);
    const base = ready.match[1];

	    const html = await fetch(base).then(r => r.text());
	    assert.match(html, /Atris Task Factory/);
	    assert.match(html, /data-smoke="hello-from-ui">hello from UI/);
	    assert.match(html, /\/api\/tasks\/' \+ task\.id \+ '\/ready/);
	    assert.match(html, /\/api\/tasks\/' \+ task\.id \+ '\/accept/);
	    assert.match(html, /if \(lesson\) payload\.lesson = lesson/);
	    assert.match(html, /if \(nextTask\) payload\.next = nextTask/);
	    assert.match(html, /task\.review && task\.review\.next_task/);
	    assert.doesNotMatch(html, /\/api\/tasks\/' \+ task\.id \+ '\/finish/);

    const created = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Ship the task factory board', tag: 'factory' }),
    }).then(r => r.json());
    assert.equal(created.ok, true);
    assert.equal(created.task.title, 'Ship the task factory board');

    const claimed = await fetch(`${base}/api/tasks/${created.task_id.slice(0, 8)}/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ owner: 'swarlo' }),
    }).then(r => r.json());
    assert.equal(claimed.ok, true);
    assert.equal(claimed.task.claimed_by, 'swarlo');

    const noted = await fetch(`${base}/api/tasks/${created.task_id}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'operator', content: 'Looks good in the board' }),
    }).then(r => r.json());
    assert.equal(noted.ok, true);
    assert.equal(noted.task.messages[0].content, 'Looks good in the board');

    const finished = await fetch(`${base}/api/tasks/${created.task_id}/finish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actor: 'operator',
        proof: 'browser API smoke',
        lesson: 'Task factory API can drive the board',
        next: 'Connect the board to Swarlo leases',
        createNext: true,
      }),
    }).then(r => r.json());
    assert.equal(finished.ok, true);
    assert.equal(finished.task.status, 'done');
    assert.equal(finished.episode.career_xp.eligible, false);
    assert.equal(finished.xp_projection.total_xp, 0);
    assert.ok(finished.next_task_id);

    const apiReview = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Reject stale API proof after revise', tag: 'factory' }),
    }).then(r => r.json());
    assert.equal(apiReview.ok, true);
    const apiReviewId = apiReview.task_id;

    const missingReadyProofResponse = await fetch(`${base}/api/tasks/${apiReviewId}/ready`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'codex' }),
    });
    assert.equal(missingReadyProofResponse.status, 400);
    const missingReadyProof = await missingReadyProofResponse.json();
    assert.equal(missingReadyProof.reason, 'proof_required');

    const apiReady = await fetch(`${base}/api/tasks/${apiReviewId}/ready`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'codex', proof: 'old API proof' }),
    }).then(r => r.json());
    assert.equal(apiReady.ok, true);

    const prematureApiFinishResponse = await fetch(`${base}/api/tasks/${apiReviewId}/finish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'codex', proof: 'skip accept' }),
    });
    assert.equal(prematureApiFinishResponse.status, 409);
    const prematureApiFinish = await prematureApiFinishResponse.json();
    assert.equal(prematureApiFinish.reason, 'not_open_or_claimed');

    const apiRevise = await fetch(`${base}/api/tasks/${apiReviewId}/revise`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'operator', note: 'needs another pass' }),
    }).then(r => r.json());
    assert.equal(apiRevise.ok, true);
    assert.equal(apiRevise.task.status, 'open');

    const staleApiAcceptResponse = await fetch(`${base}/api/tasks/${apiReviewId}/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'operator' }),
    });
    assert.equal(staleApiAcceptResponse.status, 400);
    const staleApiAccept = await staleApiAcceptResponse.json();
    assert.equal(staleApiAccept.reason, 'proof_required');

    const freshApiReady = await fetch(`${base}/api/tasks/${apiReviewId}/ready`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actor: 'codex',
        proof: 'fresh API proof',
        lesson: 'API accept keeps the ready lesson',
        next: 'Create the API follow-up task',
      }),
    }).then(r => r.json());
    assert.equal(freshApiReady.ok, true);
    const invalidRewardResponse = await fetch(`${base}/api/tasks/${apiReviewId}/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'operator', reward: 0 }),
    });
    assert.equal(invalidRewardResponse.status, 400);
    const invalidReward = await invalidRewardResponse.json();
    assert.equal(invalidReward.reason, 'invalid_reward');

    const freshApiAccept = await fetch(`${base}/api/tasks/${apiReviewId}/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'operator', createNext: true }),
    }).then(r => r.json());
    assert.equal(freshApiAccept.ok, true);
    assert.equal(freshApiAccept.episode.proof, 'fresh API proof');
    assert.equal(freshApiAccept.episode.lesson, 'API accept keeps the ready lesson');
    assert.equal(freshApiAccept.episode.next_task_suggestion, 'Create the API follow-up task');
    assert.ok(freshApiAccept.next_task_id);

    const clearReview = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Clear stale review guidance', tag: 'factory' }),
    }).then(r => r.json());
    assert.equal(clearReview.ok, true);
    const clearReviewId = clearReview.task_id;

    const clearReady = await fetch(`${base}/api/tasks/${clearReviewId}/ready`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actor: 'codex',
        proof: 'clear proof stays visible',
        lesson: 'stale ready lesson',
        next: 'stale ready next',
      }),
    }).then(r => r.json());
    assert.equal(clearReady.ok, true);

    const omittedApiReview = await fetch(`${base}/api/tasks/${clearReviewId}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'validator', reward: 0 }),
    }).then(r => r.json());
    assert.equal(omittedApiReview.ok, true);
    assert.equal(omittedApiReview.task.review.proof, 'clear proof stays visible');
    assert.equal(omittedApiReview.task.review.lesson, 'stale ready lesson');
    assert.equal(omittedApiReview.task.review.next_task, 'stale ready next');

    const clearAccept = await fetch(`${base}/api/tasks/${clearReviewId}/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'operator', lesson: '', next: '' }),
    }).then(r => r.json());
    assert.equal(clearAccept.ok, true);
    assert.equal(clearAccept.episode.proof, 'clear proof stays visible');
    assert.equal(clearAccept.episode.lesson, '');
    assert.equal(clearAccept.episode.next_task_suggestion, null);
    assert.equal(clearAccept.task.review.proof, 'clear proof stays visible');
    assert.equal(clearAccept.task.review.lesson, null);
    assert.equal(clearAccept.task.review.next_task, null);

    const listed = await fetch(`${base}/api/tasks`).then(r => r.json());
    assert.equal(listed.ok, true);
    assert.ok(listed.projection.tasks.some(t => t.id === finished.next_task_id && t.title === 'Connect the board to Swarlo leases'));
    assert.ok(listed.projection.tasks.some(t => t.id === freshApiAccept.next_task_id && t.title === 'Create the API follow-up task'));
  } finally {
    if (child) child.kill('SIGTERM');
    cleanupTempDir(dir);
  }
});

test('task sync dry-run maps local tasks to canonical cloud task writes', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.atris', 'business.json'), JSON.stringify({
      business_id: 'biz-task-sync',
      slug: 'task-sync-lab',
    }), 'utf8');

    const created = runCli(['task', 'new', 'Sync local task to cloud control plane', '--tag', 'swarlo', '--json'], { cwd: dir, env });
    assert.equal(created.status, 0, created.stderr);
    const id = JSON.parse(created.stdout).task_id;

    const claimed = runCli(['task', 'claim', id, '--as', 'codex', '--json'], { cwd: dir, env });
    assert.equal(claimed.status, 0, claimed.stderr);

    const noted = runCli(['task', 'say', id, 'Use dry-run before cloud writes', '--as', 'codex', '--json'], { cwd: dir, env });
    assert.equal(noted.status, 0, noted.stderr);

    const ready = runCli(['task', 'ready', id, '--proof', 'dry-run sync proof', '--as', 'codex', '--json'], { cwd: dir, env });
    assert.equal(ready.status, 0, ready.stderr);

    const sync = runCli(['task', 'sync', '--dry-run', '--json'], { cwd: dir, env });
    assert.equal(sync.status, 0, sync.stderr);
    const payload = JSON.parse(sync.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.business_id, 'biz-task-sync');
    assert.equal(payload.planned_writes, 1);
    assert.equal(payload.plan[0].method, 'POST');
    assert.equal(payload.plan[0].endpoint, '/business/biz-task-sync/work/tasks');
    assert.equal(payload.plan[0].body.type, 'improvement');
    assert.equal(payload.plan[0].body.owner_member_id, 'agent:codex');
    assert.equal(payload.plan[0].body.metadata.source, 'atris_cli_task');
    assert.equal(payload.plan[0].body.metadata.local_task_id, id);
    assert.equal(payload.plan[0].body.metadata.approval_status, 'pending');
    assert.equal(payload.plan[0].body.metadata.swarlo.lease_owner, 'codex');
    assert.equal(payload.plan[0].body.metadata.swarlo.lease_state, 'none');
    assert.equal(payload.plan[0].body.needs_approval, true);
    assert.equal(payload.plan[0].after_create[0].body.state, 'doing');
    assert.match(payload.plan[0].body.description, /Use dry-run before cloud writes/);
    assert.match(payload.plan[0].body.description, /Proof: dry-run sync proof/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task projection exposes goals, review proof, and task lineage for visual boards', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'goals.md'), [
      '---',
      'type: goals',
      '---',
      '',
      '# Goals',
      '',
      '- Build the task factory into a compounding autonomous development surface',
      '- Connect tasks to Swarlo and Supabase',
      '',
    ].join('\n'), 'utf8');

    const created = runCli(['task', 'new', 'Improve task factory lineage view', '--tag', 'tasks', '--json'], { cwd: dir, env });
    assert.equal(created.status, 0, created.stderr);
    const id = JSON.parse(created.stdout).task_id;

    const unrelated = runCli(['task', 'new', 'Repair notarized Mac installer', '--tag', 'release', '--json'], { cwd: dir, env });
    assert.equal(unrelated.status, 0, unrelated.stderr);
    const unrelatedId = JSON.parse(unrelated.stdout).task_id;

    const genericLoop = runCli(['task', 'new', 'Loop tick: Validate local Claude /goal behavior', '--tag', 'agent', '--json'], { cwd: dir, env });
    assert.equal(genericLoop.status, 0, genericLoop.stderr);
    const genericLoopId = JSON.parse(genericLoop.stdout).task_id;

    const finished = runCli([
      'task', 'finish', id,
      '--proof', 'board shows lineage',
      '--lesson', 'Visual tasks need goal and proof context',
      '--next', 'Render lineage in Task Factory board',
      '--create-next',
      '--as', 'codex',
      '--json',
    ], { cwd: dir, env });
    assert.equal(finished.status, 0, finished.stderr);
    const donePayload = JSON.parse(finished.stdout);
    const nextId = donePayload.next_task_id;

    const exported = runCli(['task', 'export', '--json'], { cwd: dir, env });
    assert.equal(exported.status, 0, exported.stderr);
    const projection = JSON.parse(exported.stdout).projection;
    assert.equal(projection.goals.items[0], 'Build the task factory into a compounding autonomous development surface');
    assert.ok(projection.streams.some(stream => stream.objective === 'Build the task factory into a compounding autonomous development surface'));
    const parent = projection.tasks.find(t => t.id === id);
    const child = projection.tasks.find(t => t.id === nextId);
    const unrelatedTask = projection.tasks.find(t => t.id === unrelatedId);
    const genericLoopTask = projection.tasks.find(t => t.id === genericLoopId);
    assert.equal(parent.objective, 'Build the task factory into a compounding autonomous development surface');
    assert.equal(unrelatedTask.objective, null);
    assert.equal(genericLoopTask.objective, null);
    assert.equal(parent.review.summary, 'This is the accepted outcome: improve task factory lineage view is done and counted as real work.');
    assert.equal(parent.review.proof, 'board shows lineage');
    assert.equal(parent.review.lesson, 'Visual tasks need goal and proof context');
    assert.deepEqual(parent.lineage.child_task_ids, [nextId]);
    assert.equal(parent.lineage.next_task_suggestion, 'Render lineage in Task Factory board');
    assert.equal(child.lineage.parent_task_id, id);
    assert.equal(child.lineage.parent_title, 'Improve task factory lineage view');
    const stream = projection.streams.find(s => s.objective === parent.objective);
    assert.equal(stream.done_count, 1);
    assert.equal(stream.active_count, 1);
    assert.ok(stream.tasks.some(t => t.id === nextId && t.parent_task_id === id));
  } finally {
    cleanupTempDir(dir);
  }
});

test('TODO fallback parser handles nested groups and modern task ids', () => {
  const dir = makeTempDir();
  try {
    const todoPath = path.join(dir, 'TODO.md');
    fs.writeFileSync(todoPath, [
      '# TODO.md',
      '',
      '## Backlog',
      '',
      '### UX',
      '- [ ] **Fast idea dump** — capture rough thoughts before running agents.',
      '- **windows-public-release-T1:** Publish signed Windows installer [agent] [execute]',
      '  **Verify:** npm run release:gate:win',
      '',
      '## In Progress',
      '',
      '- **prod-first-install-hotfix-T1:** Fix first-install failures [agent] [execute]',
      '  **Claimed by:** Codex at 2026-05-02T12:34:00Z',
      '  **Verify:** npm run update:smoke',
      '',
      '## Completed',
      '',
    ].join('\n'), 'utf8');

    const { parseTodoFile } = require('../lib/todo-fallback');
    const parsed = parseTodoFile(todoPath);
    assert.equal(parsed.backlog.length, 2);
    assert.equal(parsed.backlog[0].title, 'Fast idea dump — capture rough thoughts before running agents.');
    assert.equal(parsed.backlog[1].id, 'windows-public-release-T1');
    assert.equal(parsed.backlog[1].verify, 'npm run release:gate:win');
    assert.equal(parsed.inProgress[0].id, 'prod-first-install-hotfix-T1');
    assert.equal(parsed.inProgress[0].claimed, 'Codex at 2026-05-02T12:34:00Z');
    assert.equal(parsed.inProgress[0].verify, 'npm run update:smoke');
  } finally {
    cleanupTempDir(dir);
  }
});

test('task import preserves Verify metadata through DB-backed TODO shim', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    const atrisDir = path.join(dir, 'atris');
    fs.mkdirSync(atrisDir, { recursive: true });
    const todoPath = path.join(atrisDir, 'TODO.md');
    fs.writeFileSync(todoPath, [
      '# TODO.md',
      '',
      '## Backlog',
      '',
      '- **T1:** Task plane import keeps proof [endgame] [execute]',
      '  **Verify:** test -f done.txt',
      '',
      '## In Progress',
      '',
      '- **T2:** Claimed task keeps section [execute]',
      '  **Claimed by:** codex at 2026-04-28T07:29:42Z',
      '  **Verify:** test -f claimed.txt',
      '',
      '## Completed',
      '',
    ].join('\n'), 'utf8');

    const imported = runCli(['task', 'import', 'atris/TODO.md'], { cwd: dir, env });
    assert.equal(imported.status, 0, imported.stderr);
    assert.match(imported.stdout, /imported 2 new, skipped 0/);

    const script = [
      "const { parseTodo } = require('./lib/todo');",
      "const { getVerifyCommand } = require('./commands/autopilot');",
      `const todo = parseTodo(${JSON.stringify(todoPath)});`,
      `const verify = getVerifyCommand(${JSON.stringify(dir)}, 'Task plane import keeps proof');`,
      "console.log(JSON.stringify({ todo, verify }));",
    ].join('\n');
    const parsed = spawnSync(process.execPath, ['-e', script], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 15000,
      env: {
        ...process.env,
        ATRIS_TASK_DB: '1',
        ATRIS_TASKS_DB: dbPath,
        NODE_NO_WARNINGS: '1',
      },
    });
    assert.equal(parsed.status, 0, parsed.stderr);
    const out = JSON.parse(parsed.stdout);
    assert.equal(out.todo.backlog[0].verify, 'test -f done.txt');
    assert.equal(out.todo.inProgress[0].verify, 'test -f claimed.txt');
    assert.equal(out.todo.inProgress[0].claimed, 'codex at 2026-04-28T07:29:42Z');
    assert.deepEqual(out.verify, { cmd: 'test -f done.txt', explicit: true });
  } finally {
    cleanupTempDir(dir);
  }
});

// ============================================
// search
// ============================================

test('search with no keyword prints usage', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    const res = runCli(['search'], { cwd: dir });
    assert.equal(res.status, 1);
    assert.match(res.stdout, /Usage: atris search/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('search help flags print usage without workspace state', () => {
  const dir = makeTempDir();
  try {
    const home = path.join(dir, 'home');
    for (const flag of ['--help', '-h']) {
      const res = runCli(['search', flag], { cwd: dir, env: { HOME: home } });
      assert.equal(res.status, 0, `search ${flag}: ${res.stderr || res.stdout}`);
      assert.match(res.stdout, /Usage: atris search <keyword>/);
      assert.doesNotMatch(res.stdout, /No atris\/logs\/ directory found/);
      assert.equal(fs.existsSync(path.join(dir, 'atris')), false, `search ${flag} created atris/`);
      assert.equal(fs.existsSync(path.join(home, '.atris')), false, `search ${flag} created ~/.atris`);
    }
  } finally {
    cleanupTempDir(dir);
  }
});

test('learn help prints usage without workspace state', () => {
  const dir = makeTempDir();
  try {
    const home = path.join(dir, 'home');
    for (const helpArg of ['--help', '-h', 'help']) {
      const res = runCli(['learn', helpArg], { cwd: dir, env: { HOME: home } });
      assert.equal(res.status, 0, `learn ${helpArg}: ${res.stderr || res.stdout}`);
      assert.match(res.stdout, /Usage: atris learn \[command\]/);
      assert.doesNotMatch(res.stderr, /atris\/ folder not found/);
      assert.equal(fs.existsSync(path.join(dir, 'atris')), false, `learn ${helpArg} created atris/`);
      assert.equal(fs.existsSync(path.join(home, '.atris')), false, `learn ${helpArg} created ~/.atris`);
    }
  } finally {
    cleanupTempDir(dir);
  }
});

test('soul help prints usage without workspace state', () => {
  const dir = makeTempDir();
  try {
    const home = path.join(dir, 'home');
    for (const helpArg of ['--help', '-h', 'help']) {
      const res = runCli(['soul', helpArg], { cwd: dir, env: { HOME: home } });
      assert.equal(res.status, 0, `soul ${helpArg}: ${res.stderr || res.stdout}`);
      assert.match(res.stdout, /atris soul/);
      assert.doesNotMatch(res.stderr, /No atris\/ folder found/);
      assert.equal(fs.existsSync(path.join(dir, 'atris')), false, `soul ${helpArg} created atris/`);
      assert.equal(fs.existsSync(path.join(home, '.atris')), false, `soul ${helpArg} created ~/.atris`);
    }
  } finally {
    cleanupTempDir(dir);
  }
});

test('workspace-free help smoke sweep covers common entrypoints', () => {
  const cases = [
    ['--help'],
    ['status', '--help'],
    ['analytics', '--help'],
    ['brain', '--help'],
    ['brain', '-h'],
    ['brainstorm', '--help'],
    ['brainstorm', '-h'],
    ['brainstorm', 'help'],
    ['search', '--help'],
    ['search', '-h'],
    ['learn', '--help'],
    ['learn', '-h'],
    ['learn', 'help'],
    ['soul', '--help'],
    ['soul', '-h'],
    ['soul', 'help'],
    ['activate', '--help'],
    ['next', '--help'],
    ['now', '--help'],
    ['clean', '--help'],
    ['verify', '--help'],
    ['loop', '--help'],
    ['serve', '--help'],
    ['agent', '--help'],
    ['update', '--help'],
    ['sync', '--help'],
    ['upgrade', '--help'],
    ['release', '--help'],
    ['login', '--help'],
    ['logout', '--help'],
    ['whoami', '--help'],
    ['switch', '--help'],
    ['use', '--help'],
    ['accounts', '--help'],
    ['integrations', '--help'],
    ['skill', '--help'],
    ['member', '--help'],
    ['plugin', '--help'],
    ['experiments', '--help'],
    ['receipt', '--help'],
    ['proof', '--help'],
    ['play', '--help'],
    ['code-review', '--help'],
    ['cr', '--help'],
  ];

  for (const args of cases) {
    const dir = makeTempDir();
    try {
      const home = path.join(dir, 'home');
      const res = runCli(args, { cwd: dir, env: { HOME: home } });
      const label = args.join(' ');
      assert.equal(res.status, 0, `${label}: ${res.stderr || res.stdout}`);
      assert.ok((res.stdout + res.stderr).trim().length > 0, `${label} printed no help`);
      assert.doesNotMatch(res.stdout + res.stderr, /folder not found|Run "atris init"|Not logged in|Checking for updates|Current Status|Atris Analytics|CONTEXT LOADED|Wiki Loop/);
      assert.equal(fs.existsSync(path.join(dir, 'atris')), false, `${label} created atris/`);
      assert.equal(fs.existsSync(path.join(home, '.atris')), false, `${label} created ~/.atris`);
    } finally {
      cleanupTempDir(dir);
    }
  }
});

test('init scaffolds atris/wiki/briefs instead of syntheses', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'wiki', 'briefs')));
    assert.equal(fs.existsSync(path.join(dir, 'atris', 'wiki', 'syntheses')), false);
    const agents = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
    assert.match(agents, /Atris is the source of truth/);
    assert.match(agents, /AGENTS\.md`; do not turn it into a parallel brain/);
    assert.match(agents, /`atris\/atris\.md` \| Protocol\/backbone/);
    assert.match(agents, /`atris task ready <id> --proof/);
    assert.match(agents, /Human accept\s+-> task Done \+ AgentXP awarded/);
    assert.doesNotMatch(agents, /task finish <id> --proof/);
    const claudeCommand = fs.readFileSync(path.join(dir, '.claude', 'commands', 'atris.md'), 'utf8');
    assert.match(claudeCommand, /atris\/atris\.md/);
    assert.match(claudeCommand, /AGENTS\.md is only a tool adapter/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('init scaffolds Devin permission for Atris command access', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    const configPath = path.join(dir, '.devin', 'config.local.json');
    assert.ok(fs.existsSync(configPath));
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.deepEqual(config.permissions.allow, ['Exec(atris)']);
  } finally {
    cleanupTempDir(dir);
  }
});

test('agent doctor verifies local AI CLI wiring without auth', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    const res = runCli(['agent', 'doctor', '--json'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.action, 'agent_doctor');
    assert.equal(payload.ok, true);
    assert.deepEqual(
      payload.checks.map((check) => [check.id, check.ok]),
      [
        ['atris-core', true],
        ['codex', true],
        ['claude', true],
        ['cursor', true],
        ['devin', true],
      ]
    );
    assert.ok(payload.binaries.some((binary) => binary.name === 'devin'));
  } finally {
    cleanupTempDir(dir);
  }
});

test('business slug matcher accepts config aliases', () => {
  const business = {
    slug: 'atris-labs',
    name: 'Atris Labs',
    config: { aliases: ['atris'] },
  };

  assert.equal(businessMatchesSlug(business, 'atris-labs'), true);
  assert.equal(businessMatchesSlug(business, 'atris'), true);
  assert.equal(businessMatchesSlug(business, 'Atris Labs'), false);
  assert.equal(businessMatchesSlug(business, 'Atris Labs', { includeName: true }), true);
});

test('business doctor plans safe cache repoints for stale duplicate rows', () => {
  const active = {
    id: 'active-example',
    slug: 'example-recruiting',
    name: 'example-recruiting',
    workspace_id: 'active-workspace',
    config: {},
  };
  const analysis = analyzeBusinessDoctor({
    cloudBusinesses: [active],
    cache: {
      'example-recruiting': {
        business_id: 'deleted-duplicate',
        workspace_id: 'deleted-workspace',
        name: 'example-recruiting',
        slug: 'example-recruiting-1',
      },
    },
    folderBindings: [],
  });

  assert.ok(analysis.issues.some((issue) => issue.code === 'stale-cache-repoint'));
  assert.equal(analysis.cacheUpdates['example-recruiting'].business_id, 'active-example');
  assert.equal(analysis.cacheUpdates['example-recruiting'].workspace_id, 'active-workspace');
  assert.equal(analysis.cacheUpdates['example-recruiting'].slug, 'example-recruiting');
});

test('business doctor accepts clean alias folders and asks for missing alias cache', () => {
  const atrisLabs = {
    id: 'biz-atris-labs',
    slug: 'atris-labs',
    name: 'Atris Labs',
    workspace_id: 'workspace-atris-labs',
    config: { aliases: ['atris'] },
  };
  const analysis = analyzeBusinessDoctor({
    cloudBusinesses: [atrisLabs],
    cache: {
      'atris-labs': {
        business_id: 'biz-atris-labs',
        workspace_id: 'workspace-atris-labs',
        name: 'Atris Labs',
        slug: 'atris-labs',
      },
    },
    folderBindings: [{
      name: 'atris',
      isSymlink: false,
      hasAtris: true,
      hasBusinessJson: true,
      meta: {
        business_id: 'biz-atris-labs',
        workspace_id: 'workspace-atris-labs',
        name: 'Atris Labs',
        slug: 'atris',
        canonical_slug: 'atris-labs',
      },
    }],
  });

  assert.equal(analysis.issues.some((issue) => issue.code === 'folder-name-not-slug-or-alias'), false);
  assert.equal(analysis.issues.some((issue) => issue.code === 'folder-slug-mismatch'), false);
  assert.equal(analysis.cacheUpdates.atris.business_id, 'biz-atris-labs');
  assert.equal(analysis.cacheUpdates.atris.canonical_slug, 'atris-labs');
});

test('ensureWikiScaffold migrates legacy syntheses pages into briefs', () => {
  const dir = makeTempDir();
  try {
    const wikiDir = path.join(dir, 'atris', 'wiki');
    const legacyDir = path.join(wikiDir, 'syntheses');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(
      path.join(wikiDir, 'index.md'),
      '# Atris Wiki Index\n\n## Syntheses\n\n- [[atris/wiki/syntheses/example.md]]\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(legacyDir, 'example.md'),
      '---\ntype: synthesis\nslug: example\ntitle: Example\n---\n# Example\n',
      'utf8'
    );

    ensureWikiScaffold(dir);

    const briefsPath = path.join(wikiDir, 'briefs', 'example.md');
    assert.ok(fs.existsSync(briefsPath));
    assert.equal(fs.existsSync(legacyDir), false);
    assert.match(fs.readFileSync(path.join(wikiDir, 'index.md'), 'utf8'), /## Briefs/);
    assert.doesNotMatch(fs.readFileSync(path.join(wikiDir, 'index.md'), 'utf8'), /syntheses/);
    assert.match(fs.readFileSync(briefsPath, 'utf8'), /^type: brief$/m);
  } finally {
    cleanupTempDir(dir);
  }
});

test('search with no atris/logs prints error', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['search', 'auth'], { cwd: dir });
    assert.equal(res.status, 1);
    assert.match(res.stdout, /atris init/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('search finds matches in journal files', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    writeTodayLog(dir, '# Log\n\n## Inbox\n\n- **I1:** Fix the auth module\n');
    const res = runCli(['search', 'auth'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Found 1 match/);
    assert.match(res.stdout, /auth/i);
  } finally {
    cleanupTempDir(dir);
  }
});

test('search is case-insensitive', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    writeTodayLog(dir, '# Log\n\n## Notes\n\nDebugged the AUTH flow\n');
    const res = runCli(['search', 'auth'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Found 1 match/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('search with no matches prints no matches', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    writeTodayLog(dir, '# Log\n\n## Notes\n\nNothing relevant here\n');
    const res = runCli(['search', 'xyznonexistent'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /No matches found/);
  } finally {
    cleanupTempDir(dir);
  }
});

// ============================================
// analytics
// ============================================

test('analytics exits 1 when no atris/ folder', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['analytics'], { cwd: dir });
    assert.equal(res.status, 1);
    assert.match(res.stdout, /atris init/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('analytics shows zero completions on fresh workspace', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    const res = runCli(['analytics'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Total completions:\s+0/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('analytics counts completions in journal', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    writeTodayLog(dir, '# Log\n\n## Completed ✅\n\n- **C1: Shipped auth**\n- **C2: Fixed bug**\n\n## Inbox\n\n');
    const res = runCli(['analytics'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    // Today should show 2 completions
    assert.match(res.stdout, /2/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('analytics counts inbox items when Inbox is last section', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    // Inbox at the end with no ## or --- after it (regression test)
    writeTodayLog(dir, '# Log\n\n## Completed ✅\n\n---\n\n## Inbox\n\n- **I1:** Fix auth\n- **I2:** Add tests\n');
    const res = runCli(['analytics'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Inbox items:\s+2/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('getRecentSignals returns empty commit/wiki/lesson signals when sources are missing', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    fs.rmSync(path.join(dir, 'atris', 'wiki', 'STATUS.md'), { force: true });
    fs.rmSync(path.join(dir, 'atris', 'lessons.md'), { force: true });

    const signals = getRecentSignals(dir);
    assert.deepEqual(signals.recentCommits, []);
    assert.equal(signals.wikiHealth, null);
    assert.deepEqual(signals.recentLessons, []);
  } finally {
    cleanupTempDir(dir);
  }
});

test('getRecentSignals reads recent git commits, wiki health, and last 10 lesson lines', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);

    const initResult = runGit(['init'], dir);
    assert.equal(initResult.status, 0, initResult.stderr);
    assert.equal(runGit(['config', 'user.name', 'Test User'], dir).status, 0);
    assert.equal(runGit(['config', 'user.email', 'test@example.com'], dir).status, 0);
    assert.equal(runGit(['add', '.'], dir).status, 0);
    const commitResult = runGit(['commit', '-m', 'seed workspace'], dir);
    assert.equal(commitResult.status, 0, commitResult.stderr);

    const statusPath = path.join(dir, 'atris', 'wiki', 'STATUS.md');
    fs.writeFileSync(statusPath, '# STATUS\n\nHealth: 3/5\nNext move: tighten loop\n', 'utf8');

    const lessonsPath = path.join(dir, 'atris', 'lessons.md');
    const lessonLines = Array.from({ length: 12 }, (_, i) => `- lesson ${i + 1}`);
    fs.writeFileSync(lessonsPath, `${lessonLines.join('\n')}\n`, 'utf8');

    const signals = getRecentSignals(dir);
    assert.equal(signals.recentCommits.length, 1);
    assert.match(signals.recentCommits[0], /seed workspace/);
    assert.match(signals.wikiHealth, /Health: 3\/5/);
    assert.equal(signals.recentLessons.length, 10);
    assert.deepEqual(signals.recentLessons, lessonLines.slice(-10));
  } finally {
    cleanupTempDir(dir);
  }
});

test('renderHumanTickIntro keeps the default autopilot briefing plain and narrow', () => {
  const text = renderHumanTickIntro({
    time: '11:20 a.m.',
    identity: 'Ship one clean step at a time.',
    slug: 'loop-self-seeds-horizons',
    horizon: 'Teach the loop to imagine the next horizon when the queue goes quiet.',
    total: 5,
    done: 2
  }, {
    auto: true,
    durationLabel: 'until clean'
  });

  assert.match(text, /I am starting an autopilot tick in autonomous mode\./);
  assert.match(text, /Progress is 2 of 5 endgame steps\./);
  assert.doesNotMatch(text, /[┌┐└┘│]/);
  for (const line of text.split('\n')) {
    assert.ok(line.length <= 80, `line too wide: ${line.length} "${line}"`);
  }
});

test('renderHumanSuggestion keeps the default suggestion briefing plain and narrow', () => {
  const text = renderHumanSuggestion({
    task: 'Rewrite the autopilot tick output to match the chief-of-staff format.',
    why: 'The current box-heavy output makes it hard for a non-technical reader to decide whether to let the loop continue.',
    kind: 'execute'
  }, 1, 4);

  assert.match(text, /I picked task 1 of 4\./);
  assert.match(text, /Next: approve it, skip it, or stop the loop\./);
  assert.doesNotMatch(text, /[┌┐└┘│]/);
  for (const line of text.split('\n')) {
    assert.ok(line.length <= 80, `line too wide: ${line.length} "${line}"`);
  }
});

// ============================================
// visualize
// ============================================

test('visualize exits 1 when no journal exists', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    // Remove any auto-created log
    const logsDir = path.join(dir, 'atris', 'logs');
    if (fs.existsSync(logsDir)) {
      fs.rmSync(logsDir, { recursive: true, force: true });
      fs.mkdirSync(logsDir, { recursive: true });
    }
    const res = runCli(['visualize'], { cwd: dir });
    assert.equal(res.status, 1);
    assert.match(res.stdout, /atris log/i);
  } finally {
    cleanupTempDir(dir);
  }
});

test('visualize exits 1 when inbox is empty', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    writeTodayLog(dir, '# Log\n\n## Inbox\n\n\n## Notes\n\n');
    const res = runCli(['visualize'], { cwd: dir });
    assert.equal(res.status, 1);
    assert.match(res.stdout, /Inbox|inbox/i);
  } finally {
    cleanupTempDir(dir);
  }
});

test('visualize renders breakdown for inbox items', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    writeTodayLog(dir, '# Log\n\n## Inbox\n\n- **I1:** Build the dashboard\n\n## Notes\n\n');
    const res = runCli(['visualize'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Build the dashboard/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('visualize dry-run accepts any prompt without requiring inbox', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    const res = runCli(['visualize', 'show the connect-api workflow for onboarding', '--dry-run'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Atris Visualize dry run/);
    assert.match(res.stdout, /gpt-image-2/);
    assert.match(res.stdout, /connect-api workflow/);
    assert.match(res.stdout, /Artifact type: workflow/);
    assert.match(res.stdout, /atris\/reports\/visuals/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('visualize dry-run supports custom output and raw prompt', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    const res = runCli([
      'visualize',
      'exact raw diagram prompt',
      '--dry-run',
      '--raw',
      '--out',
      'custom/path.png',
    ], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /custom\/path\.png/);
    assert.match(res.stdout, /exact raw diagram prompt/);
    assert.doesNotMatch(res.stdout, /Workspace context to respect/);
  } finally {
    cleanupTempDir(dir);
  }
});

// ============================================
// clean
// ============================================

test('clean exits 1 when no atris/ folder', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['clean'], { cwd: dir });
    assert.equal(res.status, 1);
    assert.match(res.stdout, /atris init/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('clean --help prints usage without touching workspace', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['clean', '--help'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Usage: atris clean/);
    assert.match(res.stdout, /--dry-run/);
    assert.doesNotMatch(res.stdout, /Atris Clean/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('clean reports clean workspace on fresh init', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    const res = runCli(['clean'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    // Should complete without crashing
    assert.match(res.stdout, /clean|stale|target/i);
  } finally {
    cleanupTempDir(dir);
  }
});

// ============================================
// verify
// ============================================

test('verify exits 1 when no atris/ folder', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['verify'], { cwd: dir });
    assert.equal(res.status, 1);
    assert.match(res.stdout, /atris init/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('verify detects placeholder MAP.md', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    // init creates a placeholder MAP.md
    const res = runCli(['verify'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    // Should mention MAP issues since it's a placeholder
    assert.match(res.stdout, /MAP\.md/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('verify passes with populated MAP.md', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    // Write a MAP.md with enough file refs (verify regex: `filename.ext` with known extensions)
    const mapContent = [
      '# MAP.md', '',
      '## By-Feature',
      '- auth: `bin/atris.js` line 1',
      '- init: `commands/init.js` line 10',
      '- sync: `commands/sync.js` line 20',
      '- status: `commands/status.js` line 30',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'atris', 'MAP.md'), mapContent, 'utf8');
    const res = runCli(['verify'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /MAP\.md.*Valid/i);
  } finally {
    cleanupTempDir(dir);
  }
});

// ============================================
// sync alias
// ============================================

test('sync command works as alias for update', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    const res = runCli(['sync'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /up to date|Updated/i);
  } finally {
    cleanupTempDir(dir);
  }
});

test('update and sync --help print usage without touching workspace', () => {
  const dir = makeTempDir();
  try {
    for (const command of ['update', 'sync']) {
      const res = runCli([command, '--help'], { cwd: dir });
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.stdout, new RegExp(`Usage: atris ${command}`));
      assert.match(res.stdout, /--dry-run/);
      assert.doesNotMatch(res.stdout, /Updating|Local workspace updated|up to date/i);
    }
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
    assert.equal(fs.existsSync(path.join(dir, '.atris')), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('upgrade --help prints usage without npm update checks', () => {
  const dir = makeTempDir();
  try {
    const home = path.join(dir, 'home');
    const res = runCli(['upgrade', '--help'], { cwd: dir, env: { HOME: home } });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Usage: atris upgrade/);
    assert.doesNotMatch(res.stdout, /Checking for updates|Installing update|npm update -g atris/);
    assert.equal(fs.existsSync(path.join(home, '.atris')), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('now --help prints usage without update-check side effects', () => {
  const dir = makeTempDir();
  try {
    const home = path.join(dir, 'home');
    const res = runCli(['now', '--help'], { cwd: dir, env: { HOME: home } });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Usage: atris now/);
    assert.doesNotMatch(res.stdout, /Current operating truth|Created atris\/now\.md/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
    assert.equal(fs.existsSync(path.join(home, '.atris')), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('help invocations skip background update-check cache writes', () => {
  const dir = makeTempDir();
  try {
    const commands = [
      ['skill', '--help'],
      ['member', '--help'],
      ['plugin', '--help'],
      ['experiments', '--help'],
      ['receipt', '--help'],
      ['code-review', '--help'],
    ];

    for (const args of commands) {
      const home = path.join(dir, `home-${args[0]}`);
      const res = runCli(args, { cwd: dir, env: { HOME: home } });
      assert.equal(res.status, 0, `${args.join(' ')}: ${res.stderr || res.stdout}`);
      assert.equal(fs.existsSync(path.join(home, '.atris')), false, `${args.join(' ')} created ~/.atris`);
    }
  } finally {
    cleanupTempDir(dir);
  }
});

test('status and analytics --help print usage without workspace state', () => {
  const dir = makeTempDir();
  try {
    const home = path.join(dir, 'home');
    for (const command of ['status', 'analytics']) {
      const res = runCli([command, '--help'], { cwd: dir, env: { HOME: home } });
      assert.equal(res.status, 0, `${command}: ${res.stderr || res.stdout}`);
      assert.match(res.stdout, new RegExp(`Usage: atris ${command}`));
      assert.doesNotMatch(res.stdout, /atris\/ folder not found|Atris Analytics|Current Status/);
      assert.equal(fs.existsSync(path.join(dir, 'atris')), false, `${command} created atris/`);
      assert.equal(fs.existsSync(path.join(home, '.atris')), false, `${command} created ~/.atris`);
    }
  } finally {
    cleanupTempDir(dir);
  }
});

test('brain --help prints usage without workspace state', () => {
  const dir = makeTempDir();
  try {
    const home = path.join(dir, 'home');
    for (const flag of ['--help', '-h']) {
      const res = runCli(['brain', flag], { cwd: dir, env: { HOME: home } });
      assert.equal(res.status, 0, `brain ${flag}: ${res.stderr || res.stdout}`);
      assert.match(res.stdout, /Usage: atris brain compile/);
      assert.doesNotMatch(res.stderr, /atris\/ folder not found/);
      assert.equal(fs.existsSync(path.join(dir, 'atris')), false, `brain ${flag} created atris/`);
      assert.equal(fs.existsSync(path.join(home, '.atris')), false, `brain ${flag} created ~/.atris`);
    }
  } finally {
    cleanupTempDir(dir);
  }
});

test('brainstorm help prints usage without workspace state', () => {
  const dir = makeTempDir();
  try {
    const home = path.join(dir, 'home');
    for (const helpArg of ['--help', '-h', 'help']) {
      const res = runCli(['brainstorm', helpArg], { cwd: dir, env: { HOME: home } });
      assert.equal(res.status, 0, `brainstorm ${helpArg}: ${res.stderr || res.stdout}`);
      assert.match(res.stdout, /Usage: atris brainstorm/);
      assert.doesNotMatch(res.stderr, /atris\/ folder not found/);
      assert.equal(fs.existsSync(path.join(dir, 'atris')), false, `brainstorm ${helpArg} created atris/`);
      assert.equal(fs.existsSync(path.join(home, '.atris')), false, `brainstorm ${helpArg} created ~/.atris`);
    }
  } finally {
    cleanupTempDir(dir);
  }
});

test('auth --help prints usage without auth side effects', () => {
  const dir = makeTempDir();
  try {
    const home = path.join(dir, 'home');
    for (const command of ['login', 'whoami']) {
      const res = runCli([command, '--help'], { cwd: dir, env: { HOME: home } });
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.stdout, new RegExp(`Usage: atris ${command}`));
      assert.doesNotMatch(res.stdout, /Choose login method|Status: Not logged in|Run "atris login"/);
      assert.equal(fs.existsSync(path.join(home, '.atris')), false);
    }

    fs.mkdirSync(path.join(home, '.atris'), { recursive: true });
    const credentialsPath = path.join(home, '.atris', 'credentials.json');
    fs.writeFileSync(credentialsPath, JSON.stringify({
      token: 'fake',
      email: 'fake@example.com',
      provider: 'manual',
    }, null, 2), 'utf8');
    const before = fs.readFileSync(credentialsPath, 'utf8');
    const logout = runCli(['logout', '--help'], { cwd: dir, env: { HOME: home } });
    assert.equal(logout.status, 0, logout.stderr);
    assert.match(logout.stdout, /Usage: atris logout/);
    assert.doesNotMatch(logout.stdout, /Signed out/);
    assert.equal(fs.readFileSync(credentialsPath, 'utf8'), before);
  } finally {
    cleanupTempDir(dir);
  }
});

test('account and integrations --help print usage without session side effects', () => {
  const dir = makeTempDir();
  try {
    const home = path.join(dir, 'home');
    for (const command of ['switch', 'use', 'accounts', 'integrations']) {
      const res = runCli([command, '--help'], { cwd: dir, env: { HOME: home } });
      assert.equal(res.status, 0, `${command}: ${res.stderr || res.stdout}`);
      assert.match(res.stdout, new RegExp(`Usage: atris ${command}`));
      assert.doesNotMatch(res.stdout, /No saved accounts|Not signed in|Set per-terminal account|Integration Status/);
      assert.doesNotMatch(res.stderr, /Not logged in|Run: atris login/);
      assert.equal(fs.existsSync(path.join(home, '.atris')), false, `${command} created ~/.atris`);
    }
  } finally {
    cleanupTempDir(dir);
  }
});

test('setup --help prints usage without entering setup flow', () => {
  const dir = makeTempDir();
  try {
    const home = path.join(dir, 'home');
    const res = runCli(['setup', '--help'], { cwd: dir, env: { HOME: home } });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Usage: atris setup/);
    assert.doesNotMatch(res.stdout, /Atris Setup|Starting login|Choose login method/);
    assert.equal(fs.existsSync(path.join(home, '.atris')), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('activate and next --help print usage without loading workflow context', () => {
  const dir = makeTempDir();
  try {
    const home = path.join(dir, 'home');
    for (const command of ['activate', 'next']) {
      const res = runCli([command, '--help'], { cwd: dir, env: { HOME: home } });
      assert.equal(res.status, 0, `${command}: ${res.stderr || res.stdout}`);
      assert.match(res.stdout, new RegExp(`Usage: atris ${command}`));
      assert.doesNotMatch(res.stdout, /CONTEXT LOADED|Context Loaded|Atris Activate|Atris Plan|Completed \(preview\)/);
      assert.equal(fs.existsSync(path.join(dir, 'atris')), false, `${command} created atris/`);
      assert.equal(fs.existsSync(path.join(home, '.atris')), false, `${command} created ~/.atris`);
    }
  } finally {
    cleanupTempDir(dir);
  }
});

test('serve --help prints usage instead of entering planner or bridge', () => {
  const dir = makeTempDir();
  try {
    const home = path.join(dir, 'home');
    const res = runCli(['serve', '--help'], { cwd: dir, env: { HOME: home } });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Usage: atris serve/);
    assert.doesNotMatch(res.stdout, /CONTEXT LOADED|Atris Plan|Local AI Computer Bridge|Not logged in/);
    assert.equal(fs.existsSync(path.join(home, '.atris')), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('loop --help prints usage without running wiki loop', () => {
  const dir = makeTempDir();
  try {
    const home = path.join(dir, 'home');
    const res = runCli(['loop', '--help'], { cwd: dir, env: { HOME: home } });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Usage: atris loop/);
    assert.match(res.stdout, /--dry-run/);
    assert.doesNotMatch(res.stdout, /Wiki Loop|Pages:|Health: wiki/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
    assert.equal(fs.existsSync(path.join(home, '.atris')), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('verify --help prints usage without running verifier', () => {
  const dir = makeTempDir();
  try {
    const home = path.join(dir, 'home');
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), '# TODO.md\n\n## Completed\n- **[HELP-1]** verify help sentinel\n', 'utf8');
    const res = runCli(['verify', '--help'], { cwd: dir, env: { HOME: home } });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Usage: atris verify/);
    assert.match(res.stdout, /--section <name>/);
    assert.doesNotMatch(res.stdout, /Atris Verify|Verifying:|Verifying workspace|Tests:/);
    assert.equal(fs.existsSync(path.join(home, '.atris')), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('release --help prints usage without changing package metadata', () => {
  const dir = makeTempDir();
  try {
    const pkgPath = path.join(dir, 'package.json');
    fs.writeFileSync(pkgPath, JSON.stringify({ name: 'demo-release', version: '1.2.3' }, null, 2), 'utf8');
    const before = fs.readFileSync(pkgPath, 'utf8');
    const res = runCli(['release', '--help'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Usage: atris release/);
    assert.match(res.stdout, /--dry-run/);
    assert.doesNotMatch(res.stdout, /commits since|bump type|bumped package/);
    assert.equal(fs.readFileSync(pkgPath, 'utf8'), before);
  } finally {
    cleanupTempDir(dir);
  }
});

test('createCanonicalBusinessWorkspace writes business metadata and canonical atris scaffold into an existing folder', () => {
  const dir = makeTempDir();
  try {
    fs.writeFileSync(path.join(dir, 'BLONDISH_NOTES.md'), '# raw notes\n', 'utf8');

    const result = createCanonicalBusinessWorkspace(dir, {
      business_id: 'biz-123',
      workspace_id: 'ws-456',
      name: 'BLOND:ISH',
      slug: 'blondish',
      owner_email: 'joel@blondish.world',
    }, { here: true });

    assert.equal(result.targetRoot, dir);
    assert.ok(fs.existsSync(path.join(dir, 'BLONDISH_NOTES.md')));
    assert.ok(fs.existsSync(path.join(dir, '.atris', 'business.json')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'MAP.md')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'TODO.md')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'goals.md')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'PERSONA.md')));
    assert.ok(fs.readdirSync(path.join(dir, 'atris')).includes('PERSONA.md'));
    assert.equal(fs.readdirSync(path.join(dir, 'atris')).includes('persona.md'), false);
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'policies', 'REWARD.md')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'context', 'live-workspace.md')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'wiki', 'STATUS.md')));
    assert.ok(fs.existsSync(path.join(dir, '.atris', 'state', '_sync.json')));
    assert.ok(fs.existsSync(path.join(dir, '.atris', 'state', 'events.jsonl')));
    assert.ok(fs.existsSync(path.join(dir, '.atris', 'state', 'episodes.jsonl')));
    assert.ok(fs.existsSync(path.join(dir, '.atris', 'state', 'scorecards.jsonl')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'reports', 'operating-recap-template.md')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'wiki', 'concepts', 'first-loop-template.md')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'team', '_template', 'MEMBER.md')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'team', 'operator', 'MEMBER.md')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'team', 'validator', 'MEMBER.md')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'team', 'ops', 'MEMBER.md')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'team', 'comms', 'MEMBER.md')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'team', 'research', 'MEMBER.md')));

    const meta = JSON.parse(fs.readFileSync(path.join(dir, '.atris', 'business.json'), 'utf8'));
    assert.equal(meta.slug, 'blondish');
    assert.equal(meta.business_id, 'biz-123');
    assert.equal(meta.workspace_id, 'ws-456');
    assert.equal(meta.workspace_template, 'business');
    assert.equal(meta.owner_email, 'joel@blondish.world');

    const syncMeta = JSON.parse(fs.readFileSync(path.join(dir, '.atris', 'state', '_sync.json'), 'utf8'));
    assert.equal(syncMeta.workspace_slug, 'blondish');
    assert.equal(syncMeta.business_id, 'biz-123');
    assert.equal(syncMeta.workspace_id, 'ws-456');
    assert.equal(syncMeta.workspace_template, 'business');

    const map = fs.readFileSync(path.join(dir, 'atris', 'MAP.md'), 'utf8');
    assert.match(map, /BLOND:ISH/);
    assert.match(map, /\.atris\/state\/events\.jsonl/);

    const persona = fs.readFileSync(path.join(dir, 'atris', 'PERSONA.md'), 'utf8');
    assert.match(persona, /BLOND:ISH/);

    const reward = fs.readFileSync(path.join(dir, 'atris', 'policies', 'REWARD.md'), 'utf8');
    assert.match(reward, /Reward what makes the operator faster/i);
    assert.match(reward, /events\.jsonl/);

    const liveWorkspace = fs.readFileSync(path.join(dir, 'atris', 'context', 'live-workspace.md'), 'utf8');
    assert.match(liveWorkspace, /biz-123/);
    assert.match(liveWorkspace, /ws-456/);
    assert.match(liveWorkspace, /Structured State/);

    const todo = fs.readFileSync(path.join(dir, 'atris', 'TODO.md'), 'utf8');
    assert.match(todo, /## Endgame/);
    assert.match(todo, /\*\*B1:\*\*/);
    assert.match(todo, /\[endgame\]/);
    assert.match(todo, /\*\*Verify:\*\*/);
    assert.match(todo, /first measurable loop/i);
    assert.match(todo, /named human/i);
    assert.match(todo, /structured state entries/i);

    const teamReadme = fs.readFileSync(path.join(dir, 'atris', 'team', 'README.md'), 'utf8');
    assert.match(teamReadme, /real humans/i);
  } finally {
    cleanupTempDir(dir);
  }
});

test('createCanonicalBusinessWorkspace can scaffold a research lab template', () => {
  const dir = makeTempDir();
  try {
    const result = createCanonicalBusinessWorkspace(dir, {
      business_id: 'biz-r1',
      workspace_id: 'ws-r2',
      name: 'Frontier Lab',
      slug: 'frontier-lab',
      owner_email: 'pi@frontier.lab',
      workspace_template: 'research',
    }, { here: true, templateName: 'research' });

    assert.equal(result.targetRoot, dir);
    assert.equal(result.workspaceTemplate, 'research');
    assert.ok(fs.existsSync(path.join(dir, '.atris', 'business.json')));
    assert.ok(fs.existsSync(path.join(dir, '.atris', 'state', '_sync.json')));
    assert.ok(fs.existsSync(path.join(dir, '.atris', 'state', 'events.jsonl')));
    assert.ok(fs.existsSync(path.join(dir, '.atris', 'state', 'episodes.jsonl')));
    assert.ok(fs.existsSync(path.join(dir, '.atris', 'state', 'scorecards.jsonl')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'team', 'hypothesis', 'MEMBER.md')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'team', 'eval', 'MEMBER.md')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'wiki', 'concepts', 'research-loop.md')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'wiki', 'briefs', 'research-program.md')));

    const meta = JSON.parse(fs.readFileSync(path.join(dir, '.atris', 'business.json'), 'utf8'));
    assert.equal(meta.workspace_template, 'research');

    const todo = fs.readFileSync(path.join(dir, 'atris', 'TODO.md'), 'utf8');
    assert.match(todo, /## Endgame/);
    assert.match(todo, /\*\*R1:\*\*/);
    assert.match(todo, /\[endgame\]/);
    assert.match(todo, /\*\*Verify:\*\*/);

    const reward = fs.readFileSync(path.join(dir, 'atris', 'policies', 'REWARD.md'), 'utf8');
    assert.match(reward, /reproducible/i);
    assert.match(reward, /held-out|replayable/i);

    const liveWorkspace = fs.readFileSync(path.join(dir, 'atris', 'context', 'live-workspace.md'), 'utf8');
    assert.match(liveWorkspace, /research/i);
    assert.match(liveWorkspace, /biz-r1/);
    assert.match(liveWorkspace, /ws-r2/);

    const teamReadme = fs.readFileSync(path.join(dir, 'atris', 'team', 'README.md'), 'utf8');
    assert.match(teamReadme, /hypothesis, experiment, eval, literature/i);
  } finally {
    cleanupTempDir(dir);
  }
});

test('business help exposes default workspace creation', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['business'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /init <name>/);
    assert.match(res.stdout, /create <name>/);
    assert.match(res.stdout, /business environment/i);
    assert.doesNotMatch(res.stdout, /canonical business workspace/i);
  } finally {
    cleanupTempDir(dir);
  }
});

test('fresh business environment starter exposes an endgame task with explicit verify', async () => {
  const dir = makeTempDir();
  try {
    createCanonicalBusinessWorkspace(dir, {
      business_id: 'biz-123',
      workspace_id: 'ws-456',
      name: 'BLOND:ISH',
      slug: 'blondish',
      owner_email: 'joel@blondish.world',
      workspace_template: 'business',
    }, { here: true });

    const suggestion = await suggestNextTask(dir, new Set(), { auto: true });
    assert.equal(suggestion.kind, 'endgame');

    const verify = getVerifyCommand(dir, suggestion.task);
    assert.equal(verify.explicit, true);
    assert.match(verify.cmd, /find atris\/wiki\/concepts/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('fresh research environment starter exposes an endgame task with explicit verify', async () => {
  const dir = makeTempDir();
  try {
    createCanonicalBusinessWorkspace(dir, {
      business_id: 'biz-r1',
      workspace_id: 'ws-r2',
      name: 'Frontier Lab',
      slug: 'frontier-lab',
      owner_email: 'pi@frontier.lab',
      workspace_template: 'research',
    }, { here: true, templateName: 'research' });

    const suggestion = await suggestNextTask(dir, new Set(), { auto: true });
    assert.equal(suggestion.kind, 'endgame');

    const verify = getVerifyCommand(dir, suggestion.task);
    assert.equal(verify.explicit, true);
    assert.match(verify.cmd, /research-program\.md/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('business record appends recap state to all three workspace logs', async () => {
  const dir = makeTempDir();
  try {
    createCanonicalBusinessWorkspace(dir, {
      business_id: 'biz-123',
      workspace_id: 'ws-456',
      name: 'BLOND:ISH',
      slug: 'blondish',
      owner_email: 'joel@blondish.world',
      workspace_template: 'business',
    }, { here: true });

    const reportPath = path.join(dir, 'atris', 'reports', '2026-04-12-operator-recap.md');
    fs.writeFileSync(reportPath, '# Operator Recap\n\nA real run happened.\n', 'utf8');

    const prevCwd = process.cwd();
    process.chdir(dir);
    try {
      await recordBusinessRun('atris/reports/2026-04-12-operator-recap.md', '--outcome', 'positive', '--metric', 'ticket pulse');
    } finally {
      process.chdir(prevCwd);
    }

    const events = fs.readFileSync(path.join(dir, '.atris', 'state', 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    const episodes = fs.readFileSync(path.join(dir, '.atris', 'state', 'episodes.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    const scorecards = fs.readFileSync(path.join(dir, '.atris', 'state', 'scorecards.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));

    assert.equal(events.length, 1);
    assert.equal(episodes.length, 1);
    assert.equal(scorecards.length, 1);
    assert.equal(events[0].type, 'report_recorded');
    assert.equal(episodes[0].type, 'episode');
    assert.equal(scorecards[0].type, 'scorecard');
    assert.equal(events[0].business_slug, 'blondish');
    assert.equal(events[0].report_path, 'atris/reports/2026-04-12-operator-recap.md');
    assert.equal(events[0].metric, 'ticket pulse');
    assert.equal(events[0].outcome, 'positive');
    assert.equal(events[0].reward, 5);
  } finally {
    cleanupTempDir(dir);
  }
});

test('business onboard seeds intake, wiki pages, and a cheat sheet from sparse inputs', async () => {
  const dir = makeTempDir();
  try {
    createCanonicalBusinessWorkspace(dir, {
      business_id: 'biz-789',
      workspace_id: 'ws-789',
      name: 'Cashmere AI',
      slug: 'cashmere-ai',
      owner_email: 'team@cashmere.ai',
      workspace_template: 'business',
    }, { here: true });

    const prevCwd = process.cwd();
    process.chdir(dir);
    try {
      await onboardBusiness(
        '--website', 'https://cashmere.ai',
        '--contact', 'Farbod Nowzad',
        '--email', 'farbod@cashmere.ai',
        '--role', 'Founder',
        '--note', 'Warm proposal-stage account',
        '--note', 'Need a sharper first loop'
      );
    } finally {
      process.chdir(prevCwd);
    }

    const ingestRoot = path.join(dir, 'atris', 'context', '_ingest');
    const packs = fs.readdirSync(ingestRoot);
    assert.equal(packs.length, 1);
    assert.ok(fs.existsSync(path.join(ingestRoot, packs[0], 'intake.md')));
    assert.ok(fs.existsSync(path.join(ingestRoot, packs[0], 'links.txt')));
    assert.ok(fs.existsSync(path.join(ingestRoot, packs[0], 'sources.txt')));

    const briefPath = path.join(dir, 'atris', 'wiki', 'briefs', 'cashmere-ai-starter-brief.md');
    const personPath = path.join(dir, 'atris', 'wiki', 'people', 'farbod-nowzad.md');
    const conceptPath = path.join(dir, 'atris', 'wiki', 'concepts', 'cashmere-ai-first-loop.md');
    const cheatSheetPath = path.join(dir, 'atris', 'reports', `${new Date().toISOString().slice(0, 10)}-cashmere-ai-onboarding-cheat-sheet.md`);
    const onePagerPath = path.join(dir, 'atris', 'reports', `${new Date().toISOString().slice(0, 10)}-cashmere-ai-operator-one-pager.md`);

    assert.ok(fs.existsSync(briefPath));
    assert.ok(fs.existsSync(personPath));
    assert.ok(fs.existsSync(conceptPath));
    assert.ok(fs.existsSync(cheatSheetPath));
    assert.ok(fs.existsSync(onePagerPath));

    assert.match(fs.readFileSync(briefPath, 'utf8'), /Warm proposal-stage account/);
    assert.match(fs.readFileSync(personPath, 'utf8'), /Farbod Nowzad/);
    assert.match(fs.readFileSync(conceptPath, 'utf8'), /Candidate Loop/);
    assert.match(fs.readFileSync(cheatSheetPath, 'utf8'), /Next 3 Moves/);
    assert.match(fs.readFileSync(cheatSheetPath, 'utf8'), /Best Next Action/);
    assert.match(fs.readFileSync(cheatSheetPath, 'utf8'), /Swarlo join/);
    assert.match(fs.readFileSync(onePagerPath, 'utf8'), /One Pager/);
    assert.match(fs.readFileSync(onePagerPath, 'utf8'), /Swarlo join/);

    const index = fs.readFileSync(path.join(dir, 'atris', 'wiki', 'index.md'), 'utf8');
    assert.match(index, /\[\[atris\/wiki\/briefs\/cashmere-ai-starter-brief\.md\]\]/);
    assert.match(index, /\[\[atris\/wiki\/people\/farbod-nowzad\.md\]\]/);
    assert.match(index, /\[\[atris\/wiki\/concepts\/cashmere-ai-first-loop\.md\]\]/);

    const status = fs.readFileSync(path.join(dir, 'atris', 'wiki', 'STATUS.md'), 'utf8');
    assert.match(status, /starter onboarding compiled/);
    const log = fs.readFileSync(path.join(dir, 'atris', 'wiki', 'log.md'), 'utf8');
    assert.match(log, /ONBOARD starter onboarding compiled for cashmere-ai/);

    const todoContent = fs.readFileSync(path.join(dir, 'atris', 'TODO.md'), 'utf8');
    assert.match(todoContent, /\[execute\]/);
    assert.match(todoContent, /Draft a founder-context note/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('business onboard can infer signals from sloppy input and local files', async () => {
  const dir = makeTempDir();
  try {
    createCanonicalBusinessWorkspace(dir, {
      business_id: 'biz-900',
      workspace_id: 'ws-900',
      name: 'Northstar Ops',
      slug: 'northstar-ops',
      owner_email: 'team@northstar.ops',
      workspace_template: 'business',
    }, { here: true });

    fs.writeFileSync(path.join(dir, 'meeting-notes.md'), '# Notes\n\nSite: https://northstarops.ai\n', 'utf8');

    const prevCwd = process.cwd();
    process.chdir(dir);
    try {
      await onboardBusiness('sleep deprived onboarding', 'need something useful fast');
    } finally {
      process.chdir(prevCwd);
    }

    const briefPath = path.join(dir, 'atris', 'wiki', 'briefs', 'northstar-ops-starter-brief.md');
    const onePagerPath = path.join(dir, 'atris', 'reports', `${new Date().toISOString().slice(0, 10)}-northstar-ops-operator-one-pager.md`);
    const sourcesRoot = path.join(dir, 'atris', 'context', '_ingest');
    const pack = fs.readdirSync(sourcesRoot)[0];
    const sourcesTxt = fs.readFileSync(path.join(sourcesRoot, pack, 'sources.txt'), 'utf8');

    assert.ok(fs.existsSync(briefPath));
    assert.ok(fs.existsSync(onePagerPath));
    assert.match(fs.readFileSync(briefPath, 'utf8'), /Website: https:\/\/northstarops\.ai/);
    assert.match(fs.readFileSync(briefPath, 'utf8'), /sleep deprived onboarding need something useful fast/);
    assert.match(fs.readFileSync(onePagerPath, 'utf8'), /Map the offer into one loop|Extract the first workflow from local evidence/);
    assert.match(sourcesTxt, /meeting-notes\.md/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('business onboard bootstraps from bare directory with --name flag', async () => {
  const dir = makeTempDir();
  try {
    const prevCwd = process.cwd();
    process.chdir(dir);
    try {
      await onboardBusiness(
        '--name', 'Acme Corp',
        '--website', 'https://acme.com',
        '--contact', 'Jane Doe',
        '--email', 'jane@acme.com'
      );
    } finally {
      process.chdir(prevCwd);
    }

    const bizFile = path.join(dir, '.atris', 'business.json');
    assert.ok(fs.existsSync(bizFile), '.atris/business.json should exist');
    const meta = JSON.parse(fs.readFileSync(bizFile, 'utf8'));
    assert.equal(meta.name, 'Acme Corp');
    assert.equal(meta.slug, 'acme-corp');

    const briefPath = path.join(dir, 'atris', 'wiki', 'briefs', 'acme-corp-starter-brief.md');
    assert.ok(fs.existsSync(briefPath), 'starter brief should exist');
    assert.match(fs.readFileSync(briefPath, 'utf8'), /Jane Doe/);

    const todoPath = path.join(dir, 'atris', 'TODO.md');
    assert.ok(fs.existsSync(todoPath), 'TODO.md should exist');
    const todoContent = fs.readFileSync(todoPath, 'utf8');
    assert.match(todoContent, /Backlog/);
    assert.match(todoContent, /\[execute\]/);
  } finally {
    cleanupTempDir(dir);
  }
});

// ============================================
// receipt
// ============================================

test('receipt doctor prints readiness without requiring auth', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['receipt', 'doctor'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Receipt check/);
    assert.match(res.stdout, /business binding/);
    assert.match(res.stdout, /atris receipt init business-workflow/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('receipt init scaffolds task and receipt directory', () => {
  const dir = makeTempDir();
  try {
    createCanonicalBusinessWorkspace(dir, {
      business_id: 'biz-receipt',
      workspace_id: 'ws-receipt',
      name: 'Receipt Co',
      slug: 'receipt-co',
      owner_email: 'team@receipt.dev',
      workspace_template: 'business',
    }, { here: true });

    const res = runCli(['receipt', 'init', 'support-agent'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Receipt task ready/);

    const taskPath = path.join(dir, '.atris', 'tasks', 'support-agent.json');
    assert.ok(fs.existsSync(taskPath));
    assert.ok(fs.existsSync(path.join(dir, '.atris', 'receipts', '.gitkeep')));

    const task = JSON.parse(fs.readFileSync(taskPath, 'utf8'));
    assert.equal(task.workspace.slug, 'receipt-co');
    assert.equal(task.runtime.proof_command, 'atris computer proof');
  } finally {
    cleanupTempDir(dir);
  }
});

test('receipt run dry-run prints commands and writes nothing', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['receipt', 'run', '--dry-run'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /atris computer proof/);
    assert.match(res.stdout, /atris experiments replay endstate/);
    assert.match(res.stdout, /Dry run only/);
    assert.equal(fs.existsSync(path.join(dir, '.atris', 'receipts')), false);
  } finally {
    cleanupTempDir(dir);
  }
});

// ============================================
// computer
// ============================================

test('computer card prints local workspace card without auth', () => {
  const dir = makeTempDir();
  try {
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'demo-workspace', bin: { demo: 'bin/demo.js' }, scripts: { test: 'node --test' } }, null, 2),
      'utf8'
    );
    initWorkspace(dir);

    const res = runCli(['computer', 'card'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Atris Computer Card/);
    assert.match(res.stdout, /Owner:\s+demo-workspace \(project\)/);
    assert.match(res.stdout, /Type:\s+codeops/);
    assert.match(res.stdout, /Memory:\s+atris\/MAP\.md/);
    assert.match(res.stdout, /Validate:\s+npm test/);
    assert.doesNotMatch(res.stderr, /Not logged in/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('computer card --write saves an inspectable markdown artifact', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);

    const res = runCli(['computer', 'card', '--write'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Wrote atris\/reports\/computer-card\.md/);

    const cardPath = path.join(dir, 'atris', 'reports', 'computer-card.md');
    assert.ok(fs.existsSync(cardPath));
    const card = fs.readFileSync(cardPath, 'utf8');
    assert.match(card, /^# Atris Computer Card/);
    assert.match(card, /- Loop: plan -> do -> review/);
    assert.match(card, /- Proof: atris proof run/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('proof remains a quiet alias for receipt', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['proof', 'doctor'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Receipt check/);
  } finally {
    cleanupTempDir(dir);
  }
});

// research CLI command not yet wired — template exists but no `atris research` subcommand

// ============================================
// log sequential IDs
// ============================================

test('log assigns sequential IDs across sessions', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    runCli(['log'], { cwd: dir, input: 'First idea\nexit\n' });
    runCli(['log'], { cwd: dir, input: 'Second idea\nexit\n' });

    const logsDir = path.join(dir, 'atris', 'logs');
    const yearDirs = fs.readdirSync(logsDir).filter(d => /^\d{4}$/.test(d));
    const yearDir = path.join(logsDir, yearDirs[0]);
    const logFiles = fs.readdirSync(yearDir).filter(f => f.endsWith('.md'));
    const content = fs.readFileSync(path.join(yearDir, logFiles[0]), 'utf8');

    assert.match(content, /I1/);
    assert.match(content, /I2/);
    assert.match(content, /First idea/);
    assert.match(content, /Second idea/);
  } finally {
    cleanupTempDir(dir);
  }
});

// ============================================
// status full mode
// ============================================

test('status default mode renders human summary', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    const todoPath = path.join(dir, 'atris', 'TODO.md');
    fs.writeFileSync(todoPath, [
      '# TODO.md',
      '',
      '## Backlog',
      '',
      '- **T1:** Implement feature X',
      '',
      '## In Progress',
      '',
      '(Empty)',
      '',
      '## Completed',
      '',
      '(Empty)',
    ].join('\n'), 'utf8');

    const res = runCli(['status'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Where we are:/);
    assert.match(res.stdout, /What is queued:/);
    assert.match(res.stdout, /What is blocking:/);
    assert.doesNotMatch(res.stdout, /TASK BOARD|┌|└|│/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('status verbose mode keeps the legacy task board', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    const res = runCli(['status', '--verbose'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /TASK BOARD|Backlog/i);
    assert.match(res.stdout, /┌|└|│/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('status stays local even when .atris/business.json exists', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    const metaDir = path.join(dir, '.atris');
    fs.mkdirSync(metaDir, { recursive: true });
    fs.writeFileSync(
      path.join(metaDir, 'business.json'),
      JSON.stringify({ slug: 'example-co' }, null, 2),
      'utf8'
    );

    const res = runCli(['status'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Where we are:/);
    assert.doesNotMatch(res.stdout, /last synced/i);
  } finally {
    cleanupTempDir(dir);
  }
});

test('review default mode renders human validator brief', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    const res = runCli(['review'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /I checked the review setup\./);
    assert.match(res.stdout, /refresh the task\s+projection\/TODO view/);
    assert.doesNotMatch(res.stdout, /clear completed tasks out of TODO/);
    assert.match(res.stdout, /Decision: hold/);
    assert.doesNotMatch(res.stdout, /┌|└|│|Validator Agent Activated/);
    for (const line of res.stdout.trimEnd().split('\n')) {
      assert.ok(line.length <= 80, `line too wide: ${line.length} "${line}"`);
    }
  } finally {
    cleanupTempDir(dir);
  }
});

test('review verbose mode keeps the legacy validator board', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    const res = runCli(['review', '--verbose'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Atris Review|Validator Agent Activated/);
    assert.match(res.stdout, /Confirm active task state is clean/);
    assert.doesNotMatch(res.stdout, /delete completed tasks|DELETE completed tasks/);
    assert.match(res.stdout, /┌|└|│/);
  } finally {
    cleanupTempDir(dir);
  }
});

// ============================================
// feedback
// ============================================

test('feedback rejects unknown subcommands before submit fallback', () => {
  const dir = makeTempDir();
  try {
    const bogus = runCli(['feedback', 'bogus-subcommand'], { cwd: dir });
    assert.notEqual(bogus.status, 0);
    assert.match(bogus.stderr, /Unknown feedback command: bogus-subcommand/);
    assert.match(bogus.stderr, /Usage:/);
    assert.doesNotMatch(bogus.stdout, /Feedback submitted/);

    const show = runCli(['feedback', 'show', '0e136c15'], { cwd: dir });
    assert.notEqual(show.status, 0);
    assert.match(show.stderr, /Unknown feedback command: show/);
    assert.match(show.stderr, /Usage:/);
    assert.doesNotMatch(show.stdout, /Feedback submitted/);
  } finally {
    cleanupTempDir(dir);
  }
});

// ============================================
// unknown command warning
// ============================================

test('unknown single-word command shows warning', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    fs.writeFileSync(path.join(dir, 'atris', 'MAP.md'), '# MAP.md\n\n## By-Feature\n- example: bin/atris.js:1\n', 'utf8');
    const res = runCli(['foobarxyz'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Unknown command.*foobarxyz/i);
  } finally {
    cleanupTempDir(dir);
  }
});

test('unknown top-level command with --json returns JSON error', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['foobarxyz', '--json'], { cwd: dir });
    assert.equal(res.status, 2, res.stderr);
    assert.equal(res.stderr, '');
    assert.deepEqual(JSON.parse(res.stdout), {
      ok: false,
      error: 'unknown command: foobarxyz',
      command: 'foobarxyz',
      input: 'foobarxyz --json',
      usage: 'atris help',
    });
  } finally {
    cleanupTempDir(dir);
  }
});

// ============================================
// wiki
// ============================================

test('wiki help paths print usage without scaffolding workspace state', () => {
  const dir = makeTempDir();
  try {
    const home = path.join(dir, 'home');
    const cases = [
      { args: ['ingest', '--help'], usage: /Usage: atris ingest/ },
      { args: ['query', '--help'], usage: /Usage: atris query/ },
      { args: ['lint', '--help'], usage: /Usage: atris lint/ },
      { args: ['wiki', '--help'], usage: /Usage: atris wiki/ },
      { args: ['wiki', 'ingest', '--help'], usage: /Usage: atris wiki ingest/ },
    ];

    for (const item of cases) {
      const res = runCli(item.args, { cwd: dir, env: { HOME: home } });
      assert.equal(res.status, 0, `${item.args.join(' ')}: ${res.stderr || res.stdout}`);
      assert.match(res.stdout, item.usage);
      assert.doesNotMatch(res.stdout, /Local wiki ingest|Local wiki query|Local wiki lint|No local wiki|Target: atris\/wiki|Prompt for/);
      assert.equal(fs.existsSync(path.join(dir, 'atris')), false, `${item.args.join(' ')} created atris/`);
      assert.equal(fs.existsSync(path.join(home, '.atris')), false, `${item.args.join(' ')} created ~/.atris`);
    }
  } finally {
    cleanupTempDir(dir);
  }
});

test('ingest is local-first and scaffolds atris/wiki', () => {
  const dir = makeTempDir();
  try {
    fs.writeFileSync(path.join(dir, 'README.md'), '# Test source\n', 'utf8');
    const res = runCli(['ingest', 'README.md'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Local wiki ingest/);
    assert.match(res.stdout, /Target: atris\/wiki/);
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'wiki', 'wiki.md')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'wiki', 'index.md')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'wiki', 'STATUS.md')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'context', 'README.md')));
  } finally {
    cleanupTempDir(dir);
  }
});

test('local ingest stages a source pack and refreshes wiki bookkeeping', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'sources'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'sources', 'overview.md'), '# Overview\n', 'utf8');

    const res = runCli(['ingest', 'sources'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Pack: atris\/context\/_ingest\//);
    assert.match(res.stdout, /Manifest: atris\/context\/_ingest\//);
    assert.match(res.stdout, /Sources: atris\/context\/_ingest\//);

    const ingestRoot = path.join(dir, 'atris', 'context', '_ingest');
    const packs = fs.readdirSync(ingestRoot);
    assert.equal(packs.length, 1);

    const packDir = path.join(ingestRoot, packs[0]);
    const manifestPath = path.join(packDir, 'manifest.json');
    assert.ok(fs.existsSync(manifestPath));
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.entries[0].kind, 'directory');
    assert.ok(manifest.entries[0].files.some((file) => file.endsWith('overview.md')));

    const status = fs.readFileSync(path.join(dir, 'atris', 'wiki', 'STATUS.md'), 'utf8');
    assert.match(status, /Last ingest: \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
    assert.match(status, /Health: ingest staged from atris\/context\/_ingest\//);
    assert.match(status, /Next move: compile atris\/context\/_ingest\//);

    const log = fs.readFileSync(path.join(dir, 'atris', 'wiki', 'log.md'), 'utf8');
    assert.match(log, /INGEST 1 source item\(s\) staged from sources/);
    assert.match(log, /manifest atris\/context\/_ingest\//);
  } finally {
    cleanupTempDir(dir);
  }
});

test('wiki ingest --private scaffolds .atris/presidio', () => {
  const dir = makeTempDir();
  try {
    fs.writeFileSync(path.join(dir, 'README.md'), '# Private source\n', 'utf8');
    const res = runCli(['wiki', 'ingest', '--private', 'README.md'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Private wiki ingest/);
    assert.match(res.stdout, /Target: \.atris\/presidio/);
    assert.ok(fs.existsSync(path.join(dir, '.atris', 'presidio', 'wiki.md')));
    assert.ok(fs.existsSync(path.join(dir, '.atris', 'presidio', 'index.md')));
    assert.ok(fs.existsSync(path.join(dir, '.atris', 'presidio', 'STATUS.md')));
    assert.ok(fs.existsSync(path.join(dir, '.atris', 'presidio', 'context', 'README.md')));
  } finally {
    cleanupTempDir(dir);
  }
});

test('query alias uses local wiki by default', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'wiki'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'wiki', 'index.md'), '# Atris Wiki Index\n', 'utf8');
    const res = runCli(['query', 'what is the system state'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Local wiki query/);
    assert.match(res.stdout, /what is the system state/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('wiki search reads canonical atris/wiki index', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'wiki'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'atris', 'wiki', 'index.md'),
      '# Atris Wiki Index\n\n## Concepts\n\n- [[atris/wiki/concepts/local-first.md]] - local-first wiki routing\n',
      'utf8'
    );
    const res = runCli(['wiki', 'search', 'local-first'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /local-first wiki routing/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('wiki log reads canonical atris/wiki log', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'wiki'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'atris', 'wiki', 'log.md'),
      '# Atris Wiki Log\n\n## 2026-04-07\n- 10:00 INGEST README.md\n  - created local-first page\n',
      'utf8'
    );
    const res = runCli(['wiki', 'log'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /2026-04-07/);
    assert.match(res.stdout, /INGEST README\.md/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('wiki sync alias normalizes --only wiki to atris/wiki', () => {
  assert.equal(normalizeWikiOnlyPrefix('wiki'), 'atris/wiki/');
  assert.equal(normalizeWikiOnlyPrefix('wiki/'), 'atris/wiki/');
  assert.equal(normalizeWikiOnlyPrefix('atris/wiki'), 'atris/wiki/');
});

test('agent-readable wiki contract requires sources, verification, dependencies, confidence, and actionability', () => {
  const dir = makeTempDir();
  try {
    const today = new Date().toISOString().slice(0, 10);
    fs.mkdirSync(path.join(dir, 'atris', 'wiki', 'concepts'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'README.md'), '# Source\n', 'utf8');
    fs.writeFileSync(
      path.join(dir, 'atris', 'wiki', 'concepts', 'good.md'),
      [
        '---',
        'sources:',
        '  - README.md',
        `last_compiled: ${today}`,
        `last_verified: ${today}`,
        'confidence: 0.8',
        'dependencies: []',
        'actionability: "use this in weekly review"',
        '---',
        '# Good',
        '',
      ].join('\n'),
      'utf8'
    );

    assert.deepEqual(validateAgentReadableWikiPages(dir).findings, []);

    fs.writeFileSync(path.join(dir, 'atris', 'wiki', 'concepts', 'bad.md'), '# Bad\n', 'utf8');
    const report = validateAgentReadableWikiPages(dir);
    assert.equal(report.ok, false);
    assert.equal(report.findings.some((finding) => finding.page.endsWith('bad.md') && finding.code === 'missing-sources'), true);
    assert.equal(report.findings.some((finding) => finding.page.endsWith('bad.md') && finding.code === 'missing-actionability'), true);
  } finally {
    cleanupTempDir(dir);
  }
});

test('wiki stale checks accept external source labels and legacy context paths', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'context', 'calls'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'context', 'calls', 'README.md'), '# Calls\n', 'utf8');
    fs.mkdirSync(path.join(dir, 'atris', 'wiki', 'systems'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'atris', 'wiki', 'systems', 'example-co.md'),
      [
        '---',
        'sources: [hubspot, chorus, context/calls]',
        'last_compiled: 2999-01-01',
        'last_verified: 2999-01-01',
        'confidence: 0.7',
        'dependencies: []',
        'actionability: "route account questions"',
        '---',
        '# ExampleCo',
        '',
      ].join('\n'),
      'utf8'
    );

    assert.deepEqual(validateAgentReadableWikiPages(dir).findings, []);
  } finally {
    cleanupTempDir(dir);
  }
});

test('wiki orphan checks accept markdown links in legacy indexes', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'wiki', 'people'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'atris', 'wiki', 'index.md'),
      '# Index\n\n- [Jane](people/jane.md)\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(dir, 'atris', 'wiki', 'people', 'jane.md'),
      [
        '---',
        'sources: [hubspot]',
        'last_compiled: 2999-01-01',
        'last_verified: 2999-01-01',
        'confidence: 0.7',
        'dependencies: []',
        'actionability: "route stakeholder questions"',
        '---',
        '# Jane',
        '',
      ].join('\n'),
      'utf8'
    );

    const { findWikiOrphans } = require('../lib/wiki');
    assert.deepEqual(findWikiOrphans(dir), []);
  } finally {
    cleanupTempDir(dir);
  }
});

test('loop flags stale wiki pages and refreshes status/log', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    fs.writeFileSync(path.join(dir, 'README.md'), '# Repo\n', 'utf8');
    const pagePath = path.join(dir, 'atris', 'wiki', 'concepts', 'stale-page.md');
    fs.mkdirSync(path.dirname(pagePath), { recursive: true });
    fs.writeFileSync(pagePath, [
      '---',
      'type: concept',
      'slug: stale-page',
      'title: Stale Page',
      'sources:',
      '  - README.md',
      'last_compiled: 2000-01-01',
      'created: 2000-01-01',
      'updated: 2000-01-01',
      'tags:',
      '  - test',
      '---',
      '# Stale Page',
      '',
      'Body.',
      '',
    ].join('\n'), 'utf8');

    const res = runCli(['loop'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Wiki Loop/);
    assert.match(res.stdout, /Stale: 1/);

    const status = fs.readFileSync(path.join(dir, 'atris', 'wiki', 'STATUS.md'), 'utf8');
    assert.match(status, /Last loop:/);
    assert.match(status, /recompile atris\/wiki\/concepts\/stale-page\.md from README\.md/);

    const log = fs.readFileSync(path.join(dir, 'atris', 'wiki', 'log.md'), 'utf8');
    assert.match(log, /LOOP/);
    assert.match(log, /stale atris\/wiki\/concepts\/stale-page\.md <- README\.md/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('loop suggests next ingest candidates when wiki is clean', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    fs.writeFileSync(path.join(dir, 'README.md'), '# Repo\n', 'utf8');
    const res = runCli(['loop', '--json'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    const report = JSON.parse(res.stdout);
    assert.ok(report.nextSources.includes('README.md'));
    assert.match(report.health, /ready for ingest|stable/i);
  } finally {
    cleanupTempDir(dir);
  }
});

test('wiki loop alias runs the same upkeep analysis', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    fs.writeFileSync(path.join(dir, 'README.md'), '# Repo\n', 'utf8');
    const res = runCli(['wiki', 'loop'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Wiki Loop/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('getVerifyCommand finds task-specific verify commands before and after task moves', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    const todoPath = path.join(dir, 'atris', 'TODO.md');
    fs.writeFileSync(todoPath, `# TODO.md

## Endgame

**Slug:** verify-loop
**Picked:** 2026-04-09 00:00
**Horizon:** Verify stays attached to the task.
**Source:** test

## Backlog
- **T1:** ship parser fix [endgame]
  **Verify:** node -e "process.exit(0)"

## In Progress

---

## Completed

---
`, 'utf8');

    const result1 = getVerifyCommand(dir, 'ship parser fix');
    assert.equal(result1.cmd, 'node -e "process.exit(0)"');
    assert.equal(result1.explicit, true);

    fs.writeFileSync(todoPath, `# TODO.md

## Endgame

**Slug:** verify-loop
**Picked:** 2026-04-09 00:00
**Horizon:** Verify stays attached to the task.
**Source:** test

## Backlog

## In Progress

---

## Completed
- **T1:** ship parser fix [endgame]
  **Verify:** node -e "process.exit(0)"

---
`, 'utf8');

    const result2 = getVerifyCommand(dir, 'ship parser fix');
    assert.equal(result2.cmd, 'node -e "process.exit(0)"');
    assert.equal(result2.explicit, true);
  } finally {
    cleanupTempDir(dir);
  }
});

test('computeTickReward does not award verify points when review failed before verify ran', () => {
  const reward = computeTickReward({
    reviewOutput: 'failed — scope drift',
    verifyPass: false,
    verifyRan: false,
    phaseResults: {
      do: { output: '' }
    }
  }, 'halted', 'npm test');

  assert.equal(reward, -3);
});

test('REWARD_CONFIG is frozen and cannot be mutated', () => {
  assert.ok(Object.isFrozen(REWARD_CONFIG));
  assert.throws(() => { 'use strict'; REWARD_CONFIG.VERIFY_PASS = 999; }, TypeError);
});

test('REWARD_CHECKSUM matches live REWARD_CONFIG + computeTickReward source', () => {
  const crypto = require('crypto');
  const h = crypto.createHash('sha256');
  h.update(JSON.stringify(REWARD_CONFIG));
  h.update(computeTickReward.toString());
  const actual = h.digest('hex');
  assert.strictEqual(actual, REWARD_CHECKSUM);
});

test('verifyJudgeIntegrity returns ok:true on clean state', () => {
  const result = verifyJudgeIntegrity();
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.expected, result.actual);
});

test('maybeWriteCompletedEndgameScorecard writes a scorecard from closed endgame state', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    const now = new Date();
    const yyyy = now.getFullYear().toString();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const dateStr = `${yyyy}-${mm}-${dd}`;

    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), `# TODO.md

## Endgame

**Slug:** verify-loop
**Picked:** ${dateStr} 00:00
**Horizon:** Every closed endgame writes a scorecard.
**Source:** test

## Backlog

## In Progress

---

## Completed
- **T1:** ship parser fix [endgame]
  **Verify:** node -e "process.exit(0)"

---
`, 'utf8');

    writeTodayLog(dir, `# Log — ${dateStr}

## Handoff

---

## Completed ✅

---

## In Progress 🔄

---

## Backlog

---

## Notes

### Endgame picked — 12:00 AM PDT

slug: verify-loop

- 12:10 am
  I planned, built, and reviewed "ship parser fix".
  We are still on the verify-loop endgame.
  Next tick will pick the next endgame task.
  Reward: 6

## Inbox

---
`);

    const wrote = maybeWriteCompletedEndgameScorecard(dir, {
      slug: 'verify-loop',
      pickedAt: `${dateStr} 00:00`,
      remaining: 1,
    });

    assert.equal(wrote, true);
    const scorecards = readScorecards(path.join(dir, 'atris'));
    assert.equal(scorecards.length, 1);
    assert.equal(scorecards[0].slug, 'verify-loop');
    assert.equal(scorecards[0].tasksShipped, 1);
    assert.equal(scorecards[0].totalReward, 6);

    const wroteAgain = maybeWriteCompletedEndgameScorecard(dir, {
      slug: 'verify-loop',
      pickedAt: `${dateStr} 00:00`,
      remaining: 1,
    });
    assert.equal(wroteAgain, false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('maybeWriteCompletedEndgameScorecard treats Review endgame work as active', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    const now = new Date();
    const yyyy = now.getFullYear().toString();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const dateStr = `${yyyy}-${mm}-${dd}`;

    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), `# TODO.md

## Endgame

**Slug:** review-loop
**Picked:** ${dateStr} 00:00
**Horizon:** Review is not shipped yet.
**Source:** test

## Backlog

(Empty)

## In Progress

(Empty)

## Review

- **[T1]** Waiting for human accept [endgame]
  **Verify:** node -e "process.exit(0)"

## Completed

(Empty)
`, 'utf8');

    const wrote = maybeWriteCompletedEndgameScorecard(dir, {
      slug: 'review-loop',
      pickedAt: `${dateStr} 00:00`,
      remaining: 1,
    });

    assert.equal(wrote, false);
    const scorecards = readScorecards(path.join(dir, 'atris'));
    assert.equal(scorecards.length, 0);
  } finally {
    cleanupTempDir(dir);
  }
});

// ============================================
// scoreEndgameCandidates
// ============================================

test('scoreEndgameCandidates returns best by confidence when no atris folder', () => {
  const dir = makeTempDir();
  try {
    const candidates = [
      { title: 'wiki-search', confidence: 0.9, rationale: 'High confidence' },
      { title: 'verify-tests', confidence: 0.7, rationale: 'Medium confidence' },
      { title: 'refactor-cli', confidence: 0.5, rationale: 'Low confidence' }
    ];
    const result = scoreEndgameCandidates(dir, candidates);
    assert.equal(result.title, 'wiki-search', 'should pick highest confidence');
    assert.equal(result.confidence, 0.9);
    assert.equal(result.scored, false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('scoreEndgameCandidates returns best by confidence when no scorecards', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    const candidates = [
      { title: 'wiki-search', confidence: 0.6, rationale: 'Medium confidence' },
      { title: 'verify-tests', confidence: 0.8, rationale: 'High confidence' },
      { title: 'refactor-cli', confidence: 0.4, rationale: 'Low confidence' }
    ];
    const result = scoreEndgameCandidates(dir, candidates);
    assert.equal(result.title, 'verify-tests', 'should pick highest confidence');
    assert.equal(result.confidence, 0.8);
    assert.equal(result.scored, false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('scoreEndgameCandidates scores candidates by historical reward with adaptive explore rate', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);

    // Create scorecards with diverse types (wiki, verify, refactor, harden)
    const scorecardsPath = getScorecardsPath(path.join(dir, 'atris'));
    const content = `# scorecards.md — Endgame Results

> Append-only. One line per closed endgame.

---

- **[2026-04-01] wiki-search-v1** — shipped: 3/3 — wall-clock: 2.5h — halt: 10% — reward: 50 — lessons: 5
- **[2026-04-02] verify-tests** — shipped: 2/3 — wall-clock: 3.0h — halt: 20% — reward: 40 — lessons: 3
- **[2026-04-03] refactor-api** — shipped: 4/4 — wall-clock: 1.5h — halt: 5% — reward: 55 — lessons: 6
- **[2026-04-04] harden-loop** — shipped: 1/2 — wall-clock: 4.0h — halt: 30% — reward: 30 — lessons: 2
- **[2026-04-05] ship-release** — shipped: 2/2 — wall-clock: 1.0h — halt: 0% — reward: 45 — lessons: 1
`;
    fs.writeFileSync(scorecardsPath, content, 'utf8');

    const candidates = [
      { title: 'wiki-new-feature', confidence: 0.7, rationale: 'New wiki work' },
      { title: 'verify-edge-cases', confidence: 0.6, rationale: 'Test edge cases' },
      { title: 'refactor-api', confidence: 0.8, rationale: 'Refactor API' }
    ];

    // 5 unique types in last 5 → exploreRate = 0.2 (max diversity)
    let exploitCount = 0, exploreCount = 0;
    for (let i = 0; i < 100; i++) {
      const result = scoreEndgameCandidates(dir, candidates);
      assert.equal(result.scored, true);
      assert.ok(result.reason, 'should have scoring reason');
      assert.ok(result.exploreRate !== undefined, 'should expose exploreRate');
      // With 5 unique types, exploreRate should be 0.2
      assert.ok(Math.abs(result.exploreRate - 0.2) < 0.01, `explore rate ${result.exploreRate} should be ~0.2`);
      if (result.reason.includes('exploit')) exploitCount++;
      else if (result.reason.includes('explore')) exploreCount++;
    }

    // ~80/20 split with diverse history
    assert.ok(exploitCount >= 60 && exploitCount <= 100, `exploit count ${exploitCount} should be ~80`);
    assert.ok(exploreCount >= 0 && exploreCount <= 40, `explore count ${exploreCount} should be ~20`);
  } finally {
    cleanupTempDir(dir);
  }
});

test('scoreEndgameCandidates boosts explore to 50% when last 5 are same type', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);

    // All 5 scorecards are wiki-* type
    const scorecardsPath = getScorecardsPath(path.join(dir, 'atris'));
    const content = `# scorecards.md — Endgame Results

> Append-only. One line per closed endgame.

---

- **[2026-04-01] wiki-search** — shipped: 3/3 — wall-clock: 2.5h — halt: 10% — reward: 50 — lessons: 5
- **[2026-04-02] wiki-ingest** — shipped: 2/3 — wall-clock: 3.0h — halt: 20% — reward: 40 — lessons: 3
- **[2026-04-03] wiki-lint** — shipped: 4/4 — wall-clock: 1.5h — halt: 5% — reward: 55 — lessons: 6
- **[2026-04-04] wiki-status** — shipped: 3/3 — wall-clock: 2.0h — halt: 0% — reward: 45 — lessons: 2
- **[2026-04-05] wiki-compile** — shipped: 2/2 — wall-clock: 1.0h — halt: 0% — reward: 48 — lessons: 1
`;
    fs.writeFileSync(scorecardsPath, content, 'utf8');

    const candidates = [
      { title: 'wiki-new-feature', confidence: 0.7, rationale: 'More wiki work' },
      { title: 'verify-edge-cases', confidence: 0.6, rationale: 'Test edge cases' },
      { title: 'refactor-api', confidence: 0.5, rationale: 'Refactor API' }
    ];

    let exploitCount = 0, exploreCount = 0;
    for (let i = 0; i < 200; i++) {
      const result = scoreEndgameCandidates(dir, candidates);
      assert.equal(result.scored, true);
      // All same type → exploreRate should be 0.5
      assert.ok(Math.abs(result.exploreRate - 0.5) < 0.01, `explore rate ${result.exploreRate} should be 0.5`);
      if (result.reason.includes('exploit')) exploitCount++;
      else if (result.reason.includes('explore')) exploreCount++;
    }

    // ~50/50 split: explore should be significantly higher than 20%
    assert.ok(exploreCount >= 60, `explore count ${exploreCount} should be >= 60 out of 200 (50% rate)`);
  } finally {
    cleanupTempDir(dir);
  }
});

test('scoreEndgameCandidates filters easy-win candidates when harder ones exist', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);

    // wiki type: high success rate (9/10 = 90%) and high mean reward (50)
    // verify type: low success rate (3/6 = 50%) and low mean reward (10)
    const scorecardsPath = getScorecardsPath(path.join(dir, 'atris'));
    const content = `# scorecards.md — Endgame Results

> Append-only. One line per closed endgame.

---

- **[2026-04-01] wiki-a** — shipped: 3/3 — wall-clock: 1.0h — halt: 0% — reward: 50 — lessons: 2
- **[2026-04-02] verify-a** — shipped: 1/2 — wall-clock: 3.0h — halt: 30% — reward: 10 — lessons: 3
- **[2026-04-03] wiki-b** — shipped: 3/3 — wall-clock: 1.0h — halt: 0% — reward: 50 — lessons: 1
- **[2026-04-04] verify-b** — shipped: 1/2 — wall-clock: 4.0h — halt: 40% — reward: 10 — lessons: 4
- **[2026-04-05] wiki-c** — shipped: 3/4 — wall-clock: 1.5h — halt: 5% — reward: 50 — lessons: 2
- **[2026-04-06] verify-c** — shipped: 1/2 — wall-clock: 3.5h — halt: 35% — reward: 10 — lessons: 3
`;
    fs.writeFileSync(scorecardsPath, content, 'utf8');

    const candidates = [
      { title: 'wiki-easy', confidence: 0.9, rationale: 'Easy wiki task' },
      { title: 'verify-hard', confidence: 0.7, rationale: 'Hard verify task' },
      { title: 'refactor-new', confidence: 0.5, rationale: 'New refactor work' }
    ];

    // Run many times — exploit picks should never be wiki-easy (filtered by difficulty floor)
    let wikiExploitCount = 0;
    for (let i = 0; i < 100; i++) {
      const result = scoreEndgameCandidates(dir, candidates);
      if (result.reason.includes('exploit') && result.title === 'wiki-easy') {
        wikiExploitCount++;
      }
    }

    // wiki type has >80% success rate and mean reward 50 (>5), so it should be filtered
    // from the exploit pool. Exploit picks should not select wiki-easy.
    assert.equal(wikiExploitCount, 0, 'easy-win wiki should be filtered from exploit pool');
  } finally {
    cleanupTempDir(dir);
  }
});

test('scoreEndgameCandidates returns fallback when scoring fails', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);

    // Write malformed scorecards to trigger parsing error
    const scorecardsPath = getScorecardsPath(path.join(dir, 'atris'));
    fs.writeFileSync(scorecardsPath, '# scorecards\n\nmalformed line that won\'t parse', 'utf8');

    const candidates = [
      { title: 'wiki-work', confidence: 0.9, rationale: 'High confidence' },
      { title: 'verify-work', confidence: 0.5, rationale: 'Low confidence' }
    ];

    const result = scoreEndgameCandidates(dir, candidates);
    // Should fall back to best by confidence
    assert.equal(result.title, 'wiki-work');
    assert.equal(result.confidence, 0.9);
    // scored flag tells us it fell back (if there was an error)
  } finally {
    cleanupTempDir(dir);
  }
});

// ─── writeLesson ───────────────────────────────────────────

test('writeLesson appends a lesson line to existing lessons.md', () => {
  const dir = makeTempDir();
  try {
    const atrisDir = path.join(dir, 'atris');
    fs.mkdirSync(atrisDir, { recursive: true });
    const lessonsPath = path.join(atrisDir, 'lessons.md');
    fs.writeFileSync(lessonsPath, '# lessons.md — What We Learned\n\n> Append-only.\n\n---\n\n', 'utf8');

    const before = fs.readFileSync(lessonsPath, 'utf8').split('\n').length;
    writeLesson(dir, 'test-slug', 'fail', 'Test explanation');
    const after = fs.readFileSync(lessonsPath, 'utf8').split('\n').length;

    assert.ok(after > before, `Expected line count to grow: ${before} → ${after}`);
    const content = fs.readFileSync(lessonsPath, 'utf8');
    assert.ok(content.includes('test-slug'), 'Lesson should contain slug');
    assert.ok(content.includes('fail'), 'Lesson should contain status');
    assert.ok(content.includes('Test explanation'), 'Lesson should contain explanation');
  } finally {
    cleanupTempDir(dir);
  }
});

test('writeLesson creates lessons.md if it does not exist', () => {
  const dir = makeTempDir();
  try {
    const atrisDir = path.join(dir, 'atris');
    fs.mkdirSync(atrisDir, { recursive: true });

    writeLesson(dir, 'new-file-slug', 'pass', 'Created from scratch');

    const lessonsPath = path.join(atrisDir, 'lessons.md');
    assert.ok(fs.existsSync(lessonsPath), 'lessons.md should be created');
    const content = fs.readFileSync(lessonsPath, 'utf8');
    assert.ok(content.includes('new-file-slug'), 'Lesson should contain slug');
  } finally {
    cleanupTempDir(dir);
  }
});
