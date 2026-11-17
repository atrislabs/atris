'use strict';

// commands/task/review-evidence/review-evidence.js: What a reviewer reads about a task: the review
// summary, the proof and evidence commands, the review chat handoff, and follow-up tasks a review
// asks for.
// Owner: validator. Moved out of commands/task.js on 2026-11-16 by lib/split-file.js; read
// README.md first.

// Names borrowed from commands/task.js and other feature folders, set by bindMain().
let hasFlag, evaluateAutoAccept, isAutoCertifyVerifyCommandAllowed, extractReceiptEvidence,
  reviewIntegrity, isRetiredFillerReason, landingWhyClause, DEFAULT_OWNER,
  AGENT_CERTIFICATION_REVIEW_PASSES, PROOF_BOUNDARY_BLOCKED_ACTION, MISSION_XP_END_TO_END_REASON,
  warnIfTaskTitleNeedsOperatorWhy, missionReceiptResultForProof, missionXpProofBoundaryEvaluation,
  taskRef, taskAssignee, clipStatusText, taskHasReviewFollowUpChild, taskAllowsReviewChat;
function bindMain(deps) {
  ({
    hasFlag, evaluateAutoAccept, isAutoCertifyVerifyCommandAllowed, extractReceiptEvidence,
    reviewIntegrity, isRetiredFillerReason, landingWhyClause, DEFAULT_OWNER,
    AGENT_CERTIFICATION_REVIEW_PASSES, PROOF_BOUNDARY_BLOCKED_ACTION, MISSION_XP_END_TO_END_REASON,
    warnIfTaskTitleNeedsOperatorWhy, missionReceiptResultForProof, missionXpProofBoundaryEvaluation,
    taskRef, taskAssignee, clipStatusText, taskHasReviewFollowUpChild, taskAllowsReviewChat,
  } = deps);
}

function reviewNextTaskTitle(task) {
  return normalizeReviewNextTaskInput(rawReviewNextTaskTitle(task)).nextTask;
}

function rawReviewNextTaskTitle(task) {
  const review = task && task.review || {};
  const metadata = task && task.metadata || {};
  return String(review.next_task || metadata.latest_agent_next_task || '').trim();
}

function reviewNextTaskTitleIsSpecific(title) {
  const text = String(title || '').trim();
  if (!text) return false;
  const compact = text.toLowerCase().replace(/\s+/g, ' ');
  return ![
    /^human accept remains pending\b/,
    /^agent double-check complete\b/,
    /^proof is in review\b/,
    /^continue work elsewhere\b/,
    /\bnext agent-actionable work can continue\b/,
    /\bagentxp waits for human accept\b/,
  ].some(pattern => pattern.test(compact));
}

function normalizeReviewNextTaskInput(value) {
  const raw = String(value || '').trim();
  if (!raw) return { nextTask: '', ignored: null };
  if (reviewNextTaskTitleIsSpecific(raw)) return { nextTask: raw, ignored: null };
  return {
    nextTask: '',
    ignored: {
      reason: 'non_specific_next_task',
      value: raw,
    },
  };
}

function genericContinuationIssues(task) {
  const issues = [];
  const titleInput = normalizeReviewNextTaskInput(task && task.title);
  if (titleInput.ignored) {
    issues.push({
      field: 'title',
      reason: titleInput.ignored.reason,
      value: titleInput.ignored.value,
    });
  }
  const nextTitle = rawReviewNextTaskTitle(task);
  const nextInput = normalizeReviewNextTaskInput(nextTitle);
  if (nextInput.ignored) {
    issues.push({
      field: 'review.next_task',
      reason: nextInput.ignored.reason,
      value: nextInput.ignored.value,
    });
  }
  return issues;
}

function findExistingReviewNextTask(taskDb, db, currentTask, title) {
  const parentId = currentTask && currentTask.id || null;
  const nextTitle = String(title || '').trim();
  if (!parentId || !nextTitle) return null;
  const children = taskDb.listTasks(db, {
    workspaceRoot: taskDb.workspaceRoot(),
  }).filter(task => {
    const metadata = task.metadata || {};
    return metadata.parent_task_id === parentId
      && metadata.source === 'task_review_next';
  });
  return children.find(task => String(task.title || '').trim() === nextTitle)
    || children[0]
    || null;
}

function buildReviewFollowUpChildPredicate(taskDb, db, workspaceRoot) {
  const rows = taskDb.listTasks(db, {
    workspaceRoot: workspaceRoot || null,
  });
  const childrenByParent = new Map();
  for (const task of rows) {
    const metadata = task && task.metadata || {};
    const parentId = metadata.parent_task_id || null;
    if (!parentId || metadata.source !== 'task_review_next') continue;
    if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
    childrenByParent.get(parentId).push(task);
  }
  return task => {
    const parentId = task && task.id || null;
    return Boolean(parentId && childrenByParent.has(parentId));
  };
}

function taskEventOrderValue(event) {
  const version = Number(event && event.version);
  if (Number.isFinite(version) && version > 0) return version;
  const createdAt = Number(event && event.created_at);
  return Number.isFinite(createdAt) ? createdAt : 0;
}

function eventIsTaskReviewChat(event) {
  const content = event && event.payload && event.payload.content;
  return event && event.event_type === 'message'
    && /\bTASK_REVIEW_CHAT\b/.test(String(content || ''));
}

function eventClearsPendingReviewChat(event) {
  return Boolean(event && [
    'proof_ready',
    'reviewed',
    'revision_requested',
    'completed',
    'blocked',
  ].includes(event.event_type));
}

function buildPendingReviewChatPredicate(taskDb, db, workspaceRoot) {
  const events = taskDb.listTaskEvents(db, {
    workspaceRoot: workspaceRoot || null,
  });
  const latestReviewChatByTask = new Map();
  const latestClearByTask = new Map();
  for (const event of events) {
    const taskId = event && event.task_id;
    if (!taskId) continue;
    const order = taskEventOrderValue(event);
    if (eventIsTaskReviewChat(event)) {
      latestReviewChatByTask.set(taskId, Math.max(latestReviewChatByTask.get(taskId) || 0, order));
    } else if (eventClearsPendingReviewChat(event)) {
      latestClearByTask.set(taskId, Math.max(latestClearByTask.get(taskId) || 0, order));
    }
  }
  return task => {
    const taskId = task && task.id || null;
    if (!taskId) return false;
    const latestReviewChat = latestReviewChatByTask.get(taskId) || 0;
    if (!latestReviewChat) return false;
    return latestReviewChat > (latestClearByTask.get(taskId) || 0);
  };
}

