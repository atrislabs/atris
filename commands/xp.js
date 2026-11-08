const { ensureValidCredentials } = require('../utils/auth');
const { apiRequestJson } = require('../utils/api');
const xpCore = require('../lib/xp-core');
const {
  DEFAULT_GRAPH_DAYS,
  CAREER_XP_PROJECTION_FILE,
  AGENT_XP_LABEL,
  AGENTXP_LEADERBOARD_URL,
  defaultXpWorkspace,
  asNumber,
  formatNumber,
  buildContributionRows,
  currentForm,
  readInlineFirstFlag,
  hasFlagOrValue,
  buildCareerXpProjection,
  collectLocalXpProjection,
  publicWorkspaceBinding,
  collectAllLocalXpProjection,
  textExcerpt,
  buildCareerXpSessionCapsule,
  buildAgentXpSyncPacket,
} = xpCore;

function showHelp() {
  console.log('Usage: atris xp [card|status|collect|session|sync] [--json] [--workspace <path>] [--all] [--root <path>]');
  console.log('       atris xp session [--since today|tonight|YYYY-MM-DD] [--until <time>] [--mission <text>] [--thread <id>] [--no-write]');
  console.log('       atris xp sync [--as <player>] [--local|--all] [--token <token>|logged-in] [--dry-run] [--json]');
  console.log('       atris xp [--json] [--local] [--workspace <path>] [--operator <name>]');
  console.log('');
  console.log('Show your AgentXP graph for the active Atris account.');
  console.log('With no bound business (.atris/business.json), defaults to --local workspace receipts.');
  console.log('Use status to show account-level AgentXP across verified local ledgers.');
  console.log('Use collect or status --local to project accepted task proof in the current workspace.');
  console.log('Use session to encapsulate the current work window into a local XP capsule.');
  console.log('Use sync to upload a path-private AgentXP packet to the hosted leaderboard.');
  console.log('Use status --all to explicitly aggregate verified local XP ledgers across workspaces.');
  console.log('Use --local to render from proof receipts in the current workspace.');
}

function renderContributionGraph(graph) {
  if (!graph || !Array.isArray(graph.days)) return;
  console.log('');
  console.log(`Last ${formatNumber(graph.window_days || DEFAULT_GRAPH_DAYS)} days: ${formatNumber(graph.total_xp)} ${AGENT_XP_LABEL} across ${formatNumber(graph.active_days)} active days`);
  for (const row of buildContributionRows(graph.days)) {
    console.log(row);
  }
  console.log('Legend: blank none | . started | : solid | * heavy | # breakout');
}

function renderLocalActivity(activity) {
  if (!activity || !Array.isArray(activity.detected_providers) || !activity.detected_providers.length) return;
  console.log(
    `Local activity: ${activity.detected_providers.join(', ')} | context ${formatNumber(activity.context_agent_xp)} | not public ${AGENT_XP_LABEL}`
  );
}

async function syncAgentXp(args = []) {
  const preview = buildAgentXpSyncPacket(args);
  const dryRun = hasFlagOrValue(args, '--dry-run') || hasFlagOrValue(args, '--no-post') || hasFlagOrValue(args, '--packet');
  if (dryRun) return preview;

  const token = readInlineFirstFlag(args, '--token', process.env.ATRIS_AGENTXP_SYNC_TOKEN || process.env.AGENTXP_SYNC_TOKEN || '');
  const envToken = process.env.ATRIS_TOKEN && process.env.ATRIS_TOKEN.trim() ? process.env.ATRIS_TOKEN.trim() : '';
  const options = {
    method: 'POST',
    body: preview.packet,
    retries: 0,
  };
  if (token) {
    options.headers = { 'X-AgentXP-Sync-Token': token };
  } else if (envToken) {
    options.token = envToken;
  } else {
    const ensured = await ensureValidCredentials(apiRequestJson);
    if (ensured.error) {
      throw new Error(
        `Missing sync auth. Run atris login, then retry atris xp sync. `
        + `Guided demos can pass --token <owner-provided-token>${ensured.detail ? ` (${ensured.detail})` : ''}.`
      );
    }
    options.token = ensured.credentials.token;
  }

  const response = await apiRequestJson('/agentxp/leaderboard/sync', options);
  if (!response.ok) {
    throw new Error(`AgentXP sync failed: ${response.error || response.status}`);
  }
  return {
    schema: 'atris.agentxp_sync_result.v1',
    generated_at: new Date().toISOString(),
    dry_run: false,
    player: preview.player,
    entry: preview.entry,
    packet_hash: preview.packet.packet_hash,
    server: response.data || {},
  };
}

