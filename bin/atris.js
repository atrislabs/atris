#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { exec, spawnSync } = require('child_process');
const readline = require('readline');
const os = require('os');
const https = require('https');
const http = require('http');
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

const DEFAULT_CLIENT_ID = `AtrisCLI/${CLI_VERSION}`;
const DEFAULT_USER_AGENT = `${DEFAULT_CLIENT_ID} (node ${process.version}; ${os.platform()} ${os.release()} ${os.arch()})`;

// Update check utility
const { checkForUpdates, showUpdateNotification, autoUpdate } = require('../utils/update-check');

// State detection for smart default
const { detectWorkspaceState, loadContext } = require('../lib/state-detection');

// Run update check in background (non-blocking)
// Skip for 'version' and 'update' commands to avoid redundant messages
let updateCheckPromise = null;
const skipUpdateCheck = Boolean(process.env.ATRIS_SKIP_UPDATE_CHECK || process.env.NO_UPDATE_NOTIFIER);
if (!skipUpdateCheck && (!process.argv[2] || (process.argv[2] && !['version', 'update', 'help'].includes(process.argv[2])))) {
  updateCheckPromise = checkForUpdates()
    .then((updateInfo) => {
      // Show notification if update available (after command completes)
      if (updateInfo) {
        // Auto-update in background, fall back to notification if it fails
        setTimeout(() => {
          if (!autoUpdate(updateInfo)) {
            showUpdateNotification(updateInfo);
          }
        }, 100);
      }
      return updateInfo;
    })
    .catch(() => {
      // Silently fail - don't annoy users with update check errors
      return null;
    });
}

const command = process.argv[2];

// Auto-sync skills on every command (fast — just file diffs, no network)
try {
  const { syncSkills } = require('../commands/sync');
  const skillsUpdated = syncSkills({ silent: true });
  if (skillsUpdated > 0) {
    console.log(`⬆️  ${skillsUpdated} skill${skillsUpdated > 1 ? 's' : ''} updated`);
  }
} catch (e) {
  // Non-critical
}

const TOKEN_REFRESH_BUFFER_SECONDS = 300; // Refresh ~5 minutes before expiry

