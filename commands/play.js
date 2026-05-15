'use strict';

const path = require('path');
const os = require('os');

function showHelp() {
  console.log('');
  console.log('Usage: atris play [--as <player>] [--workspace <path>] [--json]');
  console.log('');
  console.log('Description:');
  console.log('  Enter AgentXP Mode for a player in the current Atris workspace.');
  console.log('  Shows the next proof-backed mission, the win condition, and the');
  console.log('  exact claim, proof, accept/revise, and XP card commands.');
  console.log('');
  console.log('Options:');
  console.log('  --as <player>        Player id, for example justin.');
  console.log('  --player <player>    Alias for --as.');
  console.log('  --workspace <path>   Read missions from another Atris workspace.');
  console.log('  --json               Print machine-readable mode state.');
  console.log('  --help, -h           Show this help.');
  console.log('');
}

function flag(args, name) {
  const inline = args.find(arg => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  if (index >= 0 && args[index + 1] && !args[index + 1].startsWith('--')) {
    return args[index + 1];
  }
  return null;
}

function hasFlag(args, name) {
  return args.includes(name) || args.some(arg => arg.startsWith(`${name}=`));
}

function positional(args) {
  return args.filter((arg, index) => {
    if (arg.startsWith('--')) return false;
    if (index > 0 && args[index - 1].startsWith('--')) return false;
    return true;
  });
}

function normalizeOwner(value) {
  return String(value || '').trim().toLowerCase();
}

function taskAssignee(task) {
  const metadata = task && task.metadata && typeof task.metadata === 'object'
    ? task.metadata
    : {};
  return metadata.assigned_to
    || metadata.owner
    || metadata.assignee
    || task.claimed_by
    || null;
}

function taskRef(task) {
  return task.display_id || task.legacy_ref || String(task.id || '').slice(0, 8);
}

function clip(value, max = 320) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3)).trim()}...`;
}

function latestMessage(events) {
  const messages = (events || [])
    .filter(event => event.event_type === 'message' && event.payload && event.payload.content)
    .sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0));
  return messages.length ? clip(messages[0].payload.content, 520) : null;
}

function rankTask(task, player) {
  const assignedTo = normalizeOwner(taskAssignee(task));
  const claimedBy = normalizeOwner(task.claimed_by);
  const target = normalizeOwner(player);
  const assignedMatch = target && assignedTo === target;
  const claimedMatch = target && claimedBy === target;

  if (task.status === 'claimed' && claimedMatch) return 0;
  if (task.status === 'review' && (claimedMatch || assignedMatch)) return 1;
  if (task.status === 'open' && assignedMatch) return 2;
  if (task.status === 'claimed') return 3;
  if (task.status === 'review') return 4;
  if (task.status === 'open') return 5;
  return 99;
}

function selectMission(tasks, player) {
  const active = (tasks || []).filter(task => !['done', 'failed'].includes(task.status));
  if (!active.length) return null;
  return [...active].sort((a, b) => {
    const rank = rankTask(a, player) - rankTask(b, player);
    if (rank) return rank;
    return Number(b.updated_at || b.created_at || 0) - Number(a.updated_at || a.created_at || 0);
  })[0] || null;
}

function nextCommands(task, player) {
  if (!task) {
    return [
      `atris task delegate "AgentXP first rep: one proof-backed mission" --to ${player} --tag agent-xp`,
      `atris play --as ${player}`,
    ];
  }

  const ref = taskRef(task);
  if (task.status === 'open') {
    return [
      `atris task claim ${ref} --as ${player}`,
      `atris task ready ${ref} --proof "<artifact path + verifier result>"`,
      `atris task accept ${ref} --proof "<human review>"`,
      'atris xp card --local',
    ];
  }

  if (task.status === 'claimed') {
    return [
      `atris task ready ${ref} --proof "<artifact path + verifier result>"`,
      `atris task accept ${ref} --proof "<human review>"`,
      'atris xp card --local',
    ];
  }

  if (task.status === 'review') {
    return [
      `atris task show ${ref}`,
      `atris task accept ${ref} --proof "<human review>"`,
      `atris task revise ${ref} --note "<what must change>"`,
      'atris xp card --local',
    ];
  }

  return [
    `atris task show ${ref}`,
    'atris xp card --local',
  ];
}

function modeState(args = []) {
  const taskDb = require('../lib/task-db');
  const player = flag(args, '--as')
    || flag(args, '--player')
    || flag(args, '--user')
    || positional(args)[0]
    || process.env.ATRIS_PLAYER
    || process.env.ATRIS_AGENT_ID
    || process.env.USER
    || os.userInfo().username
    || 'player';
  const workspaceArg = flag(args, '--workspace') || flag(args, '--root') || process.cwd();
  const workspaceRoot = taskDb.workspaceRoot(path.resolve(workspaceArg));
  const db = taskDb.open();
  const rows = taskDb.listTasks(db, {
    workspaceRoot,
    limit: 500,
  });
  const tasks = taskDb.withTaskDisplayRefs(rows);
  const mission = selectMission(tasks, player);
  const events = mission
    ? taskDb.listTaskEvents(db, { taskId: mission.id, limit: 20, order: 'desc' })
    : [];
  const commandList = nextCommands(mission, player);

  return {
    schema: 'atris.agentxp_play_mode.v1',
    mode: 'AgentXP Mode',
    generated_at: new Date().toISOString(),
    player,
    workspace_root: workspaceRoot,
    workspace_name: path.basename(workspaceRoot),
    mission: mission ? {
      id: mission.id,
      ref: taskRef(mission),
      title: mission.title,
      status: mission.status,
      tag: mission.tag || null,
      assigned_to: taskAssignee(mission),
      claimed_by: mission.claimed_by || null,
      prompt: latestMessage(events),
    } : null,
    xp_rule: 'AgentXP lands only after proof is ready and a human accepts the task.',
    next_commands: commandList,
  };
}

function render(state) {
  console.log('');
  console.log('AgentXP Mode');
  console.log(`Player ${state.player} | Workspace ${state.workspace_name}`);
  console.log('');

  if (!state.mission) {
    console.log('No active mission found.');
    console.log('');
    console.log('Seed one:');
    for (const command of state.next_commands) console.log(`- ${command}`);
    return;
  }

  const mission = state.mission;
  console.log(`Mission ${mission.ref}: ${mission.title}`);
  console.log(`State ${mission.status} | Assigned ${mission.assigned_to || 'unassigned'} | Claimed ${mission.claimed_by || 'none'}`);
  if (mission.prompt) {
    console.log('');
    console.log(`Prompt: ${mission.prompt}`);
  }
  console.log('');
  console.log('Win condition: real artifact + verifier + human accept.');
  console.log('XP rule: no proof, no AgentXP; accept/revise stays human-gated.');
  console.log('');
  console.log('Next commands:');
  for (const command of state.next_commands) console.log(`- ${command}`);
}

async function playCommand(...args) {
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    showHelp();
    return;
  }

  const state = modeState(args);
  if (hasFlag(args, '--json')) {
    console.log(JSON.stringify(state, null, 2));
    return;
  }
  render(state);
}

module.exports = {
  playCommand,
  modeState,
  selectMission,
};
