'use strict';

// commands/task/reviews/reviews.js: The reviews queue people read, review chat on a task, and
// sending a task back with revise.
// Owner: validator. Moved out of commands/task.js on 2026-11-16 by lib/split-file.js; read
// README.md first.

// Names borrowed from commands/task.js and other feature folders, set by bindMain().
let hasFlag, taskExplanation, extractReceiptEvidence, reviewIntegrity, gateForHuman, numberWord,
  plainLandingReason, DEFAULT_OWNER, AGENT_CERTIFICATION_REVIEW_PASSES,
  PROOF_BOUNDARY_BLOCKED_ACTION, getTaskDb, flag, wantsJson, printJson, failTask, positional,
  taskRef, writeDefaultProjection, genericContinuationIssues, continueWorkCommandForTask,
  handoffAllowsHumanAccept, taskApprovalFor, reviewLandingForDisplay, reviewBlockerForTask,
  reviewHandoffForTask, reviewActor, taskReviewClip, taskReviewChatHandoff, taskReviewChatContract,
  taskReviewChatNote, compactTaskFromProjection, requireTaskId, taskDetail;
function bindMain(deps) {
  ({
    hasFlag, taskExplanation, extractReceiptEvidence, reviewIntegrity, gateForHuman, numberWord,
    plainLandingReason, DEFAULT_OWNER, AGENT_CERTIFICATION_REVIEW_PASSES,
    PROOF_BOUNDARY_BLOCKED_ACTION, getTaskDb, flag, wantsJson, printJson, failTask, positional,
    taskRef, writeDefaultProjection, genericContinuationIssues, continueWorkCommandForTask,
    handoffAllowsHumanAccept, taskApprovalFor, reviewLandingForDisplay, reviewBlockerForTask,
    reviewHandoffForTask, reviewActor, taskReviewClip, taskReviewChatHandoff,
    taskReviewChatContract, taskReviewChatNote, compactTaskFromProjection, requireTaskId,
    taskDetail,
  } = deps);
}

function arrayFromPathValue(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(arrayFromPathValue);
  if (typeof value === 'object') {
    if (typeof value.path === 'string') return [value.path];
    if (typeof value.file === 'string') return [value.file];
    if (typeof value.filename === 'string') return [value.filename];
    return [];
  }
  return String(value)
    .split(/[\n,]+/)
    .map(part => part.trim())
    .filter(Boolean);
}

function reviewQueueLimit(args, total) {
  if (hasFlag(args, '--all')) return total;
  const raw = flag(args, '--limit');
  const limit = raw && raw !== true ? Number(raw) : 5;
  return Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 5;
}

function reviewQueueVerbose(args) {
  return hasFlag(args, '--verbose') || hasFlag(args, '--details') || hasFlag(args, '--all');
}

function reviewGroupTextLimit(args, total) {
  if (hasFlag(args, '--all')) return total;
  const raw = flag(args, '--limit');
  const limit = raw && raw !== true ? Number(raw) : 10;
  return Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 10;
}

function plainReviewBlockerMessage(item) {
  const ref = item.display_id || taskRef(item.id);
  if (item.reason === 'verify_command_not_allowed') {
    return `${ref} used a check command the system does not allow; rerun with an approved check`;
  }
  if (item.reason === 'needs_second_actor_review') {
    return `${ref} needs a second reviewer before it can land`;
  }
  return `${ref} needs another check before it can land`;
}

// Risk order for human attention: named receipts that are missing/failing (0)
// beat prose-only proofs (1) beat fully validated green evidence (2).
function evidenceRiskRank(evidence) {
  if (!evidence) return 1;
  return evidence.all_passing ? 2 : 0;
}