function renderSync(payload) {
  const entry = payload.entry || {};
  console.log('AgentXP Sync');
  console.log(`Player ${payload.player || entry.username || 'player'} | AgentXP ${formatNumber(entry.agent_xp)} | receipts ${formatNumber(entry.verified_receipts)}`);
  if (payload.dry_run) {
    console.log(`Packet ${payload.packet?.packet_hash || 'unhashed'} ready; no network upload ran.`);
    console.log('Run atris login, then atris xp sync --local to publish to the hosted leaderboard.');
    console.log('Guided demos can pass --token <owner-provided-token>.');
    console.log(`Leaderboard: ${AGENTXP_LEADERBOARD_URL}`);
    return;
  }
  const server = payload.server || {};
  console.log(`Uploaded: accepted ${formatNumber(server.accepted_count)} | stored ${formatNumber(server.stored_count)}`);
  const acceptedUsernames = Array.isArray(server.accepted_usernames)
    ? server.accepted_usernames.map(value => String(value || '').trim()).filter(Boolean)
    : [];
  if (acceptedUsernames.length) {
    console.log(`Public identity: ${acceptedUsernames.join(', ')}`);
  }
  const player = String(payload.player || entry.username || '').trim().toLowerCase();
  const accepted = acceptedUsernames.map(value => value.toLowerCase());
  if (server.mapped_to_authenticated_user === true && player && !accepted.includes(player)) {
    console.log('Login auth mapped this sync to your Atris account.');
  }
  console.log(`Packet ${payload.packet_hash}`);
  const publicAccepted = asNumber(server.public_accepted_count);
  const internalAccepted = asNumber(server.internal_accepted_count);
  if (publicAccepted > 0) {
    console.log(`Published to AgentXP: ${AGENTXP_LEADERBOARD_URL}`);
  } else if (internalAccepted > 0 || server.private_agentxp) {
    console.log('Saved internally. Public AgentXP was not updated.');
    console.log('To publish publicly, run: atris xp sync --all --public');
  } else {
    console.log(`Leaderboard: ${AGENTXP_LEADERBOARD_URL}`);
  }
}

