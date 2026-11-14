/**
 * Atris Computer: interact with your EC2 AI Computer
 *
 *   atris computer                 : Open SMART mode (cloud in business workspace, local elsewhere)
 *   atris computer setup           : Connect coding accounts to a computer
 *   atris computer --cloud         : Open CLOUD workspace mode
 *   atris computer create <name>   : Create and wake a business computer
 *   atris computer wake            : Start the computer
 *   atris computer sleep           : Stop (files persist)
 *   atris computer delete          : Sleep, confirm, and delete a business computer
 *   atris computer card            : Show the local computer card
 *   atris computer run <command>   : Run bash on EC2 (no LLM)
 *   atris computer grep <pattern>  : Search files on EC2
 *   atris computer ls [path]       : List files
 *   atris computer cat <path>      : Read a file
 *   atris computer exec <prompt>   : Run with LLM (Claude Code)
 *   atris computer recruiting      : Open the recruiting workflow shortcut
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { loadCredentials } = require('../utils/auth');
const api = require('../utils/api');
const { getApiBaseUrl, getAppBaseUrl } = api;
const { businessWorkspaceBase, loadBusinesses, saveBusinesses } = require('./business');
const {
  engineLoginSeatError,
  formatEngineSeats,
  listEngineSeats,
  normalizeEngineLoginSeat,
  readyCheckEngineLogin,
  runEngineDeviceLoginCommand,
  validEngineLoginSeat,
} = require('./engine');

function apiRequestJson(...args) {
  return api.apiRequestJson(...args);
}
const {
  VALID_CLOUD_WORKERS,
  VALID_COMPUTER_TYPES,
  RECRUITING_BUSINESS_SLUG,
  RECRUITING_LOCAL_SYNC_COMMANDS,
  KNOWN_CHAT_COMMANDS,
  CODEOPS_WORKFLOW_PROMPT,
  RECRUITING_WORKFLOW_PROMPT,
  sleep,
  askComputerSetup,
  setupComputerChoices,
  chooseSetupComputer,
  chooseSetupProviders,
  ui,
  useInteractiveCloudUi,
  useInteractiveTerminalUi,
  readPipedStdin,
  printCloudWordmark,
  printLocalWordmark,
  activeWorker,
  formatWorkerName,
  extractAttachedWorkspaceMismatch,
  contextForAttachedWorkspaceMismatch,
  describeClaudeAuth,
  describeBillingMode,
  printCloudHelp,
  printCloudStartPanel,
  appendSystemPrompt,
  codeOpsCloudOptions,
  recruitingCloudOptions,
  printCodeOpsStartPanel,
  printCodeOpsWorkflowContract,
  printRecruitingWorkflowContract,
  printRecruitingComputerHelp,
  withoutRecruitingWrapperFlags,
  printRecruitingLocalSyncOutcome,
  runRecruitingLocalSyncCommand,
  runRecruitingSyncHelper,
  buildLocalBridgeSystemPrompt,
  printLocalAtrisStartPanel,
  printCloudSessionStatus,
  questionAsync,
  chooseComputerSurface,
  chooseCloudLane,
  parseComputerOptions,
  parseComputerCreateArgs,
  computerCreateArgsHaveName,
  normalizeComputerType,
  formatComputerTypeList,
  parseComputerDeleteArgs,
  formatCloudSelection,
  findAtrisCodeTerminal,
  computerLocalLegacy,
  computerLocal,
  startLocalAtrisBridge,
  runLocalBridgeOp,
  readBusinessBinding,
  buildComputerCard,
  renderComputerCard,
  renderComputerCardMarkdown,
  parseComputerCardArgs,
  computerCard,
  resolveBusinessContext,
  resolveBusinessContextBySlug,
  resolveComputerCommandContext,
  resolveTypedBusinessComputerContext,
  printMissingTypedComputer,
  looksLikeWorkspaceId,
  resolveBusinessOwnerForCreate,
  apiFailureDetail,
  printComputerCommandFailure,
  rememberBusinessWorkspace,
  rememberCreatedComputer,
  shellQuote,
  listBusinessWorkspaces,
  formatWorkspaceRef,
  workspaceMatchesInput,
  resolveWorkspaceFromList,
  workspaceMatchesComputerType,
  formatLeaseAge,
  probeAttachedWorkspace,
  bootstrapBusinessComputerRuntime,
  readBusinessWorkspaceFile,
  extractRunnerProxyText,
  runBusinessPromptViaRunnerProxy,
  ensureBusinessAwake,
  cancelBusinessChat,
  fetchBusinessChatAudit,
  computerCloudLogin,
  computerAudit,
} = require('../lib/computer-core');

function getToken() {
  const creds = loadCredentials();
  if (!creds || !creds.token) {
    console.error('Not logged in. Run: atris login');
    process.exit(1);
  }
  return creds.token;
}

async function computerSetup(deps = {}) {
  try {
    const load = deps.loadCredentials || loadCredentials;
    const credentials = await load();
    if (!credentials?.token) {
      console.error('run: atris login');
      return 1;
    }

    const api = deps.apiRequestJson || apiRequestJson;
    const computersResult = await api('/business/', {
      method: 'GET',
      token: credentials.token,
      timeoutMs: 15000,
      retries: 0,
    });
    if (!computersResult.ok) {
      console.error('could not load your computers; please try again.');
      return 1;
    }

    const computer = await chooseSetupComputer(setupComputerChoices(computersResult.data), deps);
    const providers = await chooseSetupProviders(deps);
    const deviceLogin = deps.runEngineDeviceLoginCommand || runEngineDeviceLoginCommand;
    const readyCheck = deps.readyCheckEngineLogin || readyCheckEngineLogin;

    for (const provider of providers) {
      while (true) {
        const providerHint = provider === 'claude'
          ? ' you will get a code in the browser, paste it back here.'
          : '';
        const rawSeat = await askComputerSetup(
          `connect a ${provider} account?${providerHint} give it a short name like personal or work (enter to finish) `,
          deps
        );
        if (!rawSeat) break;
        const seat = normalizeEngineLoginSeat(rawSeat);
        if (!validEngineLoginSeat(seat)) {
          console.error(engineLoginSeatError());
          continue;
        }

        const code = await deviceLogin(provider, {
          target: computer.target,
          seat,
          setup: true,
        }, deps);
        if (code !== 0) return 1;
        let working = false;
        try {
          const checked = await readyCheck(provider, computer.target, deps);
          working = Boolean(checked?.ok && checked.data?.status === 'ready');
        } catch {}
        const seatName = seat.toLowerCase();
        console.log(working
          ? `${seatName}: working`
          : `${seatName}: linked, but the check failed - it may still work, try: atris engine seats`);
      }
    }

    const listSeats = deps.listEngineSeats || listEngineSeats;
    const seats = await listSeats(deps);
    if (!seats.ok) {
      console.error('could not check the linked accounts; please try again.');
      return 1;
    }

    const now = typeof deps.now === 'function' ? deps.now() : Date.now();
    console.log(formatEngineSeats(seats.data, now));
    console.log('Done. Your computer can now work on these accounts.');
    return 0;
  } catch {
    console.error('could not finish computer setup; please try again.');
    return 1;
  }
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

  const ctx = await resolveBusinessOwnerForCreate(token, options.businessSlug, {
    allowCanonicalShortcutFallback: Boolean(defaults.allowCanonicalShortcutFallback),
  });
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
  console.log(`  cd ${businessWorkspaceBase()}/${owner}`);
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
      console.log(`  + ${f.name} (${f.size}b), new on EC2`);
      added++;
    } else {
      const localSize = fs.statSync(localPath).size;
      if (Math.abs(localSize - (f.size || 0)) > 10) {
        console.log(`  ~ ${f.name} (local: ${localSize}b, EC2: ${f.size}b), changed`);
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
        console.log(`  - ${localFile}, deleted on EC2`);
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
  const soulTemplate = `# Soul: ${businessSlug}\n\n## Identity\nBusiness computer for ${businessSlug}. Self-improving context system.\n\n## Goals\n- Learn the business overnight\n- Accumulate context that makes the agent smarter\n- Track what works and what doesn't\n\n## Rules\n- No emails without approval\n- No destructive actions\n- Save everything to soul/\n`;

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
      '  echo "- [$NAME]($NAME.md), $FIRST_LINE ($SIZE bytes)" >> soul/INDEX.md',
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

function computerLane(rest, ctx) {
  if (!ctx?.slug && !ctx?.businessId) {
    console.error('No business selected. Pass --business <slug>.');
    process.exitCode = 1;
    return;
  }
  const businesses = loadBusinesses();
  const key = Object.keys(businesses).find((slug) => {
    const entry = businesses[slug] || {};
    return slug === ctx.slug || entry.business_id === ctx.businessId;
  });
  if (!key) {
    console.error(`Business ${ctx.slug || ctx.businessId} is not in the local business list yet. Run any computer command against it once, then retry.`);
    process.exitCode = 1;
    return;
  }
  const requested = (rest || '').trim().toLowerCase();
  if (!requested) {
    const current = businesses[key].worker || null;
    console.log(current
      ? `  Saved lane for ${key}: ${formatWorkerName(current)}`
      : `  No saved lane for ${key}. Runs default to Claude unless you pass --worker.`);
    console.log(`  Set one: atris computer lane <claude|openai> --business ${key}`);
    return;
  }
  if (requested === 'clear' || requested === 'none') {
    delete businesses[key].worker;
    saveBusinesses(businesses);
    console.log(`  Cleared saved lane for ${key}.`);
    return;
  }
  if (!['claude', 'openai', 'codex'].includes(requested)) {
    console.error(`Unknown lane "${requested}". Use claude, openai, or clear.`);
    process.exitCode = 1;
    return;
  }
  const normalized = requested === 'codex' ? 'openai' : requested;
  businesses[key].worker = normalized;
  saveBusinesses(businesses);
  console.log(`  Saved lane for ${key}: ${formatWorkerName(normalized)}. Every run for this business now uses it unless you pass --worker.`);
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
      process.exitCode = 1;
      return;
    }
    const worker = activeWorker(options.worker || ctx.worker);
    const laneSource = options.worker ? '' : ctx.worker ? '  (saved for this business)' : '';
    console.log(`  Lane: ${formatWorkerName(worker)}  ${formatCloudSelection({ worker, model: options.model })}${laneSource}`);
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
        process.exitCode = 1;
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
    process.exitCode = 1;
    return;
  }
  console.log(`  Execution: ${result.data.execution_id}`);
  console.log(`  Stream: ${result.data.endpoint}/events/stream?execution_id=${result.data.execution_id}`);
  console.log('  Use the stream URL to watch progress.');
}

function printComputerPrHelp(log = console.log) {
  log('Usage: atris computer pr <owner/repo> "<task>" [--business <slug>] [--worker claude|openai] [--model <id>] [--base <branch>] [--branch <name>]');
  log('');
  log('The business computer does the task on a new branch and opens a pull request.');
  log('It prints the pull request link. It never merges.');
  log('');
  log('Example:');
  log('  atris computer pr atrislabs/demo "Fix the typo in the README" --business my-lab');
}

// One pull request from a repo and a plain-words task. Exit 0 only when a
// pull request link for the same repo came back. Never merges.
async function computerPr(token, args = [], ctx = null, options = {}, deps = {}) {
  const prLib = require('../lib/computer-pr');
  const log = deps.log || ((s) => console.log(s));
  const logError = deps.logError || ((s) => console.error(s));
  const write = deps.write || ((s) => process.stdout.write(s));
  const request = deps.apiRequestJson || apiRequestJson;
  const wake = deps.ensureBusinessAwake || ensureBusinessAwake;
  const stream = deps.streamBusinessChatResult || streamBusinessChatResult;
  const fail = (message) => {
    logError(prLib.redactSecrets(message));
    process.exitCode = 1;
    return 1;
  };

  let parsed;
  try {
    parsed = prLib.parsePrArgs(args);
  } catch (err) {
    printComputerPrHelp(logError);
    return fail(err.message);
  }
  if (parsed.help) {
    printComputerPrHelp(log);
    return 0;
  }
  if (!ctx?.businessId || !ctx?.workspaceId) {
    return fail('No business computer selected. Pass --business <slug>.');
  }

  const { repo, task, base } = parsed;
  const branch = parsed.branch || prLib.defaultBranchName(task, deps.now ? deps.now() : new Date());
  const title = prLib.titleFromTask(task);
  const prompt = prLib.buildPullRequestPrompt({ owner: repo.owner, name: repo.name, task, base, branch, title });

  const awake = await wake(token, ctx);
  if (!awake) return fail('The business computer did not become ready in time, so no pull request was started.');

  const worker = activeWorker(options.worker || ctx.worker);
  const laneSource = options.worker ? '' : ctx.worker ? ' (saved for this business)' : '';
  log(`Opening a pull request on ${repo.owner}/${repo.name} from branch ${branch}.`);
  log(`  Lane: ${formatWorkerName(worker)}  ${formatCloudSelection({ worker, model: options.model })}${laneSource}`);

  const started = await request(`/business/${ctx.businessId}/chat`, {
    method: 'POST',
    token,
    body: {
      message: prompt,
      workspace_id: ctx.workspaceId,
      worker,
      ...(options.model ? { model: options.model } : {}),
    },
    timeoutMs: 40000,
    retries: 0,
  });
  if (!started.ok || !started.data?.execution_id) {
    return fail(`The run could not start: ${started.error || started.status || 'no run id came back'}`);
  }

  const out = prLib.createRedactingWriter(write);
  const streamed = await stream(token, ctx, started.data.execution_id, null, {
    write: (s) => out.write(s),
    writeError: (s) => { out.flush(); logError(prLib.redactSecrets(s)); },
  });
  out.flush();

  const text = [streamed?.text, streamed?.resultText].filter(Boolean).join('\n');
  const result = prLib.parsePullRequestResult(text, repo);

  if (result.ok) {
    log('');
    log(`Pull request opened: ${title}`);
    log(`Branch: ${result.branch || branch}`);
    log(result.url);
    return 0;
  }
  if (result.failedStep) {
    return fail(`Step ${result.failedStep} failed, so no pull request is ready: ${result.error}`);
  }
  const why = streamed?.ok
    ? `${result.error} No pull request is confirmed.`
    : `The run stopped before it finished (${streamed?.status || 'unknown'}), and no pull request link came back.`;
  logError(prLib.redactSecrets(why));
  const tail = prLib.lastLines(streamed?.text || streamed?.resultText || '', 15);
  if (tail) {
    logError('Last lines of the run:');
    logError(prLib.redactSecrets(tail));
  }
  process.exitCode = 1;
  return 1;
}

async function streamBusinessChatResult(token, ctx, executionId, rl = null, options = {}) {
  let fromIndex = 0;
  let errors = 0;
  let cancelling = false;
  let cancelPromise = null;
  let sawVisibleOutput = false;
  let terminalStatus = null;
  // Callers that need the run's words (atris computer pr) read `text` from the
  // return value, and may route printing through their own writers.
  let collectedText = '';
  let resultText = '';
  const out = typeof options.write === 'function' ? options.write : (s) => process.stdout.write(s);
  const errOut = typeof options.writeError === 'function' ? options.writeError : (s) => console.error(s);

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
          return { ok: false, status: 'connection_lost', text: collectedText, resultText };
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
            collectedText += event.content;
            out(event.content);
          } else if (event.type === 'result' && event.result && !sawVisibleOutput) {
            sawVisibleOutput = true;
            resultText = String(event.result);
            collectedText += resultText;
            out(resultText);
          } else if (event.type === 'result' && event.result) {
            resultText = String(event.result);
          } else if (showTools && !options.quiet && event.type === 'tool_use' && event.tool) {
            const arg = event.input?.file_path || event.input?.path || event.input?.pattern || event.input?.command || '';
            if (arg) {
              out(`\n  [${event.tool}] ${String(arg).slice(0, 120)}\n`);
            } else {
              out(`\n  [${event.tool}]\n`);
            }
          } else if (event.type === 'error') {
            if (event.error) errOut(`\n${event.error}`);
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

        out('\n');
        if (!sawVisibleOutput && events.data?.status === 'completed') console.log('(no result)');
        const finalStatus = terminalStatus || events.data?.status || (done ? 'completed' : 'unknown');
        return { ok: finalStatus === 'completed', status: finalStatus, text: collectedText, resultText };
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
      maxTurns: 60,
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
    console.error('run this inside a bound business workspace, or use `atris computer --local` for local mode.');
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
    ? { worker: initialOptions.worker || ctx?.worker || null, model: initialOptions.model }
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
    const messages = oneShotMessage ? [scriptedInput] : scriptedInput.split(/\r?\n/);
    for (const rawLine of messages) {
      const line = String(rawLine || '').trim();
      if (!line) continue;
      const isCommand = line.startsWith('/') && !/[\r\n]/.test(line);
      if (isCommand && (line === '/exit' || line === '/quit')) break;
      if (isCommand && line.startsWith('/run ')) {
        await computerRun(token, line.slice(5), ctx);
        continue;
      }
      if (isCommand && line === '/pwd') {
        await computerRun(token, 'pwd', ctx);
        continue;
      }
      if (isCommand && (line === '/audit' || line.startsWith('/audit '))) {
        const rawLimit = line.split(/\s+/, 2)[1];
        const limit = rawLimit ? Number.parseInt(rawLimit, 10) : 10;
        await computerAudit(token, ctx, Number.isFinite(limit) ? limit : 10);
        continue;
      }
      if (isCommand) {
        const command = line.split(/\s+/, 1)[0];
        if (!KNOWN_CHAT_COMMANDS.has(command)) {
          console.log(`Unknown command: ${command}`);
          console.log('Type /help for commands, or remove the slash to ask the model.');
        }
        continue;
      }
      sessionId = await sendBusinessChat(token, ctx, oneShotMessage ? rawLine : line, sessionId, false, null, {
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
    console.error('run inside a bound business workspace, or use `atris computer local-byo`.');
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
    console.error('run inside a bound business workspace first.');
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
      allowCanonicalShortcutFallback: !cloudOptions.businessSlug,
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
    allowCanonicalShortcutFallback: !recruitingOptions.businessSlug,
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

async function runComputer(argv = process.argv.slice(3), deps = {}) {
  const parsed = parseComputerOptions(argv);
  const args = parsed.positional;
  const cloudOptions = parsed.options;
  const sub = args[0];

  if ((sub === 'exec' || sub === 'chat') && argv.slice(argv.indexOf(sub) + 1).some(arg => arg === '--help' || arg === '-h')) {
    console.log(sub === 'exec'
      ? 'Usage: atris computer exec "<prompt>" [--business <slug>] [--workspace <id>] [--no-wait]'
      : 'Usage: atris computer chat [--message <text>] [--business <slug>] [--workspace <id>]');
    return;
  }

  if (sub === 'login') {
    const { computerLogin } = require('./computer-login');
    // The shared option reader takes --business wherever it sits, so hand it
    // on; otherwise a flag typed before `login` would be dropped silently.
    const code = await computerLogin(argv.slice(argv.indexOf('login') + 1), {
      readBusinessBinding,
      business: cloudOptions.businessSlug || '',
      ...deps,
    });
    if (code !== 0) process.exitCode = code;
    return code;
  }

  if (sub === 'setup') {
    const code = await computerSetup(deps);
    if (code !== 0) process.exitCode = code;
    return code;
  }

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

  if (sub === 'pr') {
    // Read the repo and task before any login or cloud call, so a typo costs
    // nothing and help works signed out.
    let prArgs;
    try {
      prArgs = require('../lib/computer-pr').parsePrArgs(args.slice(1));
    } catch (err) {
      printComputerPrHelp(console.error);
      console.error(err.message);
      process.exitCode = 1;
      return 1;
    }
    if (prArgs.help) {
      printComputerPrHelp();
      return 0;
    }
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
    console.log(`  cd ${businessWorkspaceBase()}/<business>`);
    console.log('  atris computer');
    console.log('  Choose Cloud workspace or Local folder, then type the outcome in plain English.');
    console.log('');
    console.log('Modes:');
    console.log('  (default)       Choose CLOUD vs LOCAL when both are available');
    console.log('  setup           Connect named Codex or Claude accounts to a computer');
    console.log('  card            Show the local owner/computer card, no login required');
    console.log('  local           Open LOCAL Atris mode; cloud brain edits this folder');
    console.log('  proof           Run the local-edit + cloud-isolation + audit proof');
    console.log('  local-byo       Open LOCAL BYO Claude mode; Anthropic tokens, no cloud audit');
    console.log('  --cloud         Open CLOUD workspace mode in the bound business workspace');
    console.log('  cloud           Open CLOUD workspace mode in the bound business workspace');
    console.log('  codeops         Open Atris CodeOps workflow computer if your account has access');
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
    console.log('  pr <owner/repo> "<task>"  Do the task on a new branch and print the pull request link (never merges)');
    console.log('                  --base <branch> --branch <name> --worker claude|openai --model <id>');
    console.log('  pull [path] [dir] Pull files from EC2 to local');
    console.log('  diff [path]       Show what changed on EC2 since last pull');
    console.log('  learn             Trigger autonomous learning cycle');
    console.log('  onboard <slug>    Set up a new business computer');
    console.log('');
    console.log('Examples:');
    console.log('  atris computer');
    console.log('  atris computer setup');
    console.log('  atris computer card --write');
    console.log('  atris business init "My Lab"     # first/default computer with Atris + operator');
    console.log('  atris computer create "Hiring Computer" --business my-lab --type recruiting');
    console.log('  atris computer --business my-lab --workspace <workspace-id>');
    console.log('  atris computer sleep --business my-lab --workspace <workspace-id>');
    console.log('  atris computer delete --business my-lab --workspace <workspace-id>');
    console.log('  atris computer proof');
    console.log('  atris computer local');
    console.log('  atris computer codex');
    console.log('  atris computer --cloud');
    console.log('  atris computer --cloud --worker openai --model <model>');
    console.log('  atris computer cloud');
    console.log('  atris computer codeops');
    console.log('  atris computer codeops status');
    console.log('  atris computer codeops run "pwd"');
    console.log('  atris computer codeops exec "Plan a safe repo fix"');
    console.log('  atris computer status');
    console.log('  atris computer wake');
    console.log('  atris computer run "ls -la /workspace"');
    console.log('  atris computer grep "overnight"');
    console.log('  atris computer cat soul/soul.md');
    console.log('  atris computer exec "Read soul/ and suggest what to work on"');
    console.log('  atris computer pr owner/repo "Fix the typo in the README" --business my-lab');
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
      process.exitCode = 1;
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
        process.exitCode = 1;
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
    case 'pr': return computerPr(token, args.slice(1), ctx, cloudOptions);
    case 'lane': return computerLane(rest, ctx);
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
      process.exitCode = 1;
  }
}

module.exports = {
  runComputer,
  computerSetup,
  // `atris pack run` starts a packet as a free local computer, so it needs the
  // local starter and the business-binding check as seams, not copies.
  computerLocal,
  readBusinessBinding,
  formatEngineSeats,
  buildComputerCard,
  extractAttachedWorkspaceMismatch,
  contextForAttachedWorkspaceMismatch,
  printRecruitingLocalSyncOutcome,
  useInteractiveCloudUi,
  useInteractiveTerminalUi,
  // Hermetic parsing/formatting layer, exported for test/computer.test.js.
  parseComputerOptions,
  parseComputerCreateArgs,
  computerCreateArgsHaveName,
  normalizeComputerType,
  formatComputerTypeList,
  parseComputerDeleteArgs,
  parseComputerCardArgs,
  renderComputerCard,
  renderComputerCardMarkdown,
  formatLeaseAge,
  formatWorkspaceRef,
  workspaceMatchesInput,
  resolveWorkspaceFromList,
  workspaceMatchesComputerType,
  looksLikeWorkspaceId,
  shellQuote,
  withoutRecruitingWrapperFlags,
  formatCloudSelection,
  computerPr,
  streamBusinessChatResult,
};
