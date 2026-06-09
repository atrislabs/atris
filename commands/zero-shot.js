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
  if (lane === 'review_lane' && task && task.ref) return `atris task review-chat ${shellToken(task.ref)} --as codex-review`;
  if (lane === 'fast_model_task' || lane === 'quick_task') {
    return task && task.tag
      ? `atris task current-step --tag ${shellToken(task.tag)} --json`
      : 'atris task current-step --json';
  }
  if (lane === 'owner_gate') return 'atris radar --json';
  return 'atris radar --json';
}

function buildPacket(options = {}) {
  const root = findWorkspaceRoot(options.cwd || process.cwd());
  const brain = collectBrain(root);
  const taskState = collectTasks(root);
  const selected = selectTask(taskState.tasks);
  const decision = classify(selected);
  return {
    schema: SCHEMA,
    generated_at: new Date().toISOString(),
    workspace_root: root,
    decision: {
      ...decision,
      confidence: selected || brain.status_present ? 'medium' : 'low',
      selected_ref: selected ? selected.ref : null,
      selected_title: selected ? selected.title : null,
    },
    queue: taskState.counts,
    brain,
    commands: {
      zero_shot_json: 'atris zero-shot --json',
      next_command: nextCommand(selected, decision.lane),
      context_check: 'atris radar --json',
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
    'boundaries: no external sends, no human accept, no task mutation, no file writes',
    `json: ${packet.commands.zero_shot_json}`,
  ].join('\n');
}

function renderHelp() {
  return [
    'Usage: atris zero-shot [--json]',
    '',
    'Print the next safe move when the operator gives no prompt.',
    'Reads atris/brain/STATUS.md and .atris/state/tasks.projection.json without writing state.',
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
  collectTasks,
  renderPacket,
  zeroShotCommand,
};