function createReviewNextTask(taskDb, db, currentTask, title) {
  const nextTitle = String(title || '').trim();
  if (!nextTitle) return null;
  const operatorTitleWarning = warnIfTaskTitleNeedsOperatorWhy(nextTitle);
  const currentMetadata = currentTask && currentTask.metadata && typeof currentTask.metadata === 'object'
    ? currentTask.metadata
    : {};
  const existing = findExistingReviewNextTask(taskDb, db, currentTask, nextTitle);
  if (existing) return { id: existing.id, inserted: false, operator_title_warning: operatorTitleWarning };
  const goalId = currentMetadata.goal_id || currentMetadata.goalId || null;
  const parentId = currentTask && currentTask.id || null;
  const sourceKey = parentId && typeof taskDb.sourceKey === 'function'
    ? taskDb.sourceKey(`task_review_next:${parentId}`, nextTitle)
    : null;
  try {
    const created = taskDb.addTask(db, {
      title: nextTitle,
      tag: currentTask && currentTask.tag || null,
      workspaceRoot: taskDb.workspaceRoot(),
      sourceKey,
      metadata: {
        parent_task_id: parentId,
        ...(goalId ? { goal_id: String(goalId) } : {}),
        source: 'task_review_next',
      },
    });
    return { ...created, operator_title_warning: operatorTitleWarning };
  } catch (error) {
    if (sourceKey && /constraint|unique/i.test(String(error && (error.code || error.message) || error))) {
      const racedExisting = findExistingReviewNextTask(taskDb, db, currentTask, nextTitle);
      if (racedExisting) return { id: racedExisting.id, inserted: false, operator_title_warning: operatorTitleWarning };
    }
    throw error;
  }
}

function createNextTaskIfRequested(taskDb, db, args, currentTask, title) {
  if (!hasFlag(args, '--create-next')) return null;
  return createReviewNextTask(taskDb, db, currentTask, title);
}

function continueWorkCommandForTask(task, { owner } = {}) {
  if (!reviewNextTaskTitle(task)) return null;
  const actor = String(owner || (task && (task.claimed_by || taskAssignee(task))) || DEFAULT_OWNER).trim() || DEFAULT_OWNER;
  return `atris task continue-work ${taskRef(task)} --as ${actor} --json`;
}

function certifiedReviewNextAction(nextTaskTitle) {
  return String(nextTaskTitle || '').trim() ? 'continue_work' : 'human_accept_waiting';
}

function proofBoundaryBlockedEvaluation(task) {
  const missionXpBoundary = missionXpProofBoundaryEvaluation(task);
  if (missionXpBoundary) return missionXpBoundary;
  // This is a render-path probe for the boundary reason only. strictVerify
  // alone is not enough to keep it read-only because probationary actors
  // still require strict verification. Never execute a stored verifier while
  // drawing task reviews, status, queues, or projections.
  const evaluation = evaluateAutoAccept(task, {
    strictVerify: false,
    minPasses: 0,
    executeVerify: false,
  });
  return evaluation && evaluation.reason === 'proof_unmerged_or_draft_pr_boundary'
    ? evaluation
    : null;
}

function handoffAllowsHumanAccept(handoff) {
  return handoff && !handoffIsProofBoundaryBlocked(handoff);
}

function handoffIsProofBoundaryBlocked(handoff) {
  return handoff && handoff.next_action === PROOF_BOUNDARY_BLOCKED_ACTION;
}

function reviewSummary(task, payload = {}) {
  const metadata = task.metadata || {};
  const explicit = payload.summary
    || payload.meaning
    || metadata.review_summary
    || metadata.review_meaning
    || metadata.plain_language_summary
    || metadata.human_summary;
  if (explicit) return clipStatusText(explicit, 240);

  const title = String(task.title || 'this task').replace(/\s+/g, ' ').trim();
  const plainTitle = title ? title.charAt(0).toLowerCase() + title.slice(1) : 'this task';
  const approvalStatus = payload.approval_status || metadata.approval_status || null;
  if (approvalStatus === 'revise') {
    return `Rework requested for ${plainTitle}.`;
  }
  const careerText = [
    task.tag,
    metadata.goal_id,
    metadata.task_goal,
    metadata.goal_objective,
    metadata.review_goal,
  ].filter(Boolean).join(' ').toLowerCase();
  if (
    careerText.includes('career-xp')
    || careerText.includes('career xp')
    || careerText.includes('agent-xp')
    || careerText.includes('agent xp')
  ) {
    if (task.status === 'done') {
      return `Completed AgentXP result for ${plainTitle}.`;
    }
    if (task.status === 'review') {
      return `${plainTitle}: proof is ready for human approval; approve only if the evidence is real.`;
    }
    return `This explains the AgentXP result ${plainTitle} would make real.`;
  }
  if (task.status === 'done') {
    return `Completed result for ${plainTitle}.`;
  }
  if (task.status === 'review') {
    return `${plainTitle}: review the completed result, then approve or ask for rework.`;
  }
  return `This explains what ${plainTitle} would make real.`;
}

function titleToResultText(title) {
  const text = String(title || 'this task').replace(/\s+/g, ' ').trim();
  if (!text) return 'Completed this task.';
  const resultSentence = (prefix, body) => {
    const clean = String(body || '').replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '');
    return clean ? `${prefix} ${clean}.` : `${prefix}.`;
  };
  const missionXp = text.match(/^Mission XP:\s*(.+)$/i);
  if (missionXp) {
    const missionResult = titleToResultText(missionXp[1]).replace(/[.!?]+$/, '');
    return resultSentence('Completed mission work:', missionResult.replace(/^Completed:\s*/i, ''));
  }
  const [first, ...restParts] = text.split(' ');
  const rest = restParts.join(' ');
  const firstLower = String(first || '').toLowerCase();
  const compound = rest.match(/^and\s+([a-z]+)\s+(.+)$/i);
  const compoundPast = compound ? ({
    audit: { close: 'Audited and closed' },
    decide: { start: 'Decided and started' },
    prune: { compress: 'Pruned and compressed' },
  }[firstLower] || {})[String(compound[1] || '').toLowerCase()] : null;
  if (compoundPast && compound[2]) return resultSentence(compoundPast, compound[2]);
  const past = {
    add: 'Added',
    approve: 'Prepared approval for',
    audit: 'Audited',
    batch: 'Batched',
    build: 'Built',
    clean: 'Cleaned',
    create: 'Created',
    decide: 'Decided',
    design: 'Designed',
    document: 'Documented',
    find: 'Found',
    fix: 'Fixed',
    heal: 'Healed',
    ignore: 'Ignored',
    infer: 'Inferred',
    keep: 'Kept',
    make: 'Made',
    number: 'Numbered',
    prune: 'Pruned',
    reconcile: 'Reconciled',
    refresh: 'Refreshed',
    render: 'Rendered',
    repair: 'Repaired',
    replace: 'Replaced',
    respect: 'Respected',
    route: 'Routed',
    run: 'Ran',
    ship: 'Shipped',
    show: 'Showed',
    stop: 'Stopped',
    summarize: 'Summarized',
    suppress: 'Suppressed',
    trim: 'Trimmed',
    update: 'Updated',
    use: 'Used',
    validate: 'Validated',
    wire: 'Wired',
  }[firstLower];
  if (past && rest) return resultSentence(past, rest);
  return resultSentence('Completed:', text);
}

