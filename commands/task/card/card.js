'use strict';

// commands/task/card/card.js: Reading and changing one task: note, retitle, tag, chat, inspect,
// show, the task page and its next action.
// Owner: unassigned. Moved out of commands/task.js on 2026-11-16 by lib/split-file.js; read
// README.md first.

// Names borrowed from commands/task.js and other feature folders, set by bindMain().
let hasFlag, taskExplanation, explanationLines, approvalLines, TASK_INSPECT_FIELDS, readFieldsFlag,
  stripInspectArgs, validateFields, inspectTextLines, buildInspectPayload, DEFAULT_OWNER,
  AGENT_CERTIFICATION_REVIEW_PASSES, PROOF_BOUNDARY_BLOCKED_ACTION, PROOF_BOUNDARY_BLOCKED_REASON,
  getTaskDb, warnIfTaskTitleNeedsOperatorWhy, flag, scopedWorkspaceRoot, wantsJson, printJson,
  failTask, textFlag, positional, taskRef, normalizedStatusPart, taskColumn, taskHasReview,
  writeDefaultProjection, continueWorkCommandForTask, handoffAllowsHumanAccept,
  handoffIsProofBoundaryBlocked, taskReviewSummary, taskInspectFieldValues, taskAssignee,
  taskApprovalFor, enrichTaskProjection, printReviewLanding, reviewHandoffForTask, reviewActor,
  taskReviewChatHandoff, compactTaskFromProjection, readProjectionFile, requireTaskId,
  collectFlagValues, taskCommandQuote, taskAllowsReviewChat;
function bindMain(deps) {
  ({
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
  } = deps);
}

function cmdNote(args) {
  const pos = positional(args);
  const id = pos[0];
  const content = pos.slice(1).join(' ').trim();
  if (!id || !content) {
    failTask('atris task note', 'missing_args', 'id and message required');
  }
  const actor = flag(args, '--as') || DEFAULT_OWNER;
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const taskId = requireTaskId(taskDb, db, id, 'atris task note');
  const result = taskDb.noteTask(db, { id: taskId, actor: String(actor), content });
  if (!result.noted) {
    console.error(`note failed: ${result.reason}`);
    process.exit(1);
  }
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'noted',
      task_id: taskId,
      version: result.event.version,
      projection_path: outPath,
      task: compactTaskFromProjection(projection, taskId),
    });
    return;
  }
  console.log(`noted ${taskRef(compactTaskFromProjection(projection, taskId))} v${result.event.version}`);
}

function cmdRetitle(args) {
  const pos = positional(args);
  const id = pos[0];
  const title = pos.slice(1).join(' ').trim();
  if (!id) failTask('atris task retitle', 'missing_id', 'task id required');
  if (!title) failTask('atris task retitle', 'missing_title', 'new title required');
  warnIfTaskTitleNeedsOperatorWhy(title);

  const actor = flag(args, '--as') || DEFAULT_OWNER;
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const taskId = requireTaskId(taskDb, db, id, 'atris task retitle');
  const current = taskDb.getTask(db, taskId);
  const oldTitle = String(current.title || '');
  const now = Math.max(Date.now(), Number(current.updated_at || 0) + 1);
  const updated = db.prepare(`
    UPDATE tasks
       SET title = ?,
           updated_at = ?
     WHERE id = ?
       AND updated_at = ?
  `).run(title, now, taskId, current.updated_at);
  if (updated.changes !== 1) {
    failTask('atris task retitle', 'stale_task_state', 'retitle failed: stale task state', 1);
  }
  const history = taskDb.noteTask(db, {
    id: taskId,
    actor: String(actor),
    content: `previous title: ${oldTitle}`,
  });
  if (!history.noted) {
    failTask('atris task retitle', history.reason || 'history_failed', `retitle history failed: ${history.reason || 'unknown'}`, 1);
  }

  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  const task = compactTaskFromProjection(projection, taskId);
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'retitled',
      task_id: taskId,
      old_title: oldTitle,
      title,
      version: history.event.version,
      projection_path: outPath,
      task,
    });
    return;
  }
  console.log(`retitled ${taskRef(task)}: ${title}`);
}

