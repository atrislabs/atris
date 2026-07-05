'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const AGENTXP_LEADERBOARD_URL = 'https://api.atris.ai/api/agentxp/leaderboard';
const AGENTXP_GLOBAL_SYNC_RULE = 'Run atris login, then sync. Owner-provided sync tokens are guided-demo fallback only.';
const GM_WATCH_DEFAULT_INTERVAL_SECONDS = 10;
const GM_WATCH_CONTENT_LIMIT = 180;

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
  console.log('       atris gm --watch [--interval 10]');
  console.log('');
  console.log('Description:');
  console.log('  Enter AgentXP General Manager mode for the current Atris workspace.');
  console.log('  Shows local players, active missions, review queue, and the next command');
  console.log('  that moves the same AgentXP game loop forward.');
  console.log('  Watch mode keeps that first board, then appends new mission, review, and feed events.');
  console.log('');
  console.log('Options:');
  console.log('  --manager <id>    Manager id. Defaults to game-manager when present.');
  console.log('  --as <id>         Alias for --player.');
  console.log('  --player <id>     Preferred player when seeding a first local mission.');
  console.log('  --workspace <p>   Read missions from another Atris workspace.');
  console.log('  --watch           Append new GM events until Ctrl+C.');
  console.log('  --interval <sec>  Watch polling interval. Defaults to 10.');
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
  return 'AgentXP Mode first rep: complete one proof-backed useful mission';
}

