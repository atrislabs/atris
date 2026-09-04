'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');
const { randomUUID, createHash } = require('crypto');
const { isDeepStrictEqual } = require('util');
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
// File tools that mutate bytes. Only these are journaled with an action
// identity and only these are ever denied as recovered-completed paths.
const FILE_MUTATION_TOOLS = new Set(['Edit', 'Write']);
// Journal support marker. Runs launched before this marker carry no per-action
// identity, so their receipts can never back a recovery.
const PACK_JOURNAL_VERSION = 1;
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
  const fileEffects = pairPackFileEffects(events);
  const inheritedProtected = requireInheritedProtection(launch, null);
  const protectedFiles = mergeProtectedFiles(inheritedProtected, fileEffects.confirmed);
  const recoveryMode = launch.recovery && launch.recovery.mode === 'recovered' ? 'recovered' : 'fresh';
  const journalSupported = Boolean(launch.journal && launch.journal.supported === true
    && launch.journal.version === PACK_JOURNAL_VERSION);
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
    journal: launch.journal && typeof launch.journal === 'object'
      ? launch.journal
      : { version: 0, supported: false },
    fileEffects: {
      confirmed: fileEffects.confirmed,
      unresolved: fileEffects.unresolved,
      failed: fileEffects.failed,
    },
    recovery: {
      mode: recoveryMode,
      ...(recoveryMode === 'recovered'
        ? { parentRunId: launch.recovery.parentRunId || null, parentReceipt: launch.recovery.parentReceipt || null }
        : {}),
      protectedFiles,
      journalVersion: (launch.journal && launch.journal.version) || 0,
      hasMissingIdentity: fileEffects.unresolved.some((item) => item.reason === 'missing-identity'),
    },
    observability: {
      denialCoverage: 'atris-hooks-only',
      runtimePermissionDenialsCaptured: false,
      toolInputsLogged: false,
      directSkillInvocationsCaptured: false,
      runnerExitCaptured: Boolean(exit),
      fileEffectIdentitiesLogged: journalSupported,
      recoveryLinked: recoveryMode === 'recovered',
      protectedFilesCarried: protectedFiles.length,
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

// ── file-effect journal and explicit recovery ─────────────────────────────
// Intent is journaled in PreToolUse after every guard approves but before the
// tool executes, keyed by tool_use_id plus canonical relative target. No raw
// content or arguments ever enter the journal. PostToolUse confirms the same
// identity with the on-disk SHA-256. A missing post stays unresolved, and an
// interactive permission denial (prompt answered "no") can also leave an
// intent with no post hook, so recovery primarily serves headless/trusted
// runs and refuses anything unresolved rather than risk replay.
function hookToolUseId(input) {
  const id = input && input.tool_use_id;
  return typeof id === 'string' && id.trim() ? id : null;
}

function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

function journalRelativeTarget(tool, toolInput, root) {
  const targetValue = fileToolTarget(tool, toolInput || {}, root);
  if (!targetValue) return null;
  const realRoot = fs.realpathSync(root);
  const rel = path.relative(realRoot, path.resolve(realRoot, targetValue));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

function readFileIdentity(absPath) {
  try {
    const stat = fs.statSync(absPath);
    if (!stat.isFile()) return { present: true, isFile: false };
    return {
      present: true,
      isFile: true,
      sha256: sha256Hex(fs.readFileSync(absPath)),
      dev: stat.dev,
      ino: stat.ino,
      nlink: stat.nlink,
    };
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return { present: false };
    throw error;
  }
}

function readProtectedFiles() {
  const raw = process.env.ATRIS_PACK_PROTECTED_FILES;
  if (raw === undefined || raw === null || raw === '') return { ok: true, files: [] };
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { ok: false, files: [] };
    const files = [];
    for (const entry of parsed) {
      if (!entry || typeof entry.target !== 'string' || typeof entry.sha256 !== 'string') {
        return { ok: false, files: [] };
      }
      files.push(entry);
    }
    return { ok: true, files };
  } catch {
    return { ok: false, files: [] };
  }
}

function readAuthoritativeProtectedFiles(env) {
  const raw = fs.readFileSync(env.eventsPath, 'utf8');
  let launch = null;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const parsed = JSON.parse(line);
    if (parsed && parsed.event === 'launch') {
      if (launch) throw new Error('recovery journal has duplicate launch events');
      launch = parsed;
    }
  }
  if (!launch) throw new Error('recovery journal is missing its launch event');
  const recovery = launch.recovery || { mode: 'fresh' };
  if (recovery.mode !== undefined && recovery.mode !== 'fresh' && recovery.mode !== 'recovered') {
    throw new Error('recovery journal has malformed recovered protection');
  }
  if (recovery.mode === 'recovered') {
    if (typeof recovery.parentRunId !== 'string' || !recovery.parentRunId
      || typeof recovery.parentReceipt !== 'string' || !recovery.parentReceipt
      || !Array.isArray(recovery.protectedFiles)) {
      throw new Error('recovery journal has malformed recovered protection');
    }
    for (const entry of recovery.protectedFiles) {
      if (!entry || typeof entry.target !== 'string' || typeof entry.sha256 !== 'string'
        || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
        throw new Error('recovery journal has malformed recovered protection');
      }
    }
    return { mode: 'recovered', files: recovery.protectedFiles };
  }
  if (!Array.isArray(recovery.protectedFiles || [])) throw new Error('recovery journal has malformed protection');
  return { mode: 'fresh', files: Array.isArray(recovery.protectedFiles) ? recovery.protectedFiles : [] };
}