function decodeJwtClaims(token) {
  if (!token || typeof token !== 'string') {
    return null;
  }
  const parts = token.split('.');
  if (parts.length < 2) {
    return null;
  }
  try {
    const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
    const decoded = Buffer.from(padded, 'base64').toString('utf8');
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

function getTokenExpiryEpochSeconds(token) {
  const claims = decodeJwtClaims(token);
  if (!claims || typeof claims.exp !== 'number') {
    return null;
  }
  return claims.exp;
}

function shouldRefreshToken(token, bufferSeconds = TOKEN_REFRESH_BUFFER_SECONDS) {
  const exp = getTokenExpiryEpochSeconds(token);
  if (!exp) {
    return false;
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  return exp <= nowSeconds + bufferSeconds;
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
    const files = fs.readdirSync(dir);
    for (const file of files) {
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
  console.log('atrisDev — The new way to build with AI');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
  console.log('Quick Start:');
  console.log('');
  console.log('  1. atris                  Load context, start building');
  console.log('  2. Describe what you want (in your editor or terminal)');
  console.log('  3. Agent shows visualization, you approve, it builds');
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
  console.log('Setup:');
  console.log('  init       - Initialize Atris in current project');
  console.log('  update     - Update local files to latest version');
  console.log('  upgrade    - Install latest Atris from npm');
  console.log('');
  console.log('Core workflow:');
  console.log('  plan       - Create build spec with visualization');
  console.log('  do         - Execute tasks');
  console.log('  review     - Validate work (tests, safety checks, docs)');
  console.log('');
  console.log('Context & tracking:');
  console.log('  log        - Add ideas to inbox');
  console.log('  activate   - Load Atris context');
  console.log('  status     - See active work and completions');
  console.log('  analytics  - Show recent productivity from journals');
  console.log('  search     - Search journal history (atris search <keyword>)');
  console.log('  clean      - Housekeeping (stale tasks, archive journals, broken refs)');
  console.log('  verify     - Validate work is done (tests, MAP.md, changes)');
  console.log('');
  console.log('Optional helpers:');
  console.log('  brainstorm - Explore ideas conversationally before planning');
  console.log('  autopilot  - Guided loop that can clarify TODOs and run plan → do → review');
  console.log('  visualize  - Legacy visualization helper (prefer "atris plan")');
  console.log('');
  console.log('Quick commands:');
  console.log('  atris      - Load context and start (natural language)');
  console.log('  next       - Auto-advance to next step');
  console.log('');
  console.log('Cloud & agents:');
  console.log('  console    - Start/attach always-on coding console (tmux daemon)');
  console.log('  agent      - Select which Atris agent to use');
  console.log('  chat       - Chat with the selected Atris agent');
  console.log('  login      - Authenticate (use --token <t> for non-interactive)');
  console.log('  logout     - Remove credentials');
  console.log('  whoami     - Show auth status');
  console.log('  switch     - Switch account (atris switch <name>)');
  console.log('  accounts   - List saved accounts');
  console.log('');
  console.log('Integrations:');
  console.log('  gmail      - Email commands (inbox, read)');
  console.log('  calendar   - Calendar commands (today, week)');
  console.log('  twitter    - Twitter commands (post)');
  console.log('  slack      - Slack commands (channels)');
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
  console.log('Usage: atris autopilot "description" [options]');
  console.log('       atris autopilot --from-todo [options]');
  console.log('');
  console.log('Description:');
  console.log('  PRD-driven autonomous execution using claude -p.');
  console.log('  Runs plan → do → review cycles until acceptance criteria are met.');
  console.log('');
  console.log('Options:');
  console.log('  --bug            Treat as bug fix (different acceptance criteria)');
  console.log('  --from-todo      Pick next item from TODO.md backlog');
  console.log('  --iterations=N   Max iterations before stopping (default: 5)');
  console.log('  --verbose, -v    Show detailed claude output');
  console.log('  --dry-run        Generate PRD without executing');
  console.log('');
  console.log('Examples:');
  console.log('  atris autopilot "Add dark mode toggle"');
  console.log('  atris autopilot --bug "Login fails on Safari"');
  console.log('  atris autopilot --from-todo --iterations=3');
  console.log('');
  console.log('Output:');
  console.log('  - prd.json: PRD with acceptance criteria');
  console.log('  - progress.txt: Execution log');
  console.log('  - Journal: Completion logged to today\'s journal');
  console.log('');
}

if (command === 'help' || command === '--help' || command === '-h') {
  showHelp();
  process.exit(0);
}

// Command handlers - must load BEFORE interactiveEntry() is called (TDZ issue)
const { initAtris: initCmd } = require('../commands/init');
const { syncAtris: syncCmd } = require('../commands/sync');
const { logAtris: logCmd } = require('../commands/log');
const { logSyncAtris: logSyncCmd } = require('../commands/log-sync');
const { loginAtris: loginCmd, logoutAtris: logoutCmd, whoamiAtris: whoamiCmd, switchAccount: switchCmd, listAccountsCmd: accountsCmd } = require('../commands/auth');
const { showVersion: versionCmd } = require('../commands/version');
const { planAtris: planCmd, doAtris: doCmd, reviewAtris: reviewCmd } = require('../commands/workflow');
const { visualizeAtris: visualizeCmd } = require('../commands/visualize');
const { brainstormAtris: brainstormCmd } = require('../commands/brainstorm');
const { autopilotAtris: autopilotCmd, autopilotFromTodo: autopilotFromTodoCmd } = require('../commands/autopilot');
const { activateAtris: activateCmd } = require('../commands/activate');
const { statusAtris: statusCmd } = require('../commands/status');
const { analyticsAtris: analyticsCmd } = require('../commands/analytics');
const { cleanAtris: cleanCmd } = require('../commands/clean');
const { verifyAtris: verifyCmd } = require('../commands/verify');
const { skillCommand: skillCmd } = require('../commands/skill');
const { memberCommand: memberCmd } = require('../commands/member');
const { pluginCommand: pluginCmd } = require('../commands/plugin');

// Check if this is a known command or natural language input
const knownCommands = ['init', 'log', 'status', 'analytics', 'visualize', 'brainstorm', 'autopilot', 'plan', 'do', 'review',
                       'activate', 'agent', 'chat', 'console', 'login', 'logout', 'whoami', 'switch', 'accounts', 'update', 'upgrade', 'version', 'help', 'next', 'atris',
                       'clean', 'verify', 'search', 'skill', 'member', 'plugin',
                       'gmail', 'calendar', 'twitter', 'slack', 'integrations'];

// Check if command is an atris.md spec file - triggers welcome visualization
function isSpecFile(cmd) {
  if (!cmd) return false;
  return cmd === 'atris.md' || cmd.endsWith('/atris.md') || cmd.endsWith('\\atris.md');
}

if (isSpecFile(command)) {
  showWelcomeVisualization();
  process.exit(0);
}

// If no command OR command is not recognized, treat as natural language
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
} else if (command === 'agent') {
  agentAtris();
} else if (command === 'log') {
  const subcommand = process.argv[3];
  if (subcommand === 'sync') {
    logSyncCmd()
      .then(() => process.exit(0))
      .catch((error) => {
        console.error(`✗ Log sync failed: ${error.message || error}`);
        process.exit(1);
      });
  } else {
    logCmd();
  }
} else if (command === 'activate') {
  activateCmd();
} else if (command === 'update') {
  syncCmd();
} else if (command === 'upgrade') {
  upgradeAtris();
} else if (command === 'chat') {
  chatAtris()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(`✗ Chat failed: ${error.message || error}`);
      process.exit(1);
    });
} else if (command === 'console') {
  consoleCmd();
} else if (command === 'version') {
  versionCmd();
} else if (command === 'login') {
  loginCmd();
} else if (command === 'logout') {
  logoutCmd();
} else if (command === 'whoami') {
  whoamiCmd();
} else if (command === 'switch') {
  switchCmd();
} else if (command === 'accounts') {
  accountsCmd();
} else if (command === 'visualize') {
  console.log('ℹ️  "atris visualize" is a legacy helper. Visualization is now built into "atris plan".');
  console.log('   Prefer: atris plan');
  console.log('');
  visualizeCmd();
} else if (command === 'autopilot') {
  const args = process.argv.slice(3);
  if (args.includes('--help') || args.includes('-h')) {
    showAutopilotHelp();
    process.exit(0);
  }

  // Parse options
  const isBug = args.includes('--bug');
  const fromTodo = args.includes('--from-todo');
  const verbose = args.includes('--verbose') || args.includes('-v');
  const dryRun = args.includes('--dry-run');
  const maxIterationsArg = args.find(a => a.startsWith('--iterations='));
  const maxIterations = maxIterationsArg ? parseInt(maxIterationsArg.split('=')[1]) : 5;

  // Get description (non-flag args)
  const description = args.filter(a => !a.startsWith('-')).join(' ').trim();

  const options = {
    type: isBug ? 'bug' : 'feature',
    maxIterations,
    verbose,
    dryRun
  };

  let promise;
  if (fromTodo) {
    promise = autopilotFromTodoCmd(options);
  } else if (description) {
    promise = autopilotCmd(description, options);
  } else {
    console.log('Usage: atris autopilot "description" [--bug] [--verbose] [--iterations=N]');
    console.log('       atris autopilot --from-todo');
    console.log('');
    console.log('Run `atris autopilot --help` for more options.');
    process.exit(1);
  }

  promise
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(`✗ Autopilot failed: ${error.message || error}`);
      process.exit(1);
    });
} else if (command === 'brainstorm') {
  brainstormCmd()
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
  const isQuick = process.argv.includes('--quick') || process.argv.includes('-q');
  statusCmd(isQuick);
} else if (command === 'analytics') {
  analyticsCmd();
} else if (command === 'clean') {
  const dryRun = process.argv.includes('--dry-run') || process.argv.includes('-n');
  cleanCmd({ dryRun });
} else if (command === 'verify') {
  const taskId = process.argv[3] || null;
  verifyCmd(taskId);
} else if (command === 'search') {
  const keyword = process.argv.slice(3).join(' ');
  searchJournal(keyword);
} else if (command === 'gmail') {
  const { gmailCommand } = require('../commands/integrations');
  const subcommand = process.argv[3];
  const args = process.argv.slice(4);
  gmailCommand(subcommand, ...args)
    .then(() => process.exit(0))
    .catch((err) => { console.error(err.message); process.exit(1); });
} else if (command === 'calendar') {
  const { calendarCommand } = require('../commands/integrations');
  const subcommand = process.argv[3];
  const args = process.argv.slice(4);
  calendarCommand(subcommand, ...args)
    .then(() => process.exit(0))
    .catch((err) => { console.error(err.message); process.exit(1); });
} else if (command === 'twitter') {
  const { twitterCommand } = require('../commands/integrations');
  const subcommand = process.argv[3];
  const args = process.argv.slice(4);
  twitterCommand(subcommand, ...args)
    .then(() => process.exit(0))
    .catch((err) => { console.error(err.message); process.exit(1); });
} else if (command === 'slack') {
  const { slackCommand } = require('../commands/integrations');
  const subcommand = process.argv[3];
  const args = process.argv.slice(4);
  slackCommand(subcommand, ...args)
    .then(() => process.exit(0))
    .catch((err) => { console.error(err.message); process.exit(1); });
} else if (command === 'integrations') {
  const { integrationsStatus } = require('../commands/integrations');
  integrationsStatus()
    .then(() => process.exit(0))
    .catch((err) => { console.error(err.message); process.exit(1); });
} else if (command === 'skill') {
  const subcommand = process.argv[3];
  const args = process.argv.slice(4);
  skillCmd(subcommand, ...args);
} else if (command === 'member') {
  const subcommand = process.argv[3];
  const args = process.argv.slice(4);
  memberCmd(subcommand, ...args);
} else if (command === 'plugin') {
  const subcommand = process.argv[3] || 'build';
  const args = process.argv.slice(4);
  pluginCmd(subcommand, ...args);
} else {
  console.log(`Unknown command: ${command}`);
  console.log('Run "atris help" to see available commands');
  process.exit(1);
}

