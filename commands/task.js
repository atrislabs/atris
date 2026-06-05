// `atris task` - SQLite-backed task state. TODO.md is a regenerated view;
// events are the durable trail that web/desktop/cloud projections can read.

'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const os = require('os');
const { taskProofState } = require('../lib/task-proof');
const { evaluateAutoAccept, parseVerifyCommand } = require('../lib/auto-accept-certified');

const DEFAULT_OWNER = process.env.ATRIS_AGENT_ID
  || process.env.USER
  || os.userInfo().username
  || 'unknown';
const AGENT_CERTIFICATION_REVIEW_PASSES = 2;
const REVIEW_LANE_LOOP_DEFAULT_MAX_STEPS = 3;
const REVIEW_LANE_LOOP_MAX_STEPS = 10;
const REVIEW_LANE_RUN_DEFAULT_MAX_RUNS = 3;
const REVIEW_LANE_RUN_MAX_RUNS = 20;
const PENDING_REVIEW_CHAT_STOP_REASON = 'pending_review_chat_waiting_for_agent_review';
const PROOF_BOUNDARY_BLOCKED_ACTION = 'proof_boundary_blocked';
const PROOF_BOUNDARY_BLOCKED_REASON = 'proof_boundary_blocked_requires_revision';

const STATUS_PLAN_TAGS = new Set([
  'agent',
  'autopilot',
  'cron',
  'endgame',
  'execute',
  'explore',
  'feature',
  'goal',
  'goal-step',
  'loop',
  'plan',
  'planned',
  'schedule',
  'scheduled',
  'shape',
  'shaping',
  'ui',
  'ux',
]);
const TASK_QUEUE_COLUMN_ORDER = ['do', 'review', 'plan', 'backlog', 'blocked', 'done'];
const TASK_QUEUE_COLUMN_LABELS = {
  backlog: 'Backlog',
  plan: 'Plan',
  do: 'Do',
  review: 'Review',
  blocked: 'Blocked',
  done: 'Done',
};
const TASK_REVIEW_STATE_LANES = ['needs-agent', 'continue-work', 'proof-boundary-blocked', 'human-accept-waiting', 'certified'];
const TASK_REVIEW_STATE_ALIASES = {
  'needs-agent': ['needs-review', 'agent-review'],
  'continue-work': ['continue', 'agent-actionable', 'executable'],
  'proof-boundary-blocked': ['proof-boundary', 'boundary-blocked', 'stale-pr-proof', 'unmerged-pr-proof'],
  'human-accept-waiting': ['human-accept', 'accept-waiting', 'waiting-accept', 'no-next-task'],
  certified: ['waiting-human', 'human-waiting'],
};

let taskDbModule = null;

function getTaskDb() {
  if (taskDbModule) return taskDbModule;
  try {
    taskDbModule = require('../lib/task-db');
    return taskDbModule;
  } catch (e) {
    const message = String(e && (e.message || e));
    const missingSqlite = e && (
      e.code === 'ERR_UNKNOWN_BUILTIN_MODULE'
      || /node:sqlite|No such built-in module/i.test(message)
    );
    if (missingSqlite) {
      console.error('atris task requires Node.js 22+ because it uses built-in node:sqlite.');
      console.error('Use the markdown TODO.md flow on older Node versions.');
      process.exit(1);
    }
    throw e;
  }
}

function taskUsageText() {
  return `
atris task - durable local task state (SQLite, gitignored)

  atris task                              Show the task desk
  atris task new "<title>"                Create a task
  atris task next                         Claim/show the next open task
  atris task continue-work <id>           Create/reuse a certified Review follow-up task
  atris task say <id> "<message>"         Add context to a task
  atris task chat <id> "<message>" [--goal "..."]  Refine a task chat + working goal
  atris task ready <id> --proof "..."      Agent proof ready; native goal can complete
  atris task review-chat <id> [--as <owner>]  Start a task-owned /codex verification chat
  atris task accept <id> [--proof "..."]   Human accepts proof, marks done
  atris task auto-accept-certified --dry-run [--strict-verify] [--limit <n>]
                                           Preview certified Review rows; live accept needs --confirm-human-accept --as <human>
  atris task revise <id> --note "..."      Send reviewed work back to Do

  atris task add "<title>" [--tag <tag>] [--goal-id <id>]  Create a task
  atris task delegate "<title>" --to <id> [--goal-id <id>]  Create an assigned task
  atris task plan <id> --goal "..." --exit "..." --proof-needed "..."
                                           Record a task-owned Plan stage
  atris task do <id> --as <owner> --first-move "..."
                                           Start task-owned Do work from the plan
  atris task backlog <id> [--reason "..."] Move a planned open task back to Backlog
  atris task clear-plan --yes              Move all planned open tasks back to Backlog
  atris task day [--json]                  Show today's owner-grouped task list
  atris task list [--all] [--status <s>]   List tasks (default: this workspace)
  atris task claim <id> [--as <owner>]     Atomic claim
  atris task capabilities [--json]         Read-only task CLI/API capability contract
  atris task capabilities-check [--json]   Verify task capability contract conformance
  atris task review-lane-drain [--json]    Pick next safe Review-lane agent action
  atris task review-lane-act [--json]      Execute next safe Review-lane agent action
  atris task review-lane-loop [--json]     Run bounded safe Review-lane actions
  atris task review-lane-run [--json]      Run bounded review-lane loops and write receipts
  atris task current [--json] [--goal-id <id>] [--tag <tag>] [--status <s>] [--review-state <lane>]
                                           Read-only best next task page + queue
  atris task queue [--json] [--goal-id <id>] [--tag <tag>] [--status <s>] [--review-state <lane>]
                                           Read-only task lanes + current page
  atris task current-step [--json] [--goal-id <id>] [--tag <tag>] [--review-state <lane>]
                                           Advance the scoped current task one safe step
                                           review-state lanes: needs-agent, continue-work, human-accept-waiting, certified
  atris task note <id> "<message>"         Append dialogue/context to a task
  atris task show <id> [--json]            Show a task card + dialogue
  atris task page <id> [--json]            Show the one-task page contract
  atris task step <id> [--json]            Refine chat, then advance one safe Plan/Do/Review step
  atris task done <id> --proof "..."       Mark complete with proof
  atris task done <id> --failed [--proof "..."]  Mark failed, optionally reviewed
  atris task finish <id> --proof "..."     Legacy alias for done with proof
  atris task review <id> --reward <n> [--verify "<cmd>"]
                                           Write review event + RSI episode
  atris task reviews [--limit <n>]         Show certified Review items for human accept/revise
  atris task status [--json] [--history]   Compact live status for web/Swarlo
  atris task setup [--import-todo]         Create/refresh task projection
  atris task serve [--port <n>]            Open local task factory board
  atris task sync --dry-run                Plan cloud/Swarlo task sync writes
  atris task import <file>                 One-shot import from TODO.md
  atris task events [id] [--limit <n>]     Print recent task events
  atris task events --all                  Print the full append-only ledger
  atris task export [--out <file>]         Write web/desktop JSON projection
  atris task render [--out <file>]         Regenerate compact TODO.md view from state
  atris task where                          Print db path + workspace scope
  atris task help                           This help

Confidence Gate:
  Before plan/do/review advances, find loopholes, patch them with proof,
  verifier, owner, rollback, or name the residual risk.

Env:
  ATRIS_TASKS_DB    Override db path (default ~/.atris/tasks.db)
  ATRIS_AGENT_ID    Owner id for claim/done (default: $USER)

Refs:
  Human views use semantic refs like OBL-18. Commands accept OBL-18,
  OBL18, full 26-char task IDs, and any unique legacy prefix. JSON/API
  keep the full id as canonical and also expose display_id + legacy_ref.

Headless:
  Add --json to task commands for machine-readable output and stable automation.
`.trim();
}

function taskUsageLines() {
  return taskUsageText().split('\n');
}

function help() {
  console.log(taskUsageText());
}

function flag(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return null;
  return args[i + 1] || true;
}

function hasFlag(args, name) {
  return args.indexOf(name) !== -1;
}

function hasEmptyFlagValue(args, name) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] === '';
}

function wantsJson(args) {
  return hasFlag(args, '--json');
}

function parseAcceptReward(value, { defaultValue = 1 } = {}) {
  if (value === undefined || value === null || value === true) return { ok: true, value: defaultValue };
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return { ok: false, reason: 'invalid_reward' };
  }
  return { ok: true, value: numeric };
}

function validHumanActorFlag(value) {
  if (typeof value !== 'string') return false;
  const actor = value.trim();
  return Boolean(actor) && !actor.startsWith('--') && actor !== 'auto-accept-certified';
}

function agentProofOnlyMode() {
  return process.env.ATRIS_AGENT_PROOF_ONLY === '1';
}

function failAgentProofOnly(label, detail) {
  failTask(
    label,
    'agent_proof_only_human_accept_blocked',
    detail || 'Agent proof-only mode can write notes, ready proof, and zero-reward reviews, but cannot mark tasks done or accept XP.',
  );
}

function printJson(value) {
  const buffer = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  const retryWait = new Int32Array(new SharedArrayBuffer(4));
  let offset = 0;
  while (offset < buffer.length) {
    try {
      offset += fs.writeSync(process.stdout.fd, buffer, offset, buffer.length - offset);
    } catch (err) {
      if (err && err.code === 'EAGAIN') {
        Atomics.wait(retryWait, 0, 0, 10);
        continue;
      }
      throw err;
    }
  }
}

function refreshCareerXpProjection(workspaceRoot) {
  if (!workspaceRoot) return null;
  try {
    const { collectLocalXpProjection } = require('../commands/xp');
    return collectLocalXpProjection(['--workspace', workspaceRoot]);
  } catch (error) {
    return {
      ok: false,
      error: error && error.message ? error.message : String(error),
    };
  }
}

function refreshCareerXpAfterReview(reviewed) {
  return refreshCareerXpProjection(reviewed?.episode?.workspace_root);
}

function jsonModeActive() {
  return process.argv.includes('--json');
}

function failTask(label, reason, detail, exitCode = 2) {
  if (jsonModeActive()) {
    console.log(JSON.stringify({
      ok: false,
      command: label,
      reason,
      detail: detail || null,
    }));
  } else {
    console.error(detail || `${label}: ${reason}`);
  }
  process.exit(exitCode);
}

function proofFlagValue(args) {
  const proof = flag(args, '--proof');
  return typeof proof === 'string' ? proof.trim() : '';
}

function textFlag(args, names) {
  for (const name of names) {
    const value = flag(args, name);
    if (typeof value === 'string') return value.trim();
  }
  return '';
}

function numericFlag(args, name) {
  const value = flag(args, name);
  if (value === null || value === true || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function meaningfulTaskProofIssue(proof, { required = true } = {}) {
  const text = String(proof || '').trim();
  if (!required && !text) return null;
  const state = taskProofState(text);
  return state.ok ? null : state.reason;
}

function requireMeaningfulTaskProof(label, proof, { required = true } = {}) {
  const issue = meaningfulTaskProofIssue(proof, { required });
  if (issue) failTask(label, 'weak_proof', `meaningful proof required: ${issue}`);
}

function sendProofIssue(res, proof, issue) {
  return sendJson(res, 400, {
    ok: false,
    reason: String(proof || '').trim() ? 'weak_proof' : 'proof_required',
    detail: `meaningful proof required: ${issue}`,
  });
}

function positional(args) {
  return args.filter((a, i) => {
    if (a.startsWith('--')) return false;
    if (i > 0 && args[i - 1].startsWith('--')) return false;
    return true;
  });
}

function writeDefaultProjection(taskDb, db, { all = false } = {}) {
  const projection = enrichTaskProjection(taskDb.taskProjection(db, {
    workspaceRoot: all ? null : taskDb.workspaceRoot(),
    limit: 500,
  }));
  const outPath = path.resolve(path.join('.atris', 'state', 'tasks.projection.json'));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(projection, null, 2) + '\n', 'utf8');
  return { projection, outPath };
}

function taskFromProjection(projection, id) {
  return projection.tasks.find(t => t.id === id) || null;
}

function taskRef(taskOrId) {
  if (!taskOrId) return 'TASK';
  if (typeof taskOrId === 'string') return taskOrId.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 8);
  return taskOrId.display_id || taskOrId.legacy_ref || taskRef(taskOrId.id);
}