function cmdTag(args) {
  const pos = positional(args);
  const id = pos[0];
  if (!id) failTask('atris task tag', 'missing_id', 'task id required');
  const add = collectFlagValues(args, '--add');
  const remove = collectFlagValues(args, '--remove');
  const setTag = pos.slice(1).join(' ').trim();
  if (!add.length && !remove.length && !setTag) {
    failTask('atris task tag', 'missing_tags', 'a tag, or at least one --add <tag> or --remove <tag>, required');
  }
  if (setTag && (add.length || remove.length)) {
    failTask('atris task tag', 'tag_conflict', 'use either `task tag <id> <tag>` or --add/--remove, not both');
  }
  const actor = flag(args, '--as') || DEFAULT_OWNER;
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const taskId = requireTaskId(taskDb, db, id, 'atris task tag');
  if (setTag) {
    // Sets the primary tag, the same field `task add --tag` writes at creation.
    const set = taskDb.setTaskTag(db, { id: taskId, actor: String(actor), tag: setTag });
    if (!set.tagged && set.reason !== 'no_changes') {
      failTask('atris task tag', set.reason || 'tag_failed', `tag failed: ${set.reason || 'unknown'}`, 1);
    }
    const { projection, outPath } = writeDefaultProjection(taskDb, db);
    const task = compactTaskFromProjection(projection, taskId);
    if (wantsJson(args)) {
      printJson({
        ok: true,
        action: set.tagged ? 'tag_set' : 'unchanged',
        task_id: taskId,
        tag: set.tag,
        previous_tag: set.tagged ? set.previous_tag : set.tag,
        projection_path: outPath,
        task,
      });
      return;
    }
    console.log(set.tagged
      ? `tagged ${taskRef(task)} tag ${set.previous_tag || 'none'} -> ${set.tag}`
      : `no change ${taskRef(task)} tag ${set.tag}`);
    return;
  }
  const result = taskDb.tagTask(db, { id: taskId, actor: String(actor), add, remove });
  if (!result.tagged) {
    if (result.reason === 'no_changes') {
      const { projection, outPath } = writeDefaultProjection(taskDb, db);
      const task = compactTaskFromProjection(projection, taskId);
      if (wantsJson(args)) {
        printJson({
          ok: true,
          action: 'unchanged',
          task_id: taskId,
          added: [],
          removed: [],
          tags: result.tags || [],
          projection_path: outPath,
          task,
        });
        return;
      }
      console.log(`no change ${taskRef(task)} tags [${(result.tags || []).join(', ')}]`);
      return;
    }
    failTask('atris task tag', result.reason || 'tag_failed', `tag failed: ${result.reason || 'unknown'}`, 1);
  }
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  const task = compactTaskFromProjection(projection, taskId);
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'tagged',
      task_id: taskId,
      added: result.added,
      removed: result.removed,
      tags: result.tags,
      version: result.event.version,
      projection_path: outPath,
      task,
    });
    return;
  }
  const parts = [];
  if (result.added.length) parts.push(`+${result.added.join(' +')}`);
  if (result.removed.length) parts.push(`-${result.removed.join(' -')}`);
  console.log(`tagged ${taskRef(task)} ${parts.join(' ')} -> [${result.tags.join(', ')}] v${result.event.version}`);
}

