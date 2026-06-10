'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCHEMA = 'atris.zero_shot_next_move.v1';
const ROUTE_LIMIT = 8;
const LATEST_PACKET_RELATIVE_PATH = '.atris/state/zero-shot.latest.json';
const LATEST_PROMPT_RELATIVE_PATH = '.atris/state/zero-shot.prompt.txt';
const LATEST_MENU_RELATIVE_PATH = '.atris/state/zero-shot.menu.txt';
const ZERO_SHOT_COMMAND = 'atris 0-shot';
const LEGACY_ZERO_SHOT_COMMAND = 'atris zero-shot';
const ZERO_SHOT_JSON_COMMAND = `${ZERO_SHOT_COMMAND} --json`;
const ZERO_SHOT_PROMPT_COMMAND = `${ZERO_SHOT_COMMAND} --prompt`;
const ZERO_SHOT_ALL_COMMAND = `${ZERO_SHOT_COMMAND} --all`;
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
const HORIZON_ORDER = ['now', 'immediate_review', 'long_term', 'blocked', 'orient'];
const HORIZON_PROMPTS = [
  ['now', 'now'],
  ['review', 'immediate_review'],
  ['long', 'long_term'],
  ['blocked', 'blocked'],
  ['orient', 'orient'],
];

function modelPromptRelativePath(tier) {
  return `.atris/state/zero-shot.${tier}.prompt.txt`;
}

function modelPromptRelativePaths() {
  return Object.fromEntries(MODEL_TIERS.map(tier => [tier, modelPromptRelativePath(tier)]));
}

function horizonPromptRelativePath(key) {
  return `.atris/state/zero-shot.${key}.prompt.txt`;
}

function horizonPromptRelativePaths() {
  return Object.fromEntries(HORIZON_PROMPTS.map(([key]) => [key, horizonPromptRelativePath(key)]));
}

function normalizeModelTier(value) {
  const tier = String(value || '').trim().toLowerCase().replace(/[-\s]+/g, '_');
  if (!tier) return null;
  if (tier === 'quick') return 'fast';
  if (tier === 'long' || tier === 'long_term') return 'pro';
  return MODEL_TIERS.includes(tier) ? tier : null;
}

function parseModelTierArg(args = []) {
  let requested = null;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--model' || arg === '--tier') {
      const value = args[i + 1];
      const tier = normalizeModelTier(value);
      return tier ? { tier } : { error: `${arg} requires one of: ${MODEL_TIERS.join(', ')}` };
    }
    if (arg.startsWith('--model=')) {
      const tier = normalizeModelTier(arg.slice('--model='.length));
      return tier ? { tier } : { error: `--model requires one of: ${MODEL_TIERS.join(', ')}` };
    }
    if (arg.startsWith('--tier=')) {
      const tier = normalizeModelTier(arg.slice('--tier='.length));
      return tier ? { tier } : { error: `--tier requires one of: ${MODEL_TIERS.join(', ')}` };
    }
    const flagTier = normalizeModelTier(arg.replace(/^--/, ''));
    if (arg.startsWith('--') && flagTier && MODEL_TIERS.includes(flagTier)) requested = flagTier;
  }
  return { tier: requested };
}

function normalizeHorizon(value) {
  const horizon = String(value || '').trim().toLowerCase().replace(/[-\s]+/g, '_');
  if (!horizon) return null;
  if (horizon === 'quick') return 'now';
  if (horizon === 'review' || horizon === 'immediate') return 'immediate_review';
  if (horizon === 'long') return 'long_term';
  if (horizon === 'context') return 'orient';
  return HORIZON_ORDER.includes(horizon) ? horizon : null;
}

function parseHorizonArg(args = []) {
  let requested = null;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--horizon') {
      const horizon = normalizeHorizon(args[i + 1]);
      return horizon ? { horizon } : { error: `--horizon requires one of: ${HORIZON_ORDER.join(', ')}` };
    }
    if (arg.startsWith('--horizon=')) {
      const horizon = normalizeHorizon(arg.slice('--horizon='.length));
      return horizon ? { horizon } : { error: `--horizon requires one of: ${HORIZON_ORDER.join(', ')}` };
    }
    const flagHorizon = normalizeHorizon(arg.replace(/^--/, ''));
    if (arg.startsWith('--') && flagHorizon && HORIZON_ORDER.includes(flagHorizon)) requested = flagHorizon;
  }
  return { horizon: requested };
}

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

