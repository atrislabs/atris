#!/usr/bin/env node

// Catch-all for uncaught async errors — prevents silent crashes
process.on('unhandledRejection', (err) => {
  console.error(`\n✗ Unexpected error: ${err?.message || err}`);
  process.exit(1);
});

const fs = require('fs');
const path = require('path');
const { exec, spawnSync } = require('child_process');
const readline = require('readline');
const os = require('os');
const crypto = require('crypto');
const PACKAGE_JSON_PATH = path.join(__dirname, '..', 'package.json');

let CLI_VERSION = 'unknown';
try {
  const pkgRaw = fs.readFileSync(PACKAGE_JSON_PATH, 'utf8');
  const pkg = JSON.parse(pkgRaw);
  if (pkg && typeof pkg.version === 'string') {
    CLI_VERSION = pkg.version;
  }
} catch {
  // Ignore parse errors; fall back to unknown
}

// Update check utility
const {
  checkForUpdates,
  showUpdateNotification,
  inspectInstallGitState,
  formatInstallGitWarning,
} = require('../utils/update-check');

// State detection for smart default
const { detectWorkspaceState, loadContext } = require('../lib/state-detection');
const {
  saveContextProfile,
  createStarterTask,
  shouldGatherContext,
  isAtrisMetaQuestion,
  renderPrompt: renderContextGathererPrompt,
} = require('../lib/context-gatherer');

// Journal & config utilities (canonical modules)
const { getLogPath, ensureLogDirectory, createLogFile } = require('../lib/file-ops');
const { getConfigPath, loadConfig, saveConfig, loadLogSyncState, saveLogSyncState } = require('../utils/config');

// Auth & API (canonical modules — eliminates duplicate inline code)
const {
  decodeJwtClaims, getTokenExpiryEpochSeconds, shouldRefreshToken,
  getCredentialsPath, saveCredentials, loadCredentials, deleteCredentials,
  validateAccessToken: _validateAccessToken,
  refreshAccessToken: _refreshAccessToken,
  performTokenRefresh: _performTokenRefresh,
  ensureValidCredentials: _ensureValidCredentials,
  fetchMyAgents: _fetchMyAgents,
  displayAccountSummary: _displayAccountSummary,
  openBrowser, promptUser,
} = require('../utils/auth');
const {
  getApiBaseUrl, getAppBaseUrl, buildApiUrl, httpRequest,
  apiRequestJson, streamProChat, spawnClaudeCodeSession,
  DEFAULT_CLIENT_ID, DEFAULT_USER_AGENT,
} = require('../utils/api');
const missionRuntime = require('../lib/mission-runtime-loop');

// Bind DI wrappers (utils/auth uses dependency injection for apiRequestJson)
const validateAccessToken = (token) => _validateAccessToken(token, apiRequestJson);
const refreshAccessToken = (rt, p) => _refreshAccessToken(rt, p, apiRequestJson);
const performTokenRefresh = (creds) => _performTokenRefresh(creds, apiRequestJson);
const ensureValidCredentials = (opts) => _ensureValidCredentials(apiRequestJson, opts);
const fetchMyAgents = (token) => _fetchMyAgents(token, apiRequestJson);
const displayAccountSummary = () => _displayAccountSummary(apiRequestJson);

// Run update check in background (non-blocking).
// Skip for machine-readable JSON and help commands to avoid corrupting stdout.
let updateCheckPromise = null;
const updateCommand = process.argv[2];
const updateArgs = process.argv.slice(3);
const helpRequested = updateCommand === 'help'
  || updateCommand === '--help'
  || updateCommand === '-h'
  || updateArgs.includes('--help')
  || updateArgs.includes('-h')
  || updateArgs[0] === 'help';
const jsonRequested = updateArgs.includes('--json');
const skipUpdateCheck = Boolean(process.env.ATRIS_SKIP_UPDATE_CHECK || process.env.NO_UPDATE_NOTIFIER || helpRequested || jsonRequested);
if (!skipUpdateCheck && (!updateCommand || (updateCommand && !['version', 'update'].includes(updateCommand)))) {
  updateCheckPromise = checkForUpdates()
    .then((updateInfo) => {
      if (updateInfo) {
        showUpdateNotification(updateInfo, {
          packageRoot: path.join(__dirname, '..'),
        });
      }
      return updateInfo;
    })
    .catch(() => {
      // Silently fail - don't annoy users with update check errors
      return null;
    });
}

let command = process.argv[2];
const commandArgs = process.argv.slice(3);
const firstCommandArg = process.argv[3];
const RUNNER_FLAG_NAMES = ['--runner-bin', '--runner-template', '--runner-model', '--runner-profile'];

