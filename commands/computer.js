/**
 * Atris Computer — interact with your EC2 AI Computer
 *
 *   atris computer                  — Open SMART mode (cloud in business workspace, local elsewhere)
 *   atris computer --cloud          — Open CLOUD workspace mode
 *   atris computer create <name>    — Create and wake a business computer
 *   atris computer wake             — Start the computer
 *   atris computer sleep            — Stop (files persist)
 *   atris computer delete           — Sleep, confirm, and delete a business computer
 *   atris computer card             — Show the local computer card
 *   atris computer run <command>    — Run bash on EC2 (no LLM)
 *   atris computer grep <pattern>   — Search files on EC2
 *   atris computer ls [path]        — List files
 *   atris computer cat <path>       — Read a file
 *   atris computer exec <prompt>    — Run with LLM (Claude Code)
 *   atris computer recruiting       — Open Atris Labs recruiting computer
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');
const { loadCredentials, decodeJwtClaims } = require('../utils/auth');
const { apiRequestJson, getApiBaseUrl, getAppBaseUrl } = require('../utils/api');
const { loadBusinesses, saveBusinesses } = require('./business');
const { consoleCommand, gatherAtrisContext, buildSystemPrompt } = require('./console');
const { streamSession } = require('./serve');
const { buildRemoteAtrisBootstrapCommand } = require('../lib/runtime-bootstrap');

function getToken() {
  const creds = loadCredentials();
  if (!creds || !creds.token) {
    console.error('Not logged in. Run: atris login');
    process.exit(1);
  }
  return creds.token;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const VALID_CLOUD_WORKERS = new Set(['claude', 'openai']);
const LOCAL_BRIDGE_RECONNECT_MS = 2000;
const VALID_COMPUTER_TYPES = new Set([
  'general',
  'business_ops',
  'codeops',
  'research',
  'crm',
  'reporting',
  'recruiting',
  'event_ops',
  'support',
]);
const RECRUITING_BUSINESS_SLUG = 'atris-labs';
const RECRUITING_LOCAL_SYNC_COMMANDS = new Set(['pull', 'push', 'watch', 'review']);
const KNOWN_CHAT_COMMANDS = new Set([
  '/audit',
  '/exit',
  '/files',
  '/help',
  '/login',
  '/model',
  '/pwd',
  '/quit',
  '/reset',
  '/run',
  '/start',
  '/status',
  '/worker',
  '/workflow',
]);

const CODEOPS_WORKFLOW_PROMPT = `
## Atris CodeOps Workflow

You are running inside Atris CodeOps with full computer permissions (permission_mode=bypassPermissions).
Use those permissions to inspect, edit, test, commit, push, and open PRs when the task calls for it.

Do not behave like an open-ended chat.
Every coding or repo operation must follow the scientific workflow:
OBSERVE -> HYPOTHESIS -> PLAN -> ACTION -> VALIDATION -> EVIDENCE -> NEXT STATE.

For a new coding request, first show a concise PLAN with Files, Checks, Risk, and Merge policy.
If the user has not clearly approved execution, ask for approval before editing.
If the user explicitly says to execute, proceed after the concise plan.

After work, always report:
- edited_files
- commands_run
- validation_result
- evidence
- pr_url if any
- pr_state
- merge_state
- next_task

Use one of these next states:
planned, executing, validated, pr_opened, merge_ready, merge_blocked_checks, merge_blocked_policy, merged, failed, needs_human.

Never hide failures.
A blocked check or missing permission is evidence, not success.
`.trim();

const RECRUITING_WORKFLOW_PROMPT = `
## Atris Recruiting Workflow

You are running inside the recruiting computer.
Optimize for recruiter throughput: pipeline clarity, candidate follow-up, role context, interview loops, and decision notes.
Do not send outreach, DMs, emails, or calendar invites without explicit operator approval.

For each work block, report:
- role or pipeline touched
- candidates or sources reviewed
- artifact changed
- follow-up owner
- sync/proof status
`.trim();

function color(code, value) {
  if (process.env.NO_COLOR || !process.stdout.isTTY) return String(value);
  return `\x1b[${code}m${value}\x1b[0m`;
}

const ui = {
  bold: (value) => color(1, value),
  dim: (value) => color(2, value),
  green: (value) => color(32, value),
  yellow: (value) => color(33, value),
  cyan: (value) => color(36, value),
  red: (value) => color(31, value),
};

function useInteractiveCloudUi() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY && !process.env.ATRIS_NO_INTERACTIVE);
}

function useInteractiveTerminalUi() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY && !process.env.ATRIS_NO_INTERACTIVE);
}

async function readPipedStdin() {
  if (process.stdin.isTTY) return null;
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk.toString();
  }
  return input;
}

function printCloudWordmark() {
  if (!process.stdout.isTTY) return;
  console.log(ui.cyan('    ___  __________  ________   CLOUD'));
  console.log(ui.cyan('   / _ |/_  __/ __ \\/  _/ __/'));
  console.log(ui.cyan('  / __ | / / / /_/ // /_\\ \\  '));
  console.log(ui.cyan(' /_/ |_|/_/  \\____/___/___/  '));
}

function printLocalWordmark() {
  if (!process.stdout.isTTY) return;
  console.log(ui.green('    ___  __________  ________   LOCAL'));
  console.log(ui.green('   / _ |/_  __/ __ \\/  _/ __/'));
  console.log(ui.green('  / __ | / / / /_/ // /_\\ \\  '));
  console.log(ui.green(' /_/ |_|/_/  \\____/___/___/  '));
}

function activeWorker(worker) {
  return (worker || 'claude').toLowerCase() === 'default' ? 'claude' : (worker || 'claude').toLowerCase();
}

function formatWorkerName(worker) {
  const active = activeWorker(worker);
  return active === 'openai' ? 'OpenAI' : 'Claude';
}

function extractAttachedWorkspaceMismatch(...values) {
  const text = values
    .filter((value) => value !== null && value !== undefined)
    .map((value) => {
      if (typeof value === 'string') return value;
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    })
    .join('\n');
  const match = text.match(/attached to workspace\s+([a-z0-9-]+)\.\s*Activate workspace\s+([a-z0-9-]+)\s+to switch/i);
  if (!match) return null;
  return {
    attachedWorkspaceId: match[1],
    requestedWorkspaceId: match[2],
  };
}

function contextForAttachedWorkspaceMismatch(ctx, failure) {
  const mismatch = extractAttachedWorkspaceMismatch(
    failure?.result?.error,
    failure?.result?.errorMessage,
    failure?.result?.data,
    failure?.fallback?.error,
    failure?.fallback?.payload
  );
  if (!mismatch?.attachedWorkspaceId || mismatch.attachedWorkspaceId === ctx?.workspaceId) return null;
  return { ...ctx, workspaceId: mismatch.attachedWorkspaceId };
}

async function describeClaudeAuth(token, ctx) {
  try {
    const status = await fetchBusinessClaudeLoginStatus(token, ctx);
    if (!status.ok) {
      return {
        connected: false,
        label: 'Claude login: unknown',
        detail: 'run /login to connect the remote computer',
      };
    }
    const data = status.data || {};
    if (data.loggedIn || data.connected || data.status === 'completed' || data.next_action === 'connected') {
      return {
        connected: true,
        label: 'Claude login: connected',
        detail: 'Claude subscription lane is active',
      };
    }
    return {
      connected: false,
      label: 'Claude login: not connected',
      detail: 'run /login to turn on the 0-credit Claude lane',
    };
  } catch {
    return {
      connected: false,
      label: 'Claude login: unknown',
      detail: 'run /login to connect the remote computer',
    };
  }
}

async function describeBillingMode(token, ctx, worker) {
  if (activeWorker(worker) === 'openai') {
    return 'Atris credits';
  }
  const auth = await describeClaudeAuth(token, ctx);
  if (auth.connected) {
    return 'Claude subscription connected - 0 Atris credits';
  }
  return 'Claude via Atris credits - /login makes it 0 credits';
}

function printCloudHelp() {
  console.log('');
  console.log(ui.bold('Useful commands'));
  console.log('  /start               Show the beginner flow again');
  console.log('  /help                Show this menu');
  console.log('  /status              Show cloud computer status');
  console.log('  /workflow            Show the CodeOps workflow contract');
  console.log('  /files [path]        List files in the workspace');
  console.log('  /run <cmd>           Run shell without the model');
  console.log('  /audit [n]           Show recent runs, output, and charges');
  console.log('  /worker claude       Use Claude subscription lane');
  console.log('  /worker openai       Use OpenAI credit lane');
  console.log('  /login               Connect Claude subscription on the remote box');
  console.log('  /reset               Start a fresh chat session');
  console.log('  /exit                Leave cloud mode');
  console.log('');
  console.log(ui.dim('No code needed: type the outcome in normal English. Unknown /commands are blocked locally.'));
}

function printCloudStartPanel(ctx, worker, model, billingLabel, authSummary = null) {
  console.log('');
  console.log(ui.bold('Atris Cloud Computer'));
  console.log(`${ctx.businessName}  ${ui.dim('/workspace persists')}`);
  console.log(`Lane: ${ui.bold(formatWorkerName(worker))}  ${ui.dim(formatCloudSelection({ worker, model }))}`);
  console.log(`Billing: ${billingLabel}`);
  if (authSummary) console.log(`${authSummary.label}  ${ui.dim(authSummary.detail)}`);
  console.log(`${ui.green('Atris loaded')}  ${ui.dim('plain English -> workspace actions')}`);
  console.log('');
  console.log(ui.bold('Start here'));
  console.log('  Type what you want built. Atris can inspect, edit, run, and save files.');
  console.log('  "look around this workspace and tell me what is here"');
  console.log('  "build me a one-page website for my coffee shop"');
  console.log('  "make a script that turns a CSV into a chart"');
  console.log('');
  console.log(ui.bold('Controls'));
  console.log('  /start   this screen      /status  lane, auth, billing');
  console.log('  /files   workspace files  /run pwd shell without the model');
  console.log('  /login   connect Claude   /worker openai use credits');
  console.log('  /audit 5 recent runs      /exit leave cloud mode');
  console.log('');
  console.log(ui.dim('Plain English goes to Atris. Slash commands control the computer.'));
}

function appendSystemPrompt(basePrompt, extraPrompt) {
  if (!extraPrompt) return basePrompt || null;
  const marker = String(extraPrompt).split('\n', 1)[0];
  if (basePrompt && marker && basePrompt.includes(marker)) return basePrompt;
  if (!basePrompt) return extraPrompt;
  return `${String(basePrompt).trim()}\n\n${extraPrompt}`;
}

function codeOpsCloudOptions(options = {}) {
  return {
    ...options,
    worker: options.worker || 'claude',
    mode: 'codeops',
    systemPrompt: appendSystemPrompt(options.systemPrompt, CODEOPS_WORKFLOW_PROMPT),
  };
}

function recruitingCloudOptions(options = {}) {
  return {
    ...options,
    worker: options.worker || 'claude',
    mode: 'recruiting',
    systemPrompt: appendSystemPrompt(options.systemPrompt, RECRUITING_WORKFLOW_PROMPT),
  };
}

function printCodeOpsStartPanel(ctx, worker, model, billingLabel, authSummary = null) {
  console.log('');
  console.log(ui.bold('Atris CodeOps Computer'));
  console.log(`${ctx.businessName}  ${ui.dim('/workspace persists, full permissions enabled')}`);
  console.log(`Lane: ${ui.bold(formatWorkerName(worker))}  ${ui.dim(formatCloudSelection({ worker, model }))}`);
  console.log(`Billing: ${billingLabel}`);
  if (authSummary) console.log(`${authSummary.label}  ${ui.dim(authSummary.detail)}`);
  console.log(`${ui.green('Workflow locked')}  ${ui.dim('observe -> plan -> act -> validate -> evidence -> next')}`);
  console.log('');
  console.log(ui.bold('Start here'));
  console.log('  Type a coding goal in plain English.');
  console.log('  CodeOps will plan first, then execute after approval or explicit proceed language.');
  console.log('  Use /workflow to see the contract, /run for shell, /audit for run history, /exit to leave.');
  console.log('');
}

function printCodeOpsWorkflowContract() {
  console.log('');
  console.log(ui.bold('CodeOps workflow'));
  console.log('  observe -> hypothesis -> plan -> action -> validation -> evidence -> next state');
  console.log('');
  console.log('  Required final evidence: edited_files, commands_run, validation_result, pr_url, pr_state, merge_state, next_task.');
  console.log('  Allowed states: planned, executing, validated, pr_opened, merge_ready, merge_blocked_checks, merge_blocked_policy, merged, failed, needs_human.');
  console.log('  Full permissions stay on; the workflow contract controls how the computer uses them.');
}

function printRecruitingWorkflowContract() {
  console.log('');
  console.log(ui.bold('Recruiting workflow'));
  console.log('  pipeline -> candidates -> next touch -> owner -> proof -> sync');
  console.log('');
  console.log('  No external outreach, DMs, emails, or calendar invites without explicit operator approval.');
  console.log('  Required final evidence: pipeline touched, candidates reviewed, artifact changed, follow-up owner, sync/proof status.');
}

function printRecruitingComputerHelp() {
  console.log('Usage: atris computer recruiting [chat|status|sync|pull|push|watch|review|wake|sleep|run|grep|ls|cat|exec|audit|workflow|create]');
  console.log('');
  console.log('Examples:');
  console.log('  atris computer recruiting');
  console.log('  atris computer recruiting status');
  console.log('  atris computer recruiting sync');
  console.log('  atris computer recruiting pull');
  console.log('  atris computer recruiting push --dry-run');
  console.log('  atris computer recruiting watch');
  console.log('  atris computer recruiting run "pwd && find . -maxdepth 2 -type f | head"');
  console.log("  atris computer recruiting exec \"Summarize today's candidate follow-ups\"");
  console.log('  atris computer recruiting create');
}

function displayHomeRelativePath(targetPath) {
  const home = os.homedir();
  if (targetPath && home && targetPath === home) return '~';
  if (targetPath && home && targetPath.startsWith(`${home}${path.sep}`)) {
    return `~${targetPath.slice(home.length)}`;
  }
  return targetPath;
}

function recruitingBusinessWorkspacePath(slug = RECRUITING_BUSINESS_SLUG) {
  const root = process.env.ATRIS_BUSINESS_ROOT || path.join(os.homedir(), 'arena', 'atris-business');
  return path.join(root, slug);
}

function normalizeBusinessSlug(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function bindingMatchesBusinessSlug(binding, slug) {
  if (!binding) return false;
  const wanted = normalizeBusinessSlug(slug);
  return [binding.slug, binding.business_slug, binding.name]
    .map(normalizeBusinessSlug)
    .some((candidate) => candidate && candidate === wanted);
}

function bindingBusinessLabel(binding) {
  return binding?.slug || binding?.business_slug || binding?.name || 'unknown';
}

function resolveRecruitingSyncWorkspace(slug = RECRUITING_BUSINESS_SLUG) {
  const currentBinding = readBusinessBinding();
  if (bindingMatchesBusinessSlug(currentBinding, slug)) {
    return {
      cwd: process.cwd(),
      binding: currentBinding,
      source: 'current',
    };
  }

  const canonicalCwd = recruitingBusinessWorkspacePath(slug);
  const canonicalBinding = readBusinessBinding(canonicalCwd);
  if (bindingMatchesBusinessSlug(canonicalBinding, slug)) {
    return {
      cwd: canonicalCwd,
      binding: canonicalBinding,
      source: 'canonical',
    };
  }

  return null;
}

function printRecruitingSyncNextSteps(slug = RECRUITING_BUSINESS_SLUG, workspacePath = null) {
  const target = workspacePath || recruitingBusinessWorkspacePath(slug);
  console.log('');
  console.log('Recruiting sync commands');
  console.log(`  cd ${displayHomeRelativePath(target)}`);
  console.log('  atris computer recruiting pull');
  console.log('  atris computer recruiting push --dry-run');
  console.log('  atris sync --status');
  console.log('  atris sync --dry-run');
  console.log('  atris sync');
  console.log('  atris sync --watch');
}

function recruitingLocalSyncCommand(action, slug = RECRUITING_BUSINESS_SLUG, args = []) {
  switch (action) {
    case 'pull':
      return ['pull', slug, '--keep-local', '--fail-on-conflict', ...args];
    case 'push':
      return ['push', slug, ...args];
    case 'watch':
      return ['sync', '--watch', ...args];
    case 'review':
      return ['sync', '--review', ...args];
    default:
      return ['sync', ...args];
  }
}

function printRecruitingLocalSyncCommandHelp(action, slug = RECRUITING_BUSINESS_SLUG) {
  const command = recruitingLocalSyncCommand(action, slug, action === 'push' ? ['--dry-run'] : []);
  console.log(`Usage: atris computer recruiting ${action} [flags]`);
  console.log('');
  console.log('Runs from the current or canonical Atris Labs recruiting workspace.');
  if (action === 'pull') {
    console.log('Use --dry-run first; use --apply to write into a dirty local workspace.');
  }
  console.log('');
  console.log('Underlying command:');
  console.log(`  atris ${command.join(' ')}`);
}

function withoutRecruitingWrapperFlags(action, args = []) {
  if (action !== 'pull') return args;
  return args.filter((arg) => arg !== '--apply');
}

function gitDirtySummary(cwd) {
  const result = spawnSync('git', ['-C', cwd, 'status', '--short'], {
    encoding: 'utf8',
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' },
  });
  if (result.status !== 0) return null;
  const lines = String(result.stdout || '').split(/\r?\n/).filter(Boolean);
  return {
    count: lines.length,
    sample: lines.slice(0, 5),
  };
}

function printRecruitingPullPreflight(summary) {
  console.log('');
  console.log('Recruiting pull preflight');
  console.log(`  local git changes: ${summary.count}`);
  summary.sample.forEach((line) => console.log(`  ${line}`));
  console.log('');
  console.log('Safe next step');
  console.log('  atris computer recruiting pull --dry-run');
  console.log('  atris computer recruiting pull --apply   # writes pull changes and conflict review packet');
}

function runAtrisCliCommand(cliArgs, cwd) {
  const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'atris.js'), ...cliArgs], {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' },
  });
  if (result.error) throw result.error;
  if (result.signal) {
    process.exitCode = 1;
    return 1;
  }
  process.exitCode = result.status || 0;
  return process.exitCode;
}

function printRecruitingLocalSyncOutcome(action, status = 0, args = []) {
  if (action === 'pull') {
    console.log('');
    console.log('Recruiting next step');
    if (args.includes('--dry-run')) {
      console.log('  atris computer recruiting pull --apply   # writes review packet if conflicts were reported');
      console.log('  atris computer recruiting review');
      console.log('  atris computer recruiting push --dry-run');
      return;
    }
    console.log('  atris computer recruiting review   # if conflicts were reported');
    console.log('  atris computer recruiting push --dry-run');
    return;
  }

  if (action === 'push' && status !== 0) {
    console.log('');
    console.log('Recruiting next step');
    console.log('  atris computer recruiting pull --dry-run');
    console.log('  atris computer recruiting review   # if conflicts were reported');
    return;
  }

  if (action === 'push' && args.includes('--dry-run')) {
    console.log('');
    console.log('Recruiting next step');
    console.log('  atris computer recruiting push');
  }
}

async function runRecruitingLocalSyncCommand(action, args = [], cloudOptions = {}) {
  const slug = cloudOptions.businessSlug || RECRUITING_BUSINESS_SLUG;
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    printRecruitingLocalSyncCommandHelp(action, slug);
    return;
  }

  const workspace = resolveRecruitingSyncWorkspace(slug);
  console.log(`Recruiting local ${action}`);
  if (!workspace) {
    const currentBinding = readBusinessBinding();
    if (currentBinding && !bindingMatchesBusinessSlug(currentBinding, slug)) {
      console.log(`  current workspace: ${bindingBusinessLabel(currentBinding)} (not ${slug})`);
    } else {
      console.log('  local workspace: not detected in this folder');
    }
    printRecruitingLocalSyncCommandHelp(action, slug);
    printRecruitingSyncNextSteps(slug);
    return;
  }

  if (workspace.source === 'canonical') {
    console.log(`  folder: ${displayHomeRelativePath(workspace.cwd)} (auto-detected)`);
  }

  const commandArgs = withoutRecruitingWrapperFlags(action, args);
  if (action === 'pull' && !args.includes('--dry-run') && !args.includes('--apply')) {
    const dirty = gitDirtySummary(workspace.cwd);
    if (dirty && dirty.count > 0) {
      printRecruitingPullPreflight(dirty);
      process.exitCode = 1;
      return;
    }
  }

  const command = recruitingLocalSyncCommand(action, workspace.binding.slug || slug, commandArgs);
  const status = runAtrisCliCommand(command, workspace.cwd);
  printRecruitingLocalSyncOutcome(action, status, commandArgs);
}

async function runRecruitingSyncHelper(args = [], cloudOptions = {}) {
  const slug = cloudOptions.businessSlug || RECRUITING_BUSINESS_SLUG;
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    console.log('Usage: atris computer recruiting sync [--status|--dry-run|--watch|--review|--resolve local|cloud|merge]');
    console.log('');
    console.log('Runs local recruiting workspace sync from the current or canonical Atris Labs folder.');
    printRecruitingSyncNextSteps(slug);
    return;
  }

  const workspace = resolveRecruitingSyncWorkspace(slug);
  console.log('Recruiting local sync');
  if (!workspace) {
    const currentBinding = readBusinessBinding();
    if (currentBinding && !bindingMatchesBusinessSlug(currentBinding, slug)) {
      console.log(`  current workspace: ${bindingBusinessLabel(currentBinding)} (not ${slug})`);
    } else {
      console.log('  local workspace: not detected in this folder');
    }
    printRecruitingSyncNextSteps(slug);
    return;
  }

  if (workspace.source === 'canonical') {
    console.log(`  folder: ${displayHomeRelativePath(workspace.cwd)} (auto-detected)`);
  }

  const { businessSync } = require('./business-sync');
  await businessSync(args.length > 0 ? args : ['--status'], workspace.cwd);
  printRecruitingSyncNextSteps(workspace.binding.slug || slug, workspace.cwd);
}

function buildLocalBridgeSystemPrompt(sessionId, localRoot, allowBash) {
  const endpoint = `/api/cli/sessions/${sessionId}/file-op`;
  const bashLine = allowBash
    ? '- Run local commands with local_file_op({ "type": "bash", "command": "..." }).'
    : '- Bash is disabled for this local session. Use read/write/edit/delete only.';

  return `

## Atris Local Folder Mode

The user connected their LOCAL folder to Atris through CLI session ${sessionId}.
Their local root is: ${localRoot}
Treat this local folder as the primary workspace for this chat.
The cloud /workspace is only a control plane.
Do not use Write/Edit/apply_patch for requested local edits.
Use the native local_file_op tool for every local filesystem change.

Preferred tool calls:
- local_file_op({ "type": "read", "path": "relative/path.txt" })
- local_file_op({ "type": "write", "path": "file.txt", "content": "..." })
- local_file_op({ "type": "edit", "path": "file.txt", "find": "...", "replace": "..." })
- local_file_op({ "type": "delete", "path": "file.txt" })
${bashLine}

Fallback if the native tool is unavailable: use Bash to call the Atris Python API from the cloud workspace:

\`\`\`python
from atris_api import api
api("POST", "${endpoint}", {
    "type": "read",
    "path": "relative/path.txt",
    "wait_for_ack": True,
    "timeout_seconds": 30,
})
\`\`\`

Supported operations:
- Read: { "type": "read", "path": "file.txt", "wait_for_ack": true }
- Write: { "type": "write", "path": "file.txt", "content": "...", "wait_for_ack": true }
- Edit: { "type": "edit", "path": "file.txt", "find": "...", "replace": "...", "wait_for_ack": true }
- Delete: { "type": "delete", "path": "file.txt", "wait_for_ack": true }

Rules:
- All paths must be relative to the local root.
- Read before editing unless you are creating a new file.
- Use local bash for ls/rg/tests when available.
- Do not ask the user to copy, paste, or save files. Apply the change through the bridge.
- In final answers, say what changed locally and how you verified it.
---`;
}

function printLocalAtrisStartPanel(ctx, bridge, worker, model, billingLabel, authSummary = null) {
  console.log('');
  console.log(ui.bold('Atris Local Computer'));
  console.log(`${ctx.businessName}  ${ui.dim('cloud brain -> local folder')}`);
  console.log(`Local: ${bridge.workingDir}`);
  console.log(`Bridge: ${bridge.sessionId.slice(0, 8)}  ${ui.dim(bridge.allowBash ? 'local bash enabled' : 'file ops only')}`);
  console.log(`Lane: ${ui.bold(formatWorkerName(worker))}  ${ui.dim(formatCloudSelection({ worker, model }))}`);
  console.log(`Billing: ${billingLabel}`);
  if (authSummary) console.log(`${authSummary.label}  ${ui.dim(authSummary.detail)}`);
  console.log(`${ui.green('Atris loaded')}  ${ui.dim('plain English -> local edits')}`);
  console.log('');
  console.log(ui.bold('Start here'));
  console.log('  "look around this folder and tell me what is here"');
  console.log('  "make the homepage look premium"');
  console.log('  "add a script that converts a CSV into a chart"');
  console.log('');
  console.log(ui.bold('Controls'));
  console.log('  /status  local bridge, lane, billing');
  console.log('  /files   local files');
  console.log('  /run     local shell command');
  console.log('  /audit   recent cloud brain runs');
  console.log('  /worker  claude|openai');
  console.log('  /exit    leave local Atris mode');
  console.log('');
  console.log(ui.dim('Tokens run through Atris/cloud billing. Edits land in this local folder.'));
}

async function printCloudSessionStatus(token, ctx, worker, model) {
  const statusResult = await apiRequestJson(`/business/${ctx.businessId}/ai-computer/status`, {
    method: 'GET',
    token,
  });
  const d = statusResult.ok ? (statusResult.data || {}) : {};
  const computerState = d.status || (statusResult.ok ? 'unknown' : `error ${statusResult.status}`);
  const authSummary = activeWorker(worker) === 'claude' ? await describeClaudeAuth(token, ctx) : null;
  const billingLabel = await describeBillingMode(token, ctx, worker);

  console.log('');
  console.log(ui.bold('Cloud status'));
  console.log(`  Computer: ${computerState}`);
  console.log(`  Business: ${ctx.businessName}`);
  console.log('  Workspace: /workspace');
  console.log(`  Lane: ${formatWorkerName(worker)}  ${formatCloudSelection({ worker, model })}`);
  console.log(`  Billing: ${billingLabel}`);
  console.log('  Atris: loaded');
  if (authSummary) console.log(`  Claude: ${authSummary.connected ? 'connected' : 'not connected'}  ${authSummary.detail}`);
  if (d.endpoint) console.log(`  Endpoint: ${d.endpoint}`);
}

function questionAsync(rl, question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

async function selectFromDropdown(title, choices) {
  if (!useInteractiveTerminalUi() || !choices.length) return choices[0] || null;

  console.log(ui.bold(title));
  choices.forEach((choice, i) => {
    console.log(`${i + 1}. ${choice.label}  ${ui.dim(choice.detail || '')}`.trimEnd());
  });

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = String(await questionAsync(rl, `Choose [1-${choices.length}] (default 1): `) || '').trim();
  rl.close();

  if (!answer) return choices[0];
  if (answer.toLowerCase() === 'q' || answer.toLowerCase() === 'quit' || answer.toLowerCase() === 'exit') {
    return null;
  }
  const selected = Number.parseInt(answer, 10);
  if (Number.isFinite(selected) && selected >= 1 && selected <= choices.length) {
    return choices[selected - 1];
  }
  return choices[0];
}

async function chooseComputerSurface(hasBusinessBinding, hasLocalHarness) {
  if (!useInteractiveTerminalUi()) {
    return hasBusinessBinding ? 'cloud' : 'local';
  }
  if (hasBusinessBinding) {
    const choices = [
      { label: 'Cloud workspace', value: 'cloud', detail: '/workspace, shared, Atris loaded' },
      { label: 'Local folder', value: 'local-atris', detail: 'edits this folder, tokens run through Atris' },
    ];
    if (hasLocalHarness) {
      choices.push({ label: 'Local BYO Claude', value: 'local-byo', detail: 'advanced, tokens go to Anthropic' });
    }
    const selected = await selectFromDropdown('Choose computer', choices);
    if (selected === null) return null;
    return selected?.value || 'cloud';
  }
  return 'local';
}

async function chooseCloudLane(token, ctx, initialOptions = {}) {
  let worker = initialOptions.worker || null;
  let model = initialOptions.model || null;

  if (!worker && useInteractiveCloudUi()) {
    const selected = await selectFromDropdown('Choose compute lane', [
      { label: 'Claude', value: 'claude', detail: 'subscription lane when connected, 0 Atris credits' },
      { label: 'OpenAI', value: 'openai', detail: 'works now, uses Atris credits' },
    ]);
    if (selected === null) return { cancelled: true };
    if (selected?.value) worker = selected.value;
  }

  if (activeWorker(worker) === 'claude' && useInteractiveCloudUi()) {
    let state = null;
    try {
      const status = await fetchBusinessClaudeLoginStatus(token, ctx);
      state = status.ok ? status.data : null;
    } catch {
      state = null;
    }

    if (!state?.connected && !state?.loggedIn && state?.status !== 'completed' && state?.next_action !== 'connected') {
      const selected = await selectFromDropdown('Claude subscription auth', [
        { label: 'Use Atris Claude', value: 'continue', detail: 'works now, uses Atris credits' },
        { label: 'Login to Claude', value: 'login', detail: 'turns on 0-credit Claude lane' },
        { label: 'Use OpenAI', value: 'openai', detail: 'works now, uses Atris credits' },
      ]);
      if (selected === null) return { cancelled: true };
      if (selected?.value === 'login') {
        await computerCloudLogin(token, ctx);
      } else if (selected?.value === 'openai') {
        worker = 'openai';
      }
    }
  }

  return { worker, model };
}

function parseComputerOptions(argv) {
  const positional = [];
  let worker = process.env.ATRIS_CLOUD_WORKER || null;
  let model = process.env.ATRIS_CLOUD_MODEL || null;
  let businessSlug = null;
  let workspaceId = null;
  let waitForResult = true;
  let message = null;
  let force = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if ((arg === '--business' || arg === '-b') && argv[i + 1]) {
      businessSlug = argv[i + 1];
      i++;
      continue;
    }
    if (arg.startsWith('--business=')) {
      businessSlug = arg.split('=', 2)[1] || null;
      continue;
    }
    if ((arg === '--workspace' || arg === '--workspace-id') && argv[i + 1]) {
      workspaceId = argv[i + 1];
      i++;
      continue;
    }
    if (arg.startsWith('--workspace=')) {
      workspaceId = arg.split('=', 2)[1] || null;
      continue;
    }
    if (arg.startsWith('--workspace-id=')) {
      workspaceId = arg.split('=', 2)[1] || null;
      continue;
    }
    if (arg === '--worker' && argv[i + 1]) {
      worker = argv[i + 1];
      i++;
      continue;
    }
    if (arg.startsWith('--worker=')) {
      worker = arg.split('=', 2)[1] || null;
      continue;
    }
    if (arg === '--model' && argv[i + 1]) {
      model = argv[i + 1];
      i++;
      continue;
    }
    if (arg.startsWith('--model=')) {
      model = arg.split('=', 2)[1] || null;
      continue;
    }
    if (arg === '--message' && argv[i + 1]) {
      message = argv[i + 1];
      i++;
      continue;
    }
    if (arg.startsWith('--message=')) {
      message = arg.slice('--message='.length);
      continue;
    }
    if (arg === '--no-wait' || arg === '--async') {
      waitForResult = false;
      continue;
    }
    if (arg === '--force') {
      force = true;
      continue;
    }
    positional.push(arg);
  }

  if (worker && !VALID_CLOUD_WORKERS.has(worker)) {
    console.error(`Invalid cloud worker: ${worker}`);
    console.error('Expected one of: claude, openai');
    process.exit(1);
  }

  return {
    positional,
    options: {
      worker: worker || null,
      model: model || null,
      businessSlug: businessSlug ? String(businessSlug).trim() : null,
      workspaceId: workspaceId ? String(workspaceId).trim() : null,
      waitForResult,
      message,
      force,
    },
  };
}

function parseComputerCreateArgs(argv = []) {
  const nameParts = [];
  let businessSlug = null;
  let help = false;
  let setDefault = false;
  let computerType = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h' || arg === 'help') {
      help = true;
      continue;
    }
    if ((arg === '--business' || arg === '-b') && argv[i + 1]) {
      businessSlug = argv[i + 1];
      i++;
      continue;
    }
    if (arg.startsWith('--business=')) {
      businessSlug = arg.split('=', 2)[1] || null;
      continue;
    }
    if ((arg === '--type' || arg === '-t') && argv[i + 1] && !argv[i + 1].startsWith('-')) {
      computerType = argv[i + 1];
      i++;
      continue;
    }
    if (arg.startsWith('--type=')) {
      computerType = arg.split('=', 2)[1] || null;
      continue;
    }
    if (arg === '--set-default') {
      setDefault = true;
      continue;
    }
    nameParts.push(arg);
  }

  return {
    name: nameParts.join(' ').trim(),
    businessSlug: businessSlug ? String(businessSlug).trim() : null,
    computerType: computerType ? normalizeComputerType(computerType) : null,
    help,
    setDefault,
  };
}

function computerCreateArgsHaveName(argv = []) {
  const flagsWithValues = new Set(['--business', '-b', '--type', '-t']);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (flagsWithValues.has(arg)) {
      i++;
      continue;
    }
    if (!arg || arg.startsWith('-') || arg === 'help') continue;
    return true;
  }
  return false;
}

function normalizeComputerType(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (normalized === 'business') return 'business_ops';
  if (normalized === 'event') return 'event_ops';
  return normalized || 'general';
}

function formatComputerTypeList() {
  return [...VALID_COMPUTER_TYPES].join(', ');
}

function parseComputerDeleteArgs(argv = []) {
  const options = { help: false, confirm: null };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h' || arg === 'help') {
      options.help = true;
      continue;
    }
    if (arg === '--confirm' && argv[i + 1]) {
      options.confirm = argv[i + 1];
      i++;
      continue;
    }
    if (arg.startsWith('--confirm=')) {
      options.confirm = arg.slice('--confirm='.length);
      continue;
    }
  }

  return options;
}

function formatCloudSelection(options = {}) {
  const worker = activeWorker(options.worker);
  const parts = [`worker=${worker}`];
  if (options.model) parts.push(`model=${options.model}`);
  if (!options.model) parts.push('model=default');
  return parts.join(' ');
}

function printModeBanner(mode, root, lines = []) {
  console.log(`Mode: ${mode}`);
  console.log(`Root: ${root}`);
  for (const line of lines) console.log(line);
  console.log('');
}

function findAtrisCodeTerminal() {
  const envPath = process.env.ATRIS_CODE_PY;
  const candidates = [
    envPath,
    path.join(__dirname, '..', 'cli', 'atris_code.py'),
    path.join(process.cwd(), 'cli', 'atris_code.py'),
    path.join(os.homedir(), 'arena', 'atrisos-backend', 'cli', 'atris_code.py'),
  ].filter(Boolean);

  let dir = process.cwd();
  for (let i = 0; i < 4; i++) {
    candidates.push(path.join(dir, 'cli', 'atris_code.py'));
    dir = path.dirname(dir);
  }

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function computerLocalLegacy(extraArgs = []) {
  printModeBanner('LOCAL', process.cwd(), [
    'Current folder is the workspace.',
    'Legacy console mode.',
  ]);

  const originalArgv = process.argv;
  process.argv = [originalArgv[0], originalArgv[1], originalArgv[2], ...extraArgs];
  try {
    consoleCommand();
  } finally {
    process.argv = originalArgv;
  }
}

function computerLocal(extraArgs = []) {
  printLocalWordmark();
  printModeBanner('LOCAL', process.cwd(), [
    'Claude Code + Atris workspace context.',
    'BYO local Claude: tokens go through Anthropic, not Atris.',
    'No Atris credits, no cloud audit, no remote workspace.',
    'Remote /login only applies to Cloud workspace.',
  ]);

  const originalArgv = process.argv;
  process.argv = [originalArgv[0], originalArgv[1], originalArgv[2], 'claude', ...extraArgs];
  try {
    consoleCommand();
  } finally {
    process.argv = originalArgv;
  }
}

async function startLocalAtrisBridge(token, options = {}) {
  const workingDir = process.cwd();
  const allowBash = options.allowBash !== false;
  const result = await apiRequestJson('/cli/sessions', {
    method: 'POST',
    token,
    body: {
      working_directory: workingDir,
      agent_id: null,
      allow_bash: allowBash,
    },
    timeoutMs: 15000,
  });

  if (!result.ok) {
    throw new Error(result.errorMessage || result.error || `failed to create local bridge (${result.status})`);
  }

  const session = result.data || {};
  const sessionId = session.session_id;
  if (!sessionId) {
    throw new Error('local bridge did not return a session id');
  }

  let stopped = false;
  const loop = async () => {
    while (!stopped) {
      try {
        await streamSession(token, sessionId, workingDir);
      } catch (err) {
        if (!stopped) console.error(ui.dim(`  local bridge reconnecting: ${err.message}`));
      }
      if (!stopped) await sleep(LOCAL_BRIDGE_RECONNECT_MS);
    }
  };
  loop();

  return {
    sessionId,
    workingDir,
    allowBash,
    stop: async () => {
      stopped = true;
      await apiRequestJson(`/cli/sessions/${sessionId}`, {
        method: 'DELETE',
        token,
        timeoutMs: 10000,
      }).catch(() => {});
    },
  };
}

async function runLocalBridgeOp(token, sessionId, op, timeoutSeconds = 30) {
  const result = await apiRequestJson(`/cli/sessions/${sessionId}/file-op`, {
    method: 'POST',
    token,
    body: {
      ...op,
      wait_for_ack: true,
      timeout_seconds: timeoutSeconds,
    },
    timeoutMs: Math.max(10, timeoutSeconds + 5) * 1000,
  });

  if (!result.ok) {
    console.error(`Failed: ${result.errorMessage || result.error || result.status}`);
    return null;
  }

  const data = result.data || {};
  if (data.status === 'error') {
    const err = data.result?.error || 'local operation failed';
    console.error(`Failed: ${err}`);
  }
  return data;
}

function readBusinessBinding(cwd = process.cwd()) {
  const bindingPath = path.join(cwd, '.atris', 'business.json');
  if (!fs.existsSync(bindingPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(bindingPath, 'utf8'));
  } catch {
    return null;
  }
}

function readPackageMeta(cwd = process.cwd()) {
  const packagePath = path.join(cwd, 'package.json');
  if (!fs.existsSync(packagePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  } catch {
    return null;
  }
}

function relIfExists(cwd, target) {
  return fs.existsSync(path.join(cwd, target)) ? target : null;
}

function detectValidationCommand(cwd = process.cwd(), pkg = null) {
  const meta = pkg || readPackageMeta(cwd);
  const testScript = meta?.scripts?.test;
  if (testScript && !/no test specified/i.test(testScript)) return 'npm test';
  if (fs.existsSync(path.join(cwd, 'pytest.ini')) || fs.existsSync(path.join(cwd, 'pyproject.toml'))) return 'pytest';
  if (fs.existsSync(path.join(cwd, 'Cargo.toml'))) return 'cargo test';
  if (fs.existsSync(path.join(cwd, 'go.mod'))) return 'go test ./...';
  return 'none detected';
}

function detectComputerType(cwd = process.cwd(), pkg = null, binding = null) {
  if (binding?.computer_type) return binding.computer_type;
  if (binding?.workspace_type) return binding.workspace_type;
  const meta = pkg || readPackageMeta(cwd);
  if (meta?.bin || fs.existsSync(path.join(cwd, 'bin')) || fs.existsSync(path.join(cwd, 'commands'))) return 'codeops';
  if (fs.existsSync(path.join(cwd, 'docs')) || fs.existsSync(path.join(cwd, 'atris', 'wiki'))) return 'research';
  return 'workspace';
}

function buildComputerCard(cwd = process.cwd()) {
  const binding = readBusinessBinding(cwd);
  const pkg = readPackageMeta(cwd);
  const folderName = path.basename(cwd);
  const ownerName = binding?.name || pkg?.name || folderName;
  const ownerType = binding ? 'business' : 'project';
  const computerName = binding?.computer_name || binding?.workspace_name || `${ownerName} computer`;
  const computerType = detectComputerType(cwd, pkg, binding);
  const memory = [
    relIfExists(cwd, 'atris/MAP.md'),
    relIfExists(cwd, 'atris/TODO.md'),
    relIfExists(cwd, 'atris/wiki'),
    relIfExists(cwd, 'atris/logs'),
  ].filter(Boolean);
  const artifacts = [
    fs.existsSync(path.join(cwd, 'atris')) ? 'atris/reports/' : null,
    relIfExists(cwd, '.atris/receipts'),
  ].filter(Boolean);

  return {
    ownerName,
    ownerType,
    computerName,
    computerType,
    workspace: cwd,
    loop: 'plan -> do -> review',
    memory,
    validation: detectValidationCommand(cwd, pkg),
    proof: binding ? 'atris computer proof' : 'atris proof run',
    visual: 'atris visualize "<prompt>"',
    artifacts,
    generatedAt: new Date().toISOString(),
  };
}

function renderList(items) {
  return items.length ? items.join(', ') : 'none detected';
}

function renderComputerCard(card) {
  return [
    'Atris Computer Card',
    '',
    `  Owner:      ${card.ownerName} (${card.ownerType})`,
    `  Computer:   ${card.computerName}`,
    `  Type:       ${card.computerType}`,
    `  Workspace:  ${card.workspace}`,
    `  Loop:       ${card.loop}`,
    `  Memory:     ${renderList(card.memory)}`,
    `  Validate:   ${card.validation}`,
    `  Proof:      ${card.proof}`,
    `  Visual:     ${card.visual}`,
    `  Artifacts:  ${renderList(card.artifacts)}`,
  ].join('\n');
}

function renderComputerCardMarkdown(card) {
  return [
    '# Atris Computer Card',
    '',
    `Generated: ${card.generatedAt}`,
    '',
    `- Owner: ${card.ownerName} (${card.ownerType})`,
    `- Computer: ${card.computerName}`,
    `- Type: ${card.computerType}`,
    `- Workspace: ${card.workspace}`,
    `- Loop: ${card.loop}`,
    `- Memory: ${renderList(card.memory)}`,
    `- Validate: ${card.validation}`,
    `- Proof: ${card.proof}`,
    `- Visual: ${card.visual}`,
    `- Artifacts: ${renderList(card.artifacts)}`,
    '',
  ].join('\n');
}

function parseComputerCardArgs(args = []) {
  const options = { write: false, out: null, help: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--write') options.write = true;
    else if (arg === '--out' && args[i + 1]) options.out = args[++i];
    else if (arg.startsWith('--out=')) options.out = arg.slice('--out='.length);
  }
  return options;
}

function defaultComputerCardPath(cwd = process.cwd()) {
  if (fs.existsSync(path.join(cwd, 'atris'))) {
    return path.join(cwd, 'atris', 'reports', 'computer-card.md');
  }
  return path.join(cwd, 'computer-card.md');
}

function computerCard(args = [], cwd = process.cwd()) {
  const options = parseComputerCardArgs(args);
  if (options.help) {
    console.log('Usage: atris computer card [--write] [--out <path>]');
    console.log('');
    console.log('Show the local owner/computer card for this workspace.');
    return null;
  }

  const card = buildComputerCard(cwd);
  console.log(renderComputerCard(card));

  if (options.write || options.out) {
    const outputPath = options.out
      ? (path.isAbsolute(options.out) ? options.out : path.join(cwd, options.out))
      : defaultComputerCardPath(cwd);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, renderComputerCardMarkdown(card), 'utf8');
    console.log('');
    console.log(`Wrote ${path.relative(cwd, outputPath) || outputPath}`);
    return outputPath;
  }

  return card;
}

async function resolveBusinessContext(token) {
  const binding = readBusinessBinding();
  if (!binding) return null;

  if (binding.business_id && binding.workspace_id) {
    return {
      slug: binding.slug,
      businessId: binding.business_id,
      workspaceId: binding.workspace_id,
      businessName: binding.name || binding.slug || 'business',
    };
  }

  const slug = binding.slug;
  if (!slug) return null;

  const businesses = loadBusinesses();
  const list = await apiRequestJson('/business/', { method: 'GET', token });
  if (list.ok) {
    const match = (list.data || []).find(
      (b) => b.slug === slug || (b.name || '').toLowerCase() === slug.toLowerCase()
    );
    if (match) {
      businesses[slug] = {
        business_id: match.id,
        workspace_id: match.workspace_id,
        name: match.name,
        slug: match.slug,
        added_at: new Date().toISOString(),
      };
      saveBusinesses(businesses);
      return {
        slug: match.slug,
        businessId: match.id,
        workspaceId: match.workspace_id,
        businessName: match.name || match.slug,
      };
    }
  }

  const cached = businesses[slug];
  if (cached && cached.business_id && cached.workspace_id) {
    return {
      slug,
      businessId: cached.business_id,
      workspaceId: cached.workspace_id,
      businessName: cached.name || slug,
    };
  }

  return null;
}

function cachedBusinessContext(slug) {
  if (!slug) return null;
  const wanted = String(slug).toLowerCase();
  const businesses = loadBusinesses();
  const cached = businesses[slug] || Object.values(businesses).find((entry) => {
    if (!entry) return false;
    return String(entry.slug || '').toLowerCase() === wanted
      || String(entry.canonical_slug || '').toLowerCase() === wanted
      || String(entry.name || '').toLowerCase() === wanted;
  });
  if (!cached?.business_id) return null;
  return {
    slug: cached.slug || slug,
    businessId: cached.business_id,
    workspaceId: cached.workspace_id || null,
    businessName: cached.name || cached.slug || slug,
  };
}

async function resolveBusinessContextBySlug(token, slug, options = {}) {
  if (!slug) return null;

  if (options.preferCache) {
    const cached = cachedBusinessContext(slug);
    if (cached?.workspaceId) return cached;
  }

  const businesses = loadBusinesses();
  const list = await apiRequestJson('/business/', { method: 'GET', token });
  if (list.ok) {
    const match = (list.data || []).find(
      (b) => b.slug === slug || (b.name || '').toLowerCase() === slug.toLowerCase()
    );
    if (match) {
      businesses[match.slug || slug] = {
        business_id: match.id,
        workspace_id: match.workspace_id,
        name: match.name,
        slug: match.slug,
        added_at: new Date().toISOString(),
      };
      saveBusinesses(businesses);
      return {
        slug: match.slug,
        businessId: match.id,
        workspaceId: match.workspace_id,
        businessName: match.name || match.slug,
      };
    }
  }

  return null;
}

async function resolveComputerCommandContext(token, options = {}) {
  if (options.businessSlug || options.workspaceId) {
    const ctx = options.businessSlug
      ? await resolveBusinessContextBySlug(token, options.businessSlug, { preferCache: true })
      : await resolveBusinessContext(token);
    if (!ctx?.businessId) return null;
    const workspaceId = options.workspaceId
      ? await resolveWorkspaceSelector(token, ctx, options.workspaceId)
      : ctx.workspaceId;
    return {
      ...ctx,
      workspaceId,
    };
  }

  return resolveBusinessContext(token);
}

async function resolveTypedBusinessComputerContext(token, options = {}, defaults = {}) {
  const businessSlug = options.businessSlug || defaults.businessSlug;
  const computerType = normalizeComputerType(defaults.computerType);
  if (options.workspaceId) {
    return resolveComputerCommandContext(token, { ...options, businessSlug });
  }

  const ctx = await resolveBusinessContextBySlug(token, businessSlug, { preferCache: true });
  if (!ctx?.businessId) return null;
  const workspaces = await listBusinessWorkspaces(token, ctx);
  const workspace = resolveWorkspaceByComputerType(workspaces, computerType);
  if (!workspace?.id) {
    return {
      ...ctx,
      workspaceId: null,
      missingComputerType: computerType,
    };
  }
  return {
    ...ctx,
    workspaceId: workspace.id,
    workspaceName: workspace.name || null,
    computerType,
  };
}

function printMissingTypedComputer(ctx, computerType, options = {}) {
  const label = options.label || computerType;
  const businessSlug = options.businessSlug || ctx?.slug || RECRUITING_BUSINESS_SLUG;
  console.error(`No ${label} computer found for ${ctx?.businessName || businessSlug}.`);
  console.error(`Create it: atris computer ${label} create`);
  console.error(`Or explicitly create one: atris computer create "${label[0].toUpperCase()}${label.slice(1)} Computer" --business ${businessSlug} --type ${computerType}`);
  process.exitCode = 1;
}

function looksLikeWorkspaceId(input) {
  const value = String(input || '').trim();
  if (!value) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    || /^ws-[a-z0-9_-]+$/i.test(value);
}

async function resolveWorkspaceSelector(token, ctx, input) {
  const selector = String(input || '').trim();
  if (!selector) return ctx.workspaceId;
  if (selector === ctx.workspaceId || looksLikeWorkspaceId(selector)) return selector;

  const workspaces = await listBusinessWorkspaces(token, ctx);
  const workspace = resolveWorkspaceFromList(workspaces, selector);
  return workspace?.id || selector;
}

async function resolveBusinessOwnerForCreate(token, businessSlug = null) {
  const wantedSlug = businessSlug ? String(businessSlug).trim() : null;
  if (wantedSlug) {
    const fromApi = await resolveBusinessContextBySlug(token, wantedSlug);
    if (fromApi) return fromApi;

    const cached = loadBusinesses()[wantedSlug];
    if (cached?.business_id) {
      return {
        slug: cached.slug || wantedSlug,
        businessId: cached.business_id,
        workspaceId: cached.workspace_id || null,
        businessName: cached.name || cached.slug || wantedSlug,
      };
    }
    return null;
  }

  const binding = readBusinessBinding();
  if (binding?.business_id) {
    return {
      slug: binding.slug || binding.canonical_slug || null,
      businessId: binding.business_id,
      workspaceId: binding.workspace_id || null,
      businessName: binding.name || binding.slug || 'business',
    };
  }

  return resolveBusinessContext(token);
}

function businessSelector(ctx) {
  return ctx?.slug || ctx?.businessId || '<business>';
}

function apiFailureDetail(result) {
  return String(result?.errorMessage || result?.error || result?.data?.detail || result?.status || 'Request failed');
}

function printComputerCommandFailure(result, ctx = null) {
  const detail = apiFailureDetail(result);
  console.error(detail);
  if (result?.status === 409) {
    const mismatch = extractAttachedWorkspaceMismatch(detail, result?.data);
    const targetWorkspace = mismatch?.requestedWorkspaceId || ctx?.workspaceId || '<workspace-id>';
    const forceFlag = /--force|force to take over|re-run with --force/i.test(detail) ? ' --force' : '';
    console.error(`Run: atris computer activate --business ${businessSelector(ctx)} --workspace ${targetWorkspace}${forceFlag}`);
  }
}

function rememberBusinessWorkspace(ctx, workspaceId, options = {}) {
  const slug = ctx.slug || (ctx.businessName || '').toLowerCase().replace(/\s+/g, '-');
  if (!slug || !workspaceId) return;
  const businesses = loadBusinesses();
  const existing = businesses[slug] || {};
  businesses[slug] = {
    ...existing,
    business_id: ctx.businessId,
    workspace_id: workspaceId,
    name: ctx.businessName,
    slug,
    computer_name: options.computerName || existing.computer_name,
    endpoint: options.endpoint || existing.endpoint,
    added_at: existing.added_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  saveBusinesses(businesses);
}

function rememberCreatedComputer(ctx, workspace, endpoint = null, options = {}) {
  const slug = ctx.slug || (ctx.businessName || '').toLowerCase().replace(/\s+/g, '-');
  if (!slug) return;
  const businesses = loadBusinesses();
  const existing = businesses[slug] || {};
  const shouldSetDefault = Boolean(options.setDefault || !existing.workspace_id);
  businesses[slug] = {
    ...existing,
    business_id: ctx.businessId,
    workspace_id: shouldSetDefault ? workspace.id : existing.workspace_id,
    name: ctx.businessName,
    slug,
    computer_name: shouldSetDefault ? workspace.name : existing.computer_name,
    computer_type: shouldSetDefault ? (options.computerType || existing.computer_type) : existing.computer_type,
    endpoint: shouldSetDefault ? (endpoint || existing.endpoint) : existing.endpoint,
    added_at: existing.added_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  saveBusinesses(businesses);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function businessPromptUserId(token) {
  const claims = decodeJwtClaims(token) || {};
  return claims.sub || claims.user_id || claims.uid || null;
}

async function runBusinessTerminalCommand(token, ctx, command, timeout = 30) {
  return apiRequestJson(
    `/business/${ctx.businessId}/workspaces/${ctx.workspaceId}/terminal`,
    {
      method: 'POST',
      token,
      body: { command, timeout },
      timeoutMs: Math.max(timeout + 10, 40) * 1000,
    }
  );
}

async function listBusinessWorkspaces(token, ctx) {
  const result = await apiRequestJson(`/business/${ctx.businessId}/workspaces`, {
    method: 'GET',
    token,
    timeoutMs: 15000,
    retries: 0,
  });
  return result.ok && Array.isArray(result.data) ? result.data : [];
}

function formatWorkspaceRef(workspace) {
  if (!workspace) return '-';
  return workspace.name ? `${workspace.name} (${workspace.id})` : workspace.id;
}

function workspaceMatchesInput(workspace, input) {
  if (!workspace || !input) return false;
  const wanted = String(input).trim().toLowerCase();
  if (!wanted) return false;
  return String(workspace.id || '').toLowerCase() === wanted
    || String(workspace.name || '').toLowerCase() === wanted;
}

function resolveWorkspaceFromList(workspaces, input) {
  return (workspaces || []).find((workspace) => workspaceMatchesInput(workspace, input)) || null;
}

function workspaceComputerType(workspace) {
  return normalizeComputerType(workspace?.type || workspace?.computer_type || workspace?.workspace_type || '');
}

function workspaceMatchesComputerType(workspace, type) {
  if (!workspace || !type) return false;
  const wanted = normalizeComputerType(type);
  if (workspaceComputerType(workspace) === wanted) return true;
  const compactWanted = wanted.replace(/_/g, '');
  const name = String(workspace.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  return Boolean(compactWanted && name.includes(compactWanted));
}

function resolveWorkspaceByComputerType(workspaces, type) {
  return (workspaces || []).find((workspace) => workspaceMatchesComputerType(workspace, type)) || null;
}

function formatLeaseAge(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) return '-';
  if (value < 60) return `${Math.floor(value)}s`;
  const minutes = Math.floor(value / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

async function probeAttachedWorkspace(token, ctx) {
  const result = await apiRequestJson(
    `/business/${ctx.businessId}/workspaces/${ctx.workspaceId}/terminal`,
    {
      method: 'POST',
      token,
      body: { command: 'printf "ATRIS_STATUS_OK\\n"', timeout: 5 },
      timeoutMs: 8000,
      retries: 0,
    }
  );
  if (result.ok) return { workspaceId: ctx.workspaceId, health: 'ready' };
  const mismatch = extractAttachedWorkspaceMismatch(apiFailureDetail(result), result.data);
  if (mismatch?.attachedWorkspaceId) {
    return { workspaceId: mismatch.attachedWorkspaceId, health: 'workspace_mismatch', result };
  }
  return { workspaceId: null, health: 'degraded', result };
}

async function bootstrapBusinessComputerRuntime(token, ctx, boundary = 'computer-wake', options = {}) {
  if (!ctx?.businessId || !ctx?.workspaceId) {
    return { ok: false, skipped: true, reason: 'missing_workspace' };
  }
  if (process.env.ATRIS_SKIP_RUNTIME_BOOTSTRAP === '1') {
    return { ok: true, skipped: true, reason: 'env' };
  }

  const command = buildRemoteAtrisBootstrapCommand({
    boundary,
    businessSlug: ctx.slug || '',
    businessId: ctx.businessId,
    workspaceId: ctx.workspaceId,
  });
  const result = await runBusinessTerminalCommand(token, ctx, command, 120);
  if (!result.ok) {
    if (!options.quiet) {
      console.log('  Runtime: bootstrap could not run.');
      console.log(`  Recovery: atris computer run "npm install --prefix /workspace/.atris-npm atris@latest && /workspace/.atris-npm/node_modules/.bin/atris update" --business ${ctx.slug || ctx.businessId} --workspace ${ctx.workspaceId}`);
    }
    return { ok: false, result };
  }

  const data = result.data || {};
  const output = String(data.stdout || data.output || data.result || '').trim();
  const line = output.split('\n').find((entry) => entry.includes('atris_runtime_bootstrap'));
  const recovery = output.split('\n').find((entry) => entry.startsWith('recovery='));
  if (!options.quiet) {
    if (line) {
      console.log(`  Runtime: ${line.replace(/^atris_runtime_bootstrap\s*/, '')}`);
    } else {
      console.log('  Runtime: Atris bootstrap receipt written.');
    }
    if (recovery) {
      console.log(`  Recovery: atris computer run "${recovery.slice('recovery='.length)}" --business ${ctx.slug || ctx.businessId} --workspace ${ctx.workspaceId}`);
    }
  }
  return { ok: true, output };
}

async function readBusinessWorkspaceFile(token, ctx, remotePath, timeoutMs = 15000) {
  return apiRequestJson(
    `/business/${ctx.businessId}/workspaces/${ctx.workspaceId}/file?path=${encodeURIComponent(remotePath)}`,
    {
      method: 'GET',
      token,
      timeoutMs,
    }
  );
}

function extractRunnerProxyText(payload = {}) {
  const result = String(payload.result || '').trim();
  if (result) return result;
  if (Array.isArray(payload.assistant_text)) {
    const joined = payload.assistant_text.join('').trim();
    if (joined) return joined;
  }
  if (typeof payload.text === 'string' && payload.text.trim()) {
    return payload.text.trim();
  }
  return '';
}

async function runBusinessPromptViaRunnerProxy(token, ctx, prompt, options = {}) {
  const requestId = `cli-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
  const remoteDir = '/workspace/.atris-runner-proxy';
  const outputPath = `${remoteDir}/${requestId}.json`;
  const scriptPath = `/tmp/atris_runner_proxy_${requestId}.py`;
  const stdoutPath = `/tmp/atris_runner_proxy_${requestId}.stdout`;
  const stderrPath = `/tmp/atris_runner_proxy_${requestId}.stderr`;
  const payload = {
    prompt,
    permission_mode: 'bypassPermissions',
    max_turns: Math.min(Math.max(Number(options.maxTurns || 12), 1), 25),
    reset_context: Boolean(options.resetContext),
  };
  if (options.worker) payload.worker = options.worker;
  if (options.model) payload.model = options.model;
  if (options.systemPrompt) payload.system_prompt = options.systemPrompt;
  if (options.allowedTools) payload.allowed_tools = options.allowedTools;
  if (options.localCliSessionId) payload.local_cli_session_id = options.localCliSessionId;

  const userId = businessPromptUserId(token);
  if (userId) payload.user_id = userId;

  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  const remoteScript = [
    'import base64, json, pathlib, time, urllib.request',
    `PAYLOAD = json.loads(base64.b64decode(${JSON.stringify(payloadB64)}).decode("utf-8"))`,
    `OUTPUT_PATH = pathlib.Path(${JSON.stringify(outputPath)})`,
    'TOKEN = ""',
    'with open("/opt/atris/config/env", "r", encoding="utf-8") as fh:',
    '    for line in fh:',
    '        if line.startswith("ATRIS_SERVICE_TOKEN="):',
    '            TOKEN = line.split("=", 1)[1].strip()',
    '            break',
    'if not TOKEN:',
    '    OUTPUT_PATH.write_text(json.dumps({"status":"error","error":"missing ATRIS_SERVICE_TOKEN"}), encoding="utf-8")',
    '    raise SystemExit(0)',
    'def _fetch(req, timeout=120):',
    '    with urllib.request.urlopen(req, timeout=timeout) as resp:',
    '        return json.loads(resp.read().decode("utf-8"))',
    'try:',
    '    start_req = urllib.request.Request(',
    '        "http://127.0.0.1:8081/execute-background",',
    '        data=json.dumps(PAYLOAD).encode("utf-8"),',
    '        headers={"Content-Type":"application/json","X-Atris-Service-Token":TOKEN},',
    '        method="POST",',
    '    )',
    '    start = _fetch(start_req)',
    '    execution_id = start.get("execution_id")',
    '    result = {"execution_id": execution_id, "assistant_text": [], "result": "", "status": "running", "result_event": None}',
    '    from_index = 0',
    '    deadline = time.time() + 300',
    '    while time.time() < deadline:',
    '        poll_req = urllib.request.Request(',
    '            f"http://127.0.0.1:8081/events?execution_id={execution_id}&from_index={from_index}",',
    '            headers={"X-Atris-Service-Token":TOKEN},',
    '            method="GET",',
    '        )',
    '        data = _fetch(poll_req, timeout=60)',
    '        events = data.get("events") or []',
    '        for event in events:',
    '            typ = event.get("type")',
    '            if typ in ("assistant_text", "text"):',
    '                content = event.get("content") or ""',
    '                if content:',
    '                    result["assistant_text"].append(content)',
    '            elif typ == "result":',
    '                result["result"] = event.get("result") or result["result"]',
    '                result["result_event"] = event',
    '        from_index = data.get("next_index", from_index + len(events))',
    '        result["status"] = data.get("status") or result["status"]',
    '        if result["status"] in ("completed", "failed", "error", "cancelled"):',
    '            break',
    '        time.sleep(2)',
    '    OUTPUT_PATH.write_text(json.dumps(result), encoding="utf-8")',
    'except Exception as exc:',
    '    OUTPUT_PATH.write_text(json.dumps({"execution_id": None, "assistant_text": [], "result": "", "status": "error", "error": str(exc)}), encoding="utf-8")',
  ].join('\n');

  const launcher = [
    `mkdir -p ${shellQuote(remoteDir)}`,
    `cat > ${shellQuote(scriptPath)} <<'PY'`,
    remoteScript,
    'PY',
    `nohup python3 ${shellQuote(scriptPath)} >${shellQuote(stdoutPath)} 2>${shellQuote(stderrPath)} < /dev/null &`,
    'echo launched',
  ].join('\n');

  const launchResult = await runBusinessTerminalCommand(token, ctx, launcher, 30);
  if (!launchResult.ok) {
    return {
      ok: false,
      error: launchResult.error || `launcher failed (${launchResult.status})`,
      status: launchResult.status,
    };
  }

  const deadline = Date.now() + 330000;
  while (Date.now() < deadline) {
    const fileResult = await readBusinessWorkspaceFile(token, ctx, outputPath, 15000);
    if (!fileResult.ok) {
      if (fileResult.status === 404) {
        await sleep(2000);
        continue;
      }
      return {
        ok: false,
        error: fileResult.error || `runner proxy read failed (${fileResult.status})`,
        status: fileResult.status,
      };
    }
    try {
      const payload = JSON.parse(fileResult.data?.content || '{}');
      const status = payload.status || 'unknown';
      if (['completed', 'failed', 'error', 'cancelled', 'timeout'].includes(status)) {
        return { ok: status === 'completed', payload, status };
      }
    } catch {
      // Ignore partial file writes and keep polling.
    }
    await sleep(2000);
  }

  return { ok: false, error: 'runner proxy timed out', status: 0 };
}