function queueSummaryText(queue = {}) {
  return `total=${queue.total || 0} open=${queue.open || 0} claimed=${queue.claimed || 0} review=${queue.review || 0} blocked=${queue.blocked || 0} failed=${queue.failed || 0} done=${queue.done || 0}`;
}

function routeContextPromptLines(routes = {}, queue = {}) {
  const horizons = routes.horizons || {};
  const models = routes.models || {};
  const horizonFirst = routes.horizon_first || {};
  return [
    `Queue: ${queueSummaryText(queue)}`,
    `Route inventory: total=${routes.total || 0} compact=${routes.shown || 0} hidden=${routes.hidden_count || 0} full_field=routes.all_options`,
    `Horizon buckets: now=${horizons.now || 0} review=${horizons.immediate_review || 0} long=${horizons.long_term || 0} blocked=${horizons.blocked || 0} orient=${horizons.orient || 0}`,
    `First routes by horizon: ${firstRoutesByHorizonText(horizonFirst)}`,
    `Model buckets: fast=${models.fast?.count || 0} pro=${models.pro?.count || 0} validator=${models.validator?.count || 0} human=${models.human?.count || 0}`,
    `First routes by model: ${firstRoutesByModelText(models)}`,
    'Inspect all routes before switching lanes: atris 0-shot --all; machine-readable full list: run atris 0-shot --json and read routes.all_options.',
    'Selection prompts: atris 0-shot --model fast|pro|validator|human --prompt; atris 0-shot --horizon now|review|long|blocked|orient --prompt.',
  ];
}

