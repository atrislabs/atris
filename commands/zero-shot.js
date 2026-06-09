'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCHEMA = 'atris.zero_shot_next_move.v1';
const ROUTE_LIMIT = 8;
const LATEST_PACKET_RELATIVE_PATH = '.atris/state/zero-shot.latest.json';
const LATEST_PROMPT_RELATIVE_PATH = '.atris/state/zero-shot.prompt.txt';
const ZERO_SHOT_COMMAND = 'atris 0-shot';
const LEGACY_ZERO_SHOT_COMMAND = 'atris zero-shot';
const ZERO_SHOT_JSON_COMMAND = `${ZERO_SHOT_COMMAND} --json`;
const ZERO_SHOT_PROMPT_COMMAND = `${ZERO_SHOT_COMMAND} --prompt`;
const ZERO_SHOT_WRITE_COMMAND = `${ZERO_SHOT_COMMAND} --write`;
const ZERO_SHOT_CHECK_COMMAND = `${ZERO_SHOT_COMMAND} --check`;
const LEGACY_ZERO_SHOT_JSON_COMMAND = `${LEGACY_ZERO_SHOT_COMMAND} --json`;
const LEGACY_ZERO_SHOT_PROMPT_COMMAND = `${LEGACY_ZERO_SHOT_COMMAND} --prompt`;
const LEGACY_ZERO_SHOT_WRITE_COMMAND = `${LEGACY_ZERO_SHOT_COMMAND} --write`;
const LEGACY_ZERO_SHOT_CHECK_COMMAND = `${LEGACY_ZERO_SHOT_COMMAND} --check`;
const FRESHNESS_SOURCES = [
  ['brain_status', 'atris/brain/STATUS.md'],
  ['task_projection', '.atris/state/tasks.projection.json'],
  ['todo', 'atris/TODO.md'],
  ['missions', '.atris/state/missions.jsonl'],
  ['codex_goal', '.atris/state/codex_goal.json'],
];
const TERMINAL_TASK_STATUSES = new Set(['done', 'accepted', 'complete', 'completed']);
const LANE_PRIORITY = {
  mission_tick: 0,
  review_lane: 1,
  owner_gate: 2,
  recovery_lane: 3,
  fast_model_task: 4,
  quick_task: 5,
  long_horizon: 6,
  goal_context: 7,
  no_current_task: 8,
};
const MODEL_TIERS = ['fast', 'pro', 'validator', 'human'];

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function readTextWithDeps(file, deps = {}) {
  const exists = deps.existsSync || fs.existsSync;
  const readFile = deps.readFileSync || fs.readFileSync;
  try {
    if (exists && !exists(file)) return '';
    return String(readFile(file, 'utf8'));
  } catch {
    return '';
  }
}

function readJson(file) {
  try { return JSON.parse(readText(file)); } catch { return null; }
}

function sha1(value) {
  return crypto.createHash('sha1').update(String(value || '')).digest('hex');
}

