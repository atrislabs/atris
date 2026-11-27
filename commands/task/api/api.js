'use strict';

const { isPlanAwaitingApproval } = require('../../../lib/member-task-pick');
const { workerEnvMarker } = require('../../../lib/task-core');

// commands/task/api/api.js: The local task API server behind atris task serve: its routes, reads
// and writes.
// Owner: unassigned. Moved out of commands/task.js on 2026-11-16 by lib/split-file.js; read
// README.md first.

// Names borrowed from commands/task.js and other feature folders, set by bindMain().
let http, crypto, path, unrunNamedProofCommandIssue, explanationFieldsFromInput, DEFAULT_OWNER,
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
  selectedNextKeyFromCurrent, TASK_API_ROUTES, TASK_API_POST_OPERATIONS;
function bindMain(deps) {
  ({
    http, crypto, path, unrunNamedProofCommandIssue, explanationFieldsFromInput, DEFAULT_OWNER,
    getTaskDb, warnIfTaskTitleNeedsOperatorWhy, flag, parseAcceptReward, refreshCareerXpAfterReview,
    resultSentenceIssue, sendProofIssue, meaningfulTaskProofIssue, taskFromProjection,
    taskBoardHtml, readJsonBody, sendJson, sendHtml, writeDefaultProjection,
    normalizeReviewNextTaskInput, createNextTaskIfRequested, enrichTaskProjection,
    taskQueueScopeFromSearchParams, taskCapabilitiesContract, taskCapabilitiesCheckReport,
    buildTaskCurrent, taskReviewLaneDrainReport, taskReviewLaneActOptionsFromBody,
    taskReviewLaneAct, taskReviewLaneLoopOptionsFromBody, taskReviewLaneLoop,
    taskReviewLaneRunOptionsFromBody, taskReviewLaneRun, resolveTaskRef, continueWorkForReviewTask,
    stageErrorDetail, taskDetail, buildAutomaticPlanTrace, buildAutomaticResultTrace,
    taskPageContract, appendTaskReviewChat, taskStepOptionsFromBody, taskCurrentStepOptionsFromBody,
    runTaskStep, runCurrentTaskStep, selectedNextKeyFromCurrent, TASK_API_ROUTES,
    TASK_API_POST_OPERATIONS,
  } = deps);
}

function taskApiQueueOptions(url) {
  const limitParam = url.searchParams.get('limit');
  const limit = limitParam ? Number(limitParam) : 8;
  return {
    owner: url.searchParams.get('owner') || url.searchParams.get('as') || DEFAULT_OWNER,
    reviewer: url.searchParams.get('reviewer') || url.searchParams.get('as_reviewer') || 'codex-review',
    all: url.searchParams.get('all') === '1' || url.searchParams.get('all') === 'true',
    everywhere: url.searchParams.get('everywhere') === '1' || url.searchParams.get('everywhere') === 'true',
    limit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 8,
    scope: taskQueueScopeFromSearchParams(url.searchParams),
  };
}

function serveTaskApiOptions({ res }) {
  return sendJson(res, 200, { ok: true });
}

function serveTaskBoardPage({ res }) {
  return sendHtml(res, taskBoardHtml());
}

function serveTaskList({ res, taskDb, db }) {
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  return sendJson(res, 200, { ok: true, projection_path: outPath, projection });
}

