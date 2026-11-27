'use strict';

const { isPlanAwaitingApproval } = require('../../../lib/member-task-pick');
const { workerEnvMarker } = require('../../../lib/task-core');

// commands/task/board/board.js: The everyday board commands: add, list, status, day, home, keep,
// delegate, claim, release, and moving a task between plan, doing and backlog.
// Owner: unassigned. Moved out of commands/task.js on 2026-11-16 by lib/split-file.js; read
// README.md first.

// Names borrowed from commands/task.js and other feature folders, set by bindMain().
let fs, path, hasFlag, taskExplanation, approvalLines, normalizeOwnerSlug, resolveFunctionalTaskOwner,
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
  autoRenderTodoFromDb;
function bindMain(deps) {
  ({
    fs, path, hasFlag, taskExplanation, approvalLines, normalizeOwnerSlug,
    resolveFunctionalTaskOwner, decisionMarkerFor, buildFirstMinute, deskNextCommand,
    firstTalkCommand, folderName, personName, speakFirstMinute, loadContext, DEFAULT_OWNER,
    getTaskDb, warnIfTaskTitleNeedsOperatorWhy, flag, taskScopeEverywhere, scopedWorkspaceRoot,
    wantsJson, agentProofOnlyMode, printJson, failTask, textFlag, explanationFlags, numericFlag,
    positional, taskFromProjection, taskRef, taskColumn, taskHasReview, writeDefaultProjection,
    buildReviewFollowUpChildPredicate, handoffIsProofBoundaryBlocked, taskAssignee, taskApprovalFor,
    enrichTaskProjection, taskStateForCloud, latestTaskEvent, reviewHandoffForTask,
    normalizeTaskQueueScope, taskQueueScopeFromArgs, taskQueueScopeIsEmpty, filterTasksByScope,
    formatTaskQueueScope, certifiedPendingReviewTasks, readProjectionFile, requireTaskId,
    workspaceRefRows, DAY_STALE_FAILED_MS, DAY_TEXT_TASK_LIMIT, localDay, guardExplicitActor,
    suggestNextClaimableTask, isUninitializedTaskFolder, stageErrorDetail, taskDetail,
    buildAutomaticPlanTrace, autoRenderTodoFromDb,
  } = deps);
}

function compactTaskForStatus(task) {
  if (!task) return null;
  const metadata = task.metadata || {};
  const title = clipStatusTitle(task.title, 140);
  const out = {
    id: task.id,
    display_id: task.display_id || null,
    legacy_ref: task.legacy_ref || taskRef(task.id),
    title,
    result: clipStatusText(task.result || metadata.result, 180) || null,
    status: task.status,
    updated_at: task.updated_at,
    explanation: taskExplanation({ ...task, title }),
    approval: task.approval || taskApprovalFor(task),
  };
  if (task.tag) out.tag = task.tag;
  if (task.claimed_by) out.claimed_by = task.claimed_by;
  const assignedTo = taskAssignee(task);
  if (assignedTo) out.assigned_to = assignedTo;
  if (task.latest_event_type) out.latest_event_type = task.latest_event_type;
  if (task.objective) out.objective = clipStatusText(task.objective, 180);
  if (task.review) {
    const review = {};
    if (typeof task.review.reward === 'number') review.reward = task.review.reward;
    else if (task.review.reward === null) review.reward = null;
    if (task.review.landing) review.landing = task.review.landing;
    if (task.review.result) review.result = task.review.result;
    if (task.review.summary) review.summary = clipStatusText(task.review.summary, 240);
    if (task.review.proof) review.proof = clipStatusText(task.review.proof, 180);
    if (task.review.lesson) review.lesson = clipStatusText(task.review.lesson, 180);
    if (task.review.next_task) review.next_task = clipStatusText(task.review.next_task, 140);
    if (Object.prototype.hasOwnProperty.call(task.review, 'receipt_path')) review.receipt_path = task.review.receipt_path || null;
    if (task.review.approval_status) review.approval_status = task.review.approval_status;
    if (task.review.agent_review_pass_count) review.agent_review_pass_count = task.review.agent_review_pass_count;
    if (task.review.agent_certified) review.agent_certified = task.review.agent_certified;
    if (task.review.agent_certification_policy) review.agent_certification_policy = task.review.agent_certification_policy;
    if (task.review.human_revision_count) review.human_revision_count = task.review.human_revision_count;
    if (task.review.verification_chat) review.verification_chat = task.review.verification_chat;
    const handoff = reviewHandoffForTask(task, { suppressExistingFollowUp: true });
    if (handoff) review.handoff = handoff;
    if (Object.keys(review).length) out.review = review;
  }
  if (task.lineage) {
    const lineage = {};
    if (task.lineage.parent_task_id) lineage.parent_task_id = task.lineage.parent_task_id;
    if (task.lineage.parent_title) lineage.parent_title = clipStatusText(task.lineage.parent_title, 140);
    if (task.lineage.child_task_ids && task.lineage.child_task_ids.length) lineage.child_task_ids = task.lineage.child_task_ids;
    if (task.lineage.next_task_suggestion) lineage.next_task_suggestion = clipStatusText(task.lineage.next_task_suggestion, 140);
    if (Object.keys(lineage).length) out.lineage = lineage;
  }
  const compactMetadata = {};
  for (const key of ['todo_id', 'stage', 'verify', 'delegate_via', 'owner_resolution', 'requested_owner', 'executed_by', 'proposed_member', 'proposed_member_command', 'goal_id', 'task_goal', 'goal_objective', 'approval_status', 'agent_review_pass_count', 'agent_certified', 'agent_certification_policy', 'human_revision_count', 'human_revision_note']) {
    if (metadata[key]) compactMetadata[key] = key === 'verify' ? clipStatusText(metadata[key], 180) : metadata[key];
  }
  if (Object.keys(compactMetadata).length) out.metadata = compactMetadata;
  return out;
}

function compactTaskFromProjection(projection, id) {
  return compactTaskForStatus(taskFromProjection(projection, id));
}

function compactEventPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const out = {};
  for (const key of ['title', 'status', 'tag', 'content', 'goal', 'summary', 'proof', 'lesson', 'reward', 'next_task', 'result']) {
    if (payload[key] !== undefined && payload[key] !== null && payload[key] !== '') out[key] = payload[key];
  }
  return Object.keys(out).length ? out : null;
}

