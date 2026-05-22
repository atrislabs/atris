// `atris task` - SQLite-backed task state. TODO.md is a regenerated view;
// events are the durable trail that web/desktop/cloud projections can read.

'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const os = require('os');

const DEFAULT_OWNER = process.env.ATRIS_AGENT_ID
  || process.env.USER
  || os.userInfo().username
  || 'unknown';
const AGENT_CERTIFICATION_REVIEW_PASSES = 2;

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
  atris task say <id> "<message>"         Add context to a task
  atris task ready <id> --proof "..."      Agent proof ready; native goal can complete
  atris task accept <id> [--proof "..."]   Human accepts proof, marks done
  atris task revise <id> --note "..."      Send reviewed work back to Do

  atris task add "<title>" [--tag <tag>] [--goal-id <id>]  Create a task
  atris task delegate "<title>" --to <id>  Create an assigned task
  atris task day [--json]                  Show today's owner-grouped task list
  atris task list [--all] [--status <s>]   List tasks (default: this workspace)
  atris task claim <id> [--as <owner>]     Atomic claim
  atris task note <id> "<message>"         Append dialogue/context to a task
  atris task show <id> [--json]            Show a task card + dialogue
  atris task done <id> [--failed] [--proof "..."]  Mark complete (or failed), optionally reviewed
  atris task finish <id> [--proof "..."]   Legacy alias for done
  atris task review <id> --reward <n>      Write review event + RSI episode
  atris task reviews [--limit <n>]         Show certified Review items for human accept/revise
  atris task status [--json] [--history]   Compact live status for web/Swarlo
  atris task setup [--import-todo]         Create/refresh task projection
  atris task serve [--port <n>]            Open local task factory board
  atris task sync --dry-run                Plan cloud/Swarlo task sync writes
  atris task import <file>                 One-shot import from TODO.md
  atris task events [id] [--limit <n>]     Print recent task events
  atris task events --all                  Print the full append-only ledger
  atris task export [--out <file>]         Write web/desktop JSON projection
  atris task render [--out <file>] [--failed-limit <n>]  Regenerate compact TODO.md view from state
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

function createNextTaskIfRequested(taskDb, db, args, currentTask, title) {
  const nextTitle = String(title || '').trim();
  if (!hasFlag(args, '--create-next') || !nextTitle) return null;
  const result = taskDb.addTask(db, {
    title: nextTitle,
    tag: currentTask && currentTask.tag || null,
    workspaceRoot: taskDb.workspaceRoot(),
    metadata: {
      parent_task_id: currentTask && currentTask.id || null,
      source: 'task_review_next',
    },
  });
  return result;
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
    return {
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
  }
  const reviewPassCount = Number(metadata.agent_review_pass_count || payload.review_pass_count || 0);
  const agentCertified = metadata.agent_certified === true
    || payload.agent_certified === true
    || reviewPassCount >= AGENT_CERTIFICATION_REVIEW_PASSES;
  const reviewedEventHas = (key) => reviewed && reviewed.event_type === 'reviewed'
    && Object.prototype.hasOwnProperty.call(payload, key);
  const clearedReviewFields = new Set(Array.isArray(payload.cleared_review_fields) ? payload.cleared_review_fields : []);
  const readyField = (key, metadataKey) => {
    if (reviewedEventHas(key)) {
      if (payload[key]) return payload[key];
      if (key === 'proof' || !clearedReviewFields.has(key)) return metadata[metadataKey] || null;
      return null;
    }
    return payload[key] || metadata[metadataKey] || null;
  };
  return {
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
  };
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
    || metadata.goal_objective
    || metadata.objective
    || pickTaskGoal(task, goals);
}

