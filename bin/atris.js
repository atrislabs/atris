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
const { checkForUpdates, showUpdateNotification, autoUpdate } = require('../utils/update-check');

// State detection for smart default
const { detectWorkspaceState, loadContext } = require('../lib/state-detection');

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

// Run update check in background (non-blocking)
// Skip for 'version' and 'update' commands to avoid redundant messages
let updateCheckPromise = null;
const skipUpdateCheck = Boolean(process.env.ATRIS_SKIP_UPDATE_CHECK || process.env.NO_UPDATE_NOTIFIER);
if (!skipUpdateCheck && (!process.argv[2] || (process.argv[2] && !['version', 'update', 'help'].includes(process.argv[2])))) {
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

const command = process.argv[2];
const commandArgs = process.argv.slice(3);
const firstCommandArg = process.argv[3];
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

function searchJournal(keyword) {
  if (!keyword) {
    console.log('Usage: atris search <keyword>');
    console.log('Example: atris search auth');
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
  console.log('');
  console.log('Context & tracking:');
  console.log('  log        - Add ideas to inbox');
  console.log('  now        - Show atris/now.md, the current operating truth');
  console.log('  activate   - Load Atris context');
  console.log('  status     - See local work and completions (`atris status <business>` for remote)');
  console.log('  analytics  - Show recent productivity from journals');
  console.log('  search     - Search journal history (atris search <keyword>)');
  console.log('  clean      - Housekeeping (stale tasks, archive journals, broken refs)');
  console.log('  verify     - Validate work is done (tests, MAP.md, changes)');
  console.log('  task       - Local agent task plane (atomic claims, TODO import)');
  console.log('  mission    - Goal + loop + member owner + verifier + receipt');
  console.log('  release    - Tag release, bump version, create GitHub release, draft /launch');
  console.log('  learn      - Project learnings (patterns, pitfalls, preferences)');
  console.log('  brain      - Compile MAP/TODO/wiki/state into a loadable agent brain');
  console.log('  ingest     - Local-first wiki ingest into atris/wiki/');
  console.log('  query      - Local-first wiki query against atris/wiki/');
  console.log('  lint       - Local-first wiki lint for atris/wiki/');
  console.log('  loop       - Local wiki upkeep loop (stale pages, orphans, next ingest)');
  console.log('');
  console.log('Optional helpers:');
  console.log('  brainstorm - Explore ideas conversationally before planning');
  console.log('  autopilot  - Guided loop that can clarify TODOs and run plan → do → review');
  console.log('  visualize  - Generate a Slack/deck-ready visual from a prompt');
  console.log('');
  console.log('Experiments:');
  console.log('  experiments init [slug]     - Prepare atris/experiments/ or scaffold a pack');
  console.log('  experiments validate        - Validate experiment packs');
  console.log('  experiments run <slug>      - Execute a pack or record an Endstate receipt');
  console.log('  experiments benchmark [m]   - Run validate/runtime experiment benchmarks');
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
  console.log('  agent      - Select which Atris agent to use');
  console.log('  chat       - Chat with the selected Atris agent');
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
  console.log('  imessage   - Local Mac iMessage commands (doctor, recent)');
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
  console.log('Usage: atris review [--execute] [--full]');
  console.log('');
  console.log('Description:');
  console.log('  Activate the Validator agent to verify recent changes.');
  console.log('  Reads TODO.md, MAP.md, and today\'s journal, then prints a validation');
  console.log('  checklist (and, in agent mode, runs tests and updates docs).');
  console.log('');
  console.log('Options:');
  console.log('  --execute   Run in agent mode via Atris cloud (requires login + agent).');
  console.log('  --full      Print full spec/context dumps (verbose copy/paste).');
  console.log('  --verbose   Alias for --full.');
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
  console.log('  --verbose, -v    Show detailed claude output');
  console.log('  --dry-run        Show suggestions without executing');
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

// Check if this is a known command or natural language input
const knownCommands = ['init', 'log', 'now', 'status', 'analytics', 'visualize', 'brain', 'brainstorm', 'autopilot', 'run', 'plan', 'do', 'review', 'release',
                       'activate', '_activate', 'agent', 'chat', 'console', 'login', 'logout', 'whoami', 'switch', 'use', 'accounts', '_resolve', '_profile-email', '_switch-session', 'shell-init', 'update', 'upgrade', 'version', 'help', 'next', 'atris',
                       'clean', 'verify', 'search', 'skill', 'member', 'app', 'learn', 'plugin', 'experiments', 'receipt', 'proof', 'openclaw', 'pull', 'push', 'live', 'align', 'terminal', 'computer', 'diff', 'business', 'sync',
                       'ingest', 'query', 'lint', 'loop', 'task', 'mission', 'aeo',
                       'gmail', 'calendar', 'twitter', 'slack', 'imessage', 'integrations', 'setup', 'clean-workspace', 'cw',
                       'fork', 'browse', 'publish', 'sleep', 'wake', 'feedback', 'errors', 'wiki', 'code-review', 'cr', 'soul', 'fleet'];

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
  'what happened': 'status',
  'whats going on': 'status',
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

  // Build status line
  const parts = [];
  const wipCount = inProgressTasksCount + inProgressFeaturesCount;
  if (wipCount > 0) {
    parts.push(`WIP: ${wipCount}`);
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
  if (mapStatus !== 'ready') {
    console.log('');
    console.log('┌─────────────────────────────────────────────────────────────┐');
    console.log('│ BOOTSTRAP REQUIRED                                          │');
    console.log('└─────────────────────────────────────────────────────────────┘');
    console.log('');
    console.log('🗺️  Atris needs a real `atris/MAP.md` (navigation index with file:line refs).');
    console.log('');
    console.log('Copy/paste into your coding agent:');
    console.log('─────────────────────────────────────────────────────────────');
    console.log('Read `atris/atris.md`, then generate a complete `atris/MAP.md` for this repo.');
    console.log('Rules: include file:line refs, keep it grep-friendly, do NOT change code.');
    if (userInput) {
      console.log('');
      console.log('After MAP is generated, run:');
      console.log(`- atris ${userInput}`);
    } else {
      console.log('');
      console.log('Then rerun: atris');
    }
    console.log('─────────────────────────────────────────────────────────────');
    console.log('');
    return;
  }

  // Hot start - user provided input directly
  if (userInput) {
    console.log(`\n> ${userInput}`);
    await planCmd(userInput);
    return;
  }

  // Cold start - auto-advance based on current workspace state
  if (completedTasksCount > 0) {
    const preview = context.completedTasks.slice(0, 3).map((t) => (t.length > 70 ? `${t.slice(0, 67)}...` : t));
    if (preview.length > 0) {
      console.log('\nCompleted (preview):');
      preview.forEach((t) => console.log(`- ${t}`));
    }
    console.log('\nNext: atris review (pending validation)');
    await reviewCmd();
    return;
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

// ASCII Welcome Visualization
function showWelcomeVisualization() {
  const { getBacklogTasks, getInProgressTasks } = require('../lib/state-detection');
  const { getLogPath, ensureLogDirectory, createLogFile } = require('../lib/journal');
  const cwd = process.cwd();
  const atrisDir = path.join(cwd, 'atris');
  const projectName = path.basename(cwd);

  // Gather workspace stats
  let filesIndexed = 0;
  let tasksInBacklog = 0;
  let tasksInProgress = 0;
  let journalEntries = 0;
  let hasMap = false;
  let isInitialized = fs.existsSync(atrisDir);

  if (isInitialized) {
    // Auto-create today's journal if missing
    try {
      ensureLogDirectory();
      const { logFile, dateFormatted } = getLogPath();
      if (!fs.existsSync(logFile)) {
        createLogFile(logFile, dateFormatted);
      }
    } catch {
      // Silently fail - don't block welcome display
    }
    // Check MAP.md
    const mapPath = path.join(atrisDir, 'MAP.md');
    if (fs.existsSync(mapPath)) {
      hasMap = true;
      const mapContent = fs.readFileSync(mapPath, 'utf8');
      // Count file references (lines with file paths)
      const fileRefs = mapContent.match(/`[^`]+\.(js|ts|py|go|rs|md|json|yaml|yml)`/g);
      filesIndexed = fileRefs ? fileRefs.length : 0;
    }

    // Check TODO.md
    const todoPath = path.join(atrisDir, 'TODO.md');
    if (fs.existsSync(todoPath)) {
      try {
        tasksInBacklog = getBacklogTasks(atrisDir).length;
        tasksInProgress = getInProgressTasks(atrisDir).length;
      } catch {
        // Silently fail - show 0 tasks if parsing fails
      }
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
    console.log(`    │   📝 Journal: ${(journalEntries + ' entries today').padEnd(26)}│`);
    console.log('    │                                          │');
    console.log('    │   ┌──────────────────────────────────┐   │');
    console.log('    │   │  MAP.md ←──── YOU ARE HERE       │   │');
    console.log('    │   │     ↓                            │   │');
    const taskText = `${tasksInBacklog} tasks waiting`;
    console.log(`    │   │  TODO.md ←── ${taskText.padEnd(17)}│   │`);
    console.log('    │   │     ↓                            │   │');
    console.log('    │   │  navigator → executor → validator│   │');
    console.log('    │   └──────────────────────────────────┘   │');
    console.log('    │                                          │');
    console.log('    └──────────────────────────────────────────┘');
  }
  console.log('');
  console.log(`    Ready. Run 'atris plan' to start.`);
  console.log('');
}

if (command === 'init') {
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
} else if (command === 'aeo') {
  // AEO: AI Engine Optimization — credit-metered citation drafting against the customer workspace.
  Promise.resolve(require('../commands/aeo').run(process.argv.slice(3)))
    .then(() => process.exit(0))
    .catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'brain') {
  Promise.resolve(require('../commands/brain').brainCommand(process.argv.slice(3)))
    .then(() => process.exit(0))
    .catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); });
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
  } else if (subcommand && subcommand !== '--help' && !subcommand.startsWith('-')) {
    // Business log: atris log <business-slug>
    require('../commands/context-sync').businessLog(subcommand)
      .then(() => process.exit(0))
      .catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); });
  } else {
    logCmd();
  }
} else if (command === 'now') {
  require('../commands/now').nowAtris(process.argv.slice(3));
} else if (command === 'activate') {
  activateCmd();
} else if (command === 'update' || command === 'sync') {
  const firstSyncArg = process.argv[3];
  const isBusinessSync = command === 'sync'
    && (
      fs.existsSync(path.join(process.cwd(), '.atris', 'business.json'))
      || isBusinessSyncSafetyCommand
      || (firstSyncArg && !firstSyncArg.startsWith('-'))
    )
    && firstSyncArg !== 'all';
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
  upgradeAtris().then(() => process.exit(0)).catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'chat') {
  chatAtris()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(`✗ Chat failed: ${error.message || error}`);
      process.exit(1);
    });
} else if (command === 'console') {
  consoleCmd();
} else if (command === 'serve') {
  // Start the local AI Computer bridge — make this directory addressable
  // by cloud agents via the Atris API
  const serveArgs = process.argv.slice(3);
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
  require('../commands/auth').loginAtris();
} else if (command === 'logout') {
  require('../commands/auth').logoutAtris();
} else if (command === 'whoami') {
  require('../commands/auth').whoamiAtris();
} else if (command === 'switch') {
  require('../commands/auth').switchAccount();
} else if (command === 'use') {
  require('../commands/auth').useAccount();
} else if (command === 'accounts') {
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
  if (args.includes('--help') || args.includes('-h')) {
    console.log('');
    console.log('Usage: atris run [options]');
    console.log('');
    console.log('Auto-chain plan → do → review cycles autonomously.');
    console.log('Reads inbox ideas, creates tasks, builds them, validates, repeats.');
    console.log('');
    console.log('Options:');
    console.log('  --cycles=N    Max cycles (default: 5)');
    console.log('  --once        Single plan→do→review cycle');
    console.log('  --verbose     Show claude -p output');
    console.log('  --dry-run     Preview without executing');
    console.log('  --timeout=N   Phase timeout in seconds (default: 600)');
    console.log('  --push        Auto-push after each cycle (default: true)');
    console.log('  --no-push     Skip auto-push after each cycle');
    console.log('');
    process.exit(0);
  }

  const verbose = args.includes('--verbose') || args.includes('-v');
  const dryRun = args.includes('--dry-run');
  const once = args.includes('--once');
  const push = !args.includes('--no-push');
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
  if (args.includes('--help') || args.includes('-h')) {
    showAutopilotHelp();
    process.exit(0);
  }

  // Parse options
  const verbose = args.includes('--verbose') || args.includes('-v');
  const dryRun = args.includes('--dry-run');
  const auto = args.includes('--auto');
  const maxIterationsArg = args.find(a => a.startsWith('--iterations='));
  const maxIterations = maxIterationsArg ? parseInt(maxIterationsArg.split('=')[1]) : undefined;
  const durationArg = args.find(a => a.startsWith('--duration='));
  const duration = durationArg ? durationArg.split('=')[1] : null;

  // Get description (non-flag args)
  const description = args.filter(a => !a.startsWith('-')).join(' ').trim() || null;

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
  require('../commands/analytics').analyticsAtris();
} else if (command === 'clean') {
  const dryRun = process.argv.includes('--dry-run') || process.argv.includes('-n');
  require('../commands/clean').cleanAtris({ dryRun });
} else if (command === 'verify') {
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
  const dryRun = process.argv.includes('--dry-run');
  require('../commands/release').releaseAtris({ dryRun })
    .then(() => process.exit(0))
    .catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'search') {
  const keyword = process.argv.slice(3).join(' ');
  searchJournal(keyword);
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
  const { integrationsStatus } = require('../commands/integrations');
  integrationsStatus()
    .then(() => process.exit(0))
    .catch((err) => { console.error(`✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'learn') {
  const subcommand = process.argv[3];
  const args = process.argv.slice(4);
  require('../commands/learn')(subcommand, ...args);
} else if (command === 'skill') {
  const subcommand = process.argv[3];
  const args = process.argv.slice(4);
  require('../commands/skill').skillCommand(subcommand, ...args);
} else if (command === 'member') {
  const subcommand = process.argv[3];
  const args = process.argv.slice(4);
  require('../commands/member').memberCommand(subcommand, ...args);
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
} else if (command === 'computer') {
  require('../commands/computer').runComputer()
    .then(() => process.exit(0))
    .catch((err) => { console.error(`\n✗ Error: ${err.message || err}`); process.exit(1); });
} else if (command === 'diff') {
  let diffSlug = process.argv[3];
  if (!diffSlug || diffSlug.startsWith('-')) {
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
} else if (command === 'receipt' || command === 'proof' || command === 'openclaw') {
  const subcommand = process.argv[3];
  const args = process.argv.slice(4);
  require('../commands/proof').proofCommand(subcommand, ...args);
} else if (command === 'setup') {
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

async function agentAtris() {
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
