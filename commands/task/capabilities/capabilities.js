'use strict';

// commands/task/capabilities/capabilities.js: The task API's capability contract and the self-check
// that proves the review lane behaves as the contract says.
// Owner: validator. Moved out of commands/task.js on 2026-11-16 by lib/split-file.js; read
// README.md first.

// Names borrowed from commands/task.js and other feature folders, set by bindMain().
let hasFlag, DEFAULT_OWNER, REVIEW_LANE_LOOP_DEFAULT_MAX_STEPS, REVIEW_LANE_LOOP_MAX_STEPS,
  REVIEW_LANE_RUN_DEFAULT_MAX_RUNS, REVIEW_LANE_RUN_MAX_RUNS, PENDING_REVIEW_CHAT_STOP_REASON,
  PROOF_BOUNDARY_BLOCKED_ACTION, PROOF_BOUNDARY_BLOCKED_REASON, TASK_REVIEW_STATE_LANES,
  TASK_REVIEW_STATE_ALIASES, getTaskDb, flag, taskScopeEverywhere, wantsJson, printJson,
  reviewActor, taskQueueLimit, normalizeTaskQueueScope, taskQueueScopeFromArgs,
  taskHasReviewFollowUpChild, buildTaskCurrent, taskReviewLaneDrainSelection,
  AUTO_REVIEW_NO_GREEN_EVIDENCE_REASON, normalizeReviewLaneLoopMaxSteps,
  taskReviewLaneLoopStopIsSafe, normalizeReviewLaneRunMaxRuns, taskReviewLaneRunStopIsSafe;
function bindMain(deps) {
  ({
    hasFlag, DEFAULT_OWNER, REVIEW_LANE_LOOP_DEFAULT_MAX_STEPS, REVIEW_LANE_LOOP_MAX_STEPS,
    REVIEW_LANE_RUN_DEFAULT_MAX_RUNS, REVIEW_LANE_RUN_MAX_RUNS, PENDING_REVIEW_CHAT_STOP_REASON,
    PROOF_BOUNDARY_BLOCKED_ACTION, PROOF_BOUNDARY_BLOCKED_REASON, TASK_REVIEW_STATE_LANES,
    TASK_REVIEW_STATE_ALIASES, getTaskDb, flag, taskScopeEverywhere, wantsJson, printJson,
    reviewActor, taskQueueLimit, normalizeTaskQueueScope, taskQueueScopeFromArgs,
    taskHasReviewFollowUpChild, buildTaskCurrent, taskReviewLaneDrainSelection,
    AUTO_REVIEW_NO_GREEN_EVIDENCE_REASON, normalizeReviewLaneLoopMaxSteps,
    taskReviewLaneLoopStopIsSafe, normalizeReviewLaneRunMaxRuns, taskReviewLaneRunStopIsSafe,
  } = deps);
}

