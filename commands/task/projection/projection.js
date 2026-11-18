'use strict';

// commands/task/projection/projection.js: The task projection file and what it carries: goals
// matched to tasks, task streams, approvals, missions and wishes, and the payload sent to the
// cloud.
// Owner: unassigned. Moved out of commands/task.js on 2026-11-16 by lib/split-file.js; read
// README.md first.

// Names borrowed from commands/task.js and other feature folders, set by bindMain().
let fs, path, projectGoalAge, taskExplanation, explicitDoneLooksLike, explanationLines,
  taskApprovalControls, approvalLines, writeFileAtomic, DEFAULT_OWNER, taskScopeEverywhere,
  scopedWorkspaceRoot, taskRef, taskLookupRefs, resolveProjectionTaskRef, taskColumn, taskHasReview,
  handoffAllowsHumanAccept, handoffIsProofBoundaryBlocked, withReviewReceiptPath, taskReviewSummary,
  GOAL_MATCH_STOPWORDS, PROJECTION_MISSION_LIMIT, PROJECTION_WISH_LIMIT, PROJECTION_CLIP,
  reviewLandingForDisplay, reviewHandoffForTask, taskCommandQuote, taskPageCurrentStage,
  taskPageActions;
function bindMain(deps) {
  ({
    fs, path, projectGoalAge, taskExplanation, explicitDoneLooksLike, explanationLines,
    taskApprovalControls, approvalLines, writeFileAtomic, DEFAULT_OWNER, taskScopeEverywhere,
    scopedWorkspaceRoot, taskRef, taskLookupRefs, resolveProjectionTaskRef, taskColumn,
    taskHasReview, handoffAllowsHumanAccept, handoffIsProofBoundaryBlocked, withReviewReceiptPath,
    taskReviewSummary, GOAL_MATCH_STOPWORDS, PROJECTION_MISSION_LIMIT, PROJECTION_WISH_LIMIT,
    PROJECTION_CLIP, reviewLandingForDisplay, reviewHandoffForTask, taskCommandQuote,
    taskPageCurrentStage, taskPageActions,
  } = deps);
}

// options.root is for a caller that is not the command line, the dispatch flight: it
// keeps the list for its own workspace instead of for the directory this process is in.
function writeDefaultProjection(taskDb, db, options = {}) {
  const root = options.root ? path.resolve(options.root) : null;
  const workspaceRoot = root
    ? (taskScopeEverywhere([], options) ? null : taskDb.workspaceRoot(root))
    : scopedWorkspaceRoot(taskDb, [], options);
  const projection = enrichTaskProjection(taskDb.taskProjection(db, {
    workspaceRoot,
    limit: options.all ? null : 500,
  }));
  const outPath = path.resolve(root || process.cwd(), '.atris', 'state', 'tasks.projection.json');
  const output = JSON.stringify(projection, null, 2) + '\n';
  let shouldWrite = true;
  try {
    shouldWrite = fs.readFileSync(outPath, 'utf8') !== output;
  } catch {
    shouldWrite = true;
  }
  // Temp file and rename: a reader never sees half a projection. This is the one writer of the
  // projection's shape; lib/mission-core.js writes through it too.
  if (shouldWrite) writeFileAtomic(outPath, output);
  return { projection, outPath };
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
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const goals = extractGoalLines(fs.readFileSync(file, 'utf8'));
    if (goals.length) return { path: file, goals, updated_at: fs.statSync(file).mtime.toISOString() };
  }
  return { path: null, goals: [], updated_at: null };
}

function taskAssignee(task) {
  const metadata = task && task.metadata || {};
  return metadata.assigned_to || task.claimed_by || null;
}

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

// A task's objective is only what the task or its parent recorded. A project
// goal line that shares a few words is a board grouping, never this task's
// purpose, so it is not offered here.
function taskBaseObjective(task) {
  const metadata = task && task.metadata || {};
  return task.objective
    || metadata.task_goal
    || metadata.goal_objective
    || metadata.objective
    || null;
}

function taskObjective(task, parent, { parentLinkType = null, baseObjectives = new Map() } = {}) {
  const metadata = task && task.metadata || {};
  const explicit = task.objective || metadata.task_goal || metadata.goal_objective || metadata.objective;
  if (explicit) return explicit;
  if (parent) {
    if (parentLinkType === 'parent_task_id') return baseObjectives.get(parent.id) || parent.title;
    if (parentLinkType === 'goal_id') return parent.title;
    return baseObjectives.get(parent.id) || parent.title;
  }
  return null;
}