function readOptionArg(args, name) {
  const prefix = `${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = args.indexOf(name);
  if (index !== -1 && index < args.length - 1 && !String(args[index + 1]).startsWith('--')) return args[index + 1];
  return null;
}

function isOptionValue(args, index, optionNames) {
  return index > 0 && optionNames.includes(args[index - 1]);
}

function applyRunnerFlags(args) {
  // --engine <name> is the operator-facing spelling of --runner-profile:
  // one flag rents a specific intelligence for this run.
  const engineFlag = readOptionArg(args, '--engine');
  if (engineFlag) {
    const { canonicalEngineName } = require('../commands/engine');
    const { RUNNER_PROFILE_NAMES } = require('../lib/runner-command');
    const canonical = canonicalEngineName(engineFlag);
    if (!canonical) {
      console.error(`Unknown --engine "${engineFlag}". Known engines: ${RUNNER_PROFILE_NAMES.join(', ')}.`);
      process.exit(1);
    }
    process.env.ATRIS_RUNNER_PROFILE = canonical;
  }
  const runnerProfile = readOptionArg(args, '--runner-profile');
  if (runnerProfile) {
    // Fail fast at the CLI boundary: an unknown profile otherwise stays silent
    // until a heartbeat spawn resolves it mid-loop (silent overnight outage).
    const { RUNNER_PROFILES, RUNNER_PROFILE_NAMES } = require('../lib/runner-command');
    if (!Object.prototype.hasOwnProperty.call(RUNNER_PROFILES, runnerProfile)) {
      console.error(`Unknown --runner-profile "${runnerProfile}". Known profiles: ${RUNNER_PROFILE_NAMES.join(', ')}.`);
      process.exit(1);
    }
    process.env.ATRIS_RUNNER_PROFILE = runnerProfile;
  }
  const runnerBin = readOptionArg(args, '--runner-bin');
  if (runnerBin) {
    process.env.ATRIS_RUNNER_BIN = runnerBin;
    process.env.ATRIS_CLAUDE_BIN = runnerBin;
  }
  const runnerTemplate = readOptionArg(args, '--runner-template');
  if (runnerTemplate) {
    process.env.ATRIS_RUNNER_COMMAND_TEMPLATE = runnerTemplate;
    process.env.ATRIS_CLAUDE_COMMAND_TEMPLATE = runnerTemplate;
  }
  const runnerModel = readOptionArg(args, '--runner-model');
  if (runnerModel) {
    process.env.ATRIS_RUNNER_MODEL = runnerModel;
    process.env.ATRIS_CLAUDE_MODEL = runnerModel;
  }
  // No per-run choice and no env: the workspace's saved engine
  // (.atris/engine.json, written by `atris engine <name>`) becomes the
  // profile for every loop spawn. For the loop commands themselves, fall all
  // the way to the house engine (atris-fast when ax is installed) so the
  // default intelligence is our own. Heartbeats stay engine-agnostic without
  // any loop code knowing about engines.
  if (!process.env.ATRIS_RUNNER_PROFILE) {
    try {
      const engine = require('../commands/engine');
      const saved = engine.readSavedEngine();
      if (saved) {
        process.env.ATRIS_RUNNER_PROFILE = saved;
      } else if (RUNNER_SPAWNING_COMMANDS.includes(command)) {
        const resolved = engine.resolveDefaultEngine();
        if (resolved.source === 'house') process.env.ATRIS_RUNNER_PROFILE = resolved.name;
      }
    } catch {}
  }
}

// Commands whose ticks spawn a worker engine; only these pay the engine
// detection probe when nothing is configured.
const RUNNER_SPAWNING_COMMANDS = ['run', 'autopilot', 'mission', 'pulse', 'gm', 'spaceship'];

const isBusinessSyncSafetyCommand = command === 'sync'
  && (
    commandArgs.includes('--status')
    || commandArgs.includes('--review')
    || commandArgs.includes('--resolve')
    || firstCommandArg === 'status'
    || firstCommandArg === 'doctor'
    || firstCommandArg === 'review'
    || firstCommandArg === 'resolve'
  );

// Auto-sync skills only for commands that modify workspace state
if (['init', 'update', 'upgrade'].includes(command) || (command === 'sync' && !isBusinessSyncSafetyCommand)) {
  try {
    const { syncSkills } = require('../commands/sync');
    const skillsUpdated = syncSkills({ silent: true });
    if (skillsUpdated > 0) {
      console.log(`⬆️  ${skillsUpdated} skill${skillsUpdated > 1 ? 's' : ''} updated`);
    }
  } catch (e) {
    // Non-critical
  }
}

/**
 * Load active missions from .atris/state/missions.jsonl (append-only event log).
 * Walks lines in reverse, deduping by mission id, returns missions whose latest
 * record has status in {ready, running, planning} sorted newest-first.
 *
 * Each mission: { id, owner, objective, status, verifier, verifier_passed, next_action, lane }.
 *
 * Returns [] if file missing or malformed — never throws.
 */
function loadActiveMissions(workspaceDir) {
  try {
    const file = path.join(workspaceDir, '.atris', 'state', 'missions.jsonl');
    if (!fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const seen = new Map(); // id -> mission record
    for (let i = lines.length - 1; i >= 0; i--) {
      let rec;
      try { rec = JSON.parse(lines[i]); } catch { continue; }
      const id = rec.id || rec.mission_id;
      if (!id || seen.has(id)) continue;
      seen.set(id, rec);
    }
    const live = [];
    for (const m of seen.values()) {
      const status = m.status;
      if (!['ready', 'running', 'planning'].includes(status)) continue;
      live.push({
        id: m.id || m.mission_id,
        owner: m.owner || '?',
        objective: m.objective || '',
        status,
        created_at: m.created_at || null,
        updated_at: m.updated_at || null,
        completed_at: m.completed_at || null,
        verifier: m.verifier || null,
        verifier_passed: (m.verifier_result && m.verifier_result.passed) === true,
        next_action: m.next_action || '',
        lane: m.lane || null,
        runner: m.runner || null,
      });
    }
    // Most recently started first (rough — relies on insertion order from reversed walk)
    return live;
  } catch {
    return [];
  }
}

function readAtrisGoalState(workspaceDir) {
  try {
    const file = path.join(workspaceDir, '.atris', 'state', 'atris_goal.json');
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed?.goal || null;
  } catch {
    return null;
  }
}

function currentAtrisGoal(workspaceDir) {
  const activeMissions = loadActiveMissions(workspaceDir);
  const stored = readAtrisGoalState(workspaceDir);
  if (stored && stored.objective) {
    const mission = activeMissions.find((item) => item.id === stored.mission_id) || null;
    return {
      ...stored,
      mission_status: mission?.status || stored.mission_status,
      created_at: stored.created_at || mission?.created_at || null,
      updated_at: stored.updated_at || mission?.updated_at || null,
      completed_at: stored.completed_at || mission?.completed_at || null,
      next_command: stored.next_command || mission?.next_action || null,
    };
  }
  const mission = activeMissions[0] || null;
  if (!mission) return null;
  return {
    objective: mission.objective,
    mission_id: mission.id,
    mission_status: mission.status,
    owner: mission.owner,
    runner: mission.runner || 'mission',
    created_at: mission.created_at,
    updated_at: mission.updated_at,
    completed_at: mission.completed_at,
    next_command: mission.next_action || `atris mission tick ${mission.id} --summary "<what changed>"`,
  };
}

function goalElapsedSeconds(goal) {
  const started = Date.parse(goal?.created_at || '');
  if (!Number.isFinite(started)) return null;
  const ended = Date.parse(goal?.completed_at || '') || Date.now();
  return Math.max(0, Math.floor((ended - started) / 1000));
}

function formatGoalDuration(seconds) {
  if (!Number.isFinite(seconds)) return null;
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

function goalAchieved(goal) {
  return ['complete', 'completed', 'achieved'].includes(String(goal?.mission_status || goal?.status || '').toLowerCase());
}

function printAtrisGoalBanner(workspaceDir = process.cwd(), label = 'Atris goal') {
  if (process.env.ATRIS_SHOW_GOAL_BANNER !== '1' && process.env.AX_SHOW_GOAL_BANNER !== '1') return null;
  const goal = currentAtrisGoal(workspaceDir);
  if (!goal) return null;
  if (String(goal.runner || '').trim().toLowerCase() === 'codex_goal') return null;
  const objective = String(goal.objective || '').length > 92
    ? `${String(goal.objective).slice(0, 89)}...`
    : String(goal.objective || '');
  console.log(`${label}: ${objective}`);
  if (goal.mission_id || goal.mission_status || goal.runner) {
    const elapsed = formatGoalDuration(goalElapsedSeconds(goal));
    const parts = [
      goal.mission_id || '?',
      goal.mission_status || '?',
      goal.runner || 'mission',
    ];
    if (elapsed) parts.push(`elapsed ${elapsed}`);
    parts.push(`achieved ${goalAchieved(goal) ? 'yes' : 'no'}`);
    console.log(`Mission: ${parts.join(' · ')}`);
  }
  if (goal.next_command) console.log(`Next: ${goal.next_command}`);
  console.log('');
  return goal;
}

function showSearchHelp() {
  require('../commands/search').showSearchHelp();
}

function consoleCmd() {
  const extractedCommand = path.join(__dirname, '..', 'commands', 'console.js');
  if (fs.existsSync(extractedCommand)) {
    const loaded = require('../commands/console');
    if (loaded && typeof loaded.consoleCommand === 'function') {
      return loaded.consoleCommand();
    }
  }

  const workspace = process.cwd();
  const daemonScript = path.join(workspace, 'cli', 'atrisd.sh');

  if (!fs.existsSync(daemonScript)) {
    console.error('✗ Missing cli/atrisd.sh in this workspace.');
    console.error('  Run this from your project root, or add cli/atrisd.sh first.');
    process.exit(1);
  }

  const args = process.argv.slice(3);
  const result = spawnSync('bash', [daemonScript, ...args], {
    cwd: workspace,
    stdio: 'inherit',
    env: process.env,
  });

  if (result.error) {
    console.error(`✗ Failed to start console: ${result.error.message}`);
    process.exit(1);
  }

  process.exit(result.status ?? 0);
}

function showHelp() {
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('atris — an operating system for intelligence');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
  console.log('Quick Start:');
  console.log('');
  console.log('  1. atris                  Open a persistent AI computer for this workspace');
  console.log('     npx atris              Same command after a local project install');
  console.log('  2. Describe what you want run, built, researched, or validated');
  console.log('  3. Atris acts with context, memory, tools, and a review loop');
  console.log('');
  console.log('Common invocations:');
  console.log('  atris init [--yes]        Global install: initialize this project');
  console.log('  npx atris init [--yes]    Local install: initialize this project');
  console.log('  atris computer');
  console.log('  atris business init "My Company"');
  console.log('  atris run');
  console.log('  atris drill');
  console.log('  atris status');
  console.log('  atris soul');
  console.log('  atris fleet status');
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
  console.log('Atris Computers:');
  console.log('  Owner = User | Business');
  console.log('  Owners have Computers: workspace + files + tools + secrets + memory + agents + validation');
  console.log('  Types: code, research, CRM, reporting, events, support, business ops');
  console.log('');
  console.log('Setup:');
  console.log('  setup      - Guided first-time setup (login, pick business, pull)');
  console.log('  init       - Initialize Atris in current project (--yes skips prompts)');
  console.log('  update     - Update local files to latest version');
  console.log('  upgrade    - Install latest Atris from npm');
  console.log('');
  console.log('Core workflow:');
  console.log('  plan       - Create build spec with visualization');
  console.log('  do         - Execute tasks');
  console.log('  review     - Validate work (tests, safety checks, docs)');
  console.log('  run        - One bounded mission pursuit: start or resume, tick, complete');
  console.log('  run logs   - Browse glass run logs (phase reasoning persisted to disk)');
  console.log('  run search - Search phase reasoning across all run logs');
  console.log('  pulse      - Durable overnight self-improvement heartbeat (OS cron, install/status/tick)');
  console.log('  spaceship  - Bounded overnight runner that survives bad ticks and emails updates');
  console.log('');
  console.log('Context & tracking:');
  console.log('  log        - Add ideas to inbox');
  console.log('  wish       - Say one plain sentence, then Atris asks only for gaps or delegates it');
  console.log('  now        - Show atris/now.md, the current operating truth');
  console.log('  activate   - Load Atris context');
  console.log('  radar      - Show live agents joined with tasks, missions, and worktrees');
  console.log('  stream     - Watch the whole team work live in one terminal');
  console.log('  ctop       - Show a process-first live agent CPU/memory view');
  console.log('  launchpad  - Show the next action from local brain, task, mission, and proof state');
  console.log('  brief      - Show the one-glance operator brief');
  console.log('  status     - See local work and completions (`atris status <business>` for remote)');
  console.log('  recap      - What your AI team did, in plain English (--share for paste-ready)');
  console.log('  report     - Weekly block: landings, journal completions, and Career XP');
  console.log('  xp         - Show Career XP and contribution graph');
  console.log('  analytics  - Show recent productivity from journals');
  console.log('  search     - Search workspace memory (atris search <keyword>)');
  console.log('  clean      - Housekeeping (stale tasks, archive journals, broken refs)');
  console.log('  harvest    - Find bugs and next actions from receipts, run logs, and thinking');
  console.log('  verify     - Validate work is done (tests, MAP.md, changes)');
  console.log('  task       - Local agent task plane (atomic claims, TODO import)');
  console.log('  golden path (zero human turns):');
  console.log('    atris task delegate "fix the login bug" --to <member>');
  console.log('    atris task claim <id> --as <member>');
  console.log('    ... build ...');
  console.log('    atris task ready <id> --verify');
  console.log('    atris autoland tick   # second check runs, task lands');
  console.log('  mission    - Goal + loop + member owner + verifier + receipt; --budget quick|long|deep sets bounded tiers');
  console.log('  release    - Tag release, bump version, create GitHub release, draft /launch');
  console.log('  learn      - Project learnings (patterns, pitfalls, preferences)');
  console.log('  study      - On-demand learning feed: ingest topic, start server, open browser');
  console.log('  rainmaker  - Relationship manager dashboard (atrisos-backend/scripts/rainmaker.py)');
  console.log('  brain      - Compile MAP/TODO/wiki/state into a loadable agent brain');
  console.log('  lesson     - Append a one-line lesson to atris/lessons.md (mine: distill receipts/episodes/scorecards into policy lessons)');
  console.log('  ingest     - Local-first wiki ingest into atris/wiki/');
  console.log('  query      - Local-first wiki query against atris/wiki/');
  console.log('  lint       - Local-first wiki lint for atris/wiki/');
  console.log('  loop       - Local wiki upkeep loop (stale pages, orphans, next ingest)');
  console.log('  write      - Guided writing sessions: you write every word, atris structures + reviews');
  console.log('');
  console.log('Optional helpers:');
  console.log('  brainstorm - Explore ideas conversationally before planning');
  console.log('  autopilot  - Keep the workspace moving: mission/member loop until you stop it');
  console.log('  improve    - Run one paid RL tick (POST /api/improve, deducts credits)');
  console.log('  worktree   - Isolated Git worktrees plus guarded ship/merge for parallel agents');
  console.log('  land       - The landing: what is actually done vs still in the air; --reap backs up + clears overdue');
  console.log('  drive      - One self-driving tick: mission doctor -> auto-fix -> count disengagements');
  console.log('  autoland   - Approve the policy once; certified work lands itself, you keep irreversible calls');
  console.log('  engine     - Engine registry: list/resolve roles, health flips, default engine, `engine test`, and dispatch flights');
  console.log('  sign       - Co-author trailer on every commit in an atris workspace (on/off/status)');
  console.log('  visualize  - Generate a Slack/deck-ready visual from a prompt');
  console.log('  youtube    - Process YouTube videos with timestamped transcript-first analysis');
  console.log('');
  console.log('Experiments:');
  console.log('  experiments init [slug]     - Prepare atris/experiments/ or scaffold a pack');
  console.log('  experiments validate        - Validate experiment packs');
  console.log('  experiments run <slug>      - Execute a pack or record an Endstate receipt');
  console.log('  experiments benchmark [m]   - Run validate/runtime experiment benchmarks');
  console.log('  bench      - run core benchmark gates');
  console.log('');
  console.log('Compile loop (learn like AI, run like code):');
  console.log('  compile record <name>       - Append an execution record (--input/--output)');
  console.log('  compile build <name>        - Compile records into a deterministic run.js');
  console.log('  compile backtest <name>     - Replay all records, score accuracy vs gate');
  console.log('  compile promote <name>      - Activate (gate: accuracy >= threshold)');
  console.log('  compile exec <name>         - Run the compiled process token-free');
  console.log('');
  console.log('Quick commands:');
  console.log('  atris      - Load context and start (natural language)');
  console.log('  next       - Auto-advance to next step');
  console.log('');
  console.log('Sync:');
  console.log('  pull       - Pull journals + member data from cloud');
  console.log('  push       - Push workspace files to cloud');
  console.log('  live       - Keep a business brain fresh (doctor, pull, watch, push)');
  console.log('  clean-workspace <slug> - Analyze & remove junk files from a workspace (alias: cw)');
  console.log('');
  console.log('GitHub for Context:');
  console.log('  browse [query]     - Discover workspace templates');
  console.log('  fork <template>    - Clone a template into a new workspace');
  console.log('  publish            - Share your workspace as a template');
  console.log('  sleep [business]   - Pause workspace compute (context saved)');
  console.log('  wake [business]    - Resume workspace (agents restart)');
  console.log('');
  console.log('Business:');
  console.log('  business init <name>   - Create shared owner + first/default computer');
  console.log('  business onboard       - Onboard from sparse input (--name, --website, --contact)');
  console.log('  business add <slug>    - Connect a business');
  console.log('  business list          - Show connected businesses');
  console.log('  business remove <slug> - Disconnect a business');
  console.log('  business team [slug]   - Show members, roles, and admin access');
  console.log('  business health <slug> - Health report (members, workspace, issues)');
  console.log('  business audit         - One-line health summary of all businesses');
  console.log('  business doctor        - Catch stale cache, alias, and folder bindings');
  console.log('  business create <name> - Cloud-only business record; add --workspace to also scaffold local');
  console.log('  business connect <svc> - Wire a skill/integration');
  console.log('  business notify <mode> - Set notification mode (digest/silent/push)');
  console.log('  business deploy <slug> - Push local business to cloud');
  console.log('');
  console.log('Code Review:');
  console.log('  code-review <file>     - Run 6-specialist code review (alias: cr)');
  console.log('  cr --all               - Audit all backend services');
  console.log('');
  console.log('Cloud & agents:');
  console.log('  computer   - Open a scoped AI computer (cloud/local, personal/business)');
  console.log('  receipt    - Save evidence from an agent run');
  console.log('  console    - Start/attach always-on coding console (tmux daemon)');
  console.log('  soul       - Show, snapshot, or fork workspace identity');
  console.log('  fleet      - Inspect local fleet status');
  console.log('  loops      - Background loops board: what runs, what died, start/stop');
  console.log('  agent      - Select cloud agent, spawn worker requests, or run `agent doctor`');
  console.log('  chat       - Chat with Atris 2 Fast in this workspace (--agent for cloud agent; or: atris chat scan)');
  console.log('  fast       - Chat with Atris2 Fast');
  console.log('  login      - Sign in or add another account');
  console.log('  logout     - Sign out of current account');
  console.log('  whoami     - Show active account');
  console.log('  switch     - Switch account globally (atris switch <name>)');
  console.log('  use        - Set account for this terminal only (atris use <name>)');
  console.log('  accounts   - Manage accounts (list, add, remove)');
  console.log('');
  console.log('Integrations:');
  console.log('  github    - github cli wrapper (doctor, auth, pr list/create/checks/view)');
  console.log('  vercel    - vercel cli wrapper (doctor, auth, deploy/ls/logs/inspect)');
  console.log('  supabase  - supabase cli wrapper (doctor, auth, status/db/functions)');
  console.log('  linear    - linear cli wrapper (doctor, auth, issue list/create/view/update)');
  console.log('  stripe    - stripe cli wrapper (doctor, auth, listen/trigger/products)');
  console.log('  gmail      - Email commands (inbox, read, archive)');
  console.log('  calendar   - Calendar commands (today, week)');
  console.log('  twitter    - Twitter commands (post)');
  console.log('  slack      - Slack commands (channels)');
  console.log('  imessage   - Local Mac iMessage commands (doctor, lookup, recent, send)');
  console.log('  integrations - Show integration status');
  console.log('');
  console.log('Skills:');
  console.log('  skill create <name> - Scaffold a new skill (--integration, --local)');
  console.log('  skill link [--all]  - Symlink skills to ~/.claude/skills/ (system-level)');
  console.log('  skill list          - Show all skills with compliance status');
  console.log('  skill audit [name]  - Validate skill against Anthropic guide');
  console.log('  skill fix [name]    - Auto-fix common compliance issues');
  console.log('  skill delete <name> - Delete a skill and its symlinks');
  console.log('');
  console.log('Team:');
  console.log('  member create <name> - Scaffold a new team member (MEMBER.md)');
  console.log('  member list          - Show all team members');
  console.log('  member activate <n>  - Activate a member (link skills, show context)');
  console.log('  member upgrade <n>   - Convert flat file to directory format');
  console.log('');
  console.log('Plugin:');
  console.log('  plugin build        - Package skills as .plugin for Cowork');
  console.log('  plugin publish      - Sync skills to marketplace repo and push');
  console.log('  plugin info         - Preview what will be included');
  console.log('');
  console.log('Feedback:');
  console.log('  feedback "msg"             - Submit feedback');
  console.log('  feedback                   - List feedback queue');
  console.log('  feedback resolve <id> "<note>" - Mark resolved (admin)');
  console.log('  feedback close <id>        - Close as wontfix (admin)');
  console.log('  feedback delete <id>       - Delete feedback (admin)');
  console.log('');
  console.log('Other:');
  console.log('  version    - Show Atris version');
  console.log('  help       - Show this help');
  console.log('');
  console.log('💡 Tip: Just run "atris" to get started');
  console.log('');
}

function showPlanHelp() {
  console.log('');
  console.log('Usage: atris plan [--execute] [--full]');
  console.log('');
  console.log('Description:');
  console.log('  Activate the Navigator agent to plan work.');
  console.log('  Reads your journal Inbox, TODO.md, MAP.md, and features/, then prints a');
  console.log('  short, copy/pasteable prompt for your coding agent.');
  console.log('');
  console.log('Options:');
  console.log('  --execute   Run in agent mode via Atris cloud (requires login + agent).');
  console.log('  --full      Print full spec/context dumps (verbose copy/paste).');
  console.log('  --verbose   Alias for --full.');
  console.log('');
}

function showDoHelp() {
  console.log('');
  console.log('Usage: atris do [--execute] [--full]');
  console.log('');
  console.log('Description:');
  console.log('  Activate the Executor agent to build tasks.');
  console.log('  Reads TODO.md and features/*/build.md, then prints step-by-step');
  console.log('  execution instructions (and, in agent mode, edits code + runs commands).');
  console.log('');
  console.log('Options:');
  console.log('  --execute   Run in agent mode via Atris cloud (requires login + agent).');
  console.log('  --full      Print full spec/context dumps (verbose copy/paste).');
  console.log('  --verbose   Alias for --full.');
  console.log('');
}

function showReviewHelp() {
  console.log('');
  console.log('Usage: atris review [--limit N|--all|--json] [--full|--execute]');
  console.log('');
  console.log('Description:');
  console.log('  Show the certified Review queue: proof-ready work waiting for');
  console.log('  human accept or revise. Human accept is the AgentXP gate.');
  console.log('  Use --full/--verbose for the legacy Validator prompt.');
  console.log('');
  console.log('Options:');
  console.log('  --limit N   Show at most N certified review rows.');
  console.log('  --all       Show all certified review rows.');
  console.log('  --json      Emit the task-backed review queue as JSON.');
  console.log('  --group-by  Group certified rows by tag, owner, or source.');
  console.log('  --execute   Run in agent mode via Atris cloud (requires login + agent).');
  console.log('  --full      Print full spec/context dumps (verbose copy/paste).');
  console.log('  --verbose   Alias for --full.');
  console.log('');
}

function showStatusHelp() {
  console.log('');
  console.log('Usage: atris status [--quick] [--json] [--verbose]');
  console.log('');
  console.log('Description:');
  console.log('  Show the local Atris workspace task, inbox, completion, lesson, and team status.');
  console.log('');
  console.log('Options:');
  console.log('  --quick, -q    Print one compact status line.');
  console.log('  --json         Print machine-readable workspace status.');
  console.log('  --verbose, -v  Print the legacy visual task board.');
  console.log('  --help, -h     Show this help.');
  console.log('');
}

function showAnalyticsHelp() {
  console.log('');
  console.log('Usage: atris analytics');
  console.log('');
  console.log('Description:');
  console.log('  Summarize local journal completions, inbox trend, and activity patterns.');
  console.log('');
  console.log('Options:');
  console.log('  --help, -h   Show this help.');
  console.log('');
}

function showActivateHelp() {
  console.log('');
  console.log('Usage: atris activate');
  console.log('');
  console.log('Description:');
  console.log('  Load workspace context, recent completions, TODO, MAP, journal, and wiki status.');
  console.log('');
  console.log('Options:');
  console.log('  --help, -h   Show this help.');
  console.log('');
}

function showNextHelp(commandName = 'next') {
  console.log('');
  console.log(`Usage: atris ${commandName} [request]`);
  console.log('');
  console.log('Description:');
  console.log('  Auto-advance to the next workflow step, or route a request through the Atris entry.');
  console.log('');
  console.log('Options:');
  console.log('  --help, -h   Show this help.');
  console.log('');
}

function showVerifyHelp() {
  console.log('');
  console.log('Usage: atris verify [task]');
  console.log('Usage: atris verify <feature-slug> --section <name>');
  console.log('');
  console.log('Description:');
  console.log('  Validate workspace health, a specific task, or a feature rubric section.');
  console.log('');
  console.log('Options:');
  console.log('  --section <name>  Run a fenced bash check from atris/features/<slug>/validate.md.');
  console.log('  --help, -h        Show this help.');
  console.log('');
}

function showUpdateHelp(commandName = 'update') {
  console.log('');
  const selfFlag = commandName === 'update' ? ' [--self]' : '';
  console.log(`Usage: atris ${commandName} [--all] [--dry-run] [--force]${selfFlag}`);
  console.log('');
  console.log('Description:');
  console.log('  Sync Atris workspace files from the installed CLI templates.');
  console.log('');
  console.log('Options:');
  console.log('  --all        Update Atris files across projects under the current tree.');
  console.log('  --dry-run    Preview update work without writing files.');
  console.log('  --force      Overwrite existing template files where supported.');
  if (commandName === 'update') {
    console.log('  --self       Update the installed atris cli from npm (packaged installs only).');
  }
  console.log('  --help, -h       Show this help.');
  console.log('');
}

function showUpgradeHelp() {
  console.log('');
  console.log('Usage: atris upgrade');
  console.log('');
  console.log('Description:');
  console.log('  Check npm for the latest Atris CLI and install it globally if newer.');
  console.log('  Normal packaged installs also auto-update in the background.');
  console.log('');
  console.log('Options:');
  console.log('  --help, -h       Show this help.');
  console.log('');
}

function showReleaseHelp() {
  console.log('');
  console.log('Usage: atris release [--dry-run]');
  console.log('');
  console.log('Description:');
  console.log('  Draft or publish a release from local git history.');
  console.log('');
  console.log('Options:');
  console.log('  --dry-run    Print the planned release without committing, tagging, or pushing.');
  console.log('  --help, -h   Show this help.');
  console.log('');
}

function showAuthHelp(commandName) {
  const usage = {
    login: 'Usage: atris login [--token <token>] [--force]',
    logout: 'Usage: atris logout',
    whoami: 'Usage: atris whoami',
    switch: 'Usage: atris switch [account] [--global]',
    use: 'Usage: atris use [account]',
    accounts: 'Usage: atris accounts [add|remove <account>|remove --all]',
  }[commandName] || 'Usage: atris login|logout|whoami';
  console.log('');
  console.log(usage);
  console.log('');
  console.log('Description:');
  if (commandName === 'login') {
    console.log('  Sign in with browser OAuth or a pasted API token.');
  } else if (commandName === 'logout') {
    console.log('  Sign out of the current Atris account.');
  } else if (commandName === 'whoami') {
    console.log('  Show the active Atris account.');
  } else if (commandName === 'switch') {
    console.log('  Switch the active account globally or for this terminal session.');
  } else if (commandName === 'use') {
    console.log('  Print an ATRIS_PROFILE export for per-terminal account use.');
  } else if (commandName === 'accounts') {
    console.log('  List, add, or remove saved Atris accounts.');
  }
  console.log('');
  console.log('Options:');
  if (commandName === 'login') {
    console.log('  --token <token>  Save an API token without prompting.');
    console.log('  --force, -f      Re-run login even if credentials already exist.');
  } else if (commandName === 'switch') {
    console.log('  --global, -g     Switch the account for all terminals.');
  }
  console.log('  --help, -h       Show this help.');
  console.log('');
}

function showIntegrationsHelp() {
  console.log('');
  console.log('Usage: atris integrations');
  console.log('');
  console.log('Description:');
  console.log('  Show connection status for Gmail, Calendar, Slack, Twitter, GitHub, and iMessage.');
  console.log('');
  console.log('Options:');
  console.log('  --help, -h       Show this help.');
  console.log('');
}

function showSetupHelp() {
  console.log('');
  console.log('Usage: atris setup');
  console.log('');
  console.log('Description:');
  console.log('  Guided first-time setup: checks Node.js, login, businesses, and pull.');
  console.log('');
  console.log('Options:');
  console.log('  --help, -h   Show this help.');
  console.log('');
}

function showServeHelp() {
  console.log('');
  console.log('Usage: atris serve [--agent <agent_id>] [--allow-bash]');
  console.log('');
  console.log('Description:');
  console.log('  Start the local AI Computer bridge for the current directory.');
  console.log('');
  console.log('Options:');
  console.log('  --agent <agent_id>  Bind the session to a specific cloud agent.');
  console.log('  --allow-bash        Allow remote bash operations in this directory.');
  console.log('  --help, -h          Show this help.');
  console.log('');
}

function showLoopHelp() {
  console.log('');
  console.log('Usage: atris loop [add|start|status|report|stop|wiki] [options]');
  console.log('');
  console.log('Description:');
  console.log('  One front door for the self-improvement loop. It reads ROADMAP.md,');
  console.log('  runs bounded proof-backed work, and keeps wiki upkeep under loop wiki.');
  console.log('');
  console.log('Commands:');
  console.log('  atris loop add "<task>"        Put a bounded task into the loop queue.');
  console.log('  atris loop start [--once]      Run the local loop.');
  console.log('  atris loop start --overnight   Install the durable heartbeat.');
  console.log('  atris loop status [--json]     Show heartbeat, local runs, and next moves.');
  console.log('  atris loop report [--json]     Show proof of handled and queued loop work.');
  console.log('  atris loop stop                Remove the durable heartbeat.');
  console.log('  atris loop wiki                Run the wiki upkeep loop.');
  console.log('  --help, -h                     Show this help.');
  console.log('');
}

function showCleanHelp() {
  console.log('');
  console.log('Usage: atris clean [--dry-run] [--json]');
  console.log('');
  console.log('Description:');
  console.log('  Check workspace housekeeping: stale tasks, MAP.md refs, old journals,');
  console.log('  empty TODO sections, and stale wiki pages.');
  console.log('');
  console.log('Options:');
  console.log('  --dry-run, -n   Preview cleanup without changing files.');
  console.log('  --json          Print machine-readable cleanup results.');
  console.log('  --help, -h      Show this help.');
  console.log('');
}

function showAutopilotHelp() {
  console.log('');
  console.log('Usage: atris autopilot [description] [options]');
  console.log('');
  console.log('Description:');
  console.log('  Suggests one task at a time with justification.');
  console.log('  Human approves, skips, or cancels. Agent executes plan → do → review.');
  console.log('  Detects work from: stale wiki pages, in-progress tasks, backlog, inbox.');
  console.log('');
  console.log('Options:');
  console.log('  --auto           Execute without waiting for approval');
  console.log('  --duration=TIME  Run for a time limit (e.g. 1h, 30m, 90m)');
  console.log('  --iterations=N   Max tasks before stopping');
  console.log('  --verbose, -v    Show detailed runner output');
  console.log('  --dry-run        Show suggestions without executing');
  console.log('  --runner-bin PATH       Runner binary for this run');
  console.log('  --runner-template CMD   Runner command template for this run');
  console.log('  --runner-model MODEL    Runner model for this run');
  console.log(`  --runner-profile NAME   Runner profile for this run (one of: ${require('../lib/runner-command').RUNNER_PROFILE_NAMES.join(', ')})`);
  console.log('');
  console.log('Examples:');
  console.log('  atris autopilot                        # Suggest from existing work');
  console.log('  atris autopilot --auto --duration=1h    # Autonomous for 1 hour');
  console.log('  atris autopilot "Add dark mode toggle"  # Seed inbox, then suggest');
  console.log('  atris autopilot --auto --iterations=3   # Fully autonomous, 3 tasks max');
  console.log('');
}

if (command === 'help' || command === '--help' || command === '-h') {
  showHelp();
  process.exit(0);
}

// Core command handlers — loaded eagerly (used by interactiveEntry default path)
const { initAtris: initCmd } = require('../commands/init');
const { syncAtris: syncCmd, syncAtrisAll: syncAllCmd } = require('../commands/sync');
const { logAtris: logCmd } = require('../commands/log');
const { activateAtris: activateCmd } = require('../commands/activate');
const { statusAtris: statusCmd } = require('../commands/status');
const { planAtris: planCmd, doAtris: doCmd, reviewAtris: reviewCmd } = require('../commands/workflow');

// All other commands are lazy-loaded inline (require() only when invoked)

if (command === '2' && ['fast', 'pro'].includes(String(firstCommandArg || '').toLowerCase())) {
  const userInput = process.argv.slice(2).join(' ');
  planCmd(userInput)
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(`✗ Atris 2 failed: ${error.message || error}`);
      process.exit(1);
    });
  return;
}

// Check if this is a known command or natural language input
const knownCommands = ['init', 'log', 'wish', 'drill', 'dream', 'now', 'radar', 'stream', 'ctop', 'launchpad', 'status', 'analytics', 'visualize', 'brain', 'brainstorm', 'autopilot', 'run', '_start', 'plan', 'do', 'review', 'release',
                       'activate', '_activate', 'agent', 'chat', 'fast', 'ax', 'console', 'serve', 'login', 'logout', 'whoami', 'switch', 'use', 'accounts', '_resolve', '_profile-email', '_switch-session', 'shell-init', 'update', 'upgrade', 'version', 'help', 'next', 'atris',
                       'clean', 'harvest', 'verify', 'search', 'scout', 'skill', 'member', 'codex-goal', 'app', 'apps', 'learn', 'lesson', 'plugin', 'experiments', 'bench', 'receipt', 'proof', 'openclaw', 'pull', 'push', 'live', 'align', 'terminal', 'computer', 'diff', 'business', 'sync', 'youtube',
                       'ingest', 'query', 'lint', 'loop', 'pulse', 'task', 'mission', 'agents', 'probe', 'worktree', 'land', 'autoland', 'drive', 'aeo', 'slop', 'strings', 'write', 'security-review', 'secure', 'deck', 'site', 'theme', 'card', 'reel', 'improve', 'study', 'rainmaker', 'xp', 'play', 'gm', 'x', 'recap', 'report', 'signup', 'clarity', 'interview', 'moves', 'unknowns',
                       'github', 'vercel', 'supabase', 'linear', 'stripe', 'gmail', 'calendar', 'twitter', 'slack', 'imessage', 'integrations', 'setup', 'clean-workspace', 'cw',
                       'fork', 'browse', 'publish', 'sleep', 'wake', 'feedback', 'errors', 'wiki', 'code-review', 'cr', 'soul', 'fleet', 'loops', 'compile', 'spaceship', 'truth', 'sign', 'engine', 'engines', 'feed', 'brief'];

// Check if command is an atris.md spec file - triggers welcome visualization
function isSpecFile(cmd) {
  if (!cmd) return false;
  return cmd === 'atris.md' || cmd.endsWith('/atris.md') || cmd.endsWith('\\atris.md');
}

if (isSpecFile(command)) {
  showWelcomeVisualization();
  process.exit(0);
}

// --version flag (works anywhere: atris --version, atris -v)
if (command === '--version' || command === '-v' || process.argv.includes('--version')) {
  console.log(`atris v${CLI_VERSION}`);
  process.exit(0);
}

// If no command OR command is not recognized, treat as natural language
// Voice-friendly aliases — natural language → command mapping
// Solves speech-to-text issues (inspired by gstack v0.14.6 voice-triggers)
const START_MISSION_OBJECTIVE = 'self improve goal after goal: pick one useful bounded mission from current Atris state, run proof, and continue only with real next work';

const voiceTriggers = {
  'start': '_start',
  'start now': '_start',
  'go': '_start',
  'keep going': '_start',
  'keepgoing': '_start',
  'keep-going': '_start',
  'review my code': 'code-review',
  'check my code': 'code-review',
  'run a review': 'code-review',
  'audit': 'code-review',
  'create a business': 'business',
  'start a business': 'business',
  'new business': 'business',
  'show status': 'status',
  'what happened': 'radar',
  'whats going on': 'radar',
  'what is going on': 'radar',
  'run tests': 'verify',
  'check health': 'status',
  'deploy': 'business',
  'show my businesses': 'business',
  'pull latest': 'pull',
  'push changes': 'push',
  'show learnings': 'learn',
  'what did i learn': 'learn',
};

if (!command || !knownCommands.includes(command)) {
  // Check voice triggers before falling through to natural language
  const fullInput = process.argv.slice(2).join(' ').toLowerCase().trim();
  const fullInputWithoutFlags = process.argv.slice(2)
    .filter((arg, index, args) => !String(arg).startsWith('-') && !isOptionValue(args, index, RUNNER_FLAG_NAMES))
    .join(' ')
    .toLowerCase()
    .trim();
  const triggered = voiceTriggers[fullInput] || voiceTriggers[fullInputWithoutFlags];
  if (triggered) {
    command = triggered;
    // Re-check — if it's now a known command, fall through to dispatch
    if (knownCommands.includes(command)) {
      // Rewrite argv so dispatch works
      process.argv[2] = command;
      // Don't return — let it fall through to the command dispatch below
    }
  }
}

if (!command || !knownCommands.includes(command)) {
  const userInput = process.argv.slice(2).join(' ');

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({
      ok: false,
      error: command ? `unknown command: ${command}` : 'unknown command',
      command: command || null,
      input: userInput,
      usage: 'atris help',
    }, null, 2));
    process.exit(2);
  }

  // Warn if this looks like a mistyped single-word command (no spaces)
  if (command && !userInput.includes(' ')) {
    console.log(`⚠ Unknown command: "${command}". Run "atris help" for available commands.`);
    console.log('  Treating as natural language input...\n');
  }

  // Launch interactive entry (the "Performance")
  interactiveEntry(userInput)
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(`✗ Error: ${error.message || error}`);
      process.exit(1);
    });
  return;
}

function printAtrisOverview() {
  console.log('');
  console.log('Atris is an AI computer for a workspace.');
  console.log('It keeps project context, tasks, memory, tools, and proof in one loop: plan -> do -> review.');
  console.log('Run `atris` to load the current workspace, or `atris help` to see commands.');
  console.log('');
}

function useInteractiveAtrisUi() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY && !process.env.ATRIS_NO_INTERACTIVE);
}

function initNonInteractiveFlag() {
  const args = process.argv.slice(2);
  return args.includes('--yes') || args.includes('-y');
}

function shouldSkipContextGatherer() {
  return !useInteractiveAtrisUi() || initNonInteractiveFlag();
}

function firstUseCommand() {
  return 'atris "help me choose the first useful step for this project"';
}

function firstMissionObjective() {
  return 'Create FIRST_PROOF.md in this project';
}

function localOwnerName() {
  return process.env.USER || os.userInfo?.().username || 'operator';
}

function firstMissionOwner(root = process.cwd()) {
  const defaultOwner = path.join(root, 'atris', 'team', 'executor', 'MEMBER.md');
  return fs.existsSync(defaultOwner) ? 'executor' : localOwnerName();
}

function firstMissionCommand() {
  return `atris mission start "${firstMissionObjective()}" --owner ${firstMissionOwner()} --runner manual --lane code --verify "test -f FIRST_PROOF.md" --stop "FIRST_PROOF.md exists"`;
}

function printFirstUseNext() {
  console.log(`Next: ${firstMissionCommand()}`);
  console.log(`Then: ${firstUseCommand()}`);
}

function printStarterTaskNext(starter) {
  console.log('NEXT SETUP STEP: open atris/MAP.md, then claim the starter task.');
  if (starter && starter.display_id) {
    console.log(`Next: atris task claim ${starter.display_id} --as ${localOwnerName()}`);
    console.log(`Mission: ${firstMissionCommand()}`);
    return;
  }
  console.log('Next: atris task next --as ' + localOwnerName());
  console.log(`Mission: ${firstMissionCommand()}`);
}

async function interactiveEntry(userInput) {
  const workspaceDir = process.cwd();
  const state = detectWorkspaceState(workspaceDir);
  const context = loadContext(workspaceDir);

  if (isAtrisMetaQuestion(userInput)) {
    printAtrisOverview();
    return;
  }

  // Fresh install - offer init
  if (state.state === 'fresh') {
    console.log('\nNo atris/ folder found.');
    console.log('');
    console.log('Start here:');
    console.log('  atris init       if Atris is installed globally');
    console.log('  npx atris init   if Atris was installed in this project');
    return;
  }

  // Ensure today's journal exists (so "atris" always has somewhere to write/read)
  try {
    ensureLogDirectory();
    const { logFile, dateFormatted } = getLogPath();
    if (!fs.existsSync(logFile)) {
      createLogFile(logFile, dateFormatted);
    }
  } catch {
    // Non-fatal; continue
  }

  const inboxCount = typeof context.inboxCount === 'number' ? context.inboxCount : (context.inboxItems || []).length;
  const backlogCount = Array.isArray(context.backlogTasks) ? context.backlogTasks.length : 0;
  const inProgressTasksCount = Array.isArray(context.inProgressTasks) ? context.inProgressTasks.length : 0;
  const completedTasksCount = Array.isArray(context.completedTasks) ? context.completedTasks.length : 0;
  const inProgressFeaturesCount = typeof context.inProgressFeaturesCount === 'number'
    ? context.inProgressFeaturesCount
    : (context.inProgressFeatures || []).length;

  // Pull active missions (durable goals) — these outrank dev-pipeline state
  // because a mission with an unverified verifier is a Keshav-attributable
  // commitment that hasn't been closed yet.
  const activeMissions = loadActiveMissions(workspaceDir);
  const liveMissionsCount = activeMissions.length;
  // Mission needs a tick when: it has a verifier configured AND that verifier
  // hasn't passed yet. Planning-state missions count too — first tick is what
  // moves them to running.
  const needsTickMission = activeMissions.find(
    (m) => m.verifier && !m.verifier_passed
  );

  // Build status line
  const parts = [];
  const wipCount = inProgressTasksCount + inProgressFeaturesCount;
  if (wipCount > 0) {
    parts.push(`WIP: ${wipCount}`);
  }
  if (liveMissionsCount > 0) {
    parts.push(`Missions: ${liveMissionsCount}`);
  }
  if (inboxCount > 0) {
    parts.push(`Inbox: ${inboxCount}`);
  }
  if (backlogCount > 0) {
    parts.push(`Backlog: ${backlogCount}`);
  }
  if (completedTasksCount > 0) {
    parts.push(`Done: ${completedTasksCount}`);
  }
  const statusLine = parts.length > 0 ? parts.join('  |  ') : 'Clean slate';

  console.log('');
  console.log('┌─────────────────────────────────────────────────────────────┐');
  console.log('│ CONTEXT LOADED                                              │');
  console.log('├─────────────────────────────────────────────────────────────┤');
  console.log(`│ ${statusLine.padEnd(60)}│`);
  console.log('└─────────────────────────────────────────────────────────────┘');

  const mapStatus = context.mapStatus || (context.mapExists ? 'ready' : 'missing');
  if (shouldGatherContext({
    root: workspaceDir,
    userInput,
    mapStatus,
    liveMissionsCount,
    wipCount,
    backlogCount,
    inboxCount,
  })) {
    const hotAnswer = String(userInput || '').trim();
    if (hotAnswer) {
      const answer = hotAnswer;
      if (isAtrisMetaQuestion(answer)) {
        printAtrisOverview();
        return;
      }
      const profile = saveContextProfile(workspaceDir, answer, { source: 'hot_start' });
      const starter = createStarterTask(workspaceDir, answer);
      console.log('');
      console.log('Got it. I saved your first direction.');
      console.log(`Focus: ${profile.first_answer}`);
      if (starter && starter.display_id) {
        console.log(`First task: ${starter.display_id} — ${starter.title}`);
      } else if (starter && starter.title) {
        console.log(`First task: ${starter.title}`);
      }
      if (mapStatus !== 'ready') {
        printStarterTaskNext(starter);
        return;
      }
      await planCmd(answer);
      return;
    }
    if (shouldSkipContextGatherer()) {
      console.log('');
      console.log('context gatherer skipped (non-interactive).');
      printFirstUseNext();
      return;
    } else {
      const answer = await askContextGatherer(workspaceDir);
      if (isAtrisMetaQuestion(answer)) {
        printAtrisOverview();
        return;
      }
      if (!answer.trim()) {
        console.log('');
        console.log('No problem. When you are ready, answer in normal words.');
        console.log('Example: "help me organize college applications" or "help me build a small website".');
        return;
      }
      const profile = saveContextProfile(workspaceDir, answer, { source: 'cold_start' });
      const starter = createStarterTask(workspaceDir, answer);
      console.log('');
      console.log('Got it. I saved your first direction.');
      console.log(`Focus: ${profile.first_answer}`);
      if (starter && starter.display_id) {
        console.log(`First task: ${starter.display_id} — ${starter.title}`);
      } else if (starter && starter.title) {
        console.log(`First task: ${starter.title}`);
      }
      if (mapStatus !== 'ready') {
        printStarterTaskNext(starter);
        return;
      }
      await planCmd(answer);
      return;
    }
  }

  if (mapStatus !== 'ready') {
    printMapBootstrap({ userInput });
    return;
  }

  // Hot start - user provided input directly
  if (userInput) {
    console.log(`\n> ${userInput}`);
    await planCmd(userInput);
    return;
  }

  // Surface live missions so the operator sees durable goals alongside dev WIP.
  if (liveMissionsCount > 0) {
    console.log('\nLive missions:');
    for (const m of activeMissions.slice(0, 5)) {
      const tickGate = m.verifier && !m.verifier_passed ? ' [needs tick]' : '';
      const obj = m.objective.length > 70 ? `${m.objective.slice(0, 67)}...` : m.objective;
      console.log(`- [${m.owner}] ${obj} (${m.status})${tickGate}`);
    }
  }

  // Cold start auto-advance.
  // ORDER MATTERS: missions outrank pipeline state because a mission's verifier
  // is the contract that gates the Stop hook. Closing it unblocks everything else.
  if (needsTickMission) {
    console.log(`\nNext: atris mission tick (${needsTickMission.owner} mission has unverified verifier)`);
    console.log(`Run: atris mission tick ${needsTickMission.id} --verify --complete-on-pass`);
    return;
  }

  if (completedTasksCount > 0) {
    const preview = context.completedTasks.slice(0, 3).map((t) => (t.length > 70 ? `${t.slice(0, 67)}...` : t));
    if (preview.length > 0) {
      console.log('\nCompleted (history):');
      preview.forEach((t) => console.log(`- ${t}`));
      console.log('Completed tasks are history, not pending review.');
    }
  }

  if (wipCount > 0 || backlogCount > 0) {
    const featurePreview = Array.isArray(context.inProgressFeatures) ? context.inProgressFeatures : [];
    const inProgressPreview = context.inProgressTasks.slice(0, 2).map((t) => (t.length > 70 ? `${t.slice(0, 67)}...` : t));
    const backlogPreview = context.backlogTasks.slice(0, 2).map((t) => (t.length > 70 ? `${t.slice(0, 67)}...` : t));
    if (featurePreview.length > 0) {
      console.log(`\nIn-progress features: ${featurePreview.join(', ')}`);
    }
    if (inProgressPreview.length > 0) {
      console.log('\nIn Progress (preview):');
      inProgressPreview.forEach((t) => console.log(`- ${t}`));
    }
    if (backlogPreview.length > 0) {
      console.log('\nBacklog (preview):');
      backlogPreview.forEach((t) => console.log(`- ${t}`));
    }
    console.log('\nNext: atris do (work ready to execute)');
    await doCmd();
    return;
  }

  if (inboxCount > 0) {
    const preview = context.inboxItems.slice(0, 3).map((t) => (t.length > 70 ? `${t.slice(0, 67)}...` : t));
    if (preview.length > 0) {
      console.log('\nInbox (preview):');
      preview.forEach((t) => console.log(`- ${t}`));
    }
    console.log('\nNext: atris plan (Inbox has ideas)');
    await planCmd();
    return;
  }

  if (completedTasksCount > 0) {
    console.log('Next: atris plan (new work)');
    return;
  }

  // No obvious next step - prompt for input
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const request = await new Promise(r => rl.question('\nWhat do you want to build?\n> ', r));
  rl.close();

  if (!request.trim()) {
    return;
  }

  await planCmd(request);
}

async function askContextGatherer(workspaceDir) {
  console.log(renderContextGathererPrompt({ projectName: path.basename(workspaceDir) }));
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  const answer = await new Promise(r => rl.question('> ', r));
  rl.close();
  return answer;
}

function printMapBootstrap({ userInput, prefix = 'Bootstrap required' } = {}) {
  console.log('');
  console.log('┌─────────────────────────────────────────────────────────────┐');
  console.log(`│ ${String(prefix).toUpperCase().padEnd(60)}│`);
  console.log('└─────────────────────────────────────────────────────────────┘');
  console.log('');
  console.log('Atris needs a real `atris/MAP.md` so future steps are grounded in the workspace.');
  console.log('');
  console.log('For an agent:');
  console.log('─────────────────────────────────────────────────────────────');
  console.log('Read `atris/atris.md`, then generate a complete `atris/MAP.md` for this repo.');
  console.log('Rules: include file:line refs, keep it grep-friendly, do NOT change code.');
  if (userInput) {
    console.log('');
    console.log('After MAP is generated, continue with:');
    console.log(`- ${userInput}`);
  } else {
    console.log('');
    console.log('Then rerun: atris');
  }
  console.log('─────────────────────────────────────────────────────────────');
  console.log('');
}

// ASCII Welcome Visualization
function showWelcomeVisualization() {
  const { getTaskCounts } = require('../lib/state-detection');
  const { readEndgameState } = require('../commands/autopilot');
  const cwd = process.cwd();
  const atrisDir = path.join(cwd, 'atris');
  const projectName = path.basename(cwd);

  // Gather workspace stats
  let filesIndexed = 0;
  let tasksInBacklog = 0;
  let tasksInProgress = 0;
  let tasksInReview = 0;
  let tasksCertified = 0;
  let journalEntries = 0;
  let hasMap = false;
  let isInitialized = fs.existsSync(atrisDir);
  let endgameState = { slug: 'unset', horizon: '' };

  if (isInitialized) {
    // Check MAP.md
    const mapPath = path.join(atrisDir, 'MAP.md');
    if (fs.existsSync(mapPath)) {
      hasMap = true;
      const mapContent = fs.readFileSync(mapPath, 'utf8');
      // Count file references (lines with file paths)
      const fileRefs = mapContent.match(/`[^`]+\.(js|ts|py|go|rs|md|json|yaml|yml)`/g);
      filesIndexed = fileRefs ? fileRefs.length : 0;
    }

    // Task lane counts — DB truth first, TODO.md parse as fallback
    try {
      const counts = getTaskCounts(atrisDir);
      tasksInBacklog = counts.backlog;
      tasksInProgress = counts.active;
      tasksInReview = counts.review;
      tasksCertified = counts.reviewCertified;
    } catch {
      // Silently fail - show 0 tasks if reading fails
    }

    // Read endgame state
    try {
      endgameState = readEndgameState(cwd);
    } catch {
      // Silently fail - show unset if reading fails
    }

    // Count journal entries today
    const today = new Date();
    const year = today.getFullYear();
    const dateStr = today.toISOString().split('T')[0];
    const journalPath = path.join(atrisDir, 'logs', String(year), `${dateStr}.md`);
    if (fs.existsSync(journalPath)) {
      const journalContent = fs.readFileSync(journalPath, 'utf8');
      const inboxItems = journalContent.match(/- \*\*I\d+:/g);
      const completedItems = journalContent.match(/- \*\*C\d+:/g);
      journalEntries = (inboxItems ? inboxItems.length : 0) + (completedItems ? completedItems.length : 0);
    }
  }

  console.log('');
  console.log('    ╭──────────────────────────────────────────╮');
  console.log('    │                                          │');
  console.log('    │      █████╗ ████████╗██████╗ ██╗███████╗ │');
  console.log('    │     ██╔══██╗╚══██╔══╝██╔══██╗██║██╔════╝ │');
  console.log('    │     ███████║   ██║   ██████╔╝██║███████╗ │');
  console.log('    │     ██╔══██║   ██║   ██╔══██╗██║╚════██║ │');
  console.log('    │     ██║  ██║   ██║   ██║  ██║██║███████║ │');
  console.log('    │     ╚═╝  ╚═╝   ╚═╝   ╚═╝  ╚═╝╚═╝╚══════╝ │');
  console.log('    │                                          │');
  console.log('    ╰──────────────────────────────────────────╯');
  console.log('');

  if (!isInitialized) {
    console.log('    ⚡ Spec detected. No workspace found.');
    console.log('');
    console.log('    ┌─ READY TO INITIALIZE ────────────────────┐');
    console.log('    │                                          │');
    console.log(`    │   📍 Project: ${projectName.substring(0, 25).padEnd(25)}│`);
    console.log(`    │   📄 Spec:    atris.md v${CLI_VERSION.padEnd(18)}│`);
    console.log('    │                                          │');
    console.log('    │   Run "atris init" to create workspace   │');
    console.log('    │                                          │');
    console.log('    └──────────────────────────────────────────┘');
  } else {
    console.log('    ⚡ Scanning spec...');
    console.log('');
    console.log('    ┌─ WORKSPACE DETECTED ─────────────────────┐');
    console.log('    │                                          │');
    console.log(`    │   📍 Project: ${projectName.substring(0, 25).padEnd(25)}│`);
    console.log(`    │   📄 Spec:    atris.md v${CLI_VERSION.padEnd(18)}│`);
    console.log(`    │   🗺️  Map:    ${hasMap ? (filesIndexed + ' files indexed').padEnd(26) : 'not generated yet'.padEnd(26)}│`);
    console.log(`    │   📋 Tasks:   ${(tasksInBacklog + ' backlog, ' + tasksInProgress + ' active').padEnd(26)}│`);
    if (tasksInReview > 0) {
      const reviewText = tasksCertified > 0
        ? `${tasksInReview} waiting (${tasksCertified} certified)`
        : `${tasksInReview} waiting`;
      console.log(`    │   ⏳ Review:  ${reviewText.padEnd(26)}│`);
    }
    let landInfo = null;
    try { landInfo = require('../commands/land').landSummary(process.cwd()); } catch (err) { landInfo = null; }
    if (landInfo && landInfo.branches > 0) {
      const landText = `${landInfo.branches} in the air, ${landInfo.due} overdue`;
      console.log(`    │   🛬 Land:    ${landText.padEnd(26)}│`);
    }
    let rotInfo = null;
    try {
      const { parseLessons } = require('../lib/memory-view');
      const resolved = path.resolve(cwd);
      const parent = path.dirname(resolved);
      const grandparent = path.dirname(parent);
      let worktreeDir;
      if (path.basename(grandparent) === '.agent-worktrees') {
        worktreeDir = parent;
      } else {
        worktreeDir = path.join(path.dirname(resolved), '.agent-worktrees', path.basename(resolved));
      }
      let worktrees = 0;
      if (fs.existsSync(worktreeDir)) {
        worktrees = fs.readdirSync(worktreeDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory()).length;
      }
      let lessonsText = '';
      try {
        lessonsText = fs.readFileSync(path.join(atrisDir, 'lessons.md'), 'utf8');
      } catch (err) {
        lessonsText = '';
      }
      // rot = fail lessons nobody has resolved. A `pass` lesson is knowledge
      // that worked — it has nothing to resolve and counting it guilt-trips
      // the operator with a number (600+) no one can ever drive to zero.
      const unresolvedLessons = parseLessons(lessonsText)
        .filter((lesson) => lesson.status === 'fail' && !lesson.resolved && !/\[resolved\]/i.test(lesson.text)).length;
      if (worktrees > 0 || unresolvedLessons > 0) {
        rotInfo = { worktrees, lessons: unresolvedLessons };
      }
    } catch (err) {
      rotInfo = null;
    }
    if (rotInfo) {
      const rotText = `${rotInfo.worktrees} stale worktree${rotInfo.worktrees === 1 ? '' : 's'}, ${rotInfo.lessons} unresolved lesson${rotInfo.lessons === 1 ? '' : 's'}`;
      console.log(`    │   🧹 rot:      ${rotText.padEnd(26)}│`);
    }
    console.log(`    │   📝 Journal: ${(journalEntries + ' entries today').padEnd(26)}│`);
    if (endgameState.slug !== 'unset' && endgameState.horizon) {
      const endgameLine = endgameState.slug + ' — ' + endgameState.horizon;
      const paddedEndgame = endgameLine.padEnd(26);
      console.log(`    │   🎯 Endgame: ${paddedEndgame}│`);
    }
    console.log('    │                                          │');
    console.log('    │   ┌──────────────────────────────────┐   │');
    console.log('    │   │  MAP.md ←──── YOU ARE HERE       │   │');
    console.log('    │   │     ↓                            │   │');
    const taskText = `${tasksInBacklog} task${tasksInBacklog === 1 ? '' : 's'} waiting`;
    console.log(`    │   │  TODO.md ←── ${taskText.padEnd(20)}│   │`);
    console.log('    │   │     ↓                            │   │');
    console.log('    │   │  navigator → executor → validator│   │');
    console.log('    │   └──────────────────────────────────┘   │');
    console.log('    │                                          │');
    console.log('    └──────────────────────────────────────────┘');
  }
  console.log('');
  if (tasksCertified > 0) {
    console.log(`    Ready. ${tasksCertified} certified await accept — run 'atris task reviews'.`);
  } else {
    let landHint = null;
    try { landHint = require('../commands/land').landSummary(process.cwd()); } catch (err) { landHint = null; }
    if (landHint && landHint.due > 0) {
      console.log(`    Ready. ${landHint.due} overdue in the landing — run 'atris land --reap'.`);
    } else {
      console.log(`    Ready. Run 'atris plan' to start.`);
    }
  }
  console.log('');
}