function normalizeTaskLookupRef(value) {
  return String(value || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}

function taskLookupRefs(task) {
  if (!task) return [];
  return [task.id, task.display_id, task.legacy_ref, taskRef(task)]
    .map(normalizeTaskLookupRef)
    .filter(Boolean);
}

function resolveProjectionTaskRef(ref, taskByRef) {
  const key = normalizeTaskLookupRef(ref);
  return key ? taskByRef.get(key) || null : null;
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
  const currentMetadata = currentTask && currentTask.metadata && typeof currentTask.metadata === 'object'
    ? currentTask.metadata
    : {};
  const existing = findExistingReviewNextTask(taskDb, db, currentTask, nextTitle);
  if (existing) return { id: existing.id, inserted: false };
  const goalId = currentMetadata.goal_id || currentMetadata.goalId || null;
  const parentId = currentTask && currentTask.id || null;
  const sourceKey = parentId && typeof taskDb.sourceKey === 'function'
    ? taskDb.sourceKey(`task_review_next:${parentId}`, nextTitle)
    : null;
  try {
    return taskDb.addTask(db, {
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
  } catch (error) {
    if (sourceKey && /constraint|unique/i.test(String(error && (error.code || error.message) || error))) {
      const racedExisting = findExistingReviewNextTask(taskDb, db, currentTask, nextTitle);
      if (racedExisting) return { id: racedExisting.id, inserted: false };
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
  const evaluation = evaluateAutoAccept(task, { strictVerify: false, minPasses: 0 });
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

function readLocalBusinessBinding(root = process.cwd()) {
  const file = path.join(root, '.atris', 'business.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`Failed to read .atris/business.json: ${e.message || e}`);
  }
}

function extractGoalLines(text) {
  const goals = [];
  let inFrontmatter = false;
  let seenContent = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '---' && !seenContent) {
      inFrontmatter = !inFrontmatter;
      continue;
    }
    if (inFrontmatter) continue;
    if (!line) continue;
    seenContent = true;
    if (line.startsWith('#') || line.startsWith('---') || /^\|[-\s|]+\|$/.test(line)) continue;
    if (/^\|/.test(line)) {
      const cells = line.split('|').map(c => c.trim()).filter(Boolean);
      if (cells[0] && !/^goal$/i.test(cells[0])) goals.push(cells.slice(0, 3).join(' / '));
      continue;
    }
    goals.push(line.replace(/^[-*]\s+/, '').replace(/^\d+\.\s+/, ''));
  }
  return goals.filter(Boolean).slice(0, 8);
}

function readGoalSources(root = process.cwd()) {
  const candidates = [
    path.join(root, 'atris', 'goals.md'),
    path.join(root, 'goals.md'),
    path.join(root, 'atris', 'wiki', 'concepts', 'atris-labs-goals.md'),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const goals = extractGoalLines(fs.readFileSync(file, 'utf8'));
    if (goals.length) return { path: file, goals };
  }
  return { path: null, goals: [] };
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
      return `This is accepted AgentXP work: ${plainTitle} is done and has a proof receipt.`;
    }
    if (task.status === 'review') {
      return `This is AgentXP review: ${plainTitle} is agent-complete; accept only if the proof is real.`;
    }
    return `This explains what accepting ${plainTitle} would make real for AgentXP.`;
  }
  if (task.status === 'done') {
    return `This is the accepted outcome: ${plainTitle} is done and counted as real work.`;
  }
  if (task.status === 'review') {
    return `This is the human checkpoint: ${plainTitle} is agent-complete and needs acceptance before it counts as done.`;
  }
  return `This explains what accepting ${plainTitle} would make real.`;
}

function taskReviewSummary(task) {
  const reviewed = (task.events || []).slice().reverse().find(e => e.event_type === 'reviewed' || e.event_type === 'proof_ready' || e.event_type === 'revision_requested');
  const payload = reviewed && reviewed.payload || {};
  const metadata = task.metadata || {};
  if (!reviewed && !metadata.approval_status && !metadata.agent_review_pass_count && !metadata.human_revision_count && !metadata.agent_certified) return null;
  if (reviewed && reviewed.event_type === 'revision_requested') {
    return reviewSummaryWithVerificationChat(task, {
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
    });
  }
  const reviewPassCount = Number(metadata.agent_review_pass_count || payload.review_pass_count || 0);
  const agentCertified = metadata.agent_certified === true
    || payload.agent_certified === true
    || reviewPassCount >= AGENT_CERTIFICATION_REVIEW_PASSES;
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
  return reviewSummaryWithVerificationChat(task, {
    summary: reviewSummary(task, payload),
    reward: reviewed && reviewed.event_type === 'reviewed' && payload.reward !== undefined ? payload.reward : null,
    proof: readyField('proof', 'latest_agent_proof'),
    lesson: readyField('lesson', 'latest_agent_lesson'),
    next_task: readyField('next_task', 'latest_agent_next_task'),
    approval_status: metadata.approval_status || (task.status === 'review' ? 'pending' : null),
    agent_review_pass_count: reviewPassCount || null,
    agent_certified: agentCertified,
    agent_certification_policy: metadata.agent_certification_policy
      || payload.agent_certification_policy
      || (agentCertified ? `${AGENT_CERTIFICATION_REVIEW_PASSES}_agent_review_passes` : null),
    human_revision_count: metadata.human_revision_count || null,
  });
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

function taskAssignee(task) {
  const metadata = task && task.metadata || {};
  return metadata.assigned_to || task.claimed_by || null;
}

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

function scoreGoalMatch(task, goal) {
  const haystack = `${task.title} ${task.tag || ''}`.toLowerCase();
  const words = (String(goal || '').toLowerCase().match(/[a-z0-9]{4,}/g) || [])
    .filter(word => !GOAL_MATCH_STOPWORDS.has(word));
  return words.reduce((score, word) => {
    const singular = word.endsWith('s') && word.length > 4 ? word.slice(0, -1) : word;
    return score + (haystack.includes(word) || haystack.includes(singular) ? 1 : 0);
  }, 0);
}

function pickTaskGoal(task, goals) {
  if (!goals.length) return null;
  let best = goals[0];
  let bestScore = -1;
  for (const goal of goals) {
    const score = scoreGoalMatch(task, goal);
    if (score > bestScore) {
      best = goal;
      bestScore = score;
    }
  }
  return bestScore > 0 ? best : null;
}

function taskBaseObjective(task, goals) {
  const metadata = task && task.metadata || {};
  return task.objective
    || metadata.task_goal
    || metadata.goal_objective
    || metadata.objective
    || pickTaskGoal(task, goals);
}

function taskObjective(task, parent, goals, { parentLinkType = null, baseObjectives = new Map() } = {}) {
  const metadata = task && task.metadata || {};
  const explicit = task.objective || metadata.task_goal || metadata.goal_objective || metadata.objective;
  if (explicit) return explicit;
  if (parent) {
    if (parentLinkType === 'parent_task_id') return baseObjectives.get(parent.id) || parent.title;
    if (parentLinkType === 'goal_id') return parent.title;
    return baseObjectives.get(parent.id) || parent.title;
  }
  return pickTaskGoal(task, goals);
}

function buildTaskStreams(tasks, goals) {
  const buckets = new Map();
  for (const task of tasks) {
    const objective = task.objective || 'Unmapped work';
    if (!buckets.has(objective)) {
      buckets.set(objective, {
        objective,
        active_count: 0,
        done_count: 0,
        open_count: 0,
        doing_count: 0,
        blocked_count: 0,
        review_count: 0,
        tasks: [],
      });
    }
    const stream = buckets.get(objective);
    const column = taskColumn(task);
    if (task.status === 'done') stream.done_count += 1; else stream.active_count += 1;
    if (column === 'open') stream.open_count += 1;
    if (column === 'doing') stream.doing_count += 1;
    if (column === 'blocked') stream.blocked_count += 1;
    if (column === 'review') stream.review_count += 1;
    stream.tasks.push({
      id: task.id,
      title: task.title,
      status: task.status,
      tag: task.tag,
      claimed_by: task.claimed_by,
      assigned_to: taskAssignee(task),
      parent_task_id: task.lineage && task.lineage.parent_task_id || null,
      child_task_ids: task.lineage && task.lineage.child_task_ids || [],
      proof: task.review && task.review.proof || null,
    });
  }
  for (const goal of goals) {
    if (!buckets.has(goal)) {
      buckets.set(goal, {
        objective: goal,
        active_count: 0,
        done_count: 0,
        open_count: 0,
        doing_count: 0,
        blocked_count: 0,
        review_count: 0,
        tasks: [],
      });
    }
  }
  return Array.from(buckets.values())
    .sort((a, b) => (b.active_count - a.active_count) || (b.done_count - a.done_count) || a.objective.localeCompare(b.objective));
}

function enrichTaskProjection(projection) {
  const root = projection.workspace_root || process.cwd();
  const goalSource = readGoalSources(root);
  const byRef = new Map();
  for (const task of projection.tasks || []) {
    for (const ref of taskLookupRefs(task)) byRef.set(ref, task);
  }
  const baseObjectives = new Map();
  for (const task of projection.tasks || []) {
    const objective = taskBaseObjective(task, goalSource.goals);
    if (objective) baseObjectives.set(task.id, objective);
  }
  const children = new Map();
  for (const task of projection.tasks || []) {
    const metadata = task.metadata || {};
    const parent = resolveProjectionTaskRef(metadata.parent_task_id, byRef) || resolveProjectionTaskRef(metadata.goal_id, byRef);
    if (!parent) continue;
    if (!children.has(parent.id)) children.set(parent.id, []);
    children.get(parent.id).push(task);
  }
  const enrichedTasks = (projection.tasks || []).map(task => {
      const metadata = task.metadata || {};
      const parentFromParentId = resolveProjectionTaskRef(metadata.parent_task_id, byRef);
      const parentFromGoalId = resolveProjectionTaskRef(metadata.goal_id, byRef);
      const parent = parentFromParentId || parentFromGoalId;
      const parentLinkType = parentFromParentId ? 'parent_task_id' : parentFromGoalId ? 'goal_id' : null;
      const parentId = parent ? parent.id : metadata.parent_task_id || null;
      const childTasks = children.get(task.id) || [];
      const review = taskReviewSummary(task);
      return {
        ...task,
        objective: taskObjective(task, parent, goalSource.goals, { parentLinkType, baseObjectives }),
        review,
        lineage: {
          parent_task_id: parentId,
          parent_title: parent ? parent.title : null,
          child_task_ids: childTasks.map(child => child.id),
          child_titles: childTasks.map(child => child.title),
          next_task_suggestion: review ? review.next_task : null,
        },
      };
    });
  return {
    ...projection,
    goals: {
      source_path: goalSource.path,
      items: goalSource.goals,
    },
    streams: buildTaskStreams(enrichedTasks, goalSource.goals),
    tasks: enrichedTasks,
  };
}

function taskTypeForCloud(task) {
  const tag = String(task.tag || '').toLowerCase();
  if (['inbound', 'outbound', 'creative', 'improvement'].includes(tag)) return tag;
  if (['design', 'writing', 'image', 'video', 'launch'].includes(tag)) return 'creative';
  if (['sales', 'gtm', 'customer', 'email'].includes(tag)) return 'outbound';
  return 'improvement';
}

function taskStateForCloud(task) {
  if (task.status === 'review') return 'doing';
  if (task.status === 'claimed') return 'doing';
  if (task.status === 'failed' && taskHasReview(task)) return 'done';
  if (task.status === 'failed') return 'blocked';
  if (task.status === 'done') return 'done';
  return 'open';
}

function taskNeedsApprovalForCloud(task) {
  const approvalStatus = task?.review?.approval_status || task?.metadata?.approval_status || null;
  return task?.status === 'review' || approvalStatus === 'pending';
}

function ownerMemberIdForCloud(task) {
  const ownerValue = task.claimed_by || taskAssignee(task);
  if (!ownerValue) return null;
  const owner = String(ownerValue).trim();
  if (!owner) return null;
  if (owner.includes(':')) return owner;
  return `agent:${owner}`;
}

function taskDescriptionForCloud(task) {
  const lines = [
    `Local task: ${task.id}`,
    `Status: ${task.status}`,
    `Latest event: ${task.latest_event_type || 'none'}`,
  ];
  if (task.messages && task.messages.length) {
    lines.push('', 'Thread:');
    for (const message of task.messages.slice(-5)) {
      lines.push(`- ${message.actor || 'unknown'}: ${message.content}`);
    }
  }
  const reviewed = (task.events || []).slice().reverse().find(e => e.event_type === 'reviewed');
  if (reviewed && reviewed.payload) {
    if (reviewed.payload.proof) lines.push('', `Proof: ${reviewed.payload.proof}`);
    if (reviewed.payload.lesson) lines.push(`Lesson: ${reviewed.payload.lesson}`);
    if (reviewed.payload.next_task) lines.push(`Next: ${reviewed.payload.next_task}`);
  } else if (task.review && task.review.proof) {
    lines.push('', `Proof: ${task.review.proof}`);
    if (task.review.lesson) lines.push(`Lesson: ${task.review.lesson}`);
    if (task.review.next_task) lines.push(`Next: ${task.review.next_task}`);
  }
  return lines.join('\n').slice(0, 5000);
}

function cloudPayloadForTask(task, businessId) {
  const metadata = task.metadata || {};
  const claimedAtEvent = (task.events || []).find(e => e.event_type === 'claimed');
  return {
    type: taskTypeForCloud(task),
    title: String(task.title || '').slice(0, 200),
    description: taskDescriptionForCloud(task),
    owner_member_id: ownerMemberIdForCloud(task),
    needs_approval: taskNeedsApprovalForCloud(task),
    metadata: {
      ...metadata,
      source: 'atris_cli_task',
      business_id: businessId,
      local_task_id: task.id,
      local_status: task.status,
      local_tag: task.tag || null,
      current_version: task.current_version,
      latest_event_type: task.latest_event_type,
      workspace_root: task.workspace_root,
      swarlo: {
        lease_owner: task.claimed_by || null,
        lease_state: task.status === 'claimed' ? 'held' : 'none',
        lease_started_at: claimedAtEvent ? new Date(claimedAtEvent.created_at).toISOString() : null,
      },
    },
  };
}

function syncPlanForProjection(projection, businessId) {
  const endpoint = `/business/${businessId}/work/tasks`;
  const plan = [];
  for (const task of projection.tasks) {
    const payload = cloudPayloadForTask(task, businessId);
    const cloudTaskId = task.metadata && (task.metadata.cloud_task_id || task.metadata.supabase_task_id);
    if (cloudTaskId) {
      plan.push({
        action: 'patch',
        method: 'PATCH',
        endpoint: `${endpoint}/${cloudTaskId}`,
        local_task_id: task.id,
        cloud_task_id: cloudTaskId,
        body: {
          ...payload,
          state: taskStateForCloud(task),
        },
      });
    } else {
      plan.push({
        action: 'post',
        method: 'POST',
        endpoint,
        local_task_id: task.id,
        body: payload,
        after_create: taskStateForCloud(task) === 'open' ? [] : [{
          method: 'PATCH',
          endpoint: `${endpoint}/{created_task_id}`,
          body: { state: taskStateForCloud(task) },
        }],
      });
    }
  }
  return plan;
}

function latestTaskEvent(task) {
  const events = task.events || [];
  return events.length ? events[events.length - 1] : null;
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
    handoff.revise_command = `atris task revise ${taskRef(task)} --note "<replace stale PR proof with merged proof or move back to Do>"`;
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
  if (/^atris\s+task\s+\w+\s+json\s*$/i.test(text) && !/--json\b/i.test(text)) return false;
  if (/^atris\s+(?:command|review-chat|smoke|temp)\b/i.test(text)) return false;
  if (/^(?:npm|npx|pnpm|yarn|python3?|pytest|bash|sh|tsc|vitest|curl|gh|rg|git)\s+commands?\b/i.test(text)) return false;
  if (/^(?:npm|pnpm|yarn)\s+(?:tests|checks?)$/i.test(text)) return false;
  if (/^(?:git|gh|rg|curl|bash|sh|tsc)\s+(?:tests?|checks?)$/i.test(text)) return false;
  if (/\s+(?:and|then)\s+\S+/i.test(text)) return false;
  if (/^node\s+(?!-|\S*(?:[/.]))/i.test(text)) return false;
  if (/^node\s+--test\s+[\w-]+(?:\s+[\w-]+)+$/i.test(text)) return false;
  return true;
}

function taskReviewEvidenceCommands(text, limit = 8) {
  const source = String(text || '').trim();
  if (!source) return [];
  const commandWord = '(?:npm|node|git|atris|npx|pnpm|yarn|python3?|pytest|bash|sh|tsc|vitest|curl|gh|rg)';
  const envPrefix = '(?:(?:[A-Z_][A-Z0-9_]*=[^\\s,;|]+)\\s+)*';
  const prosePrefix = '(?:(?:rechecked|reran|re-run|run|verified|validated|validation(?:\\s+passed)?|verification(?:\\s+passed)?|focused|live|scoped|installed|direct|full|current|fresh|then|and|commands?|checks?)[:\\s]+)*';
  const commandStart = `${prosePrefix}${envPrefix}${commandWord}\\b`;
  const commandStartPattern = new RegExp(`(^|[^\\w./-])(${commandStart})`, 'i');
  const commandStartInnerPattern = new RegExp(`${envPrefix}${commandWord}\\b`, 'i');
  const commandBoundaryPattern = new RegExp(`(?:;\\s*|\\n\\s*|\\s+&&\\s+|,\\s+|\\.\\s+|\\s+and\\s+|\\s+then\\s+)(?=${commandStart})`, 'gi');
  const clauses = source
    .replace(/\r/g, '\n')
    .replace(/```[ \t]*(?:bash|sh|shell|zsh|console|text|txt)?[ \t]*\n/gi, '\n')
    .replace(/```/g, '\n')
    .replace(/`/g, '')
    .replace(/(?:;\s*|\n\s*|\s+&&\s+)/g, '\n')
    .replace(commandBoundaryPattern, '\n')
    .split('\n');
  const out = [];
  const seen = new Set();
  for (const clause of clauses) {
    const start = clause.match(commandStartPattern);
    if (!start || start.index == null) continue;
    const commandStartOffset = start[0].indexOf(start[2]);
    const raw = clause.slice(start.index + Math.max(0, commandStartOffset));
    const prefix = raw.match(commandStartInnerPattern);
    const commandOffset = prefix && prefix.index != null ? prefix.index : 0;
    const command = raw.slice(Math.max(0, commandOffset));
    const clean = command
      .replace(/\s+from\s+[^,;]*(?:showed|shows|showing|returned|returns)\b.*$/i, '')
      .replace(/\s+(?:showed|shows|showing|returned|returns)\b.*$/i, '')
      .replace(/\.\s+(?:Reward remains|No human|Human accept|AgentXP|XP)\b.*$/i, '')
      .replace(/\s+\((?:passed|ok|clean|failed|errored|timed out|succeeded|succeeds|successful|confirmed)\)$/i, '')
      .replace(/\s+\(?(?:exit|status|code)\s+\d+\)?$/i, '')
      .replace(/[\]),.;:]+$/g, '')
      .replace(/\s+\(?(?:passed|ok|clean|failed|errored|timed out|succeeded|succeeds|successful|confirmed)\s+\d+\/\d+(?:\s+(?:tests?|checks?|passed|pass|ok|clean|failed|failures?))?$/i, '')
      .replace(/\s+\(?(?:passed|ok|clean|failed|errored|timed out|succeeded|succeeds|successful|confirmed)(?:[.:]\s+.*|\s+after\b.*)$/i, '')
      .replace(/\s+\(?(?:passed|ok|clean|failed|errored|timed out|succeeded|succeeds|successful|confirmed)\)?$/i, '')
      .replace(/\s+\d+\/\d+(?:\s+(?:tests?|checks?|passed|pass|ok|clean|failed|failures?))?$/i, '')
      .replace(/[\]),.;:]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
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

function taskReviewVerificationFocus(task) {
  const review = task && task.review || {};
  const metadata = task && task.metadata || {};
  const proof = review.proof || metadata.latest_agent_proof || '';
  const lesson = review.lesson || metadata.latest_agent_lesson || '';
  const nextTask = review.next_task || metadata.latest_agent_next_task || '';
  const objective = task && (task.objective || metadata.task_goal || metadata.goal_objective || metadata.objective) || '';
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
    ? ` Commands: ${focus.commands_to_verify.join(' | ')}.`
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
  const objective = task && (task.objective || metadata.task_goal || metadata.goal_objective || metadata.objective) || '';
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
        ? `Re-run or inspect these proof commands: ${verificationFocus.commands_to_verify.join(' | ')}.`
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

function compactTaskForStatus(task) {
  if (!task) return null;
  const metadata = task.metadata || {};
  const out = {
    id: task.id,
    display_id: task.display_id || null,
    legacy_ref: task.legacy_ref || taskRef(task.id),
    title: clipStatusText(task.title, 140),
    status: task.status,
    updated_at: task.updated_at,
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
    if (task.review.summary) review.summary = clipStatusText(task.review.summary, 240);
    if (task.review.proof) review.proof = clipStatusText(task.review.proof, 180);
    if (task.review.lesson) review.lesson = clipStatusText(task.review.lesson, 180);
    if (task.review.next_task) review.next_task = clipStatusText(task.review.next_task, 140);
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
  for (const key of ['todo_id', 'stage', 'verify', 'delegate_via', 'goal_id', 'task_goal', 'goal_objective', 'approval_status', 'agent_review_pass_count', 'agent_certified', 'agent_certification_policy', 'human_revision_count', 'human_revision_note']) {
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
  for (const key of ['title', 'status', 'tag', 'content', 'goal', 'summary', 'proof', 'lesson', 'reward', 'next_task']) {
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

function taskQueueItem(task, { reviewer = 'codex-review', hasExistingReviewFollowUp = null } = {}) {
  const page = taskPageContract(task, { reviewer, hasExistingReviewFollowUp });
  const item = compactTaskForStatus(task) || {};
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

function taskMatchesQueueScope(task, scope = {}, options = {}) {
  const normalized = normalizeTaskQueueScope(scope);
  if (normalized.goal_id && !taskGoalScopeValues(task).some(value => taskScopeEquals(value, normalized.goal_id))) {
    return false;
  }
  if (normalized.tag && !taskScopeEquals(task && task.tag, normalized.tag)) {
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
      },
      queue: {
        command: 'atris task queue --review-state <lane> --json',
        api: { method: 'GET', path: '/api/tasks/queue?review_state=<lane>' },
        read_only: true,
        mutates_task_db: false,
        writes_projection: true,
        requires_task_db: true,
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
  const checks = {
    allows_review_chat: reviewChat.ok === true && reviewChat.step_action === 'review_chat',
    allows_continue_work: continueWork.ok === true && continueWork.step_action === 'continue_work',
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
  const limit = options.limit !== undefined ? options.limit : taskQueueLimit(args);
  const scope = normalizeTaskQueueScope(options.scope || taskQueueScopeFromArgs(args));
  const standalone = taskCapabilitiesContract();
  const { outPath, current } = buildTaskCurrent(taskDb, db, [], {
    owner,
    reviewer,
    all,
    limit,
    scope,
  });
  const acceptedLanes = standalone.filters.review_state.accepted || [];
  const currentStepLanes = standalone.current_step.lanes || {};
  const currentStepIdentityFields = standalone.current_step.output_fields?.identity || [];
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

function formatTaskQueueScope(scope = {}) {
  const normalized = normalizeTaskQueueScope(scope);
  return Object.entries(normalized)
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}=${value}`)
    .join(' ');
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
  const tasks = filterTasksByScope(sortTasksNewestFirst(projection.tasks || []), scope, { hasExistingReviewFollowUp });
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
  const planReady = columns.plan[0];
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
  const limit = options.limit !== undefined ? options.limit : taskQueueLimit(args);
  const scope = normalizeTaskQueueScope(options.scope || taskQueueScopeFromArgs(args));
  const { projection, outPath } = writeDefaultProjection(taskDb, db, { all });
  const hasExistingReviewFollowUp = buildReviewFollowUpChildPredicate(
    taskDb,
    db,
    all ? null : taskDb.workspaceRoot(),
  );
  const hasPendingReviewChat = buildPendingReviewChatPredicate(
    taskDb,
    db,
    all ? null : taskDb.workspaceRoot(),
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
  const limit = options.limit !== undefined ? options.limit : taskQueueLimit(args);
  const scope = normalizeTaskQueueScope(options.scope || taskQueueScopeFromArgs(args));
  const capabilitiesCheck = taskCapabilitiesCheckReport(taskDb, db, [], {
    owner,
    reviewer,
    all,
    limit,
    scope,
  });
  const { outPath, current } = buildTaskCurrent(taskDb, db, [], {
    owner,
    reviewer,
    all,
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
    limit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 8,
    scope: mergeTaskQueueScopes(queryScope, bodyScope),
    dryRun: searchParams.get('dry_run') === '1'
      || searchParams.get('dry-run') === '1'
      || searchParams.get('dryRun') === 'true'
      || Boolean(body.dry_run || body.dryRun),
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
      allowed_actions: ['review_chat', 'continue_work'],
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
  let status = 200;
  let finalDrain = null;
  let finalDecision = null;
  let projectionPath = null;

  for (let index = 1; index <= maxSteps; index += 1) {
	    const preview = taskReviewLaneAct(taskDb, db, {
	      owner,
	      reviewer,
	      all: Boolean(options.all),
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
      status = taskReviewLaneLoopStopIsSafe(stoppedReason).ok ? 200 : preview.status || 409;
      steps.push(compactReviewLaneLoopStep(index, preview, { phase: 'preview' }));
      break;
    }

    const actionKey = taskReviewLaneActSelectionKey(preview);
    if (!actionKey) {
      stoppedReason = 'no_review_lane_action';
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
  let stoppedOn = null;
  let status = 200;
  let projectionPath = null;

  for (let index = 1; index <= maxRuns; index += 1) {
	    const loop = taskReviewLaneLoop(taskDb, db, {
	      owner,
	      reviewer,
	      all: Boolean(options.all),
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

function reviewQueueLimit(args, total) {
  if (hasFlag(args, '--all')) return total;
  const raw = flag(args, '--limit');
  const limit = raw && raw !== true ? Number(raw) : 12;
  return Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 12;
}

function reviewQueueItem(task) {
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
    tag: task.tag || null,
    updated_at: task.updated_at || null,
    review_pass_count: task.review?.agent_review_pass_count || null,
    proof: taskReviewClip(task.review?.proof, 500) || null,
    next_action: handoff?.next_action || null,
    accept_command: acceptCommand,
    revise_command: `atris task revise ${ref} --note "<what must change>"`,
  };
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
  const items = certified.slice(0, limit).map(reviewQueueItem);
  return {
    schema: 'atris.task_review_queue.v1',
    generated_at: projection.generated_at,
    workspace_root: projection.workspace_root,
    counts: {
      review: reviewTasks.length,
      certified: certified.length,
      blocking: blocking.length,
      proof_boundary_blocked: proofBoundaryBlocked.length,
      shown: items.length,
    },
    hygiene: reviewQueueHygiene(reviewTasks),
    items,
  };
}

function cmdReviews(args) {
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  const queue = taskReviewQueue(projection, args);
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'review_queue',
      projection_path: outPath,
      queue,
    });
    return;
  }
  console.log('CERTIFIED REVIEW QUEUE');
  console.log(`${queue.counts.certified} certified / ${queue.counts.blocking} need agent review / ${queue.counts.review} total review`);
  if (!queue.items.length) {
    console.log('No certified review items.');
    return;
  }
  queue.items.forEach((item, index) => {
    const tag = item.tag ? ` [${item.tag}]` : '';
    const passes = item.review_pass_count ? ` (${item.review_pass_count} reviews)` : '';
    console.log('');
    console.log(`${index + 1}. ${item.display_id || taskRef(item.id)}${tag}${passes}: ${item.title}`);
    if (item.proof) console.log(`   proof: ${item.proof}`);
    if (item.review_chat_command) console.log(`   /codex: ${item.review_chat_command}`);
    if (item.continue_work_command) console.log(`   continue: ${item.continue_work_command}`);
    if (item.accept_command) console.log(`   accept: ${item.accept_command}`);
    else if (item.blocked_accept_reason) console.log(`   accept: blocked (${item.blocked_accept_reason})`);
    console.log(`   revise: ${item.revise_command}`);
  });
  if (queue.counts.shown < queue.counts.certified) {
    console.log('');
    console.log(`Showing ${queue.counts.shown}/${queue.counts.certified}; rerun with --all or --limit ${queue.counts.certified}.`);
  }
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

function normalizedStatusPart(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, '-');
}

function taskIsPlannedOpen(task) {
  const metadata = task && task.metadata || {};
  const tag = normalizedStatusPart(task && task.tag);
  const stage = normalizedStatusPart(metadata.stage);
  return STATUS_PLAN_TAGS.has(tag)
    || STATUS_PLAN_TAGS.has(stage)
    || Boolean(metadata.verify || metadata.goal || metadata.loop || metadata.cron || metadata.next_run_at);
}

function formatTaskLine(task) {
  if (!task) return 'none';
  const owner = task.claimed_by ? ` @${task.claimed_by}` : '';
  const assigned = !task.claimed_by && taskAssignee(task) ? ` -> ${taskAssignee(task)}` : '';
  const tag = task.tag ? ` #${task.tag}` : '';
  return `${taskRef(task)}${owner}${assigned}${tag} ${task.title}`;
}

function cmdStatus(args) {
  const all = hasFlag(args, '--all');
  const history = hasFlag(args, '--history');
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const compact = writeDefaultProjection(taskDb, db, { all });
  const projection = history
    ? enrichTaskProjection(taskDb.taskProjection(db, {
      workspaceRoot: all ? null : taskDb.workspaceRoot(),
      limit: 500,
      includeHistory: true,
    }))
    : compact.projection;
  const outPath = compact.outPath;
  const hasExistingReviewFollowUp = buildReviewFollowUpChildPredicate(taskDb, db, all ? null : taskDb.workspaceRoot());
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
  console.log(`current ${formatTaskLine(status.current)}`);
  console.log(`next    ${formatTaskLine(status.next)}`);
  if (status.needs_review.length) {
    console.log('review');
    for (const task of status.needs_review.slice(0, 3)) console.log(`  ${formatTaskLine(task)}`);
  }
  if (history) console.log(`history feed ${status.swarlo.feed.length} event${status.swarlo.feed.length === 1 ? '' : 's'}`);
}

function resolveTaskRef(taskDb, db, ref) {
  const token = String(ref || '').trim();
  if (!token) return { ok: false, reason: 'missing' };
  const exact = taskDb.getTask(db, token);
  if (exact) return { ok: true, id: exact.id, row: exact };
  const normalized = taskDb.normalizeTaskRef ? taskDb.normalizeTaskRef(token) : token.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  const rows = taskDb.withTaskDisplayRefs(taskDb.listTasks(db, { workspaceRoot: taskDb.workspaceRoot() }));
  const seen = new Set();
  const matches = rows.filter(r => {
    const id = String(r.id || '').toUpperCase();
    const display = taskDb.normalizeTaskRef ? taskDb.normalizeTaskRef(r.display_id) : String(r.display_id || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
    const legacy = taskDb.normalizeTaskRef ? taskDb.normalizeTaskRef(r.legacy_ref) : String(r.legacy_ref || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
    const matched = id.startsWith(normalized) || display === normalized || legacy === normalized;
    if (!matched || seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });
  if (matches.length === 1) return { ok: true, id: matches[0].id, row: matches[0] };
  if (matches.length > 1) return { ok: false, reason: 'ambiguous', matches };
  return { ok: false, reason: 'not_found' };
}

function requireTaskId(taskDb, db, ref, label) {
  const resolved = resolveTaskRef(taskDb, db, ref);
  if (resolved.ok) return resolved.id;
  if (resolved.reason === 'ambiguous') {
    failTask(label, 'ambiguous', `ambiguous task id prefix "${ref}"`);
  } else if (resolved.reason === 'missing') {
    failTask(label, 'missing_id', 'task id required');
  } else {
    failTask(label, 'not_found', `task not found: ${ref}`);
  }
}

function workspaceRefRows(taskDb, db, all = false) {
  return taskDb.listTasks(db, { workspaceRoot: all ? null : taskDb.workspaceRoot() });
}

function renderTaskDesk(rows, refRows = rows) {
  const displayRows = getTaskDb().withTaskDisplayRefs(rows, refRows);
  const active = displayRows.filter(r => r.status !== 'done');
  const done = displayRows.filter(r => r.status === 'done');
  if (rows.length === 0) {
    console.log('No tasks yet.');
    console.log('Start with: atris task new "Ship the smallest useful thing"');
    return;
  }
  console.log('TASK DESK');
  console.log('');
  for (const r of active.slice(0, 12)) {
    const owner = r.claimed_by ? ` @${r.claimed_by}` : '';
    const assigned = !r.claimed_by && taskAssignee(r) ? ` -> ${taskAssignee(r)}` : '';
    const tag = r.tag ? ` #${r.tag}` : '';
    console.log(`${r.status.padEnd(7)} ${taskRef(r)}${owner}${assigned}${tag}`);
    console.log(`        ${r.title}`);
  }
  if (active.length === 0) console.log('clear   no active tasks');
  console.log('');
  console.log(`active ${active.length} / done ${done.length}`);
  console.log('next: atris task next');
}

function cmdAdd(args) {
  const pos = positional(args);
  const title = pos.join(' ').trim();
  if (!title) {
    failTask('atris task add', 'missing_title', 'title required');
  }
  const tag = flag(args, '--tag');
  const goalId = flag(args, '--goal-id');
  const goalObjective = flag(args, '--goal-objective') || flag(args, '--goal');
  const metadata = {};
  if (goalId && goalId !== true) metadata.goal_id = String(goalId);
  if (goalObjective && goalObjective !== true) {
    metadata.task_goal = String(goalObjective);
    metadata.goal_objective = String(goalObjective);
  }
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const ws = taskDb.workspaceRoot();
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
      projection_path: outPath,
      task,
    });
    return;
  }
  console.log(`${taskRef(task)}\t${title}`);
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

function cmdDelegate(args) {
  const pos = positional(args);
  const title = pos.join(' ').trim();
  const owner = flag(args, '--to') || flag(args, '--as');
  if (!title) {
    failTask('atris task delegate', 'missing_title', 'title required');
  }
  if (!owner || owner === true) {
    failTask('atris task delegate', 'missing_owner', '--to <owner> required');
  }
  const viaFlag = flag(args, '--via');
  const via = viaFlag === 'swarlo' ? 'swarlo' : 'local';
  const tag = flag(args, '--tag');
  const note = flag(args, '--note');
  const goalId = flag(args, '--goal-id');
  const goalObjective = flag(args, '--goal-objective') || flag(args, '--goal');
  const claimNow = hasFlag(args, '--claim');
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const ws = taskDb.workspaceRoot();
  const metadata = {
    assigned_to: String(owner),
    delegate_via: via,
    swarlo_channel: via === 'swarlo' ? String(tag || 'tasks') : null,
    created_for_day: new Date().toISOString().slice(0, 10),
  };
  if (goalId && goalId !== true) metadata.goal_id = String(goalId);
  if (goalObjective && goalObjective !== true) {
    metadata.task_goal = String(goalObjective);
    metadata.goal_objective = String(goalObjective);
  }
  const result = taskDb.addTask(db, {
    title,
    tag: typeof tag === 'string' ? tag : null,
    workspaceRoot: ws,
    status: claimNow ? 'claimed' : 'open',
    claimedBy: claimNow ? String(owner) : null,
    metadata,
  });
  if (typeof note === 'string' && note.trim()) {
    taskDb.noteTask(db, { id: result.id, actor: DEFAULT_OWNER, content: note });
  }
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  const task = compactTaskFromProjection(projection, result.id);
  const handoff = delegateHandoff(task, String(owner), via, typeof tag === 'string' ? tag : null);
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'delegated',
      task_id: result.id,
      inserted: result.inserted !== false,
      owner: String(owner),
      via,
      handoff,
      projection_path: outPath,
      task,
    });
    return;
  }
  const tagText = tag && tag !== true ? ` #${tag}` : '';
  console.log(`delegated ${taskRef(task)} -> ${owner}${tagText} via=${via}`);
  console.log(`claim: ${handoff.command}`);
  if (handoff.swarlo) console.log(`swarlo: ${handoff.swarlo.channel}/${handoff.swarlo.action}`);
}

function taskDayGroups(tasks) {
  const active = tasks.filter(task => task.status !== 'done');
  const groups = new Map();
  for (const task of active) {
    const owner = taskAssignee(task) || 'unassigned';
    if (!groups.has(owner)) groups.set(owner, []);
    groups.get(owner).push(task);
  }
  return Array.from(groups.entries())
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
}

function cmdDay(args) {
  const all = hasFlag(args, '--all');
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const { projection, outPath } = writeDefaultProjection(taskDb, db, { all });
  const groups = taskDayGroups(projection.tasks || []);
  const counts = {
    active: groups.reduce((sum, group) => sum + group.tasks.length, 0),
    owners: groups.length,
    open: (projection.tasks || []).filter(task => task.status === 'open').length,
    claimed: (projection.tasks || []).filter(task => task.status === 'claimed').length,
    review: (projection.tasks || []).filter(task => task.status === 'review' || task.status === 'failed' || (task.status === 'done' && task.review && task.review.reward === null)).length,
  };
  const date = new Date().toISOString().slice(0, 10);
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'day',
      date,
      projection_path: outPath,
      counts,
      groups,
    });
    return;
  }
  console.log('TASK DAY');
  console.log(`${date}  active ${counts.active} / owners ${counts.owners} / review ${counts.review}`);
  console.log('');
  if (!groups.length) {
    console.log('clear   no active tasks');
  }
  for (const group of groups) {
    console.log(`${group.owner}`);
    for (const task of group.tasks.slice(0, 8)) {
      const tag = task.tag ? ` #${task.tag}` : '';
      const claim = task.claimed_by ? ` @${task.claimed_by}` : '';
      console.log(`  ${task.status.padEnd(7)} ${taskRef(task)}${claim}${tag} ${task.title}`);
    }
  }
  console.log('');
  console.log('add: atris task delegate "..." --to codex --tag tasks');
}

function cmdHome(args) {
  const all = hasFlag(args, '--all');
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const rows = taskDb.listTasks(db, {
    workspaceRoot: all ? null : taskDb.workspaceRoot(),
    limit: 200,
  });
  const { projection, outPath } = writeDefaultProjection(taskDb, db, { all });
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
  renderTaskDesk(rows, rows);
}

function cmdList(args) {
  const all = hasFlag(args, '--all');
  const status = flag(args, '--status');
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const rows = taskDb.listTasks(db, {
    workspaceRoot: all ? null : taskDb.workspaceRoot(),
    status: typeof status === 'string' ? status : null,
    limit: 200,
  });
  const displayRows = taskDb.withTaskDisplayRefs(rows, workspaceRefRows(taskDb, db, all));
  if (wantsJson(args)) {
    printJson({ ok: true, action: 'list', tasks: displayRows });
    return;
  }
  if (rows.length === 0) {
    console.log('(no tasks)');
    return;
  }
  for (const r of displayRows) {
    const claim = r.claimed_by ? ` [${r.claimed_by}]` : '';
    const tag = r.tag ? ` #${r.tag}` : '';
    console.log(`${r.status.padEnd(8)} ${taskRef(r)}${claim}${tag}\t${r.title}`);
  }
}

function cmdClaim(args) {
  const pos = positional(args);
  const id = pos[0];
  if (!id) {
    failTask('atris task claim', 'missing_id', 'id required');
  }
  const owner = flag(args, '--as') || DEFAULT_OWNER;
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const taskId = requireTaskId(taskDb, db, id, 'atris task claim');
  const result = taskDb.claimTask(db, { id: taskId, claimedBy: String(owner) });
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
    console.log(`claimed ${taskRef(compactTaskFromProjection(projection, taskId))} as ${owner}`);
  } else {
    if (wantsJson(args)) {
      printJson({
        ok: false,
        command: 'atris task claim',
        reason: result.reason,
        claimed_by: result.claimed_by || null,
        detail: `claim failed: ${result.reason}${result.claimed_by ? ` (held by ${result.claimed_by})` : ''}`,
      });
      process.exit(1);
    }
    console.error(`claim failed: ${result.reason}${result.claimed_by ? ` (held by ${result.claimed_by})` : ''}`);
    process.exit(1);
  }
}

function cmdNext(args) {
  const owner = flag(args, '--as') || DEFAULT_OWNER;
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const claimed = taskDb.listTasks(db, {
    workspaceRoot: taskDb.workspaceRoot(),
    status: 'claimed',
    claimedBy: String(owner),
    limit: 1,
  });
  if (claimed.length) {
    const { projection, outPath } = writeDefaultProjection(taskDb, db);
    if (wantsJson(args)) {
      printJson({
        ok: true,
        action: 'current',
        task_id: claimed[0].id,
        owner: String(owner),
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
  const reviewTasks = (reviewProjection.projection.tasks || [])
    .map(compactTaskForStatus)
    .filter(task => task && task.review && task.review.handoff);
  const open = taskDb.listTasks(db, {
    workspaceRoot: taskDb.workspaceRoot(),
    status: 'open',
    limit: 1,
  });
  if (!open.length) {
    const { projection, outPath } = reviewProjection;
    const reviewTask = reviewTasks.find(task => task.review.handoff.next_action === 'agent_review_again')
      || reviewTasks.find(task => task.review.handoff.next_action === 'continue_work')
      || reviewTasks.find(task => task.review.handoff.next_action === 'human_accept_waiting');
    if (reviewTask) {
      const handoff = reviewTask.review.handoff;
      const continueWorkCommand = handoff.next_action === 'continue_work'
        ? continueWorkCommandForTask(reviewTask, { owner })
        : null;
      if (wantsJson(args)) {
        printJson({
          ok: true,
          action: handoff.next_action,
          task_id: handoff.next_action === 'continue_work' ? null : reviewTask.id,
          owner: String(owner),
          projection_path: outPath,
          handoff,
          continue_work_command: continueWorkCommand,
          continue_work_api: continueWorkCommand ? { method: 'POST', path: `/api/tasks/${encodeURIComponent(reviewTask.id)}/continue-work` } : null,
          review_task: reviewTask,
        });
        return;
      }
      console.log('No open tasks.');
      console.log(handoff.next_action === 'agent_review_again'
        ? `${taskRef(reviewTask)} needs one more agent review before continuation.`
        : `${taskRef(reviewTask)} is agent-certified and waiting for human accept.`);
      console.log(handoff.next_action === 'continue_work'
        ? 'Continue work elsewhere; AgentXP waits for human accept.'
        : handoff.next_action === 'human_accept_waiting'
        ? 'No concrete next agent task is attached; AgentXP waits for human accept.'
        : 'Review this task again before continuing.');
      if (continueWorkCommand) console.log(`Command: ${continueWorkCommand}`);
      return;
    }
    if (wantsJson(args)) {
      printJson({
        ok: true,
        action: 'none',
        task_id: null,
        owner: String(owner),
        projection_path: outPath,
      });
      return;
    }
    console.log('No open tasks.');
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
      projection_path: outPath,
      task: compactTaskFromProjection(projection, open[0].id),
    });
    return;
  }
  console.log(`next ${taskRef(compactTaskFromProjection(projection, open[0].id))} @${owner}`);
  console.log(open[0].title);
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

function cmdPlan(args) {
  const pos = positional(args);
  const id = pos[0];
  if (!id) failTask('atris task plan', 'missing_id', 'id required');
  const actor = String(flag(args, '--as') || DEFAULT_OWNER);
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
  const result = taskDb.stageTask(db, {
    id: taskId,
    actor,
    stage: 'plan',
    goal,
    summary,
    owner,
    exit,
    proofNeeded,
    firstMove,
    nextButton,
    confidence,
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
  const task = projection.tasks[0];
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
  console.log(`${task.status.toUpperCase()} ${taskRef(task)} v${task.current_version}${owner}${tag}`);
  console.log(task.title);
  if (task.review) {
    console.log('');
    if (task.review.summary) console.log(`Summary: ${task.review.summary}`);
    if (task.review.proof) console.log(`Proof: ${task.review.proof}`);
    if (task.review.lesson) console.log(`Lesson: ${task.review.lesson}`);
    if (task.review.next_task) console.log(`Next: ${task.review.next_task}`);
    if (task.review.approval_status) console.log(`Approval: ${task.review.approval_status}`);
    if (task.review.verification_chat) console.log(`Review chat: ${task.review.verification_chat.command}`);
    if (task.review.agent_certified) console.log(`Agent certified: yes (${task.review.agent_review_pass_count || AGENT_CERTIFICATION_REVIEW_PASSES} reviews)`);
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
  console.log(`TASK PAGE ${taskRef(task)}`);
  console.log(`Goal: ${page.goal.text || '(none)'}`);
  console.log(`Stage: ${page.stage.current}`);
  console.log(`Next: ${page.stage.next_action.command || page.stage.next_action.label}`);
  console.log(`Chat: ${page.chat.command}`);
  if (page.review.verification_chat) console.log(`Review chat: ${page.review.verification_chat.command}`);
  if (page.review.human_accept.enabled) console.log(`Human accept: ${page.review.human_accept.command}`);
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

function taskDetail(taskDb, db, taskId) {
  const detailedProjection = taskDb.taskProjection(db, { taskId });
  const detailedTask = detailedProjection.tasks[0] || null;
  if (!detailedTask) return null;
  const workspaceRoot = detailedTask.workspace_root || taskDb.workspaceRoot();
  const contextProjection = enrichTaskProjection(taskDb.taskProjection(db, {
    workspaceRoot,
    limit: 5000,
  }));
  const enrichedTask = contextProjection.tasks.find(task => task.id === detailedTask.id) || null;
  if (!enrichedTask) return enrichTaskProjection(detailedProjection).tasks[0] || null;
  return {
    ...enrichedTask,
    current_version: detailedTask.current_version,
    latest_event_type: detailedTask.latest_event_type,
    messages: detailedTask.messages,
    events: detailedTask.events,
    history: detailedTask.history,
  };
}

function taskCommandQuote(value) {
  const text = String(value || '').replace(/\s+/g, ' ').replace(/"/g, '\\"').trim();
  return `"${text || '...'}"`;
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
    ready_command: `atris task ready ${ref} --as ${owner} --proof "<specific proof command/result>"`,
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
        label: 'Waiting for human accept',
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
      approval_status: task.review && task.review.approval_status || metadata.approval_status || null,
      agent_review_pass_count: task.review && task.review.agent_review_pass_count || metadata.agent_review_pass_count || null,
      agent_certified: Boolean(task.review && task.review.agent_certified || metadata.agent_certified),
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
  if (reviewPassCount >= AGENT_CERTIFICATION_REVIEW_PASSES) return false;
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
    throw taskReviewChatError('agent_certified_continue_work', 'review chat is closed after agent certification; continue other work or wait for human accept', { status: 409, exitCode: 1 });
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

function taskStepError(reason, detail, { status = 409, exitCode = 1, page = null } = {}) {
  const error = new Error(detail || reason);
  error.reason = reason;
  error.status = status;
  error.exitCode = exitCode;
  error.page = page;
  return error;
}

function taskStepStatusForReason(reason) {
  if (['goal_required', 'exit_required', 'proof_needed_required', 'first_move_required', 'proof_required', 'weak_proof', 'invalid_reward'].includes(reason)) {
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
      ? 'Agent double-check complete; continue work. AgentXP waits for human accept.'
      : 'Proof is in Review; one more agent review pass certifies continuation. AgentXP waits for human accept.',
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
  const initialHandoffState = task.status === 'review' ? reviewHandoffForTask(task, { suppressExistingFollowUp: true }) : null;
  if (initialHandoffState && (initialHandoffState.next_action === 'continue_work' || initialHandoffState.next_action === 'human_accept_waiting')) {
    const reason = initialHandoffState.next_action === 'continue_work'
      ? 'agent_certified_continue_work'
      : 'agent_certified_waiting_human';
    throw taskStepError(reason, 'atris task step: agent-certified Review rows have no safe agent step; continue other work or wait for human accept', { status: 409, exitCode: 1, page: initialPage });
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
    const planned = taskDb.stageTask(db, {
      id: taskId,
      actor,
      stage: 'plan',
      goal,
      summary,
      owner: actor,
      exit: String(options.exit || ''),
      proofNeeded: String(options.proofNeeded || ''),
      firstMove: String(options.firstMove || ''),
    });
    if (!planned.staged) taskStepFailure('atris task step', planned, actionPage);
    stepAction = 'planned';
    version = planned.event.version;
    stagePacket = planned.stage_packet;
  } else if (current === 'plan') {
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
      throw taskStepError(proof ? 'weak_proof' : 'proof_required', `meaningful proof required: ${proofIssue}`, { status: 400, exitCode: 2, page: actionPage });
    }
    const lesson = String(options.lesson || '');
    const nextTask = String(options.nextTask || '');
    const ready = taskDb.readyTask(db, { id: taskId, actor, proof, lesson, nextTask });
    if (!ready.ready) taskStepFailure('atris task step', ready, actionPage);
    task = taskDetail(taskDb, db, taskId) || task;
    stepAction = 'ready';
    version = ready.event.version;
    handoff = readyHandoffForStep(task, proof, lesson, nextTask, ready.event.payload.agent_certified === true);
  } else if (current === 'review' && task.status === 'review') {
    const handoffState = reviewHandoffForTask(task, { suppressExistingFollowUp: true });
    if (handoffState && handoffState.next_action === PROOF_BOUNDARY_BLOCKED_ACTION) {
      throw taskStepError(PROOF_BOUNDARY_BLOCKED_REASON, 'atris task step: Review proof cites an open/draft/unmerged PR boundary; revise the row before further stepping', { status: 409, exitCode: 1, page: actionPage });
    }
    if (handoffState && (handoffState.next_action === 'continue_work' || handoffState.next_action === 'human_accept_waiting')) {
      const reason = handoffState.next_action === 'continue_work'
        ? 'agent_certified_continue_work'
        : 'agent_certified_waiting_human';
      throw taskStepError(reason, 'atris task step: agent-certified Review rows have no safe agent step; continue other work or wait for human accept', { status: 409, exitCode: 1, page: actionPage });
    }
    const reviewed = appendTaskReviewChat(taskDb, db, taskId, { reviewer, dryRun: Boolean(options.dryRun) });
    stepAction = 'review_chat';
    version = reviewed.version;
    contract = reviewed.contract;
  } else if (current === 'review') {
    const proof = String(options.proof || '').trim();
    const proofIssue = meaningfulTaskProofIssue(proof);
    if (proofIssue) {
      throw taskStepError(proof ? 'weak_proof' : 'proof_required', `meaningful proof required: ${proofIssue}`, { status: 400, exitCode: 2, page: actionPage });
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
      'atris task current-step: selected Review row is agent-certified and waiting for human accept; no agent mutation is safe',
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
    const error = taskStepError(
      PROOF_BOUNDARY_BLOCKED_REASON,
      'atris task current-step: selected Review row has stale/open/draft/unmerged PR proof; revise it instead of accepting or auto-stepping',
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
      printJson({
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
    } else {
      console.error(error.message || 'atris task current-step failed');
    }
    process.exit(error.exitCode || 1);
  }
  if (wantsJson(args)) {
    printJson(result);
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

function cmdDone(args) {
  const pos = positional(args);
  const id = pos[0];
  if (!id) {
    failTask('atris task done', 'missing_id', 'id required');
  }
  const failed = hasFlag(args, '--failed');
  const proof = proofFlagValue(args);
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const taskId = requireTaskId(taskDb, db, id, 'atris task done');
  const actor = String(flag(args, '--as') || DEFAULT_OWNER);
  const beforeTask = taskDb.getTask(db, taskId);
  const hasReview = hasFlag(args, '--review') || flag(args, '--lesson') || flag(args, '--next') || flag(args, '--proof') || flag(args, '--reward');
  if (agentProofOnlyMode() && !failed) {
    failAgentProofOnly(
      'atris task done',
      'Agent proof-only mode cannot mark tasks done. Use `atris task ready <id> --proof "..."` or `atris task review <id> --reward 0 --proof "..."`.',
    );
  }
  const canComplete = beforeTask && (beforeTask.status === 'open' || beforeTask.status === 'claimed');
  if (canComplete) {
    if (!failed || hasReview) requireMeaningfulTaskProof('atris task done', proof);
    else if (proof) requireMeaningfulTaskProof('atris task done', proof);
  }
  const result = taskDb.doneTask(db, { id: taskId, status: failed ? 'failed' : 'done', actor });
  if (result.updated) {
    const review = hasReview ? taskDb.reviewTask(db, {
      id: taskId,
      actor,
      reward: flag(args, '--reward') || (failed ? 0 : 1),
      lesson: typeof flag(args, '--lesson') === 'string' ? flag(args, '--lesson') : '',
      nextTask: typeof flag(args, '--next') === 'string' ? flag(args, '--next') : '',
      proof,
      careerXpEligible: false,
    }) : null;
    const xpProjection = refreshCareerXpAfterReview(review);
    const { projection, outPath } = writeDefaultProjection(taskDb, db);
    if (wantsJson(args)) {
      printJson({
        ok: true,
        action: failed ? 'failed' : 'done',
        task_id: taskId,
        reviewed: Boolean(review && review.reviewed),
        reward: review && review.episode ? review.episode.reward.value : null,
        episode: review && review.episode || null,
        xp_projection: xpProjection,
        projection_path: outPath,
        task: compactTaskFromProjection(projection, taskId),
      });
      return;
    }
    const task = compactTaskFromProjection(projection, taskId);
    if (review && review.reviewed) {
      console.log(`${failed ? 'failed' : 'done'} ${taskRef(task)} reward=${review.episode.reward.value}`);
    } else {
      console.log(`${failed ? 'failed' : 'done'} ${taskRef(task)}`);
    }
  } else {
    const detail = `done failed: ${taskId} not in open|claimed`;
    if (wantsJson(args)) {
      printJson({
        ok: false,
        command: 'atris task done',
        reason: 'not_open_or_claimed',
        task_id: taskId,
        detail,
      });
      process.exit(1);
    }
    console.error(detail);
    process.exit(1);
  }
}

function cmdFinish(args) {
  const pos = positional(args);
  const id = pos[0];
  if (!id) {
    failTask('atris task finish', 'missing_id', 'id required');
  }
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const taskId = requireTaskId(taskDb, db, id, 'atris task finish');
  const currentTask = taskDb.getTask(db, taskId);
  const actor = String(flag(args, '--as') || DEFAULT_OWNER);
  const proof = proofFlagValue(args);
  const failed = hasFlag(args, '--failed');
  const hasReview = hasFlag(args, '--review') || flag(args, '--lesson') || flag(args, '--next') || flag(args, '--proof') || flag(args, '--reward');
  if (agentProofOnlyMode() && !failed) {
    failAgentProofOnly(
      'atris task finish',
      'Agent proof-only mode cannot finish tasks. Use `atris task ready <id> --proof "..."` or `atris task review <id> --reward 0 --proof "..."`.',
    );
  }
  const canComplete = currentTask && (currentTask.status === 'open' || currentTask.status === 'claimed');
  if (canComplete) {
    if (!failed || hasReview) requireMeaningfulTaskProof('atris task finish', proof);
    else if (proof) requireMeaningfulTaskProof('atris task finish', proof);
  }
  const done = taskDb.doneTask(db, { id: taskId, status: failed ? 'failed' : 'done', actor });
  if (!done.updated) {
    const detail = `finish failed: ${taskId} not in open|claimed`;
    if (wantsJson(args)) {
      printJson({
        ok: false,
        command: 'atris task finish',
        reason: 'not_open_or_claimed',
        task_id: taskId,
        detail,
      });
      process.exit(1);
    }
    console.error(detail);
    process.exit(1);
  }
  if (hasReview) {
    const result = taskDb.reviewTask(db, {
      id: taskId,
      actor,
      reward: flag(args, '--reward') || 1,
      lesson: typeof flag(args, '--lesson') === 'string' ? flag(args, '--lesson') : '',
      nextTask: typeof flag(args, '--next') === 'string' ? flag(args, '--next') : '',
      proof,
      careerXpEligible: false,
    });
    const nextCreated = createNextTaskIfRequested(taskDb, db, args, currentTask, result.episode.next_task_suggestion);
    const xpProjection = refreshCareerXpAfterReview(result);
    const { projection, outPath } = writeDefaultProjection(taskDb, db);
    if (wantsJson(args)) {
      printJson({
        ok: true,
        action: 'finished',
        task_id: taskId,
        reviewed: true,
        reward: result.episode.reward.value,
        episode: result.episode,
        xp_projection: xpProjection,
        next_task_id: nextCreated ? nextCreated.id : null,
        projection_path: outPath,
        task: compactTaskFromProjection(projection, taskId),
        next_task: nextCreated ? compactTaskFromProjection(projection, nextCreated.id) : null,
      });
      return;
    }
    console.log(`finished ${taskRef(compactTaskFromProjection(projection, taskId))} reward=${result.episode.reward.value}`);
    if (result.episode.next_task_suggestion) console.log(`next: ${result.episode.next_task_suggestion}`);
    if (nextCreated) console.log(`created next ${taskRef(compactTaskFromProjection(projection, nextCreated.id))}`);
    return;
  }
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'finished',
      task_id: taskId,
      reviewed: false,
      projection_path: outPath,
      task: compactTaskFromProjection(projection, taskId),
    });
    return;
  }
  console.log(`finished ${taskRef(compactTaskFromProjection(projection, taskId))}`);
}

function cmdReady(args) {
  const pos = positional(args);
  const id = pos[0];
  if (!id) {
    console.error('atris task ready: id required');
    process.exit(2);
  }
  const proof = flag(args, '--proof');
  if (!proof || proof === true) {
    console.error('atris task ready: --proof required');
    process.exit(2);
  }
  requireMeaningfulTaskProof('atris task ready', String(proof));
  const lesson = flag(args, '--lesson') || '';
  const nextTaskInput = normalizeReviewNextTaskInput(typeof flag(args, '--next') === 'string' ? flag(args, '--next') : '');
  const actor = String(flag(args, '--as') || DEFAULT_OWNER);
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const taskId = requireTaskId(taskDb, db, id, 'atris task ready');
  const result = taskDb.readyTask(db, {
    id: taskId,
    actor,
    proof: String(proof),
    lesson: typeof lesson === 'string' ? lesson : '',
    nextTask: nextTaskInput.nextTask,
  });
  if (!result.ready) {
    console.error(`ready failed: ${result.reason}`);
    process.exit(1);
  }
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  const agentCertified = result.event.payload.agent_certified === true;
  const projectionTask = taskFromProjection(projection, taskId)
    || compactTaskFromProjection(projection, taskId)
    || result.row;
  const verifierTask = taskWithReviewEvidence(taskWithAgentCertification(projectionTask, agentCertified), {
    proof: String(proof),
    lesson: typeof lesson === 'string' ? lesson : '',
    nextTask: nextTaskInput.nextTask,
  });
  const reviewChat = taskReviewChatHandoff(verifierTask, { reviewer: 'codex-review' });
  const handoff = {
    native_goal_status: agentCertified ? 'agent_certified' : 'needs_second_agent_review',
    career_xp_status: 'pending_human_accept',
    next_action: agentCertified ? certifiedReviewNextAction(nextTaskInput.nextTask) : 'agent_review_again',
    rule: agentCertified
      ? 'Agent double-check complete; continue work. AgentXP waits for human accept.'
      : 'Proof is in Review; one more agent review pass certifies continuation. AgentXP waits for human accept.',
  };
  if (reviewChat) {
    handoff.review_chat_command = reviewChat.command;
    handoff.codex_prompt = reviewChat.codex_prompt;
    handoff.verification_focus = reviewChat.verification_focus;
  }
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'ready',
      task_id: taskId,
      version: result.event.version,
      approval_status: 'pending',
      review_pass_count: result.event.payload.review_pass_count,
      agent_certified: agentCertified,
      handoff,
      ...(nextTaskInput.ignored ? { review_next_task_ignored: nextTaskInput.ignored } : {}),
      projection_path: outPath,
      task: compactTaskFromProjection(projection, taskId),
    });
    return;
  }
  console.log(`ready ${taskRef(compactTaskFromProjection(projection, taskId))} v${result.event.version} pending approval`);
  console.log(handoff.rule);
}

function cmdAccept(args) {
  const pos = positional(args);
  const id = pos[0];
  if (!id) {
    console.error('atris task accept: id required');
    process.exit(2);
  }
  const actor = String(flag(args, '--as') || DEFAULT_OWNER);
  const reward = flag(args, '--reward');
  const lessonFlag = flag(args, '--lesson');
  const nextTaskFlag = flag(args, '--next');
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const taskId = requireTaskId(taskDb, db, id, 'atris task accept');
  if (agentProofOnlyMode()) {
    failAgentProofOnly(
      'atris task accept',
      'Agent proof-only mode cannot accept tasks or award XP. Leave proof in Review for human accept/revise.',
    );
  }
  const beforeProjection = enrichTaskProjection(taskDb.taskProjection(db, { taskId }));
  const beforeTask = beforeProjection.tasks[0] || null;
  const proofFlag = flag(args, '--proof');
  const hasExplicitProof = typeof proofFlag === 'string';
  const proof = hasExplicitProof
    ? proofFlag
    : String(beforeTask?.metadata?.latest_agent_proof || '').trim();
  if (!proof) {
    console.error('atris task accept: proof required or task must already have fresh proof_ready proof');
    process.exit(2);
  }
  requireMeaningfulTaskProof('atris task accept', proof);
  const readyReview = beforeTask?.review || {};
  const clearLesson = hasEmptyFlagValue(args, '--lesson');
  const clearNextTask = hasEmptyFlagValue(args, '--next');
  const lesson = clearLesson
    ? ''
    : typeof lessonFlag === 'string'
    ? lessonFlag
    : String(readyReview.lesson || beforeTask?.metadata?.latest_agent_lesson || '');
  const nextTask = clearNextTask
    ? ''
    : typeof nextTaskFlag === 'string'
    ? nextTaskFlag
    : String(readyReview.next_task || beforeTask?.metadata?.latest_agent_next_task || '');
  const clearedFields = [];
  if (clearLesson || (typeof lessonFlag === 'string' && !String(lessonFlag).trim())) clearedFields.push('lesson');
  if (clearNextTask || (typeof nextTaskFlag === 'string' && !String(nextTaskFlag).trim())) clearedFields.push('next_task');
  const parsedReward = parseAcceptReward(reward);
  if (!parsedReward.ok) {
    console.error('atris task accept: reward must be a positive number');
    process.exit(2);
  }
  const done = taskDb.doneTask(db, { id: taskId, status: 'done', actor, allowReview: true });
  if (!done.updated) {
    console.error(`accept failed: ${taskId} not open|claimed|review`);
    process.exit(1);
  }
  const reviewed = taskDb.reviewTask(db, {
    id: taskId,
    actor,
    reward: parsedReward.value,
    lesson,
    nextTask,
    proof,
    careerXpEligible: true,
    clearedFields,
  });
  const xpProjection = refreshCareerXpAfterReview(reviewed);
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'accepted',
      task_id: taskId,
      reviewed: true,
      reward: reviewed.episode.reward.value,
      episode: reviewed.episode,
      xp_projection: xpProjection,
      projection_path: outPath,
      task: compactTaskFromProjection(projection, taskId),
    });
    return;
  }
  console.log(`accepted ${taskRef(compactTaskFromProjection(projection, taskId))} reward=${reviewed.episode.reward.value}`);
}

function stampAutoAcceptMetadata(taskDb, db, taskId, actor, policy) {
  const row = taskDb.getTask(db, taskId);
  if (!row) return;
  const metadata = row.metadata && typeof row.metadata === 'object' ? { ...row.metadata } : {};
  metadata.auto_accepted_at = new Date().toISOString();
  metadata.auto_accepted_by = actor;
  metadata.auto_accept_policy = policy;
  db.prepare(`
    UPDATE tasks
       SET metadata = ?,
           updated_at = ?
     WHERE id = ?
  `).run(JSON.stringify(metadata), Date.now(), taskId);
}

function acceptReviewTask(taskDb, db, taskId, { actor, proof, reward, lesson = '', nextTask = '' }) {
  const done = taskDb.doneTask(db, { id: taskId, status: 'done', actor, allowReview: true });
  if (!done.updated) {
    return { ok: false, reason: 'not_open_claimed_or_review' };
  }
  const reviewed = taskDb.reviewTask(db, {
    id: taskId,
    actor,
    reward,
    lesson,
    nextTask,
    proof,
    careerXpEligible: true,
  });
  return { ok: true, reviewed };
}

function cmdAutoAcceptCertified(args) {
  const dryRun = hasFlag(args, '--dry-run');
  const strictVerify = hasFlag(args, '--strict-verify');
  const actorFlag = flag(args, '--as');
  const actor = String(actorFlag || 'auto-accept-certified');
  const hasHumanActor = validHumanActorFlag(actorFlag);
  const confirmedHumanAccept = hasFlag(args, '--confirm-human-accept');
  const limitRaw = flag(args, '--limit');
  const max = limitRaw && limitRaw !== true ? Math.max(1, Number(limitRaw) || 12) : 12;
  const parsedReward = parseAcceptReward(flag(args, '--reward'));
  if (!parsedReward.ok) {
    console.error('atris task auto-accept-certified: reward must be a positive number');
    process.exit(2);
  }
  if (!dryRun && !confirmedHumanAccept) {
    failTask(
      'atris task auto-accept-certified',
      'human_accept_confirmation_required',
      'live auto-accept requires --confirm-human-accept --as <human>; use --dry-run to preview',
    );
  }
  if (!dryRun && !hasHumanActor) {
    failTask(
      'atris task auto-accept-certified',
      'human_actor_required',
      'live auto-accept requires --as <human> so XP has an explicit human acceptance actor',
    );
  }
  if (agentProofOnlyMode() && !dryRun) {
    failAgentProofOnly(
      'atris task auto-accept-certified',
      'Agent proof-only mode can preview certified rows with --dry-run, but cannot live-accept them.',
    );
  }

  const taskDb = getTaskDb();
  const db = taskDb.open();
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  const queue = taskReviewQueue(projection, ['--limit', String(max)]);
  const results = [];

  for (const item of queue.items) {
    const fullProjection = enrichTaskProjection(taskDb.taskProjection(db, { taskId: item.id }));
    const task = fullProjection.tasks[0] || null;
    if (!task) {
      results.push({ ref: item.display_id || item.id, eligible: false, reason: 'task_not_found', action: 'skipped' });
      continue;
    }
    const evaluation = evaluateAutoAccept(task, { strictVerify });
    if (!evaluation.eligible) {
      results.push({ ...evaluation, action: 'skipped' });
      continue;
    }
    if (dryRun) {
      results.push({ ...evaluation, action: 'would_accept', reward: parsedReward.value });
      continue;
    }
    const accepted = acceptReviewTask(taskDb, db, task.id, {
      actor,
      proof: evaluation.proof,
      reward: parsedReward.value,
      lesson: String(task.review?.lesson || task.metadata?.latest_agent_lesson || ''),
      nextTask: String(task.review?.next_task || task.metadata?.latest_agent_next_task || ''),
    });
    if (!accepted.ok) {
      results.push({ ...evaluation, action: 'accept_failed', reason: accepted.reason });
      continue;
    }
    stampAutoAcceptMetadata(taskDb, db, task.id, actor, evaluation.policy);
    refreshCareerXpAfterReview(accepted.reviewed);
    results.push({
      ...evaluation,
      action: 'accepted',
      reward: accepted.reviewed.episode.reward.value,
      task_id: task.id,
    });
  }

  const { projection: finalProjection, outPath: finalPath } = writeDefaultProjection(taskDb, db);
  const summary = {
    scanned: queue.items.length,
    accepted: results.filter(row => row.action === 'accepted').length,
    would_accept: results.filter(row => row.action === 'would_accept').length,
    skipped: results.filter(row => row.action === 'skipped').length,
    failed: results.filter(row => row.action === 'accept_failed').length,
  };
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: dryRun ? 'auto_accept_certified_dry_run' : 'auto_accept_certified',
      strict_verify: strictVerify,
      summary,
      ...summary,
      results,
      projection_path: finalPath,
      queue,
    });
    return;
  }
  console.log(`AUTO-ACCEPT CERTIFIED (${dryRun ? 'dry-run' : 'execute'})`);
  console.log(`${summary.accepted || summary.would_accept} accepted / ${summary.skipped} skipped / ${summary.failed} failed / ${summary.scanned} scanned`);
  for (const row of results) {
    const nextAction = row.next_action ? ` next_action=${row.next_action}` : '';
    const reviewChat = row.review_chat_command ? ` review_chat=${row.review_chat_command}` : '';
    console.log(`${row.action.toUpperCase()} ${row.ref}: ${row.reason}${row.reward ? ` reward=${row.reward}` : ''}${nextAction}${reviewChat}`);
  }
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
      projection_path: outPath,
      task: compactTaskFromProjection(projection, taskId),
    });
    return;
  }
  console.log(`revise ${taskRef(compactTaskFromProjection(projection, taskId))} v${result.event.version}`);
}

function cmdReview(args) {
  const pos = positional(args);
  const id = pos[0];
  if (!id) {
    failTask('atris task review', 'missing_id', 'id required');
  }
  const reward = flag(args, '--reward');
  const lessonFlag = flag(args, '--lesson');
  const nextTaskFlag = flag(args, '--next');
  const clearLesson = hasEmptyFlagValue(args, '--lesson');
  const clearNextTask = hasEmptyFlagValue(args, '--next');
  const lesson = clearLesson
    ? ''
    : typeof lessonFlag === 'string'
    ? lessonFlag
    : '';
  const nextTaskInput = normalizeReviewNextTaskInput(
    clearNextTask
      ? ''
      : typeof nextTaskFlag === 'string'
      ? nextTaskFlag
      : ''
  );
  const clearedFields = [];
  if (clearLesson || (typeof lessonFlag === 'string' && !String(lessonFlag).trim())) clearedFields.push('lesson');
  if (clearNextTask || (typeof nextTaskFlag === 'string' && !String(nextTaskFlag).trim())) clearedFields.push('next_task');
  const proof = proofFlagValue(args);
  const verify = textFlag(args, ['--verify']);
  const actor = flag(args, '--as') || DEFAULT_OWNER;
  const rewardValue = reward === true || reward === null ? 0 : reward;
  if (agentProofOnlyMode() && Number(rewardValue) > 0) {
    failAgentProofOnly(
      'atris task review',
      'Agent proof-only mode allows verifier notes with `--reward 0` only. Positive reward and acceptance stay human-gated.',
    );
  }
  if (Number(rewardValue) > 0 || proof) {
    requireMeaningfulTaskProof('atris task review', proof);
  }
  if (verify) {
    const parsedVerify = parseVerifyCommand(verify);
    if (!parsedVerify.ok) {
      failTask(
        'atris task review',
        parsedVerify.reason || 'invalid_verify_command',
        'Verify command must be a safe simple command accepted by strict auto-accept.',
      );
    }
  }
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const taskId = requireTaskId(taskDb, db, id, 'atris task review');
  const currentTask = taskDb.getTask(db, taskId);
  const result = taskDb.reviewTask(db, {
    id: taskId,
    actor: String(actor),
    reward: rewardValue,
    lesson: typeof lesson === 'string' ? lesson : '',
    nextTask: nextTaskInput.nextTask,
    proof,
    verify,
    careerXpEligible: false,
    clearedFields,
  });
  if (!result.reviewed) {
    console.error(`review failed: ${result.reason}`);
    process.exit(1);
  }
  const nextCreated = createNextTaskIfRequested(taskDb, db, args, currentTask, result.episode.next_task_suggestion);
  const xpProjection = refreshCareerXpAfterReview(result);
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'reviewed',
      task_id: taskId,
      version: result.event.version,
      reward: result.episode.reward.value,
      episode: result.episode,
      xp_projection: xpProjection,
      next_task_id: nextCreated ? nextCreated.id : null,
      ...(nextTaskInput.ignored ? { review_next_task_ignored: nextTaskInput.ignored } : {}),
      projection_path: outPath,
      task: compactTaskFromProjection(projection, taskId),
      next_task: nextCreated ? compactTaskFromProjection(projection, nextCreated.id) : null,
    });
    return;
  }
  console.log(`reviewed ${taskRef(compactTaskFromProjection(projection, taskId))} v${result.event.version} reward=${result.episode.reward.value}`);
  if (result.episode.next_task_suggestion) console.log(`next: ${result.episode.next_task_suggestion}`);
  if (nextCreated) console.log(`created next ${taskRef(compactTaskFromProjection(projection, nextCreated.id))}`);
}

