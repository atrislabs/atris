// `atris task` - SQLite-backed task state. TODO.md is a regenerated view;
// events are the durable trail that web/desktop/cloud projections can read.

'use strict';

const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { execSync } = require('node:child_process');
const path = require('path');
const { hasFlag } = require('../lib/arg-parser');
const { buildNextWorkContext, reconcileTaskRows, projectGoalAge } = require('../lib/next-work-context');
const { argsWantHelp } = require('../lib/noninteractive');
const {
  compactErrorPayload,
  compactSuccessPayload,
  printCliJson,
} = require('../lib/cli-json');
const {
  unrunNamedProofCommandIssue,
} = require('../lib/task-proof');
const {
  candidatePolicyGate,
  declaredCandidatePathValues,
  evaluateAutoAccept,
  isAgentCertified,
  isAutoCertifyVerifyCommandAllowed,
  openPullRequestRefusal,
  parseVerifyChain,
  parseVerifyCommand,
  runVerifyCommand,
  DENIED_TAGS,
  protectedLaneOf,
} = require('../lib/auto-accept-certified');
const { evaluateAcceptVerify, nonFalsifyingIssue } = require('../lib/accept-verify-gate');
const { checkedCodeSha, mainLineSha, runVerifyAtJobCode } = require('../lib/job-code-verify');
const { proveTaskLanding } = require('../lib/landing-proof');
const {
  taskExplanation,
  explicitDoneLooksLike,
  explanationFieldsFromInput,
  explanationLines,
  taskApprovalControls,
  approvalLines,
} = require('../lib/task-explanation');
const { extractReceiptEvidence } = require('../lib/receipt-evidence');
const escapeRegExp = require('../lib/escape-regexp');
const { writeFileAtomic } = require('../lib/json-file');
const reviewIntegrity = require('../lib/review-integrity');
const { gateForHuman, isRetiredFillerReason, landingWhyClause, numberWord, plainLandingReason } = require('../lib/voice-gate');
const {
  normalizeOwnerSlug,
  resolveFunctionalOwner: resolveFunctionalTaskOwner,
} = require('../lib/functional-owner');
const {
  TASK_INSPECT_FIELDS,
  readFieldsFlag,
  stripInspectArgs,
  validateFields,
  inspectTextLines,
  buildInspectPayload,
} = require('../lib/inspect-fields');
const {
  taskTagTokens,
  isDecisionHoldTag,
  isDecisionTask,
  decisionMarkerFor,
  summarizeSkippedDecisions,
  formatDecisionRefusalLines,
  DECISION_REFUSE_REASON,
} = require('../lib/task-decision');
const {
  buildFirstMinute,
  loadLocalTaskState,
  deskNextCommand,
  firstTalkCommand,
  folderName,
  personName,
  pickNext,
  speakFirstMinute,
  taskCommand,
  taskNextCommand,
} = require('../lib/first-minute');
const { loadContext } = require('../lib/state-detection');
const {
  DEFAULT_OWNER,
  AGENT_CERTIFICATION_REVIEW_PASSES,
  RESULT_SAVED_TEXT_LIMIT,
  REVIEW_LANE_LOOP_DEFAULT_MAX_STEPS,
  REVIEW_LANE_LOOP_MAX_STEPS,
  REVIEW_LANE_RUN_DEFAULT_MAX_RUNS,
  REVIEW_LANE_RUN_MAX_RUNS,
  PENDING_REVIEW_CHAT_STOP_REASON,
  PROOF_BOUNDARY_BLOCKED_ACTION,
  PROOF_BOUNDARY_BLOCKED_REASON,
  MISSION_XP_END_TO_END_REASON,
  MISSION_XP_END_TO_END_DETAIL,
  READY_RESULT_TEACHING,
  STATUS_PLAN_TAGS,
  TASK_QUEUE_COLUMN_ORDER,
  TASK_QUEUE_COLUMN_LABELS,
  TASK_REVIEW_STATE_LANES,
  TASK_REVIEW_STATE_ALIASES,
  AGENT_ENV_MARKERS,
  WORKER_ENV_MARKERS,
  TASK_BOARD_COLUMNS,
  getTaskDb,
  warnIfTaskTitleNeedsOperatorWhy,
  taskUsageLines,
  help,
  flag,
  taskScopeEverywhere,
  scopedWorkspaceRoot,
  hasEmptyFlagValue,
  wantsJson,
  parseAcceptReward,
  validHumanActorFlag,
  agentProofOnlyMode,
  workerEnvMarker,
  failAgentProofOnly,
  writeStdoutSync,
  printJson,
  refreshCareerXpProjection,
  refreshCareerXpAfterReview,
  compactCareerXpProjection,
  jsonModeActive,
  failTask,
  refuseCandidatePolicyGate,
  proofFlagValue,
  resultSentenceIssue,
  readyResultDetail,
  requireResultSentence,
  weakProofDetail,
  requireMeaningfulTaskProof,
  requireRanNamedProofCommand,
  sendProofIssue,
  textFlag,
  explanationFlags,
  landingFlags,
  readyMergeFlags,
  normalizedLandingSentence,
  defaultLandingSentenceForTitle,
  landingNeedsDayOnePm,
  warnIfLandingNeedsDayOnePm,
  requireExplicitLandingDayOnePm,
  numericFlag,
  meaningfulTaskProofIssue,
  goldenPathMissionXpTask,
  debugUnreadableReceipt,
  receiptTextForProof,
  missionReceiptResultForProof,
  missionXpEndToEndProofIssue,
  missionXpProofBoundaryEvaluation,
  positional,
  taskFromProjection,
  taskRef,
  taskLookupRefs,
  resolveProjectionTaskRef,
  normalizedStatusPart,
  taskIsPlannedOpen,
  taskColumn,
  taskHasReview,
  taskBoardViewModel,
  taskBoardTemplate,
  taskBoardHtml,
  readJsonBody,
  sendJson,
  sendHtml,
} = require('../lib/task-core');

