const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { buildManifest } = require('../lib/manifest');
const { ensureWikiScaffold, normalizeWikiOnlyPrefix, validateAgentReadableWikiPages } = require('../lib/wiki');
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
const { buildPullConflictReviewPacket } = require('../commands/pull');
const { basenameOfManifestPath, buildPushChangePlan, isBusinessWorkspaceRoot, resolvePushSourceDir, shouldRetrySyncIndividually } = require('../commands/push');
const { collectState } = require('../commands/brain');
const {
  buildBusinessSyncPlan,
  canPreviewPush,
  collectBrainSnapshot,
  collectConflictResolutionEntries,
  collectLocalSyncStatus,
  describeWatchFailure,
  parseBusinessSyncArgs,
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
    fs.writeFileSync(path.join(child, '.atris', 'business.json'), JSON.stringify({ slug: 'atris-labs-1' }), 'utf8');

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

test('push retries multi-file server failures individually but not access or sleeping states', () => {
  assert.equal(shouldRetrySyncIndividually({ ok: false, status: 500 }, [{ path: '/a.md' }, { path: '/b.md' }]), true);
  assert.equal(shouldRetrySyncIndividually({ ok: false, status: 502 }, [{ path: '/a.md' }, { path: '/b.md' }]), true);
  assert.equal(shouldRetrySyncIndividually({ ok: false, status: 500 }, [{ path: '/a.md' }]), false);
  assert.equal(shouldRetrySyncIndividually({ ok: false, status: 403 }, [{ path: '/a.md' }, { path: '/b.md' }]), false);
  assert.equal(shouldRetrySyncIndividually({ ok: false, status: 409 }, [{ path: '/a.md' }, { path: '/b.md' }]), false);
  assert.equal(shouldRetrySyncIndividually({ ok: true, status: 200 }, [{ path: '/a.md' }, { path: '/b.md' }]), false);
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
  assert.deepEqual(buildBusinessSyncPlan(options), {
    pullArgs: ['pull', 'doordash', '--keep-local', '--fail-on-conflict', '--timeout', '240', '--dry-run'],
    pushArgs: ['push', 'doordash', '--dry-run', '--delete'],
  });
});

test('business sync resolve applies local or cloud conflict artifacts to atris files', () => {
  const dir = makeTempDir();
  try {
    const packetDir = path.join(dir, '.atris', 'sync', 'conflicts', '2026-05-01T12-00-00Z', 'atris', 'wiki');
    fs.mkdirSync(packetDir, { recursive: true });
    fs.writeFileSync(path.join(packetDir, 'a.md.base'), 'base copy\n', 'utf8');
    fs.writeFileSync(path.join(packetDir, 'a.md.local'), 'local copy\n', 'utf8');
    fs.writeFileSync(path.join(packetDir, 'a.md.remote'), 'cloud copy\n', 'utf8');
    fs.writeFileSync(path.join(dir, '.atris', 'sync', 'conflicts', '2026-05-01T12-00-00Z', 'summary.md'), '# Review\n', 'utf8');

    const entries = collectConflictResolutionEntries(dir);
    assert.deepEqual(entries.map(entry => entry.targetRel), ['atris/wiki/a.md']);

    const local = resolveLatestConflict(dir, 'local');
    assert.deepEqual(local.resolved, ['atris/wiki/a.md']);
    assert.equal(fs.readFileSync(path.join(dir, 'atris', 'wiki', 'a.md'), 'utf8'), 'local copy\n');

    const cloud = resolveLatestConflict(dir, 'cloud');
    assert.deepEqual(cloud.resolved, ['atris/wiki/a.md']);
    assert.equal(fs.readFileSync(path.join(dir, 'atris', 'wiki', 'a.md'), 'utf8'), 'cloud copy\n');
    assert.match(cloud.message, /atris sync --dry-run/);

    const both = resolveLatestConflict(dir, 'both');
    assert.deepEqual(both.resolved, ['atris/wiki/a.md']);
    assert.equal(fs.readFileSync(path.join(dir, 'atris', 'wiki', 'a.md'), 'utf8'), 'local copy\n');
    assert.equal(fs.readFileSync(path.join(dir, 'atris', 'wiki', 'a.md.cloud'), 'utf8'), 'cloud copy\n');
    assert.match(both.message, /both versions/);

    fs.writeFileSync(path.join(packetDir, 'a.md.base'), 'A\nB\nC\n', 'utf8');
    fs.writeFileSync(path.join(packetDir, 'a.md.local'), 'A\nB local\nC\n', 'utf8');
    fs.writeFileSync(path.join(packetDir, 'a.md.remote'), 'A\nB\nC cloud\n', 'utf8');
    const merge = resolveLatestConflict(dir, 'merge');
    assert.deepEqual(merge.resolved, ['atris/wiki/a.md']);
    assert.equal(fs.readFileSync(path.join(dir, 'atris', 'wiki', 'a.md'), 'utf8'), 'A\nB local\nC cloud\n');
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
    assert.match(rendered, /Company brain status/);
    assert.match(rendered, /business: doordash/);
    assert.match(rendered, /brain: atris\/ \(1 file\)/);
    assert.match(rendered, /conflicts: 1 review packet/);
    assert.match(rendered, /watcher: last heartbeat/);
    assert.match(rendered, /atris sync --dry-run/);
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
    assert.match(res.stdout, /Company brain status/);
    assert.match(res.stdout, /business: doordash/);
    assert.match(res.stdout, /Next: run `atris sync --dry-run`/);
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

test('business sync watch snapshot detects atris folder changes only', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'wiki'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'wiki', 'a.md'), 'one\n', 'utf8');
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'ignored.json'), '{}', 'utf8');

    const before = collectBrainSnapshot(dir);
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'ignored.json'), '{"x":1}', 'utf8');
    assert.equal(brainSnapshotsDiffer(before, collectBrainSnapshot(dir)), false);

    fs.writeFileSync(path.join(dir, 'atris', 'wiki', 'a.md'), 'two longer\n', 'utf8');
    assert.equal(brainSnapshotsDiffer(before, collectBrainSnapshot(dir)), true);
  } finally {
    cleanupTempDir(dir);
  }
});