function taskQueueCapabilities() {
  return {
    schema: 'atris.task_capabilities.v1',
    read_only_semantics: 'read_only means no task DB mutation; some read surfaces may refresh projection cache files',
    surfaces: {
      capabilities: {
        command: 'atris task capabilities --json',
        api: { method: 'GET', path: '/api/tasks/capabilities' },
        read_only: true,
        mutates_task_db: false,
        writes_projection: false,
        requires_task_db: {
          cli: false,
          api_route_handler: false,
          api_server: true,
        },
      },
      capabilities_check: {
        command: 'atris task capabilities-check --json',
        api: { method: 'GET', path: '/api/tasks/capabilities/check' },
        read_only: true,
        mutates_task_db: false,
        writes_projection: true,
        requires_task_db: true,
      },
      review_lane_drain: {
        command: 'atris task review-lane-drain --json',
        api: { method: 'GET', path: '/api/tasks/review-lane-drain' },
        read_only: true,
        mutates_task_db: false,
        writes_projection: true,
        requires_task_db: true,
        skips_existing_follow_up_children: true,
        output_fields: {
          identity: ['selected_task_id', 'selected_ref', 'selected_next_key'],
        },
      },
      review_lane_act: {
        command: 'atris task review-lane-act --json',
        api: { method: 'POST', path: '/api/tasks/review-lane-act' },
        read_only: false,
        mutates_task_db: 'conditional',
        writes_projection: true,
        requires_task_db: true,
        dry_run_flag: '--dry-run',
        allowed_actions: ['review_chat', 'continue_work'],
        blocked_actions: [PROOF_BOUNDARY_BLOCKED_ACTION, 'human_accept_waiting', 'pending_review_chat', 'capabilities_drift', 'none'],
        output_fields: {
          identity: ['selected_task_id', 'selected_ref', 'selected_next_key'],
        },
      },
      review_lane_loop: {
        command: 'atris task review-lane-loop --json',
        api: { method: 'POST', path: '/api/tasks/review-lane-loop' },
        read_only: false,
        mutates_task_db: 'conditional',
        writes_projection: true,
        requires_task_db: true,
        dry_run_flag: '--dry-run',
        max_steps_flag: '--max-steps <n>',
        default_max_steps: REVIEW_LANE_LOOP_DEFAULT_MAX_STEPS,
        max_steps_cap: REVIEW_LANE_LOOP_MAX_STEPS,
        orchestrates: 'review_lane_act',
        allowed_actions: ['review_chat', 'continue_work'],
        stopped_by: ['dry_run_preview', PROOF_BOUNDARY_BLOCKED_REASON, 'human_accept_waiting_is_human_only', PENDING_REVIEW_CHAT_STOP_REASON, 'capabilities_check_failed', 'no_review_lane_action', 'continue_work_reused_existing_follow_up', 'repeat_selection', 'max_steps_reached'],
        blocked_actions: [PROOF_BOUNDARY_BLOCKED_ACTION, 'human_accept_waiting', 'pending_review_chat'],
      },
      review_lane_run: {
        command: 'atris task review-lane-run --json',
        api: { method: 'POST', path: '/api/tasks/review-lane-run' },
        read_only: false,
        mutates_task_db: 'conditional',
        writes_projection: true,
        writes_receipt: true,
        receipt_path: '.atris/state/review-lane-runs.jsonl',
        latest_receipt_path: '.atris/state/review-lane-run.latest.json',
        requires_task_db: true,
        dry_run_flag: '--dry-run',
        max_runs_flag: '--max-runs <n>',
        max_steps_flag: '--max-steps <n>',
        default_max_runs: REVIEW_LANE_RUN_DEFAULT_MAX_RUNS,
        max_runs_cap: REVIEW_LANE_RUN_MAX_RUNS,
        default_max_steps: REVIEW_LANE_LOOP_DEFAULT_MAX_STEPS,
        max_steps_cap: REVIEW_LANE_LOOP_MAX_STEPS,
        orchestrates: 'review_lane_loop',
        allowed_actions: ['review_chat', 'continue_work'],
        stopped_by: ['dry_run_preview', PROOF_BOUNDARY_BLOCKED_REASON, 'human_accept_waiting_is_human_only', PENDING_REVIEW_CHAT_STOP_REASON, 'capabilities_check_failed', 'no_review_lane_action', 'continue_work_reused_existing_follow_up', 'repeat_selection', 'max_runs_reached'],
        blocked_actions: [PROOF_BOUNDARY_BLOCKED_ACTION, 'human_accept_waiting', 'pending_review_chat'],
      },
      current: {
        command: 'atris task current --review-state <lane> --json',
        api: { method: 'GET', path: '/api/tasks/current?review_state=<lane>' },
        read_only: true,
        mutates_task_db: false,
        writes_projection: true,
        requires_task_db: true,
        output_fields: {
          identity: ['selected_task_id', 'selected_ref', 'selected_next_key'],
        },
      },
      queue: {
        command: 'atris task queue --review-state <lane> --json',
        api: { method: 'GET', path: '/api/tasks/queue?review_state=<lane>' },
        read_only: true,
        mutates_task_db: false,
        writes_projection: true,
        requires_task_db: true,
        output_fields: {
          identity: ['selected_task_id', 'selected_ref', 'selected_next_key'],
        },
      },
    },
    filters: {
      review_state: {
        cli_flag: '--review-state <lane>',
        query: 'review_state=<lane>',
        accepted: [...TASK_REVIEW_STATE_LANES],
        aliases: { ...TASK_REVIEW_STATE_ALIASES },
      },
    },
    commands: {
      capabilities: 'atris task capabilities --json',
      capabilities_check: 'atris task capabilities-check --json',
      review_lane_drain: 'atris task review-lane-drain --json',
      review_lane_act: 'atris task review-lane-act --json',
      review_lane_loop: 'atris task review-lane-loop --json',
      review_lane_run: 'atris task review-lane-run --json',
      current: 'atris task current --review-state <lane> --json',
      queue: 'atris task queue --review-state <lane> --json',
      current_step: 'atris task current-step --review-state <lane> --json',
    },
    current_step: {
      api: { method: 'POST', path: '/api/tasks/current/step?review_state=<lane>' },
      output_fields: {
        identity: ['selected_task_id', 'selected_ref', 'selected_next_key'],
      },
      safety: {
        read_only: false,
        claims_work: 'conditional',
        claiming_stages: ['plan'],
        human_accept: false,
        xp_after_human_accept: true,
      },
      stage_safety: {
        backlog: { step_action: 'planned', claims_work: false },
        plan: { step_action: 'doing', claims_work: true },
        do: { step_action: 'ready', claims_work: false },
        review: { step_action: 'review_chat_or_continue_work_or_blocked', claims_work: false },
      },
      lanes: {
        'needs-agent': {
          selected_next_action: 'review_chat',
          step_action: 'review_chat',
          claims_work: false,
          safe_for_agent: true,
        },
        'continue-work': {
          selected_next_action: 'continue_work',
          step_action: 'continue_work',
          claims_work: false,
          safe_for_agent: true,
          creates_or_reuses_follow_up: true,
        },
        'proof-boundary-blocked': {
          selected_next_action: PROOF_BOUNDARY_BLOCKED_ACTION,
          step_action: null,
          claims_work: false,
          safe_for_agent: false,
          reason: PROOF_BOUNDARY_BLOCKED_REASON,
        },
        'human-accept-waiting': {
          selected_next_action: 'human_accept_waiting',
          step_action: null,
          claims_work: false,
          safe_for_agent: false,
          reason: 'agent_certified_waiting_human',
        },
        certified: {
          selected_next_action: ['continue_work', PROOF_BOUNDARY_BLOCKED_ACTION, 'human_accept_waiting'],
          step_action: 'depends_on_selected_next_action',
          claims_work: false,
          safe_for_agent: 'depends_on_selected_next_action',
        },
      },
    },
  };
}