function protectedFileMatch(rel, absIdentity, protectedFiles) {
  for (const entry of protectedFiles) {
    if (entry.target === rel) return entry;
    // Device/inode pairing catches case aliases on macOS, where a differently
    // cased path resolves to the same bytes through no new directory entry.
    if (absIdentity && absIdentity.present && absIdentity.isFile !== false
      && Number.isFinite(entry.dev) && Number.isFinite(entry.ino)
      && absIdentity.dev === entry.dev && absIdentity.ino === entry.ino) {
      return entry;
    }
  }
  return null;
}

// Runs after the file guards approve. Denies recovered-completed paths by
// path AND device/inode; anything else passes through to journaling.
// Fails closed: malformed protection, unreadable journal, or identity errors
// deny rather than becoming an empty set.
function isAuthoritativeJournalPath(env, lexical) {
  for (const candidate of [env.receiptPath, env.eventsPath]) {
    if (!candidate) continue;
    try {
      const realCandidate = fs.realpathSync(candidate);
      let realLexical = null;
      try {
        realLexical = realBoundaryPath(lexical);
      } catch {
        realLexical = null;
      }
      if (realLexical && realLexical === realCandidate) return true;
      try {
        const a = fs.statSync(lexical);
        const b = fs.statSync(candidate);
        if (a.dev === b.dev && a.ino === b.ino) return true;
      } catch {
        // Fall through to lexical comparison below; stat failures stay denied
        // only if the paths already matched, never as an allow.
      }
      if (path.resolve(candidate) === lexical) return true;
    } catch {
      if (path.resolve(candidate) === lexical) return true;
    }
  }
  return false;
}

function checkProtectedMutation(env, input) {
  const tool = input && input.tool_name;
  if (!FILE_MUTATION_TOOLS.has(tool)) return null;
  const toolInput = input.tool_input || {};
  const targetValue = fileToolTarget(tool, toolInput, env.root);
  if (!targetValue) return null;
  const realRoot = fs.realpathSync(env.root);
  const lexical = path.resolve(realRoot, targetValue);
  const rel = path.relative(realRoot, lexical).split(path.sep).join('/');
  if (isAuthoritativeJournalPath(env, lexical)) {
    return { denied: true, reason: `${tool} to the pack run journal is denied: the journal is outside model reach` };
  }
  let identity = null;
  try {
    const stat = fs.statSync(lexical);
    identity = stat.isFile()
      ? { present: true, dev: stat.dev, ino: stat.ino }
      : { present: true };
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      identity = { present: false };
    } else {
      return { denied: true, reason: `${tool} identity check failed; refusing the mutation rather than risk replay` };
    }
  }
  let authoritative = null;
  try {
    authoritative = readAuthoritativeProtectedFiles(env);
  } catch {
    return { denied: true, reason: `${tool} protection state is unreadable; refusing the mutation rather than risk replay` };
  }
  const envBlob = readProtectedFiles();
  if (!envBlob.ok) {
    return { denied: true, reason: `${tool} protection state is malformed; refusing the mutation rather than risk replay` };
  }
  const combined = [...authoritative.files];
  for (const entry of envBlob.files) {
    if (!combined.some((item) => item.target === entry.target && item.sha256 === entry.sha256)) {
      combined.push(entry);
    }
  }
  if (authoritative.mode === 'recovered') {
    const envTargets = new Set(envBlob.files.map((entry) => entry.target));
    for (const entry of authoritative.files) {
      if (!envTargets.has(entry.target)) {
        return { denied: true, reason: `${tool} protection state is incomplete; refusing the mutation rather than risk replay` };
      }
    }
  }
  const hit = protectedFileMatch(rel, identity, combined);
  if (hit) {
    return { denied: true, reason: `${tool} to ${hit.target} is denied: the file completed in a prior run and is protected during recovery` };
  }
  return null;
}

function journalFileIntent(env, input) {
  const tool = input && input.tool_name;
  if (!FILE_MUTATION_TOOLS.has(tool)) return;
  appendReceiptEvent(env.eventsPath, {
    event: 'intent',
    at: new Date().toISOString(),
    tool,
    tool_use_id: hookToolUseId(input),
    target: journalRelativeTarget(tool, input.tool_input || {}, env.root),
  });
  // A journal write failure throws, so pre-hook setup exits 2 and the tool
  // never runs unrecorded.
  finalizePackRunReceipt(env.receiptPath, env.eventsPath);
}