if (command === 'init') {
  // Help flag must short-circuit before initCmd() (which scaffolds files)
  // and before interactiveEntry (which loads workspace context).
  const initArg = process.argv[3];
  if (initArg === '-h' || initArg === '--help' || initArg === 'help') {
    initCmd();
    process.exit(0);
  }
  initCmd();
  // Flow directly into interactive prompt
  interactiveEntry()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(`✗ Error: ${error.message || error}`);
      process.exit(1);
    });
} else if (command === '_start') {
  const args = process.argv.slice(3);
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    console.log('');
    console.log('Usage: atris start [options]');
    console.log('');
    console.log('Starts the durable mission loop for one useful self-improvement mission.');
    console.log('');
    console.log('Options:');
    console.log('  --json       Print the mission route without starting it.');
    console.log('  --owner X    Override mission owner.');
    console.log('  --cadence X  Override mission cadence.');
    console.log('');
    process.exit(0);
  }

  if (args.includes('--json')) {
    console.log(JSON.stringify({
      ok: true,
      action: 'start_mission_run',
      route: `atris mission run "${START_MISSION_OBJECTIVE}"`,
      reason: 'casual_launch',
      objective: START_MISSION_OBJECTIVE,
      expected_loop: 'mission_run',
    }, null, 2));
    process.exit(0);
  }

  Promise.resolve(require('../commands/mission').missionCommand(['run', START_MISSION_OBJECTIVE, ...args]))
    .then(() => process.exit(process.exitCode || 0))
    .catch((error) => {
      console.error(`✗ Start failed: ${error.message || error}`);
      process.exit(1);
    });
} else if (command === 'task') {
  // SQLite-backed task plane. ~/.atris/tasks.db, gitignored, per-workspace.
  Promise.resolve(require('../commands/task').run(process.argv.slice(3)))
    .then(() => process.exit(0))
    .catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'wish') {
  Promise.resolve(require('../commands/wish').wishCommand(process.argv.slice(3)))
    .then((code) => process.exit(code || 0))
    .catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'drill') {
  Promise.resolve(require('../commands/drill').drillCommand(process.argv.slice(3)))
    .then((code) => process.exit(code || 0))
    .catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'bench') {
  Promise.resolve(require('../commands/bench').benchCommand(process.argv.slice(3)))
    .then((code) => process.exit(code || 0))
    .catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(2); });
} else if (command === 'mission') {
  Promise.resolve(require('../commands/mission').missionCommand(process.argv.slice(3)))
    .then(() => process.exit(process.exitCode || 0))
    .catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'agents') {
  // Glanceable view of every member's state: stuck, waiting on you, working, resting.
  const code = require('../commands/agents').agentsCommand(process.argv.slice(3));
  process.exit(code || 0);
} else if (command === 'pulse') {
  // Pulse: durable overnight self-improvement heartbeat (OS cron) for atris-cli.
  Promise.resolve(require('../commands/pulse').pulseCommand(process.argv.slice(3)))
    .then((res) => process.exit(res && res.ok === false ? 1 : 0))
    .catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'probe') {
  // Chat-lane probe (TRR-22): one real /atris2/turn over the full tool relay.
  Promise.resolve(require('../commands/probe').probeCommand(process.argv.slice(3)))
    .then((code) => process.exit(code || 0))
    .catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'worktree') {
  Promise.resolve(require('../commands/worktree').worktreeCommand(process.argv.slice(3)))
    .then((code) => process.exit(code || 0))
    .catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'autoland') {
  Promise.resolve(require('../commands/autoland').autolandCommand(process.argv.slice(3)))
    .then((code) => process.exit(code || 0))
    .catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'land') {
  Promise.resolve(require('../commands/land').landCommand(process.argv.slice(3)))
    .then((code) => process.exit(code || 0))
    .catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'drive') {
  // Drive: one self-driving tick — mission doctor -> auto-fix safe findings -> count disengagements.
  Promise.resolve(require('../commands/drive').driveCommand(process.argv.slice(3)))
    .then((code) => process.exit(code || 0))
    .catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'radar' || command === 'ctop') {
  const radarArgs = command === 'ctop' ? ['--agents', ...process.argv.slice(3)] : process.argv.slice(3);
  Promise.resolve(require('../commands/radar').radarCommand(radarArgs))
    .then((code) => process.exit(code || 0))
    .catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'stream') {
  Promise.resolve(require('../commands/stream').streamCommand(process.argv.slice(3)))
    .then((code) => process.exit(code || 0))
    .catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'truth') {
  // Truth: one table rolling up mission state, tasks, feature proof receipts, and loop heartbeats.
  Promise.resolve(require('../commands/truth').truthCommand(process.argv.slice(3)))
    .then((code) => process.exit(code || 0))
    .catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'codex-goal') {
  Promise.resolve(require('../commands/codex-goal').codexGoalCommand(process.argv.slice(3)))
    .then(() => process.exit(process.exitCode || 0))
    .catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'aeo') {
  // AEO: AI Engine Optimization — credit-metered citation drafting against the customer workspace.
  Promise.resolve(require('../commands/aeo').run(process.argv.slice(3)))
    .then(() => process.exit(0))
    .catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'improve') {
  // Improve: one paid RL tick via POST /api/improve (deducts credits), local autopilot fallback.
  Promise.resolve(require('../commands/improve').run(process.argv.slice(3)))
    .then((code) => process.exit(typeof code === 'number' ? code : 0))
    .catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'study') {
  // Study: on-demand learning feed ingest + local server + browser open.
  Promise.resolve(require('../commands/study').run(process.argv.slice(3)))
    .then((code) => process.exit(typeof code === 'number' ? code : 0))
    .catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'rainmaker') {
  const code = require('../commands/rainmaker').rainmakerCommand(process.argv.slice(3));
  process.exit(typeof code === 'number' ? code : 0);
} else if (command === 'brain') {
  Promise.resolve()
    .then(() => require('../commands/brain').brainCommand(process.argv.slice(3)))
    .then(() => process.exit(0))
    .catch((err) => {
      const message = err.message || String(err);
      if (process.argv.slice(3).includes('--json')) {
        console.log(JSON.stringify({ ok: false, error: message }, null, 2));
      } else {
        console.error(`\n✗ Error: ${message}`);
      }
      process.exit(1);
    });
} else if (command === 'agent') {
  agentAtris().then(() => process.exit(0)).catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'log') {
  const subcommand = process.argv[3];
  if (subcommand === 'sync') {
    require('../commands/log-sync').logSyncAtris()
      .then(() => process.exit(0))
      .catch((error) => {
        console.error(`✗ Log sync failed: ${error.message || error}`);
        process.exit(1);
      });
  } else if (subcommand === '--help' || subcommand === '-h' || subcommand === 'help') {
    console.log('Usage: atris log [business-slug | sync | help]');
    console.log('');
    console.log('  atris log                Open today\'s journal REPL (write to ## Inbox)');
    console.log('  atris log <slug>         Show business log history');
    console.log('  atris log sync           Sync the local journal to cloud');
    process.exit(0);
  } else if (subcommand && !subcommand.startsWith('-')) {
    // Business log: atris log <business-slug>
    require('../commands/context-sync').businessLog(subcommand)
      .then(() => process.exit(0))
      .catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); });
  } else {
    logCmd();
  }
} else if (command === 'now') {
  const args = process.argv.slice(3);
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    require('../commands/now').nowAtris(args);
    process.exit(0);
  }
  require('../commands/now').nowAtris(args);
} else if (command === 'recap') {
  require('../commands/recap').recapAtris(process.argv.slice(3));
} else if (command === 'activate') {
  const args = process.argv.slice(3);
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    showActivateHelp();
    process.exit(0);
  }
  activateCmd();
} else if (command === 'update' || command === 'sync') {
  const args = process.argv.slice(3);
  const firstSyncArg = process.argv[3];
  const isBusinessSync = command === 'sync'
    && (
      fs.existsSync(path.join(process.cwd(), '.atris', 'business.json'))
      || isBusinessSyncSafetyCommand
      || (firstSyncArg && !firstSyncArg.startsWith('-'))
    )
    && firstSyncArg !== 'all';
  if ((args.includes('--help') || args.includes('-h') || args[0] === 'help') && !isBusinessSync) {
    showUpdateHelp(command);
    process.exit(0);
  }
  if (command === 'update' && args.includes('--self')) {
    const { updateSelf } = require('../commands/update');
    const result = updateSelf({ packageRoot: path.join(__dirname, '..') });
    process.exit(result.ok ? 0 : 1);
  }
  if (isBusinessSync) {
    Promise.resolve(require('../commands/business-sync').businessSync(process.argv.slice(3)))
      .then(() => process.exit(0))
      .catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); });
  } else if (process.argv.includes('--all')) {
    const dryRun = process.argv.includes('--dry-run');
    const force = process.argv.includes('--force') || process.argv.includes('--yes') || process.argv.includes('-y');
    Promise.resolve(syncAllCmd({ dryRun, force }))
      .then(() => process.exit(0))
      .catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); });
  } else {
    syncCmd();
  }
} else if (command === 'upgrade') {
  const args = process.argv.slice(3);
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    showUpgradeHelp();
    process.exit(0);
  }
  upgradeAtris().then(() => process.exit(0)).catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'chat') {
  if (process.argv[3] === 'scan') {
    try {
      require('../commands/chat-scan').chatScanCommand(process.argv.slice(4));
      process.exit(0);
    } catch (error) {
      console.error(`✗ Chat scan failed: ${error.message || error}`);
      process.exit(1);
    }
  }
  chatAtris()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(`✗ Chat failed: ${error.message || error}`);
      process.exit(1);
    });
} else if (command === 'fast' || command === 'ax') {
  atrisFastChat()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(`✗ Fast chat failed: ${error.message || error}`);
      process.exit(1);
    });
} else if (command === 'console') {
  consoleCmd();
} else if (command === 'serve') {
  // Start the local AI Computer bridge — make this directory addressable
  // by cloud agents via the Atris API
  const serveArgs = process.argv.slice(3);
  if (serveArgs.includes('--help') || serveArgs.includes('-h') || serveArgs[0] === 'help') {
    showServeHelp();
    process.exit(0);
  }
  const serveOptions = {};
  for (let i = 0; i < serveArgs.length; i++) {
    if (serveArgs[i] === '--agent' && serveArgs[i + 1]) {
      serveOptions.agent = serveArgs[i + 1];
      i++;
    } else if (serveArgs[i] === '--allow-bash') {
      serveOptions.allowBash = true;
    }
  }
  require('../commands/serve').serveAtris(serveOptions)
    .catch((err) => {
      console.error(`✗ atris serve failed: ${err.message}`);
      process.exit(1);
    });
} else if (command === 'version') {
  require('../commands/version').showVersion();
} else if (command === 'login') {
  const args = process.argv.slice(3);
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    showAuthHelp('login');
    process.exit(0);
  }
  require('../commands/auth').loginAtris();
} else if (command === 'logout') {
  const args = process.argv.slice(3);
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    showAuthHelp('logout');
    process.exit(0);
  }
  require('../commands/auth').logoutAtris();
} else if (command === 'whoami') {
  const args = process.argv.slice(3);
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    showAuthHelp('whoami');
    process.exit(0);
  }
  require('../commands/auth').whoamiAtris();
} else if (command === 'switch') {
  const args = process.argv.slice(3);
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    showAuthHelp('switch');
    process.exit(0);
  }
  require('../commands/auth').switchAccount();
} else if (command === 'use') {
  const args = process.argv.slice(3);
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    showAuthHelp('use');
    process.exit(0);
  }
  require('../commands/auth').useAccount();
} else if (command === 'accounts') {
  const args = process.argv.slice(3);
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    showAuthHelp('accounts');
    process.exit(0);
  }
  require('../commands/auth').accountsCmd();
} else if (command === '_resolve') {
  // Hidden: resolve a profile name query → print exact profile name
  require('../commands/auth').resolveProfile();
} else if (command === '_profile-email') {
  // Hidden: print email for a profile name
  require('../commands/auth').profileEmail();
} else if (command === '_activate') {
  // Hidden: copy profile to credentials.json (global switch, legacy)
  require('../commands/auth').activateGlobal();
} else if (command === '_switch-session') {
  // Hidden: per-terminal switch — writes session file so each tab keeps its own account
  require('../commands/auth').switchSession();
} else if (command === 'shell-init') {
  require('../commands/auth').shellInit();
} else if (command === 'visualize') {
  require('../commands/visualize').visualizeAtris(process.argv.slice(3))
    .then(() => process.exit(0))
    .catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'youtube') {
  require('../commands/youtube').youtubeCommand(process.argv.slice(3))
    .then(() => process.exit(0))
    .catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'run') {
  const args = process.argv.slice(3);
  if (args[0] === 'logs') {
    // Subcommand: atris run logs [--tail N] [--cat FILE] [--json]
    const { listRunLogs } = require('../commands/run');
    const logsArgs = args.slice(1);
    if (logsArgs.includes('--help') || logsArgs.includes('-h')) {
      console.log('');
      console.log('Usage: atris run logs [options]');
      console.log('');
      console.log('List and read glass run logs from atris/logs/runs/.');
      console.log('');
      console.log('Options:');
      console.log('  --tail N      Show last N lines of each log (default: 5)');
      console.log('  --cat FILE    Print full contents of a specific log file');
      console.log('  --json        Output machine-readable JSON');
      console.log('  --help        Show this help');
      console.log('');
      process.exit(0);
    }
    listRunLogs(logsArgs);
    process.exit(0);
  }
  if (args[0] === 'prune-logs') {
    // Subcommand: atris run prune-logs [--keep N] [--dry-run]
    const { pruneRunLogs } = require('../commands/run');
    const pruneArgs = args.slice(1);
    if (pruneArgs.includes('--help') || pruneArgs.includes('-h')) {
      console.log('');
      console.log('Usage: atris run prune-logs [options]');
      console.log('');
      console.log('Prune old run logs, keeping only the most recent N files.');
      console.log('');
      console.log('Options:');
      console.log('  --keep N      Number of recent logs to keep (default: 50)');
      console.log('  --dry-run     Show what would be deleted without deleting');
      console.log('  --help        Show this help');
      console.log('');
      process.exit(0);
    }
    pruneRunLogs(pruneArgs);
    process.exit(0);
  }
  if (args[0] === 'search') {
    // Subcommand: atris run search <keyword> [--phase P] [--limit N]
    const { searchRunLogs } = require('../commands/run');
    const searchArgs = args.slice(1);
    if (searchArgs.includes('--help') || searchArgs.includes('-h') || searchArgs.length === 0) {
      console.log('');
      console.log('Usage: atris run search <keyword> [options]');
      console.log('');
      console.log('Search phase reasoning across all run logs.');
      console.log('');
      console.log('Options:');
      console.log('  --phase P     Limit search to a phase (plan, do, review, error)');
      console.log('  --limit N     Max results to show (default: 20)');
      console.log('  --help        Show this help');
      console.log('');
      process.exit(0);
    }
    searchRunLogs(searchArgs);
    process.exit(0);
  }
  if (args[0] === 'stats') {
    // Subcommand: atris run stats
    const { statsRunLogs } = require('../commands/run');
    statsRunLogs();
    process.exit(0);
  }
  if (args[0] === 'export') {
    // Subcommand: atris run export [--out FILE]
    const { exportRunLogs } = require('../commands/run');
    const exportArgs = args.slice(1);
    if (exportArgs.includes('--help') || exportArgs.includes('-h')) {
      console.log('');
      console.log('Usage: atris run export [options]');
      console.log('');
      console.log('Export all run logs as a JSON bundle for backup or transfer.');
      console.log('');
      console.log('Options:');
      console.log('  --out FILE    Write to a specific file (default: atris/logs/runs/export.json)');
      console.log('  --help        Show this help');
      console.log('');
      process.exit(0);
    }
    exportRunLogs(exportArgs);
    process.exit(0);
  }
  if (args[0] === 'diff') {
    // Subcommand: atris run diff <file1> <file2>
    const { diffRunLogs } = require('../commands/run');
    const diffArgs = args.slice(1);
    if (diffArgs.includes('--help') || diffArgs.includes('-h') || diffArgs.length === 0) {
      console.log('');
      console.log('Usage: atris run diff <file1> <file2>');
      console.log('');
      console.log('Compare two run logs side by side, showing phase-level differences.');
      console.log('');
      console.log('Options:');
      console.log('  --help        Show this help');
      console.log('');
      process.exit(0);
    }
    diffRunLogs(diffArgs);
    process.exit(0);
  }
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    console.log('');
    console.log('Usage: atris run ["objective"] [options]');
    console.log('');
    console.log('One bounded mission pursuit: start a mission from the objective');
    console.log('(or resume the most logical runnable mission), tick it through the');
    console.log('mission runtime, complete on pass, then exit.');
    console.log('For an ongoing loop, use: atris autopilot');
    console.log('');
    console.log('Options:');
    console.log('  --owner NAME      Mission owner (default: mission-lead)');
    console.log('  --minutes N | --hours N   Time budget for the pursuit');
    console.log('  --max-ticks N     Override the tick budget');
    console.log('  --max-wall N      Override the wall clock in seconds');
    console.log('  --cadence C       Mission cadence (e.g. 15m)');
    console.log('  --no-complete     Skip auto-complete after a passing run');
    console.log('  --legacy          Old plan→do→review loop (claude -p cycles)');
    console.log('');
    console.log('Legacy options (with --legacy):');
    console.log('  --cycles=N --once --verbose --dry-run --timeout=N --no-push');
    console.log('  --runner-bin PATH / --runner-template CMD / --runner-model MODEL');
    console.log(`  --runner-profile NAME   Runner profile for this run (one of: ${require('../lib/runner-command').RUNNER_PROFILE_NAMES.join(', ')})`);
    console.log('');
    console.log('Subcommands:');
    console.log('  atris run logs [--tail N] [--cat FILE] [--json]  Browse glass run logs');
    console.log('  atris run prune-logs [--keep N] [--dry-run]      Prune old run logs');
    console.log('  atris run search <keyword> [--phase P] [--limit N]  Search run logs');
    console.log('  atris run stats                                  Show run log stats');
    console.log('  atris run export [--out FILE]                    Export logs as JSON');
    console.log('  atris run diff <file1> <file2>                   Compare two run logs');
    console.log('');
    process.exit(0);
  }

  applyRunnerFlags(args);

  if (args.includes('--legacy')) {
    const legacyArgs = args.filter(a => a !== '--legacy');
    const verbose = legacyArgs.includes('--verbose') || legacyArgs.includes('-v');
    const dryRun = legacyArgs.includes('--dry-run');
    const once = legacyArgs.includes('--once');
    const push = !legacyArgs.includes('--no-push');
    const cyclesArg = legacyArgs.find(a => a.startsWith('--cycles='));
    const maxCycles = cyclesArg ? parseInt(cyclesArg.split('=')[1]) : 5;
    const timeoutArg = legacyArgs.find(a => a.startsWith('--timeout='));
    const timeout = timeoutArg ? parseInt(timeoutArg.split('=')[1]) * 1000 : undefined;

    require('../commands/run').runAtris({ maxCycles, verbose, dryRun, once, push, timeout })
      .then(() => process.exit(0))
      .catch((error) => {
        console.error(`\u2717 Run failed: ${error.message || error}`);
        process.exit(1);
      });
  } else {
    require('../commands/run-front').runMissionFront(args)
      .then((code) => process.exit(code || 0))
      .catch((error) => {
        console.error(`\u2717 Run failed: ${error.message || error}`);
        process.exit(1);
      });
  }
} else if (command === 'launchpad') {
  const code = require('../commands/launchpad').launchpadCommand(process.argv.slice(3));
  process.exit(code);
} else if (command === 'autopilot') {
  const args = process.argv.slice(3);
  applyRunnerFlags(args);

  if (args.includes('--legacy')) {
    const legacyArgs = args.filter(a => a !== '--legacy');
    if (legacyArgs.includes('--help') || legacyArgs.includes('-h') || legacyArgs[0] === 'help') {
      showAutopilotHelp();
      process.exit(0);
    }

    // Parse options
    const verbose = legacyArgs.includes('--verbose') || legacyArgs.includes('-v');
    const dryRun = legacyArgs.includes('--dry-run');
    const auto = legacyArgs.includes('--auto');
    const maxIterationsArg = legacyArgs.find(a => a.startsWith('--iterations='));
    const maxIterations = maxIterationsArg ? parseInt(maxIterationsArg.split('=')[1]) : undefined;
    const durationArg = legacyArgs.find(a => a.startsWith('--duration='));
    const duration = durationArg ? durationArg.split('=')[1] : null;

    // Get description (non-flag args)
    const description = legacyArgs.filter((a, i) => !a.startsWith('-') && !isOptionValue(legacyArgs, i, RUNNER_FLAG_NAMES)).join(' ').trim() || null;

    const options = {
      ...(maxIterations !== undefined && { maxIterations }),
      verbose,
      dryRun,
      auto,
      duration
    };

    require('../commands/autopilot').autopilotAtris(description, options)
      .then(() => process.exit(0))
      .catch((error) => {
        console.error(`✗ Autopilot failed: ${error.message || error}`);
        process.exit(1);
      });
  } else {
    Promise.resolve(require('../commands/autopilot-front').autopilotFront(args))
      .then((code) => process.exit(code || 0))
      .catch((error) => {
        console.error(`✗ Autopilot failed: ${error.message || error}`);
        process.exit(1);
      });
  }
} else if (command === 'brainstorm') {
  require('../commands/brainstorm').brainstormAtris()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(`✗ Brainstorm failed: ${error.message || error}`);
      process.exit(1);
    });
} else if (command === 'next') {
  Promise.resolve(require('../commands/next').nextCommand(process.argv.slice(3)))
    .then((code) => process.exit(typeof code === 'number' ? code : 0))
    .catch((error) => {
      console.error(`✗ Error: ${error.message || error}`);
      process.exit(1);
    });
} else if (command === 'dream') {
  Promise.resolve(require('../commands/dream').dreamCommand(process.argv.slice(3)))
    .then((code) => process.exit(typeof code === 'number' ? code : 0))
    .catch((error) => {
      console.log('No dreams tonight: could not finish dream');
      console.log('Run me nightly: atris dream');
      process.exit(0);
    });
} else if (command === 'atris') {
  const rawArgs = process.argv.slice(3);
  if (rawArgs.includes('--help') || rawArgs.includes('-h') || rawArgs[0] === 'help') {
    showNextHelp(command);
    process.exit(0);
  }
  const userInput = rawArgs.filter((arg) => !arg.startsWith('-')).join(' ').trim();
  interactiveEntry(userInput || null)
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(`✗ Error: ${error.message || error}`);
      process.exit(1);
    });
} else if (command === 'plan') {
  const args = process.argv.slice(3);
  if (args.includes('--help') || args.includes('-h')) {
    showPlanHelp();
    process.exit(0);
  }
  planCmd()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(`✗ Plan failed: ${error.message || error}`);
      process.exit(1);
    });
} else if (command === 'do') {
  const args = process.argv.slice(3);
  if (args.includes('--help') || args.includes('-h')) {
    showDoHelp();
    process.exit(0);
  }
  doCmd()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(`✗ Do failed: ${error.message || error}`);
      process.exit(1);
    });
} else if (command === 'review') {
  const args = process.argv.slice(3);
  if (args.includes('--help') || args.includes('-h')) {
    showReviewHelp();
    process.exit(0);
  }
  reviewCmd()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(`✗ Review failed: ${error.message || error}`);
      process.exit(1);
    });
} else if (command === 'status') {
  const args = process.argv.slice(3);
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    showStatusHelp();
    process.exit(0);
  }
  let subcommand = process.argv[3];
  if (subcommand && !subcommand.startsWith('-')) {
    require('../commands/context-sync').businessStatus(subcommand)
      .then(() => process.exit(0))
      .catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); });
  } else {
    const isQuick = process.argv.includes('--quick') || process.argv.includes('-q');
    const isJson = process.argv.includes('--json');
    const verbose = process.argv.includes('--verbose') || process.argv.includes('-v');
    statusCmd(isQuick, isJson, verbose);
  }
} else if (command === 'analytics') {
  const args = process.argv.slice(3);
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    showAnalyticsHelp();
    process.exit(0);
  }
  require('../commands/analytics').analyticsAtris();
} else if (command === 'clean') {
  const args = process.argv.slice(3);
  if (args.includes('--help') || args.includes('-h')) {
    showCleanHelp();
    process.exit(0);
  }
  const dryRun = process.argv.includes('--dry-run') || process.argv.includes('-n');
  const json = process.argv.includes('--json');
  require('../commands/clean').cleanAtris({ dryRun, json });
} else if (command === 'harvest') {
  Promise.resolve(require('../commands/harvest').harvestCommand(process.argv.slice(3)))
    .catch((err) => {
      console.error(err.message || err);
      process.exit(1);
    });
} else if (command === 'verify') {
  const args = process.argv.slice(3);
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    showVerifyHelp();
    process.exit(0);
  }
  const sectionIdx = process.argv.indexOf('--section');
  if (sectionIdx > 0 && process.argv[sectionIdx + 1]) {
    const slug = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : null;
    const section = process.argv[sectionIdx + 1];
    const code = require('../commands/verify').verifyRubric(slug, section);
    process.exit(code);
  }
  const taskId = process.argv[3] || null;
  require('../commands/verify').verifyAtris(taskId);
} else if (command === 'release') {
  const args = process.argv.slice(3);
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    showReleaseHelp();
    process.exit(0);
  }
  const dryRun = process.argv.includes('--dry-run');
  require('../commands/release').releaseAtris({ dryRun })
    .then(() => process.exit(0))
    .catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'search') {
  const code = require('../commands/search').searchCommand(process.argv.slice(3));
  process.exitCode = code;
} else if (command === 'scout') {
  require('../commands/scout').scoutCommand(process.argv.slice(3))
    .then((code) => { process.exitCode = code; })
    .catch((err) => { console.error(`✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'xp') {
  require('../commands/xp').xpCommand(...process.argv.slice(3))
    .then(() => { process.exitCode = 0; })
    .catch((err) => { console.error(`✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'report') {
  const args = process.argv.slice(3);
  const { reportCommand, showReportHelp } = require('../commands/report');
  if (args.includes('--help') || args.includes('-h')) {
    showReportHelp();
    process.exit(0);
  }
  process.exit(reportCommand(args));
} else if (command === 'play') {
  require('../commands/play').playCommand(...process.argv.slice(3))
    .then(() => process.exit(0))
    .catch((err) => { console.error(`✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'gm') {
  require('../commands/gm').gmCommand(...process.argv.slice(3))
    .then(() => process.exit(0))
    .catch((err) => { console.error(`✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'github') {
  const status = require('../commands/github').githubCommand(process.argv.slice(3));
  process.exit(status);
} else if (command === 'vercel') {
  const status = require('../commands/vercel').vercelCommand(process.argv.slice(3));
  process.exit(status);
} else if (command === 'supabase') {
  const status = require('../commands/supabase').supabaseCommand(process.argv.slice(3));
  process.exit(status);
} else if (command === 'linear') {
  const status = require('../commands/linear').linearCommand(process.argv.slice(3));
  process.exit(status);
} else if (command === 'stripe') {
  const status = require('../commands/stripe').stripeCommand(process.argv.slice(3));
  process.exit(status);
} else if (command === 'gmail') {
  const { gmailCommand } = require('../commands/integrations');
  const subcommand = process.argv[3];
  const args = process.argv.slice(4);
  gmailCommand(subcommand, ...args)
    .then(() => process.exit(0))
    .catch((err) => { console.error(`✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'calendar') {
  const { calendarCommand } = require('../commands/integrations');
  const subcommand = process.argv[3];
  const args = process.argv.slice(4);
  calendarCommand(subcommand, ...args)
    .then(() => process.exit(0))
    .catch((err) => { console.error(`✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'twitter') {
  const { twitterCommand } = require('../commands/integrations');
  const subcommand = process.argv[3];
  const args = process.argv.slice(4);
  twitterCommand(subcommand, ...args)
    .then(() => process.exit(0))
    .catch((err) => { console.error(`✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'slack') {
  const { slackCommand } = require('../commands/integrations');
  const subcommand = process.argv[3];
  const args = process.argv.slice(4);
  slackCommand(subcommand, ...args)
    .then(() => process.exit(0))
    .catch((err) => { console.error(`✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'imessage') {
  const { imessageCommand } = require('../commands/integrations');
  const subcommand = process.argv[3];
  const args = process.argv.slice(4);
  imessageCommand(subcommand, ...args)
    .then(() => process.exit(0))
    .catch((err) => { console.error(`✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'integrations') {
  const args = process.argv.slice(3);
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    showIntegrationsHelp();
    process.exit(0);
  }
  const { integrationsStatus } = require('../commands/integrations');
  integrationsStatus()
    .then(() => process.exit(0))
    .catch((err) => { console.error(`✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'apps') {
  // Keep APP.md app-pack operations independent from the heavier workspace boot
  // path so `atris apps --json` stays machine-readable for agents.
  const subcommand = process.argv[3];
  const args = process.argv.slice(4);
  Promise.resolve(require('../commands/apps').appsCommand(subcommand, ...args))
    .then(() => process.exit(0))
    .catch((err) => { console.error(`✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'learn') {
  const subcommand = process.argv[3];
  const args = process.argv.slice(4);
  require('../commands/learn')(subcommand, ...args);
} else if (command === 'lesson') {
  const subcommand = process.argv[3];
  const args = process.argv.slice(4);
  require('../commands/lesson')(subcommand, ...args);
} else if (command === 'skill') {
  const subcommand = process.argv[3];
  const args = process.argv.slice(4);
  require('../commands/skill').skillCommand(subcommand, ...args);
} else if (command === 'member') {
  const subcommand = process.argv[3];
  const args = process.argv.slice(4);
  Promise.resolve(require('../commands/member').memberCommand(subcommand, ...args))
    .then(() => process.exit(0))
    .catch((err) => { console.error(`✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'app') {
  const subcommand = process.argv[3];
  const args = process.argv.slice(4);
  require('../commands/app').appCommand(subcommand, ...args);
} else if (command === 'pull') {
  require('../commands/pull').pullAtris()
    .then(() => process.exit(0))
    .catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'push') {
  require('../commands/push').pushAtris()
    .then(() => process.exit(0))
    .catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'live') {
  require('../commands/live').liveCommand()
    .then(() => process.exit(0))
    .catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'align') {
  require('../commands/align').alignAtris()
    .then(() => process.exit(0))
    .catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'terminal') {
  require('../commands/terminal').terminalAtris()
    .then(() => process.exit(0))
    .catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'x') {
  // Fast Agent SDK execution - like "atris x echo hello" or "atris x ls -la"
  const userInput = process.argv.slice(3).join(' ').trim();
  if (!userInput) {
    console.log('Usage: atris x <command>');
    console.log('Example: atris x echo "hello world"');
    console.log('Example: atris x ls -la');
    process.exit(1);
  }
  require('../commands/workflow').executeAgentSDKFast(userInput);
} else if (command === 'computer') {
  require('../commands/computer').runComputer()
    .then(() => process.exit(process.exitCode || 0))
    .catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'diff') {
  let diffSlug = process.argv[3];
  if (diffSlug === '-h' || diffSlug === '--help') {
    console.log('Usage: atris diff [business] [path]');
    process.exit(0);
  }
  if (!diffSlug || diffSlug.startsWith('-')) {
    diffSlug = undefined;
    const bizFile = require('path').join(process.cwd(), '.atris', 'business.json');
    if (require('fs').existsSync(bizFile)) {
      try { diffSlug = JSON.parse(require('fs').readFileSync(bizFile, 'utf8')).slug; } catch {}
    }
  }
  if (!diffSlug) { console.error('Usage: atris diff [business] [path]'); process.exit(1); }
  require('../commands/context-sync').businessDiff(diffSlug)
    .then(() => process.exit(0))
    .catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'business') {
  const subcommand = process.argv[3];
  const args = process.argv.slice(4);
  require('../commands/business').businessCommand(subcommand, ...args)
    .then(() => process.exit(0))
    .catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'soul') {
  const args = process.argv.slice(3);
  require('../commands/soul').soul(args)
    .then(() => process.exit(0))
    .catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'fleet') {
  const args = process.argv.slice(3);
  require('../commands/fleet').fleet(args)
    .then(() => process.exit(0))
    .catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'loops') {
  try {
    require('../commands/loops').loopsCommand(process.argv[3], ...process.argv.slice(4));
    process.exit(0);
  } catch (error) {
    console.error(`\n✗ Error: ${error.message || error}`);
    process.exit(1);
  }
} else if (command === 'spaceship') {
  const args = process.argv.slice(3);
  require('../commands/spaceship').spaceship(args)
    .then(() => process.exit(0))
    .catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'code-review' || command === 'cr') {
  const args = process.argv.slice(3);
  require('../commands/review').reviewCommand(...args)
} else if (command === 'wiki') {
  const subcommand = process.argv[3];
  const args = process.argv.slice(4);
  require('../commands/wiki').wikiCommand(subcommand, ...args)
    .then(() => process.exit(0))
    .catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'ingest' || command === 'query' || command === 'lint') {
  const args = process.argv.slice(3);
  require('../commands/wiki').wikiCommand(command, ...args)
    .then(() => process.exit(0))
    .catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'loop') {
  const args = process.argv.slice(3);
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    showLoopHelp();
    process.exit(0);
  }
  Promise.resolve(require('../commands/loop-front').loopFront(args))
    .then((code) => process.exit(typeof code === 'number' ? code : 0))
    .catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'clean-workspace' || command === 'cw') {
  const { cleanWorkspace } = require('../commands/workspace-clean');
  cleanWorkspace()
    .then(() => process.exit(0))
    .catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'plugin') {
  const subcommand = process.argv[3] || 'build';
  const args = process.argv.slice(4);
  require('../commands/plugin').pluginCommand(subcommand, ...args);
} else if (command === 'experiments') {
  const subcommand = process.argv[3];
  const args = process.argv.slice(4);
  require('../commands/experiments').experimentsCommand(subcommand, ...args);
} else if (command === 'compile') {
  const subcommand = process.argv[3];
  const args = process.argv.slice(4);
  Promise.resolve(require('../commands/compile').compileCommand(subcommand, ...args))
    .then(() => process.exit(process.exitCode || 0))
    .catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'engine' || command === 'engines') {
  // Engine: bring any intelligence — roster of installed coding CLIs, default
  // engine per workspace, --engine <name> rides any loop for one run.
  // `engine dispatch` runs an async claim -> build -> ship flight, so the
  // return value may be a promise or a plain number; Promise.resolve handles
  // both (mirrors the `compile` command dispatch just above).
  const engineArgs = command === 'engines' && process.argv.length <= 3 ? [] : process.argv.slice(3);
  Promise.resolve(require('../commands/engine').engineCommand(engineArgs))
    .then((code) => process.exit(typeof code === 'number' ? code : 0))
    .catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'sign') {
  // Sign: prepare-commit-msg hook that credits Atris as co-author on commits in atris workspaces.
  try { process.exit(require('../commands/sign').signCommand(process.argv[3]) || 0); }
  catch (err) { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); }
} else if (command === 'slop') {
  // Slop: deterministic frontend-slop detector (no LLM). Exit 1 = slop found, for CI + the autopilot gate.
  Promise.resolve(require('../commands/slop').slopCommand(process.argv.slice(3)))
    .then((code) => process.exit(typeof code === 'number' ? code : 0))
    .catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'write') {
  // Write: guided writing sessions — human types every word, atris structures + reviews (plan-do-review for prose).
  Promise.resolve(require('../commands/write').writeCommand(process.argv.slice(3)))
    .then((code) => process.exit(typeof code === 'number' ? code : 0))
    .catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'strings') {
  // Strings: content design system from live code (no LLM). Extracts UI strings, flags variants,
  // enforces preferred terms at the gate. Exit 1 = variants/banned terms found, for CI + the gate.
  Promise.resolve(require('../commands/strings').stringsCommand(process.argv.slice(3)))
    .then((code) => process.exit(typeof code === 'number' ? code : 0))
    .catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'security-review' || command === 'secure') {
  // Security review: deterministic secrets/PII/code-risk scan (no LLM). Exit 1 = HIGH finding,
  // for the autopilot/mission/CI gate + a SOC 2 evidence artifact via --json.
  Promise.resolve(require('../commands/security-review').securityReviewCommand(process.argv.slice(3)))
    .then((code) => process.exit(typeof code === 'number' ? code : 0))
    .catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'signup') {
  // Signup: one-call seedless agent signup → writes the active profile (install→signup→play seam).
  Promise.resolve(require('../commands/signup').signupCommand(process.argv.slice(3)))
    .then((code) => process.exit(typeof code === 'number' ? code : 0))
    .catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'moves') {
  // Moves: your 3 next moves — approve one into the loop, kill, or skip.
  Promise.resolve(require('../commands/moves').movesCommand(process.argv.slice(3)))
    .then((code) => process.exit(typeof code === 'number' ? code : 0))
    .catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'unknowns') {
  // Unknowns: blindspot pass from local territory context into the SQLite ledger.
  Promise.resolve(require('../commands/unknowns').unknownsCommand(process.argv.slice(3)))
    .then((code) => process.exit(typeof code === 'number' ? code : 0))
    .catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'feed') {
  // Feed: read and post the business group feed — receipts and state changes only.
  // Sets exitCode instead of process.exit() so large --json output flushes fully.
  Promise.resolve(require('../commands/feed').feedCommand(process.argv.slice(3)))
    .then((code) => { process.exitCode = typeof code === 'number' ? code : 0; })
    .catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exitCode = 1; });
} else if (command === 'clarity') {
  // Clarity: interview yourself once; agents read how you work so you stop repeating it.
  Promise.resolve(require('../commands/clarity').clarityCommand(process.argv.slice(3)))
    .then((code) => process.exit(typeof code === 'number' ? code : 0))
    .catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'interview') {
  // Interview: the interlinked 1-on-1 — live interview that extracts judgment into a member file.
  Promise.resolve(require('../commands/interview').interviewCommand(process.argv.slice(3)))
    .then((code) => process.exit(typeof code === 'number' ? code : 0))
    .catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'deck') {
  // Deck: premium Google Slides from a plain content spec, via the Atris deck engine (anti-slop design system).
  Promise.resolve(require('../commands/deck').run(process.argv.slice(3)))
    .then((code) => process.exit(typeof code === 'number' ? code : 0))
    .catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'site') {
  // Site: beautiful static site from a folder of markdown, in the anti-slop design system.
  Promise.resolve(require('../commands/site').run(process.argv.slice(3)))
    .then((code) => process.exit(typeof code === 'number' ? code : 0))
    .catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'theme') {
  // Theme: brand themes (.atris/theme.json) for the whole design system (deck/html/site).
  Promise.resolve(require('../commands/theme').run(process.argv.slice(3)))
    .then((code) => process.exit(typeof code === 'number' ? code : 0))
    .catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'card') {
  // Card: one line of text into an on-brand image (uses your theme + the design system).
  Promise.resolve(require('../commands/card').run(process.argv.slice(3)))
    .then((code) => process.exit(typeof code === 'number' ? code : 0))
    .catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'brief') {
  // Brief: one-glance operator surface for landings, waits, and next moves.
  Promise.resolve(require('../commands/brief').run(process.argv.slice(3)))
    .then((code) => process.exit(typeof code === 'number' ? code : 0))
    .catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'reel') {
  // Reel: one line of text into a short on-brand video (an animated card; frames via Chrome + ffmpeg).
  Promise.resolve(require('../commands/reel').run(process.argv.slice(3)))
    .then((code) => process.exit(typeof code === 'number' ? code : 0))
    .catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'receipt' || command === 'proof' || command === 'openclaw') {
  const subcommand = process.argv[3];
  const args = process.argv.slice(4);
  require('../commands/proof').proofCommand(subcommand, ...args);
} else if (command === 'setup') {
  const args = process.argv.slice(3);
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    showSetupHelp();
    process.exit(0);
  }
  require('../commands/setup').setupAtris()
    .then(() => process.exit(0))
    .catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'fork') {
  require('../commands/fork').forkAtris()
    .then(() => process.exit(0))
    .catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'browse') {
  require('../commands/browse').browseAtris()
    .then(() => process.exit(0))
    .catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'publish') {
  require('../commands/publish').publishAtris()
    .then(() => process.exit(0))
    .catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'sleep') {
  require('../commands/lifecycle').sleepAtris()
    .then(() => process.exit(0))
    .catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'wake') {
  require('../commands/lifecycle').wakeAtris()
    .then(() => process.exit(0))
    .catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'feedback') {
  require('../commands/feedback').feedbackCommand()
    .then(() => process.exit(0))
    .catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'errors') {
  require('../commands/errors').errorsCommand()
    .then(() => process.exit(0))
    .catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); });
} else {
  console.log(`Unknown command: ${command}`);
  console.log('Run "atris help" to see available commands');
  process.exit(1);
}

async function upgradeAtris() {
  console.log('');
  console.log('┌─────────────────────────────────────────────────────────────┐');
  console.log('│ Atris Upgrade                                               │');
  console.log('└─────────────────────────────────────────────────────────────┘');
  console.log('');
  console.log(`Current version: ${CLI_VERSION}`);
  console.log('');
  const installWarning = formatInstallGitWarning(inspectInstallGitState(path.join(__dirname, '..')));
  if (installWarning) {
    console.log(installWarning);
    console.log('');
  }
  console.log('Checking for updates...');

  // Force check npm for latest version
  const updateInfo = await checkForUpdates(true);

  if (!updateInfo || !updateInfo.needsUpdate) {
    console.log('');
    console.log('✓ You are on the latest version!');
    console.log('');
    return;
  }

  console.log('');
  console.log(`📦 Update available: ${updateInfo.installed} → ${updateInfo.latest}`);
  console.log('');
  console.log('Installing update...');
  console.log('');

  // Run npm install -g atris@latest
  const result = spawnSync('npm', ['install', '-g', 'atris@latest'], {
    stdio: 'inherit',
    shell: true
  });

  if (result.status === 0) {
    console.log('');
    console.log('✓ Atris upgraded successfully!');
    console.log('');
    console.log('Run `atris update` in your projects to sync local files.');
    console.log('');
  } else {
    console.log('');
    console.log('✗ Upgrade failed. Try running manually:');
    console.log('  npm install -g atris@latest');
    console.log('');
    console.log('If you see permission errors, try:');
    console.log('  sudo npm install -g atris@latest');
    console.log('');
  }
}

function showVersion() {
  try {
    const packageJson = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));
    console.log(`atris v${packageJson.version}`);
  } catch (error) {
    console.error('✗ Error: Could not read package.json');
    process.exit(1);
  }
}

// ============================================
// Agent Selection
// ============================================

function fileContains(relPath, pattern) {
  try {
    const fullPath = path.join(process.cwd(), relPath);
    if (!fs.existsSync(fullPath)) return false;
    const text = fs.readFileSync(fullPath, 'utf8');
    return pattern instanceof RegExp ? pattern.test(text) : text.includes(pattern);
  } catch {
    return false;
  }
}

function commandOnPath(name) {
  const result = spawnSync('which', [name], { encoding: 'utf8', timeout: 1000 });
  return result.status === 0 ? result.stdout.trim() : null;
}

function inspectAgentCliWiring() {
  const checks = [
    {
      id: 'atris-core',
      label: 'Atris core',
      ok: fs.existsSync(path.join(process.cwd(), 'atris', 'MAP.md'))
        && fs.existsSync(path.join(process.cwd(), 'atris', 'TODO.md')),
      fix: 'Run `atris init` from the workspace root.',
    },
    {
      id: 'codex',
      label: 'Codex / OpenAI agents',
      ok: fileContains('AGENTS.md', /atris\/MAP\.md|atris atris\.md|atris task/),
      fix: 'Add AGENTS.md with Atris boot, MAP, and task instructions.',
    },
    {
      id: 'claude',
      label: 'Claude Code',
      ok: fileContains('.claude/commands/atris.md', /atris|AGENTS\.md/)
        || fileContains('.claude/settings.json', /atris atris\.md|atris\/skills/)
        || fileContains('CLAUDE.md', /Atris|atris/),
      fix: 'Run `atris init` to create .claude commands/settings.',
    },
    {
      id: 'cursor',
      label: 'Cursor',
      ok: fileContains('.cursor/rules/atris.mdc', /atris\/MAP\.md|AGENTS\.md|atris task/)
        || fileContains('.cursorrules', /atris\/MAP\.md|AGENTS\.md|atris task/)
        || fileContains('.cursor/commands/atris.md', /atris\/MAP\.md|atris\.md/),
      fix: 'Run `atris init` to create Cursor rules, or add .cursor/commands/atris.md.',
    },
    {
      id: 'devin',
      label: 'Devin',
      ok: fileContains('.devin/config.local.json', /Exec\(atris\)/),
      fix: 'Run `atris init` or add .devin/config.local.json allowing Exec(atris).',
    },
  ];

  const binaries = ['atris', 'ax', 'claude', 'codex', 'cursor-agent', 'devin', 'droid'].map((name) => ({
    name,
    path: commandOnPath(name),
  }));
  return { checks, binaries };
}

function agentDoctor() {
  const args = process.argv.slice(4);
  const json = args.includes('--json');
  const { checks, binaries } = inspectAgentCliWiring();
  const ok = checks.every((check) => check.ok);
  const payload = { ok, action: 'agent_doctor', checks, binaries };

  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    process.exit(ok ? 0 : 1);
  }

  console.log('Atris agent CLI doctor');
  console.log('');
  for (const check of checks) {
    console.log(`${check.ok ? '✓' : '✗'} ${check.label}`);
    if (!check.ok) console.log(`  fix: ${check.fix}`);
  }
  console.log('');
  console.log('Local binaries');
  for (const binary of binaries) {
    console.log(`${binary.path ? '✓' : '·'} ${binary.name}${binary.path ? ` -> ${binary.path}` : ' not on PATH'}`);
  }
  process.exit(ok ? 0 : 1);
}

async function agentAtris() {
  // Respect -h / --help / help before any auth/state work
  const firstArg = process.argv[3];
  if (firstArg === '-h' || firstArg === '--help' || firstArg === 'help') {
    console.log('Usage: atris agent [doctor|spawn|spawns|spawn-status]');
    console.log('');
    console.log('  Pick which cloud agent to chat with from this workspace.');
    console.log('  Run `atris agent spawn <role> --task "..."` to create a worker request.');
    console.log('  Run `atris agent spawns` to list worker requests.');
    console.log('  Run `atris agent doctor` to verify local AI CLIs can see Atris context.');
    console.log('  Requires `atris login` first.');
    console.log('');
    console.log('  After selecting, use: atris chat ["message"]');
    process.exit(0);
  }

  if (firstArg === 'doctor') {
    agentDoctor();
  }
  if (firstArg === 'dogfood') {
    // Internal diagnostic, gated off the public CLI. Operators use `atris agent doctor`.
    if (!process.env.ATRIS_INTERNAL_AGENT_DOGFOOD) {
      console.error('atris agent dogfood is an internal diagnostic and is not part of the public CLI.');
      console.error('Run `atris agent doctor` to verify local AI CLIs can see Atris context.');
      process.exit(1);
    }
    const dogfoodArgs = process.argv.slice(4);
    if (dogfoodArgs.includes('--help') || dogfoodArgs.includes('-h') || dogfoodArgs[0] === 'help') {
      console.log('Internal usage: atris agent dogfood [--live]');
      console.log('  Smoke-test Devin/Droid with GLM 5.2. Gated behind ATRIS_INTERNAL_AGENT_DOGFOOD.');
      process.exit(0);
    }
    const result = require('../commands/agent-spawn').agentDogfoodCommand(dogfoodArgs);
    process.exit(result.ok ? 0 : 1);
  }
  if (firstArg === 'spawn') {
    require('../commands/agent-spawn').agentSpawnCommand(process.argv.slice(4));
    return;
  }
  if (firstArg === 'spawns' || firstArg === 'spawn-list' || firstArg === 'list-spawns') {
    require('../commands/agent-spawn').agentSpawnListCommand(process.argv.slice(4));
    return;
  }
  if (firstArg === 'spawn-status' || firstArg === 'spawn-show') {
    require('../commands/agent-spawn').agentSpawnStatusCommand(process.argv.slice(4));
    return;
  }

  const targetDir = path.join(process.cwd(), 'atris');

  // Check if atris/ folder exists
  if (!fs.existsSync(targetDir)) {
    console.error('✗ Error: atris/ folder not found. Run "atris init" first.');
    process.exit(1);
  }

  printAtrisGoalBanner(process.cwd());

  // Check if logged in (with token refresh)
  const ensured = await ensureValidCredentials();
  if (ensured.error === 'not_logged_in' || !ensured.credentials?.token) {
    console.error('✗ Error: Not logged in. Run "atris login" first.');
    process.exit(1);
  }
  if (ensured.error) {
    console.error(`✗ Error: Authentication failed: ${ensured.detail || ensured.error}. Run "atris login" to re-authenticate.`);
    process.exit(1);
  }
  const credentials = ensured.credentials;

  console.log('🔍 Fetching your agents...\n');

  // Fetch agents from backend
  const result = await apiRequestJson('/agent/my-agents', {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${credentials.token}`,
    },
  });

  if (!result.ok) {
    console.error(`✗ Error: ${result.error || 'Failed to fetch agents'}`);
    process.exit(1);
  }

  const agents = result.data?.my_agents || [];

  if (agents.length === 0) {
    console.log('No agents found. Create one at https://atris.ai');
    process.exit(0);
  }

  // Show current selection
  const config = loadConfig();
  if (config.agent_id) {
    const current = agents.find(a => a.id === config.agent_id);
    if (current) {
      console.log(`Current agent: ${current.name}\n`);
    }
  }

  // Display agents
  console.log('Available agents:');
  agents.forEach((agent, index) => {
    console.log(`  ${index + 1}. ${agent.name}`);
  });

  console.log('');

  // Prompt for selection
  const answer = await promptUser('Select agent number (or press Enter to cancel): ');

  if (!answer) {
    console.log('Cancelled.');
    process.exit(0);
  }

  const selection = parseInt(answer, 10);

  if (isNaN(selection) || selection < 1 || selection > agents.length) {
    console.error('✗ Invalid selection');
    process.exit(1);
  }

  const selectedAgent = agents[selection - 1];

  // Save to config
  config.agent_id = selectedAgent.id;
  config.agent_name = selectedAgent.name;
  saveConfig(config);

  console.log(`\n✓ Selected agent: ${selectedAgent.name}`);
  console.log(`✓ Config saved to atris/.config`);
  console.log(`\nYou can now use "atris chat" to talk with this agent.`);
}


async function chatAtris() {
  // Get message from command line args; --agent forces the legacy cloud-agent lane
  const rawArgs = process.argv.slice(3);
  const fastLaneFlags = [];
  const messageArgs = [];
  let agentLane = false;
  for (const arg of rawArgs) {
    if (arg === '--agent') {
      agentLane = true;
    } else if (arg === '--print' || arg === '--headless') {
      fastLaneFlags.push(arg);
    } else {
      messageArgs.push(arg);
    }
  }
  const message = messageArgs.join(' ').trim();

  // Respect -h / --help before any auth/state checks
  if (message === '-h' || message === '--help' || message === 'help') {
    console.log('Usage: atris chat ["message"]');
    console.log('');
    console.log('  Chat with Atris 2 Fast in this workspace: tools attached, same turn as `ax --fast`.');
    console.log('  Requires `atris login`.');
    console.log('');
    console.log('  atris chat                  Interactive chat (ax --fast --chat)');
    console.log('  atris chat "what now?"      One-shot message (ax --fast)');
    console.log('  atris chat --print "..."    Headless JSON result (ax --fast --print)');
    console.log('  atris chat --agent [...]    Legacy cloud-agent lane (needs `atris agent`)');
    process.exit(0);
  }

  // Check atris/ exists
  const targetDir = path.join(process.cwd(), 'atris');
  if (!fs.existsSync(targetDir)) {
    console.error('✗ Error: atris/ folder not found. Run "atris init" first.');
    process.exit(1);
  }

  const missionIntent = fastLaneFlags.length ? null : missionRunIntentFromFastMessage(message);
  if (missionIntent) {
    process.exit(await runLocalFastMission(missionIntent));
  }

  // Workspace standard v2: `atris chat` is the same turn as `ax --fast`,
  // Atris 2 Fast with tools attached, ax owning routing (local tool loop,
  // cloud fallback when no backend listens). The pro-chat cloud-agent lane
  // survives behind --agent only; it 404s the moment a saved agent is
  // deleted server-side and cannot see the workspace.
  if (!agentLane) {
    try {
      const axPath = path.join(__dirname, '..', 'ax');
      const axArgs = message || fastLaneFlags.length ? ['--fast', ...fastLaneFlags, message].filter(Boolean) : ['--fast', '--chat'];
      const run = spawnSync(process.execPath, [axPath, ...axArgs], { stdio: 'inherit' });
      process.exit(run.status || 0);
    } catch {
      // ax unavailable: fall through to the agent lane.
    }
  }

  printAtrisGoalBanner(process.cwd());

  // Check agent selected
  const config = loadConfig();
  if (!config.agent_id) {
    console.error('✗ Error: No agent selected. Run "atris agent" first.');
    process.exit(1);
  }

  // Check credentials (with token refresh)
  const ensured = await ensureValidCredentials();
  if (ensured.error === 'not_logged_in' || !ensured.credentials?.token) {
    console.error('✗ Error: Not logged in. Run "atris login" first.');
    process.exit(1);
  }
  if (ensured.error) {
    console.error(`✗ Error: Authentication failed: ${ensured.detail || ensured.error}. Run "atris login" to re-authenticate.`);
    process.exit(1);
  }
  const credentials = ensured.credentials;

  // If message provided, one-shot mode
  if (message) {
    await chatOnce(config, credentials, message);
    return;
  }

  // Otherwise, interactive mode
  await chatInteractive(config, credentials);
}

async function chatOnce(config, credentials, message) {
  console.log(`\nAgent: ${config.agent_name || config.agent_id}`);
  console.log('');

  const agentId = config.agent_id;
  const apiUrl = getApiBaseUrl().replace(/\/api$/, '');
  const endpoint = `${apiUrl}/api/agent/${agentId}/pro-chat`;

  const body = JSON.stringify({
    message: message,
    stream: true,
    memory_enabled: true,
  });

  try {
    await streamProChat(endpoint, credentials.token, body);
    console.log('\n\n✓ Complete\n');
  } catch (error) {
    const detail = String(error.message || error);
    if (/404/.test(detail) && /agent not found/i.test(detail)) {
      console.error(`\n✗ Error: Agent "${config.agent_name || agentId}" no longer exists on the server.`);
      console.error('  Run "atris agent" to pick a new one, or drop --agent to use the fast workspace lane.');
    } else {
      console.error(`\n✗ Error: ${detail}`);
    }
    process.exit(1);
  }
}

async function chatInteractive(config, credentials) {
  return new Promise((resolve) => {
    const agentId = config.agent_id;
    const agentName = config.agent_name || config.agent_id;
    const conversationId = `cli-${Date.now()}`;

    console.log('┌────────────────────────────────────────────────────────────┐');
    console.log(`│ Atris Chat — ${agentName.padEnd(44)} │`);
    console.log('├────────────────────────────────────────────────────────────┤');
    console.log('│ Type your message and press Enter                          │');
    console.log('│ Type "exit" to quit                                        │');
    console.log('└────────────────────────────────────────────────────────────┘');
    console.log('');

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: '> ',
    });

    rl.prompt();

    const handleLine = async (line) => {
      const input = line.trim();

      if (input.toLowerCase() === 'exit') {
        console.log('\n✓ Session saved\n');
        rl.close();
        resolve();
        return;
      }

      if (!input) {
        rl.prompt();
        return;
      }

      const missionIntent = missionRunIntentFromFastMessage(input);
      if (missionIntent) {
        console.log('');
        await runLocalFastMission(missionIntent);
        console.log('');
        rl.prompt();
        return;
      }

      // Send to pro-chat
      console.log('');
      const apiUrl = getApiBaseUrl().replace(/\/api$/, '');
      const endpoint = `${apiUrl}/api/agent/${agentId}/pro-chat`;

      const body = JSON.stringify({
        message: input,
        conversation_id: conversationId,
        stream: true,
        memory_enabled: true,
      });

      try {
        await streamProChat(endpoint, credentials.token, body);
        console.log('\n');
      } catch (error) {
        console.error(`\n✗ Error: ${error.message || error}\n`);
      }

      rl.prompt();
    };

    rl.on('line', (line) => {
      // Pause readline while processing
      rl.pause();
      handleLine(line)
        .then(() => {
          rl.resume();
        })
        .catch((error) => {
          console.error(`\n✗ Error: ${error.message || error}\n`);
          rl.resume();
          rl.prompt();
        });
    });

    rl.on('close', () => {
      console.log('\nGoodbye!');
      resolve();
    });
  });
}

function atrisFastMessageFromArgs() {
  const offset = command === 'ax' ? 4 : 3;
  return process.argv.slice(offset).join(' ').trim();
}

function stripFastMissionQuotes(value) {
  const text = String(value || '').trim();
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return text.slice(1, -1).trim();
    }
  }
  return text;
}

function extractFastMissionFlag(text, flagName) {
  const source = String(text || '');
  const inline = new RegExp(`(^|\\s)${flagName}=([^\\s]+)(?=\\s|$)`).exec(source);
  if (inline) {
    return {
      value: inline[2],
      text: `${source.slice(0, inline.index)}${inline[1] || ''}${source.slice(inline.index + inline[0].length)}`.replace(/\s+/g, ' ').trim(),
    };
  }
  const split = new RegExp(`(^|\\s)${flagName}\\s+([^\\s]+)(?=\\s|$)`).exec(source);
  if (split) {
    return {
      value: split[2],
      text: `${source.slice(0, split.index)}${split[1] || ''}${source.slice(split.index + split[0].length)}`.replace(/\s+/g, ' ').trim(),
    };
  }
  return { value: null, text: source.trim() };
}

function missionRunIntentFromFastMessage(message) {
  return missionRuntime.missionRunIntentFromMessage(message);
}

function printFastMissionStartReceipt(payload) {
  const mission = payload?.mission || {};
  const goal = payload?.atris_goal_state?.goal || {};
  const receiptGoal = {
    ...goal,
    objective: goal.objective || mission.objective,
    mission_id: goal.mission_id || mission.id,
    mission_status: goal.mission_status || mission.status,
    runner: goal.runner || mission.runner,
    created_at: goal.created_at || mission.created_at,
    updated_at: goal.updated_at || mission.updated_at,
    completed_at: goal.completed_at || mission.completed_at,
    next_command: goal.next_command || payload?.next_command || mission.next_action,
  };
  const elapsed = formatGoalDuration(goalElapsedSeconds(receiptGoal)) || '0s';

  console.log('Atris mission started');
  console.log(`Goal: ${receiptGoal.objective || '?'}`);
  console.log(`Mission: ${receiptGoal.mission_id || '?'} · ${receiptGoal.mission_status || '?'} · ${receiptGoal.runner || 'atris2'}`);
  console.log(`Elapsed: ${elapsed}`);
  console.log(`Achieved: ${goalAchieved(receiptGoal) ? 'yes' : 'no'}`);
  if (receiptGoal.next_command) console.log(`Next: ${receiptGoal.next_command}`);
}

async function runLocalFastMission(intent) {
  const result = await missionRuntime.runRuntimeMissionLoop(intent, {
    cwd: process.cwd(),
    cliPath: __filename,
    onProgress: (line) => {
      if (/^pursuing /.test(line)) console.log('Pursuing goal...');
      else if (/^\[tick /.test(line)) console.log(line);
    },
  });
  console.log(result.text || 'Mission command failed.');
  return result.ok ? 0 : (result.status || 1);
}

async function atrisFastChat() {
  if (command === 'ax' && process.argv[3] !== 'fast') {
    console.error('Usage: atris ax fast "message"');
    process.exit(1);
  }

  const message = atrisFastMessageFromArgs();

  if (message === '-h' || message === '--help' || message === 'help') {
    console.log('Usage: atris fast ["message"]');
    console.log('');
    console.log('  Chat with Atris2 Fast through /api/atris2/turn.');
    console.log('  Requires `atris login`.');
    console.log('');
    console.log('  atris fast "what now?"      One-shot message');
    console.log('  atris ax fast "what now?"   Alias');
    process.exit(0);
  }

  if (!message) {
    console.error('Usage: atris fast "message"');
    process.exit(1);
  }

  const missionIntent = missionRunIntentFromFastMessage(message);
  if (missionIntent) {
    process.exit(await runLocalFastMission(missionIntent));
  }

  // One routing brain: `atris fast` defers to ax's AX Context Standard. A
  // workspace-shaped question asked from inside a workspace needs local tools
  // (this lane is a tool-less cloud one-shot and confabulates on repo
  // questions — SwapBench 2026-07-02), so delegate the whole turn to ax.
  try {
    const axModule = require('../ax');
    if (axModule.resolveRoute(message) === 'local') {
      const run = spawnSync(process.execPath, [path.join(__dirname, '..', 'ax'), '--fast', message], { stdio: 'inherit' });
      process.exit(run.status || 0);
    }
  } catch {
    // ax unavailable: fall through to the plain cloud one-shot.
  }

  printAtrisGoalBanner(process.cwd());

  const ensured = await ensureValidCredentials();
  if (ensured.error === 'not_logged_in' || !ensured.credentials?.token) {
    console.error('✗ Error: Not logged in. Run "atris login" first.');
    process.exit(1);
  }
  if (ensured.error) {
    console.error(`✗ Error: Authentication failed: ${ensured.detail || ensured.error}. Run "atris login" to re-authenticate.`);
    process.exit(1);
  }

  const credentials = ensured.credentials;
  await atrisFastOnce(credentials, message);
}

async function atrisFastOnce(credentials, message) {
  console.log('\nAtris2 Fast');
  console.log('');

  const apiUrl = getApiBaseUrl().replace(/\/api$/, '');
  const endpoint = `${apiUrl}/api/atris2/turn`;
  const body = JSON.stringify({
    message,
    model: 'atris:fast',
    max_turns: 1,
  });

  await streamProChat(endpoint, credentials.token, body);
  console.log('\n\n✓ Complete\n');
}