function taskCapabilitiesContract() {
  return taskQueueCapabilities();
}

function stableCapabilityJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableCapabilityJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableCapabilityJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function capabilityValuesEqual(left, right) {
  return stableCapabilityJson(left) === stableCapabilityJson(right);
}

function capabilityCheck(name, ok, detail = null) {
  return {
    name,
    ok: Boolean(ok),
    ...(detail ? { detail } : {}),
  };
}

function reviewLaneDrainBehaviorConformance() {
  const needsAgent = {
    id: 'needs-agent-id',
    ref: 'OBL-NEEDS',
    title: 'Needs agent review',
    status: 'review',
    next_action: 'review_chat',
    command: 'atris task review-chat OBL-NEEDS --as codex-review',
    api: { method: 'POST', path: '/api/tasks/needs-agent-id/review-chat' },
  };
  const continueWork = {
    id: 'continue-work-id',
    ref: 'OBL-CONTINUE',
    title: 'Continue certified work',
    status: 'review',
    next_action: 'continue_work',
    command: 'atris task continue-work OBL-CONTINUE --as codex --json',
    api: { method: 'POST', path: '/api/tasks/continue-work-id/continue-work' },
  };
  const proofBoundaryBlocked = {
    id: 'proof-boundary-id',
    ref: 'OBL-BOUNDARY',
    title: 'Stale PR proof boundary',
    status: 'review',
    next_action: PROOF_BOUNDARY_BLOCKED_ACTION,
    command: 'atris task revise OBL-BOUNDARY --note "<replace stale PR proof>"',
    revise_command: 'atris task revise OBL-BOUNDARY --note "<replace stale PR proof>"',
    api: null,
  };
  const humanAcceptWaiting = {
    id: 'human-accept-id',
    ref: 'OBL-HUMAN',
    title: 'Human accept only',
    status: 'review',
    next_action: 'human_accept_waiting',
    command: 'atris task accept OBL-HUMAN',
    api: { method: 'POST', path: '/api/tasks/human-accept-id/accept' },
  };
  const capabilityOk = { ok: true };
  const withAll = taskReviewLaneDrainSelection({
    needs_agent: needsAgent,
    continue_work: continueWork,
    human_accept_waiting: humanAcceptWaiting,
  }, capabilityOk);
  const continueOnly = taskReviewLaneDrainSelection({
    continue_work: continueWork,
    human_accept_waiting: humanAcceptWaiting,
  }, capabilityOk);
  const humanOnly = taskReviewLaneDrainSelection({
    human_accept_waiting: humanAcceptWaiting,
  }, capabilityOk);
  const proofBoundaryOnly = taskReviewLaneDrainSelection({
    proof_boundary_blocked: proofBoundaryBlocked,
    human_accept_waiting: humanAcceptWaiting,
  }, capabilityOk);
  const drift = taskReviewLaneDrainSelection({
    needs_agent: needsAgent,
    continue_work: continueWork,
    proof_boundary_blocked: proofBoundaryBlocked,
    human_accept_waiting: humanAcceptWaiting,
  }, { ok: false });
  const followedContinueWork = taskHasReviewFollowUpChild({
    ...continueWork,
    review: { next_task: 'Add child follow-up' },
    lineage: { child_task_ids: ['child-task-id'], child_titles: ['Add child follow-up'] },
  });
  const retitledContinueWork = taskHasReviewFollowUpChild({
    ...continueWork,
    review: { next_task: 'Add newer follow-up wording' },
    lineage: { child_task_ids: ['child-task-id'], child_titles: ['Add child follow-up'] },
  });
  const freshContinueWork = !taskHasReviewFollowUpChild({
    ...continueWork,
    review: { next_task: 'Add child follow-up' },
    lineage: { child_task_ids: [], child_titles: [] },
  });
  const checks = {
    prefers_review_chat: withAll.next_action === 'review_chat'
      && withAll.review_state === 'needs-agent'
      && withAll.command === needsAgent.command
      && capabilityValuesEqual(withAll.api, needsAgent.api),
    uses_continue_work_from_review_state_actions: continueOnly.next_action === 'continue_work'
      && continueOnly.review_state === 'continue-work'
      && continueOnly.command === continueWork.command
      && capabilityValuesEqual(continueOnly.api, continueWork.api),
    selected_human_accept_waiting_is_non_executable: humanOnly.next_action === 'human_accept_waiting'
      && humanOnly.safe_for_agent === false
      && humanOnly.command === null
      && humanOnly.api === null
      && humanOnly.human_accept_waiting
      && humanOnly.human_accept_waiting.command === null
      && humanOnly.human_accept_waiting.api === null,
    selected_proof_boundary_is_non_executable: proofBoundaryOnly.next_action === PROOF_BOUNDARY_BLOCKED_ACTION
      && proofBoundaryOnly.review_state === 'proof-boundary-blocked'
      && proofBoundaryOnly.safe_for_agent === false
      && proofBoundaryOnly.command === null
      && proofBoundaryOnly.api === null
      && proofBoundaryOnly.proof_boundary_blocked
      && proofBoundaryOnly.proof_boundary_blocked.revise_command === proofBoundaryBlocked.revise_command,
    capability_drift_blocks_execution: drift.next_action === 'capabilities_drift'
      && drift.safe_for_agent === false
      && drift.command === null
      && drift.api === null,
    skips_continue_work_with_existing_follow_up_child: followedContinueWork && retitledContinueWork && freshContinueWork,
  };
  return {
    ok: Object.values(checks).every(Boolean),
    checks,
  };
}

