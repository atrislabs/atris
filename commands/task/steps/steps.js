'use strict';

const { workerEnvMarker } = require('../../../lib/task-core');

// commands/task/steps/steps.js: Working a task step by step: step options, running a step, the
// current step, and step.
// Owner: executor. Moved out of commands/task.js on 2026-11-16 by lib/split-file.js; read README.md
// first.

// Names borrowed from commands/task.js and other feature folders, set by bindMain().
let hasFlag, compactErrorPayload, compactSuccessPayload, printCliJson, unrunNamedProofCommandIssue,
  DEFAULT_OWNER, PROOF_BOUNDARY_BLOCKED_ACTION, PROOF_BOUNDARY_BLOCKED_REASON,
  MISSION_XP_END_TO_END_REASON, MISSION_XP_END_TO_END_DETAIL, getTaskDb, flag, wantsJson, printJson,
  refreshCareerXpAfterReview, failTask, proofFlagValue, weakProofDetail, textFlag,
  meaningfulTaskProofIssue, missionReceiptResultForProof, missionXpEndToEndProofIssue, positional,
  taskRef, writeDefaultProjection, certifiedReviewNextAction, reviewHandoffForTask, reviewActor,
  taskReviewChatHandoff, taskWithReviewEvidence, taskWithAgentCertification,
  compactTaskFromProjection, taskQueueScopeFromArgs, taskQueueScopeFromSearchParams,
  taskQueueScopeFromBody, mergeTaskQueueScopes, buildTaskCurrent, requireTaskId,
  continueWorkForReviewTask, stageErrorDetail, taskDetail, buildAutomaticPlanTrace,
  buildAutomaticResultTrace, taskPageContract, appendTaskReviewChat;
function bindMain(deps) {
  ({
    hasFlag, compactErrorPayload, compactSuccessPayload, printCliJson, unrunNamedProofCommandIssue,
    DEFAULT_OWNER, PROOF_BOUNDARY_BLOCKED_ACTION, PROOF_BOUNDARY_BLOCKED_REASON,
    MISSION_XP_END_TO_END_REASON, MISSION_XP_END_TO_END_DETAIL, getTaskDb, flag, wantsJson,
    printJson, refreshCareerXpAfterReview, failTask, proofFlagValue, weakProofDetail, textFlag,
    meaningfulTaskProofIssue, missionReceiptResultForProof, missionXpEndToEndProofIssue, positional,
    taskRef, writeDefaultProjection, certifiedReviewNextAction, reviewHandoffForTask, reviewActor,
    taskReviewChatHandoff, taskWithReviewEvidence, taskWithAgentCertification,
    compactTaskFromProjection, taskQueueScopeFromArgs, taskQueueScopeFromSearchParams,
    taskQueueScopeFromBody, mergeTaskQueueScopes, buildTaskCurrent, requireTaskId,
    continueWorkForReviewTask, stageErrorDetail, taskDetail, buildAutomaticPlanTrace,
    buildAutomaticResultTrace, taskPageContract, appendTaskReviewChat,
  } = deps);
}

function taskStepError(reason, detail, { status = 409, exitCode = 1, page = null } = {}) {
  const error = new Error(detail || reason);
  error.reason = reason;
  error.status = status;
  error.exitCode = exitCode;
  error.page = page;
  return error;
}

function taskStepStatusForReason(reason) {
  if (['goal_required', 'exit_required', 'proof_needed_required', 'first_move_required', 'proof_required', 'weak_proof', 'proof_command_not_run', 'invalid_reward'].includes(reason)) {
    return 400;
  }
  if (reason === 'not_found') return 404;
  return 409;
}

