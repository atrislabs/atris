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

function help() {
  console.log(`
atris task - durable local task state (SQLite, gitignored)

  atris task                              Show the task desk
  atris task new "<title>"                Create a task
  atris task next                         Claim/show the next open task
  atris task say <id> "<message>"         Add context to a task
  atris task finish <id> [--proof "..."]  Complete, optionally review

  atris task add "<title>" [--tag <tag>]   Create a task
  atris task list [--all] [--status <s>]   List tasks (default: this workspace)
  atris task claim <id> [--as <owner>]     Atomic claim
  atris task note <id> "<message>"         Append dialogue/context to a task
  atris task show <id> [--json]            Show a task card + dialogue
  atris task done <id> [--failed]          Mark complete (or failed)
  atris task review <id> --reward <n>      Write review event + RSI episode
  atris task status [--json]               Compact live status for web/Swarlo
  atris task setup [--import-todo]         Create/refresh task projection
  atris task serve [--port <n>]            Open local task factory board
  atris task sync --dry-run                Plan cloud/Swarlo task sync writes
  atris task import <file>                 One-shot import from TODO.md
  atris task events [id]                   Print append-only task events
  atris task export [--out <file>]         Write web/desktop JSON projection
  atris task render [--out <file>]         Regenerate TODO.md view from state
  atris task where                          Print db path + workspace scope
  atris task help                           This help

Env:
  ATRIS_TASKS_DB    Override db path (default ~/.atris/tasks.db)
  ATRIS_AGENT_ID    Owner id for claim/done (default: $USER)

Headless:
  Add --json to task commands for machine-readable output and stable automation.
`.trim());
}

function flag(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return null;
  return args[i + 1] || true;
}

function hasFlag(args, name) {
  return args.indexOf(name) !== -1;
}