function compactTaskEvent(event) {
  if (!event) return null;
  return {
    event_id: event.event_id,
    task_id: event.task_id,
    version: event.version,
    actor: event.actor || null,
    event_type: event.event_type,
    created_at: event.created_at,
    payload: compactEventPayload(event.payload),
  };
}

function clipStatusText(value, max = 180) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function clipStatusTitle(value, max = 140) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max + 1);
  const boundaries = [...cut.matchAll(/[.!?;](?=\s|$)/g)];
  const boundary = boundaries.map((match) => match.index).filter((index) => index >= max * 0.45).pop();
  if (Number.isInteger(boundary)) {
    return cut.slice(0, boundary + 1).replace(/[;:]+$/, '').trim();
  }
  const wholeWords = text.slice(0, max).replace(/\s+\S*$/, '').trim();
  return `${wholeWords || text.slice(0, max).trim()}...`;
}

function compactReviewActionRef(task, { hasExistingReviewFollowUp = null } = {}) {
  if (!task) return null;
  const handoff = reviewHandoffForTask(task, { suppressExistingFollowUp: true, hasExistingReviewFollowUp }) || {};
  return {
    id: task.id,
    display_id: task.display_id || null,
    ref: taskRef(task),
    title: clipStatusText(task.title, 120),
    claimed_by: task.claimed_by || null,
    assigned_to: taskAssignee(task),
    next_action: handoff.next_action || null,
    next_task: handoff.next_task || null,
    command: handoff.continue_work_command || handoff.revise_command || null,
    reason: handoff.reason || null,
    next_action_detail: handoff.next_action_detail || null,
  };
}

function taskStatusSummary(projection, { history = false, hasExistingReviewFollowUp = null } = {}) {
  const tasks = projection.tasks || [];
  const hiddenDoneCount = Math.max(0, Number(projection.surface && projection.surface.hidden_done_count || 0));
  const fullTaskCount = Math.max(tasks.length + hiddenDoneCount, Number(projection.surface && projection.surface.full_task_count || 0));
  const columns = {
    backlog: tasks.filter(task => taskColumn(task) === 'backlog'),
    plan: tasks.filter(task => taskColumn(task) === 'open'),
    do: tasks.filter(task => taskColumn(task) === 'doing'),
    review: tasks.filter(task => taskColumn(task) === 'review'),
    blocked: tasks.filter(task => taskColumn(task) === 'blocked'),
    done: tasks.filter(task => taskColumn(task) === 'done'),
  };
  const active = [...columns.do, ...columns.review, ...columns.blocked, ...columns.plan];
  const reviewNeedingAgentAction = columns.review.filter(task => {
    const handoff = reviewHandoffForTask(task, { suppressExistingFollowUp: true, hasExistingReviewFollowUp });
    return handoff && handoff.next_action === 'agent_review_again';
  });
  const reviewContinueWork = columns.review.filter(task => {
    const handoff = reviewHandoffForTask(task, { suppressExistingFollowUp: true, hasExistingReviewFollowUp });
    return handoff && handoff.next_action === 'continue_work';
  });
  const reviewHumanAcceptWaiting = columns.review.filter(task => {
    const handoff = reviewHandoffForTask(task, { suppressExistingFollowUp: true, hasExistingReviewFollowUp });
    return handoff && handoff.next_action === 'human_accept_waiting';
  });
  const reviewProofBoundaryBlocked = columns.review.filter(task => {
    const handoff = reviewHandoffForTask(task, { suppressExistingFollowUp: true, hasExistingReviewFollowUp });
    return handoffIsProofBoundaryBlocked(handoff);
  });
  const reviewAgentCertified = reviewContinueWork.length + reviewHumanAcceptWaiting.length + reviewProofBoundaryBlocked.length;
  const blocked = columns.blocked.length;
  const lastUpdated = tasks.reduce((max, task) => Math.max(max, Number(task.updated_at || 0)), 0);
  const swarloFeed = history ? tasks
    .flatMap(task => (task.events || []).map(event => ({
      task_id: task.id,
      task_title: clipStatusText(task.title, 120),
      actor: event.actor || task.claimed_by || null,
      kind: event.event_type === 'claimed'
        ? 'claim'
        : event.event_type === 'completed' || event.event_type === 'reviewed'
          ? 'result'
          : 'note',
      channel: task.tag || 'tasks',
      content: clipStatusText(
        event.payload && (event.payload.content || event.payload.proof || event.payload.lesson)
          || humanEventType(event.event_type),
        180,
      ),
      created_at: event.created_at,
      metadata: {
        swarlo: {
          task_key: task.id,
          kind: event.event_type === 'claimed' ? 'claim' : event.event_type === 'completed' || event.event_type === 'reviewed' ? 'result' : 'note',
          status: taskStateForCloud(task),
        },
      },
    })))
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, 12) : [];
  const status = {
    schema: 'atris.task_status.v1',
    generated_at: projection.generated_at,
    workspace_root: projection.workspace_root,
    goals: projection.goals || { source_path: null, items: [] },
    counts: {
      total: fullTaskCount,
      active: columns.plan.length + columns.do.length + reviewNeedingAgentAction.length + reviewProofBoundaryBlocked.length,
      backlog: columns.backlog.length,
      plan: columns.plan.length,
      do: columns.do.length,
      review: columns.review.length,
      review_blocking: reviewNeedingAgentAction.length,
      review_certified: reviewAgentCertified,
      review_continue_work: reviewContinueWork.length,
      review_proof_boundary_blocked: reviewProofBoundaryBlocked.length,
      review_human_accept_waiting: reviewHumanAcceptWaiting.length,
      blocked,
      done: tasks.filter(task => task.status === 'done' || (task.status === 'failed' && taskHasReview(task))).length + hiddenDoneCount,
    },
    current: compactTaskForStatus(columns.do[0] || reviewNeedingAgentAction[0] || reviewProofBoundaryBlocked[0] || null),
    next: compactTaskForStatus(columns.plan[0] || null),
    review_actions: {
      continue_work: {
        count: reviewContinueWork.length,
        first: compactReviewActionRef(reviewContinueWork[0] || null, { hasExistingReviewFollowUp }),
      },
      proof_boundary_blocked: {
        count: reviewProofBoundaryBlocked.length,
        first: compactReviewActionRef(reviewProofBoundaryBlocked[0] || null, { hasExistingReviewFollowUp }),
      },
      human_accept_waiting: {
        count: reviewHumanAcceptWaiting.length,
        first: compactReviewActionRef(reviewHumanAcceptWaiting[0] || null, { hasExistingReviewFollowUp }),
      },
    },
    needs_review: columns.review.slice(0, 5).map(compactTaskForStatus),
    streams: (projection.streams || []).slice(0, 8).map(stream => ({
      objective: stream.objective,
      active_count: stream.active_count,
      done_count: stream.done_count,
      open_count: stream.open_count,
      doing_count: stream.doing_count,
      review_count: stream.review_count,
      blocked_count: stream.blocked_count,
      tasks: (stream.tasks || []).map(task => ({
        id: task.id,
        title: clipStatusText(task.title, 120),
        status: task.status,
        tag: task.tag || null,
        claimed_by: task.claimed_by || null,
        assigned_to: task.assigned_to || null,
        parent_task_id: task.parent_task_id || null,
        child_task_ids: task.child_task_ids || [],
        proof: task.proof || null,
      })),
    })),
    last_updated_at: lastUpdated ? new Date(lastUpdated).toISOString() : null,
  };
  if (history) {
    status.last_event = active.map(task => ({ task: compactTaskForStatus(task), event: compactTaskEvent(latestTaskEvent(task)) })).filter(row => row.event)
      .sort((a, b) => b.event.created_at - a.event.created_at)[0] || null;
    status.swarlo = {
      feed: swarloFeed,
      realtime_contract: {
        claim: 'Swarlo claim -> canonical task state=doing + lease metadata',
        report_done: 'Swarlo report(done) -> canonical task state=done + proof metadata',
        web: 'atrisos-web reads canonical tasks through /api/agent/:id/tasks or /api/business/* and live activity through public business/Swarlo posts',
      },
    };
  }
  return status;
}