function handoffPrompt(route, root, routes, queue) {
  return [
    routePrompt(route, root),
    '',
    ...routeContextPromptLines(routes, queue),
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

function buildHandoff(route, root, routes, queue) {
  return {
    prompt: handoffPrompt(route, root, routes, queue),
    first_command: route.first_command,
    model_tier: route.model_tier,
    lane: route.lane,
    route_options_field: 'routes.all_options',
    json_command: ZERO_SHOT_JSON_COMMAND,
    prompt_command: ZERO_SHOT_PROMPT_COMMAND,
    all_command: ZERO_SHOT_ALL_COMMAND,
    write_command: ZERO_SHOT_WRITE_COMMAND,
    legacy_json_command: LEGACY_ZERO_SHOT_JSON_COMMAND,
    legacy_prompt_command: LEGACY_ZERO_SHOT_PROMPT_COMMAND,
    legacy_write_command: LEGACY_ZERO_SHOT_WRITE_COMMAND,
  };
}

function allPublicRouteOptions(packet) {
  const routes = packet && packet.routes ? packet.routes : {};
  if (Array.isArray(routes.all_options)) return routes.all_options;
  if (Array.isArray(routes.options)) return routes.options;
  return [];
}

function routeForModelPrompt(packet, tier) {
  const models = packet && packet.routes && packet.routes.models ? packet.routes.models : {};
  const entry = models[tier] || {};
  return entry.first || noRouteForModel(tier);
}

function routeForHorizonPrompt(packet, horizon) {
  const options = allPublicRouteOptions(packet);
  return options.find(route => route.horizon === horizon) || noRouteForSelection(null, horizon);
}

function buildModelPromptRecords(packet, root) {
  return Object.fromEntries(MODEL_TIERS.map(tier => {
    const route = routeForModelPrompt(packet, tier);
    const relativePath = modelPromptRelativePath(tier);
    return [tier, {
      tier,
      prompt_txt: relativePath,
      prompt_txt_abs: path.join(root, relativePath),
      model_tier_match: Boolean(packet.routes && packet.routes.models && packet.routes.models[tier] && packet.routes.models[tier].first),
      selected_ref: route.ref || null,
      lane: route.lane || null,
      first_command: route.first_command || null,
      prompt: handoffPrompt(route, root, packet.routes || {}, packet.queue || {}),
    }];
  }));
}

function buildHorizonPromptRecords(packet, root) {
  return Object.fromEntries(HORIZON_PROMPTS.map(([key, horizon]) => {
    const route = routeForHorizonPrompt(packet, horizon);
    const options = allPublicRouteOptions(packet);
    const relativePath = horizonPromptRelativePath(key);
    return [key, {
      key,
      horizon,
      prompt_txt: relativePath,
      prompt_txt_abs: path.join(root, relativePath),
      horizon_match: options.some(option => option.horizon === horizon),
      selected_ref: route.ref || null,
      lane: route.lane || null,
      first_command: route.first_command || null,
      prompt: handoffPrompt(route, root, packet.routes || {}, packet.queue || {}),
    }];
  }));
}

function publicModelPromptRecords(records) {
  return Object.fromEntries(Object.entries(records).map(([tier, record]) => [tier, {
    prompt_txt: record.prompt_txt,
    prompt_txt_abs: record.prompt_txt_abs,
    model_tier_match: record.model_tier_match,
    selected_ref: record.selected_ref,
    lane: record.lane,
    first_command: record.first_command,
  }]));
}

function publicHorizonPromptRecords(records) {
  return Object.fromEntries(Object.entries(records).map(([key, record]) => [key, {
    horizon: record.horizon,
    prompt_txt: record.prompt_txt,
    prompt_txt_abs: record.prompt_txt_abs,
    horizon_match: record.horizon_match,
    selected_ref: record.selected_ref,
    lane: record.lane,
    first_command: record.first_command,
  }]));
}

function checkPromptRecords(records, keys) {
  return Object.fromEntries(keys.map(key => {
    const expectedRecord = records[key];
    const promptPath = expectedRecord.prompt_txt_abs;
    const exists = fs.existsSync(promptPath);
    const expectedText = `${expectedRecord.prompt}\n`;
    const actualText = exists ? readText(promptPath) : '';
    const record = {
      prompt_txt: expectedRecord.prompt_txt,
      exists,
      matches_expected: Boolean(exists && actualText === expectedText),
      actual_sha1: exists ? sha1(actualText) : null,
      expected_sha1: sha1(expectedText),
      selected_ref: expectedRecord.selected_ref,
      lane: expectedRecord.lane,
      first_command: expectedRecord.first_command,
    };
    if (expectedRecord.horizon) record.horizon = expectedRecord.horizon;
    return [key, record];
  }));
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
  const summary = Object.fromEntries(HORIZON_ORDER.map(horizon => [horizon, 0]));
  return routes.reduce((summary, route) => {
    const horizon = route.horizon || 'unknown';
    summary[horizon] = (summary[horizon] || 0) + 1;
    return summary;
  }, summary);
}

function summarizeHorizonFirstRoutes(routes) {
  const summary = Object.fromEntries(HORIZON_ORDER.map(horizon => [horizon, null]));
  for (const route of routes) {
    const horizon = route.horizon || 'unknown';
    if (!Object.prototype.hasOwnProperty.call(summary, horizon)) summary[horizon] = null;
    if (!summary[horizon]) summary[horizon] = compactRouteChoice(route);
  }
  return summary;
}

function selectRoute(routes, requestedModelTier = null, requestedHorizon = null) {
  if (!requestedModelTier && !requestedHorizon) return routes[0] || null;
  return routes.find(route => {
    if (requestedModelTier && route.model_tier !== requestedModelTier) return false;
    if (requestedHorizon && route.horizon !== requestedHorizon) return false;
    return true;
  }) || null;
}

function noRouteForModel(requestedModelTier) {
  const decision = {
    lane: 'no_current_task',
    urgency: 'orient',
    model: requestedModelTier,
    reason: `No ${requestedModelTier} model route is available in the current queue.`,
  };
  const command = 'atris radar --json';
  const details = {
    horizon: 'orient',
    work_size: 'context',
    model_tier: requestedModelTier,
    agent_directive: `Do not take work assigned to another model tier from this prompt. Inspect routes.models, then hand off to a tier with available work or wait for new ${requestedModelTier} work.`,
    first_command: command,
  };
  return routeFromDecision(decision, details, command);
}

function defaultModelTierForHorizon(horizon) {
  if (horizon === 'immediate_review') return 'validator';
  if (horizon === 'long_term') return 'pro';
  if (horizon === 'blocked') return 'human';
  return 'fast';
}

function noRouteForSelection(requestedModelTier, requestedHorizon) {
  if (requestedModelTier && !requestedHorizon) return noRouteForModel(requestedModelTier);
  const modelTier = requestedModelTier || defaultModelTierForHorizon(requestedHorizon);
  const scope = requestedModelTier
    ? `${requestedModelTier} model route in ${requestedHorizon} horizon`
    : `${requestedHorizon} horizon route`;
  const decision = {
    lane: 'no_current_task',
    urgency: 'orient',
    model: modelTier,
    reason: `No ${scope} is available in the current queue.`,
  };
  const command = 'atris radar --json';
  const details = {
    horizon: requestedHorizon || 'orient',
    work_size: 'context',
    model_tier: modelTier,
    agent_directive: `Do not take work outside the requested 0-shot selection from this prompt. Inspect routes.all_options, then hand off to an available horizon or wait for new ${requestedHorizon || modelTier} work.`,
    first_command: command,
  };
  return routeFromDecision(decision, details, command);
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
    horizon_first: summarizeHorizonFirstRoutes(routes),
    models: summarizeRouteModels(routes),
    options: routes.slice(0, ROUTE_LIMIT),
    all_options: routes,
  };
}

function buildPacket(options = {}) {
  const root = findWorkspaceRoot(options.cwd || process.cwd());
  const requestedModelTier = normalizeModelTier(options.model_tier || options.modelTier || options.model);
  const requestedHorizon = normalizeHorizon(options.horizon || options.requested_horizon || options.requestedHorizon);
  const brain = collectBrain(root);
  const missionState = collectMissions(root);
  const goalState = collectCodexGoal(root);
  const taskState = collectTasks(root);
  const freshness = collectFreshness(root);
  const routeIndex = buildRouteIndex({ missionState, goalState, taskState });
  const { all_options: allRoutes, ...publicRouteIndex } = routeIndex;
  const selectedRoute = selectRoute(allRoutes, requestedModelTier, requestedHorizon);
  const modelTierMatch = requestedModelTier ? Boolean(selectedRoute) : null;
  const horizonMatch = requestedHorizon ? Boolean(selectedRoute) : null;
  const fallbackRoute = (requestedModelTier || requestedHorizon) && !selectedRoute
    ? noRouteForSelection(requestedModelTier, requestedHorizon)
    : null;
  const effectiveRoute = selectedRoute || fallbackRoute;
  const decision = selectedRoute
    ? {
      lane: selectedRoute.lane,
      urgency: selectedRoute.urgency,
      model: selectedRoute.model,
      reason: selectedRoute.reason,
    }
    : (fallbackRoute ? {
      lane: fallbackRoute.lane,
      urgency: fallbackRoute.urgency,
      model: fallbackRoute.model,
      reason: fallbackRoute.reason,
    } : classify(null));
  const command = effectiveRoute ? effectiveRoute.first_command : nextCommand(null, decision.lane);
  const details = selectedRoute
    ? {
      horizon: selectedRoute.horizon,
      work_size: selectedRoute.work_size,
      model_tier: selectedRoute.model_tier,
      agent_directive: selectedRoute.agent_directive,
      first_command: selectedRoute.first_command,
    }
    : (fallbackRoute ? {
      horizon: fallbackRoute.horizon,
      work_size: fallbackRoute.work_size,
      model_tier: fallbackRoute.model_tier,
      agent_directive: fallbackRoute.agent_directive,
      first_command: fallbackRoute.first_command,
    } : laneDetails(null, decision.lane, command));
  const selectedTaskRoute = selectedRoute && selectedRoute.kind === 'task' ? selectedRoute : null;
  const publicOptions = publicRouteIndex.options.map(route => publicRoute(route, root));
  const publicAllOptions = allRoutes.map(route => publicRoute(route, root));
  const publicRoutes = {
    ...publicRouteIndex,
    requested_model_tier: requestedModelTier,
    model_tier_match: modelTierMatch,
    requested_horizon: requestedHorizon,
    horizon_match: horizonMatch,
    visible_limit: ROUTE_LIMIT,
    hidden_count: Math.max(0, publicAllOptions.length - publicOptions.length),
    options: publicOptions,
    all_options: publicAllOptions,
  };
  const handoffRoute = effectiveRoute ? publicRoute(effectiveRoute, root) : routeFromDecision(decision, details, command);
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
      requested_model_tier: requestedModelTier,
      model_tier_match: modelTierMatch,
      requested_horizon: requestedHorizon,
      horizon_match: horizonMatch,
    },
    queue: taskState.counts,
    routes: publicRoutes,
    handoff: buildHandoff(handoffRoute, root, publicRoutes, taskState.counts),
    freshness,
    durable: {
      write_command: ZERO_SHOT_WRITE_COMMAND,
      latest_json: LATEST_PACKET_RELATIVE_PATH,
      prompt_txt: LATEST_PROMPT_RELATIVE_PATH,
      menu_txt: LATEST_MENU_RELATIVE_PATH,
      model_prompt_txt: modelPromptRelativePaths(),
      horizon_prompt_txt: horizonPromptRelativePaths(),
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
      zero_shot_all: ZERO_SHOT_ALL_COMMAND,
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
  const menuTxtPath = path.join(root, LATEST_MENU_RELATIVE_PATH);
  const modelPromptRecords = buildModelPromptRecords(packet, root);
  const horizonPromptRecords = buildHorizonPromptRecords(packet, root);
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
      menu_txt: LATEST_MENU_RELATIVE_PATH,
      latest_json_abs: latestJsonPath,
      prompt_txt_abs: promptTxtPath,
      menu_txt_abs: menuTxtPath,
      model_prompt_txt: modelPromptRelativePaths(),
      model_prompts: publicModelPromptRecords(modelPromptRecords),
      horizon_prompt_txt: horizonPromptRelativePaths(),
      horizon_prompts: publicHorizonPromptRecords(horizonPromptRecords),
      source_fingerprint: packet.freshness ? packet.freshness.source_fingerprint : null,
    },
  };
  fs.mkdirSync(path.dirname(latestJsonPath), { recursive: true });
  fs.writeFileSync(latestJsonPath, `${JSON.stringify(packetToWrite, null, 2)}\n`, 'utf8');
  fs.writeFileSync(promptTxtPath, `${packetToWrite.handoff.prompt}\n`, 'utf8');
  fs.writeFileSync(menuTxtPath, `${renderRouteMenu(packetToWrite)}\n`, 'utf8');
  for (const record of Object.values(modelPromptRecords)) {
    fs.writeFileSync(record.prompt_txt_abs, `${record.prompt}\n`, 'utf8');
  }
  for (const record of Object.values(horizonPromptRecords)) {
    fs.writeFileSync(record.prompt_txt_abs, `${record.prompt}\n`, 'utf8');
  }
  return packetToWrite;
}