function taskStepOptionsFromArgs(args) {
  const pos = positional(args);
  const messageFlag = textFlag(args, ['--message', '--content', '--text']);
  return {
    id: pos[0],
    options: {
      actor: String(flag(args, '--as') || DEFAULT_OWNER),
      reviewer: reviewActor(flag(args, '--reviewer') || flag(args, '--as-reviewer') || 'codex-review'),
      message: messageFlag || pos.slice(1).join(' ').trim(),
      goal: textFlag(args, ['--goal', '--objective']),
      summary: textFlag(args, ['--summary']),
      exit: textFlag(args, ['--exit', '--exit-condition']),
      proofNeeded: textFlag(args, ['--proof-needed', '--verify']) || proofFlagValue(args),
      firstMove: textFlag(args, ['--first-move', '--first']),
      proof: proofFlagValue(args),
      lesson: textFlag(args, ['--lesson']),
      nextTask: textFlag(args, ['--next']),
      reward: flag(args, '--reward'),
      dryRun: hasFlag(args, '--dry-run') || hasFlag(args, '--no-note'),
    },
  };
}

function taskCurrentStepOptionsFromArgs(args) {
  const pos = positional(args);
  const messageFlag = textFlag(args, ['--message', '--content', '--text']);
  const owner = String(flag(args, '--owner') || flag(args, '--as') || DEFAULT_OWNER);
  return {
    owner,
    scope: taskQueueScopeFromArgs(args),
    stepOptions: {
      actor: String(flag(args, '--as') || owner),
      reviewer: reviewActor(flag(args, '--reviewer') || flag(args, '--as-reviewer') || 'codex-review'),
      message: messageFlag || pos.join(' ').trim(),
      goal: textFlag(args, ['--goal', '--objective']),
      summary: textFlag(args, ['--summary']),
      exit: textFlag(args, ['--exit', '--exit-condition']),
      proofNeeded: textFlag(args, ['--proof-needed', '--verify']) || proofFlagValue(args),
      firstMove: textFlag(args, ['--first-move', '--first']),
      proof: proofFlagValue(args),
      lesson: textFlag(args, ['--lesson']),
      nextTask: textFlag(args, ['--next']),
      reward: flag(args, '--reward'),
      dryRun: hasFlag(args, '--dry-run') || hasFlag(args, '--no-note'),
    },
  };
}

function taskStepOptionsFromBody(body = {}) {
  return {
    actor: String(body.actor || DEFAULT_OWNER),
    reviewer: reviewActor(body.reviewer || body.review_actor || body.reviewActor || 'codex-review'),
    message: String(body.message || body.content || body.text || '').trim(),
    goal: String(body.goal || body.objective || '').trim(),
    summary: String(body.summary || '').trim(),
    exit: String(body.exit || body.exit_condition || body.exitCondition || '').trim(),
    proofNeeded: String(body.proof_needed || body.proofNeeded || body.verify || body.proof || '').trim(),
    firstMove: String(body.first_move || body.firstMove || body.first || '').trim(),
    proof: String(body.proof || '').trim(),
    lesson: String(body.lesson || '').trim(),
    nextTask: String(body.next || body.next_task || body.nextTask || '').trim(),
    reward: body.reward,
    dryRun: Boolean(body.dryRun || body.noNote || body.dry_run),
  };
}

function taskCurrentStepOptionsFromBody(body = {}, searchParams = new URLSearchParams()) {
  const stepOptions = taskStepOptionsFromBody(body);
  const queryScope = taskQueueScopeFromSearchParams(searchParams);
  const bodyScope = taskQueueScopeFromBody(body);
  const queryOwner = searchParams.get('owner') || searchParams.get('as') || searchParams.get('actor');
  const queryReviewer = searchParams.get('reviewer') || searchParams.get('as_reviewer') || searchParams.get('as-reviewer');
  const bodyOwner = body.owner || body.as;
  const owner = String(queryOwner || bodyOwner || body.actor || DEFAULT_OWNER);
  stepOptions.actor = String(body.actor || body.as || body.owner || queryOwner || owner);
  stepOptions.reviewer = reviewActor(body.reviewer || body.review_actor || body.reviewActor || queryReviewer || stepOptions.reviewer);
  return {
    owner,
    scope: mergeTaskQueueScopes(queryScope, bodyScope),
    stepOptions,
  };
}

function parseStepReviewReward(value) {
  if (value === undefined || value === null || value === true || value === '') return { ok: true, value: 0 };
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return { ok: false, reason: 'invalid_reward' };
  return { ok: true, value: numeric };
}

