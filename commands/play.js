'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { getSessionProfile, loadCredentials } = require('../utils/auth');

const AGENTXP_LEADERBOARD_URL = 'https://api.atris.ai/api/agentxp/leaderboard';

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
  console.log('  --no-seed            Do not create a starter mission when none exists.');
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

function slugify(value) {
  return normalizeOwner(value)
    .replace(/@.*$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
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

function explicitPlayer(args) {
  return flag(args, '--as')
    || flag(args, '--player')
    || flag(args, '--user')
    || positional(args)[0]
    || null;
}

function activePlayerCounts(tasks) {
  const counts = new Map();
  for (const task of tasks || []) {
    if (!task || ['done', 'failed'].includes(task.status)) continue;
    const owner = slugify(taskAssignee(task));
    if (!owner) continue;
    counts.set(owner, (counts.get(owner) || 0) + 1);
  }
  return counts;
}

function uniqueAssignedPlayer(tasks) {
  const counts = activePlayerCounts(tasks);
  if (counts.size !== 1) return null;
  return Array.from(counts.keys())[0] || null;
}

function gitIdentityCandidate(workspaceRoot) {
  const candidates = [];
  for (const key of ['user.email', 'user.name']) {
    const result = spawnSync('git', ['config', '--get', key], {
      cwd: workspaceRoot,
      encoding: 'utf8',
      timeout: 1000,
    });
    if (result.status === 0 && result.stdout.trim()) {
      candidates.push(slugify(result.stdout.trim()));
    }
  }
  return candidates.find(Boolean) || null;
}

function activeAccountCandidate() {
  const envPlayer = slugify(process.env.ATRIS_PLAYER || process.env.ATRIS_USERNAME);
  if (envPlayer) return { player: envPlayer, source: 'env' };

  const envProfile = slugify(process.env.ATRIS_PROFILE);
  if (envProfile) return { player: envProfile, source: 'atris_profile' };

  try {
    const sessionProfile = slugify(getSessionProfile());
    if (sessionProfile) return { player: sessionProfile, source: 'atris_session' };
  } catch {}

  try {
    const credentials = loadCredentials();
    const credentialPlayer = slugify(
      credentials?.username
      || credentials?.handle
      || credentials?.display_name
      || credentials?.name
    );
    if (credentialPlayer) return { player: credentialPlayer, source: 'atris_account' };
  } catch {}

  return null;
}

function teamMemberExists(workspaceRoot, player) {
  const slug = slugify(player);
  return Boolean(slug) && fs.existsSync(path.join(workspaceRoot, 'atris', 'team', slug));
}

function onlyTeamMember(workspaceRoot) {
  const teamDir = path.join(workspaceRoot, 'atris', 'team');
  try {
    const members = fs.readdirSync(teamDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .filter(name => !name.startsWith('_') && name !== 'template')
      .filter(name => fs.existsSync(path.join(teamDir, name, 'MEMBER.md')) || fs.existsSync(path.join(teamDir, name, 'START_HERE.md')));
    return members.length === 1 ? slugify(members[0]) : null;
  } catch {
    return null;
  }
}

function inferPlayer(workspaceRoot, tasks, args = []) {
  const explicit = explicitPlayer(args);
  if (explicit) return { player: slugify(explicit), source: 'flag' };

  const account = activeAccountCandidate();
  if (account) return account;

  const gitPlayer = gitIdentityCandidate(workspaceRoot);
  if (gitPlayer && teamMemberExists(workspaceRoot, gitPlayer)) {
    return { player: gitPlayer, source: 'git_team_match' };
  }

  for (const value of [process.env.USER, os.userInfo().username]) {
    const player = slugify(value);
    if (player && teamMemberExists(workspaceRoot, player)) {
      return { player, source: 'local_user_team_match' };
    }
  }

  const soleMember = onlyTeamMember(workspaceRoot);
  if (soleMember) return { player: soleMember, source: 'only_team_member' };

  const fallback = slugify(process.env.USER || os.userInfo().username || 'player') || 'player';
  if (fallback) return { player: fallback, source: 'local_user' };

  const assigned = uniqueAssignedPlayer(tasks);
  if (assigned) return { player: assigned, source: 'active_task_assignment' };

  return { player: 'player', source: 'fallback' };
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

function taskMatchesPlayer(task, player) {
  const target = normalizeOwner(player);
  return Boolean(target) && (
    normalizeOwner(taskAssignee(task)) === target
    || normalizeOwner(task?.claimed_by) === target
  );
}

function selectMission(tasks, player) {
  const active = (tasks || [])
    .filter(task => !['done', 'failed'].includes(task.status))
    .filter(task => taskMatchesPlayer(task, player));
  if (!active.length) return null;
  return [...active].sort((a, b) => {
    const rank = rankTask(a, player) - rankTask(b, player);
    if (rank) return rank;
    return Number(b.updated_at || b.created_at || 0) - Number(a.updated_at || a.created_at || 0);
  })[0] || null;
}

function starterMissionTitle() {
  return 'AgentXP Mode first rep: complete one proof-backed customer-motion mission';
}

function starterMissionPrompt(player) {
  return [
    `Player ${player}: enter AgentXP Mode in this local workspace.`,
    'Pick one concrete Atris Labs customer-motion rep you can finish today.',
    'Have an agent help create a real artifact and verifier proof.',
    'Do not self-accept; when proof is ready, show accept/revise.',
    'Win condition: one accepted proof-backed rep visible on the local AgentXP card.',
  ].join(' ');
}

function globalSyncCommands(player) {
  return [
    'atris login',
    `atris xp sync --local --as ${player}`,
  ];
}

function ensureStarterMission(taskDb, db, workspaceRoot, player, tasks, args = []) {
  if (hasFlag(args, '--no-seed')) return { tasks, seeded: null };
  if (selectMission(tasks, player)) return { tasks, seeded: null };
  fs.mkdirSync(path.join(workspaceRoot, 'atris'), { recursive: true });

  const result = taskDb.addTask(db, {
    title: starterMissionTitle(),
    tag: 'agent-xp',
    workspaceRoot,
    metadata: {
      assigned_to: player,
      delegate_via: 'agentxp_play',
      auto_seeded_by: 'atris play',
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
  const seeded = refreshed.find(task => task.id === result.id) || null;
  return { tasks: refreshed, seeded };
}

function playWorkspaceRoot(taskDb, workspaceArg) {
  let requested = path.resolve(workspaceArg || process.cwd());
  try { requested = fs.realpathSync(requested); } catch {}
  if (
    fs.existsSync(path.join(requested, '.git'))
    || fs.existsSync(path.join(requested, 'atris'))
    || fs.existsSync(path.join(requested, '.atris'))
  ) {
    return taskDb.workspaceRoot(requested);
  }
  return requested;
}

function nextCommands(task, player) {
  const helper = 'game-manager';
  if (!task) {
    return [
      `atris task delegate "AgentXP first rep: one proof-backed mission" --to ${player} --tag agent-xp`,
      `atris play --as ${player}`,
    ];
  }

  const ref = taskRef(task);
  if (task.status === 'open') {
    return [
      `atris task claim ${ref} --as ${helper}`,
      `atris task ready ${ref} --as ${helper} --proof "<artifact path + verifier result>"`,
      `atris task accept ${ref} --as ${player} --proof "<human review>"`,
      'atris xp card --local',
      ...globalSyncCommands(player),
    ];
  }

  if (task.status === 'claimed') {
    const actor = task.claimed_by || helper;
    return [
      `atris task ready ${ref} --as ${actor} --proof "<artifact path + verifier result>"`,
      `atris task accept ${ref} --as ${player} --proof "<human review>"`,
      'atris xp card --local',
      ...globalSyncCommands(player),
    ];
  }

  if (task.status === 'review') {
    return [
      `atris task show ${ref}`,
      `atris task accept ${ref} --as ${player} --proof "<human review>"`,
      `atris task revise ${ref} --as ${player} --note "<what must change>"`,
      'atris xp card --local',
      ...globalSyncCommands(player),
    ];
  }

  return [
    `atris task show ${ref}`,
    'atris xp card --local',
    ...globalSyncCommands(player),
  ];
}

function modeState(args = []) {
  const taskDb = require('../lib/task-db');
  const workspaceArg = flag(args, '--workspace') || flag(args, '--root') || process.cwd();
  const workspaceRoot = playWorkspaceRoot(taskDb, workspaceArg);
  const db = taskDb.open();
  const rows = taskDb.listTasks(db, {
    workspaceRoot,
    limit: 500,
  });
  let tasks = taskDb.withTaskDisplayRefs(rows);
  const detected = inferPlayer(workspaceRoot, tasks, args);
  const player = detected.player || 'player';
  const starter = ensureStarterMission(taskDb, db, workspaceRoot, player, tasks, args);
  tasks = starter.tasks;
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
    player_source: detected.source,
    workspace_root: workspaceRoot,
    workspace_name: path.basename(workspaceRoot),
    seeded: starter.seeded ? {
      id: starter.seeded.id,
      ref: taskRef(starter.seeded),
      title: starter.seeded.title,
    } : null,
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
    global_sync_rule: 'Run atris login once before syncing to the hosted AgentXP leaderboard.',
    leaderboard_url: AGENTXP_LEADERBOARD_URL,
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
  if (state.seeded) {
    console.log(`Starter mission created locally: ${state.seeded.ref}`);
    console.log('');
  }
  console.log(`Mission ${mission.ref}: ${mission.title}`);
  console.log(`State ${mission.status} | Assigned ${mission.assigned_to || 'unassigned'} | Claimed ${mission.claimed_by || 'none'}`);
  if (mission.prompt) {
    console.log('');
    console.log(`Prompt: ${mission.prompt}`);
  }
  console.log('');
  console.log('Win condition: real artifact + verifier + human accept.');
  console.log('XP rule: no proof, no AgentXP; accept/revise stays human-gated.');
  console.log('Global sync: run atris login once before hosted leaderboard sync.');
  console.log(`Leaderboard: ${state.leaderboard_url}`);
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