function render(payload) {
  if (payload.schema === 'atris.agentxp_sync_preview.v1' || payload.schema === 'atris.agentxp_sync_result.v1') {
    renderSync(payload);
    return;
  }

  if (payload.schema === 'atris.career_xp_session_capsule.v1') {
    const xp = payload.xp || {};
    const tasks = payload.tasks || {};
    console.log(`${AGENT_XP_LABEL} Session ${payload.window?.label || 'window'}`);
    console.log(`${AGENT_XP_LABEL} earned ${formatNumber(xp.delta_agent_xp ?? xp.delta_xp)} | Total ${formatNumber(xp.after_agent_xp ?? xp.after_total_xp)} | Today ${formatNumber(xp.today_agent_xp ?? xp.today_xp)} | Career Level ${formatNumber(xp.level || 1)}`);
    console.log(`Tasks ${formatNumber(tasks.touched_count)} touched | ${formatNumber(tasks.review_count)} in Review | ${formatNumber(tasks.accepted_count)} accepted`);
    if (payload.proof?.latest_accepted) {
      const proof = payload.proof.latest_accepted;
      console.log(`Latest proof ${proof.task_id || proof.title || 'accepted proof'}: ${textExcerpt(proof.proof, 260)}`);
    } else {
      console.log('Latest proof: none accepted in this session');
    }
    console.log(`Mission: ${payload.mission?.label || 'Capture proof-backed work'}`);
    console.log(`Next quest: ${payload.next_quest || 'Pick the next proof-backed task.'}`);
    if (payload.files?.session_path) console.log(`Capsule: ${payload.files.session_path}`);
    console.log(`Integrity: ${xp.integrity_status || 'unknown'}`);
    return;
  }

  if (payload.schema === 'atris.career_xp_profile.v1') {
    const progress = payload.next_level_progress || {};
    console.log(`${AGENT_XP_LABEL} Card`);
    console.log(`${AGENT_XP_LABEL} ${formatNumber(payload.total_agent_xp ?? payload.total_xp)} | Today ${formatNumber(payload.today_agent_xp ?? payload.today_xp)} | Career Level ${formatNumber(payload.level || 1)}`);
    console.log(`Next career level ${formatNumber(progress.current_xp)}/${formatNumber(progress.required_xp)} ${AGENT_XP_LABEL} (${formatNumber(progress.percent)}%) | ${formatNumber(progress.remaining_xp)} to go`);
    console.log(`Workspaces ${formatNumber(payload.verified_workspace_count)}/${formatNumber(payload.workspace_count)} verified`);
    renderContributionGraph(payload.contribution_graph);
    console.log('');
    for (const workspace of payload.workspaces || []) {
      const marker = workspace.included ? 'included' : 'excluded';
      console.log(`- ${workspace.name}: ${formatNumber(workspace.total_xp)} ${AGENT_XP_LABEL} | today ${formatNumber(workspace.today_xp)} | ${workspace.integrity_status} | ${marker}`);
    }
    if (payload.latest_accepted_proof) {
      const proof = payload.latest_accepted_proof;
      console.log(`Latest proof ${proof.workspace_name || 'workspace'} / ${proof.label || proof.title || 'Accepted proof'}: ${proof.proof}`);
    } else {
      console.log('Latest proof: none accepted yet');
    }
    renderLocalActivity(payload.local_activity);
    const integrity = payload.integrity || {};
    console.log(`Integrity: ${integrity.status || 'unknown'} (${integrity.local_trust || 'local'})`);
    for (const warning of integrity.warnings || []) {
      console.log(`Warning: ${warning.workspace_root} ${warning.reason}`);
    }
    return;
  }

  if (payload.schema === 'atris.career_xp_projection.v1') {
    const progress = payload.next_level_progress || {};
    console.log(`${AGENT_XP_LABEL} Card`);
    console.log(`${AGENT_XP_LABEL} ${formatNumber(payload.total_agent_xp ?? payload.total_xp)} | Today ${formatNumber(payload.today_agent_xp ?? payload.today_xp)} | Career Level ${formatNumber(payload.level || 1)}`);
    console.log(`Next career level ${formatNumber(progress.current_xp)}/${formatNumber(progress.required_xp)} ${AGENT_XP_LABEL} (${formatNumber(progress.percent)}%) | ${formatNumber(progress.remaining_xp)} to go`);
    renderContributionGraph(payload.contribution_graph);
    console.log('');
    if (payload.latest_accepted_proof) {
      const proof = payload.latest_accepted_proof;
      console.log(`Latest proof ${proof.label || proof.title || 'Accepted proof'}: ${proof.proof}`);
    } else {
      console.log('Latest proof: none accepted yet');
    }
    renderLocalActivity(payload.local_activity);
    console.log(`Ledger: ${payload.ledger?.projection_path || CAREER_XP_PROJECTION_FILE}`);
    return;
  }

  const graph = payload.contribution_graph || {};
  const form = currentForm(payload);

  console.log(`${AGENT_XP_LABEL} ${formatNumber(payload.agent_xp ?? payload.career_xp)} | Career Level ${formatNumber(payload.level || 1)}`);
  if (form) {
    const stats = form.visibleStats.length ? ` | ${form.visibleStats.join(', ')}` : '';
    console.log(`Current form ${form.ovr}/99 | ${form.integrityStatus}${stats}`);
  }
  console.log(`Last ${formatNumber(graph.window_days || 365)} days: ${formatNumber(graph.total_xp)} ${AGENT_XP_LABEL} across ${formatNumber(graph.active_days)} active days`);
  console.log('');
  for (const row of buildContributionRows(graph.days)) {
    console.log(row);
  }
  console.log('');
  console.log('Legend: blank none | . started | : solid | * heavy | # breakout');
  if (payload.leaderboard_eligible === false) {
    console.log('Leaderboard: integrity review needed before public ranking.');
  }
}

