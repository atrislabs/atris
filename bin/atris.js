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
  autoUpdate,
  inspectInstallGitState,
  formatInstallGitWarning,
} = require('../utils/update-check');

// State detection for smart default
const { detectWorkspaceState, loadContext } = require('../lib/state-detection');
const {
  saveContextProfile,
  createStarterTask,
  shouldGatherContext,
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
      // Show notification if update available (after command completes)
      if (updateInfo) {
        // Notify only — never auto-update mid-session (opt-in via ATRIS_AUTO_UPDATE=1)
        if (process.env.ATRIS_AUTO_UPDATE === '1') {
          setTimeout(() => {
            if (!autoUpdate(updateInfo)) {
              showUpdateNotification(updateInfo);
            }
          }, 100);
        } else {
          showUpdateNotification(updateInfo);
        }
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
  const runnerProfile = readOptionArg(args, '--runner-profile');
  if (runnerProfile) process.env.ATRIS_RUNNER_PROFILE = runnerProfile;
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
}

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
        verifier: m.verifier || null,
        verifier_passed: (m.verifier_result && m.verifier_result.passed) === true,
        next_action: m.next_action || '',
        lane: m.lane || null,
      });
    }
    // Most recently started first (rough — relies on insertion order from reversed walk)
    return live;
  } catch {
    return [];
  }
}

function showSearchHelp() {
  console.log('Usage: atris search <keyword>');
  console.log('Example: atris search auth');
}