function buildLatestCheck(options = {}) {
  const current = buildPacket(options);
  const root = current.workspace_root;
  const latestPath = path.join(root, LATEST_PACKET_RELATIVE_PATH);
  const promptPath = path.join(root, LATEST_PROMPT_RELATIVE_PATH);
  const menuPath = path.join(root, LATEST_MENU_RELATIVE_PATH);
  const latest = readJson(latestPath);
  const currentFingerprint = current.freshness.source_fingerprint;
  const latestFingerprint = latest && latest.freshness ? latest.freshness.source_fingerprint : null;
  const promptExists = fs.existsSync(promptPath);
  const expectedPromptText = `${current.handoff.prompt}\n`;
  const actualPromptText = promptExists ? readText(promptPath) : '';
  const promptFresh = Boolean(promptExists && actualPromptText === expectedPromptText);
  const menuExists = fs.existsSync(menuPath);
  const expectedMenuText = `${renderRouteMenu(current)}\n`;
  const actualMenuText = menuExists ? readText(menuPath) : '';
  const menuFresh = Boolean(menuExists && actualMenuText === expectedMenuText);
  const expectedModelPromptRecords = buildModelPromptRecords(current, root);
  const modelPrompts = checkPromptRecords(expectedModelPromptRecords, MODEL_TIERS);
  const modelPromptsFresh = Object.values(modelPrompts).every(record => record.matches_expected);
  const expectedHorizonPromptRecords = buildHorizonPromptRecords(current, root);
  const horizonPrompts = checkPromptRecords(expectedHorizonPromptRecords, HORIZON_PROMPTS.map(([key]) => key));
  const horizonPromptsFresh = Object.values(horizonPrompts).every(record => record.matches_expected);
  const exists = Boolean(latest);
  const fresh = Boolean(exists && promptFresh && menuFresh && modelPromptsFresh && horizonPromptsFresh && latestFingerprint && latestFingerprint === currentFingerprint);
  return {
    schema: 'atris.zero_shot_latest_check.v1',
    ok: fresh,
    status: fresh ? 'fresh' : (exists ? 'stale' : 'missing'),
    workspace_root: root,
    latest_json: LATEST_PACKET_RELATIVE_PATH,
    prompt_txt: LATEST_PROMPT_RELATIVE_PATH,
    menu_txt: LATEST_MENU_RELATIVE_PATH,
    model_prompt_txt: modelPromptRelativePaths(),
    horizon_prompt_txt: horizonPromptRelativePaths(),
    latest_exists: exists,
    prompt_exists: promptExists,
    prompt_fresh: promptFresh,
    prompt_actual_sha1: promptExists ? sha1(actualPromptText) : null,
    prompt_expected_sha1: sha1(expectedPromptText),
    menu_exists: menuExists,
    menu_fresh: menuFresh,
    menu_actual_sha1: menuExists ? sha1(actualMenuText) : null,
    menu_expected_sha1: sha1(expectedMenuText),
    model_prompts: modelPrompts,
    model_prompts_fresh: modelPromptsFresh,
    horizon_prompts: horizonPrompts,
    horizon_prompts_fresh: horizonPromptsFresh,
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
    `prompt: ${check.prompt_fresh ? 'fresh' : (check.prompt_exists ? 'stale' : 'missing')} (${check.prompt_txt})`,
    `menu: ${check.menu_fresh ? 'fresh' : (check.menu_exists ? 'stale' : 'missing')} (${check.menu_txt})`,
    `model prompts: ${check.model_prompts_fresh ? 'fresh' : 'stale_or_missing'}`,
    `horizon prompts: ${check.horizon_prompts_fresh ? 'fresh' : 'stale_or_missing'}`,
    `selected: ${check.latest_selected_ref || 'none'} -> current ${check.current_selected_ref || 'none'}`,
    `refresh: ${check.refresh_command}`,
  ].join('\n');
}

