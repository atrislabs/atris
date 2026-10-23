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
  console.log('       atris gm --league         print the league, every project as a club');
  console.log('       atris gm replay [--since 12h|2d|last-seen] [--speed N] [--plain] [--league]');
  console.log('       atris gm card <member> [--json]  one member\'s profile page');
  console.log('       atris gm target [--landed N] [--max-abandoned N] [--max-stuck N] [--clear]');
  console.log('       atris gm phone [--port 7777] [--send] [--new-link]  decision cards on your phone');
  console.log('       atris gm --json           machine-readable state');
  console.log('       atris gm --watch [--interval 10]');
  console.log('');
  console.log('Description:');
  console.log('  The front office for your team. The board shows each member\'s rating,');
  console.log('  their last five finished jobs, who is on a job, the last plays, and');
  console.log('  what is up next. Every job a member takes in the last 30 days ends');
  console.log('  landed (accepted or merged), dropped (claim let go), sent back, or');
  console.log('  abandoned (archived without landing). Jobs in review are pending.');
  console.log('  ovr = round(60 + 39 * landed / finished), rookie under 3 finished.');
  console.log('  Drops and abandons count, so this is stricter than the website rating.');
  console.log('  "on a job" means the claimed task moved in the last 6 hours; a claim');
  console.log('  that sat longer shows as stuck, with its age and task id.');
  console.log('  The line above the roster recaps what happened since your last look');
  console.log('  (saved in ~/.atris/state/gm-last-seen.json by the playable board only).');
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
  console.log('    g  switch between this club and the league (read only)');
  console.log('    c  switch to another club from the league (read only, like --workspace)');
  console.log('    v  replay what happened since your last look, then back to the board');
  console.log('    i  a member\'s card: rating by week, record, engine, scouting (read only)');
  console.log('    o  set this week\'s owner target: landed, max abandoned, max stuck over a day');
  console.log('    enter or space  refresh,  q  quit');
  console.log('  Every key that runs a command shows it first.');
  console.log('');
  console.log('  atris gm replay plays a window back as a time-lapse in about 75 seconds:');
  console.log('  a clock, each member\'s running tally, and the last six plays. Keys:');
  console.log('  space pause, f faster, q quit. Off a terminal, or with --plain, it prints');
  console.log('  each play as a line. --since takes 30m, 12h, 2d, or last-seen (the');
  console.log('  default, else 12h); --speed 2 plays twice as fast; --league plays every');
  console.log('  club at once.');
  console.log('');
  console.log('  The owner target is the win condition: landed this week, at most N');
  console.log('  abandoned, at most N claims stuck over a day. It carries forward to new');
  console.log('  weeks until changed. During the week a landed shortfall is behind and a');
  console.log('  broken limit is missed; a week is won only once it is over and all');
  console.log('  three held. The header keeps the season record of won and lost weeks.');
  console.log('  Saved in ~/.atris/state/gm-targets/, one file per workspace.');
  console.log('');
  console.log('  atris gm phone opens a page your phone can reach on the same wifi. It');
  console.log('  prints a link with a random key and a QR code; anything without the key');
  console.log('  gets nothing. The page is one dark screen with the orb in the middle.');
  console.log('  A quiet link at the bottom opens the decisions only you can make, one');
  console.log('  card at a time, at most five a session:');
  console.log('    jobs waiting on review: have the reviewer check them');
  console.log('         atris task auto-accept-certified --json --certify-first');
  console.log('         (offered only while autoland is on), or approve / send back the');
  console.log('         oldest 3 one at a time: atris task accept <id>,');
  console.log('         atris task revise <id> --note "..."');
  console.log('    stuck claims: atris task release <id> --as <holder> for each, or');
  console.log('         atris member wake <holder> for each holder');
  console.log('    no target: set this week\'s target (5 seconds to undo)');
  console.log('  Tap the orb and a smart model (claude -p, your subscription, never an');
  console.log('  api key) reads now.md, this week\'s target, the changes merged on master');
  console.log('  this week, npm installs and the best installs week of the last 2 months,');
  console.log('  the published version and how much on master is not in it, the newest');
  console.log('  research briefs, and past bets with won or lost, then proposes one new');
  console.log('  move with a target number, a check date (it picks the number of days,');
  console.log('  7 to 14), a check that proves the deliverable, and steps, each team step');
  console.log('  naming a member of atris/team. Bets are business moves only (customers,');
  console.log('  revenue, reach, product people use); plumbing is the team\'s job. An');
  console.log('  installs goal must beat the best recent week. A second model then checks');
  console.log('  that the move makes sense. When a job finishes, the reviewer in the engine');
  console.log('  roster reads the work before it counts as done. Bets the team is doing are');
  console.log('  scored won or lost from the same numbers once the check date is over.');
  console.log('  The Mac keeps 3 bets ready so a tap rarely waits; tap the orb again for');
  console.log('  the next one. Every answer is saved to ~/.atris/state/gm-bet-attempts.jsonl.');
  console.log('  do it starts a mission: atris mission start "<bet, steps, handoffs>"');
  console.log('  --owner <first step member> --verify "<the bet check>" --runner claude,');
  console.log('  then atris mission run <id> --detach. later steps go to their member with');
  console.log('  atris member handoff <from> <to> "...".');
  console.log('  steps marked your yes become decision cards; yes sends');
  console.log('  atris mission ping <id> "..." --from gm-phone and nothing else.');
  console.log('  Bets are kept in ~/.atris/state/gm-bets.jsonl.');
  console.log('  Anything that starts agents, frees claims, or lands work needs a second');
  console.log('  tap. Every tap is logged to ~/.atris/state/gm-phone-actions.jsonl.');
  console.log('  --send texts the link to the number saved with atris autoland on --to.');
  console.log('');
  console.log('  The league treats every real project folder with task events in the');
  console.log('  last 30 days as a club: team rating, landed this week and in 30 days,');
  console.log('  drops, abandons, stuck claims, last task event, and best player.');
  console.log('  Scratch folders under the temp dirs and agent worktree checkouts are');
  console.log('  left out, and clubs under 3 finished jobs are counted but hidden.');
  console.log('');
  console.log('Options:');
  console.log('  --board           Print the board once and exit, no keys. Read only, even');
  console.log('                    with --json (schema atris.gm_board.v1, never seeds).');
  console.log('  --league          Print the league once and exit; with --json, adds league.');
  console.log('  --manager <id>    Manager id. Defaults to game-manager when present.');
  console.log('  --as <id>         Alias for --player.');
  console.log('  --player <id>     Preferred player when seeding a first local mission.');
  console.log('  --workspace <p>   Read another Atris workspace.');
  console.log('  --watch           Append new GM events until Ctrl+C.');
  console.log('  --interval <sec>  Watch polling interval. Defaults to 10.');
  console.log('  --port <n>        gm phone port. Defaults to 7777.');
  console.log('  --send            gm phone: text the link to your saved number.');
  console.log('  --new-link        gm phone: make a new link; the old one stops working.');
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
  '      g league  c switch club  v replay  i card  o target  enter refresh  q quit',
];
const LEAGUE_KEYS = 'keys: g back to the club  c switch club  v replay  enter refresh  q quit';
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