test('business sync watch ignore rules skip runtime and OS files', () => {
  assert.equal(shouldIgnoreWatchPath(path.join('.atris', 'state.json')), true);
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
    assert.match(fs.readFileSync(path.join(dir, 'atris', 'brain', 'STATUS.md'), 'utf8'), /sync-language\.md/);
    assert.match(fs.readFileSync(path.join(dir, 'atris', 'brain', 'STATUS.md'), 'utf8'), /First-message rule/);
    assert.match(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), /Atris Brain Compile/);
    assert.match(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), /sync-language\.md/);
    assert.match(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), /activation\/SKILL\.md/);
    const state = collectState(dir);
    assert.equal(state.totalRows, 1);
    assert.equal(state.validRows, 1);
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
    assert.match(res.stdout, /Keshav Rao: make one high-leverage CEO move/);
    assert.match(res.stdout, /---/);
    assert.match(res.stdout, /VERIFY: brain artifacts present/);
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

    const missing = runCli(['task', 'show', 'DOESNOTEXIST', '--json'], { cwd: dir, env });
    assert.equal(missing.status, 2);
    const missingPayload = JSON.parse(missing.stderr);
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
    assert.ok(finished.next_task_id);

    const listed = await fetch(`${base}/api/tasks`).then(r => r.json());
    assert.equal(listed.ok, true);
    assert.ok(listed.projection.tasks.some(t => t.id === finished.next_task_id && t.title === 'Connect the board to Swarlo leases'));
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
    assert.equal(payload.plan[0].body.metadata.swarlo.lease_owner, 'codex');
    assert.equal(payload.plan[0].body.metadata.swarlo.lease_state, 'held');
    assert.equal(payload.plan[0].after_create[0].body.state, 'doing');
    assert.match(payload.plan[0].body.description, /Use dry-run before cloud writes/);
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
    assert.equal(parent.objective, 'Build the task factory into a compounding autonomous development surface');
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