// NOTE: initAtris, syncAtris, logAtris, appendLog, logSyncAtris, showTodayLog, showRecentLogs
// are legacy inline implementations. Routing now uses require('../commands/...') instead.
// The journal utilities (getLogPath, ensureLogDirectory, createLogFile) are still used by
// top-level code at lines ~393 and ~2553 via hoisting — do not remove without migrating those.
function initAtris() {
  const targetDir = path.join(process.cwd(), 'atris');
  const teamDir = path.join(targetDir, 'team');
  const sourceFile = path.join(__dirname, '..', 'atris.md');
  const targetFile = path.join(targetDir, 'atris.md');

  // Create atris/ folder structure
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
    console.log('✓ Created atris/ folder');
  } else {
    console.log('✓ atris/ folder already exists');
  }

  // Create team/ subfolder
  if (!fs.existsSync(teamDir)) {
    fs.mkdirSync(teamDir, { recursive: true });
    console.log('✓ Created atris/team/ folder');
  }

  // Create policies/ subfolder
  const policiesDir = path.join(targetDir, 'policies');
  if (!fs.existsSync(policiesDir)) {
    fs.mkdirSync(policiesDir, { recursive: true });
    console.log('✓ Created atris/policies/ folder');
  }

  // Create placeholder files
  const gettingStartedFile = path.join(targetDir, 'GETTING_STARTED.md');
  const personaFile = path.join(targetDir, 'PERSONA.md');
  const mapFile = path.join(targetDir, 'MAP.md');
  const taskContextsFile = path.join(targetDir, 'TASK_CONTEXTS.md');
  const navigatorFile = path.join(teamDir, 'navigator.md');
  const executorFile = path.join(teamDir, 'executor.md');
  const validatorFile = path.join(teamDir, 'validator.md');
  const launcherFile = path.join(teamDir, 'launcher.md');

  const gettingStartedSource = path.join(__dirname, '..', 'GETTING_STARTED.md');
  const personaSource = path.join(__dirname, '..', 'PERSONA.md');

  // Copy GETTING_STARTED.md
  if (!fs.existsSync(gettingStartedFile) && fs.existsSync(gettingStartedSource)) {
    fs.copyFileSync(gettingStartedSource, gettingStartedFile);
    console.log('✓ Created GETTING_STARTED.md');
  }

  // Copy PERSONA.md
  if (!fs.existsSync(personaFile) && fs.existsSync(personaSource)) {
    fs.copyFileSync(personaSource, personaFile);
    console.log('✓ Created PERSONA.md');
  }

  if (!fs.existsSync(mapFile)) {
    fs.writeFileSync(mapFile, '# MAP.md\n\n> Generated by your AI agent after reading atris.md\n\nRun your AI agent with atris.md to populate this file.\n');
    console.log('✓ Created MAP.md placeholder');
  }

  if (!fs.existsSync(taskContextsFile)) {
    fs.writeFileSync(taskContextsFile, '# TASK_CONTEXTS.md\n\n> Generated by your AI agent after reading atris.md\n\nRun your AI agent with atris.md to populate this file.\n');
    console.log('✓ Created TASK_CONTEXTS.md placeholder');
  }

  // Copy agent templates from package (MEMBER.md directory format)
  const members = ['navigator', 'executor', 'validator', 'launcher', 'brainstormer', 'researcher'];
  members.forEach(name => {
    const sourceFile = path.join(__dirname, '..', 'atris', 'team', name, 'MEMBER.md');
    const memberDir = path.join(teamDir, name);
    const targetFile = path.join(memberDir, 'MEMBER.md');
    const legacyFile = path.join(teamDir, `${name}.md`);

    if (fs.existsSync(targetFile) || fs.existsSync(legacyFile)) return;

    if (fs.existsSync(sourceFile)) {
      fs.mkdirSync(memberDir, { recursive: true });
      fs.copyFileSync(sourceFile, targetFile);
      console.log(`✓ Created team/${name}/MEMBER.md`);
    }
  });

  // Copy policies from package
  const antislopSource = path.join(__dirname, '..', 'atris', 'policies', 'ANTISLOP.md');
  const antislopFile = path.join(policiesDir, 'ANTISLOP.md');
  if (!fs.existsSync(antislopFile) && fs.existsSync(antislopSource)) {
    fs.copyFileSync(antislopSource, antislopFile);
    console.log('✓ Created policies/ANTISLOP.md');
  }

  // Copy atris.md to the folder
  if (fs.existsSync(sourceFile)) {
    fs.copyFileSync(sourceFile, targetFile);
    console.log('✓ Copied atris.md to atris/ folder');
    console.log('\nAtris initialized. Structure created:');
    console.log('   atris/');
    console.log('   ├── GETTING_STARTED.md (read this first!)');
    console.log('   ├── PERSONA.md (agent personality)');
    console.log('   ├── atris.md (AI agent instructions)');
    console.log('   ├── MAP.md (placeholder)');
    console.log('   ├── TASK_CONTEXTS.md (placeholder)');
    console.log('   ├── team/');
    console.log('   │   ├── navigator.md');
    console.log('   │   ├── executor.md');
    console.log('   │   ├── validator.md');
    console.log('   │   └── launcher.md');
    console.log('   └── policies/');
    console.log('       └── ANTISLOP.md (output quality checklist)');
    console.log('\nNext steps:');
    console.log('1. Read atris/GETTING_STARTED.md for the full guide');
    console.log('2. Open atris/atris.md and paste it to your AI agent');
    console.log('3. Your agent will populate all placeholder files in ~10 mins');
  } else {
    console.error('✗ Error: atris.md not found in package');
    process.exit(1);
  }
}

function syncAtris() {
  const targetDir = path.join(process.cwd(), 'atris');
  const teamDir = path.join(targetDir, 'team');

  // Check if atris/ folder exists
  if (!fs.existsSync(targetDir)) {
    console.error('✗ Error: atris/ folder not found. Run "atris init" first.');
    process.exit(1);
  }

  // Ensure team folder exists
  if (!fs.existsSync(teamDir)) {
    fs.mkdirSync(teamDir, { recursive: true });
  }

  // Ensure policies folder exists
  const policiesDir = path.join(targetDir, 'policies');
  if (!fs.existsSync(policiesDir)) {
    fs.mkdirSync(policiesDir, { recursive: true });
    console.log('✓ Created atris/policies/ folder');
  }

  // Files to sync
  const filesToSync = [
    { source: 'atris.md', target: 'atris.md' },
    { source: 'atrisDev.md', target: 'atrisDev.md' },
    { source: 'PERSONA.md', target: 'PERSONA.md' },
    { source: 'GETTING_STARTED.md', target: 'GETTING_STARTED.md' },
    { source: 'atris/team/navigator/MEMBER.md', target: 'team/navigator/MEMBER.md' },
    { source: 'atris/team/executor/MEMBER.md', target: 'team/executor/MEMBER.md' },
    { source: 'atris/team/validator/MEMBER.md', target: 'team/validator/MEMBER.md' },
    { source: 'atris/team/launcher/MEMBER.md', target: 'team/launcher/MEMBER.md' },
    { source: 'atris/team/brainstormer/MEMBER.md', target: 'team/brainstormer/MEMBER.md' },
    { source: 'atris/team/researcher/MEMBER.md', target: 'team/researcher/MEMBER.md' },
    { source: 'atris/policies/ANTISLOP.md', target: 'policies/ANTISLOP.md' }
  ];

  let updated = 0;
  let skipped = 0;

  filesToSync.forEach(({ source, target }) => {
    const sourceFile = path.join(__dirname, '..', source);
    const targetFile = path.join(targetDir, target);

    if (!fs.existsSync(sourceFile)) {
      console.log(`⚠ Skipping ${source} (not found in package)`);
      return;
    }

    const currentContent = fs.existsSync(targetFile) ? fs.readFileSync(targetFile, 'utf8') : '';
    const newContent = fs.readFileSync(sourceFile, 'utf8');

    if (currentContent === newContent) {
      skipped++;
      return;
    }

    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.copyFileSync(sourceFile, targetFile);
    console.log(`✓ Updated ${target}`);
    updated++;
  });

  if (updated === 0) {
    console.log('✓ Already up to date');
  } else {
    console.log(`\n✓ Updated ${updated} file(s), ${skipped} unchanged`);
    console.log('\nRun your AI agent again to use the latest specs and agent templates.');
  }
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

// ============================================
// Log System
// ============================================

function getLogPath(dateStr) {
  const targetDir = path.join(process.cwd(), 'atris');
  const date = dateStr ? new Date(dateStr) : new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const dateFormatted = `${year}-${month}-${day}`; // YYYY-MM-DD in local time

  const logsDir = path.join(targetDir, 'logs');
  const yearDir = path.join(logsDir, year.toString());
  const logFile = path.join(yearDir, `${dateFormatted}.md`);

  return { logsDir, yearDir, logFile, dateFormatted };
}

function ensureLogDirectory() {
  const { logsDir, yearDir } = getLogPath();

  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }

  if (!fs.existsSync(yearDir)) {
    fs.mkdirSync(yearDir, { recursive: true });
  }
}