function cmdChat(args) {
  const pos = positional(args);
  const id = pos[0];
  const content = pos.slice(1).join(' ').trim();
  const goal = textFlag(args, ['--goal', '--objective']);
  const summary = textFlag(args, ['--summary']);
  if (!id) failTask('atris task chat', 'missing_id', 'id required');
  if (!content && !goal && !summary) {
    failTask('atris task chat', 'content_required', 'atris task chat: message, --goal, or --summary required');
  }
  const actor = flag(args, '--as') || DEFAULT_OWNER;
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const taskId = requireTaskId(taskDb, db, id, 'atris task chat');
  const result = taskDb.chatTask(db, {
    id: taskId,
    actor: String(actor),
    content,
    goal,
    summary,
  });
  if (!result.chatted) {
    failTask('atris task chat', result.reason || 'chat_failed', stageErrorDetail('atris task chat', result.reason, result), 1);
  }
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'chatted',
      task_id: taskId,
      version: result.event.version,
      goal_changed: result.goal_changed,
      chat_packet: result.chat_packet,
      projection_path: outPath,
      task: compactTaskFromProjection(projection, taskId),
    });
    return;
  }
  console.log(`chat ${taskRef(compactTaskFromProjection(projection, taskId))} v${result.event.version}`);
}

function stageErrorDetail(command, reason, extra = {}) {
  if (reason === 'goal_required') return `${command}: --goal required`;
  if (reason === 'content_required') return `${command}: message, --goal, or --summary required`;
  if (reason === 'plan_required') return `${command}: run atris task plan first`;
  if (reason === 'exit_required') return `${command}: --exit required`;
  if (reason === 'proof_needed_required') return `${command}: --proof-needed required`;
  if (reason === 'plan_goal_mismatch') return `${command}: Do must use the recorded Plan goal`;
  if (reason === 'plan_proof_mismatch') return `${command}: Do must use the recorded Plan proof requirement`;
  if (reason === 'plan_exit_mismatch') return `${command}: Do must use the recorded Plan exit condition`;
  if (reason === 'not_planned') return `${command}: task is already in Backlog`;
  if (reason === 'confirm_required') return `${command}: --yes required`;
  if (reason === 'claimed_by_other') return `${command}: task is claimed by ${extra.claimed_by || 'another owner'}`;
  if (reason === 'not_reviewable_use_revise') return `${command}: task is in review; use atris task revise first`;
  if (reason === 'stale_task_state') return `${command}: task changed while staging; reload and try again`;
  if (reason && reason.startsWith('already_')) return `${command}: task is ${reason.slice('already_'.length)}`;
  return `${command}: ${reason || 'stage_failed'}`;
}

function cmdInspect(args) {
  const parsed = readFieldsFlag(args, '--fields');
  if (!parsed || parsed.error) {
    failTask('atris task inspect', 'missing_fields', parsed?.error || 'Usage: atris task inspect <id> --fields review,status,title [--json]');
  }
  const fieldError = validateFields(parsed.fields, TASK_INSPECT_FIELDS, 'task');
  if (fieldError) failTask('atris task inspect', 'unknown_fields', fieldError);
  const ref = stripInspectArgs(args)[0] || '';
  if (!ref) {
    failTask('atris task inspect', 'missing_id', 'Usage: atris task inspect <id> --fields review,status,title [--json]');
  }
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const taskId = requireTaskId(taskDb, db, ref, 'atris task inspect');
  const projection = enrichTaskProjection(taskDb.taskProjection(db, { taskId }));
  let task = projection.tasks[0];
  if (!task) {
    const wsRoot = scopedWorkspaceRoot(taskDb, args) || process.cwd();
    const proj = readProjectionFile(wsRoot);
    if (proj && Array.isArray(proj.tasks)) {
      task = proj.tasks.find(t => t.id === taskId) || null;
    }
  }
  if (!task) {
    failTask('atris task inspect', 'not_found', `task not found: ${ref}`, 1);
  }
  const values = taskInspectFieldValues(task, parsed.fields);
  const payload = buildInspectPayload({
    action: 'task_inspect',
    idKey: 'task_id',
    idValue: task.id,
    fields: parsed.fields,
    values,
  });
  if (wantsJson(args)) {
    printJson(payload);
    return;
  }
  for (const line of inspectTextLines(parsed.fields, values)) console.log(line);
}