// Moved into feature folders on 2026-11-16 by lib/split-file.js. Each folder's README names its owner: ./task/README.md
const {
  resolveTaskRef, requireTaskId, workspaceRefRows, localDay, guardExplicitActor, collectFlagValues,
  taskCommandQuote, cleanPublicText, publicWords,
} = require('./task/core/core.js');
const {
  reviewNextTaskTitle,
  normalizeReviewNextTaskInput, genericContinuationIssues,
  buildReviewFollowUpChildPredicate,
  buildPendingReviewChatPredicate, createReviewNextTask,
  createNextTaskIfRequested, continueWorkCommandForTask, certifiedReviewNextAction,
  proofBoundaryBlockedEvaluation, handoffAllowsHumanAccept, handoffIsProofBoundaryBlocked,
  taskReviewLanding,
  withReviewReceiptPath, taskReviewSummary,
  taskInspectFieldValues, reviewLandingForDisplay,
  printReviewLanding, latestTaskEvent,
  reviewBlockerForTask, reviewHandoffForTask, reviewActor, taskReviewClip,
  taskReviewCleanEvidenceCommand,
  taskReviewEvidenceCommands,
  taskReviewChatHandoff, taskWithReviewEvidence, taskWithAgentCertification, taskReviewChatContract,
  taskReviewChatNote,
} = require('./task/review-evidence/review-evidence.js');
const {
  writeDefaultProjection, readLocalBusinessBinding, taskAssignee,
  taskApprovalFor, enrichTaskProjection, projectionMissions, projectionWishes,
  taskStateForCloud,
  taskDescriptionForCloud, syncPlanForProjection, readProjectionFile,
} = require('./task/projection/projection.js');
const {
  compactTaskForStatus, compactTaskFromProjection,
  clipStatusText,
  formatTaskEventCompact, cmdStatus,
  cmdAdd, delegateTask, cmdDelegate, taskDayTextGroups,
  taskDayTitle, taskDayGroups, refreshKeptTaskList, keptCount, cmdKeep,
  cmdDay, cmdFirstMinute, cmdHome, cmdList, cmdClaim, cmdRelease, cmdPlan, cmdDo, cmdBacklog,
  cmdClearPlan,
} = require('./task/board/board.js');
const {
  taskQueueLimit,
  normalizeTaskQueueScope, taskQueueScopeFromArgs,
  taskQueueScopeFromSearchParams, taskQueueScopeFromBody, mergeTaskQueueScopes,
  taskQueueScopeIsEmpty,
  filterTasksByScope,
  taskHasReviewFollowUpChild,
  normalizeTaskIdSet,
  formatTaskQueueScope,
  buildTaskCurrent, cmdCurrent, cmdQueue,
  suggestNextClaimableTask,
  isUninitializedTaskFolder, cmdNext, continueWorkForReviewTask,
  cmdContinueWork,
} = require('./task/next/next.js');
const {
  taskQueueCapabilities, taskCapabilitiesContract,
  taskReviewLaneActDecision,
  taskCapabilitiesCheckReport, cmdCapabilities,
  cmdCapabilitiesCheck,
} = require('./task/capabilities/capabilities.js');
const {
  taskReviewLaneDrainSelection, taskReviewLaneDrainReport,
  cmdReviewLaneDrain, taskReviewLaneActOptionsFromBody,
  taskReviewLaneAct, cmdReviewLaneAct,
  normalizeReviewLaneLoopMaxSteps, taskReviewLaneLoopStopIsSafe,
  taskReviewLaneLoopOptionsFromBody,
  taskReviewLaneLoop, cmdReviewLaneLoop, normalizeReviewLaneRunMaxRuns,
  taskReviewLaneRunOptionsFromBody, taskReviewLaneRunStopIsSafe,
  taskReviewLaneRun,
  cmdReviewLaneRun,
} = require('./task/review-lane/review-lane.js');
const {
  evidenceRiskRank,
  taskReviewQueue, certifiedPendingReviewTasks, reviewGroupKey,
  reviewGroupValue, taskReviewLandingLines, cmdReviews, cmdReviewChat,
  taskAllowsReviewChat, appendTaskReviewChat, cmdRevise,
} = require('./task/reviews/reviews.js');
const {
  cmdAudit,
  cmdReview,
} = require('./task/audit/audit.js');
const {
  cmdNote, cmdRetitle, cmdTag, cmdChat, stageErrorDetail, cmdInspect, cmdShow, cmdPage, taskDetail,
  taskPageCurrentStage, taskPageActions,
  taskPageContract,
} = require('./task/card/card.js');
const {
  readTeamMembers, chooseTaskOwner,
  traceLineFromContent, latestTraceValue, taskHasTrace, taskPurpose, cmdPlanPreview,
  buildAutomaticPlanTrace,
} = require('./task/plans/plans.js');
const {
  refreshBrainScorecardsAfterAccept, nextMissionRouteAfterAccept,
  renderAcceptLanding, publishAcceptAgentXp,
  buildAutomaticResultTrace, cmdResult,
} = require('./task/results/results.js');
const {
  taskStepOptionsFromBody, taskCurrentStepOptionsFromBody,
  runTaskStep, runCurrentTaskStep, cmdCurrentStep, selectedNextKeyFromCurrent,
  cmdStep,
} = require('./task/steps/steps.js');
const {
  cmdDone, cmdFinish, cmdArchive, cmdReopen, cmdClearDone,
  cmdPruneTestJunk, cmdReapMissionBlockers, cmdRelabelArchived, appendRelabelArchivedJournalReceipt,
} = require('./task/closing/closing.js');
const {
  cmdAcceptGroup, cmdReady, cmdTaskReceipt, cmdAccept,
  landingProofVerify, stampAutoAcceptMetadata, acceptReviewTask, certifyVerifyCandidate,
  cmdCertifyVerified,
  cmdLanding, cmdAutoAcceptCertified,
  evaluateSweepAutoAccept,
  cmdSweep,
} = require('./task/landing/landing.js');
const {
  cmdImport, cmdWhere, cmdEvents, cmdLineage,
  cmdExport, cmdSetup, extractTodoSectionMarkdown,
  refreshExistingTodoMarkdown, autoRenderTodoFromDb, completeTodoTaskByTitle, cmdRender, cmdSync,
} = require('./task/todo-sync/todo-sync.js');
const {
  serveTaskApiOptions, serveTaskBoardPage, serveTaskList,
  serveTaskActivityStream, serveTaskCapabilities, serveTaskCapabilitiesCheck,
  serveTaskReviewLaneDrain, postTaskReviewLaneAct, postTaskReviewLaneLoop, postTaskReviewLaneRun,
  serveTaskCurrent, postCurrentTaskStep, postTaskCreate, postTaskClearPlan, serveTaskDetail,
  serveTaskPage, postTaskApiStep, postTaskApiContinueWork, postTaskApiClaim, postTaskApiMessage,
  postTaskApiChat, postTaskApiPlan, postTaskApiDo, postTaskApiBacklog, postTaskApiReviewChat,
  postTaskApiFinish, postTaskApiReady, postTaskApiAccept, postTaskApiRevise, postTaskApiReview,
  serveTaskOperation, createTaskApiServer,
  cmdServe,
} = require('./task/api/api.js');