const DEFAULT_WIDTH = 100;
const NAME_CAP = 24;

// The terminal's width when there is one, else 100 columns.
function termWidth() {
  const cols = process.stdout.isTTY ? Number(process.stdout.columns) : 0;
  return cols >= 40 ? cols : DEFAULT_WIDTH;
}

// A column cell that never cuts mid-word silently: text that does not fit
// ends in "..." so it reads as shortened. Always one space after.
function cell(value, width) {
  const text = String(value == null ? '' : value);
  const room = Math.max(1, width - 1);
  if (text.length <= room) return text + ' '.repeat(width - text.length);
  const short = `${text.slice(0, Math.max(1, width - 5))}...`;
  return short + ' '.repeat(Math.max(1, width - short.length));
}

// A name column wide enough for the longest name shown, capped at 24.
function nameWidth(names, min = 12, cap = NAME_CAP) {
  const longest = Math.max(0, ...names.filter(Boolean).map(n => String(n).length));
  return Math.max(min, Math.min(cap, longest)) + 2;
}

// The free text at the end of a line (a title) takes whatever room is left.
function tail(text, used, width) {
  return clip(text, Math.max(10, width - used));
}

// Last guard on width: a long line breaks after a comma onto an indented
// line; anything still too long ends in "...".
function fitLines(lines, width) {
  const out = [];
  for (const line of lines) {
    let rest = line;
    while (rest.length > width) {
      const cut = rest.lastIndexOf(', ', width - 1);
      if (cut <= 0) break;
      out.push(rest.slice(0, cut + 1));
      rest = `  ${rest.slice(cut + 2)}`;
    }
    out.push(rest.length > width ? `${rest.slice(0, width - 3)}...` : rest);
  }
  return out;
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
  return season.seasonBoard(season.loadSeason(workspaceRoot, { lastSeen: options.lastSeen }), options);
}

// One screen, about 40 rows at most. Pure: board in, lines out.
function renderBoardLines(board, { interactive = false, width = termWidth() } = {}) {
  const { clockLabel } = require('../lib/gm-season');
  const lines = [];
  const nameW = nameWidth([
    ...board.roster.map(r => r.name),
    ...(board.waiting_on_review || []).map(r => r.member),
    ...(board.stuck || []).map(r => r.member),
    ...(board.last_plays || []).map(p => p.member),
  ], 16);
  const gmTarget = require('../lib/gm-target');
  const live = interactive ? ` | refreshes every ${REFRESH_MS / 1000}s` : '';
  const record = board.record ? ` | ${gmTarget.recordLine(board.record)}` : '';
  lines.push(`front office | ${board.workspace_name} | ${weekLabel(board.week_of)}${record}${live}`);
  lines.push(board.mood.line);
  if (board.target) lines.push(gmTarget.targetLine(board.target));
  if (board.since_last_look) lines.push(board.since_last_look.line);
  if (board.error) lines.push(`could not read the task list: ${clip(board.error, 80)}`);
  lines.push('');

  lines.push('roster, last 30 days');
  if (board.roster.length) {
    lines.push(`  ${pad('name', nameW)}${pad('ovr', 8)}${pad('form', 7)}${pad('record', 18)}status`);
    for (const row of board.roster) {
      const record = `landed ${row.landed} of ${row.jobs}`;
      lines.push(`  ${cell(row.name, nameW)}${pad(row.ovr == null ? 'rookie' : row.ovr, 8)}${pad(row.form || '-', 7)}${pad(record, 18)}${row.status}`);
    }
  } else {
    lines.push('  no jobs taken in the last 30 days');
  }
  lines.push('');

  // review waits first: handed in, waiting on a reviewer, the usual jam
  if (board.waiting_on_review && board.waiting_on_review.length) {
    const total = board.waiting_on_review_total || board.waiting_on_review.length;
    const more = total > board.waiting_on_review.length ? `, ${total} in all, oldest first` : '';
    lines.push(`waiting on review, age since the proof${more}`);
    for (const row of board.waiting_on_review) {
      const head = `  ${cell(row.member, nameW)}${pad(row.age, 6)}${cell(row.ref, 11)}`;
      lines.push(`${head}${tail(row.title, head.length, width)}`);
    }
    lines.push('');
  }
  if (board.stuck && board.stuck.length) {
    lines.push(`stuck with the player, claimed with no move for 6h or more${interactive ? ' (u to unstick)' : ''}`);
    for (const row of board.stuck) {
      const head = `  ${cell(row.member, nameW)}${pad(row.age, 6)}${cell(row.ref, 11)}`;
      lines.push(`${head}${tail(row.title, head.length, width)}`);
    }
    lines.push('');
  }

  // the outcome word is its own column and never cut; the title gives way
  lines.push('last plays');
  if (board.last_plays && board.last_plays.length) {
    for (const play of board.last_plays) {
      const tag = play.fresh ? '  new' : '';
      const head = `  ${pad(clockLabel(play.at, board.now), 17)}${cell(play.member, nameW)}${pad(play.play, 10)}${pad(hoursLabel(play.hours), 6)}`;
      lines.push(`${head}${tail(play.title, head.length + tag.length, width)}${tag}`);
    }
  } else {
    lines.push('  no plays yet');
  }
  lines.push('');

  lines.push('up next');
  if (board.up_next.length) {
    for (const item of board.up_next) {
      const label = item.kind === 'task' ? (item.ref || 'task') : 'mission';
      const owner = item.owner ? ` (${clip(item.owner, NAME_CAP)})` : '';
      const head = `  ${cell(label, 12)}`;
      lines.push(`${head}${tail(item.title, head.length + owner.length, width)}${owner}`);
    }
  } else {
    lines.push('  no open tasks or active missions');
  }
  lines.push('');

  lines.push('key: ovr 60 to 99 = share of finished jobs landed, rookie under 3 finished,');
  lines.push('     stricter than the website rating on purpose (drops and abandons count)');
  lines.push('     form: last 5, newest right: k landed, d dropped, x sent back, a abandoned');
  lines.push('     hours: claim to result. on a job: moved in the last 6h. review: pending');
  if (interactive) for (const line of PLAY_KEYS) lines.push(line);
  else lines.push('     run atris gm in a terminal to play');
  return fitLines(lines, width);
}