function importTodoFile(taskDb, db, target) {
  const filePath = path.resolve(target);
  if (!fs.existsSync(filePath)) {
    return { ok: false, reason: 'not_found', filePath };
  }
  const { parseTodoFile } = require('../lib/todo-fallback');
  const parsed = parseTodoFile(filePath);
  const ws = taskDb.workspaceRoot();
  const all = [
    ...parsed.backlog.map(t => ({ ...t, importStatus: 'open' })),
    ...parsed.inProgress.map(t => ({ ...t, importStatus: 'claimed' })),
    ...(parsed.review || []).map(t => ({ ...t, importStatus: 'review' })),
  ];
  let inserted = 0;
  let skipped = 0;
  for (const t of all) {
    if (!t.title) continue;
    const sk = taskDb.sourceKey(filePath, t.title);
    const result = taskDb.addTask(db, {
      title: t.title,
      tag: t.tag || null,
      workspaceRoot: ws,
      sourceKey: sk,
      status: t.importStatus,
      claimedBy: t.claimed || null,
      metadata: { todo_id: t.id, todo_tags: t.tags || [], claimed: t.claimed, stage: t.stage, verify: t.verify },
    });
    if (result.inserted) inserted++; else skipped++;
  }
  return { ok: true, inserted, skipped, filePath };
}