const GOAL_MATCH_STOPWORDS = new Set([
  'daily',
  'goal',
  'goals',
  'loop',
  'loops',
  'make',
  'task',
  'tasks',
  'work',
]);

// The desktop app renders projection.missions but the writer never filled it,
// so live workers were invisible on every dashboard. Best-effort: a broken
// mission or wish store must never take the task projection down with it.
const PROJECTION_MISSION_LIMIT = 50;
const PROJECTION_WISH_LIMIT = 30;
const PROJECTION_CLIP = 240;

const AUTO_REVIEW_NO_GREEN_EVIDENCE_REASON = 'auto_review_no_green_evidence';

// Failed tasks older than this stop earning a daily owner-group row;
// they collapse into one stale summary line instead (target state = clean day view).
const DAY_STALE_FAILED_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_TEXT_TASK_LIMIT = 8;

const { memberTypeOf } = require('../lib/member-type');

const GENERIC_MEMBER_SLUGS = new Set([
  '_template',
  'coordinator',
  'executor',
  'generalist',
  'navigator',
  'supervisor',
]);

// The check already failed on exactly this code: running it again proves
// nothing until something changes. "This code" is the job's code and the main
// line's tip together, and a failure older than a day is tried again anyway.
// The job's code alone never changes once it is handed in, so a check that
// failed once on a loaded machine (CLI-1473, 2026-11-12) was skipped every
// hour after, while the same check passed on the same commit.
const FAILED_CHECK_TRUSTED_MS = 24 * 60 * 60 * 1000;

const SWEEP_AUTO_ACCEPT_PROTECTED = new Set([
  'money', 'deploy', 'release', 'publish', 'security', 'customer', 'outward',
]);

// A bullet the renderer wrote starts with its job's ref in bold brackets: `- **[WSX-1]** title`.
const RENDERED_TODO_BULLET_REF = /^\s*- (?:\[[ x]\]\s+)?\*\*\[([^\]]+)\]\*\*/;

const TASK_API_ROUTES = [
  { method: 'OPTIONS', pathname: null, serve: serveTaskApiOptions },
  { method: 'GET', pathname: '/', serve: serveTaskBoardPage },
  { method: 'GET', pathname: '/api/tasks', serve: serveTaskList },
  { method: 'GET', pathname: '/api/stream', serve: serveTaskActivityStream },
  { method: 'GET', pathname: '/api/tasks/capabilities', serve: serveTaskCapabilities },
  { method: 'GET', pathname: '/api/tasks/capabilities/check', serve: serveTaskCapabilitiesCheck },
  { method: 'GET', pathname: '/api/tasks/review-lane-drain', serve: serveTaskReviewLaneDrain },
  { method: 'POST', pathname: '/api/tasks/review-lane-act', serve: postTaskReviewLaneAct },
  { method: 'POST', pathname: '/api/tasks/review-lane-loop', serve: postTaskReviewLaneLoop },
  { method: 'POST', pathname: '/api/tasks/review-lane-run', serve: postTaskReviewLaneRun },
  { method: 'GET', pathname: '/api/tasks/current', serve: serveTaskCurrent },
  { method: 'GET', pathname: '/api/tasks/queue', serve: serveTaskCurrent },
  { method: 'POST', pathname: '/api/tasks/current/step', serve: postCurrentTaskStep },
  { method: 'POST', pathname: '/api/tasks', serve: postTaskCreate },
  { method: 'POST', pathname: '/api/tasks/clear-plan', serve: postTaskClearPlan },
  { pattern: /^\/api\/tasks\/([^/]+)$/, serve: serveTaskDetail },
  { pattern: /^\/api\/tasks\/([^/]+)\/page$/, serve: serveTaskPage },
  { pattern: /^\/api\/tasks\/([^/]+)\/(claim|message|chat|step|plan|do|backlog|ready|accept|revise|finish|review|review-chat|continue-work|events)$/, serve: serveTaskOperation },
];