function reviewQueueItem(task, root = process.cwd(), evidence = undefined) {
  const ref = taskRef(task);
  const handoff = reviewHandoffForTask(task, { suppressExistingFollowUp: true });
  const reviewChat = taskReviewChatHandoff(task, { reviewer: 'codex-review', allowCertified: true });
  const continueWorkCommand = continueWorkCommandForTask(task);
  const genericIssues = genericContinuationIssues(task);
  const acceptCommand = handoffAllowsHumanAccept(handoff) ? `atris task accept ${ref}` : null;
  const item = {
    id: task.id,
    display_id: task.display_id || null,
    title: task.title,
    explanation: task.explanation || taskExplanation(task),
    approval: task.approval || taskApprovalFor(task),
    tag: task.tag || null,
    updated_at: task.updated_at || null,
    review_pass_count: task.review?.agent_review_pass_count || null,
    landing: reviewLandingForDisplay(task.review),
    result: task.review?.result || null,
    proof: taskReviewClip(task.review?.proof, 500) || null,
    next_action: handoff?.next_action || null,
    accept_command: acceptCommand,
    land_command: acceptCommand,
    revise_command: `atris task revise ${ref} --note "<what must change>"`,
    send_back_command: `atris task revise ${ref} --note "<what must change>"`,
  };
  const resolvedEvidence = evidence === undefined ? extractReceiptEvidence(task.review?.proof, root) : evidence;
  if (resolvedEvidence) item.evidence = resolvedEvidence;
  if (!acceptCommand && handoff?.reason) {
    item.blocked_accept_reason = handoff.reason;
    item.next_action_detail = handoff.next_action_detail || null;
  }
  if (continueWorkCommand && handoff?.next_action === 'continue_work') {
    item.continue_work_command = continueWorkCommand;
    item.continue_work_api = { method: 'POST', path: `/api/tasks/${encodeURIComponent(task.id)}/continue-work` };
  }
  if (reviewChat) {
    item.review_chat_command = reviewChat.command;
    item.codex_prompt = reviewChat.codex_prompt;
    item.verification_focus = reviewChat.verification_focus;
  }
  if (genericIssues.length) {
    item.hygiene = {
      generic_continuation_issues: genericIssues,
    };
  }
  return item;
}

function blockedReviewQueueItem(task, root = process.cwd()) {
  const item = reviewQueueItem(task, root);
  const blocker = reviewBlockerForTask(task);
  item.queue_role = 'blocked';
  item.reason = blocker.reason;
  item.blocked_reason = blocker.reason;
  item.next_command = blocker.next_command;
  item.verify_command = blocker.verify_command;
  item.accept_command = null;
  item.land_command = null;
  return item;
}

function reviewQueueHygiene(tasks) {
  const genericContinuations = (tasks || []).map(task => {
    const issues = genericContinuationIssues(task);
    if (!issues.length) return null;
    return {
      id: task.id,
      display_id: task.display_id || null,
      title: task.title,
      issues,
    };
  }).filter(Boolean);
  return {
    generic_continuation_count: genericContinuations.length,
    generic_continuations: genericContinuations,
  };
}