function starterMissionPrompt(player) {
  return [
    `Player ${player}: enter AgentXP Mode in this local workspace.`,
    'Pick one small useful contribution you can finish today: improve a doc, verify setup, create a handoff, or fix a tiny tool.',
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
    'atris login',
    'atris xp sync --local',
    'atris xp sync --local --token <owner-provided-token>',
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

function readGmTaskRows(args = []) {
  const taskDb = require('../lib/task-db');
  const workspaceArg = flag(args, '--workspace') || flag(args, '--root') || process.cwd();
  const workspaceRoot = taskDb.workspaceRoot(path.resolve(workspaceArg));
  const db = taskDb.open();
  const tasks = taskDb.withTaskDisplayRefs(taskDb.listTasks(db, {
    workspaceRoot,
    limit: 500,
  }));
  return { taskDb, db, workspaceRoot, tasks };
}

function gmState(args = [], options = {}) {
  const { taskDb, db, workspaceRoot, tasks: initialTasks } = readGmTaskRows(args);
  let tasks = initialTasks;
  const detected = inferManager(workspaceRoot, args);
  const starter = options.seed === false
    ? { tasks, seeded: null }
    : ensureStarterMission(taskDb, db, workspaceRoot, tasks, args);
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
    xp_rule: 'GM can route missions and review proof, but AgentXP is awarded only after human approval.',
    global_sync_rule: AGENTXP_GLOBAL_SYNC_RULE,
    leaderboard_url: AGENTXP_LEADERBOARD_URL,
  };
}

function watchIntervalSeconds(args = []) {
  const raw = flag(args, '--interval');
  const parsed = parseInt(raw || String(GM_WATCH_DEFAULT_INTERVAL_SECONDS), 10);
  return Number.isFinite(parsed) ? Math.max(1, parsed) : GM_WATCH_DEFAULT_INTERVAL_SECONDS;
}

function watchStamp(value) {
  const date = value ? new Date(value) : new Date();
  const safe = Number.isFinite(date.getTime()) ? date : new Date();
  return safe.toTimeString().slice(0, 5);
}

function eventMs(value) {
  const ms = value ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : Date.now();
}

function watchLine(event) {
  const name = String(event.name || event.kind || 'event').replace(/\s+/g, ' ').trim();
  const content = clip(event.content || '', GM_WATCH_CONTENT_LIMIT);
  return `[${watchStamp(event.at)}] [${event.kind}] ${name}: ${content}`;
}

function missionShortId(mission) {
  const id = String(mission && mission.id || '');
  if (!id) return 'mission';
  return id.length > 20 ? `...${id.slice(-8)}` : id;
}

function missionFingerprint(mission) {
  return [
    mission && mission.status,
    mission && mission.last_tick_at,
    mission && mission.last_tick_index,
    mission && mission.receipt_path,
  ].join('|');
}

function missionEvent(mission) {
  let heartbeat = '';
  try {
    const { missionHeartbeatLines } = require('./mission');
    heartbeat = missionHeartbeatLines(mission).map(line => line.trim()).join(', ');
  } catch {
    heartbeat = '';
  }
  const title = mission.objective || mission.slug || mission.id || 'mission';
  return {
    id: `mission:${mission.id}`,
    kind: 'mission',
    name: mission.owner || mission.slug || 'mission',
    at: mission.last_tick_at || mission.updated_at || mission.created_at,
    content: [
      missionShortId(mission),
      `[${mission.status || 'unknown'}]`,
      heartbeat || null,
      clip(title, 100),
    ].filter(Boolean).join(' - '),
    fingerprint: missionFingerprint(mission),
  };
}

function taskMissionFingerprint(task) {
  return [
    task && task.status,
    task && task.updated_at,
    task && task.claimed_by,
    task && task.done_at,
  ].join('|');
}

function taskMissionEvent(task) {
  const player = taskAssignee(task) || task.claimed_by || 'unassigned';
  return {
    id: `task:${task.id}`,
    kind: 'mission',
    name: player,
    at: task.updated_at ? new Date(Number(task.updated_at)).toISOString() : null,
    content: `${taskRef(task)} [${task.status || 'unknown'}] ${task.title || 'untitled task'}`,
    fingerprint: taskMissionFingerprint(task),
  };
}

function reviewEvent(task) {
  const player = task.assigned_to || taskAssignee(task) || task.claimed_by || 'review';
  return {
    id: task.id,
    kind: 'review',
    name: player,
    at: task.updated_at ? new Date(Number(task.updated_at)).toISOString() : null,
    content: `${task.ref || taskRef(task)} ready - ${task.title || 'untitled task'}`,
  };
}

function feedPostId(post) {
  return String(post.id || post.post_id || `${post.created_at || ''}:${post.author_id || ''}:${post.content || ''}`);
}

function credentialsFileExists() {
  return fs.existsSync(path.join(os.homedir(), '.atris', 'credentials.json'));
}

async function fetchFeedEvents(workspaceRoot) {
  if (!credentialsFileExists()) return [];
  let feed;
  let loadCredentials;
  try {
    feed = require('./feed');
    loadCredentials = require('../utils/auth').loadCredentials;
  } catch {
    return [];
  }
  if (
    typeof feed.findBusiness !== 'function'
    || typeof feed.fetchPosts !== 'function'
    || typeof feed.authorLabel !== 'function'
  ) {
    return [];
  }
  const business = feed.findBusiness(workspaceRoot);
  if (!business) return [];
  const credentials = loadCredentials();
  if (!credentials || !credentials.token) return [];
  const aliases = typeof feed.loadAuthorAliases === 'function' ? feed.loadAuthorAliases(business.root) : {};
  const posts = await feed.fetchPosts(business.businessId, credentials.token, 20);
  return posts.map((post) => {
    const id = feedPostId(post);
    return {
      id,
      kind: 'feed',
      name: feed.authorLabel(post, aliases, credentials.user_id, credentials.email),
      at: post.created_at,
      content: String(post.content || '').replace(/\s+/g, ' ').trim(),
    };
  });
}

function collectLocalWatchState(args = []) {
  const { workspaceRoot, tasks } = readGmTaskRows(args);
  const taskMissions = activeAgentXpTasks(tasks);
  const reviewQueue = taskMissions.filter(task => task.status === 'review');
  return { workspaceRoot, taskMissions, reviewQueue };
}

function listDurableMissions(workspaceRoot) {
  try {
    const { listMissions } = require('./mission');
    if (typeof listMissions !== 'function') return [];
    return listMissions(workspaceRoot);
  } catch {
    return [];
  }
}

async function gmWatchSnapshot(args) {
  const local = collectLocalWatchState(args);
  const durableMissions = listDurableMissions(local.workspaceRoot);
  const feedEvents = await fetchFeedEvents(local.workspaceRoot);
  return {
    reviewEvents: local.reviewQueue.map(reviewEvent),
    missionEvents: [
      ...local.taskMissions.map(taskMissionEvent),
      ...durableMissions.map(missionEvent),
    ],
    feedEvents,
  };
}

function markSnapshotSeen(snapshot, seen) {
  for (const event of snapshot.missionEvents) seen.missions.set(event.id, event.fingerprint);
  for (const event of snapshot.reviewEvents) seen.reviews.add(event.id);
  for (const event of snapshot.feedEvents) seen.feed.add(event.id);
}

function newWatchEvents(snapshot, seen) {
  const events = [];
  for (const event of snapshot.missionEvents) {
    const previous = seen.missions.get(event.id);
    if (previous !== event.fingerprint) {
      events.push(event);
      seen.missions.set(event.id, event.fingerprint);
    }
  }
  for (const event of snapshot.reviewEvents) {
    if (!seen.reviews.has(event.id)) {
      events.push(event);
      seen.reviews.add(event.id);
    }
  }
  for (const event of snapshot.feedEvents) {
    if (!seen.feed.has(event.id)) {
      events.push(event);
      seen.feed.add(event.id);
    }
  }
  return events.sort((a, b) => eventMs(a.at) - eventMs(b.at));
}

async function gmWatch(args = []) {
  const intervalSeconds = watchIntervalSeconds(args);
  const seen = {
    missions: new Map(),
    reviews: new Set(),
    feed: new Set(),
  };
  try {
    markSnapshotSeen(await gmWatchSnapshot(args), seen);
  } catch {
    // Watch mode is append-only; transient read failures should not redraw or exit.
  }

  console.log('');
  console.log(`Watching GM events every ${intervalSeconds}s. Ctrl+C to stop.`);
  console.log('');

  let polling = false;
  const poll = async () => {
    if (polling) return;
    polling = true;
    try {
      const events = newWatchEvents(await gmWatchSnapshot(args, seen), seen);
      for (const event of events) console.log(watchLine(event));
    } catch {
      // Match fleet watch: quiet on transient poll failures.
    } finally {
      polling = false;
    }
  };

  const interval = setInterval(poll, intervalSeconds * 1000);
  return new Promise((resolve) => {
    const onSigint = () => {
      clearInterval(interval);
      process.off('SIGINT', onSigint);
      console.log('\nStopped watching.\n');
      resolve();
    };
    process.on('SIGINT', onSigint);
  });
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
  console.log('Global sync: run atris login, then sync; owner tokens are guided-demo fallback only.');
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
  if (hasFlag(args, '--watch')) {
    await gmWatch(args);
  }
}

module.exports = {
  gmCommand,
  gmState,
  gmWatchSnapshot,
};