function loadLeagueBoard(options = {}) {
  const season = require('../lib/gm-season');
  return season.leagueBoard(season.loadLeague(options));
}

// The league: one row per club, best this week first. Pure: board in, lines out.
function renderLeagueLines(board, { interactive = false, width = termWidth() } = {}) {
  const lines = [];
  const clubW = nameWidth(board.rows.slice(0, LEAGUE_MAX_ROWS).map(r => r.club), 16);
  const live = interactive ? ` | refreshes every ${REFRESH_MS / 1000}s` : '';
  lines.push(`league | ${board.days} days | ${board.rows.length} clubs${live}`);
  if (board.error) lines.push(`could not read the task list: ${clip(board.error, 80)}`);
  lines.push('');
  if (!board.rows.length) {
    lines.push('  no club finished 3 or more jobs in the last 30 days');
  } else {
    // the target column shows only when some club has a target
    const withTarget = board.rows.some(row => row.target);
    const targetHead = withTarget ? pad('target', 10) : '';
    lines.push(`  ${pad('club', clubW)}${pad('ovr', 7)}${pad('week', 6)}${pad('30d', 6)}${pad('drop', 6)}${pad('aband', 7)}${pad('stuck', 7)}${pad('last', 6)}${targetHead}best player`);
    for (const row of board.rows.slice(0, LEAGUE_MAX_ROWS)) {
      const targetCell = withTarget ? pad(row.target || '-', 10) : '';
      const head = `  ${cell(row.club, clubW)}${pad(row.ovr == null ? 'rookie' : row.ovr, 7)}${pad(row.landed_week, 6)}${pad(row.landed_30d, 6)}${pad(row.dropped_30d, 6)}${pad(row.abandoned_30d, 7)}${pad(row.stuck, 7)}${pad(row.last_play, 6)}${targetCell}`;
      // the rating always shows; a long best player name gives way first
      const best = row.best_player
        ? `${clip(row.best_player.name, Math.max(6, Math.min(NAME_CAP, width - head.length - 4)))} ${row.best_player.ovr}`
        : '-';
      lines.push(`${head}${best}`);
    }
    const more = board.rows.length - LEAGUE_MAX_ROWS;
    if (more > 0) lines.push(`  and ${more} more clubs (atris gm --league --json lists all)`);
  }
  if (board.hidden) lines.push(`  ${board.hidden} quiet clubs hidden (under 3 finished jobs in 30 days)`);
  lines.push('');
  lines.push('key: week and 30d count landed jobs; drop and aband count dropped and');
  lines.push('     abandoned jobs in 30 days. stuck: claims with no move for 6h or more');
  lines.push('     last: newest task event. ovr: the club board rating over every job');
  lines.push(interactive ? LEAGUE_KEYS : '     run atris gm in a terminal, then g, to play');
  return fitLines(lines, width);
}

// The club a typed name means: its unique league label, or a folder name
// that only one club has. Returns { root }, { ambiguous: [labels] }, or null.
function pickClub(answer, rows = []) {
  const wanted = String(answer || '').trim().toLowerCase();
  if (!wanted) return null;
  const exact = rows.filter(row => String(row.club).toLowerCase() === wanted);
  if (exact.length === 1) return { root: exact[0].root };
  const byFolder = exact.length ? exact : rows.filter(row => path.basename(String(row.root)).toLowerCase() === wanted);
  if (byFolder.length === 1) return { root: byFolder[0].root };
  if (byFolder.length > 1) return { ambiguous: byFolder.map(row => row.club) };
  return null;
}

// An unreadable task db is a failure, not an empty board: say so, exit 1.
function failRead(error) {
  console.error(`could not read the task list: ${clip(error, 120)}`);
  process.exitCode = 1;
}

function printLeague() {
  const board = loadLeagueBoard();
  if (board.error) return failRead(board.error);
  console.log(renderLeagueLines(board).join('\n'));
  return undefined;
}