function taskReviewQueue(projection, args = []) {
  const reviewTasks = (projection.tasks || [])
    .filter(task => task && task.status === 'review' && task.review && task.review.approval_status === 'pending')
    .sort((a, b) => Number(b.updated_at || 0) - Number(a.updated_at || 0));
  const reviewHandoff = (task) => task.review?.handoff || reviewHandoffForTask(task, { suppressExistingFollowUp: true });
  const blocking = reviewTasks.filter(task => reviewHandoff(task)?.next_action === 'agent_review_again');
  const proofBoundaryBlocked = reviewTasks.filter(task => reviewHandoff(task)?.next_action === PROOF_BOUNDARY_BLOCKED_ACTION);
  const certified = reviewTasks.filter(task => {
    const handoff = reviewHandoff(task);
    return handoff?.next_action === 'continue_work'
      || handoff?.next_action === PROOF_BOUNDARY_BLOCKED_ACTION
      || handoff?.next_action === 'human_accept_waiting'
      || task.review?.agent_certified === true;
  });
  const limit = reviewQueueLimit(args, certified.length);
  const root = projection.workspace_root || process.cwd();
  // Green-evidence items float to the top: they are the cheapest accepts.
  const evidenceByTaskId = new Map(certified.map((task) => [task.id, extractReceiptEvidence(task.review?.proof, root)]));
  const ordered = [...certified].sort((a, b) =>
    evidenceRiskRank(evidenceByTaskId.get(b.id)) - evidenceRiskRank(evidenceByTaskId.get(a.id))
    || Number(b.updated_at || 0) - Number(a.updated_at || 0));
  const certifiedItems = ordered.slice(0, limit).map((task) => reviewQueueItem(task, root, evidenceByTaskId.get(task.id)));
  const blockedLimit = reviewQueueLimit(args, blocking.length);
  const blockedItems = blocking.slice(0, blockedLimit).map((task) => blockedReviewQueueItem(task, root));
  const items = [...certifiedItems, ...blockedItems];
  return {
    schema: 'atris.task_review_queue.v1',
    generated_at: projection.generated_at,
    workspace_root: projection.workspace_root,
    counts: {
      review: reviewTasks.length,
      certified: certified.length,
      evidence_passing: certified.filter((task) => evidenceByTaskId.get(task.id)?.all_passing).length,
      blocking: blocking.length,
      proof_boundary_blocked: proofBoundaryBlocked.length,
      shown: certifiedItems.length,
      blocking_shown: blockedItems.length,
    },
    hygiene: reviewQueueHygiene(reviewTasks),
    items,
  };
}

// ── Fast unblock: cluster the certified-pending wall so a human reviews ~15 groups, not 473 rows ──
function certifiedPendingReviewTasks(projection) {
  return (projection.tasks || [])
    .filter(task => task && task.status === 'review' && task.review && task.review.approval_status === 'pending')
    .filter(task => {
      const handoff = task.review?.handoff || reviewHandoffForTask(task, { suppressExistingFollowUp: true });
      return handoff?.next_action === 'continue_work'
        || handoff?.next_action === 'human_accept_waiting'
        || task.review?.agent_certified === true;
    });
}

function reviewGroupKey(value) {
  const v = String(value || 'tag').toLowerCase();
  return ['tag', 'owner', 'source'].includes(v) ? v : 'tag';
}

function reviewGroupValue(task, key) {
  if (key === 'owner') return String(task.claimed_by || '(unclaimed)');
  if (key === 'source') return String(task.source_key || (task.metadata && task.metadata.source) || '(no source)');
  return String(task.tag || '(untagged)');
}

function taskReviewGroups(projection, key) {
  const certified = certifiedPendingReviewTasks(projection);
  const root = projection.workspace_root || process.cwd();
  const groups = new Map();
  for (const task of certified) {
    const value = reviewGroupValue(task, key);
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value).push(task);
  }
  const list = [...groups.entries()].map(([value, tasks]) => ({
    value,
    count: tasks.length,
    evidence_passing: tasks.filter(t => extractReceiptEvidence(t.review?.proof, root)?.all_passing).length,
    sample_titles: tasks.slice(0, 3).map(t => t.title).filter(Boolean),
    oldest_updated_at: tasks.reduce((min, t) => Math.min(min, Number(t.updated_at || 0) || 0), Infinity),
    accept_group_command: `atris task accept-group ${key}=${JSON.stringify(value)} --spot-check 3`,
  })).sort((a, b) => b.count - a.count || String(a.value).localeCompare(String(b.value)));
  return {
    schema: 'atris.task_review_groups.v1',
    generated_at: projection.generated_at,
    workspace_root: projection.workspace_root,
    group_by: key,
    total_certified: certified.length,
    group_count: list.length,
    groups: list,
  };
}