function sanitizeLaunchRecovery(recovery) {
  if (!recovery || typeof recovery !== 'object') return { mode: 'fresh' };
  const protectedFiles = Array.isArray(recovery.protectedFiles)
    ? recovery.protectedFiles
      .filter((entry) => entry && typeof entry.target === 'string' && typeof entry.sha256 === 'string')
      .map((entry) => ({ target: entry.target, sha256: entry.sha256, dev: entry.dev, ino: entry.ino }))
    : [];
  return {
    mode: 'recovered',
    parentRunId: typeof recovery.parentRunId === 'string' ? recovery.parentRunId : null,
    parentReceipt: typeof recovery.parentReceipt === 'string' ? recovery.parentReceipt : null,
    protectedFiles,
  };
}

function mergeProtectedFiles(inherited, confirmed) {
  const merged = [...inherited];
  for (const entry of confirmed) {
    const record = { target: entry.target, sha256: entry.sha256, dev: entry.dev, ino: entry.ino };
    const index = merged.findIndex((item) => item.target === record.target);
    if (index === -1) merged.push(record);
    else merged[index] = record;
  }
  return merged;
}

// Pairs intent events with their post events by tool_use_id. Anything that
// does not pair cleanly is unresolved, including confirmations that arrive
// without an intent and intents whose confirmation never arrived. Strict:
// each mutation has exactly one identity, intent precedes post with same
// tool AND target, duplicates/unknown shapes/malformed hashes refuse.
function pairPackFileEffects(events) {
  const confirmed = [];
  const unresolved = [];
  const failed = [];
  const KNOWN_TOOLS = new Set([...TOOL_ORDER, ...FILE_MUTATION_TOOLS]);
  const intentIndices = new Map();
  const postIndices = new Map();
  events.forEach((event, index) => {
    if (!event || typeof event.event !== 'string') {
      unresolved.push({ tool: null, target: null, tool_use_id: null, reason: 'malformed-event' });
      return;
    }
    if (event.event === 'intent') {
      if (!FILE_MUTATION_TOOLS.has(event.tool)) {
        unresolved.push({ tool: event.tool || null, target: event.target || null, tool_use_id: event.tool_use_id || null, reason: 'unknown-tool' });
        return;
      }
      const id = typeof event.tool_use_id === 'string' && event.tool_use_id ? event.tool_use_id : null;
      if (!id || typeof event.target !== 'string' || !event.target) {
        unresolved.push({ tool: event.tool || null, target: event.target || null, tool_use_id: id, reason: 'missing-identity' });
        return;
      }
      if (intentIndices.has(id)) {
        unresolved.push({ tool: event.tool || null, target: event.target || null, tool_use_id: id, reason: 'duplicate-intent' });
        return;
      }
      intentIndices.set(id, index);
    } else if (event.event === 'used' || event.event === 'failed') {
      if (!event.tool || !KNOWN_TOOLS.has(event.tool)) {
        unresolved.push({ tool: event.tool || null, target: event.target || null, tool_use_id: event.tool_use_id || null, reason: 'unknown-tool' });
        return;
      }
      if (!FILE_MUTATION_TOOLS.has(event.tool)) return;
      const id = typeof event.tool_use_id === 'string' && event.tool_use_id ? event.tool_use_id : null;
      if (!id) {
        unresolved.push({ tool: event.tool || null, target: event.target || null, tool_use_id: null, reason: 'missing-identity' });
        return;
      }
      if (postIndices.has(id)) {
        unresolved.push({ tool: event.tool || null, target: event.target || null, tool_use_id: id, reason: 'duplicate-post' });
        return;
      }
      postIndices.set(id, index);
    } else if (!['launch', 'exit', 'denied', 'session-end'].includes(event.event)) {
      unresolved.push({ tool: event.tool || null, target: event.target || null, tool_use_id: event.tool_use_id || null, reason: 'unknown-event' });
    }
  });
  const intents = [];
  const postsById = new Map();
  events.forEach((event) => {
    if (event.event === 'intent' && FILE_MUTATION_TOOLS.has(event.tool)
      && typeof event.tool_use_id === 'string' && event.tool_use_id
      && typeof event.target === 'string' && event.target
      && !intents.some((item) => item.tool_use_id === event.tool_use_id)) {
      intents.push(event);
    }
    if ((event.event === 'used' || event.event === 'failed') && FILE_MUTATION_TOOLS.has(event.tool)
      && typeof event.tool_use_id === 'string' && event.tool_use_id
      && !Array.from(postsById.values()).flat().includes(event)) {
      if (!postsById.has(event.tool_use_id)) postsById.set(event.tool_use_id, []);
      postsById.get(event.tool_use_id).push(event);
    }
  });
  const consumed = new Set();
  for (const intent of intents) {
    const id = intent.tool_use_id;
    const post = ((postsById.get(id) || []).filter((candidate) => !consumed.has(candidate)))[0] || null;
    if (!post) {
      if (!unresolved.some((item) => item.tool_use_id === id)) {
        unresolved.push({ tool: intent.tool || null, target: intent.target || null, tool_use_id: id, reason: 'missing-post' });
      }
      continue;
    }
    consumed.add(post);
    const intentIndex = events.indexOf(intent);
    const postIndex = events.indexOf(post);
    if (postIndex < intentIndex) {
      unresolved.push({ tool: intent.tool || null, target: intent.target || null, tool_use_id: id, reason: 'out-of-order' });
      continue;
    }
    if (post.tool !== intent.tool || post.target !== intent.target) {
      unresolved.push({ tool: intent.tool || null, target: intent.target || null, tool_use_id: id, reason: 'confirmation-mismatch' });
      continue;
    }
    if (post.event === 'failed') {
      failed.push({ tool: intent.tool || null, target: intent.target || null, tool_use_id: id });
      continue;
    }
    if (typeof post.fileSha256 === 'string' && /^[0-9a-f]{64}$/.test(post.fileSha256)) {
      confirmed.push({
        tool: intent.tool || null, target: intent.target || null,
        sha256: post.fileSha256, dev: post.dev, ino: post.ino, tool_use_id: id,
      });
    } else {
      unresolved.push({ tool: intent.tool || null, target: intent.target || null, tool_use_id: id, reason: 'confirmation-mismatch' });
    }
  }
  for (const [id, list] of postsById.entries()) {
    for (const post of list) {
      if (consumed.has(post)) continue;
      unresolved.push({ tool: post.tool || null, target: post.target || null, tool_use_id: id, reason: 'missing-intent' });
    }
  }
  return { confirmed, unresolved, failed };
}

