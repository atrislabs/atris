const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { buildManifest, computeLocalHashes, threeWayCompare } = require('../lib/manifest');
const taskStore = require('../lib/task-db');
const { branchName, cleanupWorktrees, defaultStartBase, normalizeTargetRef, parseWorktrees, slugify, swarloClaim } = require('../commands/worktree');
const { ensureWikiScaffold, normalizeWikiOnlyPrefix, validateAgentReadableWikiPages } = require('../lib/wiki');
const { formatLocalDate } = require('../commands/now');
const {
  analyzeBusinessDoctor,
  businessMatchesSlug,
  collectBusinessShareState,
  createCanonicalBusinessWorkspace,
  onboardBusiness,
  renderBusinessCreatedNextSteps,
  shareBusinessWorkspace,
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
const { scrubAgentEnv } = require('./helpers/agent-env');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-cmd-test-'));
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

function runCli(args, { cwd, input, env } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    input,
    encoding: 'utf8',
    timeout: 15000,
    env: {
      ...scrubAgentEnv(),
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

test('member run starts a budgeted isolated mission from plain text', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-member-run-test-'));
  const dir = path.join(base, 'repo');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const git = (args, cwd = dir) => {
      const result = runGit(args, cwd);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return result.stdout.trim();
    };
    git(['init', '-q']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test User']);
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const logDir = path.join(dir, 'atris', 'logs', today.slice(0, 4));
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, `${today}.md`), [
      `# Log ${today}`,
      '',
      '## Inbox',
      '',
      '- **I1:** test idea',
      '',
    ].join('\n'), 'utf8');
    const created = runCli(['member', 'create', 'growth'], { cwd: dir });
    assert.equal(created.status, 0, created.stderr || created.stdout);
    git(['add', '.']);
    git(['commit', '-qm', 'baseline']);
    fs.writeFileSync(path.join(dir, 'main-dirt.txt'), 'noise that must stay out of the member mission\n');

    const res = runCli([
      'member',
      'run',
      'growth',
      'Improve onboarding proof',
      '--minutes',
      '10',
      '--json',
    ], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const payload = JSON.parse(res.stdout);
    const mission = payload.mission;

    assert.equal(payload.action, 'mission_started');
    assert.equal(mission.owner, 'growth');
    assert.equal(mission.objective, 'Improve onboarding proof');
    assert.equal(mission.runner, 'codex_goal');
    assert.equal(mission.budget_contract.requested_seconds, 600);
    assert.equal(mission.budget_contract.policy, 'spend_full_budget');
    assert.equal(mission.max_wall_seconds, 600);
    assert.match(mission.stop_condition, /use the whole time unless blocked or unsafe/);
    assert.ok(mission.worktree?.path, 'member mission should have an isolated worktree by default');
    assert.ok(fs.existsSync(mission.worktree.path));
    assert.notEqual(fs.realpathSync(mission.worktree.path), fs.realpathSync(dir));
    assert.ok(!fs.existsSync(path.join(mission.worktree.path, 'main-dirt.txt')));
    assert.ok(fs.existsSync(path.join(mission.worktree.path, '.atris', 'state', 'missions.jsonl')));
    assert.equal(fs.existsSync(path.join(dir, '.atris', 'state', 'missions.jsonl')), false);
  } finally {
    cleanupTempDir(base);
  }
});

test('member run chooses useful work from params when no mission text exists', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-member-run-auto-test-'));
  const dir = path.join(base, 'repo');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const git = (args, cwd = dir) => {
      const result = runGit(args, cwd);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return result.stdout.trim();
    };
    git(['init', '-q']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test User']);
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const created = runCli(['member', 'create', 'growth'], { cwd: dir });
    assert.equal(created.status, 0, created.stderr || created.stdout);
    git(['add', '.']);
    git(['commit', '-qm', 'baseline']);

    const res = runCli([
      'member',
      'run',
      'growth',
      '--minutes',
      '5',
      '--industry',
      'logistics',
      '--value',
      'reduce support time',
      '--json',
    ], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const payload = JSON.parse(res.stdout);
    const mission = payload.mission;

    assert.equal(payload.action, 'mission_started');
    assert.equal(mission.owner, 'growth');
    assert.match(mission.objective, /meaningful work for logistics/);
    assert.match(mission.objective, /reduce support time/);
    assert.match(mission.objective, /what changed, what was checked, and what is still unproven/);
    assert.match(mission.objective, /stop instead of doing fake busywork/);
    assert.doesNotMatch(mission.objective, /Start with this concrete candidate: test idea/);
    assert.equal(mission.budget_contract.requested_seconds, 300);
    assert.equal(mission.max_wall_seconds, 300);
    assert.ok(mission.worktree?.path, 'auto member mission should still use an isolated worktree');
  } finally {
    cleanupTempDir(base);
  }
});

test('harvest surfaces receipt and thinking actions, then writes inbox on request', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'runs'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'thinking.md'), [
      '# thinking',
      '',
      '- Values plain English and proof over motion.',
      '- Stop instead of fake busywork when there is no concrete next move.',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'runs', 'mission-harvest.json'), JSON.stringify({
      schema: 'atris.mission_receipt.v1',
      mission_id: 'mission-harvest',
      objective: 'harvest buried proof',
      result: {
        landing: {
          changed: 'Saved a useful receipt.',
          reason: 'The good reasoning was buried in a receipt.',
          checked: 'I checked the receipt.',
          tested: 'No automated verifier ran for this receipt.',
          proof: 'Receipt saved at atris/runs/mission-harvest.json.',
          next: 'no concrete follow-up mission found in Atris state',
        },
        verifier_result: { passed: true },
      },
    }, null, 2), 'utf8');

    const help = runCli(['harvest', '--help'], { cwd: dir });
    assert.equal(help.status, 0, help.stderr || help.stdout);
    assert.match(help.stdout, /Usage: atris harvest/);

    const readOnly = runCli(['harvest', '--json'], { cwd: dir });
    assert.equal(readOnly.status, 0, readOnly.stderr || readOnly.stdout);
    const payload = JSON.parse(readOnly.stdout);
    assert.equal(payload.action, 'harvest');
    assert.equal(payload.write, false);
    assert.ok(payload.actions.some((action) => /Surface buried result landing/.test(action.title)));
    assert.ok(payload.actions.some((action) => /proof and task previews plain/.test(action.title)));
    assert.equal(fs.existsSync(path.join(dir, 'atris', 'logs')), false);

    const written = runCli(['harvest', '--write', '--json'], { cwd: dir });
    assert.equal(written.status, 0, written.stderr || written.stdout);
    const writtenPayload = JSON.parse(written.stdout);
    assert.ok(writtenPayload.writes.some((item) => item.line));
    const today = new Date();
    const logPath = path.join(
      dir,
      'atris',
      'logs',
      String(today.getFullYear()),
      `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}.md`,
    );
    const log = fs.readFileSync(logPath, 'utf8');
    assert.match(log, /Surface buried result landing reasoning/);
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
    assert.match(res.stdout, /Default: stay in the current checkout/);
    assert.match(res.stdout, /atris mission start/);
    assert.match(res.stdout, /atris member goal-from-mission/);
    assert.match(res.stdout, /atris worktree ship --message/);
    assert.match(res.stdout, /atris worktree cleanup --apply/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('worktree cleanup removes only clean merged sibling worktrees', () => {
  const dir = makeTempDir();
  let cleanWorktree;
  let dirtyWorktree;
  try {
    const runGit = (args, cwd = dir) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return result.stdout.trim();
    };
    runGit(['init', '-q']);
    runGit(['config', 'user.email', 'test@example.com']);
    runGit(['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n');
    runGit(['add', '.']);
    runGit(['commit', '-qm', 'init']);

    cleanWorktree = path.join(dir, '..', `${path.basename(dir)}-clean-worktree`);
    dirtyWorktree = path.join(dir, '..', `${path.basename(dir)}-dirty-worktree`);
    runGit(['worktree', 'add', '-q', '-b', 'clean-done', cleanWorktree, 'HEAD']);
    runGit(['worktree', 'add', '-q', '-b', 'dirty-done', dirtyWorktree, 'HEAD']);
    fs.writeFileSync(path.join(dirtyWorktree, 'dirty.txt'), 'keep me\n');

    const dryRun = cleanupWorktrees({ root: dir, base: 'HEAD' });
    assert.deepEqual(dryRun.candidates.map(item => fs.realpathSync(item.path)), [fs.realpathSync(cleanWorktree)]);
    assert(dryRun.kept.some(item => fs.realpathSync(item.path) === fs.realpathSync(dirtyWorktree) && item.reason === 'dirty'));
    const cleanCandidatePath = dryRun.candidates[0].path;

    const applied = cleanupWorktrees({ root: dir, base: 'HEAD', apply: true });
    assert.deepEqual(applied.removed.map(item => item.path), [cleanCandidatePath]);
    assert.equal(fs.existsSync(cleanWorktree), false);
    assert.equal(fs.existsSync(dirtyWorktree), true);
  } finally {
    if (dirtyWorktree) spawnSync('git', ['worktree', 'remove', '--force', dirtyWorktree], { cwd: dir, encoding: 'utf8' });
    if (cleanWorktree) spawnSync('git', ['worktree', 'remove', '--force', cleanWorktree], { cwd: dir, encoding: 'utf8' });
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
    const loopStateDir = path.join(dir, '.atris', 'state', 'member-loops');
    fs.mkdirSync(loopStateDir, { recursive: true });
    fs.writeFileSync(path.join(loopStateDir, 'old-coach.lock.json'), JSON.stringify({
      schema: 'atris.member_loop_lease.v1',
      member: 'old-coach',
      run_id: 'stale-run',
      pid: 999999999,
      started_at: '2026-06-01T00:00:00.000Z',
      heartbeat_at: '2026-06-01T00:00:00.000Z',
      expires_at_ms: Date.now() - 1000,
    }, null, 2), 'utf8');
    fs.writeFileSync(path.join(loopStateDir, 'old-coach.stop.json'), JSON.stringify({
      schema: 'atris.member_loop_stop.v1',
      member: 'old-coach',
    }, null, 2), 'utf8');
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
    assert.equal(fs.existsSync(path.join(loopStateDir, 'old-coach.lock.json')), false);
    assert.equal(fs.existsSync(path.join(loopStateDir, 'old-coach.stop.json')), false);
    const latest = JSON.parse(fs.readFileSync(path.join(loopStateDir, 'old-coach.latest.json'), 'utf8'));
    assert.equal(latest.status, 'archived');
    assert.equal(latest.stale_lease_removed, true);
    assert.equal(latest.previous_lease.run_id, 'stale-run');
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

    const duplicateReview = runCli([
      'member', 'review', 'growth', tickPayload.experiment.id,
      '--accept',
      '--proof', 'second review should not mutate closed experiment',
      '--next', 'Duplicate next experiment',
      '--json',
    ], { cwd: dir });
    assert.notEqual(duplicateReview.status, 0);
    assert.match(duplicateReview.stderr, /already accepted/);

    const blockAccepted = runCli([
      'member', 'block', 'growth', tickPayload.experiment.id,
      '--reason', 'late blocker',
      '--ask', 'Should not apply',
      '--json',
    ], { cwd: dir });
    assert.notEqual(blockAccepted.status, 0);
    assert.match(blockAccepted.stderr, /already accepted/);

    const afterRefused = JSON.parse(fs.readFileSync(goalsPath, 'utf8'));
    assert.equal(afterRefused.goals[0].experiments.length, 2);
    assert.equal(afterRefused.goals[0].experiments[0].status, 'accepted');
    assert.equal(afterRefused.goals[0].experiments[0].proof, 'dry run produced a verified recovery action');
    assert.equal(afterRefused.goals[0].experiments[1].title, 'Prepare the next recovery experiment');
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
    const startedMission = runCli([
      'mission', 'start', 'Make Missions change the world with self-generated goals',
      '--owner', 'mission-lead',
      '--json',
    ], { cwd: dir });
    assert.equal(startedMission.status, 0, startedMission.stderr || startedMission.stdout);
    const mission = JSON.parse(startedMission.stdout).mission;
    const missionTaskAdd = runCli([
      'task', 'add', 'Build the mission-owned task loop',
      '--tag', 'mission',
      '--goal-id', mission.id,
      '--json',
    ], { cwd: dir });
    assert.equal(missionTaskAdd.status, 0, missionTaskAdd.stderr || missionTaskAdd.stdout);
    const missionTask = JSON.parse(missionTaskAdd.stdout).task;
    const missionTaskClaim = runCli(['task', 'claim', missionTask.display_id, '--as', 'mission-lead'], { cwd: dir });
    assert.equal(missionTaskClaim.status, 0, missionTaskClaim.stderr || missionTaskClaim.stdout);

    const goal = runCli(['member', 'goal-from-mission', 'mission-lead', '--json'], { cwd: dir });
    assert.equal(goal.status, 0, goal.stderr || goal.stdout);
    const payload = JSON.parse(goal.stdout);
    assert.equal(payload.action, 'goal_from_mission_created');
    assert.equal(payload.goal.source, 'mission');
    assert.match(payload.goal.title, /Make Missions change the world/);
    assert.doesNotMatch(payload.goal.title, /Prove one bounded step toward/, 'goal title carries the mission focus without boilerplate');
    assert.match(payload.goal.why, /Make Missions change the world/);
    assert.equal(payload.goal.mission_file, 'atris/team/mission-lead/MISSION.md');
    assert.equal(payload.goal.now_file, 'atris/team/mission-lead/now.md');
    assert.ok(payload.goal.mission_id);
    assert.equal(payload.task.ref, missionTask.display_id);
    assert.equal(payload.native_goal.task.ref, missionTask.display_id);
    assert.match(payload.native_goal.objective, /mission-lead: complete/);
    assert.match(payload.native_goal.objective, /Build the mission-owned task loop/);
    assert.equal(payload.native_goal.slash_goal, payload.native_goal.objective);
    assert.match(payload.native_goal.next_command, new RegExp(`atris task current-step --goal-id ${mission.id}`));
    assert.equal(payload.goal.native_goal.objective, payload.native_goal.objective);
    assert.match(payload.next_command, new RegExp(`atris task current-step --goal-id ${mission.id}`));

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

test('member goal-from-mission does not append a duplicate history entry on every reuse tick', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'mission-lead', '--description="Make Missions change the world"'], { cwd: dir }).status, 0);
    assert.equal(runCli(['mission', 'start', 'Make Missions change the world', '--owner', 'mission-lead', '--json'], { cwd: dir }).status, 0);

    const created = runCli(['member', 'goal-from-mission', 'mission-lead', '--json'], { cwd: dir });
    assert.equal(created.status, 0, created.stderr || created.stdout);
    const goalsPath = path.join(dir, 'atris', 'team', 'mission-lead', 'goals.json');
    const historyLen = () => JSON.parse(fs.readFileSync(goalsPath, 'utf8')).goals[0].history.length;
    const afterCreate = historyLen();

    // The cadence loop reuses the same goal every tick. Before the fix each tick appended an identical
    // no-op `goal_from_mission_reused` entry, growing goals.json without bound (2,200+ entries live).
    for (let i = 0; i < 30; i += 1) {
      assert.equal(runCli(['member', 'goal-from-mission', 'mission-lead', '--json'], { cwd: dir }).status, 0);
    }
    const afterReuse = historyLen();
    assert.ok(afterReuse <= afterCreate + 1, `reuse ticks must not append duplicate history (was ${afterCreate}, now ${afterReuse} after 30 identical reuses)`);
    assert.ok(afterReuse <= 50, `history must stay capped, got ${afterReuse}`);
  } finally {
    cleanupTempDir(dir);
  }
});

test('member goal-from-mission stops when active mission is blocked', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'mission-lead', '--description="Make Missions change the world with self-generated goals"'], { cwd: dir }).status, 0);
    assert.equal(runCli([
      'mission', 'start', 'Make Missions change the world with self-generated goals',
      '--owner', 'mission-lead',
      '--json',
    ], { cwd: dir }).status, 0);

    const nowPath = path.join(dir, 'atris', 'team', 'mission-lead', 'now.md');
    const nowText = fs.readFileSync(nowPath, 'utf8');
    fs.writeFileSync(nowPath, nowText.replace(/^- status: .+$/m, '- status: blocked').replace(/^- next: .+$/m, '- next: fix verifier failure or revise mission'), 'utf8');

    const blocked = runCli(['member', 'goal-from-mission', 'mission-lead', '--json'], { cwd: dir });
    assert.equal(blocked.status, 0, blocked.stderr || blocked.stdout);
    const payload = JSON.parse(blocked.stdout);
    assert.equal(payload.action, 'needs_user');
    assert.equal(payload.needs_user, true);
    assert.match(payload.ask, /blocked/i);
    assert.match(payload.ask, /fix verifier failure or revise mission/i);

    const goalsPath = path.join(dir, 'atris', 'team', 'mission-lead', 'goals.json');
    if (fs.existsSync(goalsPath)) {
      const state = JSON.parse(fs.readFileSync(goalsPath, 'utf8'));
      assert.equal(state.goals.length, 0);
    }
  } finally {
    cleanupTempDir(dir);
  }
});

test('member goal-from-mission preserves completed same-day proof history', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'mission-lead', '--description="Make Missions preserve completed proof history"'], { cwd: dir }).status, 0);
    assert.equal(runCli([
      'mission', 'start', 'Make Missions preserve completed proof history',
      '--owner', 'mission-lead',
      '--json',
    ], { cwd: dir }).status, 0);

    const created = runCli(['member', 'goal-from-mission', 'mission-lead', '--json'], { cwd: dir });
    assert.equal(created.status, 0, created.stderr || created.stdout);
    const createdPayload = JSON.parse(created.stdout);
    const completedId = createdPayload.goal.id;
    const goalsPath = path.join(dir, 'atris', 'team', 'mission-lead', 'goals.json');
    const state = JSON.parse(fs.readFileSync(goalsPath, 'utf8'));
    state.goals[0].status = 'completed';
    state.goals[0].completed_at = '2026-06-04T00:00:00.000Z';
    state.goals[0].completed_reason = 'accepted_experiment_proof';
    state.goals[0].experiments = [
      {
        id: 'exp-proof',
        title: 'Accepted proof',
        status: 'accepted',
        proof: 'receipt-backed proof',
        reviewed_at: '2026-06-04T00:00:00.000Z',
        value: 4,
      },
    ];
    fs.writeFileSync(goalsPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

    const next = runCli(['member', 'goal-from-mission', 'mission-lead', '--json'], { cwd: dir });
    assert.equal(next.status, 0, next.stderr || next.stdout);
    const nextPayload = JSON.parse(next.stdout);
    const nextState = JSON.parse(fs.readFileSync(goalsPath, 'utf8'));
    const completed = nextState.goals.find((goal) => goal.id === completedId);
    assert.equal(nextPayload.action, 'goal_from_mission_created');
    assert.notEqual(nextPayload.goal.id, completedId);
    assert.match(nextPayload.goal.id, new RegExp(`^${completedId}-2$`));
    assert.equal(nextState.goals[0].id, nextPayload.goal.id);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.experiments[0].id, 'exp-proof');
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

test('member wake skips proof-ready review task evidence', () => {
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
          id: 'review-ready',
          display_id: 'OBL-202',
          title: 'Proof-ready card should wait for review',
          status: 'review',
          claimed_by: 'command-leader',
          metadata: { assigned_to: 'command-leader' },
          review: { proof: 'Already has proof.' },
          latest_event_type: 'proof_ready',
          updated_at: 1778058000000,
        },
        {
          id: 'real-work',
          display_id: 'OBL-203',
          title: 'Do the next real business task',
          status: 'claimed',
          claimed_by: 'command-leader',
          metadata: { assigned_to: 'command-leader' },
          updated_at: 1778057000000,
        },
      ],
    }, null, 2), 'utf8');

    const wake = runCli(['member', 'wake', 'command-leader', '--json'], { cwd: dir });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    assert.equal(payload.decision, 'close_loop');
    assert.equal(payload.reason, 'nearest_open_loop:task_projection:OBL-203');
    assert.equal(payload.evidence.task_projection.candidate_count, 1);
    assert.equal(payload.evidence.nearest_open_loop.task_ref, 'OBL-203');
    assert.match(payload.next_command, /atris task note OBL-203/);
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

test('member wake discovers autonomous objective from scorecard signal with no active goal', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'command-leader', '--description="Coordinate autonomous AGI foundation loops"'], { cwd: dir }).status, 0);
    fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'scorecards.jsonl'), `${JSON.stringify({
      schema: 'atris.brain.scorecard.v1',
      type: 'scorecard',
      reward: 0.4,
      next_task_suggestion: 'Build autonomous problem scanner from telemetry receipts',
      lesson: 'The loop had no member goal even though telemetry exposed a high-value AGI gap.',
      created_at: '2026-06-02T10:00:00.000Z',
    })}\n`, 'utf8');

    const wake = runCli(['member', 'wake', 'command-leader', '--json'], { cwd: dir });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    assert.equal(payload.decision, 'set_objective');
    assert.equal(payload.reason, 'autonomous_problem_discovery:scorecards');
    assert.equal(payload.checks.has_goal, false);
    assert.equal(payload.checks.has_autonomous_problem_candidate, true);
    assert.equal(payload.checks.autonomous_problem_source, 'scorecards');
    assert.match(payload.autonomous_problem.objective_title, /autonomous problem scanner/i);
    assert.match(payload.next_command, /member wake command-leader --execute --confirm-autonomy-policy/);
    assert.equal(fs.existsSync(path.join(dir, 'atris', 'team', 'command-leader', 'goals.json')), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('member wake execute seeds autonomous objective from Pulse AGI receipt', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'command-leader', '--description="Coordinate autonomous AGI foundation loops"'], { cwd: dir }).status, 0);
    fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'pulse_agi_loop_receipts.jsonl'), `${JSON.stringify({
      schema: 'atris.pulse_agi_loop_receipt.v1',
      phase: 'DECIDE',
      task: 'verify Pulse AGI-loop runtime work',
      why: 'Pulse discovered autonomous coordination lacks a durable objective seed.',
      recommended_next_action: 'Seed an autonomous objective from Pulse AGI receipts and prove the next bounded member tick',
      created_at: '2026-06-02T11:00:00.000Z',
    })}\n`, 'utf8');

    const refused = runCli(['member', 'wake', 'command-leader', '--execute', '--json'], { cwd: dir });
    assert.equal(refused.status, 0, refused.stderr || refused.stdout);
    const refusedPayload = JSON.parse(refused.stdout);
    assert.equal(refusedPayload.decision, 'stop');
    assert.equal(refusedPayload.reason, 'execute_requires_confirm_autonomy_policy');
    assert.equal(fs.existsSync(path.join(dir, 'atris', 'team', 'command-leader', 'goals.json')), false);

    const executed = runCli(['member', 'wake', 'command-leader', '--execute', '--confirm-autonomy-policy', '--json'], { cwd: dir });
    assert.equal(executed.status, 0, executed.stderr || executed.stdout);
    const payload = JSON.parse(executed.stdout);
    assert.equal(payload.executed, true);
    assert.equal(payload.decision, 'tick');
    assert.equal(payload.reason, 'autonomous_objective_seeded');
    assert.equal(payload.active_goal.source, 'autonomous_problem_discovery');
    assert.match(payload.active_goal.title, /Pulse AGI receipts/i);
    assert.match(payload.next_command, /member tick command-leader --goal/);

    const state = JSON.parse(fs.readFileSync(path.join(dir, 'atris', 'team', 'command-leader', 'goals.json'), 'utf8'));
    assert.equal(state.goals.length, 1);
    assert.equal(state.goals[0].source, 'autonomous_problem_discovery');
    assert.equal(state.goals[0].source_signal.source, 'pulse_agi_loop_receipts');
    assert.match(state.goals[0].acceptance.join('\n'), /do not claim the full AGI bar is complete/i);
  } finally {
    cleanupTempDir(dir);
  }
});

test('member wake discovers autonomous objective from env-declared external signal root', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'command-leader', '--description="Coordinate autonomous AGI foundation loops"'], { cwd: dir }).status, 0);
    const externalRoot = path.join(dir, 'external-signals');
    fs.mkdirSync(path.join(externalRoot, '.atris', 'state'), { recursive: true });
    fs.writeFileSync(path.join(externalRoot, '.atris', 'state', 'scorecards.jsonl'), `${JSON.stringify({
      schema: 'atris.external.scorecard.v1',
      type: 'scorecard',
      reward: 0.2,
      next_task_suggestion: 'Scan customer behavior metrics for autonomous objective gaps',
      lesson: 'External metrics show repeated user dropoff before member objective creation.',
      created_at: '2026-06-03T09:00:00.000Z',
    })}\n`, 'utf8');

    const wake = runCli(['member', 'wake', 'command-leader', '--json'], {
      cwd: dir,
      env: { ATRIS_MEMBER_SIGNAL_ROOTS: externalRoot },
    });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    assert.equal(payload.decision, 'set_objective');
    assert.equal(payload.reason, 'autonomous_problem_discovery:external_signals_scorecards');
    assert.equal(payload.checks.autonomous_problem_source, 'external_signals_scorecards');
    assert.match(payload.autonomous_problem.objective_title, /customer behavior metrics/i);
    assert.ok(payload.evidence.problem_discovery.sources_with_rows.find((source) => source.source === 'external_signals_scorecards'));
  } finally {
    cleanupTempDir(dir);
  }
});

test('member wake discovers autonomous objective from configured metrics signal file', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'command-leader', '--description="Coordinate autonomous AGI foundation loops"'], { cwd: dir }).status, 0);
    fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'signals'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'member-signal-sources.json'), JSON.stringify({
      sources: [
        { source: 'api_metrics', path: 'signals/api-metrics.jsonl', kind: 'jsonl' },
      ],
    }, null, 2), 'utf8');
    fs.writeFileSync(path.join(dir, 'signals', 'api-metrics.jsonl'), `${JSON.stringify({
      schema: 'atris.metrics.problem_signal.v1',
      current_blocker: 'API metrics show onboarding users stall before any member objective exists.',
      recommended_next_action: 'Patch onboarding API conversion drop from user behavior metrics',
      created_at: '2026-06-03T09:15:00.000Z',
    })}\n`, 'utf8');

    const wake = runCli(['member', 'wake', 'command-leader', '--json'], { cwd: dir });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    assert.equal(payload.decision, 'set_objective');
    assert.equal(payload.reason, 'autonomous_problem_discovery:api_metrics');
    assert.equal(payload.checks.autonomous_problem_source, 'api_metrics');
    assert.match(payload.autonomous_problem.problem, /API metrics/);
    assert.match(payload.autonomous_problem.suggested_action, /conversion drop/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('signal-scout wake creates auto-discovery task from recurring log errors', () => {
  const dir = makeTempDir();
  const env = { ATRIS_TASKS_DB: path.join(dir, '.atris', 'tasks.db') };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'signal-scout', '--description="Turn repeated errors into bounded tasks"'], { cwd: dir, env }).status, 0);
    assert.equal(runCli(['member', 'goal-from-mission', 'signal-scout', '--json'], { cwd: dir, env }).status, 0);

    const logsDir = path.join(dir, 'atris', 'logs', '2026');
    fs.mkdirSync(logsDir, { recursive: true });
    const pattern = 'ERROR renderer crashed while opening Team Hub queue';
    fs.writeFileSync(path.join(logsDir, '2026-06-04.md'), [
      '# test log',
      `- ${pattern}`,
      `- ${pattern}`,
      `- ${pattern}`,
      '- unrelated warning',
      '',
    ].join('\n'), 'utf8');

    const scriptPath = path.join(dir, 'scripts', 'scan-errors.mjs');
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(scriptPath, `
import { readFileSync } from 'node:fs';
import path from 'node:path';
const rootIndex = process.argv.indexOf('--root');
const root = rootIndex >= 0 ? process.argv[rootIndex + 1] : process.cwd();
const filePath = path.join(root, 'atris', 'logs', '2026', '2026-06-04.md');
const lines = readFileSync(filePath, 'utf8').split(/\\r?\\n/);
const matches = lines.map((line, index) => ({ line, index })).filter((row) => /error|failed|crashed/i.test(row.line));
const counts = new Map();
for (const row of matches) {
  const pattern = row.line.replace(/^\\s*[-*]\\s+/, '').trim();
  const existing = counts.get(pattern) || { pattern, count: 0, evidence: [] };
  existing.count += 1;
  existing.evidence.push({ path: 'atris/logs/2026/2026-06-04.md', line: row.index + 1, text: row.line });
  counts.set(pattern, existing);
}
const selected = [...counts.values()].sort((a, b) => b.count - a.count)[0] || null;
console.log(JSON.stringify({ ok: true, schema: 'atris.error_scan.v1', threshold: 3, since_hours: 24, pattern: selected?.pattern || null, count: selected?.count || 0, selected, scanned: { files: 1, lines: lines.length, matching_lines: matches.length }, matches: [...counts.values()] }));
`, 'utf8');

    const dryRun = runCli(['member', 'wake', 'signal-scout', '--execute', '--dry-run', '--json'], { cwd: dir, env });
    assert.equal(dryRun.status, 0, dryRun.stderr || dryRun.stdout);
    const dryPayload = JSON.parse(dryRun.stdout);
    assert.equal(dryPayload.mode, 'dry_run');
    assert.equal(dryPayload.executed, false);
    assert.equal(dryPayload.decision, 'create_task');
    assert.equal(dryPayload.reason, 'autonomous_error_discovery:log_error_scan');
    assert.match(dryPayload.next_command, /atris task new 'Fix recurring error:/);
    assert.equal(fs.existsSync(path.join(dir, '.atris', 'state', 'tasks.projection.json')), false);

    const executed = runCli(['member', 'wake', 'signal-scout', '--execute', '--confirm-autonomy-policy', '--json'], { cwd: dir, env });
    assert.equal(executed.status, 0, executed.stderr || executed.stdout);
    const payload = JSON.parse(executed.stdout);
    assert.equal(payload.executed, true);
    assert.equal(payload.decision, 'create_task');
    assert.equal(payload.reason, 'autonomous_error_task_created');
    assert.equal(payload.created_task.tag, 'auto-discovery');
    assert.match(payload.created_task.title, /Fix recurring error: ERROR renderer crashed/);
    assert.equal(payload.autonomous_discovery_receipt.error_count, 3);
    assert.ok(fs.existsSync(payload.receipt_path));

    const projection = JSON.parse(fs.readFileSync(path.join(dir, '.atris', 'state', 'tasks.projection.json'), 'utf8'));
    assert.ok(projection.tasks.some((task) => task.tag === 'auto-discovery' && /Fix recurring error: ERROR renderer crashed/.test(task.title)));
    const projectLog = fs.readFileSync(payload.autonomous_discovery_project_log_path, 'utf8');
    assert.match(projectLog, /Signal Scout autonomous problem discovery/);
    assert.match(projectLog, /ERROR renderer crashed while opening Team Hub queue/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('member tick reads goal file evidence and consumes LLM proposal output', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'atris', 'context'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'atris', 'context', 'agi.md'),
      [
        '# AGI bar',
        'Build a causal model from action to outcome before setting the next objective.',
      ].join('\n'),
      'utf8',
    );
    assert.equal(runCli(['member', 'create', 'command-leader', '--description="Coordinate autonomous AGI foundation loops"'], { cwd: dir }).status, 0);
    const goal = runCli([
      'member', 'goal', 'command-leader',
      'Build AGI objective setting from atris/context/agi.md',
      '--acceptance', 'Use atris/context/agi.md and return one receipt-backed causal proof step.',
      '--json',
    ], { cwd: dir });
    assert.equal(goal.status, 0, goal.stderr || goal.stdout);
    const goalPayload = JSON.parse(goal.stdout);

    const wake = runCli(['member', 'wake', 'command-leader', '--json'], { cwd: dir });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const wakePayload = JSON.parse(wake.stdout);
    assert.equal(wakePayload.evidence.goal_files.files_read, 1);
    assert.equal(wakePayload.evidence.goal_files.files[0].path, 'atris/context/agi.md');
    assert.match(wakePayload.evidence.goal_files.files[0].excerpt, /causal model/);

    const tick = runCli(['member', 'tick', 'command-leader', '--goal', goalPayload.goal.id, '--json'], {
      cwd: dir,
      env: {
        ATRIS_MEMBER_PROPOSAL_LLM_JSON: JSON.stringify({
          title: 'Model causal loop from AGI context',
          proof_target: 'Causal action-to-outcome proof from atris/context/agi.md',
          next_step: 'Read atris/context/agi.md, write one action-to-outcome causal claim, and attach the verifier command as proof.',
          verifier: 'node --check commands/member.js',
          stop_rule: 'Stop before architecture mutation or external side effects.',
        }),
      },
    });
    assert.equal(tick.status, 0, tick.stderr || tick.stdout);
    const tickPayload = JSON.parse(tick.stdout);
    assert.equal(tickPayload.experiment.generation.mode, 'llm');
    assert.equal(tickPayload.experiment.generation.source, 'env_json');
    assert.equal(tickPayload.experiment.title, 'Model causal loop from AGI context');
    assert.match(tickPayload.experiment.next_step, /action-to-outcome causal claim/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('auto-improver wake writes dogfood receipt and bounded task', () => {
  const dir = makeTempDir();
  const env = { ATRIS_TASKS_DB: path.join(dir, '.atris', 'tasks.db') };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'auto-improver', '--description="Finds problems before they grow"'], { cwd: dir, env }).status, 0);

    const logsDir = path.join(dir, 'atris', 'logs', '2026');
    fs.mkdirSync(logsDir, { recursive: true });
    const pattern = 'ERROR rsi client expected /api/rsi/improve but backend exposed /api/rsi/tick';
    fs.writeFileSync(path.join(logsDir, '2026-06-07.md'), [
      '# test log',
      `- ${pattern}`,
      `- ${pattern}`,
      `- ${pattern}`,
      '',
    ].join('\n'), 'utf8');

    const wake = runCli(['member', 'wake', 'auto-improver', '--execute', '--confirm-autonomy-policy', '--json'], { cwd: dir, env });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    assert.equal(payload.decision, 'task_created');
    assert.equal(payload.auto_improver.schema, 'atris.auto_improver_dogfood.v1');
    assert.equal(payload.auto_improver.proof.prevented_suffering, 1);
    assert.equal(payload.auto_improver.proof.found_problems > 0, true);
    assert.equal(payload.auto_improver.pain.after < payload.auto_improver.pain.before, true);
    assert.equal(payload.created_task.ok, true);
    assert.ok(fs.existsSync(payload.receipt_path));
    assert.ok(fs.existsSync(path.join(dir, '.atris', 'state', 'auto-improver-dogfood-latest.json')));

    const receipt = JSON.parse(fs.readFileSync(payload.receipt_path, 'utf8'));
    assert.match(receipt.scan.prevented_fire_candidate.title, /Recurring log pattern/);
    assert.equal(receipt.created_task.task_ref, payload.created_task.task_ref);
  } finally {
    cleanupTempDir(dir);
  }
});

test('auto-improver wake ignores self-generated recurring-pattern log noise', () => {
  const dir = makeTempDir();
  const env = { ATRIS_TASKS_DB: path.join(dir, '.atris', 'tasks.db') };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'auto-improver', '--description="Finds problems before they grow"'], { cwd: dir, env }).status, 0);

    const logsDir = path.join(dir, 'atris', 'logs', '2026');
    fs.mkdirSync(logsDir, { recursive: true });
    const nestedNoise = '- candidate: Recurring log pattern: candidate: Recurring log pattern: "mission_status": "blocked"';
    const strippedNoise = '- candidate: Next tick will stop until a human looks at the error.';
    const rawLoopNoise = 'Next tick will stop until a human looks at the error.';
    const genericFailureRows = [
      '## 12:37 · Task failed',
      '- status: failed',
      '- action: failed',
      '- state: blocked',
      '- verifier: failed',
      '- title: Auto-improver: Next tick will stop until a human looks at the error.',
      '- title: Make runner error wording config-neutral',
      '- proof: third-actor rerun 2026-06-16: node --test test/task-day-stale-failed.test.js passed 17/17.',
      'Next tick will verify failed, halting.',
    ];
    const resolvedByLesson = 'I hit an error while running "Re-read sources and update atris/features/team-member-standard/validate.md": spawnSync /bin/sh ETIMEDOUT';
    const realPattern = 'ERROR team hub mission_status blocked waiting for owner';
    fs.writeFileSync(path.join(dir, 'atris', 'lessons.md'), [
      '# lessons',
      '',
      '- **[2026-06-18] reconcile-already-shipped-check-git-first** — pass — team-member-standard/validate.md already landed; 2x spawnSync /bin/sh ETIMEDOUT was closeout noise.',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(logsDir, '2026-06-09.md'), [
      '# test log',
      `- ${nestedNoise}`,
      `- ${nestedNoise}`,
      strippedNoise,
      strippedNoise,
      rawLoopNoise,
      rawLoopNoise,
      rawLoopNoise,
      ...genericFailureRows,
      ...genericFailureRows,
      ...genericFailureRows,
      resolvedByLesson,
      resolvedByLesson,
      resolvedByLesson,
      `- ${realPattern}`,
      `- ${realPattern}`,
      `- ${realPattern}`,
      '',
    ].join('\n'), 'utf8');

    const wake = runCli(['member', 'wake', 'auto-improver', '--execute', '--confirm-autonomy-policy', '--json'], { cwd: dir, env });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    assert.equal(payload.decision, 'task_created');
    assert.match(payload.created_task.title || payload.created_task.task?.title || '', /^Auto-improver: /);
    assert.doesNotMatch(payload.created_task.title || payload.created_task.task?.title || '', /candidate: Recurring log pattern: candidate:/);

    const receipt = JSON.parse(fs.readFileSync(payload.receipt_path, 'utf8'));
    assert.doesNotMatch(receipt.scan.prevented_fire_candidate.title, /candidate: Recurring log pattern: candidate:/);
    const repeated = receipt.scan.log_signals.repeated_failures || [];
    assert.deepEqual(
      repeated.filter((failure) => /Next tick will stop until a human looks at the error/.test(failure.pattern)),
      [],
      'generated candidate fields must not feed the recurring-failure scanner',
    );
    assert.deepEqual(
      repeated.filter((failure) => /Next tick will stop until a human looks at the error/.test(failure.pattern)),
      [],
      'generic loop stop lines must not feed the recurring-failure scanner',
    );
    assert.deepEqual(
      repeated.filter((failure) => /Task failed|status: failed|action: failed|state: blocked|verifier: failed|title:|proof:|Next tick will verify failed/i.test(failure.pattern)),
      [],
      'generic structured failure, proof, and title rows must not feed the recurring-failure scanner',
    );
    assert.deepEqual(
      repeated.filter((failure) => /spawnSync \/bin\/sh ETIMEDOUT/.test(failure.pattern)),
      [],
      'failures covered by a pass lesson must not feed the recurring-failure scanner',
    );
  } finally {
    cleanupTempDir(dir);
  }
});

test('auto-improver wake ignores archived log failures', () => {
  const dir = makeTempDir();
  const env = { ATRIS_TASKS_DB: path.join(dir, '.atris', 'tasks.db') };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'auto-improver', '--description="Finds problems before they grow"'], { cwd: dir, env }).status, 0);

    const archiveDir = path.join(dir, 'atris', 'logs', 'archive', '2026');
    fs.mkdirSync(archiveDir, { recursive: true });
    const oldPattern = 'ERROR old April loop stopped until a human looked at the error';
    fs.writeFileSync(path.join(archiveDir, '2026-04-09.md'), [
      '# old archived log',
      oldPattern,
      oldPattern,
      oldPattern,
      '',
    ].join('\n'), 'utf8');

    const wake = runCli(['member', 'wake', 'auto-improver', '--json'], { cwd: dir, env });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    assert.equal(payload.decision, 'scan_clean');
    assert.deepEqual(payload.auto_improver.scan.log_signals.repeated_failures, []);
    assert.equal(payload.auto_improver.scan.prevented_fire_candidate, null);
  } finally {
    cleanupTempDir(dir);
  }
});

test('auto-improver wake selector skips done/accepted tasks (OBL-1469)', () => {
  const dir = makeTempDir();
  const env = { ATRIS_TASKS_DB: path.join(dir, '.atris', 'tasks.db') };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'auto-improver', '--description="Finds problems before they grow"'], { cwd: dir, env }).status, 0);

    const logsDir = path.join(dir, 'atris', 'logs', '2026');
    fs.mkdirSync(logsDir, { recursive: true });
    const pattern = 'ERROR rsi client expected /api/rsi/improve but backend exposed /api/rsi/tick';
    fs.writeFileSync(path.join(logsDir, '2026-06-07.md'), [
      '# test log',
      `- ${pattern}`,
      `- ${pattern}`,
      `- ${pattern}`,
      '',
    ].join('\n'), 'utf8');

    const first = runCli(['member', 'wake', 'auto-improver', '--execute', '--confirm-autonomy-policy', '--json'], { cwd: dir, env });
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const firstPayload = JSON.parse(first.stdout);
    assert.equal(firstPayload.decision, 'task_created');
    const firstRef = firstPayload.created_task.task_ref;
    assert.ok(firstRef);

    // Cross the lifecycle boundary as the human: the wake target is now done. Pre-fix the
    // next wake re-selected it forever (the OBL-1433 no-op spiral). Human done
    // still requires meaningful proof (the agent-env scrub made that visible).
    const done = runCli(['task', 'done', firstRef, '--as', 'keshavrao', '--proof', 'verified: rsi route mismatch fixed, curl /api/rsi/improve returns 200', '--json'], { cwd: dir, env: { ...env, ATRIS_AGENT_PROOF_ONLY: '0' } });
    assert.equal(done.status, 0, done.stderr || done.stdout);

    const second = runCli(['member', 'wake', 'auto-improver', '--execute', '--confirm-autonomy-policy', '--json'], { cwd: dir, env });
    assert.equal(second.status, 0, second.stderr || second.stdout);
    const secondPayload = JSON.parse(second.stdout);
    assert.notEqual(secondPayload.created_task?.task_ref, firstRef, 'wake must not re-select a done task');
    assert.equal(secondPayload.decision, 'task_created');
  } finally {
    cleanupTempDir(dir);
  }
});

test('auto-improver dry-run surfaces existing actionable task', () => {
  const dir = makeTempDir();
  const env = { ATRIS_TASKS_DB: path.join(dir, '.atris', 'tasks.db') };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'auto-improver', '--description="Finds problems before they grow"'], { cwd: dir, env }).status, 0);

    const logsDir = path.join(dir, 'atris', 'logs', '2026');
    fs.mkdirSync(logsDir, { recursive: true });
    const pattern = 'ERROR rsi client expected /api/rsi/improve but backend exposed /api/rsi/tick';
    fs.writeFileSync(path.join(logsDir, '2026-06-07.md'), [
      '# test log',
      `- ${pattern}`,
      `- ${pattern}`,
      `- ${pattern}`,
      '',
    ].join('\n'), 'utf8');

    const first = runCli(['member', 'wake', 'auto-improver', '--execute', '--confirm-autonomy-policy', '--json'], { cwd: dir, env });
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const firstPayload = JSON.parse(first.stdout);
    assert.equal(firstPayload.decision, 'task_created');
    const firstRef = firstPayload.created_task.task_ref;
    assert.ok(firstRef);

    const dryRun = runCli(['member', 'wake', 'auto-improver', '--json'], { cwd: dir, env });
    assert.equal(dryRun.status, 0, dryRun.stderr || dryRun.stdout);
    const dryRunPayload = JSON.parse(dryRun.stdout);
    assert.equal(dryRunPayload.mode, 'dry_run');
    assert.equal(dryRunPayload.decision, 'existing_task_found');
    assert.equal(dryRunPayload.created_task.existing, true);
    assert.equal(dryRunPayload.created_task.task_ref, firstRef);
    assert.equal(dryRunPayload.next_command, `atris task show ${firstRef} --json`);
  } finally {
    cleanupTempDir(dir);
  }
});

test('auto-improver dry-run matches legacy recurring-pattern task title', () => {
  const dir = makeTempDir();
  const env = { ATRIS_TASKS_DB: path.join(dir, '.atris', 'tasks.db') };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'auto-improver', '--description="Finds problems before they grow"'], { cwd: dir, env }).status, 0);

    const logsDir = path.join(dir, 'atris', 'logs', '2026');
    fs.mkdirSync(logsDir, { recursive: true });
    const pattern = 'ERROR rsi client expected /api/rsi/improve but backend exposed /api/rsi/tick';
    fs.writeFileSync(path.join(logsDir, '2026-06-07.md'), [
      '# test log',
      `- ${pattern}`,
      `- ${pattern}`,
      `- ${pattern}`,
      '',
    ].join('\n'), 'utf8');

    const legacyTitle = `Auto-improver: Recurring log pattern: ${pattern}`;
    const task = runCli(['task', 'new', legacyTitle, '--tag', 'auto-improver', '--json'], { cwd: dir, env });
    assert.equal(task.status, 0, task.stderr || task.stdout);
    const taskPayload = JSON.parse(task.stdout);
    const taskRef = taskPayload.task?.display_id || taskPayload.task_id;
    assert.ok(taskRef);

    const dryRun = runCli(['member', 'wake', 'auto-improver', '--json'], { cwd: dir, env });
    assert.equal(dryRun.status, 0, dryRun.stderr || dryRun.stdout);
    const dryRunPayload = JSON.parse(dryRun.stdout);
    assert.equal(dryRunPayload.decision, 'existing_task_found');
    assert.equal(dryRunPayload.created_task.existing, true);
    assert.equal(dryRunPayload.created_task.task_ref, taskRef);
    assert.equal(dryRunPayload.next_command, `atris task show ${taskRef} --json`);
  } finally {
    cleanupTempDir(dir);
  }
});

test('auto-improver wake does not treat certified review as stale or unclear work', () => {
  const dir = makeTempDir();
  const env = { ATRIS_TASKS_DB: path.join(dir, '.atris', 'tasks.db') };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'auto-improver', '--description="Finds problems before they grow"'], { cwd: dir, env }).status, 0);

    const stateDir = path.join(dir, '.atris', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'tasks.projection.json'), JSON.stringify({
      tasks: Array.from({ length: 13 }, (_, index) => ({
        display_id: `CLI-${index + 1}`,
        title: `Certified review needs proof for stale item ${index + 1}`,
        status: 'review',
        claimed_by: 'builder',
        metadata: {
          approval_status: 'pending',
          agent_certified: true,
        },
        review: {
          approval_status: 'pending',
          agent_certified: true,
        },
      })),
    }, null, 2), 'utf8');

    const wake = runCli(['member', 'wake', 'auto-improver', '--json'], { cwd: dir, env });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    const taskSignals = payload.auto_improver.scan.task_signals;
    assert.equal(taskSignals.review_task_count, 13);
    assert.equal(taskSignals.stale_task_count, 0);
    assert.equal(taskSignals.unclear_task_count, 0);
    assert.deepEqual(payload.auto_improver.scan.findings.filter((finding) => finding.source === 'task_truth'), []);
    assert.deepEqual(payload.auto_improver.scan.findings.filter((finding) => finding.source === 'unclear_next_actions'), []);
    assert.equal(payload.decision, 'scan_clean');
  } finally {
    cleanupTempDir(dir);
  }
});

test('auto-improver wake does not treat closed tasks as unclear work', () => {
  const dir = makeTempDir();
  const env = { ATRIS_TASKS_DB: path.join(dir, '.atris', 'tasks.db') };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'auto-improver', '--description="Finds problems before they grow"'], { cwd: dir, env }).status, 0);

    const stateDir = path.join(dir, '.atris', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'tasks.projection.json'), JSON.stringify({
      tasks: Array.from({ length: 13 }, (_, index) => ({
        display_id: `CLI-${index + 1}`,
        title: `Closed stale task needs proof ${index + 1}`,
        status: 'done',
        claimed_by: 'builder',
      })),
    }, null, 2), 'utf8');

    const wake = runCli(['member', 'wake', 'auto-improver', '--json'], { cwd: dir, env });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    const taskSignals = payload.auto_improver.scan.task_signals;
    assert.equal(taskSignals.unclear_task_count, 0);
    assert.deepEqual(payload.auto_improver.scan.findings.filter((finding) => finding.source === 'unclear_next_actions'), []);
    assert.equal(payload.decision, 'scan_clean');
  } finally {
    cleanupTempDir(dir);
  }
});

test('auto-improver unclear log finding carries line evidence', () => {
  const dir = makeTempDir();
  const env = { ATRIS_TASKS_DB: path.join(dir, '.atris', 'tasks.db') };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'auto-improver', '--description="Finds problems before they grow"'], { cwd: dir, env }).status, 0);

    const logsDir = path.join(dir, 'atris', 'logs', '2026');
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(path.join(logsDir, '2026-06-11.md'), [
      '# test log',
      ...Array.from({ length: 11 }, (_, index) => `needs owner for follow-up ${index + 1}`),
      '',
    ].join('\n'), 'utf8');

    const wake = runCli(['member', 'wake', 'auto-improver', '--json'], { cwd: dir, env });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    const scan = payload.auto_improver.scan;
    assert.equal(scan.log_signals.unclear_next_action_count, 11);
    assert.equal(scan.log_signals.unclear_next_actions.length, 5);
    assert.equal(scan.prevented_fire_candidate.source, 'unclear_next_actions');
    assert.equal(scan.prevented_fire_candidate.evidence[0].path, 'atris/logs/2026/2026-06-11.md');
    assert.equal(scan.prevented_fire_candidate.evidence[0].date, '2026-06-11');
    assert.equal(scan.prevented_fire_candidate.evidence[0].line, 2);
    assert.match(scan.prevented_fire_candidate.evidence[0].text, /needs owner for follow-up 1/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('auto-improver log evidence keeps source line numbers after tail scan', () => {
  const dir = makeTempDir();
  const env = { ATRIS_TASKS_DB: path.join(dir, '.atris', 'tasks.db') };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'auto-improver', '--description="Finds problems before they grow"'], { cwd: dir, env }).status, 0);

    const logsDir = path.join(dir, 'atris', 'logs', '2026');
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(path.join(logsDir, '2026-06-12.md'), [
      '# test log',
      ...Array.from({ length: 504 }, (_, index) => `filler ${index + 1}`),
      'needs owner after tail scan',
      '',
    ].join('\n'), 'utf8');

    const wake = runCli(['member', 'wake', 'auto-improver', '--json'], { cwd: dir, env });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    const scan = payload.auto_improver.scan;
    assert.equal(scan.log_signals.unclear_next_action_count, 1);
    assert.equal(scan.log_signals.unclear_next_actions[0].line, 506);
    assert.match(scan.log_signals.unclear_next_actions[0].text, /after tail scan/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('auto-improver unclear log evidence favors recent dated logs', () => {
  const dir = makeTempDir();
  const env = { ATRIS_TASKS_DB: path.join(dir, '.atris', 'tasks.db') };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'auto-improver', '--description="Finds problems before they grow"'], { cwd: dir, env }).status, 0);

    const oldLogsDir = path.join(dir, 'atris', 'team', 'mission-lead', 'logs');
    fs.mkdirSync(oldLogsDir, { recursive: true });
    fs.writeFileSync(path.join(oldLogsDir, '2026-05-07.md'), [
      '# old log',
      ...Array.from({ length: 10 }, (_, index) => `needs owner stale follow-up ${index + 1}`),
      '',
    ].join('\n'), 'utf8');

    const recentLogsDir = path.join(dir, 'atris', 'logs', '2026');
    fs.mkdirSync(recentLogsDir, { recursive: true });
    fs.writeFileSync(path.join(recentLogsDir, '2026-06-12.md'), [
      '# recent log',
      'needs owner for current follow-up',
      '',
    ].join('\n'), 'utf8');

    const wake = runCli(['member', 'wake', 'auto-improver', '--json'], { cwd: dir, env });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    const scan = payload.auto_improver.scan;
    assert.equal(scan.log_signals.unclear_next_action_count, 11);
    assert.equal(scan.log_signals.unclear_next_actions.length, 5);
    assert.equal(scan.log_signals.unclear_next_actions[0].path, 'atris/logs/2026/2026-06-12.md');
    assert.equal(scan.prevented_fire_candidate.evidence[0].path, 'atris/logs/2026/2026-06-12.md');
    assert.equal(scan.prevented_fire_candidate.evidence[0].date, '2026-06-12');
    assert.match(scan.prevented_fire_candidate.evidence[0].text, /current follow-up/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('auto-improver repeated failure evidence favors recent dated logs', () => {
  const dir = makeTempDir();
  const env = { ATRIS_TASKS_DB: path.join(dir, '.atris', 'tasks.db') };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'auto-improver', '--description="Finds problems before they grow"'], { cwd: dir, env }).status, 0);

    const oldLogsDir = path.join(dir, 'atris', 'team', 'mission-lead', 'logs');
    fs.mkdirSync(oldLogsDir, { recursive: true });
    fs.writeFileSync(path.join(oldLogsDir, '2026-05-07.md'), [
      '# old log',
      ...Array.from({ length: 5 }, () => 'ERROR recurring sync failure'),
      '',
    ].join('\n'), 'utf8');

    const recentLogsDir = path.join(dir, 'atris', 'logs', '2026');
    fs.mkdirSync(recentLogsDir, { recursive: true });
    fs.writeFileSync(path.join(recentLogsDir, '2026-06-12.md'), [
      '# recent log',
      'ERROR recurring sync failure',
      '',
    ].join('\n'), 'utf8');

    const wake = runCli(['member', 'wake', 'auto-improver', '--json'], { cwd: dir, env });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    const scan = payload.auto_improver.scan;
    assert.equal(scan.log_signals.repeated_failure_count, 1);
    assert.equal(scan.log_signals.repeated_failures[0].count, 6);
    assert.equal(scan.log_signals.repeated_failures[0].evidence.length, 5);
    assert.equal(scan.prevented_fire_candidate.source, 'repeated_failure');
    assert.equal(scan.prevented_fire_candidate.evidence[0].path, 'atris/logs/2026/2026-06-12.md');
    assert.equal(scan.prevented_fire_candidate.evidence[0].date, '2026-06-12');
  } finally {
    cleanupTempDir(dir);
  }
});

test('auto-improver repeated failure ties favor newest evidence', () => {
  const dir = makeTempDir();
  const env = { ATRIS_TASKS_DB: path.join(dir, '.atris', 'tasks.db') };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'auto-improver', '--description="Finds problems before they grow"'], { cwd: dir, env }).status, 0);

    const oldLogsDir = path.join(dir, 'atris', 'logs', '2026');
    fs.mkdirSync(oldLogsDir, { recursive: true });
    fs.writeFileSync(path.join(oldLogsDir, '2026-05-07.md'), [
      '# old log',
      'ERROR recurring alpha failure',
      'ERROR recurring alpha failure',
      '',
    ].join('\n'), 'utf8');

    const recentLogsDir = path.join(dir, 'atris', 'team', 'mission-lead', 'logs');
    fs.mkdirSync(recentLogsDir, { recursive: true });
    fs.writeFileSync(path.join(recentLogsDir, '2026-06-12.md'), [
      '# recent log',
      'ERROR recurring beta failure',
      'ERROR recurring beta failure',
      '',
    ].join('\n'), 'utf8');

    const wake = runCli(['member', 'wake', 'auto-improver', '--json'], { cwd: dir, env });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    const failures = payload.auto_improver.scan.log_signals.repeated_failures;
    assert.equal(failures.length, 2);
    assert.match(failures[0].pattern, /beta/);
    assert.equal(failures[0].count, 2);
    assert.equal(failures[0].evidence[0].date, '2026-06-12');
    assert.match(failures[1].pattern, /alpha/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('auto-improver wake ignores its own summary log residue', () => {
  const dir = makeTempDir();
  const env = { ATRIS_TASKS_DB: path.join(dir, '.atris', 'tasks.db') };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'auto-improver', '--description="Finds problems before they grow"'], { cwd: dir, env }).status, 0);

    const logsDir = path.join(dir, 'atris', 'team', 'auto-improver', 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(path.join(logsDir, '2026-06-13.md'), [
      '# auto-improver log',
      ...Array.from({ length: 11 }, (_, index) => `- summary: CLI-275 adds auto-improver unclear log evidence ${index + 1}`),
      '',
    ].join('\n'), 'utf8');

    const wake = runCli(['member', 'wake', 'auto-improver', '--json'], { cwd: dir, env });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    const scan = payload.auto_improver.scan;
    assert.equal(scan.log_signals.unclear_next_action_count, 0);
    assert.deepEqual(scan.log_signals.unclear_next_actions, []);
    assert.deepEqual(scan.findings.filter((finding) => finding.source === 'unclear_next_actions'), []);
    assert.equal(payload.decision, 'scan_clean');
  } finally {
    cleanupTempDir(dir);
  }
});

test('auto-improver wake ignores blocked-to-ready receipt text', () => {
  const dir = makeTempDir();
  const env = { ATRIS_TASKS_DB: path.join(dir, '.atris', 'tasks.db') };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'auto-improver', '--description="Finds problems before they grow"'], { cwd: dir, env }).status, 0);

    const logsDir = path.join(dir, 'atris', 'logs', '2026');
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(path.join(logsDir, '2026-06-12.md'), [
      '# test log',
      ...Array.from({ length: 11 }, (_, index) => `inspected blocked→ready receipt pair ${index + 1}`),
      'blocked until owner chooses next step',
      '',
    ].join('\n'), 'utf8');

    const wake = runCli(['member', 'wake', 'auto-improver', '--json'], { cwd: dir, env });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    const scan = payload.auto_improver.scan;
    assert.equal(scan.log_signals.unclear_next_action_count, 1);
    assert.equal(scan.log_signals.unclear_next_actions.length, 1);
    assert.equal(scan.log_signals.unclear_next_actions[0].date, '2026-06-12');
    assert.match(scan.log_signals.unclear_next_actions[0].text, /blocked until owner/);
    assert.deepEqual(scan.findings.filter((finding) => finding.source === 'unclear_next_actions'), []);
    assert.equal(payload.decision, 'scan_clean');
  } finally {
    cleanupTempDir(dir);
  }
});

test('auto-improver wake skips journal append on identical no-op repeat', () => {
  const dir = makeTempDir();
  const env = { ATRIS_TASKS_DB: path.join(dir, '.atris', 'tasks.db') };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'auto-improver', '--description="Finds problems before they grow"'], { cwd: dir, env }).status, 0);

    const logsDir = path.join(dir, 'atris', 'logs', '2026');
    fs.mkdirSync(logsDir, { recursive: true });
    const pattern = 'ERROR rsi client expected /api/rsi/improve but backend exposed /api/rsi/tick';
    fs.writeFileSync(path.join(logsDir, '2026-06-07.md'), [
      '# test log',
      `- ${pattern}`,
      `- ${pattern}`,
      `- ${pattern}`,
      '',
    ].join('\n'), 'utf8');

    const wakeOnce = () => {
      const wake = runCli(['member', 'wake', 'auto-improver', '--execute', '--confirm-autonomy-policy', '--json'], { cwd: dir, env });
      assert.equal(wake.status, 0, wake.stderr || wake.stdout);
      return JSON.parse(wake.stdout);
    };

    const first = wakeOnce();   // creates the task → journaled
    assert.equal(first.decision, 'task_created');
    const second = wakeOnce();  // existing actionable task, prevented 0 → journaled (state changed)
    const third = wakeOnce();   // identical no-op repeat → receipt yes, journal no
    assert.equal(third.decision, second.decision);
    assert.equal(third.journal_skipped, 'duplicate_noop');
    assert.equal(third.log_path, null);
    assert.ok(fs.existsSync(third.receipt_path), 'receipt must still be written on skipped journal');

    const projectLogs = fs.readdirSync(logsDir).filter((f) => f.endsWith('.md') && f !== '2026-06-07.md');
    const journalText = projectLogs
      .map((f) => fs.readFileSync(path.join(logsDir, f), 'utf8'))
      .join('\n');
    const entryCount = (journalText.match(/## .* · Auto-improver dogfood scan/g) || []).length;
    assert.equal(entryCount, 2, `expected 2 journal entries (got ${entryCount}):\n${journalText}`);
  } finally {
    cleanupTempDir(dir);
  }
});

test('auto-improver wake ignores declared check verification lines (CLI-199)', () => {
  const dir = makeTempDir();
  const env = { ATRIS_TASKS_DB: path.join(dir, '.atris', 'tasks.db') };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'auto-improver', '--description="Finds problems before they grow"'], { cwd: dir, env }).status, 0);

    // Wiki upkeep sweeps log one verification receipt per recompiled page.
    // These are success records — even when they contain failure-adjacent
    // words — and must never become recurring-failure candidates.
    const wikiDir = path.join(dir, 'atris', 'wiki');
    fs.mkdirSync(wikiDir, { recursive: true });
    const checkLine = '- check: `node bin/atris.js loop --dry-run --json` reports 0 failed pages instead of 13';
    fs.writeFileSync(path.join(wikiDir, 'log.md'), [
      '# wiki log',
      checkLine,
      checkLine,
      checkLine,
      checkLine,
      '',
    ].join('\n'), 'utf8');

    const wake = runCli(['member', 'wake', 'auto-improver', '--json'], { cwd: dir, env });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    const repeated = payload.auto_improver.scan.log_signals.repeated_failures || [];
    assert.deepEqual(
      repeated.filter((failure) => /loop --dry-run/.test(failure.pattern)),
      [],
      'check: verification lines must not count as repeated failures',
    );
  } finally {
    cleanupTempDir(dir);
  }
});

test('simple member alias reuses legacy problem-finding runtime', () => {
  const dir = makeTempDir();
  const env = { ATRIS_TASKS_DB: path.join(dir, '.atris', 'tasks.db') };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'signal-scout', '--description="Turn repeated errors into bounded tasks"'], { cwd: dir, env }).status, 0);
    assert.equal(runCli(['member', 'goal-from-mission', 'problem-finder', '--json'], { cwd: dir, env }).status, 0);

    const logsDir = path.join(dir, 'atris', 'logs', '2026');
    fs.mkdirSync(logsDir, { recursive: true });
    const pattern = 'ERROR alias path failed before problem-finder could scan logs';
    fs.writeFileSync(path.join(logsDir, '2026-06-07.md'), [
      '# test log',
      `- ${pattern}`,
      `- ${pattern}`,
      `- ${pattern}`,
      '',
    ].join('\n'), 'utf8');

    const scriptPath = path.join(dir, 'scripts', 'scan-errors.mjs');
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(scriptPath, `
import { readFileSync } from 'node:fs';
import path from 'node:path';
const rootIndex = process.argv.indexOf('--root');
const root = rootIndex >= 0 ? process.argv[rootIndex + 1] : process.cwd();
const filePath = path.join(root, 'atris', 'logs', '2026', '2026-06-07.md');
const lines = readFileSync(filePath, 'utf8').split(/\\r?\\n/);
const matches = lines.map((line, index) => ({ line, index })).filter((row) => /error|failed|crashed/i.test(row.line));
const selected = { pattern: '${pattern}', count: matches.length, evidence: matches.map((row) => ({ path: 'atris/logs/2026/2026-06-07.md', line: row.index + 1, text: row.line })) };
console.log(JSON.stringify({ ok: true, schema: 'atris.error_scan.v1', threshold: 3, selected, scanned: { files: 1, lines: lines.length, matching_lines: matches.length } }));
`, 'utf8');

    const wake = runCli(['member', 'wake', 'problem-finder', '--execute', '--dry-run', '--json'], { cwd: dir, env });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    assert.equal(payload.mode, 'dry_run');
    assert.equal(payload.decision, 'create_task');
    assert.equal(payload.reason, 'autonomous_error_discovery:log_error_scan');
    assert.match(payload.next_command, /atris task new 'Fix recurring error:/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('wiki-miner wake builds wiki graph and wiki graph queries read it', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'team', 'wiki-miner'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'team', 'wiki-miner', 'MEMBER.md'), [
      '---',
      'name: wiki-miner',
      'role: Knowledge Graph Builder',
      'description: Extracts entities and relationships from wiki using LLM',
      'skills: []',
      'permissions:',
      '  can-read: true',
      '  can-execute: true',
      '  can-approve: false',
      '---',
      '',
      '# Wiki Miner',
      '',
      'Extract entities and relationships from wiki pages.',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'team', 'wiki-miner', 'MISSION.md'), [
      '# Mission',
      '',
      '## North Star',
      '',
      'Maintain cross-domain knowledge graph for AGI reasoning.',
      '',
    ].join('\n'), 'utf8');
    fs.mkdirSync(path.join(dir, 'atris', 'wiki', 'systems'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'wiki', 'systems', 'signals.md'), [
      '# Signal Loop',
      '',
      'signal-scout owns inbound feedback and uses the wiki graph to route AGI work.',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'wiki', '.causal.json'), JSON.stringify({
      schema: 'atris.causal_patterns.v1',
      patterns: [
        { id: 'causal:signal', action: 'signal-scout proof packet', outcome: 'validator accepted proof', outcome_type: 'success' },
      ],
    }, null, 2), 'utf8');

    const wake = runCli(['member', 'wake', 'wiki-miner', '--execute', '--json'], {
      cwd: dir,
      env: {
        ATRIS_WIKI_MINER_LLM_JSON: JSON.stringify({
          entities: [
            { type: 'system', name: 'signal-scout' },
            { type: 'concept', name: 'wiki graph' },
          ],
          relationships: [
            { from: 'signal-scout', to: 'wiki graph', type: 'uses' },
          ],
        }),
      },
    });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    assert.equal(payload.decision, 'wiki_mine');
    assert.equal(payload.executed, true);
    assert.equal(payload.wiki_miner.llm_successful_pages, 1);
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'wiki', '.graph.json')));
    assert.ok(fs.existsSync(payload.receipt_path));
    const receipt = JSON.parse(fs.readFileSync(payload.receipt_path, 'utf8'));
    assert.equal(receipt.schema, 'atris.wiki_miner_tick.v1');
    assert.equal(receipt.pages_succeeded, 1);
    assert.equal(receipt.pages[0].llm_source, 'env_json');

    const graph = JSON.parse(fs.readFileSync(path.join(dir, 'atris', 'wiki', '.graph.json'), 'utf8'));
    assert.ok(graph.entities.some((entity) => entity.name === 'signal-scout' && entity.type === 'system'));
    assert.ok(graph.relationships.some((relationship) => relationship.from === 'signal-scout' && relationship.to === 'wiki graph'));
    assert.equal(graph.causal_patterns.length, 1);
    assert.equal(payload.wiki_miner.causal_pattern_count, 1);

    const related = runCli(['wiki', 'related', 'signal-scout', '--json'], { cwd: dir });
    assert.equal(related.status, 0, related.stderr || related.stdout);
    const relatedPayload = JSON.parse(related.stdout);
    assert.equal(relatedPayload.relationships.length, 1);
    assert.equal(relatedPayload.relationships[0].to, 'wiki graph');

    const entities = runCli(['wiki', 'entities', '--type', 'system', '--json'], { cwd: dir });
    assert.equal(entities.status, 0, entities.stderr || entities.stdout);
    const entitiesPayload = JSON.parse(entities.stdout);
    assert.deepEqual(entitiesPayload.entities.map((entity) => entity.name), ['signal-scout']);
  } finally {
    cleanupTempDir(dir);
  }
});

test('supervisor wake writes recommendations and query reads them', () => {
  const dir = makeTempDir();
  try {
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
    fs.mkdirSync(path.join(dir, 'atris', 'team', 'signal-scout', 'logs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'team', 'signal-scout', 'logs', '2026-06-04.md'), [
      '## 09:00 - Wake',
      '- status: shipped two clean receipts',
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

    const wake = runCli(['member', 'wake', 'supervisor', '--execute', '--json'], {
      cwd: dir,
      env: {
        ATRIS_SUPERVISOR_LLM_JSON: JSON.stringify({
          top_performers: [
            { member: 'signal-scout', reason: 'Recent receipt succeeded quickly and log shows clean handoff.' },
          ],
          bottlenecks: [
            { issue: 'validator waits on proof packets', suggestion: 'Route proof-ready work through signal-scout first.' },
          ],
          recommendations: [
            { type: 'assignment', from: 'validator', to: 'signal-scout', reason: 'Let signal-scout preflight proof packets before validation.' },
          ],
        }),
      },
    });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    assert.equal(payload.decision, 'supervise');
    assert.equal(payload.executed, true);
    assert.equal(payload.supervisor.llm_successful, true);
    assert.equal(payload.supervisor.llm_source, 'env_json');
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'team', 'supervisor', 'recommendations.json')));
    assert.ok(fs.existsSync(payload.receipt_path));

    const receipt = JSON.parse(fs.readFileSync(payload.receipt_path, 'utf8'));
    assert.equal(receipt.schema, 'atris.supervisor_tick.v1');
    assert.equal(receipt.recommendation_count, 1);
    assert.equal(receipt.analysis.top_performers[0].member, 'signal-scout');

    const recommendations = JSON.parse(fs.readFileSync(path.join(dir, 'atris', 'team', 'supervisor', 'recommendations.json'), 'utf8'));
    assert.equal(recommendations.status, 'ok');
    assert.equal(recommendations.recommendations[0].to, 'signal-scout');

    const query = runCli(['member', 'supervisor', 'recommendations', '--json'], { cwd: dir });
    assert.equal(query.status, 0, query.stderr || query.stdout);
    const queryPayload = JSON.parse(query.stdout);
    assert.equal(queryPayload.ok, true);
    assert.equal(queryPayload.recommendations.recommendations[0].reason, 'Let signal-scout preflight proof packets before validation.');
  } finally {
    cleanupTempDir(dir);
  }
});

test('objective-generator wake writes scored proposal and query reads it', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'team', 'objective-generator'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'team', 'objective-generator', 'MEMBER.md'), [
      '---',
      'name: objective-generator',
      'role: Autonomous Objective Setter',
      'description: Identifies high-value problems from world model and proposes objectives',
      'skills: []',
      'permissions:',
      '  can-read: true',
      '  can-execute: true',
      '  can-approve: false',
      '---',
      '',
      '# Objective Generator',
      '',
      'Use world model to identify valuable problems and propose objectives.',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'team', 'objective-generator', 'MISSION.md'), [
      '# Mission',
      '',
      '## North Star',
      '',
      'Identify and prioritize high-value problems autonomously.',
      '',
    ].join('\n'), 'utf8');
    fs.mkdirSync(path.join(dir, 'atris', 'wiki'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'wiki', '.graph.json'), JSON.stringify({
      schema: 'atris.wiki_graph.v1',
      entities: [
        { type: 'system', name: 'signal-scout' },
        { type: 'concept', name: 'proof routing' },
      ],
      relationships: [
        { from: 'signal-scout', to: 'proof routing', type: 'uses' },
      ],
    }, null, 2), 'utf8');
    fs.mkdirSync(path.join(dir, 'atris', 'team', 'supervisor'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'team', 'supervisor', 'recommendations.json'), JSON.stringify({
      schema: 'atris.supervisor_recommendations.v1',
      status: 'ok',
      recommendations: [
        { type: 'assignment', from: 'validator', to: 'signal-scout', reason: 'Preflight proof packets before review.' },
      ],
    }, null, 2), 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'wiki', '.patterns.json'), JSON.stringify({
      schema: 'atris.transfer_patterns.v1',
      patterns: [
        {
          id: 'transfer:proof-routing',
          pattern: 'world graph signal -> proof packet preflight -> validator handoff',
          from_domain: 'coordination',
          transfer_score: 12,
          steps: ['world graph signal', 'proof packet preflight', 'validator handoff'],
        },
      ],
    }, null, 2), 'utf8');

    const wake = runCli(['member', 'wake', 'objective-generator', '--execute', '--json'], {
      cwd: dir,
      env: {
        ATRIS_OBJECTIVE_GENERATOR_LLM_JSON: JSON.stringify({
          proposed_objective: 'Repair proof routing gaps around signal-scout',
          impact_score: 9,
          urgency_score: 8,
          alignment_score: 9,
          justification: 'signal-scout connects world graph evidence to validator handoff quality.',
          suggested_member: 'signal-scout',
          suggested_patterns: [
            { pattern: 'world graph signal -> proof packet preflight -> validator handoff', reason: 'matches proof routing' },
          ],
        }),
      },
    });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    assert.equal(payload.decision, 'generate_objective');
    assert.equal(payload.executed, true);
    assert.equal(payload.objective_generator.llm_successful, true);
    assert.equal(payload.objective_generator.llm_source, 'env_json');
    assert.equal(payload.objective_generator.world_model_used, true);
    assert.equal(payload.objective_generator.transfer_pattern_count, 1);
    assert.equal(payload.objective_generator.task_created, true);
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'team', 'objective-generator', 'proposals.json')));
    assert.ok(fs.existsSync(payload.receipt_path));

    const receipt = JSON.parse(fs.readFileSync(payload.receipt_path, 'utf8'));
    assert.equal(receipt.schema, 'atris.objective_generator_tick.v1');
    assert.equal(receipt.proposal.proposed_objective, 'Repair proof routing gaps around signal-scout');
    assert.equal(receipt.proposal.overall_score, 8.67);
    assert.equal(receipt.proposal.suggested_patterns[0].pattern, 'world graph signal -> proof packet preflight -> validator handoff');
    assert.equal(receipt.created_task.tag, 'auto-objective');

    const proposals = JSON.parse(fs.readFileSync(path.join(dir, 'atris', 'team', 'objective-generator', 'proposals.json'), 'utf8'));
    assert.equal(proposals.status, 'ok');
    assert.equal(proposals.suggested_member, 'signal-scout');
    assert.equal(proposals.suggested_patterns[0].reason, 'matches proof routing');
    assert.equal(proposals.created_task.tag, 'auto-objective');

    const query = runCli(['member', 'objective-generator', 'proposals', '--json'], { cwd: dir });
    assert.equal(query.status, 0, query.stderr || query.stdout);
    const queryPayload = JSON.parse(query.stdout);
    assert.equal(queryPayload.ok, true);
    assert.equal(queryPayload.proposal.proposed_objective, 'Repair proof routing gaps around signal-scout');
  } finally {
    cleanupTempDir(dir);
  }
});

test('objective-generator wake falls back to scored heuristic proposal without llm', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'team', 'objective-generator'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'team', 'objective-generator', 'MEMBER.md'), [
      '---',
      'name: objective-generator',
      'role: Autonomous Objective Setter',
      'description: Identifies high-value problems from world model and proposes objectives',
      'skills: []',
      'permissions:',
      '  can-read: true',
      '  can-execute: true',
      '  can-approve: false',
      '---',
      '',
      '# Objective Generator',
      '',
    ].join('\n'), 'utf8');
    fs.mkdirSync(path.join(dir, 'atris', 'wiki'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'wiki', '.graph.json'), JSON.stringify({
      schema: 'atris.wiki_graph.v1',
      entities: [
        { type: 'concept', name: 'wiki graph' },
        { type: 'system', name: 'signal-scout' },
      ],
      relationships: [
        { from: 'signal-scout', to: 'wiki graph', type: 'uses' },
      ],
    }, null, 2), 'utf8');
    fs.mkdirSync(path.join(dir, 'atris', 'team', 'supervisor'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'team', 'supervisor', 'recommendations.json'), JSON.stringify({
      schema: 'atris.supervisor_recommendations.v1',
      status: 'ok',
      top_performers: [
        { member: 'signal-scout', reason: 'Recent member receipts succeeded and logs show clean handoffs.' },
      ],
      bottlenecks: [
        { issue: 'Review-ready work waits on proof packet routing', suggestion: 'Route proof packet preflight through signal-scout before validator review.' },
      ],
      recommendations: [
        { type: 'assignment', from: 'validator', to: 'signal-scout', reason: 'Let signal-scout preflight proof packets before validation.' },
      ],
    }, null, 2), 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'wiki', '.patterns.json'), JSON.stringify({
      schema: 'atris.transfer_patterns.v1',
      patterns: [
        {
          id: 'transfer:proof-routing',
          pattern: 'world graph signal -> proof packet preflight -> validator handoff',
          from_domain: 'coordination',
          transfer_score: 12,
          steps: ['world graph signal', 'proof packet preflight', 'validator handoff'],
        },
      ],
    }, null, 2), 'utf8');

    const wake = runCli(['member', 'wake', 'objective-generator', '--execute', '--json'], { cwd: dir });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    assert.equal(payload.reason, 'heuristic_objective_proposal_written');
    assert.equal(payload.objective_generator.llm_successful, false);
    assert.equal(payload.objective_generator.llm_error, 'llm_not_configured');
    assert.equal(payload.objective_generator.task_created, false);

    const proposals = JSON.parse(fs.readFileSync(path.join(dir, 'atris', 'team', 'objective-generator', 'proposals.json'), 'utf8'));
    assert.equal(proposals.status, 'ok');
    assert.equal(proposals.proposed_objective, 'Repair proof routing gaps around signal-scout wiki graph handoffs');
    assert.equal(proposals.overall_score, 7);
    assert.equal(proposals.suggested_member, 'signal-scout');
    assert.equal(proposals.suggested_patterns[0].pattern, 'world graph signal -> proof packet preflight -> validator handoff');
  } finally {
    cleanupTempDir(dir);
  }
});

test('objective-generator wake handles empty world model without task creation', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'team', 'objective-generator'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'team', 'objective-generator', 'MEMBER.md'), [
      '---',
      'name: objective-generator',
      'role: Autonomous Objective Setter',
      'description: Identifies high-value problems from world model and proposes objectives',
      'skills: []',
      'permissions:',
      '  can-read: true',
      '  can-execute: true',
      '  can-approve: false',
      '---',
      '',
      '# Objective Generator',
      '',
    ].join('\n'), 'utf8');

    const wake = runCli(['member', 'wake', 'objective-generator', '--execute', '--json'], { cwd: dir });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    assert.equal(payload.reason, 'insufficient_world_model_data');
    assert.equal(payload.objective_generator.world_model_used, false);
    assert.equal(payload.objective_generator.task_created, false);

    const proposals = JSON.parse(fs.readFileSync(path.join(dir, 'atris', 'team', 'objective-generator', 'proposals.json'), 'utf8'));
    assert.equal(proposals.status, 'insufficient_world_model_data');
    assert.match(proposals.justification, /Insufficient world model data/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('generalist wake solves a restaurant domain without project-specific world model', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'team', 'generalist'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'team', 'generalist', 'MEMBER.md'), [
      '---',
      'name: generalist',
      'role: Cross-Domain Problem Solver',
      'description: Applies AGI capabilities to any domain',
      '---',
      '',
      '# Generalist',
      '',
      'Use world model, causal reasoning, and transfer learning to solve problems in any domain.',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'team', 'generalist', 'MISSION.md'), [
      '# Mission',
      '',
      '## North Star',
      '',
      'Prove cross-domain generalization by solving unfamiliar domains with the same AGI loop.',
      '',
      '## How To Choose Goals',
      '',
      '- Pick the next domain proof or reusable operating bottleneck.',
      '',
    ].join('\n'), 'utf8');
    fs.mkdirSync(path.join(dir, 'atris', 'wiki'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'wiki', '.patterns.json'), JSON.stringify({
      schema: 'atris.transfer_patterns.v1',
      patterns: [
        {
          id: 'transfer:ops-bottleneck',
          pattern: 'bottleneck signal -> small controlled intervention -> outcome receipt',
          from_domain: 'operations',
          transfer_score: 11,
          steps: ['measure bottleneck', 'pilot one reversible change', 'review outcome receipt'],
        },
      ],
    }, null, 2), 'utf8');
    fs.writeFileSync(path.join(dir, 'restaurant-domain.md'), [
      '# Restaurant Operations',
      '',
      'A 90-seat neighborhood restaurant has slow seating during Friday dinner.',
      'Hosts manage walk-ins and reservations, servers cover uneven sections, and the kitchen gets order spikes.',
      'The team wants fewer guest complaints, lower wait time, less inventory waste, and no drop in service quality.',
      '',
    ].join('\n'), 'utf8');

    const wake = runCli([
      'member', 'wake', 'generalist',
      '--execute',
      '--domain-file', 'restaurant-domain.md',
      '--domain-name', 'restaurant operations',
      '--json',
    ], { cwd: dir });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    assert.equal(payload.decision, 'cross_domain_generalize');
    assert.equal(payload.executed, true);
    assert.equal(payload.reason, 'heuristic_cross_domain_proof_written');
    assert.equal(payload.generalist.domain_name, 'restaurant operations');
    assert.equal(payload.generalist.domain_agnostic, true);
    assert.equal(payload.generalist.atris_specific_code_required, false);
    assert.equal(payload.generalist.capabilities_used.length, 8);
    assert.equal(payload.generalist.world_model_entities > 0, true);
    assert.equal(payload.generalist.world_model_relationships > 0, true);
    assert.equal(payload.generalist.objective_count > 0, true);
    assert.ok(fs.existsSync(payload.receipt_path));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'team', 'generalist', 'proofs', 'latest.json')));

    const receipt = JSON.parse(fs.readFileSync(payload.receipt_path, 'utf8'));
    assert.equal(receipt.schema, 'atris.generalist_tick.v1');
    assert.equal(receipt.proof.world_model.entities.some((entity) => entity.name === 'kitchen staff'), true);
    assert.match(receipt.top_objective.objective, /Reduce peak-service wait time/);
    assert.equal(receipt.proof.transfer_patterns[0].source_pattern, 'bottleneck signal -> small controlled intervention -> outcome receipt');
    assert.equal(/signal-scout|wiki-miner|objective-generator|Atris/.test(JSON.stringify(receipt.proof)), false);

    const query = runCli(['member', 'generalist', 'proof', '--json'], { cwd: dir });
    assert.equal(query.status, 0, query.stderr || query.stdout);
    const queryPayload = JSON.parse(query.stdout);
    assert.equal(queryPayload.ok, true);
    assert.equal(queryPayload.proof.domain.name, 'restaurant operations');
    assert.equal(queryPayload.proof.capabilities_used.length, 8);
  } finally {
    cleanupTempDir(dir);
  }
});

test('generalist wake scans domain files before existing task evidence', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'team', 'generalist', 'domains'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'team', 'generalist', 'MEMBER.md'), [
      '---',
      'name: generalist',
      'role: Cross-Domain Problem Solver',
      'description: Applies AGI capabilities to any domain',
      '---',
      '',
      '# Generalist',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'team', 'generalist', 'MISSION.md'), [
      '# Mission',
      '',
      '## North Star',
      '',
      'Prove cross-domain generalization by solving unfamiliar domains with the same AGI loop.',
      '',
      '## How To Choose Goals',
      '',
      '- Pick the next domain proof or reusable operating bottleneck.',
      '',
    ].join('\n'), 'utf8');
    assert.equal(runCli(['member', 'goal-from-mission', 'generalist', '--json'], { cwd: dir }).status, 0);
    fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'tasks.projection.json'), JSON.stringify({
      schema: 'atris.task_projection.v1',
      generated_at: '2026-06-05T00:00:00.000Z',
      tasks: [
        {
          id: 'bakery-blocking-task',
          display_id: 'OBL-777',
          title: 'Existing task should wait until bakery domain proof is written',
          status: 'claimed',
          claimed_by: 'generalist',
          metadata: { assigned_to: 'generalist' },
          updated_at: Date.now(),
        },
      ],
    }, null, 2), 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'team', 'generalist', 'domains', 'bakery-operations.md'), [
      '# Bakery Operations',
      '',
      'A neighborhood bakery handles morning pastry demand, custom cake orders, wholesale pickups, oven capacity, proofing time, ingredient inventory, and front-counter queues.',
      'The bakery wants shorter morning wait time, fewer sold-out staples, lower waste, and calmer handoffs between bakers and counter staff.',
      '',
    ].join('\n'), 'utf8');

    const wake = runCli(['member', 'wake', 'generalist', '--execute', '--json'], { cwd: dir });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    assert.equal(payload.decision, 'cross_domain_generalize');
    assert.equal(payload.executed, true);
    assert.equal(payload.generalist.domain_source_path, 'atris/team/generalist/domains/bakery-operations.md');
    assert.match(payload.generalist.domain_name, /Bakery Operations/i);
    assert.equal(payload.generalist.proof.domain.source_path, 'atris/team/generalist/domains/bakery-operations.md');
    assert.equal(payload.generalist.proof.world_model.entities.length > 0, true);
    assert.equal(payload.generalist.proof.objectives.length > 0, true);
    assert.match(payload.generalist.proof_path, /atris\/team\/generalist\/proofs\/bakery-operations-/);
    assert.ok(fs.existsSync(path.join(dir, payload.generalist.proof_path)));
    assert.doesNotMatch(payload.next_command, /task (delegate|note|show|review)/);

    const secondWake = runCli(['member', 'wake', 'generalist', '--json'], { cwd: dir });
    assert.equal(secondWake.status, 0, secondWake.stderr || secondWake.stdout);
    const secondPayload = JSON.parse(secondWake.stdout);
    assert.equal(secondPayload.decision, 'close_loop');
    assert.equal(secondPayload.reason, 'nearest_open_loop:task_projection:OBL-777');
  } finally {
    cleanupTempDir(dir);
  }
});

test('generalist wake learns restaurant pattern and reuses it for healthcare', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'team', 'generalist'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'team', 'generalist', 'MEMBER.md'), [
      '---',
      'name: generalist',
      'role: Cross-Domain Problem Solver',
      'description: Applies AGI capabilities to any domain',
      '---',
      '',
      '# Generalist',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'team', 'generalist', 'MISSION.md'), [
      'North Star: Prove cross-domain generalization by solving unfamiliar domains with the same AGI loop.',
      '',
    ].join('\n'), 'utf8');
    fs.mkdirSync(path.join(dir, 'atris', 'wiki'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'restaurant-domain.md'), [
      '# Restaurant Operations',
      '',
      'A 90-seat restaurant has slow seating during Friday dinner.',
      'Hosts manage walk-ins and reservations, servers cover uneven sections, and the kitchen gets order spikes.',
      'The team wants fewer guest complaints, lower wait time, less inventory waste, and stable service quality.',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(dir, 'healthcare-domain.md'), [
      '# Healthcare Scheduling',
      '',
      'An outpatient clinic has long waits for urgent follow-ups.',
      'Schedulers balance provider calendars, room availability, authorization, urgency, no-show risk, and phone queues.',
      'The clinic wants faster access for high-risk patients, fewer idle slots, and lower staff stress.',
      '',
    ].join('\n'), 'utf8');

    const restaurant = runCli([
      'member', 'wake', 'generalist',
      '--execute',
      '--domain-file', 'restaurant-domain.md',
      '--domain-name', 'restaurant operations',
      '--json',
    ], { cwd: dir });
    assert.equal(restaurant.status, 0, restaurant.stderr || restaurant.stdout);
    const restaurantPayload = JSON.parse(restaurant.stdout);
    assert.equal(restaurantPayload.generalist.cross_domain_learning.reused_pattern_count, 0);
    assert.equal(restaurantPayload.generalist.cross_domain_learning.after_metrics.domains_solved_count, 1);
    assert.equal(restaurantPayload.generalist.cross_domain_learning.after_metrics.pattern_count, 1);
    assert.equal(restaurantPayload.generalist.cross_domain_learning.after_metrics.cross_domain_success_rate, 0);

    const libraryPath = path.join(dir, 'atris', 'wiki', '.cross_domain_patterns.json');
    assert.ok(fs.existsSync(libraryPath));
    const firstLibrary = JSON.parse(fs.readFileSync(libraryPath, 'utf8'));
    assert.equal(firstLibrary.patterns.length, 1);
    assert.deepEqual(firstLibrary.patterns[0].domains, ['restaurant operations']);

    const healthcare = runCli([
      'member', 'wake', 'generalist',
      '--execute',
      '--domain-file', 'healthcare-domain.md',
      '--domain-name', 'healthcare scheduling',
      '--json',
    ], { cwd: dir });
    assert.equal(healthcare.status, 0, healthcare.stderr || healthcare.stdout);
    const healthcarePayload = JSON.parse(healthcare.stdout);
    assert.equal(healthcarePayload.generalist.cross_domain_patterns_scanned, 1);
    assert.equal(healthcarePayload.generalist.cross_domain_pattern_matches.length, 1);
    assert.equal(healthcarePayload.generalist.cross_domain_learning.reused_pattern_count, 1);
    assert.equal(healthcarePayload.generalist.cross_domain_learning.learning_improved, true);
    assert.equal(healthcarePayload.generalist.cross_domain_learning.after_metrics.domains_solved_count, 2);
    assert.equal(healthcarePayload.generalist.cross_domain_learning.after_metrics.cross_domain_pattern_count, 1);
    assert.equal(healthcarePayload.generalist.cross_domain_learning.after_metrics.pattern_reuse_rate, 0.5);
    assert.equal(healthcarePayload.generalist.cross_domain_learning.after_metrics.cross_domain_success_rate, 1);
    assert.match(healthcarePayload.generalist.proof.transfer_patterns[0].reason, /Reused cross-domain pattern/);
    assert.deepEqual(healthcarePayload.generalist.cross_domain_learning.reused_patterns[0].domains_before, ['restaurant operations']);

    const secondLibrary = JSON.parse(fs.readFileSync(libraryPath, 'utf8'));
    assert.equal(secondLibrary.metrics.domains_solved_count, 2);
    assert.equal(secondLibrary.metrics.pattern_reuse_rate, 0.5);
    assert.equal(secondLibrary.metrics.cross_domain_success_rate, 1);
    assert.deepEqual(secondLibrary.patterns[0].domains, ['healthcare scheduling', 'restaurant operations']);
    assert.equal(secondLibrary.patterns[0].domain_count, 2);
    assert.equal(secondLibrary.patterns[0].success_rate, 1);

    const query = runCli(['member', 'generalist', 'patterns', '--json'], { cwd: dir });
    assert.equal(query.status, 0, query.stderr || query.stdout);
    const queryPayload = JSON.parse(query.stdout);
    assert.equal(queryPayload.ok, true);
    assert.equal(queryPayload.library.metrics.domains_solved_count, 2);
    assert.equal(queryPayload.library.patterns[0].domain_count, 2);
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

test('member wake scores strategic objective above low-value nearby loop', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'atris', 'context'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'context', 'agi.md'), 'Cross-domain world model and transfer learning target.\n', 'utf8');
    assert.equal(runCli(['member', 'create', 'command-leader', '--description="Coordinate autonomous AGI foundation loops"'], { cwd: dir }).status, 0);
    assert.equal(runCli([
      'member', 'goal', 'command-leader',
      'Build AGI cross-domain world model from atris/context/agi.md',
      '--acceptance', 'Use atris/context/agi.md to set the next autonomous objective.',
      '--json',
    ], { cwd: dir }).status, 0);
    fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'tasks.projection.json'), JSON.stringify({
      schema: 'atris.task_projection.v1',
      generated_at: '2026-05-06T00:00:00.000Z',
      tasks: [
        {
          id: 'tiny-loop',
          display_id: 'OBL-301',
          title: 'Rename a small helper',
          status: 'claimed',
          claimed_by: 'command-leader',
          metadata: { assigned_to: 'command-leader' },
          updated_at: 1778057000000,
        },
      ],
    }, null, 2), 'utf8');

    const wake = runCli(['member', 'wake', 'command-leader', '--json'], { cwd: dir });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    assert.equal(payload.decision, 'tick');
    assert.equal(payload.reason, 'safe_next_bounded_step');
    assert.equal(payload.evidence.nearest_open_loop.task_ref, 'OBL-301');
    assert.equal(payload.evidence.selected_wake_candidate.decision, 'tick');
    assert.equal(payload.evidence.wake_candidate_scores[0].decision, 'tick');
    assert.ok(payload.evidence.wake_candidate_scores.find((candidate) => candidate.task_ref === 'OBL-301'));
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
      pid: process.pid,
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

    fs.rmSync(path.join(loopStateDir, 'mission-lead.lock.json'), { force: true });
    fs.writeFileSync(path.join(loopStateDir, 'mission-lead.lock.json'), JSON.stringify({
      schema: 'atris.member_loop_lease.v1',
      member: 'mission-lead',
      run_id: 'dead-run',
      pid: 99999999,
      started_at: new Date().toISOString(),
      heartbeat_at: new Date().toISOString(),
      expires_at_ms: Date.now() + 60000,
    }, null, 2));

    const recovered = runCli(['member', 'loop', 'mission-lead', '--ticks', '1', '--interval', '0', '--json'], { cwd: dir });
    assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);
    const recoveredPayload = JSON.parse(recovered.stdout);
    assert.notEqual(recoveredPayload.status, 'skipped');
    assert.notEqual(recoveredPayload.reason, 'loop_already_active');
  } finally {
    cleanupTempDir(dir);
  }
});

test('member alive supports hourly forever contract with a stop command', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'mission-lead', '--description="Make Missions loop safely"'], { cwd: dir }).status, 0);
    assert.equal(runCli([
      'mission', 'start', 'Make Missions loop safely',
      '--owner', 'mission-lead',
      '--json',
    ], { cwd: dir }).status, 0);

    const alive = runCli([
      'member', 'alive', 'mission-lead',
      '--hourly',
      '--forever',
      '--ticks', '1',
      '--json',
    ], { cwd: dir });
    assert.equal(alive.status, 0, alive.stderr || alive.stdout);
    const payload = JSON.parse(alive.stdout);
    assert.equal(payload.action, 'alive');
    assert.equal(payload.cadence, 'hourly');
    assert.equal(payload.forever, true);
    assert.equal(payload.interval_ms, 3600000);
    assert.equal(payload.ticks_requested, 1);
    assert.equal(payload.stop_command, 'atris member alive mission-lead --stop');
    assert.match(payload.operating_contract, /choose useful work/);
    assert.match(payload.operating_contract, /instead of faking activity/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('member alive install dry-run writes hourly cron plan without touching crontab', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'mission-lead', '--description="Make Missions loop safely"'], { cwd: dir }).status, 0);

    const install = runCli([
      'member', 'alive', 'mission-lead',
      '--install',
      '--dry-run',
      '--hourly',
      '--forever',
      '--execute',
      '--confirm-autonomy-policy',
      '--json',
    ], { cwd: dir });
    assert.equal(install.status, 0, install.stderr || install.stdout);
    const payload = JSON.parse(install.stdout);
    assert.equal(payload.action, 'alive_install');
    assert.equal(payload.dry_run, true);
    assert.equal(payload.installed, false);
    assert.equal(payload.cadence, 'hourly');
    assert.equal(payload.forever, true);
    assert.match(payload.crontab_line, /ATRIS_MEMBER_ALIVE_MISSION_LEAD/);
    assert.match(payload.crontab_line, /23 \* \* \* \*/);
    assert.equal(payload.preview.member, 'mission-lead');
    assert.equal(payload.preview.cadence, '23 * * * *');
    assert.match(payload.preview.mission_text, /Run mission-lead on meaningful work/);
    assert.match(payload.preview.run, /member' 'alive' 'mission-lead'/);
    assert.equal(payload.preview.verify, 'atris member alive mission-lead --status --json');
    assert.match(payload.preview.stop_when, /atris member alive mission-lead --uninstall/);
    assert.match(payload.preview.receipts, /\.atris\/state\/member-loops\/logs$/);
    assert.deepEqual(payload.command.slice(-7), [
      '--hourly',
      '--forever',
      '--ticks',
      '1',
      '--json',
      '--execute',
      '--confirm-autonomy-policy',
    ]);
    assert.equal(payload.stop_command, 'atris member alive mission-lead --uninstall');
    assert.ok(fs.existsSync(payload.script_path));
    const script = fs.readFileSync(payload.script_path, 'utf8');
    assert.match(script, /member' 'alive' 'mission-lead'/);
    assert.match(script, /--ticks' '1'/);

    const humanInstall = runCli([
      'member', 'alive', 'mission-lead',
      '--install',
      '--dry-run',
      '--hourly',
      '--forever',
      '--execute',
      '--confirm-autonomy-policy',
    ], { cwd: dir });
    assert.equal(humanInstall.status, 0, humanInstall.stderr || humanInstall.stdout);
    assert.match(humanInstall.stdout, /Every hour this will:/);
    assert.match(humanInstall.stdout, /verify: atris member alive mission-lead --status --json/);
    assert.match(humanInstall.stdout, /receipts: .*\.atris\/state\/member-loops\/logs/);

    const status = runCli(['member', 'alive', 'mission-lead', '--status', '--json'], { cwd: dir });
    assert.equal(status.status, 0, status.stderr || status.stdout);
    const statusPayload = JSON.parse(status.stdout);
    assert.equal(statusPayload.hourly_alive.script_exists, true);
    assert.equal(statusPayload.hourly_alive.installed, false);
    assert.equal(statusPayload.hourly_alive.install_command, 'atris member alive mission-lead --install --hourly --forever --execute --confirm-autonomy-policy --json');
    assert.equal(statusPayload.hourly_alive.uninstall_command, 'atris member alive mission-lead --uninstall');
  } finally {
    cleanupTempDir(dir);
  }
});

test('member alive install blocks execute on dirty git', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runGit(['init', '-q'], dir).status, 0);
    assert.equal(runGit(['config', 'user.email', 'test@example.com'], dir).status, 0);
    assert.equal(runGit(['config', 'user.name', 'Test User'], dir).status, 0);
    assert.equal(runCli(['member', 'create', 'mission-lead', '--description="Make Missions loop safely"'], { cwd: dir }).status, 0);
    assert.equal(runGit(['add', '.'], dir).status, 0);
    assert.equal(runGit(['commit', '-qm', 'baseline'], dir).status, 0);
    fs.writeFileSync(path.join(dir, 'dirty.txt'), 'uncommitted install risk\n');

    const install = runCli([
      'member', 'alive', 'mission-lead',
      '--install',
      '--hourly',
      '--forever',
      '--execute',
      '--confirm-autonomy-policy',
      '--json',
    ], { cwd: dir });
    assert.equal(install.status, 0, install.stderr || install.stdout);
    const payload = JSON.parse(install.stdout);
    assert.equal(payload.action, 'alive_install');
    assert.equal(payload.status, 'blocked');
    assert.equal(payload.reason, 'install_requires_clean_git');
    assert.equal(payload.git.dirty, true);
    assert.ok(payload.git.dirty_files.some((line) => /dirty\.txt/.test(line)));
    assert.equal(payload.preview.verify, 'atris member alive mission-lead --status --json');
    assert.equal(fs.existsSync(payload.preview.receipts), false);
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

test('member block refuses discarded experiments', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'ops'], { cwd: dir }).status, 0);
    assert.equal(runCli(['member', 'goal', 'ops', 'Keep discarded work closed'], { cwd: dir }).status, 0);
    const tick = runCli(['member', 'tick', 'ops', '--json'], { cwd: dir });
    assert.equal(tick.status, 0, tick.stderr || tick.stdout);
    const experimentId = JSON.parse(tick.stdout).experiment.id;

    const discarded = runCli([
      'member', 'review', 'ops', experimentId,
      '--discard',
      '--proof', 'discarded because the experiment was not useful',
      '--json',
    ], { cwd: dir });
    assert.equal(discarded.status, 0, discarded.stderr || discarded.stdout);

    const blocked = runCli([
      'member', 'block', 'ops', experimentId,
      '--reason', 'late blocker',
      '--ask', 'Should not reopen discarded work',
      '--json',
    ], { cwd: dir });
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /already discarded/);

    const state = JSON.parse(fs.readFileSync(path.join(dir, 'atris', 'team', 'ops', 'goals.json'), 'utf8'));
    assert.equal(state.goals[0].experiments.length, 1);
    assert.equal(state.goals[0].experiments[0].status, 'discarded');
    assert.equal(state.goals[0].experiments[0].proof, 'discarded because the experiment was not useful');
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
	    const ack = runCli([
	      'mission', 'goal', 'ack', startPayload.mission.id,
	      '--runtime', 'codex',
	      '--status', 'active',
	      '--objective', 'Make Mission real',
	      '--json',
	    ], { cwd: dir });
	    assert.equal(ack.status, 0, ack.stderr || ack.stdout);

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
      'mission', 'start', 'Bound failed worker attempts',
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
        'mission', 'start', title,
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
    assert.equal(untimedRun.status, 0, untimedRun.stderr || untimedRun.stdout);
    const untimedPayload = JSON.parse(untimedRun.stdout);
    // With max-ticks 1 it is impossible to tick more than once.
    assert.equal(untimedPayload.tick_count, 1);
    assert.equal(untimedPayload.ran_ticks, 1);

    const timed = startMission('timed member run loops for the budget');
    const timedRun = runCli(['member', 'run', 'mission-lead', '--mission-id', timed.id, '--minutes', '10', '--json'], { cwd: dir, env });
    assert.equal(timedRun.status, 0, timedRun.stderr || timedRun.stdout);
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
      'mission', 'start', 'timed run survives allowed rate-limit info',
      '--owner', 'mission-lead',
      '--runner', 'claude',
      '--cadence', 'manual',
      '--verify', 'node -e "process.exit(1)"',
      '--json',
    ], { cwd: dir, env });
    assert.equal(start.status, 0, start.stderr || start.stdout);
    const mission = JSON.parse(start.stdout).mission;

    const run = runCli(['member', 'run', 'mission-lead', '--mission-id', mission.id, '--minutes', '10', '--json'], { cwd: dir, env });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const payload = JSON.parse(run.stdout);
    // The failing verifier is the intended stop; a rate-limit pause after one
    // tick means the allowed-status window info was mistaken for a cooldown.
    assert.notEqual(payload.pause_reason, 'rate-limit-exceeded-wall');
    assert.equal(payload.tick_count, 2);
    assert.equal(payload.pause_reason, 'consecutive-verifier-fails');
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

test('brain compile includes chat scan load pointer when present', () => {
  const dir = makeTempDir();
  try {
    seedBrainWorkspace(dir);
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'chat_scan.latest.json'), JSON.stringify({
      generated_at: '2026-06-28T00:00:00.000Z',
      next_command: 'atris member wake auto-improver --execute --confirm-autonomy-policy',
    }) + '\n', 'utf8');
    const res = runCli(['brain', 'compile', '--root', dir, '--verify'], { cwd: dir });
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

    const res = runCli(['brain', 'compile', '--root', worktreePath, '--verify'], { cwd: worktreePath });
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

    const res = runCli(['brain', 'compile', '--root', dir, '--verify'], { cwd: dir });
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

    const res = runCli(['brain', 'compile', '--root', dir, '--verify'], { cwd: dir });
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

    const compile = runCli(['brain', 'compile', '--root', dir, '--verify'], { cwd: dir });
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
      '--proof', 'node --test test/commands.test.js passed and diff reviewed',
      '--happened', 'Made the approval receipt readable.',
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
    assert.equal(acceptedPayload.episode.review_landing.happened, 'Made the approval receipt readable.');
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
      '--proof', 'node --test test/commands.test.js passed but receipt was vague',
      '--happened', 'Updated the result.',
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
    assert.equal(acceptedCard.review_landing.happened, 'Made the approval receipt readable.');
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
    const compile = runCli(['brain', 'compile', '--root', dir, '--verify'], { cwd: dir });
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

    const compile = runCli(['brain', 'compile', '--root', worktreePath, '--verify'], { cwd: worktreePath });
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

    const res = runCli(['brain', 'activate', '--member', 'executor', '--root', dir, '--verify'], { cwd: dir });
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

    const res = runCli(['brain', 'activate', '--member', 'codex-executor', '--root', dir, '--verify'], { cwd: dir });
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

    const res = runCli(['brain', 'activate', '--member', 'executor', '--root', dir, '--verify'], { cwd: dir });
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

    const res = runCli(['brain', 'activate', '--member', 'launcher', '--root', dir, '--verify'], { cwd: dir });
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
    assert.equal((second.match(/Keep markdown horizon/g) || []).length, 0);
    assert.equal((second.match(/Pending human approval/g) || []).length, 0);
    assert.equal((second.match(/DB state task/g) || []).length, 1);
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
    assert.match(generated, new RegExp(`## Review\\n\\n- \\*\\*\\[${ref}\\]\\*\\* Move review work forward \\[task-plane\\]`));
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
    assert.match(rootHelp.stdout, /atris task capabilities \[--json\]/);
    assert.match(rootHelp.stdout, /atris task capabilities-check \[--json\]/);
    assert.match(rootHelp.stdout, /atris task review-lane-drain \[--json\]/);
    assert.match(rootHelp.stdout, /atris task review-lane-act \[--json\]/);
    assert.match(rootHelp.stdout, /atris task review-lane-loop \[--json\]/);
    assert.match(rootHelp.stdout, /atris task review-lane-run \[--json\]/);
    assert.match(rootHelp.stdout, /atris task reviews \[--all\|--limit <n>\] \[--verbose\]/);
    assert.match(rootHelp.stdout, /atris task current .*--review-state <lane>/);
    assert.match(rootHelp.stdout, /atris task queue .*--review-state <lane>/);
    assert.match(rootHelp.stdout, /atris task current-step .*--review-state <lane>/);
    assert.match(rootHelp.stdout, /review-state lanes: needs-agent, continue-work, human-accept-waiting, certified/);
    assert.doesNotMatch(rootHelp.stdout, /TASK DESK/);

    const eventsHelp = runCli(['task', 'events', '--help'], { cwd: dir });
    assert.equal(eventsHelp.status, 0, eventsHelp.stderr);
    assert.match(eventsHelp.stdout, /atris task events --all/);
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
      '--proof', 'node --test test/commands.test.js passed before review lane drain continuation',
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
      '--proof', 'node --test test/commands.test.js passed before review lane drain human gate',
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
      '--proof', 'node --test test/commands.test.js passed before human-only review lane drain',
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
      '--proof', 'node --test test/commands.test.js passed before review-lane-act review chat',
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
      '--proof', 'node --test test/commands.test.js passed before review-lane-act continuation',
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
      '--proof', 'node --test test/commands.test.js passed before review-lane-act human gate',
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
      '--proof', 'node --test test/commands.test.js passed before review-lane-act chat',
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
      '--proof', 'node --test test/commands.test.js passed before review-lane-act continuation',
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
      '--proof', 'node --test test/commands.test.js passed before review-lane-act human gate',
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
      '--proof', 'node --test test/commands.test.js passed before review-lane-act human only',
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

test('task review-lane-loop runs bounded safe actions and stops before human accept', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex', ATRIS_SKIP_UPDATE_CHECK: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const reviewCreated = runCli([
      'task', 'new', 'Loop should start one review chat and stop on repeat',
      '--tag', 'task',
      '--goal-id', 'OBL-950',
      '--json',
    ], { cwd: dir, env });
    assert.equal(reviewCreated.status, 0, reviewCreated.stderr);
    const reviewTask = JSON.parse(reviewCreated.stdout).task;
    const reviewRef = reviewTask.display_id;
    assert.equal(runCli([
      'task', 'ready', reviewRef,
      '--as', 'codex',
      '--proof', 'node --test test/commands.test.js passed before review-lane-loop chat',
    ], { cwd: dir, env }).status, 0);

    const dryLoop = runCli(['task', 'review-lane-loop', '--goal-id', 'OBL-950', '--max-steps', '3', '--dry-run', '--json'], { cwd: dir, env });
    assert.equal(dryLoop.status, 0, dryLoop.stderr);
    const dryPayload = JSON.parse(dryLoop.stdout);
    assert.equal(dryPayload.ok, true);
    assert.equal(dryPayload.dry_run, true);
    assert.equal(dryPayload.acted_count, 0);
    assert.equal(dryPayload.stopped_reason, 'dry_run_preview');
    assert.equal(dryPayload.steps.length, 1);
    assert.equal(dryPayload.steps[0].decision.step_action, 'review_chat');
    assert.equal(dryPayload.safety.read_only, true);
    assert.equal(dryPayload.safety.human_accept, false);

    const beforeReview = JSON.parse(runCli(['task', 'show', reviewRef, '--json'], { cwd: dir, env }).stdout);
    const liveReviewLoop = runCli(['task', 'review-lane-loop', '--goal-id', 'OBL-950', '--max-steps', '3', '--json'], { cwd: dir, env });
    assert.equal(liveReviewLoop.status, 0, liveReviewLoop.stderr);
    const liveReviewPayload = JSON.parse(liveReviewLoop.stdout);
    assert.equal(liveReviewPayload.ok, true);
    assert.equal(liveReviewPayload.acted_count, 1);
    assert.equal(liveReviewPayload.steps[0].selected_action, 'review_chat');
    assert.equal(liveReviewPayload.steps[0].result.appended, true);
    assert.equal(liveReviewPayload.stopped_reason, 'no_review_lane_action');
    assert.equal(liveReviewPayload.safety.repeat_selection_guard, true);
    const afterReview = JSON.parse(runCli(['task', 'show', reviewRef, '--json'], { cwd: dir, env }).stdout);
    assert.equal(afterReview.current_version, beforeReview.current_version + 1);

    const continueCreated = runCli([
      'task', 'new', 'Loop should continue one certified task and stop on repeat',
      '--tag', 'task',
      '--goal-id', 'OBL-951',
      '--json',
    ], { cwd: dir, env });
    assert.equal(continueCreated.status, 0, continueCreated.stderr);
    const continueTask = JSON.parse(continueCreated.stdout).task;
    const continueRef = continueTask.display_id;
    assert.equal(runCli([
      'task', 'ready', continueRef,
      '--as', 'codex',
      '--proof', 'node --test test/commands.test.js passed before review-lane-loop continuation',
    ], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'review', continueRef,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js passed during review-lane-loop continuation',
      '--next', 'Add a follow-up created by review lane loop',
    ], { cwd: dir, env }).status, 0);

    const waitingCreated = runCli([
      'task', 'new', 'Loop should leave human accept waiting alone',
      '--tag', 'task',
      '--goal-id', 'OBL-951',
      '--json',
    ], { cwd: dir, env });
    assert.equal(waitingCreated.status, 0, waitingCreated.stderr);
    const waitingRef = JSON.parse(waitingCreated.stdout).task.display_id;
    assert.equal(runCli([
      'task', 'ready', waitingRef,
      '--as', 'codex',
      '--proof', 'node --test test/commands.test.js passed before review-lane-loop human gate',
    ], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'review', waitingRef,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js passed during review-lane-loop human gate',
    ], { cwd: dir, env }).status, 0);
    const beforeWaiting = JSON.parse(runCli(['task', 'show', waitingRef, '--json'], { cwd: dir, env }).stdout);

    const liveContinueLoop = runCli(['task', 'review-lane-loop', '--goal-id', 'OBL-951', '--max-steps', '3', '--json'], { cwd: dir, env });
    assert.equal(liveContinueLoop.status, 0, liveContinueLoop.stderr);
    const liveContinuePayload = JSON.parse(liveContinueLoop.stdout);
    assert.equal(liveContinuePayload.ok, true);
    assert.equal(liveContinuePayload.acted_count, 1);
    assert.equal(liveContinuePayload.steps[0].selected_action, 'continue_work');
    assert.ok(liveContinuePayload.steps[0].result.next_task_id);
    assert.equal(liveContinuePayload.stopped_reason, 'human_accept_waiting_is_human_only');
    assert.equal(liveContinuePayload.final_drain.next_action, 'human_accept_waiting');
    assert.equal(liveContinuePayload.final_drain.command, null);
    assert.equal(liveContinuePayload.final_drain.api, null);
    assert.equal(liveContinuePayload.safety.human_accept, false);
    const afterWaiting = JSON.parse(runCli(['task', 'show', waitingRef, '--json'], { cwd: dir, env }).stdout);
    assert.equal(afterWaiting.current_version, beforeWaiting.current_version);

    const humanOnlyCreated = runCli([
      'task', 'new', 'Loop must stop on human-only review rows',
      '--tag', 'task',
      '--goal-id', 'OBL-952',
      '--json',
    ], { cwd: dir, env });
    assert.equal(humanOnlyCreated.status, 0, humanOnlyCreated.stderr);
    const humanOnlyRef = JSON.parse(humanOnlyCreated.stdout).task.display_id;
    assert.equal(runCli([
      'task', 'ready', humanOnlyRef,
      '--as', 'codex',
      '--proof', 'node --test test/commands.test.js passed before review-lane-loop human only',
    ], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'review', humanOnlyRef,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js passed during review-lane-loop human only',
    ], { cwd: dir, env }).status, 0);
    const humanOnlyLoop = runCli(['task', 'review-lane-loop', '--goal-id', 'OBL-952', '--max-steps', '3', '--json'], { cwd: dir, env });
    assert.equal(humanOnlyLoop.status, 0, humanOnlyLoop.stderr);
    const humanOnlyPayload = JSON.parse(humanOnlyLoop.stdout);
    assert.equal(humanOnlyPayload.ok, true);
    assert.equal(humanOnlyPayload.acted_count, 0);
    assert.equal(humanOnlyPayload.stopped_reason, 'human_accept_waiting_is_human_only');
    assert.equal(humanOnlyPayload.final_drain.command, null);
    assert.equal(humanOnlyPayload.final_drain.api, null);
    assert.equal(humanOnlyPayload.safety.human_accept, false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task review-lane-run writes bounded receipts and stops before human accept', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex', ATRIS_SKIP_UPDATE_CHECK: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const continueCreated = runCli([
      'task', 'new', 'Run should continue one certified task and write a receipt',
      '--tag', 'task',
      '--goal-id', 'OBL-953',
      '--json',
    ], { cwd: dir, env });
    assert.equal(continueCreated.status, 0, continueCreated.stderr);
    const continueRef = JSON.parse(continueCreated.stdout).task.display_id;
    assert.equal(runCli([
      'task', 'ready', continueRef,
      '--as', 'codex',
      '--proof', 'node --test test/commands.test.js passed before review-lane-run continuation',
    ], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'review', continueRef,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js passed during review-lane-run continuation',
      '--next', 'Add a follow-up created by review lane run',
    ], { cwd: dir, env }).status, 0);

    const waitingCreated = runCli([
      'task', 'new', 'Run should leave human accept waiting alone',
      '--tag', 'task',
      '--goal-id', 'OBL-953',
      '--json',
    ], { cwd: dir, env });
    assert.equal(waitingCreated.status, 0, waitingCreated.stderr);
    const waitingRef = JSON.parse(waitingCreated.stdout).task.display_id;
    assert.equal(runCli([
      'task', 'ready', waitingRef,
      '--as', 'codex',
      '--proof', 'node --test test/commands.test.js passed before review-lane-run human gate',
    ], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'review', waitingRef,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js passed during review-lane-run human gate',
    ], { cwd: dir, env }).status, 0);

    const realDir = fs.realpathSync(dir);
    const receiptPath = path.join(realDir, '.atris', 'state', 'review-lane-runs.jsonl');
    const latestPath = path.join(realDir, '.atris', 'state', 'review-lane-run.latest.json');
    const dryRun = runCli([
      'task', 'review-lane-run',
      '--goal-id', 'OBL-953',
      '--max-runs', '2',
      '--max-steps', '1',
      '--dry-run',
      '--json',
    ], { cwd: dir, env });
    assert.equal(dryRun.status, 0, dryRun.stderr);
    const dryPayload = JSON.parse(dryRun.stdout);
    assert.equal(dryPayload.ok, true);
    assert.equal(dryPayload.action, 'review_lane_run');
    assert.equal(dryPayload.dry_run, true);
    assert.equal(dryPayload.run_count, 1);
    assert.equal(dryPayload.total_acted_count, 0);
    assert.equal(dryPayload.stopped_reason, 'dry_run_preview');
    assert.equal(dryPayload.receipt_written, false);
    assert.equal(dryPayload.receipt_path, null);
    assert.equal(dryPayload.would_write_receipt_path, receiptPath);
    assert.equal(dryPayload.safety.human_accept, false);
    assert.equal(dryPayload.safety.writes_receipt, false);
    assert.equal(fs.existsSync(receiptPath), false);
    assert.equal(fs.existsSync(latestPath), false);

    const beforeWaiting = JSON.parse(runCli(['task', 'show', waitingRef, '--json'], { cwd: dir, env }).stdout);
    const liveRun = runCli([
      'task', 'review-lane-run',
      '--goal-id', 'OBL-953',
      '--max-runs', '2',
      '--max-steps', '1',
      '--json',
    ], { cwd: dir, env });
    assert.equal(liveRun.status, 0, liveRun.stderr);
    const livePayload = JSON.parse(liveRun.stdout);
    assert.equal(livePayload.ok, true);
    assert.equal(livePayload.dry_run, false);
    assert.equal(livePayload.run_count, 2);
    assert.equal(livePayload.total_acted_count, 1);
    assert.equal(livePayload.runs[0].stopped_reason, 'max_steps_reached');
    assert.equal(livePayload.runs[0].steps[0].selected_action, 'continue_work');
    assert.ok(livePayload.runs[0].steps[0].result.next_task_id);
    assert.equal(livePayload.stopped_reason, 'human_accept_waiting_is_human_only');
    assert.equal(livePayload.stopped_on, 'human_accept_waiting');
    assert.equal(livePayload.receipt_written, true);
    assert.equal(livePayload.receipt_path, receiptPath);
    assert.equal(livePayload.latest_receipt_path, latestPath);
    assert.equal(livePayload.safety.human_accept, false);
    assert.equal(livePayload.safety.writes_receipt, true);
    assert.equal(fs.existsSync(receiptPath), true);
    assert.equal(fs.existsSync(latestPath), true);

    const receiptLines = fs.readFileSync(receiptPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(receiptLines.length, 1);
    assert.equal(receiptLines[0].schema, 'atris.task_review_lane_run.v1');
    assert.equal(receiptLines[0].receipt_written, true);
    assert.equal(receiptLines[0].total_acted_count, 1);
    const latestReceipt = JSON.parse(fs.readFileSync(latestPath, 'utf8'));
    assert.equal(latestReceipt.stopped_reason, 'human_accept_waiting_is_human_only');
    assert.equal(latestReceipt.safety.human_accept, false);

    const afterWaiting = JSON.parse(runCli(['task', 'show', waitingRef, '--json'], { cwd: dir, env }).stdout);
    assert.equal(afterWaiting.current_version, beforeWaiting.current_version);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task review-lane-run does not repeat the same review_chat task across inner loops', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex', ATRIS_SKIP_UPDATE_CHECK: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const created = runCli([
      'task', 'new', 'Run should not duplicate review chat packets',
      '--tag', 'task',
      '--goal-id', 'OBL-954',
      '--json',
    ], { cwd: dir, env });
    assert.equal(created.status, 0, created.stderr);
    const ref = JSON.parse(created.stdout).task.display_id;
    assert.equal(runCli([
      'task', 'ready', ref,
      '--as', 'codex',
      '--proof', 'node --test test/commands.test.js passed before review-lane-run duplicate guard',
    ], { cwd: dir, env }).status, 0);

    const before = JSON.parse(runCli(['task', 'show', ref, '--json'], { cwd: dir, env }).stdout);
    const beforeReviewChats = (before.messages || []).filter(message => /TASK_REVIEW_CHAT/.test(message.content || '')).length;
    const liveRun = runCli([
      'task', 'review-lane-run',
      '--goal-id', 'OBL-954',
      '--max-runs', '3',
      '--max-steps', '1',
      '--json',
    ], { cwd: dir, env });
    assert.equal(liveRun.status, 0, liveRun.stderr);
    const payload = JSON.parse(liveRun.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.run_count, 2);
    assert.equal(payload.total_acted_count, 1);
    assert.equal(payload.runs[0].stopped_reason, 'max_steps_reached');
    assert.equal(payload.runs[0].steps[0].selected_action, 'review_chat');
    assert.equal(payload.runs[1].stopped_reason, 'no_review_lane_action');
    assert.equal(payload.stopped_reason, 'no_review_lane_action');

    const actedTaskIds = payload.runs
      .flatMap(run => run.steps || [])
      .filter(step => step.acted)
      .map(step => step.decision && step.decision.task_id)
      .filter(Boolean);
    assert.deepEqual(actedTaskIds, [before.id]);

    const after = JSON.parse(runCli(['task', 'show', ref, '--json'], { cwd: dir, env }).stdout);
    const afterReviewChats = (after.messages || []).filter(message => /TASK_REVIEW_CHAT/.test(message.content || '')).length;
    assert.equal(after.current_version, before.current_version + 1);
    assert.equal(afterReviewChats, beforeReviewChats + 1);

    const drainAfterChat = runCli(['task', 'review-lane-drain', '--goal-id', 'OBL-954', '--json'], { cwd: dir, env });
    assert.equal(drainAfterChat.status, 0, drainAfterChat.stderr);
    const drainAfterPayload = JSON.parse(drainAfterChat.stdout);
    assert.equal(drainAfterPayload.drain.next_action, 'pending_review_chat');
    assert.equal(drainAfterPayload.drain.safe_for_agent, false);
    assert.equal(drainAfterPayload.drain.command, null);
    assert.equal(drainAfterPayload.drain.reason, 'pending_review_chat_waiting_for_agent_review');
    assert.equal(drainAfterPayload.review_state_actions.pending_review_chat_count, 1);
    assert.equal(drainAfterPayload.review_state_actions.pending_review_chat[0].ref, ref);

    const secondRun = runCli([
      'task', 'review-lane-run',
      '--goal-id', 'OBL-954',
      '--max-runs', '2',
      '--max-steps', '1',
      '--json',
    ], { cwd: dir, env });
    assert.equal(secondRun.status, 0, secondRun.stderr);
    const secondPayload = JSON.parse(secondRun.stdout);
    assert.equal(secondPayload.ok, true);
    // The pending chat is auto-review territory now: the lane attempts the
    // evidence-gated pass, refuses prose-only proof, and excludes the task
    // instead of re-selecting it. No mutation, no repeated chat packets.
    assert.equal(secondPayload.run_count, 2);
    assert.equal(secondPayload.total_acted_count, 0);
    assert.equal(secondPayload.stopped_reason, 'auto_review_no_green_evidence');
    assert.equal(secondPayload.runs[0].steps[0].reason, 'auto_review_no_green_evidence');
    const afterSecondRun = JSON.parse(runCli(['task', 'show', ref, '--json'], { cwd: dir, env }).stdout);
    const afterSecondRunReviewChats = (afterSecondRun.messages || []).filter(message => /TASK_REVIEW_CHAT/.test(message.content || '')).length;
    assert.equal(afterSecondRun.current_version, after.current_version);
    assert.equal(afterSecondRunReviewChats, afterReviewChats);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task review-lane-drain skips continue-work rows with existing follow-up children', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex', ATRIS_SKIP_UPDATE_CHECK: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const freshCreated = runCli([
      'task', 'new', 'Drain should eventually choose this fresh continuation',
      '--tag', 'task',
      '--goal-id', 'OBL-953',
      '--json',
    ], { cwd: dir, env });
    assert.equal(freshCreated.status, 0, freshCreated.stderr);
    const freshRef = JSON.parse(freshCreated.stdout).task.display_id;
    assert.equal(runCli([
      'task', 'ready', freshRef,
      '--as', 'codex',
      '--proof', 'node --test test/commands.test.js passed before fresh drain continuation',
    ], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'review', freshRef,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js passed during fresh drain continuation',
      '--next', 'Add the fresh child selected by review lane drain',
    ], { cwd: dir, env }).status, 0);

    const followedCreated = runCli([
      'task', 'new', 'Drain should skip this already-followed continuation',
      '--tag', 'task',
      '--goal-id', 'OBL-953',
      '--json',
    ], { cwd: dir, env });
    assert.equal(followedCreated.status, 0, followedCreated.stderr);
    const followedRef = JSON.parse(followedCreated.stdout).task.display_id;
    assert.equal(runCli([
      'task', 'ready', followedRef,
      '--as', 'codex',
      '--proof', 'node --test test/commands.test.js passed before followed drain continuation',
    ], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'review', followedRef,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js passed during followed drain continuation',
      '--next', 'Add the already-created child skipped by review lane drain',
    ], { cwd: dir, env }).status, 0);
    const followedContinue = runCli(['task', 'continue-work', followedRef, '--as', 'codex', '--json'], { cwd: dir, env });
    assert.equal(followedContinue.status, 0, followedContinue.stderr);
    const followedContinuePayload = JSON.parse(followedContinue.stdout);
    assert.equal(followedContinuePayload.created, true);

    assert.equal(runCli([
      'task', 'review', followedRef,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js passed during retitled followed drain continuation',
      '--next', 'Add a newer child title after the first follow-up already exists',
    ], { cwd: dir, env }).status, 0);
    const followedRetitledContinue = runCli(['task', 'continue-work', followedRef, '--as', 'codex', '--json'], { cwd: dir, env });
    assert.equal(followedRetitledContinue.status, 0, followedRetitledContinue.stderr);
    const followedRetitledPayload = JSON.parse(followedRetitledContinue.stdout);
    assert.equal(followedRetitledPayload.created, false);
    assert.equal(followedRetitledPayload.next_task_id, followedContinuePayload.next_task_id);

    const db = taskStore.open(dbPath);
    assert.equal(taskStore.doneTask(db, {
      id: followedContinuePayload.next_task_id,
      actor: 'codex',
    }).updated, true);
    const workspaceRoot = fs.realpathSync(dir);
    for (let i = 0; i < 9; i += 1) {
      const filler = taskStore.addTask(db, {
        title: `Projection filler done child ${i}`,
        workspaceRoot,
        status: 'done',
      });
      assert.equal(filler.inserted, true);
    }
    taskStore.close();

    const drain = runCli(['task', 'review-lane-drain', '--goal-id', 'OBL-953', '--json'], { cwd: dir, env });
    assert.equal(drain.status, 0, drain.stderr);
    const payload = JSON.parse(drain.stdout);
    assert.equal(payload.drain.next_action, 'continue_work');
    assert.equal(payload.drain.task.ref, freshRef);
    assert.match(payload.drain.command, new RegExp(`continue-work ${freshRef}`));
    assert.equal(payload.review_state_counts.continue_work, 1);
    assert.equal(payload.review_state_counts.human_accept_waiting, 1);
    assert.equal(payload.review_state_actions.continue_work.ref, freshRef);
    assert.equal(payload.review_state_actions.skipped_continue_work_with_follow_up_count, 1);
    assert.equal(payload.review_state_actions.skipped_continue_work_with_follow_up[0].ref, followedRef);
    assert.equal(payload.review_state_actions.skipped_continue_work_with_follow_up[0].next_action, 'human_accept_waiting');
    assert.equal(payload.review_state_actions.skipped_continue_work_with_follow_up[0].command, null);
    assert.equal(payload.review_state_actions.skipped_continue_work_with_follow_up[0].continue_work_command, undefined);

    const status = runCli(['task', 'status', '--json'], { cwd: dir, env });
    assert.equal(status.status, 0, status.stderr);
    const statusPayload = JSON.parse(status.stdout);
    assert.equal(statusPayload.status.counts.review_continue_work, 1);
    assert.equal(statusPayload.status.counts.review_human_accept_waiting, 1);
    assert.equal(statusPayload.status.review_actions.continue_work.count, 1);
    assert.equal(statusPayload.status.review_actions.continue_work.first.ref, freshRef);
    assert.match(statusPayload.status.review_actions.continue_work.first.command, new RegExp(`continue-work ${freshRef}`));
    assert.equal(statusPayload.status.review_actions.human_accept_waiting.count, 1);
    assert.equal(statusPayload.status.review_actions.human_accept_waiting.first.ref, followedRef);
    assert.equal(statusPayload.status.review_actions.human_accept_waiting.first.command, null);

    const followedCurrent = runCli([
      'task', 'current',
      '--goal-id', 'OBL-953',
      '--review-state', 'human-accept-waiting',
      '--json',
    ], { cwd: dir, env });
    assert.equal(followedCurrent.status, 0, followedCurrent.stderr);
    const followedCurrentPayload = JSON.parse(followedCurrent.stdout);
    assert.equal(followedCurrentPayload.current.review_state_actions.human_accept_waiting.ref, followedRef);
    assert.equal(followedCurrentPayload.current.review_state_actions.human_accept_waiting.command, null);
    assert.equal(followedCurrentPayload.current.review_state_actions.human_accept_waiting.continue_work_command, undefined);
  } finally {
    taskStore.close();
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

test('task delegate infers a functional owner when none is supplied', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const delegated = runCli([
      'task',
      'delegate',
      'Design 24/7 functional team member factory',
      '--tag',
      'team-members',
      '--json',
    ], { cwd: dir, env });
    assert.equal(delegated.status, 0, delegated.stderr);
    const body = JSON.parse(delegated.stdout);
    assert.equal(body.owner, 'architect');
    assert.equal(body.task.assigned_to, 'architect');
    assert.equal(body.task.metadata.owner_resolution, 'inferred_by_task_signal');
    assert.equal(body.executed_by, null);
    assert.match(body.handoff.command, /^atris task claim [A-Z0-9]{3}-1 --as architect$/);
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
    assert.equal(body.owner, 'mission-lead');
    assert.equal(body.executed_by, 'codex');
    assert.equal(body.task.assigned_to, 'mission-lead');
    assert.equal(body.task.metadata.executed_by, 'codex');
    assert.equal(body.task.metadata.requested_owner, 'codex');
    assert.equal(body.task.metadata.owner_resolution, 'engine_owner_resolved_by_task_signal');
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
      'Win condition: one proof-backed useful rep.',
      '--json',
    ], { cwd: dir, env });
    assert.equal(delegated.status, 0, delegated.stderr);

    const play = runCli(['play', '--as', 'justin'], { cwd: dir, env: { ...env, USER: 'keshav' } });
    assert.equal(play.status, 0, play.stderr);
    assert.match(play.stdout, /AgentXP Mode/);
    assert.match(play.stdout, /Player justin/);
    assert.match(play.stdout, /Handle source: --as\/--player\./);
    assert.match(play.stdout, /AgentXP Mode first rep/);
    assert.match(play.stdout, /Win condition: one proof-backed useful rep/);
    assert.match(play.stdout, /atris task claim [A-Z0-9]{3}-1 --as justin/);
    assert.match(play.stdout, /atris task ready [A-Z0-9]{3}-1 --as justin --proof/);
    assert.match(play.stdout, /atris xp card --local/);
    assert.match(play.stdout, /atris xp sync --local --token <owner-provided-token>/);
    assert.match(play.stdout, /atris login/);
    assert.match(play.stdout, /atris xp sync --local/);
    assert.match(play.stdout, /Leaderboard: https:\/\/api\.atris\.ai\/api\/agentxp\/leaderboard/);
    assert.match(play.stdout, /Proof recipe:/);
    assert.match(play.stdout, /Ready proof:/);

    const json = runCli(['play', '--as', 'justin', '--json'], { cwd: dir, env: { ...env, USER: 'keshav' } });
    assert.equal(json.status, 0, json.stderr);
    const body = JSON.parse(json.stdout);
    assert.equal(body.schema, 'atris.agentxp_play_mode.v1');
    assert.equal(body.player, 'justin');
    assert.equal(body.player_source, 'flag');
    assert.equal(body.mission.title, 'AgentXP Mode first rep');
    assert.equal(body.mission.assigned_to, 'justin');
    assert.equal(body.global_sync_rule, 'Run atris login, then sync. Owner-provided sync tokens are guided-demo fallback only.');
    assert.equal(body.leaderboard_url, 'https://api.atris.ai/api/agentxp/leaderboard');
    assert.match(body.proof_recipe.verifier, /test -s AGENTXP_PROOF\.md/);
    assert.match(body.proof_recipe.solo_review_rule, /solo public smoke/);
    assert.equal(body.next_commands[0], `atris task claim ${body.mission.ref} --as justin`);
    assert.ok(
      body.next_commands.indexOf('atris login')
        < body.next_commands.indexOf('atris xp sync --local --token <owner-provided-token>')
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
    assert.match(play.stdout, /Handle source: inferred\. To choose one, run atris play --as <handle> or ATRIS_PLAYER=<handle> atris play\./);
    assert.match(play.stdout, /Starter mission created locally/);
    assert.match(play.stdout, /AgentXP Mode first rep: complete one proof-backed useful mission/);
    assert.match(play.stdout, /atris task claim [A-Z0-9]{3}-1 --as justin/);

    const json = runCli(['play', '--json'], { cwd: dir, env });
    assert.equal(json.status, 0, json.stderr);
    const body = JSON.parse(json.stdout);
    assert.equal(body.player, 'justin');
    assert.equal(body.player_source, 'local_user_team_match');
    assert.equal(body.seeded, null);
    assert.equal(body.mission.assigned_to, 'justin');
    assert.equal(body.mission.title, 'AgentXP Mode first rep: complete one proof-backed useful mission');
    assert.doesNotMatch(body.mission.prompt, /Do not self-accept/);
    assert.match(body.mission.prompt, /weak proof should be revised/);
    assert.match(body.proof_recipe.ready_proof, /atris task ready/);

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
    assert.equal(body.seeded.title, 'AgentXP Mode first rep: complete one proof-backed useful mission');
    assert.equal(body.mission.assigned_to, 'justin');
    assert.deepEqual(body.next_commands.slice(0, 2), [
      `atris task claim ${body.mission.ref} --as justin`,
      `atris task ready ${body.mission.ref} --as justin --proof "AGENTXP_PROOF.md + test -s AGENTXP_PROOF.md passed"`,
    ]);
    assert.match(body.proof_recipe.artifact, /AGENTXP_PROOF\.md/);
    assert.equal(body.next_commands.includes('atris xp sync --local --token <owner-provided-token>'), true);
    assert.equal(body.next_commands.includes('atris login'), true);
    assert.equal(body.next_commands.includes('atris xp sync --local'), true);
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
    assert.equal(runCli(['task', 'done', ref, '--proof', 'node --test test/commands.test.js passed'], { cwd: dir, env }).status, 0);

    const review = runCli([
      'task', 'review', ref,
      '--reward', '1',
      '--lesson', 'Small task events compound',
      '--next', 'Sync task events to Swarlo',
      '--proof', 'npm test',
      '--as', 'codex',
    ], { cwd: dir, env });
    assert.equal(review.status, 0, review.stderr);
    assert.match(review.stdout, new RegExp(`reviewed ${ref} v4 reward=1`));
    assert.match(review.stdout, /next: Sync task events to Swarlo/);

    const events = runCli(['task', 'events', ref], { cwd: dir, env });
    assert.equal(events.status, 0, events.stderr);
    assert.match(events.stdout, new RegExp(`4\\treviewed\\t${ref}`));

    const episodePath = path.join(dir, '.atris', 'state', 'task_episodes.jsonl');
    const episodes = fs.readFileSync(episodePath, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.equal(episodes.length, 2);
    const episode = episodes.at(-1);
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
      landing_completeness: 0,
      approval_status: 'accepted',
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

    const add = runCli(['task', 'add', 'Validate proof persistence', '--tag', 'rsi'], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const id = add.stdout.trim().split('\t')[0];

    const done = runCli([
      'task', 'done', id,
      '--proof', 'task show validation passed',
      '--lesson', 'done with proof should unlock review state',
      '--json',
    ], { cwd: dir, env });
    assert.equal(done.status, 0, done.stderr);
    const donePayload = JSON.parse(done.stdout);
    assert.equal(donePayload.reviewed, true);
    assert.equal(donePayload.reward, 1);
    assert.equal(donePayload.episode.proof, 'task show validation passed');
    assert.equal(donePayload.episode.lesson, 'done with proof should unlock review state');
    assert.equal(donePayload.episode.career_xp.eligible, false);
    assert.equal(donePayload.xp_projection.total_xp, 0);
    assert.equal(donePayload.xp_projection.collected_receipts, 0);
    assert.equal(
      donePayload.xp_projection.earning_model.policies.task_done_with_proof,
      'Records proof for review and RL context; emits no Career XP receipt until human accept.',
    );

    const show = runCli(['task', 'show', id, '--json'], { cwd: dir, env });
    assert.equal(show.status, 0, show.stderr);
    const task = JSON.parse(show.stdout);
    assert.equal(task.status, 'done');
    assert.deepEqual(task.events.map(e => e.event_type), ['created', 'completed', 'reviewed']);
    assert.equal(task.review.proof, 'task show validation passed');
    assert.equal(task.review.reward, 1);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task plan and do record an explicit headless stage contract', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const add = runCli(['task', 'add', 'Make task stage loop explicit', '--tag', 'capture', '--json'], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const ref = JSON.parse(add.stdout).task.display_id;

    const unplannedDo = runCli(['task', 'do', ref, '--as', 'codex', '--first-move', 'patch the CLI', '--json'], { cwd: dir, env });
    assert.equal(unplannedDo.status, 1);
    assert.equal(JSON.parse(unplannedDo.stdout).reason, 'goal_required');

    const inlineDoTask = runCli(['task', 'add', 'Inline do must not skip plan', '--tag', 'capture', '--json'], { cwd: dir, env });
    assert.equal(inlineDoTask.status, 0, inlineDoTask.stderr);
    const inlineDoRef = JSON.parse(inlineDoTask.stdout).task.display_id;
    const inlineDo = runCli([
      'task', 'do', inlineDoRef,
      '--as', 'codex',
      '--goal', 'Try to skip the plan',
      '--proof-needed', 'node --test should not run yet',
      '--first-move', 'start too early',
      '--json',
    ], { cwd: dir, env });
    assert.equal(inlineDo.status, 1);
    assert.equal(JSON.parse(inlineDo.stdout).reason, 'plan_required');

    const owned = runCli(['task', 'add', 'Do not plan another owner task', '--tag', 'capture', '--json'], { cwd: dir, env });
    assert.equal(owned.status, 0, owned.stderr);
    const ownedRef = JSON.parse(owned.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', ownedRef, '--as', 'alice'], { cwd: dir, env }).status, 0);
    const otherOwnerPlan = runCli([
      'task', 'plan', ownedRef,
      '--as', 'codex',
      '--goal', 'Change someone else task',
      '--exit', 'should be rejected',
      '--proof-needed', 'should be rejected',
      '--json',
    ], { cwd: dir, env });
    assert.equal(otherOwnerPlan.status, 1);
    assert.equal(JSON.parse(otherOwnerPlan.stdout).reason, 'claimed_by_other');

    const otherOwnerPlanWithAssignee = runCli([
      'task', 'plan', ownedRef,
      '--as', 'codex',
      '--owner', 'alice',
      '--goal', 'Rewrite by naming the claimant',
      '--exit', 'should be rejected',
      '--proof-needed', 'should be rejected',
      '--json',
    ], { cwd: dir, env });
    assert.equal(otherOwnerPlanWithAssignee.status, 1);
    assert.equal(JSON.parse(otherOwnerPlanWithAssignee.stdout).reason, 'claimed_by_other');

    const claimedAfterPlan = runCli(['task', 'add', 'Do not start after external claim', '--tag', 'capture', '--json'], { cwd: dir, env });
    assert.equal(claimedAfterPlan.status, 0, claimedAfterPlan.stderr);
    const claimedAfterPlanRef = JSON.parse(claimedAfterPlan.stdout).task.display_id;
    const claimedAfterPlanStage = runCli([
      'task', 'plan', claimedAfterPlanRef,
      '--as', 'codex',
      '--owner', 'codex',
      '--goal', 'Keep planned owner aligned',
      '--exit', 'claim owner and plan owner agree',
      '--proof-needed', 'node --test task stage coverage passes',
      '--json',
    ], { cwd: dir, env });
    assert.equal(claimedAfterPlanStage.status, 0, claimedAfterPlanStage.stderr);
    assert.equal(runCli(['task', 'claim', claimedAfterPlanRef, '--as', 'alice'], { cwd: dir, env }).status, 0);
    const claimedConflictDo = runCli([
      'task', 'do', claimedAfterPlanRef,
      '--as', 'codex',
      '--first-move', 'start despite external claim',
      '--json',
    ], { cwd: dir, env });
    assert.equal(claimedConflictDo.status, 1);
    assert.equal(JSON.parse(claimedConflictDo.stdout).reason, 'claimed_by_other');

    const missingExit = runCli(['task', 'plan', ref, '--goal', 'Ship task stage CLI', '--proof-needed', 'node --test commands passed', '--json'], { cwd: dir, env });
    assert.equal(missingExit.status, 1);
    assert.equal(JSON.parse(missingExit.stdout).reason, 'exit_required');

    const planned = runCli([
      'task', 'plan', ref,
      '--as', 'codex',
      '--goal', 'Ship task stage CLI',
      '--summary', 'Add durable Plan and Do stage commands',
      '--owner', 'codex',
      '--exit', 'task can enter Review with command-backed proof',
      '--proof-needed', 'node --test test/commands.test.js passes for task stage commands',
      '--first-move', 'patch task-db stageTask',
      '--confidence', '0.9',
      '--json',
    ], { cwd: dir, env });
    assert.equal(planned.status, 0, planned.stderr);
    const plannedPayload = JSON.parse(planned.stdout);
    assert.equal(plannedPayload.action, 'planned');
    assert.equal(plannedPayload.task.status, 'open');
    assert.equal(plannedPayload.task.objective, 'Ship task stage CLI');
    assert.equal(plannedPayload.task.metadata.stage, 'plan');
    assert.equal(plannedPayload.task.metadata.verify, 'node --test test/commands.test.js passes for task stage commands');
    assert.match(plannedPayload.stage_packet, /TASK_STAGE_UPDATE/);
    assert.match(plannedPayload.stage_packet, /stage: plan/);
    assert.match(plannedPayload.stage_packet, /goal: Ship task stage CLI/);
    assert.match(plannedPayload.stage_packet, /proof_needed: node --test test\/commands\.test\.js passes for task stage commands/);

    const wrongOwnerDo = runCli([
      'task', 'do', ref,
      '--as', 'bob',
      '--first-move', 'take over another owner plan',
      '--json',
    ], { cwd: dir, env });
    assert.equal(wrongOwnerDo.status, 1);
    assert.equal(JSON.parse(wrongOwnerDo.stdout).reason, 'claimed_by_other');

    const rewritePlanDo = runCli([
      'task', 'do', ref,
      '--as', 'codex',
      '--goal', 'Rewrite the recorded plan',
      '--proof-needed', 'weaker proof',
      '--first-move', 'start from rewritten text',
      '--json',
    ], { cwd: dir, env });
    assert.equal(rewritePlanDo.status, 1);
    assert.equal(JSON.parse(rewritePlanDo.stdout).reason, 'plan_goal_mismatch');

    const exitMismatchDo = runCli([
      'task', 'do', ref,
      '--as', 'codex',
      '--exit', 'different review boundary',
      '--first-move', 'start with changed exit',
      '--json',
    ], { cwd: dir, env });
    assert.equal(exitMismatchDo.status, 1);
    assert.equal(JSON.parse(exitMismatchDo.stdout).reason, 'plan_exit_mismatch');

    const showPlanned = runCli(['task', 'show', ref, '--json'], { cwd: dir, env });
    assert.equal(showPlanned.status, 0, showPlanned.stderr);
    const plannedTask = JSON.parse(showPlanned.stdout);
    assert.equal(plannedTask.latest_event_type, 'task_planned');
    assert.equal(plannedTask.history.message_count, 1);
    assert.match(plannedTask.messages[0].content, /TASK_STAGE_UPDATE/);
    assert.match(plannedTask.messages[0].content, /exit: task can enter Review with command-backed proof/);

    const statusAfterPlan = runCli(['task', 'status', '--json'], { cwd: dir, env });
    assert.equal(statusAfterPlan.status, 0, statusAfterPlan.stderr);
    assert.equal(JSON.parse(statusAfterPlan.stdout).status.counts.plan, 1);

    const doing = runCli([
      'task', 'do', ref,
      '--as', 'codex',
      '--summary', 'Start from the recorded plan',
      '--first-move', 'run the focused command tests',
      '--json',
    ], { cwd: dir, env });
    assert.equal(doing.status, 0, doing.stderr);
    const doingPayload = JSON.parse(doing.stdout);
    assert.equal(doingPayload.action, 'doing');
    assert.equal(doingPayload.task.status, 'claimed');
    assert.equal(doingPayload.task.claimed_by, 'codex');
    assert.equal(doingPayload.task.metadata.stage, 'do');
    assert.match(doingPayload.stage_packet, /stage: do/);
    assert.doesNotMatch(doingPayload.stage_packet, /confidence:/);
    assert.match(doingPayload.stage_packet, /first_move: run the focused command tests/);

    const showDoing = runCli(['task', 'show', ref, '--json'], { cwd: dir, env });
    assert.equal(showDoing.status, 0, showDoing.stderr);
    const doingTask = JSON.parse(showDoing.stdout);
    assert.equal(doingTask.latest_event_type, 'work_started');
    assert.equal(doingTask.messages.length, 2);
    assert.match(doingTask.messages.at(-1).content, /stage: do/);

    const ready = runCli(['task', 'ready', ref, '--as', 'codex', '--proof', 'node --test test/commands.test.js passed for task stage commands', '--json'], { cwd: dir, env });
    assert.equal(ready.status, 0, ready.stderr);
    const readyPayload = JSON.parse(ready.stdout);
    assert.equal(readyPayload.task.status, 'review');
    assert.equal(readyPayload.task.review.proof, 'node --test test/commands.test.js passed for task stage commands');
    assert.equal(readyPayload.task.review.verification_chat.schema, 'atris.task_review_chat.v1');
  } finally {
    cleanupTempDir(dir);
  }
});

test('task do reloads latest plan metadata after claiming an open task', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const taskDb = require('../lib/task-db');
  taskDb.close();
  try {
    fs.mkdirSync(path.join(dir, 'project-obelisk', 'atris'), { recursive: true });
    const db = taskDb.open(dbPath);
    const workspaceRoot = fs.realpathSync(path.join(dir, 'project-obelisk'));
    const created = taskDb.addTask(db, {
      title: 'Use freshest plan during Do claim',
      tag: 'capture',
      workspaceRoot,
    });
    const planned = taskDb.stageTask(db, {
      id: created.id,
      actor: 'codex',
      stage: 'plan',
      goal: 'Old plan goal',
      exit: 'old exit',
      proofNeeded: 'old proof',
      firstMove: 'old first move',
    });
    assert.equal(planned.staged, true);

    db.prepare(`
      CREATE TRIGGER refresh_plan_after_stage_claim
      AFTER UPDATE OF status ON tasks
      WHEN NEW.id = '${created.id}' AND OLD.status = 'open' AND NEW.status = 'claimed'
      BEGIN
        UPDATE tasks
           SET updated_at = 4102444800000,
               metadata = '{"stage":"plan","planned_at":"fresh-plan","stage_plan_recorded_at":"fresh-plan","goal_objective":"Fresh plan goal","stage_goal":"Fresh plan goal","exit_condition":"fresh exit","verify":"fresh proof","proof_needed":"fresh proof","first_move":"fresh first move","next_button":"Start do"}'
         WHERE id = NEW.id;
      END
    `).run();

    const doing = taskDb.stageTask(db, {
      id: created.id,
      actor: 'codex',
      stage: 'do',
      firstMove: 'run the freshest plan',
    });
    assert.equal(doing.staged, true);
    assert.match(doing.stage_packet, /goal: Fresh plan goal/);
    assert.match(doing.stage_packet, /exit: fresh exit/);
    assert.match(doing.stage_packet, /proof_needed: fresh proof/);

    const updated = taskDb.getTask(db, created.id);
    assert.equal(updated.status, 'claimed');
    assert.equal(updated.metadata.stage, 'do');
    assert.equal(updated.metadata.goal_objective, 'Fresh plan goal');
    assert.equal(updated.metadata.exit_condition, 'fresh exit');
    assert.equal(updated.metadata.verify, 'fresh proof');
    assert.equal(updated.metadata.next_button, 'Move to review');
    assert.ok(updated.updated_at > 4102444800000);
    const events = taskDb.listTaskEvents(db, { taskId: created.id });
    const workStarted = events.find(event => event.event_type === 'work_started');
    assert.equal(workStarted.payload.goal, 'Fresh plan goal');
  } finally {
    taskDb.close();
    cleanupTempDir(dir);
  }
});

test('task do rolls back the claim when plan ownership changes during claim', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const taskDb = require('../lib/task-db');
  taskDb.close();
  try {
    fs.mkdirSync(path.join(dir, 'project-obelisk', 'atris'), { recursive: true });
    const db = taskDb.open(dbPath);
    const workspaceRoot = fs.realpathSync(path.join(dir, 'project-obelisk'));
    const created = taskDb.addTask(db, {
      title: 'Do should not keep a stale claim',
      tag: 'capture',
      workspaceRoot,
    });
    const planned = taskDb.stageTask(db, {
      id: created.id,
      actor: 'codex',
      stage: 'plan',
      owner: 'codex',
      goal: 'Old plan goal',
      exit: 'old exit',
      proofNeeded: 'old proof',
    });
    assert.equal(planned.staged, true);

    db.prepare(`
      CREATE TRIGGER reassign_plan_after_stage_claim
      AFTER UPDATE OF status ON tasks
      WHEN NEW.id = '${created.id}' AND OLD.status = 'open' AND NEW.status = 'claimed'
      BEGIN
        UPDATE tasks
           SET updated_at = 4102444800000,
               metadata = '{"stage":"plan","planned_at":"fresh-plan","stage_plan_recorded_at":"fresh-plan","stage_owner":"alice","assigned_to":"alice","goal_objective":"Fresh plan goal","stage_goal":"Fresh plan goal","exit_condition":"fresh exit","verify":"fresh proof","proof_needed":"fresh proof","next_button":"Start do"}'
         WHERE id = NEW.id;
      END
    `).run();

    const doing = taskDb.stageTask(db, {
      id: created.id,
      actor: 'codex',
      stage: 'do',
      firstMove: 'start from stale owner',
    });
    assert.equal(doing.staged, false);
    assert.equal(doing.reason, 'claimed_by_other');
    assert.equal(doing.claimed_by, 'alice');

    const updated = taskDb.getTask(db, created.id);
    assert.equal(updated.status, 'open');
    assert.equal(updated.claimed_by, null);
    assert.equal(updated.metadata.stage, 'plan');
    assert.equal(updated.metadata.stage_owner, 'alice');
    assert.ok(updated.updated_at > 4102444800000);
    const eventTypes = taskDb.listTaskEvents(db, { taskId: created.id }).map(event => event.event_type);
    assert.deepEqual(eventTypes, ['created', 'task_planned']);
  } finally {
    taskDb.close();
    cleanupTempDir(dir);
  }
});

test('task do lets current claimant override stale plan owner metadata', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const taskDb = require('../lib/task-db');
  taskDb.close();
  try {
    fs.mkdirSync(path.join(dir, 'project-obelisk', 'atris'), { recursive: true });
    const db = taskDb.open(dbPath);
    const workspaceRoot = fs.realpathSync(path.join(dir, 'project-obelisk'));
    const created = taskDb.addTask(db, {
      title: 'Do should trust the current claimant',
      tag: 'capture',
      workspaceRoot,
      status: 'claimed',
      claimedBy: 'agi-research',
      metadata: {
        stage: 'plan',
        planned_at: 'old-plan',
        stage_plan_recorded_at: 'old-plan',
        stage_owner: 'keshavrao',
        assigned_to: 'keshavrao',
        goal_objective: 'Ship the claimed task',
        stage_goal: 'Ship the claimed task',
        exit_condition: 'Do starts under the actual claimant',
        verify: 'node --test task do ownership coverage',
        proof_needed: 'node --test task do ownership coverage',
        next_button: 'Start do',
      },
    });

    const doing = taskDb.stageTask(db, {
      id: created.id,
      actor: 'agi-research',
      stage: 'do',
      firstMove: 'continue from the claimed row',
    });
    assert.equal(doing.staged, true);
    assert.match(doing.stage_packet, /owner: agi-research/);

    const updated = taskDb.getTask(db, created.id);
    assert.equal(updated.status, 'claimed');
    assert.equal(updated.claimed_by, 'agi-research');
    assert.equal(updated.metadata.stage, 'do');
    assert.equal(updated.metadata.stage_owner, 'agi-research');
    assert.equal(updated.metadata.assigned_to, 'agi-research');
    assert.equal(updated.metadata.goal_objective, 'Ship the claimed task');
    const eventTypes = taskDb.listTaskEvents(db, { taskId: created.id }).map(event => event.event_type);
    assert.deepEqual(eventTypes, ['claimed', 'work_started']);
  } finally {
    taskDb.close();
    cleanupTempDir(dir);
  }
});

test('task do assigns legacy claimed rows that have no claimant', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const taskDb = require('../lib/task-db');
  taskDb.close();
  try {
    fs.mkdirSync(path.join(dir, 'project-obelisk', 'atris'), { recursive: true });
    const db = taskDb.open(dbPath);
    const workspaceRoot = fs.realpathSync(path.join(dir, 'project-obelisk'));
    const created = taskDb.addTask(db, {
      title: 'Legacy claimed task without owner',
      tag: 'capture',
      workspaceRoot,
      status: 'claimed',
    });
    const planned = taskDb.stageTask(db, {
      id: created.id,
      actor: 'codex',
      stage: 'plan',
      owner: 'codex',
      goal: 'Recover unowned claimed task',
      exit: 'Do assigns the missing owner',
      proofNeeded: 'node --test task stage coverage passes',
    });
    assert.equal(planned.staged, true);

    const doing = taskDb.stageTask(db, {
      id: created.id,
      actor: 'codex',
      stage: 'do',
      firstMove: 'continue the legacy claimed row',
    });
    assert.equal(doing.staged, true);
    const updated = taskDb.getTask(db, created.id);
    assert.equal(updated.status, 'claimed');
    assert.equal(updated.claimed_by, 'codex');
    assert.equal(updated.metadata.stage, 'do');
    const eventTypes = taskDb.listTaskEvents(db, { taskId: created.id }).map(event => event.event_type);
    assert.deepEqual(eventTypes, ['claimed', 'task_planned', 'claimed', 'work_started']);
  } finally {
    taskDb.close();
    cleanupTempDir(dir);
  }
});

test('task chat refines a durable goal before plan', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex', ATRIS_SKIP_UPDATE_CHECK: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const add = runCli(['task', 'add', 'Make a vague task useful', '--tag', 'capture', '--json'], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const ref = JSON.parse(add.stdout).task.display_id;

    const emptyChat = runCli(['task', 'chat', ref, '--json'], { cwd: dir, env });
    assert.equal(emptyChat.status, 2);
    assert.equal(JSON.parse(emptyChat.stdout).reason, 'content_required');

    const chat = runCli([
      'task', 'chat', ref,
      'This needs one concrete goal before execution',
      '--goal', 'Ship durable task chat refinement',
      '--summary', 'Narrowed from vague task to one proofable primitive',
      '--as', 'operator',
      '--json',
    ], { cwd: dir, env });
    assert.equal(chat.status, 0, chat.stderr);
    const chatPayload = JSON.parse(chat.stdout);
    assert.equal(chatPayload.action, 'chatted');
    assert.equal(chatPayload.goal_changed, true);
    assert.equal(chatPayload.task.objective, 'Ship durable task chat refinement');
    assert.equal(chatPayload.task.metadata.task_goal, 'Ship durable task chat refinement');
    assert.match(chatPayload.chat_packet, /TASK_CHAT_UPDATE/);
    assert.match(chatPayload.chat_packet, /goal: Ship durable task chat refinement/);

    const clearPlan = runCli(['task', 'clear-plan', '--yes', '--json'], { cwd: dir, env });
    assert.equal(clearPlan.status, 0, clearPlan.stderr);
    assert.equal(JSON.parse(clearPlan.stdout).cleared_count, 0);

    const show = runCli(['task', 'show', ref, '--json'], { cwd: dir, env });
    assert.equal(show.status, 0, show.stderr);
    const shown = JSON.parse(show.stdout);
    assert.equal(shown.latest_event_type, 'task_chat');
    assert.equal(shown.objective, 'Ship durable task chat refinement');
    assert.ok(shown.messages.some(message => message.content.includes('TASK_CHAT_UPDATE')));

    const plan = runCli([
      'task', 'plan', ref,
      '--as', 'codex',
      '--exit', 'task chat can seed the plan goal',
      '--proof-needed', 'node --test task chat coverage passes',
      '--json',
    ], { cwd: dir, env });
    assert.equal(plan.status, 0, plan.stderr);
    const planPayload = JSON.parse(plan.stdout);
    assert.match(planPayload.stage_packet, /goal: Ship durable task chat refinement/);
    assert.equal(planPayload.task.metadata.task_goal, 'Ship durable task chat refinement');
  } finally {
    cleanupTempDir(dir);
  }
});

test('task page exposes one-task goal chat stage and review actions', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex', ATRIS_SKIP_UPDATE_CHECK: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const add = runCli(['task', 'add', 'Make one task page useful', '--tag', 'capture', '--json'], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const ref = JSON.parse(add.stdout).task.display_id;

    const firstPage = runCli(['task', 'page', ref, '--json'], { cwd: dir, env });
    assert.equal(firstPage.status, 0, firstPage.stderr);
    const firstPayload = JSON.parse(firstPage.stdout);
    assert.equal(firstPayload.action, 'page');
    assert.equal(firstPayload.page.schema, 'atris.task_page.v1');
    assert.equal(firstPayload.page.task.ref, ref);
    assert.equal(firstPayload.page.stage.current, 'backlog');
    assert.equal(firstPayload.page.stage.next_action.key, 'plan');
    assert.match(firstPayload.page.actions.plan_command, new RegExp(`atris task plan ${ref}`));
    assert.equal(firstPayload.page.review.human_accept.enabled, false);
    assert.notEqual(firstPayload.page.stage.next_action.key, 'accept');

    const chat = runCli([
      'task', 'chat', ref,
      'Turn the card into a focused task page contract',
      '--goal', 'Ship a headless task page contract',
      '--summary', 'Need one stable packet for UI and agents',
      '--as', 'operator',
      '--json',
    ], { cwd: dir, env });
    assert.equal(chat.status, 0, chat.stderr);

    const chatPage = runCli(['task', 'page', ref, '--json'], { cwd: dir, env });
    assert.equal(chatPage.status, 0, chatPage.stderr);
    const chatContract = JSON.parse(chatPage.stdout).page;
    assert.equal(chatContract.goal.text, 'Ship a headless task page contract');
    assert.equal(chatContract.goal.source, 'task_goal');
    assert.match(chatContract.chat.command, /atris task chat/);
    assert.ok(chatContract.chat.recent_messages.some(message => message.content.includes('TASK_CHAT_UPDATE')));
    assert.match(chatContract.actions.plan_command, /Ship a headless task page contract/);

    const plan = runCli([
      'task', 'plan', ref,
      '--as', 'codex',
      '--exit', 'task page shows the next Do action',
      '--proof-needed', 'node --test task page coverage passes',
      '--json',
    ], { cwd: dir, env });
    assert.equal(plan.status, 0, plan.stderr);

    const planPage = runCli(['task', 'page', ref, '--json'], { cwd: dir, env });
    assert.equal(planPage.status, 0, planPage.stderr);
    const planned = JSON.parse(planPage.stdout).page;
    assert.equal(planned.stage.current, 'plan');
    assert.equal(planned.stage.next_action.key, 'do');
    assert.match(planned.stage.next_action.command, new RegExp(`atris task do ${ref}`));
    assert.equal(planned.stage.rail.find(item => item.key === 'plan').state, 'current');

    const doing = runCli(['task', 'do', ref, '--as', 'codex', '--first-move', 'patch the page contract', '--json'], { cwd: dir, env });
    assert.equal(doing.status, 0, doing.stderr);

    const doPage = runCli(['task', 'page', ref, '--json'], { cwd: dir, env });
    assert.equal(doPage.status, 0, doPage.stderr);
    const doingContract = JSON.parse(doPage.stdout).page;
    assert.equal(doingContract.stage.current, 'do');
    assert.equal(doingContract.stage.next_action.key, 'ready');
    assert.match(doingContract.stage.next_action.command, new RegExp(`atris task ready ${ref}`));

    const ready = runCli([
      'task', 'ready', ref,
      '--as', 'codex',
      '--proof', 'node --test test/commands.test.js passed for task page review',
      '--json',
    ], { cwd: dir, env });
    assert.equal(ready.status, 0, ready.stderr);

    const reviewPage = runCli(['task', 'page', ref, '--json'], { cwd: dir, env });
    assert.equal(reviewPage.status, 0, reviewPage.stderr);
    const reviewContract = JSON.parse(reviewPage.stdout).page;
    assert.equal(reviewContract.stage.current, 'review');
    assert.equal(reviewContract.stage.next_action.key, 'review_chat');
    assert.match(reviewContract.stage.next_action.command, new RegExp(`atris task review-chat ${ref} --as codex-review`));
    assert.equal(reviewContract.review.verification_chat.schema, 'atris.task_review_chat.v1');
    assert.equal(reviewContract.review.human_accept.enabled, true);
    assert.equal(reviewContract.review.human_accept.human_only, true);
    assert.equal(reviewContract.review.human_accept.command, `atris task accept ${ref}`);
    assert.notEqual(reviewContract.stage.next_action.command, reviewContract.review.human_accept.command);

    const customReviewerPage = runCli(['task', 'page', ref, '--as', 'alice-review', '--json'], { cwd: dir, env });
    assert.equal(customReviewerPage.status, 0, customReviewerPage.stderr);
    const customReviewerContract = JSON.parse(customReviewerPage.stdout).page;
    assert.equal(customReviewerContract.stage.next_action.command, `atris task review-chat ${ref} --as alice-review`);
    assert.equal(customReviewerContract.review.verification_chat.command, `atris task review-chat ${ref} --as alice-review`);
    assert.equal(customReviewerContract.review.verification_chat.pass_command, `atris task review ${ref} --reward 0 --as alice-review --proof "<specific verifier commands passed and diff/proof inspected>" --verify "<safe verifier command>"`);

    const certify = runCli([
      'task', 'review', ref,
      '--reward', '0',
      '--as', 'validator',
      '--proof', 'node --test test/commands.test.js passed and task page inspected',
      '--json',
    ], { cwd: dir, env });
    assert.equal(certify.status, 0, certify.stderr);
    const certifiedPage = runCli(['task', 'page', ref, '--json'], { cwd: dir, env });
    assert.equal(certifiedPage.status, 0, certifiedPage.stderr);
    const certifiedContract = JSON.parse(certifiedPage.stdout).page;
    assert.equal(certifiedContract.stage.current, 'review');
    assert.equal(certifiedContract.stage.next_action.key, 'human_accept_waiting');
    assert.equal(certifiedContract.stage.next_action.command, null);
    assert.equal(certifiedContract.review.handoff.next_action, 'human_accept_waiting');
    assert.equal(certifiedContract.review.verification_chat.schema, 'atris.task_review_chat.v1');
    assert.equal(certifiedContract.review.verification_chat.command, `atris task review-chat ${ref} --as codex-review`);
    assert.equal(certifiedContract.actions.review_chat_command, `atris task review-chat ${ref} --as codex-review`);
    assert.equal(certifiedContract.review.human_accept.enabled, true);
    assert.equal(certifiedContract.review.human_accept.command, `atris task accept ${ref}`);

    const certifiedReviewChat = runCli(['task', 'review-chat', ref, '--as', 'codex-review', '--json'], { cwd: dir, env });
    assert.equal(certifiedReviewChat.status, 0, certifiedReviewChat.stderr);
    const certifiedReviewChatPayload = JSON.parse(certifiedReviewChat.stdout);
    assert.equal(certifiedReviewChatPayload.action, 'review_chat');
    assert.equal(certifiedReviewChatPayload.appended, true);
    assert.equal(certifiedReviewChatPayload.contract.review.agent_certified, true);

    const certifiedShow = runCli(['task', 'show', ref, '--json'], { cwd: dir, env });
    assert.equal(certifiedShow.status, 0, certifiedShow.stderr);
    assert.equal(JSON.parse(certifiedShow.stdout).review.verification_chat, undefined);

    const legacyAdd = runCli(['task', 'add', 'Legacy done row still needs review', '--tag', 'capture', '--json'], { cwd: dir, env });
    assert.equal(legacyAdd.status, 0, legacyAdd.stderr);
    const legacyAddPayload = JSON.parse(legacyAdd.stdout);
    const legacyRef = legacyAddPayload.task.display_id;
    const previousTaskDb = process.env.ATRIS_TASKS_DB;
    const taskDb = require('../lib/task-db');
    try {
      process.env.ATRIS_TASKS_DB = dbPath;
      taskDb.close();
      const db = taskDb.open();
      const legacyDone = taskDb.doneTask(db, { id: legacyAddPayload.task_id, status: 'done', actor: 'codex' });
      assert.equal(legacyDone.updated, true);
      taskDb.close();
    } finally {
      taskDb.close();
      if (previousTaskDb === undefined) delete process.env.ATRIS_TASKS_DB;
      else process.env.ATRIS_TASKS_DB = previousTaskDb;
    }

    const legacyPage = runCli(['task', 'page', legacyRef, '--json'], { cwd: dir, env });
    assert.equal(legacyPage.status, 0, legacyPage.stderr);
    const legacyContract = JSON.parse(legacyPage.stdout).page;
    assert.equal(legacyContract.task.status, 'done');
    assert.equal(legacyContract.stage.current, 'review');
    assert.equal(legacyContract.stage.next_action.key, 'review');
    assert.match(legacyContract.stage.next_action.command, new RegExp(`atris task review ${legacyRef}`));
    assert.match(legacyContract.stage.next_action.command, /--reward 0/);
    assert.equal(legacyContract.review.verification_chat, null);
    assert.equal(legacyContract.review.human_accept.enabled, false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task step advances one safe headless action and never human-accepts', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex', ATRIS_SKIP_UPDATE_CHECK: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const add = runCli(['task', 'add', 'Drive task loop from a single headless step', '--tag', 'capture', '--json'], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const ref = JSON.parse(add.stdout).task.display_id;

    const missingGoal = runCli(['task', 'step', ref, '--exit', 'needs a goal first', '--proof-needed', 'node --test missing goal coverage passes', '--json'], { cwd: dir, env });
    assert.equal(missingGoal.status, 2);
    const missingGoalPayload = JSON.parse(missingGoal.stdout);
    assert.equal(missingGoalPayload.reason, 'goal_required');
    assert.equal(missingGoalPayload.page.stage.current, 'backlog');
    assert.equal(missingGoalPayload.page.stage.next_action.key, 'plan');

    const planned = runCli([
      'task', 'step', ref,
      'Narrow this task before planning',
      '--goal', 'Drive one task through Plan Do Review from step',
      '--summary', 'chat narrowed the task before plan',
      '--exit', 'step returns a Do-ready page',
      '--proof-needed', 'node --test test/commands.test.js passes task step coverage',
      '--json',
    ], { cwd: dir, env });
    assert.equal(planned.status, 0, planned.stderr);
    const plannedPayload = JSON.parse(planned.stdout);
    assert.equal(plannedPayload.action, 'stepped');
    assert.equal(plannedPayload.step_action, 'planned');
    assert.equal(plannedPayload.chat.action, 'chatted');
    assert.equal(plannedPayload.page.schema, 'atris.task_page.v1');
    assert.equal(plannedPayload.page.stage.current, 'plan');
    assert.equal(plannedPayload.page.stage.next_action.key, 'do');
    assert.equal(plannedPayload.page.goal.text, 'Drive one task through Plan Do Review from step');
    assert.match(plannedPayload.page.actions.step_command, new RegExp(`atris task step ${ref} --json`));
    assert.equal(plannedPayload.page.api.step, `/api/tasks/${plannedPayload.task.id}/step`);

    const doing = runCli(['task', 'step', ref, '--as', 'codex', '--first-move', 'run the headless step test', '--json'], { cwd: dir, env });
    assert.equal(doing.status, 0, doing.stderr);
    const doingPayload = JSON.parse(doing.stdout);
    assert.equal(doingPayload.step_action, 'doing');
    assert.equal(doingPayload.page.stage.current, 'do');
    assert.equal(doingPayload.task.status, 'claimed');

    const weakReady = runCli(['task', 'step', ref, '--proof', 'done', '--json'], { cwd: dir, env });
    assert.equal(weakReady.status, 2);
    const weakReadyPayload = JSON.parse(weakReady.stdout);
    assert.equal(weakReadyPayload.reason, 'weak_proof');
    assert.equal(weakReadyPayload.page.stage.current, 'do');

    const ready = runCli([
      'task', 'step', ref,
      '--as', 'codex',
      '--proof', 'node --test test/commands.test.js passed for task step ready',
      '--lesson', 'Step keeps XP behind human accept',
      '--next', 'Use step from the task page UI later',
      '--json',
    ], { cwd: dir, env });
    assert.equal(ready.status, 0, ready.stderr);
    const readyPayload = JSON.parse(ready.stdout);
    assert.equal(readyPayload.step_action, 'ready');
    assert.equal(readyPayload.page.stage.current, 'review');
    assert.equal(readyPayload.page.stage.next_action.key, 'review_chat');
    assert.equal(readyPayload.handoff.next_action, 'agent_review_again');
    assert.equal(readyPayload.page.review.human_accept.enabled, true);
    assert.notEqual(readyPayload.page.stage.next_action.command, readyPayload.page.review.human_accept.command);

    const reviewChat = runCli(['task', 'step', ref, '--reviewer', 'codex-review', '--json'], { cwd: dir, env });
    assert.equal(reviewChat.status, 0, reviewChat.stderr);
    const reviewChatPayload = JSON.parse(reviewChat.stdout);
    assert.equal(reviewChatPayload.step_action, 'review_chat');
    assert.equal(reviewChatPayload.contract.schema, 'atris.task_review_chat.v1');
    assert.match(reviewChatPayload.contract.codex_prompt, /\/codex review/);
    assert.ok(reviewChatPayload.page.chat.recent_messages.some(message => message.content.includes('TASK_REVIEW_CHAT')));
    assert.equal(reviewChatPayload.page.task.status, 'review');
    assert.equal(reviewChatPayload.page.review.human_accept.enabled, true);

    const certify = runCli([
      'task', 'review', ref,
      '--reward', '0',
      '--as', 'validator',
      '--proof', 'node --test test/commands.test.js passed during certified step regression',
      '--json',
    ], { cwd: dir, env });
    assert.equal(certify.status, 0, certify.stderr);
    const certifiedStep = runCli(['task', 'step', ref, '--json'], { cwd: dir, env });
    assert.equal(certifiedStep.status, 1);
    const certifiedStepPayload = JSON.parse(certifiedStep.stdout);
    assert.equal(certifiedStepPayload.reason, 'agent_certified_continue_work');
    assert.equal(certifiedStepPayload.page.stage.next_action.key, 'continue_work');
    assert.equal(certifiedStepPayload.page.stage.next_action.command, `atris task continue-work ${ref} --as codex --json`);
    assert.equal(certifiedStepPayload.page.review.human_accept.enabled, true);
    assert.equal(certifiedStepPayload.page.review.verification_chat.schema, 'atris.task_review_chat.v1');

    const certifiedMessageStep = runCli([
      'task', 'step', ref,
      'should not write to certified review',
      '--goal', 'Certified review should not be refined by step',
      '--json',
    ], { cwd: dir, env });
    assert.equal(certifiedMessageStep.status, 1);
    const certifiedMessagePayload = JSON.parse(certifiedMessageStep.stdout);
    assert.equal(certifiedMessagePayload.reason, 'agent_certified_continue_work');

    const show = runCli(['task', 'show', ref, '--json'], { cwd: dir, env });
    assert.equal(show.status, 0, show.stderr);
    const shownTask = JSON.parse(show.stdout);
    assert.equal(shownTask.status, 'review');
    assert.equal(shownTask.metadata.task_goal, 'Drive one task through Plan Do Review from step');
    assert.equal(shownTask.messages.some(message => message.content.includes('should not write to certified review')), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task current-step advances the scoped current task one safe action', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex', ATRIS_SKIP_UPDATE_CHECK: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const reviewAdd = runCli(['task', 'add', 'Unrelated review debt stays global', '--tag', 'agent', '--json'], { cwd: dir, env });
    assert.equal(reviewAdd.status, 0, reviewAdd.stderr);
    const reviewTask = JSON.parse(reviewAdd.stdout).task;
    assert.equal(runCli(['task', 'claim', reviewTask.display_id, '--as', 'codex'], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'ready', reviewTask.display_id,
      '--as', 'codex',
      '--proof', 'node --test test/commands.test.js passed for unrelated review debt',
    ], { cwd: dir, env }).status, 0);

    const scopedAdd = runCli([
      'task', 'add', 'Scoped current step task',
      '--tag', 'task',
      '--goal-id', 'OBL-928',
      '--json',
    ], { cwd: dir, env });
    assert.equal(scopedAdd.status, 0, scopedAdd.stderr);
    const scopedTask = JSON.parse(scopedAdd.stdout).task;
    const scopedPlan = runCli([
      'task', 'plan', scopedTask.display_id,
      '--as', 'codex',
      '--goal', 'Advance the scoped current task',
      '--exit', 'current-step can start the task from Plan',
      '--proof-needed', 'node --test test/commands.test.js passes current-step coverage',
      '--json',
    ], { cwd: dir, env });
    assert.equal(scopedPlan.status, 0, scopedPlan.stderr);

    const unscopedCurrent = runCli(['task', 'current', '--as', 'codex', '--json'], { cwd: dir, env });
    assert.equal(unscopedCurrent.status, 0, unscopedCurrent.stderr);
    const unscopedPayload = JSON.parse(unscopedCurrent.stdout);
    assert.equal(unscopedPayload.current.selected_task_id, reviewTask.id);
    assert.equal(unscopedPayload.current.selected_reason, 'review_needs_agent_verification');

    const doing = runCli([
      'task', 'current-step',
      '--goal-id', 'OBL-928',
      '--as', 'codex',
      '--first-move', 'run the scoped current-step test',
      '--json',
    ], { cwd: dir, env });
    assert.equal(doing.status, 0, doing.stderr);
    const doingPayload = JSON.parse(doing.stdout);
    assert.equal(doingPayload.action, 'current_step');
    assert.equal(doingPayload.selected_ref, scopedTask.display_id);
    assert.equal(doingPayload.selected_next_key, doingPayload.before_current.next.key);
    assert.equal(doingPayload.before_current.scope.goal_id, 'OBL-928');
    assert.equal(doingPayload.before_current.selected_task_id, scopedTask.id);
    assert.equal(doingPayload.before_current.selected_ref, scopedTask.display_id);
    assert.equal(doingPayload.before_current.selected_reason, 'plan_ready');
    assert.equal(doingPayload.step.step_action, 'doing');
    assert.equal(doingPayload.step.task.id, scopedTask.id);
    assert.equal(doingPayload.page.stage.current, 'do');
    assert.equal(doingPayload.after_current.selected_task_id, scopedTask.id);
    assert.equal(doingPayload.after_current.selected_ref, scopedTask.display_id);
    assert.equal(doingPayload.after_current.selected_reason, 'claimed_by_owner');
    assert.equal(doingPayload.after.current.selected_task_id, scopedTask.id);
    assert.equal(doingPayload.after.page.stage.current, 'do');
    assert.equal(doingPayload.current.selected_reason, 'claimed_by_owner');
    assert.equal(doingPayload.safety.read_only, false);
    assert.equal(doingPayload.safety.claims_work, true);
    assert.equal(doingPayload.safety.human_accept, false);

    const ready = runCli([
      'task', 'current-step',
      '--goal-id', 'OBL-928',
      '--as', 'codex',
      '--proof', 'node --test test/commands.test.js passed for current-step ready',
      '--lesson', 'current-step keeps current and step contracts together',
      '--next', 'Use current-step from the mission runner',
      '--json',
    ], { cwd: dir, env });
    assert.equal(ready.status, 0, ready.stderr);
    const readyPayload = JSON.parse(ready.stdout);
    assert.equal(readyPayload.selected_task_id, scopedTask.id);
    assert.equal(readyPayload.selected_ref, scopedTask.display_id);
    assert.equal(readyPayload.selected_next_key, readyPayload.before_current.next.key);
    assert.equal(readyPayload.step.step_action, 'ready');
    assert.equal(readyPayload.current.selected_task_id, scopedTask.id);
    assert.equal(readyPayload.current.selected_ref, scopedTask.display_id);
    assert.equal(readyPayload.current.next.key, 'review_chat');
    assert.equal(readyPayload.after_current.selected_task_id, scopedTask.id);
    assert.equal(readyPayload.after_current.next.key, 'review_chat');
    assert.equal(readyPayload.after.current.next.key, 'review_chat');
    assert.equal(readyPayload.page.review.human_accept.enabled, true);
    assert.equal(readyPayload.safety.human_accept, false);

    const reviewChat = runCli(['task', 'current-step', '--goal-id', 'OBL-928', '--reviewer', 'codex-review', '--json'], { cwd: dir, env });
    assert.equal(reviewChat.status, 0, reviewChat.stderr);
    const reviewChatPayload = JSON.parse(reviewChat.stdout);
    assert.equal(reviewChatPayload.step.step_action, 'review_chat');
    assert.equal(reviewChatPayload.step.contract.schema, 'atris.task_review_chat.v1');
    assert.match(reviewChatPayload.step.contract.codex_prompt, /\/codex review/);
    assert.ok(reviewChatPayload.page.chat.recent_messages.some(message => message.content.includes('TASK_REVIEW_CHAT')));
    assert.equal(reviewChatPayload.page.review.human_accept.enabled, true);
    assert.equal(reviewChatPayload.safety.human_accept, false);

    const reviewShow = runCli(['task', 'show', reviewTask.display_id, '--json'], { cwd: dir, env });
    assert.equal(reviewShow.status, 0, reviewShow.stderr);
    assert.equal(JSON.parse(reviewShow.stdout).messages.some(message => message.content.includes('TASK_REVIEW_CHAT')), false);
    const scopedShow = runCli(['task', 'show', scopedTask.display_id, '--json'], { cwd: dir, env });
    assert.equal(scopedShow.status, 0, scopedShow.stderr);
    const scopedDetail = JSON.parse(scopedShow.stdout);
    assert.equal(scopedDetail.status, 'review');
    assert.equal(scopedDetail.review.approval_status, 'pending');
    assert.ok(scopedDetail.messages.some(message => message.content.includes('TASK_REVIEW_CHAT')));

    const continueAdd = runCli([
      'task', 'add', 'Current-step certified continuation parent',
      '--tag', 'task',
      '--goal-id', 'OBL-931',
      '--json',
    ], { cwd: dir, env });
    assert.equal(continueAdd.status, 0, continueAdd.stderr);
    const continueTask = JSON.parse(continueAdd.stdout).task;
    assert.equal(runCli(['task', 'claim', continueTask.display_id, '--as', 'codex'], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'ready', continueTask.display_id,
      '--as', 'codex',
      '--proof', 'node --test test/commands.test.js passed before current-step continue-work',
    ], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'review', continueTask.display_id,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js passed during current-step continue-work review',
      '--next', 'Current-step continuation child',
    ], { cwd: dir, env }).status, 0);

    const waitingAdd = runCli([
      'task', 'add', 'Current-step waits for human accept only',
      '--tag', 'task',
      '--goal-id', 'OBL-931',
      '--json',
    ], { cwd: dir, env });
    assert.equal(waitingAdd.status, 0, waitingAdd.stderr);
    const waitingTask = JSON.parse(waitingAdd.stdout).task;
    assert.equal(runCli(['task', 'claim', waitingTask.display_id, '--as', 'codex'], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'ready', waitingTask.display_id,
      '--as', 'codex',
      '--proof', 'node --test test/commands.test.js passed before current-step human wait',
    ], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'review', waitingTask.display_id,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js passed during current-step human wait review',
    ], { cwd: dir, env }).status, 0);

    const continueStep = runCli([
      'task', 'current-step',
      '--goal-id', 'OBL-931',
      '--review-state', 'continue-work',
      '--as', 'codex',
      '--json',
    ], { cwd: dir, env });
    assert.equal(continueStep.status, 0, continueStep.stderr);
    const continueStepPayload = JSON.parse(continueStep.stdout);
    assert.equal(continueStepPayload.before_current.scope.review_state, 'continue-work');
    assert.equal(continueStepPayload.before_current.selected_task_id, continueTask.id);
    assert.equal(continueStepPayload.selected_ref, continueTask.display_id);
    assert.equal(continueStepPayload.selected_next_key, 'continue_work');
    assert.equal(continueStepPayload.before_current.selected_ref, continueTask.display_id);
    assert.equal(continueStepPayload.before_current.next.key, 'continue_work');
    assert.equal(continueStepPayload.step.step_action, 'continue_work');
    assert.equal(continueStepPayload.step.continue_work.action, 'continue_work');
    assert.equal(continueStepPayload.step.continue_work.parent_task_id, continueTask.id);
    assert.equal(continueStepPayload.step.continue_work.created, true);
    assert.equal(continueStepPayload.step.next_task.title, 'Current-step continuation child');
    assert.equal(continueStepPayload.page.task.id, continueStepPayload.step.next_task.id);
    assert.equal(continueStepPayload.safety.human_accept, false);
    assert.equal(continueStepPayload.safety.claims_work, false);
    const continueParentShow = runCli(['task', 'show', continueTask.display_id, '--json'], { cwd: dir, env });
    assert.equal(continueParentShow.status, 0, continueParentShow.stderr);
    const continueParentDetail = JSON.parse(continueParentShow.stdout);
    assert.equal(continueParentDetail.status, 'review');
    assert.equal(continueParentDetail.review.approval_status, 'pending');

    const waitingStep = runCli([
      'task', 'current-step',
      '--goal-id', 'OBL-931',
      '--review-state', 'human-accept-waiting',
      '--as', 'codex',
      '--json',
    ], { cwd: dir, env });
    assert.notEqual(waitingStep.status, 0);
    const waitingStepPayload = JSON.parse(waitingStep.stdout);
    assert.equal(waitingStepPayload.reason, 'agent_certified_waiting_human');
    assert.equal(waitingStepPayload.selected_ref, waitingTask.display_id);
    assert.equal(waitingStepPayload.selected_next_key, 'human_accept_waiting');
    assert.equal(waitingStepPayload.current.selected_task_id, waitingTask.id);
    assert.equal(waitingStepPayload.current.selected_ref, waitingTask.display_id);
    assert.equal(waitingStepPayload.current.next.key, 'human_accept_waiting');
    assert.equal(waitingStepPayload.page.stage.next_action.command, null);
    assert.equal(waitingStepPayload.page.stage.next_action.api, null);
    const waitingShow = runCli(['task', 'show', waitingTask.display_id, '--json'], { cwd: dir, env });
    assert.equal(waitingShow.status, 0, waitingShow.stderr);
    const waitingDetail = JSON.parse(waitingShow.stdout);
    assert.equal(waitingDetail.status, 'review');
    assert.equal(waitingDetail.review.approval_status, 'pending');

    const otherAdd = runCli([
      'task', 'add', 'Other owner scoped task stays untouched',
      '--tag', 'task',
      '--goal-id', 'OBL-929',
      '--json',
    ], { cwd: dir, env });
    assert.equal(otherAdd.status, 0, otherAdd.stderr);
    const otherTask = JSON.parse(otherAdd.stdout).task;
    assert.equal(runCli(['task', 'claim', otherTask.display_id, '--as', 'other-agent'], { cwd: dir, env }).status, 0);
    const otherStep = runCli([
      'task', 'current-step',
      '--goal-id', 'OBL-929',
      '--as', 'codex',
      '--proof', 'node --test test/commands.test.js passed without touching other owner work',
      '--json',
    ], { cwd: dir, env });
    assert.notEqual(otherStep.status, 0);
    const otherPayload = JSON.parse(otherStep.stdout);
    assert.equal(otherPayload.reason, 'claimed_by_other');
    assert.equal(otherPayload.selected_ref, otherTask.display_id);
    assert.equal(otherPayload.selected_next_key, otherPayload.current.next.key);
    assert.equal(otherPayload.current.selected_task_id, otherTask.id);
    assert.equal(otherPayload.current.selected_ref, otherTask.display_id);
    assert.equal(otherPayload.current.selected_reason, 'active_do_elsewhere');
    const otherShow = runCli(['task', 'show', otherTask.display_id, '--json'], { cwd: dir, env });
    assert.equal(otherShow.status, 0, otherShow.stderr);
    const otherDetail = JSON.parse(otherShow.stdout);
    assert.equal(otherDetail.status, 'claimed');
    assert.equal(otherDetail.claimed_by, 'other-agent');

    const otherReviewAdd = runCli([
      'task', 'add', 'Other owner review task stays untouched',
      '--tag', 'task',
      '--goal-id', 'OBL-930',
      '--json',
    ], { cwd: dir, env });
    assert.equal(otherReviewAdd.status, 0, otherReviewAdd.stderr);
    const otherReviewTask = JSON.parse(otherReviewAdd.stdout).task;
    assert.equal(runCli(['task', 'claim', otherReviewTask.display_id, '--as', 'other-agent'], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'ready', otherReviewTask.display_id,
      '--as', 'other-agent',
      '--proof', 'node --test test/commands.test.js passed before other owner review',
    ], { cwd: dir, env }).status, 0);
    const otherReviewStep = runCli([
      'task', 'current-step',
      '--goal-id', 'OBL-930',
      '--as', 'codex',
      '--reviewer', 'codex-review',
      '--json',
    ], { cwd: dir, env });
    assert.notEqual(otherReviewStep.status, 0);
    const otherReviewPayload = JSON.parse(otherReviewStep.stdout);
    assert.equal(otherReviewPayload.reason, 'claimed_by_other');
    assert.equal(otherReviewPayload.current.selected_task_id, otherReviewTask.id);
    assert.equal(otherReviewPayload.current.selected_reason, 'review_needs_agent_verification');
    const otherReviewShow = runCli(['task', 'show', otherReviewTask.display_id, '--json'], { cwd: dir, env });
    assert.equal(otherReviewShow.status, 0, otherReviewShow.stderr);
    const otherReviewDetail = JSON.parse(otherReviewShow.stdout);
    assert.equal(otherReviewDetail.status, 'review');
    assert.equal(otherReviewDetail.claimed_by, 'other-agent');
    assert.equal(otherReviewDetail.messages.some(message => message.content.includes('TASK_REVIEW_CHAT')), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task current returns read-only selected page and queue lanes', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex', ATRIS_SKIP_UPDATE_CHECK: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const reviewAdd = runCli(['task', 'add', 'Verify this task before more work', '--tag', 'agent', '--json'], { cwd: dir, env });
    assert.equal(reviewAdd.status, 0, reviewAdd.stderr);
    const reviewTask = JSON.parse(reviewAdd.stdout).task;
    assert.equal(runCli(['task', 'claim', reviewTask.display_id, '--as', 'codex'], { cwd: dir, env }).status, 0);
	    assert.equal(runCli([
	      'task', 'ready', reviewTask.display_id,
	      '--as', 'codex',
	      '--proof', 'node --test test/commands.test.js passed for current selector review',
	      '--next', 'Create a continuation only after agent certification',
	    ], { cwd: dir, env }).status, 0);

    const planAdd = runCli(['task', 'add', 'Plan ready fallback task', '--tag', 'agent', '--json'], { cwd: dir, env });
    assert.equal(planAdd.status, 0, planAdd.stderr);
    const planTask = JSON.parse(planAdd.stdout).task;

    const scopedPlanAdd = runCli([
      'task', 'add', 'Scoped OBL-928 fallback task',
      '--tag', 'agent',
      '--goal-id', 'OBL-928',
      '--json',
    ], { cwd: dir, env });
    assert.equal(scopedPlanAdd.status, 0, scopedPlanAdd.stderr);
    const scopedPlanTask = JSON.parse(scopedPlanAdd.stdout).task;
    const scopedParallelAdd = runCli([
      'task', 'add', 'Scoped OBL-928 validator task should wait',
      '--tag', 'agent',
      '--goal-id', 'OBL-928',
      '--json',
    ], { cwd: dir, env });
    assert.equal(scopedParallelAdd.status, 0, scopedParallelAdd.stderr);
    const scopedParallelTask = JSON.parse(scopedParallelAdd.stdout).task;

    const backlogAdd = runCli(['task', 'add', 'Raw inbox idea', '--tag', 'capture', '--json'], { cwd: dir, env });
    assert.equal(backlogAdd.status, 0, backlogAdd.stderr);
    const backlogTask = JSON.parse(backlogAdd.stdout).task;

    const current = runCli(['task', 'current', '--as', 'codex', '--json'], { cwd: dir, env });
    assert.equal(current.status, 0, current.stderr);
    const payload = JSON.parse(current.stdout);
    assert.equal(payload.action, 'current');
    assert.equal(payload.current.schema, 'atris.task_current.v1');
    assert.equal(payload.current.safety.read_only, true);
    assert.equal(payload.current.safety.claims_work, false);
    assert.equal(payload.current.safety.human_accept, false);
	    assert.equal(payload.current.selected_reason, 'review_needs_agent_verification');
	    assert.equal(payload.current.selected_task_id, reviewTask.id);
	    assert.equal(payload.current.selected_ref, reviewTask.display_id);
	    assert.equal(payload.current.selected_next_key, 'review_chat');
	    assert.equal(payload.selected_task_id, reviewTask.id);
	    assert.equal(payload.selected_ref, reviewTask.display_id);
	    assert.equal(payload.selected_next_key, 'review_chat');
	    assert.equal(payload.page.stage.current, 'review');
	    assert.equal(payload.current.next.key, 'review_chat');
	    assert.match(payload.current.next.command, new RegExp(`atris task review-chat ${reviewTask.display_id}`));
	    assert.match(payload.current.next.step_command, new RegExp(`atris task step ${reviewTask.display_id} --json`));
	    assert.equal(payload.selected.continue_work_command, undefined);
	    assert.equal(payload.selected.commands.continue_work, undefined);
	    assert.equal(payload.queue.schema, 'atris.task_queue.v1');
	    assert.deepEqual(payload.current.capabilities, payload.queue.capabilities);
	    assert.equal(payload.queue.capabilities.schema, 'atris.task_capabilities.v1');
	    assert.equal(payload.queue.capabilities.surfaces.capabilities.read_only, true);
	    assert.equal(payload.queue.capabilities.commands.capabilities, 'atris task capabilities --json');
	    assert.equal(payload.queue.capabilities.surfaces.current.read_only, true);
	    assert.equal(payload.queue.capabilities.surfaces.queue.read_only, true);
	    assert.deepEqual(payload.queue.capabilities.filters.review_state.accepted, ['needs-agent', 'continue-work', 'proof-boundary-blocked', 'human-accept-waiting', 'certified']);
	    assert.deepEqual(payload.queue.capabilities.filters.review_state.aliases['human-accept-waiting'], ['human-accept', 'accept-waiting', 'waiting-accept', 'no-next-task']);
	    assert.equal(payload.queue.capabilities.current_step.safety.read_only, false);
	    assert.equal(payload.queue.capabilities.current_step.safety.claims_work, 'conditional');
	    assert.deepEqual(payload.queue.capabilities.current_step.safety.claiming_stages, ['plan']);
	    assert.equal(payload.queue.capabilities.current_step.stage_safety.plan.claims_work, true);
	    assert.equal(payload.queue.capabilities.current_step.stage_safety.review.claims_work, false);
	    assert.equal(payload.queue.capabilities.current_step.safety.human_accept, false);
	    assert.equal(payload.queue.capabilities.current_step.safety.xp_after_human_accept, true);
	    assert.equal(payload.queue.capabilities.current_step.lanes['needs-agent'].step_action, 'review_chat');
	    assert.equal(payload.queue.capabilities.current_step.lanes['needs-agent'].claims_work, false);
	    assert.equal(payload.queue.capabilities.current_step.lanes['continue-work'].creates_or_reuses_follow_up, true);
	    assert.equal(payload.queue.capabilities.current_step.lanes['continue-work'].claims_work, false);
	    assert.equal(payload.queue.capabilities.current_step.lanes['human-accept-waiting'].reason, 'agent_certified_waiting_human');
	    assert.equal(payload.queue.capabilities.current_step.lanes['human-accept-waiting'].claims_work, false);
	    assert.equal(payload.queue.capabilities.current_step.lanes.certified.claims_work, false);
	    const capabilitiesCli = runCli(['task', 'capabilities', '--json'], { cwd: dir, env });
	    assert.equal(capabilitiesCli.status, 0, capabilitiesCli.stderr);
	    const capabilitiesPayload = JSON.parse(capabilitiesCli.stdout);
	    assert.deepEqual(capabilitiesPayload.capabilities, payload.queue.capabilities);
	    assert.equal(capabilitiesPayload.safety.read_only, true);
	    assert.equal(capabilitiesPayload.safety.claims_work, false);
	    assert.equal(payload.queue.counts.review, 1);
	    assert.equal(payload.queue.counts.plan, 3);
	    assert.equal(payload.queue.counts.backlog, 1);
	    assert.equal(payload.current.review_state_counts.total, 1);
	    assert.equal(payload.current.review_state_counts.needs_agent, 1);
	    assert.equal(payload.current.review_state_counts.continue_work, 0);
	    assert.equal(payload.current.review_state_counts.human_accept_waiting, 0);
	    assert.equal(payload.current.review_state_counts.certified, 0);
	    assert.deepEqual(payload.current.review_state_counts, payload.queue.review_state_counts);
	    assert.deepEqual(payload.current.review_state_actions, payload.queue.review_state_actions);
	    assert.equal(payload.current.review_state_actions.schema, 'atris.task_review_state_actions.v1');
	    assert.equal(payload.current.review_state_actions.active_filter, null);
	    assert.equal(payload.current.review_state_actions.scope.review_state, null);
	    assert.equal(payload.current.review_state_actions.needs_agent.id, reviewTask.id);
	    assert.equal(payload.current.review_state_actions.needs_agent.next_action, 'review_chat');
	    assert.match(payload.current.review_state_actions.needs_agent.command, new RegExp(`atris task review-chat ${reviewTask.display_id}`));
	    assert.deepEqual(payload.current.review_state_actions.needs_agent.api, { method: 'POST', path: `/api/tasks/${reviewTask.id}/review-chat` });
	    assert.equal(payload.current.review_state_actions.needs_agent.continue_work_command, undefined);
	    assert.equal(payload.current.review_state_actions.needs_agent.human_accept.human_only, true);
	    assert.match(payload.current.review_state_actions.needs_agent.human_accept.command, new RegExp(`atris task accept ${reviewTask.display_id}`));
	    assert.equal(payload.current.review_state_actions.continue_work, null);
	    assert.equal(payload.current.review_state_actions.human_accept_waiting, null);
	    const reviewQueueItem = payload.queue.columns.find(column => column.key === 'review').items[0];
	    assert.equal(reviewQueueItem.id, reviewTask.id);
	    assert.equal(reviewQueueItem.ref, reviewTask.display_id);
	    assert.equal(reviewQueueItem.display_id, reviewTask.display_id);
	    assert.ok(reviewQueueItem.legacy_ref);
	    assert.equal(reviewQueueItem.continue_work_command, undefined);

	    const needsAgentCurrent = runCli(['task', 'current', '--as', 'codex', '--review-state', 'needs-agent', '--json'], { cwd: dir, env });
	    assert.equal(needsAgentCurrent.status, 0, needsAgentCurrent.stderr);
	    const needsAgentPayload = JSON.parse(needsAgentCurrent.stdout);
	    assert.equal(needsAgentPayload.current.scope.review_state, 'needs-agent');
	    assert.equal(needsAgentPayload.current.selected_task_id, reviewTask.id);
	    assert.equal(needsAgentPayload.current.next.key, 'review_chat');
	    assert.equal(needsAgentPayload.selected.continue_work_command, undefined);
	    assert.equal(needsAgentPayload.current.review_state_counts.active_filter, 'needs-agent');
	    assert.equal(needsAgentPayload.current.review_state_counts.scope.review_state, null);
	    assert.equal(needsAgentPayload.current.review_state_counts.total, 1);
	    assert.equal(needsAgentPayload.current.review_state_counts.needs_agent, 1);
	    assert.equal(needsAgentPayload.current.review_state_actions.active_filter, 'needs-agent');
	    assert.equal(needsAgentPayload.current.review_state_actions.scope.review_state, null);
	    assert.equal(needsAgentPayload.current.review_state_actions.needs_agent.id, reviewTask.id);
	    assert.equal(needsAgentPayload.current.review_state_actions.needs_agent.next_action, 'review_chat');
	    assert.equal(needsAgentPayload.current.review_state_actions.continue_work, null);
	    assert.equal(needsAgentPayload.current.review_state_actions.human_accept_waiting, null);
	    assert.deepEqual(needsAgentPayload.current.capabilities.filters.review_state.accepted, ['needs-agent', 'continue-work', 'proof-boundary-blocked', 'human-accept-waiting', 'certified']);
	    assert.equal(needsAgentPayload.current.capabilities.current_step.lanes['needs-agent'].safe_for_agent, true);

    const scopedCurrent = runCli(['task', 'current', '--as', 'codex', '--goal-id', 'OBL-928', '--json'], { cwd: dir, env });
    assert.equal(scopedCurrent.status, 0, scopedCurrent.stderr);
    const scopedPayload = JSON.parse(scopedCurrent.stdout);
    assert.equal(scopedPayload.current.scope.goal_id, 'OBL-928');
    assert.equal(scopedPayload.current.selected_reason, 'plan_ready');
    assert.equal(scopedPayload.current.selected_task_id, scopedPlanTask.id);
    assert.equal(scopedPayload.current.selected_ref, scopedPlanTask.display_id);
    assert.equal(scopedPayload.page.task.ref, scopedPlanTask.display_id);
    assert.equal(scopedPayload.queue.scope.goal_id, 'OBL-928');
    assert.equal(scopedPayload.queue.counts.total, 2);
    assert.equal(scopedPayload.queue.counts.review, 0);
    assert.equal(scopedPayload.queue.counts.plan, 2);

    const scopedQueue = runCli(['task', 'queue', '--as', 'codex', '--goal-id', 'OBL-928', '--limit', '1', '--json'], { cwd: dir, env });
    assert.equal(scopedQueue.status, 0, scopedQueue.stderr);
    const scopedQueuePayload = JSON.parse(scopedQueue.stdout);
    assert.equal(scopedQueuePayload.queue.scope.goal_id, 'OBL-928');
    assert.equal(scopedQueuePayload.queue.counts.total, 2);
    assert.equal(scopedQueuePayload.queue.columns.find(column => column.key === 'plan').items[0].id, scopedParallelTask.id);

    const tagQueue = runCli(['task', 'queue', '--tag', 'capture', '--json'], { cwd: dir, env });
    assert.equal(tagQueue.status, 0, tagQueue.stderr);
    const tagQueuePayload = JSON.parse(tagQueue.stdout);
    assert.equal(tagQueuePayload.queue.scope.tag, 'capture');
    assert.equal(tagQueuePayload.queue.counts.total, 1);
    assert.equal(tagQueuePayload.queue.columns.find(column => column.key === 'backlog').items[0].id, backlogTask.id);

    const statusCurrent = runCli(['task', 'current', '--status', 'review', '--json'], { cwd: dir, env });
    assert.equal(statusCurrent.status, 0, statusCurrent.stderr);
    const statusPayload = JSON.parse(statusCurrent.stdout);
    assert.equal(statusPayload.current.scope.status, 'review');
    assert.equal(statusPayload.current.selected_task_id, reviewTask.id);
    assert.equal(statusPayload.current.selected_ref, reviewTask.display_id);
    assert.equal(statusPayload.queue.counts.total, 1);

    const planShow = runCli(['task', 'show', planTask.display_id, '--json'], { cwd: dir, env });
    assert.equal(planShow.status, 0, planShow.stderr);
    assert.equal(JSON.parse(planShow.stdout).status, 'open');
    const reviewShow = runCli(['task', 'show', reviewTask.display_id, '--json'], { cwd: dir, env });
    assert.equal(reviewShow.status, 0, reviewShow.stderr);
    const reviewDetail = JSON.parse(reviewShow.stdout);
    assert.equal(reviewDetail.status, 'review');
    assert.equal(reviewDetail.review.approval_status, 'pending');
    assert.equal(reviewDetail.messages.some(message => message.content.includes('TASK_REVIEW_CHAT')), false);

    assert.equal(runCli(['task', 'claim', planTask.display_id, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const claimedCurrent = runCli(['task', 'current', '--as', 'codex', '--json'], { cwd: dir, env });
    assert.equal(claimedCurrent.status, 0, claimedCurrent.stderr);
    const claimedPayload = JSON.parse(claimedCurrent.stdout);
    assert.equal(claimedPayload.current.selected_reason, 'claimed_by_owner');
    assert.equal(claimedPayload.current.selected_task_id, planTask.id);
    assert.equal(claimedPayload.current.selected_ref, planTask.display_id);
    assert.equal(claimedPayload.page.stage.current, 'do');
    assert.match(claimedPayload.current.next.command, new RegExp(`atris task ready ${planTask.display_id}`));

    const queue = runCli(['task', 'queue', '--as', 'codex', '--limit', '1', '--json'], { cwd: dir, env });
    assert.equal(queue.status, 0, queue.stderr);
    const queuePayload = JSON.parse(queue.stdout);
    assert.equal(queuePayload.action, 'queue');
    assert.equal(queuePayload.selected_task_id, planTask.id);
    assert.equal(queuePayload.selected_ref, planTask.display_id);
    assert.equal(queuePayload.selected_next_key, 'ready');
    assert.equal(queuePayload.current.selected_next_key, 'ready');
    assert.equal(queuePayload.queue.columns.find(column => column.key === 'do').items.length, 1);
    assert.equal(queuePayload.queue.columns.find(column => column.key === 'backlog').items[0].id, backlogTask.id);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task backlog and clear-plan demote only planned open tasks', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex', ATRIS_SKIP_UPDATE_CHECK: '1' };
  const taskDb = require('../lib/task-db');
  taskDb.close();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const workspaceRoot = fs.realpathSync(dir);

    const raw = runCli(['task', 'add', 'Raw capture stays backlog', '--tag', 'capture', '--json'], { cwd: dir, env });
    assert.equal(raw.status, 0, raw.stderr);
    const rawRef = JSON.parse(raw.stdout).task.display_id;

    const single = runCli(['task', 'add', 'Single planned row moves back', '--tag', 'plan', '--json'], { cwd: dir, env });
    assert.equal(single.status, 0, single.stderr);
    const singleRef = JSON.parse(single.stdout).task.display_id;
    assert.equal(runCli([
      'task', 'plan', singleRef,
      '--as', 'codex',
      '--goal', 'Single row has a plan',
      '--exit', 'single row can be demoted',
      '--proof-needed', 'node --test task backlog coverage passes',
      '--json',
    ], { cwd: dir, env }).status, 0);

    const singleBacklog = runCli(['task', 'backlog', singleRef, '--as', 'codex', '--reason', 'operator moved it', '--tag', 'feature', '--json'], { cwd: dir, env });
    assert.equal(singleBacklog.status, 0, singleBacklog.stderr);
    const singleBacklogPayload = JSON.parse(singleBacklog.stdout);
    assert.equal(singleBacklogPayload.action, 'backlogged');
    assert.equal(singleBacklogPayload.task.tag, 'capture');
    const singleBacklogMetadata = singleBacklogPayload.task.metadata || {};
    assert.equal(singleBacklogMetadata.stage, undefined);
    assert.equal(singleBacklogMetadata.goal_objective, undefined);
    assert.equal(singleBacklogMetadata.objective, undefined);
    assert.equal(singleBacklogMetadata.task_goal, 'Single row has a plan');
    assert.equal(singleBacklogMetadata.verify, undefined);
    assert.equal(singleBacklogPayload.task.latest_event_type, 'task_backlogged');

    const singleShow = runCli(['task', 'show', singleRef, '--json'], { cwd: dir, env });
    assert.equal(singleShow.status, 0, singleShow.stderr);
    const singleShowTask = JSON.parse(singleShow.stdout);
    assert.equal(singleShowTask.metadata.backlogged_by, 'codex');
    assert.equal(singleShowTask.metadata.goal_objective, undefined);
    assert.equal(singleShowTask.metadata.objective, undefined);
    assert.equal(singleShowTask.metadata.task_goal, 'Single row has a plan');
    assert.ok(singleShowTask.messages.some(message => message.content.includes('TASK_BACKLOG_UPDATE')));

    const doAfterBacklog = runCli(['task', 'do', singleRef, '--as', 'codex', '--first-move', 'start after demotion', '--json'], { cwd: dir, env });
    assert.equal(doAfterBacklog.status, 1);
    assert.equal(JSON.parse(doAfterBacklog.stdout).reason, 'goal_required');

    const planAfterBacklogWithoutGoal = runCli([
      'task', 'plan', singleRef,
      '--as', 'codex',
      '--exit', 'new exit still needs a fresh goal',
      '--proof-needed', 'new proof still needs a fresh goal',
      '--json',
    ], { cwd: dir, env });
    assert.equal(planAfterBacklogWithoutGoal.status, 0, planAfterBacklogWithoutGoal.stderr);
    assert.match(JSON.parse(planAfterBacklogWithoutGoal.stdout).stage_packet, /goal: Single row has a plan/);
    const singleBacklogAgain = runCli(['task', 'backlog', singleRef, '--as', 'codex', '--reason', 'operator moved it again', '--json'], { cwd: dir, env });
    assert.equal(singleBacklogAgain.status, 0, singleBacklogAgain.stderr);

    const db = taskDb.open(dbPath);
    const signalTask = taskDb.addTask(db, {
      title: 'Metadata signal planned row moves back',
      tag: 'capture',
      workspaceRoot,
      metadata: {
        goal: 'legacy goal signal',
        loop: 'legacy loop signal',
        cron: '0 * * * *',
        next_run_at: '2099-01-01T00:00:00.000Z',
      },
    });
    const signalBacklog = runCli(['task', 'backlog', signalTask.id, '--as', 'codex', '--reason', 'operator cleared legacy plan signals', '--tag', 'feature', '--json'], { cwd: dir, env });
    assert.equal(signalBacklog.status, 0, signalBacklog.stderr);
    const signalBacklogPayload = JSON.parse(signalBacklog.stdout);
    assert.equal(signalBacklogPayload.task.tag, 'capture');
    for (const key of ['goal', 'loop', 'cron', 'next_run_at']) {
      assert.ok(signalBacklogPayload.cleared_keys.includes(key), `${key} should be cleared`);
    }
    const signalShow = runCli(['task', 'show', signalTask.id, '--json'], { cwd: dir, env });
    assert.equal(signalShow.status, 0, signalShow.stderr);
    const signalShowTask = JSON.parse(signalShow.stdout);
    assert.equal(signalShowTask.metadata.goal, undefined);
    assert.equal(signalShowTask.metadata.loop, undefined);
    assert.equal(signalShowTask.metadata.cron, undefined);
    assert.equal(signalShowTask.metadata.next_run_at, undefined);
    const signalBacklogAgain = runCli(['task', 'backlog', signalTask.id, '--as', 'codex', '--json'], { cwd: dir, env });
    assert.equal(signalBacklogAgain.status, 1);
    assert.equal(JSON.parse(signalBacklogAgain.stdout).reason, 'not_planned');

    const goalOnlyTask = taskDb.addTask(db, {
      title: 'Goal-only stale plan row moves back',
      tag: 'capture',
      workspaceRoot,
      metadata: {
        goal_objective: 'stale goal only',
        objective: 'stale objective only',
      },
    });
    const goalOnlyBacklog = runCli(['task', 'backlog', goalOnlyTask.id, '--as', 'codex', '--reason', 'operator cleared stale goal-only plan', '--json'], { cwd: dir, env });
    assert.equal(goalOnlyBacklog.status, 1);
    assert.equal(JSON.parse(goalOnlyBacklog.stdout).reason, 'not_planned');
    const goalOnlyPlanWithoutGoal = runCli([
      'task', 'plan', goalOnlyTask.id,
      '--as', 'codex',
      '--exit', 'new exit still needs a fresh goal',
      '--proof-needed', 'new proof still needs a fresh goal',
      '--json',
    ], { cwd: dir, env });
    assert.equal(goalOnlyPlanWithoutGoal.status, 0, goalOnlyPlanWithoutGoal.stderr);
    assert.match(JSON.parse(goalOnlyPlanWithoutGoal.stdout).stage_packet, /goal: stale goal only/);
    const goalOnlyBacklogAfterPlan = runCli(['task', 'backlog', goalOnlyTask.id, '--as', 'codex', '--reason', 'operator cleared real plan', '--json'], { cwd: dir, env });
    assert.equal(goalOnlyBacklogAfterPlan.status, 0, goalOnlyBacklogAfterPlan.stderr);

    const delegated = runCli(['task', 'delegate', 'Delegated planned row keeps owner', '--to', 'alice', '--tag', 'capture', '--json'], { cwd: dir, env });
    assert.equal(delegated.status, 0, delegated.stderr);
    const delegatedRef = JSON.parse(delegated.stdout).task.display_id;
    const delegatedPlan = runCli([
      'task', 'plan', delegatedRef,
      '--as', 'alice',
      '--owner', 'alice',
      '--goal', 'Delegated owner has a plan',
      '--exit', 'owner survives demotion',
      '--proof-needed', 'owner preservation regression passes',
      '--json',
    ], { cwd: dir, env });
    assert.equal(delegatedPlan.status, 0, delegatedPlan.stderr);
    const delegatedBacklog = runCli(['task', 'backlog', delegatedRef, '--as', 'alice', '--reason', 'operator cleared delegated plan', '--json'], { cwd: dir, env });
    assert.equal(delegatedBacklog.status, 0, delegatedBacklog.stderr);
    const delegatedShow = runCli(['task', 'show', delegatedRef, '--json'], { cwd: dir, env });
    assert.equal(delegatedShow.status, 0, delegatedShow.stderr);
    const delegatedTask = JSON.parse(delegatedShow.stdout);
    assert.equal(delegatedTask.metadata.assigned_to, 'alice');
    assert.equal(delegatedTask.metadata.delegate_via, 'local');
    assert.equal(delegatedTask.metadata.stage_owner, undefined);

    const bulkA = runCli(['task', 'add', 'Bulk planned A', '--tag', 'feature', '--json'], { cwd: dir, env });
    const bulkB = runCli(['task', 'add', 'Bulk planned B', '--tag', 'capture', '--json'], { cwd: dir, env });
    const claimed = runCli(['task', 'add', 'Claimed Do row stays active', '--tag', 'plan', '--json'], { cwd: dir, env });
    assert.equal(bulkA.status, 0, bulkA.stderr);
    assert.equal(bulkB.status, 0, bulkB.stderr);
    assert.equal(claimed.status, 0, claimed.stderr);
    const bulkARef = JSON.parse(bulkA.stdout).task.display_id;
    const bulkBRef = JSON.parse(bulkB.stdout).task.display_id;
    const claimedRef = JSON.parse(claimed.stdout).task.display_id;
    for (const ref of [bulkARef, bulkBRef, claimedRef]) {
      const planned = runCli([
        'task', 'plan', ref,
        '--as', 'codex',
        '--owner', 'codex',
        '--goal', `Goal ${ref}`,
        '--exit', `Exit ${ref}`,
        '--proof-needed', `Proof ${ref}`,
        '--json',
      ], { cwd: dir, env });
      assert.equal(planned.status, 0, planned.stderr);
    }
    const claimedDo = runCli(['task', 'do', claimedRef, '--as', 'codex', '--first-move', 'keep doing this row', '--json'], { cwd: dir, env });
    assert.equal(claimedDo.status, 0, claimedDo.stderr);

    const missingConfirm = runCli(['task', 'clear-plan', '--json'], { cwd: dir, env });
    assert.equal(missingConfirm.status, 2);
    assert.equal(JSON.parse(missingConfirm.stdout).reason, 'confirm_required');

    const cleared = runCli(['task', 'clear-plan', '--as', 'codex', '--reason', 'bulk cleanup', '--yes', '--json'], { cwd: dir, env });
    assert.equal(cleared.status, 0, cleared.stderr);
    const clearedPayload = JSON.parse(cleared.stdout);
    assert.equal(clearedPayload.action, 'clear_plan');
    assert.equal(clearedPayload.cleared_count, 2);
    assert.deepEqual(clearedPayload.tasks.map(task => task.display_id).sort(), [bulkARef, bulkBRef].sort());
    assert.ok(clearedPayload.tasks.every(task => task.tag === 'capture'));

    const status = runCli(['task', 'status', '--json'], { cwd: dir, env });
    assert.equal(status.status, 0, status.stderr);
    const counts = JSON.parse(status.stdout).status.counts;
    assert.equal(counts.plan, 0);
    assert.equal(counts.do, 1);
    assert.equal(counts.backlog, 7);

    const claimedShow = runCli(['task', 'show', claimedRef, '--json'], { cwd: dir, env });
    assert.equal(claimedShow.status, 0, claimedShow.stderr);
    assert.equal(JSON.parse(claimedShow.stdout).status, 'claimed');

    const rawShow = runCli(['task', 'show', rawRef, '--json'], { cwd: dir, env });
    assert.equal(rawShow.status, 0, rawShow.stderr);
    assert.equal(JSON.parse(rawShow.stdout).latest_event_type, 'created');
  } finally {
    taskDb.close();
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
      '--proof', 'premature validation passed',
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
      '--happened', 'Prepared the XP approval gate so autonomous work waits for human accept.',
      '--checked', 'I checked the task stayed in Review and did not mint XP.',
      '--tested', 'I ran the typecheck proof and inspected the diff.',
      '--decision', 'Accept if XP should land; rework if proof is missing.',
      '--as', 'codex',
      '--json',
    ], { cwd: dir, env });
    assert.equal(ready.status, 0, ready.stderr);
    const readyPayload = JSON.parse(ready.stdout);
    assert.equal(readyPayload.action, 'ready');
    assert.equal(readyPayload.approval_status, 'pending');
    assert.equal(readyPayload.review_pass_count, 1);
    assert.equal(readyPayload.agent_certified, false);
    assert.equal(readyPayload.handoff.native_goal_status, 'needs_second_agent_review');
    assert.equal(readyPayload.handoff.career_xp_status, 'pending_human_accept');
    assert.equal(readyPayload.handoff.next_action, 'agent_review_again');
    assert.equal(readyPayload.handoff.review_chat_command, `atris task review-chat ${ref} --as codex-review`);
    assert.equal(readyPayload.handoff.rule, 'Proof is ready; one more agent check before human approval. XP waits for the human.');
    assert.match(readyPayload.handoff.codex_prompt, new RegExp(`/codex review ${ref}`));
    assert.match(readyPayload.handoff.codex_prompt, /Approve autonomous work before XP/);
    assert.match(readyPayload.handoff.codex_prompt, /Proof: typecheck passed and diff reviewed/);
    assert.equal(readyPayload.task.status, 'review');
    assert.equal(readyPayload.task.review.summary, 'approve autonomous work before XP: proof is ready for human approval; approve only if the evidence is real.');
    assert.deepEqual(readyPayload.task.review.landing, {
      happened: 'Prepared the XP approval gate so autonomous work waits for human accept.',
      reason: 'It keeps real-world side effects behind a clear human decision.',
      checked: 'I checked the task stayed in Review and did not mint XP.',
      tested: 'I ran the typecheck proof and inspected the diff.',
      decision: 'Accept if XP should land; rework if proof is missing.',
    });
    assert.deepEqual(readyPayload.task.review.result, {
      changed: 'Prepared the XP approval gate so autonomous work waits for human accept.',
      reason: 'It keeps real-world side effects behind a clear human decision.',
      checked: 'I checked the task stayed in Review and did not mint XP.',
      saved: `Completed result saved for review as ${ref}.`,
      accept: 'Accept if XP should land; rework if proof is missing.',
    });
    assert.equal(readyPayload.task.review.proof, 'typecheck passed and diff reviewed');
    assert.equal(readyPayload.task.review.reward, null);
    assert.equal(readyPayload.task.review.approval_status, 'pending');
    assert.equal(readyPayload.task.review.agent_certified, undefined);
    assert.equal(readyPayload.task.review.verification_chat.command, `atris task review-chat ${ref} --as codex-review`);
    assert.match(readyPayload.task.review.verification_chat.codex_prompt, /\/codex review/);

    const readyShow = runCli(['task', 'show', ref], { cwd: dir, env });
    assert.equal(readyShow.status, 0, readyShow.stderr);
    assert.match(readyShow.stdout, /Result:/);
    assert.match(readyShow.stdout, /What happened: Prepared the XP approval gate so autonomous work waits for human accept\./);
    assert.match(readyShow.stdout, /Why it matters: It keeps real-world side effects behind a clear human decision\./);
    assert.match(readyShow.stdout, /How I checked: I checked the task stayed in Review and did not mint XP\./);
    assert.match(readyShow.stdout, /What I tested: I ran the typecheck proof and inspected the diff\./);
    assert.match(readyShow.stdout, new RegExp(`Saved: Completed result saved for review as ${ref}\\.`));
    assert.match(readyShow.stdout, /Decision: Accept if XP should land; rework if proof is missing\./);
    assert.match(readyShow.stdout, /Short version: approve autonomous work before XP: proof is ready for human approval; approve only if the evidence is real\./);
    assert.match(readyShow.stdout, /Details: typecheck passed and diff reviewed/);
    assert.match(readyShow.stdout, /Landing: waiting on human/);
    assert.match(readyShow.stdout, new RegExp(`Check command: atris task review-chat ${ref} --as codex-review`));
    assert.doesNotMatch(readyShow.stdout, /Agent certified: yes/);

    const reviewChat = runCli(['task', 'review-chat', ref, '--as', 'codex-review', '--json'], { cwd: dir, env });
    assert.equal(reviewChat.status, 0, reviewChat.stderr);
    const reviewChatPayload = JSON.parse(reviewChat.stdout);
    assert.equal(reviewChatPayload.action, 'review_chat');
    assert.equal(reviewChatPayload.appended, true);
    assert.equal(reviewChatPayload.contract.schema, 'atris.task_review_chat.v1');
    assert.equal(reviewChatPayload.contract.task.ref, ref);
    assert.match(reviewChatPayload.contract.codex_prompt, /\/codex review/);
    assert.equal(reviewChatPayload.contract.verification_focus.proof_claim, 'typecheck passed and diff reviewed');
    assert.match(reviewChatPayload.contract.required_checks.join('\n'), /Find the concrete verifier command/);
    assert.match(reviewChatPayload.contract.required_checks.join('\n'), /Do not run task accept/);
    assert.equal(reviewChatPayload.contract.pass_command, `atris task review ${ref} --reward 0 --as codex-review --proof "<specific verifier commands passed and diff/proof inspected>" --verify "<safe verifier command>"`);
    assert.equal(reviewChatPayload.contract.revise_command, `atris task revise ${ref} --as codex-review --note "<specific missing proof or required change>"`);
    assert.match(reviewChatPayload.task.messages.at(-1).content, /TASK_REVIEW_CHAT/);
    assert.match(reviewChatPayload.task.messages.at(-1).content, /proof_claim: typecheck passed and diff reviewed/);
    assert.match(reviewChatPayload.task.messages.at(-1).content, /commands_to_verify:/);
    assert.match(reviewChatPayload.task.messages.at(-1).content, /files_to_inspect:/);
    assert.match(reviewChatPayload.task.messages.at(-1).content, /human_accept_xp: atris task accept/);

    fs.writeFileSync(path.join(dir, 'review-verify.js'), 'const ok = true;\n', 'utf8');
    const prooflessReview = runCli([
      'task', 'review', ref,
      '--reward', '0',
      '--as', 'validator',
      '--verify', 'node --check review-verify.js',
      '--json',
    ], { cwd: dir, env });
    assert.equal(prooflessReview.status, 0, prooflessReview.stderr);
    assert.equal(JSON.parse(prooflessReview.stdout).task.review.proof, 'typecheck passed and diff reviewed');
    assert.equal(JSON.parse(prooflessReview.stdout).task.review.agent_review_pass_count, 2);
    assert.equal(JSON.parse(prooflessReview.stdout).task.review.agent_certified, true);
    assert.equal(JSON.parse(prooflessReview.stdout).task.metadata.agent_certified, true);
    assert.equal(JSON.parse(prooflessReview.stdout).task.metadata.verify, 'node --check review-verify.js');

    const nextAfterReviewCertification = runCli(['task', 'next', '--as', 'codex', '--json'], { cwd: dir, env });
    assert.equal(nextAfterReviewCertification.status, 0, nextAfterReviewCertification.stderr);
    const firstNextPayload = JSON.parse(nextAfterReviewCertification.stdout);
    assert.equal(firstNextPayload.action, 'human_accept_waiting');
    assert.equal(firstNextPayload.task_id, readyPayload.task.id);
    assert.equal(firstNextPayload.handoff.next_action, 'human_accept_waiting');
    assert.equal(firstNextPayload.continue_work_command, null);

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
    assert.equal(certifiedPayload.review_pass_count, 3);
    assert.equal(certifiedPayload.agent_certified, true);
    assert.equal(certifiedPayload.handoff.native_goal_status, 'agent_certified');
    assert.equal(certifiedPayload.handoff.career_xp_status, 'pending_human_accept');
    assert.equal(certifiedPayload.handoff.next_action, 'continue_work');
    assert.equal(certifiedPayload.handoff.review_chat_command, undefined);
    assert.equal(certifiedPayload.handoff.codex_prompt, undefined);
    assert.equal(certifiedPayload.handoff.verification_focus, undefined);
    assert.equal(certifiedPayload.handoff.rule, 'Double-check complete; ready to keep moving. XP is awarded only after the human approves the task.');
    assert.equal(certifiedPayload.task.status, 'review');
    assert.equal(certifiedPayload.task.review.approval_status, 'pending');
    assert.equal(certifiedPayload.task.review.agent_review_pass_count, 3);
    assert.equal(certifiedPayload.task.review.agent_certified, true);
    assert.equal(certifiedPayload.task.review.verification_chat, undefined);
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
	    assert.match(certifiedShow.stdout, /Details: typecheck passed and diff reviewed again/);
	    assert.match(certifiedShow.stdout, /Landing: waiting on human/);
	    assert.match(certifiedShow.stdout, /Checked: yes \(3 agent checks\)/);

	    for (let i = 0; i < 10; i += 1) {
	      const note = runCli(['task', 'note', ref, `post-ready context ${i}`, '--as', 'codex'], { cwd: dir, env });
	      assert.equal(note.status, 0, note.stderr);
	    }

    const statusAfterCertification = runCli(['task', 'status', '--json'], { cwd: dir, env });
    assert.equal(statusAfterCertification.status, 0, statusAfterCertification.stderr);
    const statusPayload = JSON.parse(statusAfterCertification.stdout);
    assert.equal(statusPayload.status.current, null);
    assert.equal(statusPayload.status.counts.active, 0);
    assert.equal(statusPayload.status.counts.review, 1);
    assert.equal(statusPayload.status.counts.review_blocking, 0);
    assert.equal(statusPayload.status.counts.review_certified, 1);
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
    assert.match(readyText.stdout, /ready for approval .*/);
    assert.match(readyText.stdout, /Proof is ready; one more agent check before human approval\. XP waits for the human\./);

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
    assert.equal(acceptPayload.task.review.summary, 'Completed AgentXP result for approve autonomous work before XP.');
    assert.equal(acceptPayload.task.review.result.saved, `Result accepted as ${ref}.`);
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
      '--proof', 'cli clear validation passed',
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
    assert.equal(clearCliPayload.episode.proof, 'cli clear validation passed');
    assert.equal(clearCliPayload.episode.lesson, '');
    assert.equal(clearCliPayload.episode.next_task_suggestion, null);
    assert.equal(clearCliPayload.task.review.proof, 'cli clear validation passed');
    assert.equal(Object.prototype.hasOwnProperty.call(clearCliPayload.task.review, 'lesson'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(clearCliPayload.task.review, 'next_task'), false);

	    const events = runCli(['task', 'events', ref, '--json'], { cwd: dir, env });
	    assert.equal(events.status, 0, events.stderr);
	    const eventTypes = JSON.parse(events.stdout).events.map(event => event.event_type);
	    assert.deepEqual(eventTypes.slice(0, 6), ['created', 'claimed', 'proof_ready', 'message', 'reviewed', 'proof_ready']);
	    assert.deepEqual(eventTypes.slice(-2), ['completed', 'reviewed']);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task review accepts clean dry-run verifier', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const add = runCli([
      'task', 'add', 'Review with clean dry-run proof',
      '--tag', 'maintenance',
      '--json',
    ], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const ref = JSON.parse(add.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', ref, '--as', 'codex'], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'ready', ref,
      '--proof', 'node bin/atris.js clean --dry-run --json passed before verifier review',
      '--as', 'codex',
    ], { cwd: dir, env }).status, 0);

    const review = runCli([
      'task', 'review', ref,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node bin/atris.js clean --dry-run --json reported no map repairs',
      '--verify', 'node bin/atris.js clean --dry-run --json',
      '--json',
    ], { cwd: dir, env });
    assert.equal(review.status, 0, review.stderr);
    assert.equal(JSON.parse(review.stdout).task.metadata.verify, 'node bin/atris.js clean --dry-run --json');

    const mutatingReview = runCli([
      'task', 'review', ref,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'git diff --check passed before unsafe clean command rejection',
      '--verify', 'node bin/atris.js clean --json',
      '--json',
    ], { cwd: dir, env });
    assert.equal(mutatingReview.status, 2);
    assert.equal(JSON.parse(mutatingReview.stdout).reason, 'verify_command_not_allowed');
  } finally {
    cleanupTempDir(dir);
  }
});

test('task review-chat emits proof-specific verifier packet', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const add = runCli([
      'task', 'add', 'Verify review chat specificity',
      '--tag', 'agent',
      '--goal-objective', 'Make Review chat tell Codex exactly what to verify',
      '--json',
    ], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const ref = JSON.parse(add.stdout).task.display_id;

    const tooEarly = runCli(['task', 'review-chat', ref, '--json'], { cwd: dir, env });
    assert.equal(tooEarly.status, 1);
    assert.equal(JSON.parse(tooEarly.stdout).reason, 'not_reviewable_open');

    assert.equal(runCli(['task', 'claim', ref, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const proofContext = `${'context '.repeat(180)}Long proofs can carry setup notes before the verification commands.`;
    const proof = [
      proofContext,
      'Rechecked node --check commands/task.js lib/task-db.js passed, node --test test/commands.test.js passed, git diff --check -- commands/task.js lib/task-db.js test/commands.test.js clean, live ATRIS_SKIP_UPDATE_CHECK=1 atris task reviews --limit 3 --json from project-obelisk showed rows. tail-marker-full-proof-must-survive',
    ].join(' ');
    const ready = runCli([
      'task', 'ready', ref,
      '--proof', proof,
      '--lesson', 'Review packets need concrete proof targets',
      '--next', 'Wire the task page to launch this verifier',
      '--as', 'codex',
      '--json',
    ], { cwd: dir, env });
    assert.equal(ready.status, 0, ready.stderr);
    const readyPayload = JSON.parse(ready.stdout);
    assert.ok(readyPayload.handoff.verification_focus.commands_to_verify.some(command => command.includes('node --check commands/task.js')));
    assert.ok(readyPayload.handoff.verification_focus.commands_to_verify.some(command => command.includes('node --test test/commands.test.js')));
    assert.ok(readyPayload.handoff.verification_focus.files_to_inspect.includes('commands/task.js'));
    assert.match(readyPayload.handoff.codex_prompt, /Commands: command 1: node --check commands\/task\.js/);

    const reviewChat = runCli(['task', 'review-chat', ref, '--as', 'codex-review', '--json'], { cwd: dir, env });
    assert.equal(reviewChat.status, 0, reviewChat.stderr);
    const payload = JSON.parse(reviewChat.stdout);
    assert.equal(payload.action, 'review_chat');
    assert.equal(payload.contract.task.ref, ref);
    assert.equal(payload.contract.verification_focus.objective, 'Make Review chat tell Codex exactly what to verify');
    assert.equal(payload.contract.verification_focus.proof_claim, proof);
    assert.deepEqual(payload.contract.verification_focus.commands_to_verify.slice(0, 4), [
      'node --check commands/task.js lib/task-db.js',
      'node --test test/commands.test.js',
      'git diff --check -- commands/task.js lib/task-db.js test/commands.test.js',
      'ATRIS_SKIP_UPDATE_CHECK=1 atris task reviews --limit 3 --json',
    ]);
    assert.ok(payload.contract.verification_focus.commands_to_verify.some(command => command.includes('node --check commands/task.js')));
    assert.ok(payload.contract.verification_focus.commands_to_verify.some(command => command.includes('node --test test/commands.test.js')));
    assert.ok(payload.contract.verification_focus.commands_to_verify.some(command => command.includes('git diff --check')));
    assert.ok(payload.contract.verification_focus.files_to_inspect.includes('commands/task.js'));
    assert.ok(payload.contract.verification_focus.files_to_inspect.includes('lib/task-db.js'));
    assert.ok(payload.contract.verification_focus.files_to_inspect.includes('test/commands.test.js'));
    assert.ok(!payload.contract.verification_focus.commands_to_verify.some(command => command.includes('atris-cli/commands')));
    assert.ok(!payload.contract.verification_focus.files_to_inspect.some(file => file.includes('commands_to_verify/files_to_inspect')));
    assert.match(payload.contract.codex_prompt, /Verify review chat specificity/);
    assert.match(payload.contract.codex_prompt, /Commands: command 1: node --check commands\/task\.js/);
    assert.match(payload.contract.codex_prompt, /Files\/artifacts: commands\/task\.js, lib\/task-db\.js, test\/commands\.test\.js/);
    assert.match(payload.contract.required_checks.join('\n'), /Re-run or inspect these proof commands/);
    assert.match(payload.contract.required_checks.join('\n'), /Inspect these named files\/artifacts/);
    assert.match(payload.task.messages.at(-1).content, /TASK_REVIEW_CHAT/);
    assert.match(payload.task.messages.at(-1).content, /proof_claim: context context/);
    assert.match(payload.task.messages.at(-1).content, /tail-marker-full-proof-must-survive/);
    assert.match(payload.task.messages.at(-1).content, /commands_to_verify:\n- node --check commands\/task\.js/);
    assert.match(payload.task.messages.at(-1).content, /files_to_inspect:\n- commands\/task\.js/);
    assert.ok(Array.isArray(payload.contract.verification_focus.recent_thread));
    assert.match(payload.task.messages.at(-1).content, /pass: atris task review/);
    assert.match(payload.task.messages.at(-1).content, /human_accept_xp: atris task accept/);
    assert.match(payload.task.messages.at(-1).content.slice(0, 500), /human_accept_xp: atris task accept/);

    const reviewProof = [
      `${'context '.repeat(180)}Long verifier review proof before commands`,
      'node --test test/commands.test.js passed',
      'git diff --check -- commands/task.js test/commands.test.js clean',
    ].join('; ');
    const proofReview = runCli([
      'task', 'review', ref,
      '--reward', '0',
      '--as', 'validator',
      '--proof', reviewProof,
      '--json',
    ], { cwd: dir, env });
    assert.equal(proofReview.status, 0, proofReview.stderr);

    const statusAfterProofReview = runCli(['task', 'status', '--json'], { cwd: dir, env });
    assert.equal(statusAfterProofReview.status, 0, statusAfterProofReview.stderr);
    const statusReview = JSON.parse(statusAfterProofReview.stdout).status.needs_review[0].review;
    assert.match(statusReview.proof, /context context/);
    assert.equal(statusReview.agent_certified, true);
    assert.equal(statusReview.verification_chat, undefined);

    const showAfterProofReview = runCli(['task', 'show', ref, '--json'], { cwd: dir, env });
    assert.equal(showAfterProofReview.status, 0, showAfterProofReview.stderr);
    const showReview = JSON.parse(showAfterProofReview.stdout).review;
    assert.equal(showReview.proof, reviewProof);
    assert.equal(showReview.agent_certified, true);
    assert.equal(showReview.verification_chat, undefined);

    const certifiedReviewProof = [
      `${'context '.repeat(180)}Certified rows can still receive newer verifier proof`,
      'node --test test/commands.test.js passed after certification',
      'git diff --check -- commands/task.js lib/task-db.js test/commands.test.js clean',
    ].join('; ');
    const certifiedProofReview = runCli([
      'task', 'review', ref,
      '--reward', '0',
      '--as', 'validator',
      '--proof', certifiedReviewProof,
      '--json',
    ], { cwd: dir, env });
    assert.equal(certifiedProofReview.status, 0, certifiedProofReview.stderr);

    const certifiedStatus = runCli(['task', 'status', '--json'], { cwd: dir, env });
    assert.equal(certifiedStatus.status, 0, certifiedStatus.stderr);
    const certifiedStatusReview = JSON.parse(certifiedStatus.stdout).status.needs_review[0].review;
    assert.match(certifiedStatusReview.proof, /context context/);
    assert.equal(certifiedStatusReview.verification_chat, undefined);

    const certifiedShow = runCli(['task', 'show', ref, '--json'], { cwd: dir, env });
    assert.equal(certifiedShow.status, 0, certifiedShow.stderr);
    const certifiedShowReview = JSON.parse(certifiedShow.stdout).review;
    assert.equal(certifiedShowReview.proof, certifiedReviewProof);
    assert.equal(certifiedShowReview.verification_chat, undefined);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task review-chat extracts only proof-derived verifier commands', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const semicolonTask = runCli(['task', 'new', 'Semicolon proof commands', '--json'], { cwd: dir, env });
    assert.equal(semicolonTask.status, 0, semicolonTask.stderr);
    const semicolonRef = JSON.parse(semicolonTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', semicolonRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const semicolonReady = runCli([
      'task', 'ready', semicolonRef,
      '--as', 'codex',
      '--proof', '`node --check commands/task.js` passed; `node --test test/commands.test.js` passed',
      '--json',
    ], { cwd: dir, env });
    assert.equal(semicolonReady.status, 0, semicolonReady.stderr);
    const semicolonChat = runCli(['task', 'review-chat', semicolonRef, '--json'], { cwd: dir, env });
    assert.equal(semicolonChat.status, 0, semicolonChat.stderr);
    assert.deepEqual(JSON.parse(semicolonChat.stdout).contract.verification_focus.commands_to_verify, [
      'node --check commands/task.js',
      'node --test test/commands.test.js',
    ]);

    const commaTask = runCli(['task', 'new', 'Comma proof commands', '--json'], { cwd: dir, env });
    assert.equal(commaTask.status, 0, commaTask.stderr);
    const commaRef = JSON.parse(commaTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', commaRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const commaReady = runCli([
      'task', 'ready', commaRef,
      '--as', 'codex',
      '--proof', 'Installed Atris review-chat command extraction changed. Verification passed: node --check commands/task.js, verified node --test test/commands.test.js 295/295, scoped git diff --check -- commands/task.js test/commands.test.js clean, live ATRIS_SKIP_UPDATE_CHECK=1 atris task status --json returned ok',
      '--json',
    ], { cwd: dir, env });
    assert.equal(commaReady.status, 0, commaReady.stderr);
    const commaChat = runCli(['task', 'review-chat', commaRef, '--json'], { cwd: dir, env });
    assert.equal(commaChat.status, 0, commaChat.stderr);
    assert.deepEqual(JSON.parse(commaChat.stdout).contract.verification_focus.commands_to_verify, [
      'node --check commands/task.js',
      'node --test test/commands.test.js',
      'git diff --check -- commands/task.js test/commands.test.js',
      'ATRIS_SKIP_UPDATE_CHECK=1 atris task status --json',
    ]);

    const narratedTask = runCli(['task', 'new', 'Narrated CLI proof commands', '--json'], { cwd: dir, env });
    assert.equal(narratedTask.status, 0, narratedTask.stderr);
    const narratedRef = JSON.parse(narratedTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', narratedRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const narratedReady = runCli([
      'task', 'ready', narratedRef,
      '--as', 'codex',
      '--proof', 'Validation passed: node /Users/owner/arena/atris-cli/bin/atris.js business check printed Ready: yes; node /Users/owner/arena/atris-cli/bin/atris.js business share --write wrote atris/reports/share.md; node /Users/owner/arena/atris-cli/bin/atris.js app list reported agentgrads-match-room runtime=local',
      '--json',
    ], { cwd: dir, env });
    assert.equal(narratedReady.status, 0, narratedReady.stderr);
    const narratedChat = runCli(['task', 'review-chat', narratedRef, '--json'], { cwd: dir, env });
    assert.equal(narratedChat.status, 0, narratedChat.stderr);
    assert.deepEqual(JSON.parse(narratedChat.stdout).contract.verification_focus.commands_to_verify, [
      'node /Users/owner/arena/atris-cli/bin/atris.js business check',
      'node /Users/owner/arena/atris-cli/bin/atris.js business share --write',
      'node /Users/owner/arena/atris-cli/bin/atris.js app list',
    ]);

    const pathPassedTask = runCli(['task', 'new', 'Path then passed proof commands', '--json'], { cwd: dir, env });
    assert.equal(pathPassedTask.status, 0, pathPassedTask.stderr);
    const pathPassedRef = JSON.parse(pathPassedTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', pathPassedRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const pathPassedReady = runCli([
      'task', 'ready', pathPassedRef,
      '--as', 'codex',
      '--proof', 'Inspected commands/workflow.js, bin/atris.js, and atris/MAP.md. Passed: node --check commands/workflow.js; node --test test/apps.test.js (11/11); git diff --check -- commands/workflow.js bin/atris.js atris/MAP.md clean',
      '--json',
    ], { cwd: dir, env });
    assert.equal(pathPassedReady.status, 0, pathPassedReady.stderr);
    const pathPassedChat = runCli(['task', 'review-chat', pathPassedRef, '--json'], { cwd: dir, env });
    assert.equal(pathPassedChat.status, 0, pathPassedChat.stderr);
    assert.deepEqual(JSON.parse(pathPassedChat.stdout).contract.verification_focus.commands_to_verify, [
      'node --check commands/workflow.js',
      'node --test test/apps.test.js',
      'git diff --check -- commands/workflow.js bin/atris.js atris/MAP.md',
    ]);

    const chainedTask = runCli(['task', 'new', 'Chained proof commands', '--json'], { cwd: dir, env });
    assert.equal(chainedTask.status, 0, chainedTask.stderr);
    const chainedRef = JSON.parse(chainedTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', chainedRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const chainedReady = runCli([
      'task', 'ready', chainedRef,
      '--as', 'codex',
      '--proof', 'Verified node --check commands/task.js && node --check lib/task-db.js; node --test test/auto-accept-certified.test.js 6/6; installed Atris review-chat command extraction changed; installed atris temp review-chat smoke confirmed specificity; installed atris smoke confirmed review-chat specificity',
      '--json',
    ], { cwd: dir, env });
    assert.equal(chainedReady.status, 0, chainedReady.stderr);
    const chainedChat = runCli(['task', 'review-chat', chainedRef, '--json'], { cwd: dir, env });
    assert.equal(chainedChat.status, 0, chainedChat.stderr);
    assert.deepEqual(JSON.parse(chainedChat.stdout).contract.verification_focus.commands_to_verify, [
      'node --check commands/task.js',
      'node --check lib/task-db.js',
      'node --test test/auto-accept-certified.test.js',
    ]);

    const fencedTask = runCli(['task', 'new', 'Fenced proof commands', '--json'], { cwd: dir, env });
    assert.equal(fencedTask.status, 0, fencedTask.stderr);
    const fencedRef = JSON.parse(fencedTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', fencedRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const fencedReady = runCli([
      'task', 'ready', fencedRef,
      '--as', 'codex',
      '--proof', '```bash\nnode --check commands/task.js\nnode --test test/json-output.test.js passed\n```',
      '--json',
    ], { cwd: dir, env });
    assert.equal(fencedReady.status, 0, fencedReady.stderr);
    const fencedChat = runCli(['task', 'review-chat', fencedRef, '--json'], { cwd: dir, env });
    assert.equal(fencedChat.status, 0, fencedChat.stderr);
    assert.deepEqual(JSON.parse(fencedChat.stdout).contract.verification_focus.commands_to_verify, [
      'node --check commands/task.js',
      'node --test test/json-output.test.js',
    ]);

    const titleOnlyTask = runCli(['task', 'new', 'Fix git diff display', '--json'], { cwd: dir, env });
    assert.equal(titleOnlyTask.status, 0, titleOnlyTask.stderr);
    const titleOnlyRef = JSON.parse(titleOnlyTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', titleOnlyRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const titleOnlyReady = runCli([
      'task', 'ready', titleOnlyRef,
      '--as', 'codex',
      '--proof', 'manual browser validation passed',
      '--json',
    ], { cwd: dir, env });
    assert.equal(titleOnlyReady.status, 0, titleOnlyReady.stderr);
    const titleOnlyChat = runCli(['task', 'review-chat', titleOnlyRef, '--json'], { cwd: dir, env });
    assert.equal(titleOnlyChat.status, 0, titleOnlyChat.stderr);
    const titleOnlyPayload = JSON.parse(titleOnlyChat.stdout);
    assert.deepEqual(titleOnlyPayload.contract.verification_focus.commands_to_verify, []);
    assert.match(titleOnlyPayload.contract.required_checks.join('\n'), /Find the concrete verifier command/);

    const pathOnlyTask = runCli(['task', 'new', 'Inspect artifact path', '--json'], { cwd: dir, env });
    assert.equal(pathOnlyTask.status, 0, pathOnlyTask.stderr);
    const pathOnlyRef = JSON.parse(pathOnlyTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', pathOnlyRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const pathOnlyReady = runCli([
      'task', 'ready', pathOnlyRef,
      '--as', 'codex',
      '--proof', 'inspected commands/git-diff.js passed',
      '--json',
    ], { cwd: dir, env });
    assert.equal(pathOnlyReady.status, 0, pathOnlyReady.stderr);
    const pathOnlyChat = runCli(['task', 'review-chat', pathOnlyRef, '--json'], { cwd: dir, env });
    assert.equal(pathOnlyChat.status, 0, pathOnlyChat.stderr);
    const pathOnlyPayload = JSON.parse(pathOnlyChat.stdout);
    assert.deepEqual(pathOnlyPayload.contract.verification_focus.commands_to_verify, []);
    assert.ok(pathOnlyPayload.contract.verification_focus.files_to_inspect.includes('commands/git-diff.js'));

    const detailTask = runCli(['task', 'new', 'Trim status details', '--json'], { cwd: dir, env });
    assert.equal(detailTask.status, 0, detailTask.stderr);
    const detailRef = JSON.parse(detailTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', detailRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const detailReady = runCli([
      'task', 'ready', detailRef,
      '--as', 'codex',
      '--proof', 'Full `node --test test/commands.test.js` passed: 299 tests, 0 failures.',
      '--json',
    ], { cwd: dir, env });
    assert.equal(detailReady.status, 0, detailReady.stderr);
    const detailChat = runCli(['task', 'review-chat', detailRef, '--json'], { cwd: dir, env });
    assert.equal(detailChat.status, 0, detailChat.stderr);
    assert.deepEqual(JSON.parse(detailChat.stdout).contract.verification_focus.commands_to_verify, [
      'node --test test/commands.test.js',
    ]);

    const punctuationTask = runCli(['task', 'new', 'Trim status punctuation', '--json'], { cwd: dir, env });
    assert.equal(punctuationTask.status, 0, punctuationTask.stderr);
    const punctuationRef = JSON.parse(punctuationTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', punctuationRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const punctuationReady = runCli([
      'task', 'ready', punctuationRef,
      '--as', 'codex',
      '--proof', 'node --test test/commands.test.js passed.',
      '--json',
    ], { cwd: dir, env });
    assert.equal(punctuationReady.status, 0, punctuationReady.stderr);
    const punctuationChat = runCli(['task', 'review-chat', punctuationRef, '--json'], { cwd: dir, env });
    assert.equal(punctuationChat.status, 0, punctuationChat.stderr);
    assert.deepEqual(JSON.parse(punctuationChat.stdout).contract.verification_focus.commands_to_verify, [
      'node --test test/commands.test.js',
    ]);

    const bracketTask = runCli(['task', 'new', 'Bracket proof list', '--json'], { cwd: dir, env });
    assert.equal(bracketTask.status, 0, bracketTask.stderr);
    const bracketRef = JSON.parse(bracketTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', bracketRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const bracketReady = runCli([
      'task', 'ready', bracketRef,
      '--as', 'codex',
      '--proof', 'live review-chat dry-run emitted [node --check commands/task.js, node --check test/commands.test.js, git diff --check]',
      '--json',
    ], { cwd: dir, env });
    assert.equal(bracketReady.status, 0, bracketReady.stderr);
    const bracketChat = runCli(['task', 'review-chat', bracketRef, '--json'], { cwd: dir, env });
    assert.equal(bracketChat.status, 0, bracketChat.stderr);
    assert.deepEqual(JSON.parse(bracketChat.stdout).contract.verification_focus.commands_to_verify, [
      'node --check commands/task.js',
      'node --check test/commands.test.js',
      'git diff --check',
    ]);

    const pseudoTask = runCli(['task', 'new', 'Reject prose pseudo command', '--json'], { cwd: dir, env });
    assert.equal(pseudoTask.status, 0, pseudoTask.stderr);
    const pseudoRef = JSON.parse(pseudoTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', pseudoRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const pseudoReady = runCli([
      'task', 'ready', pseudoRef,
      '--as', 'codex',
      '--proof', 'validation passed: node command tests passed',
      '--json',
    ], { cwd: dir, env });
    assert.equal(pseudoReady.status, 0, pseudoReady.stderr);
    const pseudoChat = runCli(['task', 'review-chat', pseudoRef, '--json'], { cwd: dir, env });
    assert.equal(pseudoChat.status, 0, pseudoChat.stderr);
    assert.deepEqual(JSON.parse(pseudoChat.stdout).contract.verification_focus.commands_to_verify, []);

    const npmPseudoTask = runCli(['task', 'new', 'Reject npm prose pseudo command', '--json'], { cwd: dir, env });
    assert.equal(npmPseudoTask.status, 0, npmPseudoTask.stderr);
    const npmPseudoRef = JSON.parse(npmPseudoTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', npmPseudoRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const npmPseudoReady = runCli([
      'task', 'ready', npmPseudoRef,
      '--as', 'codex',
      '--proof', 'validation passed: npm command tests passed',
      '--json',
    ], { cwd: dir, env });
    assert.equal(npmPseudoReady.status, 0, npmPseudoReady.stderr);
    const npmPseudoChat = runCli(['task', 'review-chat', npmPseudoRef, '--json'], { cwd: dir, env });
    assert.equal(npmPseudoChat.status, 0, npmPseudoChat.stderr);
    assert.deepEqual(JSON.parse(npmPseudoChat.stdout).contract.verification_focus.commands_to_verify, []);

    const pluralPseudoTask = runCli(['task', 'new', 'Reject plural prose pseudo commands', '--json'], { cwd: dir, env });
    assert.equal(pluralPseudoTask.status, 0, pluralPseudoTask.stderr);
    const pluralPseudoRef = JSON.parse(pluralPseudoTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', pluralPseudoRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const pluralPseudoReady = runCli([
      'task', 'ready', pluralPseudoRef,
      '--as', 'codex',
      '--proof', 'validation passed: npm tests passed, git checks passed',
      '--json',
    ], { cwd: dir, env });
    assert.equal(pluralPseudoReady.status, 0, pluralPseudoReady.stderr);
    const pluralPseudoChat = runCli(['task', 'review-chat', pluralPseudoRef, '--json'], { cwd: dir, env });
    assert.equal(pluralPseudoChat.status, 0, pluralPseudoChat.stderr);
    assert.deepEqual(JSON.parse(pluralPseudoChat.stdout).contract.verification_focus.commands_to_verify, []);

    const atrisSlugTask = runCli(['task', 'new', 'Reject Atris slug prose pseudo command', '--json'], { cwd: dir, env });
    assert.equal(atrisSlugTask.status, 0, atrisSlugTask.stderr);
    const atrisSlugRef = JSON.parse(atrisSlugTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', atrisSlugRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const atrisSlugReady = runCli([
      'task', 'ready', atrisSlugRef,
      '--as', 'codex',
      '--proof', 'Second-pass review: recruiting shortcut fallback is scoped to the built-in atris-labs shortcut, keeps generic business lookup strict, and full npm test passed 1635/1635.',
      '--json',
    ], { cwd: dir, env });
    assert.equal(atrisSlugReady.status, 0, atrisSlugReady.stderr);
    const atrisSlugReadyPayload = JSON.parse(atrisSlugReady.stdout);
    assert.equal(atrisSlugReadyPayload.task.review.landing.tested, 'I ran the listed check for this result.');
    const atrisSlugChat = runCli(['task', 'review-chat', atrisSlugRef, '--json'], { cwd: dir, env });
    assert.equal(atrisSlugChat.status, 0, atrisSlugChat.stderr);
    assert.deepEqual(JSON.parse(atrisSlugChat.stdout).contract.verification_focus.commands_to_verify, [
      'npm test',
    ]);

    const atrisWildcardTask = runCli(['task', 'new', 'Reject Atris wildcard prose pseudo command', '--json'], { cwd: dir, env });
    assert.equal(atrisWildcardTask.status, 0, atrisWildcardTask.stderr);
    const atrisWildcardRef = JSON.parse(atrisWildcardTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', atrisWildcardRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const atrisWildcardReady = runCli([
      'task', 'ready', atrisWildcardRef,
      '--as', 'codex',
      '--proof', 'Second-pass review: extractor now rejects atris-* slug prose before command token matching; live review queue shows CLI-640 Commands: npm test only; node --test test/commands.test.js passed 381/381.',
      '--json',
    ], { cwd: dir, env });
    assert.equal(atrisWildcardReady.status, 0, atrisWildcardReady.stderr);
    const atrisWildcardReadyPayload = JSON.parse(atrisWildcardReady.stdout);
    assert.equal(atrisWildcardReadyPayload.task.review.landing.tested, 'I ran the listed checks for this result.');
    assert.doesNotMatch(atrisWildcardReadyPayload.task.review.landing.tested, /atris-\*/);
    assert.doesNotMatch(atrisWildcardReadyPayload.task.review.landing.tested, /npm test only/);
    const atrisWildcardChat = runCli(['task', 'review-chat', atrisWildcardRef, '--json'], { cwd: dir, env });
    assert.equal(atrisWildcardChat.status, 0, atrisWildcardChat.stderr);
    assert.deepEqual(JSON.parse(atrisWildcardChat.stdout).contract.verification_focus.commands_to_verify, [
      'npm test',
      'node --test test/commands.test.js',
    ]);

    const proseSegmentTask = runCli(['task', 'new', 'Semicolon prose segment', '--json'], { cwd: dir, env });
    assert.equal(proseSegmentTask.status, 0, proseSegmentTask.stderr);
    const proseSegmentRef = JSON.parse(proseSegmentTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', proseSegmentRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const proseSegmentReady = runCli([
      'task', 'ready', proseSegmentRef,
      '--as', 'codex',
      '--proof', 'node --check commands/task.js; focused three-test command; git diff --check -- commands/task.js test/commands.test.js',
      '--json',
    ], { cwd: dir, env });
    assert.equal(proseSegmentReady.status, 0, proseSegmentReady.stderr);
    const proseSegmentChat = runCli(['task', 'review-chat', proseSegmentRef, '--json'], { cwd: dir, env });
    assert.equal(proseSegmentChat.status, 0, proseSegmentChat.stderr);
    assert.deepEqual(JSON.parse(proseSegmentChat.stdout).contract.verification_focus.commands_to_verify, [
      'node --check commands/task.js',
      'git diff --check -- commands/task.js test/commands.test.js',
    ]);

    const thenJoinedTask = runCli(['task', 'new', 'Then joined commands', '--json'], { cwd: dir, env });
    assert.equal(thenJoinedTask.status, 0, thenJoinedTask.stderr);
    const thenJoinedRef = JSON.parse(thenJoinedTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', thenJoinedRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const thenJoinedReady = runCli([
      'task', 'ready', thenJoinedRef,
      '--as', 'codex',
      '--proof', 'node --check commands/task.js then node --check test/commands.test.js passed',
      '--json',
    ], { cwd: dir, env });
    assert.equal(thenJoinedReady.status, 0, thenJoinedReady.stderr);
    const thenJoinedChat = runCli(['task', 'review-chat', thenJoinedRef, '--json'], { cwd: dir, env });
    assert.equal(thenJoinedChat.status, 0, thenJoinedChat.stderr);
    assert.deepEqual(JSON.parse(thenJoinedChat.stdout).contract.verification_focus.commands_to_verify, [
      'node --check commands/task.js',
      'node --check test/commands.test.js',
    ]);

    const pipelineTask = runCli(['task', 'new', 'Preserve pipeline command', '--json'], { cwd: dir, env });
    assert.equal(pipelineTask.status, 0, pipelineTask.stderr);
    const pipelineRef = JSON.parse(pipelineTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', pipelineRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const pipelineReady = runCli([
      'task', 'ready', pipelineRef,
      '--as', 'codex',
      '--proof', 'curl -fsS http://127.0.0.1:8000/api/health | rg ok passed',
      '--json',
    ], { cwd: dir, env });
    assert.equal(pipelineReady.status, 0, pipelineReady.stderr);
    const pipelineChat = runCli(['task', 'review-chat', pipelineRef, '--json'], { cwd: dir, env });
    assert.equal(pipelineChat.status, 0, pipelineChat.stderr);
    assert.deepEqual(JSON.parse(pipelineChat.stdout).contract.verification_focus.commands_to_verify, [
      'curl -fsS http://127.0.0.1:8000/api/health | rg ok',
    ]);

    const parenStatusTask = runCli(['task', 'new', 'Trim parenthesized status', '--json'], { cwd: dir, env });
    assert.equal(parenStatusTask.status, 0, parenStatusTask.stderr);
    const parenStatusRef = JSON.parse(parenStatusTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', parenStatusRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const parenStatusReady = runCli([
      'task', 'ready', parenStatusRef,
      '--as', 'codex',
      '--proof', 'node --test test/commands.test.js (passed)',
      '--json',
    ], { cwd: dir, env });
    assert.equal(parenStatusReady.status, 0, parenStatusReady.stderr);
    const parenStatusChat = runCli(['task', 'review-chat', parenStatusRef, '--json'], { cwd: dir, env });
    assert.equal(parenStatusChat.status, 0, parenStatusChat.stderr);
    assert.deepEqual(JSON.parse(parenStatusChat.stdout).contract.verification_focus.commands_to_verify, [
      'node --test test/commands.test.js',
    ]);

    const exitStatusTask = runCli(['task', 'new', 'Trim exit status annotation', '--json'], { cwd: dir, env });
    assert.equal(exitStatusTask.status, 0, exitStatusTask.stderr);
    const exitStatusRef = JSON.parse(exitStatusTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', exitStatusRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const exitStatusReady = runCli([
      'task', 'ready', exitStatusRef,
      '--as', 'codex',
      '--proof', 'node --test test/commands.test.js passed (exit 0)',
      '--json',
    ], { cwd: dir, env });
    assert.equal(exitStatusReady.status, 0, exitStatusReady.stderr);
    const exitStatusChat = runCli(['task', 'review-chat', exitStatusRef, '--json'], { cwd: dir, env });
    assert.equal(exitStatusChat.status, 0, exitStatusChat.stderr);
    assert.deepEqual(JSON.parse(exitStatusChat.stdout).contract.verification_focus.commands_to_verify, [
      'node --test test/commands.test.js',
    ]);

    const statusSentenceTask = runCli(['task', 'new', 'Trim status sentence', '--json'], { cwd: dir, env });
    assert.equal(statusSentenceTask.status, 0, statusSentenceTask.stderr);
    const statusSentenceRef = JSON.parse(statusSentenceTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', statusSentenceRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const statusSentenceReady = runCli([
      'task', 'ready', statusSentenceRef,
      '--as', 'codex',
      '--proof', 'validation passed: node --check commands/task.js passed. Output clean.',
      '--json',
    ], { cwd: dir, env });
    assert.equal(statusSentenceReady.status, 0, statusSentenceReady.stderr);
    const statusSentenceChat = runCli(['task', 'review-chat', statusSentenceRef, '--json'], { cwd: dir, env });
    assert.equal(statusSentenceChat.status, 0, statusSentenceChat.stderr);
    assert.deepEqual(JSON.parse(statusSentenceChat.stdout).contract.verification_focus.commands_to_verify, [
      'node --check commands/task.js',
    ]);

    const passCountTask = runCli(['task', 'new', 'Trim pass count suffix', '--json'], { cwd: dir, env });
    assert.equal(passCountTask.status, 0, passCountTask.stderr);
    const passCountRef = JSON.parse(passCountTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', passCountRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const passCountReady = runCli([
      'task', 'ready', passCountRef,
      '--as', 'codex',
      '--proof', 'full node --test test/commands.test.js passed 299/299',
      '--json',
    ], { cwd: dir, env });
    assert.equal(passCountReady.status, 0, passCountReady.stderr);
    const passCountChat = runCli(['task', 'review-chat', passCountRef, '--json'], { cwd: dir, env });
    assert.equal(passCountChat.status, 0, passCountChat.stderr);
    assert.deepEqual(JSON.parse(passCountChat.stdout).contract.verification_focus.commands_to_verify, [
      'node --test test/commands.test.js',
    ]);

    const passExplanationTask = runCli(['task', 'new', 'Trim pass count explanation', '--json'], { cwd: dir, env });
    assert.equal(passExplanationTask.status, 0, passExplanationTask.stderr);
    const passExplanationRef = JSON.parse(passExplanationTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', passExplanationRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const passExplanationReady = runCli([
      'task', 'ready', passExplanationRef,
      '--as', 'codex',
      '--proof', "node --test test/mission-status.test.js passed 51/51, including the new regression 'mission tick keeps task-backed always-on caller-session missions runnable without verifier'. Live proof: atris mission tick mission-abc.",
      '--json',
    ], { cwd: dir, env });
    assert.equal(passExplanationReady.status, 0, passExplanationReady.stderr);
    const passExplanationChat = runCli(['task', 'review-chat', passExplanationRef, '--json'], { cwd: dir, env });
    assert.equal(passExplanationChat.status, 0, passExplanationChat.stderr);
    assert.deepEqual(JSON.parse(passExplanationChat.stdout).contract.verification_focus.commands_to_verify, [
      'node --test test/mission-status.test.js',
    ]);

    const changedFilesTailTask = runCli(['task', 'new', 'Trim changed files tail', '--json'], { cwd: dir, env });
    assert.equal(changedFilesTailTask.status, 0, changedFilesTailTask.stderr);
    const changedFilesTailRef = JSON.parse(changedFilesTailTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', changedFilesTailRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const changedFilesTailReady = runCli([
      'task', 'ready', changedFilesTailRef,
      '--as', 'codex',
      '--proof', 'node --test test/mission-status.test.js passed 46/46. Changed files: lib/mission-room.js adds business-move naming.',
      '--json',
    ], { cwd: dir, env });
    assert.equal(changedFilesTailReady.status, 0, changedFilesTailReady.stderr);
    const changedFilesTailChat = runCli(['task', 'review-chat', changedFilesTailRef, '--json'], { cwd: dir, env });
    assert.equal(changedFilesTailChat.status, 0, changedFilesTailChat.stderr);
    assert.deepEqual(JSON.parse(changedFilesTailChat.stdout).contract.verification_focus.commands_to_verify, [
      'node --test test/mission-status.test.js',
    ]);

    const passedWithTailTask = runCli(['task', 'new', 'Trim passed with tail', '--json'], { cwd: dir, env });
    assert.equal(passedWithTailTask.status, 0, passedWithTailTask.stderr);
    const passedWithTailRef = JSON.parse(passedWithTailTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', passedWithTailRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const passedWithTailReady = runCli([
      'task', 'ready', passedWithTailRef,
      '--as', 'codex',
      '--proof', 'node scripts/verify-mission-room.js passed with member=mission-lead. node --test test/mission-status.test.js passed.',
      '--json',
    ], { cwd: dir, env });
    assert.equal(passedWithTailReady.status, 0, passedWithTailReady.stderr);
    const passedWithTailChat = runCli(['task', 'review-chat', passedWithTailRef, '--json'], { cwd: dir, env });
    assert.equal(passedWithTailChat.status, 0, passedWithTailChat.stderr);
    assert.deepEqual(JSON.parse(passedWithTailChat.stdout).contract.verification_focus.commands_to_verify, [
      'node scripts/verify-mission-room.js',
      'node --test test/mission-status.test.js',
    ]);

    const exampleCommandTask = runCli(['task', 'new', 'Ignore example command subject', '--json'], { cwd: dir, env });
    assert.equal(exampleCommandTask.status, 0, exampleCommandTask.stderr);
    const exampleCommandRef = JSON.parse(exampleCommandTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', exampleCommandRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const exampleCommandReady = runCli([
      'task', 'ready', exampleCommandRef,
      '--as', 'codex',
      '--proof', 'Product proof: review packets no longer ask humans to rerun result text like node scripts/verify-mission-room.js passed with member=mission-lead. Checks: node -c commands/task.js; git diff --check.',
      '--json',
    ], { cwd: dir, env });
    assert.equal(exampleCommandReady.status, 0, exampleCommandReady.stderr);
    const exampleCommandChat = runCli(['task', 'review-chat', exampleCommandRef, '--json'], { cwd: dir, env });
    assert.equal(exampleCommandChat.status, 0, exampleCommandChat.stderr);
    assert.deepEqual(JSON.parse(exampleCommandChat.stdout).contract.verification_focus.commands_to_verify, [
      'node -c commands/task.js',
      'git diff --check',
    ]);

    const commaResultTask = runCli(['task', 'new', 'Trim comma result prose', '--json'], { cwd: dir, env });
    assert.equal(commaResultTask.status, 0, commaResultTask.stderr);
    const commaResultRef = JSON.parse(commaResultTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', commaResultRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const commaResultReady = runCli([
      'task', 'ready', commaResultRef,
      '--as', 'codex',
      '--proof', 'node --check commands/mission.js passed, live run proved stderr_empty=true. Checks: git diff --check.',
      '--json',
    ], { cwd: dir, env });
    assert.equal(commaResultReady.status, 0, commaResultReady.stderr);
    const commaResultChat = runCli(['task', 'review-chat', commaResultRef, '--json'], { cwd: dir, env });
    assert.equal(commaResultChat.status, 0, commaResultChat.stderr);
    assert.deepEqual(JSON.parse(commaResultChat.stdout).contract.verification_focus.commands_to_verify, [
      'node --check commands/mission.js',
      'git diff --check',
    ]);

    const focusedSuiteTask = runCli(['task', 'new', 'Split focused suite verifier', '--json'], { cwd: dir, env });
    assert.equal(focusedSuiteTask.status, 0, focusedSuiteTask.stderr);
    const focusedSuiteRef = JSON.parse(focusedSuiteTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', focusedSuiteRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const focusedSuiteReady = runCli([
      'task', 'ready', focusedSuiteRef,
      '--as', 'codex',
      '--proof', 'node scripts/verify-mission-room.js. Focused suite also passed separately: node --test test/mission-status.test.js.',
      '--json',
    ], { cwd: dir, env });
    assert.equal(focusedSuiteReady.status, 0, focusedSuiteReady.stderr);
    const focusedSuiteChat = runCli(['task', 'review-chat', focusedSuiteRef, '--json'], { cwd: dir, env });
    assert.equal(focusedSuiteChat.status, 0, focusedSuiteChat.stderr);
    assert.deepEqual(JSON.parse(focusedSuiteChat.stdout).contract.verification_focus.commands_to_verify, [
      'node scripts/verify-mission-room.js',
      'node --test test/mission-status.test.js',
    ]);

    const commaProseTask = runCli(['task', 'new', 'Trim comma prose command list', '--json'], { cwd: dir, env });
    assert.equal(commaProseTask.status, 0, commaProseTask.stderr);
    const commaProseRef = JSON.parse(commaProseTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', commaProseRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const commaProseReady = runCli([
      'task', 'ready', commaProseRef,
      '--as', 'codex',
      '--proof', 'Verified commands/task.js with node -c commands/task.js passed, command suite, clean dry-run, brain compile.',
      '--json',
    ], { cwd: dir, env });
    assert.equal(commaProseReady.status, 0, commaProseReady.stderr);
    const commaProseChat = runCli(['task', 'review-chat', commaProseRef, '--json'], { cwd: dir, env });
    assert.equal(commaProseChat.status, 0, commaProseChat.stderr);
    assert.deepEqual(JSON.parse(commaProseChat.stdout).contract.verification_focus.commands_to_verify, [
      'node -c commands/task.js',
    ]);

    const describedCommandTask = runCli(['task', 'new', 'Ignore described command subject', '--json'], { cwd: dir, env });
    assert.equal(describedCommandTask.status, 0, describedCommandTask.stderr);
    const describedCommandRef = JSON.parse(describedCommandTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', describedCommandRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const describedCommandReady = runCli([
      'task', 'ready', describedCommandRef,
      '--as', 'codex',
      '--proof', 'Product proof: parser extracts only node --test test/mission-status.test.js. Checks: node -c commands/task.js; git diff --check.',
      '--json',
    ], { cwd: dir, env });
    assert.equal(describedCommandReady.status, 0, describedCommandReady.stderr);
    const describedCommandChat = runCli(['task', 'review-chat', describedCommandRef, '--json'], { cwd: dir, env });
    assert.equal(describedCommandChat.status, 0, describedCommandChat.stderr);
    assert.deepEqual(JSON.parse(describedCommandChat.stdout).contract.verification_focus.commands_to_verify, [
      'node -c commands/task.js',
      'git diff --check',
    ]);

    const productProofTask = runCli(['task', 'new', 'Product proof command extraction', '--json'], { cwd: dir, env });
    assert.equal(productProofTask.status, 0, productProofTask.stderr);
    const productProofRef = JSON.parse(productProofTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', productProofRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const productProofReady = runCli([
      'task', 'ready', productProofRef,
      '--as', 'codex',
      '--proof', "Product proof: live mission goal now says next_command=atris mission run mission-2026-06-30-work-overnight-and-see-where-1858e505, so the overnight loop continues instead of asking for task review. Checks: node -c commands/mission.js; node --test test/mission-status.test.js --test-name-pattern 'always-on|mission goal' (57 pass); node bin/atris.js mission goal --json; node bin/atris.js clean --dry-run --json; git diff --check; node bin/atris.js brain compile --root . --verify.",
      '--json',
    ], { cwd: dir, env });
    assert.equal(productProofReady.status, 0, productProofReady.stderr);
    const productProofReadyPayload = JSON.parse(productProofReady.stdout);
    assert.equal(productProofReadyPayload.task.review.landing.tested, 'I ran the listed checks for this result.');
    assert.doesNotMatch(productProofReadyPayload.task.review.landing.tested, /node -c commands\/mission\.js \| node --test/);
    const productProofChat = runCli(['task', 'review-chat', productProofRef, '--json'], { cwd: dir, env });
    assert.equal(productProofChat.status, 0, productProofChat.stderr);
    const productProofPayload = JSON.parse(productProofChat.stdout);
    assert.deepEqual(productProofPayload.contract.verification_focus.commands_to_verify, [
      'node -c commands/mission.js',
      "node --test test/mission-status.test.js --test-name-pattern 'always-on|mission goal'",
      'node bin/atris.js mission goal --json',
      'node bin/atris.js clean --dry-run --json',
      'git diff --check',
      'node bin/atris.js brain compile --root . --verify',
    ]);
    assert.match(productProofPayload.contract.codex_prompt, /command 1: node -c commands\/mission\.js/);
    assert.doesNotMatch(productProofPayload.contract.codex_prompt, /node -c commands\/mission\.js \| node --test/);

    const quotedPipeTask = runCli(['task', 'new', 'Quoted pipe proof command', '--json'], { cwd: dir, env });
    assert.equal(quotedPipeTask.status, 0, quotedPipeTask.stderr);
    const quotedPipeRef = JSON.parse(quotedPipeTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', quotedPipeRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const quotedPipeReady = runCli([
      'task', 'ready', quotedPipeRef,
      '--as', 'codex',
      '--proof', "Checks passed: node --test test/commands.test.js --test-name-pattern 'always-on mission run keeps ticking|clean dry-run shows MAP refs|clean --dry-run --json reports machine-readable health' (380 pass); git diff --check.",
      '--json',
    ], { cwd: dir, env });
    assert.equal(quotedPipeReady.status, 0, quotedPipeReady.stderr);
    const quotedPipeReadyPayload = JSON.parse(quotedPipeReady.stdout);
    assert.equal(quotedPipeReadyPayload.task.review.landing.tested, 'I ran the listed checks for this result.');
    assert.doesNotMatch(quotedPipeReadyPayload.task.review.landing.tested, /health' \| git diff --check/);
    const quotedPipeChat = runCli(['task', 'review-chat', quotedPipeRef, '--json'], { cwd: dir, env });
    assert.equal(quotedPipeChat.status, 0, quotedPipeChat.stderr);
    const quotedPipePayload = JSON.parse(quotedPipeChat.stdout);
    assert.deepEqual(quotedPipePayload.contract.verification_focus.commands_to_verify, [
      "node --test test/commands.test.js --test-name-pattern 'always-on mission run keeps ticking|clean dry-run shows MAP refs|clean --dry-run --json reports machine-readable health'",
      'git diff --check',
    ]);
    assert.match(quotedPipePayload.contract.codex_prompt, /command 1: node --test test\/commands\.test\.js/);
    assert.match(quotedPipePayload.contract.required_checks.join('\n'), /command 2: git diff --check/);
    assert.doesNotMatch(quotedPipePayload.contract.codex_prompt, /health' \| git diff --check/);
    assert.doesNotMatch(quotedPipePayload.contract.required_checks.join('\n'), /health' \| git diff --check/);

    const quotedListTask = runCli(['task', 'new', 'Quoted command-list examples', '--json'], { cwd: dir, env });
    assert.equal(quotedListTask.status, 0, quotedListTask.stderr);
    const quotedListRef = JSON.parse(quotedListTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', quotedListRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const quotedListReady = runCli([
      'task', 'ready', quotedListRef,
      '--as', 'codex',
      '--proof', "Product proof says 'Commands: command 1: <pipe-containing test command>; command 2: git diff --check'. Checks passed: node -c commands/task.js; git diff --check.",
      '--json',
    ], { cwd: dir, env });
    assert.equal(quotedListReady.status, 0, quotedListReady.stderr);
    const quotedListPayload = JSON.parse(quotedListReady.stdout);
    assert.deepEqual(quotedListPayload.handoff.verification_focus.commands_to_verify, [
      'node -c commands/task.js',
      'git diff --check',
    ]);
    assert.equal(quotedListPayload.task.review.landing.tested, 'I ran the listed checks for this result.');

    const quotedProductTask = runCli(['task', 'new', 'Quoted product command example', '--json'], { cwd: dir, env });
    assert.equal(quotedProductTask.status, 0, quotedProductTask.stderr);
    const quotedProductRef = JSON.parse(quotedProductTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', quotedProductRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const quotedProductReady = runCli([
      'task', 'ready', quotedProductRef,
      '--as', 'codex',
      '--proof', "Product proof: live Mission Report plain text now ends with 'Next: atris mission run mission-2026-06-30-work-overnight-and-see-where-1858e505' instead of 'Next: next move: run ...'. JSON still keeps operator_next raw for machines. Checks: node -c commands/mission.js; node --test test/mission-status.test.js --test-name-pattern 'mission report' (60 pass); git diff --check.",
      '--json',
    ], { cwd: dir, env });
    assert.equal(quotedProductReady.status, 0, quotedProductReady.stderr);
    const quotedProductChat = runCli(['task', 'review-chat', quotedProductRef, '--json'], { cwd: dir, env });
    assert.equal(quotedProductChat.status, 0, quotedProductChat.stderr);
    assert.deepEqual(JSON.parse(quotedProductChat.stdout).contract.verification_focus.commands_to_verify, [
      'node -c commands/mission.js',
      "node --test test/mission-status.test.js --test-name-pattern 'mission report'",
      'git diff --check',
    ]);

    const optionBeforeFileTask = runCli(['task', 'new', 'Quoted option-before-file verifier', '--json'], { cwd: dir, env });
    assert.equal(optionBeforeFileTask.status, 0, optionBeforeFileTask.stderr);
    const optionBeforeFileRef = JSON.parse(optionBeforeFileTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', optionBeforeFileRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const optionBeforeFileReady = runCli([
      'task', 'ready', optionBeforeFileRef,
      '--as', 'codex',
      '--proof', "Product proof: the review handoff preserves the full verifier command, including node --test --test-name-pattern with quoted test names containing 'and'. Checks: node --test test/mission-xp.test.js; node --test --test-name-pattern 'mission run blocks Codex-goal work until native goal ack|mission goal-loop attaches task spine before due mission work|mission goal-loop runs due mission work once and refreshes final state' test/mission-status.test.js; git diff --check; atris clean --dry-run --json; atris brain compile --root . --verify.",
      '--json',
    ], { cwd: dir, env });
    assert.equal(optionBeforeFileReady.status, 0, optionBeforeFileReady.stderr);
    const optionBeforeFilePayload = JSON.parse(optionBeforeFileReady.stdout);
    assert.deepEqual(optionBeforeFilePayload.handoff.verification_focus.commands_to_verify, [
      'node --test test/mission-xp.test.js',
      "node --test --test-name-pattern 'mission run blocks Codex-goal work until native goal ack|mission goal-loop attaches task spine before due mission work|mission goal-loop runs due mission work once and refreshes final state' test/mission-status.test.js",
      'git diff --check',
      'atris clean --dry-run --json',
      'atris brain compile --root . --verify',
    ]);

    const noteTailTask = runCli(['task', 'new', 'Trim note tail from verifier command', '--json'], { cwd: dir, env });
    assert.equal(noteTailTask.status, 0, noteTailTask.stderr);
    const noteTailRef = JSON.parse(noteTailTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', noteTailRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const noteTailReady = runCli([
      'task', 'ready', noteTailRef,
      '--as', 'codex',
      '--proof', 'Checks: atris brain compile --root . --verify. Note: full npm test still has unrelated failures queued for later work.',
      '--json',
    ], { cwd: dir, env });
    assert.equal(noteTailReady.status, 0, noteTailReady.stderr);
    assert.deepEqual(JSON.parse(noteTailReady.stdout).handoff.verification_focus.commands_to_verify, [
      'atris brain compile --root . --verify',
    ]);

    const withPassingTask = runCli(['task', 'new', 'Trim with passing test tail', '--json'], { cwd: dir, env });
    assert.equal(withPassingTask.status, 0, withPassingTask.stderr);
    const withPassingRef = JSON.parse(withPassingTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', withPassingRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const withPassingReady = runCli([
      'task', 'ready', withPassingRef,
      '--as', 'codex',
      '--proof', "Checks passed: node --test test/commands.test.js --test-name-pattern 'task review-chat extracts only proof-derived verifier commands' with 380 passing tests; git diff --check.",
      '--json',
    ], { cwd: dir, env });
    assert.equal(withPassingReady.status, 0, withPassingReady.stderr);
    const withPassingPayload = JSON.parse(withPassingReady.stdout);
    assert.doesNotMatch(withPassingPayload.task.review.landing.tested, /with 380 passing tests/);
    assert.equal(withPassingPayload.task.review.landing.checked, 'I ran the behavior check and the diff cleanliness check.');
    const withPassingChat = runCli(['task', 'review-chat', withPassingRef, '--json'], { cwd: dir, env });
    assert.equal(withPassingChat.status, 0, withPassingChat.stderr);
    assert.deepEqual(JSON.parse(withPassingChat.stdout).contract.verification_focus.commands_to_verify, [
      "node --test test/commands.test.js --test-name-pattern 'task review-chat extracts only proof-derived verifier commands'",
      'git diff --check',
    ]);

    const receiptCheckedTask = runCli(['task', 'new', 'Receipt-specific checked landing', '--json'], { cwd: dir, env });
    assert.equal(receiptCheckedTask.status, 0, receiptCheckedTask.stderr);
    const receiptCheckedRef = JSON.parse(receiptCheckedTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', receiptCheckedRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const receiptCheckedReady = runCli([
      'task', 'ready', receiptCheckedRef,
      '--as', 'codex',
      '--proof', 'Second-pass review: receipt atris/runs/mission-example-2026-06-30T00-00-00-000Z.json verifier_result.passed=true.',
      '--json',
    ], { cwd: dir, env });
    assert.equal(receiptCheckedReady.status, 0, receiptCheckedReady.stderr);
    const receiptCheckedPayload = JSON.parse(receiptCheckedReady.stdout);
    assert.equal(receiptCheckedPayload.task.review.landing.checked, 'I inspected the passing receipt named in the proof.');

    const outputCheckedTask = runCli(['task', 'new', 'Verifier output checked landing', '--json'], { cwd: dir, env });
    assert.equal(outputCheckedTask.status, 0, outputCheckedTask.stderr);
    const outputCheckedRef = JSON.parse(outputCheckedTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', outputCheckedRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const outputCheckedReady = runCli([
      'task', 'ready', outputCheckedRef,
      '--as', 'codex',
      '--proof', 'node scripts/verify-mission-product-wedge.js printed MISSION PRODUCT WEDGE VERIFIED.',
      '--json',
    ], { cwd: dir, env });
    assert.equal(outputCheckedReady.status, 0, outputCheckedReady.stderr);
    assert.equal(JSON.parse(outputCheckedReady.stdout).task.review.landing.checked, 'I checked the verifier output named in the proof.');

    const passesCheckedTask = runCli(['task', 'new', 'Passes checked landing', '--json'], { cwd: dir, env });
    assert.equal(passesCheckedTask.status, 0, passesCheckedTask.stderr);
    const passesCheckedRef = JSON.parse(passesCheckedTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', passesCheckedRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const passesCheckedReady = runCli([
      'task', 'ready', passesCheckedRef,
      '--as', 'codex',
      '--proof', 'node scripts/verify-mission-artifact-timeline.js passes.',
      '--json',
    ], { cwd: dir, env });
    assert.equal(passesCheckedReady.status, 0, passesCheckedReady.stderr);
    assert.equal(JSON.parse(passesCheckedReady.stdout).task.review.landing.checked, 'I ran the verifier named in the proof.');

    const proseCheckedTask = runCli(['task', 'new', 'Prose-only proof landing', '--json'], { cwd: dir, env });
    assert.equal(proseCheckedTask.status, 0, proseCheckedTask.stderr);
    const proseCheckedRef = JSON.parse(proseCheckedTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', proseCheckedRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const proseCheckedReady = runCli([
      'task', 'ready', proseCheckedRef,
      '--as', 'codex',
      '--proof', 'Agent review: help output renders, clean dry-run dropped stale pages, the help-focused test slice passed 379/379, and diff cleanliness passed.',
      '--json',
    ], { cwd: dir, env });
    assert.equal(proseCheckedReady.status, 0, proseCheckedReady.stderr);
    assert.equal(JSON.parse(proseCheckedReady.stdout).task.review.landing.tested, 'I checked: help output, clean dry-run, passing tests, and 1 more check.');

    const rewardTailTask = runCli(['task', 'new', 'Trim human gate tail', '--json'], { cwd: dir, env });
    assert.equal(rewardTailTask.status, 0, rewardTailTask.stderr);
    const rewardTailRef = JSON.parse(rewardTailTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', rewardTailRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const rewardTailReady = runCli([
      'task', 'ready', rewardTailRef,
      '--as', 'codex',
      '--proof', 'node --test test/commands.test.js. Reward remains 0; no human accept or XP.',
      '--json',
    ], { cwd: dir, env });
    assert.equal(rewardTailReady.status, 0, rewardTailReady.stderr);
    const rewardTailChat = runCli(['task', 'review-chat', rewardTailRef, '--json'], { cwd: dir, env });
    assert.equal(rewardTailChat.status, 0, rewardTailChat.stderr);
    assert.deepEqual(JSON.parse(rewardTailChat.stdout).contract.verification_focus.commands_to_verify, [
      'node --test test/commands.test.js',
    ]);

    const humanAcceptTask = runCli(['task', 'new', 'Reject human accept proof prose', '--json'], { cwd: dir, env });
    assert.equal(humanAcceptTask.status, 0, humanAcceptTask.stderr);
    const humanAcceptRef = JSON.parse(humanAcceptTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', humanAcceptRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const humanAcceptReady = runCli([
      'task', 'ready', humanAcceptRef,
      '--as', 'codex',
      '--proof', 'node --check commands/task.js passed. Do not run atris task accept OBL-1; no human accept or XP.',
      '--json',
    ], { cwd: dir, env });
    assert.equal(humanAcceptReady.status, 0, humanAcceptReady.stderr);
    const humanAcceptChat = runCli(['task', 'review-chat', humanAcceptRef, '--json'], { cwd: dir, env });
    assert.equal(humanAcceptChat.status, 0, humanAcceptChat.stderr);
    assert.deepEqual(JSON.parse(humanAcceptChat.stdout).contract.verification_focus.commands_to_verify, [
      'node --check commands/task.js',
    ]);

    const longFiles = Array.from({ length: 10 }, (_, index) => `test/long-${index}.test.js`).join(' ');
    const longCommand = `node --test ${longFiles}`;
    assert.ok(longCommand.length > 180);
    const longCommandTask = runCli(['task', 'new', 'Preserve long verifier command', '--json'], { cwd: dir, env });
    assert.equal(longCommandTask.status, 0, longCommandTask.stderr);
    const longCommandRef = JSON.parse(longCommandTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', longCommandRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const longCommandReady = runCli([
      'task', 'ready', longCommandRef,
      '--as', 'codex',
      '--proof', `${longCommand} passed`,
      '--json',
    ], { cwd: dir, env });
    assert.equal(longCommandReady.status, 0, longCommandReady.stderr);
    const longCommandChat = runCli(['task', 'review-chat', longCommandRef, '--json'], { cwd: dir, env });
    assert.equal(longCommandChat.status, 0, longCommandChat.stderr);
    assert.deepEqual(JSON.parse(longCommandChat.stdout).contract.verification_focus.commands_to_verify, [
      longCommand,
    ]);

    const jsonFileTask = runCli(['task', 'new', 'JSON named verifier file', '--json'], { cwd: dir, env });
    assert.equal(jsonFileTask.status, 0, jsonFileTask.stderr);
    const jsonFileRef = JSON.parse(jsonFileTask.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', jsonFileRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const jsonFileReady = runCli([
      'task', 'ready', jsonFileRef,
      '--as', 'codex',
      '--proof', '`node --test test/json-output.test.js` passed',
      '--json',
    ], { cwd: dir, env });
    assert.equal(jsonFileReady.status, 0, jsonFileReady.stderr);
    const jsonFileChat = runCli(['task', 'review-chat', jsonFileRef, '--json'], { cwd: dir, env });
    assert.equal(jsonFileChat.status, 0, jsonFileChat.stderr);
    assert.deepEqual(JSON.parse(jsonFileChat.stdout).contract.verification_focus.commands_to_verify, [
      'node --test test/json-output.test.js',
    ]);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task next claims open work before surfacing review debt', () => {
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
    assert.equal(runCli(['task', 'ready', reviewRef, '--proof', 'first pass validation passed', '--as', 'codex'], { cwd: dir, env }).status, 0);

    const openAdd = runCli(['task', 'add', 'Open work must wait', '--tag', 'agent', '--json'], { cwd: dir, env });
    assert.equal(openAdd.status, 0, openAdd.stderr);
    const openPayload = JSON.parse(openAdd.stdout);

    const next = runCli(['task', 'next', '--as', 'codex', '--json'], { cwd: dir, env });
    assert.equal(next.status, 0, next.stderr);
    const payload = JSON.parse(next.stdout);
    assert.equal(payload.action, 'next');
    assert.equal(payload.task_id, openPayload.task.id);

    const openShow = runCli(['task', 'show', openPayload.task.display_id, '--json'], { cwd: dir, env });
    assert.equal(openShow.status, 0, openShow.stderr);
    assert.equal(JSON.parse(openShow.stdout).status, 'claimed');

    const reviewShow = runCli(['task', 'show', reviewRef, '--json'], { cwd: dir, env });
    assert.equal(reviewShow.status, 0, reviewShow.stderr);
    assert.equal(JSON.parse(reviewShow.stdout).status, 'review');
  } finally {
    cleanupTempDir(dir);
  }
});

test('task next surfaces review debt when no open work exists', () => {
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
    assert.equal(runCli(['task', 'ready', reviewRef, '--proof', 'first pass validation passed', '--as', 'codex'], { cwd: dir, env }).status, 0);

    const next = runCli(['task', 'next', '--as', 'codex', '--json'], { cwd: dir, env });
    assert.equal(next.status, 0, next.stderr);
    const payload = JSON.parse(next.stdout);
    assert.equal(payload.action, 'agent_review_again');
    assert.equal(payload.task_id, JSON.parse(reviewAdd.stdout).task.id);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task next surfaces Endgame fallback for human-only certified review', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex-executor' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), [
      '# TODO.md',
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

    const created = runCli(['task', 'new', 'Certified checkpoint', '--tag', 'runner', '--json'], { cwd: dir, env });
    assert.equal(created.status, 0, created.stderr);
    const ref = JSON.parse(created.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', ref, '--as', 'codex-executor'], { cwd: dir, env }).status, 0);
    assert.equal(runCli(['task', 'ready', ref, '--proof', 'node --test test/commands.test.js passed', '--as', 'codex-executor'], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'review', ref,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js passed during certification',
    ], { cwd: dir, env }).status, 0);

    const next = runCli(['task', 'next', '--as', 'codex-executor', '--json'], { cwd: dir, env });
    assert.equal(next.status, 0, next.stderr);
    const payload = JSON.parse(next.stdout);
    assert.equal(payload.action, 'human_accept_waiting');
    assert.equal(payload.next_agent_action.kind, 'create_bounded_endgame_task');
    assert.equal(payload.next_agent_action.endgame_slug, 'runner-swap-safe');
    assert.match(payload.next_agent_action.horizon, /runner swaps should be config-only/);
    assert.match(payload.next_agent_action.command, /atris brain activate --member codex-executor/);
    assert.match(payload.next_agent_action.message, /Do not accept XP/);
    assert.equal(payload.next_agent_action.task_seed.tag, 'runner');
    assert.match(payload.next_agent_action.task_seed.title, /runner-agnostic heartbeat gap/);
    assert.deepEqual(payload.next_agent_action.task_seed.files, [
      'commands/autopilot.js',
      'commands/run.js',
      'lib/runner-command.js',
      'test/autopilot-runner-model.test.js',
    ]);
    assert.match(payload.next_agent_action.task_seed.verifier, /test\/autopilot-runner-model\.test\.js/);
    assert.match(payload.next_agent_action.task_seed.create_command, /atris task new/);
    assert.match(payload.next_agent_action.task_seed.note_command, /Files: commands\/autopilot\.js/);

    const text = runCli(['task', 'next', '--as', 'codex-executor'], { cwd: dir, env });
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /Create the next bounded task from Endgame runner-swap-safe/);
    assert.match(text.stdout, /runner swaps should be config-only/);
    assert.match(text.stdout, /Do not accept XP/);
    assert.match(text.stdout, /Create: atris task new/);
    assert.match(text.stdout, /Claim: atris task claim <id> --as codex-executor/);
    assert.match(text.stdout, /Verify: node --test test\/autopilot-runner-model\.test\.js/);
    assert.doesNotMatch(text.stdout, /No concrete next agent task is attached/);

    const createNext = runCli(['task', 'next', '--as', 'codex-executor', '--create-next', '--json'], { cwd: dir, env });
    assert.equal(createNext.status, 0, createNext.stderr);
    const createdPayload = JSON.parse(createNext.stdout);
    assert.equal(createdPayload.action, 'created_next');
    assert.equal(createdPayload.task.status, 'claimed');
    assert.equal(createdPayload.task.claimed_by, 'codex-executor');
    assert.equal(createdPayload.task.tag, 'runner');
    assert.match(createdPayload.task.title, /runner-agnostic heartbeat gap/);
    assert.equal(createdPayload.review_task.display_id, ref);

    const after = runCli(['task', 'next', '--as', 'codex-executor', '--json'], { cwd: dir, env });
    assert.equal(after.status, 0, after.stderr);
    const afterPayload = JSON.parse(after.stdout);
    assert.equal(afterPayload.action, 'current');
    assert.equal(afterPayload.task_id, createdPayload.task_id);

    const show = runCli(['task', 'show', createdPayload.task.display_id, '--json'], { cwd: dir, env });
    assert.equal(show.status, 0, show.stderr);
    const shown = JSON.parse(show.stdout);
    assert.match(shown.messages[0].content, /Goal: Find and close one remaining runner-agnostic heartbeat gap/);
    assert.match(shown.messages[0].content, /Check: node --test test\/autopilot-runner-model\.test\.js/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task next does not repeat an Endgame seed that already exists', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex-executor' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), [
      '# TODO.md',
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

    const existing = runCli([
      'task', 'new', 'Audit and close next runner-agnostic heartbeat gap',
      '--tag', 'runner',
      '--json',
    ], { cwd: dir, env });
    assert.equal(existing.status, 0, existing.stderr);
    const existingTask = JSON.parse(existing.stdout).task;
    assert.equal(runCli(['task', 'claim', existingTask.display_id, '--as', 'auto-improver'], { cwd: dir, env }).status, 0);

    const created = runCli(['task', 'new', 'Certified checkpoint', '--tag', 'runner', '--json'], { cwd: dir, env });
    assert.equal(created.status, 0, created.stderr);
    const ref = JSON.parse(created.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', ref, '--as', 'codex-executor'], { cwd: dir, env }).status, 0);
    assert.equal(runCli(['task', 'ready', ref, '--proof', 'node --test test/commands.test.js passed', '--as', 'codex-executor'], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'review', ref,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js passed during certification',
    ], { cwd: dir, env }).status, 0);

    const next = runCli(['task', 'next', '--as', 'codex-executor', '--json'], { cwd: dir, env });
    assert.equal(next.status, 0, next.stderr);
    const payload = JSON.parse(next.stdout);
    assert.equal(payload.action, 'human_accept_waiting');
    assert.equal(payload.next_agent_action, null);
    assert.equal(payload.review_task.display_id, ref);

    const text = runCli(['task', 'next', '--as', 'codex-executor'], { cwd: dir, env });
    assert.equal(text.status, 0, text.stderr);
    assert.doesNotMatch(text.stdout, /Create the next bounded task/);
    assert.doesNotMatch(text.stdout, /Create: atris task new/);
    assert.match(text.stdout, /No next agent task is attached/);

    const duplicate = runCli(['task', 'next', '--as', 'codex-executor', '--create-next', '--json'], { cwd: dir, env });
    assert.notEqual(duplicate.status, 0);
    const duplicatePayload = JSON.parse(duplicate.stdout);
    assert.equal(duplicatePayload.reason, 'no_create_next_seed');
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
      '--proof', 'closed stale duplicate scheduler claims; validation passed reward 0',
      '--as', 'codex',
      '--json',
    ], { cwd: dir, env });
    assert.equal(ready.status, 0, ready.stderr);
    const readyPayload = JSON.parse(ready.stdout);
    assert.equal(readyPayload.task.review.summary, 'clean stale claimed task queue after XP review: review the completed result, then approve or ask for rework.');
    assert.deepEqual(readyPayload.task.review.landing, {
      happened: 'Cleaned stale claimed task queue after XP review.',
      reason: 'It turns the task title into a concrete result the human can approve.',
      checked: 'I ran the validation check.',
      tested: 'I attached the proof below.',
      decision: 'Needs one more check; ask for rework if the receipt misses the point.',
    });
    assert.equal(readyPayload.task.review.result.changed, 'Cleaned stale claimed task queue after XP review.');
    assert.equal(readyPayload.task.review.result.checked, 'I ran the validation check.');
    assert.equal(readyPayload.task.review.proof, 'closed stale duplicate scheduler claims; validation passed reward 0');

    const readyShow = runCli(['task', 'show', ref], { cwd: dir, env });
    assert.equal(readyShow.status, 0, readyShow.stderr);
    assert.match(readyShow.stdout, /Result:/);
    assert.match(readyShow.stdout, /What happened: Cleaned stale claimed task queue after XP review\./);
    assert.match(readyShow.stdout, /How I checked: I ran the validation check\./);
    assert.match(readyShow.stdout, /What I tested: I attached the proof below\./);
    assert.match(readyShow.stdout, /Why it matters: It turns the task title into a concrete result the human can approve\./);
    assert.match(readyShow.stdout, /Decision: Needs one more check; ask for rework if the receipt misses the point\./);
    assert.match(readyShow.stdout, /Short version: clean stale claimed task queue after XP review: review the completed result, then approve or ask for rework\./);
    assert.match(readyShow.stdout, /Details: closed stale duplicate scheduler claims; validation passed reward 0/);
    assert.doesNotMatch(readyShow.stdout, /AgentXP a real local scoreboard/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task ready default landing describes completed work for unmapped titles', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const add = runCli([
      'task', 'add', 'Explore review landing output',
      '--tag', 'cli',
      '--json',
    ], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const ref = JSON.parse(add.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', ref, '--as', 'codex'], { cwd: dir, env }).status, 0);

    const ready = runCli([
      'task', 'ready', ref,
      '--proof', 'node --test test/commands.test.js passed',
      '--as', 'codex',
      '--json',
    ], { cwd: dir, env });
    assert.equal(ready.status, 0, ready.stderr);
    const readyPayload = JSON.parse(ready.stdout);
    assert.equal(readyPayload.task.review.landing.happened, 'Completed: Explore review landing output.');
    assert.equal(readyPayload.task.review.result.changed, 'Completed: Explore review landing output.');

    const readyShow = runCli(['task', 'show', ref], { cwd: dir, env });
    assert.equal(readyShow.status, 0, readyShow.stderr);
    assert.match(readyShow.stdout, /What happened: Completed: Explore review landing output\./);
    assert.doesNotMatch(readyShow.stdout, /Explore review landing output is ready to review/);
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
    assert.equal(runCli(['task', 'ready', ref, '--proof', 'accept validation passed', '--as', 'codex'], { cwd: dir, env }).status, 0);

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

test('task proof-only agent env blocks acceptance verbs', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = {
    ATRIS_TASKS_DB: dbPath,
    NODE_NO_WARNINGS: '1',
    ATRIS_AGENT_ID: 'codex',
    ATRIS_AGENT_PROOF_ONLY: '1',
  };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const add = runCli(['task', 'add', 'Proof-only guard task', '--tag', 'agent-xp', '--json'], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const ref = JSON.parse(add.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', ref, '--as', 'codex'], { cwd: dir, env }).status, 0);

    const done = runCli(['task', 'done', ref, '--as', 'codex', '--proof', 'proof-only guard checked done command', '--json'], { cwd: dir, env });
    assert.equal(done.status, 2);
    assert.equal(JSON.parse(done.stdout).reason, 'agent_proof_only_human_accept_blocked');

    const finish = runCli(['task', 'finish', ref, '--as', 'codex', '--proof', 'proof-only guard checked finish command', '--json'], { cwd: dir, env });
    assert.equal(finish.status, 2);
    assert.equal(JSON.parse(finish.stdout).reason, 'agent_proof_only_human_accept_blocked');

    const positiveReview = runCli([
      'task', 'review', ref,
      '--reward', '1',
      '--as', 'codex-review',
      '--proof', 'proof-only guard checked positive review command',
      '--json',
    ], { cwd: dir, env });
    assert.equal(positiveReview.status, 2);
    assert.equal(JSON.parse(positiveReview.stdout).reason, 'agent_proof_only_human_accept_blocked');

    const ready = runCli([
      'task', 'ready', ref,
      '--as', 'codex',
      '--proof', 'node --check commands/task.js passed and git diff --check passed for proof-only guard',
      '--json',
    ], { cwd: dir, env });
    assert.equal(ready.status, 0, ready.stderr);

    const zeroReview = runCli([
      'task', 'review', ref,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js proof-only guard passed and diff inspected',
      '--json',
    ], { cwd: dir, env });
    assert.equal(zeroReview.status, 0, zeroReview.stderr);

    const accept = runCli(['task', 'accept', ref, '--as', 'keshavrao', '--json'], { cwd: dir, env });
    assert.equal(accept.status, 2);
    assert.equal(JSON.parse(accept.stdout).reason, 'agent_proof_only_human_accept_blocked');

    const autoAccept = runCli([
      'task', 'auto-accept-certified',
      '--confirm-human-accept',
      '--as', 'keshavrao',
      '--json',
    ], { cwd: dir, env });
    assert.equal(autoAccept.status, 2);
    assert.equal(JSON.parse(autoAccept.stdout).reason, 'agent_proof_only_human_accept_blocked');

    const show = runCli(['task', 'show', ref, '--json'], { cwd: dir, env });
    assert.equal(show.status, 0, show.stderr);
    const task = JSON.parse(show.stdout);
    assert.equal(task.status, 'review');
    assert.equal(task.metadata.approval_status, 'pending');
  } finally {
    cleanupTempDir(dir);
  }
});

test('task auto-accept-certified requires explicit human confirmation', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const add = runCli(['task', 'add', 'Auto accept still needs a human', '--tag', 'agent-xp', '--json'], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const ref = JSON.parse(add.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', ref, '--as', 'codex'], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'ready', ref,
      '--proof', 'node --test test/commands.test.js passed and git diff --check passed',
      '--as', 'codex',
    ], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'review', ref,
      '--reward', '0',
      '--as', 'validator',
      '--proof', 'node --test test/commands.test.js passed and diff inspected',
    ], { cwd: dir, env }).status, 0);

    const unconfirmed = runCli(['task', 'auto-accept-certified', '--json'], { cwd: dir, env });
    assert.equal(unconfirmed.status, 2);
    assert.equal(JSON.parse(unconfirmed.stdout).reason, 'human_accept_confirmation_required');
    assert.equal(JSON.parse(runCli(['task', 'show', ref, '--json'], { cwd: dir, env }).stdout).status, 'review');

    const missingActor = runCli(['task', 'auto-accept-certified', '--confirm-human-accept', '--json'], { cwd: dir, env });
    assert.equal(missingActor.status, 2);
    assert.equal(JSON.parse(missingActor.stdout).reason, 'human_actor_required');

    const flagActor = runCli(['task', 'auto-accept-certified', '--confirm-human-accept', '--as', '--json'], { cwd: dir, env });
    assert.equal(flagActor.status, 2);
    assert.equal(JSON.parse(flagActor.stdout).reason, 'human_actor_required');

    const preview = runCli(['task', 'auto-accept-certified', '--dry-run', '--json'], { cwd: dir, env });
    assert.equal(preview.status, 0, preview.stderr);
    const previewPayload = JSON.parse(preview.stdout);
    assert.equal(previewPayload.action, 'auto_accept_certified_dry_run');
    assert.equal(previewPayload.summary.would_accept, 1);
    assert.equal(previewPayload.scanned, previewPayload.summary.scanned);
    assert.equal(previewPayload.accepted, previewPayload.summary.accepted);
    assert.equal(previewPayload.would_accept, previewPayload.summary.would_accept);
    assert.equal(previewPayload.skipped, previewPayload.summary.skipped);
    assert.equal(previewPayload.failed, previewPayload.summary.failed);
    assert.equal(previewPayload.results[0].action, 'would_accept');
    assert.equal(JSON.parse(runCli(['task', 'show', ref, '--json'], { cwd: dir, env }).stdout).status, 'review');

    const strictPreview = runCli(['task', 'auto-accept-certified', '--dry-run', '--strict-verify', '--json'], { cwd: dir, env });
    assert.equal(strictPreview.status, 0, strictPreview.stderr);
    const strictPayload = JSON.parse(strictPreview.stdout);
    assert.equal(strictPayload.summary.would_accept, 0);
    assert.equal(strictPayload.summary.skipped, 1);
    assert.equal(strictPayload.would_accept, 0);
    assert.equal(strictPayload.skipped, 1);
    assert.equal(strictPayload.results[0].reason, 'strict_verify_missing');
    assert.match(strictPayload.results[0].next_action, /metadata\.verify/);
    assert.equal(strictPayload.results[0].review_chat_command, `atris task review-chat ${ref} --as codex-review`);

    const strictText = runCli(['task', 'auto-accept-certified', '--dry-run', '--strict-verify'], { cwd: dir, env });
    assert.equal(strictText.status, 0, strictText.stderr);
    assert.match(strictText.stdout, /SKIPPED .*strict_verify_missing/);
    assert.match(strictText.stdout, /next_action=.*metadata\.verify/);
    assert.match(strictText.stdout, new RegExp(`review_chat=atris task review-chat ${ref} --as codex-review`));

    fs.writeFileSync(path.join(dir, 'verify.js'), 'const ok = true;\n', 'utf8');
    const verifyReview = runCli([
      'task', 'review', ref,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --check verify.js passed and diff inspected',
      '--verify', 'node --check verify.js',
      '--json',
    ], { cwd: dir, env });
    assert.equal(verifyReview.status, 0, verifyReview.stderr);
    assert.equal(JSON.parse(verifyReview.stdout).task.metadata.verify, 'node --check verify.js');

    const strictVerifiedPreview = runCli(['task', 'auto-accept-certified', '--dry-run', '--strict-verify', '--json'], { cwd: dir, env });
    assert.equal(strictVerifiedPreview.status, 0, strictVerifiedPreview.stderr);
    const strictVerifiedPayload = JSON.parse(strictVerifiedPreview.stdout);
    assert.equal(strictVerifiedPayload.summary.would_accept, 1);
    assert.equal(strictVerifiedPayload.summary.skipped, 0);
    assert.equal(strictVerifiedPayload.results[0].action, 'would_accept');
    assert.equal(strictVerifiedPayload.results[0].reason, 'certified_strict_verify');

    const confirmed = runCli([
      'task', 'auto-accept-certified',
      '--confirm-human-accept',
      '--as', 'keshavrao',
      '--json',
    ], { cwd: dir, env });
    assert.equal(confirmed.status, 0, confirmed.stderr);
    const confirmedPayload = JSON.parse(confirmed.stdout);
    assert.equal(confirmedPayload.summary.accepted, 1);
    assert.equal(confirmedPayload.accepted, 1);
    assert.equal(confirmedPayload.failed, 0);
    assert.equal(confirmedPayload.results[0].action, 'accepted');
    const acceptedTask = JSON.parse(runCli(['task', 'show', ref, '--json'], { cwd: dir, env }).stdout);
    assert.equal(acceptedTask.status, 'done');
    assert.equal(acceptedTask.review.approval_status, 'accepted');
    assert.equal(acceptedTask.metadata.accepted_by, 'keshavrao');
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
    assert.equal(runCli(['task', 'ready', ref, '--proof', 'accepted once validation passed', '--as', 'codex'], { cwd: dir, env }).status, 0);

    const accept = runCli(['task', 'accept', ref, '--as', 'keshavrao', '--json'], { cwd: dir, env });
    assert.equal(accept.status, 0, accept.stderr);
    assert.equal(JSON.parse(accept.stdout).xp_projection.total_xp, 1);

    const extraReview = runCli(['task', 'review', ref, '--reward', '1', '--proof', 'duplicate review validation passed', '--as', 'codex', '--json'], { cwd: dir, env });
    assert.equal(extraReview.status, 0, extraReview.stderr);
    const extraReviewPayload = JSON.parse(extraReview.stdout);
    assert.equal(extraReviewPayload.episode.career_xp.eligible, false);
    assert.equal(extraReviewPayload.xp_projection.compact, true);
    assert.equal(extraReviewPayload.xp_projection.total_xp, 1);
    assert.equal(extraReviewPayload.xp_projection.collected_receipts, 0);
    assert.equal(extraReviewPayload.xp_projection.contribution_graph, undefined);
    assert.equal(extraReviewPayload.xp_projection.local_activity, undefined);
    assert.ok(Buffer.byteLength(extraReview.stdout, 'utf8') < 12000, extraReview.stdout);

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
    assert.equal(runCli(['task', 'ready', ref, '--proof', 'duplicate receipt repair validation passed', '--as', 'codex'], { cwd: dir, env }).status, 0);
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
    assert.equal(runCli(['task', 'ready', ref, '--proof', 'conflict validation passed', '--as', 'codex'], { cwd: dir, env }).status, 0);
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
    assert.equal(runCli(['task', 'ready', ref, '--proof', 'tamper test passed', '--as', 'codex'], { cwd: dir, env }).status, 0);
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

    const revisedReady = runCli(['task', 'ready', ref, '--proof', 'revised validation passed', '--as', 'codex', '--json'], { cwd: dir, env });
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
    assert.equal(runCli(['task', 'ready', ref, '--proof', 'open task validation passed', '--as', 'codex'], { cwd: dir, env }).status, 0);

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
    assert.equal(runCli(['task', 'ready', ref, '--proof', 'accepted validation passed', '--as', 'codex'], { cwd: dir, env }).status, 0);
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

test('task status stream tasks use latest agent proof fallback', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const db = taskStore.open(dbPath);
    const proof = 'agent-only proof is visible in stream rows';
    const objective = 'Make proof visible in stream status';
    const added = taskStore.addTask(db, {
      title: 'Expose stream proof fallback',
      tag: 'tasks',
      workspaceRoot: taskStore.workspaceRoot(dir),
      status: 'claimed',
      claimedBy: 'codex',
      metadata: {
        goal_objective: objective,
        latest_agent_proof: proof,
      },
    });
    assert.ok(added.id);
    taskStore.close();

    const status = runCli(['task', 'status', '--json'], { cwd: dir, env });
    assert.equal(status.status, 0, status.stderr);
    const payload = JSON.parse(status.stdout);
    const stream = payload.status.streams.find(row => row.objective === objective);
    assert.ok(stream);
    const task = stream.tasks.find(row => row.id === added.id);
    assert.ok(task);
    assert.equal(task.proof, proof);
  } finally {
    taskStore.close();
    cleanupTempDir(dir);
  }
});

test('task status separates review continue-work from human accept waiting', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex', ATRIS_SKIP_UPDATE_CHECK: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const continuationCreated = runCli(['task', 'new', 'Certified row with concrete continuation', '--tag', 'task', '--json'], { cwd: dir, env });
    assert.equal(continuationCreated.status, 0, continuationCreated.stderr);
    const continuationTask = JSON.parse(continuationCreated.stdout).task;
    assert.equal(runCli([
      'task', 'ready', continuationTask.display_id,
      '--as', 'codex',
      '--proof', 'node --test test/commands.test.js passed before status continuation split',
    ], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'review', continuationTask.display_id,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js passed during status continuation split',
      '--next', 'Build the next concrete continuation slice',
    ], { cwd: dir, env }).status, 0);

    const waitingCreated = runCli(['task', 'new', 'Certified row waiting on human accept', '--tag', 'task', '--json'], { cwd: dir, env });
    assert.equal(waitingCreated.status, 0, waitingCreated.stderr);
    const waitingTask = JSON.parse(waitingCreated.stdout).task;
    assert.equal(runCli([
      'task', 'ready', waitingTask.display_id,
      '--as', 'codex',
      '--proof', 'node --test test/commands.test.js passed before human accept split',
    ], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'review', waitingTask.display_id,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js passed during human accept split',
    ], { cwd: dir, env }).status, 0);

    const blockingCreated = runCli(['task', 'new', 'Review row still needs second agent check', '--tag', 'task', '--json'], { cwd: dir, env });
    assert.equal(blockingCreated.status, 0, blockingCreated.stderr);
    const blockingTask = JSON.parse(blockingCreated.stdout).task;
    assert.equal(runCli([
      'task', 'ready', blockingTask.display_id,
      '--as', 'codex',
      '--proof', 'node --test test/commands.test.js passed before status blocking split',
    ], { cwd: dir, env }).status, 0);

    const status = runCli(['task', 'status', '--json'], { cwd: dir, env });
    assert.equal(status.status, 0, status.stderr);
    const payload = JSON.parse(status.stdout);
    assert.equal(payload.status.counts.review, 3);
    assert.equal(payload.status.counts.review_blocking, 1);
    assert.equal(payload.status.counts.review_certified, 2);
    assert.equal(payload.status.counts.review_continue_work, 1);
    assert.equal(payload.status.counts.review_human_accept_waiting, 1);
    assert.equal(payload.status.counts.active, 1);
    assert.equal(payload.status.review_actions.continue_work.count, 1);
    assert.equal(payload.status.review_actions.continue_work.first.id, continuationTask.id);
    assert.equal(payload.status.review_actions.continue_work.first.ref, continuationTask.display_id);
    assert.equal(payload.status.review_actions.continue_work.first.next_action, 'continue_work');
    assert.equal(payload.status.review_actions.continue_work.first.next_task, 'Build the next concrete continuation slice');
    assert.equal(payload.status.review_actions.continue_work.first.command, `atris task continue-work ${continuationTask.display_id} --as codex --json`);
    assert.equal(payload.status.review_actions.human_accept_waiting.count, 1);
    assert.equal(payload.status.review_actions.human_accept_waiting.first.id, waitingTask.id);
    assert.equal(payload.status.review_actions.human_accept_waiting.first.ref, waitingTask.display_id);
    assert.equal(payload.status.review_actions.human_accept_waiting.first.next_action, 'human_accept_waiting');
    assert.equal(payload.status.review_actions.human_accept_waiting.first.next_task, null);
    assert.equal(payload.status.review_actions.human_accept_waiting.first.command, null);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task reviews gives a compact certified accept queue', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const certifiedCreated = runCli(['task', 'new', 'Ship certified proof packet', '--tag', 'review', '--json'], { cwd: dir, env });
    assert.equal(certifiedCreated.status, 0, certifiedCreated.stderr);
    const certifiedTask = JSON.parse(certifiedCreated.stdout).task;
    assert.equal(runCli(['task', 'claim', certifiedTask.display_id, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const certifiedProof = `Product proof: Human approval queue shows a compact certified packet without stale objective text. ${'context '.repeat(35)}Verifiers: node --test test/commands.test.js passed, focused node --test review queue test, live atris task reviews json showing rows, git diff --check -- commands/task.js test/commands.test.js clean`;
    assert.equal(runCli([
      'task', 'ready', certifiedTask.display_id,
      '--proof', certifiedProof,
      '--happened', 'Certified proof packet is ready for human approval.',
      '--checked', 'I checked the verifier claims and review thread.',
      '--tested', 'I ran the focused review queue test.',
      '--decision', 'Accept if the packet is readable; rework if proof is vague.',
      '--as', 'codex',
    ], { cwd: dir, env }).status, 0);
    const db = taskStore.open(dbPath);
    try {
      const row = taskStore.getTask(db, certifiedTask.id);
      const metadata = {
        ...(row.metadata || {}),
        goal_objective: 'Stale mission objective from another task',
        objective: 'Stale metadata objective from another task',
      };
      db.prepare('UPDATE tasks SET metadata = ? WHERE id = ?').run(JSON.stringify(metadata), certifiedTask.id);
    } finally {
      taskStore.close();
    }
    assert.equal(runCli(['task', 'review', certifiedTask.display_id, '--reward', '0', '--as', 'validator'], { cwd: dir, env }).status, 0);

    const blockingCreated = runCli(['task', 'new', 'Needs another agent review', '--tag', 'review', '--json'], { cwd: dir, env });
    assert.equal(blockingCreated.status, 0, blockingCreated.stderr);
    const blockingTask = JSON.parse(blockingCreated.stdout).task;
    assert.equal(runCli(['task', 'claim', blockingTask.display_id, '--as', 'codex'], { cwd: dir, env }).status, 0);
    assert.equal(runCli(['task', 'ready', blockingTask.display_id, '--proof', 'one review validation passed', '--as', 'codex'], { cwd: dir, env }).status, 0);

    const queue = runCli(['task', 'reviews', '--json'], { cwd: dir, env });
    assert.equal(queue.status, 0, queue.stderr);
    const payload = JSON.parse(queue.stdout);
    assert.equal(payload.action, 'review_queue');
    assert.equal(payload.queue.schema, 'atris.task_review_queue.v1');
    assert.equal(payload.queue.counts.review, 2);
    assert.equal(payload.queue.counts.certified, 1);
    assert.equal(payload.queue.counts.blocking, 1);
    assert.equal(payload.queue.items.length, 1);
    assert.equal(payload.queue.items[0].display_id, certifiedTask.display_id);
	    assert.deepEqual(payload.queue.items[0].landing, {
	      happened: 'Certified proof packet is ready for human approval.',
	      reason: 'Human approval queue shows a compact certified packet without stale objective text.',
	      checked: 'I checked the verifier claims and review thread.',
	      tested: 'I ran the focused review queue test.',
	      decision: 'Accept if the packet is readable; rework if proof is vague.',
    });
    assert.equal(payload.queue.items[0].result.saved, `Result is ready for human approval as ${certifiedTask.display_id}.`);
    assert.equal(payload.queue.items[0].accept_command, `atris task accept ${certifiedTask.display_id}`);
    assert.equal(payload.queue.items[0].land_command, `atris task accept ${certifiedTask.display_id}`);
    assert.equal(payload.queue.items[0].revise_command, `atris task revise ${certifiedTask.display_id} --note "<what must change>"`);
    assert.equal(payload.queue.items[0].send_back_command, `atris task revise ${certifiedTask.display_id} --note "<what must change>"`);
    assert.equal(payload.queue.items[0].review_chat_command, `atris task review-chat ${certifiedTask.display_id} --as codex-review`);
    assert.match(payload.queue.items[0].codex_prompt, new RegExp(`/codex review ${certifiedTask.display_id}`));
    assert.equal(payload.queue.items[0].verification_focus.objective, 'Ship certified proof packet');
    assert.doesNotMatch(payload.queue.items[0].codex_prompt, /Stale mission objective|Stale metadata objective/);
    assert.match(payload.queue.items[0].verification_focus.proof_claim, /node --test test\/commands\.test\.js passed/);
    assert.deepEqual(payload.queue.items[0].verification_focus.commands_to_verify, [
      'node --test test/commands.test.js',
      'git diff --check -- commands/task.js test/commands.test.js',
    ]);
    assert.ok(payload.queue.items[0].verification_focus.commands_to_verify.some(command => command.includes('node --test test/commands.test.js')));

    const text = runCli(['task', 'reviews'], { cwd: dir, env });
    assert.equal(text.status, 0, text.stderr);
	    assert.match(text.stdout, /READY FOR APPROVAL/);
	    assert.match(text.stdout, /Result:/);
	    assert.match(text.stdout, /What happened: Certified proof packet is ready for human approval\./);
	    assert.match(text.stdout, /Why it matters: Human approval queue shows a compact certified packet without stale objective text\./);
    assert.match(text.stdout, /How I checked: I checked the verifier claims and review thread\./);
    assert.match(text.stdout, /What I tested: I ran the focused review queue test\./);
    assert.match(text.stdout, /Saved: Result is ready for human approval as .*?\./);
    assert.match(text.stdout, /Decision: Accept if the packet is readable; rework if proof is vague\./);
    assert.doesNotMatch(text.stdout, /   details:/);
    assert.doesNotMatch(text.stdout, /   receipt:/);
    assert.doesNotMatch(text.stdout, /   \/codex:/);
    assert.match(text.stdout, new RegExp(`approve: atris task accept ${certifiedTask.display_id}`));
    assert.match(text.stdout, new RegExp(`rework: atris task revise ${certifiedTask.display_id}`));
    assert.doesNotMatch(text.stdout, new RegExp(`approve: atris task accept ${blockingTask.display_id}`));

    const verbose = runCli(['task', 'reviews', '--verbose'], { cwd: dir, env });
    assert.equal(verbose.status, 0, verbose.stderr);
    assert.ok(verbose.stdout.indexOf('   Result:') < verbose.stdout.indexOf('   details:'), 'Result should appear before raw details');
    assert.match(verbose.stdout, new RegExp(`/codex: atris task review-chat ${certifiedTask.display_id} --as codex-review`));

    const grouped = runCli(['task', 'reviews', '--group-by', 'tag'], { cwd: dir, env });
    assert.equal(grouped.status, 0, grouped.stderr);
    assert.match(grouped.stdout, /READY FOR APPROVAL — grouped by tag/);
    assert.match(grouped.stdout, /1 ready for approval across 1 tag group\(s\)/);
    assert.match(grouped.stdout, /approve this group: atris task accept-group tag="review" --spot-check 3 --confirm-human-accept --as <you>/);
    assert.doesNotMatch(grouped.stdout, /CERTIFIED REVIEW|review then accept/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task review groups are capped by default for human scan', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    for (let index = 1; index <= 12; index += 1) {
      const tag = `tag-${String(index).padStart(2, '0')}`;
      const created = runCli(['task', 'new', `Grouped approval ${index}`, '--tag', tag, '--json'], { cwd: dir, env });
      assert.equal(created.status, 0, created.stderr);
      const task = JSON.parse(created.stdout).task;
      assert.equal(runCli(['task', 'claim', task.display_id, '--as', 'codex'], { cwd: dir, env }).status, 0);
      assert.equal(runCli(['task', 'ready', task.display_id, '--proof', 'node --test test/commands.test.js passed', '--as', 'codex'], { cwd: dir, env }).status, 0);
      assert.equal(runCli(['task', 'review', task.display_id, '--reward', '0', '--as', 'validator'], { cwd: dir, env }).status, 0);
    }

    const grouped = runCli(['task', 'reviews', '--group-by', 'tag'], { cwd: dir, env });
    assert.equal(grouped.status, 0, grouped.stderr);
    assert.match(grouped.stdout, /12 ready for approval across 12 tag group\(s\)/);
    assert.match(grouped.stdout, /1\. tag-01/);
    assert.match(grouped.stdout, /10\. tag-10/);
    assert.doesNotMatch(grouped.stdout, /11\. tag-11/);
    assert.match(grouped.stdout, /Showing 10\/12 groups; rerun with --all for every group or --limit N to adjust\./);

    const limited = runCli(['task', 'reviews', '--group-by', 'tag', '--limit', '3'], { cwd: dir, env });
    assert.equal(limited.status, 0, limited.stderr);
    assert.match(limited.stdout, /3\. tag-03/);
    assert.doesNotMatch(limited.stdout, /4\. tag-04/);
    assert.match(limited.stdout, /Showing 3\/12 groups/);

    const all = runCli(['task', 'reviews', '--group-by', 'tag', '--all'], { cwd: dir, env });
    assert.equal(all.status, 0, all.stderr);
    assert.match(all.stdout, /12\. tag-12/);
    assert.doesNotMatch(all.stdout, /Showing 10\/12 groups/);
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

    const parentCreated = runCli(['task', 'add', 'GM Desk v0: make Acme Co open to one playable daily rep', '--tag', 'gm-desk', '--json'], { cwd: dir, env });
    assert.equal(parentCreated.status, 0, parentCreated.stderr);
    const parent = JSON.parse(parentCreated.stdout).task;

    const childCreated = runCli(['task', 'add', 'GM Desk v0 step 2: route Acme Co open to daily surface, no /flow', '--tag', 'gm-desk', '--goal-id', parent.display_id, '--json'], { cwd: dir, env });
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
    const failed = runCli(['task', 'done', id, '--failed', '--proof', 'Misrouted small talk; validation failed in intake triage.', '--json'], { cwd: dir, env });
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

test('task status keeps failed blockers out of review handoff', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    const created = runCli(['task', 'new', 'Owner-gated route decision', '--tag', 'business-gm', '--json'], { cwd: dir, env });
    assert.equal(created.status, 0, created.stderr);
    const id = JSON.parse(created.stdout).task_id;
    const claimed = runCli(['task', 'claim', id, '--as', 'codex', '--json'], { cwd: dir, env });
    assert.equal(claimed.status, 0, claimed.stderr);
    const failed = runCli(['task', 'done', id, '--failed', '--json'], { cwd: dir, env });
    assert.equal(failed.status, 0, failed.stderr);

    const status = runCli(['task', 'status', '--json'], { cwd: dir, env });
    assert.equal(status.status, 0, status.stderr);
    const payload = JSON.parse(status.stdout);
    assert.equal(payload.status.counts.review, 0);
    assert.equal(payload.status.counts.blocked, 1);
    assert.deepEqual(payload.status.needs_review, []);

    const text = runCli(['task', 'status'], { cwd: dir, env });
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /review 0/);
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
      const done = runCli(['task', 'done', id, '--proof', `node --test test/commands.test.js passed for archive ${i}`, '--json'], { cwd: dir, env });
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

test('task render archives old blocked records from TODO view', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    for (let i = 0; i < 16; i += 1) {
      const created = runCli(['task', 'new', `Blocked task ${i}`, '--tag', 'agent', '--json'], { cwd: dir, env });
      assert.equal(created.status, 0, created.stderr);
      const id = JSON.parse(created.stdout).task_id;
      const failed = runCli(['task', 'done', id, '--failed', '--proof', `node --test test/commands.test.js passed for blocked archive ${i}`, '--json'], { cwd: dir, env });
      assert.equal(failed.status, 0, failed.stderr);
    }

    const render = runCli(['task', 'render', '--out', 'atris/TODO.md'], { cwd: dir, env });
    assert.equal(render.status, 0, render.stderr);
    const regenerated = fs.readFileSync(path.join(dir, 'atris', 'TODO.md'), 'utf8');
    const blockedLines = regenerated.match(/\*\*\[[^\]]+\]\*\* Blocked task/g) || [];
    assert.equal(blockedLines.length, 12);
    assert.match(regenerated, /4 older blocked tasks archived/);

    const tightRender = runCli(['task', 'render', '--out', 'atris/TODO.md', '--failed-limit', '3'], { cwd: dir, env });
    assert.equal(tightRender.status, 0, tightRender.stderr);
    const tight = fs.readFileSync(path.join(dir, 'atris', 'TODO.md'), 'utf8');
    const tightBlockedLines = tight.match(/\*\*\[[^\]]+\]\*\* Blocked task/g) || [];
    assert.equal(tightBlockedLines.length, 3);
    assert.match(tight, /13 older blocked tasks archived/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task review create-next preserves goal scope', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const created = runCli(['task', 'new', 'Improve task loop', '--tag', 'rsi', '--goal-id', 'OBL-928', '--json'], { cwd: dir, env });
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
    assert.equal(next.metadata.goal_id, 'OBL-928');

    const scopedCurrent = runCli(['task', 'current', '--goal-id', 'OBL-928', '--json'], { cwd: dir, env });
    assert.equal(scopedCurrent.status, 0, scopedCurrent.stderr);
    const scopedPayload = JSON.parse(scopedCurrent.stdout);
    assert.equal(scopedPayload.current.selected_task_id, payload.next_task_id);
    assert.equal(scopedPayload.current.selected_reason, 'backlog_idea');
  } finally {
    cleanupTempDir(dir);
  }
});

test('task continue-work creates the certified review next task', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex', ATRIS_SKIP_UPDATE_CHECK: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const created = runCli([
      'task', 'new', 'Certify the task continuation path',
      '--tag', 'task',
      '--goal-id', 'OBL-928',
      '--json',
    ], { cwd: dir, env });
    assert.equal(created.status, 0, created.stderr);
    const parent = JSON.parse(created.stdout).task;
    const ref = parent.display_id;

    const ready = runCli([
      'task', 'ready', ref,
      '--as', 'codex',
      '--proof', 'node --test test/commands.test.js passed before continue-work certification',
      '--json',
    ], { cwd: dir, env });
    assert.equal(ready.status, 0, ready.stderr);

    const certified = runCli([
      'task', 'review', ref,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js passed during continue-work certification',
      '--next', 'Expose the follow-up task in the scoped current queue',
      '--json',
    ], { cwd: dir, env });
    assert.equal(certified.status, 0, certified.stderr);
    const certifiedPayload = JSON.parse(certified.stdout);
    assert.equal(certifiedPayload.task.status, 'review');
    assert.equal(certifiedPayload.task.review.agent_certified, true);
    assert.equal(certifiedPayload.task.review.approval_status, 'pending');

    const continued = runCli(['task', 'continue-work', ref, '--as', 'codex', '--json'], { cwd: dir, env });
    assert.equal(continued.status, 0, continued.stderr);
    const continuedPayload = JSON.parse(continued.stdout);
    assert.equal(continuedPayload.ok, true);
    assert.equal(continuedPayload.action, 'continue_work');
    assert.equal(continuedPayload.parent_task_id, parent.id);
    assert.equal(continuedPayload.created, true);
    assert.equal(continuedPayload.safety.human_accept, false);
    assert.equal(continuedPayload.safety.accepts_parent, false);
    assert.equal(continuedPayload.parent.status, 'review');
    assert.equal(continuedPayload.parent.review.approval_status, 'pending');
    assert.equal(continuedPayload.next_task.title, 'Expose the follow-up task in the scoped current queue');
    assert.equal(continuedPayload.next_task.status, 'open');
    assert.equal(continuedPayload.next_task.tag, 'task');
    assert.equal(continuedPayload.next_task.metadata.goal_id, 'OBL-928');
    assert.equal(continuedPayload.next_task.lineage.parent_task_id, parent.id);

    const reused = runCli(['task', 'continue-work', ref, '--as', 'codex', '--json'], { cwd: dir, env });
    assert.equal(reused.status, 0, reused.stderr);
    const reusedPayload = JSON.parse(reused.stdout);
    assert.equal(reusedPayload.next_task_id, continuedPayload.next_task_id);
    assert.equal(reusedPayload.created, false);

    const current = runCli(['task', 'current', '--goal-id', 'OBL-928', '--json'], { cwd: dir, env });
    assert.equal(current.status, 0, current.stderr);
    const currentPayload = JSON.parse(current.stdout);
    assert.equal(currentPayload.current.selected_task_id, continuedPayload.next_task_id);
    assert.equal(currentPayload.current.selected_reason, 'backlog_idea');

    const xp = runCli(['xp', 'status', '--local', '--json'], { cwd: dir, env });
    assert.equal(xp.status, 0, xp.stderr);
    assert.equal(JSON.parse(xp.stdout).total_xp, 0);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task continue-work rejects generic human-accept continuation titles', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex', ATRIS_SKIP_UPDATE_CHECK: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const created = runCli([
      'task', 'new', 'Certified row with generic continuation text',
      '--tag', 'task',
      '--goal-id', 'OBL-928',
      '--json',
    ], { cwd: dir, env });
    assert.equal(created.status, 0, created.stderr);
    const parent = JSON.parse(created.stdout).task;
    const ref = parent.display_id;

    const ready = runCli([
      'task', 'ready', ref,
      '--as', 'codex',
      '--proof', 'node --test test/commands.test.js passed before generic continue-work guard',
      '--next', 'Human accept remains pending for XP; next agent-actionable work can continue from OBL-1008.',
      '--json',
    ], { cwd: dir, env });
    assert.equal(ready.status, 0, ready.stderr);
    const readyPayload = JSON.parse(ready.stdout);
    assert.equal(readyPayload.review_next_task_ignored.reason, 'non_specific_next_task');
    assert.equal(readyPayload.task.review.next_task, undefined);

    const certified = runCli([
      'task', 'review', ref,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js passed during generic continue-work guard',
      '--next', 'Human accept remains pending for XP; next agent-actionable work can continue from OBL-1008.',
      '--json',
    ], { cwd: dir, env });
    assert.equal(certified.status, 0, certified.stderr);
    const certifiedPayload = JSON.parse(certified.stdout);
    assert.equal(certifiedPayload.review_next_task_ignored.reason, 'non_specific_next_task');
    assert.equal(certifiedPayload.task.review.agent_certified, true);
    assert.equal(certifiedPayload.task.review.next_task, undefined);

    const current = runCli(['task', 'current', '--goal-id', 'OBL-928', '--json'], { cwd: dir, env });
    assert.equal(current.status, 0, current.stderr);
    const currentPayload = JSON.parse(current.stdout);
    assert.equal(currentPayload.current.selected_task_id, parent.id);
    assert.equal(currentPayload.current.selected_reason, 'review_certified_waiting_human');
    assert.equal(currentPayload.current.next.key, 'human_accept_waiting');
    assert.equal(currentPayload.current.next.command, null);
    assert.equal(currentPayload.current.next.api, null);
    assert.equal(currentPayload.selected.continue_work_command, undefined);

    const reviews = runCli(['task', 'reviews', '--json'], { cwd: dir, env });
    assert.equal(reviews.status, 0, reviews.stderr);
    const reviewItem = JSON.parse(reviews.stdout).queue.items[0];
    assert.equal(reviewItem.id, parent.id);
    assert.equal(reviewItem.continue_work_command, undefined);
    assert.equal(reviewItem.continue_work_api, undefined);

    const continued = runCli(['task', 'continue-work', ref, '--as', 'codex', '--json'], { cwd: dir, env });
    assert.notEqual(continued.status, 0);
    const continuedPayload = JSON.parse(continued.stdout);
    assert.equal(continuedPayload.ok, false);
    assert.equal(continuedPayload.reason, 'no_next_task');
    assert.match(continuedPayload.detail, /no specific next_task suggestion/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task review hygiene reports generic continuation debt without mutation', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex', ATRIS_SKIP_UPDATE_CHECK: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const created = runCli([
      'task', 'new', 'Certified row with stale generic review-next debt',
      '--tag', 'task',
      '--goal-id', 'OBL-928',
      '--json',
    ], { cwd: dir, env });
    assert.equal(created.status, 0, created.stderr);
    const parent = JSON.parse(created.stdout).task;
    const ref = parent.display_id;

    const ready = runCli([
      'task', 'ready', ref,
      '--as', 'codex',
      '--proof', 'node --test test/commands.test.js passed before review hygiene',
      '--json',
    ], { cwd: dir, env });
    assert.equal(ready.status, 0, ready.stderr);

    const certified = runCli([
      'task', 'review', ref,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js passed during review hygiene',
      '--json',
    ], { cwd: dir, env });
    assert.equal(certified.status, 0, certified.stderr);

    const seeded = spawnSync(process.execPath, ['-e', `
      const { DatabaseSync } = require('node:sqlite');
      const sqlite = new DatabaseSync(process.argv[1]);
      try {
        const row = sqlite.prepare('SELECT metadata FROM tasks WHERE id = ?').get(process.argv[2]);
        const metadata = JSON.parse(row.metadata || '{}');
        metadata.latest_agent_next_task = 'Human accept remains pending for XP; next agent-actionable work can continue from OBL-1008.';
        sqlite.prepare('UPDATE tasks SET metadata = ? WHERE id = ?').run(JSON.stringify(metadata), process.argv[2]);
      } finally {
        sqlite.close();
      }
    `, dbPath, parent.id], {
      encoding: 'utf8',
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    assert.equal(seeded.status, 0, seeded.stderr);

    const reviews = runCli(['task', 'reviews', '--json'], { cwd: dir, env });
    assert.equal(reviews.status, 0, reviews.stderr);
    const queue = JSON.parse(reviews.stdout).queue;
    assert.equal(queue.hygiene.generic_continuation_count, 1);
    assert.equal(queue.hygiene.generic_continuations[0].id, parent.id);
    assert.equal(queue.hygiene.generic_continuations[0].issues[0].field, 'review.next_task');
    assert.equal(queue.items[0].id, parent.id);
    assert.equal(queue.items[0].hygiene.generic_continuation_issues[0].field, 'review.next_task');
    assert.equal(queue.items[0].continue_work_command, undefined);
    assert.equal(queue.items[0].continue_work_api, undefined);

    const continued = runCli(['task', 'continue-work', ref, '--as', 'codex', '--json'], { cwd: dir, env });
    assert.notEqual(continued.status, 0);
    const continuedPayload = JSON.parse(continued.stdout);
    assert.equal(continuedPayload.ok, false);
    assert.equal(continuedPayload.reason, 'no_next_task');
  } finally {
    cleanupTempDir(dir);
  }
});

test('task current exposes continue-work for certified review suggestions', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex', ATRIS_SKIP_UPDATE_CHECK: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const created = runCli([
      'task', 'new', 'Surface the certified continuation command',
      '--tag', 'task',
      '--goal-id', 'OBL-928',
      '--json',
    ], { cwd: dir, env });
    assert.equal(created.status, 0, created.stderr);
    const parent = JSON.parse(created.stdout).task;
    const ref = parent.display_id;

    assert.equal(runCli([
      'task', 'ready', ref,
      '--as', 'codex',
      '--proof', 'node --test test/commands.test.js passed before current continue-work',
    ], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'review', ref,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js passed during current continue-work review',
      '--next', 'Queue the command-backed follow-up',
    ], { cwd: dir, env }).status, 0);

    const current = runCli(['task', 'current', '--goal-id', 'OBL-928', '--json'], { cwd: dir, env });
    assert.equal(current.status, 0, current.stderr);
    const currentPayload = JSON.parse(current.stdout);
    const command = `atris task continue-work ${ref} --as codex --json`;
    assert.equal(currentPayload.current.selected_task_id, parent.id);
    assert.equal(currentPayload.current.selected_reason, 'review_certified_waiting_human');
    assert.equal(currentPayload.current.next.key, 'continue_work');
    assert.equal(currentPayload.current.next.command, command);
    assert.equal(currentPayload.current.next.human_accept_command, `atris task accept ${ref}`);
    assert.equal(currentPayload.page.review.verification_chat.human_accept_command, `atris task accept ${ref}`);
    assert.deepEqual(currentPayload.current.next.api, { method: 'POST', path: `/api/tasks/${parent.id}/continue-work` });
    assert.equal(currentPayload.page.stage.next_action.command, command);
    assert.equal(currentPayload.selected.continue_work_command, command);
    assert.equal(currentPayload.queue.columns.find(column => column.key === 'review').items[0].continue_work_command, command);

    const reviews = runCli(['task', 'reviews', '--json'], { cwd: dir, env });
    assert.equal(reviews.status, 0, reviews.stderr);
    const reviewItem = JSON.parse(reviews.stdout).queue.items[0];
    assert.equal(reviewItem.id, parent.id);
    assert.equal(reviewItem.continue_work_command, command);
    assert.deepEqual(reviewItem.continue_work_api, { method: 'POST', path: `/api/tasks/${parent.id}/continue-work` });

    const clearedReview = runCli([
      'task', 'review', ref,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js passed while clearing stale next_task',
      '--next', '',
      '--json',
    ], { cwd: dir, env });
    assert.equal(clearedReview.status, 0, clearedReview.stderr);
    const clearedPayload = JSON.parse(clearedReview.stdout);
    assert.equal(clearedPayload.episode.next_task_suggestion, null);
    assert.equal(clearedPayload.episode.action.event_type, 'reviewed');
    assert.equal(clearedPayload.episode.rl.has_next_task, false);
    assert.equal(clearedPayload.task.review.next_task, undefined);
    assert.equal(Object.prototype.hasOwnProperty.call(clearedPayload.task.metadata, 'latest_agent_next_task'), false);

    const waitingCurrent = runCli(['task', 'current', '--goal-id', 'OBL-928', '--review-state', 'human-accept-waiting', '--json'], { cwd: dir, env });
    assert.equal(waitingCurrent.status, 0, waitingCurrent.stderr);
    const waitingCurrentPayload = JSON.parse(waitingCurrent.stdout);
    assert.equal(waitingCurrentPayload.current.review_state_actions.human_accept_waiting.ref, ref);
    assert.equal(waitingCurrentPayload.current.review_state_actions.human_accept_waiting.command, null);
    assert.equal(waitingCurrentPayload.current.review_state_actions.continue_work, null);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task queue filters certified review rows by continue-work and human-accept waiting state', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex', ATRIS_SKIP_UPDATE_CHECK: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const continueCreated = runCli([
      'task', 'new', 'Certified task with executable continuation',
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
      '--proof', 'node --test test/commands.test.js passed before continue-work filter review',
    ], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'review', continueRef,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js passed during continue-work filter review',
      '--next', 'Add the next queue lane filter regression',
    ], { cwd: dir, env }).status, 0);

    const waitingCreated = runCli([
      'task', 'new', 'Certified task waiting for human accept only',
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
      '--proof', 'node --test test/commands.test.js passed before human-accept filter review',
    ], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'review', waitingRef,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js passed during human-accept filter review',
    ], { cwd: dir, env }).status, 0);

    const continueQueue = runCli([
      'task', 'queue',
      '--goal-id', 'OBL-928',
      '--review-state', 'continue-work',
      '--json',
    ], { cwd: dir, env });
    assert.equal(continueQueue.status, 0, continueQueue.stderr);
    const continuePayload = JSON.parse(continueQueue.stdout);
    const continueCommand = `atris task continue-work ${continueRef} --as codex --json`;
    assert.equal(continuePayload.current.scope.review_state, 'continue-work');
    assert.equal(continuePayload.current.selected_task_id, continueTask.id);
    assert.equal(continuePayload.current.next.key, 'continue_work');
    assert.equal(continuePayload.current.next.command, continueCommand);
    assert.deepEqual(continuePayload.current.capabilities, continuePayload.queue.capabilities);
    assert.equal(continuePayload.queue.capabilities.commands.current_step, 'atris task current-step --review-state <lane> --json');
    assert.equal(continuePayload.queue.capabilities.current_step.api.path, '/api/tasks/current/step?review_state=<lane>');
    assert.equal(continuePayload.queue.capabilities.current_step.lanes['continue-work'].step_action, 'continue_work');
    assert.equal(continuePayload.queue.capabilities.current_step.lanes['human-accept-waiting'].safe_for_agent, false);
    assert.equal(continuePayload.queue.counts.total, 1);
    assert.equal(continuePayload.queue.counts.review, 1);
    assert.equal(continuePayload.queue.review_state_counts.active_filter, 'continue-work');
    assert.equal(continuePayload.queue.review_state_counts.scope.goal_id, 'OBL-928');
    assert.equal(continuePayload.queue.review_state_counts.scope.review_state, null);
    assert.equal(continuePayload.queue.review_state_counts.total, 2);
    assert.equal(continuePayload.queue.review_state_counts.continue_work, 1);
    assert.equal(continuePayload.queue.review_state_counts.human_accept_waiting, 1);
    assert.equal(continuePayload.queue.review_state_counts.certified, 2);
    assert.deepEqual(continuePayload.current.review_state_counts, continuePayload.queue.review_state_counts);
    assert.deepEqual(continuePayload.current.review_state_actions, continuePayload.queue.review_state_actions);
    assert.equal(continuePayload.queue.review_state_actions.active_filter, 'continue-work');
    assert.equal(continuePayload.queue.review_state_actions.scope.goal_id, 'OBL-928');
    assert.equal(continuePayload.queue.review_state_actions.scope.review_state, null);
    assert.equal(continuePayload.queue.review_state_actions.needs_agent, null);
    assert.equal(continuePayload.queue.review_state_actions.continue_work.id, continueTask.id);
    assert.equal(continuePayload.queue.review_state_actions.continue_work.next_action, 'continue_work');
    assert.equal(continuePayload.queue.review_state_actions.continue_work.command, continueCommand);
    assert.deepEqual(continuePayload.queue.review_state_actions.continue_work.api, { method: 'POST', path: `/api/tasks/${continueTask.id}/continue-work` });
    assert.equal(continuePayload.queue.review_state_actions.continue_work.continue_work_command, continueCommand);
    assert.equal(continuePayload.queue.review_state_actions.continue_work.human_accept.human_only, true);
    assert.equal(continuePayload.queue.review_state_actions.human_accept_waiting.id, waitingTask.id);
    assert.equal(continuePayload.queue.review_state_actions.human_accept_waiting.next_action, 'human_accept_waiting');
    assert.equal(continuePayload.queue.review_state_actions.human_accept_waiting.command, null);
    assert.equal(continuePayload.queue.review_state_actions.human_accept_waiting.api, null);
    assert.equal(continuePayload.queue.review_state_actions.human_accept_waiting.continue_work_command, undefined);
    assert.equal(continuePayload.queue.review_state_actions.human_accept_waiting.human_accept.human_only, true);
    const continueQueueItem = continuePayload.queue.columns.find(column => column.key === 'review').items[0];
    assert.equal(continueQueueItem.id, continueTask.id);
    assert.equal(continueQueueItem.ref, continueTask.display_id);
    assert.equal(continueQueueItem.display_id, continueTask.display_id);
    assert.ok(continueQueueItem.legacy_ref);
    assert.equal(continueQueueItem.continue_work_command, continueCommand);

    const waitingQueue = runCli([
      'task', 'queue',
      '--goal-id', 'OBL-928',
      '--review-state', 'human-accept-waiting',
      '--json',
    ], { cwd: dir, env });
    assert.equal(waitingQueue.status, 0, waitingQueue.stderr);
    const waitingPayload = JSON.parse(waitingQueue.stdout);
    assert.equal(waitingPayload.current.scope.review_state, 'human-accept-waiting');
    assert.equal(waitingPayload.current.selected_task_id, waitingTask.id);
    assert.equal(waitingPayload.current.next.key, 'human_accept_waiting');
    assert.equal(waitingPayload.current.next.command, null);
    assert.equal(waitingPayload.selected.continue_work_command, undefined);
    assert.equal(waitingPayload.queue.counts.total, 1);
    assert.equal(waitingPayload.queue.counts.review, 1);
    assert.equal(waitingPayload.queue.review_state_counts.active_filter, 'human-accept-waiting');
    assert.equal(waitingPayload.queue.review_state_counts.total, 2);
    assert.equal(waitingPayload.queue.review_state_counts.continue_work, 1);
    assert.equal(waitingPayload.queue.review_state_counts.human_accept_waiting, 1);
    assert.equal(waitingPayload.queue.review_state_counts.certified, 2);
    assert.deepEqual(waitingPayload.current.review_state_counts, waitingPayload.queue.review_state_counts);
    assert.deepEqual(waitingPayload.current.review_state_actions, waitingPayload.queue.review_state_actions);
    assert.equal(waitingPayload.queue.review_state_actions.active_filter, 'human-accept-waiting');
    assert.equal(waitingPayload.queue.review_state_actions.continue_work.id, continueTask.id);
    assert.equal(waitingPayload.queue.review_state_actions.continue_work.command, continueCommand);
    assert.equal(waitingPayload.queue.review_state_actions.human_accept_waiting.id, waitingTask.id);
    assert.equal(waitingPayload.queue.review_state_actions.human_accept_waiting.next_action, 'human_accept_waiting');
    assert.equal(waitingPayload.queue.review_state_actions.human_accept_waiting.command, null);
    assert.equal(waitingPayload.queue.review_state_actions.human_accept_waiting.api, null);
    const waitingQueueItem = waitingPayload.queue.columns.find(column => column.key === 'review').items[0];
    assert.equal(waitingQueueItem.id, waitingTask.id);
    assert.equal(waitingQueueItem.ref, waitingTask.display_id);
    assert.equal(waitingQueueItem.display_id, waitingTask.display_id);
    assert.ok(waitingQueueItem.legacy_ref);
    assert.equal(waitingQueueItem.continue_work_command, undefined);

    const waitingCurrent = runCli([
      'task', 'current',
      '--goal-id', 'OBL-928',
      '--review-state', 'no_next_task',
      '--json',
    ], { cwd: dir, env });
    assert.equal(waitingCurrent.status, 0, waitingCurrent.stderr);
    const waitingCurrentPayload = JSON.parse(waitingCurrent.stdout);
    assert.equal(waitingCurrentPayload.current.scope.review_state, 'no_next_task');
    assert.equal(waitingCurrentPayload.current.selected_task_id, waitingTask.id);
    assert.equal(waitingCurrentPayload.current.next.key, 'human_accept_waiting');
    assert.equal(waitingCurrentPayload.current.review_state_counts.active_filter, 'no_next_task');
    assert.equal(waitingCurrentPayload.current.review_state_counts.total, 2);
    assert.equal(waitingCurrentPayload.current.review_state_counts.continue_work, 1);
    assert.equal(waitingCurrentPayload.current.review_state_counts.human_accept_waiting, 1);
    assert.equal(waitingCurrentPayload.current.review_state_actions.active_filter, 'no_next_task');
    assert.equal(waitingCurrentPayload.current.review_state_actions.continue_work.id, continueTask.id);
    assert.equal(waitingCurrentPayload.current.review_state_actions.human_accept_waiting.id, waitingTask.id);
    assert.equal(waitingCurrentPayload.current.review_state_actions.human_accept_waiting.command, null);
    assert.deepEqual(waitingCurrentPayload.current.capabilities.filters.review_state.aliases['human-accept-waiting'], ['human-accept', 'accept-waiting', 'waiting-accept', 'no-next-task']);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task review lanes route stale PR proof out of human accept waiting', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex', ATRIS_SKIP_UPDATE_CHECK: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const created = runCli([
      'task', 'new', 'Certified stale PR proof boundary',
      '--tag', 'task',
      '--goal-id', 'OBL-928',
      '--json',
    ], { cwd: dir, env });
    assert.equal(created.status, 0, created.stderr);
    const task = JSON.parse(created.stdout).task;
    const ref = task.display_id;
    const stalePrProof = 'Verified #1600 remains OPEN/draft/CLEAN at head be8797f. git diff --check passed.';

    assert.equal(runCli([
      'task', 'ready', ref,
      '--as', 'codex',
      '--proof', stalePrProof,
    ], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'review', ref,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', stalePrProof,
    ], { cwd: dir, env }).status, 0);

    const status = runCli(['task', 'status', '--json'], { cwd: dir, env });
    assert.equal(status.status, 0, status.stderr);
    const statusPayload = JSON.parse(status.stdout).status;
    assert.equal(statusPayload.counts.review, 1);
    assert.equal(statusPayload.counts.review_certified, 1);
    assert.equal(statusPayload.counts.review_proof_boundary_blocked, 1);
    assert.equal(statusPayload.counts.review_human_accept_waiting, 0);
    assert.equal(statusPayload.counts.active, 1);
    assert.equal(statusPayload.review_actions.proof_boundary_blocked.count, 1);
    assert.equal(statusPayload.review_actions.proof_boundary_blocked.first.ref, ref);
    assert.equal(statusPayload.review_actions.proof_boundary_blocked.first.next_action, 'proof_boundary_blocked');
    assert.equal(statusPayload.review_actions.proof_boundary_blocked.first.reason, 'proof_unmerged_or_draft_pr_boundary');
    assert.match(statusPayload.review_actions.proof_boundary_blocked.first.command, new RegExp(`atris task revise ${ref}`));
    assert.equal(statusPayload.review_actions.human_accept_waiting.count, 0);
    assert.equal(statusPayload.review_actions.human_accept_waiting.first, null);

    const current = runCli([
      'task', 'current',
      '--goal-id', 'OBL-928',
      '--review-state', 'proof-boundary-blocked',
      '--json',
    ], { cwd: dir, env });
    assert.equal(current.status, 0, current.stderr);
    const currentPayload = JSON.parse(current.stdout);
    assert.equal(currentPayload.current.selected_task_id, task.id);
    assert.equal(currentPayload.current.selected_reason, 'review_proof_boundary_blocked');
    assert.equal(currentPayload.current.next.key, 'proof_boundary_blocked');
    assert.equal(currentPayload.current.next.reason, 'proof_boundary_blocked_requires_revision');
    assert.match(currentPayload.current.next.command, new RegExp(`atris task revise ${ref}`));
    assert.equal(currentPayload.current.next.human_accept_command, null);
    assert.equal(currentPayload.current.review_state_counts.proof_boundary_blocked, 1);
    assert.equal(currentPayload.current.review_state_counts.human_accept_waiting, 0);
    assert.equal(currentPayload.current.review_state_counts.certified, 1);
    assert.equal(currentPayload.current.review_state_actions.proof_boundary_blocked.id, task.id);
    assert.equal(currentPayload.current.review_state_actions.proof_boundary_blocked.human_accept.enabled, false);
    assert.equal(currentPayload.current.review_state_actions.proof_boundary_blocked.human_accept.command, null);
    assert.equal(currentPayload.selected.commands.human_accept, undefined);
    assert.equal(currentPayload.page.review.verification_chat.human_accept_command, null);
    assert.doesNotMatch(JSON.stringify(currentPayload.page.review.verification_chat), new RegExp(`atris task accept ${ref}`));

    const waiting = runCli([
      'task', 'current',
      '--goal-id', 'OBL-928',
      '--review-state', 'human-accept-waiting',
      '--json',
    ], { cwd: dir, env });
    assert.equal(waiting.status, 0, waiting.stderr);
    const waitingPayload = JSON.parse(waiting.stdout);
    assert.equal(waitingPayload.current.selected_task_id, null);
    assert.equal(waitingPayload.current.selected_ref, null);

    const reviews = runCli(['task', 'reviews', '--json'], { cwd: dir, env });
    assert.equal(reviews.status, 0, reviews.stderr);
    const reviewItem = JSON.parse(reviews.stdout).queue.items[0];
    assert.equal(reviewItem.id, task.id);
    assert.equal(reviewItem.next_action, 'proof_boundary_blocked');
    assert.equal(reviewItem.accept_command, null);
    assert.equal(reviewItem.blocked_accept_reason, 'proof_unmerged_or_draft_pr_boundary');
    assert.match(reviewItem.revise_command, new RegExp(`atris task revise ${ref}`));

    const reviewText = runCli(['task', 'reviews'], { cwd: dir, env });
    assert.equal(reviewText.status, 0, reviewText.stderr);
    assert.match(reviewText.stdout, /approve: blocked \(proof_unmerged_or_draft_pr_boundary\)/);
    assert.doesNotMatch(reviewText.stdout, new RegExp(`approve: atris task accept ${ref}`));

    const dryRun = runCli(['task', 'auto-accept-certified', '--dry-run', '--json'], { cwd: dir, env });
    assert.equal(dryRun.status, 0, dryRun.stderr);
    const dryRunResult = JSON.parse(dryRun.stdout).results[0];
    assert.equal(dryRunResult.action, 'skipped');
    assert.equal(dryRunResult.reason, 'proof_unmerged_or_draft_pr_boundary');

    const currentStep = runCli([
      'task', 'current-step',
      '--goal-id', 'OBL-928',
      '--review-state', 'proof-boundary-blocked',
      '--json',
    ], { cwd: dir, env });
    assert.notEqual(currentStep.status, 0);
    assert.equal(JSON.parse(currentStep.stdout).reason, 'proof_boundary_blocked_requires_revision');
  } finally {
    cleanupTempDir(dir);
  }
});

test('task serve continue-work creates scoped follow-up', async () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex', ATRIS_SKIP_UPDATE_CHECK: '1' };
  let child = null;
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const created = runCli([
      'task', 'add', 'API certified continuation parent',
      '--tag', 'factory',
      '--goal-id', 'OBL-933',
      '--json',
    ], { cwd: dir, env });
    assert.equal(created.status, 0, created.stderr);
    const parent = JSON.parse(created.stdout).task;
    assert.equal(runCli([
      'task', 'ready', parent.display_id,
      '--as', 'codex',
      '--proof', 'node --test test/commands.test.js passed before API continue-work',
    ], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'review', parent.display_id,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js passed during API continue-work review',
      '--next', 'API scoped continuation child',
    ], { cwd: dir, env }).status, 0);

    child = spawn(process.execPath, [cliPath, 'task', 'serve', '--host', '127.0.0.1', '--port', '0'], {
      cwd: dir,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const ready = await waitForOutput(child, /Task board: (http:\/\/127\.0\.0\.1:\d+)/);
    const base = ready.match[1];

    const detail = await fetch(`${base}/api/tasks/${parent.id}`).then(r => r.json());
    assert.equal(detail.ok, true);
    assert.equal(detail.page.stage.next_action.key, 'continue_work');
    assert.equal(detail.page.stage.next_action.command, `atris task continue-work ${parent.display_id} --as codex --json`);
    assert.deepEqual(detail.page.stage.next_action.api, { method: 'POST', path: `/api/tasks/${parent.id}/continue-work` });

    const continued = await fetch(`${base}/api/tasks/${parent.id}/continue-work`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'codex' }),
    }).then(r => r.json());
    assert.equal(continued.ok, true);
    assert.equal(continued.action, 'continue_work');
    assert.equal(continued.created, true);
    assert.equal(continued.parent.status, 'review');
    assert.equal(continued.parent.review.approval_status, 'pending');
    assert.equal(continued.next_task.title, 'API scoped continuation child');
    assert.equal(continued.next_task.status, 'open');
    assert.equal(continued.next_task.metadata.goal_id, 'OBL-933');
    assert.equal(continued.next_task.lineage.parent_task_id, parent.id);
    assert.equal(continued.safety.human_accept, false);

    const reused = await fetch(`${base}/api/tasks/${parent.id}/continue-work`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'codex' }),
    }).then(r => r.json());
    assert.equal(reused.ok, true);
    assert.equal(reused.next_task_id, continued.next_task_id);
    assert.equal(reused.created, false);
  } finally {
    if (child) child.kill('SIGTERM');
    cleanupTempDir(dir);
  }
});

test('task serve rejects generic review next continuation', async () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex', ATRIS_SKIP_UPDATE_CHECK: '1' };
  let child = null;
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    child = spawn(process.execPath, [cliPath, 'task', 'serve', '--host', '127.0.0.1', '--port', '0'], {
      cwd: dir,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const readyServer = await waitForOutput(child, /Task board: (http:\/\/127\.0\.0\.1:\d+)/);
    const base = readyServer.match[1];

    const created = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'API certified row with generic continuation text', tag: 'factory' }),
    }).then(r => r.json());
    assert.equal(created.ok, true);

    const genericNext = 'Human accept remains pending for XP; next agent-actionable work can continue from OBL-1008.';
    const ready = await fetch(`${base}/api/tasks/${created.task_id}/ready`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actor: 'codex',
        proof: 'node --test test/commands.test.js passed before API generic continue-work guard',
        next: genericNext,
      }),
    }).then(r => r.json());
    assert.equal(ready.ok, true);
    assert.equal(ready.review_next_task_ignored.reason, 'non_specific_next_task');
    assert.equal(ready.task.review.next_task, null);

    const reviewed = await fetch(`${base}/api/tasks/${created.task_id}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actor: 'codex-review',
        reward: 0,
        proof: 'node --test test/commands.test.js passed during API generic continue-work guard',
        next: genericNext,
      }),
    }).then(r => r.json());
    assert.equal(reviewed.ok, true);
    assert.equal(reviewed.review_next_task_ignored.reason, 'non_specific_next_task');
    assert.equal(reviewed.task.review.agent_certified, true);
    assert.equal(reviewed.task.review.next_task, null);

    const detail = await fetch(`${base}/api/tasks/${created.task_id}`).then(r => r.json());
    assert.equal(detail.ok, true);
    assert.equal(detail.page.stage.next_action.key, 'human_accept_waiting');
    assert.equal(detail.page.stage.next_action.command, null);
    assert.equal(detail.page.stage.next_action.api, null);

    const continuedResponse = await fetch(`${base}/api/tasks/${created.task_id}/continue-work`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'codex' }),
    });
    assert.equal(continuedResponse.status, 409);
    const continued = await continuedResponse.json();
    assert.equal(continued.ok, false);
    assert.equal(continued.reason, 'no_next_task');
    assert.match(continued.detail, /no specific next_task suggestion/);
  } finally {
    if (child) child.kill('SIGTERM');
    cleanupTempDir(dir);
  }
});

test('task serve exposes review-lane-drain API', async () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex', ATRIS_SKIP_UPDATE_CHECK: '1' };
  let child = null;
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const continueCreated = runCli([
      'task', 'new', 'API drain row with executable continuation',
      '--tag', 'task',
      '--goal-id', 'OBL-930',
      '--json',
    ], { cwd: dir, env });
    assert.equal(continueCreated.status, 0, continueCreated.stderr);
    const continueTask = JSON.parse(continueCreated.stdout).task;
    const continueRef = continueTask.display_id;
    assert.equal(runCli([
      'task', 'ready', continueRef,
      '--as', 'codex',
      '--proof', 'node --test test/commands.test.js passed before API review lane drain',
    ], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'review', continueRef,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js passed during API review lane drain',
      '--next', 'Add a scoped API review drain follow-up',
    ], { cwd: dir, env }).status, 0);

    const waitingCreated = runCli([
      'task', 'new', 'API drain row waiting on human accept',
      '--tag', 'task',
      '--goal-id', 'OBL-930',
      '--json',
    ], { cwd: dir, env });
    assert.equal(waitingCreated.status, 0, waitingCreated.stderr);
    const waitingTask = JSON.parse(waitingCreated.stdout).task;
    const waitingRef = waitingTask.display_id;
    assert.equal(runCli([
      'task', 'ready', waitingRef,
      '--as', 'codex',
      '--proof', 'node --test test/commands.test.js passed before API human accept wait drain',
    ], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'review', waitingRef,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js passed during API human accept wait drain',
    ], { cwd: dir, env }).status, 0);

    const humanOnlyCreated = runCli([
      'task', 'new', 'API act row waiting on human accept',
      '--tag', 'task',
      '--goal-id', 'OBL-931',
      '--json',
    ], { cwd: dir, env });
    assert.equal(humanOnlyCreated.status, 0, humanOnlyCreated.stderr);
    const humanOnlyRef = JSON.parse(humanOnlyCreated.stdout).task.display_id;
    assert.equal(runCli([
      'task', 'ready', humanOnlyRef,
      '--as', 'codex',
      '--proof', 'node --test test/commands.test.js passed before API review-lane-act human block',
    ], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'review', humanOnlyRef,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js passed during API review-lane-act human block',
    ], { cwd: dir, env }).status, 0);

    const runContinueCreated = runCli([
      'task', 'new', 'API run should continue one certified task',
      '--tag', 'task',
      '--goal-id', 'OBL-932',
      '--json',
    ], { cwd: dir, env });
    assert.equal(runContinueCreated.status, 0, runContinueCreated.stderr);
    const runContinueRef = JSON.parse(runContinueCreated.stdout).task.display_id;
    assert.equal(runCli([
      'task', 'ready', runContinueRef,
      '--as', 'codex',
      '--proof', 'node --test test/commands.test.js passed before API review-lane-run continuation',
    ], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'review', runContinueRef,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js passed during API review-lane-run continuation',
      '--next', 'Add a follow-up created by API review lane run',
    ], { cwd: dir, env }).status, 0);

    const runWaitingCreated = runCli([
      'task', 'new', 'API run should stop on human accept wait',
      '--tag', 'task',
      '--goal-id', 'OBL-932',
      '--json',
    ], { cwd: dir, env });
    assert.equal(runWaitingCreated.status, 0, runWaitingCreated.stderr);
    const runWaitingRef = JSON.parse(runWaitingCreated.stdout).task.display_id;
    assert.equal(runCli([
      'task', 'ready', runWaitingRef,
      '--as', 'codex',
      '--proof', 'node --test test/commands.test.js passed before API review-lane-run human gate',
    ], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'review', runWaitingRef,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js passed during API review-lane-run human gate',
    ], { cwd: dir, env }).status, 0);

    child = spawn(process.execPath, [cliPath, 'task', 'serve', '--host', '127.0.0.1', '--port', '0'], {
      cwd: dir,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const readyServer = await waitForOutput(child, /Task board: (http:\/\/127\.0\.0\.1:\d+)/);
    const base = readyServer.match[1];

    const capabilities = await fetch(`${base}/api/tasks/capabilities`).then(r => r.json());
    assert.equal(capabilities.ok, true);
    assert.equal(capabilities.capabilities.commands.review_lane_drain, 'atris task review-lane-drain --json');
    assert.equal(capabilities.capabilities.commands.review_lane_act, 'atris task review-lane-act --json');
    assert.equal(capabilities.capabilities.commands.review_lane_loop, 'atris task review-lane-loop --json');
    assert.equal(capabilities.capabilities.commands.review_lane_run, 'atris task review-lane-run --json');
    assert.deepEqual(capabilities.capabilities.surfaces.review_lane_drain.api, { method: 'GET', path: '/api/tasks/review-lane-drain' });
    assert.deepEqual(capabilities.capabilities.surfaces.review_lane_act.api, { method: 'POST', path: '/api/tasks/review-lane-act' });
    assert.deepEqual(capabilities.capabilities.surfaces.review_lane_loop.api, { method: 'POST', path: '/api/tasks/review-lane-loop' });
    assert.deepEqual(capabilities.capabilities.surfaces.review_lane_run.api, { method: 'POST', path: '/api/tasks/review-lane-run' });

    const response = await fetch(`${base}/api/tasks/review-lane-drain?goal_id=OBL-930`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    const continueCommand = `atris task continue-work ${continueRef} --as codex --json`;
    assert.equal(payload.ok, true);
    assert.equal(payload.action, 'review_lane_drain');
    assert.equal(payload.capabilities_check.ok, true);
    assert.equal(payload.drain.next_action, 'continue_work');
    assert.equal(payload.drain.safe_for_agent, true);
    assert.equal(payload.drain.command, continueCommand);
    assert.deepEqual(payload.drain.api, { method: 'POST', path: `/api/tasks/${continueTask.id}/continue-work` });
    assert.equal(payload.review_state_actions.human_accept_waiting.id, waitingTask.id);
    assert.equal(payload.review_state_actions.human_accept_waiting.command, null);
    assert.equal(payload.review_state_actions.human_accept_waiting.api, null);
    assert.equal(payload.drain.human_accept_waiting.command, null);
    assert.equal(payload.drain.human_accept_waiting.api, null);
    assert.equal(payload.safety.human_accept, false);

    const actDryRun = await fetch(`${base}/api/tasks/review-lane-act?goal_id=OBL-930`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'codex', dry_run: true }),
    }).then(r => r.json());
    assert.equal(actDryRun.ok, true);
    assert.equal(actDryRun.action, 'review_lane_act');
    assert.equal(actDryRun.dry_run, true);
    assert.equal(actDryRun.acted, false);
    assert.equal(actDryRun.decision.step_action, 'continue_work');
    assert.equal(actDryRun.safety.human_accept, false);

    const loopDryRun = await fetch(`${base}/api/tasks/review-lane-loop?goal_id=OBL-930`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'codex', dry_run: true, max_steps: 3 }),
    }).then(r => r.json());
    assert.equal(loopDryRun.ok, true);
    assert.equal(loopDryRun.action, 'review_lane_loop');
    assert.equal(loopDryRun.dry_run, true);
    assert.equal(loopDryRun.acted_count, 0);
    assert.equal(loopDryRun.stopped_reason, 'dry_run_preview');
    assert.equal(loopDryRun.steps[0].decision.step_action, 'continue_work');
    assert.equal(loopDryRun.safety.human_accept, false);

    const loopResponse = await fetch(`${base}/api/tasks/review-lane-loop?goal_id=OBL-930`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'codex', max_steps: 3 }),
    });
    assert.equal(loopResponse.status, 200);
    const loopPayload = await loopResponse.json();
    assert.equal(loopPayload.ok, true);
    assert.equal(loopPayload.acted_count, 1);
    assert.equal(loopPayload.steps[0].selected_action, 'continue_work');
    assert.ok(loopPayload.steps[0].result.next_task_id);
    assert.equal(loopPayload.stopped_reason, 'human_accept_waiting_is_human_only');
    assert.equal(loopPayload.final_drain.next_action, 'human_accept_waiting');
    assert.equal(loopPayload.final_drain.command, null);
    assert.equal(loopPayload.final_drain.api, null);
    assert.equal(loopPayload.safety.human_accept, false);

    const apiRealDir = fs.realpathSync(dir);
    const apiRunReceiptPath = path.join(apiRealDir, '.atris', 'state', 'review-lane-runs.jsonl');
    const apiRunLatestPath = path.join(apiRealDir, '.atris', 'state', 'review-lane-run.latest.json');
    const runDryRun = await fetch(`${base}/api/tasks/review-lane-run?goal_id=OBL-932`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'codex', dry_run: true, max_runs: 2, max_steps: 1 }),
    }).then(r => r.json());
    assert.equal(runDryRun.ok, true);
    assert.equal(runDryRun.action, 'review_lane_run');
    assert.equal(runDryRun.dry_run, true);
    assert.equal(runDryRun.run_count, 1);
    assert.equal(runDryRun.total_acted_count, 0);
    assert.equal(runDryRun.stopped_reason, 'dry_run_preview');
    assert.equal(runDryRun.receipt_written, false);
    assert.equal(runDryRun.would_write_receipt_path, apiRunReceiptPath);
    assert.equal(fs.existsSync(apiRunReceiptPath), false);

    const beforeRunWaiting = JSON.parse(runCli(['task', 'show', runWaitingRef, '--json'], { cwd: dir, env }).stdout);
    const runResponse = await fetch(`${base}/api/tasks/review-lane-run?goal_id=OBL-932`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'codex', max_runs: 2, max_steps: 1 }),
    });
    assert.equal(runResponse.status, 200);
    const runPayload = await runResponse.json();
    assert.equal(runPayload.ok, true);
    assert.equal(runPayload.run_count, 2);
    assert.equal(runPayload.total_acted_count, 1);
    assert.equal(runPayload.runs[0].stopped_reason, 'max_steps_reached');
    assert.equal(runPayload.runs[0].steps[0].selected_action, 'continue_work');
    assert.equal(runPayload.stopped_reason, 'human_accept_waiting_is_human_only');
    assert.equal(runPayload.receipt_written, true);
    assert.equal(runPayload.receipt_path, apiRunReceiptPath);
    assert.equal(runPayload.latest_receipt_path, apiRunLatestPath);
    assert.equal(runPayload.safety.human_accept, false);
    assert.equal(fs.existsSync(apiRunReceiptPath), true);
    assert.equal(fs.existsSync(apiRunLatestPath), true);
    const afterRunWaiting = JSON.parse(runCli(['task', 'show', runWaitingRef, '--json'], { cwd: dir, env }).stdout);
    assert.equal(afterRunWaiting.current_version, beforeRunWaiting.current_version);

    const actResponse = await fetch(`${base}/api/tasks/review-lane-act?goal_id=OBL-930`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'codex' }),
    });
    assert.equal(actResponse.status, 409);
    const actPayload = await actResponse.json();
    assert.equal(actPayload.ok, false);
    assert.equal(actPayload.acted, false);
    assert.equal(actPayload.reason, 'human_accept_waiting_is_human_only');
    assert.equal(actPayload.drain.command, null);
    assert.equal(actPayload.drain.api, null);
    assert.equal(actPayload.safety.human_accept, false);

    const blockedResponse = await fetch(`${base}/api/tasks/review-lane-act?goal_id=OBL-931`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'codex' }),
    });
    assert.equal(blockedResponse.status, 409);
    const blockedPayload = await blockedResponse.json();
    assert.equal(blockedPayload.ok, false);
    assert.equal(blockedPayload.acted, false);
    assert.equal(blockedPayload.reason, 'human_accept_waiting_is_human_only');
    assert.equal(blockedPayload.drain.command, null);
    assert.equal(blockedPayload.drain.api, null);
    assert.equal(blockedPayload.safety.human_accept, false);

    const blockedLoopResponse = await fetch(`${base}/api/tasks/review-lane-loop?goal_id=OBL-931`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'codex', max_steps: 3 }),
    });
    assert.equal(blockedLoopResponse.status, 200);
    const blockedLoop = await blockedLoopResponse.json();
    assert.equal(blockedLoop.ok, true);
    assert.equal(blockedLoop.acted_count, 0);
    assert.equal(blockedLoop.stopped_reason, 'human_accept_waiting_is_human_only');
    assert.equal(blockedLoop.final_drain.command, null);
    assert.equal(blockedLoop.final_drain.api, null);
    assert.equal(blockedLoop.safety.human_accept, false);
  } finally {
    if (child) child.kill('SIGTERM');
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
	    // heartbeat strip + live activity stream (replaced the old smoke placeholder)
	    assert.match(html, /class="beat" id="heartbeat"/);
	    assert.match(html, /class="activity" id="activity"/);
	    assert.match(html, /async function loadStream\(\)/);
	    assert.match(html, /\/api\/tasks\/' \+ task\.id \+ '\/ready/);
	    assert.match(html, /\/api\/tasks\/' \+ task\.id \+ '\/accept/);
	    assert.match(html, /if \(lesson\) payload\.lesson = lesson/);
	    assert.match(html, /if \(nextTask\) payload\.next = nextTask/);
	    assert.match(html, /task\.review && task\.review\.next_task/);
	    assert.doesNotMatch(html, /\/api\/tasks\/' \+ task\.id \+ '\/finish/);

    // the activity stream endpoint returns a heartbeat + an events array
    const stream = await fetch(`${base}/api/stream`).then(r => r.json());
    assert.equal(stream.ok, true);
    assert.ok(stream.heartbeat && typeof stream.heartbeat.state === 'string');
    assert.ok(Array.isArray(stream.events));

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

	    const missingFinishProofResponse = await fetch(`${base}/api/tasks/${created.task_id}/finish`, {
	      method: 'POST',
	      headers: { 'content-type': 'application/json' },
	      body: JSON.stringify({ actor: 'operator' }),
	    });
	    assert.equal(missingFinishProofResponse.status, 400);
	    const missingFinishProof = await missingFinishProofResponse.json();
	    assert.equal(missingFinishProof.reason, 'proof_required');

	    const weakFinishProofResponse = await fetch(`${base}/api/tasks/${created.task_id}/finish`, {
	      method: 'POST',
	      headers: { 'content-type': 'application/json' },
	      body: JSON.stringify({ actor: 'operator', proof: 'done' }),
	    });
	    assert.equal(weakFinishProofResponse.status, 400);
	    const weakFinishProof = await weakFinishProofResponse.json();
	    assert.equal(weakFinishProof.reason, 'weak_proof');

	    const finished = await fetch(`${base}/api/tasks/${created.task_id}/finish`, {
	      method: 'POST',
	      headers: { 'content-type': 'application/json' },
	      body: JSON.stringify({
	        actor: 'operator',
	        proof: 'node --test test/commands.test.js passed for task serve API',
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
    const earlyApiReviewChatResponse = await fetch(`${base}/api/tasks/${apiReviewId}/review-chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'codex-review' }),
    });
    assert.equal(earlyApiReviewChatResponse.status, 409);
    assert.equal((await earlyApiReviewChatResponse.json()).reason, 'not_reviewable_open');

    const apiStage = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Drive plan do review through API', tag: 'factory' }),
    }).then(r => r.json());
    assert.equal(apiStage.ok, true);
    const apiStageId = apiStage.task_id;

    const apiChatTask = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Refine API task chat', tag: 'capture' }),
    }).then(r => r.json());
    assert.equal(apiChatTask.ok, true);
    const apiEmptyChatResponse = await fetch(`${base}/api/tasks/${apiChatTask.task_id}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'operator' }),
    });
    assert.equal(apiEmptyChatResponse.status, 400);
    assert.equal((await apiEmptyChatResponse.json()).reason, 'content_required');
    const apiChat = await fetch(`${base}/api/tasks/${apiChatTask.task_id}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actor: 'operator',
        content: 'Make this task useful before planning',
        goal: 'API chat seeds the task goal',
        summary: 'chat narrowed the task',
      }),
    }).then(r => r.json());
    assert.equal(apiChat.ok, true);
    assert.equal(apiChat.action, 'chatted');
    assert.equal(apiChat.task.objective, 'API chat seeds the task goal');
    assert.equal(apiChat.task.metadata.task_goal, 'API chat seeds the task goal');
    assert.ok(apiChat.task.messages.some(message => message.content.includes('TASK_CHAT_UPDATE')));
    const apiChatPlan = await fetch(`${base}/api/tasks/${apiChatTask.task_id}/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actor: 'codex',
        exit: 'API chat plan can use the refined goal',
        proof_needed: 'node --test API chat coverage passes',
      }),
    }).then(r => r.json());
    assert.equal(apiChatPlan.ok, true);
    assert.match(apiChatPlan.stage_packet, /goal: API chat seeds the task goal/);
    const apiChatBacklog = await fetch(`${base}/api/tasks/${apiChatTask.task_id}/backlog`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'codex', reason: 'preserve task goal while clearing plan' }),
    }).then(r => r.json());
    assert.equal(apiChatBacklog.ok, true);
    assert.equal(apiChatBacklog.task.metadata.task_goal, 'API chat seeds the task goal');
    assert.equal(apiChatBacklog.task.metadata.goal_objective, undefined);

    const apiStepTask = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Drive API task step', tag: 'capture' }),
    }).then(r => r.json());
    assert.equal(apiStepTask.ok, true);
    const apiStepPlanned = await fetch(`${base}/api/tasks/${apiStepTask.task_id}/step`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actor: 'codex',
        message: 'Refine this API step task before plan',
        goal: 'API step drives Plan Do Review',
        summary: 'step includes chat before plan',
        exit: 'API step returns the next page action',
        proof_needed: 'node --test test/commands.test.js passes API step coverage',
      }),
    }).then(r => r.json());
    assert.equal(apiStepPlanned.ok, true);
    assert.equal(apiStepPlanned.action, 'stepped');
    assert.equal(apiStepPlanned.step_action, 'planned');
    assert.equal(apiStepPlanned.chat.action, 'chatted');
    assert.equal(apiStepPlanned.page.stage.current, 'plan');
    assert.equal(apiStepPlanned.page.stage.next_action.key, 'do');
    assert.equal(apiStepPlanned.page.api.step, `/api/tasks/${apiStepTask.task_id}/step`);

    const apiStepDoing = await fetch(`${base}/api/tasks/${apiStepTask.task_id}/step`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'codex', first_move: 'run API step smoke' }),
    }).then(r => r.json());
    assert.equal(apiStepDoing.ok, true);
    assert.equal(apiStepDoing.step_action, 'doing');
    assert.equal(apiStepDoing.page.stage.current, 'do');

    const apiStepReady = await fetch(`${base}/api/tasks/${apiStepTask.task_id}/step`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actor: 'codex',
        proof: 'node --test test/commands.test.js passed for API task step',
        lesson: 'API step keeps accept human-only',
      }),
    }).then(r => r.json());
    assert.equal(apiStepReady.ok, true);
    assert.equal(apiStepReady.step_action, 'ready');
    assert.equal(apiStepReady.page.stage.current, 'review');
    assert.equal(apiStepReady.page.stage.next_action.key, 'review_chat');
    assert.notEqual(apiStepReady.page.stage.next_action.command, apiStepReady.page.review.human_accept.command);

    const apiStepReviewChat = await fetch(`${base}/api/tasks/${apiStepTask.task_id}/step`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reviewer: 'codex-review' }),
    }).then(r => r.json());
	    assert.equal(apiStepReviewChat.ok, true);
	    assert.equal(apiStepReviewChat.step_action, 'review_chat');
	    assert.equal(apiStepReviewChat.contract.schema, 'atris.task_review_chat.v1');
	    assert.equal(apiStepReviewChat.page.task.status, 'review');

	    const apiScopedAdd = runCli([
	      'task', 'add', 'Scoped API current task',
	      '--tag', 'api-scope',
	      '--goal-id', 'OBL-928',
	      '--json',
	    ], { cwd: dir, env });
	    assert.equal(apiScopedAdd.status, 0, apiScopedAdd.stderr);
	    const apiScopedTask = JSON.parse(apiScopedAdd.stdout).task;

	    const apiCurrent = await fetch(`${base}/api/tasks/current?owner=codex&reviewer=codex-review`).then(r => r.json());
	    assert.equal(apiCurrent.ok, true);
	    assert.equal(apiCurrent.action, 'current');
	    assert.equal(apiCurrent.current.schema, 'atris.task_current.v1');
	    assert.equal(apiCurrent.current.safety.read_only, true);
	    assert.equal(apiCurrent.current.safety.claims_work, false);
	    assert.equal(apiCurrent.current.safety.human_accept, false);
	    assert.equal(apiCurrent.current.selected_task_id, apiStepTask.task_id);
	    assert.equal(apiCurrent.page.stage.current, 'review');
	    assert.equal(apiCurrent.current.next.key, 'review_chat');
	    assert.equal(apiCurrent.current.next.step_api, `/api/tasks/${apiStepTask.task_id}/step`);
	    assert.equal(apiCurrent.queue.schema, 'atris.task_queue.v1');
	    assert.ok(apiCurrent.queue.counts.review >= 1);

	    const apiCapabilities = await fetch(`${base}/api/tasks/capabilities`).then(r => r.json());
	    assert.equal(apiCapabilities.ok, true);
	    assert.equal(apiCapabilities.action, 'capabilities');
	    assert.deepEqual(apiCapabilities.capabilities, apiCurrent.current.capabilities);
	    assert.equal(apiCapabilities.safety.read_only, true);
	    assert.equal(apiCapabilities.safety.claims_work, false);
	    assert.equal(apiCapabilities.safety.human_accept, false);
	    assert.equal(apiCapabilities.safety.xp_after_human_accept, true);
	    assert.equal(apiCapabilities.projection_path, undefined);

	    const apiCapabilitiesCheck = await fetch(`${base}/api/tasks/capabilities/check?owner=codex`).then(r => r.json());
	    assert.equal(apiCapabilitiesCheck.ok, true);
	    assert.equal(apiCapabilitiesCheck.action, 'capabilities_check');
	    assert.equal(apiCapabilitiesCheck.schema, 'atris.task_capabilities_check.v1');
	    assert.deepEqual(apiCapabilitiesCheck.capabilities, apiCurrent.current.capabilities);
	    assert.equal(apiCapabilitiesCheck.summary.failed, 0);
	    assert.equal(apiCapabilitiesCheck.safety.mutates_task_db, false);
	    assert.equal(apiCapabilitiesCheck.safety.writes_projection, true);
	    assert.ok(apiCapabilitiesCheck.checks.some(check => check.name === 'current_queue_capabilities_match' && check.ok));
	    assert.ok(apiCapabilitiesCheck.checks.some(check => check.name === 'read_only_projection_semantics_declared' && check.ok));
	    assert.ok(apiCapabilitiesCheck.checks.some(check => check.name === 'capabilities_check_surface_declared' && check.ok));

	    assert.equal(runCli(['task', 'claim', apiScopedTask.display_id, '--as', 'codex'], { cwd: dir, env }).status, 0);
	    const apiScopedCurrent = await fetch(`${base}/api/tasks/current?owner=codex&goal_id=OBL-928`).then(r => r.json());
	    assert.equal(apiScopedCurrent.ok, true);
	    assert.equal(apiScopedCurrent.current.scope.goal_id, 'OBL-928');
	    assert.equal(apiScopedCurrent.current.selected_task_id, apiScopedTask.id);
	    assert.equal(apiScopedCurrent.current.selected_reason, 'claimed_by_owner');
	    assert.equal(apiScopedCurrent.queue.counts.total, 1);
	    assert.equal(apiScopedCurrent.queue.counts.review, 0);
	    assert.equal(apiScopedCurrent.page.task.ref, apiScopedTask.display_id);

	    const apiScopedQueue = await fetch(`${base}/api/tasks/queue?goal_id=OBL-928&tag=api-scope`).then(r => r.json());
	    assert.equal(apiScopedQueue.ok, true);
	    assert.equal(apiScopedQueue.queue.scope.goal_id, 'OBL-928');
	    assert.equal(apiScopedQueue.queue.scope.tag, 'api-scope');
	    assert.equal(apiScopedQueue.queue.counts.total, 1);
	    assert.equal(apiScopedQueue.queue.columns.find(column => column.key === 'do').items[0].id, apiScopedTask.id);

	    const apiStatusCurrent = await fetch(`${base}/api/tasks/current?status=review&review_state=needs-agent`).then(r => r.json());
		    assert.equal(apiStatusCurrent.ok, true);
		    assert.equal(apiStatusCurrent.current.scope.status, 'review');
		    assert.equal(apiStatusCurrent.current.scope.review_state, 'needs-agent');
			    assert.equal(apiStatusCurrent.current.selected_task_id, apiStepTask.task_id);
			    assert.equal(apiStatusCurrent.current.next.key, 'review_chat');
			    assert.equal(apiStatusCurrent.selected.continue_work_command, undefined);
			    assert.equal(apiStatusCurrent.selected.commands.continue_work, undefined);
			    assert.deepEqual(apiStatusCurrent.current.capabilities, apiStatusCurrent.queue.capabilities);
			    assert.equal(apiStatusCurrent.current.capabilities.schema, 'atris.task_capabilities.v1');
			    assert.deepEqual(apiStatusCurrent.current.capabilities.filters.review_state.accepted, ['needs-agent', 'continue-work', 'proof-boundary-blocked', 'human-accept-waiting', 'certified']);
			    assert.equal(apiStatusCurrent.current.capabilities.current_step.lanes['needs-agent'].step_action, 'review_chat');
			    assert.equal(apiStatusCurrent.current.capabilities.current_step.safety.claims_work, 'conditional');
			    assert.equal(apiStatusCurrent.current.capabilities.current_step.stage_safety.plan.claims_work, true);
			    assert.equal(apiStatusCurrent.current.review_state_counts.active_filter, 'needs-agent');
			    assert.equal(apiStatusCurrent.current.review_state_counts.scope.status, 'review');
			    assert.equal(apiStatusCurrent.current.review_state_counts.scope.review_state, null);
		    assert.equal(apiStatusCurrent.current.review_state_counts.total, 1);
		    assert.equal(apiStatusCurrent.current.review_state_counts.needs_agent, 1);
		    assert.deepEqual(apiStatusCurrent.current.review_state_actions, apiStatusCurrent.queue.review_state_actions);
		    assert.equal(apiStatusCurrent.current.review_state_actions.active_filter, 'needs-agent');
		    assert.equal(apiStatusCurrent.current.review_state_actions.scope.status, 'review');
		    assert.equal(apiStatusCurrent.current.review_state_actions.scope.review_state, null);
			    assert.equal(apiStatusCurrent.current.review_state_actions.needs_agent, null);
			    assert.equal(apiStatusCurrent.current.review_state_actions.pending_review_chat_count, 1);
			    assert.equal(apiStatusCurrent.current.review_state_actions.pending_review_chat[0].id, apiStepTask.task_id);
			    assert.equal(apiStatusCurrent.current.review_state_actions.pending_review_chat[0].next_action, 'pending_review_chat');
			    assert.equal(apiStatusCurrent.current.review_state_actions.pending_review_chat[0].command, null);
			    assert.equal(apiStatusCurrent.current.review_state_actions.pending_review_chat[0].api, null);
			    assert.equal(apiStatusCurrent.current.review_state_actions.continue_work, null);
			    assert.equal(apiStatusCurrent.current.review_state_actions.human_accept_waiting, null);

		    const apiNeedsAgentQueue = await fetch(`${base}/api/tasks/queue?status=review&review_state=needs-agent`).then(r => r.json());
		    assert.equal(apiNeedsAgentQueue.ok, true);
		    assert.equal(apiNeedsAgentQueue.action, 'queue');
		    assert.equal(apiNeedsAgentQueue.current.scope.status, 'review');
		    assert.equal(apiNeedsAgentQueue.current.scope.review_state, 'needs-agent');
		    assert.equal(apiNeedsAgentQueue.current.selected_task_id, apiStepTask.task_id);
		    assert.equal(apiNeedsAgentQueue.current.next.key, 'review_chat');
		    assert.equal(apiNeedsAgentQueue.queue.scope.status, 'review');
		    assert.equal(apiNeedsAgentQueue.queue.scope.review_state, 'needs-agent');
		    assert.equal(apiNeedsAgentQueue.queue.counts.total, 1);
		    assert.equal(apiNeedsAgentQueue.queue.counts.review, 1);
		    assert.deepEqual(apiNeedsAgentQueue.current.review_state_counts, apiNeedsAgentQueue.queue.review_state_counts);
		    assert.equal(apiNeedsAgentQueue.queue.review_state_counts.total, 1);
		    assert.equal(apiNeedsAgentQueue.queue.review_state_counts.needs_agent, 1);
		    assert.deepEqual(apiNeedsAgentQueue.current.review_state_actions, apiNeedsAgentQueue.queue.review_state_actions);
		    assert.equal(apiNeedsAgentQueue.queue.review_state_actions.active_filter, 'needs-agent');
			    assert.equal(apiNeedsAgentQueue.queue.review_state_actions.needs_agent, null);
			    assert.equal(apiNeedsAgentQueue.queue.review_state_actions.pending_review_chat_count, 1);
			    assert.equal(apiNeedsAgentQueue.queue.review_state_actions.pending_review_chat[0].id, apiStepTask.task_id);
			    assert.equal(apiNeedsAgentQueue.queue.review_state_actions.pending_review_chat[0].next_action, 'pending_review_chat');
			    assert.equal(apiNeedsAgentQueue.queue.review_state_actions.pending_review_chat[0].command, null);
		    const apiNeedsAgentItem = apiNeedsAgentQueue.queue.columns.find(column => column.key === 'review').items[0];
		    assert.equal(apiNeedsAgentItem.id, apiStepTask.task_id);
		    assert.equal(apiNeedsAgentItem.continue_work_command, undefined);
		    assert.equal(apiNeedsAgentItem.commands.continue_work, undefined);

	    const apiContinueCreated = runCli([
	      'task', 'add', 'API certified task with continuation action',
	      '--tag', 'api-review-state',
	      '--goal-id', 'OBL-934',
	      '--json',
	    ], { cwd: dir, env });
	    assert.equal(apiContinueCreated.status, 0, apiContinueCreated.stderr);
	    const apiContinueTask = JSON.parse(apiContinueCreated.stdout).task;
	    assert.equal(runCli(['task', 'claim', apiContinueTask.display_id, '--as', 'codex'], { cwd: dir, env }).status, 0);
	    assert.equal(runCli([
	      'task', 'ready', apiContinueTask.display_id,
	      '--as', 'codex',
	      '--proof', 'node --test test/commands.test.js passed before API continue-work filter',
	    ], { cwd: dir, env }).status, 0);
	    assert.equal(runCli([
	      'task', 'review', apiContinueTask.display_id,
	      '--reward', '0',
	      '--as', 'codex-review',
	      '--proof', 'node --test test/commands.test.js passed during API continue-work filter',
	      '--next', 'Run the API continuation follow-up',
	    ], { cwd: dir, env }).status, 0);

	    const apiWaitingCreated = runCli([
	      'task', 'add', 'API certified task waiting for human accept',
	      '--tag', 'api-review-state',
	      '--goal-id', 'OBL-934',
	      '--json',
	    ], { cwd: dir, env });
	    assert.equal(apiWaitingCreated.status, 0, apiWaitingCreated.stderr);
	    const apiWaitingTask = JSON.parse(apiWaitingCreated.stdout).task;
	    assert.equal(runCli(['task', 'claim', apiWaitingTask.display_id, '--as', 'codex'], { cwd: dir, env }).status, 0);
	    assert.equal(runCli([
	      'task', 'ready', apiWaitingTask.display_id,
	      '--as', 'codex',
	      '--proof', 'node --test test/commands.test.js passed before API human-accept filter',
	    ], { cwd: dir, env }).status, 0);
	    assert.equal(runCli([
	      'task', 'review', apiWaitingTask.display_id,
	      '--reward', '0',
	      '--as', 'codex-review',
	      '--proof', 'node --test test/commands.test.js passed during API human-accept filter',
	    ], { cwd: dir, env }).status, 0);

	    const apiContinueCommand = `atris task continue-work ${apiContinueTask.display_id} --as codex --json`;
	    const apiContinueCurrent = await fetch(`${base}/api/tasks/current?owner=codex&goal_id=OBL-934&review_state=continue-work`).then(r => r.json());
	    assert.equal(apiContinueCurrent.ok, true);
	    assert.equal(apiContinueCurrent.current.scope.goal_id, 'OBL-934');
	    assert.equal(apiContinueCurrent.current.scope.review_state, 'continue-work');
	    assert.equal(apiContinueCurrent.current.selected_task_id, apiContinueTask.id);
	    assert.equal(apiContinueCurrent.current.next.key, 'continue_work');
	    assert.equal(apiContinueCurrent.current.next.command, apiContinueCommand);
	    assert.deepEqual(apiContinueCurrent.current.next.api, { method: 'POST', path: `/api/tasks/${apiContinueTask.id}/continue-work` });
	    assert.equal(apiContinueCurrent.selected.continue_work_command, apiContinueCommand);
		    assert.deepEqual(apiContinueCurrent.selected.api.next_action, { method: 'POST', path: `/api/tasks/${apiContinueTask.id}/continue-work` });
		    assert.equal(apiContinueCurrent.current.safety.read_only, true);
		    assert.equal(apiContinueCurrent.current.safety.human_accept, false);
		    assert.deepEqual(apiContinueCurrent.current.capabilities, apiContinueCurrent.queue.capabilities);
		    assert.equal(apiContinueCurrent.current.capabilities.current_step.lanes['continue-work'].creates_or_reuses_follow_up, true);
		    assert.equal(apiContinueCurrent.current.capabilities.current_step.lanes['human-accept-waiting'].reason, 'agent_certified_waiting_human');
		    assert.equal(apiContinueCurrent.current.review_state_counts.active_filter, 'continue-work');
		    assert.equal(apiContinueCurrent.current.review_state_counts.scope.goal_id, 'OBL-934');
		    assert.equal(apiContinueCurrent.current.review_state_counts.scope.review_state, null);
	    assert.equal(apiContinueCurrent.current.review_state_counts.total, 2);
	    assert.equal(apiContinueCurrent.current.review_state_counts.continue_work, 1);
	    assert.equal(apiContinueCurrent.current.review_state_counts.human_accept_waiting, 1);
	    assert.equal(apiContinueCurrent.current.review_state_counts.certified, 2);
	    assert.deepEqual(apiContinueCurrent.current.review_state_actions, apiContinueCurrent.queue.review_state_actions);
	    assert.equal(apiContinueCurrent.current.review_state_actions.active_filter, 'continue-work');
	    assert.equal(apiContinueCurrent.current.review_state_actions.scope.goal_id, 'OBL-934');
	    assert.equal(apiContinueCurrent.current.review_state_actions.scope.review_state, null);
	    assert.equal(apiContinueCurrent.current.review_state_actions.continue_work.id, apiContinueTask.id);
	    assert.equal(apiContinueCurrent.current.review_state_actions.continue_work.next_action, 'continue_work');
	    assert.equal(apiContinueCurrent.current.review_state_actions.continue_work.command, apiContinueCommand);
	    assert.deepEqual(apiContinueCurrent.current.review_state_actions.continue_work.api, { method: 'POST', path: `/api/tasks/${apiContinueTask.id}/continue-work` });
	    assert.equal(apiContinueCurrent.current.review_state_actions.continue_work.continue_work_command, apiContinueCommand);
	    assert.equal(apiContinueCurrent.current.review_state_actions.human_accept_waiting.id, apiWaitingTask.id);
	    assert.equal(apiContinueCurrent.current.review_state_actions.human_accept_waiting.next_action, 'human_accept_waiting');
	    assert.equal(apiContinueCurrent.current.review_state_actions.human_accept_waiting.command, null);
	    assert.equal(apiContinueCurrent.current.review_state_actions.human_accept_waiting.api, null);
	    assert.equal(apiContinueCurrent.current.review_state_actions.human_accept_waiting.human_accept.human_only, true);

		    const apiContinueQueue = await fetch(`${base}/api/tasks/queue?goal_id=OBL-934&review_state=continue-work`).then(r => r.json());
		    assert.equal(apiContinueQueue.ok, true);
		    assert.equal(apiContinueQueue.action, 'queue');
		    assert.equal(apiContinueQueue.current.scope.review_state, 'continue-work');
		    assert.equal(apiContinueQueue.current.selected_task_id, apiContinueTask.id);
		    assert.equal(apiContinueQueue.current.next.key, 'continue_work');
		    assert.equal(apiContinueQueue.current.next.command, apiContinueCommand);
		    assert.equal(apiContinueQueue.queue.scope.review_state, 'continue-work');
		    assert.equal(apiContinueQueue.queue.counts.total, 1);
		    assert.equal(apiContinueQueue.queue.counts.review, 1);
		    assert.deepEqual(apiContinueQueue.current.review_state_counts, apiContinueQueue.queue.review_state_counts);
		    assert.equal(apiContinueQueue.queue.review_state_counts.total, 2);
		    assert.equal(apiContinueQueue.queue.review_state_counts.continue_work, 1);
		    assert.equal(apiContinueQueue.queue.review_state_counts.human_accept_waiting, 1);
		    assert.deepEqual(apiContinueQueue.current.review_state_actions, apiContinueQueue.queue.review_state_actions);
		    assert.equal(apiContinueQueue.queue.review_state_actions.active_filter, 'continue-work');
		    assert.equal(apiContinueQueue.queue.review_state_actions.continue_work.id, apiContinueTask.id);
		    assert.equal(apiContinueQueue.queue.review_state_actions.continue_work.command, apiContinueCommand);
		    assert.equal(apiContinueQueue.queue.review_state_actions.human_accept_waiting.id, apiWaitingTask.id);
		    assert.equal(apiContinueQueue.queue.review_state_actions.human_accept_waiting.command, null);
		    assert.equal(apiContinueQueue.queue.columns.find(column => column.key === 'review').items[0].id, apiContinueTask.id);
		    assert.equal(apiContinueQueue.queue.columns.find(column => column.key === 'review').items[0].continue_work_command, apiContinueCommand);
		    assert.deepEqual(apiContinueQueue.queue.columns.find(column => column.key === 'review').items[0].api.next_action, { method: 'POST', path: `/api/tasks/${apiContinueTask.id}/continue-work` });

	    const apiWaitingCurrent = await fetch(`${base}/api/tasks/current?owner=codex&goal_id=OBL-934&review_state=human-accept-waiting`).then(r => r.json());
	    assert.equal(apiWaitingCurrent.ok, true);
	    assert.equal(apiWaitingCurrent.current.scope.review_state, 'human-accept-waiting');
	    assert.equal(apiWaitingCurrent.current.selected_task_id, apiWaitingTask.id);
	    assert.equal(apiWaitingCurrent.current.next.key, 'human_accept_waiting');
	    assert.equal(apiWaitingCurrent.current.next.command, null);
	    assert.equal(apiWaitingCurrent.current.next.api, null);
	    assert.equal(apiWaitingCurrent.selected.continue_work_command, undefined);
	    assert.equal(apiWaitingCurrent.selected.commands.continue_work, undefined);
	    assert.equal(apiWaitingCurrent.selected.api.next_action, undefined);
	    assert.equal(apiWaitingCurrent.current.safety.read_only, true);
	    assert.equal(apiWaitingCurrent.current.safety.human_accept, false);
	    assert.equal(apiWaitingCurrent.current.review_state_counts.active_filter, 'human-accept-waiting');
	    assert.equal(apiWaitingCurrent.current.review_state_counts.total, 2);
	    assert.equal(apiWaitingCurrent.current.review_state_counts.continue_work, 1);
	    assert.equal(apiWaitingCurrent.current.review_state_counts.human_accept_waiting, 1);
	    assert.deepEqual(apiWaitingCurrent.current.review_state_actions, apiWaitingCurrent.queue.review_state_actions);
	    assert.equal(apiWaitingCurrent.current.review_state_actions.active_filter, 'human-accept-waiting');
	    assert.equal(apiWaitingCurrent.current.review_state_actions.continue_work.id, apiContinueTask.id);
	    assert.equal(apiWaitingCurrent.current.review_state_actions.continue_work.command, apiContinueCommand);
	    assert.equal(apiWaitingCurrent.current.review_state_actions.human_accept_waiting.id, apiWaitingTask.id);
	    assert.equal(apiWaitingCurrent.current.review_state_actions.human_accept_waiting.next_action, 'human_accept_waiting');
	    assert.equal(apiWaitingCurrent.current.review_state_actions.human_accept_waiting.command, null);
	    assert.equal(apiWaitingCurrent.current.review_state_actions.human_accept_waiting.api, null);

		    const apiWaitingQueue = await fetch(`${base}/api/tasks/queue?goal_id=OBL-934&review_state=human-accept-waiting`).then(r => r.json());
		    assert.equal(apiWaitingQueue.ok, true);
		    assert.equal(apiWaitingQueue.action, 'queue');
		    assert.equal(apiWaitingQueue.current.scope.review_state, 'human-accept-waiting');
		    assert.equal(apiWaitingQueue.current.selected_task_id, apiWaitingTask.id);
		    assert.equal(apiWaitingQueue.current.next.key, 'human_accept_waiting');
		    assert.equal(apiWaitingQueue.current.next.command, null);
		    assert.equal(apiWaitingQueue.queue.scope.review_state, 'human-accept-waiting');
		    assert.equal(apiWaitingQueue.queue.counts.total, 1);
		    assert.equal(apiWaitingQueue.queue.counts.review, 1);
		    assert.deepEqual(apiWaitingQueue.current.review_state_counts, apiWaitingQueue.queue.review_state_counts);
		    assert.equal(apiWaitingQueue.queue.review_state_counts.total, 2);
		    assert.equal(apiWaitingQueue.queue.review_state_counts.certified, 2);
		    assert.deepEqual(apiWaitingQueue.current.review_state_actions, apiWaitingQueue.queue.review_state_actions);
		    assert.equal(apiWaitingQueue.queue.review_state_actions.active_filter, 'human-accept-waiting');
		    assert.equal(apiWaitingQueue.queue.review_state_actions.human_accept_waiting.id, apiWaitingTask.id);
		    assert.equal(apiWaitingQueue.queue.review_state_actions.human_accept_waiting.command, null);
		    const apiWaitingItem = apiWaitingQueue.queue.columns.find(column => column.key === 'review').items[0];
		    assert.equal(apiWaitingItem.id, apiWaitingTask.id);
		    assert.equal(apiWaitingItem.continue_work_command, undefined);
		    assert.equal(apiWaitingItem.commands.continue_work, undefined);
		    assert.equal(apiWaitingItem.api.next_action, undefined);

		    const apiNoNextCurrent = await fetch(`${base}/api/tasks/current?owner=codex&goal_id=OBL-934&review_state=no_next_task`).then(r => r.json());
		    assert.equal(apiNoNextCurrent.ok, true);
		    assert.equal(apiNoNextCurrent.current.scope.review_state, 'no_next_task');
		    assert.equal(apiNoNextCurrent.current.selected_task_id, apiWaitingTask.id);
		    assert.equal(apiNoNextCurrent.current.next.key, 'human_accept_waiting');
		    assert.equal(apiNoNextCurrent.current.next.command, null);
		    assert.equal(apiNoNextCurrent.current.review_state_counts.active_filter, 'no_next_task');
		    assert.equal(apiNoNextCurrent.current.review_state_counts.total, 2);
		    assert.equal(apiNoNextCurrent.current.review_state_counts.human_accept_waiting, 1);
		    assert.equal(apiNoNextCurrent.current.review_state_actions.active_filter, 'no_next_task');
		    assert.equal(apiNoNextCurrent.current.review_state_actions.continue_work.id, apiContinueTask.id);
		    assert.equal(apiNoNextCurrent.current.review_state_actions.human_accept_waiting.id, apiWaitingTask.id);
		    assert.equal(apiNoNextCurrent.current.review_state_actions.human_accept_waiting.command, null);

		    const apiNoNextQueue = await fetch(`${base}/api/tasks/queue?goal_id=OBL-934&review_state=no_next_task`).then(r => r.json());
		    assert.equal(apiNoNextQueue.ok, true);
		    assert.equal(apiNoNextQueue.action, 'queue');
		    assert.equal(apiNoNextQueue.current.scope.review_state, 'no_next_task');
		    assert.equal(apiNoNextQueue.current.selected_task_id, apiWaitingTask.id);
		    assert.equal(apiNoNextQueue.current.next.key, 'human_accept_waiting');
		    assert.equal(apiNoNextQueue.current.next.command, null);
		    assert.equal(apiNoNextQueue.queue.scope.review_state, 'no_next_task');
		    assert.equal(apiNoNextQueue.queue.counts.total, 1);
		    assert.equal(apiNoNextQueue.queue.counts.review, 1);
		    assert.deepEqual(apiNoNextQueue.current.review_state_counts, apiNoNextQueue.queue.review_state_counts);
		    assert.equal(apiNoNextQueue.queue.review_state_counts.total, 2);
		    assert.equal(apiNoNextQueue.queue.review_state_counts.continue_work, 1);
		    assert.equal(apiNoNextQueue.queue.review_state_counts.human_accept_waiting, 1);
		    assert.deepEqual(apiNoNextQueue.current.review_state_actions, apiNoNextQueue.queue.review_state_actions);
		    assert.equal(apiNoNextQueue.queue.review_state_actions.active_filter, 'no_next_task');
		    assert.equal(apiNoNextQueue.queue.review_state_actions.continue_work.id, apiContinueTask.id);
		    assert.equal(apiNoNextQueue.queue.review_state_actions.human_accept_waiting.id, apiWaitingTask.id);
		    assert.equal(apiNoNextQueue.queue.review_state_actions.human_accept_waiting.command, null);
		    const apiNoNextItem = apiNoNextQueue.queue.columns.find(column => column.key === 'review').items[0];
		    assert.equal(apiNoNextItem.id, apiWaitingTask.id);
		    assert.equal(apiNoNextItem.continue_work_command, undefined);
		    assert.equal(apiNoNextItem.commands.continue_work, undefined);

		    const apiCertifiedStepMessageResponse = await fetch(`${base}/api/tasks/${apiContinueTask.id}/step`, {
		      method: 'POST',
		      headers: { 'content-type': 'application/json' },
		      body: JSON.stringify({
		        actor: 'codex',
		        message: 'should not write API certified review',
		        goal: 'API certified review should not be refined by step',
		      }),
		    });
		    assert.equal(apiCertifiedStepMessageResponse.status, 409);
		    const apiCertifiedStepMessage = await apiCertifiedStepMessageResponse.json();
		    assert.equal(apiCertifiedStepMessage.reason, 'agent_certified_continue_work');
		    const apiContinueAfterGenericStep = await fetch(`${base}/api/tasks/${apiContinueTask.id}`).then(r => r.json());
		    assert.equal(apiContinueAfterGenericStep.task.status, 'review');
		    assert.equal(apiContinueAfterGenericStep.task.messages.some(m => m.content.includes('should not write API certified review')), false);

		    const apiCurrentStepContinue = await fetch(`${base}/api/tasks/current/step?owner=codex&goal_id=OBL-934&review_state=continue-work`, {
		      method: 'POST',
		      headers: { 'content-type': 'application/json' },
		      body: JSON.stringify({ actor: 'codex' }),
		    }).then(r => r.json());
		    assert.equal(apiCurrentStepContinue.ok, true);
		    assert.equal(apiCurrentStepContinue.action, 'current_step');
		    assert.equal(apiCurrentStepContinue.before_current.scope.review_state, 'continue-work');
		    assert.equal(apiCurrentStepContinue.before_current.selected_task_id, apiContinueTask.id);
		    assert.equal(apiCurrentStepContinue.selected_next_key, 'continue_work');
		    assert.equal(apiCurrentStepContinue.step.step_action, 'continue_work');
		    assert.equal(apiCurrentStepContinue.step.continue_work.action, 'continue_work');
		    assert.equal(apiCurrentStepContinue.step.continue_work.parent_task_id, apiContinueTask.id);
		    assert.equal(apiCurrentStepContinue.step.continue_work.created, true);
		    assert.equal(apiCurrentStepContinue.step.next_task.title, 'Run the API continuation follow-up');
		    assert.equal(apiCurrentStepContinue.page.task.id, apiCurrentStepContinue.step.next_task.id);
		    assert.equal(apiCurrentStepContinue.safety.human_accept, false);
		    assert.equal(apiCurrentStepContinue.safety.claims_work, false);
		    const apiContinueParentAfterStep = await fetch(`${base}/api/tasks/${apiContinueTask.id}`).then(r => r.json());
		    assert.equal(apiContinueParentAfterStep.task.status, 'review');
		    assert.equal(apiContinueParentAfterStep.task.review.approval_status, 'pending');

		    const apiCurrentStepWaitingResponse = await fetch(`${base}/api/tasks/current/step?owner=codex&goal_id=OBL-934&review_state=human-accept-waiting`, {
		      method: 'POST',
		      headers: { 'content-type': 'application/json' },
		      body: JSON.stringify({ actor: 'codex' }),
		    });
		    assert.equal(apiCurrentStepWaitingResponse.status, 409);
		    const apiCurrentStepWaiting = await apiCurrentStepWaitingResponse.json();
		    assert.equal(apiCurrentStepWaiting.reason, 'agent_certified_waiting_human');
		    assert.equal(apiCurrentStepWaiting.selected_task_id, apiWaitingTask.id);
		    assert.equal(apiCurrentStepWaiting.selected_next_key, 'human_accept_waiting');
		    assert.equal(apiCurrentStepWaiting.current.selected_task_id, apiWaitingTask.id);
		    assert.equal(apiCurrentStepWaiting.current.next.key, 'human_accept_waiting');
		    assert.equal(apiCurrentStepWaiting.page.stage.next_action.command, null);
		    assert.equal(apiCurrentStepWaiting.page.stage.next_action.api, null);
		    const apiWaitingAfterStep = await fetch(`${base}/api/tasks/${apiWaitingTask.id}`).then(r => r.json());
		    assert.equal(apiWaitingAfterStep.task.status, 'review');
		    assert.equal(apiWaitingAfterStep.task.review.approval_status, 'pending');

	    const apiQueue = await fetch(`${base}/api/tasks/queue?owner=codex&limit=1`).then(r => r.json());
	    assert.equal(apiQueue.ok, true);
	    assert.equal(apiQueue.action, 'queue');
	    assert.equal(apiQueue.current.schema, 'atris.task_current.v1');
	    assert.equal(apiQueue.queue.columns.some(column => column.key === 'review'), true);
	    const apiStepDetailAfterCurrent = await fetch(`${base}/api/tasks/${apiStepTask.task_id}`).then(r => r.json());
	    assert.equal(apiStepDetailAfterCurrent.task.status, 'review');
	    assert.equal(apiStepDetailAfterCurrent.task.review.approval_status, 'pending');

	    const apiCurrentStepReady = await fetch(`${base}/api/tasks/current/step?goal_id=OBL-928`, {
	      method: 'POST',
	      headers: { 'content-type': 'application/json' },
	      body: JSON.stringify({
	        actor: 'codex',
	        proof: 'node --test test/commands.test.js passed for API current-step ready',
	        lesson: 'API current-step keeps current and step together',
	      }),
	    }).then(r => r.json());
	    assert.equal(apiCurrentStepReady.ok, true);
	    assert.equal(apiCurrentStepReady.action, 'current_step');
	    assert.equal(apiCurrentStepReady.before_current.scope.goal_id, 'OBL-928');
	    assert.equal(apiCurrentStepReady.before_current.selected_task_id, apiScopedTask.id);
	    assert.equal(apiCurrentStepReady.before_current.selected_reason, 'claimed_by_owner');
	    assert.equal(apiCurrentStepReady.selected_next_key, apiCurrentStepReady.before_current.next.key);
	    assert.equal(apiCurrentStepReady.step.step_action, 'ready');
	    assert.equal(apiCurrentStepReady.current.selected_task_id, apiScopedTask.id);
	    assert.equal(apiCurrentStepReady.current.next.key, 'review_chat');
	    assert.equal(apiCurrentStepReady.after_current.selected_task_id, apiScopedTask.id);
	    assert.equal(apiCurrentStepReady.after_current.next.key, 'review_chat');
	    assert.equal(apiCurrentStepReady.after.current.next.key, 'review_chat');
	    assert.equal(apiCurrentStepReady.safety.read_only, false);
	    assert.equal(apiCurrentStepReady.safety.human_accept, false);

	    const apiCurrentStepReviewChat = await fetch(`${base}/api/tasks/current/step?owner=codex&goal_id=OBL-928`, {
	      method: 'POST',
	      headers: { 'content-type': 'application/json' },
	      body: JSON.stringify({ reviewer: 'codex-review' }),
	    }).then(r => r.json());
	    assert.equal(apiCurrentStepReviewChat.ok, true);
	    assert.equal(apiCurrentStepReviewChat.step.step_action, 'review_chat');
	    assert.equal(apiCurrentStepReviewChat.step.contract.schema, 'atris.task_review_chat.v1');
	    assert.match(apiCurrentStepReviewChat.step.contract.codex_prompt, /\/codex review/);
	    assert.equal(apiCurrentStepReviewChat.page.review.human_accept.enabled, true);
	    assert.equal(apiCurrentStepReviewChat.safety.human_accept, false);

	    const apiOtherReviewAdd = runCli([
	      'task', 'add', 'API other owner review stays untouched',
	      '--tag', 'api-scope',
	      '--goal-id', 'OBL-930',
	      '--json',
	    ], { cwd: dir, env });
	    assert.equal(apiOtherReviewAdd.status, 0, apiOtherReviewAdd.stderr);
	    const apiOtherReviewTask = JSON.parse(apiOtherReviewAdd.stdout).task;
	    assert.equal(runCli(['task', 'claim', apiOtherReviewTask.display_id, '--as', 'alice'], { cwd: dir, env }).status, 0);
	    assert.equal(runCli([
	      'task', 'ready', apiOtherReviewTask.display_id,
	      '--as', 'alice',
	      '--proof', 'node --test test/commands.test.js passed before API other owner review',
	    ], { cwd: dir, env }).status, 0);
	    const apiOtherReviewStepResponse = await fetch(`${base}/api/tasks/current/step?goal_id=OBL-930`, {
	      method: 'POST',
	      headers: { 'content-type': 'application/json' },
	      body: JSON.stringify({ actor: 'codex', reviewer: 'codex-review' }),
	    });
	    assert.equal(apiOtherReviewStepResponse.status, 409);
	    const apiOtherReviewStep = await apiOtherReviewStepResponse.json();
	    assert.equal(apiOtherReviewStep.reason, 'claimed_by_other');
	    assert.equal(apiOtherReviewStep.current.selected_task_id, apiOtherReviewTask.id);
	    assert.equal(apiOtherReviewStep.current.selected_reason, 'review_needs_agent_verification');
	    const apiOtherReviewDetail = await fetch(`${base}/api/tasks/${apiOtherReviewTask.id}`).then(r => r.json());
	    assert.equal(apiOtherReviewDetail.task.status, 'review');
	    assert.equal(apiOtherReviewDetail.task.claimed_by, 'alice');
	    assert.equal(apiOtherReviewDetail.task.messages.some(m => m.content.includes('TASK_REVIEW_CHAT')), false);

	    const apiScopedDetailAfterCurrentStep = await fetch(`${base}/api/tasks/${apiScopedTask.id}`).then(r => r.json());
	    assert.equal(apiScopedDetailAfterCurrentStep.task.status, 'review');
	    assert.equal(apiScopedDetailAfterCurrentStep.task.review.approval_status, 'pending');
	    assert.ok(apiScopedDetailAfterCurrentStep.task.messages.some(m => m.content.includes('TASK_REVIEW_CHAT')));

	    const apiOwnerQueryAdd = runCli([
	      'task', 'add', 'API owner query current-step task',
	      '--tag', 'api-owner',
	      '--goal-id', 'OBL-929',
	      '--json',
	    ], { cwd: dir, env });
	    assert.equal(apiOwnerQueryAdd.status, 0, apiOwnerQueryAdd.stderr);
	    const apiOwnerQueryTask = JSON.parse(apiOwnerQueryAdd.stdout).task;
	    assert.equal(runCli([
	      'task', 'plan', apiOwnerQueryTask.display_id,
	      '--as', 'alice',
	      '--goal', 'API current-step honors query owner',
	      '--exit', 'owner query steps the owner current task',
	      '--proof-needed', 'node --test test/commands.test.js passes API current-step owner query coverage',
	    ], { cwd: dir, env }).status, 0);
	    assert.equal(runCli([
	      'task', 'do', apiOwnerQueryTask.display_id,
	      '--as', 'alice',
	      '--first-move', 'alice owns API current-step query work',
	    ], { cwd: dir, env }).status, 0);
	    const apiOwnerQueryCurrent = await fetch(`${base}/api/tasks/current?owner=alice&goal_id=OBL-929`).then(r => r.json());
	    assert.equal(apiOwnerQueryCurrent.ok, true);
	    assert.equal(apiOwnerQueryCurrent.current.owner, 'alice');
	    assert.equal(apiOwnerQueryCurrent.current.selected_reason, 'claimed_by_owner');
	    assert.equal(apiOwnerQueryCurrent.current.selected_task_id, apiOwnerQueryTask.id);
	    const apiOwnerQueryStep = await fetch(`${base}/api/tasks/current/step?owner=alice&goal_id=OBL-929`, {
	      method: 'POST',
	      headers: { 'content-type': 'application/json' },
	      body: JSON.stringify({
	        proof: 'node --test test/commands.test.js passed for API current-step owner query',
	        lesson: 'POST current-step uses the same query owner as GET current',
	      }),
	    }).then(r => r.json());
	    assert.equal(apiOwnerQueryStep.ok, true);
	    assert.equal(apiOwnerQueryStep.before_current.owner, 'alice');
	    assert.equal(apiOwnerQueryStep.before_current.selected_reason, 'claimed_by_owner');
	    assert.equal(apiOwnerQueryStep.before_current.selected_task_id, apiOwnerQueryTask.id);
	    assert.equal(apiOwnerQueryStep.step.step_action, 'ready');
	    assert.equal(apiOwnerQueryStep.step.task.id, apiOwnerQueryTask.id);
	    assert.equal(apiOwnerQueryStep.safety.human_accept, false);

	    const apiOwnerPrecedenceAliceAdd = runCli([
	      'task', 'add', 'API owner precedence Alice task',
	      '--tag', 'api-owner',
	      '--goal-id', 'OBL-931',
	      '--json',
	    ], { cwd: dir, env });
	    assert.equal(apiOwnerPrecedenceAliceAdd.status, 0, apiOwnerPrecedenceAliceAdd.stderr);
	    const apiOwnerPrecedenceAliceTask = JSON.parse(apiOwnerPrecedenceAliceAdd.stdout).task;
	    const apiOwnerPrecedenceCodexAdd = runCli([
	      'task', 'add', 'API owner precedence Codex task',
	      '--tag', 'api-owner',
	      '--goal-id', 'OBL-931',
	      '--json',
	    ], { cwd: dir, env });
	    assert.equal(apiOwnerPrecedenceCodexAdd.status, 0, apiOwnerPrecedenceCodexAdd.stderr);
	    const apiOwnerPrecedenceCodexTask = JSON.parse(apiOwnerPrecedenceCodexAdd.stdout).task;
	    assert.equal(runCli([
	      'task', 'plan', apiOwnerPrecedenceAliceTask.display_id,
	      '--as', 'alice',
	      '--goal', 'Alice owns the query-selected task',
	      '--exit', 'query owner cannot be overridden by body actor',
	      '--proof-needed', 'node --test test/commands.test.js passes API current-step owner precedence coverage',
	    ], { cwd: dir, env }).status, 0);
	    assert.equal(runCli([
	      'task', 'do', apiOwnerPrecedenceAliceTask.display_id,
	      '--as', 'alice',
	      '--first-move', 'alice owns the query-selected work',
	    ], { cwd: dir, env }).status, 0);
	    assert.equal(runCli([
	      'task', 'plan', apiOwnerPrecedenceCodexTask.display_id,
	      '--as', 'codex',
	      '--goal', 'Codex owns a different same-scope task',
	      '--exit', 'query owner still selects Alice',
	      '--proof-needed', 'node --test test/commands.test.js passes API current-step owner precedence coverage',
	    ], { cwd: dir, env }).status, 0);
	    assert.equal(runCli([
	      'task', 'do', apiOwnerPrecedenceCodexTask.display_id,
	      '--as', 'codex',
	      '--first-move', 'codex owns separate same-scope work',
	    ], { cwd: dir, env }).status, 0);
	    const apiOwnerPrecedenceCurrent = await fetch(`${base}/api/tasks/current?owner=alice&goal_id=OBL-931`).then(r => r.json());
	    assert.equal(apiOwnerPrecedenceCurrent.current.selected_task_id, apiOwnerPrecedenceAliceTask.id);
	    const apiOwnerPrecedenceResponse = await fetch(`${base}/api/tasks/current/step?owner=alice&goal_id=OBL-931`, {
	      method: 'POST',
	      headers: { 'content-type': 'application/json' },
	      body: JSON.stringify({
	        actor: 'codex',
	        proof: 'node --test test/commands.test.js passed for API current-step owner precedence',
	      }),
	    });
	    assert.equal(apiOwnerPrecedenceResponse.status, 409);
	    const apiOwnerPrecedenceStep = await apiOwnerPrecedenceResponse.json();
	    assert.equal(apiOwnerPrecedenceStep.reason, 'claimed_by_other');
	    assert.equal(apiOwnerPrecedenceStep.current.selected_task_id, apiOwnerPrecedenceAliceTask.id);
	    const apiOwnerPrecedenceCodexDetail = await fetch(`${base}/api/tasks/${apiOwnerPrecedenceCodexTask.id}`).then(r => r.json());
	    assert.equal(apiOwnerPrecedenceCodexDetail.task.status, 'claimed');

	    const apiUnplannedDo = await fetch(`${base}/api/tasks/${apiStageId}/do`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'codex', first_move: 'start too early' }),
    });
    assert.equal(apiUnplannedDo.status, 409);
    assert.equal((await apiUnplannedDo.json()).reason, 'goal_required');

    const apiInlineDo = await fetch(`${base}/api/tasks/${apiStageId}/do`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actor: 'codex',
        goal: 'Skip API plan',
        proof_needed: 'should still need a plan event',
        first_move: 'start too early',
      }),
    });
    assert.equal(apiInlineDo.status, 409);
    assert.equal((await apiInlineDo.json()).reason, 'plan_required');

    const apiPlan = await fetch(`${base}/api/tasks/${apiStageId}/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actor: 'codex',
        goal: 'Prove API Plan Do Review',
        summary: 'Use API stage endpoints before review',
        owner: 'codex',
        exit: 'ready endpoint receives specific proof',
        proof_needed: 'node --test command API stage coverage passes',
        first_move: 'call the do endpoint',
      }),
    }).then(r => r.json());
    assert.equal(apiPlan.ok, true);
    assert.equal(apiPlan.action, 'planned');
    assert.equal(apiPlan.task.metadata.stage, 'plan');
    assert.match(apiPlan.stage_packet, /stage: plan/);
    assert.match(apiPlan.stage_packet, /goal: Prove API Plan Do Review/);

    const apiExitRewriteDo = await fetch(`${base}/api/tasks/${apiStageId}/do`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actor: 'codex',
        exit: 'different API review boundary',
        first_move: 'start from rewritten API exit',
      }),
    });
    assert.equal(apiExitRewriteDo.status, 409);
    assert.equal((await apiExitRewriteDo.json()).reason, 'plan_exit_mismatch');

    const apiRewriteDo = await fetch(`${base}/api/tasks/${apiStageId}/do`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actor: 'codex',
        goal: 'Replace API plan',
        proof_needed: 'weaker API proof',
        first_move: 'start from rewritten API text',
      }),
    });
    assert.equal(apiRewriteDo.status, 409);
    assert.equal((await apiRewriteDo.json()).reason, 'plan_goal_mismatch');

    const apiDo = await fetch(`${base}/api/tasks/${apiStageId}/do`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'codex', first_move: 'run the API stage smoke' }),
    }).then(r => r.json());
    assert.equal(apiDo.ok, true);
    assert.equal(apiDo.action, 'doing');
    assert.equal(apiDo.task.status, 'claimed');
    assert.equal(apiDo.task.claimed_by, 'codex');
    assert.equal(apiDo.task.metadata.stage, 'do');
    assert.match(apiDo.stage_packet, /stage: do/);

    const apiBacklogTask = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Move API plan row back to backlog', tag: 'plan' }),
    }).then(r => r.json());
    assert.equal(apiBacklogTask.ok, true);
    const apiBacklogTaskId = apiBacklogTask.task_id;
    const apiBacklogPlan = await fetch(`${base}/api/tasks/${apiBacklogTaskId}/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actor: 'codex',
        goal: 'API backlog has a plan',
        exit: 'API backlog endpoint clears it',
        proof_needed: 'node --test API backlog coverage passes',
      }),
    }).then(r => r.json());
    assert.equal(apiBacklogPlan.ok, true);

    const apiBacklog = await fetch(`${base}/api/tasks/${apiBacklogTaskId}/backlog`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'codex', reason: 'operator changed priority', tag: 'feature' }),
    }).then(r => r.json());
    assert.equal(apiBacklog.ok, true);
    assert.equal(apiBacklog.action, 'backlogged');
    assert.equal(apiBacklog.task.tag, 'capture');
    assert.equal(apiBacklog.task.metadata.stage, undefined);
    assert.equal(apiBacklog.task.latest_event_type, 'task_backlogged');

    const apiBacklogDo = await fetch(`${base}/api/tasks/${apiBacklogTaskId}/do`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'codex', first_move: 'start after API backlog' }),
    });
    assert.equal(apiBacklogDo.status, 409);
    assert.equal((await apiBacklogDo.json()).reason, 'goal_required');

    const apiBulkA = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'API clear plan A', tag: 'feature' }),
    }).then(r => r.json());
    const apiBulkB = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'API clear plan B', tag: 'capture' }),
    }).then(r => r.json());
    assert.equal(apiBulkA.ok, true);
    assert.equal(apiBulkB.ok, true);
    for (const taskId of [apiBulkA.task_id, apiBulkB.task_id]) {
      const planned = await fetch(`${base}/api/tasks/${taskId}/plan`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          actor: 'codex',
          owner: 'codex',
          goal: `API bulk goal ${taskId}`,
          exit: `API bulk exit ${taskId}`,
          proof_needed: `API bulk proof ${taskId}`,
        }),
      }).then(r => r.json());
      assert.equal(planned.ok, true);
    }
    const apiClearMissingConfirm = await fetch(`${base}/api/tasks/clear-plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'codex' }),
    });
    assert.equal(apiClearMissingConfirm.status, 400);
    assert.equal((await apiClearMissingConfirm.json()).reason, 'confirm_required');

    const apiClearPlan = await fetch(`${base}/api/tasks/clear-plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'codex', confirm: true, reason: 'operator cleared Plan' }),
    }).then(r => r.json());
    assert.equal(apiClearPlan.ok, true);
    assert.equal(apiClearPlan.action, 'clear_plan');
    assert.equal(apiClearPlan.cleared_count, 2);
    assert.deepEqual(apiClearPlan.tasks.map(task => task.id).sort(), [apiBulkA.task_id, apiBulkB.task_id].sort());
    assert.ok(apiClearPlan.tasks.every(task => task.tag === 'capture'));

    const missingReadyProofResponse = await fetch(`${base}/api/tasks/${apiReviewId}/ready`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'codex' }),
    });
    assert.equal(missingReadyProofResponse.status, 400);
    const missingReadyProof = await missingReadyProofResponse.json();
    assert.equal(missingReadyProof.reason, 'proof_required');

    const weakReadyProofResponse = await fetch(`${base}/api/tasks/${apiReviewId}/ready`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'codex', proof: 'done' }),
    });
    assert.equal(weakReadyProofResponse.status, 400);
    const weakReadyProof = await weakReadyProofResponse.json();
    assert.equal(weakReadyProof.reason, 'weak_proof');

    const apiReady = await fetch(`${base}/api/tasks/${apiReviewId}/ready`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'codex', proof: 'node --test test/commands.test.js passed before revise' }),
    }).then(r => r.json());
    assert.equal(apiReady.ok, true);

    const prematureApiFinishResponse = await fetch(`${base}/api/tasks/${apiReviewId}/finish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'codex', proof: 'node --test test/commands.test.js passed while blocked in review' }),
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
        proof: 'node --test test/commands.test.js passed after API ready',
        lesson: 'API accept keeps the ready lesson',
        next: 'Create the API follow-up task',
      }),
    }).then(r => r.json());
    assert.equal(freshApiReady.ok, true);

    const apiDetail = await fetch(`${base}/api/tasks/${apiReviewId}`).then(r => r.json());
    assert.equal(apiDetail.ok, true);
    assert.equal(apiDetail.action, 'detail');
    assert.equal(apiDetail.task.id, apiReviewId);
    assert.equal(apiDetail.task.review.verification_chat.schema, 'atris.task_review_chat.v1');
    assert.match(apiDetail.task.review.verification_chat.command, /atris task review-chat /);
    assert.match(apiDetail.task.review.verification_chat.codex_prompt, /\/codex review/);
    assert.equal(apiDetail.page.schema, 'atris.task_page.v1');
    assert.equal(apiDetail.page.stage.current, 'review');
    assert.equal(apiDetail.page.stage.next_action.key, 'review_chat');
    assert.equal(apiDetail.page.review.human_accept.enabled, true);
    assert.notEqual(apiDetail.page.stage.next_action.command, apiDetail.page.review.human_accept.command);

    const apiPage = await fetch(`${base}/api/tasks/${apiReviewId}/page`).then(r => r.json());
    assert.equal(apiPage.ok, true);
    assert.equal(apiPage.action, 'page');
    assert.equal(apiPage.page.task.id, apiReviewId);
    assert.equal(apiPage.page.review.verification_chat.schema, 'atris.task_review_chat.v1');
    assert.equal(apiPage.page.chat.can_chat, true);

    const apiReviewChat = await fetch(`${base}/api/tasks/${apiReviewId}/review-chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'codex-review' }),
    }).then(r => r.json());
    assert.equal(apiReviewChat.ok, true);
    assert.equal(apiReviewChat.action, 'review_chat');
    assert.equal(apiReviewChat.appended, true);
    assert.ok(apiReviewChat.version);
    assert.equal(apiReviewChat.contract.schema, 'atris.task_review_chat.v1');
    assert.match(apiReviewChat.contract.codex_prompt, /\/codex review/);
    assert.match(apiReviewChat.contract.codex_prompt, /Reject stale API proof after revise/);
    assert.match(apiReviewChat.contract.pass_command, /atris task review /);
    assert.equal(apiReviewChat.contract.verification_focus.proof_claim, 'node --test test/commands.test.js passed after API ready');
    assert.ok(apiReviewChat.contract.verification_focus.commands_to_verify.some(command => command.includes('node --test test/commands.test.js')));
    assert.ok(apiReviewChat.contract.verification_focus.files_to_inspect.includes('test/commands.test.js'));
    assert.match(apiReviewChat.contract.required_checks.join('\n'), /Re-run or inspect these proof commands/);
    assert.match(apiReviewChat.contract.required_checks.join('\n'), /Inspect these named files\/artifacts/);
    assert.ok(apiReviewChat.task.messages.some(m => m.content.includes('TASK_REVIEW_CHAT')));

    const apiDetailAfterReviewChat = await fetch(`${base}/api/tasks/${apiReviewId}`).then(r => r.json());
    assert.equal(apiDetailAfterReviewChat.ok, true);
    assert.ok(apiDetailAfterReviewChat.task.messages.some(m => m.content.includes('TASK_REVIEW_CHAT')));

    const apiDefaultReviewTask = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'API default review is verifier-only', tag: 'factory' }),
    }).then(r => r.json());
    assert.equal(apiDefaultReviewTask.ok, true);
    const apiDefaultReviewId = apiDefaultReviewTask.task_id;
    const apiDefaultReady = await fetch(`${base}/api/tasks/${apiDefaultReviewId}/ready`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actor: 'codex',
        proof: 'node --test test/commands.test.js passed before default API review',
      }),
    }).then(r => r.json());
    assert.equal(apiDefaultReady.ok, true);
    const apiDefaultReview = await fetch(`${base}/api/tasks/${apiDefaultReviewId}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actor: 'validator',
        proof: 'node --test test/commands.test.js passed during default API review',
      }),
    }).then(r => r.json());
    assert.equal(apiDefaultReview.ok, true);
    assert.equal(apiDefaultReview.episode.reward.value, 0);
    const apiDefaultDetail = await fetch(`${base}/api/tasks/${apiDefaultReviewId}`).then(r => r.json());
    assert.equal(apiDefaultDetail.task.review.approval_status, 'pending');
    assert.equal(apiDefaultDetail.task.review.agent_review_pass_count, 2);
    assert.equal(apiDefaultDetail.task.review.agent_certified, true);
    assert.equal(apiDefaultDetail.task.review.verification_chat, undefined);
    assert.equal(apiDefaultDetail.page.stage.next_action.key, 'human_accept_waiting');
    assert.equal(apiDefaultDetail.page.stage.next_action.command, null);
    assert.equal(apiDefaultDetail.page.review.verification_chat.schema, 'atris.task_review_chat.v1');
    assert.match(apiDefaultDetail.page.actions.review_chat_command, /atris task review-chat /);
    assert.equal(apiDefaultDetail.page.review.human_accept.enabled, true);

    const apiCertifiedReviewChatResponse = await fetch(`${base}/api/tasks/${apiDefaultReviewId}/review-chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'codex-review' }),
    });
    assert.equal(apiCertifiedReviewChatResponse.status, 200);
    const apiCertifiedReviewChat = await apiCertifiedReviewChatResponse.json();
    assert.equal(apiCertifiedReviewChat.ok, true);
    assert.equal(apiCertifiedReviewChat.action, 'review_chat');
    assert.equal(apiCertifiedReviewChat.contract.review.agent_certified, true);

    const weakApiAcceptResponse = await fetch(`${base}/api/tasks/${apiReviewId}/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'operator', proof: 'done' }),
    });
    assert.equal(weakApiAcceptResponse.status, 400);
    const weakApiAccept = await weakApiAcceptResponse.json();
    assert.equal(weakApiAccept.reason, 'weak_proof');

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
    assert.equal(freshApiAccept.episode.proof, 'node --test test/commands.test.js passed after API ready');
    assert.equal(freshApiAccept.episode.lesson, 'API accept keeps the ready lesson');
    assert.equal(freshApiAccept.episode.next_task_suggestion, 'Create the API follow-up task');
    assert.ok(freshApiAccept.next_task_id);

    const apiReviewGate = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Reject weak API review proof', tag: 'factory' }),
    }).then(r => r.json());
    assert.equal(apiReviewGate.ok, true);
    const weakReviewProofResponse = await fetch(`${base}/api/tasks/${apiReviewGate.task_id}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'validator', reward: 1, proof: 'done' }),
    });
    assert.equal(weakReviewProofResponse.status, 400);
    const weakReviewProof = await weakReviewProofResponse.json();
    assert.equal(weakReviewProof.reason, 'weak_proof');

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
        proof: 'node --test test/commands.test.js passed for clear review',
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
    assert.equal(omittedApiReview.task.review.proof, 'node --test test/commands.test.js passed for clear review');
    assert.equal(omittedApiReview.task.review.lesson, 'stale ready lesson');
    assert.equal(omittedApiReview.task.review.next_task, 'stale ready next');

    const clearAccept = await fetch(`${base}/api/tasks/${clearReviewId}/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'operator', lesson: '', next: '' }),
    }).then(r => r.json());
    assert.equal(clearAccept.ok, true);
    assert.equal(clearAccept.episode.proof, 'node --test test/commands.test.js passed for clear review');
    assert.equal(clearAccept.episode.lesson, '');
    assert.equal(clearAccept.episode.next_task_suggestion, null);
    assert.equal(clearAccept.task.review.proof, 'node --test test/commands.test.js passed for clear review');
    assert.equal(clearAccept.task.review.lesson, null);
    assert.equal(clearAccept.task.review.next_task, null);

    const scopedApiCreateNext = runCli([
      'task', 'add', 'Scoped API create-next parent',
      '--tag', 'factory',
      '--goal-id', 'OBL-932',
      '--json',
    ], { cwd: dir, env });
    assert.equal(scopedApiCreateNext.status, 0, scopedApiCreateNext.stderr);
    const scopedApiParent = JSON.parse(scopedApiCreateNext.stdout).task;
    const scopedApiReady = await fetch(`${base}/api/tasks/${scopedApiParent.id}/ready`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actor: 'codex',
        proof: 'node --test test/commands.test.js passed for scoped API createNext',
        next: 'Scoped API follow-up task',
      }),
    }).then(r => r.json());
    assert.equal(scopedApiReady.ok, true);
    const scopedApiAccept = await fetch(`${base}/api/tasks/${scopedApiParent.id}/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'operator', createNext: true }),
    }).then(r => r.json());
    assert.equal(scopedApiAccept.ok, true);
    assert.ok(scopedApiAccept.next_task_id);

    const listed = await fetch(`${base}/api/tasks`).then(r => r.json());
    assert.equal(listed.ok, true);
    assert.ok(listed.projection.tasks.some(t => t.id === finished.next_task_id && t.title === 'Connect the board to Swarlo leases'));
    assert.ok(listed.projection.tasks.some(t => t.id === freshApiAccept.next_task_id && t.title === 'Create the API follow-up task'));
    assert.ok(listed.projection.tasks.some(t => t.id === scopedApiAccept.next_task_id
      && t.title === 'Scoped API follow-up task'
      && t.metadata.goal_id === 'OBL-932'
      && t.lineage.parent_task_id === scopedApiParent.id));
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

    const ready = runCli(['task', 'ready', id, '--proof', 'dry-run sync validation passed', '--as', 'codex', '--json'], { cwd: dir, env });
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
    assert.match(payload.plan[0].body.description, /Proof: dry-run sync validation passed/);
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
      '--proof', 'board lineage validation passed',
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
    assert.equal(parent.review.summary, 'Completed result for improve task factory lineage view.');
    assert.equal(parent.review.proof, 'board lineage validation passed');
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
    ['fast', '--help'],
    ['ax', 'fast', '--help'],
    ['search', '--help'],
    ['search', '-h'],
    ['learn', '--help'],
    ['learn', '-h'],
    ['learn', 'help'],
    ['soul', '--help'],
    ['soul', '-h'],
    ['soul', 'help'],
    ['activate', '--help'],
    ['launchpad', '--help'],
    ['next', '--help'],
    ['now', '--help'],
    ['radar', '--help'],
    ['ctop', '--help'],
    ['clean', '--help'],
    ['verify', '--help'],
    ['loop', '--help'],
    ['pulse', '--help'],
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

test('launchpad --json picks the current actor claimed task first', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'brain'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), [
      '# TODO',
      '',
      '## Endgame',
      '',
      '**Slug:** runner-swap-safe',
      '**Horizon:** runner swaps should be config-only',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'brain', 'STATUS.md'), [
      '# Atris Brain Status',
      '',
      '## Next Move',
      '',
      'Pick the highest-leverage open TODO item.',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'tasks.projection.json'), JSON.stringify({
      schema: 'atris.task_projection.v1',
      surface: { hidden_done_count: 7 },
      tasks: [
        {
          id: 'task-codex',
          display_id: 'CLI-9',
          title: 'Ship launchpad',
          status: 'claimed',
          claimed_by: 'codex',
          updated_at: 30,
          metadata: {},
        },
        {
          id: 'task-review',
          display_id: 'CLI-8',
          title: 'Check finished work',
          status: 'review',
          claimed_by: 'claude',
          updated_at: 20,
          metadata: { agent_review_pass_count: 1 },
          review: { agent_review_pass_count: 1 },
        },
      ],
    }, null, 2), 'utf8');
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'missions.jsonl'), `${JSON.stringify({
      id: 'mission-live',
      objective: 'Keep loop alive',
      status: 'running',
      verifier: 'npm test',
    })}\n`, 'utf8');

    const res = runCli(['launchpad', '--json', '--as', 'codex'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.schema, 'atris.launchpad.v1');
    assert.equal(payload.next_action.kind, 'continue_claimed_task');
    assert.equal(payload.next_action.command, 'atris task step CLI-9');
    assert.equal(payload.counts.review_needs_agent, 1);
    assert.equal(payload.counts.missions_need_tick, 1);
    assert.deepEqual(payload.suggestions.map(item => item.title), [
      'Finish current work',
      'Run the paused live job',
      'Check a finished change',
    ]);
    assert.equal(payload.suggestions[0].subject, 'Ship launchpad');
    assert.equal(payload.suggestions[0].ref, 'CLI-9');
  } finally {
    cleanupTempDir(dir);
  }
});

test('launchpad --json reports clean review queue and endgame seed action', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'brain'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), [
      '# TODO',
      '',
      '## Endgame',
      '',
      '**Slug:** autopilot-runner-agnostic',
      '**Horizon:** runner swaps should be config-only',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'brain', 'STATUS.md'), '# Status\n\n## Next Move\n\nSeed work.\n', 'utf8');
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'tasks.projection.json'), JSON.stringify({
      schema: 'atris.task_projection.v1',
      tasks: [],
    }, null, 2), 'utf8');

    const res = runCli(['launchpad', '--json', '--as', 'codex'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.counts.open, 0);
    assert.equal(payload.counts.review, 0);
    assert.equal(payload.counts.review_needs_agent, 0);
    assert.equal(payload.counts.review_certified, 0);
    assert.equal(payload.next_action.kind, 'seed_endgame_task');
    assert.equal(payload.next_action.command, 'atris task next --create-next');
    assert.equal(payload.next_action.endgame.slug, 'autopilot-runner-agnostic');
  } finally {
    cleanupTempDir(dir);
  }
});

test('launchpad chooses a verifier mission when there is no owned claimed task', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'brain'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), '# TODO\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'brain', 'STATUS.md'), '# Status\n\n## Next Move\n\nSeed work.\n', 'utf8');
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'tasks.projection.json'), JSON.stringify({
      schema: 'atris.task_projection.v1',
      tasks: [
        {
          id: 'task-review',
          display_id: 'CLI-10',
          title: 'Check finished work',
          status: 'review',
          claimed_by: 'claude',
          updated_at: 20,
          metadata: { agent_review_pass_count: 1 },
          review: { agent_review_pass_count: 1 },
        },
      ],
    }, null, 2), 'utf8');
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'missions.jsonl'), `${JSON.stringify({
      id: 'mission-verify',
      objective: 'Ship one checked loop',
      status: 'ready',
      verifier: 'node --test',
    })}\n`, 'utf8');

    const res = runCli(['launchpad', '--as', 'codex'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /Live job waiting on a check/);
    assert.match(res.stdout, /Ship one checked loop/);
    assert.match(res.stdout, /RUN THIS\n\s+atris mission tick mission-verify --verify --complete-on-pass/);
    assert.match(res.stdout, /WHAT HAPPENED\n\s+Ship one checked loop/);
    assert.match(res.stdout, /WHAT TO WORK ON NEXT\n\s+1\. Run the paused live job/);
    assert.match(res.stdout, /2\. Check a finished change/);
    assert.match(res.stdout, /An always-on job is paused until its check runs\./);
    assert.doesNotMatch(res.stdout, /proof|review-chat|agent review/i);
  } finally {
    cleanupTempDir(dir);
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
    assert.ok(payload.binaries.some((binary) => binary.name === 'droid'));
  } finally {
    cleanupTempDir(dir);
  }
});

test('agent help hides internal dogfood diagnostic', () => {
  const res = runCli(['agent', '--help']);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.doesNotMatch(res.stdout, /dogfood/);
  assert.match(res.stdout, /Usage: atris agent \[doctor\|spawn\|spawns\|spawn-status\]/);
});

test('agent dogfood is gated from public CLI', () => {
  const res = runCli(['agent', 'dogfood', '--help']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /internal diagnostic/);
  assert.match(res.stderr, /atris agent doctor/);
});

test('agent dogfood help is available only behind internal gate', () => {
  const res = runCli(['agent', 'dogfood', '--help'], {
    env: { ...process.env, ATRIS_INTERNAL_AGENT_DOGFOOD: '1' },
  });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.match(res.stdout, /Internal usage: atris agent dogfood/);
});

test('agent spawn creates a durable worker request without auth', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const res = runCli(['agent', 'spawn', 'worker', '--task', 'Fix one bounded bug', '--engine', 'codex', '--json'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.action, 'spawn_created');
    assert.equal(payload.request.role, 'worker');
    assert.equal(payload.request.task, 'Fix one bounded bug');
    assert.equal(payload.request.engine, 'codex');
    assert.match(payload.request.command, /^codex exec /);

    const list = runCli(['agent', 'spawns', '--json'], { cwd: dir });
    assert.equal(list.status, 0, list.stderr || list.stdout);
    assert.equal(JSON.parse(list.stdout).requests.length, 1);
  } finally {
    cleanupTempDir(dir);
  }
});

test('business slug matcher accepts config aliases', () => {
  const business = {
    slug: 'acme',
    name: 'Acme Co',
    config: { aliases: ['atris'] },
  };

  assert.equal(businessMatchesSlug(business, 'acme'), true);
  assert.equal(businessMatchesSlug(business, 'atris'), true);
  assert.equal(businessMatchesSlug(business, 'Acme Co'), false);
  assert.equal(businessMatchesSlug(business, 'Acme Co', { includeName: true }), true);
});

test('business doctor plans safe cache repoints for stale duplicate rows', () => {
  const active = {
    id: 'active-example',
    slug: 'example-customer-ops',
    name: 'example-customer-ops',
    workspace_id: 'active-workspace',
    config: {},
  };
  const analysis = analyzeBusinessDoctor({
    cloudBusinesses: [active],
    cache: {
      'example-customer-ops': {
        business_id: 'deleted-duplicate',
        workspace_id: 'deleted-workspace',
        name: 'example-customer-ops',
        slug: 'example-customer-ops-1',
      },
    },
    folderBindings: [],
  });

  assert.ok(analysis.issues.some((issue) => issue.code === 'stale-cache-repoint'));
  assert.equal(analysis.cacheUpdates['example-customer-ops'].business_id, 'active-example');
  assert.equal(analysis.cacheUpdates['example-customer-ops'].workspace_id, 'active-workspace');
  assert.equal(analysis.cacheUpdates['example-customer-ops'].slug, 'example-customer-ops');
});

test('business doctor accepts clean alias folders and asks for missing alias cache', () => {
  const atrisLabs = {
    id: 'biz-acme',
    slug: 'acme',
    name: 'Acme Co',
    workspace_id: 'workspace-acme',
    config: { aliases: ['atris'] },
  };
  const analysis = analyzeBusinessDoctor({
    cloudBusinesses: [atrisLabs],
    cache: {
      'acme': {
        business_id: 'biz-acme',
        workspace_id: 'workspace-acme',
        name: 'Acme Co',
        slug: 'acme',
      },
    },
    folderBindings: [{
      name: 'atris',
      isSymlink: false,
      hasAtris: true,
      hasBusinessJson: true,
      meta: {
        business_id: 'biz-acme',
        workspace_id: 'workspace-acme',
        name: 'Acme Co',
        slug: 'atris',
        canonical_slug: 'acme',
      },
    }],
  });

  assert.equal(analysis.issues.some((issue) => issue.code === 'folder-name-not-slug-or-alias'), false);
  assert.equal(analysis.issues.some((issue) => issue.code === 'folder-slug-mismatch'), false);
  assert.equal(analysis.cacheUpdates.atris.business_id, 'biz-acme');
  assert.equal(analysis.cacheUpdates.atris.canonical_slug, 'acme');
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

test('clean --json reports missing atris folder without text chrome', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['clean', '--json'], { cwd: dir });
    assert.equal(res.status, 1);
    assert.doesNotMatch(res.stdout, /Atris Clean/);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.action, 'clean');
    assert.match(payload.error, /atris\/ folder not found/);
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
    assert.match(res.stdout, /--json/);
    assert.doesNotMatch(res.stdout, /Atris Clean/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('clean --dry-run --json reports machine-readable health', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    const res = runCli(['clean', '--dry-run', '--json'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.doesNotMatch(res.stdout, /Atris Clean/);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.action, 'clean');
    assert.equal(payload.dry_run, true);
    assert.equal(payload.results.stale_tasks.count, 0);
    assert.equal(typeof payload.results.map_refs.healed_count, 'number');
    assert.equal(payload.results.map_refs.verb, 'would_heal');
    assert.equal(Array.isArray(payload.results.map_refs.items), true);
    assert.equal(typeof payload.results.stale_pages.count, 'number');
    assert.equal(Array.isArray(payload.results.stale_pages.items), true);
    assert.equal(Array.isArray(payload.manual_action), true);
  } finally {
    cleanupTempDir(dir);
  }
});

test('clean dry-run shows MAP refs it would heal', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'app.js'), [
      'function main() {',
      '  return true;',
      '}',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'MAP.md'), [
      '# MAP.md',
      '',
      '- `src/app.js:20` (main function)',
      '',
    ].join('\n'), 'utf8');

    const res = runCli(['clean', '--dry-run', '--json'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.results.map_refs.healed_count, 1);
    assert.deepEqual(payload.results.map_refs.items, [
      {
        old: '`src/app.js:20`',
        new: '`src/app.js:1`',
        symbol: 'main',
      },
    ]);
    assert.match(fs.readFileSync(path.join(dir, 'atris', 'MAP.md'), 'utf8'), /src\/app\.js:20/);

    const text = runCli(['clean', '--dry-run'], { cwd: dir });
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /Would heal 1 MAP\.md reference/);
    assert.match(text.stdout, /`src\/app\.js:20` -> `src\/app\.js:1` \(main\)/);
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
    const res = runCli(['update'], { cwd: dir });
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
    assert.doesNotMatch(res.stdout, /Checking for updates|Installing update|npm install -g atris@latest/);
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
	    assert.match(res.stdout, /atris loop wiki/);
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
    fs.writeFileSync(path.join(dir, 'EXAMPLE_NOTES.md'), '# raw notes\n', 'utf8');

    const result = createCanonicalBusinessWorkspace(dir, {
      business_id: 'biz-123',
      workspace_id: 'ws-456',
      name: 'Example Co',
      slug: 'example-co',
      owner_email: 'operator@example.com',
    }, { here: true });

    assert.equal(result.targetRoot, dir);
    assert.ok(fs.existsSync(path.join(dir, 'EXAMPLE_NOTES.md')));
    assert.ok(fs.existsSync(path.join(dir, '.atris', 'business.json')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'MAP.md')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'TODO.md')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'goals.md')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'PERSONA.md')));
    assert.ok(fs.existsSync(path.join(dir, 'AGENTS.md')));
    assert.ok(fs.existsSync(path.join(dir, 'CLAUDE.md')));
    assert.ok(fs.existsSync(path.join(dir, 'GEMINI.md')));
    assert.ok(fs.readdirSync(path.join(dir, 'atris')).includes('PERSONA.md'));
    assert.equal(fs.readdirSync(path.join(dir, 'atris')).includes('persona.md'), false);
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'policies', 'REWARD.md')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'context', 'live-workspace.md')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'wiki', 'STATUS.md')));
    assert.ok(fs.existsSync(path.join(dir, '.atris', 'state', '_sync.json')));
    assert.ok(fs.existsSync(path.join(dir, '.atris', 'state', 'runtime.json')));
    assert.ok(fs.existsSync(path.join(dir, '.atris', 'state', 'events.jsonl')));
    assert.ok(fs.existsSync(path.join(dir, '.atris', 'state', 'episodes.jsonl')));
    assert.ok(fs.existsSync(path.join(dir, '.atris', 'state', 'scorecards.jsonl')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'reports', 'operating-recap-template.md')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'wiki', 'concepts', 'first-loop-template.md')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'team', 'START_HERE.md')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'team', '_template', 'MEMBER.md')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'team', 'operator', 'MEMBER.md')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'team', 'validator', 'MEMBER.md')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'team', 'ops', 'MEMBER.md')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'team', 'comms', 'MEMBER.md')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'team', 'research', 'MEMBER.md')));

    const meta = JSON.parse(fs.readFileSync(path.join(dir, '.atris', 'business.json'), 'utf8'));
    assert.equal(meta.slug, 'example-co');
    assert.equal(meta.business_id, 'biz-123');
    assert.equal(meta.workspace_id, 'ws-456');
    assert.equal(meta.workspace_template, 'business');
    assert.equal(meta.owner_email, 'operator@example.com');

    const syncMeta = JSON.parse(fs.readFileSync(path.join(dir, '.atris', 'state', '_sync.json'), 'utf8'));
    assert.equal(syncMeta.workspace_slug, 'example-co');
    assert.equal(syncMeta.business_id, 'biz-123');
    assert.equal(syncMeta.workspace_id, 'ws-456');
    assert.equal(syncMeta.workspace_template, 'business');

    const runtime = JSON.parse(fs.readFileSync(path.join(dir, '.atris', 'state', 'runtime.json'), 'utf8'));
    assert.equal(runtime.schema, 'atris.runtime.v1');
    assert.equal(runtime.scope, 'local-business-computer');
    assert.equal(runtime.install_status, 'local_cli_present');
    assert.equal(runtime.sync_status, 'templates_seeded');
    assert.deepEqual(runtime.agent_adapters, ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md']);

    const rootAgents = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
    assert.match(rootAgents, /Example Co Atris Workspace/);
    assert.match(rootAgents, /atris business start/);
    assert.match(rootAgents, /atris radar/);
    assert.match(rootAgents, /atris task next/);
    assert.match(rootAgents, /atris member activate operator/);
    assert.match(rootAgents, /atris mission start "Run the first useful loop for Example Co"/);
    assert.match(rootAgents, /atris do/);
    assert.match(rootAgents, /atris task ready <id> --proof/);
    assert.match(rootAgents, /Do not run `atris task accept` or claim XP unless a human approved the proof/);
    assert.match(rootAgents, /atris business share --write/);
    assert.match(rootAgents, /atris sync --dry-run/);
    assert.match(rootAgents, /atris sync --watch/);

    const map = fs.readFileSync(path.join(dir, 'atris', 'MAP.md'), 'utf8');
    assert.match(map, /Example Co/);
    assert.match(map, /\.atris\/state\/events\.jsonl/);
    assert.match(map, /atris\/team\/START_HERE\.md/);

    const teamStart = fs.readFileSync(path.join(dir, 'atris', 'team', 'START_HERE.md'), 'utf8');
    assert.match(teamStart, /Run `atris radar`/);
    assert.match(teamStart, /Claim the seeded first task with `atris task next`/);
    assert.match(teamStart, /Wake `operator` with `atris member activate operator`/);
    assert.match(teamStart, /atris mission start "Run the first useful loop for this business"/);
    assert.match(teamStart, /atris member goal-from-mission operator/);
    assert.match(teamStart, /Execute the loop with `atris do`/);
    assert.match(teamStart, /Ask `validator` to check proof/);
    assert.match(teamStart, /atris sync --dry-run/);
    assert.match(teamStart, /atris sync --watch/);

    const persona = fs.readFileSync(path.join(dir, 'atris', 'PERSONA.md'), 'utf8');
    assert.match(persona, /Example Co/);

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

test('business workspace scaffold preserves existing root agent adapter files', () => {
  const dir = makeTempDir();
  try {
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Custom Agent Rules\n', 'utf8');

    const result = createCanonicalBusinessWorkspace(dir, {
      business_id: 'biz-preserve',
      workspace_id: 'ws-preserve',
      name: 'Preserve Co',
      slug: 'preserve-co',
      owner_email: 'team@preserve.co',
    }, { here: true });

    assert.deepEqual(result.agentAdapters, ['CLAUDE.md', 'GEMINI.md']);
    assert.equal(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), '# Custom Agent Rules\n');
    assert.match(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), /Preserve Co Atris Workspace/);
    assert.match(fs.readFileSync(path.join(dir, 'GEMINI.md'), 'utf8'), /atris task next/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('business sync repairs missing root agent adapters without overwriting custom ones', () => {
  const dir = makeTempDir();
  try {
    createCanonicalBusinessWorkspace(dir, {
      business_id: 'biz-repair',
      workspace_id: 'ws-repair',
      name: 'Repair Co',
      slug: 'repair-co',
      owner_email: 'team@repair.co',
    }, { here: true });

    fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Custom Agent Rules\n', 'utf8');
    fs.rmSync(path.join(dir, 'CLAUDE.md'), { force: true });
    fs.rmSync(path.join(dir, 'GEMINI.md'), { force: true });

    const beforeCustom = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
    const res = runCli(['update'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.equal(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), beforeCustom);
    assert.match(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), /Repair Co Atris Workspace/);
    assert.match(fs.readFileSync(path.join(dir, 'GEMINI.md'), 'utf8'), /atris mission status --status active --json/);
    assert.match(res.stdout, /Root agent adapters:/);
    assert.match(res.stdout, /\+ CLAUDE\.md/);
    assert.match(res.stdout, /\+ GEMINI\.md/);

    const state = collectBusinessShareState(dir);
    assert.deepEqual(state.missingRootAgentAdapters, []);
    assert.equal(state.missing.includes('root agent adapters'), false);
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
    assert.match(res.stdout, /start\s+Check a received business workspace/);
    assert.match(res.stdout, /business environment/i);
    assert.doesNotMatch(res.stdout, /canonical business workspace/i);
  } finally {
    cleanupTempDir(dir);
  }
});

test('business quickstart includes the full first-loop operating path', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['business', 'quickstart'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Start a Business With An Operating Loop/);
    assert.match(res.stdout, /atris business start/);
    assert.match(res.stdout, /atris radar/);
    assert.match(res.stdout, /atris task next/);
    assert.match(res.stdout, /atris member activate operator/);
    assert.match(res.stdout, /atris mission status --status active --json/);
    assert.match(res.stdout, /atris mission start "Run the first useful loop for My Company"/);
    assert.match(res.stdout, /atris member goal-from-mission operator/);
    assert.match(res.stdout, /atris business onboard --website https:\/\/example\.com --contact "Founder Name" --note "what they do"/);
    assert.match(res.stdout, /atris do/);
    assert.match(res.stdout, /atris business record atris\/reports\/YYYY-MM-DD-your-recap\.md --outcome mixed --metric "operator speed"/);
    assert.match(res.stdout, /Write the handoff before sharing/);
    assert.match(res.stdout, /atris business share --write/);
    assert.match(res.stdout, /atris sync --dry-run/);
    assert.match(res.stdout, /atris sync --watch/);
    assert.match(res.stdout, /Repeat:[\s\S]*atris radar -> atris task next -> atris do -> record -> share/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('business init next steps include start task mission record share and sync', () => {
  const rendered = renderBusinessCreatedNextSteps({
    name: 'Loop Works',
    slug: 'loop-works',
  }, '/tmp/loop-works');

  assert.match(rendered, /seeded local computer \+ operator \+ validator/);
  assert.match(rendered, /cd \/tmp\/loop-works/);
  assert.match(rendered, /atris business start/);
  assert.match(rendered, /atris radar/);
  assert.match(rendered, /atris task next/);
  assert.match(rendered, /atris member activate operator/);
  assert.match(rendered, /atris mission status --status active --json/);
  assert.match(rendered, /atris mission start "Run the first useful loop for Loop Works"/);
  assert.match(rendered, /atris member goal-from-mission operator/);
  assert.match(rendered, /atris business onboard --website <url> --contact "Name" --note "what they do"/);
  assert.match(rendered, /atris business record atris\/reports\/<recap>\.md --outcome mixed --metric "operator speed"/);
  assert.match(rendered, /atris business share --write/);
  assert.match(rendered, /atris sync --dry-run/);
  assert.match(rendered, /atris sync/);
});

test('fresh business environment starter exposes an endgame task with explicit verify', async () => {
  const dir = makeTempDir();
  try {
    createCanonicalBusinessWorkspace(dir, {
      business_id: 'biz-123',
      workspace_id: 'ws-456',
      name: 'Example Co',
      slug: 'example-co',
      owner_email: 'operator@example.com',
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
      name: 'Example Co',
      slug: 'example-co',
      owner_email: 'operator@example.com',
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
    assert.equal(events[0].business_slug, 'example-co');
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
    assert.match(fs.readFileSync(cheatSheetPath, 'utf8'), /atris business share --write/);
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
    const projection = JSON.parse(fs.readFileSync(path.join(dir, '.atris', 'state', 'tasks.projection.json'), 'utf8'));
    assert.ok(projection.tasks.some(task =>
      task.title.includes('Draft a founder-context note')
      && task.status === 'open'
      && task.tag === 'execute'
      && task.metadata?.source === 'business_onboard'
    ));
    const next = runCli(['task', 'next', '--json'], { cwd: dir });
    assert.equal(next.status, 0, next.stderr);
    const nextPayload = JSON.parse(next.stdout);
    assert.match(nextPayload.task.title, /Draft a founder-context note/);
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

test('business share prints and writes a collaborator handoff from workspace state', async () => {
  const dir = makeTempDir();
  try {
    createCanonicalBusinessWorkspace(dir, {
      business_id: 'biz-share',
      workspace_id: 'ws-share',
      name: 'Share Co',
      slug: 'share-co',
      owner_email: 'team@share.co',
      workspace_template: 'business',
    }, { here: true });

    const prevCwd = process.cwd();
    process.chdir(dir);
    try {
      await onboardBusiness(
        '--website', 'https://share.co',
        '--contact', 'Sam Share',
        '--email', 'sam@share.co',
        '--note', 'Needs a clean collaborator handoff'
      );
      fs.writeFileSync(path.join(dir, 'atris', 'reports', 'first-recap.md'), '# First Recap\n\nUseful loop happened.\n', 'utf8');
      await recordBusinessRun('atris/reports/first-recap.md', '--outcome', 'positive', '--metric', 'first loop');
      seedBusinessOsState(dir);
      await shareBusinessWorkspace('--role', 'operator', '--name', 'Sam Share', '--email', 'sam@share.co', '--write');
    } finally {
      process.chdir(prevCwd);
    }

    const handoffPath = path.join(dir, 'atris', 'reports', `${new Date().toISOString().slice(0, 10)}-share-operator.md`);
    assert.ok(fs.existsSync(handoffPath));
    const body = fs.readFileSync(handoffPath, 'utf8');
    assert.match(body, /Share Co Share Handoff/);
    assert.match(body, /For: Sam Share <sam@share\.co>/);
    assert.match(body, /Ready to share: yes/);
    assert.match(body, /Remote pull: available/);
    assert.match(body, /Get The Workspace/);
    assert.match(body, /atris pull share-co/);
    assert.match(body, /atris business start/);
    assert.match(body, /atris radar/);
    assert.match(body, /atris task next/);
    assert.match(body, /atris member activate operator/);
    assert.match(body, /## Start Here[\s\S]*atris member activate operator[\s\S]*atris mission status --status active --json[\s\S]*atris mission start "Run the first useful loop for Share Co"[\s\S]*atris member goal-from-mission operator/);
    assert.match(body, /atris mission start "Run the first useful loop for Share Co"/);
    assert.match(body, /atris member goal-from-mission operator/);
    assert.match(body, /Team start: atris\/team\/START_HERE\.md/);
    assert.match(body, /atris sync --dry-run/);
    assert.match(body, /atris sync --watch/);
    assert.match(body, /atris business record atris\/reports\/<recap>\.md/);
    assert.match(body, /Starter brief: atris\/wiki\/briefs\/share-co-starter-brief\.md/);
    assert.match(body, /First loop: atris\/wiki\/concepts\/share-co-first-loop\.md/);
    assert.match(body, /Scorecards: 1/);
    assert.match(body, /Atris OS State/);
    assert.match(body, /Tasks: 1 open, 1 claimed, 1 review \(1 certified\), 0 blocked/);
    assert.match(body, /Missions: 1 active, 1 running, 1 always-on, 0 stale\/no-verifier/);
    assert.match(body, /Team goals: 6 member lanes, 1 with active goals/);
    assert.match(body, /AgentXP: 12 total, 2 today, 1 receipts, integrity ok/);
    assert.match(body, /Loop: 1 mission ticks; Codex goal Keep the business loop moving/);
    assert.match(body, /XP gate: proof can move to Review; XP is awarded only after human approval/);
    assert.match(body, /atris radar/);
    assert.match(body, /atris mission status --status active --json/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('business start gives a collaborator first-run card for a ready workspace', async () => {
  const dir = makeTempDir();
  try {
    createCanonicalBusinessWorkspace(dir, {
      business_id: 'biz-start',
      workspace_id: 'ws-start',
      name: 'Start Co',
      slug: 'start-co',
      owner_email: 'team@start.co',
      workspace_template: 'business',
    }, { here: true });

    const prevCwd = process.cwd();
    process.chdir(dir);
    try {
      await onboardBusiness(
        '--website', 'https://start.co',
        '--contact', 'Sid Start',
        '--email', 'sid@start.co',
        '--note', 'Needs a collaborator landing check'
      );
      fs.writeFileSync(path.join(dir, 'atris', 'reports', 'first-recap.md'), '# First Recap\n\nUseful loop happened.\n', 'utf8');
      await recordBusinessRun('atris/reports/first-recap.md', '--outcome', 'positive', '--metric', 'first loop');
      seedBusinessOsState(dir);
      await shareBusinessWorkspace('--role', 'operator', '--write');
    } finally {
      process.chdir(prevCwd);
    }

    const res = runCli(['business', 'start'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Start Co collaborator start/);
    assert.match(res.stdout, /Ready: yes/);
    assert.match(res.stdout, /Remote pull: available/);
    assert.match(res.stdout, /atris\/team\/START_HERE\.md/);
    assert.match(res.stdout, /atris\/wiki\/briefs\/start-co-starter-brief\.md/);
    assert.match(res.stdout, /atris sync --dry-run/);
    assert.match(res.stdout, /atris business start/);
    assert.match(res.stdout, /atris radar/);
    assert.match(res.stdout, /atris task next/);
    assert.match(res.stdout, /atris mission start "Run the first useful loop for Start Co"/);
    assert.match(res.stdout, /atris member goal-from-mission operator/);
    assert.match(res.stdout, /atris do/);
    assert.match(res.stdout, /atris business record atris\/reports\/<recap>\.md/);
    assert.match(res.stdout, /atris sync --watch/);
    assert.match(res.stdout, /OS:/);
    assert.match(res.stdout, /Tasks: 1 open, 1 claimed, 1 review \(1 certified\), 0 blocked/);
    assert.match(res.stdout, /Missions: 1 active, 1 running, 1 always-on, 0 stale\/no-verifier/);
    assert.match(res.stdout, /AgentXP: 12 total, 2 today, 1 receipts, integrity ok/);
    assert.match(res.stdout, /XP gate: proof can move to Review; XP is awarded only after human approval/);
    assert.match(res.stdout, /Work the first loop/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('business handoff mission bootstrap executes in a generated workspace', () => {
  const dir = makeTempDir();
  try {
    createCanonicalBusinessWorkspace(dir, {
      business_id: 'biz-executable',
      workspace_id: 'ws-executable',
      name: 'Executable Co',
      slug: 'executable-co',
      owner_email: 'team@executable.co',
      workspace_template: 'business',
    }, { here: true });

    const startCard = runCli(['business', 'start'], { cwd: dir });
    assert.equal(startCard.status, 0, startCard.stderr);
    assert.match(startCard.stdout, /atris mission start "Run the first useful loop for Executable Co"/);

    const mission = runCli([
      'mission', 'start', 'Run the first useful loop for Executable Co',
      '--owner', 'operator',
      '--runner', 'codex_goal',
      '--lane', 'business',
      '--verify', 'atris business check',
      '--stop', 'first proof recap recorded',
      '--json',
    ], { cwd: dir });
    assert.equal(mission.status, 0, mission.stderr || mission.stdout);
    const missionPayload = JSON.parse(mission.stdout);
    assert.equal(missionPayload.action, 'mission_started');
    assert.equal(missionPayload.mission.owner, 'operator');
    assert.equal(missionPayload.mission.runner, 'codex_goal');
    assert.equal(missionPayload.mission.lane, 'business');
    assert.equal(missionPayload.mission.verifier, 'atris business check');

    const goal = runCli(['member', 'goal-from-mission', 'operator', '--json'], { cwd: dir });
    assert.equal(goal.status, 0, goal.stderr || goal.stdout);
	    const goalPayload = JSON.parse(goal.stdout);
	    assert.equal(goalPayload.action, 'goal_from_mission_created');
	    assert.equal(goalPayload.goal.source, 'mission');
	    assert.equal(goalPayload.goal.mission_id, missionPayload.mission.id);
	    const ack = runCli([
	      'mission', 'goal', 'ack', missionPayload.mission.id,
	      '--runtime', 'codex',
	      '--status', 'active',
	      '--objective', 'Run the first useful loop for Executable Co',
	      '--json',
	    ], { cwd: dir });
	    assert.equal(ack.status, 0, ack.stderr || ack.stdout);

	    const tick = runCli(['mission', 'tick', missionPayload.mission.id, '--verify', '--json'], {
      cwd: dir,
      env: { PATH: path.dirname(process.execPath) },
    });
    assert.equal(tick.status, 0, tick.stderr || tick.stdout);
    const tickPayload = JSON.parse(tick.stdout);
    assert.equal(tickPayload.action, 'mission_tick');
    assert.equal(tickPayload.verifier_result.passed, true);
    assert.match(tickPayload.verifier_result.command, /atris business check/);
    assert.match(tickPayload.verifier_result.resolved_command, /bin\/atris\.js/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('business collaborator handoff loop connects tasks missions goals proof and share state', async () => {
  const dir = makeTempDir();
  try {
    createCanonicalBusinessWorkspace(dir, {
      business_id: 'biz-loop',
      workspace_id: 'ws-loop',
      name: 'Loop Co',
      slug: 'loop-co',
      owner_email: 'team@loop.co',
      workspace_template: 'business',
    }, { here: true });

    const prevCwd = process.cwd();
    process.chdir(dir);
    try {
      await onboardBusiness(
        '--website', 'https://loop.co',
        '--contact', 'Liv Loop',
        '--email', 'liv@loop.co',
        '--note', 'Needs a complete collaborator proof loop'
      );
    } finally {
      process.chdir(prevCwd);
    }

    const next = runCli(['task', 'next', '--json'], { cwd: dir });
    assert.equal(next.status, 0, next.stderr || next.stdout);
    const nextPayload = JSON.parse(next.stdout);
    assert.match(nextPayload.task.title, /Draft a founder-context note/);
    assert.equal(nextPayload.task.status, 'claimed');

    const mission = runCli([
      'mission', 'start', 'Run the first useful loop for Loop Co',
      '--owner', 'operator',
      '--runner', 'codex_goal',
      '--lane', 'business',
      '--verify', 'atris business check',
      '--stop', 'first proof recap recorded',
      '--json',
    ], { cwd: dir });
    assert.equal(mission.status, 0, mission.stderr || mission.stdout);
    const missionPayload = JSON.parse(mission.stdout);

    const goal = runCli(['member', 'goal-from-mission', 'operator', '--json'], { cwd: dir });
    assert.equal(goal.status, 0, goal.stderr || goal.stdout);
	    const goalPayload = JSON.parse(goal.stdout);
	    assert.equal(goalPayload.goal.mission_id, missionPayload.mission.id);
	    const ack = runCli([
	      'mission', 'goal', 'ack', missionPayload.mission.id,
	      '--runtime', 'codex',
	      '--status', 'active',
	      '--objective', 'Run the first useful loop for Loop Co',
	      '--json',
	    ], { cwd: dir });
	    assert.equal(ack.status, 0, ack.stderr || ack.stdout);

	    const tick = runCli(['mission', 'tick', missionPayload.mission.id, '--verify', '--json'], {
      cwd: dir,
      env: { PATH: path.dirname(process.execPath) },
    });
    assert.equal(tick.status, 0, tick.stderr || tick.stdout);
    const tickPayload = JSON.parse(tick.stdout);
    assert.equal(tickPayload.verifier_result.passed, true);

    fs.writeFileSync(path.join(dir, 'atris', 'reports', 'first-loop.md'), '# First Loop\n\nProof recap recorded.\n', 'utf8');
    const record = runCli(['business', 'record', 'atris/reports/first-loop.md', '--outcome', 'positive', '--metric', 'first loop'], { cwd: dir });
    assert.equal(record.status, 0, record.stderr || record.stdout);

    const share = runCli(['business', 'share', '--role', 'operator', '--name', 'Liv Loop', '--email', 'liv@loop.co', '--write'], { cwd: dir });
    assert.equal(share.status, 0, share.stderr || share.stdout);
    assert.match(share.stdout, /Ready to share: yes/);
    assert.match(share.stdout, /Tasks: 0 open, 1 claimed, 0 review \(0 certified\), 0 blocked/);
    assert.match(share.stdout, /Missions: 1 active, 0 running, 0 always-on, 0 stale\/no-verifier/);
    assert.match(share.stdout, /Team goals: 6 member lanes, 1 with active goals/);
    assert.match(share.stdout, /Loop: 1 mission ticks; Codex goal .*Run the first useful loop for Loop Co/);
    assert.match(share.stdout, /Events: 1/);
    assert.match(share.stdout, /Scorecards: 1/);
    assert.match(share.stdout, /atris task next/);
    assert.match(share.stdout, /atris mission start "Run the first useful loop for Loop Co"/);
    assert.match(share.stdout, /atris member goal-from-mission operator/);

    const handoffPath = path.join(dir, 'atris', 'reports', `${new Date().toISOString().slice(0, 10)}-share-operator.md`);
    const handoff = fs.readFileSync(handoffPath, 'utf8');
    assert.match(handoff, /For: Liv Loop <liv@loop\.co>/);
    assert.match(handoff, /atris business record atris\/reports\/<recap>\.md/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('business check names missing readiness for a received bare workspace', () => {
  const dir = makeTempDir();
  const outside = makeTempDir();
  try {
    createCanonicalBusinessWorkspace(dir, {
      business_id: 'biz-check',
      workspace_id: 'ws-check',
      name: 'Check Co',
      slug: 'check-co',
      owner_email: 'team@check.co',
      workspace_template: 'business',
    }, { here: true });

    const res = runCli(['business', 'check', '--cwd', dir], { cwd: outside });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Check Co collaborator start/);
    assert.match(res.stdout, /Ready: no/);
    assert.match(res.stdout, /missing starter brief/);
    assert.match(res.stdout, /Add starter brief/);
  } finally {
    cleanupTempDir(dir);
    cleanupTempDir(outside);
  }
});

test('business share surfaces missing readiness in a fresh workspace', async () => {
  const dir = makeTempDir();
  try {
    createCanonicalBusinessWorkspace(dir, {
      business_id: 'biz-bare',
      workspace_id: 'ws-bare',
      name: 'Bare Co',
      slug: 'bare-co',
      owner_email: 'team@bare.co',
      workspace_template: 'business',
    }, { here: true });

    const prevCwd = process.cwd();
    let state;
    process.chdir(dir);
    try {
      state = await shareBusinessWorkspace('--role', 'validator');
    } finally {
      process.chdir(prevCwd);
    }

    assert.equal(state.ready, false);
    assert.ok(state.missing.includes('starter brief'));
    assert.ok(state.missing.includes('first loop'));
    assert.ok(state.missing.includes('operator one-pager'));
    assert.ok(state.missing.includes('first proof recap'));
  } finally {
    cleanupTempDir(dir);
  }
});

test('business share surfaces missing root agent adapters for older workspaces', async () => {
  const dir = makeTempDir();
  try {
    createCanonicalBusinessWorkspace(dir, {
      business_id: 'biz-old',
      workspace_id: 'ws-old',
      name: 'Old Co',
      slug: 'old-co',
      owner_email: 'team@old.co',
      workspace_template: 'business',
    }, { here: true });

    const prevCwd = process.cwd();
    let state;
    process.chdir(dir);
    try {
      await onboardBusiness(
        '--website', 'https://old.co',
        '--contact', 'Ola Old',
        '--email', 'ola@old.co',
        '--note', 'Older shared folder missing root adapters'
      );
      fs.writeFileSync(path.join(dir, 'atris', 'reports', 'first-recap.md'), '# First Recap\n\nUseful loop happened.\n', 'utf8');
      await recordBusinessRun('atris/reports/first-recap.md', '--outcome', 'positive', '--metric', 'first loop');
      fs.rmSync(path.join(dir, 'AGENTS.md'), { force: true });
      fs.rmSync(path.join(dir, 'CLAUDE.md'), { force: true });
      fs.rmSync(path.join(dir, 'GEMINI.md'), { force: true });
      state = await shareBusinessWorkspace('--role', 'operator');
    } finally {
      process.chdir(prevCwd);
    }

    assert.equal(state.ready, false);
    assert.ok(state.missing.includes('root agent adapters'));
    assert.deepEqual(state.missingRootAgentAdapters, ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md']);

    const start = runCli(['business', 'start'], { cwd: dir });
    assert.equal(start.status, 0, start.stderr || start.stdout);
    assert.match(start.stdout, /missing root agent adapters/);
    assert.match(start.stdout, /Run `atris update` to restore root AGENTS\.md, CLAUDE\.md, and GEMINI\.md adapters\./);

    const share = runCli(['business', 'share', '--role', 'operator'], { cwd: dir });
    assert.equal(share.status, 0, share.stderr || share.stdout);
    assert.match(share.stdout, /Agent setup: missing root agent adapters/);
    assert.match(share.stdout, /Run `atris update` to restore root AGENTS\.md, CLAUDE\.md, and GEMINI\.md adapters\./);
  } finally {
    cleanupTempDir(dir);
  }
});

test('business share is honest for local-only workspaces without cloud ids', async () => {
  const dir = makeTempDir();
  try {
    const prevCwd = process.cwd();
    let state;
    process.chdir(dir);
    try {
      await onboardBusiness(
        '--name', 'Local Only Co',
        '--website', 'https://local-only.example',
        '--contact', 'Local Owner',
        '--note', 'local workspace first'
      );
      await shareBusinessWorkspace('--role', 'operator', '--write');
      state = collectBusinessShareState(dir);
    } finally {
      process.chdir(prevCwd);
    }

    assert.equal(state.remoteReady, false);
    const handoffPath = path.join(dir, 'atris', 'reports', `${new Date().toISOString().slice(0, 10)}-share-operator.md`);
    const body = fs.readFileSync(handoffPath, 'utf8');
    assert.match(body, /Remote pull: local-only/);
    assert.match(body, /Remote pull is not available yet/);
    assert.match(body, /missing a cloud business ID or workspace ID/);
    assert.doesNotMatch(body, /atris pull local-only-co/);

    const res = runCli(['business', 'start'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Remote pull: local-only/);
    assert.match(res.stdout, /local-only: no cloud sync is available yet/);
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

test('review default mode renders certified task review console', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    initWorkspace(dir);
    const created = runCli(['task', 'new', 'Ship reviewed operator checkpoint', '--tag', 'review', '--json'], { cwd: dir, env });
    assert.equal(created.status, 0, created.stderr);
    const task = JSON.parse(created.stdout).task;
    const ref = task.display_id;
    assert.equal(runCli(['task', 'claim', ref, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const proof = `${'context '.repeat(35)}Verifiers: node --test test/commands.test.js passed, live atris review showed certified queue, git diff --check -- commands/workflow.js bin/atris.js test/commands.test.js clean`;
    assert.equal(runCli(['task', 'ready', ref, '--proof', proof, '--as', 'codex'], { cwd: dir, env }).status, 0);
    assert.equal(runCli(['task', 'review', ref, '--reward', '0', '--as', 'validator'], { cwd: dir, env }).status, 0);

    const res = runCli(['review'], { cwd: dir, env });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Atris Review is the human checkpoint/);
    assert.match(res.stdout, /READY FOR APPROVAL/);
    assert.match(res.stdout, new RegExp(`approve: atris task accept ${ref}`));
    assert.match(res.stdout, new RegExp(`rework: atris task revise ${ref}`));
    assert.match(res.stdout, /Need the legacy Validator prompt/);
    assert.doesNotMatch(res.stdout, /I checked the review setup\./);
    assert.doesNotMatch(res.stdout, /┌|└|│|Validator Agent Activated/);
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

test('casual launch words route to the durable mission loop', () => {
  const dir = makeTempDir();
  try {
    for (const args of [
      ['start', '--json'],
      ['go', '--json'],
      ['keep', 'going', '--json'],
    ]) {
      const res = runCli(args, { cwd: dir });
      assert.equal(res.status, 0, `${args.join(' ')} failed: ${res.stderr}`);
      assert.equal(res.stderr, '');
      const payload = JSON.parse(res.stdout);
      assert.equal(payload.ok, true);
      assert.equal(payload.action, 'start_mission_run');
      assert.match(payload.route, /^atris mission run /);
      assert.match(payload.objective, /self improve goal after goal/);
      assert.equal(payload.expected_loop, 'mission_run');
      assert.doesNotMatch(res.stdout, /Unknown command/i);
      assert.doesNotMatch(res.stdout, /COPY\/PASTE PROMPT/i);
      assert.doesNotMatch(res.stdout, /atris run --once/i);
    }
  } finally {
    cleanupTempDir(dir);
  }
});

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

    const res = runCli(['loop', 'wiki'], { cwd: dir });
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
    const res = runCli(['loop', 'wiki', '--json'], { cwd: dir });
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

test('task lineage', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const parent = runCli(['task', 'new', 'Parent endgame task', '--json'], { cwd: dir, env });
    assert.equal(parent.status, 0, parent.stderr);
    const parentPayload = JSON.parse(parent.stdout);
    const parentRef = parentPayload.task.display_id;

    const child = runCli(['task', 'add', 'Child task under parent', '--goal-id', parentPayload.task_id, '--json'], { cwd: dir, env });
    assert.equal(child.status, 0, child.stderr);
    const childPayload = JSON.parse(child.stdout);
    const childRef = childPayload.task.display_id;

    const text = runCli(['task', 'lineage', childRef], { cwd: dir, env });
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, new RegExp(parentRef));
    assert.match(text.stdout, new RegExp(childRef));

    const parentLine = text.stdout.split('\n').findIndex(l => l.includes(parentRef));
    const childLine = text.stdout.split('\n').findIndex(l => l.includes(childRef));
    assert.ok(parentLine < childLine, 'parent appears before child in text output');

    const json = runCli(['task', 'lineage', childRef, '--json'], { cwd: dir, env });
    assert.equal(json.status, 0, json.stderr);
    const payload = JSON.parse(json.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.action, 'lineage');
    assert.ok(payload.chain, 'chain present');
    assert.ok(payload.chain.target, 'target present');
    assert.equal(payload.chain.target.display_id, childRef);
    assert.ok(Array.isArray(payload.chain.commits), 'commits is an array');

    const noGitEnv = { ...env, HOME: dir };
    const noGit = runCli(['task', 'lineage', childRef], { cwd: dir, env: noGitEnv });
    assert.equal(noGit.status, 0, 'no crash without git');
  } finally {
    cleanupTempDir(dir);
  }
});