function searchJournal(keyword) {
  if (!keyword) {
    showSearchHelp();
    process.exit(1);
  }

  if (keyword === '--help' || keyword === '-h') {
    showSearchHelp();
    process.exit(0);
  }

  if (process.argv.slice(4).includes('--help') || process.argv.slice(4).includes('-h')) {
    showSearchHelp();
    process.exit(1);
  }

  const logsDir = path.join(process.cwd(), 'atris', 'logs');
  if (!fs.existsSync(logsDir)) {
    console.log('No atris/logs/ directory found. Run "atris init" first.');
    process.exit(1);
  }

  console.log(`Searching for "${keyword}" in atris/logs/**/*.md...\n`);

  const results = [];
  const keywordLower = keyword.toLowerCase();

  // Recursively find all .md files in logs directory
  function walkDir(dir) {
    let files;
    try { files = fs.readdirSync(dir); } catch { return; }
    for (const file of files) {
      try {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
          walkDir(filePath);
        } else if (file.endsWith('.md')) {
          const content = fs.readFileSync(filePath, 'utf8');
          const lines = content.split('\n');
          lines.forEach((line, idx) => {
            if (line.toLowerCase().includes(keywordLower)) {
              results.push({
                file: path.relative(process.cwd(), filePath),
                line: idx + 1,
                content: line.trim()
              });
            }
          });
        }
      } catch { /* skip unreadable files */ }
    }
  }

  walkDir(logsDir);

  if (results.length === 0) {
    console.log('No matches found.');
  } else {
    console.log(`Found ${results.length} match${results.length > 1 ? 'es' : ''}:\n`);
    results.forEach(r => {
      console.log(`${r.file}:${r.line}`);
      console.log(`  ${r.content.substring(0, 100)}${r.content.length > 100 ? '...' : ''}`);
      console.log('');
    });
  }
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
  console.log('  2. Describe what you want run, built, researched, or validated');
  console.log('  3. Atris acts with context, memory, tools, and a review loop');
  console.log('');
  console.log('Common invocations:');
  console.log('  atris init');
  console.log('  atris computer');
  console.log('  atris business init "My Company"');
  console.log('  atris run');
  console.log('  atris status');
  console.log('  atris soul');
  console.log('  atris fleet status');
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
  console.log('Atris Computers:');
  console.log('  Owner = User | Business');
  console.log('  Owners have Computers: workspace + files + tools + secrets + memory + agents + validation');
  console.log('  Types: code, research, CRM, reporting, recruiting, events, support, business ops');
  console.log('');
  console.log('Setup:');
  console.log('  setup      - Guided first-time setup (login, pick business, pull)');
  console.log('  init       - Initialize Atris in current project');
  console.log('  update     - Update local files to latest version');
  console.log('  upgrade    - Install latest Atris from npm');
  console.log('');
  console.log('Core workflow:');
  console.log('  plan       - Create build spec with visualization');
  console.log('  do         - Execute tasks');
  console.log('  review     - Validate work (tests, safety checks, docs)');
  console.log('  run        - Auto-chain plan→do→review (autonomous loop, auto-pushes)');
  console.log('  pulse      - Durable overnight self-improvement heartbeat (OS cron, install/status/tick)');
  console.log('  spaceship  - Bounded overnight runner that survives bad ticks and emails updates');
  console.log('');
  console.log('Context & tracking:');
  console.log('  log        - Add ideas to inbox');
  console.log('  now        - Show atris/now.md, the current operating truth');
  console.log('  activate   - Load Atris context');
  console.log('  radar      - Show live agents joined with tasks, missions, and worktrees');
  console.log('  ctop       - Show a process-first live agent CPU/memory view');
  console.log('  status     - See local work and completions (`atris status <business>` for remote)');
  console.log('  recap      - What your AI team did, in plain English (--share for paste-ready)');
  console.log('  xp         - Show Career XP and contribution graph');
  console.log('  analytics  - Show recent productivity from journals');
  console.log('  search     - Search journal history (atris search <keyword>)');
  console.log('  clean      - Housekeeping (stale tasks, archive journals, broken refs)');
  console.log('  verify     - Validate work is done (tests, MAP.md, changes)');
  console.log('  task       - Local agent task plane (atomic claims, TODO import)');
  console.log('  mission    - Goal + loop + member owner + verifier + receipt');
  console.log('  release    - Tag release, bump version, create GitHub release, draft /launch');
  console.log('  learn      - Project learnings (patterns, pitfalls, preferences)');
  console.log('  brain      - Compile MAP/TODO/wiki/state into a loadable agent brain');
  console.log('  lesson     - Append a one-line lesson to atris/lessons.md (mine: distill receipts/episodes/scorecards into policy lessons)');
  console.log('  ingest     - Local-first wiki ingest into atris/wiki/');
  console.log('  query      - Local-first wiki query against atris/wiki/');
  console.log('  lint       - Local-first wiki lint for atris/wiki/');
  console.log('  loop       - Local wiki upkeep loop (stale pages, orphans, next ingest)');
  console.log('');
  console.log('Optional helpers:');
  console.log('  brainstorm - Explore ideas conversationally before planning');
  console.log('  autopilot  - Guided loop that can clarify TODOs and run plan → do → review');
  console.log('  improve    - Run one paid RL tick (POST /api/improve, deducts credits)');
  console.log('  worktree   - Isolated Git worktrees plus guarded ship/merge for parallel agents');
  console.log('  visualize  - Generate a Slack/deck-ready visual from a prompt');
  console.log('');
  console.log('Experiments:');
  console.log('  experiments init [slug]     - Prepare atris/experiments/ or scaffold a pack');
  console.log('  experiments validate        - Validate experiment packs');
  console.log('  experiments run <slug>      - Execute a pack or record an Endstate receipt');
  console.log('  experiments benchmark [m]   - Run validate/runtime experiment benchmarks');
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
  console.log('  agent      - Select cloud agent, or run `agent doctor` for local CLI wiring');
  console.log('  chat       - Chat with the selected Atris agent');
  console.log('  fast       - Chat with Atris2 Fast');
  console.log('  login      - Sign in or add another account');
  console.log('  logout     - Sign out of current account');
  console.log('  whoami     - Show active account');
  console.log('  switch     - Switch account globally (atris switch <name>)');
  console.log('  use        - Set account for this terminal only (atris use <name>)');
  console.log('  accounts   - Manage accounts (list, add, remove)');
  console.log('');
  console.log('Integrations:');
  console.log('  gmail      - Email commands (inbox, read)');
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
  console.log(`Usage: atris ${commandName} [--all] [--dry-run] [--force]`);
  console.log('');
  console.log('Description:');
  console.log('  Sync Atris workspace files from the installed CLI templates.');
  console.log('');
  console.log('Options:');
  console.log('  --all        Update Atris files across projects under the current tree.');
  console.log('  --dry-run    Preview update work without writing files.');
  console.log('  --force      Overwrite existing template files where supported.');
  console.log('  --help, -h       Show this help.');
  console.log('');
}