const TASK_API_POST_OPERATIONS = {
  step: postTaskApiStep,
  'continue-work': postTaskApiContinueWork,
  claim: postTaskApiClaim,
  message: postTaskApiMessage,
  chat: postTaskApiChat,
  plan: postTaskApiPlan,
  do: postTaskApiDo,
  backlog: postTaskApiBacklog,
  'review-chat': postTaskApiReviewChat,
  finish: postTaskApiFinish,
  ready: postTaskApiReady,
  accept: postTaskApiAccept,
  revise: postTaskApiRevise,
  review: postTaskApiReview,
};

async function runTaskCommand(args) {
  const raw = args || [];
  // A dry run must not mutate even already-expired leases.
  if (!raw.includes('--dry-run') && !(raw[0] === 'sweep' && !raw.includes('--auto-accept'))) {
    const taskDb = getTaskDb();
    taskDb.sweepExpiredLeases();
  }
  if (raw.includes('--help') || raw.includes('-h')) return help();
  const first = raw[0];
  if (!first) return cmdFirstMinute();
  const sub = first.startsWith('--') ? 'desk' : first;
  const rest = first.startsWith('--') ? raw : raw.slice(1);
  switch (sub) {
    case 'desk':   return cmdHome(rest);
    case 'today':  return cmdDay(rest);
    case 'day':    return cmdDay(rest);
    case 'add':    return cmdAdd(rest);
    case 'new':    return cmdAdd(rest);
    case 'delegate': return cmdDelegate(rest);
    case 'assign': return cmdDelegate(rest);
    case 'list':   return cmdList(rest);
    case 'ls':     return cmdList(rest);
    case 'plan':   return cmdPlan(rest);
    case 'do':     return cmdDo(rest);
    case 'backlog':
    case 'unplan':
      return cmdBacklog(rest);
    case 'clear-plan':
    case 'clearplan':
      return cmdClearPlan(rest);
    case 'claim':  return cmdClaim(rest);
    case 'start':  return cmdClaim(rest);
    case 'release':
    case 'unclaim':
      return cmdRelease(rest);
    case 'current':
    case 'select':
      return cmdCurrent(rest);
    case 'capabilities':
    case 'capability':
    case 'caps':
      return cmdCapabilities(rest);
    case 'capabilities-check':
    case 'capability-check':
    case 'caps-check':
      return cmdCapabilitiesCheck(rest);
    case 'review-lane-drain':
    case 'review-drain':
    case 'drain-review':
      return cmdReviewLaneDrain(rest);
    case 'review-lane-act':
    case 'review-act':
    case 'act-review':
      return cmdReviewLaneAct(rest);
    case 'review-lane-loop':
    case 'review-loop':
    case 'loop-review':
      return cmdReviewLaneLoop(rest);
    case 'review-lane-run':
    case 'review-run':
    case 'run-review':
      return cmdReviewLaneRun(rest);
    case 'current-step':
    case 'step-current':
    case 'advance-current':
      return cmdCurrentStep(rest);
    case 'queue':
      return cmdQueue(rest);
    case 'next':   return cmdNext(rest);
    case 'continue-work':
    case 'continue':
      return cmdContinueWork(rest);
    case 'chat':   return cmdChat(rest);
    case 'plan-preview':
    case 'preview-plan':
    case 'plan-card':
      return cmdPlanPreview(rest);
    case 'note':   return cmdNote(rest);
    case 'say':    return cmdNote(rest);
    case 'retitle': return cmdRetitle(rest);
    case 'tag':
    case 'tags':
      return cmdTag(rest);
    case 'show':   return cmdShow(rest);
    case 'inspect': return cmdInspect(rest);
    case 'page':   return cmdPage(rest);
    case 'step':   return cmdStep(rest);
    case 'review-chat':
    case 'chat-review':
      return cmdReviewChat(rest);
    case 'ready':  return cmdReady(rest);
    case 'receipt': return cmdTaskReceipt(rest);
    case 'result': return cmdResult(rest);
    case 'accept': return cmdAccept(rest);
    case 'landing':
    case 'land-review':
      return cmdLanding(rest);
    case 'auto-accept-certified':
    case 'auto-accept':
      return cmdAutoAcceptCertified(rest);
    case 'sweep':
      return cmdSweep(rest);
    case 'audit': return cmdAudit(rest);
    case 'certify-verified':
      return cmdCertifyVerified(rest);
    case 'accept-group':
      return cmdAcceptGroup(rest);
    case 'revise': return cmdRevise(rest);
    case 'done':   return cmdDone(rest);
    case 'finish': return cmdFinish(rest);
    case 'fail':   return cmdDone([...rest, '--failed']);
    case 'archive': return cmdArchive(rest);
    case 'reopen': return cmdReopen(rest);
    case 'clear-done': return cmdClearDone(rest);
    case 'prune-test-junk': return cmdPruneTestJunk(rest);
    case 'keep': return cmdKeep(rest);
    case 'reap-mission-blockers':
    case 'reap-blockers':
      return cmdReapMissionBlockers(rest);
    case 'relabel-archived': return cmdRelabelArchived(rest);
    case 'review': return cmdReview(rest);
    case 'reviews':
    case 'review-queue':
      return cmdReviews(rest);
    case 'status': return cmdStatus(rest);
    case 'setup':  return cmdSetup(rest);
    case 'serve':  return cmdServe(rest);
    case 'import': return cmdImport(rest);
    case 'lineage': return cmdLineage(rest);
    case 'events': return cmdEvents(rest);
    case 'export': return cmdExport(rest);
    case 'render': return cmdRender(rest);
    case 'sync':   return cmdSync(rest);
    case 'where':  return cmdWhere(rest);
    case 'help':
    case '--help':
    case '-h':
      return help();
    default:
      if (wantsJson(raw)) {
        printJson({
          ok: false,
          error: `unknown task subcommand: ${sub}`,
          usage: taskUsageLines(),
        });
        process.exit(2);
      }
      console.error(`atris task: unknown subcommand "${sub}"`);
      help();
      process.exit(2);
  }
}