function cmdImport(args) {
  const pos = positional(args);
  const target = pos[0] || 'atris/TODO.md';
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const result = importTodoFile(taskDb, db, target);
  if (!result.ok) {
    console.error(`atris task import: file not found: ${result.filePath}`);
    process.exit(2);
  }
  const { inserted, skipped, filePath } = result;
  const { outPath } = writeDefaultProjection(taskDb, db);
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'imported',
      inserted,
      skipped,
      source: filePath,
      projection_path: outPath,
    });
    return;
  }
  console.log(`imported ${inserted} new, skipped ${skipped} (already imported), source=${filePath}`);
}

function cmdWhere(args) {
  const taskDb = getTaskDb();
  if (wantsJson(args)) {
    printJson({
      ok: true,
      db: taskDb.getDbPath(),
      workspace: taskDb.workspaceRoot(),
      owner: DEFAULT_OWNER,
    });
    return;
  }
  console.log(`db:        ${taskDb.getDbPath()}`);
  console.log(`workspace: ${taskDb.workspaceRoot()}`);
  console.log(`owner:     ${DEFAULT_OWNER}`);
}

function cmdEvents(args) {
  const pos = positional(args);
  let taskId = pos[0] || null;
  const all = hasFlag(args, '--all');
  const rawLimit = flag(args, '--limit');
  const explicitLimit = rawLimit && rawLimit !== true ? Number(rawLimit) : null;
  const defaultRecentLimit = 24;
  const limit = explicitLimit || (taskId ? 500 : (all ? null : defaultRecentLimit));
  const taskDb = getTaskDb();
  const db = taskDb.open();
  if (taskId) taskId = requireTaskId(taskDb, db, taskId, 'atris task events');
  const events = taskDb.listTaskEvents(db, {
    taskId,
    workspaceRoot: all || taskId ? null : taskDb.workspaceRoot(),
    limit,
    order: taskId || all ? 'asc' : 'desc',
  });
  const refRows = taskDb.listTasks(db, {
    workspaceRoot: all ? null : (taskId ? (taskDb.getTask(db, taskId) || {}).workspace_root : taskDb.workspaceRoot()),
  });
  const refById = taskDb.taskDisplayRefMap(refRows);
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'events',
      task_id: taskId,
      mode: taskId ? 'task' : (all ? 'ledger' : 'recent'),
      limit,
      events,
    });
    return;
  }
  if (events.length === 0) {
    console.log('(no task events)');
    return;
  }
  if (!taskId && !all) {
    console.log('TASK EVENTS');
    console.log(`recent ${events.length} event${events.length === 1 ? '' : 's'} (use --all for the full ledger, --limit N to adjust)`);
    console.log('');
    for (const e of events) console.log(formatTaskEventCompact(e, refById));
    return;
  }
  for (const e of events) {
    const actor = e.actor ? ` actor=${e.actor}` : '';
    console.log(`${e.version}\t${e.event_type}\t${refById.get(e.task_id) || taskRef(e.task_id)}${actor}\t${JSON.stringify(e.payload || {})}`);
  }
}