function printBoard(args = []) {
  const board = loadBoard(boardWorkspaceRoot(args));
  if (board.error) return failRead(board.error);
  console.log(renderBoardLines(board).join('\n'));
  return undefined;
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
    recheck: { task_id: row.task_id, member: row.member },
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
  // The club in view. c switches it, the same as --workspace; every command a
  // key runs then runs in that club's folder.
  let workspaceRoot = boardWorkspaceRoot(args);
  const cliPath = path.join(__dirname, '..', 'bin', 'atris.js');
  const write = text => output.write(`${text}\n`);
  const setRaw = (on) => {
    if (input.isTTY && typeof input.setRawMode === 'function') input.setRawMode(on);
  };

  readline.emitKeypressEvents(input);

  // The recap compares against the look before this session, pinned per club
  // for the session. What gets saved as the new look is the time of the last
  // club snapshot actually drawn, so a landing after it still shows next time.
  const season = require('../lib/gm-season');
  let lastSeen = season.readLastSeen(workspaceRoot);

  let view = 'club';
  let seen = null;
  let note = '';
  let stuck = [];
  let leagueRowsSeen = [];
  let lastBoard = null;
  const draw = () => {
    output.write('\x1b[2J\x1b[H');
    try {
      if (view === 'league') {
        const board = loadLeagueBoard();
        leagueRowsSeen = [...board.rows, ...(board.hidden_clubs || [])];
        write(renderLeagueLines(board, { interactive: true }).join('\n'));
      } else {
        const board = loadBoard(workspaceRoot, { seen, lastSeen });
        lastBoard = board;
        seen = new Set(board.last_plays.map(play => play.id));
        stuck = board.stuck || [];
        write(renderBoardLines(board, { interactive: true }).join('\n'));
        season.writeLastSeen(workspaceRoot, board.now);
      }
    } catch (err) {
      write(`could not load the board: ${err.message}`);
    }
    if (note) write(`\n${note}`);
  };

  const switchClub = (root) => {
    workspaceRoot = root;
    lastSeen = season.readLastSeen(workspaceRoot);
    seen = null;
    stuck = [];
    view = 'club';
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

  // Ctrl-C while a command runs reaches the command, not gm, so gm comes back:
  // the signal trap below ignores SIGINT while a child runs.
  let childRunning = false;
  const runAtris = (cmdArgs, { stopAfterMs = null } = {}) => new Promise((resolve) => {
    setRaw(false);
    input.pause();
    childRunning = true;
    const child = spawn(process.execPath, [cliPath, ...cmdArgs], {
      cwd: workspaceRoot,
      stdio: 'inherit',
      env: process.env,
    });
    const timer = stopAfterMs ? setTimeout(() => child.kill('SIGTERM'), stopAfterMs) : null;
    const finish = (result) => {
      if (timer) clearTimeout(timer);
      childRunning = false;
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
    // The stuck list can be minutes old: if the holder moved while the y
    // prompt was open, releasing now would take an active job away.
    if (action.recheck && !season.stillStuck(action.recheck.task_id, action.recheck.member)) {
      return 'not stuck anymore, nothing ran';
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

  // v: replay what happened since the look this session started from (or the
  // last 12 hours), for this club or the league, then come back.
  const replayHere = async () => {
    const now = Date.now();
    const window = season.parseSince('', { now, lastSeen });
    const byClub = view === 'league';
    const model = season.loadReplay({ workspaceRoot, since: window.since, now, league: byClub });
    if (!model.plays.length) return `nothing happened since ${season.clockLabel(window.since, now)}`;
    queue.length = 0;
    setRaw(true);
    input.resume();
    const outcome = await runReplay({ plays: model.plays, since: window.since, now, byClub }, {
      write: text => output.write(text),
      poll: () => queue.splice(0).map(({ str, key }) => replayKeyName(str, key)),
    });
    const summary = season.replaySummary(model.plays, { stuck: model.stuck, since: window.since, now });
    write('');
    write(outcome === 'quit' ? `stopped early. ${summary}` : summary);
    write('press any key to go back to the board');
    await nextKey();
    return summary;
  };

  let atBoard = false;
  const refresh = setInterval(() => {
    if (atBoard) draw();
  }, REFRESH_MS);
  // A signal from outside (kill, a closed window) still hands the terminal
  // back the way it was found.
  const untrap = trapSignals(() => {
    clearInterval(refresh);
    input.off('keypress', onKeypress);
    setRaw(false);
  }, { ignoreInt: () => childRunning });

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
      } else if (name === 'g') {
        view = view === 'league' ? 'club' : 'league';
        note = '';
        draw();
      } else if (name === 'v') {
        note = await replayHere();
        draw();
      } else if (name === 'o' && view === 'club') {
        // owner target: three numbers, enter keeps the default shown
        const gmTarget = require('../lib/gm-target');
        const base = (lastBoard && lastBoard.target_default) || { landed: 1, max_abandoned: 2, max_stuck: 0 };
        write('');
        write(`owner target for the ${weekLabel(lastBoard ? lastBoard.week_of : Date.now())}`);
        const landed = await ask(`landed this week (enter for ${base.landed}): `);
        const maxAbandoned = landed === null ? null : await ask(`max abandoned (enter for ${base.max_abandoned}): `);
        const maxStuck = maxAbandoned === null ? null : await ask(`max stuck over a day (enter for ${base.max_stuck}): `);
        if (landed === null || maxAbandoned === null || maxStuck === null) {
          note = 'cancelled, target unchanged';
        } else {
          const built = targetFromInput(base, { landed, maxAbandoned, maxStuck });
          if (built.error) note = `target unchanged: ${built.error}`;
          else if (!gmTarget.writeTarget(workspaceRoot, built.target)) note = 'could not save the target';
          else note = `target set: ${targetSummary(built.target)}`;
        }
        draw();
      } else if (name === 'i') {
        write('');
        const who = await ask('card for which member? ');
        if (who === null || !who) {
          note = 'cancelled, nothing shown';
        } else {
          const result = season.loadCard(workspaceRoot, who);
          if (result.card) {
            output.write('\x1b[2J\x1b[H');
            write(renderCardLines(result.card).join('\n'));
            write('');
            write('press any key to go back to the board');
            await nextKey();
            note = '';
          } else {
            note = `${result.error}${result.close && result.close.length ? `. close names: ${result.close.join(', ')}` : ''}`;
          }
        }
        draw();
      } else if (name === 'c') {
        if (!leagueRowsSeen.length) {
          const fresh = loadLeagueBoard();
          leagueRowsSeen = [...fresh.rows, ...(fresh.hidden_clubs || [])];
        }
        write('');
        const names = leagueRowsSeen.slice(0, 6).map(row => row.club).join(', ');
        const answer = await ask(`switch to which club? (${names}${leagueRowsSeen.length > 6 ? ', ...' : ''}): `);
        const picked = answer ? pickClub(answer, leagueRowsSeen) : null;
        if (picked && picked.root) {
          switchClub(picked.root);
          note = `now looking at ${path.basename(picked.root)}`;
        } else if (picked && picked.ambiguous) {
          note = `more than one club is called that: ${picked.ambiguous.join(', ')}. type the full name`;
        } else {
          note = answer ? `no club called "${clip(answer, 40)}" in the league` : 'stayed on this club';
        }
        draw();
      } else if (view === 'club' && ['p', 'r', 'w', 's', 'u', 'l'].includes(name)) {
        note = await doAction(name);
        draw();
      }
    }
  } finally {
    untrap();
    clearInterval(refresh);
    input.off('keypress', onKeypress);
    setRaw(false);
    input.pause();
    write('');
  }
}

const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };

// Restores the terminal and exits with the usual code when a signal arrives:
// raw mode off, cursor shown, then 130 / 143 / 129. Returns the function that
// removes the handlers on a normal exit. `ignoreInt` lets SIGINT pass to a
// running child instead.
function trapSignals(cleanup, { ignoreInt = () => false } = {}) {
  const handlers = {};
  for (const sig of Object.keys(SIGNAL_EXIT_CODES)) {
    handlers[sig] = () => {
      if (sig === 'SIGINT' && ignoreInt()) return;
      try {
        cleanup();
      } catch {
        // restoring is best effort; the exit below still happens
      }
      try {
        if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') process.stdin.setRawMode(false);
      } catch {
        // stdin may already be gone
      }
      try {
        process.stdout.write('\x1b[?25h\n');
      } catch {
        // stdout may already be gone
      }
      process.exit(SIGNAL_EXIT_CODES[sig]);
    };
    process.on(sig, handlers[sig]);
  }
  return () => {
    for (const sig of Object.keys(handlers)) process.off(sig, handlers[sig]);
  };
}

// ---- owner target -----------------------------------------------------------

// A whole number typed at a prompt or flag: empty means the default, below
// `min` or not a number means no.
function parseWhole(text, fallback, min = 0) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n >= min ? n : null;
}