async function ensureBusinessAwake(token, ctx, maxWaitSec = 90, options = {}) {
  const status = await apiRequestJson(`/business/${ctx.businessId}/ai-computer/status`, { method: 'GET', token });
  if (status.ok && status.data && status.data.status === 'running' && status.data.endpoint) {
    return true;
  }
  if (!options.quiet) process.stdout.write('  Waking business computer... ');
  await apiRequestJson(`/business/${ctx.businessId}/ai-computer/wake`, { method: 'POST', token, body: {} });
  const start = Date.now();
  while (Date.now() - start < maxWaitSec * 1000) {
    await sleep(3000);
    const next = await apiRequestJson(`/business/${ctx.businessId}/ai-computer/status`, { method: 'GET', token });
    if (next.ok && next.data && next.data.status === 'running' && next.data.endpoint) {
      const elapsed = Math.floor((Date.now() - start) / 1000);
      if (!options.quiet) console.log(`awake (${elapsed}s)`);
      await bootstrapBusinessComputerRuntime(token, ctx, 'computer-auto-wake', options);
      return true;
    }
  }
  if (!options.quiet) console.log('timeout');
  return false;
}

async function computerStatus(token, ctx = null) {
  if (ctx) {
    const result = await apiRequestJson(`/business/${ctx.businessId}/ai-computer/status`, {
      method: 'GET',
      token,
    });
    if (!result.ok) {
      console.error(`Failed: ${result.errorMessage || result.status}`);
      return;
    }
    const d = result.data || {};
    const status = d.status || 'unknown';
    const icon = status === 'running' ? '●' : '○';
    console.log(`  ${icon} Computer: ${status}`);
    console.log(`    Business: ${ctx.businessName}`);
    if (d.endpoint) console.log(`    Endpoint: ${d.endpoint}`);
    const workspaces = await listBusinessWorkspaces(token, ctx);
    const defaultWorkspace = workspaces.find((workspace) => workspace.is_default);
    const resolvedTargetWorkspace = resolveWorkspaceFromList(workspaces, ctx.workspaceId);
    const targetWorkspace = resolvedTargetWorkspace || (ctx.workspaceId ? { id: ctx.workspaceId } : null);
    const probeCtx = resolvedTargetWorkspace?.id
      ? { ...ctx, workspaceId: resolvedTargetWorkspace.id }
      : ctx;
    console.log(`    Default workspace:  ${formatWorkspaceRef(defaultWorkspace)}`);
    console.log(`    Target workspace:   ${formatWorkspaceRef(targetWorkspace)}`);
    const attachedFromStatus = d.attached_workspace_id
      ? { workspaceId: d.attached_workspace_id, health: null }
      : null;
    if (attachedFromStatus) {
      const attachedWorkspace = workspaces.find((workspace) => workspace.id === attachedFromStatus.workspaceId)
        || { id: attachedFromStatus.workspaceId, name: d.attached_workspace_name || null };
      console.log(`    Attached workspace: ${formatWorkspaceRef(attachedWorkspace)}`);
      console.log(`    Attached by:        ${d.attached_by || '-'}`);
      console.log(`    Attached at:        ${d.attached_at || '-'}`);
      console.log(`    Lease age:          ${formatLeaseAge(d.lease_age_seconds)}`);
      if (d.takeover_hint) console.log(`    Takeover hint:      ${d.takeover_hint}`);
    }
    if (status === 'running' && d.endpoint && probeCtx.workspaceId) {
      const attached = await probeAttachedWorkspace(token, probeCtx);
      if (!attachedFromStatus) {
        const attachedWorkspace = workspaces.find((workspace) => workspace.id === attached.workspaceId) || (attached.workspaceId ? { id: attached.workspaceId } : null);
        console.log(`    Attached workspace: ${formatWorkspaceRef(attachedWorkspace)}`);
      }
      if (attached.health === 'workspace_mismatch') {
        printComputerCommandFailure(attached.result, ctx);
      } else if (attached.health !== 'ready') {
        console.log(`    Health:   degraded (${apiFailureDetail(attached.result)})`);
      } else {
        console.log('    Health:   ready');
      }
    }
    return;
  }

  const result = await apiRequestJson('/ai-computer/user/status', {
    method: 'GET',
    token,
  });
  if (!result.ok) {
    console.error(`Failed: ${result.errorMessage || result.status}`);
    return;
  }
  const d = result.data;
  const status = d.status || 'unknown';
  const icon = status === 'running' ? '●' : '○';
  console.log(`  ${icon} Computer: ${status}`);
  console.log(`    Agent:    ${(d.agent_id || '?').slice(0, 12)}...`);
  if (d.endpoint) console.log(`    Endpoint: ${d.endpoint}`);

  // If running, show soul stats
  if (status === 'running') {
    try {
      const filesResult = await apiRequestJson('/ai-computer/files?path=soul', { method: 'GET', token });
      if (filesResult.ok) {
        const files = filesResult.data.files || [];
        const totalSize = files.reduce((sum, f) => sum + (f.size || 0), 0);
        const learnings = files.filter(f => f.name && f.name.startsWith('learning-')).length;
        console.log(`    Soul:     ${files.length} files, ${(totalSize / 1024).toFixed(1)}KB`);
        console.log(`    Learnings: ${learnings} self-generated`);
      }
    } catch {}
  }
}