function readStrictPackEvents(eventsPath) {
  const raw = fs.readFileSync(eventsPath, 'utf8');
  const events = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let parsed = null;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error('recovery journal is corrupt (unparseable event); refusing recovery rather than risk replay');
    }
    if (!parsed || typeof parsed !== 'object' || typeof parsed.event !== 'string') {
      throw new Error('recovery journal is corrupt (malformed event); refusing recovery rather than risk replay');
    }
    events.push(parsed);
  }
  return events;
}

function assertJournalTarget(target, root) {
  if (typeof target !== 'string' || !target || target.startsWith('/') || target.split('/').includes('..')) {
    throw new Error('recovery journal is corrupt (unsafe file target); refusing recovery rather than risk replay');
  }
  if (!insideRoot(path.resolve(root, target), root)) {
    throw new Error('recovery journal records a path outside the pack root; refusing recovery');
  }
  return path.resolve(root, target);
}

function realPathOutsideCheck(candidatePath, rootReal) {
  let real = null;
  try {
    real = fs.realpathSync(candidatePath);
  } catch {
    try {
      real = realBoundaryPath(path.resolve(candidatePath));
    } catch {
      throw new Error('recovery path could not be resolved safely outside the pack root; refusing recovery');
    }
  }
  if (insideRoot(real, rootReal) || real === rootReal) {
    throw new Error('recovery receipt, journal, claim, or child receipt directory must live outside the pack root; refusing recovery');
  }
  return real;
}

function assertRecoveryPlacementOutsideRoot({ rootReal, parentReceiptPath, eventsPath, claimPath, childReceiptDir }) {
  for (const candidate of [parentReceiptPath, eventsPath, claimPath].filter(Boolean)) {
    realPathOutsideCheck(candidate, rootReal);
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile() && stat.nlink > 1) {
        throw new Error('recovery receipt, journal, or claim has multiple hard links; manual review needed before recovery');
      }
    } catch (error) {
      if (error && error.message && error.message.includes('multiple hard links')) throw error;
    }
  }
  if (childReceiptDir) {
    let realChild = null;
    try {
      realChild = realBoundaryPath(path.resolve(childReceiptDir));
    } catch {
      throw new Error('recovery child receipt directory could not be resolved safely outside the pack root; refusing recovery');
    }
    try {
      const existing = fs.realpathSync(childReceiptDir);
      realChild = existing;
    } catch {
      // Use boundary-resolved path above for not-yet-created directories.
    }
    if (insideRoot(realChild, rootReal) || realChild === rootReal) {
      throw new Error('recovery child receipt directory must live outside the pack root; refusing recovery');
    }
  }
}