function humanEventType(type) {
  return String(type || 'event').replace(/_/g, ' ');
}

function taskEventSummary(event) {
  const payload = event && event.payload || {};
  const raw = payload.content || payload.proof || payload.lesson || payload.title || payload.status || humanEventType(event && event.event_type);
  return clipStatusText(raw, 140);
}

function formatTaskEventCompact(event, refById = new Map()) {
  const actor = event.actor ? ` @${event.actor}` : '';
  const when = event.created_at ? new Date(Number(event.created_at)).toISOString() : '';
  return `${when}\t${event.event_type.padEnd(9)}\t${refById.get(event.task_id) || taskRef(event.task_id)}${actor}\t${taskEventSummary(event)}`;
}

function formatTaskLine(task) {
  if (!task) return 'none';
  const explanation = task.explanation || taskExplanation(task);
  return explanation.what_changes.replace(/\.$/, '');
}

function printStatusTask(label, task) {
  console.log(`${label.padEnd(7)} ${formatTaskLine(task)}`);
  if (!task) return;
  for (const line of approvalLines(task.approval || taskApprovalFor(task), { indent: '        ' })) console.log(line);
  const owner = task.claimed_by || taskAssignee(task);
  const ownerText = owner ? `; owner: ${owner}` : '';
  console.log(`        Technical details: atris task show ${taskRef(task)}${ownerText}`);
}

function cmdStatus(args) {
  const all = hasFlag(args, '--all');
  const everywhere = taskScopeEverywhere(args);
  const history = hasFlag(args, '--history');
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const workspaceRoot = scopedWorkspaceRoot(taskDb, args, { everywhere });
  const compact = writeDefaultProjection(taskDb, db, { all, everywhere });
  const projection = history
    ? enrichTaskProjection(taskDb.taskProjection(db, {
      workspaceRoot,
      limit: all ? null : 500,
      includeHistory: true,
    }))
    : compact.projection;
  const outPath = compact.outPath;
  const hasExistingReviewFollowUp = buildReviewFollowUpChildPredicate(taskDb, db, workspaceRoot);
  const status = taskStatusSummary(projection, { history, hasExistingReviewFollowUp });
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'status',
      projection_path: outPath,
      status,
    });
    return;
  }
  console.log('TASK STATUS');
  console.log(`workspace ${status.workspace_root || '(all)'}`);
  console.log(`plan ${status.counts.plan} / do ${status.counts.do} / review ${status.counts.review} / backlog ${status.counts.backlog} / done ${status.counts.done}`);
  printStatusTask('current', status.current);
  printStatusTask('next', status.next);
  if (status.needs_review.length) {
    console.log('review');
    for (const task of status.needs_review.slice(0, 3)) printStatusTask('review', task);
  }
  if (history) console.log(`history feed ${status.swarlo.feed.length} event${status.swarlo.feed.length === 1 ? '' : 's'}`);
}

function renderTaskDesk(rows, refRows = rows) {
  const displayRows = (rows && rows.length && rows[0].display_id) ? rows : getTaskDb().withTaskDisplayRefs(rows, refRows);
  const active = displayRows.filter(r => r.status !== 'done' && r.status !== 'archived');
  const done = displayRows.filter(r => r.status === 'done');
  if (rows.length === 0) {
    console.log('No tasks yet.');
    console.log('Start with: atris task new "Ship the smallest useful thing"');
    return;
  }
  console.log('TASK DESK');
  console.log('');
  for (const r of active.slice(0, 12)) {
    const explanation = r.explanation || taskExplanation(r);
    const owner = r.claimed_by ? ` @${r.claimed_by}` : '';
    const assigned = !r.claimed_by && taskAssignee(r) ? ` -> ${taskAssignee(r)}` : '';
    const tag = r.tag ? ` #${r.tag}` : '';
    const decision = decisionMarkerFor(r) ? ` ${decisionMarkerFor(r)}` : '';
    console.log(`What changes: ${explanation.what_changes}`);
    console.log(`        ${r.status.padEnd(7)} ${taskRef(r)}${owner}${assigned}${tag}${decision}`);
    console.log(`        Why it matters: ${explanation.why_it_matters}`);
    console.log(`        Done looks like: ${explanation.done_looks_like}`);
    for (const line of approvalLines(taskApprovalFor(r), { indent: '        ' })) console.log(line);
    console.log(`        Technical details: ${compactTechnicalDetails(r)}`);
  }
  if (active.length === 0) console.log('clear   no active tasks');
  console.log('');
  console.log(`active ${active.length} / done ${done.length}`);
  console.log(`next: ${deskNextCommand(displayRows, personName())}`);
}

