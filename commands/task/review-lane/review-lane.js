'use strict';

// commands/task/review-lane/review-lane.js: The review lane: drain, act, loop and run, which work
// through tasks waiting for review.
// Owner: validator. Moved out of commands/task.js on 2026-11-16 by lib/split-file.js; read
// README.md first.

// Names borrowed from commands/task.js and other feature folders, set by bindMain().
let fs, path, hasFlag, extractReceiptEvidence, DEFAULT_OWNER, REVIEW_LANE_LOOP_DEFAULT_MAX_STEPS,
  REVIEW_LANE_LOOP_MAX_STEPS, REVIEW_LANE_RUN_DEFAULT_MAX_RUNS, REVIEW_LANE_RUN_MAX_RUNS,
  PENDING_REVIEW_CHAT_STOP_REASON, PROOF_BOUNDARY_BLOCKED_ACTION, PROOF_BOUNDARY_BLOCKED_REASON,
  getTaskDb, flag, taskScopeEverywhere, wantsJson, printJson, writeDefaultProjection, reviewActor,
  taskQueueLimit, normalizeTaskQueueScope, taskQueueScopeFromArgs, taskQueueScopeFromSearchParams,
  taskQueueScopeFromBody, mergeTaskQueueScopes, normalizeTaskIdSet, taskReviewLaneActDecision,
  taskCapabilitiesCheckReport, buildTaskCurrent, AUTO_REVIEW_NO_GREEN_EVIDENCE_REASON,
  continueWorkForReviewTask, taskDetail, appendTaskReviewChat;
function bindMain(deps) {
  ({
    fs, path, hasFlag, extractReceiptEvidence, DEFAULT_OWNER, REVIEW_LANE_LOOP_DEFAULT_MAX_STEPS,
    REVIEW_LANE_LOOP_MAX_STEPS, REVIEW_LANE_RUN_DEFAULT_MAX_RUNS, REVIEW_LANE_RUN_MAX_RUNS,
    PENDING_REVIEW_CHAT_STOP_REASON, PROOF_BOUNDARY_BLOCKED_ACTION, PROOF_BOUNDARY_BLOCKED_REASON,
    getTaskDb, flag, taskScopeEverywhere, wantsJson, printJson, writeDefaultProjection, reviewActor,
    taskQueueLimit, normalizeTaskQueueScope, taskQueueScopeFromArgs, taskQueueScopeFromSearchParams,
    taskQueueScopeFromBody, mergeTaskQueueScopes, normalizeTaskIdSet, taskReviewLaneActDecision,
    taskCapabilitiesCheckReport, buildTaskCurrent, AUTO_REVIEW_NO_GREEN_EVIDENCE_REASON,
    continueWorkForReviewTask, taskDetail, appendTaskReviewChat,
  } = deps);
}

function taskReviewLaneDrainTask(action) {
  if (!action) return null;
  return {
    id: action.id,
    ref: action.ref,
    title: action.title,
    status: action.status,
    next_action: action.next_action,
  };
}

function humanAcceptWaitingDrain(action) {
  if (!action) return null;
  return {
    task: taskReviewLaneDrainTask(action),
    safe_for_agent: false,
    command: null,
    api: null,
    reason: 'human_accept_waiting_is_human_only',
  };
}

function proofBoundaryBlockedDrain(action) {
  if (!action) return null;
  return {
    task: taskReviewLaneDrainTask(action),
    safe_for_agent: false,
    command: null,
    api: null,
    reason: PROOF_BOUNDARY_BLOCKED_REASON,
    revise_command: action.revise_command || action.command || null,
  };
}

function pendingReviewChatDrain(action) {
  if (!action) return null;
  return {
    task: taskReviewLaneDrainTask(action),
    safe_for_agent: false,
    command: null,
    api: null,
    reason: PENDING_REVIEW_CHAT_STOP_REASON,
  };
}

