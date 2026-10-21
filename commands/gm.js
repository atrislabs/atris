'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { stateHome } = require('../lib/state-home');
const { hasFlag: hasExactFlag } = require('../lib/arg-parser');

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
  console.log('Usage: atris gm                  play the front office (in a terminal)');
  console.log('       atris gm --board          print the front office board once');
  console.log('       atris gm --json           machine-readable state');
  console.log('       atris gm --watch [--interval 10]');
  console.log('');
  console.log('Description:');
  console.log('  The front office for your team. The board shows each member\'s rating,');
  console.log('  their last five finished jobs, who is on a job, the last plays, and');
  console.log('  what is up next. Every job a member takes in the last 30 days ends');
  console.log('  landed (accepted or merged), dropped (claim let go), or sent back.');
  console.log('  ovr = round(60 + 39 * landed / finished), rookie under 3 finished.');
  console.log('  Drops count, so this is stricter than the website rating on purpose.');
  console.log('  "on a job" means the claimed task moved in the last 6 hours; a claim');
  console.log('  that sat longer shows as stuck, with its age and task id.');
  console.log('  The line above the roster recaps what happened since your last look');
  console.log('  (saved in .atris/state/gm-last-seen.json by the playable board only).');
  console.log('');
  console.log('  In a terminal, gm is playable and refreshes every 10 seconds:');
  console.log('    p  send the team out for a session (asks minutes, who, then y)');
  console.log('         one name:  atris member wake <name> --minutes N');
  console.log('                    one wake plus one work step with an N minute budget');
  console.log('         a count:   atris member wake <count>, names: atris member wake a b');
  console.log('                    keeps members picking up jobs; gm stops it after N');
  console.log('                    minutes and runs already started finish');
  console.log('    r  run a member, with an optional job (asks y first)');
  console.log('    w  wake a member (asks y first)');
  console.log('    s  put a member to sleep');
  console.log('    u  unstick: let go of a stuck claim (asks y first)');
  console.log('         atris task release <id> --as <member holding it>');
  console.log('    l  landing check (atris land --dry-run)');
  console.log('    enter or space  refresh,  q  quit');
  console.log('  Every key shows the exact command before it runs.');
  console.log('');
  console.log('Options:');
  console.log('  --board           Print the board once and exit, no keys.');
  console.log('  --manager <id>    Manager id. Defaults to game-manager when present.');
  console.log('  --as <id>         Alias for --player.');
  console.log('  --player <id>     Preferred player when seeding a first local mission.');
  console.log('  --workspace <p>   Read another Atris workspace.');
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