function createLogFile(logFile, dateFormatted) {
  let carryInProgress = '';
  let carryBacklog = '';
  let carryInbox = '';

  try {
    const [y, m, d] = String(dateFormatted).split('-').map(Number);
    if (Number.isFinite(y) && Number.isFinite(m) && Number.isFinite(d)) {
      const prev = new Date(y, m - 1, d);
      prev.setDate(prev.getDate() - 1);

      const prevYear = prev.getFullYear();
      const prevMonth = String(prev.getMonth() + 1).padStart(2, '0');
      const prevDay = String(prev.getDate()).padStart(2, '0');
      const prevDateFormatted = `${prevYear}-${prevMonth}-${prevDay}`;
      const prevLogFile = path.join(process.cwd(), 'atris', 'logs', prevYear.toString(), `${prevDateFormatted}.md`);

      if (fs.existsSync(prevLogFile)) {
        const prevContent = fs.readFileSync(prevLogFile, 'utf8');

        const escapeRegExp = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const sectionBody = (headingLine) => {
          const regex = new RegExp(
            `## ${escapeRegExp(headingLine)}\\n([\\s\\S]*?)(?=\\n---|\\n## |$)`
          );
          const match = prevContent.match(regex);
          return match ? match[1].trim() : '';
        };

        carryInProgress = sectionBody('In Progress 🔄');
        carryBacklog = sectionBody('Backlog');
        carryInbox = sectionBody('Inbox');
      }
    }
  } catch {
    // Best-effort carry-forward; never block journal creation.
  }

  const inProgressBody = carryInProgress ? `${carryInProgress}\n\n` : '';
  const backlogBody = carryBacklog ? `${carryBacklog}\n\n` : '';
  const inboxBody = carryInbox ? `${carryInbox}\n\n` : '';

  const initialContent = `# Log — ${dateFormatted}\n\n## Completed ✅\n\n---\n\n## In Progress 🔄\n\n${inProgressBody}---\n\n## Backlog\n\n${backlogBody}---\n\n## Notes\n\n---\n\n## Inbox\n\n${inboxBody}\n`;
  fs.writeFileSync(logFile, initialContent);
}

function logAtris() {
  const targetDir = path.join(process.cwd(), 'atris');

  // Check if atris/ folder exists
  if (!fs.existsSync(targetDir)) {
    console.error('✗ Error: atris/ folder not found. Run "atris init" first.');
    process.exit(1);
  }

  // Ensure log directory exists
  ensureLogDirectory();
  const { logFile, dateFormatted } = getLogPath();

  // Create log file if doesn't exist
  if (!fs.existsSync(logFile)) {
    createLogFile(logFile, dateFormatted);
  }

  // Start interactive logging session
  console.log(`┌─────────────────────────────────────────────────────────┐`);
  console.log(`│ Daily Log — ${dateFormatted}              [type "exit" to quit] │`);
  console.log(`└─────────────────────────────────────────────────────────┘`);
  console.log('');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '> '
  });

  rl.prompt();

  rl.on('line', (line) => {
    const input = line.trim();

    if (input.toLowerCase() === 'exit') {
      console.log('\n✓ Log saved');
      rl.close();
      process.exit(0);
    }

    if (input) {
      const entry = `- ${input}\n`;
      fs.appendFileSync(logFile, entry);
    }

    rl.prompt();
  });

  rl.on('close', () => {
    process.exit(0);
  });
}

function appendLog(message) {
  ensureLogDirectory();
  const { logFile, dateFormatted } = getLogPath();

  // Create log file if doesn't exist
  if (!fs.existsSync(logFile)) {
    createLogFile(logFile, dateFormatted);
    console.log(`✓ Created log for ${dateFormatted}`);
  }

  // Append message with timestamp
  const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
  const entry = `**${timestamp}** — ${message}\n\n`;

  fs.appendFileSync(logFile, entry);
  console.log(`✓ Added to ${dateFormatted} log`);
}