function taskReviewLaneDrainSelection(actions = {}, capabilitiesCheck = {}) {
  if (!capabilitiesCheck.ok) {
    return {
      key: 'capabilities_drift',
      next_action: 'capabilities_drift',
      review_state: null,
      safe_for_agent: false,
      command: null,
      api: null,
      task: null,
      reason: 'capability_conformance_failed',
      proof_boundary_blocked: proofBoundaryBlockedDrain(actions.proof_boundary_blocked),
      human_accept_waiting: humanAcceptWaitingDrain(actions.human_accept_waiting),
    };
  }
  if (actions.needs_agent) {
    return {
      key: 'review_chat',
      next_action: 'review_chat',
      review_state: 'needs-agent',
      safe_for_agent: true,
      command: actions.needs_agent.command || null,
      api: actions.needs_agent.api || null,
      task: taskReviewLaneDrainTask(actions.needs_agent),
      reason: 'needs_agent_review',
      proof_boundary_blocked: proofBoundaryBlockedDrain(actions.proof_boundary_blocked),
      human_accept_waiting: humanAcceptWaitingDrain(actions.human_accept_waiting),
    };
  }
  if (actions.continue_work) {
    return {
      key: 'continue_work',
      next_action: 'continue_work',
      review_state: 'continue-work',
      safe_for_agent: true,
      command: actions.continue_work.command || null,
      api: actions.continue_work.api || null,
      task: taskReviewLaneDrainTask(actions.continue_work),
      reason: 'certified_review_has_follow_up',
      proof_boundary_blocked: proofBoundaryBlockedDrain(actions.proof_boundary_blocked),
      human_accept_waiting: humanAcceptWaitingDrain(actions.human_accept_waiting),
    };
  }
  if (actions.proof_boundary_blocked) {
    return {
      key: PROOF_BOUNDARY_BLOCKED_ACTION,
      next_action: PROOF_BOUNDARY_BLOCKED_ACTION,
      review_state: 'proof-boundary-blocked',
      safe_for_agent: false,
      command: null,
      api: null,
      task: taskReviewLaneDrainTask(actions.proof_boundary_blocked),
      reason: PROOF_BOUNDARY_BLOCKED_REASON,
      proof_boundary_blocked: proofBoundaryBlockedDrain(actions.proof_boundary_blocked),
      human_accept_waiting: humanAcceptWaitingDrain(actions.human_accept_waiting),
    };
  }
  const pendingReviewChat = Array.isArray(actions.pending_review_chat)
    ? actions.pending_review_chat[0]
    : actions.pending_review_chat;
  if (pendingReviewChat) {
    return {
      key: 'pending_review_chat',
      next_action: 'pending_review_chat',
      review_state: 'pending-review-chat',
      safe_for_agent: false,
      command: null,
      api: null,
      task: taskReviewLaneDrainTask(pendingReviewChat),
      reason: PENDING_REVIEW_CHAT_STOP_REASON,
      proof_boundary_blocked: proofBoundaryBlockedDrain(actions.proof_boundary_blocked),
      human_accept_waiting: humanAcceptWaitingDrain(actions.human_accept_waiting),
      pending_review_chat: pendingReviewChatDrain(pendingReviewChat),
    };
  }
  if (actions.human_accept_waiting) {
    return {
      key: 'human_accept_waiting',
      next_action: 'human_accept_waiting',
      review_state: 'human-accept-waiting',
      safe_for_agent: false,
      command: null,
      api: null,
      task: taskReviewLaneDrainTask(actions.human_accept_waiting),
      reason: 'human_accept_waiting_is_human_only',
      proof_boundary_blocked: proofBoundaryBlockedDrain(actions.proof_boundary_blocked),
      human_accept_waiting: humanAcceptWaitingDrain(actions.human_accept_waiting),
    };
  }
  return {
    key: 'none',
    next_action: 'none',
    review_state: null,
    safe_for_agent: false,
    command: null,
    api: null,
    task: null,
    reason: 'no_review_lane_action',
    proof_boundary_blocked: null,
    human_accept_waiting: null,
  };
}

function taskReviewLaneDrainReport(taskDb, db, args = [], options = {}) {
  const owner = options.owner || flag(args, '--as') || flag(args, '--owner') || DEFAULT_OWNER;
  const reviewer = reviewActor(options.reviewer || flag(args, '--reviewer') || flag(args, '--as-reviewer') || 'codex-review');
  const all = options.all !== undefined ? Boolean(options.all) : hasFlag(args, '--all');
  const everywhere = taskScopeEverywhere(args, options);
  const limit = options.limit !== undefined ? options.limit : taskQueueLimit(args);
  const scope = normalizeTaskQueueScope(options.scope || taskQueueScopeFromArgs(args));
  const capabilitiesCheck = taskCapabilitiesCheckReport(taskDb, db, [], {
    owner,
    reviewer,
    all,
    everywhere,
    limit,
    scope,
  });
  const { outPath, current } = buildTaskCurrent(taskDb, db, [], {
    owner,
    reviewer,
    all,
    everywhere,
    limit,
    scope,
    excludeTaskIds: options.excludeTaskIds,
  });
  const reviewStateActions = current.review_state_actions || {};
  const drain = taskReviewLaneDrainSelection(reviewStateActions, capabilitiesCheck);
  return {
    schema: 'atris.task_review_lane_drain.v1',
    generated_at: new Date().toISOString(),
    ok: Boolean(capabilitiesCheck.ok),
    action: 'review_lane_drain',
    projection_path: outPath,
    selected_task_id: drain.task ? drain.task.id : null,
    selected_ref: drain.task ? drain.task.ref : null,
    selected_next_key: drain.task ? drain.key : null,
    scope: current.scope,
    owner: String(owner || DEFAULT_OWNER),
    reviewer,
    capabilities_check: {
      schema: capabilitiesCheck.schema,
      ok: capabilitiesCheck.ok,
      summary: capabilitiesCheck.summary,
      checks: capabilitiesCheck.checks,
      safety: capabilitiesCheck.safety,
    },
    review_state_counts: current.review_state_counts,
    review_state_actions: reviewStateActions,
    drain,
    safety: {
      read_only: true,
      mutates_task_db: false,
      writes_projection: true,
      human_accept: false,
      xp_after_human_accept: true,
      safe_to_execute_next_action: Boolean(drain.safe_for_agent && drain.command),
    },
  };
}