function cmdExport(args) {
  const out = flag(args, '--out') || path.join('.atris', 'state', 'tasks.projection.json');
  const all = hasFlag(args, '--all');
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const outPath = path.resolve(String(out));
  const projection = enrichTaskProjection(taskDb.taskProjection(db, {
    workspaceRoot: all ? null : taskDb.workspaceRoot(),
    limit: 500,
  }));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(projection, null, 2) + '\n', 'utf8');
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'exported',
      count: projection.tasks.length,
      projection_path: outPath,
      projection,
    });
    return;
  }
  console.log(`exported ${projection.tasks.length} task${projection.tasks.length === 1 ? '' : 's'} -> ${outPath}`);
}

function cmdSetup(args) {
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const ws = taskDb.workspaceRoot();
  let importResult = null;
  if (hasFlag(args, '--import-todo')) {
    importResult = importTodoFile(taskDb, db, flag(args, '--todo') || 'atris/TODO.md');
    if (!importResult.ok && flag(args, '--todo')) {
      console.error(`atris task setup: TODO file not found: ${importResult.filePath}`);
      process.exit(2);
    }
  }
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'setup',
      count: projection.tasks.length,
      projection_path: outPath,
      import: importResult && importResult.ok ? {
        inserted: importResult.inserted,
        skipped: importResult.skipped,
        source: importResult.filePath,
      } : null,
      projection,
    });
    return;
  }
  console.log(`tasks ready: ${projection.tasks.length} task${projection.tasks.length === 1 ? '' : 's'}`);
  console.log(`projection: ${outPath}`);
  if (importResult && importResult.ok) {
    console.log(`imported ${importResult.inserted} new, skipped ${importResult.skipped}`);
  }
}