// Strict launch recovery shape. A recovered launch must carry a valid parent
// identity and an array of well-formed protected identities; absent or
// malformed recovered state refuses instead of silently becoming an empty
// protection set. The summary's recorded recovery identity must agree with
// the journal rather than letting a stale summary pass as fresh.
function requireInheritedProtection(launch, summary) {
  const recovery = launch.recovery;
  if (recovery !== undefined && recovery !== null && typeof recovery !== 'object') {
    throw new Error('recovery journal is corrupt (malformed recovery metadata); refusing recovery rather than risk replay');
  }
  const mode = recovery && typeof recovery === 'object' ? recovery.mode : undefined;
  if (mode !== undefined && mode !== 'fresh' && mode !== 'recovered') {
    throw new Error('recovery journal is corrupt (unknown recovery mode); refusing recovery rather than risk replay');
  }
  let launchFiles = [];
  if (mode === 'recovered') {
    if (typeof recovery.parentRunId !== 'string' || !recovery.parentRunId
      || typeof recovery.parentReceipt !== 'string' || !recovery.parentReceipt) {
      throw new Error('recovery journal is corrupt (malformed recovered parent identity); refusing recovery rather than risk replay');
    }
    if (!Array.isArray(recovery.protectedFiles)) {
      throw new Error('recovery journal is corrupt (malformed recovered protection); refusing recovery rather than risk replay');
    }
    for (const entry of recovery.protectedFiles) {
      if (!entry || typeof entry.target !== 'string' || typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
        throw new Error('recovery journal is corrupt (malformed protected entry); refusing recovery rather than risk replay');
      }
    }
    launchFiles = recovery.protectedFiles;
  } else if (recovery && recovery.protectedFiles !== undefined
    && (!Array.isArray(recovery.protectedFiles) || recovery.protectedFiles.length !== 0)) {
    throw new Error('recovery journal is corrupt (malformed fresh protection); refusing recovery rather than risk replay');
  }
  if (!summary) return launchFiles;
  const summaryRecovery = summary.recovery;
  if (!summaryRecovery || typeof summaryRecovery !== 'object') {
    throw new Error('recovery summary is missing stable recovery metadata; refusing recovery rather than risk replay');
  }
  if (mode === 'recovered') {
    if (summaryRecovery.mode !== undefined && summaryRecovery.mode !== 'recovered') {
      throw new Error('recovery summary conflicts with its journal recovery identity; refusing recovery rather than risk replay');
    }
    if ((summaryRecovery.parentRunId || null) !== recovery.parentRunId
      || (summaryRecovery.parentReceipt || null) !== recovery.parentReceipt) {
      throw new Error('recovery summary conflicts with its journal recovery identity; refusing recovery rather than risk replay');
    }
  } else if (summaryRecovery.mode === 'recovered') {
    throw new Error('recovery summary conflicts with its journal recovery identity; refusing recovery rather than risk replay');
  }
  return launchFiles;
}

// Strict tool ceiling. The journal's granted tools must exactly equal the
// canonical tools implied by its validated capabilities: no extras, unknown
// names, duplicates, or reorderings. Stable summary evidence must agree.
function requireExactToolCeiling(launch, summary) {
  const granted = launch.grantedCapabilities;
  if (!Array.isArray(granted)) {
    throw new Error('recovery journal is corrupt (missing granted capabilities)');
  }
  const seenCaps = new Set();
  for (const cap of granted) {
    if (typeof cap !== 'string' || !CAPABILITY_DEFINITIONS[cap]) {
      throw new Error('recovery journal is corrupt (unknown granted capability); refusing recovery rather than risk replay');
    }
    if (seenCaps.has(cap)) {
      throw new Error('recovery journal is corrupt (duplicate granted capability); refusing recovery rather than risk replay');
    }
    seenCaps.add(cap);
  }
  if (!Array.isArray(launch.requestedCapabilities)) {
    throw new Error('recovery journal is corrupt (missing tool ceiling); refusing recovery rather than risk replay');
  }
  const seenRequested = new Set();
  for (const cap of launch.requestedCapabilities) {
    if (typeof cap !== 'string' || !CAPABILITY_DEFINITIONS[cap]) {
      throw new Error('recovery journal is corrupt (unknown requested capability); refusing recovery rather than risk replay');
    }
    if (seenRequested.has(cap)) {
      throw new Error('recovery journal is corrupt (duplicate requested capability); refusing recovery rather than risk replay');
    }
    seenRequested.add(cap);
    if (!seenCaps.has(cap)) {
      throw new Error('recovery journal is corrupt (requested capability outside granted set); refusing recovery rather than risk replay');
    }
  }
  const expectedTools = toolsForCapabilities(granted);
  if (!Array.isArray(launch.grantedTools) || launch.grantedTools.length !== expectedTools.length
    || launch.grantedTools.some((tool, index) => tool !== expectedTools[index])) {
    throw new Error('recovery journal is corrupt (tool ceiling does not match granted capabilities); refusing recovery rather than risk replay');
  }
  if (!summary || typeof summary !== 'object') {
    throw new Error('recovery receipt is corrupt (unrecognized pack run receipt)');
  }
  if (!Array.isArray(summary.grantedCapabilities)
    || [...summary.grantedCapabilities].sort().join(',') !== [...granted].sort().join(',')) {
    throw new Error('recovery summary conflicts with its journal capabilities; refusing recovery rather than risk replay');
  }
  if (!Array.isArray(summary.grantedTools)
    || summary.grantedTools.length !== expectedTools.length
    || summary.grantedTools.some((tool, index) => tool !== expectedTools[index])) {
    throw new Error('recovery summary conflicts with its journal tool ceiling; refusing recovery rather than risk replay');
  }
  if (!Array.isArray(summary.requestedCapabilities)
    || summary.requestedCapabilities.length !== launch.requestedCapabilities.length
    || summary.requestedCapabilities.some((cap, index) => cap !== launch.requestedCapabilities[index])) {
    throw new Error('recovery summary conflicts with its journal capability request; refusing recovery rather than risk replay');
  }
  return granted;
}