function cmdReviewLaneDrain(args) {
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const report = taskReviewLaneDrainReport(taskDb, db, args);
  if (wantsJson(args)) {
    printJson(report);
    if (!report.ok) process.exit(1);
    return;
  }
  console.log(`TASK REVIEW LANE DRAIN ${report.ok ? 'ok' : 'failed'}`);
  console.log(`next: ${report.drain.next_action}`);
  console.log(`safe_for_agent: ${report.drain.safe_for_agent ? 'true' : 'false'}`);
  console.log(`command: ${report.drain.command || 'none'}`);
  if (!report.ok) process.exit(1);
}

function taskReviewLaneActOptionsFromArgs(args = []) {
  return {
    owner: flag(args, '--as') || flag(args, '--owner') || DEFAULT_OWNER,
    reviewer: reviewActor(flag(args, '--reviewer') || flag(args, '--as-reviewer') || 'codex-review'),
    all: hasFlag(args, '--all'),
    everywhere: hasFlag(args, '--everywhere'),
    limit: taskQueueLimit(args),
    scope: taskQueueScopeFromArgs(args),
    dryRun: hasFlag(args, '--dry-run'),
  };
}

function taskReviewLaneActOptionsFromBody(body = {}, searchParams = new URLSearchParams()) {
  const queryScope = taskQueueScopeFromSearchParams(searchParams);
  const bodyScope = taskQueueScopeFromBody(body);
  const queryOwner = searchParams.get('owner') || searchParams.get('as') || searchParams.get('actor');
  const queryReviewer = searchParams.get('reviewer') || searchParams.get('as_reviewer') || searchParams.get('as-reviewer');
  const limitParam = searchParams.get('limit') || body.limit;
  const limit = limitParam ? Number(limitParam) : 8;
  return {
    owner: String(queryOwner || body.owner || body.as || body.actor || DEFAULT_OWNER),
    reviewer: reviewActor(queryReviewer || body.reviewer || body.review_actor || body.reviewActor || 'codex-review'),
    all: searchParams.get('all') === '1' || searchParams.get('all') === 'true' || Boolean(body.all),
    everywhere: searchParams.get('everywhere') === '1' || searchParams.get('everywhere') === 'true' || Boolean(body.everywhere),
    limit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 8,
    scope: mergeTaskQueueScopes(queryScope, bodyScope),
    dryRun: searchParams.get('dry_run') === '1'
      || searchParams.get('dry-run') === '1'
      || searchParams.get('dryRun') === 'true'
      || Boolean(body.dry_run || body.dryRun),
  };
}

// Evidence gate for the lane's own second review pass: every receipt named in
// the proof must exist on disk and carry an explicit passing verifier state.
// Prose-only proof, missing receipts, or unknown verifier state never certify.
function autoReviewableEvidence(proofText, root = process.cwd()) {
  const evidence = extractReceiptEvidence(proofText, root);
  if (!evidence || evidence.missing.length || !evidence.receipts.length) return { ok: false, evidence };
  return { ok: evidence.receipts.every((entry) => entry.verifier_passed === true), evidence };
}

function autoReviewPendingReviewTask(taskDb, db, taskId, { reviewer = 'codex-review' } = {}) {
  const actor = reviewActor(reviewer);
  const task = taskDetail(taskDb, db, taskId);
  if (!task) return { acted: false, reason: 'not_found' };
  if (task.status !== 'review') return { acted: false, reason: `not_reviewable_${task.status}` };
  const metadata = task.metadata || {};
  const review = task.review || {};
  if (review.agent_certified === true || metadata.agent_certified === true) {
    return { acted: false, reason: 'already_agent_certified' };
  }
  const proof = String(review.proof || metadata.latest_agent_proof || '').trim();
  const { ok, evidence } = autoReviewableEvidence(proof);
  if (!ok) return { acted: false, reason: AUTO_REVIEW_NO_GREEN_EVIDENCE_REASON, evidence };
  const reviewed = taskDb.reviewTask(db, {
    id: taskId,
    actor,
    reward: 0,
    proof,
    lesson: `auto-review: receipts verified passing on disk: ${evidence.receipts.map((entry) => entry.path).join(', ')}`,
  });
  if (!reviewed.reviewed) return { acted: false, reason: reviewed.reason || 'auto_review_failed' };
  const { outPath } = writeDefaultProjection(taskDb, db);
  return {
    acted: true,
    reason: null,
    auto_review: {
      reviewer: actor,
      receipts: evidence.receipts.map((entry) => entry.path),
      review_pass_count: reviewed.event?.payload?.review_pass_count ?? null,
      agent_certified: reviewed.event?.payload?.agent_certified === true,
    },
    evidence,
    projection_path: outPath,
  };
}