function taskStepFailure(command, result, page) {
  const reason = result && result.reason || 'step_failed';
  throw taskStepError(reason, stageErrorDetail(command, reason, result || {}), {
    status: taskStepStatusForReason(reason),
    exitCode: reason === 'not_found' ? 1 : 2,
    page,
  });
}

function readyHandoffForStep(task, proof, lesson, nextTask, agentCertified) {
  const verifierTask = taskWithReviewEvidence(taskWithAgentCertification(task, agentCertified), { proof, lesson, nextTask });
  const reviewChat = taskReviewChatHandoff(verifierTask, { reviewer: 'codex-review' });
  const handoff = {
    native_goal_status: agentCertified ? 'agent_certified' : 'needs_second_agent_review',
    career_xp_status: 'pending_human_accept',
    next_action: agentCertified ? certifiedReviewNextAction(nextTask) : 'agent_review_again',
    rule: agentCertified
      ? 'Double-check complete; ready to keep moving. XP is awarded only after the human approves the task.'
      : 'Proof is ready; one more agent check before human approval. XP waits for the human.',
  };
  if (reviewChat) {
    handoff.review_chat_command = reviewChat.command;
    handoff.codex_prompt = reviewChat.codex_prompt;
    handoff.verification_focus = reviewChat.verification_focus;
  }
  return handoff;
}