async function computerWake(token, ctx = null) {
  if (ctx) {
    console.log(`Waking computer for ${ctx.businessName}...`);
    const result = await apiRequestJson(`/business/${ctx.businessId}/ai-computer/wake`, {
      method: 'POST',
      token,
      body: {},
    });
    if (!result.ok) {
      console.error(`Failed: ${result.errorMessage || result.status}`);
      return;
    }
    console.log(`  Status:   ${result.data.status}`);
    if (result.data.endpoint) console.log(`  Endpoint: ${result.data.endpoint}`);
    await bootstrapBusinessComputerRuntime(token, ctx, 'computer-wake');
    console.log('  Computer is awake.');
    return;
  }

  console.log('Waking computer...');
  const result = await apiRequestJson('/ai-computer/user/wake', {
    method: 'POST',
    token,
    body: {},
  });
  if (!result.ok) {
    console.error(`Failed: ${result.errorMessage || result.status}`);
    return;
  }
  console.log(`  Status:   ${result.data.status}`);
  console.log(`  Endpoint: ${result.data.endpoint}`);
  console.log('  Computer is awake.');
}

async function computerCreate(token, args = [], defaults = {}) {
  const options = parseComputerCreateArgs(args);
  if (!options.businessSlug && defaults.businessSlug) {
    options.businessSlug = defaults.businessSlug;
  }
  if (!options.computerType && defaults.computerType) {
    options.computerType = normalizeComputerType(defaults.computerType);
  }
  const computerType = options.computerType || 'general';
  if (options.help || !options.name) {
    console.log('Usage: atris computer create <name> --business <slug> [--type <type>] [--set-default]');
    console.log('');
    console.log('Create a business computer, activate it, and wake it in one command.');
    console.log(`Types: ${formatComputerTypeList()}`);
    console.log('');
    console.log('Examples:');
    console.log('  atris computer create "My Business Computer" --business atris-labs');
    console.log('  atris computer create "Recruiting Computer" --business atris-labs --type recruiting');
    if (!options.name && !options.help) process.exitCode = 1;
    return;
  }

  if (!VALID_COMPUTER_TYPES.has(computerType)) {
    console.error(`Invalid computer type: ${computerType}`);
    console.error(`Expected one of: ${formatComputerTypeList()}`);
    process.exitCode = 1;
    return;
  }

  const ctx = await resolveBusinessOwnerForCreate(token, options.businessSlug);
  if (!ctx?.businessId) {
    console.error('No business found.');
    console.error('Run inside a bound business workspace or pass: --business <slug>');
    process.exitCode = 1;
    return;
  }

  console.log(`Creating computer "${options.name}" for ${ctx.businessName}...`);
  const created = await apiRequestJson(`/business/${ctx.businessId}/workspaces`, {
    method: 'POST',
    token,
    body: { name: options.name, type: computerType },
  });
  if (!created.ok) {
    console.error(`Failed to create workspace: ${created.errorMessage || created.error || created.status}`);
    process.exitCode = 1;
    return;
  }

  const workspace = created.data || {};
  const workspaceId = workspace.id || workspace.workspace_id;
  if (!workspaceId) {
    console.error('Failed to create workspace: response did not include workspace id');
    process.exitCode = 1;
    return;
  }

  const activate = await apiRequestJson(`/business/${ctx.businessId}/workspaces/${workspaceId}/activate`, {
    method: 'POST',
    token,
    body: {},
  });
  if (!activate.ok && activate.status !== 409) {
    console.error(`Failed to activate computer: ${activate.errorMessage || activate.error || activate.status}`);
    process.exitCode = 1;
    return;
  }

  const wake = await apiRequestJson(`/business/${ctx.businessId}/ai-computer/wake`, {
    method: 'POST',
    token,
    body: {},
  });
  if (!wake.ok && !activate.ok) {
    console.error(`Failed to wake computer: ${wake.errorMessage || wake.error || wake.status}`);
    process.exitCode = 1;
    return;
  }

  const endpoint = activate.data?.endpoint || wake.data?.endpoint || null;
  const status = endpoint
    ? 'running'
    : (wake.data?.status || (activate.ok ? 'activated' : 'warming_up'));
  rememberCreatedComputer(ctx, { ...workspace, id: workspaceId, name: workspace.name || options.name }, endpoint, {
    setDefault: options.setDefault,
    computerType,
  });
  await bootstrapBusinessComputerRuntime(token, { ...ctx, workspaceId }, 'computer-create');

  const appBase = getAppBaseUrl();
  console.log('');
  console.log(`Computer created: ${workspaceId}`);
  console.log(`  Name:      ${workspace.name || options.name}`);
  console.log(`  Type:      ${computerType}`);
  console.log(`  Business:  ${ctx.businessName}`);
  console.log(`  Status:    ${status}`);
  if (endpoint) console.log(`  Endpoint:  ${endpoint}`);
  console.log(`  Dashboard: ${appBase}/dashboard/gm/${ctx.businessId}`);
  const owner = ctx.slug || ctx.businessId;
  if (options.setDefault || !ctx.workspaceId) {
    console.log(`  Default:   now ${workspaceId}`);
  } else {
    console.log(`  Default:   unchanged (${ctx.workspaceId})`);
    console.log(`  Switch default: atris computer activate --business ${owner} --workspace ${workspaceId}`);
  }
  console.log('');
  console.log('Start here:');
  console.log(`  atris computer --business ${owner} --workspace ${workspaceId}`);
  console.log('');
  console.log('Org workspace:');
  console.log(`  cd ~/arena/atris-business/${owner}`);
  console.log('  atris member activate operator');
  console.log('  atris member activate validator');
  console.log('');
  console.log('If the org workspace does not exist yet:');
  console.log(`  atris business init "${ctx.businessName}"`);
  console.log('');
  console.log('Cost control:');
  console.log(`  atris computer sleep --business ${owner} --workspace ${workspaceId}`);
}