function taskReviewLaneAct(taskDb, db, options = {}) {
  const owner = String(options.owner || DEFAULT_OWNER);
  const reviewer = reviewActor(options.reviewer || 'codex-review');
  const scope = normalizeTaskQueueScope(options.scope || {});
  const dryRun = Boolean(options.dryRun);
  const drainReport = taskReviewLaneDrainReport(taskDb, db, [], {
    owner,
    reviewer,
    all: Boolean(options.all),
    everywhere: Boolean(options.everywhere),
    limit: options.limit !== undefined ? options.limit : 8,
    scope,
    excludeTaskIds: options.excludeTaskIds,
  });
  const drain = drainReport.drain || null;
  const decision = taskReviewLaneActDecision(drain || {});
  const base = {
    schema: 'atris.task_review_lane_act.v1',
    generated_at: new Date().toISOString(),
    action: 'review_lane_act',
    selected_task_id: drain && drain.task ? drain.task.id : null,
    selected_ref: drain && drain.task ? drain.task.ref : null,
    selected_next_key: drain && drain.task ? drain.key : null,
    owner,
    reviewer,
    scope,
    dry_run: dryRun,
    drain,
    drain_report: drainReport,
    decision,
    safety: {
      read_only: dryRun,
      mutates_task_db: dryRun ? false : 'conditional',
      writes_projection: true,
      human_accept: false,
      xp_after_human_accept: true,
      allowed_actions: ['review_chat', 'continue_work', 'auto_review'],
    },
  };
  if (!drainReport.ok) {
    return {
      ...base,
      ok: false,
      acted: false,
      reason: 'capabilities_check_failed',
      detail: 'review-lane-act refuses to execute while capabilities-check is failing',
      status: 409,
    };
  }
  if (!decision.ok) {
    return {
      ...base,
      ok: false,
      acted: false,
      reason: decision.reason || 'unsafe_review_lane_action',
      detail: 'review-lane-act only executes review_chat or continue_work actions selected by review-lane-drain',
      status: 409,
    };
  }
  if (dryRun) {
    return {
      ...base,
      ok: true,
      acted: false,
      result: null,
      projection_path: drainReport.projection_path,
    };
  }
  try {
    if (decision.step_action === 'review_chat') {
      const result = appendTaskReviewChat(taskDb, db, decision.task_id, { reviewer });
      return {
        ...base,
        ok: true,
        acted: true,
        selected_action: 'review_chat',
        projection_path: result.projection_path,
        result,
      };
    }
    if (decision.step_action === 'continue_work') {
      const result = continueWorkForReviewTask(taskDb, db, decision.task_id, { owner });
      const created = Boolean(result && result.created);
      return {
        ...base,
        ok: true,
        acted: created,
        selected_action: 'continue_work',
        reason: created ? null : 'continue_work_reused_existing_follow_up',
        projection_path: result.projection_path,
        result,
      };
    }
    if (decision.step_action === 'auto_review') {
      const result = autoReviewPendingReviewTask(taskDb, db, decision.task_id, { reviewer });
      return {
        ...base,
        ok: true,
        acted: Boolean(result.acted),
        selected_action: 'auto_review',
        reason: result.acted ? null : result.reason,
        projection_path: result.projection_path || drainReport.projection_path,
        result,
      };
    }
  } catch (error) {
    return {
      ...base,
      ok: false,
      acted: false,
      selected_action: decision.step_action,
      reason: error.reason || 'review_lane_act_failed',
      detail: error.message,
      status: error.status || 409,
    };
  }
  return {
    ...base,
    ok: false,
    acted: false,
    reason: 'unsupported_review_lane_action',
    detail: `unsupported review-lane action: ${decision.step_action}`,
    status: 409,
  };
}

function cmdReviewLaneAct(args) {
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const result = taskReviewLaneAct(taskDb, db, taskReviewLaneActOptionsFromArgs(args));
  if (wantsJson(args)) {
    printJson(result);
    if (!result.ok) process.exit(1);
    return;
  }
  console.log(`TASK REVIEW LANE ACT ${result.ok ? 'ok' : 'blocked'}`);
  console.log(`next: ${result.drain ? result.drain.next_action : 'none'}`);
  console.log(`acted: ${result.acted ? 'true' : 'false'}`);
  console.log(`dry_run: ${result.dry_run ? 'true' : 'false'}`);
  if (result.reason) console.log(`reason: ${result.reason}`);
  if (!result.ok) process.exit(1);
}