async function logSyncAtris() {
  const targetDir = path.join(process.cwd(), 'atris');

  if (!fs.existsSync(targetDir)) {
    throw new Error('atris/ folder not found. Run "atris init" first.');
  }

  // Determine date (today by default, allow optional 4th arg or --date=)
  let dateArg = process.argv[4];
  if (dateArg && dateArg.startsWith('--date=')) {
    dateArg = dateArg.split('=')[1];
  }

  let { logsDir, yearDir, logFile, dateFormatted } = getLogPath(dateArg);
  if (Number.isNaN(new Date(dateFormatted).getTime())) {
    throw new Error(`Invalid date provided: ${dateArg}`);
  }

  // Ensure log directory and file exist
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }
  if (!fs.existsSync(yearDir)) {
    fs.mkdirSync(yearDir, { recursive: true });
  }
  if (!fs.existsSync(logFile)) {
    createLogFile(logFile, dateFormatted);
    console.log(`Created local log template for ${dateFormatted}. Fill it in before syncing.`);
  }

  let localContent = fs.readFileSync(logFile, 'utf8');
  const localHash = computeContentHash(localContent);

  // Ensure agent selected
  const config = loadConfig();
  if (!config.agent_id) {
    throw new Error('No agent selected. Run "atris agent" first.');
  }

  // Ensure credentials
  const ensured = await ensureValidCredentials();
  if (ensured.error) {
    if (ensured.error === 'not_logged_in') {
      throw new Error('Not logged in. Run "atris login" first.');
    }
    if (ensured.detail && ensured.detail.toLowerCase().includes('enotfound')) {
      throw new Error('Unable to reach Atris API. Check your network connection.');
    }
    throw new Error(ensured.detail || ensured.error || 'Authentication failed');
  }

  const credentials = ensured.credentials;
  const agentId = config.agent_id;
  const agentLabel = config.agent_name || agentId;

  console.log(`🔄 Syncing log for ${dateFormatted} with agent "${agentLabel}"`);

  // Check existing remote entry (best effort)
  const syncState = loadLogSyncState();
  const knownRemoteUpdate = syncState[dateFormatted]?.updated_at || null;
  const knownRemoteHash = syncState[dateFormatted]?.hash || null;

  let remoteExists = false;
  let remoteUpdatedAt = null;
  let remoteContent = null;
  let remoteHash = null;
  const existing = await apiRequestJson(`/agents/${agentId}/journal/${dateFormatted}`, {
    method: 'GET',
    token: credentials.token,
  });

  if (existing.ok) {
    remoteExists = true;
    remoteUpdatedAt = existing.data?.updated_at || existing.data?.created_at || null;
    remoteContent = typeof existing.data?.content === 'string' ? existing.data.content : null;
    remoteHash = remoteContent ? computeContentHash(remoteContent) : null;

    // Bidirectional sync: check if remote is newer
    if (remoteUpdatedAt) {
      const localStats = fs.statSync(logFile);
      const localModified = localStats.mtime.toISOString();
      const remoteTime = new Date(remoteUpdatedAt).getTime();
      const localTime = new Date(localModified).getTime();

      const remoteMatchesKnown = (knownRemoteUpdate && isSameTimestamp(remoteUpdatedAt, knownRemoteUpdate))
        || (remoteHash && knownRemoteHash && remoteHash === knownRemoteHash);

      if (remoteTime > localTime && !remoteMatchesKnown) {
        const normalizedRemote = remoteContent ? remoteContent.replace(/\r\n/g, '\n') : null;
        const normalizedLocal = localContent.replace(/\r\n/g, '\n');
        if (normalizedRemote !== null && normalizedRemote.trim() === normalizedLocal.trim()) {
          const remoteDate = new Date(remoteUpdatedAt);
          if (!Number.isNaN(remoteDate.getTime())) {
            fs.utimesSync(logFile, remoteDate, remoteDate);
            const state = loadLogSyncState();
            state[dateFormatted] = {
              updated_at: remoteUpdatedAt,
              hash: remoteHash || knownRemoteHash || computeContentHash(remoteContent || ''),
            };
            saveLogSyncState(state);
          }
          console.log('✓ Already synced (timestamps aligned with web)');
          return;
        }

        // Try section-based merge
        try {
          const localSections = parseJournalSections(normalizedLocal);
          const remoteSections = parseJournalSections(normalizedRemote || '');
          const { merged, conflicts } = mergeSections(localSections, remoteSections, knownRemoteHash);

          if (conflicts.length === 0) {
            // Clean merge - auto-merge and continue
            const mergedContent = reconstructJournal(merged);
            fs.writeFileSync(logFile, mergedContent, 'utf8');
            console.log('✓ Auto-merged web and local changes');
            console.log(`   Merged sections: ${Object.keys(merged).filter(k => k !== '__header__').join(', ')}`);
            // Update local content for push
            localContent = mergedContent;
          } else {
            // Conflicts detected - prompt user
            console.log('⚠️  Conflicting changes in same section(s)');
            console.log(`   Conflicts: ${conflicts.join(', ')}`);
            console.log(`   Remote updated: ${remoteUpdatedAt}`);
            console.log(`   Local modified: ${localModified}`);
            console.log('   Type "y" to replace local with web version, or "n" to keep local changes.');
            console.log('');

            if (typeof remoteContent === 'string') {
              showLogDiff(logFile, remoteContent);
            }

            const answer = await promptUser('Overwrite local with web version? (y/n): ');

            if (answer && answer.toLowerCase() === 'y') {
              // Pull remote content
              const pulledContent = existing.data?.content || '';
              fs.writeFileSync(logFile, pulledContent, 'utf8');
              remoteHash = computeContentHash(pulledContent);
              console.log('✓ Local journal updated from web');
              console.log(`🗒️  File: ${path.relative(process.cwd(), logFile)}`);
              if (remoteUpdatedAt) {
                const remoteDate = new Date(remoteUpdatedAt);
                if (!Number.isNaN(remoteDate.getTime())) {
                  fs.utimesSync(logFile, remoteDate, remoteDate);
                }
                const state = loadLogSyncState();
                state[dateFormatted] = {
                  updated_at: remoteUpdatedAt,
                  hash: remoteHash || computeContentHash(pulledContent),
                };
                saveLogSyncState(state);
              }
              return;
            } else {
              console.log('⏩ Keeping local version, will push to web');
            }
          }
        } catch (parseError) {
          // Fallback to old prompt behavior if parsing fails
          console.log('⚠️  Web version is newer than local version');
          console.log(`   Remote updated: ${remoteUpdatedAt}`);
          console.log(`   Local modified: ${localModified}`);
          console.log('   Type "y" to replace your local file with the web version, or "n" to keep local changes and push them to the web.');
          console.log('');

          if (typeof remoteContent === 'string') {
            showLogDiff(logFile, remoteContent);
          }

          const answer = await promptUser('Overwrite local with web version? (y/n): ');

          if (answer && answer.toLowerCase() === 'y') {
            // Pull remote content
            const pulledContent = existing.data?.content || '';
            fs.writeFileSync(logFile, pulledContent, 'utf8');
            remoteHash = computeContentHash(pulledContent);
            console.log('✓ Local journal updated from web');
            console.log(`🗒️  File: ${path.relative(process.cwd(), logFile)}`);
            if (remoteUpdatedAt) {
              const remoteDate = new Date(remoteUpdatedAt);
              if (!Number.isNaN(remoteDate.getTime())) {
                fs.utimesSync(logFile, remoteDate, remoteDate);
              }
              const state = loadLogSyncState();
              state[dateFormatted] = {
                updated_at: remoteUpdatedAt,
                hash: remoteHash || computeContentHash(pulledContent),
              };
              saveLogSyncState(state);
            }
            return;
          } else {
            console.log('⏩ Keeping local version, will push to web');
          }
        }
      } else if (remoteTime > localTime && remoteMatchesKnown) {
        console.log('⚠️  Web timestamp ahead due to clock skew (matches last sync); pushing local changes.');
      } else if (remoteTime === localTime) {
        console.log('✓ Already synced (local and web are identical)');
        if (remoteUpdatedAt) {
          const state = loadLogSyncState();
          state[dateFormatted] = {
            updated_at: remoteUpdatedAt,
            hash: remoteHash || knownRemoteHash || computeContentHash(remoteContent || ''),
          };
          saveLogSyncState(state);
        }
        return;
      }
    }
  } else if (!existing.status) {
    throw new Error('Unable to reach Atris API. Check your network connection.');
  } else if (existing.status && existing.status !== 404) {
    throw new Error(existing.error || 'Failed to check existing journal entry');
  }

  const payload = {
    content: localContent,
    metadata: {
      source: 'cli',
      local_path: `logs/${dateFormatted}.md`,
    },
  };

  const result = await apiRequestJson(`/agents/${agentId}/journal/${dateFormatted}`, {
    method: 'PUT',
    token: credentials.token,
    body: payload,
  });

  if (!result.ok) {
    if (!result.status) {
      throw new Error('Unable to reach Atris API. Check your network connection.');
    }
    throw new Error(result.error || 'Failed to sync journal entry');
  }

  const data = result.data || {};
  const updatedAt = data.updated_at || new Date().toISOString();

  if (remoteExists) {
    console.log(`✓ Updated journal entry (previous update: ${remoteUpdatedAt || 'unknown'})`);
  } else {
    console.log('✓ Created journal entry in Atris');
  }

  console.log(`🗒️  Local file: ${path.relative(process.cwd(), logFile)}`);
  console.log(`🕒 Updated at: ${updatedAt}`);
  const updatedDate = new Date(updatedAt);
  if (!Number.isNaN(updatedDate.getTime())) {
    fs.utimesSync(logFile, updatedDate, updatedDate);
  }
  const finalContent = fs.readFileSync(logFile, 'utf8');
  const finalHash = computeContentHash(finalContent);
  const finalState = loadLogSyncState();
  finalState[dateFormatted] = {
    updated_at: updatedAt,
    hash: finalHash,
  };
  saveLogSyncState(finalState);
}

function showTodayLog() {
  const { logFile, dateFormatted } = getLogPath();

  if (!fs.existsSync(logFile)) {
    console.log(`No log for today (${dateFormatted})`);
    console.log('\nCreate one with: atris log "your message"');
    process.exit(0);
  }

  const content = fs.readFileSync(logFile, 'utf8');
  console.log(content);
}