function taskReviewLaneActDecision(drain = {}) {
  const nextAction = drain && drain.next_action;
  if (nextAction === 'pending_review_chat') {
    // The posted review chat is answerable by the lane itself, but only with
    // disk-backed evidence: the act step re-checks receipts before any pass.
    if (!drain.task || !drain.task.id) {
      return {
        ok: false,
        step_action: nextAction,
        reason: drain && drain.reason || PENDING_REVIEW_CHAT_STOP_REASON,
      };
    }
    return {
      ok: true,
      step_action: 'auto_review',
      task_id: drain.task.id,
      command: null,
      api: null,
    };
  }
  if (nextAction !== 'review_chat' && nextAction !== 'continue_work') {
    return {
      ok: false,
      step_action: nextAction || 'none',
      reason: drain && drain.reason || 'unsafe_review_lane_action',
    };
  }
  if (!drain.safe_for_agent || !drain.command || !drain.task || !drain.task.id) {
    return {
      ok: false,
      step_action: nextAction,
      reason: 'unsafe_review_lane_action',
    };
  }
  return {
    ok: true,
    step_action: nextAction,
    task_id: drain.task.id,
    command: drain.command,
    api: drain.api || null,
  };
}

function reviewLaneActBehaviorConformance() {
  const reviewChat = taskReviewLaneActDecision({
    next_action: 'review_chat',
    safe_for_agent: true,
    command: 'atris task review-chat OBL-NEEDS --as codex-review',
    api: { method: 'POST', path: '/api/tasks/needs-agent-id/review-chat' },
    task: { id: 'needs-agent-id' },
  });
  const continueWork = taskReviewLaneActDecision({
    next_action: 'continue_work',
    safe_for_agent: true,
    command: 'atris task continue-work OBL-CONTINUE --as codex --json',
    api: { method: 'POST', path: '/api/tasks/continue-work-id/continue-work' },
    task: { id: 'continue-work-id' },
  });
  const humanAccept = taskReviewLaneActDecision({
    next_action: 'human_accept_waiting',
    safe_for_agent: true,
    command: 'atris task accept OBL-HUMAN',
    api: { method: 'POST', path: '/api/tasks/human-accept-id/accept' },
    task: { id: 'human-accept-id' },
  });
  const drift = taskReviewLaneActDecision({
    next_action: 'capabilities_drift',
    safe_for_agent: false,
    command: null,
    api: null,
    task: null,
    reason: 'capability_conformance_failed',
  });
  const proofBoundary = taskReviewLaneActDecision({
    next_action: PROOF_BOUNDARY_BLOCKED_ACTION,
    safe_for_agent: false,
    command: null,
    api: null,
    task: { id: 'proof-boundary-id' },
    reason: PROOF_BOUNDARY_BLOCKED_REASON,
  });
  const pendingReviewChat = taskReviewLaneActDecision({
    next_action: 'pending_review_chat',
    safe_for_agent: false,
    command: null,
    api: null,
    task: { id: 'pending-review-chat-id' },
    reason: PENDING_REVIEW_CHAT_STOP_REASON,
  });
  const pendingReviewChatNoTask = taskReviewLaneActDecision({
    next_action: 'pending_review_chat',
    safe_for_agent: false,
    command: null,
    api: null,
    task: null,
    reason: PENDING_REVIEW_CHAT_STOP_REASON,
  });
  const checks = {
    allows_review_chat: reviewChat.ok === true && reviewChat.step_action === 'review_chat',
    allows_continue_work: continueWork.ok === true && continueWork.step_action === 'continue_work',
    allows_evidence_gated_auto_review: pendingReviewChat.ok === true
      && pendingReviewChat.step_action === 'auto_review'
      && pendingReviewChat.command === null,
    blocks_auto_review_without_task: pendingReviewChatNoTask.ok === false
      && pendingReviewChatNoTask.reason === PENDING_REVIEW_CHAT_STOP_REASON,
    blocks_human_accept_waiting_even_if_marked_safe: humanAccept.ok === false && humanAccept.reason !== null,
    blocks_proof_boundary_blocked: proofBoundary.ok === false && proofBoundary.reason === PROOF_BOUNDARY_BLOCKED_REASON,
    blocks_capability_drift: drift.ok === false && drift.reason === 'capability_conformance_failed',
  };
  return {
    ok: Object.values(checks).every(Boolean),
    checks,
  };
}