function normalizeReviewLaneLoopMaxSteps(value) {
  const parsed = Number(value === undefined || value === null || value === true ? REVIEW_LANE_LOOP_DEFAULT_MAX_STEPS : value);
  if (!Number.isFinite(parsed)) return REVIEW_LANE_LOOP_DEFAULT_MAX_STEPS;
  return Math.max(1, Math.min(REVIEW_LANE_LOOP_MAX_STEPS, Math.floor(parsed)));
}

function taskReviewLaneLoopStopIsSafe(reason) {
  const expected = new Set([
    'dry_run_preview',
    PROOF_BOUNDARY_BLOCKED_REASON,
    'human_accept_waiting_is_human_only',
    PENDING_REVIEW_CHAT_STOP_REASON,
    AUTO_REVIEW_NO_GREEN_EVIDENCE_REASON,
    'no_review_lane_action',
    'continue_work_reused_existing_follow_up',
    'repeat_selection',
    'max_steps_reached',
  ]);
  return {
    ok: expected.has(reason),
    read_only: reason === 'dry_run_preview',
    human_accept: false,
  };
}

function taskReviewLaneActSelectionKey(act) {
  const decision = act && act.decision || {};
  if (!decision.step_action || !decision.task_id) return null;
  return `${decision.step_action}:${decision.task_id}`;
}

function taskReviewLaneLoopOptionsFromArgs(args = []) {
  return {
    ...taskReviewLaneActOptionsFromArgs(args),
    maxSteps: normalizeReviewLaneLoopMaxSteps(flag(args, '--max-steps') || flag(args, '--limit')),
  };
}

function taskReviewLaneLoopOptionsFromBody(body = {}, searchParams = new URLSearchParams()) {
  const options = taskReviewLaneActOptionsFromBody(body, searchParams);
  const maxSteps = searchParams.get('max_steps')
    || searchParams.get('max-steps')
    || searchParams.get('limit')
    || body.max_steps
    || body.maxSteps
    || body.limit;
  return {
    ...options,
    maxSteps: normalizeReviewLaneLoopMaxSteps(maxSteps),
  };
}

function compactReviewLaneLoopStep(index, act, { phase = 'act' } = {}) {
  return {
    index,
    phase,
    ok: Boolean(act && act.ok),
    acted: Boolean(act && act.acted),
    dry_run: Boolean(act && act.dry_run),
    selected_action: act && act.selected_action || null,
    reason: act && act.reason || null,
    decision: act && act.decision || null,
    drain: act && act.drain ? {
      next_action: act.drain.next_action,
      review_state: act.drain.review_state,
      safe_for_agent: act.drain.safe_for_agent,
      task: act.drain.task || null,
      reason: act.drain.reason || null,
      command: act.drain.command || null,
      api: act.drain.api || null,
    } : null,
    result: act && act.result ? {
      ok: act.result.ok,
      action: act.result.action,
      task_id: act.result.task_id,
      parent_task_id: act.result.parent_task_id,
      next_task_id: act.result.next_task_id,
      appended: act.result.appended,
      created: act.result.created,
      projection_path: act.result.projection_path,
    } : null,
  };
}