const MUTATING_TASK_COMMANDS = new Set([
  'add', 'new', 'delegate', 'assign', 'plan', 'do', 'backlog', 'unplan',
  'clear-plan', 'clearplan', 'claim', 'start', 'release', 'unclaim', 'next',
  'continue-work', 'continue', 'chat', 'note', 'say', 'retitle', 'tag', 'tags', 'step',
  'ready', 'result', 'accept', 'landing', 'land-review', 'auto-accept-certified',
  'auto-accept', 'sweep', 'audit', 'certify-verified', 'accept-group', 'revise',
  'done', 'finish', 'fail', 'archive', 'reopen', 'clear-done', 'reap-mission-blockers', 'reap-blockers', 'relabel-archived', 'review', 'import',
  'setup', 'review-lane-act', 'review-act', 'act-review', 'review-lane-loop',
  'review-loop', 'loop-review', 'review-lane-run', 'review-run', 'run-review',
]);

async function run(args) {
  const raw = args || [];
  const sub = !raw[0] || raw[0].startsWith('--') ? 'desk' : raw[0];
  // `task accept --help` is a help request, not a run. Accept mutates
  // review rows, so never list or accept just to show usage.
  if (sub === 'accept' && argsWantHelp(raw.slice(1))) {
    console.log('Usage: atris task accept <id> [--proof "..."] [--public]');
    return;
  }
  // `task claim --help` is a help request, not a run. Claim mutates
  // ownership, so never list or claim just to show usage.
  if (sub === 'claim' && argsWantHelp(raw.slice(1))) {
    console.log('Usage: atris task claim <id> --as <member>');
    return;
  }
  // `task ready --help` is a help request, not a run. Ready mutates
  // review state, so never list or ready just to show usage.
  if (sub === 'ready' && argsWantHelp(raw.slice(1))) {
    console.log('Usage: atris task ready <id> --proof "..." --result "<sentence>" [--work-root <path>] (the copy you built in; ATRIS_WORK_ROOT is the fallback; a relative path resolves from the current folder)');
    return;
  }
  // `task step --help` is a help request, not a run. Step mutates
  // Plan/Do/Review, so never list or step just to show usage.
  if (sub === 'step' && argsWantHelp(raw.slice(1))) {
    console.log('Usage: atris task step <id> [--json]');
    return;
  }
  // `task next --help` is a help request, not a run. Next can open
  // the task db or print the desk, so never list or claim just to show usage.
  if (sub === 'next' && argsWantHelp(raw.slice(1))) {
    console.log('Usage: atris task next [--tag <tag>] [--agent <member>|--human] [--create-next]');
    return;
  }
  // `task show --help` is a help request, not a run. Show can dump
  // a task card or the encyclopedia, so never list or show just to show usage.
  if (sub === 'show' && argsWantHelp(raw.slice(1))) {
    console.log('Usage: atris task show <id> [--json]');
    return;
  }
  const result = await runTaskCommand(raw);
  const readOnlyAgentNext = sub === 'next' && require('../lib/agent-next').agentCaller(raw.slice(1));
  const skipsRender = hasFlag(raw, '--dry-run') || readOnlyAgentNext;
  if (MUTATING_TASK_COMMANDS.has(sub) && !skipsRender) autoRenderTodoFromDb();
  return result;
}

module.exports = {
  run,
  taskQueueScopeFromArgs,
  normalizeTaskQueueScope,
  filterTasksByScope,
  chooseTaskOwner,
  readTeamMembers,
  createTaskApiServer,
  taskDayGroups,
  taskDayTextGroups,
  taskDayTitle,
  taskReviewLanding,
  taskReviewLandingLines,
  delegateTask,
  AGENT_ENV_MARKERS,
  autoRenderTodoFromDb,
  completeTodoTaskByTitle,
  cmdCertifyVerified,
  refreshKeptTaskList,
  keptCount,
  projectionMissions,
  projectionWishes,
  taskBoardViewModel,
  taskBoardTemplate,
  enrichTaskProjection,
  taskApprovalFor,
  taskPageContract,
  taskDescriptionForCloud,
  taskReviewCleanEvidenceCommand,
  certifyVerifyCandidate,
  landingProofVerify,
  stampAutoAcceptMetadata,
  acceptReviewTask,
  reviewBlockerForTask,
  evaluateSweepAutoAccept,
  writeDefaultProjection,
};