function reviewLaneLoopBehaviorConformance() {
  const dryRun = taskReviewLaneLoopStopIsSafe('dry_run_preview');
  const humanOnly = taskReviewLaneLoopStopIsSafe('human_accept_waiting_is_human_only');
  const proofBoundary = taskReviewLaneLoopStopIsSafe(PROOF_BOUNDARY_BLOCKED_REASON);
  const pendingReviewChat = taskReviewLaneLoopStopIsSafe(PENDING_REVIEW_CHAT_STOP_REASON);
  const autoReviewNoEvidence = taskReviewLaneLoopStopIsSafe(AUTO_REVIEW_NO_GREEN_EVIDENCE_REASON);
  const noAction = taskReviewLaneLoopStopIsSafe('no_review_lane_action');
  const repeated = taskReviewLaneLoopStopIsSafe('repeat_selection');
  const drift = taskReviewLaneLoopStopIsSafe('capabilities_check_failed');
  const maxSteps = normalizeReviewLaneLoopMaxSteps(99) === REVIEW_LANE_LOOP_MAX_STEPS
    && normalizeReviewLaneLoopMaxSteps(0) === 1
    && normalizeReviewLaneLoopMaxSteps(undefined) === REVIEW_LANE_LOOP_DEFAULT_MAX_STEPS;
  const checks = {
    dry_run_stops_without_mutation: dryRun.ok === true && dryRun.read_only === true,
    human_accept_waiting_stops_without_execution: humanOnly.ok === true && humanOnly.human_accept === false,
    proof_boundary_blocked_stops_without_execution: proofBoundary.ok === true && proofBoundary.human_accept === false,
    pending_review_chat_stops_without_execution: pendingReviewChat.ok === true && pendingReviewChat.human_accept === false,
    auto_review_without_evidence_stops_without_certification: autoReviewNoEvidence.ok === true && autoReviewNoEvidence.human_accept === false,
    no_action_stops_without_execution: noAction.ok === true,
    repeat_selection_stops_before_duplicate_execution: repeated.ok === true,
    capability_drift_blocks_loop: drift.ok === false,
    max_steps_are_bounded: maxSteps,
  };
  return {
    ok: Object.values(checks).every(Boolean),
    checks,
  };
}

function reviewLaneRunBehaviorConformance() {
  const dryRun = taskReviewLaneRunStopIsSafe('dry_run_preview');
  const humanOnly = taskReviewLaneRunStopIsSafe('human_accept_waiting_is_human_only');
  const proofBoundary = taskReviewLaneRunStopIsSafe(PROOF_BOUNDARY_BLOCKED_REASON);
  const pendingReviewChat = taskReviewLaneRunStopIsSafe(PENDING_REVIEW_CHAT_STOP_REASON);
  const autoReviewNoEvidence = taskReviewLaneRunStopIsSafe(AUTO_REVIEW_NO_GREEN_EVIDENCE_REASON);
  const noAction = taskReviewLaneRunStopIsSafe('no_review_lane_action');
  const reusedFollowUp = taskReviewLaneRunStopIsSafe('continue_work_reused_existing_follow_up');
  const repeated = taskReviewLaneRunStopIsSafe('repeat_selection');
  const drift = taskReviewLaneRunStopIsSafe('capabilities_check_failed');
  const maxRuns = taskReviewLaneRunStopIsSafe('max_runs_reached');
  const boundedRuns = normalizeReviewLaneRunMaxRuns(99) === REVIEW_LANE_RUN_MAX_RUNS
    && normalizeReviewLaneRunMaxRuns(0) === 1
    && normalizeReviewLaneRunMaxRuns(undefined) === REVIEW_LANE_RUN_DEFAULT_MAX_RUNS;
  const checks = {
    dry_run_stops_without_receipt: dryRun.ok === true && dryRun.write_receipt === false,
    human_accept_waiting_stops_without_execution: humanOnly.ok === true && humanOnly.human_accept === false,
    proof_boundary_blocked_stops_without_execution: proofBoundary.ok === true && proofBoundary.human_accept === false,
    pending_review_chat_stops_without_execution: pendingReviewChat.ok === true && pendingReviewChat.human_accept === false,
    auto_review_without_evidence_stops_without_certification: autoReviewNoEvidence.ok === true && autoReviewNoEvidence.human_accept === false,
    no_action_stops_without_execution: noAction.ok === true,
    reused_follow_up_stops_without_duplicate_action: reusedFollowUp.ok === true,
    repeat_selection_stops_before_duplicate_execution: repeated.ok === true,
    capability_drift_blocks_run: drift.ok === false,
    max_runs_are_bounded: maxRuns.ok === true && boundedRuns,
  };
  return {
    ok: Object.values(checks).every(Boolean),
    checks,
  };
}