function showRecentLogs() {
  const { logsDir, yearDir } = getLogPath();

  if (!fs.existsSync(logsDir) || !fs.existsSync(yearDir)) {
    console.log('No logs found');
    console.log('\nCreate one with: atris log "your message"');
    process.exit(0);
  }

  // Get all log files in current year directory
  const files = fs.readdirSync(yearDir)
    .filter(f => f.endsWith('.md'))
    .sort()
    .reverse()
    .slice(0, 3); // Last 3 days

  if (files.length === 0) {
    console.log('No logs found');
    process.exit(0);
  }

  console.log(`\n📋 Last ${files.length} day(s) of logs:\n`);
  console.log('='.repeat(60) + '\n');

  files.reverse().forEach((file, index) => {
    const filePath = path.join(yearDir, file);
    const content = fs.readFileSync(filePath, 'utf8');
    console.log(content);

    // Add separator between days
    if (index < files.length - 1) {
      console.log('─'.repeat(60) + '\n');
    }
  });
}

// ============================================
// Authentication & Credentials Management
// ============================================

function getCredentialsPath() {
  const homeDir = os.homedir();
  const atrisDir = path.join(homeDir, '.atris');

  // Create .atris directory if it doesn't exist
  if (!fs.existsSync(atrisDir)) {
    fs.mkdirSync(atrisDir, { recursive: true });
  }

  return path.join(atrisDir, 'credentials.json');
}

function saveCredentials(token, refreshToken, email, userId, provider) {
  const credentialsPath = getCredentialsPath();
  const credentials = {
    token,
    refresh_token: refreshToken || null,
    email: email || null,
    user_id: userId || null,
    provider: provider || null,
    saved_at: new Date().toISOString()
  };

  fs.writeFileSync(credentialsPath, JSON.stringify(credentials, null, 2));
}

function loadCredentials() {
  const credentialsPath = getCredentialsPath();

  if (!fs.existsSync(credentialsPath)) {
    return null;
  }

  try {
    const data = fs.readFileSync(credentialsPath, 'utf8');
    const parsed = JSON.parse(data);
    if (!parsed.provider) {
      parsed.provider = null;
    }
    if (!parsed.saved_at && parsed.created_at) {
      parsed.saved_at = parsed.created_at;
    }
    return parsed;
  } catch (error) {
    return null;
  }
}

function deleteCredentials() {
  const credentialsPath = getCredentialsPath();

  if (fs.existsSync(credentialsPath)) {
    fs.unlinkSync(credentialsPath);
  }
}

function getApiBaseUrl() {
  const raw = process.env.ATRIS_API_URL || 'https://api.atris.ai/api';
  return raw.replace(/\/$/, '');
}

function getAppBaseUrl() {
  const raw = process.env.ATRIS_APP_URL || 'https://atris.ai';
  return raw.replace(/\/$/, '');
}

function buildApiUrl(pathname) {
  const base = getApiBaseUrl();
  const normalizedPath = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return `${base}${normalizedPath}`;
}

async function apiRequestJson(pathname, options = {}) {
  const url = buildApiUrl(pathname);
  const headers = { ...(options.headers || {}) };
  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }
  if (!headers['User-Agent'] && !headers['user-agent']) {
    headers['User-Agent'] = DEFAULT_USER_AGENT;
  }
  if (!headers['X-Atris-Client']) {
    headers['X-Atris-Client'] = DEFAULT_CLIENT_ID;
  }

  let bodyPayload;
  if (options.body !== undefined && options.body !== null) {
    if (typeof options.body === 'string' || Buffer.isBuffer(options.body)) {
      bodyPayload = options.body;
    } else {
      bodyPayload = JSON.stringify(options.body);
      if (!headers['Content-Type']) {
        headers['Content-Type'] = 'application/json';
      }
    }
  }

  try {
    const result = await httpRequest(url, {
      method: options.method || 'GET',
      headers,
      body: bodyPayload,
    });

    const text = result.body.toString('utf8');
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }

    const ok = result.status >= 200 && result.status < 300;
    const errorMessage = !ok
      ? (data && typeof data === 'object' && (data.detail || data.error || data.message)) || text || 'Request failed'
      : undefined;

    return {
      ok,
      status: result.status,
      data,
      text,
      error: errorMessage,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      data: null,
      text: '',
      error: error.message || 'Network error',
    };
  }
}

function httpRequest(urlString, options) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlString);
    const isHttps = parsed.protocol === 'https:';
    const transport = isHttps ? https : http;

    const requestOptions = {
      method: options.method || 'GET',
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: `${parsed.pathname}${parsed.search}`,
      headers: { ...(options.headers || {}) },
    };

    const req = transport.request(requestOptions, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode || 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
    });

    req.on('error', reject);

    if (options.body) {
      if (!req.hasHeader('Content-Length')) {
        req.setHeader('Content-Length', Buffer.byteLength(options.body));
      }
      req.write(options.body);
    }

    req.end();
  });
}

async function validateAccessToken(token) {
  if (!token) {
    return { ok: false, status: 0, error: 'Missing token' };
  }
  return apiRequestJson('/auth/validate', {
    method: 'POST',
    body: { token },
    token,
  });
}

async function refreshAccessToken(refreshToken, provider) {
  if (!refreshToken) {
    return { ok: false, status: 0, error: 'Missing refresh token' };
  }
  const body = { refresh_token: refreshToken };
  if (provider) {
    body.provider = provider;
  }
  return apiRequestJson('/auth/refresh', {
    method: 'POST',
    body,
  });
}

async function performTokenRefresh(credentials, sourceLabel = 'refreshed') {
  if (!credentials || !credentials.refresh_token) {
    return { ok: false, error: 'missing_refresh_token' };
  }

  const refreshed = await refreshAccessToken(credentials.refresh_token, credentials.provider);
  if (!refreshed.ok) {
    return { ok: false, error: refreshed.error || 'Refresh request failed' };
  }

  const accessToken = refreshed.data?.access_token;
  if (!accessToken) {
    return { ok: false, error: 'No access token returned by refresh API' };
  }

  const newRefreshToken = refreshed.data?.refresh_token || credentials.refresh_token;
  const refreshUser = refreshed.data?.user || null;
  const provider = refreshed.data?.provider || credentials.provider;
  const email = refreshUser?.email || credentials.email;
  const userId = refreshUser?.id || credentials.user_id;

  saveCredentials(accessToken, newRefreshToken, email, userId, provider);
  let latestCreds = loadCredentials();

  const validation = await validateAccessToken(accessToken);
  let finalUser = refreshUser;

  if (validation.ok && validation.data?.valid) {
    finalUser = validation.data.user || refreshUser || null;
    const updatedEmail = finalUser?.email || latestCreds?.email || email;
    const updatedProvider = finalUser?.provider || latestCreds?.provider || provider;
    const updatedUserId = finalUser?.id || latestCreds?.user_id || userId;

    if (
      !latestCreds ||
      updatedEmail !== latestCreds.email ||
      updatedProvider !== latestCreds.provider ||
      updatedUserId !== latestCreds.user_id
    ) {
      saveCredentials(accessToken, newRefreshToken, updatedEmail, updatedUserId, updatedProvider);
      latestCreds = loadCredentials();
    }
  }

  return {
    ok: true,
    payload: {
      credentials: latestCreds || loadCredentials(),
      user: finalUser,
      source: sourceLabel,
    },
  };
}

