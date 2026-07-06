const test = require('node:test');
const assert = require('node:assert/strict');

const commandsAutoland = require('../commands/autoland');
const commandsBusinessSync = require('../commands/business-sync');
const commandsClarity = require('../commands/clarity');
const commandsComputer = require('../commands/computer');
const commandsLand = require('../commands/land');
const commandsLive = require('../commands/live');
const commandsLoopFront = require('../commands/loop-front');
const commandsPull = require('../commands/pull');
const commandsWish = require('../commands/wish');
const commandsXp = require('../commands/xp');
const libAutoland = require('../lib/autoland');
const libClarity = require('../lib/clarity');
const libExperimentsDaily = require('../lib/experiments/daily');
const libInspectFields = require('../lib/inspect-fields');
const libManifest = require('../lib/manifest');
const libReceiptEvidence = require('../lib/receipt-evidence');
const libRewardConfig = require('../lib/reward-config');
const libScorecard = require('../lib/scorecard');
const libSecurityScan = require('../lib/security-scan');
const libTaskProof = require('../lib/task-proof');
const libTaskReceipt = require('../lib/task-receipt');
const libTodoFallback = require('../lib/todo-fallback');
const libWiki = require('../lib/wiki');

const slowOnlyCoveredModules = [
  ['../commands/autoland', commandsAutoland, ['autolandCommand', 'verifyClosedTaskMissions']],
  ['../commands/business-sync', commandsBusinessSync, ['businessSync', 'buildBusinessSyncPlan']],
  ['../commands/clarity', commandsClarity, ['clarityCommand', 'parseSets']],
  ['../commands/computer', commandsComputer, ['runComputer', 'buildComputerCard']],
  ['../commands/land', commandsLand, ['landCommand', 'landSummary']],
  ['../commands/live', commandsLive, ['liveCommand', 'collectSnapshot']],
  ['../commands/loop-front', commandsLoopFront, ['loopFront', 'routeLoop']],
  ['../commands/pull', commandsPull, ['pullAtris', 'buildPullConflictReviewPacket']],
  ['../commands/wish', commandsWish, ['wishCommand', 'inferBudgetTier']],
  ['../commands/xp', commandsXp, ['xpCommand', 'buildCareerXpProjection']],
  ['../lib/autoland', libAutoland, ['composeDigest', 'explainResult']],
  ['../lib/clarity', libClarity, ['renderClarityMd', 'mergeProfile']],
  ['../lib/experiments/daily', libExperimentsDaily, ['parseDailyArgs', 'evaluateKeepRule']],
  ['../lib/inspect-fields', libInspectFields, ['validateFields', 'buildInspectPayload']],
  ['../lib/manifest', libManifest, ['buildManifest', 'threeWayCompare']],
  ['../lib/receipt-evidence', libReceiptEvidence, ['extractReceiptEvidence', 'receiptVerifierPassed']],
  ['../lib/reward-config', libRewardConfig, ['REWARD_CONFIG', 'REWARD_CHECKSUM']],
  ['../lib/scorecard', libScorecard, ['buildScorecardData', 'detectEndgameCompletion']],
  ['../lib/security-scan', libSecurityScan, ['scanText', 'runScan']],
  ['../lib/task-proof', libTaskProof, ['taskProofState', 'buildVerifiedProof']],
  ['../lib/task-receipt', libTaskReceipt, ['writeTaskReceipt']],
  ['../lib/todo-fallback', libTodoFallback, ['parseTodoFile', 'parseSection']],
  ['../lib/wiki', libWiki, ['ensureWikiScaffold', 'getWikiRoot']],
];

test('fast coverage guard loads modules otherwise only reached by slow files', () => {
  for (const [modulePath, exported, expectedExports] of slowOnlyCoveredModules) {
    for (const name of expectedExports) {
      assert.ok(Object.hasOwn(exported, name), `${modulePath} exports ${name}`);
    }
  }
});

test('fast coverage guard exercises representative pure helpers', () => {
  const { inferBudgetTier } = require('../commands/wish');
  assert.equal(inferBudgetTier('quick polish the help copy'), 'quick');

  const inspect = require('../lib/inspect-fields');
  assert.equal(inspect.validateFields(['title'], inspect.TASK_INSPECT_FIELDS), null);

  const { extractReceiptEvidence } = require('../lib/receipt-evidence');
  const evidence = extractReceiptEvidence('Receipt saved at atris/runs/demo.json and verified.');
  assert.deepEqual(evidence.missing, ['atris/runs/demo.json']);

  const { taskProofState } = require('../lib/task-proof');
  assert.deepEqual(
    taskProofState('node --test test/foo.test.js passed. Receipt saved at atris/runs/demo.json.'),
    { ok: true, reason: 'proof names a command' }
  );
});