function serveTaskActivityStream({ res, taskDb, db }) {
  // Time-ordered feed of what the agent actually did + heartbeat liveness.
  const { projection } = writeDefaultProjection(taskDb, db);
  const root = projection.workspace_root || process.cwd();
  const stateDir = path.join(root, '.atris', 'state');
  const activity = require('../../../lib/activity-stream');
  const { readJsonl } = require('../../../lib/pulse');
  const readStateRows = (file) => readJsonl(path.join(stateDir, file));
  const pulseReceipts = readStateRows('pulse_agi_loop_receipts.jsonl');
  const events = activity.buildActivityStream({
    pulseReceipts,
    scorecards: readStateRows('scorecards.jsonl'),
    taskEpisodes: readStateRows('task_episodes.jsonl').slice(-200),
    xpReceipts: readStateRows('career_xp_receipts.jsonl').slice(-200),
    missionEvents: readStateRows('mission_events.jsonl').slice(-200),
  }, { limit: 60 });
  return sendJson(res, 200, {
    ok: true,
    heartbeat: activity.buildHeartbeat(pulseReceipts),
    events,
  }, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
}

function serveTaskCapabilities({ res }) {
  return sendJson(res, 200, {
    ok: true,
    action: 'capabilities',
    capabilities: taskCapabilitiesContract(),
    safety: {
      read_only: true,
      claims_work: false,
      human_accept: false,
      xp_after_human_accept: true,
    },
  });
}

function serveTaskCapabilitiesCheck({ res, taskDb, db, url }) {
  const report = taskCapabilitiesCheckReport(taskDb, db, [], taskApiQueueOptions(url));
  return sendJson(res, report.ok ? 200 : 409, report);
}

function serveTaskReviewLaneDrain({ res, taskDb, db, url }) {
  const report = taskReviewLaneDrainReport(taskDb, db, [], taskApiQueueOptions(url));
  return sendJson(res, report.ok ? 200 : 409, report);
}

async function postTaskReviewLaneAct({ req, res, taskDb, db, url }) {
  const body = await readJsonBody(req);
  const result = taskReviewLaneAct(taskDb, db, taskReviewLaneActOptionsFromBody(body, url.searchParams));
  return sendJson(res, result.ok ? 200 : result.status || 409, result);
}

async function postTaskReviewLaneLoop({ req, res, taskDb, db, url }) {
  const body = await readJsonBody(req);
  const result = taskReviewLaneLoop(taskDb, db, taskReviewLaneLoopOptionsFromBody(body, url.searchParams));
  return sendJson(res, result.ok ? 200 : result.status || 409, result);
}

async function postTaskReviewLaneRun({ req, res, taskDb, db, url }) {
  const body = await readJsonBody(req);
  const result = taskReviewLaneRun(taskDb, db, taskReviewLaneRunOptionsFromBody(body, url.searchParams));
  return sendJson(res, result.ok ? 200 : result.status || 409, result);
}

function serveTaskCurrent({ res, taskDb, db, url }) {
  const { outPath, current } = buildTaskCurrent(taskDb, db, [], taskApiQueueOptions(url));
  const action = url.pathname.endsWith('/queue') ? 'queue' : 'current';
  return sendJson(res, 200, {
    ok: true,
    action,
    projection_path: outPath,
    current,
    selected: current.selected,
    page: current.page,
    queue: current.queue,
  });
}

async function postCurrentTaskStep({ req, res, taskDb, db, url }) {
  const body = await readJsonBody(req);
  const options = taskCurrentStepOptionsFromBody(body, url.searchParams);
  try {
    const result = runCurrentTaskStep(taskDb, db, options);
    return sendJson(res, 200, result);
  } catch (error) {
    const errorCurrent = error.current || null;
    return sendJson(res, error.status || 409, {
      ok: false,
      action: 'current_step',
      reason: error.reason || 'step_failed',
      detail: error.message,
      selected_task_id: errorCurrent ? errorCurrent.selected_task_id : null,
      selected_ref: errorCurrent ? errorCurrent.selected_ref : null,
      selected_next_key: selectedNextKeyFromCurrent(errorCurrent),
      current: errorCurrent,
      page: error.page || null,
    });
  }
}

async function postTaskCreate({ req, res, taskDb, db }) {
  const body = await readJsonBody(req);
  const title = String(body.title || '').trim();
  if (!title) return sendJson(res, 400, { ok: false, reason: 'missing_title', detail: 'title required' });
  const operatorTitleWarning = warnIfTaskTitleNeedsOperatorWhy(title);
  const metadata = {
    ...(body.verify ? { verify: String(body.verify).trim() } : {}),
    ...explanationFieldsFromInput(body),
  };
  const result = taskDb.addTask(db, {
    title,
    tag: body.tag ? String(body.tag) : 'tasks',
    workspaceRoot: taskDb.workspaceRoot(),
    metadata: Object.keys(metadata).length ? metadata : null,
  });
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  return sendJson(res, 200, {
    ok: true,
    action: 'created',
    task_id: result.id,
    operator_title_warning: operatorTitleWarning,
    projection_path: outPath,
    task: taskFromProjection(projection, result.id),
  });
}

async function postTaskClearPlan({ req, res, taskDb, db }) {
  if (Boolean(workerEnvMarker())) {
    return sendJson(res, 403, {
      ok: false,
      reason: 'agent_proof_only_plan_approval_blocked',
      detail: 'only a person can clear plans waiting on approval',
    });
  }
  const body = await readJsonBody(req);
  if (!body.confirm && !body.yes) {
    return sendJson(res, 400, { ok: false, reason: 'confirm_required', detail: stageErrorDetail('task clear-plan', 'confirm_required') });
  }
  const result = taskDb.clearPlanTasks(db, {
    workspaceRoot: taskDb.workspaceRoot(),
    actor: String(body.actor || DEFAULT_OWNER),
    reason: String(body.reason || body.note || 'clear_plan'),
    tag: String(body.tag || 'capture'),
  });
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  const taskById = new Map((projection.tasks || []).map(task => [task.id, task]));
  return sendJson(res, 200, {
    ok: true,
    action: 'clear_plan',
    cleared_count: result.cleared.length,
    skipped_count: result.skipped.length,
    skipped: result.skipped,
    projection_path: outPath,
    tasks: result.cleared.map(task => taskFromProjection(projection, task.id) || taskById.get(task.id)).filter(Boolean),
  });
}

function serveTaskDetail({ req, res, taskDb, db, match }) {
  if (req.method !== 'GET') return sendJson(res, 405, { ok: false, reason: 'method_not_allowed' });
  const resolved = resolveTaskRef(taskDb, db, match[1]);
  if (!resolved.ok) return sendJson(res, resolved.reason === 'ambiguous' ? 409 : 404, { ok: false, reason: resolved.reason });
  const task = taskDetail(taskDb, db, resolved.id);
  if (!task) return sendJson(res, 404, { ok: false, reason: 'not_found' });
  const { outPath } = writeDefaultProjection(taskDb, db);
  return sendJson(res, 200, { ok: true, action: 'detail', task_id: resolved.id, projection_path: outPath, task, page: taskPageContract(task) });
}

function serveTaskPage({ req, res, taskDb, db, match }) {
  if (req.method !== 'GET') return sendJson(res, 405, { ok: false, reason: 'method_not_allowed' });
  const resolved = resolveTaskRef(taskDb, db, match[1]);
  if (!resolved.ok) return sendJson(res, resolved.reason === 'ambiguous' ? 409 : 404, { ok: false, reason: resolved.reason });
  const task = taskDetail(taskDb, db, resolved.id);
  if (!task) return sendJson(res, 404, { ok: false, reason: 'not_found' });
  const { outPath } = writeDefaultProjection(taskDb, db);
  return sendJson(res, 200, { ok: true, action: 'page', task_id: resolved.id, projection_path: outPath, page: taskPageContract(task) });
}

function postTaskApiStep({ res, taskDb, db, taskId, body }) {
  try {
    const result = runTaskStep(taskDb, db, taskId, taskStepOptionsFromBody(body));
    return sendJson(res, 200, result);
  } catch (error) {
    return sendJson(res, error.status || 409, {
      ok: false,
      action: 'step',
      task_id: taskId,
      reason: error.reason || 'step_failed',
      detail: error.message,
      page: error.page || null,
    });
  }
}

function postTaskApiContinueWork({ res, taskDb, db, taskId, body }) {
  try {
    const result = continueWorkForReviewTask(taskDb, db, taskId, { owner: body.owner || body.actor || DEFAULT_OWNER });
    return sendJson(res, 200, result);
  } catch (error) {
    return sendJson(res, error.status || 409, {
      ok: false,
      action: 'continue_work',
      task_id: taskId,
      reason: error.reason || 'continue_work_failed',
      detail: error.message,
    });
  }
}

function postTaskApiClaim({ res, taskDb, db, taskId, body }) {
  if (Boolean(workerEnvMarker())) {
    const existingTask = taskDb.getTask(db, taskId);
    if (isPlanAwaitingApproval(existingTask)) {
      return sendJson(res, 403, {
        ok: false,
        reason: 'plan_awaiting_approval',
        detail: 'plan is waiting on a person to approve before claiming',
      });
    }
  }
  const owner = String(body.owner || body.actor || DEFAULT_OWNER);
  const result = taskDb.claimTask(db, { id: taskId, claimedBy: owner });
  if (!result.claimed) return sendJson(res, 409, { ok: false, reason: result.reason, claimed_by: result.claimed_by || null });
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  return sendJson(res, 200, { ok: true, action: 'claimed', task_id: taskId, projection_path: outPath, task: taskFromProjection(projection, taskId) });
}

function postTaskApiMessage({ res, taskDb, db, taskId, body }) {
  const result = taskDb.noteTask(db, { id: taskId, actor: String(body.actor || DEFAULT_OWNER), content: String(body.content || '') });
  if (!result.noted) return sendJson(res, 404, { ok: false, reason: result.reason });
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  return sendJson(res, 200, { ok: true, action: 'noted', task_id: taskId, projection_path: outPath, task: taskFromProjection(projection, taskId) });
}

function postTaskApiChat({ res, taskDb, db, taskId, body }) {
  const result = taskDb.chatTask(db, {
    id: taskId,
    actor: String(body.actor || DEFAULT_OWNER),
    content: String(body.content || body.message || body.text || ''),
    goal: String(body.goal || body.objective || ''),
    summary: String(body.summary || ''),
  });
  if (!result.chatted) {
    const status = result.reason === 'content_required' ? 400 : result.reason === 'not_found' ? 404 : 409;
    return sendJson(res, status, { ok: false, reason: result.reason, detail: stageErrorDetail('task chat', result.reason, result) });
  }
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  return sendJson(res, 200, {
    ok: true,
    action: 'chatted',
    task_id: taskId,
    version: result.event.version,
    goal_changed: result.goal_changed,
    chat_packet: result.chat_packet,
    projection_path: outPath,
    task: taskFromProjection(projection, taskId),
  });
}

function postTaskApiPlan({ res, taskDb, db, taskId, body }) {
  const actor = String(body.actor || DEFAULT_OWNER);
  const goal = String(body.goal || body.objective || '');
  const summary = String(body.summary || body.plan || '');
  const owner = String(body.owner || body.assignee || '');
  const exit = String(body.exit || body.exit_condition || '');
  const firstMove = String(body.first_move || body.firstMove || body.first || '');
  const task = taskDetail(taskDb, db, taskId);
  const automaticPlan = buildAutomaticPlanTrace(taskDb, task, {
    actor,
    actorExplicit: Boolean(body.actor),
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
    proofNeeded: String(body.proof_needed || body.proofNeeded || body.proof || body.verify || ''),
    firstMove,
    nextButton: String(body.next_button || body.nextButton || ''),
    confidence: body.confidence,
    planTrace: automaticPlan.trace,
  });
  if (!result.staged) return sendJson(res, 409, { ok: false, reason: result.reason, detail: stageErrorDetail('task plan', result.reason, result) });
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  return sendJson(res, 200, { ok: true, action: 'planned', task_id: taskId, version: result.event.version, plan_trace: automaticPlan.trace, stage_packet: result.stage_packet, projection_path: outPath, task: taskFromProjection(projection, taskId) });
}

function postTaskApiDo({ res, taskDb, db, taskId, body }) {
  if (Boolean(workerEnvMarker())) {
    return sendJson(res, 403, {
      ok: false,
      reason: 'agent_proof_only_plan_approval_blocked',
      detail: 'only a person can approve a plan',
    });
  }
  const firstMove = String(body.first_move || body.firstMove || body.first || '').trim();
  if (!firstMove) return sendJson(res, 400, { ok: false, reason: 'first_move_required', detail: 'task do: first_move required' });
  const result = taskDb.stageTask(db, {
    id: taskId,
    actor: String(body.actor || DEFAULT_OWNER),
    stage: 'do',
    goal: String(body.goal || body.objective || ''),
    summary: String(body.summary || ''),
    owner: String(body.actor || DEFAULT_OWNER),
    exit: String(body.exit || body.exit_condition || body.exitCondition || ''),
    proofNeeded: String(body.proof_needed || body.proofNeeded || body.proof || body.verify || ''),
    firstMove,
    nextButton: String(body.next_button || body.nextButton || ''),
    confidence: body.confidence,
  });
  if (!result.staged) return sendJson(res, 409, { ok: false, reason: result.reason, detail: stageErrorDetail('task do', result.reason, result) });
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  return sendJson(res, 200, { ok: true, action: 'doing', task_id: taskId, version: result.event.version, stage_packet: result.stage_packet, projection_path: outPath, task: taskFromProjection(projection, taskId) });
}

function postTaskApiBacklog({ res, taskDb, db, taskId, body }) {
  if (Boolean(workerEnvMarker())) {
    const existingTask = taskDb.getTask(db, taskId);
    if (isPlanAwaitingApproval(existingTask)) {
      return sendJson(res, 403, {
        ok: false,
        reason: 'agent_proof_only_plan_approval_blocked',
        detail: 'only a person can backlog or clear a plan waiting on approval',
      });
    }
  }
  const result = taskDb.backlogTask(db, {
    id: taskId,
    actor: String(body.actor || DEFAULT_OWNER),
    reason: String(body.reason || body.note || 'clear_plan'),
    tag: String(body.tag || 'capture'),
  });
  if (!result.backlogged) return sendJson(res, 409, { ok: false, reason: result.reason, detail: stageErrorDetail('task backlog', result.reason, result) });
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  return sendJson(res, 200, {
    ok: true,
    action: 'backlogged',
    task_id: taskId,
    version: result.event.version,
    cleared_keys: result.cleared_keys,
    projection_path: outPath,
    task: taskFromProjection(projection, taskId),
  });
}

function postTaskApiReviewChat({ res, taskDb, db, taskId, body }) {
  try {
    const result = appendTaskReviewChat(taskDb, db, taskId, {
      reviewer: body.reviewer || body.actor || 'codex-review',
      dryRun: Boolean(body.dryRun || body.noNote),
    });
    const { event, compactProjection, outPath, ...payload } = result;
    return sendJson(res, 200, payload);
  } catch (error) {
    return sendJson(res, error.status || 409, {
      ok: false,
      reason: error.reason || 'review_chat_failed',
      detail: error.message,
    });
  }
}

function postTaskApiFinish({ res, taskDb, db, taskId, body }) {
  const currentTask = taskDb.getTask(db, taskId);
  const failed = Boolean(body.failed);
  const proof = String(body.proof || '').trim();
  const shouldReview = Boolean(body.proof || body.lesson || body.next || body.reward !== undefined);
  const proofIssue = meaningfulTaskProofIssue(proof, { required: !failed || shouldReview });
  if (proofIssue) return sendProofIssue(res, proof, proofIssue);
  const done = taskDb.doneTask(db, {
    id: taskId,
    status: failed ? 'failed' : 'done',
    actor: String(body.actor || DEFAULT_OWNER),
    action: failed ? 'failed' : 'finished',
    proof,
  });
  if (!done.updated) return sendJson(res, 409, { ok: false, reason: 'not_open_or_claimed' });
  let episode = null;
  let nextCreated = null;
  let xpProjection = null;
  if (shouldReview) {
    const reviewed = taskDb.reviewTask(db, {
      id: taskId,
      actor: String(body.actor || DEFAULT_OWNER),
      reward: body.reward === undefined ? 1 : body.reward,
      lesson: String(body.lesson || ''),
      nextTask: String(body.next || ''),
      proof: String(body.proof || ''),
      careerXpEligible: false,
    });
    episode = reviewed.episode;
    nextCreated = body.createNext ? createNextTaskIfRequested(taskDb, db, ['--create-next'], currentTask, episode.next_task_suggestion) : null;
    xpProjection = refreshCareerXpAfterReview(reviewed);
  }
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  return sendJson(res, 200, {
    ok: true,
    action: 'finished',
    task_id: taskId,
    reviewed: Boolean(episode),
    episode,
    xp_projection: xpProjection,
    next_task_id: nextCreated ? nextCreated.id : null,
    projection_path: outPath,
    task: taskFromProjection(projection, taskId),
  });
}

function postTaskApiReady({ res, taskDb, db, taskId, body }) {
  if (Boolean(workerEnvMarker())) {
    const existingTask = taskDb.getTask(db, taskId);
    if (isPlanAwaitingApproval(existingTask)) {
      return sendJson(res, 403, {
        ok: false,
        reason: 'plan_awaiting_approval',
        detail: 'plan is waiting on a person to approve before marking ready',
      });
    }
  }
  const proof = String(body.proof || '').trim();
  const proofIssue = meaningfulTaskProofIssue(proof);
  if (proofIssue) return sendProofIssue(res, proof, proofIssue);
  const unrunIssue = unrunNamedProofCommandIssue(proof, '');
  if (unrunIssue) {
    return sendJson(res, 400, {
      ok: false,
      reason: unrunIssue.reason,
      detail: unrunIssue.detail,
    });
  }
  const nextTaskInput = normalizeReviewNextTaskInput(body.next);
  const actor = String(body.actor || DEFAULT_OWNER);
  const resultText = String(body.result || '').replace(/\s+/g, ' ').trim();
  if (resultText) {
    const resultIssue = resultSentenceIssue(resultText);
    if (resultIssue) return sendJson(res, 400, { ok: false, reason: 'weak_result', detail: resultIssue });
  }
  const resultTrace = buildAutomaticResultTrace(taskDb, db, taskId, {
    actor,
    proof,
    changed: body.changed || resultText || body.done,
    checked: body.checked || body.check || body.verified,
    passed: body.passed || body.pass,
    failed: body.failed || body.fail,
    cost: body.cost,
    saved: body.saved || body.savings,
    tryNext: body.try_next || body.tryNext || body.try || body.handoff,
    status: body.status,
    files: body.files,
    commands: body.commands || body.command,
  });
  const result = taskDb.readyTask(db, {
    id: taskId,
    actor,
    proof,
    lesson: String(body.lesson || ''),
    nextTask: nextTaskInput.nextTask,
    resultTrace: resultTrace && resultTrace.trace,
    result: resultText,
    landing: body.landing || {
      happened: body.happened,
      checked: body.checked,
      tested: body.tested,
      decision: body.decision,
    },
  });
  if (!result.ready) return sendJson(res, 409, { ok: false, reason: result.reason });
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  return sendJson(res, 200, {
    ok: true,
    action: 'ready',
    task_id: taskId,
    result_trace: resultTrace,
    ...(nextTaskInput.ignored ? { review_next_task_ignored: nextTaskInput.ignored } : {}),
    projection_path: outPath,
    task: taskFromProjection(projection, taskId),
  });
}

function postTaskApiAccept({ res, taskDb, db, taskId, body }) {
  const currentTask = enrichTaskProjection(taskDb.taskProjection(db, { taskId })).tasks[0] || null;
  const hasExplicitProof = Object.prototype.hasOwnProperty.call(body, 'proof');
  const proof = String(hasExplicitProof ? body.proof : currentTask?.metadata?.latest_agent_proof || '').trim();
  const proofIssue = meaningfulTaskProofIssue(proof);
  if (proofIssue) return sendProofIssue(res, proof, proofIssue);
  const hasExplicitLesson = Object.prototype.hasOwnProperty.call(body, 'lesson');
  const hasExplicitNext = Object.prototype.hasOwnProperty.call(body, 'next');
  const lesson = hasExplicitLesson ? String(body.lesson || '') : String(currentTask?.review?.lesson || currentTask?.metadata?.latest_agent_lesson || '');
  const nextTask = hasExplicitNext ? String(body.next || '') : String(currentTask?.review?.next_task || currentTask?.metadata?.latest_agent_next_task || '');
  const clearedFields = [];
  if (hasExplicitLesson && !lesson.trim()) clearedFields.push('lesson');
  if (hasExplicitNext && !nextTask.trim()) clearedFields.push('next_task');
  const parsedReward = parseAcceptReward(body.reward);
  if (!parsedReward.ok) return sendJson(res, 400, { ok: false, reason: 'invalid_reward', detail: 'reward must be a positive number' });
  const done = taskDb.acceptTask(db, {
    id: taskId,
    actor: String(body.actor || DEFAULT_OWNER),
    reward: parsedReward.value,
    lesson,
    nextTask,
    proof,
    careerXpEligible: true,
    clearedFields,
  });
  if (!done.updated) return sendJson(res, 409, { ok: false, reason: 'not_open_claimed_or_review' });
  const reviewed = done.reviewed;
  const nextCreated = body.createNext ? createNextTaskIfRequested(taskDb, db, ['--create-next'], currentTask, reviewed.episode.next_task_suggestion) : null;
  const xpProjection = refreshCareerXpAfterReview(reviewed);
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  return sendJson(res, 200, { ok: true, action: 'accepted', task_id: taskId, episode: reviewed.episode, xp_projection: xpProjection, next_task_id: nextCreated ? nextCreated.id : null, projection_path: outPath, task: taskFromProjection(projection, taskId) });
}

function postTaskApiRevise({ res, taskDb, db, taskId, body }) {
  const result = taskDb.reviseTask(db, { id: taskId, actor: String(body.actor || DEFAULT_OWNER), note: String(body.note || body.reason || '') });
  if (!result.revised) return sendJson(res, 409, { ok: false, reason: result.reason });
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  return sendJson(res, 200, { ok: true, action: 'revise', task_id: taskId, projection_path: outPath, task: taskFromProjection(projection, taskId) });
}

function postTaskApiReview({ res, taskDb, db, taskId, body }) {
  const currentTask = taskDb.getTask(db, taskId);
  const rewardValue = body.reward === undefined ? 0 : body.reward;
  const proof = String(body.proof || '').trim();
  const hasExplicitLesson = Object.prototype.hasOwnProperty.call(body, 'lesson');
  const hasExplicitNext = Object.prototype.hasOwnProperty.call(body, 'next')
    || Object.prototype.hasOwnProperty.call(body, 'next_task')
    || Object.prototype.hasOwnProperty.call(body, 'nextTask');
  const lessonText = hasExplicitLesson ? String(body.lesson || '') : '';
  const rawNext = Object.prototype.hasOwnProperty.call(body, 'next')
    ? body.next
    : Object.prototype.hasOwnProperty.call(body, 'next_task')
    ? body.next_task
    : body.nextTask;
  const nextTaskInput = normalizeReviewNextTaskInput(hasExplicitNext ? rawNext : '');
  const clearedFields = [];
  if (hasExplicitLesson && !lessonText.trim()) clearedFields.push('lesson');
  if (hasExplicitNext && !String(rawNext || '').trim()) clearedFields.push('next_task');
  const proofIssue = Number(rewardValue) > 0 || proof
    ? meaningfulTaskProofIssue(proof)
    : null;
  if (proofIssue) return sendProofIssue(res, proof, proofIssue);
  const reviewed = taskDb.reviewTask(db, {
    id: taskId,
    actor: String(body.actor || DEFAULT_OWNER),
    reward: rewardValue,
    lesson: lessonText,
    nextTask: nextTaskInput.nextTask,
    proof,
    careerXpEligible: false,
    clearedFields,
  });
  const nextCreated = body.createNext ? createNextTaskIfRequested(taskDb, db, ['--create-next'], currentTask, reviewed.episode.next_task_suggestion) : null;
  const xpProjection = refreshCareerXpAfterReview(reviewed);
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  return sendJson(res, 200, {
    ok: true,
    action: 'reviewed',
    task_id: taskId,
    episode: reviewed.episode,
    xp_projection: xpProjection,
    next_task_id: nextCreated ? nextCreated.id : null,
    ...(nextTaskInput.ignored ? { review_next_task_ignored: nextTaskInput.ignored } : {}),
    projection_path: outPath,
    task: taskFromProjection(projection, taskId),
  });
}

function serveTaskEvents({ res, taskDb, db, taskId }) {
  const events = taskDb.listTaskEvents(db, { taskId, limit: 500 });
  return sendJson(res, 200, { ok: true, events });
}

async function serveTaskOperation({ req, res, taskDb, db, match }) {
  const resolved = resolveTaskRef(taskDb, db, match[1]);
  if (!resolved.ok) return sendJson(res, resolved.reason === 'ambiguous' ? 409 : 404, { ok: false, reason: resolved.reason });
  const taskId = resolved.id;
  const operation = match[2];
  if (req.method === 'GET' && operation === 'events') {
    return serveTaskEvents({ res, taskDb, db, taskId });
  }
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, reason: 'method_not_allowed' });
  const body = await readJsonBody(req);
  const postTaskOperation = TASK_API_POST_OPERATIONS[operation];
  if (!postTaskOperation) return;
  return postTaskOperation({ res, taskDb, db, taskId, body });
}