async function ensureValidCredentials(options = {}) {
  let credentials = loadCredentials();
  if (!credentials || !credentials.token) {
    return { error: 'not_logged_in' };
  }

  if (credentials.refresh_token && shouldRefreshToken(credentials.token)) {
    const proactive = await performTokenRefresh(credentials, 'proactive_refresh');
    if (proactive.ok) {
      return proactive.payload;
    }
    credentials = loadCredentials() || credentials;
  }

  const validation = await validateAccessToken(credentials.token);
  if (validation.ok && validation.data?.valid) {
    const user = validation.data.user || null;
    const updatedEmail = user?.email || credentials.email;
    const updatedProvider = user?.provider || credentials.provider;
    const updatedUserId = user?.id || credentials.user_id;

    if (
      updatedEmail !== credentials.email ||
      updatedProvider !== credentials.provider ||
      updatedUserId !== credentials.user_id
    ) {
      saveCredentials(
        credentials.token,
        credentials.refresh_token,
        updatedEmail,
        updatedUserId,
        updatedProvider
      );
    }

    return {
      credentials: loadCredentials(),
      user,
      source: 'access_token',
    };
  }

  if (!credentials.refresh_token) {
    return { error: 'token_invalid', detail: validation.error || 'Token expired' };
  }

  const refreshed = await performTokenRefresh(credentials, 'refreshed');
  if (!refreshed.ok) {
    return { error: 'refresh_failed', detail: refreshed.error };
  }

  return refreshed.payload;
}

async function fetchMyAgents(token) {
  if (!token) {
    return null;
  }

  const response = await apiRequestJson('/agent/my-agents', {
    method: 'GET',
    token,
  });

  if (!response.ok) {
    if (response.status === 404) {
      return null;
    }
    throw new Error(response.error || 'Failed to fetch agents');
  }

  return response.data;
}

async function displayAccountSummary() {
  const ensured = await ensureValidCredentials();

  if (ensured.error) {
    console.log('Status: Not logged in');
    if (ensured.detail) {
      console.log(`Reason: ${ensured.detail}`);
    }
    return { error: ensured.error, detail: ensured.detail };
  }

  const { credentials, user } = ensured;
  const email = user?.email || credentials.email || 'unknown';
  const userId = user?.id || credentials.user_id || 'unknown';
  const provider = user?.provider || credentials.provider || 'unknown';
  const savedAt = credentials.saved_at || 'unknown';

  console.log('Status: Logged in ✓');
  console.log(`Email: ${email}`);
  console.log(`User ID: ${userId}`);
  console.log(`Provider: ${provider}`);
  console.log(`Credentials saved: ${savedAt}`);
  console.log(`Credential file: ${getCredentialsPath()}`);

  try {
    const agentsResponse = await fetchMyAgents(credentials.token);
    if (agentsResponse && agentsResponse.my_agents) {
      const agents = agentsResponse.my_agents;
      const total = agentsResponse.total ?? agents.length;
      console.log(`Agents: ${total}`);
      agents.slice(0, 5).forEach((agent) => {
        const name = agent.name || agent.id || 'Unnamed agent';
        console.log(`  • ${name}`);
      });
      if (total > 5) {
        console.log(`  …and ${total - 5} more`);
      }
    }
  } catch (error) {
    console.log(`Agents: Unable to load (${error.message})`);
  }

  return { credentials, user };
}

function openBrowser(url) {
  const platform = os.platform();
  let command;

  if (platform === 'darwin') {
    command = `open "${url}"`;
  } else if (platform === 'win32') {
    command = `start "${url}"`;
  } else {
    command = `xdg-open "${url}"`;
  }

  exec(command, (error) => {
    if (error) {
      console.log(`\nCouldn't open browser automatically. Please visit:\n${url}`);
    }
  });
}