// Hand each feature folder the names it borrows. Keep this the last step of loading.
require('./task/core/core.js').bindMain({
  reviewIntegrity, scopedWorkspaceRoot, failTask, readProjectionFile,
});
require('./task/review-evidence/review-evidence.js').bindMain({
  hasFlag, evaluateAutoAccept, isAutoCertifyVerifyCommandAllowed, extractReceiptEvidence,
  reviewIntegrity, isRetiredFillerReason, landingWhyClause, DEFAULT_OWNER,
  AGENT_CERTIFICATION_REVIEW_PASSES, PROOF_BOUNDARY_BLOCKED_ACTION, MISSION_XP_END_TO_END_REASON,
  warnIfTaskTitleNeedsOperatorWhy, missionReceiptResultForProof, missionXpProofBoundaryEvaluation,
  taskRef, taskAssignee, clipStatusText, taskHasReviewFollowUpChild, taskAllowsReviewChat,
});
require('./task/projection/projection.js').bindMain({
  fs, path, projectGoalAge, taskExplanation, explicitDoneLooksLike, explanationLines,
  taskApprovalControls, approvalLines, writeFileAtomic, DEFAULT_OWNER, taskScopeEverywhere,
  scopedWorkspaceRoot, taskRef, taskLookupRefs, resolveProjectionTaskRef, taskColumn, taskHasReview,
  handoffAllowsHumanAccept, handoffIsProofBoundaryBlocked, withReviewReceiptPath, taskReviewSummary,
  GOAL_MATCH_STOPWORDS, PROJECTION_MISSION_LIMIT, PROJECTION_WISH_LIMIT, PROJECTION_CLIP,
  reviewLandingForDisplay, reviewHandoffForTask, taskCommandQuote, taskPageCurrentStage,
  taskPageActions,
});
require('./task/board/board.js').bindMain({
  fs, path, hasFlag, taskExplanation, approvalLines, normalizeOwnerSlug, resolveFunctionalTaskOwner,
  decisionMarkerFor, buildFirstMinute, deskNextCommand, firstTalkCommand, folderName, personName,
  speakFirstMinute, loadContext, DEFAULT_OWNER, getTaskDb, warnIfTaskTitleNeedsOperatorWhy, flag,
  taskScopeEverywhere, scopedWorkspaceRoot, wantsJson, agentProofOnlyMode, printJson, failTask,
  textFlag, explanationFlags, numericFlag, positional, taskFromProjection, taskRef, taskColumn,
  taskHasReview, writeDefaultProjection, buildReviewFollowUpChildPredicate,
  handoffIsProofBoundaryBlocked, taskAssignee, taskApprovalFor, enrichTaskProjection,
  taskStateForCloud, latestTaskEvent, reviewHandoffForTask, normalizeTaskQueueScope,
  taskQueueScopeFromArgs, taskQueueScopeIsEmpty, filterTasksByScope, formatTaskQueueScope,
  certifiedPendingReviewTasks, readProjectionFile, requireTaskId, workspaceRefRows,
  DAY_STALE_FAILED_MS, DAY_TEXT_TASK_LIMIT, localDay, guardExplicitActor, suggestNextClaimableTask,
  isUninitializedTaskFolder, stageErrorDetail, taskDetail, buildAutomaticPlanTrace,
  autoRenderTodoFromDb,
});
require('./task/next/next.js').bindMain({
  fs, path, hasFlag, buildNextWorkContext, reconcileTaskRows, taskTagTokens, isDecisionHoldTag,
  isDecisionTask, summarizeSkippedDecisions, formatDecisionRefusalLines, DECISION_REFUSE_REASON,
  loadLocalTaskState, firstTalkCommand, folderName, personName, pickNext, speakFirstMinute,
  taskCommand, taskNextCommand, DEFAULT_OWNER, PENDING_REVIEW_CHAT_STOP_REASON,
  PROOF_BOUNDARY_BLOCKED_ACTION, TASK_QUEUE_COLUMN_ORDER, TASK_QUEUE_COLUMN_LABELS, getTaskDb,
  warnIfTaskTitleNeedsOperatorWhy, flag, taskScopeEverywhere, scopedWorkspaceRoot, wantsJson,
  printJson, failTask, positional, taskRef, taskColumn, writeDefaultProjection, reviewNextTaskTitle,
  buildReviewFollowUpChildPredicate, buildPendingReviewChatPredicate, createReviewNextTask,
  continueWorkCommandForTask, taskAssignee, reviewHandoffForTask, reviewActor, compactTaskForStatus,
  compactTaskFromProjection, clipStatusText, taskQueueCapabilities, readProjectionFile,
  requireTaskId, taskDetail, taskPageContract, extractTodoSectionMarkdown,
});
require('./task/capabilities/capabilities.js').bindMain({
  hasFlag, DEFAULT_OWNER, REVIEW_LANE_LOOP_DEFAULT_MAX_STEPS, REVIEW_LANE_LOOP_MAX_STEPS,
  REVIEW_LANE_RUN_DEFAULT_MAX_RUNS, REVIEW_LANE_RUN_MAX_RUNS, PENDING_REVIEW_CHAT_STOP_REASON,
  PROOF_BOUNDARY_BLOCKED_ACTION, PROOF_BOUNDARY_BLOCKED_REASON, TASK_REVIEW_STATE_LANES,
  TASK_REVIEW_STATE_ALIASES, getTaskDb, flag, taskScopeEverywhere, wantsJson, printJson,
  reviewActor, taskQueueLimit, normalizeTaskQueueScope, taskQueueScopeFromArgs,
  taskHasReviewFollowUpChild, buildTaskCurrent, taskReviewLaneDrainSelection,
  AUTO_REVIEW_NO_GREEN_EVIDENCE_REASON, normalizeReviewLaneLoopMaxSteps,
  taskReviewLaneLoopStopIsSafe, normalizeReviewLaneRunMaxRuns, taskReviewLaneRunStopIsSafe,
});
require('./task/review-lane/review-lane.js').bindMain({
  fs, path, hasFlag, extractReceiptEvidence, DEFAULT_OWNER, REVIEW_LANE_LOOP_DEFAULT_MAX_STEPS,
  REVIEW_LANE_LOOP_MAX_STEPS, REVIEW_LANE_RUN_DEFAULT_MAX_RUNS, REVIEW_LANE_RUN_MAX_RUNS,
  PENDING_REVIEW_CHAT_STOP_REASON, PROOF_BOUNDARY_BLOCKED_ACTION, PROOF_BOUNDARY_BLOCKED_REASON,
  getTaskDb, flag, taskScopeEverywhere, wantsJson, printJson, writeDefaultProjection, reviewActor,
  taskQueueLimit, normalizeTaskQueueScope, taskQueueScopeFromArgs, taskQueueScopeFromSearchParams,
  taskQueueScopeFromBody, mergeTaskQueueScopes, normalizeTaskIdSet, taskReviewLaneActDecision,
  taskCapabilitiesCheckReport, buildTaskCurrent, AUTO_REVIEW_NO_GREEN_EVIDENCE_REASON,
  continueWorkForReviewTask, taskDetail, appendTaskReviewChat,
});
require('./task/reviews/reviews.js').bindMain({
  hasFlag, taskExplanation, extractReceiptEvidence, reviewIntegrity, gateForHuman, numberWord,
  plainLandingReason, DEFAULT_OWNER, AGENT_CERTIFICATION_REVIEW_PASSES,
  PROOF_BOUNDARY_BLOCKED_ACTION, getTaskDb, flag, wantsJson, printJson, failTask, positional,
  taskRef, writeDefaultProjection, genericContinuationIssues, continueWorkCommandForTask,
  handoffAllowsHumanAccept, taskApprovalFor, reviewLandingForDisplay, reviewBlockerForTask,
  reviewHandoffForTask, reviewActor, taskReviewClip, taskReviewChatHandoff, taskReviewChatContract,
  taskReviewChatNote, compactTaskFromProjection, requireTaskId, taskDetail,
});
require('./task/audit/audit.js').bindMain({
  fs, path, hasFlag, parseVerifyCommand, DEFAULT_OWNER, getTaskDb, flag, hasEmptyFlagValue,
  wantsJson, agentProofOnlyMode, failAgentProofOnly, printJson, refreshCareerXpAfterReview,
  compactCareerXpProjection, failTask, proofFlagValue, requireMeaningfulTaskProof, textFlag,
  positional, taskRef, writeDefaultProjection, normalizeReviewNextTaskInput,
  createNextTaskIfRequested, compactTaskFromProjection, requireTaskId, guardExplicitActor,
});
require('./task/card/card.js').bindMain({
  hasFlag, taskExplanation, explanationLines, approvalLines, TASK_INSPECT_FIELDS, readFieldsFlag,
  stripInspectArgs, validateFields, inspectTextLines, buildInspectPayload, DEFAULT_OWNER,
  AGENT_CERTIFICATION_REVIEW_PASSES, PROOF_BOUNDARY_BLOCKED_ACTION, PROOF_BOUNDARY_BLOCKED_REASON,
  getTaskDb, warnIfTaskTitleNeedsOperatorWhy, flag, scopedWorkspaceRoot, wantsJson, printJson,
  failTask, textFlag, positional, taskRef, normalizedStatusPart, taskColumn, taskHasReview,
  writeDefaultProjection, continueWorkCommandForTask, handoffAllowsHumanAccept,
  handoffIsProofBoundaryBlocked, taskReviewSummary, taskInspectFieldValues, taskAssignee,
  taskApprovalFor, enrichTaskProjection, printReviewLanding, reviewHandoffForTask, reviewActor,
  taskReviewChatHandoff, compactTaskFromProjection, readProjectionFile, requireTaskId,
  collectFlagValues, taskCommandQuote, taskAllowsReviewChat,
});
require('./task/plans/plans.js').bindMain({
  fs, path, DEFAULT_OWNER, getTaskDb, wantsJson, printJson, failTask, textFlag, positional,
  writeDefaultProjection, requireTaskId, cleanPublicText, publicWords, memberTypeOf,
  GENERIC_MEMBER_SLUGS,
});
require('./task/results/results.js').bindMain({
  fs, path, DEFAULT_OWNER, RESULT_SAVED_TEXT_LIMIT, getTaskDb, flag, wantsJson, printJson, failTask,
  requireResultSentence, textFlag, positional, taskRef, writeDefaultProjection, taskAssignee,
  compactTaskFromProjection, requireTaskId, taskDetail, cleanPublicText, traceLineFromContent,
  latestTraceValue, taskHasTrace, taskPurpose,
});
require('./task/steps/steps.js').bindMain({
  hasFlag, compactErrorPayload, compactSuccessPayload, printCliJson, unrunNamedProofCommandIssue,
  DEFAULT_OWNER, PROOF_BOUNDARY_BLOCKED_ACTION, PROOF_BOUNDARY_BLOCKED_REASON,
  MISSION_XP_END_TO_END_REASON, MISSION_XP_END_TO_END_DETAIL, getTaskDb, flag, wantsJson, printJson,
  refreshCareerXpAfterReview, failTask, proofFlagValue, weakProofDetail, textFlag,
  meaningfulTaskProofIssue, missionReceiptResultForProof, missionXpEndToEndProofIssue, positional,
  taskRef, writeDefaultProjection, certifiedReviewNextAction, reviewHandoffForTask, reviewActor,
  taskReviewChatHandoff, taskWithReviewEvidence, taskWithAgentCertification,
  compactTaskFromProjection, taskQueueScopeFromArgs, taskQueueScopeFromSearchParams,
  taskQueueScopeFromBody, mergeTaskQueueScopes, buildTaskCurrent, requireTaskId,
  continueWorkForReviewTask, stageErrorDetail, taskDetail, buildAutomaticPlanTrace,
  buildAutomaticResultTrace, taskPageContract, appendTaskReviewChat,
});
require('./task/closing/closing.js').bindMain({
  fs, path, hasFlag, DEFAULT_OWNER, getTaskDb, flag, wantsJson, agentProofOnlyMode, workerEnvMarker,
  failAgentProofOnly, printJson, refreshCareerXpAfterReview, failTask, proofFlagValue,
  requireMeaningfulTaskProof, textFlag, landingFlags, warnIfLandingNeedsDayOnePm,
  requireExplicitLandingDayOnePm, positional, taskRef, writeDefaultProjection,
  createNextTaskIfRequested, compactTaskFromProjection, requireTaskId,
});
require('./task/landing/landing.js').bindMain({
  fs, execSync, path, hasFlag, compactSuccessPayload, printCliJson, candidatePolicyGate,
  declaredCandidatePathValues, evaluateAutoAccept, isAgentCertified,
  isAutoCertifyVerifyCommandAllowed, openPullRequestRefusal, parseVerifyChain, runVerifyCommand,
  DENIED_TAGS, protectedLaneOf, evaluateAcceptVerify, nonFalsifyingIssue, checkedCodeSha,
  mainLineSha, runVerifyAtJobCode, proveTaskLanding, extractReceiptEvidence, reviewIntegrity,
  DEFAULT_OWNER, MISSION_XP_END_TO_END_REASON, getTaskDb, flag, scopedWorkspaceRoot,
  hasEmptyFlagValue, wantsJson, parseAcceptReward, validHumanActorFlag, agentProofOnlyMode,
  failAgentProofOnly, writeStdoutSync, printJson, refreshCareerXpAfterReview, failTask,
  refuseCandidatePolicyGate, requireResultSentence, requireMeaningfulTaskProof,
  requireRanNamedProofCommand, textFlag, landingFlags, readyMergeFlags, warnIfLandingNeedsDayOnePm,
  requireExplicitLandingDayOnePm, missionXpEndToEndProofIssue, positional, taskFromProjection,
  taskRef, writeDefaultProjection, normalizeReviewNextTaskInput, certifiedReviewNextAction,
  proofBoundaryBlockedEvaluation, enrichTaskProjection, taskReviewClip, taskReviewEvidenceCommands,
  taskReviewChatHandoff, taskWithReviewEvidence, taskWithAgentCertification,
  compactTaskFromProjection, clipStatusText, evidenceRiskRank, taskReviewQueue,
  certifiedPendingReviewTasks, reviewGroupKey, reviewGroupValue, cmdReviews, requireTaskId,
  guardExplicitActor, taskDetail, refreshBrainScorecardsAfterAccept, nextMissionRouteAfterAccept,
  renderAcceptLanding, publishAcceptAgentXp, buildAutomaticResultTrace, FAILED_CHECK_TRUSTED_MS,
  SWEEP_AUTO_ACCEPT_PROTECTED, refreshExistingTodoMarkdown, autoRenderTodoFromDb,
});
require('./task/todo-sync/todo-sync.js').bindMain({
  fs, path, hasFlag, escapeRegExp, writeFileAtomic, DEFAULT_OWNER, getTaskDb, flag,
  taskScopeEverywhere, scopedWorkspaceRoot, wantsJson, printJson, failTask, positional, taskRef,
  writeDefaultProjection, readLocalBusinessBinding, enrichTaskProjection, syncPlanForProjection,
  formatTaskEventCompact, requireTaskId, RENDERED_TODO_BULLET_REF,
});
require('./task/api/api.js').bindMain({
  http, crypto, path, unrunNamedProofCommandIssue, explanationFieldsFromInput, DEFAULT_OWNER,
  getTaskDb, warnIfTaskTitleNeedsOperatorWhy, flag, parseAcceptReward, refreshCareerXpAfterReview,
  resultSentenceIssue, sendProofIssue, meaningfulTaskProofIssue, taskFromProjection, taskBoardHtml,
  readJsonBody, sendJson, sendHtml, writeDefaultProjection, normalizeReviewNextTaskInput,
  createNextTaskIfRequested, enrichTaskProjection, taskQueueScopeFromSearchParams,
  taskCapabilitiesContract, taskCapabilitiesCheckReport, buildTaskCurrent,
  taskReviewLaneDrainReport, taskReviewLaneActOptionsFromBody, taskReviewLaneAct,
  taskReviewLaneLoopOptionsFromBody, taskReviewLaneLoop, taskReviewLaneRunOptionsFromBody,
  taskReviewLaneRun, resolveTaskRef, continueWorkForReviewTask, stageErrorDetail, taskDetail,
  buildAutomaticPlanTrace, buildAutomaticResultTrace, taskPageContract, appendTaskReviewChat,
  taskStepOptionsFromBody, taskCurrentStepOptionsFromBody, runTaskStep, runCurrentTaskStep,
  selectedNextKeyFromCurrent, TASK_API_ROUTES, TASK_API_POST_OPERATIONS,
});