function cmdShow(args) {
  const pos = positional(args);
  const id = pos[0];
  if (!id) {
    failTask('atris task show', 'missing_id', 'id required');
  }
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const taskId = requireTaskId(taskDb, db, id, 'atris task show');
  const projection = enrichTaskProjection(taskDb.taskProjection(db, { taskId }));
  let task = projection.tasks[0];
  if (!task) {
    const wsRoot = scopedWorkspaceRoot(taskDb, args) || process.cwd();
    const proj = readProjectionFile(wsRoot);
    if (proj && Array.isArray(proj.tasks)) {
      task = proj.tasks.find(t => t.id === taskId) || null;
    }
  }
  if (!task) {
    console.error(`task not found: ${id}`);
    process.exit(1);
  }
  if (hasFlag(args, '--json')) {
    printJson(task);
    return;
  }
  const owner = task.claimed_by ? ` / ${task.claimed_by}` : '';
  const tag = task.tag ? ` #${task.tag}` : '';
  const statusLabel = task.status === 'review'
    ? 'ready for approval'
    : task.status === 'done'
      ? 'DONE'
      : task.status.toUpperCase();
  // Plain layer first. Everything below stays exactly as it was.
  for (const line of explanationLines(task.explanation || taskExplanation(task))) console.log(line);
  for (const line of approvalLines(task.approval || taskApprovalFor(task))) console.log(line);
  console.log('');
  console.log('Technical details:');
  console.log(`${statusLabel} ${taskRef(task)} v${task.current_version}${owner}${tag}`);
  console.log(task.title);
  if (task.metadata?.verification_status === 'degraded') {
    const reason = task.metadata.verification_degraded_reason === 'diff_only_verify'
      ? 'diff-only verify command'
      : 'missing verify command';
    console.log(`verification: degraded (${reason})`);
  }
  if (task.review) {
    console.log('');
    printReviewLanding(task.review);
    if (task.review.summary) console.log(`Short version: ${task.review.summary}`);
    if (task.review.proof) console.log(`Details: ${task.review.proof}`);
    if (task.review.lesson) console.log(`Lesson: ${task.review.lesson}`);
    if (task.review.next_task) console.log(`Next: ${task.review.next_task}`);
    if (task.review.approval_status) {
      const landingStatus = task.review.approval_status === 'pending'
        ? 'waiting on human'
        : task.review.approval_status === 'revise'
          ? 'sent back'
          : task.review.approval_status;
      console.log(`Landing: ${landingStatus}`);
    }
    if (task.review.verification_chat) console.log(`Check command: ${task.review.verification_chat.command}`);
    if (task.review.agent_certified) console.log(`Checked: yes (${task.review.agent_review_pass_count || AGENT_CERTIFICATION_REVIEW_PASSES} agent checks)`);
  }
  if (task.messages.length) {
    console.log('');
    console.log('Dialogue:');
    for (const m of task.messages) {
      const who = m.actor || 'unknown';
      console.log(`- v${m.version} ${who}: ${m.content}`);
    }
  }
}

function cmdPage(args) {
  const pos = positional(args);
  const id = pos[0];
  if (!id) {
    failTask('atris task page', 'missing_id', 'id required');
  }
  const reviewer = reviewActor(flag(args, '--as') || 'codex-review');
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const taskId = requireTaskId(taskDb, db, id, 'atris task page');
  const task = taskDetail(taskDb, db, taskId);
  if (!task) {
    console.error(`task not found: ${id}`);
    process.exit(1);
  }
  const { outPath } = writeDefaultProjection(taskDb, db);
  const page = taskPageContract(task, { reviewer });
  if (hasFlag(args, '--json')) {
    printJson({
      ok: true,
      action: 'page',
      task_id: taskId,
      projection_path: outPath,
      page,
    });
    return;
  }
  for (const line of explanationLines(page.explanation)) console.log(line);
  for (const line of approvalLines(page.approval)) console.log(line);
  console.log('');
  console.log(`Technical details: TASK PAGE ${taskRef(task)} - ${task.title}`);
  console.log(`Goal: ${page.goal.text || '(none)'}`);
  console.log(`Stage: ${page.stage.current}`);
  printReviewLanding(page.review);
  console.log(`Next: ${page.stage.next_action.command || page.stage.next_action.label}`);
  console.log(`Chat: ${page.chat.command}`);
  if (page.review.verification_chat) console.log(`Check command: ${page.review.verification_chat.command}`);
  if (page.review.human_accept.enabled) console.log(`Land: ${page.review.human_accept.command}`);
}