async function xpCommand(...args) {
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    showHelp();
    return;
  }

  const subcommand = args[0] && !args[0].startsWith('--') ? args[0] : null;
  if (subcommand === 'sync') {
    const commandArgs = args.slice(1);
    let payload;
    try {
      payload = await syncAgentXp(commandArgs);
    } catch (error) {
      console.error(`Failed to sync AgentXP: ${error.message}`);
      process.exit(1);
    }
    if (args.includes('--json')) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    render(payload);
    return;
  }

  if (subcommand === 'session') {
    const commandArgs = args.slice(1);
    let payload;
    try {
      payload = buildCareerXpSessionCapsule(commandArgs);
    } catch (error) {
      console.error(`Failed to build local XP session: ${error.message}`);
      process.exit(1);
    }
    if (args.includes('--json')) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    render(payload);
    return;
  }

  if (subcommand === 'collect' || subcommand === 'status' || subcommand === 'card') {
    const commandArgs = args.slice(1);
    let payload;
    try {
      const explicitLocal = hasFlagOrValue(commandArgs, '--local')
        || hasFlagOrValue(commandArgs, '--workspace')
        || hasFlagOrValue(commandArgs, '--operator');
      const accountStatus = (subcommand === 'status' || subcommand === 'card') && !explicitLocal;
      payload = hasFlagOrValue(commandArgs, '--all') || accountStatus
        ? collectAllLocalXpProjection(commandArgs)
        : collectLocalXpProjection(commandArgs);
    } catch (error) {
      console.error(`Failed to collect local XP: ${error.message}`);
      process.exit(1);
    }
    if (args.includes('--json')) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    render(payload);
    return;
  }

  if (subcommand) {
    console.error(`Unknown xp subcommand: ${subcommand}`);
    showHelp();
    process.exit(1);
  }

  const jsonMode = args.includes('--json');
  const explicitLocal = hasFlagOrValue(args, '--local') || hasFlagOrValue(args, '--workspace') || hasFlagOrValue(args, '--operator');
  // No bound business means cloud graph has nothing useful; default to local receipts.
  const boundBusiness = publicWorkspaceBinding(defaultXpWorkspace());
  const localMode = explicitLocal || !boundBusiness;
  if (localMode) {
    let payload;
    try {
      payload = collectLocalXpProjection(args);
    } catch (error) {
      console.error(`Failed to collect local XP: ${error.message}`);
      process.exit(1);
    }
    if (jsonMode) {
      console.log(JSON.stringify(payload));
      return;
    }
    render(payload);
    return;
  }

  const ensured = await ensureValidCredentials(apiRequestJson);
  if (ensured.error) {
    console.error(`Not logged in. Run: atris login, or use --local inside a workspace${ensured.detail ? ` (${ensured.detail})` : ''}`);
    process.exit(1);
  }

  const result = await apiRequestJson('/profile/contribution-graph', {
    method: 'GET',
    token: ensured.credentials.token,
  });
  if (!result.ok) {
    console.error(`Failed to load XP graph: ${result.error || result.status}`);
    console.error('Run: atris xp --local  to render your AgentXP from proof receipts in this workspace.');
    process.exit(1);
  }

  if (jsonMode) {
    console.log(JSON.stringify(result.data || {}));
    return;
  }

  render(result.data || {});
}

module.exports = {
  ...xpCore,
  xpCommand,
  buildCareerXpProjection,
  collectLocalXpProjection,
  syncAgentXp,
  render,
};