function taskReviewLaneLoop(taskDb, db, options = {}) {
  const owner = String(options.owner || DEFAULT_OWNER);
  const reviewer = reviewActor(options.reviewer || 'codex-review');
  const scope = normalizeTaskQueueScope(options.scope || {});
  const dryRun = Boolean(options.dryRun);
  const maxSteps = normalizeReviewLaneLoopMaxSteps(options.maxSteps);
  const steps = [];
  const seenActions = new Set();
  const excludeTaskIds = normalizeTaskIdSet(options.excludeTaskIds);
  let stoppedReason = 'max_steps_reached';
  let skippedNoEvidence = false;
  let status = 200;
  let finalDrain = null;
  let finalDecision = null;
  let projectionPath = null;

  for (let index = 1; index <= maxSteps; index += 1) {
	    const preview = taskReviewLaneAct(taskDb, db, {
	      owner,
	      reviewer,
	      all: Boolean(options.all),
	      everywhere: Boolean(options.everywhere),
	      limit: options.limit !== undefined ? options.limit : 8,
	      scope,
	      excludeTaskIds,
	      dryRun: true,
	    });
    finalDrain = preview.drain || null;
    finalDecision = preview.decision || null;
    projectionPath = preview.projection_path || projectionPath;

    if (!preview.ok) {
      stoppedReason = preview.reason || 'review_lane_act_failed';
      // An empty lane after evidence-less skips is the skips' story, not "no action".
      if (stoppedReason === 'no_review_lane_action' && skippedNoEvidence) {
        stoppedReason = AUTO_REVIEW_NO_GREEN_EVIDENCE_REASON;
      }
      status = taskReviewLaneLoopStopIsSafe(stoppedReason).ok ? 200 : preview.status || 409;
      steps.push(compactReviewLaneLoopStep(index, preview, { phase: 'preview' }));
      break;
    }

    const actionKey = taskReviewLaneActSelectionKey(preview);
    if (!actionKey) {
      stoppedReason = skippedNoEvidence ? AUTO_REVIEW_NO_GREEN_EVIDENCE_REASON : 'no_review_lane_action';
      steps.push(compactReviewLaneLoopStep(index, {
        ...preview,
        ok: true,
        acted: false,
        reason: stoppedReason,
      }, { phase: 'preview' }));
      break;
    }

    if (seenActions.has(actionKey)) {
      stoppedReason = 'repeat_selection';
      steps.push(compactReviewLaneLoopStep(index, {
        ...preview,
        reason: stoppedReason,
      }, { phase: 'preview' }));
      break;
    }
    seenActions.add(actionKey);

    if (dryRun) {
      stoppedReason = 'dry_run_preview';
      steps.push(compactReviewLaneLoopStep(index, preview, { phase: 'dry_run' }));
      break;
    }

	    const act = taskReviewLaneAct(taskDb, db, {
	      owner,
	      reviewer,
	      all: Boolean(options.all),
	      everywhere: Boolean(options.everywhere),
	      limit: options.limit !== undefined ? options.limit : 8,
	      scope,
	      excludeTaskIds,
	      dryRun: false,
	    });
    finalDrain = act.drain || finalDrain;
    finalDecision = act.decision || finalDecision;
    projectionPath = act.projection_path || act.result && act.result.projection_path || projectionPath;
	    const liveKey = taskReviewLaneActSelectionKey(act);
	    if (liveKey) seenActions.add(liveKey);
	    if (act.acted && act.decision && act.decision.task_id) excludeTaskIds.add(String(act.decision.task_id));
	    steps.push(compactReviewLaneLoopStep(index, act, { phase: 'act' }));

    if (!act.ok) {
      stoppedReason = act.reason || 'review_lane_act_failed';
      status = taskReviewLaneLoopStopIsSafe(stoppedReason).ok ? 200 : act.status || 409;
      break;
    }
    if (!act.acted) {
      // Evidence-less pending reviews must not head-block the lane: exclude the
      // task and keep draining whatever sits behind it.
      if (act.reason === AUTO_REVIEW_NO_GREEN_EVIDENCE_REASON && act.decision && act.decision.task_id) {
        excludeTaskIds.add(String(act.decision.task_id));
        skippedNoEvidence = true;
        continue;
      }
      stoppedReason = act.reason || 'no_review_lane_action';
      break;
    }
  }

  const actedCount = steps.filter(step => step.acted).length;
  const stopSafety = taskReviewLaneLoopStopIsSafe(stoppedReason);
  return {
    schema: 'atris.task_review_lane_loop.v1',
    generated_at: new Date().toISOString(),
    ok: status < 400 || stopSafety.ok,
    action: 'review_lane_loop',
    owner,
    reviewer,
    scope,
    dry_run: dryRun,
    max_steps: maxSteps,
    acted_count: actedCount,
    stopped_reason: stoppedReason,
    stopped_on: finalDrain ? finalDrain.next_action : null,
    final_decision: finalDecision,
    final_drain: finalDrain,
    steps,
    status,
    projection_path: projectionPath,
    safety: {
      read_only: dryRun,
      mutates_task_db: dryRun ? false : 'conditional',
      writes_projection: true,
      human_accept: false,
      xp_after_human_accept: true,
      max_steps_cap: REVIEW_LANE_LOOP_MAX_STEPS,
      repeat_selection_guard: true,
    },
  };
}

function cmdReviewLaneLoop(args) {
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const result = taskReviewLaneLoop(taskDb, db, taskReviewLaneLoopOptionsFromArgs(args));
  if (wantsJson(args)) {
    printJson(result);
    if (!result.ok) process.exit(1);
    return;
  }
  console.log(`TASK REVIEW LANE LOOP ${result.ok ? 'ok' : 'blocked'}`);
  console.log(`acted: ${result.acted_count}`);
  console.log(`stopped: ${result.stopped_reason}`);
  console.log(`dry_run: ${result.dry_run ? 'true' : 'false'}`);
  if (!result.ok) process.exit(1);
}

function normalizeReviewLaneRunMaxRuns(value) {
  const parsed = Number(value === undefined || value === null || value === true ? REVIEW_LANE_RUN_DEFAULT_MAX_RUNS : value);
  if (!Number.isFinite(parsed)) return REVIEW_LANE_RUN_DEFAULT_MAX_RUNS;
  return Math.max(1, Math.min(REVIEW_LANE_RUN_MAX_RUNS, Math.floor(parsed)));
}