function extractTodoSectionMarkdown(content, sectionName) {
  const escaped = String(sectionName || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(content || '').match(new RegExp(`(?:^|\\n)(##\\s+${escaped}[^\\n]*\\n[\\s\\S]*?)(?=\\n##(?!#)\\s+|$)`, 'i'));
  return match ? match[1].trimEnd() : null;
}

function normalizeRenderedTaskRef(value) {
  return String(value || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}

function renderedTaskRefSet(taskDb, rows, refRows) {
  const byId = new Map();
  for (const row of [...(Array.isArray(rows) ? rows : []), ...(Array.isArray(refRows) ? refRows : [])]) {
    if (row && row.id && !byId.has(row.id)) byId.set(row.id, row);
  }
  const displayRows = taskDb.withTaskDisplayRefs([...byId.values()]);
  const refs = new Set();
  for (const row of displayRows) {
    for (const value of [row.id, row.display_id, row.legacy_ref]) {
      const ref = normalizeRenderedTaskRef(value);
      if (ref) refs.add(ref);
    }
  }
  return refs;
}

function markdownRowsForRender(taskDb, existingTodoPath, rows, refRows) {
  if (!existingTodoPath || !fs.existsSync(existingTodoPath)) return [];
  const { parseTodoFile } = require('../lib/todo-fallback');
  const existingTodo = fs.readFileSync(existingTodoPath, 'utf8');
  const generatedTodo = existingTodo.includes('Regenerated from durable Atris task state');
  const parsed = parseTodoFile(existingTodoPath);
  const ws = taskDb.workspaceRoot();
  const existingRefs = renderedTaskRefSet(taskDb, rows, refRows);
  const existingSourceKeys = new Set(
    (Array.isArray(refRows) ? refRows : [])
      .map(row => row && row.source_key)
      .filter(Boolean)
  );
  const existingTitles = new Set(
    [...(Array.isArray(rows) ? rows : []), ...(Array.isArray(refRows) ? refRows : [])]
      .map(row => taskDb.normalizeTitle(row && row.title))
      .filter(Boolean)
  );
  const sections = [
    ['backlog', 'open'],
    ['inProgress', 'claimed'],
    ['review', 'review'],
    ['completed', 'done'],
  ];
  const out = [];
  let index = 0;
  for (const [bucket, status] of sections) {
    for (const task of parsed[bucket] || []) {
      if (!task.title) continue;
      const sk = taskDb.sourceKey(existingTodoPath, task.title);
      const normalizedTitle = taskDb.normalizeTitle(task.title);
      const renderedRef = normalizeRenderedTaskRef(task.id);
      if (
        (renderedRef && existingRefs.has(renderedRef)) ||
        (sk && existingSourceKeys.has(sk)) ||
        existingTitles.has(normalizedTitle) ||
        generatedTodo
      ) continue;
      out.push({
        id: `markdown:${status}:${task.id || index}:${sk ? sk.slice(0, 10) : index}`,
        title: task.title,
        status,
        tag: task.tag || null,
        workspace_root: ws,
        claimed_by: status === 'claimed' ? (task.claimed || null) : null,
        created_at: index,
        updated_at: index,
        done_at: null,
        metadata: {
          todo_id: task.id || null,
          todo_tags: task.tags || [],
          claimed: task.claimed || null,
          stage: task.stage || null,
          verify: task.verify || null,
          markdown_source: existingTodoPath,
        },
      });
      if (sk) existingSourceKeys.add(sk);
      existingTitles.add(normalizedTitle);
      index += 1;
    }
  }
  return out;
}

function cmdRender(args) {
  const out = flag(args, '--out') || path.join('atris', 'TODO.md');
  const all = hasFlag(args, '--all');
  const doneLimitRaw = flag(args, '--done-limit');
  const doneLimit = doneLimitRaw && doneLimitRaw !== true ? Number(doneLimitRaw) : undefined;
  const failedLimitRaw = flag(args, '--failed-limit');
  const failedLimit = failedLimitRaw && failedLimitRaw !== true ? Number(failedLimitRaw) : undefined;
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const rows = taskDb.listTasks(db, {
    workspaceRoot: all ? null : taskDb.workspaceRoot(),
    limit: 500,
  });
  const refRows = taskDb.listTasks(db, {
    workspaceRoot: all ? null : taskDb.workspaceRoot(),
  });
  const outPath = path.resolve(String(out));
  const existingTodo = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : '';
  const preservedSections = [];
  const endgameSection = extractTodoSectionMarkdown(existingTodo, 'Endgame');
  if (endgameSection) preservedSections.push(endgameSection);
  const markdownRows = markdownRowsForRender(taskDb, outPath, rows, refRows);
  const rowsToRender = [...rows, ...markdownRows];
  const markdown = taskDb.renderTodoMarkdown(rowsToRender, { doneLimit, failedLimit, refRows, preservedSections });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, markdown, 'utf8');
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'rendered',
      count: rowsToRender.length,
      path: outPath,
    });
    return;
  }
  console.log(`rendered ${rowsToRender.length} task${rowsToRender.length === 1 ? '' : 's'} -> ${outPath}`);
}

function cmdSync(args) {
  const dryRun = hasFlag(args, '--dry-run');
  const businessIdFlag = flag(args, '--business-id');
  if (!dryRun) {
    console.error('atris task sync: only --dry-run is supported right now');
    process.exit(2);
  }

  const taskDb = getTaskDb();
  const db = taskDb.open();
  const binding = readLocalBusinessBinding(taskDb.workspaceRoot());
  const businessId = String(
    businessIdFlag && businessIdFlag !== true
      ? businessIdFlag
      : binding && (binding.business_id || binding.id) || ''
  ).trim();
  if (!businessId) {
    const detail = 'business id required: run inside a business workspace or pass --business-id <id>';
    if (wantsJson(args)) {
      printJson({ ok: false, action: 'sync_plan', reason: 'missing_business_id', detail });
      return;
    }
    console.error(`atris task sync: ${detail}`);
    process.exit(2);
  }

  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  const plan = syncPlanForProjection(projection, businessId);
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'sync_plan',
      dry_run: true,
      business_id: businessId,
      workspace_root: projection.workspace_root,
      projection_path: outPath,
      planned_writes: plan.length,
      plan,
    });
    return;
  }

  console.log(`task sync dry-run: ${plan.length} planned write${plan.length === 1 ? '' : 's'}`);
  console.log(`business: ${businessId}`);
  const refById = taskDb.taskDisplayRefMap(projection.tasks || []);
  for (const item of plan) {
    console.log(`${item.method.padEnd(5)} ${item.endpoint} <= ${refById.get(item.local_task_id) || taskRef(item.local_task_id)} ${item.body.title}`);
    for (const followup of item.after_create || []) {
      console.log(`      then ${followup.method} ${followup.endpoint} state=${followup.body.state}`);
    }
  }
}