function taskCapabilitiesCheckReport(taskDb, db, args = [], options = {}) {
  const owner = options.owner || flag(args, '--as') || flag(args, '--owner') || DEFAULT_OWNER;
  const reviewer = reviewActor(options.reviewer || flag(args, '--reviewer') || flag(args, '--as-reviewer') || 'codex-review');
  const all = options.all !== undefined ? Boolean(options.all) : hasFlag(args, '--all');
  const everywhere = taskScopeEverywhere(args, options);
  const limit = options.limit !== undefined ? options.limit : taskQueueLimit(args);
  const scope = normalizeTaskQueueScope(options.scope || taskQueueScopeFromArgs(args));
  const standalone = taskCapabilitiesContract();
  const { outPath, current } = buildTaskCurrent(taskDb, db, [], {
    owner,
    reviewer,
    all,
    everywhere,
    limit,
    scope,
  });
  const acceptedLanes = standalone.filters.review_state.accepted || [];
  const currentStepLanes = standalone.current_step.lanes || {};
  const currentStepIdentityFields = standalone.current_step.output_fields?.identity || [];
  const currentIdentityFields = standalone.surfaces.current.output_fields?.identity || [];
  const queueIdentityFields = standalone.surfaces.queue.output_fields?.identity || [];
  const reviewLaneDrainIdentityFields = standalone.surfaces.review_lane_drain.output_fields?.identity || [];
  const reviewLaneActIdentityFields = standalone.surfaces.review_lane_act.output_fields?.identity || [];
  const drainBehavior = reviewLaneDrainBehaviorConformance();
  const actBehavior = reviewLaneActBehaviorConformance();
  const loopBehavior = reviewLaneLoopBehaviorConformance();
  const runBehavior = reviewLaneRunBehaviorConformance();
  const checks = [
    capabilityCheck('current_capabilities_match_standalone', capabilityValuesEqual(current.capabilities, standalone)),
    capabilityCheck('queue_capabilities_match_standalone', capabilityValuesEqual(current.queue.capabilities, standalone)),
    capabilityCheck('current_queue_capabilities_match', capabilityValuesEqual(current.capabilities, current.queue.capabilities)),
    capabilityCheck(
      'review_state_lanes_cover_current_step_lanes',
      acceptedLanes.every(lane => Object.prototype.hasOwnProperty.call(currentStepLanes, lane)),
      { accepted: acceptedLanes, current_step_lanes: Object.keys(currentStepLanes) }
    ),
    capabilityCheck(
      'current_step_declares_mutating_conditional_claims',
      standalone.current_step.safety.read_only === false
        && standalone.current_step.safety.claims_work === 'conditional'
        && Array.isArray(standalone.current_step.safety.claiming_stages)
        && standalone.current_step.safety.claiming_stages.includes('plan')
    ),
    capabilityCheck(
      'current_step_never_human_accepts',
      standalone.current_step.safety.human_accept === false
        && standalone.current_step.safety.xp_after_human_accept === true
        && standalone.current_step.lanes['human-accept-waiting']
        && standalone.current_step.lanes['human-accept-waiting'].safe_for_agent === false
    ),
    capabilityCheck(
      'current_step_declares_identity_output_fields',
      ['selected_task_id', 'selected_ref', 'selected_next_key'].every(field => currentStepIdentityFields.includes(field)),
      { identity: currentStepIdentityFields }
    ),
    capabilityCheck(
      'current_and_queue_declare_identity_output_fields',
      ['selected_task_id', 'selected_ref', 'selected_next_key'].every(field => currentIdentityFields.includes(field) && queueIdentityFields.includes(field)),
      { current: currentIdentityFields, queue: queueIdentityFields }
    ),
    capabilityCheck(
      'review_lane_drain_declares_identity_output_fields',
      ['selected_task_id', 'selected_ref', 'selected_next_key'].every(field => reviewLaneDrainIdentityFields.includes(field)),
      { identity: reviewLaneDrainIdentityFields }
    ),
    capabilityCheck(
      'review_lane_act_declares_identity_output_fields',
      ['selected_task_id', 'selected_ref', 'selected_next_key'].every(field => reviewLaneActIdentityFields.includes(field)),
      { identity: reviewLaneActIdentityFields }
    ),
    capabilityCheck(
      'read_only_projection_semantics_declared',
      standalone.surfaces.capabilities.mutates_task_db === false
        && standalone.surfaces.capabilities.writes_projection === false
        && standalone.surfaces.capabilities_check.mutates_task_db === false
        && standalone.surfaces.capabilities_check.writes_projection === true
        && standalone.surfaces.review_lane_drain.mutates_task_db === false
        && standalone.surfaces.review_lane_drain.writes_projection === true
        && standalone.surfaces.review_lane_act.mutates_task_db === 'conditional'
        && standalone.surfaces.review_lane_act.writes_projection === true
        && standalone.surfaces.review_lane_loop.mutates_task_db === 'conditional'
        && standalone.surfaces.review_lane_loop.writes_projection === true
        && standalone.surfaces.review_lane_run.mutates_task_db === 'conditional'
        && standalone.surfaces.review_lane_run.writes_projection === true
        && standalone.surfaces.review_lane_run.writes_receipt === true
        && standalone.surfaces.current.mutates_task_db === false
        && standalone.surfaces.current.writes_projection === true
        && standalone.surfaces.queue.mutates_task_db === false
        && standalone.surfaces.queue.writes_projection === true
    ),
    capabilityCheck(
      'capabilities_check_surface_declared',
      standalone.commands.capabilities_check === 'atris task capabilities-check --json'
        && standalone.surfaces.capabilities_check.command === 'atris task capabilities-check --json'
        && standalone.surfaces.capabilities_check.api.path === '/api/tasks/capabilities/check'
        && standalone.surfaces.capabilities_check.requires_task_db === true
    ),
    capabilityCheck(
      'review_lane_drain_surface_declared',
      standalone.commands.review_lane_drain === 'atris task review-lane-drain --json'
        && standalone.surfaces.review_lane_drain.command === 'atris task review-lane-drain --json'
        && standalone.surfaces.review_lane_drain.api.path === '/api/tasks/review-lane-drain'
        && standalone.surfaces.review_lane_drain.requires_task_db === true
        && standalone.surfaces.review_lane_drain.skips_existing_follow_up_children === true
    ),
    capabilityCheck(
      'review_lane_drain_behavior_conforms',
      drainBehavior.ok,
      drainBehavior.checks
    ),
    capabilityCheck(
      'review_lane_act_surface_declared',
      standalone.commands.review_lane_act === 'atris task review-lane-act --json'
        && standalone.surfaces.review_lane_act.command === 'atris task review-lane-act --json'
        && standalone.surfaces.review_lane_act.api.method === 'POST'
        && standalone.surfaces.review_lane_act.api.path === '/api/tasks/review-lane-act'
        && standalone.surfaces.review_lane_act.requires_task_db === true
        && standalone.surfaces.review_lane_act.allowed_actions.includes('review_chat')
        && standalone.surfaces.review_lane_act.allowed_actions.includes('continue_work')
        && standalone.surfaces.review_lane_act.blocked_actions.includes('human_accept_waiting')
    ),
    capabilityCheck(
      'review_lane_act_behavior_conforms',
      actBehavior.ok,
      actBehavior.checks
    ),
    capabilityCheck(
      'review_lane_loop_surface_declared',
      standalone.commands.review_lane_loop === 'atris task review-lane-loop --json'
        && standalone.surfaces.review_lane_loop.command === 'atris task review-lane-loop --json'
        && standalone.surfaces.review_lane_loop.api.method === 'POST'
        && standalone.surfaces.review_lane_loop.api.path === '/api/tasks/review-lane-loop'
        && standalone.surfaces.review_lane_loop.requires_task_db === true
        && standalone.surfaces.review_lane_loop.default_max_steps === REVIEW_LANE_LOOP_DEFAULT_MAX_STEPS
        && standalone.surfaces.review_lane_loop.max_steps_cap === REVIEW_LANE_LOOP_MAX_STEPS
        && standalone.surfaces.review_lane_loop.orchestrates === 'review_lane_act'
        && standalone.surfaces.review_lane_loop.allowed_actions.includes('review_chat')
        && standalone.surfaces.review_lane_loop.allowed_actions.includes('continue_work')
        && standalone.surfaces.review_lane_loop.stopped_by.includes(PROOF_BOUNDARY_BLOCKED_REASON)
        && standalone.surfaces.review_lane_loop.stopped_by.includes('human_accept_waiting_is_human_only')
        && standalone.surfaces.review_lane_loop.stopped_by.includes(PENDING_REVIEW_CHAT_STOP_REASON)
        && standalone.surfaces.review_lane_loop.stopped_by.includes('capabilities_check_failed')
        && standalone.surfaces.review_lane_loop.stopped_by.includes('repeat_selection')
    ),
    capabilityCheck(
      'review_lane_loop_behavior_conforms',
      loopBehavior.ok,
      loopBehavior.checks
    ),
    capabilityCheck(
      'review_lane_run_surface_declared',
      standalone.commands.review_lane_run === 'atris task review-lane-run --json'
        && standalone.surfaces.review_lane_run.command === 'atris task review-lane-run --json'
        && standalone.surfaces.review_lane_run.api.method === 'POST'
        && standalone.surfaces.review_lane_run.api.path === '/api/tasks/review-lane-run'
        && standalone.surfaces.review_lane_run.requires_task_db === true
        && standalone.surfaces.review_lane_run.default_max_runs === REVIEW_LANE_RUN_DEFAULT_MAX_RUNS
        && standalone.surfaces.review_lane_run.max_runs_cap === REVIEW_LANE_RUN_MAX_RUNS
        && standalone.surfaces.review_lane_run.default_max_steps === REVIEW_LANE_LOOP_DEFAULT_MAX_STEPS
        && standalone.surfaces.review_lane_run.max_steps_cap === REVIEW_LANE_LOOP_MAX_STEPS
        && standalone.surfaces.review_lane_run.orchestrates === 'review_lane_loop'
        && standalone.surfaces.review_lane_run.writes_receipt === true
        && standalone.surfaces.review_lane_run.receipt_path === '.atris/state/review-lane-runs.jsonl'
        && standalone.surfaces.review_lane_run.latest_receipt_path === '.atris/state/review-lane-run.latest.json'
        && standalone.surfaces.review_lane_run.stopped_by.includes(PROOF_BOUNDARY_BLOCKED_REASON)
        && standalone.surfaces.review_lane_run.stopped_by.includes('human_accept_waiting_is_human_only')
        && standalone.surfaces.review_lane_run.stopped_by.includes(PENDING_REVIEW_CHAT_STOP_REASON)
        && standalone.surfaces.review_lane_run.stopped_by.includes('capabilities_check_failed')
        && standalone.surfaces.review_lane_run.stopped_by.includes('continue_work_reused_existing_follow_up')
        && standalone.surfaces.review_lane_run.stopped_by.includes('max_runs_reached')
    ),
    capabilityCheck(
      'review_lane_run_behavior_conforms',
      runBehavior.ok,
      runBehavior.checks
    ),
  ];
  const failed = checks.filter(check => !check.ok);
  return {
    schema: 'atris.task_capabilities_check.v1',
    generated_at: new Date().toISOString(),
    ok: failed.length === 0,
    action: 'capabilities_check',
    projection_path: outPath,
    scope: current.scope,
    owner: String(owner || DEFAULT_OWNER),
    reviewer,
    capabilities: standalone,
    checks,
    summary: {
      total: checks.length,
      passed: checks.length - failed.length,
      failed: failed.length,
    },
    safety: {
      mutates_task_db: false,
      writes_projection: true,
      human_accept: false,
      xp_after_human_accept: true,
    },
  };
}