// This command treats --name=value as flag presence as well as a standalone flag.
function hasFlagOrValue(args, name) {
  return hasExactFlag(args, name) || args.some(arg => arg.startsWith(`${name}=`));
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
  if (hasFlagOrValue(args, '--no-seed')) return { tasks, seeded: null };
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
  return fs.existsSync(path.join(stateHome(), '.atris', 'credentials.json'));
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

// ---- front office board -------------------------------------------------

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const PLAY_KEYS = [
  'keys: p play  r run  w wake  s sleep  u unstick  l landing check',
  '      g league  c switch club  enter refresh  q quit',
];
const LEAGUE_KEYS = 'keys: g back to the club  c switch club  enter refresh  q quit';
const LEAGUE_MAX_ROWS = 20;
const MEMBER_NAME_RE = /^[a-zA-Z0-9._-]+$/;
const REFRESH_MS = 10 * 1000;
const PLAY_DEFAULT_MINUTES = 30;
const PLAY_DEFAULT_WHO = '3';
const PLAY_MAX_MINUTES = 480;
const PLAY_MAX_COUNT = 12;

function pad(value, width) {
  const text = String(value == null ? '' : value);
  return text.length >= width ? `${text.slice(0, width - 1)} ` : text + ' '.repeat(width - text.length);
}

function weekLabel(ms) {
  const d = new Date(ms);
  return `week of ${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

function hoursLabel(hours) {
  if (hours == null) return '';
  return hours >= 10 ? `${Math.round(hours)}h` : `${hours}h`;
}

function boardWorkspaceRoot(args = []) {
  const taskDb = require('../lib/task-db');
  const workspaceArg = flag(args, '--workspace') || flag(args, '--root') || process.cwd();
  return taskDb.workspaceRoot(path.resolve(workspaceArg));
}

function loadBoard(workspaceRoot, options = {}) {
  const season = require('../lib/gm-season');
  return season.seasonBoard(season.loadSeason(workspaceRoot), options);
}

// One screen, about 40 rows at most. Pure: board in, lines out.
function renderBoardLines(board, { interactive = false } = {}) {
  const { clockLabel } = require('../lib/gm-season');
  const lines = [];
  const live = interactive ? ` | refreshes every ${REFRESH_MS / 1000}s` : '';
  lines.push(`front office | ${board.workspace_name} | ${weekLabel(board.week_of)}${live}`);
  lines.push(board.mood.line);
  if (board.since_last_look) lines.push(board.since_last_look.line);
  if (board.error) lines.push(`could not read the task list: ${clip(board.error, 80)}`);
  lines.push('');

  lines.push('roster, last 30 days');
  if (board.roster.length) {
    lines.push(`  ${pad('name', 18)}${pad('ovr', 8)}${pad('form', 7)}${pad('record', 18)}status`);
    for (const row of board.roster) {
      const record = `landed ${row.landed} of ${row.jobs}`;
      lines.push(`  ${pad(row.name, 18)}${pad(row.ovr == null ? 'rookie' : row.ovr, 8)}${pad(row.form || '-', 7)}${pad(record, 18)}${row.status}`);
    }
  } else {
    lines.push('  no jobs taken in the last 30 days');
  }
  lines.push('');

  if (board.stuck && board.stuck.length) {
    lines.push(`stuck, claimed with no move for 6h or more${interactive ? ' (u to unstick)' : ''}`);
    for (const row of board.stuck) {
      lines.push(`  ${pad(row.member, 18)}${pad(row.age, 6)}${pad(row.ref, 11)}${row.title}`);
    }
    lines.push('');
  }

  lines.push('last plays');
  if (board.last_plays && board.last_plays.length) {
    for (const play of board.last_plays) {
      const tag = play.fresh ? '  new' : '';
      lines.push(`  ${pad(clockLabel(play.at, board.now), 17)}${pad(`${play.member} ${play.play}`, 25)}${pad(hoursLabel(play.hours), 6)}${play.title}${tag}`);
    }
  } else {
    lines.push('  no plays yet');
  }
  lines.push('');

  lines.push('up next');
  if (board.up_next.length) {
    for (const item of board.up_next) {
      const label = item.kind === 'task' ? (item.ref || 'task') : 'mission';
      const owner = item.owner ? ` (${item.owner})` : '';
      lines.push(`  ${pad(label, 12)}${item.title}${owner}`);
    }
  } else {
    lines.push('  no open tasks or active missions');
  }
  lines.push('');

  lines.push('key: ovr 60 to 99 by share of finished jobs landed, rookie under 3 finished');
  lines.push('     drops count here, so it is stricter than the website rating on purpose');
  lines.push('     form: last 5 finished, newest right, k landed, d dropped, x sent back');
  lines.push('     hours: claim to result. on a job means its task moved in the last 6h');
  if (interactive) for (const line of PLAY_KEYS) lines.push(line);
  else lines.push('     run atris gm in a terminal to play');
  return lines;
}

function loadLeagueBoard(options = {}) {
  const season = require('../lib/gm-season');
  return season.leagueBoard(season.loadLeague(options));
}

// The league: one row per club, best this week first. Pure: board in, lines out.
function renderLeagueLines(board, { interactive = false } = {}) {
  const lines = [];
  const live = interactive ? ` | refreshes every ${REFRESH_MS / 1000}s` : '';
  lines.push(`league | ${board.days} days | ${board.rows.length} clubs${live}`);
  if (board.error) lines.push(`could not read the task list: ${clip(board.error, 80)}`);
  lines.push('');
  if (!board.rows.length) {
    lines.push('  no project folder had task events in the last 30 days');
  } else {
    lines.push(`  ${pad('club', 20)}${pad('ovr', 8)}${pad('week', 6)}${pad('30d', 6)}${pad('drop', 6)}${pad('stuck', 7)}${pad('last', 6)}best player`);
    for (const row of board.rows.slice(0, LEAGUE_MAX_ROWS)) {
      const best = row.best_player ? `${row.best_player.name} ${row.best_player.ovr}` : '-';
      lines.push(`  ${pad(row.club, 20)}${pad(row.ovr == null ? 'rookie' : row.ovr, 8)}${pad(row.landed_week, 6)}${pad(row.landed_30d, 6)}${pad(row.dropped_30d, 6)}${pad(row.stuck, 7)}${pad(row.last_play, 6)}${best}`);
    }
    const more = board.rows.length - LEAGUE_MAX_ROWS;
    if (more > 0) lines.push(`  and ${more} more quiet clubs (atris gm --league --json lists all)`);
  }
  lines.push('');
  lines.push('key: week and 30d count landed jobs, drop counts dropped jobs in 30 days');
  lines.push('     stuck: claims with no move for 6h or more. last: newest task event');
  lines.push('     ovr: same honest rating as the club board, over every job in the club');
  lines.push(interactive ? LEAGUE_KEYS : '     run atris gm in a terminal, then g, to play');
  return lines;
}

function printLeague() {
  console.log(renderLeagueLines(loadLeagueBoard()).join('\n'));
}

function printBoard(args = []) {
  const lines = renderBoardLines(loadBoard(boardWorkspaceRoot(args)));
  console.log(lines.join('\n'));
}

function quoteArg(value) {
  const text = String(value);
  return /^[a-zA-Z0-9._/:=-]+$/.test(text) ? text : `"${text.replace(/(["\\$`])/g, '\\$1')}"`;
}

function displayCommand(args) {
  return ['atris', ...args].map(quoteArg).join(' ');
}

function playMinutes(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return PLAY_DEFAULT_MINUTES;
  if (!/^\d+$/.test(text)) return null;
  const minutes = Number(text);
  return minutes >= 1 && minutes <= PLAY_MAX_MINUTES ? minutes : null;
}

// p sends the team out for a session:
//   one name -> atris member wake <name> --minutes N
//               one wake, then one work step with an N minute budget; ends itself
//   a count  -> atris member wake <count>  (same as atris member up --max <count>)
//   names    -> atris member wake a b      (same as atris member up --only a,b)
//               both keep members picking up jobs with no end of their own, so
//               gm stops it after N minutes; runs already started finish
function playSession({ who = '', minutes = '' } = {}) {
  const span = playMinutes(minutes);
  if (span == null) return null;
  const words = String(who || PLAY_DEFAULT_WHO).split(/[\s,]+/).filter(Boolean);
  if (!words.length) return null;
  if (words.length === 1 && /^\d+$/.test(words[0])) {
    const count = Number(words[0]);
    if (count < 1 || count > PLAY_MAX_COUNT) return null;
    return { args: ['member', 'wake', String(count)], confirm: true, stopAfterMs: span * 60 * 1000, minutes: span };
  }
  if (!words.every(word => MEMBER_NAME_RE.test(word))) return null;
  if (words.length === 1) {
    return { args: ['member', 'wake', words[0], '--minutes', String(span)], confirm: true, stopAfterMs: null, minutes: span };
  }
  return { args: ['member', 'wake', ...words], confirm: true, stopAfterMs: span * 60 * 1000, minutes: span };
}

// u lets go of a stuck claim with the real release verb. `atris task release`
// only works as the member holding the claim, so it runs --as that member,
// and the drop lands on the member that held the job.
function unstickAction(answer, stuck = []) {
  const wanted = String(answer || '').trim().toLowerCase();
  if (!wanted) return null;
  const row = stuck.find(s => [s.ref, s.task_id].filter(Boolean).some(id => String(id).toLowerCase() === wanted));
  if (!row || !MEMBER_NAME_RE.test(row.member)) return null;
  return {
    args: ['task', 'release', row.ref || row.task_id, '--as', row.member],
    confirm: true,
    confirmText: 'this releases the claim and counts a drop for that member',
  };
}

// What each key runs. p, r, w and u ask for y first.
function playAction(key, { name = '', job = '', who = '', minutes = '', stuck = [] } = {}) {
  if (key === 'l') return { args: ['land', '--dry-run'], confirm: false };
  if (key === 'p') return playSession({ who, minutes });
  if (key === 'u') return unstickAction(name, stuck);
  if (!MEMBER_NAME_RE.test(name)) return null;
  if (key === 'r') return { args: ['member', 'run', name, ...(job ? [job] : [])], confirm: true };
  if (key === 'w') return { args: ['member', 'wake', name], confirm: true };
  if (key === 's') return { args: ['member', 'sleep', name], confirm: false };
  return null;
}

function actionLabel(action) {
  const shown = displayCommand(action.args);
  if (!action.stopAfterMs) return shown;
  return `${shown}  (gm stops it after ${action.minutes} min; runs already started finish)`;
}

async function gmPlay(args = []) {
  const readline = require('readline');
  const { spawn } = require('child_process');
  const input = process.stdin;
  const output = process.stdout;
  const workspaceRoot = boardWorkspaceRoot(args);
  const cliPath = path.join(__dirname, '..', 'bin', 'atris.js');
  const write = text => output.write(`${text}\n`);
  const setRaw = (on) => {
    if (input.isTTY && typeof input.setRawMode === 'function') input.setRawMode(on);
  };

  readline.emitKeypressEvents(input);

  // The recap compares against the look before this session, pinned for the
  // whole session; this session's look is saved on open and on quit.
  const season = require('../lib/gm-season');
  const lastSeen = season.readLastSeen(workspaceRoot);
  season.writeLastSeen(workspaceRoot);

  let seen = null;
  let note = '';
  let stuck = [];
  const draw = () => {
    output.write('\x1b[2J\x1b[H');
    try {
      const board = loadBoard(workspaceRoot, { seen, lastSeen });
      seen = new Set(board.last_plays.map(play => play.id));
      stuck = board.stuck || [];
      write(renderBoardLines(board, { interactive: true }).join('\n'));
    } catch (err) {
      write(`could not load the board: ${err.message}`);
    }
    if (note) write(`\n${note}`);
  };

  // Keys arrive in bursts (type-ahead while a command runs lands as one chunk),
  // so queue them instead of keeping only the first.
  const queue = [];
  let waiter = null;
  let capturing = true;
  const onKeypress = (str, key) => {
    if (!capturing) return;
    if (waiter) {
      const resolve = waiter;
      waiter = null;
      resolve({ str, key });
    } else {
      queue.push({ str, key });
    }
  };
  input.on('keypress', onKeypress);

  const nextKey = () => {
    setRaw(true);
    input.resume();
    if (queue.length) return Promise.resolve(queue.shift());
    return new Promise((resolve) => { waiter = resolve; });
  };

  // Resolves the typed answer, or null when the prompt is cancelled with
  // Ctrl-C or closed, so a cancel never falls through to a default.
  const ask = question => new Promise((resolve) => {
    capturing = false;
    queue.length = 0;
    setRaw(false);
    const rl = readline.createInterface({ input, output, terminal: true });
    let settled = false;
    const settle = (answer) => {
      if (settled) return;
      settled = true;
      capturing = true;
      rl.close();
      resolve(answer);
    };
    rl.on('SIGINT', () => {
      output.write('\n');
      settle(null);
    });
    rl.on('close', () => settle(null));
    rl.question(question, answer => settle(String(answer || '').trim()));
  });

  // Ctrl-C while a command runs reaches the command, not gm, so gm comes back.
  const runAtris = (cmdArgs, { stopAfterMs = null } = {}) => new Promise((resolve) => {
    setRaw(false);
    input.pause();
    const keepGm = () => {};
    process.on('SIGINT', keepGm);
    const child = spawn(process.execPath, [cliPath, ...cmdArgs], {
      cwd: workspaceRoot,
      stdio: 'inherit',
      env: process.env,
    });
    const timer = stopAfterMs ? setTimeout(() => child.kill('SIGTERM'), stopAfterMs) : null;
    const finish = (result) => {
      if (timer) clearTimeout(timer);
      process.off('SIGINT', keepGm);
      resolve(result);
    };
    child.on('error', err => finish({ code: 1, error: err.message }));
    child.on('close', code => finish({ code }));
  });

  const CANCELLED = 'cancelled, nothing ran';
  const doAction = async (key) => {
    let action;
    write('');
    if (key === 'l') {
      action = playAction('l');
    } else if (key === 'p') {
      const minutes = await ask(`session length in minutes (enter for ${PLAY_DEFAULT_MINUTES}): `);
      if (minutes === null) return CANCELLED;
      const who = await ask(`who: a member name, names, or how many (enter for ${PLAY_DEFAULT_WHO}): `);
      if (who === null) return CANCELLED;
      action = playAction('p', { who, minutes });
      if (!action) return `cancelled, need 1 to ${PLAY_MAX_MINUTES} minutes and member names or a count up to ${PLAY_MAX_COUNT}`;
    } else if (key === 'u') {
      if (!stuck.length) return 'nothing is stuck';
      const id = await ask(`unstick which task? (${stuck.map(s => s.ref).join(', ')}): `);
      if (id === null) return CANCELLED;
      action = playAction('u', { name: id, stuck });
      if (!action) return id ? `cancelled, "${clip(id, 40)}" is not in the stuck list` : 'cancelled, no task named';
    } else {
      const verb = { r: 'run', w: 'wake', s: 'sleep' }[key];
      const name = await ask(`${verb} which member? `);
      if (name === null) return CANCELLED;
      if (!name) return 'cancelled, no member named';
      const job = key === 'r' ? await ask('job (optional, enter to skip): ') : '';
      if (job === null) return CANCELLED;
      action = playAction(key, { name, job });
      if (!action) return `cancelled, "${clip(name, 40)}" is not a member name`;
    }
    const shown = displayCommand(action.args);
    write('');
    write(`this will run: ${actionLabel(action)}`);
    if (action.confirm) {
      write(`${action.confirmText || 'this starts agents'}. press y to go, any other key to cancel`);
      queue.length = 0; // only a fresh key press can confirm
      const { str } = await nextKey();
      if (String(str || '').toLowerCase() !== 'y') return `cancelled: ${shown}`;
    }
    write('');
    const result = await runAtris(action.args, { stopAfterMs: action.stopAfterMs });
    write('');
    const exit = result.code == null ? 'stopped' : result.code;
    write(`${shown} finished with exit ${exit}${result.error ? ` (${result.error})` : ''}`);
    write('press any key to go back to the board');
    await nextKey();
    return `last: ${shown}`;
  };

  let atBoard = false;
  const refresh = setInterval(() => {
    if (atBoard) draw();
  }, REFRESH_MS);

  try {
    draw();
    for (;;) {
      atBoard = true;
      const { str, key } = await nextKey();
      atBoard = false;
      const name = (key && key.name) || str;
      if ((key && key.ctrl && key.name === 'c') || name === 'q' || name === 'escape') break;
      if (name === 'space' || name === 'return' || name === 'enter') {
        draw();
      } else if (['p', 'r', 'w', 's', 'u', 'l'].includes(name)) {
        note = await doAction(name);
        draw();
      }
    }
  } finally {
    clearInterval(refresh);
    season.writeLastSeen(workspaceRoot);
    input.off('keypress', onKeypress);
    setRaw(false);
    input.pause();
    write('');
  }
}

function wantsPlay(args = []) {
  if (hasFlagOrValue(args, '--json') || hasFlagOrValue(args, '--watch')) return false;
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

// `gm <name>` is how people greet a team member in chat ("gm maze"). When the
// positional names a real member (and not the manager persona), the same phrase
// works in the terminal: wake that member instead of entering manager mode.
function wakeableMember(args) {
  const name = slugify(positional(args)[0]);
  if (!name || name === 'game-manager' || flag(args, '--manager')) return null;
  const memberDir = path.join(process.cwd(), 'atris', 'team', name);
  if (!fs.existsSync(path.join(memberDir, 'MEMBER.md'))) return null;
  return name;
}

async function gmCommand(...args) {
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    showHelp();
    return;
  }

  const member = wakeableMember(args);
  if (member) {
    const { isMemberAwake } = require('../lib/member-switches');
    if (!isMemberAwake(member)) {
      console.log(`${member} is asleep`);
      return;
    }
    const { memberCommand } = require('./member');
    const passthrough = args.filter(arg => arg !== member);
    return memberCommand('wake', member, ...passthrough);
  }

  // --league prints the league once (with or without --board); in --json it
  // adds a `league` field instead, so plain --json stays a one-folder read.
  if (hasExactFlag(args, '--league') && !hasFlagOrValue(args, '--json')) {
    printLeague();
    return;
  }

  if (hasExactFlag(args, '--board') && !hasFlagOrValue(args, '--json')) {
    printBoard(args);
    return;
  }

  if (wantsPlay(args)) {
    await gmPlay(args);
    return;
  }

  if (!hasFlagOrValue(args, '--json') && !hasFlagOrValue(args, '--watch')) {
    try {
      const { gameCommand } = require('./game');
      const dashboardShown = await gameCommand([], { silentMissing: true });
      if (dashboardShown) console.log('');
    } catch {
      // The dashboard is an optional opening screen and must never block GM mode.
    }
  }

  const state = gmState(args);
  if (hasFlagOrValue(args, '--json')) {
    try {
      state.season = loadBoard(state.workspace_root);
    } catch {
      state.season = null;
    }
    if (hasExactFlag(args, '--league')) {
      try {
        state.league = loadLeagueBoard();
      } catch {
        state.league = null;
      }
    }
    console.log(JSON.stringify(state, null, 2));
    return;
  }
  render(state);
  if (hasFlagOrValue(args, '--watch')) {
    await gmWatch(args);
  }
}

module.exports = {
  displayCommand,
  gmCommand,
  playAction,
  renderBoardLines,
};