function cmdAdd(args) {
  const root = process.cwd();
  // Empty folder talks like bare atris. A leftover title is not a
  // task desk. After init, a title still files.
  if (isUninitializedTaskFolder(root)) {
    if (wantsJson(args)) {
      printJson({
        ok: false,
        action: 'none',
        command: firstTalkCommand(folderName(root)),
        task_id: null,
        projection_path: null,
        task: null,
      });
      return;
    }
    return speakFirstMinute({ root, fresh: true });
  }
  const pos = positional(args);
  const title = pos.join(' ').trim();
  if (!title) {
    failTask('atris task add', 'missing_title', 'title required');
  }
  const tag = flag(args, '--tag');
  const goalId = flag(args, '--goal-id');
  const goalObjective = flag(args, '--goal-objective') || flag(args, '--goal');
  const verify = flag(args, '--verify');
  const metadata = {};
  if (goalId && goalId !== true) metadata.goal_id = String(goalId);
  if (goalObjective && goalObjective !== true) {
    metadata.task_goal = String(goalObjective);
    metadata.goal_objective = String(goalObjective);
  }
  if (typeof verify === 'string' && verify.trim()) metadata.verify = verify.trim();
  Object.assign(metadata, explanationFlags(args));
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const ws = taskDb.workspaceRoot();
  // Filing a job that is already open or claimed hands back that job instead
  // of making a copy. Work already handed in for review can be filed again.
  const existing = taskDb.findUnfinishedTaskByTitle(db, { workspaceRoot: ws, title });
  if (existing) {
    const { projection, outPath } = writeDefaultProjection(taskDb, db);
    const task = compactTaskFromProjection(projection, existing.id);
    if (wantsJson(args)) {
      printJson({
        ok: true,
        action: 'reused',
        task_id: existing.id,
        inserted: false,
        operator_title_warning: null,
        projection_path: outPath,
        task,
      });
      return;
    }
    console.log(`${taskRef(task)}\t${existing.title}\t(already on the list, reused)`);
    return;
  }
  const operatorTitleWarning = warnIfTaskTitleNeedsOperatorWhy(title);
  // Generation throttle, the named root cause is generation > human-review rate. An AGENT cannot keep
  // minting tasks while a wall of certified-but-unaccepted work waits; that treadmill is what accept-group
  // only drains. Humans and --force bypass. Closes the tap instead of just enlarging the bucket.
  if (agentProofOnlyMode() && !hasFlag(args, '--force')) {
    const { projection: backlogProjection } = writeDefaultProjection(taskDb, db);
    const pending = certifiedPendingReviewTasks(backlogProjection).length;
    const cap = Math.max(1, Number(process.env.ATRIS_TASK_BACKLOG_CAP || 200) || 200);
    if (pending >= cap) {
      failTask('atris task add', 'backlog_throttle', `refusing agent add: ${pending} certified task(s) await human review (cap ${cap}). Drain with 'atris task accept-group' or pass --force.`);
    }
  }
  const result = taskDb.addTask(db, {
    title,
    tag: typeof tag === 'string' ? tag : null,
    workspaceRoot: ws,
    metadata: Object.keys(metadata).length ? metadata : null,
  });
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  const task = compactTaskFromProjection(projection, result.id);
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'created',
      task_id: result.id,
      inserted: result.inserted !== false,
      operator_title_warning: operatorTitleWarning,
      projection_path: outPath,
      task,
    });
    return;
  }
  console.log(`${taskRef(task)}\t${title}`);
  if (!metadata.verify) console.log(`this task has no check yet, so it cannot be marked ready without one; add one when ready: atris task ready ${taskRef(task)} --verify "<command>" --result "<result>"`);
}

function delegateHandoff(task, owner, via, tag) {
  const ref = taskRef(task);
  const handoff = {
    command: `atris task claim ${ref} --as ${owner}`,
  };
  if (via === 'swarlo') {
    handoff.swarlo = {
      task_key: task.id,
      action: 'claim',
      channel: tag || 'tasks',
      assignee: owner,
    };
  }
  return handoff;
}

function delegateTask(args, options = {}) {
  const pos = positional(args);
  const title = pos.join(' ').trim();
  if (!title) {
    failTask('atris task delegate', 'missing_title', 'title required');
  }
  const viaFlag = flag(args, '--via');
  const via = viaFlag === 'swarlo' ? 'swarlo' : 'local';
  const tag = flag(args, '--tag');
  const note = flag(args, '--note');
  const goalId = flag(args, '--goal-id');
  const goalObjective = flag(args, '--goal-objective') || flag(args, '--goal');
  const verify = flag(args, '--verify');
  const claimNow = hasFlag(args, '--claim');
  const requestedOwner = flag(args, '--to') || flag(args, '--as');
  const explicitExecutedBy = flag(args, '--executed-by');
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const ws = taskDb.workspaceRoot();
  const operatorTitleWarning = warnIfTaskTitleNeedsOperatorWhy(title, { print: options.warnOperatorTitle !== false });
  const ownerResolution = resolveFunctionalTaskOwner({
    requestedOwner: requestedOwner && requestedOwner !== true ? requestedOwner : null,
    title,
    tag,
    note,
    goal: goalObjective && goalObjective !== true ? goalObjective : '',
    root: ws,
  });
  const owner = ownerResolution.owner;
  const executedBy = explicitExecutedBy && explicitExecutedBy !== true
    ? normalizeOwnerSlug(explicitExecutedBy)
    : ownerResolution.executed_by;
  const metadata = {
    assigned_to: owner,
    delegate_via: via,
    swarlo_channel: via === 'swarlo' ? String(tag || 'tasks') : null,
    created_for_day: localDay(),
    owner_resolution: ownerResolution.reason,
  };
  if (ownerResolution.requested_owner) metadata.requested_owner = ownerResolution.requested_owner;
  if (executedBy) metadata.executed_by = executedBy;
  if (ownerResolution.proposed_member) {
    metadata.proposed_member = ownerResolution.proposed_member;
    metadata.proposed_member_command = `atris member create ${ownerResolution.proposed_member} --role="${ownerResolution.proposed_member.replace(/-/g, ' ')}"`;
  }
  if (goalId && goalId !== true) metadata.goal_id = String(goalId);
  if (goalObjective && goalObjective !== true) {
    metadata.task_goal = String(goalObjective);
    metadata.goal_objective = String(goalObjective);
  }
  if (typeof verify === 'string' && verify.trim()) metadata.verify = verify.trim();
  Object.assign(metadata, explanationFlags(args));
  const result = taskDb.addTask(db, {
    title,
    tag: typeof tag === 'string' ? tag : null,
    workspaceRoot: ws,
    status: claimNow ? 'claimed' : 'open',
    claimedBy: claimNow ? owner : null,
    metadata,
  });
  if (typeof note === 'string' && note.trim()) {
    taskDb.noteTask(db, { id: result.id, actor: DEFAULT_OWNER, content: note });
  }
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  const task = compactTaskFromProjection(projection, result.id);
  const handoff = delegateHandoff(task, owner, via, typeof tag === 'string' ? tag : null);
  return {
    ok: true,
    action: 'delegated',
    task_id: result.id,
    inserted: result.inserted !== false,
    owner,
    owner_resolution: ownerResolution,
    executed_by: executedBy || null,
    via,
    tag: typeof tag === 'string' ? tag : null,
    handoff,
    proposed_member_command: metadata.proposed_member_command || null,
    operator_title_warning: operatorTitleWarning,
    projection_path: outPath,
    task,
  };
}