async function computerActivate(token, ctx = null, options = {}) {
  if (!ctx?.businessId || !ctx?.workspaceId) {
    console.error('Usage: atris computer activate --business <slug> --workspace <id>');
    process.exitCode = 1;
    return;
  }

  const result = await apiRequestJson(`/business/${ctx.businessId}/workspaces/${ctx.workspaceId}/activate`, {
    method: 'POST',
    token,
    body: { force: Boolean(options.force) },
  });
  if (!result.ok) {
    printComputerCommandFailure(result, ctx);
    process.exitCode = 1;
    return;
  }

  const workspaces = await listBusinessWorkspaces(token, ctx);
  const workspace = workspaces.find((row) => row.id === ctx.workspaceId) || { id: ctx.workspaceId };
  rememberBusinessWorkspace(ctx, ctx.workspaceId, {
    computerName: workspace.name,
    endpoint: result.data?.endpoint,
  });

  console.log(`Activated workspace ${ctx.workspaceId} for ${ctx.businessName}.`);
  if (workspace.name) console.log(`  Name:     ${workspace.name}`);
  if (result.data?.endpoint) console.log(`  Endpoint: ${result.data.endpoint}`);
  console.log(`  CLI default: ${ctx.workspaceId}`);
}

async function computerSleep(token, ctx = null) {
  if (ctx) {
    console.log(`Sleeping computer for ${ctx.businessName}...`);
    const result = await apiRequestJson(`/business/${ctx.businessId}/ai-computer/sleep`, {
      method: 'POST',
      token,
      body: {},
    });
    if (!result.ok) {
      console.error(`Failed: ${result.errorMessage || result.status}`);
      return;
    }
    console.log('  Computer is sleeping. Files persist.');
    console.log('  No compute cost while sleeping.');
    return;
  }

  console.log('Sleeping computer...');
  const result = await apiRequestJson('/ai-computer/user/sleep', {
    method: 'POST',
    token,
    body: {},
  });
  if (!result.ok) {
    console.error(`Failed: ${result.errorMessage || result.status}`);
    return;
  }
  console.log('  Computer is sleeping. Files persist.');
  console.log('  No compute cost while sleeping.');
}