test('init scaffolds atris/wiki/briefs instead of syntheses', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'wiki', 'briefs')));
    assert.equal(fs.existsSync(path.join(dir, 'atris', 'wiki', 'syntheses')), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('business slug matcher accepts config aliases', () => {
  const business = {
    slug: 'atris-labs-1',
    name: 'Atris Labs',
    config: { aliases: ['atris-labs'] },
  };

  assert.equal(businessMatchesSlug(business, 'atris-labs'), true);
  assert.equal(businessMatchesSlug(business, 'atris-labs-1'), true);
  assert.equal(businessMatchesSlug(business, 'Atris Labs'), false);
  assert.equal(businessMatchesSlug(business, 'Atris Labs', { includeName: true }), true);
});

test('business doctor plans safe cache repoints for stale duplicate rows', () => {
  const active = {
    id: 'active-pallet',
    slug: 'pallet-recruiting',
    name: 'pallet-recruiting',
    workspace_id: 'active-workspace',
    config: {},
  };
  const analysis = analyzeBusinessDoctor({
    cloudBusinesses: [active],
    cache: {
      'pallet-recruiting': {
        business_id: 'deleted-duplicate',
        workspace_id: 'deleted-workspace',
        name: 'pallet-recruiting',
        slug: 'pallet-recruiting-1',
      },
    },
    folderBindings: [],
  });

  assert.ok(analysis.issues.some((issue) => issue.code === 'stale-cache-repoint'));
  assert.equal(analysis.cacheUpdates['pallet-recruiting'].business_id, 'active-pallet');
  assert.equal(analysis.cacheUpdates['pallet-recruiting'].workspace_id, 'active-workspace');
  assert.equal(analysis.cacheUpdates['pallet-recruiting'].slug, 'pallet-recruiting');
});

test('business doctor accepts clean alias folders and asks for missing alias cache', () => {
  const atrisLabs = {
    id: 'biz-atris-labs',
    slug: 'atris-labs-1',
    name: 'Atris Labs',
    workspace_id: 'workspace-atris-labs',
    config: { aliases: ['atris-labs'] },
  };
  const analysis = analyzeBusinessDoctor({
    cloudBusinesses: [atrisLabs],
    cache: {
      'atris-labs-1': {
        business_id: 'biz-atris-labs',
        workspace_id: 'workspace-atris-labs',
        name: 'Atris Labs',
        slug: 'atris-labs-1',
      },
    },
    folderBindings: [{
      name: 'atris-labs',
      isSymlink: false,
      hasAtris: true,
      hasBusinessJson: true,
      meta: {
        business_id: 'biz-atris-labs',
        workspace_id: 'workspace-atris-labs',
        name: 'Atris Labs',
        slug: 'atris-labs',
        canonical_slug: 'atris-labs-1',
      },
    }],
  });

  assert.equal(analysis.issues.some((issue) => issue.code === 'folder-name-not-slug-or-alias'), false);
  assert.equal(analysis.issues.some((issue) => issue.code === 'folder-slug-mismatch'), false);
  assert.equal(analysis.cacheUpdates['atris-labs'].business_id, 'biz-atris-labs');
  assert.equal(analysis.cacheUpdates['atris-labs'].canonical_slug, 'atris-labs-1');
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
      JSON.stringify({ slug: 'pallet' }, null, 2),
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

// ============================================
// wiki
// ============================================

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
      path.join(dir, 'atris', 'wiki', 'systems', 'pallet.md'),
      [
        '---',
        'sources: [hubspot, chorus, context/calls]',
        'last_compiled: 2999-01-01',
        'last_verified: 2999-01-01',
        'confidence: 0.7',
        'dependencies: []',
        'actionability: "route account questions"',
        '---',
        '# Pallet',
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
