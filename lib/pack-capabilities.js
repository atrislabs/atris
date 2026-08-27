'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');
const { randomUUID } = require('crypto');
const { enforceConfigGuard } = require('./config-guard');

const CAPABILITY_DEFINITIONS = Object.freeze({
  'pack.read': Object.freeze({
    description: 'read and search files inside the pack root',
    tools: Object.freeze(['Read', 'Glob', 'Grep', 'Skill']),
  }),
  'pack.write': Object.freeze({
    description: 'read, create, and edit files inside the pack root',
    tools: Object.freeze(['Read', 'Glob', 'Grep', 'Skill', 'Edit', 'Write']),
  }),
  'web.read': Object.freeze({
    description: 'fetch and search the public web',
    tools: Object.freeze(['WebFetch', 'WebSearch']),
  }),
  'host.shell': Object.freeze({
    description: 'run unrestricted host shell commands (includes host files and network)',
    tools: Object.freeze(['Bash']),
  }),
});

const TOOL_ORDER = Object.freeze([
  'Read', 'Glob', 'Grep', 'Skill',
  'Edit', 'Write',
  'WebFetch', 'WebSearch',
  'Bash',
]);

const FILE_TOOLS = new Set(['Read', 'Glob', 'Grep', 'Edit', 'Write']);
const PRE_TOOL_USE_MATCHER = 'Read|Glob|Grep|Edit|Write|WebFetch|Bash';
const CLAUDE_SESSION_END_REASONS = new Set([
  'clear',
  'resume',
  'logout',
  'prompt_input_exit',
  'bypass_permissions_disabled',
  'other',
]);

function canonicalCapabilityNames() {
  return Object.keys(CAPABILITY_DEFINITIONS);
}

function toolsForCapabilities(capabilities) {
  const granted = new Set();
  for (const capability of capabilities) {
    for (const tool of CAPABILITY_DEFINITIONS[capability].tools) granted.add(tool);
  }
  return TOOL_ORDER.filter((tool) => granted.has(tool));
}

function resolvePackCapabilityPolicy(value) {
  if (value === undefined || value === null) {
    return { status: 'legacy', requested: [], grantedCapabilities: [], tools: [] };
  }
  if (!Array.isArray(value)) {
    return {
      status: 'invalid',
      requested: [],
      tools: [],
      reason: `permissions must be an array of canonical capabilities (${canonicalCapabilityNames().join(', ')})`,
    };
  }

  const requested = [];
  const seen = new Set();
  for (const raw of value) {
    if (typeof raw !== 'string' || raw.trim() !== raw || !raw) {
      return {
        status: 'invalid',
        requested: [],
        tools: [],
        reason: 'permissions entries must be non-empty strings without surrounding whitespace',
      };
    }
    if (!CAPABILITY_DEFINITIONS[raw]) {
      return {
        status: 'invalid',
        requested: [],
        tools: [],
        reason: `unknown capability ${JSON.stringify(raw)}; supported capabilities: ${canonicalCapabilityNames().join(', ')}`,
      };
    }
    if (seen.has(raw)) {
      return {
        status: 'invalid',
        requested: [],
        tools: [],
        reason: `duplicate capability ${JSON.stringify(raw)}`,
      };
    }
    seen.add(raw);
    requested.push(raw);
  }

  return {
    status: 'enforced',
    requested,
    grantedCapabilities: [...requested],
    tools: toolsForCapabilities(requested),
  };
}

function assertPackCapabilityPolicy(value) {
  const policy = resolvePackCapabilityPolicy(value);
  if (policy.status === 'invalid') throw new Error(`pack.json ${policy.reason}`);
  return policy;
}

function applyPackCapabilityGrants(policy, grants = []) {
  if (!grants.length) return policy;
  const grantPolicy = resolvePackCapabilityPolicy(grants);
  if (grantPolicy.status === 'invalid') throw new Error(`--grant ${grantPolicy.reason}`);
  const grantedCapabilities = [...new Set([
    ...(policy.status === 'enforced' ? policy.grantedCapabilities : []),
    ...grantPolicy.requested,
  ])];
  return {
    status: 'enforced',
    requested: policy.status === 'enforced' ? [...policy.requested] : [],
    grantedCapabilities,
    tools: toolsForCapabilities(grantedCapabilities),
    operatorEscalated: true,
  };
}