function rememberDeletedComputer(ctx) {
  const businesses = loadBusinesses();
  let changed = false;
  for (const [slug, entry] of Object.entries(businesses)) {
    if (!entry) continue;
    const sameBusiness = entry.business_id === ctx.businessId || slug === ctx.slug;
    const sameWorkspace = entry.workspace_id === ctx.workspaceId;
    if (sameBusiness && sameWorkspace) {
      delete entry.workspace_id;
      delete entry.computer_name;
      delete entry.endpoint;
      entry.deleted_workspace_id = ctx.workspaceId;
      entry.updated_at = new Date().toISOString();
      changed = true;
    }
  }
  if (changed) saveBusinesses(businesses);
}

async function confirmComputerDelete(ctx, options) {
  const expected = `delete ${ctx.workspaceId}`;
  if (String(options.confirm || '').trim() === expected) return true;

  console.log('');
  console.log('This will sleep the computer first, then delete the workspace record.');
  console.log(`Business:  ${ctx.businessName}`);
  console.log(`Workspace: ${ctx.workspaceId}`);
  console.log(`Type "${expected}" to continue.`);

  if (!useInteractiveTerminalUi()) {
    console.error(`Confirmation required. Re-run with: --confirm "${expected}"`);
    return false;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = String(await questionAsync(rl, 'Confirm: ') || '').trim();
  rl.close();
  if (answer === expected) return true;

  console.error('Delete cancelled.');
  return false;
}

async function computerDelete(token, ctx, options = {}, args = []) {
  const deleteOptions = parseComputerDeleteArgs(args);
  if (deleteOptions.help) {
    console.log('Usage: atris computer delete --business <slug> --workspace <workspace-id>');
    console.log('');
    console.log('Sleeps the computer first, then deletes the non-default workspace after confirmation.');
    console.log('');
    console.log('Examples:');
    console.log('  atris computer delete --business atris-labs --workspace ws_123');
    console.log('  atris computer delete --business atris-labs --workspace ws_123 --confirm "delete ws_123"');
    return;
  }

  if (!ctx?.businessId) {
    console.error('No business found.');
    console.error('Pass: --business <slug> --workspace <workspace-id>');
    process.exitCode = 1;
    return;
  }

  if (!options.workspaceId || !ctx.workspaceId) {
    console.error('Refusing to delete without an explicit workspace id.');
    console.error('Pass: --workspace <workspace-id>');
    process.exitCode = 1;
    return;
  }

  const confirmed = await confirmComputerDelete(ctx, deleteOptions);
  if (!confirmed) {
    process.exitCode = 1;
    return;
  }

  console.log(`Sleeping computer for ${ctx.businessName}...`);
  const slept = await apiRequestJson(`/business/${ctx.businessId}/ai-computer/sleep`, {
    method: 'POST',
    token,
    body: {},
  });
  if (!slept.ok) {
    console.error(`Failed to sleep computer: ${slept.errorMessage || slept.error || slept.status}`);
    process.exitCode = 1;
    return;
  }

  console.log('  Computer is sleeping. Files persist.');
  console.log(`Deleting workspace ${ctx.workspaceId}...`);
  const deleted = await apiRequestJson(`/business/${ctx.businessId}/workspaces/${ctx.workspaceId}`, {
    method: 'DELETE',
    token,
  });
  if (!deleted.ok) {
    console.error(`Failed to delete computer: ${deleted.errorMessage || deleted.error || deleted.status}`);
    if (deleted.status === 400) console.error('Default workspaces cannot be deleted.');
    process.exitCode = 1;
    return;
  }

  rememberDeletedComputer(ctx);
  console.log('  Computer deleted.');
  console.log('  Cost gate: sleeping before delete completed.');
}

async function computerRun(token, command, ctx = null) {
  if (!command) {
    console.error('Usage: atris computer run <command>');
    process.exit(1);
  }

  if (ctx) {
    const awake = await ensureBusinessAwake(token, ctx);
    if (!awake) {
      console.error('  Computer did not become ready in time.');
      return;
    }
    const result = await apiRequestJson(
      `/business/${ctx.businessId}/workspaces/${ctx.workspaceId}/terminal`,
      {
        method: 'POST',
        token,
        body: { command, timeout: 30 },
        timeoutMs: 40000,
      }
    );
    if (!result.ok) {
      printComputerCommandFailure(result, ctx);
      return;
    }
    const d = result.data || {};
    if (d.stdout) process.stdout.write(d.stdout);
    if (d.stderr) process.stderr.write(d.stderr);
    if (d.exit_code && d.exit_code !== 0) {
      console.error(`Exit: ${d.exit_code}`);
    }
    return;
  }

  const result = await apiRequestJson('/ai-computer/terminal', {
    method: 'POST',
    token,
    body: { command },
  });
  if (!result.ok) {
    printComputerCommandFailure(result);
    return;
  }
  const d = result.data;
  if (d.stdout) process.stdout.write(d.stdout);
  if (d.stderr) process.stderr.write(d.stderr);
  if (d.exit_code && d.exit_code !== 0) {
    console.error(`Exit: ${d.exit_code}`);
  }
}

async function computerGrep(token, pattern, ctx = null) {
  if (!pattern) {
    console.error('Usage: atris computer grep <pattern>');
    process.exit(1);
  }
  return computerRun(token, `grep -rni "${pattern}" . --include="*.md" --include="*.py" --include="*.js" --include="*.json" 2>/dev/null | head -30`, ctx);
}

async function computerLs(token, remotePath, ctx = null) {
  const path = remotePath || '/';

  if (ctx) {
    const result = await apiRequestJson(
      `/business/${ctx.businessId}/workspaces/${ctx.workspaceId}/files?path=${encodeURIComponent(path)}`,
      {
        method: 'GET',
        token,
      }
    );
    if (!result.ok) {
      console.error(`Failed: ${result.errorMessage || result.status}`);
      return;
    }
    for (const f of (result.data.files || [])) {
      const type = f.type === 'dir' ? 'DIR ' : '    ';
      console.log(`  ${type}${f.name}  (${f.size || 0}b)`);
    }
    return;
  }

  const result = await apiRequestJson(`/ai-computer/files?path=${encodeURIComponent(path)}`, {
    method: 'GET',
    token,
  });
  if (!result.ok) {
    console.error(`Failed: ${result.errorMessage || result.status}`);
    return;
  }
  for (const f of (result.data.files || [])) {
    const type = f.type === 'dir' ? 'DIR ' : '    ';
    console.log(`  ${type}${f.name}  (${f.size || 0}b)`);
  }
}

async function computerCat(token, remotePath, ctx = null) {
  if (!remotePath) {
    console.error('Usage: atris computer cat <path>');
    process.exit(1);
  }

  if (ctx) {
    const result = await apiRequestJson(
      `/business/${ctx.businessId}/workspaces/${ctx.workspaceId}/file?path=${encodeURIComponent(remotePath)}`,
      {
        method: 'GET',
        token,
      }
    );
    if (!result.ok) {
      console.error(`Failed: ${result.errorMessage || result.status}`);
      return;
    }
    console.log(result.data.content || '');
    return;
  }

  const result = await apiRequestJson(`/ai-computer/file?path=${encodeURIComponent(remotePath)}`, {
    method: 'GET',
    token,
  });
  if (!result.ok) {
    console.error(`Failed: ${result.errorMessage || result.status}`);
    return;
  }
  console.log(result.data.content || '');
}

async function computerDiff(token, remotePath, ctx = null) {
  const rPath = remotePath || 'soul';

  // List remote files
  const listPath = ctx
    ? `/business/${ctx.businessId}/workspaces/${ctx.workspaceId}/files?path=${encodeURIComponent(rPath)}`
    : `/ai-computer/files?path=${encodeURIComponent(rPath)}`;
  const listResult = await apiRequestJson(listPath, { method: 'GET', token });
  if (!listResult.ok) {
    console.error(`Failed: ${listResult.errorMessage || listResult.status}`);
    return;
  }
  const remoteFiles = (listResult.data.files || []).filter(f => f.type === 'file');

  // Compare with local ec2_pull/
  const localDir = 'experiments/computer/ec2_pull';
  let added = 0, modified = 0, same = 0, deleted = 0;

  for (const f of remoteFiles) {
    const localPath = path.join(localDir, f.name);
    if (!fs.existsSync(localPath)) {
      console.log(`  + ${f.name} (${f.size}b) — new on EC2`);
      added++;
    } else {
      const localSize = fs.statSync(localPath).size;
      if (Math.abs(localSize - (f.size || 0)) > 10) {
        console.log(`  ~ ${f.name} (local: ${localSize}b, EC2: ${f.size}b) — changed`);
        modified++;
      } else {
        same++;
      }
    }
  }

  // Check for files deleted on EC2
  if (fs.existsSync(localDir)) {
    const remoteNames = new Set(remoteFiles.map(f => f.name));
    for (const localFile of fs.readdirSync(localDir)) {
      if (!remoteNames.has(localFile) && localFile.endsWith('.md')) {
        console.log(`  - ${localFile} — deleted on EC2`);
        deleted++;
      }
    }
  }

  console.log(`\n  ${added} new, ${modified} changed, ${deleted} deleted, ${same} unchanged`);
}

async function computerPull(token, remotePath, localDir, ctx = null) {
  const rPath = remotePath || 'soul';
  const lDir = localDir || 'ec2_pull';

  // List files
  const listPath = ctx
    ? `/business/${ctx.businessId}/workspaces/${ctx.workspaceId}/files?path=${encodeURIComponent(rPath)}`
    : `/ai-computer/files?path=${encodeURIComponent(rPath)}`;
  const listResult = await apiRequestJson(listPath, { method: 'GET', token });
  if (!listResult.ok) {
    console.error(`Failed to list: ${listResult.errorMessage || listResult.status}`);
    return;
  }
  const files = (listResult.data.files || []).filter(f => f.type === 'file');
  if (files.length === 0) {
    console.log('  No files to pull.');
    return;
  }

  // Create local dir
  fs.mkdirSync(lDir, { recursive: true });
  console.log(`Pulling ${files.length} files from ${rPath}/ → ${lDir}/`);

  let pulled = 0;
  for (const f of files) {
    const filePath = ctx
      ? `/business/${ctx.businessId}/workspaces/${ctx.workspaceId}/file?path=${encodeURIComponent(rPath + '/' + f.name)}`
      : `/ai-computer/file?path=${encodeURIComponent(rPath + '/' + f.name)}`;
    const fileResult = await apiRequestJson(
      filePath,
      { method: 'GET', token, timeoutMs: 15000 }
    );
    if (fileResult.ok && fileResult.data.content) {
      const localPath = path.join(lDir, f.name);
      fs.writeFileSync(localPath, fileResult.data.content);
      console.log(`  ${f.name} (${fileResult.data.content.length}b)`);
      pulled++;
    }
  }
  console.log(`\n  Pulled ${pulled} files.`);
}

async function computerOnboard(token, businessSlug) {
  if (!businessSlug) {
    console.error('Usage: atris computer onboard <business-slug>');
    console.error('');
    console.error('Sets up a new business computer with soul, tools, and first learning cycle.');
    console.error('The business must already exist (atris business create).');
    process.exit(1);
  }

  const fs = require('fs');
  const path = require('path');

  console.log(`\nOnboarding "${businessSlug}"...`);

  // Step 1: Push soul template
  console.log('\n  1. Pushing soul template...');
  const soulTemplate = `# Soul — ${businessSlug}\n\n## Identity\nBusiness computer for ${businessSlug}. Self-improving context system.\n\n## Goals\n- Learn the business overnight\n- Accumulate context that makes the agent smarter\n- Track what works and what doesn't\n\n## Rules\n- No emails without approval\n- No destructive actions\n- Save everything to soul/\n`;

  const templateResult = await apiRequestJson('/ai-computer/terminal', {
    method: 'POST', token,
    body: { command: `mkdir -p soul tools && echo '${soulTemplate.replace(/'/g, "'\\''")}' > soul/soul.md && echo "Soul created"` },
  });
  if (templateResult.ok) console.log('    Soul template created');

  // Step 2: Push tools
  console.log('  2. Pushing tools...');
  const toolsResult = await apiRequestJson('/ai-computer/terminal', {
    method: 'POST', token,
    body: { command: [
      'cat > tools/rebuild_index.sh << \'TOOLEOF\'',
      '#!/bin/bash',
      'echo "# Context Index" > soul/INDEX.md',
      'echo "" >> soul/INDEX.md',
      'echo "Last updated: $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> soul/INDEX.md',
      'echo "" >> soul/INDEX.md',
      'COUNT=0; TOTAL_SIZE=0',
      'for f in soul/*.md; do',
      '  [ "$f" = "soul/INDEX.md" ] && continue',
      '  NAME=$(basename $f .md)',
      '  FIRST_LINE=$(head -1 $f | sed "s/^# //")',
      '  SIZE=$(wc -c < $f | tr -d " ")',
      '  echo "- [$NAME]($NAME.md) — $FIRST_LINE ($SIZE bytes)" >> soul/INDEX.md',
      '  COUNT=$((COUNT + 1)); TOTAL_SIZE=$((TOTAL_SIZE + SIZE))',
      'done',
      'echo "" >> soul/INDEX.md',
      'echo "**Total: $COUNT files, $TOTAL_SIZE bytes**" >> soul/INDEX.md',
      'echo "Indexed $COUNT files ($TOTAL_SIZE bytes)"',
      'TOOLEOF',
      'chmod +x tools/rebuild_index.sh',
      'bash tools/rebuild_index.sh',
    ].join('\n') },
  });
  if (toolsResult.ok) console.log(`    Tools installed. ${(toolsResult.data.stdout || '').trim()}`);

  // Step 3: Trigger first learning cycle
  console.log('  3. Starting first learning cycle...');
  const learnResult = await apiRequestJson('/ai-computer/execute', {
    method: 'POST', token,
    body: {
      prompt: `You are a brand new AI computer for a business called "${businessSlug}". ` +
        `Read your soul/soul.md to understand your identity. ` +
        `Then write soul/learning-001.md with your first observation: ` +
        `what information do you need to be useful? What should the business owner push to you first? ` +
        `Be specific about what files/data would make you most helpful. ` +
        `Then run: bash tools/rebuild_index.sh`,
    },
  });
  if (learnResult.ok) {
    console.log(`    Learning cycle started: ${learnResult.data.execution_id}`);
  }

  console.log(`\n  ✓ Computer onboarded for "${businessSlug}"`);
  console.log('');
  console.log('  Next steps:');
  console.log(`    atris push ${businessSlug} --from <your-context-dir>   Push your business files`);
  console.log(`    atris computer diff soul                              See what the computer learned`);
  console.log(`    atris computer learn                                  Trigger another learning cycle`);
}

async function computerLearn(token, ctx = null) {
  if (ctx) {
    console.error('Learning mode is not wired for business workspaces yet. Use `atris computer exec` for now.');
    return;
  }
  console.log('Starting learning cycle on EC2...');

  // First check how many learnings exist
  const countResult = await apiRequestJson('/ai-computer/terminal', {
    method: 'POST', token,
    body: { command: 'ls soul/learning-*.md 2>/dev/null | wc -l | tr -d " "' },
  });
  const count = parseInt((countResult.ok && countResult.data.stdout || '0').trim()) || 0;
  const next = String(count + 1).padStart(3, '0');
  console.log(`  Existing learnings: ${count}`);
  console.log(`  Next: soul/learning-${next}.md`);

  // Trigger LLM learning cycle
  const prompt = `Self-improvement cycle. Read soul/INDEX.md to see what you know. ` +
    `Check existing soul/learning-*.md files to avoid repeating topics. ` +
    `Pick ONE new topic that would make the overnight agent better at earning money for the business owner. ` +
    `Research it using the files and tools available. ` +
    `Write your finding to soul/learning-${next}.md. Be specific and actionable. ` +
    `Then run: bash tools/rebuild_index.sh`;

  const result = await apiRequestJson('/ai-computer/execute', {
    method: 'POST', token,
    body: { prompt },
  });
  if (!result.ok) {
    console.error(`Failed: ${result.errorMessage || result.status}`);
    return;
  }
  console.log(`  Learning cycle started: ${result.data.execution_id}`);
  console.log(`  The computer is thinking... check back with: atris computer diff soul`);
}

async function computerExec(token, prompt, ctx = null, options = {}) {
  if (!prompt) {
    console.error('Usage: atris computer exec "<prompt>"');
    process.exit(1);
  }
  console.log('Executing on computer (with LLM)...');

  if (ctx) {
    const awake = await ensureBusinessAwake(token, ctx);
    if (!awake) {
      console.error('  Computer did not become ready in time.');
      return;
    }
    const worker = activeWorker(options.worker);
    console.log(`  Lane: ${formatWorkerName(worker)}  ${formatCloudSelection({ worker, model: options.model })}`);
    const result = await apiRequestJson(`/business/${ctx.businessId}/chat`, {
      method: 'POST',
      token,
      body: {
        message: prompt,
        workspace_id: ctx.workspaceId,
        worker,
        ...(options.model ? { model: options.model } : {}),
        ...(options.systemPrompt ? { system_prompt: options.systemPrompt } : {}),
        ...(options.allowedTools ? { allowed_tools: options.allowedTools } : {}),
      },
      timeoutMs: 40000,
      retries: 0,
    });
    if (!result.ok) {
      const fallback = await runBusinessPromptViaRunnerProxy(token, ctx, prompt, options);
      if (!fallback.ok) {
        console.error(`Failed: ${result.error || result.status}`);
        if (fallback.error) {
          console.error(`Fallback failed: ${fallback.error}`);
        }
        return;
      }
      const text = extractRunnerProxyText(fallback.payload);
      if (fallback.payload?.execution_id) {
        console.log(`  Execution: ${fallback.payload.execution_id} (runner fallback)`);
      }
      if (text) {
        console.log(text);
      } else {
        console.log('(no result)');
      }
      return;
    }
    const data = result.data || {};
    const base = getApiBaseUrl();
    console.log(`  Execution: ${data.execution_id}`);
    console.log(`  Session:   ${data.session_id}`);
    if (options.waitForResult === false) {
      console.log(`  Stream: ${base}/business/${ctx.businessId}/chat/stream?execution_id=${data.execution_id}&workspace_id=${ctx.workspaceId}`);
      console.log('  Use the stream URL to watch progress.');
      return;
    }
    const streamed = await streamBusinessChatResult(token, ctx, data.execution_id, null);
    if (!streamed.ok) process.exitCode = 1;
    return;
  }

  const result = await apiRequestJson('/ai-computer/execute', {
    method: 'POST',
    token,
    body: { prompt },
  });
  if (!result.ok) {
    console.error(`Failed: ${result.errorMessage || result.status}`);
    return;
  }
  console.log(`  Execution: ${result.data.execution_id}`);
  console.log(`  Stream: ${result.data.endpoint}/events/stream?execution_id=${result.data.execution_id}`);
  console.log('  Use the stream URL to watch progress.');
}

async function cancelBusinessChat(token, ctx, executionId) {
  return apiRequestJson(
    `/business/${ctx.businessId}/chat/cancel?execution_id=${encodeURIComponent(executionId)}&workspace_id=${encodeURIComponent(ctx.workspaceId)}`,
    { method: 'POST', token, timeoutMs: 15000, retries: 0 }
  );
}

async function fetchBusinessChatAudit(token, ctx, limit = 10) {
  return apiRequestJson(
    `/business/${ctx.businessId}/chat/audit?workspace_id=${encodeURIComponent(ctx.workspaceId)}&limit=${Math.max(1, Math.min(limit, 25))}`,
    { method: 'GET', token, timeoutMs: 15000, retries: 0 }
  );
}

async function startBusinessClaudeLogin(token, ctx) {
  return apiRequestJson('/sandbox-secrets/claude-login/start', {
    method: 'POST',
    token,
    body: { business_id: ctx.businessId },
    timeoutMs: 15000,
    retries: 0,
  });
}

async function fetchBusinessClaudeLoginStatus(token, ctx) {
  return apiRequestJson(
    `/sandbox-secrets/claude-login/status?business_id=${encodeURIComponent(ctx.businessId)}`,
    { method: 'GET', token, timeoutMs: 15000, retries: 0 }
  );
}

async function submitBusinessClaudeLoginCode(token, ctx, code) {
  return apiRequestJson('/sandbox-secrets/claude-login/input', {
    method: 'POST',
    token,
    body: { business_id: ctx.businessId, code },
    timeoutMs: 15000,
    retries: 0,
  });
}

async function stopBusinessClaudeLogin(token, ctx) {
  return apiRequestJson('/sandbox-secrets/claude-login/stop', {
    method: 'POST',
    token,
    body: { business_id: ctx.businessId },
    timeoutMs: 15000,
    retries: 0,
  });
}

function maybeOpenUrl(url) {
  if (!url) return;
  if (process.platform === 'darwin') {
    spawnSync('open', [url], { stdio: 'ignore' });
  }
}

async function computerCloudLogin(token, ctx, rawArg = '') {
  if (!ctx) {
    console.error('Cloud login requires a bound business workspace.');
    return;
  }

  const arg = String(rawArg || '').trim();
  if (arg.toLowerCase() === 'stop') {
    const stopped = await stopBusinessClaudeLogin(token, ctx);
    if (!stopped.ok) {
      console.error(`Failed: ${stopped.errorMessage || stopped.status}`);
      return;
    }
    console.log('Claude login stopped.');
    return;
  }

  if (arg) {
    const submitted = await submitBusinessClaudeLoginCode(token, ctx, arg);
    if (!submitted.ok) {
      console.error(`Failed: ${submitted.errorMessage || submitted.status}`);
      return;
    }
    console.log(`Claude login status: ${submitted.data?.status || 'running'}`);
    return;
  }

  const started = await startBusinessClaudeLogin(token, ctx);
  if (!started.ok) {
    console.error(`Failed: ${started.errorMessage || started.status}`);
    return;
  }

  let state = started.data || {};
  const startedAt = Date.now();
  while (!state.url && !['completed', 'failed', 'idle'].includes(state.status || '') && Date.now() - startedAt < 15000) {
    await sleep(1000);
    const status = await fetchBusinessClaudeLoginStatus(token, ctx);
    if (!status.ok) {
      console.error(`Failed: ${status.errorMessage || status.status}`);
      return;
    }
    state = status.data || {};
  }

  if (state.loggedIn || state.status === 'completed') {
    console.log('Claude App is already logged in on this computer.');
    return;
  }
  if (state.url) {
    console.log('Open this URL to log the remote computer into your Claude subscription:');
    console.log(state.url);
    maybeOpenUrl(state.url);
    console.log('After approval, paste the code with `/login <code>`.');
    return;
  }
  if (state.output) {
    console.log(state.output);
    console.log('If Claude asks for a code, paste it with `/login <code>`.');
    return;
  }
  console.log(`Claude login status: ${state.status || 'unknown'}`);
}

function printBusinessChatAudit(rows) {
  console.log('');
  console.log(ui.bold('Recent cloud runs'));
  if (!rows.length) {
    console.log('  No recent cloud runs.');
    return;
  }
  for (const row of rows) {
    const when = row.started_at ? String(row.started_at).replace('T', ' ').replace(/\.\d+/, '').replace('+00:00', 'Z') : '-';
    const tokens = Number.isFinite(row.tokens_used) ? `${row.tokens_used} tok` : '-';
    const cost = Number.isFinite(row.cost_usd) ? `$${Number(row.cost_usd).toFixed(4)}` : '-';
    const credits = Number(row.credits_charged || 0);
    const charge = credits > 0 ? ui.yellow(`${credits} cr`) : ui.green('0 cr');
    console.log(`  ${when}  ${row.status || 'unknown'}  ${tokens}  cost ${cost}  charge ${charge}`);
    if (row.worker || row.model) console.log(`    ${row.worker || '-'}  ${row.model || '-'}`);
    if (row.preview) console.log(`    ${String(row.preview).slice(0, 140)}`);
    if (row.result_preview) console.log(`    => ${String(row.result_preview).slice(0, 180)}`);
  }
}

async function computerAudit(token, ctx, limit = 10) {
  if (!ctx) {
    console.error('Cloud audit requires a bound business workspace.');
    return;
  }
  const result = await fetchBusinessChatAudit(token, ctx, limit);
  if (!result.ok) {
    console.error(`Failed: ${result.errorMessage || result.status}`);
    return;
  }
  printBusinessChatAudit(result.data?.rows || []);
}

async function streamBusinessChatResult(token, ctx, executionId, rl = null, options = {}) {
  let fromIndex = 0;
  let errors = 0;
  let cancelling = false;
  let cancelPromise = null;
  let sawVisibleOutput = false;
  let terminalStatus = null;

  const requestCancel = async () => {
    if (cancelling) return;
    cancelling = true;
    process.stdout.write('\nInterrupting cloud run...\n');
    const result = await cancelBusinessChat(token, ctx, executionId);
    if (!result.ok) {
      console.error(`Interrupt failed: ${result.error || result.status}`);
      return;
    }
    const status = result.data?.status || 'sent';
    if (status === 'not_found') {
      console.log('Run already finished.');
      return;
    }
    if (status === 'idle') {
      console.log('No active run to interrupt.');
      return;
    }
    console.log('Interrupt sent.');
  };

  const onSigint = () => {
    if (!cancelPromise) {
      cancelPromise = requestCancel();
    }
  };

  const sigintTarget = rl || process;
  sigintTarget.on('SIGINT', onSigint);

  if (!options.quiet) console.log(ui.dim('Running on cloud. Ctrl-C interrupts this run.'));

  try {
    while (true) {
      await sleep(1200);
      const events = await apiRequestJson(
        `/business/${ctx.businessId}/chat/events?execution_id=${executionId}&workspace_id=${ctx.workspaceId}&from_index=${fromIndex}`,
        { method: 'GET', token, timeoutMs: 60000 }
      );

      if (!events.ok) {
        if (++errors >= 5) {
          console.error('\nLost connection to AI computer.');
          return { ok: false, status: 'connection_lost' };
        }
        continue;
      }

      errors = 0;
      let done = false;
      const emitEvents = (items, { showTools = true } = {}) => {
        let batchDone = false;
        for (const event of (items || [])) {
          if ((event.type === 'assistant_text' || event.type === 'text') && event.content) {
            sawVisibleOutput = true;
            process.stdout.write(event.content);
          } else if (event.type === 'result' && event.result && !sawVisibleOutput) {
            sawVisibleOutput = true;
            process.stdout.write(String(event.result));
          } else if (showTools && !options.quiet && event.type === 'tool_use' && event.tool) {
            const arg = event.input?.file_path || event.input?.path || event.input?.pattern || event.input?.command || '';
            if (arg) {
              console.log(`\n  [${event.tool}] ${String(arg).slice(0, 120)}`);
            } else {
              console.log(`\n  [${event.tool}]`);
            }
          } else if (event.type === 'error') {
            if (event.error) console.error(`\n${event.error}`);
            terminalStatus = 'error';
            batchDone = true;
            break;
          } else if (event.type === 'complete') {
            terminalStatus = 'completed';
            batchDone = true;
            break;
          }
        }
        return batchDone;
      };

      const batch = events.data?.events || [];
      done = emitEvents(batch);
      const nextIndex = events.data?.next_index;
      if (Number.isInteger(nextIndex) && nextIndex >= fromIndex) {
        fromIndex = nextIndex;
      } else {
        fromIndex += batch.length;
      }

      if (done || ['completed', 'error', 'failed', 'cancelled'].includes(events.data?.status)) {
        if (!sawVisibleOutput && events.data?.status === 'completed') {
          const fullEvents = await apiRequestJson(
            `/business/${ctx.businessId}/chat/events?execution_id=${executionId}&workspace_id=${ctx.workspaceId}&from_index=0`,
            { method: 'GET', token, timeoutMs: 60000 }
          );
          if (fullEvents.ok) {
            emitEvents(fullEvents.data?.events || [], { showTools: false });
          }
        }

        if (!process.stdout.write('\n')) {
          // no-op: keep line handling stable
        }
        if (!sawVisibleOutput && events.data?.status === 'completed') console.log('(no result)');
        const finalStatus = terminalStatus || events.data?.status || (done ? 'completed' : 'unknown');
        return { ok: finalStatus === 'completed', status: finalStatus };
      }
    }
  } finally {
    sigintTarget.removeListener('SIGINT', onSigint);
  }
}

async function sendBusinessChat(token, ctx, message, sessionId, resetContext = false, rl = null, options = {}) {
  const result = await apiRequestJson(`/business/${ctx.businessId}/chat`, {
    method: 'POST',
    token,
    body: {
      message,
      workspace_id: ctx.workspaceId,
      session_id: sessionId,
      reset_context: resetContext,
      ...(options.worker ? { worker: options.worker } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.systemPrompt ? { system_prompt: options.systemPrompt } : {}),
      ...(options.allowedTools ? { allowed_tools: options.allowedTools } : {}),
      ...(options.localCliSessionId ? { local_cli_session_id: options.localCliSessionId } : {}),
    },
    timeoutMs: 40000,
  });

  if (!result.ok) {
    const fallback = await runBusinessPromptViaRunnerProxy(token, ctx, message, {
      ...options,
      resetContext,
      maxTurns: 25,
    });
    if (!fallback.ok) {
      if (typeof options.onFailure === 'function') {
        options.onFailure({ result, fallback });
      }
      console.error(`Failed: ${result.error || result.status}`);
      if (fallback.error) {
        console.error(`Fallback failed: ${fallback.error}`);
      }
      return sessionId;
    }
    const text = extractRunnerProxyText(fallback.payload);
    if (text) {
      process.stdout.write(`${text}\n`);
    } else {
      process.stdout.write('(no result)\n');
    }
    return sessionId;
  }

  const data = result.data || {};
  const nextSessionId = data.session_id || sessionId;
  if (rl) rl.pause();
  try {
    await streamBusinessChatResult(token, ctx, data.execution_id, rl, { quiet: Boolean(options.quiet) });
  } finally {
    if (rl) rl.resume();
  }
  return nextSessionId;
}

async function computerChat(token, ctx, initialOptions = {}) {
  if (!ctx) {
    console.error('Cloud computer mode requires a bound business workspace.');
    console.error('Run this inside ~/arena/atris-business/<slug>/, or use `atris computer --local` for local mode.');
    return;
  }

  const isCodeOps = initialOptions.mode === 'codeops' || ctx.slug === 'atris-codeops';
  const isRecruiting = initialOptions.mode === 'recruiting';
  const oneShotMessage = initialOptions.message != null;
  const chatSystemPrompt = isCodeOps
    ? appendSystemPrompt(initialOptions.systemPrompt, CODEOPS_WORKFLOW_PROMPT)
    : isRecruiting
    ? appendSystemPrompt(initialOptions.systemPrompt, RECRUITING_WORKFLOW_PROMPT)
    : initialOptions.systemPrompt;
  let sessionId = `biz-${ctx.businessId.slice(0, 8)}-${Date.now().toString(36)}`;
  const pipedInput = initialOptions.message != null ? null : await readPipedStdin();
  const scriptedInput = initialOptions.message != null ? String(initialOptions.message) : pipedInput;
  if (!oneShotMessage) printCloudWordmark();
  const selection = oneShotMessage
    ? { worker: initialOptions.worker, model: initialOptions.model }
    : await chooseCloudLane(token, ctx, initialOptions);
  if (selection.cancelled) return;
  let worker = activeWorker(selection.worker);
  let model = selection.model || null;
  let awaitingLoginCode = false;
  let billingLabel = oneShotMessage ? null : await describeBillingMode(token, ctx, worker);
  let authSummary = oneShotMessage || activeWorker(worker) !== 'claude' ? null : await describeClaudeAuth(token, ctx);

  const awake = await ensureBusinessAwake(token, ctx, 90, { quiet: oneShotMessage });
  if (!awake) {
    console.error('  Computer did not become ready in time.');
    return;
  }

  if (!oneShotMessage) {
    if (isCodeOps) {
      printCodeOpsStartPanel(ctx, worker, model, billingLabel, authSummary);
    } else if (isRecruiting) {
      printCloudStartPanel(ctx, worker, model, billingLabel, authSummary);
      printRecruitingWorkflowContract();
    } else {
      printCloudStartPanel(ctx, worker, model, billingLabel, authSummary);
    }
  }

  if (scriptedInput !== null) {
    for (const rawLine of scriptedInput.split(/\r?\n/)) {
      const line = String(rawLine || '').trim();
      if (!line) continue;
      if (line === '/exit' || line === '/quit') break;
      if (line.startsWith('/run ')) {
        await computerRun(token, line.slice(5), ctx);
        continue;
      }
      if (line === '/pwd') {
        await computerRun(token, 'pwd', ctx);
        continue;
      }
      if (line === '/audit' || line.startsWith('/audit ')) {
        const rawLimit = line.split(/\s+/, 2)[1];
        const limit = rawLimit ? Number.parseInt(rawLimit, 10) : 10;
        await computerAudit(token, ctx, Number.isFinite(limit) ? limit : 10);
        continue;
      }
      if (line.startsWith('/')) {
        const command = line.split(/\s+/, 1)[0];
        if (!KNOWN_CHAT_COMMANDS.has(command)) {
          console.log(`Unknown command: ${command}`);
          console.log('Type /help for commands, or remove the slash to ask the model.');
        }
        continue;
      }
      sessionId = await sendBusinessChat(token, ctx, line, sessionId, false, null, {
        worker,
        model,
        systemPrompt: chatSystemPrompt,
        allowedTools: initialOptions.allowedTools,
        quiet: oneShotMessage,
      });
    }
    return;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: isCodeOps ? 'codeops> ' : (isRecruiting ? 'recruiting> ' : 'cloud> '),
  });

  rl.prompt();

  try {
    for await (const rawLine of rl) {
      const line = String(rawLine || '').trim();
      if (!line) {
        rl.prompt();
        continue;
      }
      if (line === '/exit' || line === '/quit') {
        rl.close();
        break;
      }
      if (line === '/start') {
        billingLabel = await describeBillingMode(token, ctx, worker);
        authSummary = activeWorker(worker) === 'claude' ? await describeClaudeAuth(token, ctx) : null;
        if (isCodeOps) {
          printCodeOpsStartPanel(ctx, worker, model, billingLabel, authSummary);
        } else if (isRecruiting) {
          printCloudStartPanel(ctx, worker, model, billingLabel, authSummary);
          printRecruitingWorkflowContract();
        } else {
          printCloudStartPanel(ctx, worker, model, billingLabel, authSummary);
        }
        rl.prompt();
        continue;
      }
      if (line === '/help') {
        printCloudHelp();
        rl.prompt();
        continue;
      }
      if (line === '/status') {
        await printCloudSessionStatus(token, ctx, worker, model);
        rl.prompt();
        continue;
      }
      if (line === '/workflow') {
        if (isRecruiting) printRecruitingWorkflowContract();
        else printCodeOpsWorkflowContract();
        rl.prompt();
        continue;
      }
      if (line === '/pwd') {
        await computerRun(token, 'pwd', ctx);
        rl.prompt();
        continue;
      }
      if (line === '/files' || line.startsWith('/files ')) {
        const filePath = line.slice('/files'.length).trim() || '/workspace';
        await computerLs(token, filePath, ctx);
        rl.prompt();
        continue;
      }
      if (line === '/reset') {
        sessionId = `biz-${ctx.businessId.slice(0, 8)}-${Date.now().toString(36)}`;
        console.log('Session reset.');
        rl.prompt();
        continue;
      }
      if (line === '/worker' || line.startsWith('/worker ')) {
        const nextWorker = line.split(/\s+/, 2)[1];
        if (!nextWorker) {
          console.log(`Worker: ${worker || 'default'}`);
        } else if (!VALID_CLOUD_WORKERS.has(nextWorker)) {
          console.log('Expected: /worker claude|openai');
        } else {
          worker = nextWorker;
          billingLabel = await describeBillingMode(token, ctx, worker);
          authSummary = activeWorker(worker) === 'claude' ? await describeClaudeAuth(token, ctx) : null;
          console.log(`Lane: ${formatWorkerName(worker)}`);
          console.log(`Billing: ${billingLabel}`);
          if (authSummary) console.log(authSummary.label);
        }
        rl.prompt();
        continue;
      }
      if (line === '/model' || line.startsWith('/model ')) {
        const nextModel = line.split(/\s+/, 2)[1];
        if (!nextModel) {
          console.log(`Model: ${model || 'default'}`);
        } else {
          model = nextModel;
          console.log(`Model set: ${model}`);
        }
        rl.prompt();
        continue;
      }
      if (line === '/run') {
        console.log('Usage: /run <shell command>');
        rl.prompt();
        continue;
      }
      if (line.startsWith('/run ')) {
        await computerRun(token, line.slice(5), ctx);
        rl.prompt();
        continue;
      }
      if (line === '/audit' || line.startsWith('/audit ')) {
        const rawLimit = line.split(/\s+/, 2)[1];
        const limit = rawLimit ? Number.parseInt(rawLimit, 10) : 10;
        await computerAudit(token, ctx, Number.isFinite(limit) ? limit : 10);
        rl.prompt();
        continue;
      }
      if (line === '/login' || line.startsWith('/login ')) {
        const loginArg = line.split(/\s+/, 2)[1] || '';
        await computerCloudLogin(token, ctx, loginArg);
        billingLabel = await describeBillingMode(token, ctx, worker);
        authSummary = activeWorker(worker) === 'claude' ? await describeClaudeAuth(token, ctx) : null;
        awaitingLoginCode = !loginArg || loginArg.toLowerCase() === 'stop' ? !loginArg : false;
        rl.prompt();
        continue;
      }
      if (
        awaitingLoginCode &&
        !line.startsWith('/') &&
        /^[A-Za-z0-9._~-]+#[A-Za-z0-9._~-]+$/.test(line)
      ) {
        await computerCloudLogin(token, ctx, line);
        billingLabel = await describeBillingMode(token, ctx, worker);
        authSummary = activeWorker(worker) === 'claude' ? await describeClaudeAuth(token, ctx) : null;
        awaitingLoginCode = false;
        rl.prompt();
        continue;
      }
      if (line.startsWith('/')) {
        const command = line.split(/\s+/, 1)[0];
        if (!KNOWN_CHAT_COMMANDS.has(command)) {
          console.log(`Unknown command: ${command}`);
          console.log('Type /help for commands, or remove the slash to ask the model.');
          rl.prompt();
          continue;
        }
      }

      sessionId = await sendBusinessChat(token, ctx, line, sessionId, false, rl, {
        worker,
        model,
        systemPrompt: chatSystemPrompt,
        allowedTools: initialOptions.allowedTools,
      });
      rl.prompt();
    }
  } catch (error) {
    if (!String(error?.message || error || '').includes('readline was closed')) {
      throw error;
    }
  }
}