function cmdCapabilities(args) {
  const capabilities = taskCapabilitiesContract();
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'capabilities',
      capabilities,
      safety: {
        read_only: true,
        claims_work: false,
        human_accept: false,
        xp_after_human_accept: true,
      },
    });
    return;
  }
  console.log(capabilities.schema);
  console.log(`current: ${capabilities.commands.current}`);
  console.log(`queue: ${capabilities.commands.queue}`);
  console.log(`current-step: ${capabilities.commands.current_step}`);
  console.log(`review-state lanes: ${capabilities.filters.review_state.accepted.join(', ')}`);
}

function cmdCapabilitiesCheck(args) {
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const report = taskCapabilitiesCheckReport(taskDb, db, args);
  if (wantsJson(args)) {
    printJson(report);
    if (!report.ok) process.exit(1);
    return;
  }
  console.log(`TASK CAPABILITIES CHECK ${report.ok ? 'ok' : 'failed'}`);
  for (const check of report.checks) {
    console.log(`${check.ok ? 'ok' : 'fail'} ${check.name}`);
  }
  if (!report.ok) process.exit(1);
}

module.exports = {
  bindMain, taskQueueCapabilities, taskCapabilitiesContract, stableCapabilityJson,
  capabilityValuesEqual, capabilityCheck, reviewLaneDrainBehaviorConformance,
  taskReviewLaneActDecision, reviewLaneActBehaviorConformance, reviewLaneLoopBehaviorConformance,
  reviewLaneRunBehaviorConformance, taskCapabilitiesCheckReport, cmdCapabilities,
  cmdCapabilitiesCheck,
};