function taskReviewLaneRunOptionsFromArgs(args = []) {
  return {
    ...taskReviewLaneLoopOptionsFromArgs(args),
    maxRuns: normalizeReviewLaneRunMaxRuns(flag(args, '--max-runs') || flag(args, '--runs')),
  };
}

function taskReviewLaneRunOptionsFromBody(body = {}, searchParams = new URLSearchParams()) {
  const options = taskReviewLaneLoopOptionsFromBody(body, searchParams);
  const maxRuns = searchParams.get('max_runs')
    || searchParams.get('max-runs')
    || searchParams.get('runs')
    || body.max_runs
    || body.maxRuns
    || body.runs;
  return {
    ...options,
    maxRuns: normalizeReviewLaneRunMaxRuns(maxRuns),
  };
}

function taskReviewLaneRunStopIsSafe(reason) {
  const expected = new Set([
    'dry_run_preview',
    PROOF_BOUNDARY_BLOCKED_REASON,
    'human_accept_waiting_is_human_only',
    PENDING_REVIEW_CHAT_STOP_REASON,
    AUTO_REVIEW_NO_GREEN_EVIDENCE_REASON,
    'no_review_lane_action',
    'continue_work_reused_existing_follow_up',
    'repeat_selection',
    'max_runs_reached',
  ]);
  return {
    ok: expected.has(reason),
    write_receipt: reason !== 'dry_run_preview',
    human_accept: false,
  };
}

function reviewLaneRunReceiptPaths() {
  const stateDir = path.resolve(path.join('.atris', 'state'));
  return {
    stateDir,
    receiptPath: path.join(stateDir, 'review-lane-runs.jsonl'),
    latestPath: path.join(stateDir, 'review-lane-run.latest.json'),
  };
}

function compactReviewLaneRunLoop(index, loop) {
  return {
    index,
    ok: Boolean(loop && loop.ok),
    dry_run: Boolean(loop && loop.dry_run),
    max_steps: loop && loop.max_steps || null,
    acted_count: loop && loop.acted_count || 0,
    stopped_reason: loop && loop.stopped_reason || null,
    stopped_on: loop && loop.stopped_on || null,
    status: loop && loop.status || null,
    projection_path: loop && loop.projection_path || null,
    final_decision: loop && loop.final_decision || null,
    final_drain: loop && loop.final_drain ? {
      next_action: loop.final_drain.next_action,
      review_state: loop.final_drain.review_state,
      safe_for_agent: loop.final_drain.safe_for_agent,
      task: loop.final_drain.task || null,
      reason: loop.final_drain.reason || null,
      command: loop.final_drain.command || null,
      api: loop.final_drain.api || null,
    } : null,
    steps: Array.isArray(loop && loop.steps) ? loop.steps : [],
  };
}

function writeReviewLaneRunReceipt(receipt) {
  const { stateDir, receiptPath, latestPath } = reviewLaneRunReceiptPaths();
  fs.mkdirSync(stateDir, { recursive: true });
  fs.appendFileSync(receiptPath, `${JSON.stringify(receipt)}\n`, 'utf8');
  fs.writeFileSync(latestPath, JSON.stringify(receipt, null, 2) + '\n', 'utf8');
  return { receiptPath, latestPath };
}