function matchTaskApiRoute(req, url) {
  for (const route of TASK_API_ROUTES) {
    if (route.method && route.method !== req.method) continue;
    if (Object.prototype.hasOwnProperty.call(route, 'pathname')) {
      if (route.pathname === null || route.pathname === url.pathname) return { route, match: null };
      continue;
    }
    const match = url.pathname.match(route.pattern);
    if (match) return { route, match };
  }
  return null;
}

async function handleTaskApi(req, res, taskDb, db, token) {
  let url;
  try {
    const target = req.url || '/';
    url = new URL(target, 'http://127.0.0.1');
    if (!target.startsWith('/') || target.startsWith('//') || /[\\#\0]/.test(target) || decodeURIComponent(url.pathname).includes('\0')) throw new Error('url');
    decodeURIComponent(target);
  } catch {
    return sendJson(res, 400, { ok: false, reason: 'bad_url' });
  }
  const host = String(req.headers.host || '').toLowerCase();
  const port = req.socket.localPort;
  if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(host)) return sendJson(res, 403, { ok: false, reason: 'host' });
  const provided = Buffer.from(String(req.headers['x-atris-token'] || (req.method === 'GET' && url.searchParams.get('t')) || ''));
  const expected = Buffer.from(token);
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) return sendJson(res, 403, { ok: false, reason: 'token' });
  if (req.method === 'GET' && (req.headers['transfer-encoding'] || Number(req.headers['content-length'] || 0) > 0)) return sendJson(res, 400, { ok: false, reason: 'body' });
  if (req.method !== 'GET' && req.headers.origin !== undefined && req.headers.origin !== `http://${host}`) return sendJson(res, 403, { ok: false, reason: 'origin' });
  const matchedRoute = matchTaskApiRoute(req, url);
  if (!matchedRoute) return sendJson(res, 404, { ok: false, reason: 'not_found' });
  return matchedRoute.route.serve({
    req,
    res,
    taskDb,
    db,
    url,
    match: matchedRoute.match,
  });
}