// Atris reads a small amount of pack content before Claude starts: the
// entrypoint, persona, task count, and skill metadata. Claude's tool hooks do
// not exist yet at that point, so a symlink anywhere in a declared pack could
// otherwise make the launcher itself cross the advertised pack-root boundary.
// Published ZIPs cannot contain symlinks; apply the same portable-artifact
// contract to declared local folders before any execution context is gathered.
function assertPackExecutionTree(packDir) {
  const root = fs.realpathSync(packDir);

  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        throw new Error(`declared pack execution tree cannot contain symlinks: ${relative}`);
      }
      if (stat.isDirectory()) {
        visit(absolute);
      } else if (!stat.isFile()) {
        throw new Error(`declared pack execution tree contains an unsupported file: ${relative}`);
      }
    }
  }

  visit(root);
  return root;
}

function readClaudeUserDenyRules(options = {}) {
  const configDir = path.resolve(
    options.configDir
      || process.env.CLAUDE_CONFIG_DIR
      || path.join(os.homedir(), '.claude'),
  );
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(configDir, 'settings.json'), 'utf8'));
    const deny = settings && settings.permissions && settings.permissions.deny;
    if (!Array.isArray(deny)) return [];
    return [...new Set(deny.filter((rule) => typeof rule === 'string' && rule.trim()))];
  } catch {
    return [];
  }
}

function toolCapability(tool, requested) {
  for (const capability of requested) {
    if (CAPABILITY_DEFINITIONS[capability].tools.includes(tool)) return capability;
  }
  return null;
}