function proofToReasonText(proof) {
  const text = String(proof || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const label = /\b(?:Product proof|Why it matters)\s*:\s*/i.exec(text);
  if (!label) return '';
  const rest = text.slice(label.index + label[0].length);
  const stop = rest.search(/(?:^|[.;]\s+)\b(?:Checks?|Mission receipt|Receipt|Landing|Changed|How I checked|What I tested|Saved|Decision)\s*:/i);
  let section = (stop >= 0 ? rest.slice(0, stop) : rest)
    .replace(/^(?:[-:]\s*)+/, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*[;,:-]\s*$/, '')
    .trim();
  const sentenceStop = section.search(/[.!?]\s+/);
  if (sentenceStop >= 0) section = section.slice(0, sentenceStop + 1).trim();
  if (!section) return '';
  return /[.!?]$/.test(section) ? section : `${section}.`;
}

// A landing sentence written for --result already carries its own why
// ("..., so operators keep deciding instead of waiting"). Reuse that clause
// as the reason instead of inventing one; with no clause, stay silent.
// landingWhyClause lives in lib/voice-gate.js so every human-bound landing
// composer (task reviews, mission receipts) shares the same why extraction.

function proofToHumanCheck(proof) {
  const text = String(proof || '').replace(/\s+/g, ' ').trim();
  if (!text) return 'Proof is attached below.';
  const lower = text.toLowerCase();
  const passSignal = /\b(?:pass(?:es|ed|ing)?|ok|green|succeeded|verified)\b/.test(lower);
  const verifierCommandSignal = /\b(?:npm|node|git|atris|npx|pnpm|yarn|python3?|pytest|bash|sh|tsc|vitest|curl|gh|rg)\s+\S+/.test(lower);
  if (/\b(?:atris\s+)?task\s+(?:show|page)\b/.test(lower) && /\b(?:print|prints|printed|render|renders|rendered|show|shows|showed)\b/.test(lower)) {
    return 'I opened the real task screen and checked the receipt renders before raw proof.';
  }
  if (/git\s+diff\s+--check/.test(lower) && passSignal) {
    if (/node\s+--test/.test(lower)) return 'I ran the behavior check and the diff cleanliness check.';
    return 'I ran the diff cleanliness check.';
  }
  if (/\btypecheck\b/.test(lower) && passSignal) return 'I ran the typecheck.';
  if (/\bbuild\b/.test(lower) && passSignal) return 'I ran the build check.';
  if (/\btest\b/.test(lower) && passSignal) return 'I ran the verifier named in the proof.';
  if (/\bvalidat(?:e|ion|ed)\b/.test(lower) && passSignal) return 'I ran the validation check.';
  if (verifierCommandSignal && /\b(?:print|prints|printed|show|shows|showed|report|reports|reported|return|returns|returned)\b/.test(lower)) {
    return 'I checked the verifier output named in the proof.';
  }
  if (verifierCommandSignal && passSignal) return 'I ran the verifier named in the proof.';
  if (/atris\/runs\/[^\s),.;:]+\.json/.test(text)) {
    return passSignal
      ? 'I inspected the passing receipt named in the proof.'
      : 'I inspected the receipt named in the proof.';
  }
  if (/(?:^|\s)(?:\.{0,2}\/)?scripts\/[^\s),.;:]+\.(?:js|mjs|cjs|py|sh)\b/.test(text)) {
    return 'I inspected the verifier artifact named in the proof.';
  }
  if (/\breview(?:ed)?\b/.test(lower)) return 'Review proof is attached below.';
  return 'Proof is attached below.';
}

function taskReviewFormatCommandList(commands) {
  const list = Array.isArray(commands)
    ? commands.map(command => String(command || '').trim()).filter(Boolean)
    : [];
  if (!list.length) return '';
  if (list.length > 1) {
    return list.map((command, index) => `command ${index + 1}: ${command}`).join('; ');
  }
  return list[0];
}

function taskReviewProseCheckLabels(proof) {
  const text = String(proof || '').replace(/\s+/g, ' ').trim();
  if (!text) return [];
  const lower = text.toLowerCase();
  const hasPass = /\b(?:pass(?:es|ed|ing)?|green|verified|current|clean|complete|completed)\b/.test(lower);
  if (!hasPass) return [];
  const labels = [];
  const add = label => {
    if (!labels.includes(label)) labels.push(label);
  };
  if (/\bhelp output\b/.test(lower)) add('help output');
  if (/\b(?:wiki verify|public wiki verify|loop wiki)\b/.test(lower)) add('wiki verification');
  if (/\bclean dry-run\b/.test(lower)) add('clean dry-run');
  if (/\b(?:test slice|regression run|tests?|test)\b.*\bpass(?:es|ed|ing)?\b/.test(lower)
    || /\bpass(?:es|ed|ing)?\b.*\b(?:test slice|regression run|tests?|test)\b/.test(lower)) {
    add('passing tests');
  }
  if (/\bverifier\b.*\bpass(?:es|ed|ing)?\b/.test(lower)
    || /\bpass(?:es|ed|ing)?\b.*\bverifier\b/.test(lower)) {
    add('passing verifier');
  }
  if (/\bmission\b.*\bcomplete(?:d)?\b/.test(lower)) add('completed mission');
  if (/\bgit diff --check\b/.test(lower) || /\bdiff cleanliness\b/.test(lower)) add('diff cleanliness');
  return labels;
}

function taskReviewLandingTested(proof) {
  const maxVisible = 3;
  const commands = taskReviewEvidenceCommands(proof, 20);
  if (commands.length) {
    return commands.length === 1
      ? 'I ran the listed check for this result.'
      : 'I ran the listed checks for this result.';
  }
  const paths = taskReviewEvidencePaths(proof, 20);
  if (paths.length) {
    return paths.length === 1
      ? 'I inspected the artifact named in the proof.'
      : `I inspected ${paths.length} artifacts named in the proof.`;
  }
  const proseChecks = taskReviewProseCheckLabels(proof);
  if (proseChecks.length) {
    const visible = proseChecks.slice(0, maxVisible);
    const omitted = proseChecks.length - visible.length;
    const suffix = omitted > 0 ? `, and ${omitted} more ${omitted === 1 ? 'check' : 'checks'}` : '';
    return `I checked: ${visible.join(', ')}${suffix}.`;
  }
  return String(proof || '').trim() ? 'I attached the proof below.' : 'No verifier command recorded yet.';
}

function landingPayloadValue(payload, metadata, key) {
  const landing = payload && payload.landing && typeof payload.landing === 'object' ? payload.landing : {};
  return landing[key]
    || payload && payload[`landing_${key}`]
    || metadata[`landing_${key}`]
    || null;
}

function taskReviewLanding(task, review = {}, payload = {}) {
  const metadata = task.metadata || {};
  const proof = review.proof || payload.proof || metadata.latest_agent_proof || '';
  const agentCertified = review.agent_certified === true || metadata.agent_certified === true;
  const approvalStatus = review.approval_status || metadata.approval_status || null;
  const explicitHappened = landingPayloadValue(payload, metadata, 'happened')
    || payload.result || metadata.result || payload.changed || metadata.result_changed || metadata.human_changed || metadata.changed;
  const explicitChecked = landingPayloadValue(payload, metadata, 'checked')
    || payload.checked || metadata.result_checked || metadata.human_checked || metadata.checked;
  const explicitTested = landingPayloadValue(payload, metadata, 'tested');
  const explicitDecision = landingPayloadValue(payload, metadata, 'decision');
  const explicitReasonRaw = landingPayloadValue(payload, metadata, 'reason')
    || landingPayloadValue(payload, metadata, 'why')
    || payload.reason || payload.why || metadata.result_reason || metadata.review_reason || metadata.why_it_matters;
  const explicitReason = explicitReasonRaw && !isRetiredFillerReason(explicitReasonRaw) ? explicitReasonRaw : null;
  const missionLift = explicitHappened
    ? null
    : missionReceiptResultForProof(task, proof, task.workspace_root || process.cwd());
  let happened = clipStatusText(explicitHappened || (missionLift && missionLift.changed) || titleToResultText(task.title), 220);
  let reason = clipStatusText(explicitReason || proofToReasonText(proof) || (missionLift && missionLift.reason) || '', 220);
  if (!reason) {
    const clause = landingWhyClause(happened);
    if (clause) {
      happened = clipStatusText(clause.change, 220);
      reason = clipStatusText(clause.why, 220);
    }
  }
  return {
    happened,
    reason,
    checked: clipStatusText(explicitChecked || proofToHumanCheck(proof), 220),
    tested: clipStatusText(explicitTested || taskReviewLandingTested(proof), 260),
    decision: clipStatusText(explicitDecision || (task.status === 'done'
      ? 'Done. No action needed unless this regresses.'
      : approvalStatus === 'revise'
        ? 'Rework requested. Fix the note, then send a new receipt.'
        : approvalStatus === 'pending' && !agentCertified
          ? 'Needs one more check; ask for rework if the receipt misses the point.'
          : 'Approve if this matches the request; ask for rework if not.'), 220),
  };
}