function taskReviewLandingLines(item) {
  if (!item?.landing) return [];
  const clean = value => value
    ? gateForHuman(value, { title: item.title }).text
    : '';
  const happened = clean(item.landing.happened);
  const reason = clean(item.landing.reason);
  const unperiod = value => value.replace(/\.$/, '');
  const checked = unperiod(clean(item.landing.checked));
  const tested = unperiod(clean(item.landing.tested));
  return [
    happened ? `   what's new: ${happened}` : '',
    reason ? `   why it matters: ${reason}` : '',
    checked ? `   checked: ${checked}${tested && tested !== checked ? `; tested: ${tested}` : ''}.` : '',
  ].filter(Boolean);
}

function cmdReviews(args) {
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  // Reviews is a view, not an execution lane. Certification and landing are
  // persisted by certify-verified, explicit receipt/ready commands, sweep,
  // and autoland; this command only reports that stored state.
  const autoAcceptView = {
    enabled: false,
    read_only: true,
    accepted_now: 0,
    accepted_since_last_look: 0,
    results: [],
  };
  const groupByRaw = flag(args, '--group-by');
  if (groupByRaw) {
    const key = reviewGroupKey(groupByRaw);
    const groups = taskReviewGroups(projection, key);
    if (wantsJson(args)) {
      printJson({
        ok: true,
        action: 'review_groups',
        projection_path: outPath,
        autoaccept: autoAcceptView,
        groups,
      });
      return;
    }
    console.log(gateForHuman(`${numberWord(groups.total_certified)} finished things are waiting, grouped by ${key}.`).text);
    const visibleGroups = groups.groups.slice(0, reviewGroupTextLimit(args, groups.groups.length));
    visibleGroups.forEach((g, index) => {
      console.log('');
      console.log(`${index + 1}. ${g.value} - ${numberWord(g.count)} task${g.count === 1 ? '' : 's'}`);
      g.sample_titles.forEach(title => console.log(`   • ${gateForHuman(title, { title }).text}`));
      console.log(`   approve this group: ${g.accept_group_command} --confirm-human-accept --as <you>`);
    });
    if (visibleGroups.length < groups.groups.length) {
      console.log('');
      console.log(`showing ${numberWord(visibleGroups.length)} of ${numberWord(groups.groups.length)} groups; rerun with --all for every group or --limit N to adjust.`);
    }
    return;
  }
  const queue = taskReviewQueue(projection, args);
  const verbose = reviewQueueVerbose(args);
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'review_queue',
      projection_path: outPath,
      autoaccept: autoAcceptView,
      queue,
    });
    return;
  }
  const approvalItems = queue.items.filter(item => item.queue_role !== 'blocked');
  const blockedItems = queue.items.filter(item => item.queue_role === 'blocked');
  if (!approvalItems.length && !blockedItems.length) {
    console.log('nothing is waiting on you. everything that finished has already landed.');
    return;
  }
  if (queue.counts.certified > 0) {
    const header = queue.counts.certified === 1
      ? 'one finished thing is waiting for your ok. it passed both checks.'
      : `${numberWord(queue.counts.certified)} finished things are waiting for your ok. all of them passed both checks.`;
    console.log(gateForHuman(header).text);
  }
  if (queue.counts.blocking > 0) {
    console.log(gateForHuman(queue.counts.blocking === 1
      ? 'one more is almost ready; a second check is still running.'
      : `${numberWord(queue.counts.blocking)} more are almost ready; second checks are still running.`).text);
  }
  approvalItems.forEach((item, index) => {
    if (index > 0) console.log('');
    const ref = item.display_id || taskRef(item.id);
    const badge = item.evidence?.any_forced
      ? ' [evidence:forced]'
      : item.evidence?.all_passing ? ' [evidence:passing]' : '';
    console.log(`${index + 1}. ${item.explanation.what_changes} (${ref})${badge}`);
    console.log(`   why it matters: ${item.explanation.why_it_matters}`);
    console.log(`   done looks like: ${item.explanation.done_looks_like}`);
    if (item.landing) {
      taskReviewLandingLines(item).forEach(line => console.log(line));
      if (verbose && item.result?.saved) console.log(`   saved: ${item.result.saved}`);
    }
    if (verbose && item.proof) console.log(`   details: ${item.proof}`);
    if (verbose && item.evidence) {
      item.evidence.receipts.forEach((receipt) => {
        const verdict = receipt.verifier_passed === true ? ' verifier:passed'
          : receipt.verifier_passed === false ? ' verifier:FAILED' : '';
        console.log(`   receipt: ${receipt.path}${verdict}`);
      });
      item.evidence.missing.forEach((missingPath) => console.log(`   receipt: ${missingPath} MISSING`));
    }
    if (verbose && item.review_chat_command) console.log(`   /codex: ${item.review_chat_command}`);
    if (item.accept_command) {
      console.log(`   say yes: atris task accept ${item.display_id || taskRef(item.id)}`);
      console.log(`   ask for a change: ${item.revise_command}`);
    } else if (item.blocked_accept_reason) {
      console.log(`   approve: blocked; ${plainLandingReason(item.blocked_accept_reason)}`);
      console.log(`   rework: ${item.revise_command}`);
    }
  });
  if (blockedItems.length > 0) {
    if (approvalItems.length > 0) console.log('');
    console.log('still being checked:');
    for (const item of blockedItems) {
      console.log(`${plainReviewBlockerMessage(item)}; next: ${item.next_command}`);
    }
  }
  if (queue.counts.shown < queue.counts.certified) {
    console.log('');
    console.log(`showing ${numberWord(queue.counts.shown)} of ${numberWord(queue.counts.certified)}; rerun with --all for every row or --verbose for proof details.`);
  }
}