function wantsJson(args) {
  return hasFlag(args, '--json');
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function jsonModeActive() {
  return process.argv.includes('--json');
}

function failTask(label, reason, detail, exitCode = 2) {
  if (jsonModeActive()) {
    console.error(JSON.stringify({
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

function taskReviewSummary(task) {
  const reviewed = (task.events || []).slice().reverse().find(e => e.event_type === 'reviewed');
  const payload = reviewed && reviewed.payload || {};
  return {
    reward: payload.reward === undefined ? null : payload.reward,
    proof: payload.proof || null,
    lesson: payload.lesson || null,
    next_task: payload.next_task || null,
  };
}

function scoreGoalMatch(task, goal) {
  const haystack = `${task.title} ${task.tag || ''}`.toLowerCase();
  const words = String(goal || '').toLowerCase().match(/[a-z0-9]{4,}/g) || [];
  return words.reduce((score, word) => score + (haystack.includes(word) ? 1 : 0), 0);
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
  return best;
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
  const byId = new Map((projection.tasks || []).map(task => [task.id, task]));
  const children = new Map();
  for (const task of projection.tasks || []) {
    const parentId = task.metadata && task.metadata.parent_task_id;
    if (!parentId) continue;
    if (!children.has(parentId)) children.set(parentId, []);
    children.get(parentId).push(task);
  }
  const enrichedTasks = (projection.tasks || []).map(task => {
      const parentId = task.metadata && task.metadata.parent_task_id || null;
      const parent = parentId ? byId.get(parentId) : null;
      const childTasks = children.get(task.id) || [];
      const review = taskReviewSummary(task);
      return {
        ...task,
        objective: pickTaskGoal(task, goalSource.goals),
        review,
        lineage: {
          parent_task_id: parentId,
          parent_title: parent ? parent.title : null,
          child_task_ids: childTasks.map(child => child.id),
          child_titles: childTasks.map(child => child.title),
          next_task_suggestion: review.next_task,
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
  if (task.status === 'claimed') return 'doing';
  if (task.status === 'failed') return 'blocked';
  if (task.status === 'done') return 'done';
  return 'open';
}

function ownerMemberIdForCloud(task) {
  if (!task.claimed_by) return null;
  const owner = String(task.claimed_by).trim();
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
    needs_approval: false,
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

function taskStatusSummary(projection) {
  const tasks = projection.tasks || [];
  const columns = {
    plan: tasks.filter(task => taskColumn(task) === 'open'),
    do: tasks.filter(task => taskColumn(task) === 'doing'),
    review: tasks.filter(task => taskColumn(task) === 'review' || taskColumn(task) === 'blocked'),
    done: tasks.filter(task => taskColumn(task) === 'done'),
  };
  const active = [...columns.do, ...columns.review, ...columns.plan];
  const lastUpdated = tasks.reduce((max, task) => Math.max(max, Number(task.updated_at || 0)), 0);
  const swarloFeed = tasks
    .flatMap(task => (task.events || []).map(event => ({
      task_id: task.id,
      task_title: task.title,
      actor: event.actor || task.claimed_by || null,
      kind: event.event_type === 'claimed'
        ? 'claim'
        : event.event_type === 'completed' || event.event_type === 'reviewed'
          ? 'result'
          : 'note',
      channel: task.tag || 'tasks',
      content: event.payload && (event.payload.content || event.payload.proof || event.payload.lesson)
        || humanEventType(event.event_type),
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
    .slice(0, 12);
  return {
    schema: 'atris.task_status.v1',
    generated_at: projection.generated_at,
    workspace_root: projection.workspace_root,
    goals: projection.goals || { source_path: null, items: [] },
    counts: {
      total: tasks.length,
      active: tasks.filter(task => task.status !== 'done').length,
      plan: columns.plan.length,
      do: columns.do.length,
      review: columns.review.length,
      done: columns.done.length,
    },
    current: columns.do[0] || columns.review[0] || null,
    next: columns.plan[0] || null,
    needs_review: columns.review.slice(0, 5),
    streams: (projection.streams || []).slice(0, 8).map(stream => ({
      objective: stream.objective,
      active_count: stream.active_count,
      done_count: stream.done_count,
      open_count: stream.open_count,
      doing_count: stream.doing_count,
      review_count: stream.review_count,
      blocked_count: stream.blocked_count,
    })),
    last_event: active.map(task => ({ task, event: latestTaskEvent(task) })).filter(row => row.event)
      .sort((a, b) => b.event.created_at - a.event.created_at)[0] || null,
    last_updated_at: lastUpdated ? new Date(lastUpdated).toISOString() : null,
    swarlo: {
      feed: swarloFeed,
      realtime_contract: {
        claim: 'Swarlo claim -> canonical task state=doing + lease metadata',
        report_done: 'Swarlo report(done) -> canonical task state=done + proof metadata',
        web: 'atrisos-web reads canonical tasks through /api/agent/:id/tasks or /api/business/* and live activity through public business/Swarlo posts',
      },
    },
  };
}

function humanEventType(type) {
  return String(type || 'event').replace(/_/g, ' ');
}

function formatTaskLine(task) {
  if (!task) return 'none';
  const owner = task.claimed_by ? ` @${task.claimed_by}` : '';
  const tag = task.tag ? ` #${task.tag}` : '';
  return `${task.id.slice(0, 8)}${owner}${tag} ${task.title}`;
}

function cmdStatus(args) {
  const all = hasFlag(args, '--all');
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const { projection, outPath } = writeDefaultProjection(taskDb, db, { all });
  const status = taskStatusSummary(projection);
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
  console.log(`plan ${status.counts.plan} / do ${status.counts.do} / review ${status.counts.review} / done ${status.counts.done}`);
  console.log(`current ${formatTaskLine(status.current)}`);
  console.log(`next    ${formatTaskLine(status.next)}`);
  if (status.needs_review.length) {
    console.log('review');
    for (const task of status.needs_review.slice(0, 3)) console.log(`  ${formatTaskLine(task)}`);
  }
  console.log(`swarlo feed ${status.swarlo.feed.length} event${status.swarlo.feed.length === 1 ? '' : 's'}`);
}

function resolveTaskRef(taskDb, db, ref) {
  const token = String(ref || '').trim();
  if (!token) return { ok: false, reason: 'missing' };
  const exact = taskDb.getTask(db, token);
  if (exact) return { ok: true, id: exact.id, row: exact };
  const rows = taskDb.listTasks(db, { workspaceRoot: taskDb.workspaceRoot(), limit: 500 });
  const matches = rows.filter(r => r.id.startsWith(token));
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

function renderTaskDesk(rows) {
  const active = rows.filter(r => r.status !== 'done');
  const done = rows.filter(r => r.status === 'done');
  if (rows.length === 0) {
    console.log('No tasks yet.');
    console.log('Start with: atris task new "Ship the smallest useful thing"');
    return;
  }
  console.log('TASK DESK');
  console.log('');
  for (const r of active.slice(0, 12)) {
    const owner = r.claimed_by ? ` @${r.claimed_by}` : '';
    const tag = r.tag ? ` #${r.tag}` : '';
    console.log(`${r.status.padEnd(7)} ${r.id.slice(0, 8)}${owner}${tag}`);
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
    console.error('atris task add: title required');
    process.exit(2);
  }
  const tag = flag(args, '--tag');
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const ws = taskDb.workspaceRoot();
  const result = taskDb.addTask(db, {
    title,
    tag: typeof tag === 'string' ? tag : null,
    workspaceRoot: ws,
  });
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'created',
      task_id: result.id,
      inserted: result.inserted !== false,
      projection_path: outPath,
      task: taskFromProjection(projection, result.id),
    });
    return;
  }
  console.log(`${result.id}\t${title}`);
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
  renderTaskDesk(rows);
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
  if (wantsJson(args)) {
    printJson({ ok: true, action: 'list', tasks: rows });
    return;
  }
  if (rows.length === 0) {
    console.log('(no tasks)');
    return;
  }
  for (const r of rows) {
    const claim = r.claimed_by ? ` [${r.claimed_by}]` : '';
    const tag = r.tag ? ` #${r.tag}` : '';
    console.log(`${r.status.padEnd(8)} ${r.id}${claim}${tag}\t${r.title}`);
  }
}

function cmdClaim(args) {
  const pos = positional(args);
  const id = pos[0];
  if (!id) {
    console.error('atris task claim: id required');
    process.exit(2);
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
        task: taskFromProjection(projection, taskId),
      });
      return;
    }
    console.log(`claimed ${taskId} as ${owner}`);
  } else {
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
        task: taskFromProjection(projection, claimed[0].id),
      });
      return;
    }
    console.log(`current ${claimed[0].id.slice(0, 8)} @${owner}`);
    console.log(claimed[0].title);
    return;
  }
  const open = taskDb.listTasks(db, {
    workspaceRoot: taskDb.workspaceRoot(),
    status: 'open',
    limit: 1,
  });
  if (!open.length) {
    const { outPath } = writeDefaultProjection(taskDb, db);
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
      task: taskFromProjection(projection, open[0].id),
    });
    return;
  }
  console.log(`next ${open[0].id.slice(0, 8)} @${owner}`);
  console.log(open[0].title);
}

function cmdNote(args) {
  const pos = positional(args);
  const id = pos[0];
  const content = pos.slice(1).join(' ').trim();
  if (!id || !content) {
    console.error('atris task note: id and message required');
    process.exit(2);
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
      task: taskFromProjection(projection, taskId),
    });
    return;
  }
  console.log(`noted ${taskId} v${result.event.version}`);
}

function cmdShow(args) {
  const pos = positional(args);
  const id = pos[0];
  if (!id) {
    console.error('atris task show: id required');
    process.exit(2);
  }
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const taskId = requireTaskId(taskDb, db, id, 'atris task show');
  const projection = taskDb.taskProjection(db, { taskId });
  const task = projection.tasks[0];
  if (!task) {
    console.error(`task not found: ${id}`);
    process.exit(1);
  }
  if (hasFlag(args, '--json')) {
    console.log(JSON.stringify(task, null, 2));
    return;
  }
  const owner = task.claimed_by ? ` / ${task.claimed_by}` : '';
  const tag = task.tag ? ` #${task.tag}` : '';
  console.log(`${task.status.toUpperCase()} ${task.id} v${task.current_version}${owner}${tag}`);
  console.log(task.title);
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
    console.error('atris task done: id required');
    process.exit(2);
  }
  const failed = hasFlag(args, '--failed');
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const taskId = requireTaskId(taskDb, db, id, 'atris task done');
  const result = taskDb.doneTask(db, { id: taskId, status: failed ? 'failed' : 'done' });
  if (result.updated) {
    const { projection, outPath } = writeDefaultProjection(taskDb, db);
    if (wantsJson(args)) {
      printJson({
        ok: true,
        action: failed ? 'failed' : 'done',
        task_id: taskId,
        projection_path: outPath,
        task: taskFromProjection(projection, taskId),
      });
      return;
    }
    console.log(`${failed ? 'failed' : 'done'} ${taskId}`);
  } else {
    console.error(`done failed: ${taskId} not in open|claimed`);
    process.exit(1);
  }
}

function cmdFinish(args) {
  const pos = positional(args);
  const id = pos[0];
  if (!id) {
    console.error('atris task finish: id required');
    process.exit(2);
  }
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const taskId = requireTaskId(taskDb, db, id, 'atris task finish');
  const currentTask = taskDb.getTask(db, taskId);
  const done = taskDb.doneTask(db, { id: taskId, status: hasFlag(args, '--failed') ? 'failed' : 'done' });
  if (!done.updated) {
    console.error(`finish failed: ${taskId} not in open|claimed`);
    process.exit(1);
  }
  const hasReview = hasFlag(args, '--review') || flag(args, '--lesson') || flag(args, '--next') || flag(args, '--proof') || flag(args, '--reward');
  if (hasReview) {
    const result = taskDb.reviewTask(db, {
      id: taskId,
      actor: String(flag(args, '--as') || DEFAULT_OWNER),
      reward: flag(args, '--reward') || 1,
      lesson: typeof flag(args, '--lesson') === 'string' ? flag(args, '--lesson') : '',
      nextTask: typeof flag(args, '--next') === 'string' ? flag(args, '--next') : '',
      proof: typeof flag(args, '--proof') === 'string' ? flag(args, '--proof') : '',
    });
    const nextCreated = createNextTaskIfRequested(taskDb, db, args, currentTask, result.episode.next_task_suggestion);
    const { projection, outPath } = writeDefaultProjection(taskDb, db);
    if (wantsJson(args)) {
      printJson({
        ok: true,
        action: 'finished',
        task_id: taskId,
        reviewed: true,
        reward: result.episode.reward.value,
        episode: result.episode,
        next_task_id: nextCreated ? nextCreated.id : null,
        projection_path: outPath,
        projection,
        task: taskFromProjection(projection, taskId),
      });
      return;
    }
    console.log(`finished ${taskId} reward=${result.episode.reward.value}`);
    if (result.episode.next_task_suggestion) console.log(`next: ${result.episode.next_task_suggestion}`);
    if (nextCreated) console.log(`created next ${nextCreated.id}`);
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
      task: taskFromProjection(projection, taskId),
    });
    return;
  }
  console.log(`finished ${taskId}`);
}