function taskReviewResult(task, review = {}, payload = {}) {
  const metadata = task.metadata || {};
  const ref = taskRef(task);
  const landing = taskReviewLanding(task, review, payload);
  const explicitSaved = payload.saved || metadata.result_saved || metadata.human_saved || metadata.saved;
  return {
    changed: landing.happened,
    reason: landing.reason,
    checked: landing.checked,
    saved: clipStatusText(explicitSaved || taskReviewSavedText(task, review, ref), 180),
    accept: landing.decision,
  };
}

function taskReviewSavedText(task, review = {}, ref = taskRef(task)) {
  if (task.status === 'done') return `Result accepted as ${ref}.`;
  const metadata = task.metadata || {};
  const agentCertified = review.agent_certified === true || metadata.agent_certified === true;
  if (task.status === 'review' && agentCertified) return `Result is ready for human approval as ${ref}.`;
  if (task.status === 'review') return `Completed result saved for review as ${ref}.`;
  return `Work record saved as ${ref}.`;
}

function cleanReviewProofText(value) {
  const text = String(value || '').trim();
  return text || null;
}

function reviewMessageLooksLikeProof(value) {
  const text = cleanReviewProofText(value);
  return Boolean(text && /\b(?:proof|verified|verifier|passed|receipt|git diff --check|node --test|npm test|pnpm test|yarn test|pytest|typecheck)\b/i.test(text));
}

function taskReviewEventProof(task) {
  const events = Array.isArray(task.events) ? task.events : [];
  for (const event of events.slice().reverse()) {
    const payload = event && event.payload && typeof event.payload === 'object' ? event.payload : {};
    const explicit = cleanReviewProofText(payload.proof || payload.verify);
    if (explicit) return explicit;
    const message = cleanReviewProofText(payload.content || payload.chat_packet || payload.stage_packet);
    if (message && reviewMessageLooksLikeProof(message)) return message;
  }
  const messages = Array.isArray(task.messages) ? task.messages : [];
  for (const message of messages.slice().reverse()) {
    const content = cleanReviewProofText(message && message.content);
    if (content && reviewMessageLooksLikeProof(content)) return content;
  }
  return null;
}

function taskReviewProofFallback(task, payload = {}) {
  if (!task || task.status !== 'review') return null;
  const metadata = task.metadata || {};
  return cleanReviewProofText(metadata.latest_agent_proof)
    || cleanReviewProofText(payload.proof)
    || cleanReviewProofText(metadata.proof)
    || cleanReviewProofText(metadata.verify)
    || cleanReviewProofText(metadata.latest_agent_verify)
    || cleanReviewProofText(payload.verify)
    || taskReviewEventProof(task);
}

function reviewReceiptPath(proofText, root) {
  const evidence = extractReceiptEvidence(proofText, root);
  if (!evidence) return null;
  return evidence.receipts?.[0]?.path || evidence.missing?.[0] || null;
}

function withReviewReceiptPath(review, root) {
  if (!review) return null;
  return {
    ...review,
    receipt_path: reviewReceiptPath(review.proof, root),
  };
}

function taskReviewSummary(task) {
  const reviewed = (task.events || []).slice().reverse().find(e => e.event_type === 'reviewed' || e.event_type === 'proof_ready' || e.event_type === 'revision_requested');
  const payload = reviewed && reviewed.payload || {};
  const metadata = task.metadata || {};
  const fallbackProof = taskReviewProofFallback(task, payload);
  if (!reviewed && !metadata.approval_status && !metadata.agent_review_pass_count && !metadata.human_revision_count && !metadata.agent_certified && !fallbackProof) return null;
  if (reviewed && reviewed.event_type === 'revision_requested') {
    const review = {
      summary: reviewSummary(task, payload),
      reward: null,
      proof: null,
      lesson: null,
      next_task: null,
      approval_status: metadata.approval_status || payload.approval_status || 'revise',
      agent_review_pass_count: null,
      agent_certified: false,
      agent_certification_policy: null,
      human_revision_count: metadata.human_revision_count || payload.revision_count || null,
      human_revision_note: metadata.human_revision_note || payload.note || null,
    };
    review.landing = taskReviewLanding(task, review, payload);
    review.result = taskReviewResult(task, review, payload);
    return reviewSummaryWithVerificationChat(task, review);
  }
  const reviewPassCount = Number(metadata.agent_review_pass_count || payload.review_pass_count || 0);
  const agentCertified = metadata.agent_certified === true
    || payload.agent_certified === true
    || (reviewPassCount >= AGENT_CERTIFICATION_REVIEW_PASSES && reviewIntegrity.hasIndependentReview(task));
  const reviewedEventHas = (key) => reviewed && reviewed.event_type === 'reviewed'
    && Object.prototype.hasOwnProperty.call(payload, key);
  const clearedReviewFields = new Set(Array.isArray(payload.cleared_review_fields) ? payload.cleared_review_fields : []);
  const readyField = (key, metadataKey) => {
    if (task.status === 'review' && metadata.approval_status === 'pending' && metadata[metadataKey]) {
      return metadata[metadataKey];
    }
    if (reviewedEventHas(key)) {
      if (payload[key]) return payload[key];
      if (key === 'proof' || !clearedReviewFields.has(key)) return metadata[metadataKey] || null;
      return null;
    }
    return payload[key] || metadata[metadataKey] || null;
  };
  const review = {
    summary: reviewSummary(task, payload),
    reward: reviewed && reviewed.event_type === 'reviewed' && payload.reward !== undefined ? payload.reward : null,
    proof: readyField('proof', 'latest_agent_proof') || fallbackProof,
    lesson: readyField('lesson', 'latest_agent_lesson'),
    next_task: readyField('next_task', 'latest_agent_next_task'),
    approval_status: metadata.approval_status || (task.status === 'review' ? 'pending' : null),
    agent_review_pass_count: reviewPassCount || null,
    agent_certified: agentCertified,
    agent_certification_policy: metadata.agent_certification_policy
      || payload.agent_certification_policy
      || (agentCertified ? `${AGENT_CERTIFICATION_REVIEW_PASSES}_agent_review_passes` : null),
    human_revision_count: metadata.human_revision_count || null,
  };
  review.landing = taskReviewLanding(task, review, payload);
  review.result = taskReviewResult(task, review, payload);
  return reviewSummaryWithVerificationChat(task, review);
}