function runTaskStep(taskDb, db, taskId, options = {}) {
  const actor = String(options.actor || DEFAULT_OWNER);
  const reviewer = reviewActor(options.reviewer || 'codex-review');
  let task = taskDetail(taskDb, db, taskId);
  if (!task) throw taskStepError('not_found', `task not found: ${taskId}`, { status: 404, exitCode: 1 });
  const initialPage = taskPageContract(task, { reviewer });
  if (initialPage.stage.current === 'plan' && Boolean(workerEnvMarker())) {
    throw taskStepError('agent_proof_only_plan_approval_blocked', 'only a person can approve a plan', {
      status: 403,
      exitCode: 2,
      page: initialPage,
    });
  }
  const initialHandoffState = task.status === 'review' ? reviewHandoffForTask(task, { suppressExistingFollowUp: true }) : null;
  if (initialHandoffState && (initialHandoffState.next_action === 'continue_work' || initialHandoffState.next_action === 'human_accept_waiting')) {
    const reason = initialHandoffState.next_action === 'continue_work'
      ? 'agent_certified_continue_work'
      : 'agent_certified_waiting_human';
    throw taskStepError(reason, 'atris task step: approval-ready rows have no safe agent step; continue other work or wait for human approval/rework on this task', { status: 409, exitCode: 1, page: initialPage });
  }
  let chat = null;
  const message = String(options.message || '').trim();
  const goal = String(options.goal || '').trim();
  const summary = String(options.summary || '').trim();
  if (message || goal || summary) {
    const chatted = taskDb.chatTask(db, { id: taskId, actor, content: message, goal, summary });
    if (!chatted.chatted) taskStepFailure('atris task step', chatted, initialPage);
    chat = {
      action: 'chatted',
      version: chatted.event.version,
      goal_changed: chatted.goal_changed,
      chat_packet: chatted.chat_packet,
    };
    task = taskDetail(taskDb, db, taskId) || task;
  }
  const actionPage = taskPageContract(task, { reviewer });
  const current = actionPage.stage.current;
  let stepAction = null;
  let version = null;
  let stagePacket = null;
  let handoff = null;
  let contract = null;
  let episode = null;
  let xpProjection = null;
  if (current === 'backlog') {
    const automaticPlan = buildAutomaticPlanTrace(taskDb, task, {
      actor,
      owner: actor,
      goal,
      summary,
      firstMove: String(options.firstMove || ''),
      exit: String(options.exit || ''),
    });
    const planned = taskDb.stageTask(db, {
      id: taskId,
      actor,
      stage: 'plan',
      goal,
      summary,
      owner: automaticPlan.ownerForStage || actor,
      exit: String(options.exit || ''),
      proofNeeded: String(options.proofNeeded || ''),
      firstMove: String(options.firstMove || ''),
      planTrace: automaticPlan.trace,
    });
    if (!planned.staged) taskStepFailure('atris task step', planned, actionPage);
    stepAction = 'planned';
    version = planned.event.version;
    stagePacket = planned.stage_packet;
  } else if (current === 'plan') {
    if (Boolean(workerEnvMarker())) {
      throw taskStepError('agent_proof_only_plan_approval_blocked', 'only a person can approve a plan', {
        status: 403,
        exitCode: 2,
        page: actionPage,
      });
    }
    const firstMove = String(options.firstMove || '').trim();
    if (!firstMove) {
      throw taskStepError('first_move_required', 'atris task step: --first-move required', { status: 400, exitCode: 2, page: actionPage });
    }
    const doing = taskDb.stageTask(db, {
      id: taskId,
      actor,
      stage: 'do',
      goal,
      summary,
      owner: actor,
      exit: String(options.exit || ''),
      proofNeeded: String(options.proofNeeded || ''),
      firstMove,
    });
    if (!doing.staged) taskStepFailure('atris task step', doing, actionPage);
    stepAction = 'doing';
    version = doing.event.version;
    stagePacket = doing.stage_packet;
  } else if (current === 'do') {
    const proof = String(options.proof || '').trim();
    const proofIssue = meaningfulTaskProofIssue(proof);
    if (proofIssue) {
      throw taskStepError(proof ? 'weak_proof' : 'proof_required', weakProofDetail(proofIssue), { status: 400, exitCode: 2, page: actionPage });
    }
    const unrunIssue = unrunNamedProofCommandIssue(proof, '');
    if (unrunIssue) {
      throw taskStepError(unrunIssue.reason, unrunIssue.detail, { status: 400, exitCode: 2, page: actionPage });
    }
    const missionXpIssue = missionXpEndToEndProofIssue(task, proof, task.workspace_root || process.cwd());
    if (missionXpIssue) {
      throw taskStepError(MISSION_XP_END_TO_END_REASON, missionXpIssue, { status: 409, exitCode: 1, page: actionPage });
    }
    const lesson = String(options.lesson || '');
    const nextTask = String(options.nextTask || '');
    const resultTrace = buildAutomaticResultTrace(taskDb, db, taskId, { actor, proof });
    const missionResult = missionReceiptResultForProof(task, proof, task.workspace_root || process.cwd());
    const ready = taskDb.readyTask(db, {
      id: taskId,
      actor,
      proof,
      lesson,
      nextTask,
      resultTrace: resultTrace && resultTrace.trace,
      result: missionResult ? missionResult.changed : undefined,
      reason: missionResult ? missionResult.reason : undefined,
    });
    if (!ready.ready) taskStepFailure('atris task step', ready, actionPage);
    task = taskDetail(taskDb, db, taskId) || task;
    stepAction = 'ready';
    version = ready.event.version;
    handoff = readyHandoffForStep(task, proof, lesson, nextTask, ready.event.payload.agent_certified === true);
  } else if (current === 'review' && task.status === 'review') {
    const handoffState = reviewHandoffForTask(task, { suppressExistingFollowUp: true });
    if (handoffState && handoffState.next_action === PROOF_BOUNDARY_BLOCKED_ACTION) {
      const detail = handoffState.reason === MISSION_XP_END_TO_END_REASON
        ? `atris task step: ${MISSION_XP_END_TO_END_DETAIL}`
        : 'atris task step: Review proof cites an open/draft/unmerged PR boundary; revise the row before further stepping';
      throw taskStepError(PROOF_BOUNDARY_BLOCKED_REASON, detail, { status: 409, exitCode: 1, page: actionPage });
    }
    if (handoffState && (handoffState.next_action === 'continue_work' || handoffState.next_action === 'human_accept_waiting')) {
      const reason = handoffState.next_action === 'continue_work'
        ? 'agent_certified_continue_work'
        : 'agent_certified_waiting_human';
      throw taskStepError(reason, 'atris task step: approval-ready rows have no safe agent step; continue other work or wait for human approval/rework on this task', { status: 409, exitCode: 1, page: actionPage });
    }
    const reviewed = appendTaskReviewChat(taskDb, db, taskId, { reviewer, dryRun: Boolean(options.dryRun) });
    stepAction = 'review_chat';
    version = reviewed.version;
    contract = reviewed.contract;
  } else if (current === 'review') {
    const proof = String(options.proof || '').trim();
    const proofIssue = meaningfulTaskProofIssue(proof);
    if (proofIssue) {
      throw taskStepError(proof ? 'weak_proof' : 'proof_required', weakProofDetail(proofIssue), { status: 400, exitCode: 2, page: actionPage });
    }
    const unrunIssue = unrunNamedProofCommandIssue(proof, '');
    if (unrunIssue) {
      throw taskStepError(unrunIssue.reason, unrunIssue.detail, { status: 400, exitCode: 2, page: actionPage });
    }
    const parsedReward = parseStepReviewReward(options.reward);
    if (!parsedReward.ok) {
      throw taskStepError('invalid_reward', 'atris task step: --reward must be zero or a positive number', { status: 400, exitCode: 2, page: actionPage });
    }
    const reviewed = taskDb.reviewTask(db, {
      id: taskId,
      actor: reviewer,
      reward: parsedReward.value,
      lesson: String(options.lesson || ''),
      nextTask: String(options.nextTask || ''),
      proof,
      careerXpEligible: false,
    });
    if (!reviewed.reviewed) taskStepFailure('atris task step', reviewed, actionPage);
    stepAction = 'reviewed';
    version = reviewed.event.version;
    episode = reviewed.episode;
    xpProjection = refreshCareerXpAfterReview(reviewed);
  } else {
    throw taskStepError('no_next_action', `atris task step: no safe agent action for ${current}`, { status: 409, exitCode: 1, page: actionPage });
  }
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  const finalTask = taskDetail(taskDb, db, taskId) || task;
  return {
    ok: true,
    action: 'stepped',
    task_id: taskId,
    step_action: stepAction,
    version,
    chat,
    stage_packet: stagePacket,
    handoff,
    contract,
    episode,
    xp_projection: xpProjection,
    projection_path: outPath,
    previous_page: initialPage,
    page: taskPageContract(finalTask, { reviewer }),
    task: compactTaskFromProjection(projection, taskId),
  };
}