function buildTaskStreams(tasks, goals) {
  const buckets = new Map();
  for (const task of tasks) {
    const objective = task.objective || pickTaskGoal(task, goals) || 'Unmapped work';
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
    const review = task.review || {};
    const metadata = task.metadata || {};
    stream.tasks.push({
      id: task.id,
      title: task.title,
      explanation: task.explanation || taskExplanation(task),
      status: task.status,
      tag: task.tag,
      claimed_by: task.claimed_by,
      assigned_to: taskAssignee(task),
      parent_task_id: task.lineage && task.lineage.parent_task_id || null,
      child_task_ids: task.lineage && task.lineage.child_task_ids || [],
      proof: review.proof || metadata.latest_agent_proof || null,
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

// The approval half of the plain layer: one clear way to approve proposed
// work, one clear way to ask for a change. Every enabled/blocked answer comes
// from the existing review handoff, so this relabels what the certification
// rules already allow and can never widen it.
function joinPlainList(items) {
  if (items.length <= 2) return items.join(' and ');
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

function taskApprovalFor(task, { reviewer = 'codex-review', hasExistingReviewFollowUp = null } = {}) {
  const metadata = task && task.metadata || {};
  const approvalStatus = (task && task.review && task.review.approval_status) || metadata.approval_status || null;
  if (task && task.status === 'done' && approvalStatus === 'accepted') {
    return taskApprovalControls({
      question: 'Landed and accepted. Nothing to do.',
      approveLabel: 'Approve the completed work',
      acceptEnabled: false,
      acceptCommand: null,
      requestChangeEnabled: false,
      requestChangeCommand: null,
      blockedReason: null,
      waitingOn: null,
    });
  }
  const current = taskPageCurrentStage(task);
  const actions = taskPageActions(task, { reviewer, hasExistingReviewFollowUp });
  const inReview = current === 'review';
  const handoff = inReview
    ? reviewHandoffForTask(task, { suppressExistingFollowUp: true, hasExistingReviewFollowUp })
    : null;
  const planned = current === 'plan';
  // Name only the plan parts that are really missing: a job given a check
  // should not be told it still needs one, and a job that says what done
  // looks like already has its finish line.
  const planMissing = [
    !(metadata.task_goal || metadata.goal_objective || task.objective) && 'a goal',
    !(metadata.exit_condition || explicitDoneLooksLike(metadata)) && 'a finish line',
    !(metadata.verify || metadata.proof_needed) && 'a check',
    !metadata.first_move && 'a first move',
  ].filter(Boolean);
  const planReady = planned && planMissing.length === 0;
  const acceptEnabled = inReview ? handoffAllowsHumanAccept(handoff) : planReady;
  const planOwner = task && (task.claimed_by || taskAssignee(task)) || DEFAULT_OWNER;
  const acceptCommand = inReview
    ? actions.human_accept_command
    : planReady
      ? `atris task do ${taskRef(task)} --as ${planOwner} --first-move ${taskCommandQuote(metadata.first_move)}`
      : null;
  const requestChangeEnabled = !['done', 'blocked', 'missing'].includes(current);
  const requestChangeCommand = inReview
    ? actions.revise_command
    : planned
      ? `atris task backlog ${taskRef(task)} --reason "<what needs to change>"`
      : actions.note_command;
  const blockedReason = inReview
    ? handoffIsProofBoundaryBlocked(handoff)
      ? 'The proof points at unfinished or unsafe work. Ask for a change before approval.'
      : 'The proof still needs its required checks before a person can approve it.'
    : planned
      ? `The plan still needs ${joinPlainList(planMissing)} before approval.`
      : current === 'backlog'
        ? 'This task still needs a complete plan before approval.'
        : current === 'do'
          ? 'Work is underway. Approval opens after the proof clears review.'
          : 'This task is already closed.';
  const question = inReview
    ? 'Approve the completed work, or ask for a change?'
    : planned
      ? 'Approve this plan, or ask for a change?'
      : requestChangeEnabled
        ? 'Ask for a change before work moves forward.'
        : 'No action is available on this closed task.';
  return taskApprovalControls({
    question,
    approveLabel: inReview ? 'Approve the completed work' : 'Approve this plan',
    acceptEnabled,
    acceptCommand,
    requestChangeEnabled,
    requestChangeCommand,
    blockedReason,
    waitingOn: acceptEnabled ? 'a person' : inReview ? 'the proof check' : planned ? 'a complete plan' : null,
  });
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
    const objective = taskBaseObjective(task);
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
      const review = withReviewReceiptPath(taskReviewSummary(task), root);
      const enriched = {
        ...task,
        objective: taskObjective(task, parent, { parentLinkType, baseObjectives }),
        review,
        lineage: {
          parent_task_id: parentId,
          parent_title: parent ? parent.title : null,
          child_task_ids: childTasks.map(child => child.id),
          child_titles: childTasks.map(child => child.title),
          next_task_suggestion: review ? review.next_task : null,
        },
      };
      // Recomputed here so the derived reason can use the enriched objective
      // and lineage that only exist after this pass. Explicit fields written
      // by the caller still win; nothing below this layer is dropped.
      return {
        ...enriched,
        explanation: taskExplanation(enriched),
        approval: taskApprovalFor(enriched),
      };
    });
  return {
    ...projection,
    goals: {
      source_path: goalSource.path,
      items: goalSource.goals,
      updated_at: goalSource.updated_at,
      ...(goalSource.path ? projectGoalAge(goalSource.updated_at) : { old: null, about: null }),
    },
    streams: buildTaskStreams(enrichedTasks, goalSource.goals),
    tasks: enrichedTasks,
    missions: projectionMissions(root),
    wishes: projectionWishes(root),
  };
}

function clipForProjection(value) {
  const text = String(value || '');
  return text.length > PROJECTION_CLIP ? `${text.slice(0, PROJECTION_CLIP - 3)}...` : text;
}

function projectionMissions(root) {
  try {
    const { listMissions } = require('../../mission.js');
    const recentCutoff = Date.now() - 48 * 60 * 60 * 1000;
    return listMissions(root)
      .filter(mission => {
        const status = String(mission.status || '');
        if (!['complete', 'stopped'].includes(status)) return true;
        const updated = Date.parse(mission.updated_at || mission.created_at || '') || 0;
        return updated >= recentCutoff;
      })
      .slice(0, PROJECTION_MISSION_LIMIT)
      .map(mission => ({
        id: mission.id,
        objective: clipForProjection(String(mission.objective || '')),
        status: mission.status || null,
        owner: mission.owner || null,
        runner: mission.runner || null,
        cadence: mission.cadence || null,
        lane: mission.lane || null,
        next_action: clipForProjection(String(mission.next_action || '')),
        last_tick_at: mission.last_tick_at || null,
        last_tick_status: mission.last_tick_status || null,
        receipt_path: mission.receipt_path || null,
        wish_id: mission.wish_id || null,
        created_at: mission.created_at || null,
        updated_at: mission.updated_at || null,
      }));
  } catch {
    return [];
  }
}

function projectionWishes(root) {
  try {
    const { readWishes } = require('../../../lib/wish-store');
    return readWishes(root)
      .filter(wish => String(wish.status || '') !== 'closed')
      .slice(-PROJECTION_WISH_LIMIT)
      .map(wish => ({
        id: wish.id,
        n: wish.n ?? null,
        text: clipForProjection(String(wish.text || '')),
        status: wish.status || null,
        created_at: wish.first_ts || wish.ts || null,
      }));
  } catch {
    return [];
  }
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
  const explanation = task.explanation || taskExplanation(task);
  const approval = task.approval || taskApprovalFor(task);
  const lines = [
    ...explanationLines(explanation),
    ...approvalLines(approval),
    '',
    `Technical details: ${task.title}`,
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
  const landing = reviewLandingForDisplay(task.review);
  if (landing) {
    lines.push('', 'Result:');
    if (landing.happened) lines.push(`What happened: ${landing.happened}`);
    if (landing.reason) lines.push(`Why it matters: ${landing.reason}`);
    if (landing.checked) lines.push(`How checked: ${landing.checked}`);
    if (landing.tested) lines.push(`Tested: ${landing.tested}`);
    if (landing.decision) lines.push(`Decision: ${landing.decision}`);
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

function readProjectionFile(workspaceRoot) {
  const candidatePaths = [
    workspaceRoot ? path.join(workspaceRoot, '.atris', 'state', 'tasks.projection.json') : null,
    path.resolve('.atris', 'state', 'tasks.projection.json'),
  ].filter(Boolean);
  for (const candidate of candidatePaths) {
    try {
      if (fs.existsSync(candidate)) {
        const content = fs.readFileSync(candidate, 'utf8');
        const parsed = JSON.parse(content);
        if (parsed && Array.isArray(parsed.tasks)) return parsed;
      }
    } catch {}
  }
  return null;
}

module.exports = {
  bindMain, writeDefaultProjection, readLocalBusinessBinding, extractGoalLines, readGoalSources,
  taskAssignee, scoreGoalMatch, pickTaskGoal, taskBaseObjective, taskObjective, buildTaskStreams,
  joinPlainList, taskApprovalFor, enrichTaskProjection, clipForProjection, projectionMissions,
  projectionWishes, taskTypeForCloud, taskStateForCloud, taskNeedsApprovalForCloud,
  ownerMemberIdForCloud, taskDescriptionForCloud, cloudPayloadForTask, syncPlanForProjection,
  readProjectionFile,
};