function taskDetail(taskDb, db, taskId) {
  const detailedProjection = taskDb.taskProjection(db, { taskId });
  let detailedTask = detailedProjection.tasks[0] || null;
  if (!detailedTask) {
    const wsRoot = taskDb.workspaceRoot ? taskDb.workspaceRoot() : process.cwd();
    const proj = readProjectionFile(wsRoot);
    if (proj && Array.isArray(proj.tasks)) {
      detailedTask = proj.tasks.find(t => t.id === taskId) || null;
    }
  }
  if (!detailedTask) return null;
  const workspaceRoot = detailedTask.workspace_root || taskDb.workspaceRoot();
  const contextProjection = enrichTaskProjection(taskDb.taskProjection(db, {
    workspaceRoot,
    limit: 5000,
  }));
  const enrichedTask = contextProjection.tasks.find(task => task.id === detailedTask.id) || null;
  if (!enrichedTask) return enrichTaskProjection(detailedProjection).tasks[0] || detailedTask;
  return {
    ...enrichedTask,
    current_version: detailedTask.current_version,
    latest_event_type: detailedTask.latest_event_type,
    messages: detailedTask.messages,
    events: detailedTask.events,
    history: detailedTask.history,
  };
}

function taskPageGoal(task) {
  const metadata = task && task.metadata || {};
  const candidates = [
    ['task_goal', metadata.task_goal],
    ['goal_objective', metadata.goal_objective],
    ['objective', task && task.objective],
    ['metadata_objective', metadata.objective],
    ['title', task && task.title],
  ];
  const picked = candidates.find(([, value]) => String(value || '').trim());
  return {
    text: picked ? String(picked[1]).trim() : null,
    source: picked ? picked[0] : null,
  };
}

function taskPageCurrentStage(task) {
  if (!task) return 'missing';
  if (task.status === 'done' && !taskHasReview(task)) return 'review';
  if (task.status === 'done' || (task.status === 'failed' && taskHasReview(task))) return 'done';
  if (task.status === 'failed') return 'blocked';
  if (task.status === 'review') return 'review';
  const metadata = task.metadata || {};
  const explicitStage = normalizedStatusPart(metadata.stage);
  if (explicitStage === 'plan') return 'plan';
  if (explicitStage === 'do') return 'do';
  const column = taskColumn(task);
  if (column === 'open') return 'plan';
  if (column === 'doing') return 'do';
  return column;
}

function taskPageStageRail(current) {
  const order = ['backlog', 'plan', 'do', 'review', 'done'];
  const effectiveCurrent = current === 'blocked' ? 'do' : current;
  const currentIndex = order.indexOf(effectiveCurrent);
  return order.map((key, index) => {
    let state = 'upcoming';
    if (current === 'blocked' && key === 'do') state = 'blocked';
    else if (index < currentIndex) state = 'complete';
    else if (index === currentIndex) state = 'current';
    return {
      key,
      label: key === 'do' ? 'Do' : key.charAt(0).toUpperCase() + key.slice(1),
      state,
    };
  });
}