function cmdDelegate(args) {
  const payload = delegateTask(args);
  if (wantsJson(args)) {
    printJson(payload);
    return;
  }
  const tagText = payload.tag ? ` #${payload.tag}` : '';
  console.log(`delegated ${taskRef(payload.task)} -> ${payload.owner}${tagText} via=${payload.via}`);
  if (payload.executed_by) console.log(`executed_by: ${payload.executed_by}`);
  if (payload.proposed_member_command) console.log(`member: ${payload.proposed_member_command}`);
  console.log(`claim: ${payload.handoff.command}`);
  if (payload.handoff.swarlo) console.log(`swarlo: ${payload.handoff.swarlo.channel}/${payload.handoff.swarlo.action}`);
}

function taskDayTextGroups(groups, { full = false } = {}) {
  if (full) return { groups, hiddenTasks: 0, hiddenOwners: 0 };
  const statusOrder = { claimed: 0, open: 1, review: 2, failed: 3, done: 4 };
  const ranked = groups
    .flatMap((group) => group.tasks)
    .sort((a, b) => ((statusOrder[a.status] ?? 5) - (statusOrder[b.status] ?? 5))
      || ((b.updated_at || 0) - (a.updated_at || 0)));
  const selected = new Set(ranked.slice(0, DAY_TEXT_TASK_LIMIT));
  const visibleGroups = groups
    .map((group) => ({ ...group, tasks: group.tasks.filter((task) => selected.has(task)) }))
    .filter((group) => group.tasks.length > 0);
  return {
    groups: visibleGroups,
    hiddenTasks: Math.max(0, ranked.length - selected.size),
    hiddenOwners: Math.max(0, groups.length - visibleGroups.length),
  };
}

function taskDayTitle(title, maxLength = 120) {
  const text = String(title || '').replace(/\s*[\u2014\u2013]\s*/g, ' - ').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  const sentence = text.slice(0, maxLength + 1).match(/^(.{48,}?[.!?])(?:\s|$)/);
  if (sentence) return sentence[1];
  const clipped = text.slice(0, maxLength).replace(/\s+\S*$/, '').trim();
  return `${clipped || text.slice(0, maxLength).trim()}...`;
}

function compactTechnicalDetails(task, formatTitle = value => value) {
  const explanation = task.explanation || taskExplanation(task);
  return explanation.sources && explanation.sources.what_changes === 'derived'
    ? `atris task show ${taskRef(task)}`
    : formatTitle(task.title);
}

function taskDayGroups(tasks, { now = Date.now() } = {}) {
  const active = tasks.filter(task => task.status !== 'done' && task.status !== 'archived');
  const staleFailed = [];
  const visible = [];
  for (const task of active) {
    const isStaleFailed = task.status === 'failed' && (now - (task.updated_at || 0)) > DAY_STALE_FAILED_MS;
    if (isStaleFailed) staleFailed.push(task);
    else visible.push(task);
  }
  const groups = new Map();
  for (const task of visible) {
    const owner = taskAssignee(task) || 'unassigned';
    if (!groups.has(owner)) groups.set(owner, []);
    groups.get(owner).push(task);
  }
  const grouped = Array.from(groups.entries())
    .sort((a, b) => {
      if (a[0] === 'unassigned') return 1;
      if (b[0] === 'unassigned') return -1;
      return a[0].localeCompare(b[0]);
    })
    .map(([owner, ownerTasks]) => ({
      owner,
      tasks: ownerTasks.sort((a, b) => {
        const statusOrder = { claimed: 0, open: 1, failed: 2, done: 3 };
        return (statusOrder[a.status] - statusOrder[b.status]) || (b.updated_at - a.updated_at);
      }),
    }));
  return { groups: grouped, staleFailed };
}

function refreshKeptTaskList(cwd = process.cwd()) {
  const taskDb = getTaskDb();
  const db = taskDb.open();
  writeDefaultProjection(taskDb, db);
  autoRenderTodoFromDb(cwd);
}

function keptCount(result) {
  return (result && result.put_away ? result.put_away.length : 0)
    + (result && result.reaped ? result.reaped.length : 0);
}

function cmdKeep(args) {
  const result = require('../../../lib/task-list-keeper').keepWorkspaceTaskList(process.cwd());
  if (keptCount(result)) refreshKeptTaskList(process.cwd());
  const count = keptCount(result);
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'keep',
      count,
      put_away: result.put_away,
      reaped: result.reaped,
    });
    return;
  }
  if (!count) {
    console.log('task list is current. nothing to put away.');
    return;
  }
  const noun = count === 1 ? 'item' : 'items';
  console.log(`put away ${count} ${noun} that were finished or sitting still.`);
}