function cmdReviewChat(args) {
  const pos = positional(args);
  const id = pos[0];
  if (!id) {
    failTask('atris task review-chat', 'missing_id', 'id required');
  }
  const reviewer = reviewActor(flag(args, '--as') || 'codex-review');
  const dryRun = hasFlag(args, '--dry-run') || hasFlag(args, '--no-note');
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const taskId = requireTaskId(taskDb, db, id, 'atris task review-chat');
  let result;
  try {
    result = appendTaskReviewChat(taskDb, db, taskId, { reviewer, dryRun });
  } catch (error) {
    failTask('atris task review-chat', error.reason || 'review_chat_failed', error.message, error.exitCode || 2);
  }
  const { task, contract, event, compactProjection, outPath } = result;
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'review_chat',
      task_id: taskId,
      appended: !dryRun,
      version: event ? event.version : null,
      projection_path: outPath,
      contract,
      task,
      compact_task: compactTaskFromProjection(compactProjection, taskId),
    });
    return;
  }
  console.log(`REVIEW CHAT ${taskRef(task)}`);
  console.log(contract.codex_prompt);
  console.log(`show: atris task show ${taskRef(task)} --json`);
  console.log(`pass: ${contract.pass_command}`);
  console.log(`revise: ${contract.revise_command}`);
  if (!dryRun && event) console.log(`thread: appended v${event.version}`);
}

function taskReviewChatError(reason, detail, { status = 400, exitCode = 2 } = {}) {
  const error = new Error(detail || reason);
  error.reason = reason;
  error.status = status;
  error.exitCode = exitCode;
  return error;
}

function taskAllowsReviewChat(task, { allowCertified = false } = {}) {
  if (!task || task.status !== 'review') return false;
  const review = task.review || {};
  const metadata = task.metadata || {};
  const approvalStatus = review.approval_status || metadata.approval_status || null;
  if (approvalStatus && approvalStatus !== 'pending') return false;
  if (allowCertified) return true;
  if (review.agent_certified === true || metadata.agent_certified === true) return false;
  const reviewPassCount = Number(review.agent_review_pass_count || metadata.agent_review_pass_count || 0);
  if (reviewPassCount >= AGENT_CERTIFICATION_REVIEW_PASSES && reviewIntegrity.hasIndependentReview(task)) return false;
  const handoff = reviewHandoffForTask(task, { suppressExistingFollowUp: true });
  return !(handoff && (handoff.next_action === 'continue_work' || handoff.next_action === 'human_accept_waiting'));
}