function trustedAllowRules(policy) {
  // `dontAsk` denies every call that is not explicitly pre-approved. Keep the
  // approval list identical to the --tools ceiling; the PreToolUse hook below
  // remains the authority that confines built-in file tools to the pack root.
  return [...policy.tools];
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function buildClaudeCapabilityArgs(policy, options = {}) {
  if (!policy || policy.status !== 'enforced') return [];
  const trust = options.trust === true;
  const userDenyRules = Array.isArray(options.userDenyRules) ? options.userDenyRules : [];
  const hookScript = options.hookScript || __filename;
  const hookCommand = `${shellQuote(process.execPath)} ${shellQuote(hookScript)}`;
  const settings = {
    disableAllHooks: false,
    disableSkillShellExecution: true,
    permissions: {
      defaultMode: trust ? 'dontAsk' : 'default',
      disableBypassPermissionsMode: 'disable',
      disableAutoMode: 'disable',
      ...(userDenyRules.length ? { deny: [...userDenyRules] } : {}),
      ...(trust ? { allow: trustedAllowRules(policy) } : {}),
    },
    hooks: {
      PreToolUse: [{
        matcher: PRE_TOOL_USE_MATCHER,
        hooks: [{ type: 'command', command: `${hookCommand} pre` }],
      }],
      PostToolUse: [{
        hooks: [{ type: 'command', command: `${hookCommand} used` }],
      }],
      PostToolUseFailure: [{
        hooks: [{ type: 'command', command: `${hookCommand} failed` }],
      }],
      SessionEnd: [{
        hooks: [{ type: 'command', command: `${hookCommand} session-end` }],
      }],
    },
  };

  return [
    '--tools', policy.tools.join(','),
    '--permission-mode', trust ? 'dontAsk' : 'default',
    '--no-chrome',
    ...(options.nonInteractive ? ['--no-session-persistence'] : []),
    '--setting-sources', '',
    '--strict-mcp-config',
    '--mcp-config', JSON.stringify({ mcpServers: {} }),
    '--settings', JSON.stringify(settings),
  ];
}

function receiptDirectory(options = {}) {
  if (options.receiptDir) return path.resolve(options.receiptDir);
  if (process.env.ATRIS_PACK_RUNS_DIR) return path.resolve(process.env.ATRIS_PACK_RUNS_DIR);
  return path.join(os.homedir(), '.atris', 'runs', 'packs');
}

function appendReceiptEvent(eventsPath, event) {
  fs.appendFileSync(eventsPath, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function readReceiptEvents(eventsPath) {
  if (!fs.existsSync(eventsPath)) return [];
  return fs.readFileSync(eventsPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function finalizePackRunReceipt(receiptPath, eventsPath) {
  const events = readReceiptEvents(eventsPath);
  const launch = events.find((event) => event.event === 'launch');
  if (!launch) throw new Error('pack run receipt is missing its launch event');
  const usedTools = [...new Set(events.filter((event) => event.event === 'used').map((event) => event.tool))];
  const usedCapabilities = launch.grantedCapabilities.filter((capability) => (
    usedTools.some((tool) => toolCapability(tool, [capability]) === capability)
  ));
  const exit = [...events].reverse().find((event) => event.event === 'exit');
  const sessionEnd = [...events].reverse().find((event) => event.event === 'session-end');
  const summary = {
    schema: launch.schema,
    runId: launch.runId,
    status: exit ? 'finished' : sessionEnd ? 'session-ended' : 'running',
    startedAt: launch.startedAt,
    ...(sessionEnd ? {
      sessionEndedAt: sessionEnd.at,
      sessionEndReason: sessionEnd.reason,
    } : {}),
    ...(exit ? { finishedAt: exit.at, exitStatus: exit.status, signal: exit.signal || null } : {}),
    pack: launch.pack,
    ...(launch.launcher ? { launcher: launch.launcher } : {}),
    ...(launch.operatorInput ? { operatorInput: launch.operatorInput } : {}),
    approvalMode: launch.approvalMode,
    requestedCapabilities: launch.requestedCapabilities,
    grantedCapabilities: launch.grantedCapabilities,
    grantedTools: launch.grantedTools,
    usedCapabilities,
    usedTools,
    deniedUses: events.filter((event) => event.event === 'denied').map(({ at, tool, reason }) => ({ at, tool, reason })),
    failedTools: events.filter((event) => event.event === 'failed').map(({ at, tool }) => ({ at, tool })),
    observability: {
      denialCoverage: 'atris-hooks-only',
      runtimePermissionDenialsCaptured: false,
      toolInputsLogged: false,
      directSkillInvocationsCaptured: false,
      runnerExitCaptured: Boolean(exit),
    },
    enforcement: launch.enforcement,
    events: path.basename(eventsPath),
  };
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true, mode: 0o700 });
  const temporary = `${receiptPath}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(summary, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, receiptPath);
  return summary;
}

function defaultProcessExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && error.code === 'EPERM') return true;
    if (error && error.code === 'ESRCH') return false;
    return null;
  }
}

// A missing Atris launcher does not prove that its child runner stopped. Keep
// append-only receipt truth intact and derive the narrower fact consumers can
// trust: whether Atris still owns the lifecycle of a receipt recorded as live.
function classifyPackRunLifecycle(receipt, options = {}) {
  const recordedStatus = receipt && receipt.status ? receipt.status : 'unknown';
  if (recordedStatus === 'finished') {
    return {
      status: 'finished', recordedStatus, launcherStatus: 'not-needed', runnerStatus: 'ended',
    };
  }
  if (recordedStatus === 'session-ended') {
    return {
      status: 'session-ended', recordedStatus, launcherStatus: 'not-needed', runnerStatus: 'session-ended',
    };
  }
  if (recordedStatus !== 'running') {
    return {
      status: 'unknown', recordedStatus, launcherStatus: 'unknown', runnerStatus: 'unknown',
    };
  }

  const pid = receipt && receipt.launcher && Number(receipt.launcher.pid);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return {
      status: 'unknown', recordedStatus, launcherStatus: 'unknown', runnerStatus: 'unknown',
    };
  }
  const processExists = options.processExists || defaultProcessExists;
  const alive = processExists(pid);
  if (alive === true) {
    return {
      status: 'running', recordedStatus, launcherStatus: 'active', runnerStatus: 'unknown',
    };
  }
  if (alive === false) {
    return {
      status: 'launcher-lost', recordedStatus, launcherStatus: 'lost', runnerStatus: 'unknown',
    };
  }
  return {
    status: 'unknown', recordedStatus, launcherStatus: 'unknown', runnerStatus: 'unknown',
  };
}

function beginPackRunReceipt(packDir, manifest, policy, options = {}) {
  const dir = receiptDirectory(options);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const now = options.now ? options.now() : new Date();
  const runId = options.runId || randomUUID();
  const slug = String(manifest.slug || manifest.name || 'pack').replace(/[^a-z0-9-]+/gi, '-').toLowerCase();
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const base = `${stamp}-${slug}-${runId.slice(0, 8)}`;
  const eventsPath = path.join(dir, `${base}.events.jsonl`);
  const receiptPath = path.join(dir, `${base}.json`);
  const launch = {
    schema: 'atris.pack-run.v1',
    event: 'launch',
    runId,
    startedAt: now.toISOString(),
    pack: {
      slug: manifest.slug || manifest.name || null,
      version: manifest.version || null,
      root: fs.realpathSync(packDir),
    },
    launcher: {
      pid: Number.isSafeInteger(options.launcherPid) && options.launcherPid > 0
        ? options.launcherPid
        : process.pid,
    },
    ...(options.operatorInput ? { operatorInput: options.operatorInput } : {}),
    approvalMode: options.trust ? 'pre-approved-within-declared-ceiling' : 'prompt-within-declared-ceiling',
    requestedCapabilities: policy.requested,
    grantedCapabilities: policy.grantedCapabilities,
    grantedTools: policy.tools,
    enforcement: {
      runner: 'claude',
      builtInToolCeiling: true,
      packRootFileBoundary: true,
      claudeSettingsGuard: true,
      preLaunchContextBoundary: true,
      declaredTreeSymlinksRejected: true,
      packOpeningSlashCommandsEscaped: true,
      claudeMemoryDisabledByRunner: true,
      autoMemoryDisabledByRunner: true,
      chromeIntegrationDisabledByRunner: true,
      sessionPersistenceSuppressionRequested: true,
      sessionPersistenceDisabledByRunner: options.nonInteractive === true,
      sessionPersistenceMayApply: options.nonInteractive !== true,
      openingPromptTransport: options.nonInteractive === true ? 'stdin' : 'argv',
      runnerArgvContainsOpeningPrompt: options.nonInteractive !== true,
      workspaceTrustPromptMayApply: options.nonInteractive !== true,
      workspaceTrustDoesNotWidenToolCeiling: true,
      webReadDestinationPreflight: 'literal-and-dns-private-address-deny',
      webReadDnsRebindingNotPrevented: true,
      subprocessCredentialScrubRequested: true,
      userSettingsLoaded: false,
      userDenyRulesImported: Number(options.userDenyRulesImported || 0),
      userExtensionsLoaded: false,
      projectSettingsLoaded: false,
      managedPoliciesMayApply: true,
      bundledClaudeSkillsMayApply: true,
      packSkillsPluginLoaded: options.packSkillsPluginLoaded === true,
      packSkillFrontmatterSanitized: true,
      packSkillApprovalOverridesRemoved: true,
      packSkillHooksRemoved: true,
      skillShellExecutionDisabled: true,
      mcpServersLoaded: false,
      hostShellUnrestricted: policy.grantedCapabilities.includes('host.shell'),
    },
  };
  appendReceiptEvent(eventsPath, launch);
  finalizePackRunReceipt(receiptPath, eventsPath);
  return { runId, receiptPath, eventsPath };
}

function insideRoot(candidate, root) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function realBoundaryPath(candidate) {
  let cursor = candidate;
  const suffix = [];
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    suffix.unshift(path.basename(cursor));
    cursor = parent;
  }
  const real = fs.realpathSync(cursor);
  return path.resolve(real, ...suffix);
}

function unsafeGlobPattern(value) {
  if (!value) return false;
  const normalized = String(value).replace(/\\/g, '/');
  return normalized.startsWith('/')
    || normalized.startsWith('~/')
    || normalized.split('/').includes('..');
}

function fileToolTarget(tool, input, root) {
  if (tool === 'Glob' || tool === 'Grep') return input.path ? String(input.path) : root;
  return input.file_path ? String(input.file_path) : null;
}

function enforcePackRoot(input, rootValue) {
  const tool = input && input.tool_name;
  if (!FILE_TOOLS.has(tool)) return { allowed: true };
  const root = fs.realpathSync(rootValue);
  const toolInput = input.tool_input || {};
  if (tool === 'Glob' && unsafeGlobPattern(toolInput.pattern)) {
    return { allowed: false, reason: 'Glob patterns cannot escape the pack root' };
  }
  if (tool === 'Grep' && unsafeGlobPattern(toolInput.glob)) {
    return { allowed: false, reason: 'Grep glob filters cannot escape the pack root' };
  }
  const targetValue = fileToolTarget(tool, toolInput, root);
  if (!targetValue) return { allowed: false, reason: `${tool} did not provide a path Atris can confine` };
  const lexical = path.resolve(root, targetValue);
  if (!insideRoot(lexical, root)) {
    return { allowed: false, reason: `${tool} is confined to the pack root` };
  }
  let real;
  try {
    real = realBoundaryPath(lexical);
  } catch {
    return { allowed: false, reason: `${tool} target could not be resolved safely inside the pack root` };
  }
  if (!insideRoot(real, root)) {
    return { allowed: false, reason: `${tool} cannot follow a symlink outside the pack root` };
  }
  return { allowed: true };
}

function normalizedHostname(value) {
  const lower = String(value || '').toLowerCase().replace(/\.$/, '');
  return lower.startsWith('[') && lower.endsWith(']') ? lower.slice(1, -1) : lower;
}

function privateIpv4(address) {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return true;
  }
  const [a, b] = octets;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || a >= 224;
}

function privateIpv6(address) {
  const value = address.toLowerCase();
  if (value === '::' || value === '::1' || value.startsWith('::ffff:')) return true;
  const first = Number.parseInt(value.split(':')[0] || '0', 16);
  return (first & 0xfe00) === 0xfc00
    || (first & 0xffc0) === 0xfe80
    || (first & 0xff00) === 0xff00;
}

function privateNetworkAddress(address) {
  const value = normalizedHostname(address);
  const family = net.isIP(value);
  if (family === 4) return privateIpv4(value);
  if (family === 6) return privateIpv6(value);
  return true;
}

function localHostname(hostname) {
  return hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || hostname.endsWith('.internal')
    || hostname.endsWith('.lan')
    || hostname.endsWith('.home')
    || hostname.endsWith('.home.arpa');
}

function publicWebUrlPreflight(input) {
  if (!input || input.tool_name !== 'WebFetch') return { allowed: true };
  const rawUrl = input.tool_input && input.tool_input.url;
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    return { allowed: false, reason: 'WebFetch did not provide a URL Atris can confine to public destinations' };
  }
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: 'WebFetch URL is invalid' };
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    return { allowed: false, reason: 'WebFetch is confined to ordinary public HTTP(S) URLs without embedded credentials' };
  }
  const hostname = normalizedHostname(parsed.hostname);
  if (!hostname || localHostname(hostname)) {
    return { allowed: false, reason: 'WebFetch is confined to public network destinations' };
  }
  const family = net.isIP(hostname);
  if (family && privateNetworkAddress(hostname)) {
    return { allowed: false, reason: 'WebFetch is confined to public network destinations' };
  }
  return { allowed: true, hostname, needsDns: family === 0 };
}

async function enforcePublicWeb(input, options = {}) {
  const lexical = publicWebUrlPreflight(input);
  if (!lexical.allowed || !lexical.needsDns) return lexical;
  const lookup = options.lookup || dns.lookup;
  let addresses;
  try {
    addresses = await lookup(lexical.hostname, { all: true, verbatim: true });
  } catch {
    return { allowed: false, reason: 'WebFetch destination could not be resolved as a public network address' };
  }
  if (!Array.isArray(addresses) || !addresses.length
      || addresses.some((entry) => !entry || privateNetworkAddress(entry.address))) {
    return { allowed: false, reason: 'WebFetch is confined to public network destinations' };
  }
  return { allowed: true };
}

function hookEnvironment() {
  const root = process.env.ATRIS_PACK_ROOT;
  const receiptPath = process.env.ATRIS_PACK_RECEIPT;
  const eventsPath = process.env.ATRIS_PACK_RECEIPT_EVENTS;
  const grantedCapabilities = JSON.parse(process.env.ATRIS_PACK_GRANTED_CAPABILITIES || '[]');
  if (!root || !receiptPath || !eventsPath) throw new Error('Atris pack hook environment is incomplete');
  return { root, receiptPath, eventsPath, grantedCapabilities };
}

function readStdin() {
  return fs.readFileSync(0, 'utf8').trim();
}

function denyPreToolUse(env, input, reason, now) {
  appendReceiptEvent(env.eventsPath, {
    event: 'denied', at: now, tool: input.tool_name || null, reason,
  });
  finalizePackRunReceipt(env.receiptPath, env.eventsPath);
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

function decidePreToolUse(input, env) {
  const configDecision = enforceConfigGuard(input, { cwd: env.root });
  if (!configDecision.allowed) return configDecision;
  return enforcePackRoot(input, env.root);
}

function runHook(mode, rawInput) {
  const env = hookEnvironment();
  const input = rawInput ? JSON.parse(rawInput) : {};
  const now = new Date().toISOString();
  if (mode === 'pre') {
    const decision = decidePreToolUse(input, env);
    if (!decision.allowed) {
      return denyPreToolUse(env, input, decision.reason, now);
    }
    return null;
  }

  if (mode === 'used' || mode === 'failed') {
    appendReceiptEvent(env.eventsPath, {
      event: mode,
      at: now,
      tool: input.tool_name || null,
      capability: toolCapability(input.tool_name, env.grantedCapabilities),
    });
  } else if (mode === 'session-end') {
    const reason = CLAUDE_SESSION_END_REASONS.has(input.reason) ? input.reason : 'other';
    appendReceiptEvent(env.eventsPath, { event: 'session-end', at: now, reason });
  } else {
    throw new Error(`unknown pack hook mode: ${mode}`);
  }
  finalizePackRunReceipt(env.receiptPath, env.eventsPath);
  return null;
}

async function runHookAsync(mode, rawInput, options = {}) {
  if (mode !== 'pre') return runHook(mode, rawInput);
  const env = hookEnvironment();
  const input = rawInput ? JSON.parse(rawInput) : {};
  const now = new Date().toISOString();
  const fileDecision = decidePreToolUse(input, env);
  if (!fileDecision.allowed) return denyPreToolUse(env, input, fileDecision.reason, now);
  const webDecision = await enforcePublicWeb(input, options);
  if (!webDecision.allowed) return denyPreToolUse(env, input, webDecision.reason, now);
  return null;
}

if (require.main === module) {
  (async () => {
    try {
      const output = await runHookAsync(process.argv[2], readStdin());
      if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
    } catch (error) {
      process.stderr.write(`Atris pack capability hook failed: ${error.message}\n`);
      process.exitCode = process.argv[2] === 'pre' ? 2 : 0;
    }
  })();
}

module.exports = {
  canonicalCapabilityNames,
  resolvePackCapabilityPolicy,
  assertPackCapabilityPolicy,
  applyPackCapabilityGrants,
  assertPackExecutionTree,
  readClaudeUserDenyRules,
  buildClaudeCapabilityArgs,
  beginPackRunReceipt,
  appendReceiptEvent,
  finalizePackRunReceipt,
  receiptDirectory,
  classifyPackRunLifecycle,
  enforceConfigGuard,
  enforcePackRoot,
  publicWebUrlPreflight,
  enforcePublicWeb,
  runHook,
  runHookAsync,
};