function readJsonLines(file) {
  return readText(file)
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function findWorkspaceRoot(start = process.cwd()) {
  let dir = path.resolve(start);
  while (true) {
    if (fs.existsSync(path.join(dir, 'atris')) || fs.existsSync(path.join(dir, '.atris'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(start);
    dir = parent;
  }
}

function section(text, heading) {
  const lines = String(text || '').split(/\r?\n/);
  const start = lines.findIndex(line => line.trim().toLowerCase() === `## ${heading}`.toLowerCase());
  if (start < 0) return '';
  const out = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s+/.test(line)) break;
    if (line.trim()) out.push(line.trim().replace(/^[-*]\s+/, ''));
  }
  return out.slice(0, 3).join(' ');
}

function collectBrain(root) {
  const status = readText(path.join(root, 'atris', 'brain', 'STATUS.md'));
  return {
    status_present: Boolean(status),
    strongest_signal: section(status, 'Strongest Signal') || section(status, 'Current Signal'),
    next_move: section(status, 'Next Move') || section(status, 'Move'),
  };
}

function collectFreshness(root, deps = {}) {
  const sources = FRESHNESS_SOURCES.map(([key, relative_path]) => {
    const filePath = path.join(root, relative_path);
    const exists = deps.existsSync || fs.existsSync;
    const statFn = deps.statSync || fs.statSync;
    const text = readTextWithDeps(filePath, deps);
    const present = exists(filePath);
    let size = 0;
    try {
      size = present ? statFn(filePath).size : 0;
    } catch {
      size = present ? Buffer.byteLength(text, 'utf8') : 0;
    }
    return {
      key,
      path: relative_path,
      exists: present,
      size,
      sha1: present ? sha1(text) : null,
    };
  });
  return {
    schema: 'atris.zero_shot_freshness.v1',
    source_fingerprint: sha1(JSON.stringify(sources.map(source => [
      source.key,
      source.path,
      source.exists,
      source.size,
      source.sha1,
    ]))),
    sources,
    check_command: ZERO_SHOT_CHECK_COMMAND,
    refresh_command: ZERO_SHOT_WRITE_COMMAND,
    legacy_check_command: LEGACY_ZERO_SHOT_CHECK_COMMAND,
    legacy_refresh_command: LEGACY_ZERO_SHOT_WRITE_COMMAND,
  };
}

function normalizeTask(task) {
  if (!task || typeof task !== 'object') return null;
  const metadata = task.metadata && typeof task.metadata === 'object' ? task.metadata : {};
  return {
    id: task.id || null,
    ref: task.display_id || task.ref || task.legacy_ref || task.id || null,
    title: task.title || '(untitled task)',
    status: String(task.status || '').toLowerCase(),
    tag: task.tag || metadata.tag || null,
    claimed_by: task.claimed_by || metadata.assigned_to || metadata.owner || null,
    objective: task.objective || metadata.objective || null,
    review: task.review || null,
    metadata,
  };
}

function collectTasks(root) {
  const projection = readJson(path.join(root, '.atris', 'state', 'tasks.projection.json')) || {};
  const projectionTasks = Array.isArray(projection.tasks) ? projection.tasks.map(normalizeTask).filter(Boolean) : [];
  const tasks = projectionTasks.length ? projectionTasks : collectTodoTasks(root);
  const counts = { total: tasks.length, open: 0, claimed: 0, review: 0, blocked: 0, failed: 0, done: 0 };
  for (const task of tasks) {
    if (Object.prototype.hasOwnProperty.call(counts, task.status)) counts[task.status] += 1;
  }
  return {
    projection_present: Boolean(projection.schema || projectionTasks.length),
    source: projectionTasks.length ? 'task_projection' : (tasks.length ? 'todo' : 'none'),
    tasks,
    counts,
  };
}

function collectTodoTasks(root) {
  const todoPath = path.join(root, 'atris', 'TODO.md');
  let parsed;
  try {
    parsed = require('../lib/todo-fallback').parseTodoFile(todoPath);
  } catch {
    return [];
  }
  const rows = [
    ...(parsed.backlog || []).map((task, index) => todoTask(task, 'open', index)),
    ...(parsed.inProgress || []).map((task, index) => todoTask(task, 'claimed', index)),
    ...(parsed.review || []).map((task, index) => todoTask(task, 'review', index)),
    ...(parsed.completed || []).map((task, index) => todoTask(task, 'done', index)),
  ];
  return rows.map(normalizeTask).filter(Boolean);
}

function todoTask(task, status, index) {
  const ref = task.id || `TODO-${index + 1}`;
  return {
    id: `todo:${status}:${ref}`,
    display_id: ref,
    title: task.title,
    status,
    tag: task.tag || null,
    claimed_by: task.claimed || null,
    metadata: {
      todo_source: 'atris/TODO.md',
      todo_id: task.id || null,
      todo_tags: task.tags || [],
      verify: task.verify || null,
    },
  };
}

function normalizeMission(mission) {
  if (!mission || typeof mission !== 'object') return null;
  const id = mission.id || mission.mission_id || null;
  if (!id) return null;
  const verifierResult = mission.verifier_result && typeof mission.verifier_result === 'object'
    ? mission.verifier_result
    : {};
  return {
    id,
    owner: mission.owner || '?',
    objective: mission.objective || mission.title || '',
    status: String(mission.status || '').toLowerCase(),
    verifier: mission.verifier || null,
    verifier_passed: mission.verifier_passed === true || verifierResult.passed === true,
    next_action: mission.next_action || '',
    lane: mission.lane || null,
  };
}

function collectMissions(root) {
  const latestById = new Map();
  const lines = readJsonLines(path.join(root, '.atris', 'state', 'missions.jsonl'));
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const mission = normalizeMission(lines[i]);
    if (mission && !latestById.has(mission.id)) latestById.set(mission.id, mission);
  }
  const missions = Array.from(latestById.values());
  const active = missions.filter(mission => ['ready', 'running', 'planning'].includes(mission.status));
  const needsTick = active.filter(mission => mission.verifier && !mission.verifier_passed);
  return {
    projection_present: lines.length > 0,
    active_count: active.length,
    needs_tick_count: needsTick.length,
    needs_tick: needsTick,
  };
}

function collectCodexGoal(root) {
  const state = readJson(path.join(root, '.atris', 'state', 'codex_goal.json')) || {};
  const goal = state.goal && typeof state.goal === 'object' ? state.goal : null;
  return {
    present: Boolean(state.schema || state.action || goal),
    action: state.action || null,
    objective: goal ? goal.objective || null : null,
    mission_id: goal ? goal.mission_id || null : null,
    mission_status: goal ? goal.mission_status || null : null,
    reason: goal ? goal.reason || null : null,
    next_command: goal ? goal.next_command || null : null,
  };
}

function selectCodexGoal(goal) {
  return goal && goal.objective ? goal : null;
}

function textFor(task) {
  return [task && task.title, task && task.objective, task && task.tag, JSON.stringify((task && task.metadata) || {})]
    .filter(Boolean)
    .join(' ');
}

function isHumanAcceptWaiting(task) {
  if (!task || !task.review) return false;
  const review = task.review;
  const reviewText = JSON.stringify(review);
  return review.agent_certified === true
    || /human_accept_waiting|human accept|pending_human_accept/i.test(reviewText);
}

function classify(task) {
  if (!task) {
    return {
      lane: 'no_current_task',
      urgency: 'orient',
      model: 'fast',
      reason: 'No active task was found in the local projection.',
    };
  }
  const text = textFor(task);
  const reviewStatus = task.review && /pending|review|certified/i.test(JSON.stringify(task.review));
  if (isHumanAcceptWaiting(task)) {
    return { lane: 'owner_gate', urgency: 'blocked', model: 'human', reason: `${task.ref} is agent-certified and waiting for human accept.` };
  }
  if (task.status === 'review' || reviewStatus) {
    return { lane: 'review_lane', urgency: 'high', model: 'validator', reason: `${task.ref} is waiting on review or verification.` };
  }
  if (task.status === 'blocked' || /human accept|human approval|owner approval|owner gate|approval|credential|secret|billing|customer approval|external send|accept gate|merge approval|publish approval|notar/i.test(text)) {
    return { lane: 'owner_gate', urgency: 'blocked', model: 'human', reason: `${task.ref} appears owner-gated or blocked.` };
  }
  if (task.status === 'failed') {
    return { lane: 'recovery_lane', urgency: 'recover', model: 'pro', reason: `${task.ref} failed and needs recovery context before retrying.` };
  }
  if (/mission|horizon|architecture|multi[- ]project|strategy|migration|release|launch|roadmap|endgame|company/i.test(text)) {
    return { lane: 'long_horizon', urgency: 'plan', model: 'pro', reason: `${task.ref} needs broader planning context before execution.` };
  }
  if (/typo|copy|small|single|quick|lint|test|doc|help|smoke|cli|command/i.test(text)) {
    return { lane: 'fast_model_task', urgency: 'execute', model: 'fast', reason: `${task.ref} is bounded and implementation-ready.` };
  }
  return { lane: 'quick_task', urgency: 'execute', model: 'fast', reason: `${task.ref} is the current active task.` };
}

function shellToken(value) {
  const text = String(value || '');
  if (/^[A-Za-z0-9._:/=-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, "'\\''")}'`;
}

function nextCommand(task, lane) {
  if (task && task.metadata && task.metadata.todo_source) return 'atris status --json';
  if (lane === 'mission_tick' && task && task.ref) return `atris mission tick ${shellToken(task.ref)} --verify --complete-on-pass`;
  if (lane === 'goal_context' && task && task.next_command) return task.next_command;
  if (lane === 'review_lane' && task && task.ref) return `atris task review-chat ${shellToken(task.ref)} --as codex-review`;
  if (lane === 'long_horizon' && task && task.ref) return `atris task page ${shellToken(task.ref)} --json`;
  if (lane === 'owner_gate' && task && task.ref) return `atris task page ${shellToken(task.ref)} --json`;
  if (lane === 'recovery_lane' && task && task.ref) return `atris task page ${shellToken(task.ref)} --json`;
  if (lane === 'fast_model_task' || lane === 'quick_task') {
    return task && task.tag
      ? `atris task current-step --tag ${shellToken(task.tag)} --json`
      : 'atris task current-step --json';
  }
  return 'atris radar --json';
}

function laneDetails(task, lane, command) {
  const ref = task && task.ref ? task.ref : 'the current workspace';
  const todoSource = task && task.metadata && task.metadata.todo_source;
  const details = {
    mission_tick: {
      horizon: 'long_term',
      work_size: 'long',
      model_tier: 'pro',
      agent_directive: `Advance mission ${ref}; run the verifier tick before starting unrelated work.`,
    },
    goal_context: {
      horizon: 'long_term',
      work_size: 'long',
      model_tier: 'pro',
      agent_directive: `Use the visible Codex goal ${ref} as the current objective before creating unrelated work.`,
    },
    review_lane: {
      horizon: 'immediate_review',
      work_size: 'quick',
      model_tier: 'validator',
      agent_directive: `Verify ${ref}; do not accept on behalf of the human.`,
    },
    fast_model_task: {
      horizon: 'now',
      work_size: 'quick',
      model_tier: 'fast',
      agent_directive: `Use a fast model for one bounded step on ${ref}, then hand off proof.`,
    },
    quick_task: {
      horizon: 'now',
      work_size: 'quick',
      model_tier: 'fast',
      agent_directive: `Do one scoped step on ${ref}, run the verifier, and leave proof.`,
    },
    long_horizon: {
      horizon: 'long_term',
      work_size: 'long',
      model_tier: 'pro',
      agent_directive: `Use a stronger model to plan ${ref} before execution; keep the next command as the first context step.`,
    },
    owner_gate: {
      horizon: 'blocked',
      work_size: 'owner_gate',
      model_tier: 'human',
      agent_directive: `Do not mutate or accept ${ref}; gather context and wait for the owner gate to clear.`,
    },
    recovery_lane: {
      horizon: 'now',
      work_size: 'recovery',
      model_tier: 'pro',
      agent_directive: `Inspect failed task ${ref}; identify the recovery path before retrying or revising.`,
    },
    no_current_task: {
      horizon: 'orient',
      work_size: 'context',
      model_tier: 'fast',
      agent_directive: 'Run the context check, then create or claim one bounded task from evidence.',
    },
  };
  const detail = {
    ...(details[lane] || details.quick_task),
    first_command: command,
  };
  if (todoSource) {
    detail.agent_directive = `${detail.agent_directive} Source: ${todoSource}; inspect context before importing, claiming, or mutating task state.`;
  }
  return detail;
}

function activeTasks(tasks) {
  return tasks.filter(task => !TERMINAL_TASK_STATUSES.has(task.status));
}

function lanePriority(lane) {
  return Object.prototype.hasOwnProperty.call(LANE_PRIORITY, lane) ? LANE_PRIORITY[lane] : 99;
}

function compactRoute(kind, item, decision, details, extra = {}) {
  return {
    kind,
    ref: item && item.ref ? item.ref : null,
    title: item && item.title ? item.title : null,
    status: extra.status || (item && item.status) || null,
    tag: item && item.tag ? item.tag : null,
    lane: decision.lane,
    urgency: decision.urgency,
    model: decision.model,
    horizon: details.horizon,
    work_size: details.work_size,
    model_tier: details.model_tier,
    first_command: details.first_command,
    agent_directive: details.agent_directive,
    reason: decision.reason,
    source: extra.source || null,
  };
}

function routeForTask(task) {
  const decision = classify(task);
  const command = nextCommand(task, decision.lane);
  const details = laneDetails(task, decision.lane, command);
  const kind = task && task.metadata && task.metadata.todo_source ? 'todo' : 'task';
  return compactRoute(kind, task, decision, details, { source: task });
}

function routeForMission(mission) {
  const item = { ref: mission.id, title: mission.objective || 'Mission tick' };
  const decision = {
    lane: 'mission_tick',
    urgency: 'high',
    model: 'pro',
    reason: `${mission.id} has an unverified mission verifier.`,
  };
  const command = nextCommand(item, decision.lane);
  const details = laneDetails(item, decision.lane, command);
  return compactRoute('mission', item, decision, details, { status: mission.status });
}

function routeForGoal(goal) {
  const item = {
    ref: goal.mission_id || 'codex_goal',
    title: goal.objective,
    next_command: goal.next_command,
  };
  const decision = {
    lane: 'goal_context',
    urgency: 'plan',
    model: 'pro',
    reason: `The visible Codex goal is ${goal.mission_id || 'active'} and has no active task selected.`,
  };
  const command = nextCommand(item, decision.lane);
  const details = laneDetails(item, decision.lane, command);
  return compactRoute('codex_goal', item, decision, details, { status: goal.mission_status });
}

function stripRouteSource(route) {
  const { source, ...rest } = route;
  return rest;
}

function routePrompt(route, root) {
  const focus = route.ref ? `${route.ref} - ${route.title || '(untitled)'}` : 'the current workspace';
  return [
    'Atris 0-shot selected the next move for an agent that was activated without a prompt.',
    `Workspace: ${root}`,
    `Route: ${route.lane} | horizon=${route.horizon} | work_size=${route.work_size} | model_tier=${route.model_tier}`,
    `Focus: ${focus}`,
    `Why: ${route.reason}`,
    `Run first: ${route.first_command}`,
    `Directive: ${route.agent_directive}`,
    'After the first command, stay inside this lane until evidence says the route changed. Do not human-accept, merge, publish, send externally, or switch to unrelated work from this prompt.',
  ].join('\n');
}

function publicRoute(route, root) {
  const cleanRoute = stripRouteSource(route);
  return {
    ...cleanRoute,
    prompt: routePrompt(cleanRoute, root),
  };
}

function routeFromDecision(decision, details, command) {
  return {
    kind: null,
    ref: null,
    title: null,
    status: null,
    tag: null,
    lane: decision.lane,
    urgency: decision.urgency,
    model: decision.model,
    horizon: details.horizon,
    work_size: details.work_size,
    model_tier: details.model_tier,
    first_command: command,
    agent_directive: details.agent_directive,
    reason: decision.reason,
  };
}

function buildHandoff(route, root) {
  return {
    prompt: routePrompt(route, root),
    first_command: route.first_command,
    model_tier: route.model_tier,
    lane: route.lane,
    route_options_field: 'routes.options',
    json_command: ZERO_SHOT_JSON_COMMAND,
    prompt_command: ZERO_SHOT_PROMPT_COMMAND,
    write_command: ZERO_SHOT_WRITE_COMMAND,
    legacy_json_command: LEGACY_ZERO_SHOT_JSON_COMMAND,
    legacy_prompt_command: LEGACY_ZERO_SHOT_PROMPT_COMMAND,
    legacy_write_command: LEGACY_ZERO_SHOT_WRITE_COMMAND,
  };
}

function summarizeRouteLanes(routes) {
  return routes.reduce((summary, route) => {
    summary[route.lane] = (summary[route.lane] || 0) + 1;
    return summary;
  }, {});
}

function compactRouteChoice(route) {
  if (!route) return null;
  return {
    kind: route.kind || null,
    ref: route.ref || null,
    title: route.title || null,
    lane: route.lane || null,
    horizon: route.horizon || null,
    work_size: route.work_size || null,
    model_tier: route.model_tier || null,
    first_command: route.first_command || null,
    agent_directive: route.agent_directive || null,
    reason: route.reason || null,
  };
}

function summarizeRouteModels(routes) {
  const summary = {};
  for (const tier of MODEL_TIERS) summary[tier] = { count: 0, first: null };
  for (const route of routes) {
    const tier = route.model_tier || 'unknown';
    if (!summary[tier]) summary[tier] = { count: 0, first: null };
    summary[tier].count += 1;
    if (!summary[tier].first) summary[tier].first = compactRouteChoice(route);
  }
  return summary;
}

function summarizeRouteHorizons(routes) {
  return routes.reduce((summary, route) => {
    const horizon = route.horizon || 'unknown';
    summary[horizon] = (summary[horizon] || 0) + 1;
    return summary;
  }, {});
}

function buildRouteIndex({ missionState, goalState, taskState }) {
  const missionRoutes = (missionState.needs_tick || []).map(routeForMission);
  const taskRoutes = activeTasks(taskState.tasks || [])
    .map((task, index) => ({ route: routeForTask(task), index }))
    .sort((a, b) => lanePriority(a.route.lane) - lanePriority(b.route.lane) || a.index - b.index)
    .map(entry => entry.route);
  const goal = selectCodexGoal(goalState);
  const goalRoutes = goal ? [routeForGoal(goal)] : [];
  const routes = [...missionRoutes, ...taskRoutes, ...goalRoutes];
  return {
    total: routes.length,
    shown: Math.min(routes.length, ROUTE_LIMIT),
    lanes: summarizeRouteLanes(routes),
    horizons: summarizeRouteHorizons(routes),
    models: summarizeRouteModels(routes),
    options: routes.slice(0, ROUTE_LIMIT),
  };
}

function buildPacket(options = {}) {
  const root = findWorkspaceRoot(options.cwd || process.cwd());
  const brain = collectBrain(root);
  const missionState = collectMissions(root);
  const goalState = collectCodexGoal(root);
  const taskState = collectTasks(root);
  const freshness = collectFreshness(root);
  const routeIndex = buildRouteIndex({ missionState, goalState, taskState });
  const selectedRoute = routeIndex.options[0] || null;
  const decision = selectedRoute
    ? {
      lane: selectedRoute.lane,
      urgency: selectedRoute.urgency,
      model: selectedRoute.model,
      reason: selectedRoute.reason,
    }
    : classify(null);
  const command = selectedRoute ? selectedRoute.first_command : nextCommand(null, decision.lane);
  const details = selectedRoute
    ? {
      horizon: selectedRoute.horizon,
      work_size: selectedRoute.work_size,
      model_tier: selectedRoute.model_tier,
      agent_directive: selectedRoute.agent_directive,
      first_command: selectedRoute.first_command,
    }
    : laneDetails(null, decision.lane, command);
  const selectedTaskRoute = selectedRoute && selectedRoute.kind === 'task' ? selectedRoute : null;
  const publicRoutes = {
    ...routeIndex,
    options: routeIndex.options.map(route => publicRoute(route, root)),
  };
  const handoffRoute = publicRoutes.options[0] || routeFromDecision(decision, details, command);
  return {
    schema: SCHEMA,
    generated_at: new Date().toISOString(),
    workspace_root: root,
    decision: {
      ...decision,
      ...details,
      confidence: selectedRoute || brain.status_present ? 'medium' : 'low',
      selected_ref: selectedRoute ? selectedRoute.ref : null,
      selected_title: selectedRoute ? selectedRoute.title : null,
      selected_kind: selectedRoute ? selectedRoute.kind : null,
    },
    queue: taskState.counts,
    routes: publicRoutes,
    handoff: buildHandoff(handoffRoute, root),
    freshness,
    durable: {
      write_command: ZERO_SHOT_WRITE_COMMAND,
      latest_json: LATEST_PACKET_RELATIVE_PATH,
      prompt_txt: LATEST_PROMPT_RELATIVE_PATH,
    },
    missions: {
      active: missionState.active_count,
      needs_tick: missionState.needs_tick_count,
    },
    goal: {
      present: goalState.present,
      action: goalState.action,
      objective: goalState.objective,
      mission_id: goalState.mission_id,
      next_command: goalState.next_command,
    },
    brain,
    commands: {
      zero_shot_json: ZERO_SHOT_JSON_COMMAND,
      zero_shot_prompt: ZERO_SHOT_PROMPT_COMMAND,
      zero_shot_write: ZERO_SHOT_WRITE_COMMAND,
      legacy_zero_shot_json: LEGACY_ZERO_SHOT_JSON_COMMAND,
      legacy_zero_shot_prompt: LEGACY_ZERO_SHOT_PROMPT_COMMAND,
      legacy_zero_shot_write: LEGACY_ZERO_SHOT_WRITE_COMMAND,
      next_command: command,
      first_command: command,
      context_check: 'atris radar --json',
      mission_status: 'atris mission status --status active --json',
      codex_goal: 'atris mission goal --json',
      task_page: selectedTaskRoute && selectedTaskRoute.ref ? `atris task page ${shellToken(selectedTaskRoute.ref)} --json` : null,
      task_current_step: 'atris task current-step --json',
      review_lane_drain: 'atris task review-lane-drain --json',
    },
    boundaries: {
      no_external_sends: true,
      no_human_accept: true,
      no_task_mutation: true,
      no_file_writes: true,
    },
  };
}

function writeLatestPacket(packet) {
  const root = packet.workspace_root || findWorkspaceRoot(process.cwd());
  const latestJsonPath = path.join(root, LATEST_PACKET_RELATIVE_PATH);
  const promptTxtPath = path.join(root, LATEST_PROMPT_RELATIVE_PATH);
  const packetToWrite = {
    ...packet,
    boundaries: {
      ...packet.boundaries,
      no_file_writes: false,
    },
    durable: {
      ...(packet.durable || {}),
      wrote: true,
      latest_json: LATEST_PACKET_RELATIVE_PATH,
      prompt_txt: LATEST_PROMPT_RELATIVE_PATH,
      latest_json_abs: latestJsonPath,
      prompt_txt_abs: promptTxtPath,
      source_fingerprint: packet.freshness ? packet.freshness.source_fingerprint : null,
    },
  };
  fs.mkdirSync(path.dirname(latestJsonPath), { recursive: true });
  fs.writeFileSync(latestJsonPath, `${JSON.stringify(packetToWrite, null, 2)}\n`, 'utf8');
  fs.writeFileSync(promptTxtPath, `${packetToWrite.handoff.prompt}\n`, 'utf8');
  return packetToWrite;
}

function buildLatestCheck(options = {}) {
  const current = buildPacket(options);
  const root = current.workspace_root;
  const latestPath = path.join(root, LATEST_PACKET_RELATIVE_PATH);
  const promptPath = path.join(root, LATEST_PROMPT_RELATIVE_PATH);
  const latest = readJson(latestPath);
  const currentFingerprint = current.freshness.source_fingerprint;
  const latestFingerprint = latest && latest.freshness ? latest.freshness.source_fingerprint : null;
  const promptExists = fs.existsSync(promptPath);
  const exists = Boolean(latest);
  const fresh = Boolean(exists && promptExists && latestFingerprint && latestFingerprint === currentFingerprint);
  return {
    schema: 'atris.zero_shot_latest_check.v1',
    ok: fresh,
    status: fresh ? 'fresh' : (exists ? 'stale' : 'missing'),
    workspace_root: root,
    latest_json: LATEST_PACKET_RELATIVE_PATH,
    prompt_txt: LATEST_PROMPT_RELATIVE_PATH,
    latest_exists: exists,
    prompt_exists: promptExists,
    latest_generated_at: latest ? latest.generated_at || null : null,
    latest_selected_ref: latest ? latest.decision && latest.decision.selected_ref || null : null,
    current_selected_ref: current.decision.selected_ref || null,
    latest_source_fingerprint: latestFingerprint,
    current_source_fingerprint: currentFingerprint,
    refresh_command: ZERO_SHOT_WRITE_COMMAND,
    check_command: ZERO_SHOT_CHECK_COMMAND,
    legacy_refresh_command: LEGACY_ZERO_SHOT_WRITE_COMMAND,
    legacy_check_command: LEGACY_ZERO_SHOT_CHECK_COMMAND,
  };
}

function renderLatestCheck(check) {
  return [
    '0-shot latest check',
    `status: ${check.status}`,
    `latest: ${check.latest_json}`,
    `prompt: ${check.prompt_txt}`,
    `selected: ${check.latest_selected_ref || 'none'} -> current ${check.current_selected_ref || 'none'}`,
    `refresh: ${check.refresh_command}`,
  ].join('\n');
}

function renderRouteSummary(routes) {
  const options = routes && Array.isArray(routes.options) ? routes.options : [];
  if (!options.length) return 'routes: none';
  const summary = options
    .slice(0, 3)
    .map(route => `${route.ref}:${route.lane}/${route.model_tier}`)
    .join(', ');
  const suffix = routes.total > options.length ? ` (+${routes.total - options.length} more)` : '';
  return `routes: ${summary}${suffix}`;
}

function renderPacket(packet) {
  const selected = packet.decision.selected_ref
    ? `${packet.decision.selected_ref} - ${packet.decision.selected_title}`
    : 'none';
  return [
    '0-shot next move',
    `route: ${packet.decision.lane} | ${packet.decision.urgency} | ${packet.decision.model}`,
    `focus: ${selected}`,
    `why: ${packet.decision.reason}`,
    `run: ${packet.commands.next_command}`,
    `queue: ${packet.queue.claimed} claimed, ${packet.queue.review} review, ${packet.queue.open} open, ${packet.queue.blocked} blocked, ${packet.queue.failed} failed`,
    renderRouteSummary(packet.routes),
    `prompt: ${packet.commands.zero_shot_prompt}`,
    `write: ${packet.commands.zero_shot_write} -> ${packet.durable.latest_json}`,
    `check: ${packet.freshness.check_command}`,
    `missions: ${packet.missions.active} active, ${packet.missions.needs_tick} need verifier tick`,
    `goal: ${packet.goal.objective ? packet.goal.objective.slice(0, 90) : 'none'}`,
    `boundaries: no external sends, no human accept, no task mutation${packet.boundaries.no_file_writes ? ', no file writes' : ''}`,
    `json: ${packet.commands.zero_shot_json}`,
  ].join('\n');
}

function renderHint(packet) {
  if (!packet || !packet.decision || !packet.commands) return `0-shot: ${ZERO_SHOT_PROMPT_COMMAND}`;
  return `0-shot: ${packet.decision.lane} -> ${packet.commands.next_command} | prompt: ${packet.commands.zero_shot_prompt || ZERO_SHOT_PROMPT_COMMAND}`;
}

function renderHelp() {
  return [
    'Usage: atris 0-shot [--json|--prompt|--write|--check]',
    'Alias: atris zero-shot [--json|--prompt|--write|--check]',
    'Also accepts: atris 0 shot, atris 0shot, atris zero shot, atris zeroshot',
    '',
    'Use when you do not know what to prompt next.',
    'Selects one read-only lane: mission_tick, goal_context, quick_task, fast_model_task, long_horizon, review_lane, recovery_lane, owner_gate, or no_current_task.',
    'Human output shows the first command to run.',
    '--json includes lane, horizon, work_size, model_tier, agent_directive, first_command, routes.options, handoff.prompt, and safety boundaries.',
    '--prompt prints only the copy-pasteable handoff.prompt for any model.',
    `--write refreshes ${LATEST_PACKET_RELATIVE_PATH} and ${LATEST_PROMPT_RELATIVE_PATH} for ambient agents; it does not mutate tasks or call external systems.`,
    '--check compares the durable latest packet with current source fingerprints and reports fresh, stale, or missing.',
    'Reads atris/brain/STATUS.md, .atris/state/tasks.projection.json, .atris/state/missions.jsonl, and .atris/state/codex_goal.json without accepting tasks or calling external systems.',
  ].join('\n');
}

function zeroShotCommand(args = []) {
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    console.log(renderHelp());
    return 0;
  }
  if (args.includes('--check')) {
    const check = buildLatestCheck();
    if (args.includes('--json')) {
      console.log(JSON.stringify(check, null, 2));
    } else {
      console.log(renderLatestCheck(check));
    }
    return 0;
  }
  let packet = buildPacket();
  if (args.includes('--write')) {
    packet = writeLatestPacket(packet);
  }
  if (args.includes('--json')) {
    console.log(JSON.stringify(packet, null, 2));
  } else if (args.includes('--prompt')) {
    console.log(packet.handoff.prompt);
  } else {
    console.log(renderPacket(packet));
  }
  return 0;
}

module.exports = {
  SCHEMA,
  buildPacket,
  classify,
  collectBrain,
  collectCodexGoal,
  collectFreshness,
  collectMissions,
  collectTasks,
  buildLatestCheck,
  renderHint,
  renderLatestCheck,
  renderPacket,
  writeLatestPacket,
  zeroShotCommand,
};