function appendTaskReviewChat(taskDb, db, taskId, { reviewer = 'codex-review', dryRun = false } = {}) {
  const actor = reviewActor(reviewer);
  let task = taskDetail(taskDb, db, taskId);
  if (!task) {
    throw taskReviewChatError('not_found', `task not found: ${taskId}`, { status: 404, exitCode: 1 });
  }
  if (task.status !== 'review') {
    throw taskReviewChatError(`not_reviewable_${task.status}`, `review chat requires a task in Review; current status is ${task.status}`, { status: 409, exitCode: 1 });
  }
  if (!taskAllowsReviewChat(task, { allowCertified: true })) {
    throw taskReviewChatError('agent_certified_continue_work', 'review chat is closed after agent certification; continue other work or wait for human approval/rework on this task', { status: 409, exitCode: 1 });
  }
  const contract = taskReviewChatContract(task, { reviewer: actor, allowCertified: true });
  let event = null;
  if (!dryRun) {
    const noted = taskDb.noteTask(db, {
      id: taskId,
      actor,
      content: taskReviewChatNote(contract),
    });
    if (!noted.noted) {
      throw taskReviewChatError(noted.reason || 'note_failed', `review chat failed: ${noted.reason || 'note_failed'}`, { status: 409, exitCode: 1 });
    }
    event = noted.event;
    task = taskDetail(taskDb, db, taskId) || task;
  }
  const { projection: compactProjection, outPath } = writeDefaultProjection(taskDb, db);
  return {
    ok: true,
    action: 'review_chat',
    task_id: taskId,
    appended: !dryRun,
    version: event ? event.version : null,
    projection_path: outPath,
    contract,
    task,
    compact_task: compactTaskFromProjection(compactProjection, taskId),
    event,
    compactProjection,
    outPath,
  };
}

function cmdRevise(args) {
  const pos = positional(args);
  const id = pos[0];
  if (!id) {
    console.error('atris task revise: id required');
    process.exit(2);
  }
  const note = flag(args, '--note') || flag(args, '--reason') || pos.slice(1).join(' ');
  if (!note || note === true) {
    console.error('atris task revise: --note required');
    process.exit(2);
  }
  const actor = String(flag(args, '--as') || DEFAULT_OWNER);
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const taskId = requireTaskId(taskDb, db, id, 'atris task revise');
  const result = taskDb.reviseTask(db, { id: taskId, actor, note: String(note) });
  if (!result.revised) {
    console.error(`revise failed: ${result.reason}`);
    process.exit(1);
  }
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'revise',
      task_id: taskId,
      version: result.event.version,
      approval_status: 'revise',
      revision_count: result.event.payload.revision_count,
      episode: result.episode || null,
      projection_path: outPath,
      task: compactTaskFromProjection(projection, taskId),
    });
    return;
  }
  console.log(`revise ${taskRef(compactTaskFromProjection(projection, taskId))} v${result.event.version}`);
}

module.exports = {
  bindMain, arrayFromPathValue, reviewQueueLimit, reviewQueueVerbose, reviewGroupTextLimit,
  plainReviewBlockerMessage, evidenceRiskRank, reviewQueueItem, blockedReviewQueueItem,
  reviewQueueHygiene, taskReviewQueue, certifiedPendingReviewTasks, reviewGroupKey,
  reviewGroupValue, taskReviewGroups, taskReviewLandingLines, cmdReviews, cmdReviewChat,
  taskReviewChatError, taskAllowsReviewChat, appendTaskReviewChat, cmdRevise,
};