// The target to save from what was typed, over a base target. Pure.
// Returns { target } or { error }.
function targetFromInput(base, { landed, maxAbandoned, maxStuck } = {}) {
  const next = {
    landed: parseWhole(landed, base.landed, 1),
    max_abandoned: parseWhole(maxAbandoned, base.max_abandoned, 0),
    max_stuck: parseWhole(maxStuck, base.max_stuck, 0),
  };
  if (next.landed == null) return { error: 'landed takes a whole number, 1 or more' };
  if (next.max_abandoned == null) return { error: 'max abandoned takes a whole number, 0 or more' };
  if (next.max_stuck == null) return { error: 'max stuck takes a whole number, 0 or more' };
  return { target: next };
}

function targetSummary(target) {
  return `${target.landed} landed, at most ${target.max_abandoned} abandoned, at most ${target.max_stuck} stuck over a day`;
}

// gm target: show this week's target, or set or clear it. Only the target
// file under ~/.atris/state/gm-targets is written.
function gmTargetCommand(args = []) {
  const gmTarget = require('../lib/gm-target');
  const workspaceRoot = boardWorkspaceRoot(args);
  const board = loadBoard(workspaceRoot);
  if (board.error) return failRead(board.error);
  if (hasExactFlag(args, '--clear')) {
    if (!gmTarget.writeTarget(workspaceRoot, { cleared: true })) {
      console.error('could not save the target');
      process.exitCode = 1;
      return undefined;
    }
    console.log(`target cleared from the ${weekLabel(board.week_of)} on`);
    return undefined;
  }
  const given = {
    landed: flag(args, '--landed'),
    maxAbandoned: flag(args, '--max-abandoned'),
    maxStuck: flag(args, '--max-stuck'),
  };
  if (given.landed == null && given.maxAbandoned == null && given.maxStuck == null) {
    if (board.target) console.log(gmTarget.targetLine(board.target));
    else console.log(`no target for the ${weekLabel(board.week_of)}. suggested: ${targetSummary(board.target_default)}`);
    if (board.record) console.log(gmTarget.recordLine(board.record));
    if (board.no_history) console.log('no task history yet');
    return undefined;
  }
  const base = board.target ? board.target.target : board.target_default;
  const built = targetFromInput(base, given);
  if (built.error) {
    console.error(`target: ${built.error}`);
    process.exitCode = 1;
    return undefined;
  }
  if (!gmTarget.writeTarget(workspaceRoot, built.target)) {
    console.error('could not save the target');
    process.exitCode = 1;
    return undefined;
  }
  console.log(`target for the ${weekLabel(board.week_of)}: ${targetSummary(built.target)}`);
  const after = loadBoard(workspaceRoot);
  if (after.target) console.log(gmTarget.targetLine(after.target));
  if (after.no_history) console.log('no task history yet');
  return undefined;
}