function runCurrentTaskStep(taskDb, db, { owner = DEFAULT_OWNER, reviewer = 'codex-review', scope = {}, stepOptions = {} } = {}) {
  const before = buildTaskCurrent(taskDb, db, [], { owner, reviewer, scope });
  const current = before.current;
  if (!current.selected_task_id) {
    const error = taskStepError('no_current_task', 'atris task current-step: no scoped current task selected', {
      status: 409,
      exitCode: 1,
      page: null,
    });
    error.current = current;
    throw error;
  }
  const actor = String(stepOptions.actor || owner || DEFAULT_OWNER);
  const selectedTask = taskDetail(taskDb, db, current.selected_task_id);
  if (selectedTask && selectedTask.claimed_by && selectedTask.claimed_by !== actor) {
    const error = taskStepError('claimed_by_other', `atris task current-step: scoped current task is claimed by ${selectedTask.claimed_by}; rerun as that owner or narrow the scope`, {
      status: 409,
      exitCode: 1,
      page: current.page,
    });
    error.current = current;
    throw error;
  }
  const safeReasons = new Set(['claimed_by_owner', 'review_needs_agent_verification', 'review_proof_boundary_blocked', 'plan_ready', 'backlog_idea', 'review_certified_waiting_human']);
  if (!safeReasons.has(current.selected_reason)) {
    const error = taskStepError(
      'unsafe_current_selection',
      `atris task current-step: ${current.selected_reason} is read-only; select a task owned by ${current.owner} or use atris task step <id> intentionally`,
      {
        status: 409,
        exitCode: 1,
        page: current.page,
      },
    );
    error.current = current;
    throw error;
  }
  if (current.selected_reason === 'claimed_by_owner' && current.selected?.claimed_by && current.selected.claimed_by !== actor) {
    const error = taskStepError(
      'current_step_owner_mismatch',
      `atris task current-step: selected task is claimed by ${current.selected.claimed_by}, but step actor is ${actor}`,
      {
        status: 409,
        exitCode: 1,
        page: current.page,
      },
    );
    error.current = current;
    throw error;
  }
  const nextActionKey = selectedNextKeyFromCurrent(current);
  if (nextActionKey === 'human_accept_waiting') {
    const error = taskStepError(
      'agent_certified_waiting_human',
      'atris task current-step: selected row is ready for human approval; no agent mutation is safe',
      {
        status: 409,
        exitCode: 1,
        page: current.page,
      },
    );
    error.current = current;
    throw error;
  }
  if (nextActionKey === PROOF_BOUNDARY_BLOCKED_ACTION) {
    const boundaryReason = current.page?.review?.handoff?.reason || current.selected?.review?.handoff?.reason || '';
    const detail = boundaryReason === MISSION_XP_END_TO_END_REASON
      ? `atris task current-step: ${MISSION_XP_END_TO_END_DETAIL}`
      : 'atris task current-step: selected Review row has stale/open/draft/unmerged PR proof; revise it instead of accepting or auto-stepping';
    const error = taskStepError(
      PROOF_BOUNDARY_BLOCKED_REASON,
      detail,
      {
        status: 409,
        exitCode: 1,
        page: current.page,
      },
    );
    error.current = current;
    throw error;
  }
  if (nextActionKey === 'continue_work') {
    const continued = continueWorkForReviewTask(taskDb, db, current.selected_task_id, { owner: actor });
    const after = buildTaskCurrent(taskDb, db, [], { owner, reviewer, scope });
    const nextTask = continued.next_task_id ? taskDetail(taskDb, db, continued.next_task_id) : null;
    const nextPage = nextTask ? taskPageContract(nextTask, { reviewer }) : current.page;
    const step = {
      ok: true,
      action: 'stepped',
      task_id: current.selected_task_id,
      step_action: 'continue_work',
      version: null,
      chat: null,
      stage_packet: null,
      handoff: current.page && current.page.review ? current.page.review.handoff : null,
      contract: null,
      episode: null,
      xp_projection: null,
      projection_path: continued.projection_path,
      previous_page: current.page,
      page: nextPage,
      task: continued.next_task,
      parent: continued.parent,
      next_task: continued.next_task,
      continue_work: continued,
    };
    return {
      ok: true,
      action: 'current_step',
      projection_path: after.outPath,
      selected_task_id: current.selected_task_id,
      selected_ref: current.selected_ref || null,
      selected_next_key: nextActionKey,
      selected_reason: current.selected_reason,
      scope: current.scope,
      before: current,
      before_current: current,
      step,
      after: {
        current: after.current,
        page: step.page,
        task: step.task,
      },
      after_current: after.current,
      current: after.current,
      page: step.page,
      task: step.task,
      safety: {
        read_only: false,
        claims_work: false,
        human_accept: false,
        xp_after_human_accept: true,
      },
    };
  }
  let step;
  try {
    step = runTaskStep(taskDb, db, current.selected_task_id, { ...stepOptions, actor });
  } catch (error) {
    error.current = current;
    throw error;
  }
  const after = buildTaskCurrent(taskDb, db, [], { owner, reviewer, scope });
  return {
    ok: true,
    action: 'current_step',
    projection_path: after.outPath,
    selected_task_id: current.selected_task_id,
    selected_ref: current.selected_ref || null,
    selected_next_key: nextActionKey,
    selected_reason: current.selected_reason,
    scope: current.scope,
    before: current,
    before_current: current,
    step,
    after: {
      current: after.current,
      page: step.page,
      task: step.task,
    },
    after_current: after.current,
    current: after.current,
    page: step.page,
    task: step.task,
    safety: {
      read_only: false,
      claims_work: step.step_action === 'doing',
      human_accept: false,
      xp_after_human_accept: true,
    },
  };
}