function taskReviewInspectMetadata(task) {
  const review = task.review || taskReviewSummary(task);
  if (!review) return null;
  return {
    approval_status: review.approval_status || null,
    agent_certified: review.agent_certified === true,
    agent_review_pass_count: review.agent_review_pass_count || null,
    agent_certification_policy: review.agent_certification_policy || null,
    summary: review.summary || null,
    proof: review.proof || null,
    lesson: review.lesson || null,
    next_task: review.next_task || null,
    human_revision_count: review.human_revision_count || null,
    human_revision_note: review.human_revision_note || null,
    reward: review.reward ?? null,
    receipt_path: review.receipt_path || null,
  };
}

function taskInspectFieldValues(task, fields) {
  const values = {};
  for (const field of fields) {
    switch (field) {
      case 'status':
        values.status = task.status || null;
        break;
      case 'title':
        values.title = task.title || null;
        break;
      case 'claimed_by':
        values.claimed_by = task.claimed_by || null;
        break;
      case 'tag':
        values.tag = task.tag || null;
        break;
      case 'review':
        values.review = taskReviewInspectMetadata(task);
        break;
      default:
        break;
    }
  }
  return values;
}

function reviewSummaryWithVerificationChat(task, review) {
  if (!review || task.status !== 'review' || review.approval_status !== 'pending') return review;
  const verifierTask = taskWithReviewEvidence(task, {
    proof: review.proof,
    lesson: review.lesson,
    nextTask: review.next_task,
  });
  const reviewChat = taskReviewChatHandoff(verifierTask);
  return reviewChat ? { ...review, verification_chat: reviewChat } : review;
}

function reviewLandingForDisplay(review) {
  if (!review) return null;
  if (review.landing) return review.landing;
  if (!review.result) return null;
  return {
    happened: review.result.changed || null,
    reason: review.result.reason || null,
    checked: review.result.checked || null,
    tested: review.proof ? taskReviewLandingTested(review.proof) : null,
    decision: review.result.accept || null,
  };
}

function printReviewLanding(review) {
  const landing = reviewLandingForDisplay(review);
  if (!landing) return false;
  console.log('Result:');
  if (landing.happened) console.log(`  What happened: ${landing.happened}`);
  if (landing.reason) console.log(`  Why it matters: ${landing.reason}`);
  if (landing.checked) console.log(`  How I checked: ${landing.checked}`);
  if (landing.tested) console.log(`  What I tested: ${landing.tested}`);
  if (review.result && review.result.saved) console.log(`  Saved: ${review.result.saved}`);
  if (landing.decision) console.log(`  Decision: ${landing.decision}`);
  return true;
}

function latestTaskEvent(task) {
  const events = task.events || [];
  return events.length ? events[events.length - 1] : null;
}

function verifiedProofCommand(proof) {
  const match = String(proof || '').match(/\[verified\]\s+`([^`]+)`\s+passed\s+\(exit 0\)/i);
  return match ? String(match[1] || '').trim() : '';
}

function autoCertifyCommandCandidatesForTask(task) {
  const metadata = task && task.metadata || {};
  const review = task && task.review || {};
  const proof = String(review.proof || metadata.latest_agent_proof || '');
  const candidates = [
    metadata.verify,
    metadata.latest_agent_verify,
    verifiedProofCommand(review.proof),
    verifiedProofCommand(metadata.latest_agent_proof),
    ...taskReviewEvidenceCommands(proof),
  ].map(value => String(value || '').trim()).filter(Boolean);
  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = candidate.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function reviewBlockerForTask(task) {
  const ref = taskRef(task);
  const candidates = autoCertifyCommandCandidatesForTask(task);
  const safe = candidates.find(command => isAutoCertifyVerifyCommandAllowed(command));
  const unsafe = candidates.find(command => !isAutoCertifyVerifyCommandAllowed(command));
  const reason = !safe && unsafe ? 'verify_command_not_allowed' : 'needs_second_actor_review';
  return {
    reason,
    verify_command: (!safe && unsafe) ? unsafe : (safe || candidates[0] || null),
    next_command: `atris task review-chat ${ref} --as codex-review`,
  };
}

function reviewHandoffForTask(task, { suppressExistingFollowUp = false, hasExistingReviewFollowUp = null } = {}) {
  const review = task && task.review || {};
  if (task && task.status !== 'review') return null;
  if (review.approval_status !== 'pending') return null;
  const agentCertified = review.agent_certified === true;
  const nextTask = reviewNextTaskTitle(task);
  const hasExistingFollowUp = Boolean(suppressExistingFollowUp && taskHasReviewFollowUpChild(task, { hasExistingReviewFollowUp }));
  const proofBoundary = agentCertified ? proofBoundaryBlockedEvaluation(task) : null;
  const nextAction = agentCertified
    ? (proofBoundary ? PROOF_BOUNDARY_BLOCKED_ACTION : certifiedReviewNextAction(hasExistingFollowUp ? '' : nextTask))
    : 'agent_review_again';
  const handoff = {
    native_goal_status: agentCertified ? 'agent_certified' : 'needs_second_agent_review',
    career_xp_status: proofBoundary ? 'blocked_proof_boundary' : 'pending_human_accept',
    next_action: nextAction,
  };
  if (proofBoundary) {
    handoff.reason = proofBoundary.reason;
    handoff.next_action_detail = proofBoundary.next_action || null;
    const note = proofBoundary.reason === MISSION_XP_END_TO_END_REASON
      ? '<attach zero-papercut end-to-end fresh-laptop receipt or move back to Do>'
      : '<replace stale PR proof with merged proof or move back to Do>';
    handoff.revise_command = `atris task revise ${taskRef(task)} --note "${note}"`;
  } else if (!agentCertified) {
    const blocker = reviewBlockerForTask(task);
    handoff.reason = blocker.reason;
    handoff.next_action_detail = blocker.verify_command || null;
    handoff.review_chat_command = blocker.next_command;
  } else if (agentCertified && nextTask && !hasExistingFollowUp) {
    handoff.next_task = nextTask;
    handoff.continue_work_command = continueWorkCommandForTask(task);
  } else if (agentCertified && nextTask && hasExistingFollowUp) {
    handoff.next_task = nextTask;
    handoff.existing_follow_up_child = true;
  }
  return handoff;
}

function reviewActor(value) {
  const actor = String(value || 'codex-review').trim().replace(/[^a-zA-Z0-9:_-]/g, '-');
  return actor || 'codex-review';
}

function taskReviewClip(value, max = 500) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, Math.max(0, max - 3)).trim()}...` : text;
}