function taskObjective(task, parent, goals, { parentLinkType = null, baseObjectives = new Map() } = {}) {
  const metadata = task && task.metadata || {};
  const explicit = task.objective || metadata.goal_objective || metadata.objective;
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

function reviewHandoffForTask(task) {
  const review = task && task.review || {};
  if (task && task.status !== 'review') return null;
  if (review.approval_status !== 'pending') return null;
  const agentCertified = review.agent_certified === true;
  return {
    native_goal_status: agentCertified ? 'agent_certified' : 'needs_second_agent_review',
    career_xp_status: 'pending_human_accept',
    next_action: agentCertified ? 'continue_work' : 'agent_review_again',
  };
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
    const handoff = reviewHandoffForTask(task);
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
  for (const key of ['todo_id', 'stage', 'verify', 'delegate_via', 'goal_id', 'goal_objective', 'approval_status', 'agent_review_pass_count', 'agent_certified', 'agent_certification_policy', 'human_revision_count', 'human_revision_note']) {
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
  for (const key of ['title', 'status', 'tag', 'content', 'proof', 'lesson', 'reward', 'next_task']) {
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

function taskStatusSummary(projection, { history = false } = {}) {
  const tasks = projection.tasks || [];
  const hiddenDoneCount = Math.max(0, Number(projection.surface && projection.surface.hidden_done_count || 0));
  const fullTaskCount = Math.max(tasks.length + hiddenDoneCount, Number(projection.surface && projection.surface.full_task_count || 0));
  const columns = {
    backlog: tasks.filter(task => taskColumn(task) === 'backlog'),
    plan: tasks.filter(task => taskColumn(task) === 'open'),
    do: tasks.filter(task => taskColumn(task) === 'doing'),
    review: tasks.filter(task => taskColumn(task) === 'review' || taskColumn(task) === 'blocked'),
    done: tasks.filter(task => taskColumn(task) === 'done'),
  };
  const active = [...columns.do, ...columns.review, ...columns.plan];
  const reviewNeedingAgentAction = columns.review.filter(task => {
    const handoff = reviewHandoffForTask(task);
    return handoff && handoff.next_action === 'agent_review_again';
  });
  const reviewAgentCertified = columns.review.filter(task => {
    const handoff = reviewHandoffForTask(task);
    return handoff && handoff.next_action === 'continue_work';
  }).length;
  const blocked = columns.review.filter(task => taskColumn(task) === 'blocked').length;
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
      active: columns.plan.length + columns.do.length + reviewNeedingAgentAction.length,
      backlog: columns.backlog.length,
      plan: columns.plan.length,
      do: columns.do.length,
      review: columns.review.length,
      review_blocking: reviewNeedingAgentAction.length,
      review_certified: reviewAgentCertified,
      blocked,
      done: tasks.filter(task => task.status === 'done' || (task.status === 'failed' && taskHasReview(task))).length + hiddenDoneCount,
    },
    current: compactTaskForStatus(columns.do[0] || reviewNeedingAgentAction[0] || null),
    next: compactTaskForStatus(columns.plan[0] || null),
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

function reviewQueueLimit(args, total) {
  if (hasFlag(args, '--all')) return total;
  const raw = flag(args, '--limit');
  const limit = raw && raw !== true ? Number(raw) : 12;
  return Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 12;
}

function reviewQueueItem(task) {
  const ref = taskRef(task);
  return {
    id: task.id,
    display_id: task.display_id || null,
    title: task.title,
    tag: task.tag || null,
    updated_at: task.updated_at || null,
    review_pass_count: task.review?.agent_review_pass_count || null,
    proof: task.review?.proof || null,
    accept_command: `atris task accept ${ref}`,
    revise_command: `atris task revise ${ref} --note "<what must change>"`,
  };
}

function taskReviewQueue(projection, args = []) {
  const reviewTasks = (projection.tasks || [])
    .map(compactTaskForStatus)
    .filter(task => task && task.status === 'review' && task.review && task.review.approval_status === 'pending')
    .sort((a, b) => Number(b.updated_at || 0) - Number(a.updated_at || 0));
  const blocking = reviewTasks.filter(task => task.review?.handoff?.next_action === 'agent_review_again');
  const certified = reviewTasks.filter(task => task.review?.handoff?.next_action === 'continue_work' || task.review?.agent_certified === true);
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
      shown: items.length,
    },
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
    console.log(`   accept: ${item.accept_command}`);
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
  const status = taskStatusSummary(projection, { history });
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
  if (goalObjective && goalObjective !== true) metadata.goal_objective = String(goalObjective);
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
  const statusFilter = typeof status === 'string' ? status.trim().toLowerCase() : null;
  const queryStatus = statusFilter === 'blocked' ? 'failed' : statusFilter;
  const taskDb = getTaskDb();
  const db = taskDb.open();
  if (['active', 'do', 'doing', 'blocked'].includes(statusFilter)) {
    const { projection } = writeDefaultProjection(taskDb, db, { all });
    const displayRows = (projection.tasks || []).filter(task => {
      const column = taskColumn(task);
      if (statusFilter === 'blocked') return column === 'blocked';
      if (statusFilter === 'do' || statusFilter === 'doing') return column === 'doing';
      if (column === 'open' || column === 'doing') return true;
      if (column !== 'review') return false;
      const handoff = reviewHandoffForTask(task);
      return handoff && handoff.next_action === 'agent_review_again';
    });
    if (wantsJson(args)) {
      printJson({ ok: true, action: 'list', tasks: displayRows });
      return;
    }
    if (displayRows.length === 0) {
      console.log('(no tasks)');
      return;
    }
    for (const r of displayRows) {
      const claim = r.claimed_by ? ` [${r.claimed_by}]` : '';
      const tag = r.tag ? ` #${r.tag}` : '';
      console.log(`${r.status.padEnd(8)} ${taskRef(r)}${claim}${tag}\t${r.title}`);
    }
    return;
  }
  const rows = taskDb.listTasks(db, {
    workspaceRoot: all ? null : taskDb.workspaceRoot(),
    status: queryStatus,
    limit: 200,
  });
  const displayRows = taskDb.withTaskDisplayRefs(rows, workspaceRefRows(taskDb, db, all));
  if (wantsJson(args)) {
    printJson({ ok: true, action: 'list', tasks: displayRows });
    return;
  }
  if (displayRows.length === 0) {
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
      || reviewTasks.find(task => task.review.handoff.next_action === 'continue_work');
    if (reviewTask) {
      const handoff = reviewTask.review.handoff;
      if (wantsJson(args)) {
        printJson({
          ok: true,
          action: handoff.next_action,
          task_id: handoff.next_action === 'agent_review_again' ? reviewTask.id : null,
          owner: String(owner),
          projection_path: outPath,
          handoff,
          review_task: reviewTask,
        });
        return;
      }
      console.log('No open tasks.');
      console.log(handoff.next_action === 'continue_work'
        ? `${taskRef(reviewTask)} is agent-certified and waiting for human accept.`
        : `${taskRef(reviewTask)} needs one more agent review before continuation.`);
      console.log(handoff.next_action === 'continue_work'
        ? 'Continue work elsewhere; AgentXP waits for human accept.'
        : 'Review this task again before continuing.');
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

function cmdDone(args) {
  const pos = positional(args);
  const id = pos[0];
  if (!id) {
    failTask('atris task done', 'missing_id', 'id required');
  }
  const failed = hasFlag(args, '--failed');
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const taskId = requireTaskId(taskDb, db, id, 'atris task done');
  const actor = String(flag(args, '--as') || DEFAULT_OWNER);
  const result = taskDb.doneTask(db, { id: taskId, status: failed ? 'failed' : 'done', actor });
  if (result.updated) {
    const hasReview = hasFlag(args, '--review') || flag(args, '--lesson') || flag(args, '--next') || flag(args, '--proof') || flag(args, '--reward');
    const review = hasReview ? taskDb.reviewTask(db, {
      id: taskId,
      actor,
      reward: flag(args, '--reward') || (failed ? 0 : 1),
      lesson: typeof flag(args, '--lesson') === 'string' ? flag(args, '--lesson') : '',
      nextTask: typeof flag(args, '--next') === 'string' ? flag(args, '--next') : '',
      proof: typeof flag(args, '--proof') === 'string' ? flag(args, '--proof') : '',
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
  const done = taskDb.doneTask(db, { id: taskId, status: hasFlag(args, '--failed') ? 'failed' : 'done', actor });
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
  const hasReview = hasFlag(args, '--review') || flag(args, '--lesson') || flag(args, '--next') || flag(args, '--proof') || flag(args, '--reward');
  if (hasReview) {
    const result = taskDb.reviewTask(db, {
      id: taskId,
      actor,
      reward: flag(args, '--reward') || 1,
      lesson: typeof flag(args, '--lesson') === 'string' ? flag(args, '--lesson') : '',
      nextTask: typeof flag(args, '--next') === 'string' ? flag(args, '--next') : '',
      proof: typeof flag(args, '--proof') === 'string' ? flag(args, '--proof') : '',
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
  const lesson = flag(args, '--lesson') || '';
  const nextTask = flag(args, '--next') || '';
  const actor = String(flag(args, '--as') || DEFAULT_OWNER);
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const taskId = requireTaskId(taskDb, db, id, 'atris task ready');
  const result = taskDb.readyTask(db, {
    id: taskId,
    actor,
    proof: String(proof),
    lesson: typeof lesson === 'string' ? lesson : '',
    nextTask: typeof nextTask === 'string' ? nextTask : '',
  });
  if (!result.ready) {
    console.error(`ready failed: ${result.reason}`);
    process.exit(1);
  }
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  const agentCertified = result.event.payload.agent_certified === true;
  const handoff = {
    native_goal_status: agentCertified ? 'agent_certified' : 'needs_second_agent_review',
    career_xp_status: 'pending_human_accept',
    next_action: agentCertified ? 'continue_work' : 'agent_review_again',
    rule: agentCertified
      ? 'Agent double-check complete; continue work. AgentXP waits for human accept.'
      : 'Proof is in Review; human accept can award AgentXP now. A second agent review only certifies autonomous continuation.',
  };
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
  const lesson = flag(args, '--lesson') || '';
  const nextTask = flag(args, '--next') || '';
  const proof = flag(args, '--proof') || '';
  const actor = flag(args, '--as') || DEFAULT_OWNER;
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const taskId = requireTaskId(taskDb, db, id, 'atris task review');
  const currentTask = taskDb.getTask(db, taskId);
  const result = taskDb.reviewTask(db, {
    id: taskId,
    actor: String(actor),
    reward: reward === true || reward === null ? 0 : reward,
    lesson: typeof lesson === 'string' ? lesson : '',
    nextTask: typeof nextTask === 'string' ? nextTask : '',
    proof: typeof proof === 'string' ? proof : '',
    careerXpEligible: false,
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
  const match = url.pathname.match(/^\/api\/tasks\/([^/]+)\/(claim|message|ready|accept|revise|finish|review|events)$/);
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
  if (op === 'finish') {
    const currentTask = taskDb.getTask(db, taskId);
    const done = taskDb.doneTask(db, { id: taskId, status: body.failed ? 'failed' : 'done' });
    if (!done.updated) return sendJson(res, 409, { ok: false, reason: 'not_open_or_claimed' });
    const shouldReview = body.proof || body.lesson || body.next || body.reward !== undefined;
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
    if (!proof) return sendJson(res, 400, { ok: false, reason: 'proof_required' });
    const result = taskDb.readyTask(db, {
      id: taskId,
      actor: String(body.actor || DEFAULT_OWNER),
      proof,
      lesson: String(body.lesson || ''),
      nextTask: String(body.next || ''),
    });
    if (!result.ready) return sendJson(res, 409, { ok: false, reason: result.reason });
    const { projection, outPath } = writeDefaultProjection(taskDb, db);
    return sendJson(res, 200, { ok: true, action: 'ready', task_id: taskId, projection_path: outPath, task: taskFromProjection(projection, taskId) });
  }
  if (op === 'accept') {
    const currentTask = enrichTaskProjection(taskDb.taskProjection(db, { taskId })).tasks[0] || null;
    const hasExplicitProof = Object.prototype.hasOwnProperty.call(body, 'proof');
    const proof = String(hasExplicitProof ? body.proof : currentTask?.metadata?.latest_agent_proof || '').trim();
    if (!proof) return sendJson(res, 400, { ok: false, reason: 'proof_required' });
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
    const reviewed = taskDb.reviewTask(db, {
      id: taskId,
      actor: String(body.actor || DEFAULT_OWNER),
      reward: body.reward === undefined ? 1 : body.reward,
      lesson: String(body.lesson || ''),
      nextTask: String(body.next || ''),
      proof: String(body.proof || ''),
      careerXpEligible: false,
    });
    const nextCreated = body.createNext ? createNextTaskIfRequested(taskDb, db, ['--create-next'], currentTask, reviewed.episode.next_task_suggestion) : null;
    const xpProjection = refreshCareerXpAfterReview(reviewed);
    const { projection, outPath } = writeDefaultProjection(taskDb, db);
    return sendJson(res, 200, { ok: true, action: 'reviewed', task_id: taskId, episode: reviewed.episode, xp_projection: xpProjection, next_task_id: nextCreated ? nextCreated.id : null, projection_path: outPath, task: taskFromProjection(projection, taskId) });
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
    case 'claim':  return cmdClaim(rest);
    case 'start':  return cmdClaim(rest);
    case 'next':   return cmdNext(rest);
    case 'note':   return cmdNote(rest);
    case 'say':    return cmdNote(rest);
    case 'show':   return cmdShow(rest);
    case 'ready':  return cmdReady(rest);
    case 'accept': return cmdAccept(rest);
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