function cmdDay(args) {
  const kept = require('../../../lib/task-list-keeper').keepWorkspaceTaskList(process.cwd());
  if (keptCount(kept)) autoRenderTodoFromDb(process.cwd());
  const all = hasFlag(args, '--all');
  const full = hasFlag(args, '--full');
  const everywhere = taskScopeEverywhere(args);
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const { projection, outPath } = writeDefaultProjection(taskDb, db, { all, everywhere });
  const { groups, staleFailed } = taskDayGroups(projection.tasks || []);
  const counts = {
    active: groups.reduce((sum, group) => sum + group.tasks.length, 0),
    owners: groups.length,
    open: (projection.tasks || []).filter(task => task.status === 'open').length,
    claimed: (projection.tasks || []).filter(task => task.status === 'claimed').length,
    review: (projection.tasks || []).filter(task => task.status === 'review').length,
    failed: (projection.tasks || []).filter(task => task.status === 'failed').length,
    stale_failed: staleFailed.length,
  };
  const date = localDay();
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'day',
      date,
      projection_path: outPath,
      counts,
      groups,
      stale_failed: {
        count: staleFailed.length,
        refs: staleFailed.map(task => taskRef(task)),
      },
    });
    return;
  }
  const textView = taskDayTextGroups(groups, { full });
  console.log('task day');
  const failedText = counts.failed > 0 ? ` / failed ${counts.failed}` : '';
  console.log(`${date}  active ${counts.active} / owners ${counts.owners} / review ${counts.review}${failedText}`);
  console.log('');
  if (!groups.length) {
    console.log('clear   no active tasks');
  }
  for (const group of textView.groups) {
    console.log(`${group.owner}`);
    for (const task of group.tasks) {
      const explanation = task.explanation || taskExplanation(task);
      const tag = task.tag ? ` #${task.tag}` : '';
      const claim = task.claimed_by ? ` @${task.claimed_by}` : '';
      const decision = decisionMarkerFor(task) ? ` ${decisionMarkerFor(task)}` : '';
      console.log(`  What changes: ${explanation.what_changes}`);
      console.log(`          ${task.status.padEnd(7)} ${taskRef(task)}${claim}${tag}${decision}`);
      console.log(`          Why it matters: ${explanation.why_it_matters}`);
      console.log(`          Done looks like: ${explanation.done_looks_like}`);
      for (const line of approvalLines(task.approval || taskApprovalFor(task), { indent: '          ' })) console.log(line);
      console.log(`          Technical details: ${compactTechnicalDetails(task, taskDayTitle)}`);
    }
  }
  if (textView.hiddenTasks > 0) {
    console.log('');
    const ownerText = textView.hiddenOwners > 0 ? `, ${textView.hiddenOwners} owners not shown` : '';
    console.log(`more    ${textView.hiddenTasks} active rows hidden${ownerText} - atris task day --full`);
  }
  if (staleFailed.length) {
    console.log('');
    console.log(`stale   ${staleFailed.length} failed >7d hidden - atris task list --status failed`);
  }
  console.log('');
  console.log('add: atris task delegate "..." --to task-planner --tag tasks');
}

function cmdFirstMinute() {
  const root = process.cwd();
  const fresh = !fs.existsSync(path.join(root, 'atris'));
  let context = {};
  if (!fresh) {
    try {
      context = loadContext(root);
    } catch {
      context = {};
    }
  }
  const screen = buildFirstMinute({
    root,
    fresh,
    context,
  });
  console.log(screen.text);
}

function cmdHome(args) {
  const all = hasFlag(args, '--all');
  const everywhere = taskScopeEverywhere(args);
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const workspaceRoot = scopedWorkspaceRoot(taskDb, args, { everywhere });
  const rows = taskDb.listTasks(db, {
    workspaceRoot,
    limit: all ? null : 200,
  });
  let projection;
  let outPath;
  const existingProj = readProjectionFile(workspaceRoot);
  if (rows.length === 0 && existingProj && Array.isArray(existingProj.tasks) && existingProj.tasks.length > 0) {
    projection = existingProj;
    outPath = path.resolve(path.join(workspaceRoot || '.', '.atris', 'state', 'tasks.projection.json'));
  } else {
    const written = writeDefaultProjection(taskDb, db, { all, everywhere });
    projection = written.projection;
    outPath = written.outPath;
  }
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'desk',
      projection_path: outPath,
      active_count: projection.tasks.filter(t => t.status !== 'done').length,
      done_count: projection.tasks.filter(t => t.status === 'done').length,
      projection,
    });
    return;
  }
  renderTaskDesk(projection.tasks);
}

function cmdList(args) {
  const all = hasFlag(args, '--all');
  const everywhere = taskScopeEverywhere(args);
  const status = flag(args, '--status');
  const scope = taskQueueScopeFromArgs(args);
  const scoped = !taskQueueScopeIsEmpty(scope);
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const workspaceRoot = scopedWorkspaceRoot(taskDb, args, { everywhere });
  const rawRows = taskDb.listTasks(db, {
    workspaceRoot,
    status: typeof status === 'string' ? status : null,
    limit: scoped || all ? null : 200,
  });
  const rows = filterTasksByScope(rawRows, scope);
  const displayRows = taskDb.withTaskDisplayRefs(rows, workspaceRefRows(taskDb, db, { everywhere }));
  if (wantsJson(args)) {
    const tasks = displayRows.map(task => ({
      ...task,
      explanation: taskExplanation(task),
      approval: taskApprovalFor(task),
    }));
    printJson({ ok: true, action: 'list', scope: normalizeTaskQueueScope(scope), tasks });
    return;
  }
  if (rows.length === 0) {
    const scopeText = formatTaskQueueScope(scope);
    console.log(scopeText ? `(no tasks for ${scopeText})` : '(no tasks)');
    return;
  }
  for (const r of displayRows) {
    const explanation = taskExplanation(r);
    const claim = r.claimed_by ? ` [${r.claimed_by}]` : '';
    const tag = r.tag ? ` #${r.tag}` : '';
    const decision = decisionMarkerFor(r) ? ` ${decisionMarkerFor(r)}` : '';
    console.log(`What changes: ${explanation.what_changes}`);
    console.log(`         ${r.status.padEnd(8)} ${taskRef(r)}${claim}${tag}${decision}`);
    console.log(`         Why it matters: ${explanation.why_it_matters}`);
    console.log(`         Done looks like: ${explanation.done_looks_like}`);
    for (const line of approvalLines(taskApprovalFor(r), { indent: '         ' })) console.log(line);
    console.log(`         Technical details: ${compactTechnicalDetails(r)}`);
  }
}