function showUpgradeHelp() {
  console.log('');
  console.log('Usage: atris upgrade');
  console.log('');
  console.log('Description:');
  console.log('  Check npm for the latest Atris CLI and install it globally if newer.');
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
  console.log('Usage: atris loop [--dry-run] [--json] [--limit=N]');
  console.log('');
  console.log('Description:');
  console.log('  Inspect wiki upkeep state and optionally refresh wiki status/log files.');
  console.log('');
  console.log('Options:');
  console.log('  --dry-run    Preview wiki loop state without writing files.');
  console.log('  --json       Print the loop report as JSON.');
  console.log('  --limit=N    Limit suggested source count.');
  console.log('  --help, -h   Show this help.');
  console.log('');
}

function showCleanHelp() {
  console.log('');
  console.log('Usage: atris clean [--dry-run]');
  console.log('');
  console.log('Description:');
  console.log('  Check workspace housekeeping: stale tasks, MAP.md refs, old journals,');
  console.log('  empty TODO sections, and stale wiki pages.');
  console.log('');
  console.log('Options:');
  console.log('  --dry-run, -n   Preview cleanup without changing files.');
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
  console.log('  --runner-profile NAME   Runner profile for this run (e.g. atris-fast)');
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
const knownCommands = ['init', 'log', 'now', 'radar', 'ctop', 'status', 'analytics', 'visualize', 'brain', 'brainstorm', 'autopilot', 'run', 'plan', 'do', 'review', 'release',
                       'activate', '_activate', 'agent', 'chat', 'fast', 'ax', 'console', 'serve', 'login', 'logout', 'whoami', 'switch', 'use', 'accounts', '_resolve', '_profile-email', '_switch-session', 'shell-init', 'update', 'upgrade', 'version', 'help', 'next', 'atris',
                       'clean', 'verify', 'search', 'skill', 'member', 'codex-goal', 'app', 'apps', 'learn', 'lesson', 'plugin', 'experiments', 'receipt', 'proof', 'openclaw', 'pull', 'push', 'live', 'align', 'terminal', 'computer', 'diff', 'business', 'sync',
                       'ingest', 'query', 'lint', 'loop', 'pulse', 'task', 'mission', 'probe', 'worktree', 'aeo', 'improve', 'xp', 'play', 'gm', 'x', 'recap',
                       'gmail', 'calendar', 'twitter', 'slack', 'imessage', 'integrations', 'setup', 'clean-workspace', 'cw',
                       'fork', 'browse', 'publish', 'sleep', 'wake', 'feedback', 'errors', 'wiki', 'code-review', 'cr', 'soul', 'fleet', 'compile', 'spaceship'];

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
const voiceTriggers = {
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
  const triggered = voiceTriggers[fullInput];
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

async function interactiveEntry(userInput) {
  const workspaceDir = process.cwd();
  const state = detectWorkspaceState(workspaceDir);
  const context = loadContext(workspaceDir);

  // Fresh install - offer init
  if (state.state === 'fresh') {
    console.log('\nNo atris/ folder found. Run: atris init');
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
    const answer = String(userInput || '').trim() || await askContextGatherer(workspaceDir);
    if (!answer.trim()) {
      console.log('');
      console.log('No problem. When you are ready, answer in normal words.');
      console.log('Example: "help me organize college applications" or "help me build a small website".');
      return;
    }
    const profile = saveContextProfile(workspaceDir, answer, { source: userInput ? 'hot_start' : 'cold_start' });
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
      printMapBootstrap({ userInput: answer, prefix: 'Next setup step' });
      return;
    }
    await planCmd(answer);
    return;
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
    console.log(`    Ready. Run 'atris plan' to start.`);
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
} else if (command === 'task') {
  // SQLite-backed task plane. ~/.atris/tasks.db, gitignored, per-workspace.
  Promise.resolve(require('../commands/task').run(process.argv.slice(3)))
    .then(() => process.exit(0))
    .catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'mission') {
  Promise.resolve(require('../commands/mission').missionCommand(process.argv.slice(3)))
    .then(() => process.exit(0))
    .catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); });
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
} else if (command === 'radar' || command === 'ctop') {
  const radarArgs = command === 'ctop' ? ['--agents', ...process.argv.slice(3)] : process.argv.slice(3);
  Promise.resolve(require('../commands/radar').radarCommand(radarArgs))
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
  chatAtris()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(`✗ Chat failed: ${error.message || error}`);
      process.exit(1);
    });
} else if (command === 'fast' || (command === 'ax' && process.argv[3] === 'fast')) {
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
} else if (command === 'run') {
  const args = process.argv.slice(3);
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    console.log('');
    console.log('Usage: atris run [options]');
    console.log('');
    console.log('Auto-chain plan → do → review cycles autonomously.');
    console.log('Reads inbox ideas, creates tasks, builds them, validates, repeats.');
    console.log('');
    console.log('Options:');
    console.log('  --cycles=N    Max cycles (default: 5)');
    console.log('  --once        Single plan→do→review cycle');
    console.log('  --verbose     Show configured runner output');
    console.log('  --dry-run     Preview without executing');
    console.log('  --timeout=N   Phase timeout in seconds (default: 600)');
    console.log('  --runner-bin PATH       Runner binary for this run');
    console.log('  --runner-template CMD   Runner command template for this run');
    console.log('  --runner-model MODEL    Runner model for this run');
    console.log('  --runner-profile NAME   Runner profile for this run (e.g. atris-fast)');
    console.log('  --push        Auto-push after each cycle (default: true)');
    console.log('  --no-push     Skip auto-push after each cycle');
    console.log('');
    process.exit(0);
  }

  const verbose = args.includes('--verbose') || args.includes('-v');
  const dryRun = args.includes('--dry-run');
  const once = args.includes('--once');
  const push = !args.includes('--no-push');
  applyRunnerFlags(args);
  const cyclesArg = args.find(a => a.startsWith('--cycles='));
  const maxCycles = cyclesArg ? parseInt(cyclesArg.split('=')[1]) : 5;
  const timeoutArg = args.find(a => a.startsWith('--timeout='));
  const timeout = timeoutArg ? parseInt(timeoutArg.split('=')[1]) * 1000 : undefined;

  require('../commands/run').runAtris({ maxCycles, verbose, dryRun, once, push, timeout })
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(`\u2717 Run failed: ${error.message || error}`);
      process.exit(1);
    });
} else if (command === 'autopilot') {
  const args = process.argv.slice(3);
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    showAutopilotHelp();
    process.exit(0);
  }

  // Parse options
  const verbose = args.includes('--verbose') || args.includes('-v');
  const dryRun = args.includes('--dry-run');
  const auto = args.includes('--auto');
  applyRunnerFlags(args);
  const maxIterationsArg = args.find(a => a.startsWith('--iterations='));
  const maxIterations = maxIterationsArg ? parseInt(maxIterationsArg.split('=')[1]) : undefined;
  const durationArg = args.find(a => a.startsWith('--duration='));
  const duration = durationArg ? durationArg.split('=')[1] : null;

  // Get description (non-flag args)
  const description = args.filter((a, i) => !a.startsWith('-') && !isOptionValue(args, i, RUNNER_FLAG_NAMES)).join(' ').trim() || null;

  const options = {
    ...(maxIterations !== undefined && { maxIterations }),
    verbose,
    dryRun,
    auto,
    duration
  };

  let promise;
  promise = require('../commands/autopilot').autopilotAtris(description, options);

  promise
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(`✗ Autopilot failed: ${error.message || error}`);
      process.exit(1);
    });
} else if (command === 'brainstorm') {
  require('../commands/brainstorm').brainstormAtris()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(`✗ Brainstorm failed: ${error.message || error}`);
      process.exit(1);
    });
} else if (command === 'next' || command === 'atris') {
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
  require('../commands/clean').cleanAtris({ dryRun });
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
  const keyword = process.argv.slice(3).join(' ');
  searchJournal(keyword);
} else if (command === 'xp') {
  require('../commands/xp').xpCommand(...process.argv.slice(3))
    .then(() => { process.exitCode = 0; })
    .catch((err) => { console.error(`✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'play') {
  require('../commands/play').playCommand(...process.argv.slice(3))
    .then(() => process.exit(0))
    .catch((err) => { console.error(`✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'gm') {
  require('../commands/gm').gmCommand(...process.argv.slice(3))
    .then(() => process.exit(0))
    .catch((err) => { console.error(`✗ Error: ${err.message || err}`); process.exit(1); });
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
  require('../commands/loop').loopAtris(args)
    .then(() => process.exit(0))
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

  // Run npm update -g atris
  const result = spawnSync('npm', ['update', '-g', 'atris'], {
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
    console.log('  npm update -g atris');
    console.log('');
    console.log('If you see permission errors, try:');
    console.log('  sudo npm update -g atris');
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

  const binaries = ['atris', 'claude', 'codex', 'cursor-agent', 'devin'].map((name) => ({
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
    console.log('Usage: atris agent [doctor]');
    console.log('');
    console.log('  Pick which cloud agent to chat with from this workspace.');
    console.log('  Run `atris agent doctor` to verify local AI CLIs can see Atris context.');
    console.log('  Requires `atris login` first.');
    console.log('');
    console.log('  After selecting, use: atris chat ["message"]');
    process.exit(0);
  }

  if (firstArg === 'doctor') {
    agentDoctor();
  }

  const targetDir = path.join(process.cwd(), 'atris');

  // Check if atris/ folder exists
  if (!fs.existsSync(targetDir)) {
    console.error('✗ Error: atris/ folder not found. Run "atris init" first.');
    process.exit(1);
  }

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
  // Get message from command line args
  const message = process.argv.slice(3).join(' ').trim();

  // Respect -h / --help before any auth/state checks
  if (message === '-h' || message === '--help' || message === 'help') {
    console.log('Usage: atris chat ["message"]');
    console.log('');
    console.log('  Open an interactive session with the selected agent, or send a one-shot message.');
    console.log('  Requires `atris login` and `atris agent` to be run first.');
    console.log('');
    console.log('  atris chat                  Interactive REPL with selected agent');
    console.log('  atris chat "what now?"      One-shot message');
    process.exit(0);
  }

  // Check atris/ exists
  const targetDir = path.join(process.cwd(), 'atris');
  if (!fs.existsSync(targetDir)) {
    console.error('✗ Error: atris/ folder not found. Run "atris init" first.');
    process.exit(1);
  }

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
    console.error(`\n✗ Error: ${error.message || error}`);
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

async function atrisDevEntry(userInput = null) {
  // Load workspace context and present planning-ready state
  // userInput: optional task description for hot start
  const targetDir = path.join(process.cwd(), 'atris');

  // Check if Atris is initialized
  if (!fs.existsSync(targetDir)) {
    console.log('');
    console.log('🚀 Welcome to Atris\n');
    console.log('Not initialized yet. Let\'s get started:\n');
    console.log('  → atris init        Set up your workspace');
    console.log('  → atris help        See all commands\n');
    return;
  }

  ensureLogDirectory();
  const { logFile, dateFormatted } = getLogPath();
  if (!fs.existsSync(logFile)) {
    createLogFile(logFile, dateFormatted);
  }

  // Load context
  const workspaceDir = process.cwd();
  const state = detectWorkspaceState(workspaceDir);
  const context = loadContext(workspaceDir);

  // Detect existing features
  const featuresDir = path.join(targetDir, 'features');
  let existingFeatures = [];
  if (fs.existsSync(featuresDir)) {
    existingFeatures = fs.readdirSync(featuresDir)
      .filter(name => {
        const featurePath = path.join(featuresDir, name);
        return fs.statSync(featurePath).isDirectory() && !name.startsWith('_');
      });
  }

  console.log('');
  console.log('┌─────────────────────────────────────────────────────────────┐');
  console.log('│ Atris Mode                                                  │');
  console.log('└─────────────────────────────────────────────────────────────┘');
  console.log('');
  console.log(`📅 ${dateFormatted}`);
  console.log('');

  // Show existing features
  if (existingFeatures.length > 0) {
    console.log('📦 Features: ' + existingFeatures.join(', '));
    console.log('');
  }

  // Show active work
  if (context.inProgressFeatures.length > 0) {
    console.log('⚡ Active: ' + context.inProgressFeatures.join(', '));
    console.log('');
  }

  // Show inbox
  if (context.hasInbox && context.inboxItems.length > 0) {
    console.log(`📥 Inbox (${context.inboxItems.length}):`);
    context.inboxItems.slice(0, 3).forEach((item, i) => {
      const preview = item.length > 50 ? item.substring(0, 47) + '...' : item;
      console.log(`   ${i + 1}. ${preview}`);
    });
    if (context.inboxItems.length > 3) {
      console.log(`   ... and ${context.inboxItems.length - 3} more`);
    }
    console.log('');
  }

  // Show recent completions
  const logContent = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  const completedMatch = logContent.match(/## Completed ✅\n([\s\S]*?)(?=\n##|$)/);
  if (completedMatch && completedMatch[1].trim()) {
    const completedItems = completedMatch[1].trim().split('\n')
      .filter(line => line.match(/^- \*\*C\d+:/))
      .slice(-2);
    if (completedItems.length > 0) {
      console.log('✅ Recent:');
      completedItems.forEach(item => {
        const match = item.match(/^- \*\*C\d+:\s*(.+)\*\*/);
        if (match) {
          const text = match[1].length > 50 ? match[1].substring(0, 47) + '...' : match[1];
          console.log(`   • ${text}`);
        }
      });
      console.log('');
    }
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('atris — navigator agent');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');

  if (userInput) {
    // Hot start - user provided task
    console.log('User wants:');
    console.log(`"${userInput}"`);
    console.log('');
  } else {
    // Cold start - no specific task
    console.log('Wait for user to describe what they want.');
    console.log('');
  }

  console.log('⚠️  APPROVAL REQUIRED — Follow this workflow:');
  console.log('');
  console.log('STEP 1: Show ASCII visualization');
  console.log('   Create diagrams showing architecture/flow/UI');
  console.log('   SHOW diagrams to user and WAIT for approval.');
  console.log('');
  console.log('STEP 2: After approval, determine scope');
  if (existingFeatures.length > 0) {
    console.log('   Existing: ' + existingFeatures.join(', '));
  }
  console.log('   NEW feature → atris/features/[name]/idea.md + build.md + validate.md');
  console.log('   EXISTING → Update that feature\'s docs');
  console.log('   SIMPLE → TODO.md only');
  console.log('');
  console.log('STEP 3: Create/update docs');
  console.log('   idea.md = intent (any format)');
  console.log('   build.md = technical spec');
  console.log('   validate.md = proof it works (from _templates/validate.md.template)');
  console.log('   lessons.md = read past lessons before planning, write new ones after validating');
  console.log('');
  console.log('⛔ DO NOT execute — that\'s for "atris do"');
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
}