function cmdCurrentStep(args) {
  const { owner, scope, stepOptions } = taskCurrentStepOptionsFromArgs(args);
  const taskDb = getTaskDb();
  const db = taskDb.open();
  let result;
  try {
    result = runCurrentTaskStep(taskDb, db, {
      owner,
      reviewer: stepOptions.reviewer,
      scope,
      stepOptions,
    });
  } catch (error) {
    const errorCurrent = error.current || null;
    if (wantsJson(args)) {
      const selectedRef = errorCurrent ? errorCurrent.selected_ref : null;
      const nextCommand = error.page?.stage?.next_action?.command
        || (errorCurrent && errorCurrent.next && errorCurrent.next.command)
        || null;
      printCliJson(
        {
          ok: false,
          action: 'current_step',
          reason: error.reason || 'step_failed',
          detail: error.message,
          selected_task_id: errorCurrent ? errorCurrent.selected_task_id : null,
          selected_ref: selectedRef,
          selected_next_key: selectedNextKeyFromCurrent(errorCurrent),
          next_command: nextCommand,
          current: errorCurrent,
          page: error.page || null,
        },
        compactErrorPayload({
          reason: error.reason || 'step_failed',
          detail: error.message,
          selected_ref: selectedRef,
          next_command: nextCommand,
        }),
        args,
      );
    } else {
      console.error(error.message || 'atris task current-step failed');
    }
    process.exit(error.exitCode || 1);
  }
  if (wantsJson(args)) {
    const nextCommand = result.page?.stage?.next_action?.command || null;
    printCliJson(
      result,
      compactSuccessPayload({
        action: 'current_step',
        ids: {
          selected_task_id: result.selected_task_id || null,
          selected_ref: result.selected_ref || null,
          step_action: result.step && result.step.step_action ? result.step.step_action : null,
        },
        next_command: nextCommand,
      }),
      args,
    );
    return;
  }
  console.log(`current-step ${taskRef(result.task)} -> ${result.step.step_action}`);
  console.log(`Stage: ${result.page.stage.current}`);
  if (result.page.stage.next_action && result.page.stage.next_action.command) {
    console.log(`Next: ${result.page.stage.next_action.command}`);
  }
}

