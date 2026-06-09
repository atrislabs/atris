'use strict';

const fs = require('fs');
const path = require('path');

const SCHEMA = 'atris.zero_shot_next_move.v1';

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function readJson(file) {
  try { return JSON.parse(readText(file)); } catch { return null; }
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
  const tasks = Array.isArray(projection.tasks) ? projection.tasks.map(normalizeTask).filter(Boolean) : [];
  const counts = { total: tasks.length, open: 0, claimed: 0, review: 0, blocked: 0, done: 0 };
  for (const task of tasks) {
    if (Object.prototype.hasOwnProperty.call(counts, task.status)) counts[task.status] += 1;
  }
  return { projection_present: Boolean(projection.schema || tasks.length), tasks, counts };
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

function selectMission(missions) {
  return missions.needs_tick[0] || null;
}

function selectTask(tasks) {
  const active = tasks.filter(task => !['done', 'accepted', 'complete', 'completed'].includes(task.status));
  return active.find(task => task.status === 'review')
    || active.find(task => task.status === 'claimed')
    || active.find(task => task.status === 'blocked')
    || active.find(task => task.status === 'open')
    || null;
}

function textFor(task) {
  return [task && task.title, task && task.objective, task && task.tag, JSON.stringify((task && task.metadata) || {})]
    .filter(Boolean)
    .join(' ');
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
  if (task.status === 'review' || reviewStatus) {
    return { lane: 'review_lane', urgency: 'high', model: 'validator', reason: `${task.ref} is waiting on review or verification.` };
  }
  if (task.status === 'blocked' || /human accept|human approval|owner approval|owner gate|approval|credential|secret|billing|customer approval|external send|accept gate|merge approval|publish approval|notar/i.test(text)) {
    return { lane: 'owner_gate', urgency: 'blocked', model: 'human', reason: `${task.ref} appears owner-gated or blocked.` };
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
  if (lane === 'mission_tick' && task && task.ref) return `atris mission tick ${shellToken(task.ref)} --verify --complete-on-pass`;
  if (lane === 'review_lane' && task && task.ref) return `atris task review-chat ${shellToken(task.ref)} --as codex-review`;
  if (lane === 'fast_model_task' || lane === 'quick_task') {
    return task && task.tag
      ? `atris task current-step --tag ${shellToken(task.tag)} --json`
      : 'atris task current-step --json';
  }
  if (lane === 'owner_gate') return 'atris radar --json';
  return 'atris radar --json';
}

function laneDetails(task, lane, command) {
  const ref = task && task.ref ? task.ref : 'the current workspace';
  const details = {
    mission_tick: {
      horizon: 'long_term',
      work_size: 'long',
      model_tier: 'pro',
      agent_directive: `Advance mission ${ref}; run the verifier tick before starting unrelated work.`,
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
    no_current_task: {
      horizon: 'orient',
      work_size: 'context',
      model_tier: 'fast',
      agent_directive: 'Run the context check, then create or claim one bounded task from evidence.',
    },
  };
  return {
    ...(details[lane] || details.quick_task),
    first_command: command,
  };
}

function buildPacket(options = {}) {
  const root = findWorkspaceRoot(options.cwd || process.cwd());
  const brain = collectBrain(root);
  const missionState = collectMissions(root);
  const taskState = collectTasks(root);
  const selectedMission = selectMission(missionState);
  const selectedTask = selectedMission ? null : selectTask(taskState.tasks);
  const selected = selectedMission
    ? { ref: selectedMission.id, title: selectedMission.objective || 'Mission tick', kind: 'mission' }
    : selectedTask;
  const decision = selectedMission
    ? { lane: 'mission_tick', urgency: 'high', model: 'pro', reason: `${selectedMission.id} has an unverified mission verifier.` }
    : classify(selectedTask);
  const command = nextCommand(selected, decision.lane);
  const details = laneDetails(selected, decision.lane, command);
  return {
    schema: SCHEMA,
    generated_at: new Date().toISOString(),
    workspace_root: root,
    decision: {
      ...decision,
      ...details,
      confidence: selected || brain.status_present ? 'medium' : 'low',
      selected_ref: selected ? selected.ref : null,
      selected_title: selected ? selected.title : null,
      selected_kind: selectedMission ? 'mission' : (selectedTask ? 'task' : null),
    },
    queue: taskState.counts,
    missions: {
      active: missionState.active_count,
      needs_tick: missionState.needs_tick_count,
    },
    brain,
    commands: {
      zero_shot_json: 'atris zero-shot --json',
      next_command: command,
      first_command: command,
      context_check: 'atris radar --json',
      mission_status: 'atris mission status --status active --json',
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
    `queue: ${packet.queue.claimed} claimed, ${packet.queue.review} review, ${packet.queue.open} open, ${packet.queue.blocked} blocked`,
    `missions: ${packet.missions.active} active, ${packet.missions.needs_tick} need verifier tick`,
    'boundaries: no external sends, no human accept, no task mutation, no file writes',
    `json: ${packet.commands.zero_shot_json}`,
  ].join('\n');
}

function renderHint(packet) {
  if (!packet || !packet.decision || !packet.commands) return '0-shot: atris zero-shot';
  return `0-shot: ${packet.decision.lane} -> ${packet.commands.next_command}`;
}

function renderHelp() {
  return [
    'Usage: atris zero-shot [--json]',
    '',
    'Use when you do not know what to prompt next.',
    'Selects one read-only lane: mission_tick, quick_task, fast_model_task, long_horizon, review_lane, owner_gate, or no_current_task.',
    'Human output shows the first command to run.',
    '--json includes lane, horizon, work_size, model_tier, agent_directive, first_command, and safety boundaries.',
    'Reads atris/brain/STATUS.md, .atris/state/tasks.projection.json, and .atris/state/missions.jsonl without writing state, accepting tasks, or calling external systems.',
  ].join('\n');
}

function zeroShotCommand(args = []) {
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    console.log(renderHelp());
    return 0;
  }
  const packet = buildPacket();
  if (args.includes('--json')) {
    console.log(JSON.stringify(packet, null, 2));
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
  collectMissions,
  collectTasks,
  renderHint,
  renderPacket,
  zeroShotCommand,
};
