'use strict';

const { heldForPerson } = require('../../../lib/member-task-pick');

// commands/task/next/next.js: Choosing what to work on: the queue and its scopes, the current task,
// next, endgame seed tasks and continue-work.
// Owner: task-planner. Moved out of commands/task.js on 2026-11-16 by lib/split-file.js; read
// README.md first.

// Names borrowed from commands/task.js and other feature folders, set by bindMain().
let fs, path, hasFlag, buildNextWorkContext, reconcileTaskRows, taskTagTokens, isDecisionHoldTag,
  isDecisionTask, summarizeSkippedDecisions, formatDecisionRefusalLines, DECISION_REFUSE_REASON,
  loadLocalTaskState, firstTalkCommand, folderName, personName, pickNext, speakFirstMinute,
  taskCommand, taskNextCommand, DEFAULT_OWNER, PENDING_REVIEW_CHAT_STOP_REASON,
  PROOF_BOUNDARY_BLOCKED_ACTION, TASK_QUEUE_COLUMN_ORDER, TASK_QUEUE_COLUMN_LABELS, getTaskDb,
  warnIfTaskTitleNeedsOperatorWhy, flag, taskScopeEverywhere, scopedWorkspaceRoot, wantsJson,
  printJson, failTask, positional, taskRef, taskColumn, writeDefaultProjection, reviewNextTaskTitle,
  buildReviewFollowUpChildPredicate, buildPendingReviewChatPredicate, createReviewNextTask,
  continueWorkCommandForTask, taskAssignee, reviewHandoffForTask, reviewActor, compactTaskForStatus,
  compactTaskFromProjection, clipStatusText, taskQueueCapabilities, readProjectionFile,
  requireTaskId, taskDetail, taskPageContract, extractTodoSectionMarkdown;
function bindMain(deps) {
  ({
    fs, path, hasFlag, buildNextWorkContext, reconcileTaskRows, taskTagTokens, isDecisionHoldTag,
    isDecisionTask, summarizeSkippedDecisions, formatDecisionRefusalLines, DECISION_REFUSE_REASON,
    loadLocalTaskState, firstTalkCommand, folderName, personName, pickNext, speakFirstMinute,
    taskCommand, taskNextCommand, DEFAULT_OWNER, PENDING_REVIEW_CHAT_STOP_REASON,
    PROOF_BOUNDARY_BLOCKED_ACTION, TASK_QUEUE_COLUMN_ORDER, TASK_QUEUE_COLUMN_LABELS, getTaskDb,
    warnIfTaskTitleNeedsOperatorWhy, flag, taskScopeEverywhere, scopedWorkspaceRoot, wantsJson,
    printJson, failTask, positional, taskRef, taskColumn, writeDefaultProjection,
    reviewNextTaskTitle, buildReviewFollowUpChildPredicate, buildPendingReviewChatPredicate,
    createReviewNextTask, continueWorkCommandForTask, taskAssignee, reviewHandoffForTask,
    reviewActor, compactTaskForStatus, compactTaskFromProjection, clipStatusText,
    taskQueueCapabilities, readProjectionFile, requireTaskId, taskDetail, taskPageContract,
    extractTodoSectionMarkdown,
  } = deps);
}

function taskQueueColumnKey(task) {
  const column = taskColumn(task);
  if (column === 'open') return 'plan';
  if (column === 'doing') return 'do';
  return column;
}

function sortTasksNewestFirst(tasks) {
  return [...tasks].sort((a, b) => {
    const byUpdated = Number(b.updated_at || 0) - Number(a.updated_at || 0);
    if (byUpdated) return byUpdated;
    return String(a.title || '').localeCompare(String(b.title || ''));
  });
}

function sortTasksOldestFirst(tasks) {
  return [...tasks].sort((a, b) => {
    const byUpdated = Number(a.updated_at || 0) - Number(b.updated_at || 0);
    if (byUpdated) return byUpdated;
    return String(a.title || '').localeCompare(String(b.title || ''));
  });
}

function taskQueueItem(task, { reviewer = 'codex-review', hasExistingReviewFollowUp = null } = {}) {
  const page = taskPageContract(task, { reviewer, hasExistingReviewFollowUp });
  const item = compactTaskForStatus(task) || {};
  item.ref = taskRef(task);
  item.display_id = item.display_id || task.display_id || null;
  item.legacy_ref = item.legacy_ref || task.legacy_ref || taskRef(task.id);
  if (item.review && item.review.verification_chat) {
    item.review = { ...item.review };
    delete item.review.verification_chat;
  }
  item.column = taskQueueColumnKey(task);
  item.stage_current = page.stage.current;
  item.next_action = page.stage.next_action;
  item.commands = {
    page: page.actions.page_command,
    step: page.actions.step_command,
    chat: page.actions.chat_command,
  };
  if (page.actions.review_chat_command) item.commands.review_chat = page.actions.review_chat_command;
  if (page.actions.continue_work_command) {
    item.commands.continue_work = page.actions.continue_work_command;
    item.continue_work_command = page.actions.continue_work_command;
  }
  if (page.actions.human_accept_command) item.commands.human_accept = page.actions.human_accept_command;
  item.api = {
    detail: page.api.detail,
    page: page.api.page,
    step: page.api.step,
  };
  if (page.stage.next_action.api) item.api.next_action = page.stage.next_action.api;
  return item;
}

function taskQueueLimit(args) {
  if (hasFlag(args, '--all')) return Number.POSITIVE_INFINITY;
  const raw = flag(args, '--limit');
  const limit = raw && raw !== true ? Number(raw) : 8;
  return Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 8;
}

function cleanTaskScopeValue(value) {
  if (value === undefined || value === null || value === true) return null;
  const text = String(value).trim();
  return text || null;
}

function normalizeTaskQueueScope(scope = {}) {
  return {
    goal_id: cleanTaskScopeValue(scope.goal_id || scope.goalId),
    tag: cleanTaskScopeValue(scope.tag),
    status: cleanTaskScopeValue(scope.status),
    review_state: cleanTaskScopeValue(scope.review_state || scope.reviewState),
  };
}

function taskQueueScopeFromArgs(args = []) {
  return normalizeTaskQueueScope({
    goal_id: flag(args, '--goal-id') || flag(args, '--goal_id'),
    tag: flag(args, '--tag'),
    status: flag(args, '--status'),
    review_state: flag(args, '--review-state') || flag(args, '--review_state'),
  });
}