function cmdClaim(args) {
  const pos = positional(args);
  const id = pos[0];
  if (!id) {
    failTask('atris task claim', 'missing_id', 'id required');
  }
  guardExplicitActor('atris task claim', flag(args, '--as'));
  const owner = flag(args, '--as') || DEFAULT_OWNER;
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const taskId = requireTaskId(taskDb, db, id, 'atris task claim');
  if (Boolean(workerEnvMarker())) {
    const existingTask = taskDb.getTask(db, taskId);
    if (isPlanAwaitingApproval(existingTask)) {
      failTask(
        'atris task claim',
        'plan_awaiting_approval',
        'plan is waiting on a person to approve before claiming',
        2,
      );
    }
  }
  const leaseMinutes = flag(args, '--lease-minutes');
  const leasePid = flag(args, '--lease-pid');
  if (leaseMinutes != null && (!Number.isFinite(Number(leaseMinutes)) || Number(leaseMinutes) <= 0 || !Number.isInteger(Number(leasePid)) || Number(leasePid) <= 0)) throw new Error('invalid claim lease');
  const result = taskDb.claimTask(db, { id: taskId, claimedBy: String(owner), ...(leaseMinutes == null ? {} : { leaseMinutes: Number(leaseMinutes), leasePid: Number(leasePid) }) });
  if (result.claimed) {
    const { projection, outPath } = writeDefaultProjection(taskDb, db);
    if (wantsJson(args)) {
      printJson({
        ok: true,
        action: 'claimed',
        task_id: taskId,
        owner: String(owner),
        projection_path: outPath,
        task: compactTaskFromProjection(projection, taskId),
      });
      return;
    }
    const ref = taskRef(compactTaskFromProjection(projection, taskId));
    console.log(`claimed ${ref} as ${owner}`);
    console.log(`Next: make the change, then run: atris task ready ${ref} --verify "git diff --check" --result "<who can do what now and why>" --landing "<what someone can do now>"`);
    console.log('Use a different verifier only if autoland can rerun it, such as `node --test <file>`.');
    console.log('Then: atris autoland tick');
  } else {
    const recoveryCommand = result.reason === 'already_claimed' && result.claimed_by
      ? `atris task release ${id} --as ${result.claimed_by}`
      : null;
    let nextClaimable = null;
    if (result.reason === 'already_done') {
      const doneRow = taskDb.getTask(db, taskId);
      const { projection } = writeDefaultProjection(taskDb, db);
      nextClaimable = suggestNextClaimableTask(projection, { excludeId: taskId, tag: doneRow && doneRow.tag });
    }
    if (wantsJson(args)) {
      printJson({
        ok: false,
        command: 'atris task claim',
        reason: result.reason,
        claimed_by: result.claimed_by || null,
        recovery_command: recoveryCommand,
        next_claimable: nextClaimable ? { id: nextClaimable.id, ref: taskRef(nextClaimable), tag: nextClaimable.tag || null, title: nextClaimable.title } : null,
        detail: `claim failed: ${result.reason}${result.claimed_by ? ` (held by ${result.claimed_by})` : ''}`,
      });
      process.exit(1);
    }
    console.error(`claim failed: ${result.reason}${result.claimed_by ? ` (held by ${result.claimed_by})` : ''}`);
    if (recoveryCommand) console.error(`Recovery: ${recoveryCommand}`);
    if (nextClaimable) {
      console.error(`next claimable: ${taskRef(nextClaimable)} ${String(nextClaimable.title || '').slice(0, 80)} (atris task claim ${taskRef(nextClaimable)} --as ${owner})`);
    }
    process.exit(1);
  }
}

function cmdRelease(args) {
  const pos = positional(args);
  const id = pos[0];
  if (!id) {
    failTask('atris task release', 'missing_id', 'id required');
  }
  const owner = flag(args, '--as') || DEFAULT_OWNER;
  const reasonFlag = flag(args, '--reason');
  // This command takes no kind and no pull request. A release that says its work is
  // waiting on a person would keep a miss out of the rating, and any worker holding a
  // failed job could type that to excuse itself. Only the dispatch flight, which
  // opened the pull request itself, records that release, in its own process through
  // releaseTask. Flags this command does not know are ignored, so a release that still
  // passes them is a plain release and is rated as a drop.
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const taskId = requireTaskId(taskDb, db, id, 'atris task release');
  const result = taskDb.releaseTask(db, {
    id: taskId,
    actor: String(owner),
    reason: typeof reasonFlag === 'string' ? reasonFlag : undefined,
  });
  if (result.released) {
    const { projection, outPath } = writeDefaultProjection(taskDb, db);
    const task = compactTaskFromProjection(projection, taskId);
    const keptReason = result.event && result.event.payload && result.event.payload.reason || null;
    if (wantsJson(args)) {
      printJson({
        ok: true,
        action: 'released',
        task_id: taskId,
        owner: String(owner),
        reason: keptReason,
        projection_path: outPath,
        task,
        event_version: result.event && result.event.version || null,
      });
      return;
    }
    console.log(`released ${taskRef(task)} from ${owner}${keptReason ? ` (${keptReason})` : ''}`);
    console.log(`Next: atris task next --as ${owner}`);
    return;
  }
  if (wantsJson(args)) {
    printJson({
      ok: false,
      command: 'atris task release',
      reason: result.reason,
      claimed_by: result.claimed_by || null,
      detail: `release failed: ${result.reason}${result.claimed_by ? ` (held by ${result.claimed_by})` : ''}`,
    });
    process.exit(1);
  }
  console.error(`release failed: ${result.reason}${result.claimed_by ? ` (held by ${result.claimed_by})` : ''}`);
  process.exit(1);
}

function cmdPlan(args) {
  const pos = positional(args);
  const id = pos[0];
  if (!id) failTask('atris task plan', 'missing_id', 'id required');
  const actorFlag = flag(args, '--as');
  const actor = String(actorFlag || DEFAULT_OWNER);
  const goal = textFlag(args, ['--goal', '--objective']);
  const exit = textFlag(args, ['--exit', '--exit-condition']);
  const proofNeeded = textFlag(args, ['--proof-needed', '--proof', '--verify']);
  const summary = textFlag(args, ['--summary', '--plan']);
  const owner = textFlag(args, ['--owner', '--assignee']);
  const firstMove = textFlag(args, ['--first-move', '--first']);
  const nextButton = textFlag(args, ['--next-button']);
  const confidence = numericFlag(args, '--confidence');
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const taskId = requireTaskId(taskDb, db, id, 'atris task plan');
  const task = taskDetail(taskDb, db, taskId);
  const automaticPlan = buildAutomaticPlanTrace(taskDb, task, {
    actor,
    actorExplicit: typeof actorFlag === 'string' && Boolean(actorFlag.trim()),
    owner,
    goal,
    summary,
    firstMove,
    exit,
  });
  const result = taskDb.stageTask(db, {
    id: taskId,
    actor,
    stage: 'plan',
    goal,
    summary,
    owner: automaticPlan.ownerForStage || owner,
    ownerExplicit: Boolean(owner),
    exit,
    proofNeeded,
    firstMove,
    nextButton,
    confidence,
    planTrace: automaticPlan.trace,
  });
  if (!result.staged) {
    failTask('atris task plan', result.reason || 'stage_failed', stageErrorDetail('atris task plan', result.reason, result), 1);
  }
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'planned',
      task_id: taskId,
      version: result.event.version,
      plan_trace: automaticPlan.trace ? {
        plan: automaticPlan.plan,
        owner_choice: automaticPlan.ownerChoice,
        trace: automaticPlan.trace,
      } : null,
      stage_packet: result.stage_packet,
      projection_path: outPath,
      task: compactTaskFromProjection(projection, taskId),
    });
    return;
  }
  console.log(`planned ${taskRef(compactTaskFromProjection(projection, taskId))} v${result.event.version}`);
}