function taskReviewFullEvidence(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function taskReviewEvidencePaths(text, limit = 8) {
  const source = String(text || '');
  const matches = source.match(/(?:\.{0,2}\/|~\/|\/)?[\w@.+-]+(?:\/[\w@.+-]+)+(?:\.[A-Za-z0-9]+)?|[\w@.+-]+\.(?:js|mjs|cjs|ts|tsx|jsx|json|md|py|sh|yml|yaml|toml|lock|txt)/g) || [];
  const out = [];
  const seen = new Set();
  for (const raw of matches) {
    const clean = raw.replace(/[),.;:]+$/g, '');
    const basename = clean.split('/').pop() || clean;
    const hasPathPrefix = /^(?:\.{1,2}\/|~\/|\/)/.test(clean);
    const hasFileExtension = /\.[A-Za-z0-9]+$/.test(basename);
    if (!hasPathPrefix && !hasFileExtension) continue;
    if (!clean || clean.includes('://') || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
    if (out.length >= limit) break;
  }
  return out;
}

function taskReviewCommandLooksSpecific(command) {
  const text = String(command || '').trim();
  if (!text) return false;
  if (/^(?:npm|node|git|atris|npx|pnpm|yarn|python3?|pytest|bash|sh|tsc|vitest|curl|gh|rg)$/i.test(text)) return false;
  if (/^atris\s+task\s+\w+\s*$/i.test(text)) return false;
  if (/^atris\s+task\s+(?:accept|auto-accept-certified)\b/i.test(text)) return false;
  if (/^atris[/.]/i.test(text)) return false;
  if (/^atris-\S+/i.test(text)) return false;
  if (/^atris\s+task\s+\w+\s+json\s*$/i.test(text) && !/--json\b/i.test(text)) return false;
  if (/^atris\s+(?:command|review-chat|smoke|temp)\b/i.test(text)) return false;
  if (/^(?:npm|npx|pnpm|yarn|python3?|pytest|bash|sh|tsc|vitest|curl|gh|rg|git)\s+commands?\b/i.test(text)) return false;
  if (/^(?:npm|pnpm|yarn)\s+(?:tests|checks?)$/i.test(text)) return false;
  if (/^(?:git|gh|rg|curl|bash|sh|tsc)\s+(?:tests?|checks?)$/i.test(text)) return false;
  if (/\s+(?:and|then)\s+\S+/i.test(taskReviewWithoutQuotedSegments(text))) return false;
  if (/^node\s+(?!-|\S*(?:[/.]))/i.test(text)) return false;
  if (/^node\s+--test\s+[\w-]+(?:\s+[\w-]+)+$/i.test(text)) return false;
  return true;
}

function taskReviewUnescapedQuoteCount(text, quote) {
  let count = 0;
  const source = String(text || '');
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === quote && source[index - 1] !== '\\') count += 1;
  }
  return count;
}

function taskReviewCommandStartsInsideQuote(clause, commandIndex) {
  const before = String(clause || '').slice(0, Math.max(0, commandIndex));
  return taskReviewUnescapedQuoteCount(before, "'") % 2 === 1
    || taskReviewUnescapedQuoteCount(before, '"') % 2 === 1;
}

function taskReviewWithoutQuotedSegments(text) {
  const source = String(text || '');
  let quote = null;
  let out = '';
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if ((char === "'" || char === '"') && source[index - 1] !== '\\') {
      quote = quote === char ? null : (!quote ? char : quote);
      out += ' ';
      continue;
    }
    out += quote ? ' ' : char;
  }
  return out;
}

function taskReviewTrimOutsideQuotedTail(text, pattern) {
  const source = String(text || '');
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const scanner = new RegExp(pattern.source, flags);
  let match;
  while ((match = scanner.exec(source)) !== null) {
    if (!taskReviewCommandStartsInsideQuote(source, match.index)) {
      return source.slice(0, match.index);
    }
    if (match[0] === '') scanner.lastIndex += 1;
  }
  return source;
}

function taskReviewTrimTrailingOutsideQuote(text) {
  let clean = String(text || '');
  while (clean.length > 0) {
    const index = clean.length - 1;
    if (!/[\]),.;:]/.test(clean[index])) break;
    if (taskReviewCommandStartsInsideQuote(clean, index)) break;
    clean = clean.slice(0, index);
  }
  return clean;
}