function taskPageActions(task, { reviewer = 'codex-review', hasExistingReviewFollowUp = null } = {}) {
  const ref = taskRef(task);
  const owner = task && (task.claimed_by || taskAssignee(task)) || DEFAULT_OWNER;
  const goal = taskPageGoal(task).text || '<goal>';
  const actor = reviewActor(reviewer);
  const canReviewChat = taskAllowsReviewChat(task, { allowCertified: true });
  const actions = {
    show_command: `atris task show ${ref} --json`,
    page_command: `atris task page ${ref} --json`,
    step_command: `atris task step ${ref} --json`,
    chat_command: `atris task chat ${ref} "<message>" --goal ${taskCommandQuote(goal)}`,
    note_command: `atris task note ${ref} "<context>" --as ${owner}`,
    plan_command: `atris task plan ${ref} --goal ${taskCommandQuote(goal)} --exit "<exit condition>" --proof-needed "<verification command>" --first-move "<first move>"`,
    do_command: `atris task do ${ref} --as ${owner} --first-move "<first move>"`,
    ready_command: `atris task ready ${ref} --as ${owner} --proof "<specific proof command/result>" --result "<one day-one PM sentence>" --happened "<what happened>" --checked "<how you know>" --tested "<what you ran or inspected>" --decision "<accept/rework guidance>"`,
    review_command: `atris task review ${ref} --reward 0 --as ${actor} --proof "<specific proof command/result>" --verify "<safe verifier command>"`,
  };
  if (task && task.status === 'review') {
    actions.revise_command = `atris task revise ${ref} --as ${actor} --note "<specific missing proof or required change>"`;
    const handoff = reviewHandoffForTask(task, { suppressExistingFollowUp: true, hasExistingReviewFollowUp });
    if (handoffAllowsHumanAccept(handoff)) {
      actions.human_accept_command = `atris task accept ${ref}`;
    }
    const continueWorkCommand = handoff?.next_action === 'continue_work'
      ? continueWorkCommandForTask(task, { owner })
      : null;
    if (continueWorkCommand) actions.continue_work_command = continueWorkCommand;
    if (canReviewChat) {
      actions.review_chat_command = `atris task review-chat ${ref} --as ${actor}`;
    }
  }
  return actions;
}

function taskPageNextAction(task, current, actions, { hasExistingReviewFollowUp = null } = {}) {
  const ref = taskRef(task);
  const apiBase = `/api/tasks/${encodeURIComponent(task && task.id || ref)}`;
  if (current === 'backlog') {
    return { key: 'plan', label: 'Plan task', command: actions.plan_command, api: { method: 'POST', path: `${apiBase}/plan` } };
  }
  if (current === 'plan') {
    return { key: 'do', label: 'Start Do', command: actions.do_command, api: { method: 'POST', path: `${apiBase}/do` } };
  }
  if (current === 'do') {
    return { key: 'ready', label: 'Move to Review', command: actions.ready_command, api: { method: 'POST', path: `${apiBase}/ready` } };
  }
  if (current === 'review') {
    const handoff = reviewHandoffForTask(task, { suppressExistingFollowUp: true, hasExistingReviewFollowUp });
    if (handoff && handoff.next_action === 'continue_work') {
      return {
        key: 'continue_work',
        label: 'Agent certified; continue work',
        command: actions.continue_work_command || null,
        api: actions.continue_work_command ? { method: 'POST', path: `${apiBase}/continue-work` } : null,
        human_accept_command: actions.human_accept_command || null,
      };
    }
    if (handoffIsProofBoundaryBlocked(handoff)) {
      return {
        key: PROOF_BOUNDARY_BLOCKED_ACTION,
        label: 'Proof boundary blocked',
        command: actions.revise_command || null,
        api: null,
        reason: PROOF_BOUNDARY_BLOCKED_REASON,
        next_action_detail: handoff.next_action_detail || null,
        revise_command: actions.revise_command || null,
        human_accept_command: null,
      };
    }
    if (handoff && handoff.next_action === 'human_accept_waiting') {
      return {
        key: 'human_accept_waiting',
        label: 'Ready for approval',
        command: null,
        api: null,
        human_accept_command: actions.human_accept_command || null,
      };
    }
    if (!actions.review_chat_command) {
      return { key: 'review', label: 'Record review proof', command: actions.review_command, api: { method: 'POST', path: `${apiBase}/review` } };
    }
    return { key: 'review_chat', label: 'Start verification chat', command: actions.review_chat_command, api: { method: 'POST', path: `${apiBase}/review-chat` } };
  }
  if (current === 'blocked') {
    return { key: 'blocked', label: 'Blocked', command: null, blocked_reason: 'Task is failed without accepted review proof.' };
  }
  return { key: 'none', label: 'No next agent action', command: null };
}