function taskQueueScopeFromSearchParams(searchParams) {
  return normalizeTaskQueueScope({
    goal_id: searchParams.get('goal_id') || searchParams.get('goal-id') || searchParams.get('goalId'),
    tag: searchParams.get('tag'),
    status: searchParams.get('status'),
    review_state: searchParams.get('review_state') || searchParams.get('review-state') || searchParams.get('reviewState'),
  });
}

function taskQueueScopeFromBody(body = {}) {
  const scope = body.scope && typeof body.scope === 'object' ? body.scope : {};
  return normalizeTaskQueueScope({
    goal_id: body.goal_id || body.goalId || scope.goal_id || scope.goalId,
    tag: body.tag || scope.tag,
    status: body.status || scope.status,
    review_state: body.review_state || body.reviewState || scope.review_state || scope.reviewState,
  });
}

function mergeTaskQueueScopes(primary = {}, fallback = {}) {
  const a = normalizeTaskQueueScope(primary);
  const b = normalizeTaskQueueScope(fallback);
  return normalizeTaskQueueScope({
    goal_id: a.goal_id || b.goal_id,
    tag: a.tag || b.tag,
    status: a.status || b.status,
    review_state: a.review_state || b.review_state,
  });
}

function taskQueueScopeIsEmpty(scope = {}) {
  const normalized = normalizeTaskQueueScope(scope);
  return !normalized.goal_id && !normalized.tag && !normalized.status && !normalized.review_state;
}