async function computerLocalAtris(token, ctx, initialOptions = {}) {
  if (!ctx) {
    console.error('Atris local mode needs a bound business workspace for the cloud brain.');
    console.error('Run inside ~/arena/atris-business/<slug>/, or use `atris computer local-byo`.');
    return;
  }

  const pipedInput = await readPipedStdin();

  printLocalWordmark();
  const selection = await chooseCloudLane(token, ctx, initialOptions);
  if (selection.cancelled) return;
  let worker = selection.worker || null;
  let model = selection.model || null;
  let bridge = null;
  let sessionId = `local-${ctx.businessId.slice(0, 8)}-${Date.now().toString(36)}`;

  try {
    bridge = await startLocalAtrisBridge(token, { allowBash: true });
  } catch (err) {
    console.error(`Failed to start local bridge: ${err.message}`);
    return;
  }

  const cleanup = async () => {
    if (bridge) {
      const stop = bridge.stop;
      bridge = null;
      await stop();
    }
  };

  process.once('SIGINT', cleanup);
  process.once('SIGTERM', cleanup);

  try {
    const awake = await ensureBusinessAwake(token, ctx);
    if (!awake) {
      console.error('  Computer did not become ready in time.');
      return;
    }

    let billingLabel = await describeBillingMode(token, ctx, worker);
    let authSummary = activeWorker(worker) === 'claude' ? await describeClaudeAuth(token, ctx) : null;
    let awaitingLoginCode = false;
    let localSystemPrompt = buildLocalBridgeSystemPrompt(bridge.sessionId, bridge.workingDir, bridge.allowBash);

    printLocalAtrisStartPanel(ctx, bridge, worker, model, billingLabel, authSummary);

    const rl = pipedInput === null
      ? readline.createInterface({
          input: process.stdin,
          output: process.stdout,
          prompt: 'local> ',
        })
      : null;
    const inputLines = pipedInput === null ? rl : String(pipedInput).split(/\r?\n/);
    const promptLocal = () => {
      if (rl) rl.prompt();
    };

    promptLocal();

    try {
      for await (const rawLine of inputLines) {
        const line = String(rawLine || '').trim();
        if (!line) {
          promptLocal();
          continue;
        }
        if (line === '/exit' || line === '/quit') {
          if (rl) rl.close();
          break;
        }
        if (line === '/start') {
          billingLabel = await describeBillingMode(token, ctx, worker);
          authSummary = activeWorker(worker) === 'claude' ? await describeClaudeAuth(token, ctx) : null;
          printLocalAtrisStartPanel(ctx, bridge, worker, model, billingLabel, authSummary);
          promptLocal();
          continue;
        }
        if (line === '/help') {
          console.log('');
          console.log(ui.bold('Local Atris commands'));
          console.log('  /status              Show local bridge, lane, billing');
          console.log('  /files [path]        List local files');
          console.log('  /run <cmd>           Run shell in this local folder');
          console.log('  /audit [n]           Show recent cloud brain runs');
          console.log('  /worker claude       Use Claude lane');
          console.log('  /worker openai       Use OpenAI lane');
          console.log('  /model [id]          Set model override');
          console.log('  /login               Connect Claude subscription on remote brain');
          console.log('  /reset               Start a fresh chat session');
          console.log('  /exit                Leave local Atris mode');
          console.log('');
          promptLocal();
          continue;
        }
        if (line === '/status') {
          console.log('');
          console.log(ui.bold('Local status'));
          console.log(`  Local folder: ${bridge.workingDir}`);
          console.log(`  Bridge: ${bridge.sessionId}`);
          console.log(`  Bash: ${bridge.allowBash ? 'enabled' : 'disabled'}`);
          console.log(`  Business: ${ctx.businessName}`);
          console.log(`  Lane: ${formatWorkerName(worker)}  ${formatCloudSelection({ worker, model })}`);
          billingLabel = await describeBillingMode(token, ctx, worker);
          console.log(`  Billing: ${billingLabel}`);
          promptLocal();
          continue;
        }
        if (line === '/files' || line.startsWith('/files ')) {
          const filePath = line.slice('/files'.length).trim();
          const safePath = filePath ? filePath.replace(/'/g, "'\\''") : '.';
          const op = await runLocalBridgeOp(token, bridge.sessionId, {
            type: 'bash',
            command: `ls -la '${safePath}'`,
          });
          const stdout = op?.result?.stdout || '';
          const stderr = op?.result?.stderr || '';
          if (stdout) process.stdout.write(stdout);
          if (stderr) process.stderr.write(stderr);
          promptLocal();
          continue;
        }
        if (line === '/run') {
          console.log('Usage: /run <local shell command>');
          promptLocal();
          continue;
        }
        if (line.startsWith('/run ')) {
          const op = await runLocalBridgeOp(token, bridge.sessionId, {
            type: 'bash',
            command: line.slice(5),
          }, 30);
          const stdout = op?.result?.stdout || '';
          const stderr = op?.result?.stderr || '';
          if (stdout) process.stdout.write(stdout);
          if (stderr) process.stderr.write(stderr);
          promptLocal();
          continue;
        }
        if (line === '/audit' || line.startsWith('/audit ')) {
          const rawLimit = line.split(/\s+/, 2)[1];
          const limit = rawLimit ? Number.parseInt(rawLimit, 10) : 10;
          await computerAudit(token, ctx, Number.isFinite(limit) ? limit : 10);
          promptLocal();
          continue;
        }
        if (line === '/reset') {
          sessionId = `local-${ctx.businessId.slice(0, 8)}-${Date.now().toString(36)}`;
          console.log('Session reset.');
          promptLocal();
          continue;
        }
        if (line === '/worker' || line.startsWith('/worker ')) {
          const nextWorker = line.split(/\s+/, 2)[1];
          if (!nextWorker) {
            console.log(`Worker: ${worker || 'default'}`);
          } else if (!VALID_CLOUD_WORKERS.has(nextWorker)) {
            console.log('Expected: /worker claude|openai');
          } else {
            worker = nextWorker;
            billingLabel = await describeBillingMode(token, ctx, worker);
            authSummary = activeWorker(worker) === 'claude' ? await describeClaudeAuth(token, ctx) : null;
            console.log(`Lane: ${formatWorkerName(worker)}`);
            console.log(`Billing: ${billingLabel}`);
            if (authSummary) console.log(authSummary.label);
          }
          promptLocal();
          continue;
        }
        if (line === '/model' || line.startsWith('/model ')) {
          const nextModel = line.split(/\s+/, 2)[1];
          if (!nextModel) {
            console.log(`Model: ${model || 'default'}`);
          } else {
            model = nextModel;
            console.log(`Model set: ${model}`);
          }
          promptLocal();
          continue;
        }
        if (line === '/login' || line.startsWith('/login ')) {
          const loginArg = line.split(/\s+/, 2)[1] || '';
          await computerCloudLogin(token, ctx, loginArg);
          billingLabel = await describeBillingMode(token, ctx, worker);
          authSummary = activeWorker(worker) === 'claude' ? await describeClaudeAuth(token, ctx) : null;
          awaitingLoginCode = !loginArg || loginArg.toLowerCase() === 'stop' ? !loginArg : false;
          promptLocal();
          continue;
        }
        if (
          awaitingLoginCode &&
          !line.startsWith('/') &&
          /^[A-Za-z0-9._~-]+#[A-Za-z0-9._~-]+$/.test(line)
        ) {
          await computerCloudLogin(token, ctx, line);
          billingLabel = await describeBillingMode(token, ctx, worker);
          authSummary = activeWorker(worker) === 'claude' ? await describeClaudeAuth(token, ctx) : null;
          awaitingLoginCode = false;
          promptLocal();
          continue;
        }
        if (line.startsWith('/')) {
          const command = line.split(/\s+/, 1)[0];
          if (!KNOWN_CHAT_COMMANDS.has(command)) {
            console.log(`Unknown command: ${command}`);
            console.log('Type /help for commands, or remove the slash to ask the model.');
            promptLocal();
            continue;
          }
        }

        localSystemPrompt = buildLocalBridgeSystemPrompt(bridge.sessionId, bridge.workingDir, bridge.allowBash);
        sessionId = await sendBusinessChat(token, ctx, line, sessionId, false, rl, {
          worker,
          model,
          systemPrompt: localSystemPrompt,
          localCliSessionId: bridge.sessionId,
        });
        promptLocal();
      }
    } catch (error) {
      if (!String(error?.message || error || '').includes('readline was closed')) {
        throw error;
      }
    }
  } finally {
    process.removeListener('SIGINT', cleanup);
    process.removeListener('SIGTERM', cleanup);
    await cleanup();
  }
}

async function computerProof(token, ctx, initialOptions = {}) {
  if (!ctx) {
    console.error('Atris computer proof needs a bound business workspace.');
    console.error('Run inside ~/arena/atris-business/<slug>/ first.');
    process.exitCode = 1;
    return;
  }

  const worker = initialOptions.worker || 'openai';
  const model = initialOptions.model || null;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const fileName = `atris-proof-${stamp}.txt`;
  const expected = `ATRIS_PROOF_OK_${stamp}`;
  const sessionId = `proof-${ctx.businessId.slice(0, 8)}-${Date.now().toString(36)}`;
  let bridge = null;

  console.log('');
  console.log(ui.bold('Atris Computer Proof'));
  console.log(`${ctx.businessName}  ${ui.dim('cloud brain -> local folder -> audit')}`);
  console.log(`Lane: ${ui.bold(formatWorkerName(worker))}  ${ui.dim(formatCloudSelection({ worker, model }))}`);

  try {
    bridge = await startLocalAtrisBridge(token, { allowBash: true });
  } catch (err) {
    console.error(`Failed to start local bridge: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  const cleanup = async () => {
    if (bridge) {
      const stop = bridge.stop;
      bridge = null;
      await stop();
    }
  };

  process.once('SIGINT', cleanup);
  process.once('SIGTERM', cleanup);

  try {
    const awake = await ensureBusinessAwake(token, ctx);
    if (!awake) {
      console.error('Computer did not become ready in time.');
      process.exitCode = 1;
      return;
    }

    const billingLabel = await describeBillingMode(token, ctx, worker);
    console.log(`Local: ${bridge.workingDir}`);
    console.log(`Bridge: ${bridge.sessionId.slice(0, 8)}  ${ui.dim('local bash enabled')}`);
    console.log(`Billing: ${billingLabel}`);
    console.log('');

    const prompt = [
      `Create a file named ${fileName} in the LOCAL folder with exactly ${expected}.`,
      'Use local_file_op for the write.',
      'Read it back through local_file_op.',
      'Reply with exactly ATRIS COMPUTER PROOF OK.',
    ].join(' ');
    const systemPrompt = buildLocalBridgeSystemPrompt(bridge.sessionId, bridge.workingDir, bridge.allowBash);

    console.log(ui.bold('Run'));
    console.log(`  prompt: ${prompt}`);
    let activeCtx = ctx;
    let chatFailure = null;
    let nextSessionId = await sendBusinessChat(token, activeCtx, prompt, sessionId, true, null, {
      worker,
      model,
      systemPrompt,
      localCliSessionId: bridge.sessionId,
      onFailure: (failure) => {
        chatFailure = failure;
      },
    });
    const retryCtx = contextForAttachedWorkspaceMismatch(activeCtx, chatFailure);
    if (retryCtx) {
      console.log('');
      console.log(`Retrying proof against attached workspace ${retryCtx.workspaceId}...`);
      activeCtx = retryCtx;
      chatFailure = null;
      nextSessionId = await sendBusinessChat(token, activeCtx, prompt, `${sessionId}-attached`, true, null, {
        worker,
        model,
        systemPrompt,
        localCliSessionId: bridge.sessionId,
        onFailure: (failure) => {
          chatFailure = failure;
        },
      });
    }

    const localPath = path.join(bridge.workingDir, fileName);
    let localContent = '';
    try {
      localContent = fs.readFileSync(localPath, 'utf8').trim();
    } catch {
      localContent = '';
    }
    const localOk = localContent === expected;

    const cloudFile = await readBusinessWorkspaceFile(token, activeCtx, fileName, 15000);
    const cloudClear = !cloudFile.ok && cloudFile.status === 404;

    const audit = await fetchBusinessChatAudit(token, activeCtx, 5);
    const rows = audit.ok ? (audit.data?.rows || []) : [];
    const auditRow = rows.find((row) => row.session_id === nextSessionId || row.preview?.includes(fileName)) || rows[0] || {};
    const auditOk = audit.ok && auditRow.status === 'completed' && String(auditRow.result_preview || '').includes('ATRIS COMPUTER PROOF OK');

    console.log('');
    console.log(ui.bold('Proof'));
    console.log(`  local edit:      ${localOk ? ui.green('PASS') : ui.red('FAIL')}  ${fileName}`);
    console.log(`  local contents:  ${localContent || '(missing)'}`);
    console.log(`  cloud isolation: ${cloudClear ? ui.green('PASS') : ui.red('FAIL')}  /workspace/${fileName} ${cloudClear ? 'absent' : 'present or unchecked'}`);
    console.log(`  audit:           ${auditOk ? ui.green('PASS') : ui.red('CHECK')}  ${auditRow.status || 'unknown'} ${auditRow.worker || '-'} charge ${auditRow.credits_charged ?? '-'} cr`);
    if (auditRow.result_preview) console.log(`  result:          ${String(auditRow.result_preview).slice(0, 120)}`);
    console.log('');
    console.log(ui.bold('Team command'));
    console.log('  atris computer local --worker openai');
    console.log('');

    if (!localOk || !cloudClear || !auditOk) {
      process.exitCode = 1;
    }
  } finally {
    process.removeListener('SIGINT', cleanup);
    process.removeListener('SIGTERM', cleanup);
    await cleanup();
  }
}

async function runRecruitingComputerShortcut(token, args, cloudOptions = {}) {
  const recruitingOptions = recruitingCloudOptions(cloudOptions);
  const sub = args[1];
  const rest = args.slice(2).join(' ');

  if (sub === '--help' || sub === 'help') {
    printRecruitingComputerHelp();
    return;
  }

  if (sub === 'create') {
    const createArgs = args.slice(2);
    const finalArgs = computerCreateArgsHaveName(createArgs)
      ? createArgs
      : ['Recruiting Computer', ...createArgs];
    return computerCreate(token, finalArgs, {
      businessSlug: cloudOptions.businessSlug || RECRUITING_BUSINESS_SLUG,
      computerType: 'recruiting',
    });
  }

  if (sub === 'sync') {
    return runRecruitingSyncHelper(args.slice(2), recruitingOptions);
  }

  if (RECRUITING_LOCAL_SYNC_COMMANDS.has(sub)) {
    return runRecruitingLocalSyncCommand(sub, args.slice(2), recruitingOptions);
  }

  const ctx = await resolveTypedBusinessComputerContext(token, recruitingOptions, {
    businessSlug: RECRUITING_BUSINESS_SLUG,
    computerType: 'recruiting',
  });
  if (!ctx?.businessId) {
    console.error('Atris Recruiting is not available for this account.');
    console.error('Ask an Atris Labs admin to add you, or pass --business <slug>.');
    process.exitCode = 1;
    return;
  }
  if (!ctx.workspaceId) {
    printMissingTypedComputer(ctx, 'recruiting', {
      label: 'recruiting',
      businessSlug: recruitingOptions.businessSlug || RECRUITING_BUSINESS_SLUG,
    });
    return;
  }

  if (!sub || sub === 'chat') return computerChat(token, ctx, recruitingOptions);

  switch (sub) {
    case 'status': return computerStatus(token, ctx);
    case 'up':
    case 'wake': return computerWake(token, ctx);
    case 'sleep': return computerSleep(token, ctx);
    case 'run': return computerRun(token, rest, ctx);
    case 'grep': return computerGrep(token, rest, ctx);
    case 'ls': return computerLs(token, rest || undefined, ctx);
    case 'cat': return computerCat(token, rest, ctx);
    case 'exec': return computerExec(token, rest, ctx, recruitingOptions);
    case 'audit': {
      const limit = rest ? Number.parseInt(rest, 10) : 10;
      return computerAudit(token, ctx, Number.isFinite(limit) ? limit : 10);
    }
    case 'workflow':
      printRecruitingWorkflowContract();
      return;
    default:
      console.error(`Unknown recruiting subcommand: ${sub}`);
      console.log('Run: atris computer recruiting help');
      process.exitCode = 1;
  }
}

async function runComputer() {
  const parsed = parseComputerOptions(process.argv.slice(3));
  const args = parsed.positional;
  const cloudOptions = parsed.options;
  const sub = args[0];

  if (!sub) {
    if (cloudOptions.businessSlug || cloudOptions.workspaceId) {
      const token = getToken();
      const ctx = await resolveComputerCommandContext(token, cloudOptions);
      await computerChat(token, ctx, cloudOptions);
      return;
    }

    const hasBusinessBinding = Boolean(readBusinessBinding());
    const hasLocalHarness = Boolean(findAtrisCodeTerminal());
    const surface = await chooseComputerSurface(hasBusinessBinding, hasLocalHarness);
    if (!surface) return;
    if ((surface === 'cloud' || surface === 'local-atris') && hasBusinessBinding) {
      const token = getToken();
      const ctx = await resolveBusinessContext(token);
      if (ctx) {
        if (surface === 'local-atris') {
          await computerLocalAtris(token, ctx, cloudOptions);
        } else {
          await computerChat(token, ctx, cloudOptions);
        }
        return;
      }
    }
    if (surface === 'local-byo' && hasLocalHarness) {
      computerLocal();
      return;
    }
    computerLocal();
    return;
  }

  if (sub === '--local' || sub === 'local') {
    const token = getToken();
    const ctx = await resolveComputerCommandContext(token, cloudOptions);
    if (ctx) {
      await computerLocalAtris(token, ctx, cloudOptions);
      return;
    }
    computerLocal(args.slice(1));
    return;
  }

  if (sub === 'local-atris') {
    const token = getToken();
    const ctx = await resolveComputerCommandContext(token, cloudOptions);
    await computerLocalAtris(token, ctx, cloudOptions);
    return;
  }

  if (sub === 'local-byo' || sub === '--local-byo') {
    computerLocal(args.slice(1));
    return;
  }

  if (sub === 'card') {
    computerCard(args.slice(1));
    return;
  }

  if (sub === 'claude' || sub === 'codex') {
    computerLocalLegacy(args);
    return;
  }

  if (sub === 'create') {
    const createOptions = parseComputerCreateArgs(args.slice(1));
    if (createOptions.help || !createOptions.name) {
      await computerCreate(null, args.slice(1));
      return;
    }
  }

  if (sub === 'recruiting' && (args[1] === '--help' || args[1] === 'help')) {
    printRecruitingComputerHelp();
    return;
  }

  if (sub === 'recruiting' && args[1] === 'sync') {
    return runRecruitingSyncHelper(args.slice(2), cloudOptions);
  }

  if (sub === 'recruiting' && RECRUITING_LOCAL_SYNC_COMMANDS.has(args[1])) {
    return runRecruitingLocalSyncCommand(args[1], args.slice(2), cloudOptions);
  }

  if (sub === '--help') {
    console.log('Usage: atris computer [mode|command]');
    console.log('');
    console.log('Atris computers are persistent AI workspaces for scoped jobs.');
    console.log('');
    console.log('  Owner = User | Business');
    console.log('  Owner has many Computers');
    console.log('  Computer = workspace + files + tools + secrets + memory + agents + validation');
    console.log('');
    console.log('Common types: codeops, research, CRM, reporting, recruiting, event ops, support, business ops.');
    console.log('A business can be a company, lab, collective, community, artist, team, or project.');
    console.log('');
    console.log('First use:');
    console.log('  cd ~/arena/atris-business/<business>');
    console.log('  atris computer');
    console.log('  Choose Cloud workspace or Local folder, then type the outcome in plain English.');
    console.log('');
    console.log('Modes:');
    console.log('  (default)       Choose CLOUD vs LOCAL when both are available');
    console.log('  card            Show the local owner/computer card, no login required');
    console.log('  local           Open LOCAL Atris mode; cloud brain edits this folder');
    console.log('  proof           Run the local-edit + cloud-isolation + audit proof');
    console.log('  local-byo       Open LOCAL BYO Claude mode; Anthropic tokens, no cloud audit');
    console.log('  --cloud         Open CLOUD workspace mode in the bound business workspace');
    console.log('  cloud           Open CLOUD workspace mode in the bound business workspace');
    console.log('  codeops         Open Atris CodeOps workflow computer if your account has access');
    console.log('  recruiting      Open the Atris Labs recruiting computer');
    console.log('  --business      Select a business by slug');
    console.log('  --workspace     Select a specific workspace/computer id');
    console.log('  --worker        Cloud worker override: claude | openai');
    console.log('  --model         Cloud model override');
    console.log('  --no-wait       Start exec and print stream URL without waiting');
    console.log('  claude|codex    Legacy local console backends');
    console.log('');
    console.log('Cloud commands:');
    console.log('  create <name>    Create and wake an extra business computer; add --type recruiting|codeops|research|crm');
    console.log('  activate         Attach EC2 to --workspace and remember it as the default');
    console.log('  chat            Interactive cloud workspace chat');
    console.log('  chat --message  Send one non-interactive message and print the reply');
    console.log('                  Ctrl-C during a cloud run interrupts it');
    console.log('                  /start shows the beginner flow');
    console.log('                  /status shows lane, Claude auth, and billing');
    console.log('                  /audit [n] shows recent cloud runs inside chat');
    console.log('  status          Show computer status');
    console.log('  up|wake         Start the computer');
    console.log('  sleep           Stop the computer (files persist)');
    console.log('  delete          Sleep, confirm, and delete a business computer');
    console.log('  run <cmd>       Run bash on EC2 (no LLM cost)');
    console.log('  grep <pattern>  Search files on EC2');
    console.log('  ls [path]       List files');
    console.log('  cat <path>      Read a file');
    console.log('  exec "<prompt>" Run with LLM (Claude Code)');
    console.log('  pull [path] [dir] Pull files from EC2 to local');
    console.log('  diff [path]       Show what changed on EC2 since last pull');
    console.log('  learn             Trigger autonomous learning cycle');
    console.log('  onboard <slug>    Set up a new business computer');
    console.log('');
    console.log('Examples:');
    console.log('  atris computer');
    console.log('  atris computer card --write');
    console.log('  atris business init "My Lab"     # first/default computer with Atris + operator');
    console.log('  atris computer create "Recruiting Computer" --business atris-labs --type recruiting');
    console.log('  atris computer --business atris-labs --workspace <workspace-id>');
    console.log('  atris computer sleep --business atris-labs --workspace <workspace-id>');
    console.log('  atris computer delete --business atris-labs --workspace <workspace-id>');
    console.log('  atris computer proof');
    console.log('  atris computer local');
    console.log('  atris computer codex');
    console.log('  atris computer --cloud');
    console.log('  atris computer --cloud --worker openai --model gpt-5.4');
    console.log('  atris computer cloud');
    console.log('  atris computer codeops');
    console.log('  atris computer codeops status');
    console.log('  atris computer codeops run "pwd"');
    console.log('  atris computer codeops exec "Plan a safe repo fix"');
    console.log('  atris computer recruiting');
    console.log('  atris computer recruiting status');
    console.log('  atris computer recruiting sync');
    console.log('  atris computer recruiting pull');
    console.log('  atris computer recruiting push --dry-run');
    console.log('  atris computer recruiting watch');
    console.log('  atris computer recruiting run "pwd"');
    console.log('  atris computer recruiting exec "Summarize candidate follow-ups"');
    console.log('  atris computer status');
    console.log('  atris computer wake');
    console.log('  atris computer run "ls -la /workspace"');
    console.log('  atris computer grep "overnight"');
    console.log('  atris computer cat soul/soul.md');
    console.log('  atris computer exec "Read soul/ and suggest what to work on"');
    return;
  }

  const token = getToken();
  if (sub === 'create') {
    return computerCreate(token, args.slice(1), cloudOptions);
  }
  if (sub === 'recruiting') {
    return runRecruitingComputerShortcut(token, args, cloudOptions);
  }

  const ctx = await resolveComputerCommandContext(token, cloudOptions);

  if (sub === 'codeops') {
    const codeopsCtx = await resolveBusinessContextBySlug(token, 'atris-codeops');
    if (!codeopsCtx) {
      console.error('Atris CodeOps is not available for this account.');
      console.error('Ask an Atris CodeOps admin to add you to the atris-codeops business.');
      return;
    }
    const codeopsOptions = codeOpsCloudOptions(cloudOptions);
    const codeopsSub = args[1];
    const codeopsRest = args.slice(2).join(' ');
    if (!codeopsSub || codeopsSub === 'chat') {
      await computerChat(token, codeopsCtx, codeopsOptions);
      return;
    }
    switch (codeopsSub) {
      case '--help':
      case 'help':
        console.log('Usage: atris computer codeops [chat|status|wake|sleep|run|grep|ls|cat|exec|audit|workflow]');
        console.log('');
        console.log('Examples:');
        console.log('  atris computer codeops');
        console.log('  atris computer codeops status');
        console.log('  atris computer codeops run "pwd && git status --short"');
        console.log('  atris computer codeops exec "Plan the smallest safe fix, then wait"');
        return;
      case 'status': return computerStatus(token, codeopsCtx);
      case 'wake': return computerWake(token, codeopsCtx);
      case 'sleep': return computerSleep(token, codeopsCtx);
      case 'run': return computerRun(token, codeopsRest, codeopsCtx);
      case 'grep': return computerGrep(token, codeopsRest, codeopsCtx);
      case 'ls': return computerLs(token, codeopsRest || undefined, codeopsCtx);
      case 'cat': return computerCat(token, codeopsRest, codeopsCtx);
      case 'exec': return computerExec(token, codeopsRest, codeopsCtx, codeopsOptions);
      case 'audit': {
        const limit = codeopsRest ? Number.parseInt(codeopsRest, 10) : 10;
        return computerAudit(token, codeopsCtx, Number.isFinite(limit) ? limit : 10);
      }
      case 'workflow':
        printCodeOpsWorkflowContract();
        return;
      default:
        console.error(`Unknown CodeOps subcommand: ${codeopsSub}`);
        console.log('Run: atris computer codeops help');
        return;
    }
    return;
  }

  if (sub === '--cloud' || sub === 'cloud') {
    await computerChat(token, ctx, cloudOptions);
    return;
  }

  const rest = args.slice(1).join(' ');

  switch (sub) {
    case 'chat': return computerChat(token, ctx, cloudOptions);
    case 'card': return computerCard(args.slice(1));
    case 'proof': return computerProof(token, ctx, cloudOptions);
    case 'activate': return computerActivate(token, ctx, cloudOptions);
    case 'status': return computerStatus(token, ctx);
    case 'up':
    case 'wake': return computerWake(token, ctx);
    case 'sleep': return computerSleep(token, ctx);
    case 'delete':
    case 'rm': return computerDelete(token, ctx, cloudOptions, args.slice(1));
    case 'run': return computerRun(token, rest, ctx);
    case 'grep': return computerGrep(token, rest, ctx);
    case 'ls': return computerLs(token, rest || undefined, ctx);
    case 'cat': return computerCat(token, rest, ctx);
    case 'exec': return computerExec(token, rest, ctx, cloudOptions);
    case 'pull': {
      const parts = rest.split(' ').filter(Boolean);
      return computerPull(token, parts[0], parts[1], ctx);
    }
    case 'diff': return computerDiff(token, rest || undefined, ctx);
    case 'learn': return computerLearn(token, ctx);
    case 'onboard': return computerOnboard(token, rest);
    default:
      console.error(`Unknown subcommand: ${sub}`);
      console.log('Run: atris computer --help');
  }
}

module.exports = {
  runComputer,
  buildComputerCard,
  renderComputerCard,
  renderComputerCardMarkdown,
  extractAttachedWorkspaceMismatch,
  contextForAttachedWorkspaceMismatch,
  printRecruitingLocalSyncOutcome,
};