function createTaskApiServer(taskApi = {}) {
  const taskDb = taskApi.taskDb || getTaskDb();
  const db = taskApi.db || taskDb.open();
  const token = crypto.randomBytes(32).toString('base64url');
  const server = http.createServer((req, res) => {
    handleTaskApi(req, res, taskDb, db, token).catch((error) => {
      if (res.headersSent || res.destroyed) return res.destroy();
      const status = error.statusCode || 500;
      sendJson(res, status, { ok: false, reason: status < 500 ? 'bad_request' : 'server_error' });
    }).catch(() => res.destroy());
  });
  server.taskToken = token;
  return server;
}

function cmdServe(args) {
  const host = String(flag(args, '--host') || '127.0.0.1');
  if (!['127.0.0.1', 'localhost'].includes(host)) throw new Error('task board only listens on 127.0.0.1');
  const port = Number(flag(args, '--port') || process.env.PORT || 8787);
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const server = createTaskApiServer({ taskDb, db });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const actualPort = addr && addr.port || port;
      console.log(`task board: http://${host}:${actualPort}/?t=${server.taskToken}`);
      console.log(`workspace: ${taskDb.workspaceRoot()}`);
    });

    const shutdown = () => {
      server.close(() => resolve());
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  });
}

module.exports = {
  bindMain, taskApiQueueOptions, serveTaskApiOptions, serveTaskBoardPage, serveTaskList,
  serveTaskActivityStream, serveTaskCapabilities, serveTaskCapabilitiesCheck,
  serveTaskReviewLaneDrain, postTaskReviewLaneAct, postTaskReviewLaneLoop, postTaskReviewLaneRun,
  serveTaskCurrent, postCurrentTaskStep, postTaskCreate, postTaskClearPlan, serveTaskDetail,
  serveTaskPage, postTaskApiStep, postTaskApiContinueWork, postTaskApiClaim, postTaskApiMessage,
  postTaskApiChat, postTaskApiPlan, postTaskApiDo, postTaskApiBacklog, postTaskApiReviewChat,
  postTaskApiFinish, postTaskApiReady, postTaskApiAccept, postTaskApiRevise, postTaskApiReview,
  serveTaskEvents, serveTaskOperation, matchTaskApiRoute, handleTaskApi, createTaskApiServer,
  cmdServe,
};