function cmdReview(args) {
  const pos = positional(args);
  const id = pos[0];
  if (!id) {
    console.error('atris task review: id required');
    process.exit(2);
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
  });
  if (!result.reviewed) {
    console.error(`review failed: ${result.reason}`);
    process.exit(1);
  }
  const nextCreated = createNextTaskIfRequested(taskDb, db, args, currentTask, result.episode.next_task_suggestion);
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'reviewed',
      task_id: taskId,
      version: result.event.version,
      reward: result.episode.reward.value,
      episode: result.episode,
      next_task_id: nextCreated ? nextCreated.id : null,
      projection_path: outPath,
      projection,
      task: taskFromProjection(projection, taskId),
    });
    return;
  }
  console.log(`reviewed ${taskId} v${result.event.version} reward=${result.episode.reward.value}`);
  if (result.episode.next_task_suggestion) console.log(`next: ${result.episode.next_task_suggestion}`);
  if (nextCreated) console.log(`created next ${nextCreated.id}`);
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
      metadata: { todo_id: t.id, claimed: t.claimed, stage: t.stage, verify: t.verify },
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
  const taskDb = getTaskDb();
  const db = taskDb.open();
  if (taskId) taskId = requireTaskId(taskDb, db, taskId, 'atris task events');
  const events = taskDb.listTaskEvents(db, {
    taskId,
    workspaceRoot: all || taskId ? null : taskDb.workspaceRoot(),
    limit: 500,
  });
  if (wantsJson(args)) {
    printJson({ ok: true, action: 'events', events });
    return;
  }
  if (events.length === 0) {
    console.log('(no task events)');
    return;
  }
  for (const e of events) {
    const actor = e.actor ? ` actor=${e.actor}` : '';
    console.log(`${e.version}\t${e.event_type}\t${e.task_id}${actor}\t${JSON.stringify(e.payload || {})}`);
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

function cmdRender(args) {
  const out = flag(args, '--out') || path.join('atris', 'TODO.md');
  const all = hasFlag(args, '--all');
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const rows = taskDb.listTasks(db, {
    workspaceRoot: all ? null : taskDb.workspaceRoot(),
    limit: 500,
  });
  const markdown = taskDb.renderTodoMarkdown(rows);
  const outPath = path.resolve(String(out));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, markdown, 'utf8');
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'rendered',
      count: rows.length,
      path: outPath,
    });
    return;
  }
  console.log(`rendered ${rows.length} task${rows.length === 1 ? '' : 's'} -> ${outPath}`);
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
  for (const item of plan) {
    console.log(`${item.method.padEnd(5)} ${item.endpoint} <= ${item.local_task_id.slice(0, 8)} ${item.body.title}`);
    for (const followup of item.after_create || []) {
      console.log(`      then ${followup.method} ${followup.endpoint} state=${followup.body.state}`);
    }
  }
}