function cmdDo(args) {
  const pos = positional(args);
  const id = pos[0];
  if (!id) failTask('atris task do', 'missing_id', 'id required');
  if (Boolean(workerEnvMarker())) {
    failTask('atris task do', 'agent_proof_only_plan_approval_blocked', 'only a person can approve a plan', 2);
  }
  const actor = String(flag(args, '--as') || DEFAULT_OWNER);
  const goal = textFlag(args, ['--goal', '--objective']);
  const proofNeeded = textFlag(args, ['--proof-needed', '--proof', '--verify']);
  const exit = textFlag(args, ['--exit', '--exit-condition']);
  const summary = textFlag(args, ['--summary']);
  const firstMove = textFlag(args, ['--first-move', '--first']) || pos.slice(1).join(' ').trim();
  if (!firstMove) failTask('atris task do', 'first_move_required', 'atris task do: --first-move required');
  const nextButton = textFlag(args, ['--next-button']);
  const confidence = numericFlag(args, '--confidence');
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const taskId = requireTaskId(taskDb, db, id, 'atris task do');
  const result = taskDb.stageTask(db, {
    id: taskId,
    actor,
    stage: 'do',
    goal,
    summary,
    owner: actor,
    exit,
    proofNeeded,
    firstMove,
    nextButton,
    confidence,
  });
  if (!result.staged) {
    failTask('atris task do', result.reason || 'stage_failed', stageErrorDetail('atris task do', result.reason, result), 1);
  }
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'doing',
      task_id: taskId,
      version: result.event.version,
      stage_packet: result.stage_packet,
      projection_path: outPath,
      task: compactTaskFromProjection(projection, taskId),
    });
    return;
  }
  console.log(`doing ${taskRef(compactTaskFromProjection(projection, taskId))} v${result.event.version} @${actor}`);
}

function cmdBacklog(args) {
  const pos = positional(args);
  const id = pos[0];
  if (!id) failTask('atris task backlog', 'missing_id', 'id required');
  const actor = String(flag(args, '--as') || DEFAULT_OWNER);
  const reason = textFlag(args, ['--reason', '--note']);
  const tag = textFlag(args, ['--tag']) || 'capture';
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const taskId = requireTaskId(taskDb, db, id, 'atris task backlog');
  if (Boolean(workerEnvMarker())) {
    const existingTask = taskDb.getTask(db, taskId);
    if (isPlanAwaitingApproval(existingTask)) {
      failTask(
        'atris task backlog',
        'agent_proof_only_plan_approval_blocked',
        'only a person can backlog or clear a plan waiting on approval',
        2,
      );
    }
  }
  const result = taskDb.backlogTask(db, { id: taskId, actor, reason, tag });
  if (!result.backlogged) {
    failTask('atris task backlog', result.reason || 'backlog_failed', stageErrorDetail('atris task backlog', result.reason, result), 1);
  }
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'backlogged',
      task_id: taskId,
      version: result.event.version,
      cleared_keys: result.cleared_keys,
      projection_path: outPath,
      task: compactTaskFromProjection(projection, taskId),
    });
    return;
  }
  console.log(`backlog ${taskRef(compactTaskFromProjection(projection, taskId))} v${result.event.version}`);
}

function cmdClearPlan(args) {
  if (Boolean(workerEnvMarker())) {
    failTask(
      'atris task clear-plan',
      'agent_proof_only_plan_approval_blocked',
      'only a person can clear plans waiting on approval',
      2,
    );
  }
  const confirmed = hasFlag(args, '--yes') || hasFlag(args, '--confirm');
  if (!confirmed) failTask('atris task clear-plan', 'confirm_required', stageErrorDetail('atris task clear-plan', 'confirm_required'), 2);
  const actor = String(flag(args, '--as') || DEFAULT_OWNER);
  const reason = textFlag(args, ['--reason', '--note']) || 'clear_plan';
  const tag = textFlag(args, ['--tag']) || 'capture';
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const result = taskDb.clearPlanTasks(db, {
    workspaceRoot: taskDb.workspaceRoot(),
    actor,
    reason,
    tag,
  });
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  const taskById = new Map((projection.tasks || []).map(task => [task.id, task]));
  const tasks = result.cleared.map(task => compactTaskForStatus(taskById.get(task.id) || task)).filter(Boolean);
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'clear_plan',
      cleared_count: result.cleared.length,
      skipped_count: result.skipped.length,
      skipped: result.skipped,
      projection_path: outPath,
      tasks,
    });
    return;
  }
  console.log(`clear-plan moved ${result.cleared.length} task${result.cleared.length === 1 ? '' : 's'} to Backlog`);
}

module.exports = {
  bindMain, compactTaskForStatus, compactTaskFromProjection, compactEventPayload, compactTaskEvent,
  clipStatusText, clipStatusTitle, compactReviewActionRef, taskStatusSummary, humanEventType,
  taskEventSummary, formatTaskEventCompact, formatTaskLine, printStatusTask, cmdStatus,
  renderTaskDesk, cmdAdd, delegateHandoff, delegateTask, cmdDelegate, taskDayTextGroups,
  taskDayTitle, compactTechnicalDetails, taskDayGroups, refreshKeptTaskList, keptCount, cmdKeep,
  cmdDay, cmdFirstMinute, cmdHome, cmdList, cmdClaim, cmdRelease, cmdPlan, cmdDo, cmdBacklog,
  cmdClearPlan,
};