function taskPageContract(task, { reviewer = 'codex-review', hasExistingReviewFollowUp = null } = {}) {
  const metadata = task && task.metadata || {};
  const current = taskPageCurrentStage(task);
  const actions = taskPageActions(task, { reviewer, hasExistingReviewFollowUp });
  const review = task && (task.review || taskReviewSummary(task));
  const recentMessages = (task && Array.isArray(task.messages) ? task.messages : []).slice(-10).map(message => ({
    version: message.version || null,
    actor: message.actor || null,
    content: message.content || '',
    created_at: message.created_at || null,
  }));
  const reviewChat = task && task.status === 'review'
    && taskAllowsReviewChat(task, { allowCertified: true })
    ? taskReviewChatHandoff(task, { reviewer, allowCertified: true })
    : null;
  const reviewHandoff = reviewHandoffForTask(task, { suppressExistingFollowUp: true, hasExistingReviewFollowUp });
  const humanAcceptEnabled = task.status === 'review' && handoffAllowsHumanAccept(reviewHandoff);
  return {
    schema: 'atris.task_page.v1',
    // First layer: what changes, why it matters, what done looks like, and the
    // two things a person can do about it. The full contract follows unchanged.
    explanation: task.explanation || taskExplanation(task),
    approval: taskApprovalFor(task, { reviewer, hasExistingReviewFollowUp }),
    task: {
      id: task.id,
      ref: taskRef(task),
      display_id: task.display_id || null,
      legacy_ref: task.legacy_ref || null,
      title: task.title,
      status: task.status,
      tag: task.tag || null,
      claimed_by: task.claimed_by || null,
      assigned_to: taskAssignee(task),
      objective: task.objective || metadata.task_goal || metadata.goal_objective || null,
      current_version: task.current_version || null,
      latest_event_type: task.latest_event_type || null,
      updated_at: task.updated_at || null,
    },
    goal: taskPageGoal(task),
    chat: {
      command: actions.chat_command,
      api: { method: 'POST', path: `/api/tasks/${encodeURIComponent(task.id)}/chat` },
      recent_messages: recentMessages,
      can_chat: !['done', 'failed'].includes(task.status),
    },
    stage: {
      current,
      rail: taskPageStageRail(current),
      next_action: taskPageNextAction(task, current, actions, { hasExistingReviewFollowUp }),
    },
    actions,
    review: {
      landing: review && review.landing || null,
      result: review && review.result || null,
      summary: review && review.summary || null,
      proof: review && review.proof || null,
      approval_status: review && review.approval_status || metadata.approval_status || null,
      agent_review_pass_count: review && review.agent_review_pass_count || metadata.agent_review_pass_count || null,
      agent_certified: Boolean(review && review.agent_certified || metadata.agent_certified),
      verification_chat: reviewChat,
      handoff: reviewHandoff,
      human_accept: {
        enabled: humanAcceptEnabled,
        command: humanAcceptEnabled ? actions.human_accept_command : null,
        human_only: true,
        xp_after_accept: true,
      },
    },
    api: {
      detail: `/api/tasks/${encodeURIComponent(task.id)}`,
      page: `/api/tasks/${encodeURIComponent(task.id)}/page`,
      step: `/api/tasks/${encodeURIComponent(task.id)}/step`,
      events: `/api/tasks/${encodeURIComponent(task.id)}/events`,
    },
  };
}

module.exports = {
  bindMain, cmdNote, cmdRetitle, cmdTag, cmdChat, stageErrorDetail, cmdInspect, cmdShow, cmdPage,
  taskDetail, taskPageGoal, taskPageCurrentStage, taskPageStageRail, taskPageActions,
  taskPageNextAction, taskPageContract,
};