function taskColumn(task) {
  if (task.status === 'open') return 'open';
  if (task.status === 'claimed') return 'doing';
  if (task.status === 'failed') return 'blocked';
  if (task.status === 'done' && task.latest_event_type !== 'reviewed') return 'review';
  return 'done';
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
    .grid { display:grid; grid-template-columns: repeat(5, minmax(180px, 1fr)); gap:12px; align-items:start; }
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
      <div class="sub">local durable tasks / Swarlo-ready event stream</div>
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
      ['open', 'Open'],
      ['doing', 'Doing'],
      ['review', 'Review'],
      ['blocked', 'Blocked'],
      ['done', 'Done']
    ];
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
      if (task.status === 'open') return 'open';
      if (task.status === 'claimed') return 'doing';
      if (task.status === 'failed') return 'blocked';
      if (task.status === 'done' && task.latest_event_type !== 'reviewed') return 'review';
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
        ? latest.map((task) => '<div class="chainitem"><span>' + task.id.slice(0, 8) + '</span><strong></strong></div>').join('')
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
          ? tasks.map((task) => '<div class="streamtask"><span>' + task.id.slice(0, 8) + '</span><strong></strong></div>').join('')
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
      pills[0].textContent = task.id.slice(0, 8);
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
        '<div class="fact"><b>Proof / lesson</b><div id="taskProof"></div></div>',
        '<div class="thread">' + (messages || '<div class="empty">No thread yet.</div>') + '</div>',
        '<label>Add context</label><textarea id="note" placeholder="Decision, blocker, context, update..."></textarea>',
        '<label>Proof</label><input id="proof" placeholder="npm test, PR link, screenshot, blocked reason...">',
        '<label>Lesson</label><textarea id="lesson" placeholder="What did this task teach us?"></textarea>',
        '<label>Next task</label><input id="nextTask" placeholder="Optional next sharper task">',
        '<div class="actions"><button id="claim">Claim</button><button id="saveNote">Say</button><button id="finish" class="primary full">Finish + review</button></div>'
      ].join('');
      room.querySelector('h3').textContent = task.title;
      $('taskGoal').textContent = task.objective || 'No matching goal yet.';
      $('taskLineage').textContent = 'parent: ' + parent + ' / next: ' + children;
      $('taskProof').textContent = task.review && (task.review.proof || task.review.lesson)
        ? ((task.review.proof || 'no proof') + ' / ' + (task.review.lesson || 'no lesson'))
        : 'No proof yet.';
      room.querySelectorAll('.msg div:last-child').forEach((el, i) => { el.textContent = task.messages[i].content; });
      $('claim').onclick = () => mutate('/api/tasks/' + task.id + '/claim', { owner: 'operator' });
      $('saveNote').onclick = () => mutate('/api/tasks/' + task.id + '/message', { actor: 'operator', content: $('note').value });
      $('finish').onclick = () => mutate('/api/tasks/' + task.id + '/finish', {
        actor: 'operator',
        proof: $('proof').value,
        lesson: $('lesson').value,
        next: $('nextTask').value,
        createNext: Boolean($('nextTask').value.trim())
      });
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
  const match = url.pathname.match(/^\/api\/tasks\/([^/]+)\/(claim|message|finish|review|events)$/);
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
    if (shouldReview) {
      const reviewed = taskDb.reviewTask(db, {
        id: taskId,
        actor: String(body.actor || DEFAULT_OWNER),
        reward: body.reward === undefined ? 1 : body.reward,
        lesson: String(body.lesson || ''),
        nextTask: String(body.next || ''),
        proof: String(body.proof || ''),
      });
      episode = reviewed.episode;
      nextCreated = body.createNext ? createNextTaskIfRequested(taskDb, db, ['--create-next'], currentTask, episode.next_task_suggestion) : null;
    }
    const { projection, outPath } = writeDefaultProjection(taskDb, db);
    return sendJson(res, 200, {
      ok: true,
      action: 'finished',
      task_id: taskId,
      reviewed: Boolean(episode),
      episode,
      next_task_id: nextCreated ? nextCreated.id : null,
      projection_path: outPath,
      task: taskFromProjection(projection, taskId),
    });
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
    });
    const nextCreated = body.createNext ? createNextTaskIfRequested(taskDb, db, ['--create-next'], currentTask, reviewed.episode.next_task_suggestion) : null;
    const { projection, outPath } = writeDefaultProjection(taskDb, db);
    return sendJson(res, 200, { ok: true, action: 'reviewed', task_id: taskId, episode: reviewed.episode, next_task_id: nextCreated ? nextCreated.id : null, projection_path: outPath, task: taskFromProjection(projection, taskId) });
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
  const first = raw[0];
  const sub = !first || first.startsWith('--') ? 'desk' : first;
  const rest = !first || first.startsWith('--') ? raw : raw.slice(1);
  switch (sub) {
    case 'desk':   return cmdHome(rest);
    case 'today':  return cmdHome(rest);
    case 'add':    return cmdAdd(rest);
    case 'new':    return cmdAdd(rest);
    case 'list':   return cmdList(rest);
    case 'ls':     return cmdList(rest);
    case 'claim':  return cmdClaim(rest);
    case 'start':  return cmdClaim(rest);
    case 'next':   return cmdNext(rest);
    case 'note':   return cmdNote(rest);
    case 'say':    return cmdNote(rest);
    case 'show':   return cmdShow(rest);
    case 'done':   return cmdDone(rest);
    case 'finish': return cmdFinish(rest);
    case 'fail':   return cmdDone([...rest, '--failed']);
    case 'review': return cmdReview(rest);
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
      console.error(`atris task: unknown subcommand "${sub}"`);
      help();
      process.exit(2);
  }
}

module.exports = { run };