function taskReviewLaneRun(taskDb, db, options = {}) {
  const owner = String(options.owner || DEFAULT_OWNER);
  const reviewer = reviewActor(options.reviewer || 'codex-review');
  const scope = normalizeTaskQueueScope(options.scope || {});
  const dryRun = Boolean(options.dryRun);
  const maxRuns = normalizeReviewLaneRunMaxRuns(options.maxRuns);
  const maxSteps = normalizeReviewLaneLoopMaxSteps(options.maxSteps);
  const runs = [];
  const excludeTaskIds = normalizeTaskIdSet(options.excludeTaskIds);
  let stoppedReason = 'max_runs_reached';
  let skippedNoEvidence = false;
  let stoppedOn = null;
  let status = 200;
  let projectionPath = null;

  for (let index = 1; index <= maxRuns; index += 1) {
	    const loop = taskReviewLaneLoop(taskDb, db, {
	      owner,
	      reviewer,
	      all: Boolean(options.all),
	      everywhere: Boolean(options.everywhere),
	      limit: options.limit !== undefined ? options.limit : 8,
	      scope,
	      excludeTaskIds,
	      dryRun,
	      maxSteps,
	    });
	    runs.push(compactReviewLaneRunLoop(index, loop));
	    for (const step of loop.steps || []) {
	      if (step && step.acted && step.decision && step.decision.task_id) {
	        excludeTaskIds.add(String(step.decision.task_id));
	      } else if (step && !step.acted && step.reason === AUTO_REVIEW_NO_GREEN_EVIDENCE_REASON
	        && step.decision && step.decision.task_id) {
	        // Refused auto-reviews stay refused for this run: exclude them so the
	        // next inner loop drains the tasks behind them instead of re-selecting.
	        excludeTaskIds.add(String(step.decision.task_id));
	        skippedNoEvidence = true;
	      }
	    }
    projectionPath = loop.projection_path || projectionPath;
    stoppedOn = loop.stopped_on || stoppedOn;

    if (dryRun) {
      stoppedReason = loop.stopped_reason || 'dry_run_preview';
      status = loop.status || 200;
      break;
    }

    if (!loop.ok) {
      stoppedReason = loop.stopped_reason || 'review_lane_loop_failed';
      status = loop.status || 409;
      break;
    }

    if (loop.stopped_reason !== 'max_steps_reached') {
      stoppedReason = loop.stopped_reason || 'no_review_lane_action';
      status = loop.status || 200;
      break;
    }
  }
  if (stoppedReason === 'no_review_lane_action' && skippedNoEvidence) {
    stoppedReason = AUTO_REVIEW_NO_GREEN_EVIDENCE_REASON;
  }

  const totalActedCount = runs.reduce((sum, run) => sum + (Number(run.acted_count) || 0), 0);
  const stopSafety = taskReviewLaneRunStopIsSafe(stoppedReason);
  const { receiptPath, latestPath } = reviewLaneRunReceiptPaths();
  const receipt = {
    schema: 'atris.task_review_lane_run.v1',
    generated_at: new Date().toISOString(),
    ok: status < 400 || stopSafety.ok,
    action: 'review_lane_run',
    owner,
    reviewer,
    scope,
    dry_run: dryRun,
    max_runs: maxRuns,
    max_steps: maxSteps,
    run_count: runs.length,
    total_acted_count: totalActedCount,
    stopped_reason: stoppedReason,
    stopped_on: stoppedOn,
    runs,
    status,
    projection_path: projectionPath,
    receipt_path: dryRun ? null : receiptPath,
    latest_receipt_path: dryRun ? null : latestPath,
    would_write_receipt_path: dryRun ? receiptPath : null,
    receipt_written: false,
    safety: {
      read_only: dryRun,
      mutates_task_db: dryRun ? false : 'conditional',
      writes_projection: true,
      writes_receipt: !dryRun,
      human_accept: false,
      xp_after_human_accept: true,
      max_runs_cap: REVIEW_LANE_RUN_MAX_RUNS,
      max_steps_cap: REVIEW_LANE_LOOP_MAX_STEPS,
      orchestrates: 'review_lane_loop',
    },
  };

  if (!dryRun) {
    receipt.receipt_written = true;
    const written = writeReviewLaneRunReceipt(receipt);
    receipt.receipt_path = written.receiptPath;
    receipt.latest_receipt_path = written.latestPath;
  }

  return receipt;
}

function cmdReviewLaneRun(args) {
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const result = taskReviewLaneRun(taskDb, db, taskReviewLaneRunOptionsFromArgs(args));
  if (wantsJson(args)) {
    printJson(result);
    if (!result.ok) process.exit(1);
    return;
  }
  console.log(`TASK REVIEW LANE RUN ${result.ok ? 'ok' : 'blocked'}`);
  console.log(`runs: ${result.run_count}`);
  console.log(`acted: ${result.total_acted_count}`);
  console.log(`stopped: ${result.stopped_reason}`);
  console.log(`dry_run: ${result.dry_run ? 'true' : 'false'}`);
  if (result.receipt_written) console.log(`receipt: ${result.receipt_path}`);
  if (!result.ok) process.exit(1);
}

module.exports = {
  bindMain, taskReviewLaneDrainTask, humanAcceptWaitingDrain, proofBoundaryBlockedDrain,
  pendingReviewChatDrain, taskReviewLaneDrainSelection, taskReviewLaneDrainReport,
  cmdReviewLaneDrain, taskReviewLaneActOptionsFromArgs, taskReviewLaneActOptionsFromBody,
  autoReviewableEvidence, autoReviewPendingReviewTask, taskReviewLaneAct, cmdReviewLaneAct,
  normalizeReviewLaneLoopMaxSteps, taskReviewLaneLoopStopIsSafe, taskReviewLaneActSelectionKey,
  taskReviewLaneLoopOptionsFromArgs, taskReviewLaneLoopOptionsFromBody, compactReviewLaneLoopStep,
  taskReviewLaneLoop, cmdReviewLaneLoop, normalizeReviewLaneRunMaxRuns,
  taskReviewLaneRunOptionsFromArgs, taskReviewLaneRunOptionsFromBody, taskReviewLaneRunStopIsSafe,
  reviewLaneRunReceiptPaths, compactReviewLaneRunLoop, writeReviewLaneRunReceipt, taskReviewLaneRun,
  cmdReviewLaneRun,
};