function durableFreshnessLabel(exists, fresh) {
  if (fresh) return 'fresh';
  if (exists) return 'stale';
  return 'missing';
}

function durableGroupFreshnessLabel(fresh) {
  if (fresh === true) return 'fresh';
  if (fresh === false) return 'stale_or_missing';
  return 'unknown';
}

function renderDurableSummary(check = {}) {
  return [
    `0-shot durable: status=${check.status || 'unknown'}`,
    `prompt=${durableFreshnessLabel(check.prompt_exists, check.prompt_fresh)}`,
    `menu=${durableFreshnessLabel(check.menu_exists, check.menu_fresh)}`,
    `model=${durableGroupFreshnessLabel(check.model_prompts_fresh)}`,
    `horizon=${durableGroupFreshnessLabel(check.horizon_prompts_fresh)}`,
    `| files: ${check.menu_txt || LATEST_MENU_RELATIVE_PATH}, ${check.prompt_txt || LATEST_PROMPT_RELATIVE_PATH}`,
    `| check: ${check.check_command || ZERO_SHOT_CHECK_COMMAND}`,
  ].join(' ');
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

function renderCountSummary(label, summary, orderedKeys) {
  const counts = summary && typeof summary === 'object' ? summary : {};
  const seen = new Set(orderedKeys);
  const parts = orderedKeys.map(key => `${key}=${Number(counts[key] || 0)}`);
  Object.keys(counts)
    .filter(key => !seen.has(key))
    .sort()
    .forEach(key => parts.push(`${key}=${Number(counts[key] || 0)}`));
  return `${label}: ${parts.join(' ')}`;
}

function firstRouteText(route) {
  if (!route) return 'none';
  const ref = route.ref || route.lane || 'workspace';
  return `${ref}/${route.model_tier || 'unknown'}`;
}

function firstRoutesByHorizonText(firstRoutes = {}) {
  return [
    `now=${firstRouteText(firstRoutes.now)}`,
    `review=${firstRouteText(firstRoutes.immediate_review)}`,
    `long=${firstRouteText(firstRoutes.long_term)}`,
    `blocked=${firstRouteText(firstRoutes.blocked)}`,
    `orient=${firstRouteText(firstRoutes.orient)}`,
  ].join(' ');
}

function firstRoutesByModelText(models = {}) {
  return MODEL_TIERS
    .map(tier => `${tier}=${firstRouteText(models[tier] && models[tier].first)}`)
    .join(' ');
}

function renderModelSummary(models) {
  const counts = {};
  for (const tier of MODEL_TIERS) counts[tier] = models && models[tier] ? models[tier].count || 0 : 0;
  for (const [tier, value] of Object.entries(models || {})) {
    if (!Object.prototype.hasOwnProperty.call(counts, tier)) counts[tier] = value && value.count || 0;
  }
  return renderCountSummary('models', counts, MODEL_TIERS);
}

function renderRouteMenu(packet) {
  const routes = packet.routes || {};
  const hasFullOptions = Array.isArray(routes.all_options);
  const options = allPublicRouteOptions(packet);
  const lines = ['route menu:'];
  lines.push(`first by horizon: ${firstRoutesByHorizonText(routes.horizon_first || {})}`);
  lines.push(`first by model: ${firstRoutesByModelText(routes.models || {})}`);
  if (!options.length) {
    lines.push('  none | run: atris radar --json');
  } else {
    options.forEach((route, index) => {
      const focus = route.ref ? `${route.ref} - ${route.title || '(untitled)'}` : (route.title || 'workspace');
      lines.push(`${index + 1}. ${route.horizon}/${route.model_tier}/${route.lane} | ${focus}`);
      lines.push(`   run: ${route.first_command}`);
      lines.push(`   why: ${route.reason}`);
    });
    if (!hasFullOptions && routes.total > options.length) {
      lines.push(`   +${routes.total - options.length} more not shown; use atris 0-shot --json for routes.options`);
    }
  }
  lines.push('select horizon: atris 0-shot --horizon now|review|long|blocked|orient --prompt');
  lines.push('select model: atris 0-shot --model fast|pro|validator|human --prompt');
  return lines.join('\n');
}

function renderPacket(packet, options = {}) {
  const selected = packet.decision.selected_ref
    ? `${packet.decision.selected_ref} - ${packet.decision.selected_title}`
    : 'none';
  const requestLines = [];
  if (packet.decision.requested_model_tier) {
    requestLines.push(`model request: ${packet.decision.requested_model_tier} | match=${packet.decision.model_tier_match}`);
  }
  if (packet.decision.requested_horizon) {
    requestLines.push(`horizon request: ${packet.decision.requested_horizon} | match=${packet.decision.horizon_match}`);
  }
  const lines = [
    '0-shot next move',
    `route: ${packet.decision.lane} | ${packet.decision.urgency} | ${packet.decision.model}`,
    `focus: ${selected}`,
    `why: ${packet.decision.reason}`,
    `run: ${packet.commands.next_command}`,
    `queue: ${packet.queue.claimed} claimed, ${packet.queue.review} review, ${packet.queue.open} open, ${packet.queue.blocked} blocked, ${packet.queue.failed} failed`,
    renderRouteSummary(packet.routes),
    renderCountSummary('horizons', packet.routes && packet.routes.horizons, HORIZON_ORDER),
    renderModelSummary(packet.routes && packet.routes.models),
    ...(options.all ? [renderRouteMenu(packet)] : []),
    `prompt: ${packet.commands.zero_shot_prompt}`,
    `all: ${packet.commands.zero_shot_all}`,
    `write: ${packet.commands.zero_shot_write} -> ${packet.durable.latest_json}`,
    `check: ${packet.freshness.check_command}`,
    `missions: ${packet.missions.active} active, ${packet.missions.needs_tick} need verifier tick`,
    `goal: ${packet.goal.objective ? packet.goal.objective.slice(0, 90) : 'none'}`,
    `boundaries: no external sends, no human accept, no task mutation${packet.boundaries.no_file_writes ? ', no file writes' : ''}`,
    `json: ${packet.commands.zero_shot_json}`,
  ];
  if (requestLines.length) lines.splice(2, 0, ...requestLines);
  return lines.join('\n');
}

function renderHint(packet) {
  if (!packet || !packet.decision || !packet.commands) return `0-shot: ${ZERO_SHOT_PROMPT_COMMAND}`;
  const routes = packet.routes || {};
  const horizons = routes.horizons || {};
  const models = routes.models || {};
  return [
    `0-shot: ${packet.decision.lane} -> ${packet.commands.next_command}`,
    `prompt: ${packet.commands.zero_shot_prompt || ZERO_SHOT_PROMPT_COMMAND}`,
    `queue ${queueSummaryText(packet.queue || {})}`,
    `routes total=${routes.total || 0} hidden=${routes.hidden_count || 0}`,
    `horizons now=${horizons.now || 0} review=${horizons.immediate_review || 0} long=${horizons.long_term || 0} blocked=${horizons.blocked || 0} orient=${horizons.orient || 0}`,
    `models fast=${models.fast?.count || 0} pro=${models.pro?.count || 0} validator=${models.validator?.count || 0} human=${models.human?.count || 0}`,
    `model first ${firstRoutesByModelText(models)}`,
  ].join(' | ');
}

function renderHelp() {
  return [
    'Usage: atris 0-shot [--json|--prompt|--all|--write|--check] [--model fast|pro|validator|human] [--horizon now|review|long|blocked|orient]',
    'Alias: atris zero-shot [--json|--prompt|--all|--write|--check] [--model fast|pro|validator|human] [--horizon now|review|long|blocked|orient]',
    'Also accepts: atris 0 shot, atris 0shot, atris zero shot, atris zeroshot',
    '',
    'Use when you do not know what to prompt next.',
    'Selects one read-only lane: mission_tick, goal_context, quick_task, fast_model_task, long_horizon, review_lane, recovery_lane, owner_gate, or no_current_task.',
    '--model fast|pro|validator|human selects the first route suited to that model tier; --fast, --pro, --validator, and --human are shortcuts.',
    '--horizon now|review|long|blocked|orient selects the first route in that work horizon; --quick, --review, --long, --blocked, and --orient are shortcuts.',
    'Human output shows the first command to run.',
    '--json includes lane, horizon, work_size, model_tier, agent_directive, first_command, requested_horizon, bounded routes.options, full routes.all_options, routes.models, handoff.prompt, and safety boundaries.',
    '--prompt prints only the copy-pasteable handoff.prompt for any model, including selected route, route inventory, horizon buckets, and model buckets.',
    '--all prints the selected route plus the full route menu across horizons and model tiers.',
    `--write refreshes ${LATEST_PACKET_RELATIVE_PATH}, ${LATEST_PROMPT_RELATIVE_PATH}, ${LATEST_MENU_RELATIVE_PATH}, per-model prompt files, and per-horizon prompt files for ambient agents; it does not mutate tasks or call external systems.`,
    '--check compares the durable latest packet, global prompt, route menu, per-model prompts, per-horizon prompts, and current source fingerprints, then exits 0 only when fresh.',
    'Reads atris/brain/STATUS.md, .atris/state/tasks.projection.json, .atris/state/missions.jsonl, and .atris/state/codex_goal.json without accepting tasks or calling external systems.',
  ].join('\n');
}

function zeroShotCommand(args = []) {
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    console.log(renderHelp());
    return 0;
  }
  const modelArg = parseModelTierArg(args);
  if (modelArg.error) {
    console.error(modelArg.error);
    return 1;
  }
  const horizonArg = parseHorizonArg(args);
  if (horizonArg.error) {
    console.error(horizonArg.error);
    return 1;
  }
  if (args.includes('--check')) {
    const check = buildLatestCheck();
    if (args.includes('--json')) {
      console.log(JSON.stringify(check, null, 2));
    } else {
      console.log(renderLatestCheck(check));
    }
    return check.ok ? 0 : 1;
  }
  let packet = buildPacket({ modelTier: modelArg.tier, horizon: horizonArg.horizon });
  if (args.includes('--write')) {
    packet = writeLatestPacket(packet);
  }
  if (args.includes('--json')) {
    console.log(JSON.stringify(packet, null, 2));
  } else if (args.includes('--prompt')) {
    console.log(packet.handoff.prompt);
  } else {
    console.log(renderPacket(packet, { all: args.includes('--all') || args.includes('--menu') || args.includes('--routes') }));
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
  renderDurableSummary,
  renderLatestCheck,
  renderPacket,
  writeLatestPacket,
  zeroShotCommand,
};