// Read-only assessment of a parent receipt. Throws a plain error for every
// refusal; returns the inherited protection set when recovery may proceed.
// The companion event log is authoritative: exit, caps, pack identity,
// input, inherited protection, and journal version all derive from launch
// and exit events. The summary snapshot must agree; a stale summary never
// grants authority.
function assessPackRecoveryJournal(options = {}) {
  const packDir = options.packDir;
  const manifest = options.manifest || {};
  const policy = options.policy || {};
  const parentReceiptPath = path.resolve(String(options.parentReceiptPath || ''));
  const operatorInput = options.operatorInput || null;
  const childReceiptDir = options.childReceiptDir ? path.resolve(String(options.childReceiptDir)) : null;

  let summary = null;
  try {
    summary = JSON.parse(fs.readFileSync(parentReceiptPath, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') throw new Error(`recovery receipt not found: ${parentReceiptPath}`);
    throw new Error(`recovery receipt is corrupt or unreadable: ${error.message}`);
  }
  if (!summary || typeof summary !== 'object' || summary.schema !== 'atris.pack-run.v1' || typeof summary.runId !== 'string') {
    throw new Error('recovery receipt is corrupt (unrecognized pack run receipt)');
  }
  if (typeof summary.events !== 'string' || !summary.events || summary.events.includes('/') || summary.events.includes('\\')) {
    throw new Error('recovery journal binding is corrupt (events name); refusing recovery rather than risk replay');
  }
  const root = fs.realpathSync(packDir);
  const eventsPath = path.join(path.dirname(parentReceiptPath), path.basename(summary.events));
  const claimPath = packRecoveryClaimPath(parentReceiptPath);
  assertRecoveryPlacementOutsideRoot({ rootReal: root, parentReceiptPath, eventsPath, claimPath, childReceiptDir });
  let events = null;
  try {
    events = readStrictPackEvents(eventsPath);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new Error('recovery journal is missing alongside the receipt; refusing recovery rather than risk replay');
    }
    throw error;
  }
  if (!events.length) throw new Error('recovery journal is corrupt (empty history); refusing recovery rather than risk replay');
  const launches = events.filter((event) => event.event === 'launch');
  if (launches.length !== 1 || events[0].event !== 'launch') {
    throw new Error('recovery journal is corrupt (launch must be first and only); refusing recovery rather than risk replay');
  }
  const launch = launches[0];
  if (!launch.journal || launch.journal.supported !== true || launch.journal.version !== PACK_JOURNAL_VERSION) {
    throw new Error('recovery needs a journaled run; this receipt predates file-effect journaling, so inspect the prior run with manual review');
  }
  if (summary.journal && (summary.journal.supported !== launch.journal.supported || summary.journal.version !== launch.journal.version)) {
    throw new Error('recovery journal conflicts with its receipt summary; refusing recovery rather than risk replay');
  }
  if (launch.runId !== summary.runId) {
    throw new Error('recovery journal is corrupt (launch mismatch); refusing recovery rather than risk replay');
  }
  const exits = events.filter((event) => event.event === 'exit');
  if (exits.length === 0) {
    throw new Error('parent run has no recorded runner exit; recovery needs a nonzero runner exit, so inspect the prior run with manual review');
  }
  if (exits.length !== 1 || events[events.length - 1].event !== 'exit') {
    throw new Error('recovery journal is corrupt (terminal exit must be last and only); refusing recovery rather than risk replay');
  }
  const journalExit = exits[0];
  if (typeof journalExit.status !== 'number' && !journalExit.signal) {
    throw new Error('parent run has no recorded runner exit status; refusing recovery rather than risk replay');
  }
  if (journalExit.status === 0 && !journalExit.signal) {
    throw new Error('parent run succeeded (exit 0); nothing to recover');
  }
  if (summary.status !== 'finished' || summary.exitStatus !== journalExit.status
    || (summary.signal || null) !== (journalExit.signal || null)) {
    throw new Error('recovery summary conflicts with its journal exit; refusing recovery rather than risk replay');
  }
  const expectedEvents = `${path.basename(parentReceiptPath, '.json')}.events.jsonl`;
  if (path.basename(summary.events) !== expectedEvents) {
    throw new Error('recovery journal binding does not match this receipt; refusing recovery rather than risk replay');
  }
  const journalGranted = requireExactToolCeiling(launch, summary);
  for (const event of events) {
    if (!['intent', 'used', 'failed'].includes(event.event)) continue;
    if (!launch.grantedTools.includes(event.tool)
      || (event.capability !== undefined && event.capability !== toolCapability(event.tool, journalGranted))) {
      throw new Error('recovery journal has a tool ceiling mismatch (corrupt history); refusing recovery rather than risk replay');
    }
  }
  if (journalGranted.includes('host.shell')) {
    throw new Error('parent run granted host.shell; shell effects cannot be reasoned about, so inspect the prior run with manual review');
  }
  if (!policy || policy.status !== 'enforced') {
    throw new Error('pack run --recover needs a declared capability ceiling; legacy packs cannot be recovered');
  }
  if (policy.grantedCapabilities.includes('host.shell')) {
    throw new Error('pack run --recover cannot grant host.shell; shell effects cannot be reasoned about');
  }
  if ([...journalGranted].sort().join(',') !== [...policy.grantedCapabilities].sort().join(',')) {
    throw new Error(`capabilities changed since the parent run (was: ${journalGranted.join(', ') || 'none'}); recovery needs the same granted set`);
  }
  let launchRoot = null;
  try {
    launchRoot = launch.pack && launch.pack.root ? fs.realpathSync(launch.pack.root) : null;
  } catch {
    launchRoot = null;
  }
  if (!launch.pack || typeof launch.pack.slug !== 'string' || typeof launch.pack.version !== 'string' || launchRoot !== root) {
    throw new Error('recovery journal belongs to a different pack, folder, or version; refusing to mix histories');
  }
  if (summary.pack && (summary.pack.slug !== launch.pack.slug || summary.pack.version !== launch.pack.version)) {
    throw new Error('recovery summary conflicts with its journal pack identity; refusing recovery rather than risk replay');
  }
  try {
    const summaryRoot = summary.pack && summary.pack.root ? fs.realpathSync(summary.pack.root) : null;
    if (summaryRoot && summaryRoot !== launchRoot) {
      throw new Error('recovery summary conflicts with its journal pack identity; refusing recovery rather than risk replay');
    }
  } catch {
    throw new Error('recovery summary conflicts with its journal pack identity; refusing recovery rather than risk replay');
  }
  if (!launch.pack || launch.pack.slug !== manifest.slug || launch.pack.version !== manifest.version) {
    throw new Error('recovery receipt belongs to a different pack, folder, or version; refusing to mix histories');
  }
  const journalInput = launch.operatorInput ? { bytes: launch.operatorInput.bytes, sha256: launch.operatorInput.sha256 } : null;
  const summaryInput = summary.operatorInput ? { bytes: summary.operatorInput.bytes, sha256: summary.operatorInput.sha256 } : null;
  if (JSON.stringify(summaryInput) !== JSON.stringify(journalInput)) {
    throw new Error('recovery summary conflicts with its journal input; refusing recovery rather than risk replay');
  }
  const currentInput = operatorInput ? { bytes: operatorInput.bytes, sha256: operatorInput.sha256 } : null;
  if (JSON.stringify(journalInput) !== JSON.stringify(currentInput)) {
    throw new Error('operator input differs from the parent run; recovery needs the same input');
  }
  const inherited = requireInheritedProtection(launch, summary);
  for (const entry of inherited) {
    assertJournalTarget(entry.target, root);
  }
  const effects = pairPackFileEffects(events);
  for (const item of [...effects.confirmed, ...effects.unresolved, ...effects.failed]) {
    if (item.target !== null && item.target !== undefined) assertJournalTarget(item.target, root);
  }
  // No missing identity may pass recovery, and any intent without its
  // confirmation (the crash window, or an interactive denial) refuses.
  // Inspect the prior run; a fresh rerun would risk replaying unknown effects.
  if (effects.unresolved.length) {
    const first = effects.unresolved[0];
    throw new Error(`journal has ${effects.unresolved.length} unresolved file effect(s) (first: ${first.tool || '?'} ${first.target || '?'}: ${first.reason}); inspect the prior run with manual review`);
  }
  const lastConfirmed = new Map();
  for (const entry of effects.confirmed) lastConfirmed.set(entry.target, entry);
  const inheritedByTarget = new Map();
  for (const entry of inherited) inheritedByTarget.set(entry.target, entry);
  const protectedFiles = mergeProtectedFiles(inherited, [...lastConfirmed.values()]);
  // Recompute both views from the journal, never use one summary field to
  // justify another. Lost completed or pending events must not become a
  // shorter, apparently safe history beside an unchanged receipt.
  if (!isDeepStrictEqual(summary.fileEffects, effects)) {
    throw new Error('recovery summary file effects conflict with its journal (corrupt history); refusing recovery rather than risk replay');
  }
  if (!isDeepStrictEqual(summary.recovery.protectedFiles, protectedFiles)) {
    throw new Error('recovery summary protection conflicts with its journal protection; refusing recovery rather than risk replay');
  }
  for (const entry of protectedFiles) {
    const abs = path.resolve(root, entry.target);
    let stat = null;
    try {
      stat = fs.statSync(abs);
    } catch {
      throw new Error(`completed file ${entry.target} is missing or changed since the parent run; refusing recovery`);
    }
    if (!stat.isFile()) throw new Error(`completed file ${entry.target} is missing or changed since the parent run; refusing recovery`);
    if (stat.nlink > 1) throw new Error(`completed file ${entry.target} has multiple hard links; manual review needed before recovery`);
    if (sha256Hex(fs.readFileSync(abs)) !== entry.sha256) {
      throw new Error(`completed file ${entry.target} changed since the parent run; refusing recovery`);
    }
    if (stat.dev !== entry.dev || stat.ino !== entry.ino) {
      throw new Error(`completed file ${entry.target} was replaced or aliased since the parent run; refusing recovery`);
    }
  }
  // A failed tool only counts as resolved when the bytes still match the last
  // confirmation for that target (including inherited confirmations), or the
  // never-confirmed target stayed absent.
  for (const item of effects.failed) {
    const abs = path.resolve(root, item.target);
    const last = lastConfirmed.get(item.target) || inheritedByTarget.get(item.target);
    if (last) {
      let current = null;
      try {
        current = sha256Hex(fs.readFileSync(abs));
      } catch {
        throw new Error(`file ${item.target} for a failed action is unreadable; refusing recovery`);
      }
      if (current !== last.sha256) {
        throw new Error(`failed action left ${item.target} different from its last confirmed state; refusing recovery`);
      }
    } else if (fs.existsSync(abs)) {
      throw new Error(`failed action may have changed ${item.target}; refusing recovery rather than risk replay`);
    }
  }
  return { parentRunId: launch.runId, parentSummary: summary, protectedFiles };
}

// A parent receipt backs at most one child. The claim lives next to the
// parent receipt, outside the pack root. Exclusive creation makes the single
// child atomic; a claim with no child means the launcher crashed mid-claim
// and needs manual review, never an automatic replay.
function packRecoveryClaimPath(parentReceiptPath) {
  const dir = path.dirname(path.resolve(parentReceiptPath));
  return path.join(dir, `${path.basename(parentReceiptPath, '.json')}.claim.json`);
}

function claimPackRecoveryParent(parentReceiptPath, parentRunId) {
  const claimPath = packRecoveryClaimPath(parentReceiptPath);
  const claim = {
    version: 1,
    parentReceipt: path.resolve(parentReceiptPath),
    parentRunId,
    claimedAt: new Date().toISOString(),
    childReceipt: null,
  };
  let descriptor = null;
  try {
    descriptor = fs.openSync(claimPath, 'wx', 0o600);
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      let existing = null;
      try {
        existing = JSON.parse(fs.readFileSync(claimPath, 'utf8'));
      } catch {
        existing = null;
      }
      if (!existing || typeof existing !== 'object') {
        throw new Error(`a recovery claim for this receipt is unreadable; manual review needed at ${claimPath}`);
      }
      if (existing.childReceipt) {
        throw new Error(`this receipt already recovered as ${existing.childReceipt}; recover from that child instead`);
      }
      throw new Error(`a recovery claim is already in progress for this receipt; manual review needed at ${claimPath}`);
    }
    throw error;
  }
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(claim, null, 2)}\n`);
  } finally {
    fs.closeSync(descriptor);
  }
  return claimPath;
}

function confirmPackRecoveryClaim(claimPath, childReceiptPath) {
  const claim = JSON.parse(fs.readFileSync(claimPath, 'utf8'));
  claim.childReceipt = path.resolve(childReceiptPath);
  fs.writeFileSync(claimPath, `${JSON.stringify(claim, null, 2)}\n`);
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
    journal: { version: PACK_JOURNAL_VERSION, supported: true },
    recovery: sanitizeLaunchRecovery(options.recovery),
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
    // Denied mutations return above, so they never leave a pending intent.
    const protection = checkProtectedMutation(env, input);
    if (protection && protection.denied) {
      return denyPreToolUse(env, input, protection.reason, now);
    }
    journalFileIntent(env, input);
    return null;
  }

  if (mode === 'used' || mode === 'failed') {
    const entry = {
      event: mode,
      at: now,
      tool: input.tool_name || null,
      capability: toolCapability(input.tool_name, env.grantedCapabilities),
    };
    if (FILE_MUTATION_TOOLS.has(input.tool_name)) {
      entry.tool_use_id = hookToolUseId(input);
      try {
        entry.target = journalRelativeTarget(input.tool_name, input.tool_input || {}, env.root);
        if (entry.target) {
          const identity = readFileIdentity(path.resolve(fs.realpathSync(env.root), entry.target));
          entry.targetPresent = identity.present;
          if (identity.present && identity.isFile) {
            entry.fileSha256 = identity.sha256;
            entry.dev = identity.dev;
            entry.ino = identity.ino;
            entry.nlink = identity.nlink;
          }
        }
      } catch {
        // A confirmation that cannot read its file stays deliberately thin;
        // pairing treats it as unresolved rather than confirmed.
      }
    }
    appendReceiptEvent(env.eventsPath, entry);
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
  const protection = checkProtectedMutation(env, input);
  if (protection && protection.denied) return denyPreToolUse(env, input, protection.reason, now);
  journalFileIntent(env, input);
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
  assessPackRecoveryJournal,
  packRecoveryClaimPath,
  claimPackRecoveryParent,
  confirmPackRecoveryClaim,
};
