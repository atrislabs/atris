'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const AGENTXP_LEADERBOARD_URL = 'https://api.atris.ai/api/agentxp/leaderboard';
const AGENTXP_GLOBAL_SYNC_RULE = 'Use the owner-provided sync token first; fallback is atris login before sync.';

const ROLE_PLAYERS_TO_IGNORE = new Set([
  'game-manager',
  'navigator',
  'executor',
  'validator',
  'launcher',
  'researcher',
  'brainstormer',
  'ops',
]);

function showHelp() {
  console.log('');
  console.log('Usage: atris gm [--manager <id>] [--player <id>] [--workspace <path>] [--json]');
  console.log('');
  console.log('Description:');
  console.log('  Enter AgentXP General Manager mode for the current Atris workspace.');
  console.log('  Shows local players, active missions, review queue, and the next command');
  console.log('  that moves the same AgentXP game loop forward.');
  console.log('');
  console.log('Options:');
  console.log('  --manager <id>    Manager id. Defaults to game-manager when present.');
  console.log('  --as <id>         Alias for --player.');
  console.log('  --player <id>     Preferred player when seeding a first local mission.');
  console.log('  --workspace <p>   Read missions from another Atris workspace.');
  console.log('  --no-seed         Do not create a starter player mission.');
  console.log('  --json            Print machine-readable mode state.');
  console.log('  --help, -h        Show this help.');
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

function slugify(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/@.*$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function taskRef(task) {
  return task.display_id || task.legacy_ref || String(task.id || '').slice(0, 8);
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

function clip(value, max = 240) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3)).trim()}...`;
}

function teamMembers(workspaceRoot) {
  const teamDir = path.join(workspaceRoot, 'atris', 'team');
  try {
    return fs.readdirSync(teamDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => slugify(entry.name))
      .filter(Boolean)
      .filter(name => !name.startsWith('_') && name !== 'template')
      .filter(name => fs.existsSync(path.join(teamDir, name, 'MEMBER.md')) || fs.existsSync(path.join(teamDir, name, 'START_HERE.md')));
  } catch {
    return [];
  }
}

function inferManager(workspaceRoot, args = []) {
  const explicit = flag(args, '--manager') || positional(args)[0];
  if (explicit) return { manager: slugify(explicit), source: 'flag' };

  for (const value of [process.env.ATRIS_GM, process.env.ATRIS_MANAGER, process.env.ATRIS_AGENT_ID]) {
    const manager = slugify(value);
    if (manager) return { manager, source: 'env' };
  }

  if (fs.existsSync(path.join(workspaceRoot, 'atris', 'team', 'game-manager'))) {
    return { manager: 'game-manager', source: 'team' };
  }

  return { manager: 'game-manager', source: 'default' };
}

function activeTasks(tasks) {
  return (tasks || []).filter(task => !['done', 'failed'].includes(task.status));
}

function activeAgentXpTasks(tasks) {
  return activeTasks(tasks).filter((task) => {
    const metadata = task.metadata || {};
    const text = `${task.title || ''} ${task.tag || ''} ${metadata.delegate_via || ''}`.toLowerCase();
    return text.includes('agentxp') || text.includes('agent-xp');
  });
}

function playersFromTasks(tasks) {
  const players = new Set();
  for (const task of activeTasks(tasks)) {
    const assignee = slugify(taskAssignee(task));
    if (assignee && !ROLE_PLAYERS_TO_IGNORE.has(assignee)) players.add(assignee);
    const claimedBy = slugify(task.claimed_by);
    if (claimedBy && !ROLE_PLAYERS_TO_IGNORE.has(claimedBy)) players.add(claimedBy);
  }
  return Array.from(players).sort();
}

function playersFromWorkspace(workspaceRoot) {
  return teamMembers(workspaceRoot)
    .filter(member => !ROLE_PLAYERS_TO_IGNORE.has(member))
    .sort();
}

function starterMissionTitle() {
  return 'AgentXP Mode first rep: complete one proof-backed customer-motion mission';
}

function starterMissionPrompt(player) {
  return [
    `Player ${player}: enter AgentXP Mode in this local workspace.`,
    'Pick one concrete customer-motion rep you can finish today.',
    'Use an agent for the artifact and verifier proof.',
    'Human accept/revise gates the XP.',
  ].join(' ');
}

function pickSeedPlayer(workspaceRoot, tasks, args = []) {
  const explicit = flag(args, '--player') || flag(args, '--user') || flag(args, '--as');
  if (explicit) return slugify(explicit);

  const fromTasks = playersFromTasks(tasks);
  if (fromTasks.length === 1) return fromTasks[0];

  const fromWorkspace = playersFromWorkspace(workspaceRoot);
  if (fromWorkspace.length === 1) return fromWorkspace[0];

  const local = slugify(process.env.ATRIS_PLAYER || process.env.USER || os.userInfo().username);
  if (local && !ROLE_PLAYERS_TO_IGNORE.has(local)) return local;

  return null;
}

function ensureStarterMission(taskDb, db, workspaceRoot, tasks, args = []) {
  if (hasFlag(args, '--no-seed')) return { tasks, seeded: null };
  if (!fs.existsSync(path.join(workspaceRoot, 'atris'))) return { tasks, seeded: null };
  if (activeAgentXpTasks(tasks).length) return { tasks, seeded: null };

  const player = pickSeedPlayer(workspaceRoot, tasks, args);
  if (!player) return { tasks, seeded: null };

  const result = taskDb.addTask(db, {
    title: starterMissionTitle(),
    tag: 'agent-xp',
    workspaceRoot,
    metadata: {
      assigned_to: player,
      delegate_via: 'agentxp_gm',
      auto_seeded_by: 'atris gm',
      created_for_day: new Date().toISOString().slice(0, 10),
    },
  });
  taskDb.noteTask(db, {
    id: result.id,
    actor: 'game-manager',
    content: starterMissionPrompt(player),
  });

  const refreshed = taskDb.withTaskDisplayRefs(taskDb.listTasks(db, {
    workspaceRoot,
    limit: 500,
  }));
  return {
    tasks: refreshed,
    seeded: refreshed.find(task => task.id === result.id) || null,
  };
}

function groupPlayers(tasks, workspaceRoot) {
  const players = new Map();
  for (const task of activeTasks(tasks)) {
    const player = slugify(taskAssignee(task)) || 'unassigned';
    if (!players.has(player)) {
      players.set(player, {
        player,
        source: 'task',
        open: 0,
        claimed: 0,
        review: 0,
        active: 0,
      });
    }
    const row = players.get(player);
    row.active += 1;
    if (task.status === 'open') row.open += 1;
    if (task.status === 'claimed') row.claimed += 1;
    if (task.status === 'review') row.review += 1;
  }

  if (!players.size) {
    for (const player of playersFromWorkspace(workspaceRoot)) {
      players.set(player, {
        player,
        source: 'team',
        open: 0,
        claimed: 0,
        review: 0,
        active: 0,
      });
    }
  }

  return Array.from(players.values())
    .filter(row => !ROLE_PLAYERS_TO_IGNORE.has(row.player))
    .sort((a, b) => b.active - a.active || a.player.localeCompare(b.player));
}

function compactTask(task) {
  if (!task) return null;
  return {
    id: task.id,
    ref: taskRef(task),
    title: task.title,
    status: task.status,
    assigned_to: taskAssignee(task),
    claimed_by: task.claimed_by || null,
  };
}

function globalSyncCommands(player) {
  return [
    `atris xp sync --local --as ${player} --token <owner-provided-token>`,
    'atris login',
    `atris xp sync --local --as ${player}`,
  ];
}

function nextCommands({ seeded, reviewQueue, missions, players, manager }) {
  if (reviewQueue.length) {
    const task = reviewQueue[0];
    const ref = task.ref;
    const player = task.assigned_to || task.claimed_by || players[0]?.player || 'player';
    return [
      `atris task show ${ref}`,
      `atris task accept ${ref} --as ${player} --proof "<human review>"`,
      `atris task revise ${ref} --as ${player} --note "<what must change>"`,
      ...globalSyncCommands(player),
    ];
  }
  if (missions.length) {
    const mission = missions[0];
    const player = mission.assigned_to || mission.claimed_by || players[0]?.player || 'player';
    if (mission.status === 'open') return [`atris task claim ${mission.ref} --as ${manager || 'game-manager'}`];
    return [`atris play --as ${player}`];
  }
  if (seeded) return [`atris play --as ${seeded.assigned_to || 'player'}`];
  return ['atris gm --player <player>'];
}

function gmState(args = []) {
  const taskDb = require('../lib/task-db');
  const workspaceArg = flag(args, '--workspace') || flag(args, '--root') || process.cwd();
  const workspaceRoot = taskDb.workspaceRoot(path.resolve(workspaceArg));
  const db = taskDb.open();
  let tasks = taskDb.withTaskDisplayRefs(taskDb.listTasks(db, {
    workspaceRoot,
    limit: 500,
  }));
  const detected = inferManager(workspaceRoot, args);
  const starter = ensureStarterMission(taskDb, db, workspaceRoot, tasks, args);
  tasks = starter.tasks;

  const missions = activeAgentXpTasks(tasks).map(compactTask);
  const reviewQueue = missions.filter(task => task.status === 'review');
  const players = groupPlayers(tasks, workspaceRoot);
  const seeded = compactTask(starter.seeded);
  const commands = nextCommands({ seeded, reviewQueue, missions, players, manager: detected.manager });

  return {
    schema: 'atris.agentxp_gm_mode.v1',
    mode: 'AgentXP General Manager',
    generated_at: new Date().toISOString(),
    manager: detected.manager,
    manager_source: detected.source,
    workspace_root: workspaceRoot,
    workspace_name: path.basename(workspaceRoot),
    seeded,
    counts: {
      players: players.length,
      missions: missions.length,
      review: reviewQueue.length,
    },
    players,
    missions,
    review_queue: reviewQueue,
    next_commands: commands,
    xp_rule: 'GM can route missions and review proof, but AgentXP still lands only after human accept.',
    global_sync_rule: AGENTXP_GLOBAL_SYNC_RULE,
    leaderboard_url: AGENTXP_LEADERBOARD_URL,
  };
}

function render(state) {
  console.log('');
  console.log('AgentXP General Manager');
  console.log(`Manager ${state.manager} | Workspace ${state.workspace_name}`);
  console.log('');

  if (state.seeded) {
    console.log(`Starter mission created locally: ${state.seeded.ref} -> ${state.seeded.assigned_to || 'player'}`);
    console.log('');
  }

  console.log(`Players ${state.counts.players} | Missions ${state.counts.missions} | Review ${state.counts.review}`);
  if (state.players.length) {
    console.log('');
    console.log('Players:');
    for (const player of state.players.slice(0, 8)) {
      console.log(`- ${player.player}: ${player.active} active, ${player.review} review`);
    }
  }

  if (state.missions.length) {
    console.log('');
    console.log('Missions:');
    for (const task of state.missions.slice(0, 8)) {
      console.log(`- ${task.ref} [${task.status}] ${task.assigned_to || 'unassigned'}: ${clip(task.title, 120)}`);
    }
  }

  console.log('');
  console.log('XP rule: no proof, no AgentXP; accept/revise stays human-gated.');
  console.log('Global sync: use owner token first; fallback to atris login before hosted leaderboard sync.');
  console.log(`Leaderboard: ${state.leaderboard_url}`);
  console.log('');
  console.log('Next commands:');
  for (const command of state.next_commands) console.log(`- ${command}`);
}

async function gmCommand(...args) {
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    showHelp();
    return;
  }

  const state = gmState(args);
  if (hasFlag(args, '--json')) {
    console.log(JSON.stringify(state, null, 2));
    return;
  }
  render(state);
}

module.exports = {
  gmCommand,
  gmState,
};