function taskScopeEquals(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

function taskGoalScopeValues(task) {
  const metadata = task && task.metadata || {};
  const lineage = task && task.lineage || {};
  return [
    task && task.id,
    task && task.display_id,
    task && task.legacy_ref,
    metadata.goal_id,
    metadata.goalId,
    metadata.goal && metadata.goal.id,
    metadata.parent_task_id,
    lineage.parent_task_id,
    task && task.parent_task_id,
  ].filter(Boolean);
}

function taskReviewStateMatches(task, reviewState, { hasExistingReviewFollowUp = null } = {}) {
  const wanted = String(reviewState || '').trim().toLowerCase().replace(/_/g, '-');
  if (!wanted || wanted === 'any') return true;
  const handoff = reviewHandoffForTask(task, { suppressExistingFollowUp: true, hasExistingReviewFollowUp });
  if (wanted === 'continue-work' || wanted === 'continue' || wanted === 'agent-actionable' || wanted === 'executable') {
    return handoff?.next_action === 'continue_work';
  }
  if (wanted === 'proof-boundary-blocked' || wanted === 'proof-boundary' || wanted === 'boundary-blocked' || wanted === 'stale-pr-proof' || wanted === 'unmerged-pr-proof') {
    return handoff?.next_action === PROOF_BOUNDARY_BLOCKED_ACTION;
  }
  if (wanted === 'human-accept-waiting' || wanted === 'human-accept' || wanted === 'accept-waiting' || wanted === 'waiting-accept' || wanted === 'no-next-task') {
    return handoff?.next_action === 'human_accept_waiting';
  }
  if (wanted === 'needs-agent' || wanted === 'needs-review' || wanted === 'agent-review') {
    return handoff?.next_action === 'agent_review_again';
  }
  if (wanted === 'certified' || wanted === 'waiting-human' || wanted === 'human-waiting') {
    return handoff?.next_action === 'continue_work'
      || handoff?.next_action === 'human_accept_waiting'
      || handoff?.next_action === PROOF_BOUNDARY_BLOCKED_ACTION;
  }
  return false;
}

function taskMatchesScopeTag(task, wantedTag) {
  if (!wantedTag) return true;
  if (taskScopeEquals(task && task.tag, wantedTag)) return true;
  const tokens = taskTagTokens(task);
  if (tokens.some((token) => taskScopeEquals(token, wantedTag))) return true;
  if (isDecisionHoldTag(wantedTag) && isDecisionTask(task)) return true;
  return false;
}

function taskMatchesQueueScope(task, scope = {}, options = {}) {
  const normalized = normalizeTaskQueueScope(scope);
  if (normalized.goal_id && !taskGoalScopeValues(task).some(value => taskScopeEquals(value, normalized.goal_id))) {
    return false;
  }
  if (normalized.tag && !taskMatchesScopeTag(task, normalized.tag)) {
    return false;
  }
  if (normalized.status) {
    const rawStatus = task && task.status;
    const columnStatus = taskQueueColumnKey(task);
    if (!taskScopeEquals(rawStatus, normalized.status) && !taskScopeEquals(columnStatus, normalized.status)) {
      return false;
    }
  }
  if (normalized.review_state && !taskReviewStateMatches(task, normalized.review_state, options)) {
    return false;
  }
  return true;
}

function filterTasksByScope(tasks = [], scope = {}, options = {}) {
  const normalized = normalizeTaskQueueScope(scope);
  if (taskQueueScopeIsEmpty(normalized)) return tasks;
  return tasks.filter(task => taskMatchesQueueScope(task, normalized, options));
}

function taskQueueScopeWithoutReviewState(scope = {}) {
  const normalized = normalizeTaskQueueScope(scope);
  return normalizeTaskQueueScope({
    goal_id: normalized.goal_id,
    tag: normalized.tag,
    status: normalized.status,
  });
}

function taskReviewStateCounts(tasks = [], { hasExistingReviewFollowUp = null } = {}) {
  const counts = {
    total: 0,
    needs_agent: 0,
    continue_work: 0,
    proof_boundary_blocked: 0,
    human_accept_waiting: 0,
    certified: 0,
  };
  for (const task of tasks || []) {
    if (!task || taskQueueColumnKey(task) !== 'review') continue;
    const handoff = reviewHandoffForTask(task, { suppressExistingFollowUp: true, hasExistingReviewFollowUp });
    if (!handoff) continue;
    counts.total += 1;
    if (handoff.next_action === 'agent_review_again') counts.needs_agent += 1;
    if (handoff.next_action === 'continue_work') counts.continue_work += 1;
    if (handoff.next_action === PROOF_BOUNDARY_BLOCKED_ACTION) counts.proof_boundary_blocked += 1;
    if (handoff.next_action === 'human_accept_waiting') counts.human_accept_waiting += 1;
  }
  counts.certified = counts.continue_work + counts.proof_boundary_blocked + counts.human_accept_waiting;
  return counts;
}

function taskHasReviewFollowUpChild(task, { hasExistingReviewFollowUp = null } = {}) {
  const nextTitle = reviewNextTaskTitle(task);
  if (!nextTitle) return false;
  if (typeof hasExistingReviewFollowUp === 'function' && hasExistingReviewFollowUp(task)) return true;
  const childIds = task && task.lineage && task.lineage.child_task_ids;
  if (!Array.isArray(childIds) || !childIds.some(Boolean)) return false;
  const childTitles = task && task.lineage && task.lineage.child_titles;
  if (Array.isArray(childTitles) && childTitles.some(title => String(title || '').trim() === nextTitle)) return true;
  // A certified review row should spawn one follow-up; later next_task edits should not reopen the parent.
  return true;
}

function taskQueueReviewStateCounts(projection, scope = {}, { hasExistingReviewFollowUp = null } = {}) {
  const normalizedScope = normalizeTaskQueueScope(scope);
  const countScope = taskQueueScopeWithoutReviewState(normalizedScope);
  const tasks = filterTasksByScope(sortTasksNewestFirst(projection.tasks || []), countScope, { hasExistingReviewFollowUp });
  return {
    schema: 'atris.task_review_state_counts.v1',
    scope: countScope,
    active_filter: normalizedScope.review_state || null,
    ...taskReviewStateCounts(tasks, { hasExistingReviewFollowUp }),
  };
}

function taskReviewStateActionSample(task, { reviewer = 'codex-review', hasExistingReviewFollowUp = null } = {}) {
  if (!task) return null;
  const page = taskPageContract(task, { reviewer, hasExistingReviewFollowUp });
  const nextAction = page.stage && page.stage.next_action || {};
  const sample = {
    id: task.id,
    display_id: task.display_id || null,
    ref: taskRef(task),
    title: clipStatusText(task.title, 120),
    claimed_by: task.claimed_by || null,
    assigned_to: taskAssignee(task),
    next_action: nextAction.key || null,
    label: nextAction.label || null,
    command: nextAction.command || null,
    api: nextAction.api || null,
    step_command: page.actions.step_command,
    step_api: page.api.step,
    human_accept: {
      enabled: Boolean(page.review && page.review.human_accept && page.review.human_accept.enabled),
      human_only: true,
      command: page.review && page.review.human_accept ? page.review.human_accept.command : null,
    },
  };
  if (page.actions.review_chat_command) sample.review_chat_command = page.actions.review_chat_command;
  if (page.actions.continue_work_command) sample.continue_work_command = page.actions.continue_work_command;
  if (page.actions.revise_command) sample.revise_command = page.actions.revise_command;
  if (nextAction.reason) sample.reason = nextAction.reason;
  if (nextAction.next_action_detail) sample.next_action_detail = nextAction.next_action_detail;
  return sample;
}

function normalizeTaskIdSet(values) {
  if (!values) return new Set();
  const list = values instanceof Set ? Array.from(values) : Array.isArray(values) ? values : [values];
  return new Set(list.map(value => String(value || '').trim()).filter(Boolean));
}

function taskHasPendingReviewChat(task, { hasPendingReviewChat = null } = {}) {
  return Boolean(typeof hasPendingReviewChat === 'function' && hasPendingReviewChat(task));
}

function pendingReviewChatActionSample(task, { reviewer = 'codex-review', hasExistingReviewFollowUp = null } = {}) {
  const sample = taskReviewStateActionSample(task, { reviewer, hasExistingReviewFollowUp });
  if (!sample) return null;
  sample.next_action = 'pending_review_chat';
  sample.label = 'Pending review chat';
  sample.command = null;
  sample.api = null;
  sample.step_command = null;
  sample.step_api = null;
  sample.reason = PENDING_REVIEW_CHAT_STOP_REASON;
  delete sample.review_chat_command;
  delete sample.continue_work_command;
  return sample;
}

function taskQueueReviewStateActions(projection, scope = {}, { reviewer = 'codex-review', hasExistingReviewFollowUp = null, hasPendingReviewChat = null, excludeTaskIds = null } = {}) {
  const normalizedScope = normalizeTaskQueueScope(scope);
  const actionScope = taskQueueScopeWithoutReviewState(normalizedScope);
  const tasks = filterTasksByScope(sortTasksNewestFirst(projection.tasks || []), actionScope, { hasExistingReviewFollowUp });
  const excluded = normalizeTaskIdSet(excludeTaskIds);
  const firstByState = {
    needs_agent: null,
    continue_work: null,
    proof_boundary_blocked: null,
    human_accept_waiting: null,
  };
  const skippedContinueWorkWithFollowUp = [];
  const pendingReviewChats = [];
  for (const task of tasks || []) {
    if (!task || taskQueueColumnKey(task) !== 'review') continue;
    if (excluded.has(String(task.id || ''))) continue;
    const rawHandoff = reviewHandoffForTask(task);
    const handoff = reviewHandoffForTask(task, { suppressExistingFollowUp: true, hasExistingReviewFollowUp });
    if (!handoff) continue;
    if (handoff.next_action === 'agent_review_again' && taskHasPendingReviewChat(task, { hasPendingReviewChat })) {
      pendingReviewChats.push(task);
      continue;
    }
    if (handoff.next_action === 'agent_review_again' && !firstByState.needs_agent) {
      firstByState.needs_agent = task;
    }
    if (rawHandoff?.next_action === 'continue_work' && taskHasReviewFollowUpChild(task, { hasExistingReviewFollowUp })) {
      skippedContinueWorkWithFollowUp.push(task);
    }
    if (handoff.next_action === 'continue_work' && !firstByState.continue_work) {
      firstByState.continue_work = task;
    }
    if (handoff.next_action === PROOF_BOUNDARY_BLOCKED_ACTION && !firstByState.proof_boundary_blocked) {
      firstByState.proof_boundary_blocked = task;
    }
    if (handoff.next_action === 'human_accept_waiting' && !firstByState.human_accept_waiting) {
      firstByState.human_accept_waiting = task;
    }
  }
  return {
    schema: 'atris.task_review_state_actions.v1',
    scope: actionScope,
    active_filter: normalizedScope.review_state || null,
    needs_agent: taskReviewStateActionSample(firstByState.needs_agent, { reviewer, hasExistingReviewFollowUp }),
    continue_work: taskReviewStateActionSample(firstByState.continue_work, { reviewer, hasExistingReviewFollowUp }),
    proof_boundary_blocked: taskReviewStateActionSample(firstByState.proof_boundary_blocked, { reviewer, hasExistingReviewFollowUp }),
    human_accept_waiting: taskReviewStateActionSample(firstByState.human_accept_waiting, { reviewer, hasExistingReviewFollowUp }),
    skipped_continue_work_with_follow_up_count: skippedContinueWorkWithFollowUp.length,
    skipped_continue_work_with_follow_up: skippedContinueWorkWithFollowUp
      .slice(0, 5)
      .map(task => taskReviewStateActionSample(task, { reviewer, hasExistingReviewFollowUp })),
    pending_review_chat_count: pendingReviewChats.length,
    pending_review_chat: pendingReviewChats
      .slice(0, 5)
      .map(task => pendingReviewChatActionSample(task, { reviewer, hasExistingReviewFollowUp })),
  };
}

function formatTaskQueueScope(scope = {}) {
  const normalized = normalizeTaskQueueScope(scope);
  return Object.entries(normalized)
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}=${value}`)
    .join(' ');
}

function noOpenTasksMessage(scope = {}) {
  const scopeText = formatTaskQueueScope(scope);
  return scopeText ? `No open tasks for ${scopeText}.` : 'No open tasks.';
}

function taskQueueContract(projection, { reviewer = 'codex-review', limit = 8, scope = {}, hasExistingReviewFollowUp = null, hasPendingReviewChat = null, excludeTaskIds = null } = {}) {
  const normalizedScope = normalizeTaskQueueScope(scope);
  const tasks = filterTasksByScope(sortTasksNewestFirst(projection.tasks || []), normalizedScope, { hasExistingReviewFollowUp });
  const reviewStateCounts = taskQueueReviewStateCounts(projection, normalizedScope, { hasExistingReviewFollowUp });
  const reviewStateActions = taskQueueReviewStateActions(projection, normalizedScope, { reviewer, hasExistingReviewFollowUp, hasPendingReviewChat, excludeTaskIds });
  const grouped = new Map(TASK_QUEUE_COLUMN_ORDER.map(key => [key, []]));
  for (const task of tasks) {
    const key = taskQueueColumnKey(task);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(task);
  }
  const columns = TASK_QUEUE_COLUMN_ORDER.map(key => {
    const columnTasks = grouped.get(key) || [];
    const shown = Number.isFinite(limit) ? columnTasks.slice(0, limit) : columnTasks;
    return {
      key,
      label: TASK_QUEUE_COLUMN_LABELS[key] || key,
      count: columnTasks.length,
      items: shown.map(task => taskQueueItem(task, { reviewer, hasExistingReviewFollowUp })),
    };
  });
  const counts = {};
  for (const column of columns) counts[column.key] = column.count;
  counts.active = counts.plan + counts.do + counts.review + counts.blocked;
  counts.total = tasks.length;
  return {
    schema: 'atris.task_queue.v1',
    generated_at: projection.generated_at,
    workspace_root: projection.workspace_root,
    scope: normalizedScope,
    columns,
    counts,
    review_state_counts: reviewStateCounts,
    review_state_actions: reviewStateActions,
    capabilities: taskQueueCapabilities(),
  };
}

function selectTaskForCurrent(projection, { owner = DEFAULT_OWNER, scope = {}, hasExistingReviewFollowUp = null } = {}) {
  const normalizedScope = normalizeTaskQueueScope(scope);
  const tasks = filterTasksByScope(sortTasksNewestFirst(projection.tasks || []), normalizedScope, { hasExistingReviewFollowUp });
  const columns = {
    backlog: [],
    plan: [],
    do: [],
    review: [],
    blocked: [],
    done: [],
  };
  for (const task of tasks) {
    const key = taskQueueColumnKey(task);
    if (!columns[key]) columns[key] = [];
    columns[key].push(task);
  }
  const actor = String(owner || DEFAULT_OWNER);
  const claimedByOwner = columns.do.find(task => task.claimed_by === actor);
  if (claimedByOwner) return { task: claimedByOwner, reason: 'claimed_by_owner' };
  const reviewNeedsAgent = columns.review.find(task => reviewHandoffForTask(task, { suppressExistingFollowUp: true, hasExistingReviewFollowUp })?.next_action === 'agent_review_again');
  if (reviewNeedsAgent) return { task: reviewNeedsAgent, reason: 'review_needs_agent_verification' };
  const reviewProofBoundaryBlocked = columns.review.find(task => reviewHandoffForTask(task, { suppressExistingFollowUp: true, hasExistingReviewFollowUp })?.next_action === PROOF_BOUNDARY_BLOCKED_ACTION);
  if (reviewProofBoundaryBlocked) return { task: reviewProofBoundaryBlocked, reason: 'review_proof_boundary_blocked' };
  // Scoped selection (goal_id, tag, status, or review_state) implies a sequenced
  // work stream (e.g. golden-path "pass 1a" before "pass 2"): earlier-created
  // tasks must win over newer ones, not the newest-first default used for the
  // unscoped desk view.
  const planQueue = !taskQueueScopeIsEmpty(normalizedScope) ? sortTasksOldestFirst(columns.plan) : columns.plan;
  const planReady = planQueue[0];
  if (planReady) return { task: planReady, reason: 'plan_ready' };
  const backlogIdea = columns.backlog[0];
  if (backlogIdea) return { task: backlogIdea, reason: 'backlog_idea' };
  const activeOther = columns.do[0];
  if (activeOther) return { task: activeOther, reason: 'active_do_elsewhere' };
  const blocked = columns.blocked[0];
  if (blocked) return { task: blocked, reason: 'blocked_task' };
  const certifiedReview = columns.review.find(task => {
    const handoff = reviewHandoffForTask(task, { suppressExistingFollowUp: true, hasExistingReviewFollowUp });
    return handoff?.next_action === 'continue_work' || handoff?.next_action === 'human_accept_waiting';
  });
  if (certifiedReview) return { task: certifiedReview, reason: 'review_certified_waiting_human' };
  const done = columns.done[0];
  if (done) return { task: done, reason: 'done_reference' };
  return { task: null, reason: 'none' };
}

function taskCurrentContract(projection, { owner = DEFAULT_OWNER, reviewer = 'codex-review', limit = 8, scope = {}, hasExistingReviewFollowUp = null, hasPendingReviewChat = null, excludeTaskIds = null } = {}) {
  const normalizedScope = normalizeTaskQueueScope(scope);
  const queue = taskQueueContract(projection, { reviewer, limit, scope: normalizedScope, hasExistingReviewFollowUp, hasPendingReviewChat, excludeTaskIds });
  const selection = selectTaskForCurrent(projection, { owner, scope: normalizedScope, hasExistingReviewFollowUp });
  const page = selection.task ? taskPageContract(selection.task, { reviewer, hasExistingReviewFollowUp }) : null;
  const selected = selection.task ? taskQueueItem(selection.task, { reviewer, hasExistingReviewFollowUp }) : null;
  return {
    schema: 'atris.task_current.v1',
    generated_at: projection.generated_at,
    workspace_root: projection.workspace_root,
    owner: String(owner || DEFAULT_OWNER),
    reviewer: reviewActor(reviewer || 'codex-review'),
    scope: normalizedScope,
    selected_reason: selection.reason,
    selected_task_id: selection.task ? selection.task.id : null,
    selected_ref: selection.task ? taskRef(selection.task) : null,
    selected_next_key: page ? page.stage.next_action.key : null,
    selected,
    page,
    next: page ? {
      key: page.stage.next_action.key,
      label: page.stage.next_action.label,
      command: page.stage.next_action.command || null,
      api: page.stage.next_action.api || null,
      reason: page.stage.next_action.reason || null,
      revise_command: page.stage.next_action.revise_command || null,
      human_accept_command: page.stage.next_action.human_accept_command || null,
      step_command: page.actions.step_command,
      step_api: page.api.step,
    } : null,
    review_state_counts: queue.review_state_counts,
    review_state_actions: queue.review_state_actions,
    capabilities: queue.capabilities,
    queue,
    safety: {
      read_only: true,
      claims_work: false,
      human_accept: false,
      xp_after_human_accept: true,
    },
  };
}

function buildTaskCurrent(taskDb, db, args = [], options = {}) {
  const owner = options.owner || flag(args, '--as') || flag(args, '--owner') || DEFAULT_OWNER;
  const reviewer = reviewActor(options.reviewer || flag(args, '--reviewer') || flag(args, '--as-reviewer') || 'codex-review');
  const all = options.all !== undefined ? Boolean(options.all) : hasFlag(args, '--all');
  const everywhere = taskScopeEverywhere(args, options);
  const workspaceRoot = scopedWorkspaceRoot(taskDb, args, { everywhere });
  const limit = options.limit !== undefined ? options.limit : taskQueueLimit(args);
  const scope = normalizeTaskQueueScope(options.scope || taskQueueScopeFromArgs(args));
  const { projection, outPath } = writeDefaultProjection(taskDb, db, { all, everywhere });
  const hasExistingReviewFollowUp = buildReviewFollowUpChildPredicate(
    taskDb,
    db,
    workspaceRoot,
  );
  const hasPendingReviewChat = buildPendingReviewChatPredicate(
    taskDb,
    db,
    workspaceRoot,
  );
  return {
    projection,
    outPath,
    current: taskCurrentContract(projection, { owner, reviewer, limit, scope, hasExistingReviewFollowUp, hasPendingReviewChat, excludeTaskIds: options.excludeTaskIds }),
  };
}

function printTaskCurrent(current) {
  if (!current.page) {
    console.log('TASK CURRENT');
    console.log('No task selected.');
    return;
  }
  console.log('TASK CURRENT');
  const scopeText = formatTaskQueueScope(current.scope);
  if (scopeText) console.log(`Scope: ${scopeText}`);
  console.log(`${current.page.task.ref} ${current.selected_reason}`);
  console.log(current.page.task.title);
  console.log(`Stage: ${current.page.stage.current}`);
  console.log(`Next: ${current.next.command || current.next.label}`);
  console.log(`Step: ${current.next.step_command}`);
}

function printTaskQueue(queue, current = null) {
  console.log('TASK QUEUE');
  const scopeText = formatTaskQueueScope(queue.scope);
  if (scopeText) console.log(`Scope: ${scopeText}`);
  if (current && current.page) console.log(`current ${current.page.task.ref} ${current.page.stage.current}`);
  for (const column of queue.columns) {
    console.log(`${column.label}: ${column.count}`);
    for (const item of column.items.slice(0, 5)) {
      console.log(`  ${taskRef(item)} ${item.title}`);
    }
  }
}

function cmdCurrent(args) {
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const { outPath, current } = buildTaskCurrent(taskDb, db, args);
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'current',
      projection_path: outPath,
      selected_task_id: current.selected_task_id,
      selected_ref: current.selected_ref,
      selected_next_key: current.selected_next_key,
      current,
      selected: current.selected,
      page: current.page,
      queue: current.queue,
    });
    return;
  }
  printTaskCurrent(current);
}

function cmdQueue(args) {
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const { outPath, current } = buildTaskCurrent(taskDb, db, args);
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'queue',
      projection_path: outPath,
      selected_task_id: current.selected_task_id,
      selected_ref: current.selected_ref,
      selected_next_key: current.selected_next_key,
      current,
      selected: current.selected,
      page: current.page,
      queue: current.queue,
    });
    return;
  }
  printTaskQueue(current.queue, current);
}

// A claim against an already-done task burns a whole dispatch when a
// rendered view (atris/TODO.md) is stale: the agent claims, builds, then
// discovers the work was already done. Point straight at a real open task
// instead of just reporting the failure, straight from the live projection
// (never the rendered file), preferring the same tag when one is open.
function suggestNextClaimableTask(projection, { excludeId = null, tag = '' } = {}) {
  // Decision rows (needs-human / decision) belong to a human. Autonomous
  // recovery after already_done must not hand an agent a judgment call.
  const open = (projection && projection.tasks || []).filter((t) => (
    t && t.status === 'open' && t.id !== excludeId && !isDecisionTask(t)
  ));
  if (!open.length) return null;
  const normalizedTag = String(tag || '').trim().toLowerCase();
  if (normalizedTag) {
    const sameTag = open.find((t) => String(t.tag || '').trim().toLowerCase() === normalizedTag);
    if (sameTag) return sameTag;
  }
  return open[0];
}

function liveTaskWithTitle(tasks, title) {
  const wanted = String(title || '').trim().toLowerCase();
  if (!wanted) return null;
  return (tasks || []).find(task => {
    const taskTitle = String(task.title || task.task || '').trim().toLowerCase();
    const status = String(task.status || '').toLowerCase();
    return taskTitle === wanted && !new Set(['done', 'accepted', 'failed']).has(status);
  }) || null;
}

function readEndgameAgentAction(root, owner, { tasks = [] } = {}) {
  const todoPath = path.join(root || process.cwd(), 'atris', 'TODO.md');
  if (!fs.existsSync(todoPath)) return null;
  const content = fs.readFileSync(todoPath, 'utf8');
  const section = extractTodoSectionMarkdown(content, 'Endgame');
  if (!section) return null;
  const slug = (section.match(/\*\*Slug:\*\*\s*([^\n]+)/i)?.[1] || '').trim();
  const horizon = (section.match(/\*\*Horizon:\*\*\s*([^\n]+)/i)?.[1] || '').trim();
  if (!slug && !horizon) return null;
  const member = String(owner || DEFAULT_OWNER);
  const taskSeed = buildEndgameTaskSeed({ slug, horizon, owner: member });
  const existing = liveTaskWithTitle(tasks, taskSeed.title);
  if (existing) return null;
  return {
    kind: 'create_bounded_endgame_task',
    endgame_slug: slug || null,
    horizon: horizon || null,
    task_seed: taskSeed,
    command: `atris brain activate --member ${member} --root . --verify`,
    message: `Create the next bounded task from Endgame${slug ? ` ${slug}` : ''}${horizon ? `: ${horizon}` : ''}. Do not accept XP.`,
  };
}

function shellQuoteTaskArg(value) {
  const s = String(value || '');
  if (/^[A-Za-z0-9_./:-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function buildEndgameTaskSeed({ slug, horizon, owner }) {
  const combined = `${slug || ''} ${horizon || ''}`.toLowerCase();
  const runnerEndgame = /\b(runner|heartbeat|autopilot\/run|claude -p|model retirement|runner swap)\b/.test(combined);
  const title = runnerEndgame
    ? 'Audit and close next runner-agnostic heartbeat gap'
    : `Advance Endgame ${slug || 'current horizon'}`;
  const tag = runnerEndgame ? 'runner' : 'endgame';
  const files = runnerEndgame
    ? ['commands/autopilot.js', 'commands/run.js', 'lib/runner-command.js', 'test/autopilot-runner-model.test.js']
    : ['atris/TODO.md', 'atris/MAP.md'];
  const verifier = runnerEndgame
    ? 'node --test test/autopilot-runner-model.test.js test/runner-command.test.js'
    : 'git diff --check';
  const stopRule = 'Move proof-ready work to Review; do not accept XP.';
  const goal = runnerEndgame
    ? 'Find and close one remaining runner-agnostic heartbeat gap, or record proof that the next gap is documentation/state only.'
    : `Move the Endgame forward with one bounded, verifiable slice${horizon ? `: ${horizon}` : ''}.`;
  const note = `Goal: ${goal} Files: ${files.join(', ')}. Done: one scoped Endgame slice is implemented or the audited gap is closed with proof. Check: ${verifier}; git diff --check. Stop: ${stopRule}`;
  return {
    title,
    tag,
    files,
    verifier,
    stop_rule: stopRule,
    create_command: `atris task new ${shellQuoteTaskArg(title)} --tag ${shellQuoteTaskArg(tag)}`,
    claim_command: `atris task claim <id> --as ${shellQuoteTaskArg(owner || DEFAULT_OWNER)}`,
    note,
    note_command: `atris task note <id> ${shellQuoteTaskArg(note)}`,
  };
}

function createEndgameSeedTask(taskDb, db, seed, owner) {
  const taskOwner = String(owner || DEFAULT_OWNER);
  const operatorTitleWarning = warnIfTaskTitleNeedsOperatorWhy(seed.title);
  const result = taskDb.addTask(db, {
    title: seed.title,
    tag: seed.tag,
    workspaceRoot: taskDb.workspaceRoot(),
    metadata: {
      generated_from: 'task_next_endgame_seed',
      verifier: seed.verifier,
      files: seed.files,
      stop_rule: seed.stop_rule,
    },
  });
  const claim = taskDb.claimTask(db, { id: result.id, claimedBy: taskOwner });
  if (!claim.claimed) {
    return { ok: false, reason: claim.reason || 'claim_failed', task_id: result.id };
  }
  const note = taskDb.noteTask(db, { id: result.id, actor: taskOwner, content: seed.note });
  if (!note.noted) {
    return { ok: false, reason: note.reason || 'note_failed', task_id: result.id };
  }
  return {
    ok: true,
    task_id: result.id,
    inserted: result.inserted !== false,
    operator_title_warning: operatorTitleWarning,
    note_version: note.event.version,
  };
}

function nextActionFromCommand(command) {
  const text = String(command || '').trim();
  const match = text.match(/^atris (?:task|mission) (\S+)/);
  const verb = match ? match[1] : '';
  if (verb && verb !== 'new') return verb;
  if (/^atris do\b/.test(text)) return 'do';
  return 'none';
}

function cmdNextTruth(args) {
  const owner = flag(args, '--as') || personName() || DEFAULT_OWNER;
  const scope = taskQueueScopeFromArgs(args);
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const workspaceRoot = taskDb.workspaceRoot();
  const snapshot = loadLocalTaskState(workspaceRoot);
  let projection;
  let outPath;
  if (snapshot.source !== 'database') {
    projection = { tasks: snapshot.tasks };
    outPath = path.resolve(path.join(workspaceRoot || '.', '.atris', 'state', 'tasks.projection.json'));
  } else {
    const written = writeDefaultProjection(taskDb, db);
    projection = written.projection;
    outPath = written.outPath;
  }
  const scoped = filterTasksByScope(projection.tasks || [], scope);
  const openDecisions = scoped.filter((task) => task && isDecisionTask(task) && task.status === 'open');
  const actionable = scoped.filter((task) => task && !isDecisionTask(task));
  const picked = pickNext({ tasks: actionable, person: owner });
  const command = picked.task ? (picked.command || taskCommand(picked.task, owner)) : taskNextCommand(actionable, owner);
  const task = picked.task || null;

  if (!task && openDecisions.length) {
    reportSkippedDecisionsAndExit(openDecisions, { args, owner, scope, outPath });
  }

  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: nextActionFromCommand(command),
      command,
      task_id: task ? task.id : null,
      owner: String(owner),
      scope: normalizeTaskQueueScope(scope),
      projection_path: outPath,
      task: task ? compactTaskFromProjection(projection, task.id) : null,
      context: buildNextWorkContext({ root: workspaceRoot, tasks: reconcileTaskRows(snapshot.tasks, projection.tasks || []), selected: task, owner: String(owner), taskSource: snapshot.source, generatedAt: snapshot.generated_at }),
    });
    return;
  }

  if (!task) {
    console.log(noOpenTasksMessage(scope));
    console.log(`next: ${command}`);
    return;
  }
  console.log(`next: ${command}`);
}

function reportSkippedDecisionsAndExit(openDecisions, { args, owner, scope, outPath }) {
  const summary = summarizeSkippedDecisions(openDecisions);
  if (wantsJson(args)) {
    printJson({
      ok: false,
      action: 'refused',
      reason: DECISION_REFUSE_REASON,
      command: summary.command,
      show_command: summary.show_command,
      next_command: summary.next_command,
      choice: summary.choice,
      skipped_decision_count: summary.skipped_decision_count,
      skipped_decision_refs: summary.skipped_decision_refs,
      skipped_decisions: summary.skipped_decisions,
      decisions: summary.decisions,
      owner: String(owner),
      scope: normalizeTaskQueueScope(scope),
      projection_path: outPath,
    });
    process.exit(1);
  }
  const text = formatDecisionRefusalLines(openDecisions).join('\n');
  console.log(text);
  console.error(text);
  process.exit(1);
}

function isUninitializedTaskFolder(cwd = process.cwd()) {
  const workspace = getTaskDb().workspaceRoot(cwd);
  if (fs.existsSync(path.join(workspace, 'atris'))) return false;
  const existing = readProjectionFile(workspace);
  return !(existing && Array.isArray(existing.tasks) && existing.tasks.length > 0);
}

function cmdNext(args) {
  const root = process.cwd();
  const { buildAgentNext, printAgentNext } = require('../../../lib/agent-next');
  const agent = buildAgentNext({ root, args });
  if (agent) return printAgentNext(agent, { asJson: wantsJson(args), alias: 'command' });
  // Empty folder talks like bare atris. Walk up like the task db so a
  // project subdir stays in the room; stop before inheriting /tmp.
  // A leftover projection with live tasks still names that work.
  if (isUninitializedTaskFolder(root)) {
    if (wantsJson(args)) {
      printJson({
        ok: false,
        action: 'none',
        command: firstTalkCommand(folderName(root)),
        task_id: null,
        owner: String(flag(args, '--as') || personName() || DEFAULT_OWNER),
        scope: normalizeTaskQueueScope(taskQueueScopeFromArgs(args)),
        projection_path: null,
        task: null,
      });
      return;
    }
    return speakFirstMinute({ root, fresh: true });
  }
  if (!hasFlag(args, '--create-next')) return cmdNextTruth(args);
  const owner = flag(args, '--as') || DEFAULT_OWNER;
  const scope = taskQueueScopeFromArgs(args);
  const scoped = !taskQueueScopeIsEmpty(scope);
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const claimed = filterTasksByScope(taskDb.listTasks(db, {
    workspaceRoot: taskDb.workspaceRoot(),
    status: 'claimed',
    claimedBy: String(owner),
    limit: scoped ? null : 1,
  }), scope);
  if (claimed.length) {
    const { projection, outPath } = writeDefaultProjection(taskDb, db);
    if (wantsJson(args)) {
      printJson({
        ok: true,
        action: 'current',
        task_id: claimed[0].id,
        owner: String(owner),
        scope: normalizeTaskQueueScope(scope),
        projection_path: outPath,
        task: compactTaskFromProjection(projection, claimed[0].id),
      });
      return;
    }
    console.log(`current ${taskRef(compactTaskFromProjection(projection, claimed[0].id))} @${owner}`);
    console.log(claimed[0].title);
    return;
  }
  const reviewProjection = writeDefaultProjection(taskDb, db);
  const reviewTasks = filterTasksByScope(reviewProjection.projection.tasks || [], scope)
    .map(compactTaskForStatus)
    .filter(task => task && task.review && task.review.handoff);
  const openAll = filterTasksByScope(taskDb.listTasks(db, {
    workspaceRoot: taskDb.workspaceRoot(),
    status: 'open',
    limit: scoped ? null : 50,
  }), scope);
  const open = openAll.filter((task) => !isDecisionTask(task) && !heldForPerson(task));
  const skippedDecisions = openAll.filter((task) => isDecisionTask(task)).length;
  if (!open.length) {
    const { projection, outPath } = reviewProjection;
    if (skippedDecisions > 0 && !reviewTasks.length) {
      const openDecisionTasks = filterTasksByScope(projection.tasks || [], scope)
        .filter((task) => task && isDecisionTask(task) && task.status === 'open');
      reportSkippedDecisionsAndExit(
        openDecisionTasks.length
          ? openDecisionTasks
          : taskDb.withTaskDisplayRefs(openAll.filter((task) => isDecisionTask(task))),
        { args, owner, scope, outPath }
      );
    }
    const reviewTask = reviewTasks.find(task => task.review.handoff.next_action === 'agent_review_again')
      || reviewTasks.find(task => task.review.handoff.next_action === 'continue_work')
      || reviewTasks.find(task => task.review.handoff.next_action === 'human_accept_waiting');
    if (reviewTask) {
      const handoff = reviewTask.review.handoff;
      const continueWorkCommand = handoff.next_action === 'continue_work'
        ? continueWorkCommandForTask(reviewTask, { owner })
        : null;
      const nextAgentAction = handoff.next_action === 'human_accept_waiting' && !scoped
        ? readEndgameAgentAction(taskDb.workspaceRoot(), owner, { tasks: projection.tasks || [] })
        : null;
      if (hasFlag(args, '--create-next')) {
        if (!nextAgentAction || !nextAgentAction.task_seed) {
          failTask('atris task next', 'no_create_next_seed', 'no concrete Endgame seed is available to create');
        }
        const created = createEndgameSeedTask(taskDb, db, nextAgentAction.task_seed, owner);
        if (!created.ok) {
          failTask('atris task next', created.reason || 'create_next_failed', `failed to create next task: ${created.reason || 'unknown'}`);
        }
        const { projection: createdProjection, outPath: createdOutPath } = writeDefaultProjection(taskDb, db);
        const createdTask = compactTaskFromProjection(createdProjection, created.task_id);
        if (wantsJson(args)) {
          printJson({
            ok: true,
            action: 'created_next',
            task_id: created.task_id,
            owner: String(owner),
            scope: normalizeTaskQueueScope(scope),
            projection_path: createdOutPath,
            handoff,
            next_agent_action: nextAgentAction,
            note_version: created.note_version,
            operator_title_warning: created.operator_title_warning || null,
            task: createdTask,
            review_task: reviewTask,
          });
          return;
        }
        console.log(`created ${taskRef(createdTask)} @${owner}`);
        console.log(createdTask.title);
        console.log(`Noted v${created.note_version}. Landing remains pending on ${taskRef(reviewTask)}.`);
        console.log(`Verify: ${nextAgentAction.task_seed.verifier}`);
        return;
      }
      if (wantsJson(args)) {
        printJson({
          ok: true,
          action: handoff.next_action,
          task_id: handoff.next_action === 'continue_work' ? null : reviewTask.id,
          owner: String(owner),
          scope: normalizeTaskQueueScope(scope),
          projection_path: outPath,
          handoff,
          next_agent_action: nextAgentAction,
          continue_work_command: continueWorkCommand,
          continue_work_api: continueWorkCommand ? { method: 'POST', path: `/api/tasks/${encodeURIComponent(reviewTask.id)}/continue-work` } : null,
          review_task: reviewTask,
        });
        return;
      }
      console.log(noOpenTasksMessage(scope));
      console.log(handoff.next_action === 'agent_review_again'
        ? `${taskRef(reviewTask)} needs one more agent check before approval.`
        : `${taskRef(reviewTask)} is ready for approval.`);
      console.log(handoff.next_action === 'continue_work'
        ? 'Continue work elsewhere; XP is awarded only after the human approves this task.'
        : handoff.next_action === 'human_accept_waiting'
        ? (nextAgentAction ? nextAgentAction.message : 'No next agent task is attached; this task is ready for human approval.')
        : 'Review this task again before continuing.');
      if (nextAgentAction) console.log(`Command: ${nextAgentAction.command}`);
      if (nextAgentAction && nextAgentAction.task_seed) {
        console.log(`Create: ${nextAgentAction.task_seed.create_command}`);
        console.log(`Claim: ${nextAgentAction.task_seed.claim_command}`);
        console.log(`Note: ${nextAgentAction.task_seed.note_command}`);
        console.log(`Verify: ${nextAgentAction.task_seed.verifier}`);
      }
      if (continueWorkCommand) console.log(`Command: ${continueWorkCommand}`);
      return;
    }
    if (wantsJson(args)) {
      printJson({
        ok: true,
        action: 'none',
        task_id: null,
        owner: String(owner),
        scope: normalizeTaskQueueScope(scope),
        projection_path: outPath,
      });
      return;
    }
    console.log(noOpenTasksMessage(scope));
    console.log('Start with: atris task new "..."');
    return;
  }
  const result = taskDb.claimTask(db, { id: open[0].id, claimedBy: String(owner) });
  if (!result.claimed) {
    console.error(`next failed: ${result.reason}`);
    process.exit(1);
  }
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'next',
      task_id: open[0].id,
      owner: String(owner),
      scope: normalizeTaskQueueScope(scope),
      projection_path: outPath,
      task: compactTaskFromProjection(projection, open[0].id),
    });
    return;
  }
  console.log(`next ${taskRef(compactTaskFromProjection(projection, open[0].id))} @${owner}`);
  console.log(open[0].title);
  const ref = taskRef(compactTaskFromProjection(projection, open[0].id));
  const { printOperatorNext } = require('../../../lib/operator-next');
  printOperatorNext(`atris task step ${ref}`);
}

function continueWorkForReviewTask(taskDb, db, taskId, { owner = DEFAULT_OWNER } = {}) {
  const task = taskDetail(taskDb, db, taskId);
  if (!task) {
    const error = new Error(`task not found: ${taskId}`);
    error.reason = 'not_found';
    error.status = 404;
    throw error;
  }
  const handoff = reviewHandoffForTask(task);
  if (handoff && handoff.next_action === 'human_accept_waiting') {
    const error = new Error('agent-certified Review row has no specific next_task suggestion');
    error.reason = 'no_next_task';
    error.status = 409;
    throw error;
  }
  if (!handoff || handoff.next_action !== 'continue_work') {
    const error = new Error('task is not an agent-certified Review row ready for continuation');
    error.reason = 'not_continue_work_ready';
    error.status = 409;
    throw error;
  }
  const nextTitle = reviewNextTaskTitle(task);
  if (!nextTitle) {
    const error = new Error('agent-certified Review row has no specific next_task suggestion');
    error.reason = 'no_next_task';
    error.status = 409;
    throw error;
  }
  const nextCreated = createReviewNextTask(taskDb, db, task, nextTitle);
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  const parent = compactTaskFromProjection(projection, taskId) || compactTaskForStatus(taskDetail(taskDb, db, taskId));
  const nextTask = nextCreated
    ? compactTaskFromProjection(projection, nextCreated.id) || compactTaskForStatus(taskDetail(taskDb, db, nextCreated.id))
    : null;
  return {
    ok: true,
    action: 'continue_work',
    task_id: taskId,
    parent_task_id: taskId,
    next_task_id: nextCreated ? nextCreated.id : null,
    created: Boolean(nextCreated && nextCreated.inserted !== false),
    operator_title_warning: nextCreated ? nextCreated.operator_title_warning || null : null,
    owner: String(owner || DEFAULT_OWNER),
    projection_path: outPath,
    parent,
    next_task: nextTask,
    safety: {
      accepts_parent: false,
      human_accept: false,
      xp_after_human_accept: true,
    },
  };
}

function cmdContinueWork(args) {
  const pos = positional(args);
  const id = pos[0];
  if (!id) {
    failTask('atris task continue-work', 'missing_id', 'id required');
  }
  const owner = flag(args, '--as') || DEFAULT_OWNER;
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const taskId = requireTaskId(taskDb, db, id, 'atris task continue-work');
  let result;
  try {
    result = continueWorkForReviewTask(taskDb, db, taskId, { owner });
  } catch (error) {
    failTask('atris task continue-work', error.reason || 'continue_work_failed', error.message, error.status === 404 ? 1 : 2);
  }
  if (wantsJson(args)) {
    printJson(result);
    return;
  }
  console.log(`continue-work ${taskRef(result.parent)} -> ${taskRef(result.next_task)}`);
  console.log(result.created ? 'created follow-up task' : 'reused follow-up task');
  console.log('Human accept and XP remain pending on the parent.');
}

module.exports = {
  bindMain, taskQueueColumnKey, sortTasksNewestFirst, sortTasksOldestFirst, taskQueueItem,
  taskQueueLimit, cleanTaskScopeValue, normalizeTaskQueueScope, taskQueueScopeFromArgs,
  taskQueueScopeFromSearchParams, taskQueueScopeFromBody, mergeTaskQueueScopes,
  taskQueueScopeIsEmpty, taskScopeEquals, taskGoalScopeValues, taskReviewStateMatches,
  taskMatchesScopeTag, taskMatchesQueueScope, filterTasksByScope, taskQueueScopeWithoutReviewState,
  taskReviewStateCounts, taskHasReviewFollowUpChild, taskQueueReviewStateCounts,
  taskReviewStateActionSample, normalizeTaskIdSet, taskHasPendingReviewChat,
  pendingReviewChatActionSample, taskQueueReviewStateActions, formatTaskQueueScope,
  noOpenTasksMessage, taskQueueContract, selectTaskForCurrent, taskCurrentContract,
  buildTaskCurrent, printTaskCurrent, printTaskQueue, cmdCurrent, cmdQueue,
  suggestNextClaimableTask, liveTaskWithTitle, readEndgameAgentAction, shellQuoteTaskArg,
  buildEndgameTaskSeed, createEndgameSeedTask, nextActionFromCommand, cmdNextTruth,
  reportSkippedDecisionsAndExit, isUninitializedTaskFolder, cmdNext, continueWorkForReviewTask,
  cmdContinueWork,
};