function selectedNextKeyFromCurrent(current) {
  if (!current) return null;
  if (current.next && current.next.key) return current.next.key;
  if (current.page && current.page.stage && current.page.stage.next_action) {
    return current.page.stage.next_action.key || null;
  }
  return null;
}

function cmdStep(args) {
  const { id, options } = taskStepOptionsFromArgs(args);
  if (!id) {
    failTask('atris task step', 'missing_id', 'id required');
  }
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const taskId = requireTaskId(taskDb, db, id, 'atris task step');
  let result;
  try {
    result = runTaskStep(taskDb, db, taskId, options);
  } catch (error) {
    if (wantsJson(args)) {
      printJson({
        ok: false,
        action: 'step',
        task_id: taskId,
        reason: error.reason || 'step_failed',
        detail: error.message,
        page: error.page || null,
      });
    } else {
      console.error(error.message || 'atris task step failed');
    }
    process.exit(error.exitCode || 1);
  }
  if (wantsJson(args)) {
    printJson(result);
    return;
  }
  console.log(`step ${taskRef(result.task)} -> ${result.step_action}`);
  console.log(`Stage: ${result.page.stage.current}`);
  if (result.page.stage.next_action && result.page.stage.next_action.command) {
    console.log(`Next: ${result.page.stage.next_action.command}`);
  }
}

module.exports = {
  bindMain, taskStepError, taskStepStatusForReason, taskStepOptionsFromArgs,
  taskCurrentStepOptionsFromArgs, taskStepOptionsFromBody, taskCurrentStepOptionsFromBody,
  parseStepReviewReward, taskStepFailure, readyHandoffForStep, runTaskStep, runCurrentTaskStep,
  cmdCurrentStep, selectedNextKeyFromCurrent, cmdStep,
};