function taskReviewCleanEvidenceCommand(command) {
  let clean = String(command || '');
  const tailPatterns = [
    /\s+from\s+[^,;]*(?:showed|shows|showing|returned|returns|printed|prints|wrote|writes|reported|reports)\b.*$/i,
    /\s+(?:showed|shows|showing|returned|returns|printed|prints|wrote|writes|reported|reports)\b.*$/i,
    /\.\s+(?:Reward remains|No human|Human accept|AgentXP|XP)\b.*$/i,
    /\s+with\s+\d+\s+(?:passing\s+)?(?:tests?|checks?|passes|passed|pass|ok|clean)\b.*$/i,
    /\s+\((?:passed|ok|clean|failed|errored|timed out|succeeded|succeeds|successful|confirmed)\)$/i,
    /\s+\(?(?:exit|status|code)\s+\d+\)?$/i,
    /\s+\(?(?:passed|ok|clean|failed|errored|timed out|succeeded|succeeds|successful|confirmed)\s+\d+\/\d+(?:[,.]\s+.*)?$/i,
    /\s+\(?(?:passed|ok|clean|failed|errored|timed out|succeeded|succeeds|successful|confirmed)\s+\d+\/\d+(?:\s+(?:tests?|checks?|passed|pass|ok|clean|failed|failures?))?$/i,
    /\s+\(?(?:passed|ok|clean|failed|errored|timed out|succeeded|succeeds|successful|confirmed)(?:[,.]\s+.*|\s+and\b.*)$/i,
    /\s+\(?(?:passed|ok|clean|failed|errored|timed out|succeeded|succeeds|successful|confirmed)\s+with\b.*$/i,
    /,\s+(?:command suite|mission-status tests?|live\b|focused suite|clean dry-run|brain compile)\b.*$/i,
    /\.\s+(?:The|This|It|Focused|Dogfood|Landing|Product|Review|Receipt|Human|No|Note)\b.*$/i,
    /\s+\(?\d+\s+(?:passes|passed|pass|ok|clean|tests?|checks?)\)?$/i,
    /\s+only$/i,
    /\s+\(?(?:passed|ok|clean|failed|errored|timed out|succeeded|succeeds|successful|confirmed)(?:[.:]\s+.*|\s+after\b.*)$/i,
    /\s+\(?(?:passed|ok|clean|failed|errored|timed out|succeeded|succeeds|successful|confirmed)\)?$/i,
    /\s+\(?\d+\/\d+(?:\s+(?:tests?|checks?|passed|pass|ok|clean|failed|failures?))?\)?$/i,
    /\s+\d+\/\d+(?:\s+(?:tests?|checks?|passed|pass|ok|clean|failed|failures?))?$/i,
    /\s+(?:passed|exited\s+0)(?:\s*\(\s*exit\s+0\s*\))?(?:\.(?:\s.*)?)?$/i,
  ];
  for (const pattern of tailPatterns) {
    clean = taskReviewTrimOutsideQuotedTail(clean, pattern);
    clean = taskReviewTrimTrailingOutsideQuote(clean);
  }
  return clean.replace(/\s+/g, ' ').trim();
}

function taskReviewSplitEvidenceClauses(source, commandStart) {
  const text = String(source || '');
  const hardBoundaryPattern = /^(?:;\s*|\n\s*|\s+&&\s+)/;
  const softBoundaryPattern = new RegExp(`^(?:,\\s+|\\.\\s+|\\s+and\\s+|\\s+then\\s+|\\.\\s+(?:focused|full|behavior|verifier)[^\\n.;:]{0,80}:\\s+)(?=${commandStart})`, 'i');
  const clauses = [];
  let clause = '';
  let quote = null;
  for (let index = 0; index < text.length;) {
    const char = text[index];
    if ((char === "'" || char === '"') && text[index - 1] !== '\\') {
      if (quote === char) quote = null;
      else if (!quote) quote = char;
      clause += char;
      index += 1;
      continue;
    }
    if (!quote) {
      const rest = text.slice(index);
      const boundary = rest.match(hardBoundaryPattern) || rest.match(softBoundaryPattern);
      if (boundary) {
        if (clause.trim()) clauses.push(clause);
        clause = '';
        index += boundary[0].length;
        continue;
      }
    }
    clause += char;
    index += 1;
  }
  if (clause.trim()) clauses.push(clause);
  return clauses;
}

function taskReviewCommandIsDescribedSubject(clause, commandIndex) {
  const before = String(clause || '').slice(Math.max(0, commandIndex - 80), commandIndex);
  return /\b(?:contains?|displays?|extracts?|lists?|mentions?|names?|prints?|renders?|shows?)\s+(?:only\s+)?$/i.test(before)
    || /\b(?:including|includes?|like|such as|for example|e\.g\.)\s+$/i.test(before);
}

function taskReviewEvidenceCommands(text, limit = 8) {
  const source = String(text || '').trim();
  if (!source) return [];
  const commandWord = '(?:npm|node|git|atris|npx|pnpm|yarn|python3?|pytest|bash|sh|tsc|vitest|curl|gh|rg|test(?=\\s+-[sf]\\b))';
  const envPrefix = '(?:(?:[A-Z_][A-Z0-9_]*=[^\\s,;|]+)\\s+)*';
  const prosePrefix = '(?:(?:rechecked|reran|re-run|run|verified|validated|passed|validation(?:\\s+passed)?|verification(?:\\s+passed)?|focused|live|scoped|installed|direct|full|current|fresh|then|and|commands?|checks?)[:\\s]+)*';
  const commandStart = `${prosePrefix}${envPrefix}${commandWord}\\b`;
  const commandStartPattern = new RegExp(`(^|[^\\w./=-])(${commandStart})`, 'i');
  const commandStartInnerPattern = new RegExp(`${envPrefix}${commandWord}\\b`, 'i');
  const normalized = source
    .replace(/\r/g, '\n')
    .replace(/```[ \t]*(?:bash|sh|shell|zsh|console|text|txt)?[ \t]*\n/gi, '\n')
    .replace(/```/g, '\n')
    .replace(/`/g, '');
  const clauses = taskReviewSplitEvidenceClauses(normalized, commandStart);
  const out = [];
  const seen = new Set();
  for (const clause of clauses) {
    const start = clause.match(commandStartPattern);
    if (!start || start.index == null) continue;
    const commandStartOffset = start[0].indexOf(start[2]);
    const raw = clause.slice(start.index + Math.max(0, commandStartOffset));
    const prefix = raw.match(commandStartInnerPattern);
    const commandOffset = prefix && prefix.index != null ? prefix.index : 0;
    const commandIndex = start.index + Math.max(0, commandStartOffset) + Math.max(0, commandOffset);
    if (
      taskReviewCommandStartsInsideQuote(clause, commandIndex)
      || taskReviewCommandIsDescribedSubject(clause, commandIndex)
    ) continue;
    const command = raw.slice(Math.max(0, commandOffset));
    const clean = taskReviewCleanEvidenceCommand(command);
    if (!taskReviewCommandLooksSpecific(clean) || seen.has(clean.toLowerCase())) continue;
    seen.add(clean.toLowerCase());
    out.push(clean);
    if (out.length >= limit) break;
  }
  return out;
}

function taskReviewRecentThread(task, limit = 4) {
  return (task && Array.isArray(task.messages) ? task.messages : [])
    .slice(-limit)
    .map(message => ({
      version: message.version || null,
      actor: message.actor || null,
      content: taskReviewClip(message.content, 220),
    }))
    .filter(message => message.content);
}

function taskReviewObjective(task) {
  const metadata = task && task.metadata || {};
  return task && (
    metadata.task_goal
    || task.title
    || metadata.goal_objective
    || metadata.objective
    || task.objective
  ) || '';
}

function taskReviewVerificationFocus(task) {
  const review = task && task.review || {};
  const metadata = task && task.metadata || {};
  const proof = review.proof || metadata.latest_agent_proof || '';
  const lesson = review.lesson || metadata.latest_agent_lesson || '';
  const nextTask = review.next_task || metadata.latest_agent_next_task || '';
  const objective = taskReviewObjective(task);
  const evidenceText = [proof].filter(Boolean).join('\n');
  return {
    objective: taskReviewClip(objective, 260) || null,
    proof_claim: taskReviewFullEvidence(proof) || null,
    commands_to_verify: taskReviewEvidenceCommands(evidenceText),
    files_to_inspect: taskReviewEvidencePaths(evidenceText),
    recent_thread: taskReviewRecentThread(task),
    decision_rule: 'Certify only if the current files, commands, receipts, and task thread prove the Review proof. Otherwise revise with the exact missing proof.',
  };
}

function taskReviewSpecificCodexPrompt(task, focus, actor) {
  const ref = taskRef(task);
  const title = taskReviewClip(task && task.title, 180);
  const proof = focus && focus.proof_claim ? ` Proof: ${taskReviewClip(focus.proof_claim, 1800)}` : '';
  const commands = focus && focus.commands_to_verify && focus.commands_to_verify.length
    ? ` Commands: ${taskReviewFormatCommandList(focus.commands_to_verify)}.`
    : '';
  const files = focus && focus.files_to_inspect && focus.files_to_inspect.length
    ? ` Files/artifacts: ${focus.files_to_inspect.join(', ')}.`
    : '';
  return `/codex review ${ref}: verify "${title}".${proof}${commands}${files} Inspect the task thread, then run ${`atris task review ${ref} --reward 0 --as ${actor} --proof "<specific verifier commands passed and diff/proof inspected>" --verify "<safe verifier command>"`} or revise with the exact missing proof. Do not accept XP.`;
}

function taskReviewChatHandoff(task, { reviewer = 'codex-review', allowCertified = false } = {}) {
  if (!task) return null;
  if (!taskAllowsReviewChat(task, { allowCertified })) return null;
  const ref = taskRef(task);
  const actor = reviewActor(reviewer);
  const verificationFocus = taskReviewVerificationFocus(task);
  const reviewHandoff = reviewHandoffForTask(task, { suppressExistingFollowUp: true });
  const humanAcceptCommand = reviewHandoff && reviewHandoff.next_action === PROOF_BOUNDARY_BLOCKED_ACTION
    ? null
    : `atris task accept ${ref}`;
  return {
    schema: 'atris.task_review_chat.v1',
    command: `atris task review-chat ${ref} --as ${actor}`,
    codex_prompt: taskReviewSpecificCodexPrompt(task, verificationFocus, actor),
    pass_command: `atris task review ${ref} --reward 0 --as ${actor} --proof "<specific verifier commands passed and diff/proof inspected>" --verify "<safe verifier command>"`,
    revise_command: `atris task revise ${ref} --as ${actor} --note "<specific missing proof or required change>"`,
    human_accept_command: humanAcceptCommand,
    verification_focus: {
      objective: verificationFocus.objective,
      proof_claim: verificationFocus.proof_claim,
      commands_to_verify: verificationFocus.commands_to_verify,
      files_to_inspect: verificationFocus.files_to_inspect,
      decision_rule: verificationFocus.decision_rule,
    },
  };
}

function taskWithReviewEvidence(task, { proof, lesson, nextTask } = {}) {
  if (!task) return task;
  const metadata = { ...(task.metadata || {}) };
  const review = { ...(task.review || {}) };
  if (proof !== undefined && proof !== null) {
    const text = String(proof);
    metadata.latest_agent_proof = text;
    review.proof = text;
  }
  if (lesson !== undefined && lesson !== null) {
    const text = String(lesson);
    metadata.latest_agent_lesson = text;
    review.lesson = text;
  }
  if (nextTask !== undefined && nextTask !== null) {
    const text = String(nextTask);
    metadata.latest_agent_next_task = text;
    review.next_task = text;
  }
  return {
    ...task,
    metadata,
    review,
  };
}

function taskWithAgentCertification(task, agentCertified) {
  if (!task || !agentCertified) return task;
  return {
    ...task,
    metadata: {
      ...(task.metadata || {}),
      agent_certified: true,
      agent_review_pass_count: Math.max(Number(task.metadata?.agent_review_pass_count || 0), AGENT_CERTIFICATION_REVIEW_PASSES),
      approval_status: task.metadata?.approval_status || 'pending',
    },
    review: {
      ...(task.review || {}),
      agent_certified: true,
      agent_review_pass_count: Math.max(Number(task.review?.agent_review_pass_count || 0), AGENT_CERTIFICATION_REVIEW_PASSES),
      approval_status: task.review?.approval_status || task.metadata?.approval_status || 'pending',
    },
  };
}

function taskReviewChatContract(task, { reviewer = 'codex-review', allowCertified = false } = {}) {
  const handoff = taskReviewChatHandoff(task, { reviewer, allowCertified });
  const review = task && task.review || {};
  const metadata = task && task.metadata || {};
  const proof = review.proof || metadata.latest_agent_proof || '';
  const lesson = review.lesson || metadata.latest_agent_lesson || '';
  const nextTask = review.next_task || metadata.latest_agent_next_task || '';
  const objective = taskReviewObjective(task);
  const verificationFocus = taskReviewVerificationFocus(task);
  const actor = reviewActor(reviewer);
  return {
    ...handoff,
    codex_prompt: taskReviewSpecificCodexPrompt(task, verificationFocus, actor),
    task: {
      id: task.id,
      ref: taskRef(task),
      title: task.title,
      status: task.status,
      objective: objective || null,
      claimed_by: task.claimed_by || null,
    },
    review: {
      approval_status: review.approval_status || metadata.approval_status || null,
      agent_review_pass_count: review.agent_review_pass_count || metadata.agent_review_pass_count || null,
      agent_certified: review.agent_certified === true || metadata.agent_certified === true,
      proof: proof || null,
      lesson: lesson || null,
      next_task: nextTask || null,
    },
    verification_focus: verificationFocus,
    required_checks: [
      `Run ${`atris task show ${taskRef(task)} --json`} and read the current proof plus dialogue.`,
      verificationFocus.commands_to_verify.length
        ? `Re-run or inspect these proof commands: ${taskReviewFormatCommandList(verificationFocus.commands_to_verify)}.`
        : 'Find the concrete verifier command because the proof did not name one.',
      verificationFocus.files_to_inspect.length
        ? `Inspect these named files/artifacts before certifying: ${verificationFocus.files_to_inspect.join(', ')}.`
        : 'Inspect the relevant diff/artifact boundary before certifying.',
      'Compare current task thread state against the proof claim; stale or unrelated proof must be revised.',
      'Use revise instead of review when proof is vague, stale, too narrow, or missing.',
      'Do not run task accept unless the human explicitly approves XP.',
    ],
  };
}

function taskReviewChatNote(contract) {
  const checks = (contract.required_checks || []).map((check, index) => `${index + 1}. ${check}`).join('\n');
  return [
    'TASK_REVIEW_CHAT',
    `task: ${contract.task.ref}`,
    `reviewer: ${reviewActor(contract.command.split('--as ')[1] || 'codex-review')}`,
    `pass: ${contract.pass_command}`,
    `revise: ${contract.revise_command}`,
    `human_accept_xp: ${contract.human_accept_command}`,
    '',
    `objective: ${contract.verification_focus.objective || 'unknown'}`,
    `proof_claim: ${contract.verification_focus.proof_claim || 'missing'}`,
    '',
    'commands_to_verify:',
    ...(contract.verification_focus.commands_to_verify.length
      ? contract.verification_focus.commands_to_verify.map(command => `- ${command}`)
      : ['- missing: find or request a concrete verifier command']),
    '',
    'files_to_inspect:',
    ...(contract.verification_focus.files_to_inspect.length
      ? contract.verification_focus.files_to_inspect.map(file => `- ${file}`)
      : ['- missing: inspect the relevant diff/artifact boundary']),
    '',
    'recent_thread:',
    ...(contract.verification_focus.recent_thread.length
      ? contract.verification_focus.recent_thread.map(message => `- v${message.version || '?'} ${message.actor || 'unknown'}: ${message.content}`)
      : ['- no recent task dialogue captured']),
    '',
    contract.codex_prompt,
    '',
    'checks:',
    checks,
  ].join('\n');
}

module.exports = {
  bindMain, reviewNextTaskTitle, rawReviewNextTaskTitle, reviewNextTaskTitleIsSpecific,
  normalizeReviewNextTaskInput, genericContinuationIssues, findExistingReviewNextTask,
  buildReviewFollowUpChildPredicate, taskEventOrderValue, eventIsTaskReviewChat,
  eventClearsPendingReviewChat, buildPendingReviewChatPredicate, createReviewNextTask,
  createNextTaskIfRequested, continueWorkCommandForTask, certifiedReviewNextAction,
  proofBoundaryBlockedEvaluation, handoffAllowsHumanAccept, handoffIsProofBoundaryBlocked,
  reviewSummary, titleToResultText, proofToReasonText, proofToHumanCheck,
  taskReviewFormatCommandList, taskReviewProseCheckLabels, taskReviewLandingTested,
  landingPayloadValue, taskReviewLanding, taskReviewResult, taskReviewSavedText,
  cleanReviewProofText, reviewMessageLooksLikeProof, taskReviewEventProof, taskReviewProofFallback,
  reviewReceiptPath, withReviewReceiptPath, taskReviewSummary, taskReviewInspectMetadata,
  taskInspectFieldValues, reviewSummaryWithVerificationChat, reviewLandingForDisplay,
  printReviewLanding, latestTaskEvent, verifiedProofCommand, autoCertifyCommandCandidatesForTask,
  reviewBlockerForTask, reviewHandoffForTask, reviewActor, taskReviewClip, taskReviewFullEvidence,
  taskReviewEvidencePaths, taskReviewCommandLooksSpecific, taskReviewUnescapedQuoteCount,
  taskReviewCommandStartsInsideQuote, taskReviewWithoutQuotedSegments,
  taskReviewTrimOutsideQuotedTail, taskReviewTrimTrailingOutsideQuote,
  taskReviewCleanEvidenceCommand, taskReviewSplitEvidenceClauses,
  taskReviewCommandIsDescribedSubject, taskReviewEvidenceCommands, taskReviewRecentThread,
  taskReviewObjective, taskReviewVerificationFocus, taskReviewSpecificCodexPrompt,
  taskReviewChatHandoff, taskWithReviewEvidence, taskWithAgentCertification, taskReviewChatContract,
  taskReviewChatNote,
};