function promptUser(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function loginAtris() {
  try {
    console.log('🔐 Login to AtrisOS\n');

    const existing = loadCredentials();
    if (existing) {
      const label = existing.email || existing.user_id || 'unknown user';
      console.log(`Already logged in as: ${label}`);
      const confirm = await promptUser('Do you want to login again? (y/N): ');
      if (confirm.toLowerCase() !== 'y') {
        console.log('Login cancelled.');
        process.exit(0);
      }
    }

    console.log('Choose login method:');
    console.log('  1. Browser OAuth (recommended)');
    console.log('  2. Paste existing API token');
    console.log('  3. Cancel');

    const choice = await promptUser('\nEnter choice (1-3): ');

    if (choice === '1') {
      const loginUrl = `${getAppBaseUrl()}/auth/cli`;
      console.log('\n🌐 Opening browser for OAuth login…');
      console.log('If it does not open automatically, visit:');
      console.log(loginUrl);
      console.log('\nAfter signing in, copy the CLI code shown in the browser and paste it below.');
      console.log('Codes expire after five minutes.\n');

      openBrowser(loginUrl);

      const code = await promptUser('Paste the CLI code here: ');
      if (!code) {
        console.error('✗ Error: Code is required');
        process.exit(1);
      }

      const exchange = await apiRequestJson('/auth/cli/exchange', {
        method: 'POST',
        body: { code: code.trim() },
      });

      if (!exchange.ok || !exchange.data) {
        console.error(`✗ Error: ${exchange.error || 'Invalid or expired code'}`);
        process.exit(1);
      }

      const payload = exchange.data;
      const token = payload.token;
      const refreshToken = payload.refresh_token;

      if (!token || !refreshToken) {
        console.error('✗ Error: Backend did not return tokens. Please try again.');
        process.exit(1);
      }

      const email = payload.email || existing?.email || null;
      const userId = payload.user_id || existing?.user_id || null;
      const provider = payload.provider || 'atris';

      saveCredentials(token, refreshToken, email, userId, provider);
      console.log('\n✓ Successfully logged in!');
      await displayAccountSummary();
      console.log('\nYou can now use cloud features with atris commands.');
      process.exit(0);
    } else if (choice === '2') {
      console.log('\n📋 Manual Token Entry');
      console.log('Get your token from: https://atris.ai/auth/cli\n');

      const tokenInput = await promptUser('Paste your API token: ');

      if (!tokenInput) {
        console.error('✗ Error: Token is required');
        process.exit(1);
      }

      const trimmed = tokenInput.trim();
      saveCredentials(trimmed, null, existing?.email || null, existing?.user_id || null, existing?.provider || 'manual');
      console.log('\nAttempting to validate token…\n');

      const summary = await displayAccountSummary();
      if (summary.error) {
        console.log('\n⚠️ Token saved, but validation failed. You may need to relogin.');
      } else {
        console.log('\n✓ Token validated successfully.');
      }

      console.log('\nYou can now use cloud features with atris commands.');
      process.exit(0);
    } else {
      console.log('Login cancelled.');
      process.exit(0);
    }
  } catch (error) {
    console.error(`\n✗ Login failed: ${error.message || error}`);
    process.exit(1);
  }
}

function logoutAtris() {
  const credentials = loadCredentials();

  if (!credentials) {
    console.log('Not currently logged in.');
    process.exit(0);
  }

  deleteCredentials();
  console.log('✓ Successfully logged out');
  console.log(`✓ Removed credentials from ${getCredentialsPath()}`);
}

async function whoamiAtris() {
  try {
    const summary = await displayAccountSummary();
    if (summary.error) {
      console.log('\nRun "atris login" to authenticate with AtrisOS.');
      process.exit(1);
    }
    process.exit(0);
  } catch (error) {
    console.error(`✗ Failed to fetch account details: ${error.message || error}`);
    process.exit(1);
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
// Config Management
// ============================================

function getConfigPath() {
  const targetDir = path.join(process.cwd(), 'atris');
  return path.join(targetDir, '.config');
}

function loadConfig() {
  const configPath = getConfigPath();

  if (!fs.existsSync(configPath)) {
    return {};
  }

  try {
    const data = fs.readFileSync(configPath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    return {};
  }
}

function saveConfig(config) {
  const configPath = getConfigPath();
  const targetDir = path.dirname(configPath);

  if (!fs.existsSync(targetDir)) {
    console.error('✗ Error: atris/ folder not found. Run "atris init" first.');
    process.exit(1);
  }

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

function getLogSyncStatePath() {
  const targetDir = path.join(process.cwd(), 'atris');
  return path.join(targetDir, '.log_sync_state.json');
}

function loadLogSyncState() {
  const statePath = getLogSyncStatePath();
  if (!fs.existsSync(statePath)) {
    return {};
  }

  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return {};
  }
}

function saveLogSyncState(state) {
  const statePath = getLogSyncStatePath();
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function isSameTimestamp(a, b) {
  if (!a || !b) return false;
  const ta = new Date(a).getTime();
  const tb = new Date(b).getTime();
  if (Number.isNaN(ta) || Number.isNaN(tb)) return false;
  return Math.abs(ta - tb) < 5;
}

function computeContentHash(content) {
  if (typeof content !== 'string') {
    return null;
  }

  const normalized = content.replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

function parseJournalSections(content) {
  const sections = {};
  const lines = content.split('\n');
  let currentSection = '__header__';
  let currentContent = [];

  for (const line of lines) {
    if (line.startsWith('## ')) {
      // Save previous section
      if (currentContent.length > 0 || currentSection === '__header__') {
        sections[currentSection] = currentContent.join('\n');
      }
      // Start new section
      currentSection = line.substring(3).trim();
      currentContent = [line];
    } else {
      currentContent.push(line);
    }
  }

  // Save last section
  if (currentContent.length > 0) {
    sections[currentSection] = currentContent.join('\n');
  }

  return sections;
}

function mergeSections(localSections, remoteSections, knownRemoteHash) {
  const merged = {};
  const conflicts = [];

  // Get all unique section names
  const allSections = new Set([...Object.keys(localSections), ...Object.keys(remoteSections)]);

  for (const section of allSections) {
    const localContent = localSections[section] || '';
    const remoteContent = remoteSections[section] || '';

    if (localContent === remoteContent) {
      // Same content, use either
      merged[section] = localContent;
    } else if (!remoteContent) {
      // Only in local, keep local
      merged[section] = localContent;
    } else if (!localContent) {
      // Only in remote, keep remote
      merged[section] = remoteContent;
    } else {
      // Both exist but differ - check if remote matches known state
      const remoteHash = computeContentHash(remoteContent);
      if (knownRemoteHash && remoteHash === knownRemoteHash) {
        // Remote hasn't changed since last sync, prefer local
        merged[section] = localContent;
      } else {
        // Real conflict - mark for user review
        conflicts.push(section);
        merged[section] = localContent; // Default to local
      }
    }
  }

  return { merged, conflicts };
}

function reconstructJournal(sections) {
  const parts = [];

  // Header first
  if (sections['__header__']) {
    parts.push(sections['__header__']);
  }

  // Then all other sections in order (preserve original order where possible)
  const sectionOrder = ['Completed ✅', 'In Progress 🔄', 'Backlog', 'Notes', 'Inbox', 'Timestamps', 'Lessons Learned'];

  for (const section of sectionOrder) {
    if (sections[section]) {
      parts.push(sections[section]);
    }
  }

  // Add any remaining sections not in the standard order
  for (const [section, content] of Object.entries(sections)) {
    if (section !== '__header__' && !sectionOrder.includes(section)) {
      parts.push(content);
    }
  }

  return parts.join('\n');
}

function showLogDiff(localPath, remoteContent) {
  let tmpDir;
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-diff-'));
    const remotePath = path.join(tmpDir, 'remote.md');
    fs.writeFileSync(remotePath, remoteContent, 'utf8');

    const diffCommands = [
      { cmd: 'git', args: ['--no-pager', 'diff', '--no-index', '--color=always', '--', localPath, remotePath] },
      { cmd: 'diff', args: ['-u', localPath, remotePath] },
    ];

    let shown = false;
    for (const { cmd, args } of diffCommands) {
      const result = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      if (result.error || result.status === 127) {
        continue;
      }

      const output = `${result.stdout || ''}${result.stderr || ''}`.trimEnd();
      if (output) {
        console.log('─────────────────────────────────────────────────────────────');
        console.log('Diff (web -> local):');
        process.stdout.write(output.endsWith('\n') ? output : `${output}\n`);
        console.log('─────────────────────────────────────────────────────────────');
        shown = true;
        break;
      }
    }

    if (!shown) {
      console.log('─────────────────────────────────────────────────────────────');
      console.log('Diff: (no textual diff available; files may be identical or differ only in whitespace)');
      console.log('─────────────────────────────────────────────────────────────');
    }
  } catch (error) {
    console.log('─────────────────────────────────────────────────────────────');
    console.log(`Unable to show diff automatically (${error.message || error}).`);
    console.log('─────────────────────────────────────────────────────────────');
  } finally {
    if (tmpDir) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch (_) {
        // ignore cleanup errors
      }
    }
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

  // Check if logged in
  const credentials = loadCredentials();

  if (!credentials || !credentials.token) {
    console.error('✗ Error: Not logged in. Run "atris login" first.');
    process.exit(1);
  }

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

  // Check credentials
  const credentials = loadCredentials();
  if (!credentials || !credentials.token) {
    console.error('✗ Error: Not logged in. Run "atris login" first.');
    process.exit(1);
  }

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
  console.log('🤖 atrisDev Protocol — Navigator Agent');
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

function spawnClaudeCodeSession(url, token, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === 'https:';
    const transport = isHttps ? https : http;

    const requestOptions = {
      method: 'POST',
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = transport.request(requestOptions, (res) => {
      if (res.statusCode !== 200) {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          reject(new Error(`HTTP ${res.statusCode}: ${text}`));
        });
        return;
      }

      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try {
          const response = JSON.parse(Buffer.concat(chunks).toString());
          // Session spawned - could return session ID, URL, etc
          resolve(response);
        } catch (e) {
          resolve({ status: 'session_initiated' });
        }
      });

      res.on('error', (err) => {
        reject(err);
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.write(body);
    req.end();
  });
}

function streamProChat(url, token, body, showTools = false) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === 'https:';
    const transport = isHttps ? https : http;

    const requestOptions = {
      method: 'POST',
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Accept': 'text/event-stream',
      },
    };

    const req = transport.request(requestOptions, (res) => {
      if (res.statusCode !== 200) {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          reject(new Error(`HTTP ${res.statusCode}: ${text}`));
        });
        return;
      }

      let buffer = '';

      res.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            if (!data || data === '[DONE]') continue;

            try {
              const msg = JSON.parse(data);

              // Handle different message types from Claude SDK
              if (msg.type === 'system_init' && showTools) {
                console.log(`[System] Tools available: ${msg.tools?.join(', ') || 'none'}`);
              } else if (msg.type === 'assistant') {
                // Display assistant text response
                if (msg.content && Array.isArray(msg.content)) {
                  for (const block of msg.content) {
                    if (block.type === 'text') {
                      process.stdout.write(block.text);
                    }
                  }
                }
              } else if (msg.type === 'tool_use' && showTools) {
                console.log(`\n[⚙️  Executing: ${msg.tool_name}]`);
              } else if (msg.type === 'tool_result' && showTools) {
                const preview = msg.content?.substring(0, 100) || '';
                console.log(`[✓ Result]: ${preview}${msg.content?.length > 100 ? '...' : ''}`);
              } else if (msg.type === 'result') {
                // Final result
                if (msg.result) {
                  process.stdout.write(msg.result);
                }
              } else if (msg.chunk) {
                // Legacy chunk format
                process.stdout.write(msg.chunk);
              }
            } catch (e) {
              // Ignore parse errors
            }
          }
        }
      });

      res.on('end', () => {
        resolve();
      });

      res.on('error', (err) => {
        reject(err);
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.write(body);
    req.end();
  });
}