function taskColumn(task) {
  if (task.status === 'open') return taskIsPlannedOpen(task) ? 'open' : 'backlog';
  if (task.status === 'claimed') return 'doing';
  if (task.status === 'review') return 'review';
  if (task.status === 'failed' && taskHasReview(task)) return 'done';
  if (task.status === 'failed') return 'blocked';
  if (task.status === 'done' && !taskHasReview(task)) return 'review';
  return 'done';
}

function taskHasReview(task) {
  if (task.latest_event_type === 'reviewed') return true;
  const review = task.review || {};
  return review.reward != null || Boolean(review.proof || review.lesson || review.next_task);
}

function taskBoardHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Atris Task Factory</title>
  <style>
    :root { color-scheme: dark; --bg:#101113; --panel:#17191d; --line:#292d34; --text:#f0f2f5; --muted:#9299a6; --accent:#68d391; --warn:#f6c177; --bad:#f38ba8; }
    * { box-sizing: border-box; }
    body { margin:0; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:var(--bg); color:var(--text); }
    header { height:56px; display:flex; align-items:center; justify-content:space-between; padding:0 18px; border-bottom:1px solid var(--line); background:#121418; }
    h1 { font-size:15px; margin:0; font-weight:650; letter-spacing:0; }
    .sub { color:var(--muted); font-size:12px; }
    main { display:grid; grid-template-columns: 320px 1fr; height:calc(100vh - 56px); }
    aside { border-right:1px solid var(--line); padding:14px; overflow:auto; background:#121418; }
    section { min-width:0; overflow:auto; padding:14px; }
    label { display:block; color:var(--muted); font-size:11px; margin:10px 0 5px; }
    input, textarea, select { width:100%; border:1px solid var(--line); background:#0d0f12; color:var(--text); border-radius:7px; padding:9px 10px; font:inherit; font-size:13px; }
    textarea { min-height:82px; resize:vertical; }
    button { border:1px solid var(--line); background:#20242a; color:var(--text); border-radius:7px; padding:8px 10px; font:inherit; font-size:12px; cursor:pointer; }
    button:hover { border-color:#3b414b; background:#252a32; }
    .primary { background:#214b35; border-color:#2f684a; }
    .grid { display:grid; grid-template-columns: repeat(var(--board-columns, 6), minmax(160px, 1fr)); gap:12px; align-items:start; }
    .overview { display:grid; grid-template-columns: minmax(260px, 1.4fr) minmax(260px, 1fr); gap:12px; margin-bottom:12px; }
    .goalbox, .chainbox { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:11px; min-height:88px; }
    .goalbox h2, .chainbox h2 { margin:0 0 8px; color:var(--muted); font-size:12px; font-weight:650; }
    .goalitem { font-size:13px; line-height:1.3; margin:5px 0; }
    .chainitem { display:grid; grid-template-columns:72px 1fr; gap:8px; font-size:12px; line-height:1.3; margin:5px 0; color:var(--muted); }
    .chainitem strong { color:var(--text); font-weight:600; }
    .streams { display:grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap:12px; margin-bottom:12px; }
    .stream { background:#12161b; border:1px solid var(--line); border-radius:8px; padding:10px; min-height:126px; }
    .stream h2 { margin:0 0 8px; font-size:12px; color:var(--text); line-height:1.25; }
    .streambar { display:flex; height:7px; overflow:hidden; border-radius:999px; background:#0d0f12; border:1px solid var(--line); margin:8px 0; }
    .streambar span { display:block; min-width:2px; }
    .seg-open { background:#667085; }
    .seg-doing { background:#68d391; }
    .seg-review { background:#f6c177; }
    .seg-blocked { background:#f38ba8; }
    .streamtask { display:grid; grid-template-columns:64px 1fr; gap:8px; color:var(--muted); font-size:11px; line-height:1.25; margin-top:6px; }
    .streamtask strong { color:var(--text); font-weight:550; }
    .col { background:var(--panel); border:1px solid var(--line); border-radius:8px; min-height:160px; overflow:hidden; }
    .col h2 { margin:0; padding:10px 11px; font-size:12px; color:var(--muted); border-bottom:1px solid var(--line); display:flex; justify-content:space-between; }
    .cards { padding:8px; display:flex; flex-direction:column; gap:8px; }
    .card { text-align:left; width:100%; background:#111419; border:1px solid #252a31; border-radius:8px; padding:9px; }
    .card.active { border-color:#4c7a61; box-shadow:0 0 0 1px rgba(104,211,145,.2); }
    .title { font-size:13px; line-height:1.25; }
    .meta { margin-top:6px; color:var(--muted); font-size:11px; display:flex; gap:6px; flex-wrap:wrap; }
    .pill { border:1px solid var(--line); border-radius:999px; padding:1px 6px; }
    .why { margin-top:7px; color:var(--muted); font-size:11px; line-height:1.25; }
    .fact { margin:10px 0; background:#0d0f12; border:1px solid var(--line); border-radius:7px; padding:8px; font-size:12px; line-height:1.35; }
    .fact b { color:var(--muted); font-size:11px; display:block; margin-bottom:3px; }
    .room { margin-top:14px; border-top:1px solid var(--line); padding-top:12px; }
    .room h3 { margin:0 0 4px; font-size:14px; }
    .thread { margin:10px 0; display:flex; flex-direction:column; gap:7px; }
    .msg { background:#0d0f12; border:1px solid var(--line); border-radius:7px; padding:8px; font-size:12px; }
    .msg .who { color:var(--muted); font-size:11px; margin-bottom:3px; }
    .actions { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-top:10px; }
    .full { grid-column:1 / -1; }
    .empty { color:var(--muted); font-size:12px; padding:10px; }
    @media (max-width: 980px) { main { grid-template-columns:1fr; height:auto; } aside { border-right:0; border-bottom:1px solid var(--line); } .grid, .overview { grid-template-columns:1fr; } }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>Atris Task Factory</h1>
      <div class="sub" data-smoke="hello-from-ui">hello from UI</div>
    </div>
    <button id="refresh">Refresh</button>
  </header>
  <main>
    <aside>
      <form id="create">
        <label>New task</label>
        <textarea id="title" placeholder="Need something done..."></textarea>
        <label>Lane</label>
        <input id="tag" value="tasks">
        <button class="primary full" type="submit" style="margin-top:10px;width:100%">Create task</button>
      </form>
      <div class="room" id="room">
        <div class="empty">Select a task to open its room.</div>
      </div>
    </aside>
    <section>
      <div class="overview" id="overview"></div>
      <div class="streams" id="streams"></div>
      <div class="grid" id="board"></div>
    </section>
  </main>
  <script>
    const columns = [
      ['backlog', 'Backlog'],
      ['open', 'Open'],
      ['doing', 'Doing'],
      ['review', 'Review'],
      ['blocked', 'Blocked'],
      ['done', 'Done']
    ];
    const planTags = new Set(${JSON.stringify(Array.from(STATUS_PLAN_TAGS))});
    let state = { tasks: [] };
    let selected = null;
    const $ = (id) => document.getElementById(id);

    async function api(path, options = {}) {
      const res = await fetch(path, {
        ...options,
        headers: { 'content-type': 'application/json', ...(options.headers || {}) }
      });
      const data = await res.json();
      if (!res.ok || data.ok === false) throw new Error(data.detail || data.reason || 'request failed');
      return data;
    }

    function taskColumn(task) {
      if (task.status === 'open') {
        const metadata = task.metadata || {};
        const tag = String(task.tag || '').trim().toLowerCase().replace(/\\s+/g, '-');
        const stage = String(metadata.stage || '').trim().toLowerCase().replace(/\\s+/g, '-');
        const planned = planTags.has(tag) || planTags.has(stage) || metadata.verify || metadata.goal || metadata.loop || metadata.cron || metadata.next_run_at;
        return planned ? 'open' : 'backlog';
      }
      if (task.status === 'claimed') return 'doing';
      if (task.status === 'review') return 'review';
      const reviewed = task.latest_event_type === 'reviewed' || !!(task.review && (task.review.reward != null || task.review.proof || task.review.lesson || task.review.next_task));
      if (task.status === 'failed' && reviewed) return 'done';
      if (task.status === 'failed') return 'blocked';
      if (task.status === 'done' && !reviewed) return 'review';
      return 'done';
    }

    async function load() {
      const data = await api('/api/tasks');
      state = data.projection;
      render();
    }

    function render() {
      renderOverview();
      renderStreams();
      const board = $('board');
      board.style.setProperty('--board-columns', columns.length);
      board.innerHTML = '';
      for (const [key, label] of columns) {
        const tasks = state.tasks.filter((task) => taskColumn(task) === key);
        const col = document.createElement('div');
        col.className = 'col';
        col.innerHTML = '<h2><span>' + label + '</span><span>' + tasks.length + '</span></h2><div class="cards"></div>';
        const cards = col.querySelector('.cards');
        if (!tasks.length) cards.innerHTML = '<div class="empty">No tasks</div>';
        for (const task of tasks) cards.appendChild(card(task));
        board.appendChild(col);
      }
      renderRoom();
    }

    function taskById(id) {
      return state.tasks.find((task) => task.id === id) || null;
    }

    function renderOverview() {
      const active = state.tasks.filter((task) => task.status !== 'done');
      const reviewed = state.tasks.filter((task) => task.latest_event_type === 'reviewed');
      const goals = state.goals && state.goals.items || [];
      const goalHtml = goals.length
        ? goals.slice(0, 4).map((goal) => '<div class="goalitem"></div>').join('')
        : '<div class="empty">No atris/goals.md found. Add goals to give tasks a north star.</div>';
      const latest = reviewed.slice(0, 3);
      const chainHtml = latest.length
        ? latest.map((task) => '<div class="chainitem"><span>' + (task.display_id || task.id.slice(0, 8)) + '</span><strong></strong></div>').join('')
        : '<div class="empty">Complete a task with proof to start the chain.</div>';
      $('overview').innerHTML = [
        '<div class="goalbox"><h2>Goals</h2>' + goalHtml + '</div>',
        '<div class="chainbox"><h2>Compounding Chain</h2><div class="chainitem"><span>active</span><strong>' + active.length + ' open loops</strong></div>' + chainHtml + '</div>'
      ].join('');
      $('overview').querySelectorAll('.goalitem').forEach((el, i) => { el.textContent = goals[i]; });
      $('overview').querySelectorAll('.chainbox .chainitem strong').forEach((el, i) => {
        if (i === 0) return;
        const task = latest[i - 1];
        el.textContent = (task.review && task.review.next_task) ? task.title + ' -> ' + task.review.next_task : task.title;
      });
    }

    function renderStreams() {
      const streams = (state.streams || []).filter((stream) => stream.active_count || stream.done_count).slice(0, 6);
      const root = $('streams');
      if (!streams.length) {
        root.innerHTML = '';
        return;
      }
      root.innerHTML = streams.map((stream) => {
        const total = Math.max(1, stream.open_count + stream.doing_count + stream.review_count + stream.blocked_count);
        const widths = {
          open: Math.max(0, Math.round(stream.open_count / total * 100)),
          doing: Math.max(0, Math.round(stream.doing_count / total * 100)),
          review: Math.max(0, Math.round(stream.review_count / total * 100)),
          blocked: Math.max(0, Math.round(stream.blocked_count / total * 100))
        };
        const tasks = stream.tasks.filter((task) => task.status !== 'done').slice(0, 3);
        const taskHtml = tasks.length
          ? tasks.map((task) => '<div class="streamtask"><span>' + (task.display_id || task.id.slice(0, 8)) + '</span><strong></strong></div>').join('')
          : '<div class="empty">No active tasks in this stream.</div>';
        return [
          '<div class="stream">',
          '<h2></h2>',
          '<div class="meta"><span class="pill">' + stream.active_count + ' active</span><span class="pill">' + stream.done_count + ' done</span></div>',
          '<div class="streambar"><span class="seg-open" style="width:' + widths.open + '%"></span><span class="seg-doing" style="width:' + widths.doing + '%"></span><span class="seg-review" style="width:' + widths.review + '%"></span><span class="seg-blocked" style="width:' + widths.blocked + '%"></span></div>',
          taskHtml,
          '</div>'
        ].join('');
      }).join('');
      root.querySelectorAll('.stream h2').forEach((el, i) => { el.textContent = streams[i].objective; });
      root.querySelectorAll('.stream').forEach((streamEl, i) => {
        const tasks = streams[i].tasks.filter((task) => task.status !== 'done').slice(0, 3);
        streamEl.querySelectorAll('.streamtask strong').forEach((el, idx) => { el.textContent = tasks[idx].title; });
      });
    }

    function card(task) {
      const btn = document.createElement('button');
      btn.className = 'card' + (selected === task.id ? ' active' : '');
      btn.onclick = () => { selected = task.id; render(); };
      const owner = task.claimed_by ? '@' + task.claimed_by : 'unowned';
      btn.innerHTML = '<div class="title"></div><div class="meta"><span class="pill"></span><span class="pill"></span><span class="pill"></span></div><div class="why"></div>';
      btn.querySelector('.title').textContent = task.title;
      const pills = btn.querySelectorAll('.pill');
      pills[0].textContent = task.display_id || task.id.slice(0, 8);
      pills[1].textContent = owner;
      pills[2].textContent = 'v' + task.current_version;
      const why = task.objective || (task.lineage && task.lineage.parent_title) || (task.review && task.review.proof) || '';
      btn.querySelector('.why').textContent = why;
      return btn;
    }

    function renderRoom() {
      const task = state.tasks.find((t) => t.id === selected);
      const room = $('room');
      if (!task) {
        room.innerHTML = '<div class="empty">Select a task to open its room.</div>';
        return;
      }
      const messages = task.messages.map((m) => '<div class="msg"><div class="who">' + (m.actor || 'unknown') + ' / v' + m.version + '</div><div></div></div>').join('');
      const parent = task.lineage && task.lineage.parent_title ? task.lineage.parent_title : 'none';
      const children = task.lineage && task.lineage.child_titles && task.lineage.child_titles.length ? task.lineage.child_titles.join(' | ') : (task.review && task.review.next_task || 'none yet');
      room.innerHTML = [
        '<h3></h3>',
        '<div class="meta"><span class="pill">' + task.status + '</span><span class="pill">' + (task.claimed_by || 'unowned') + '</span><span class="pill">v' + task.current_version + '</span></div>',
        '<div class="fact"><b>Goal</b><div id="taskGoal"></div></div>',
        '<div class="fact"><b>Lineage</b><div id="taskLineage"></div></div>',
        '<div class="fact"><b>Summary</b><div id="taskSummary"></div></div>',
        '<div class="fact"><b>Proof / lesson</b><div id="taskProof"></div></div>',
        '<div class="thread">' + (messages || '<div class="empty">No thread yet.</div>') + '</div>',
        '<label>Add context</label><textarea id="note" placeholder="Decision, blocker, context, update..."></textarea>',
        '<label>Proof</label><input id="proof" placeholder="npm test, PR link, screenshot, blocked reason...">',
        '<label>Lesson</label><textarea id="lesson" placeholder="What did this task teach us?"></textarea>',
        '<label>Next task</label><input id="nextTask" placeholder="Optional next sharper task">',
        '<div class="actions"><button id="claim">Claim</button><button id="saveNote">Say</button><button id="finish" class="primary full"></button></div>'
      ].join('');
      room.querySelector('h3').textContent = task.title;
      $('taskGoal').textContent = task.objective || 'No matching goal yet.';
      $('taskLineage').textContent = 'parent: ' + parent + ' / next: ' + children;
      $('taskSummary').textContent = task.review && task.review.summary
        ? task.review.summary
        : 'No review summary yet.';
      $('taskProof').textContent = task.review && (task.review.proof || task.review.lesson)
        ? ((task.review.proof || 'no proof') + ' / ' + (task.review.lesson || 'no lesson'))
        : 'No proof yet.';
      room.querySelectorAll('.msg div:last-child').forEach((el, i) => { el.textContent = task.messages[i].content; });
      $('finish').textContent = task.status === 'review' ? 'Accept proof' : 'Move to Review';
      $('claim').onclick = () => mutate('/api/tasks/' + task.id + '/claim', { owner: 'operator' });
      $('saveNote').onclick = () => mutate('/api/tasks/' + task.id + '/message', { actor: 'operator', content: $('note').value });
      $('finish').onclick = () => {
        const proof = $('proof').value.trim();
        const lesson = $('lesson').value.trim();
        const nextTask = $('nextTask').value.trim();
        const payload = { actor: 'operator' };
        if (proof) payload.proof = proof;
        if (lesson) payload.lesson = lesson;
        if (nextTask) payload.next = nextTask;
        if (task.status === 'review') {
          payload.createNext = Boolean(nextTask || (task.review && task.review.next_task));
          mutate('/api/tasks/' + task.id + '/accept', payload);
        } else {
          mutate('/api/tasks/' + task.id + '/ready', payload);
        }
      };
    }

    async function mutate(path, body) {
      await api(path, { method: 'POST', body: JSON.stringify(body) });
      await load();
    }

    $('create').onsubmit = async (e) => {
      e.preventDefault();
      const title = $('title').value.trim();
      if (!title) return;
      const data = await api('/api/tasks', { method: 'POST', body: JSON.stringify({ title, tag: $('tag').value || 'tasks' }) });
      selected = data.task_id;
      $('title').value = '';
      await load();
    };
    $('refresh').onclick = load;
    load();
    setInterval(load, 2500);
  </script>
</body>
</html>`;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body.trim()) return resolve({});
      try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, value) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': 'http://localhost',
  });
  res.end(JSON.stringify(value, null, 2));
}

function sendHtml(res, value) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(value);
}

async function handleTaskApi(req, res, taskDb, db) {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'OPTIONS') return sendJson(res, 200, { ok: true });
  if (req.method === 'GET' && url.pathname === '/') return sendHtml(res, taskBoardHtml());
  if (req.method === 'GET' && url.pathname === '/api/tasks') {
    const { projection, outPath } = writeDefaultProjection(taskDb, db);
    return sendJson(res, 200, { ok: true, projection_path: outPath, projection });
  }
  if (req.method === 'GET' && url.pathname === '/api/tasks/capabilities') {
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
  if (req.method === 'GET' && url.pathname === '/api/tasks/capabilities/check') {
    const owner = url.searchParams.get('owner') || url.searchParams.get('as') || DEFAULT_OWNER;
    const reviewer = url.searchParams.get('reviewer') || url.searchParams.get('as_reviewer') || 'codex-review';
    const limitParam = url.searchParams.get('limit');
    const limit = limitParam ? Number(limitParam) : 8;
    const scope = taskQueueScopeFromSearchParams(url.searchParams);
    const report = taskCapabilitiesCheckReport(taskDb, db, [], {
      owner,
      reviewer,
      all: url.searchParams.get('all') === '1' || url.searchParams.get('all') === 'true',
      limit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 8,
      scope,
    });
    return sendJson(res, report.ok ? 200 : 409, report);
  }
  if (req.method === 'GET' && url.pathname === '/api/tasks/review-lane-drain') {
    const owner = url.searchParams.get('owner') || url.searchParams.get('as') || DEFAULT_OWNER;
    const reviewer = url.searchParams.get('reviewer') || url.searchParams.get('as_reviewer') || 'codex-review';
    const limitParam = url.searchParams.get('limit');
    const limit = limitParam ? Number(limitParam) : 8;
    const scope = taskQueueScopeFromSearchParams(url.searchParams);
    const report = taskReviewLaneDrainReport(taskDb, db, [], {
      owner,
      reviewer,
      all: url.searchParams.get('all') === '1' || url.searchParams.get('all') === 'true',
      limit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 8,
      scope,
    });
    return sendJson(res, report.ok ? 200 : 409, report);
  }
  if (req.method === 'POST' && url.pathname === '/api/tasks/review-lane-act') {
    const body = await readJsonBody(req);
    const result = taskReviewLaneAct(taskDb, db, taskReviewLaneActOptionsFromBody(body, url.searchParams));
    return sendJson(res, result.ok ? 200 : result.status || 409, result);
  }
  if (req.method === 'POST' && url.pathname === '/api/tasks/review-lane-loop') {
    const body = await readJsonBody(req);
    const result = taskReviewLaneLoop(taskDb, db, taskReviewLaneLoopOptionsFromBody(body, url.searchParams));
    return sendJson(res, result.ok ? 200 : result.status || 409, result);
  }
  if (req.method === 'POST' && url.pathname === '/api/tasks/review-lane-run') {
    const body = await readJsonBody(req);
    const result = taskReviewLaneRun(taskDb, db, taskReviewLaneRunOptionsFromBody(body, url.searchParams));
    return sendJson(res, result.ok ? 200 : result.status || 409, result);
  }
  if (req.method === 'GET' && (url.pathname === '/api/tasks/current' || url.pathname === '/api/tasks/queue')) {
    const owner = url.searchParams.get('owner') || url.searchParams.get('as') || DEFAULT_OWNER;
    const reviewer = url.searchParams.get('reviewer') || url.searchParams.get('as_reviewer') || 'codex-review';
    const limitParam = url.searchParams.get('limit');
    const limit = limitParam ? Number(limitParam) : 8;
    const scope = taskQueueScopeFromSearchParams(url.searchParams);
    const { outPath, current } = buildTaskCurrent(taskDb, db, [], {
      owner,
      reviewer,
      all: url.searchParams.get('all') === '1' || url.searchParams.get('all') === 'true',
      limit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 8,
      scope,
    });
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
  if (req.method === 'POST' && url.pathname === '/api/tasks/current/step') {
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
  if (req.method === 'POST' && url.pathname === '/api/tasks') {
    const body = await readJsonBody(req);
    const title = String(body.title || '').trim();
    if (!title) return sendJson(res, 400, { ok: false, reason: 'missing_title', detail: 'title required' });
    const result = taskDb.addTask(db, {
      title,
      tag: body.tag ? String(body.tag) : 'tasks',
      workspaceRoot: taskDb.workspaceRoot(),
    });
    const { projection, outPath } = writeDefaultProjection(taskDb, db);
    return sendJson(res, 200, { ok: true, action: 'created', task_id: result.id, projection_path: outPath, task: taskFromProjection(projection, result.id) });
  }
  if (req.method === 'POST' && url.pathname === '/api/tasks/clear-plan') {
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
  const detailMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (detailMatch) {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, reason: 'method_not_allowed' });
    const resolved = resolveTaskRef(taskDb, db, detailMatch[1]);
    if (!resolved.ok) return sendJson(res, resolved.reason === 'ambiguous' ? 409 : 404, { ok: false, reason: resolved.reason });
    const task = taskDetail(taskDb, db, resolved.id);
    if (!task) return sendJson(res, 404, { ok: false, reason: 'not_found' });
    const { outPath } = writeDefaultProjection(taskDb, db);
    return sendJson(res, 200, { ok: true, action: 'detail', task_id: resolved.id, projection_path: outPath, task, page: taskPageContract(task) });
  }
  const pageMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/page$/);
  if (pageMatch) {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, reason: 'method_not_allowed' });
    const resolved = resolveTaskRef(taskDb, db, pageMatch[1]);
    if (!resolved.ok) return sendJson(res, resolved.reason === 'ambiguous' ? 409 : 404, { ok: false, reason: resolved.reason });
    const task = taskDetail(taskDb, db, resolved.id);
    if (!task) return sendJson(res, 404, { ok: false, reason: 'not_found' });
    const { outPath } = writeDefaultProjection(taskDb, db);
    return sendJson(res, 200, { ok: true, action: 'page', task_id: resolved.id, projection_path: outPath, page: taskPageContract(task) });
  }
  const match = url.pathname.match(/^\/api\/tasks\/([^/]+)\/(claim|message|chat|step|plan|do|backlog|ready|accept|revise|finish|review|review-chat|continue-work|events)$/);
  if (!match) return sendJson(res, 404, { ok: false, reason: 'not_found' });
  const resolved = resolveTaskRef(taskDb, db, match[1]);
  if (!resolved.ok) return sendJson(res, resolved.reason === 'ambiguous' ? 409 : 404, { ok: false, reason: resolved.reason });
  const taskId = resolved.id;
  const op = match[2];
  if (req.method === 'GET' && op === 'events') {
    const events = taskDb.listTaskEvents(db, { taskId, limit: 500 });
    return sendJson(res, 200, { ok: true, events });
  }
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, reason: 'method_not_allowed' });
  const body = await readJsonBody(req);
  if (op === 'step') {
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
  if (op === 'continue-work') {
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
  if (op === 'claim') {
    const owner = String(body.owner || body.actor || DEFAULT_OWNER);
    const result = taskDb.claimTask(db, { id: taskId, claimedBy: owner });
    if (!result.claimed) return sendJson(res, 409, { ok: false, reason: result.reason, claimed_by: result.claimed_by || null });
    const { projection, outPath } = writeDefaultProjection(taskDb, db);
    return sendJson(res, 200, { ok: true, action: 'claimed', task_id: taskId, projection_path: outPath, task: taskFromProjection(projection, taskId) });
  }
  if (op === 'message') {
    const result = taskDb.noteTask(db, { id: taskId, actor: String(body.actor || DEFAULT_OWNER), content: String(body.content || '') });
    if (!result.noted) return sendJson(res, 404, { ok: false, reason: result.reason });
    const { projection, outPath } = writeDefaultProjection(taskDb, db);
    return sendJson(res, 200, { ok: true, action: 'noted', task_id: taskId, projection_path: outPath, task: taskFromProjection(projection, taskId) });
  }
  if (op === 'chat') {
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
  if (op === 'plan') {
    const result = taskDb.stageTask(db, {
      id: taskId,
      actor: String(body.actor || DEFAULT_OWNER),
      stage: 'plan',
      goal: String(body.goal || body.objective || ''),
      summary: String(body.summary || body.plan || ''),
      owner: String(body.owner || body.assignee || ''),
      exit: String(body.exit || body.exit_condition || ''),
      proofNeeded: String(body.proof_needed || body.proofNeeded || body.proof || body.verify || ''),
      firstMove: String(body.first_move || body.firstMove || body.first || ''),
      nextButton: String(body.next_button || body.nextButton || ''),
      confidence: body.confidence,
    });
    if (!result.staged) return sendJson(res, 409, { ok: false, reason: result.reason, detail: stageErrorDetail('task plan', result.reason, result) });
    const { projection, outPath } = writeDefaultProjection(taskDb, db);
    return sendJson(res, 200, { ok: true, action: 'planned', task_id: taskId, version: result.event.version, stage_packet: result.stage_packet, projection_path: outPath, task: taskFromProjection(projection, taskId) });
  }
  if (op === 'do') {
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
  if (op === 'backlog') {
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
  if (op === 'review-chat') {
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
  if (op === 'finish') {
    const currentTask = taskDb.getTask(db, taskId);
    const failed = Boolean(body.failed);
    const proof = String(body.proof || '').trim();
    const shouldReview = Boolean(body.proof || body.lesson || body.next || body.reward !== undefined);
    const proofIssue = meaningfulTaskProofIssue(proof, { required: !failed || shouldReview });
    if (proofIssue) return sendProofIssue(res, proof, proofIssue);
    const done = taskDb.doneTask(db, { id: taskId, status: failed ? 'failed' : 'done' });
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
  if (op === 'ready') {
    const proof = String(body.proof || '').trim();
    const proofIssue = meaningfulTaskProofIssue(proof);
    if (proofIssue) return sendProofIssue(res, proof, proofIssue);
    const nextTaskInput = normalizeReviewNextTaskInput(body.next);
    const result = taskDb.readyTask(db, {
      id: taskId,
      actor: String(body.actor || DEFAULT_OWNER),
      proof,
      lesson: String(body.lesson || ''),
      nextTask: nextTaskInput.nextTask,
    });
    if (!result.ready) return sendJson(res, 409, { ok: false, reason: result.reason });
    const { projection, outPath } = writeDefaultProjection(taskDb, db);
    return sendJson(res, 200, {
      ok: true,
      action: 'ready',
      task_id: taskId,
      ...(nextTaskInput.ignored ? { review_next_task_ignored: nextTaskInput.ignored } : {}),
      projection_path: outPath,
      task: taskFromProjection(projection, taskId),
    });
  }
  if (op === 'accept') {
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
    const done = taskDb.doneTask(db, { id: taskId, status: 'done', actor: String(body.actor || DEFAULT_OWNER), allowReview: true });
    if (!done.updated) return sendJson(res, 409, { ok: false, reason: 'not_open_claimed_or_review' });
    const reviewed = taskDb.reviewTask(db, {
      id: taskId,
      actor: String(body.actor || DEFAULT_OWNER),
      reward: parsedReward.value,
      lesson,
      nextTask,
      proof,
      careerXpEligible: true,
      clearedFields,
    });
    const nextCreated = body.createNext ? createNextTaskIfRequested(taskDb, db, ['--create-next'], currentTask, reviewed.episode.next_task_suggestion) : null;
    const xpProjection = refreshCareerXpAfterReview(reviewed);
    const { projection, outPath } = writeDefaultProjection(taskDb, db);
    return sendJson(res, 200, { ok: true, action: 'accepted', task_id: taskId, episode: reviewed.episode, xp_projection: xpProjection, next_task_id: nextCreated ? nextCreated.id : null, projection_path: outPath, task: taskFromProjection(projection, taskId) });
  }
  if (op === 'revise') {
    const result = taskDb.reviseTask(db, { id: taskId, actor: String(body.actor || DEFAULT_OWNER), note: String(body.note || body.reason || '') });
    if (!result.revised) return sendJson(res, 409, { ok: false, reason: result.reason });
    const { projection, outPath } = writeDefaultProjection(taskDb, db);
    return sendJson(res, 200, { ok: true, action: 'revise', task_id: taskId, projection_path: outPath, task: taskFromProjection(projection, taskId) });
  }
  if (op === 'review') {
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
}

function cmdServe(args) {
  const host = String(flag(args, '--host') || '127.0.0.1');
  const port = Number(flag(args, '--port') || process.env.PORT || 8787);
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const server = http.createServer((req, res) => {
    handleTaskApi(req, res, taskDb, db).catch((e) => {
      sendJson(res, 500, { ok: false, reason: 'server_error', detail: String(e && e.message || e) });
    });
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const actualPort = addr && addr.port || port;
      console.log(`Task board: http://${host}:${actualPort}`);
      console.log(`Workspace: ${taskDb.workspaceRoot()}`);
    });

    const shutdown = () => {
      server.close(() => resolve());
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  });
}

async function run(args) {
  const raw = args || [];
  if (raw.includes('--help') || raw.includes('-h')) return help();
  const first = raw[0];
  const sub = !first || first.startsWith('--') ? 'desk' : first;
  const rest = !first || first.startsWith('--') ? raw : raw.slice(1);
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
    case 'note':   return cmdNote(rest);
    case 'say':    return cmdNote(rest);
    case 'show':   return cmdShow(rest);
    case 'page':   return cmdPage(rest);
    case 'step':   return cmdStep(rest);
    case 'review-chat':
    case 'chat-review':
      return cmdReviewChat(rest);
    case 'ready':  return cmdReady(rest);
    case 'accept': return cmdAccept(rest);
    case 'auto-accept-certified':
    case 'auto-accept':
      return cmdAutoAcceptCertified(rest);
    case 'revise': return cmdRevise(rest);
    case 'done':   return cmdDone(rest);
    case 'finish': return cmdFinish(rest);
    case 'fail':   return cmdDone([...rest, '--failed']);
    case 'review': return cmdReview(rest);
    case 'reviews':
    case 'review-queue':
      return cmdReviews(rest);
    case 'status': return cmdStatus(rest);
    case 'setup':  return cmdSetup(rest);
    case 'serve':  return cmdServe(rest);
    case 'import': return cmdImport(rest);
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

module.exports = { run };