// ---- phone ------------------------------------------------------------------

// gm phone: serve the decision cards to a phone on the same wifi. The link
// carries a random token; every request without it gets 403. Ctrl-C stops it.
// Commands started from the phone keep running on their own after that.
async function gmPhone(args = []) {
  const http = require('http');
  const phone = require('../lib/gm-phone');
  const { phonePage } = require('../lib/gm-phone-page');
  const gmTarget = require('../lib/gm-target');
  const { atrisHome } = require('../lib/state-home');
  const workspaceRoot = boardWorkspaceRoot(args);
  const portRaw = flag(args, '--port');
  const firstPort = portRaw == null ? 7777 : Number(portRaw);
  if (!Number.isInteger(firstPort) || firstPort < 1 || firstPort > 65535) {
    console.error('--port takes a whole number from 1 to 65535');
    process.exitCode = 2;
    return undefined;
  }
  const lan = phone.lanAddress();
  const addresses = [...new Set([lan, '127.0.0.1'].filter(Boolean))];
  // filled in once a port is open; the handler reads it on every request
  const hosts = [];
  const stateDir = path.join(atrisHome(), 'state');
  // the same link across restarts, until --new-link
  const { token, reused } = phone.phoneToken(workspaceRoot, { stateDir, rotate: hasExactFlag(args, '--new-link') });
  const handler = phone.createPhoneHandler({
    workspaceRoot,
    token,
    hosts,
    loadView: () => phone.loadPhoneView(workspaceRoot),
    runStep: phone.makeStepRunner({ cliPath: path.join(__dirname, '..', 'bin', 'atris.js'), cwd: workspaceRoot, logDir: path.join(stateDir, 'gm-phone-runs') }),
    writeTarget: target => gmTarget.writeTarget(workspaceRoot, target),
    snapshotTarget: () => phone.targetSnapshot(workspaceRoot),
    logPath: path.join(stateDir, 'gm-phone-actions.jsonl'),
    page: phonePage,
    makeBetDesk: (log) => {
      const gmBet = require('../lib/gm-bet');
      return gmBet.createBetDesk({
        workspaceRoot,
        ledgerFile: gmBet.ledgerPath(stateDir),
        attemptsFile: gmBet.attemptsPath(stateDir),
        runCli: gmBet.makeCliRunner({ cliPath: path.join(__dirname, '..', 'bin', 'atris.js'), cwd: workspaceRoot }),
        log,
        // read the started bets' missions every 25 seconds, read-only
        pollMs: gmBet.JOB_POLL_MS,
        // the numbers a question card stands on, when no bet is being made to read them
        readBundle: () => gmBet.readBundle(workspaceRoot, { ledgerFile: gmBet.ledgerPath(stateDir) }),
        // the roster's reviewer gets up to 16 minutes to read the finished work
        reviewCli: gmBet.makeCliRunner({ cliPath: path.join(__dirname, '..', 'bin', 'atris.js'), cwd: workspaceRoot, timeoutMs: 16 * 60 * 1000 }),
      });
    },
  });

  const listenAll = async (port) => {
    const opened = [];
    try {
      for (const address of addresses) {
        const server = http.createServer((req, res) => { handler(req, res); });
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(port, address, resolve);
        });
        opened.push(server);
      }
      return opened;
    } catch (err) {
      for (const server of opened) server.close();
      throw err;
    }
  };
  // With no --port, a taken 7777 moves on to the next free port (up to 10).
  let servers = null;
  let port = firstPort;
  for (let tries = portRaw == null ? 10 : 1; tries > 0 && !servers; tries -= 1) {
    try {
      servers = await listenAll(port);
    } catch (err) {
      if (!(err && err.code === 'EADDRINUSE' && tries > 1)) {
        console.error(err && err.code === 'EADDRINUSE' ? `port ${port} is taken. try --port ${port + 1}` : `could not start: ${err.message}`);
        process.exitCode = 1;
        return undefined;
      }
      port += 1;
    }
  }
  hosts.push(...addresses.map(a => `${a}:${port}`), `localhost:${port}`);

  const link = `http://${lan || '127.0.0.1'}:${port}/?t=${token}`;
  console.log('');
  console.log(`your front office for ${path.basename(workspaceRoot)} is open.`);
  if (lan) {
    console.log('scan this with your phone camera, or open the link on the same wifi:');
    console.log('');
    try {
      const { qrLines } = require('../lib/qr');
      console.log(qrLines(link, { color: Boolean(process.stdout.isTTY) }).map(line => `  ${line}`).join('\n'));
      console.log('');
    } catch {
      // the link below still works without the picture
    }
  } else {
    console.log('no wifi address found, so only this mac can open it:');
  }
  console.log(`  ${link}`);
  console.log('');
  console.log(reused ? 'this is the same link as last time.' : 'this is a new link; any older one stops working.');
  console.log('anyone with this link can act for you while this runs. ctrl-c stops it. a new link: atris gm phone --new-link');

  if (hasExactFlag(args, '--send')) {
    const autoland = require('../lib/autoland');
    const to = String((autoland.readPolicy(workspaceRoot) || {}).imessage_to || '').trim();
    if (!to) {
      console.log('not texted: no number saved for texts. save one with: atris autoland on --to <your number>');
    } else {
      const sent = autoland.sendImessage(workspaceRoot, to, `your front office: ${link}`);
      console.log(sent.ok ? `texted the link to ${to}` : `could not text the link: ${sent.output}`);
    }
  }

  await new Promise((resolve) => {
    const stop = () => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      for (const server of servers) {
        server.close();
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      }
      // the idea and question writers stop with the page; missions started from the phone keep going
      require('../lib/gm-bet').stopWriters();
      const running = handler.actions.filter(a => a.status === 'running').length;
      console.log('');
      console.log(running ? `phone page stopped. ${running} started from the phone still running on their own.` : 'phone page stopped.');
      resolve();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
  return undefined;
}

// ---- player card ------------------------------------------------------------

// One member's profile page as lines. Pure: card in, lines out.
function renderCardLines(card, { width = termWidth() } = {}) {
  const { clockLabel } = require('../lib/gm-season');
  const lines = [];
  lines.push(`card | ${card.name} | ${card.workspace_name}`);
  const roleHead = `role: ${card.role || 'not recorded'} | ${card.awake ? 'awake' : 'asleep'} | `;
  const status = card.status.title ? `${card.status.state}: ${tail(card.status.title, roleHead.length + card.status.state.length + 2, width)}` : card.status.state;
  lines.push(`${roleHead}${status}`);
  lines.push('');
  const weekly = card.weekly.map(v => (v == null ? '-' : String(v))).join(' ');
  lines.push(`ovr ${card.ovr == null ? 'rookie' : card.ovr} | last 6 weeks, oldest first: ${weekly}`);
  const r = card.record_30d;
  const median = card.median_landing_hours == null ? 'no landings to time' : `median ${card.median_landing_hours}h from claim to landing`;
  lines.push(`record 30d: ${r.landed} landed, ${r.dropped} dropped, ${r.sent_back} sent back, ${r.abandoned} abandoned | ${median}`);
  const engine = card.engine
    ? `engine: ${card.engine.engine}${card.engine.model ? ` (${card.engine.model})` : ''}, from ${card.engine.source}`
    : 'engine: not recorded';
  lines.push(engine);
  lines.push(`scouting: ${card.scouting}`);
  lines.push('');
  lines.push('last 8 plays');
  if (card.last_plays.length) {
    for (const play of card.last_plays) {
      const head = `  ${pad(clockLabel(play.at, card.now), 17)}${pad(play.outcome, 11)}`;
      lines.push(`${head}${tail(play.title, head.length, width)}`);
    }
  } else {
    lines.push('  no plays in the last 6 weeks');
  }
  return fitLines(lines, width);
}

// gm card <member>: read only. Unknown names exit 1 with the closest names.
function gmCard(args = []) {
  const season = require('../lib/gm-season');
  const workspaceRoot = boardWorkspaceRoot(args);
  const name = positional(args)[0];
  const result = season.loadCard(workspaceRoot, name);
  if (!result.card) {
    console.error(result.error);
    if (result.close && result.close.length) console.error(`close names: ${result.close.join(', ')}`);
    process.exitCode = 1;
    return;
  }
  if (hasFlagOrValue(args, '--json')) {
    console.log(JSON.stringify({ schema: 'atris.gm_card.v1', ...result.card }, null, 2));
    return;
  }
  console.log(renderCardLines(result.card).join('\n'));
}

// ---- replay: the night as a two-minute time-lapse -------------------------

const REPLAY_KEYS = 'keys: space pause  f faster  q quit';

function replayWho(play, byClub) {
  return byClub ? `${play.club}: ${play.member}` : play.member;
}

// One frame of the replay as lines. Pure: frame in, lines out.
function renderReplayFrameLines(frame, { since, now, byClub = false, speed = 1, paused = false, interactive = false, width = termWidth() } = {}) {
  const { clockLabel } = require('../lib/gm-season');
  const lines = [];
  const at = frame.at ? clockLabel(frame.at, now) : 'the start';
  const state = paused ? ', paused' : (speed !== 1 ? `, ${speed}x` : '');
  lines.push(`replaying ${clockLabel(since, now)} to now, at ${at} (play ${frame.index + 1} of ${frame.total}${state})`);
  lines.push('');
  const keyW = nameWidth(frame.rows.map(r => r.key), 18);
  lines.push(`  ${pad(byClub ? 'club' : 'name', keyW)}${pad('landed', 8)}${pad('dropped', 9)}${pad('sent back', 11)}abandoned`);
  for (const row of frame.rows) {
    lines.push(`  ${cell(row.key, keyW)}${pad(row.landed, 8)}${pad(row.dropped, 9)}${pad(row.sent_back, 11)}${pad(row.abandoned, 11)}${row.bump ? '+1' : ''}`.replace(/\s+$/, ''));
  }
  lines.push('');
  lines.push('plays, newest first');
  const whoW = nameWidth(frame.ticker.map(p => replayWho(p, byClub)), 16, byClub ? NAME_CAP * 2 : NAME_CAP);
  for (const play of frame.ticker) {
    const mark = play.newest ? '> ' : '  ';
    const head = `${mark}${pad(clockLabel(play.at, now), 17)}${cell(replayWho(play, byClub), whoW)}${pad(play.play, 10)}`;
    lines.push(`${head}${tail(play.title, head.length, width)}`);
  }
  if (interactive) {
    lines.push('');
    lines.push(REPLAY_KEYS);
  }
  return fitLines(lines, width);
}

// Plain mode: every play in order, one line each, no redraw. Pure.
function replayPlainLines(plays, { now, byClub = false, width = termWidth() } = {}) {
  const { clockLabel } = require('../lib/gm-season');
  const whoW = nameWidth(plays.map(p => replayWho(p, byClub)), 16, byClub ? NAME_CAP * 2 : NAME_CAP);
  return plays.map((play) => {
    const head = `${pad(clockLabel(play.at, now), 17)}${cell(replayWho(play, byClub), whoW)}${pad(play.play || play.kind.replace('_', ' '), 10)}`;
    return `${head}${tail(play.title, head.length, width)}`;
  });
}

function replaySleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Plays the frames in place. `poll` returns key names pressed since the last
// call (space, f, q). Resolves 'done' or 'quit'.
async function runReplay(model, { write, poll, interactive = true }) {
  const season = require('../lib/gm-season');
  const { plays, since, now, byClub } = model;
  const rows = season.replayRows(plays, { byClub });
  let speed = Number(model.speed) > 0 ? Number(model.speed) : 1;
  let paused = false;
  let index = 0;
  const draw = () => {
    const frame = season.replayFrame(plays, index, { byClub, rows });
    const lines = renderReplayFrameLines(frame, { since, now, byClub, speed, paused, interactive });
    write(`\x1b[H${lines.map(line => `${line}\x1b[K`).join('\n')}\n\x1b[J`);
  };
  write('\x1b[2J');
  while (index < plays.length) {
    draw();
    let waited = 0;
    while (paused || waited < season.replayDelayMs(plays.length, speed)) {
      for (const key of poll()) {
        if (key === 'q') return 'quit';
        if (key === 'space') paused = !paused;
        if (key === 'f') speed *= 2;
        if (key === 'space' || key === 'f') draw();
      }
      await replaySleep(50);
      if (!paused) waited += 50;
    }
    index += 1;
  }
  index = plays.length - 1;
  draw();
  return 'done';
}

function replayKeyName(str, key) {
  if (key && key.ctrl && key.name === 'c') return 'q';
  return (key && key.name) || str;
}

async function gmReplay(args = []) {
  const season = require('../lib/gm-season');
  const workspaceRoot = boardWorkspaceRoot(args);
  const byClub = hasExactFlag(args, '--league');
  const now = Date.now();
  const window = season.parseSince(flag(args, '--since'), { now, lastSeen: season.readLastSeen(workspaceRoot) });
  if (!window) {
    console.error('replay: --since takes a span like 30m, 12h, 2d, or last-seen');
    process.exitCode = 1;
    return;
  }
  const speed = Number(flag(args, '--speed')) > 0 ? Number(flag(args, '--speed')) : 1;
  const model = season.loadReplay({ workspaceRoot, since: window.since, now, league: byClub });
  const where = byClub ? 'the league' : path.basename(workspaceRoot);
  if (model.error) {
    failRead(model.error);
    return;
  }
  if (!model.plays.length) {
    console.log(`nothing happened since ${season.clockLabel(window.since, now)}`);
    return;
  }
  const summary = season.replaySummary(model.plays, { stuck: model.stuck, since: window.since, now });
  const plain = hasExactFlag(args, '--plain') || !(process.stdout.isTTY && process.stdin.isTTY);
  if (plain) {
    // A reader like head may close the pipe early; that is a normal end.
    process.stdout.on('error', (err) => {
      if (err && err.code === 'EPIPE') process.exit(0);
    });
    const lines = [
      `replay of ${where} since ${season.clockLabel(window.since, now)} (${window.label}), ${model.plays.length} plays`,
      ...replayPlainLines(model.plays, { now, byClub }),
      summary,
    ];
    // wait for the write to drain: the caller exits right after, and a pipe
    // write can still be in flight
    await new Promise(resolve => process.stdout.write(`${lines.join('\n')}\n`, resolve));
    return;
  }
  const readline = require('readline');
  const input = process.stdin;
  const pressed = [];
  const onKey = (str, key) => pressed.push(replayKeyName(str, key));
  readline.emitKeypressEvents(input);
  if (typeof input.setRawMode === 'function') input.setRawMode(true);
  input.resume();
  input.on('keypress', onKey);
  const untrap = trapSignals(() => input.off('keypress', onKey));
  try {
    await runReplay({ plays: model.plays, since: window.since, now, byClub, speed }, {
      write: text => process.stdout.write(text),
      poll: () => pressed.splice(0),
    });
    process.stdout.write(`\n${summary}\n`);
  } finally {
    untrap();
    input.off('keypress', onKey);
    if (typeof input.setRawMode === 'function') input.setRawMode(false);
    input.pause();
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

  if (positional(args)[0] === 'target') {
    const at = args.indexOf('target');
    return gmTargetCommand([...args.slice(0, at), ...args.slice(at + 1)]);
  }

  if (positional(args)[0] === 'card') {
    const at = args.indexOf('card');
    return gmCard([...args.slice(0, at), ...args.slice(at + 1)]);
  }

  if (positional(args)[0] === 'phone') {
    const at = args.indexOf('phone');
    return gmPhone([...args.slice(0, at), ...args.slice(at + 1)]);
  }

  if (positional(args)[0] === 'replay') {
    const at = args.indexOf('replay');
    return gmReplay([...args.slice(0, at), ...args.slice(at + 1)]);
  }

  // "gm <member>" wakes that member, but never when the ask is a read: any
  // --board, --league, or --json request only looks.
  const readOnly = hasExactFlag(args, '--board') || hasExactFlag(args, '--league') || hasFlagOrValue(args, '--json');
  const member = readOnly ? null : wakeableMember(args);
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

  // Any --board is read-only: it never seeds a starter task or touches the
  // task db for writing, even with --json or --league.
  if (hasExactFlag(args, '--board') && hasFlagOrValue(args, '--json')) {
    const workspaceRoot = boardWorkspaceRoot(args);
    const body = {
      schema: 'atris.gm_board.v1',
      generated_at: new Date().toISOString(),
      workspace_root: workspaceRoot,
      workspace_name: path.basename(workspaceRoot),
      season: loadBoard(workspaceRoot),
    };
    if (hasExactFlag(args, '--league')) body.league = loadLeagueBoard();
    const readError = body.season.error || (body.league && body.league.error);
    if (readError) {
      failRead(readError);
      return;
    }
    console.log(JSON.stringify(body, null, 2));
    return;
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
  pickClub,
  playAction,
  renderBoardLines,
  renderCardLines,
  targetFromInput,
  renderLeagueLines,
  renderReplayFrameLines,
  replayPlainLines,
  runReplay,
};
