'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { spawn, spawnSync } = require('child_process');
const {
  appendBriefRecord,
  stampBriefOutcome,
  worktreeBaseRef,
} = require('../lib/brief-ledger');
const {
  resolveClaudeRunnerModel,
  resolveClaudeRunnerBin,
  resolveClaudeRunnerCommandTemplate,
  buildRunnerCommand,
  RUNNER_PROFILE_DEFS,
  RUNNER_PROFILE_ALIASES,
  RUNNER_PROFILE_NAMES,
} = require('../lib/runner-command');
const {
  resolveEngineForRoleWithPreference,
  setEngineHealth,
} = require('../lib/engine-registry');
const {
  FUNCTIONAL_MEMBER_TOPICS,
  listWorkspaceMemberSlugs,
  normalizeOwnerSlug,
  resolveFunctionalOwner,
} = require('../lib/functional-owner');
const {
  buildMissionRoom,
  writeMissionRoomReceipt,
  missionRoomLines,
} = require('../lib/mission-room');
const {
  missionArtifactPaths,
  writeMissionArtifact,
} = require('../lib/mission-artifact');
const {
  renderCard,
  renderPageSection,
  renderEmailLine,
  renderMorningCardRow,
} = require('../lib/receipt-block');
const {
  pruneRuns,
  runsPruneLines,
  formatBytes,
} = require('../lib/runs-prune');
const autolandLib = require('../lib/autoland');
const { operatorReady, hasAgentJargon } = require('./autoland');
const {
  MISSION_INSPECT_FIELDS,
  readFieldsFlag,
  stripInspectArgs,
  validateFields,
  missionInspectFieldValues,
  inspectTextLines,
  buildInspectPayload,
} = require('../lib/inspect-fields');
const {
  displayNumber,
  nextRecordNumber,
  recordMatchesRef,
  shortRecordLabel,
  shortRecordRef,
} = require('../lib/short-name');
const {
  runCloudMissionCommand,
  statusCloudMissionCommand,
} = require('../lib/cloud-mission');

const VALID_STATUSES = new Set(['planning', 'running', 'ready', 'paused', 'blocked', 'stopped', 'complete']);
const TERMINAL_STATUSES = new Set(['stopped', 'complete']);
const GOAL_LOOP_STATUSES = new Set(['planning', 'running', 'ready']);
const STATUS_ALIASES = new Set(['active']);
const CODEX_NATIVE_GOAL_SLOT_STATUSES = new Set(['active', 'paused', 'usage_limited']);
const CODEX_NATIVE_GOAL_REPLACE_STATUSES = new Set(['active', 'paused', 'usage_limited']);
const DEFAULT_LONG_RUN_VERIFIER = 'git diff --check';
const SLEEP_LENGTH_BUDGET_SECONDS = 3600;
const HUMAN_BLOCKING_PAUSE_REASONS = new Set(['auth-required', 'model-unavailable', 'rate-limit-exceeded-wall']);
const MISSION_BUDGET_TIERS = Object.freeze({
  quick: Object.freeze({ max_ticks: 4, requested_seconds: 15 * 60 }),
  long: Object.freeze({ max_ticks: 12, requested_seconds: 60 * 60 }),
  deep: Object.freeze({ max_ticks: 30, requested_seconds: 180 * 60 }),
});

function stampIso() {
  return new Date().toISOString();
}

function todayName() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function slugify(value) {
  return String(value || 'mission')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'mission';
}

function shortHash(value) {
  return crypto.createHash('sha1').update(String(value || '')).digest('hex').slice(0, 8);
}

function missionId(objective) {
  return `mission-${todayName()}-${slugify(objective).slice(0, 28)}-${shortHash(`${objective}:${Date.now()}`)}`;
}

function hasFlag(args, name) {
  return args.includes(name);
}

function unquote(value) {
  const text = String(value);
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text;
}

function readFlag(args, name, fallback = '') {
  const prefix = `${name}=`;
  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i]);
    if (arg === name && args[i + 1] && !String(args[i + 1]).startsWith('--')) return unquote(args[i + 1]);
    if (arg.startsWith(prefix)) return unquote(arg.slice(prefix.length));
  }
  return fallback;
}

const MISSION_NATIVE_RUNNER_NAMES = Object.freeze(['manual', 'claude', 'atris2', 'codex_goal', 'caller_session', 'current_agent', 'drill']);
const MISSION_NATIVE_RUNNER_SET = new Set(MISSION_NATIVE_RUNNER_NAMES);
const MISSION_AUTO_RUNNER = 'auto';

function canonicalEngineName(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return '';
  if (RUNNER_PROFILE_DEFS[trimmed]) return trimmed;
  if (RUNNER_PROFILE_ALIASES[trimmed]) return RUNNER_PROFILE_ALIASES[trimmed];
  return '';
}

function knownMissionRunnerText() {
  return `Known runners: ${[...MISSION_NATIVE_RUNNER_NAMES, MISSION_AUTO_RUNNER].join(', ')}. Known engines: ${RUNNER_PROFILE_NAMES.join(', ')}`;
}

function resolveMissionRunnerSelection(value, options = {}) {
  const raw = String(value || '').trim();
  const asJson = options.asJson === true;
  const engineOnly = options.engineOnly === true;
  if (!raw) {
    exitMissionError(`${options.label || 'runner'} is required. ${knownMissionRunnerText()}.`, 2, asJson);
  }
  const runner = raw.toLowerCase();
  if (runner === MISSION_AUTO_RUNNER) {
    return { requested: raw, runner, engine: null, kind: 'auto' };
  }
  if (!engineOnly && MISSION_NATIVE_RUNNER_SET.has(runner)) {
    return { requested: raw, runner, engine: null, kind: 'runner' };
  }
  const engine = canonicalEngineName(raw);
  if (engine) {
    return { requested: raw, runner: engine, engine, kind: 'engine' };
  }
  const noun = engineOnly ? 'engine' : 'runner';
  exitMissionError(`Unknown ${noun} "${raw}". ${knownMissionRunnerText()}.`, 2, asJson);
}

function resolveMissionTickRunner(mission, root = process.cwd()) {
  if (String(mission && mission.runner || '').trim().toLowerCase() !== MISSION_AUTO_RUNNER) {
    return { mission, engine_id: null, requested_engine: null, engine_fallback_reason: null };
  }
  const resolved = resolveEngineForRoleWithPreference('executor', root, mission.preferred_engine);
  return {
    mission: resolved.engine ? { ...mission, runner: resolved.engine.id, runner_kind: 'engine' } : mission,
    engine_id: resolved.engine ? resolved.engine.id : null,
    requested_engine: resolved.requested_engine,
    engine_fallback_reason: resolved.engine_fallback_reason,
  };
}

function engineFailureHealthStatus(result) {
  if (!result || result.status !== 'errored') return null;
  const signalText = [
    result.reason,
    result.model_unavailable,
    result.claude && result.claude.summary,
    result.claude && result.claude.receipt_text,
    result.claude && result.claude.stderr,
    result.rate_limit_info && JSON.stringify(result.rate_limit_info),
  ].filter(Boolean).join('\n').toLowerCase();
  if (/usage[ _-]?limit|purchase more credits|insufficient credits|credit(?:s)?[ _-]?(?:out|limit)|rate[ _-]?limit/.test(signalText)) {
    return 'credit_out';
  }
  if (/timeout|model-unavailable/.test(signalText)) return 'not_installed';
  // Any other errored tick (claude-error, no-ready-engine's sibling failures,
  // etc.) is still a real failure signal for the engine that ran it. Falling
  // through to null here left the registry showing "ready" for an engine
  // that had just hard-failed (e.g. a 401), so auto routing kept sending
  // ticks back to it. Mark it "error" instead of silently doing nothing.
  return 'error';
}

function recordMissionEngineTickOutcome(engineId, result, root = process.cwd()) {
  if (!engineId) return null;
  const status = result && result.status === 'ran' ? 'ready' : engineFailureHealthStatus(result);
  return status ? setEngineHealth(engineId, status, root) : null;
}

function runnerModelPatch(runner, model) {
  const explicitModel = String(model || '').trim();
  if (explicitModel) return { model: explicitModel };
  if (String(runner || '').trim().toLowerCase() === 'atris2') return { model: 'atris:fast' };
  return {};
}

function missionRunRuntimeView(mission, runnerOverride = null, modelOverride = '') {
  if (!runnerOverride) return mission;
  const next = {
    ...mission,
    runner: runnerOverride.runner,
    runner_kind: runnerOverride.kind,
    run_runner_override: {
      requested: runnerOverride.requested,
      runner: runnerOverride.runner,
      stored_runner: mission.runner || null,
      stored_model: mission.model || null,
    },
  };
  delete next.model;
  Object.assign(next, runnerModelPatch(runnerOverride.runner, modelOverride));
  if (next.model) next.run_runner_override.model = next.model;
  return next;
}

function applyMissionRunnerProfile(runner) {
  const runnerName = String(runner || '').trim().toLowerCase();
  // `manual` is the legacy name for a directly-run Claude mission. Do not let
  // the host process's runner profile silently turn it into another engine.
  const engine = canonicalEngineName(runnerName) || (runnerName === 'manual' ? 'claude' : '');
  if (!engine) return () => {};
  const previous = process.env.ATRIS_RUNNER_PROFILE;
  process.env.ATRIS_RUNNER_PROFILE = engine;
  return () => {
    if (previous === undefined) delete process.env.ATRIS_RUNNER_PROFILE;
    else process.env.ATRIS_RUNNER_PROFILE = previous;
  };
}

function exitMissionError(message, code = 1, asJson = false) {
  if (asJson) console.log(JSON.stringify({ ok: false, error: message }, null, 2));
  else console.error(message);
  process.exit(code);
}

// Write-time warnings judge only what a machine can truly judge: identifiers,
// flags, and task ids. Whether a why is present is a judgment call — the tick
// prompt demands it, the review pass judges it. A warning that cries wolf on
// plain sentences teaches agents to ignore it (golden-path papercut). The
// strict operatorReady bar stays at the digest surface, where under-showing
// is cheap. Boundary pinned by the marker-free fixture in mission-status tests.
function warnIfSummaryNeedsOperatorWhy(summary) {
  const text = String(summary || '').trim();
  if (!text || !hasAgentJargon(text)) return null;
  const warning = 'Warning: this tick summary contains flags, ids, or code identifiers. Rewrite it in words the operator can use; identifiers belong in the receipt body.';
  console.error(warning);
  return warning;
}

function warnIfTaskTitleNeedsOperatorWhy(title) {
  const text = String(title || '').trim();
  if (!text || !hasAgentJargon(text)) return null;
  const warning = 'Warning: this task title contains flags, ids, or code identifiers. Rewrite it in words the operator can use; identifiers belong in the task body.';
  console.error(warning);
  return warning;
}

function readPositiveIntegerFlag(args, name, fallback = null, options = {}) {
  const raw = readFlag(args, name, '');
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    exitMissionError(`${name} must be a positive integer`, 2, options.json);
  }
  return value;
}

function readNonNegativeIntegerFlag(args, name, fallback = null) {
  const raw = readFlag(args, name, '');
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return value;
}

function readRepeatedFlag(args, name) {
  const values = [];
  const prefix = `${name}=`;
  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i]);
    if (arg === name && args[i + 1] && !String(args[i + 1]).startsWith('--')) {
      values.push(unquote(args[i + 1]));
      i += 1;
      continue;
    }
    if (arg.startsWith(prefix)) values.push(unquote(arg.slice(prefix.length)));
  }
  return values.filter(Boolean);
}

function codexNativeGoalOptionsFromArgs(args) {
  const nativeGoalStatus = readFlag(args, '--native-goal-status', readFlag(args, '--visible-goal-status', ''));
  const nativeGoalObjective = readFlag(args, '--native-goal-objective', readFlag(args, '--visible-goal-objective', ''));
  return {
    ...(nativeGoalStatus ? { nativeGoalStatus } : {}),
    ...(nativeGoalObjective ? { nativeGoalObjective } : {}),
    ...(hasFlag(args, '--manual-ack') ? { manualAck: true } : {}),
    ...(hasFlag(args, '--allow-native-goal-supersede') || hasFlag(args, '--supersede-paused-native-goal') ? { allowNativeGoalSupersede: true } : {}),
  };
}

function lintMissionVerifier(command) {
  const text = String(command || '').trim();
  if (!text) return null;
  const compact = text.replace(/\s+/g, ' ');
  const staticNumericTest = /^test \d+ -(?:eq|ne|gt|ge|lt|le) \d+$/.test(compact)
    || /^\[ \d+ -(?:eq|ne|gt|ge|lt|le) \d+ \]$/.test(compact);
  if (!staticNumericTest) return null;
  return 'looks like shell substitution expanded before Atris received it; quote dynamic verifiers with single quotes';
}

function assertMissionVerifier(command, asJson = false) {
  const issue = lintMissionVerifier(command);
  if (!issue) return;
  exitMissionError(`Invalid --verify: ${issue}. Example: --verify 'test $(wc -l < atris/learnings.jsonl) -ge 478'`, 2, asJson);
}

function stripKnownFlags(args, valueNames, booleanNames = []) {
  const valueSet = new Set(valueNames);
  const booleanSet = new Set(booleanNames);
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i]);
    const key = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
    if (booleanSet.has(key)) continue;
    if (valueSet.has(key)) {
      if (!arg.includes('=') && args[i + 1] && !String(args[i + 1]).startsWith('--')) i += 1;
      continue;
    }
    out.push(args[i]);
  }
  return out;
}

function wantsJson(args) {
  return hasFlag(args, '--json');
}

function printJsonOrText(payload, lines, asJson) {
  if (asJson) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  for (const line of lines) console.log(line);
}

const MISSION_RUN_VALUE_FLAGS = [
  '--slots',
  '--max-ticks',
  '--max-idle-ticks',
  '--max-wall',
  '--minutes',
  '--hours',
  '--cadence',
  '--owner',
  '--runner',
  '--lane',
  '--verify',
  '--stop',
  '--model',
  '--engine',
  '--budget',
  '--repo',
  '--native-goal-status',
  '--native-goal-objective',
  '--visible-goal-status',
  '--visible-goal-objective',
];
const MISSION_RUN_BOOLEAN_FLAGS = [
  '--json',
  '--due',
  '--headless',
  '--fleet',
  '--dry-run',
  '--land',
  '--no-claude',
  '--no-verify',
  '--complete-on-pass',
  '--no-drain',
  '--create-next',
  '--spend-full-budget',
  '--use-whole-budget',
  '--stop-when-done',
  '--preflight',
  '--no-preflight',
  '--room-preflight',
  '--no-room-preflight',
  '--room-auto-run',
  '--no-room-auto-run',
  '--manual-ack',
  '--allow-native-goal-supersede',
  '--supersede-paused-native-goal',
  '--take-goal-slot',
  '--always-on',
  '--xp-task',
  '--agent-xp',
  '--cloud',
];
const DEFAULT_MISSION_RUN_OWNER_SLUGS = new Set(
  FUNCTIONAL_MEMBER_TOPICS.map(topic => normalizeOwnerSlug(topic.owner)),
);

function missionRunInputRequired(asJson = false, owner = '') {
  const defaultOwner = normalizeOwnerSlug(owner || process.env.ATRIS_AGENT_ID || 'mission-lead') || 'mission-lead';
  const error = 'mission run needs an interactive terminal; use atris mission run --due --headless or atris mission run <explicit-mission-id>.';
  const payload = {
    ok: false,
    action: 'mission_input_required',
    error,
    prompt: 'What mission should Atris run?',
    owner: defaultOwner,
    owner_prompt: 'Which team member should own it?',
    example: `atris mission run "make onboarding magical" --owner ${defaultOwner}`,
  };
  if (asJson) {
    console.log(JSON.stringify(payload));
  } else {
    console.error(error);
  }
  process.exit(1);
}

function askLine(rl, question) {
  return new Promise((resolve) => rl.question(question, (answer) => resolve(String(answer || '').trim())));
}

function removeValueFlag(args, name) {
  const out = [];
  const prefix = `${name}=`;
  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i]);
    if (arg === name) {
      if (args[i + 1] && !String(args[i + 1]).startsWith('--')) i += 1;
      continue;
    }
    if (arg.startsWith(prefix)) continue;
    out.push(args[i]);
  }
  return out;
}

function missionRunOwnerRef(ref, root = process.cwd()) {
  const owner = normalizeOwnerSlug(ref);
  if (!owner || /\s/.test(String(ref || ''))) return null;
  if (listWorkspaceMemberSlugs(root).has(owner)) return owner;
  if (DEFAULT_MISSION_RUN_OWNER_SLUGS.has(owner)) return owner;
  return null;
}

function missionRunArgsWithOwner(args, owner) {
  return [...removeValueFlag(args, '--owner'), '--owner', owner];
}

function missionRunInputFromArgs(args, root = process.cwd()) {
  const positionals = stripKnownFlags(args, MISSION_RUN_VALUE_FLAGS, MISSION_RUN_BOOLEAN_FLAGS);
  const explicitOwner = Boolean(readFlag(args, '--owner', ''));
  if (!explicitOwner && positionals.length > 0) {
    const owner = missionRunOwnerRef(positionals[0], root);
    if (owner) {
      return {
        ref: positionals.slice(1).join(' ').trim(),
        args: missionRunArgsWithOwner(args, owner),
        owner,
      };
    }
  }
  return {
    ref: positionals.join(' ').trim(),
    args,
    owner: readFlag(args, '--owner', ''),
  };
}

async function promptMissionRunInput(args) {
  if (!process.stdin.isTTY) missionRunInputRequired(wantsJson(args), readFlag(args, '--owner', ''));
  const defaultOwner = readFlag(args, '--owner', process.env.ATRIS_AGENT_ID || 'mission-lead');
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const objective = await askLine(rl, 'Mission: ');
    if (!objective) missionRunInputRequired(false);
    const owner = await askLine(rl, `Team member [${defaultOwner}]: `);
    return {
      objective,
      args: [...removeValueFlag(args, '--owner'), '--owner', owner || defaultOwner],
    };
  } finally {
    rl.close();
  }
}

function loadTaskDb(asJson = false) {
  try {
    return require('../lib/task-db');
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    if (error?.code === 'ERR_UNKNOWN_BUILTIN_MODULE' || /node:sqlite/.test(message)) {
      exitMissionError('AgentXP mission tasks require Node 22+ with node:sqlite.', 2, asJson);
    }
    throw error;
  }
}

function writeMissionTaskProjection(taskDb, db, workspaceRoot) {
  const projection = taskDb.taskProjection(db, { workspaceRoot, limit: 500 });
  const outPath = path.join(workspaceRoot, '.atris', 'state', 'tasks.projection.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(projection, null, 2) + '\n', 'utf8');
  return { projection, outPath };
}

function missionTaskRef(task) {
  return task?.display_id || task?.legacy_ref || String(task?.id || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 8);
}

function createMissionXpTask(mission, root = process.cwd(), asJson = false) {
  const taskDb = loadTaskDb(asJson);
  const db = taskDb.open();
  const workspaceRoot = taskDb.workspaceRoot(root);
  const title = `Mission XP: ${mission.objective}`;
  const operatorTitleWarning = warnIfTaskTitleNeedsOperatorWhy(title);
  const ownerResolution = resolveMissionOwner(mission, workspaceRoot);
  const owner = ownerResolution.owner;
  const metadata = {
    assigned_to: owner,
    delegate_via: 'mission_goal_loop',
    created_for_day: todayName(),
    goal_id: mission.id,
    goal_objective: mission.objective,
    mission_id: mission.id,
    mission_objective: mission.objective,
    mission_owner: owner,
    owner_resolution: ownerResolution.reason,
    mission_lane: mission.lane,
    mission_runner: mission.runner,
    verify: mission.verifier || null,
    stop_condition: mission.stop_condition || null,
  };
  if (ownerResolution.requested_owner && ownerResolution.requested_owner !== owner) metadata.requested_owner = ownerResolution.requested_owner;
  if (ownerResolution.executed_by) metadata.executed_by = normalizeOwnerSlug(ownerResolution.executed_by);
  if (ownerResolution.proposed_member) metadata.proposed_member = ownerResolution.proposed_member;
  const result = taskDb.addTask(db, {
    title,
    tag: 'agent-xp',
    workspaceRoot,
    sourceKey: `mission-xp:${mission.id}`,
    status: 'claimed',
    claimedBy: owner,
    metadata,
  });
  const rows = taskDb.withTaskDisplayRefs(taskDb.listTasks(db, { workspaceRoot }));
  const task = rows.find(row => row.id === result.id);
  if (task) {
    taskDb.noteTask(db, {
      id: task.id,
      actor: process.env.ATRIS_AGENT_ID || owner,
      content: `Mission goal loop XP bridge for ${mission.id}. Proof goes through task current-step; AgentXP is awarded only after human approval.`,
    });
  }
  const { outPath } = writeMissionTaskProjection(taskDb, db, workspaceRoot);
  return {
    task_id: result.id,
    ref: missionTaskRef(task) || result.id,
    title,
    operator_title_warning: operatorTitleWarning,
    status: task?.status || 'claimed',
    assigned_to: owner,
    owner_resolution: ownerResolution.reason,
    executed_by: ownerResolution.executed_by ? normalizeOwnerSlug(ownerResolution.executed_by) : null,
    inserted: result.inserted !== false,
    projection_path: outPath,
  };
}

function statePaths(root = process.cwd()) {
  const stateDir = path.join(root, '.atris', 'state');
  return {
    stateDir,
    missionsJsonl: path.join(stateDir, 'missions.jsonl'),
    eventsJsonl: path.join(stateDir, 'mission_events.jsonl'),
    codexGoalJson: path.join(stateDir, 'codex_goal.json'),
    codexGoalRequestJson: path.join(stateDir, 'codex_goal_request.json'),
    codexGoalStatus: path.join(root, 'atris', 'status', 'codex-goal.md'),
    atrisGoalJson: path.join(stateDir, 'atris_goal.json'),
    atrisGoalStatus: path.join(root, 'atris', 'status', 'atris-goal.md'),
    statusNow: path.join(root, 'atris', 'status', 'now.md'),
    runsDir: path.join(root, 'atris', 'runs'),
  };
}

function readBusinessBinding(root = process.cwd()) {
  const file = path.join(root, '.atris', 'business.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      business_id: parsed.business_id || '',
      workspace_id: parsed.workspace_id || '',
      slug: parsed.slug || '',
    };
  } catch {
    return null;
  }
}

function businessIdForAtris2Mission(mission, cwd = process.cwd()) {
  return mission?.business_id || readBusinessBinding(cwd)?.business_id || null;
}

function readJsonLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function nextMissionNumber(root = process.cwd()) {
  return nextRecordNumber(readJsonLines(statePaths(root).missionsJsonl));
}

function missionLabel(mission) {
  return shortRecordLabel(mission, mission && (mission.objective || mission.slug || mission.id));
}

function missionRef(mission) {
  return shortRecordRef(mission);
}

function missionDisplayText(mission, value) {
  const text = String(value || '');
  const id = String(mission && mission.id || '').trim();
  if (!id) return text;
  return text.split(id).join(missionRef(mission));
}

function assignMissionNumber(mission, root = process.cwd()) {
  if (!mission) return mission;
  const existing = mission.id ? loadMissionMap(root).get(mission.id) : null;
  if (existing) {
    const next = { ...mission };
    if (displayNumber(existing.n)) next.n = existing.n;
    else delete next.n;
    return next;
  }
  if (displayNumber(mission.n)) return mission;
  return { ...mission, n: nextMissionNumber(root) };
}

function loadMissionMap(root = process.cwd()) {
  const paths = statePaths(root);
  const map = new Map();
  const assignedNumbers = new Map();
  for (const mission of readJsonLines(paths.missionsJsonl)) {
    if (!mission || !mission.id) continue;
    if (!assignedNumbers.has(mission.id) && displayNumber(mission.n)) {
      assignedNumbers.set(mission.id, mission.n);
    }
    const normalized = { ...normalizeMissionState(mission) };
    if (assignedNumbers.has(mission.id)) normalized.n = assignedNumbers.get(mission.id);
    else delete normalized.n;
    map.set(mission.id, normalized);
  }
  return map;
}

function terminalNextAction(status) {
  if (status === 'complete') return 'mission complete';
  if (status === 'stopped') return 'mission stopped';
  return null;
}

function normalizeMissionState(mission) {
  if (!mission) return mission;
  let normalized = mission;
  const nextAction = terminalNextAction(mission.status);
  if (nextAction && mission.next_action !== nextAction) {
    normalized = { ...normalized, next_action: nextAction };
  }
  const effectiveVerifier = effectiveMissionVerifier(normalized);
  const explicitVerifier = String(normalized.verifier || '').trim();
  if (effectiveVerifier && effectiveVerifier !== explicitVerifier) {
    return { ...normalized, effective_verifier: effectiveVerifier };
  }
  if (Object.prototype.hasOwnProperty.call(normalized, 'effective_verifier')) {
    const { effective_verifier, ...withoutDerivedVerifier } = normalized;
    return withoutDerivedVerifier;
  }
  return normalized;
}

function listMissions(root = process.cwd()) {
  return Array.from(loadMissionMap(root).values())
    .sort((a, b) => String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || '')));
}

// Cross-worktree rollup: missions started with --worktree keep their state inside
// that worktree, so a plain `mission status` from any single checkout is blind to
// them. Enumerate sibling git worktrees and surface their missions read-only.
function listWorktreeRollupMissions(root = process.cwd()) {
  let entries = [];
  try {
    entries = require('./worktree').listWorktrees(root);
  } catch {
    return []; // not a git repo (or git unavailable): nothing to roll up
  }
  let here = root;
  try {
    here = fs.realpathSync(root);
  } catch { /* keep raw path */ }
  const rolled = [];
  for (const entry of entries) {
    let wtRoot;
    try {
      wtRoot = fs.realpathSync(entry.path);
    } catch {
      continue; // stale worktree record
    }
    if (wtRoot === here) continue;
    for (const mission of listMissions(wtRoot)) {
      rolled.push({ ...mission, worktree_root: entry.path, worktree_branch: entry.branch });
    }
  }
  return rolled;
}

// BCK-1319: `mission list` merges in worktree-rollup missions (sibling git
// worktrees keep their own missions.jsonl) but the resolver only ever
// searched the local root, so an id/slug list showed via rollup would 404 in
// run/tick/show. This is the same local+rollup, deduped-by-id, list-sorted
// set `mission status`/`list` renders, so id/slug/suffix lookups search
// exactly what list showed. n stays exactly as each mission's home workspace
// assigned it (loadMissionMap owns that) — this index does NOT renumber,
// because n must stay a stable, durable handle across saves (see
// mission-number-stability.test.js); numeric-n resolution stays scoped to
// the local root, where n is guaranteed unique.
function canonicalMissionIndex(root = process.cwd()) {
  const missions = listMissions(root);
  const seen = new Set(missions.map((mission) => mission.id));
  for (const rolled of listWorktreeRollupMissions(root)) {
    if (seen.has(rolled.id)) continue;
    seen.add(rolled.id);
    missions.push(rolled);
  }
  missions.sort((a, b) => String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || '')));
  return missions;
}

const MISSION_REF_SUFFIX_MIN_LENGTH = 6;

// A ref that "looks like" an id/suffix/number is a single token with no
// whitespace matching a hex/id/numeric shape. Those must resolve or error —
// never silently fall through to starting a new mission (a mistyped id/n
// creating a junk mission is the worst failure mode here).
function missionRefLooksLikeHandle(ref) {
  const raw = String(ref || '').trim();
  if (!raw || /\s/.test(raw)) return false;
  const withoutHash = raw.startsWith('#') ? raw.slice(1) : raw;
  if (/^\d+$/.test(withoutHash)) return true;
  if (/^mission-/.test(raw)) return true;
  if (/^[0-9a-f]{6,}$/i.test(withoutHash)) return true;
  return false;
}

function missionMatchesRef(mission, ref) {
  return mission && (recordMatchesRef(mission, ref) || mission.slug === String(ref || '').trim());
}

// Suffix/prefix id matches and slug-prefix matches, gated to unique hits of
// at least MISSION_REF_SUFFIX_MIN_LENGTH chars so a short fragment can't
// silently grab the wrong mission.
function missionsMatchingHandleFragment(missions, ref) {
  const raw = String(ref || '').trim();
  if (!raw || raw.length < MISSION_REF_SUFFIX_MIN_LENGTH) return [];
  const lower = raw.toLowerCase();
  const idHits = missions.filter((mission) => {
    const id = String(mission.id || '').toLowerCase();
    return id.startsWith(lower) || id.endsWith(lower);
  });
  if (idHits.length) return idHits;
  return missions.filter((mission) => String(mission.slug || '').toLowerCase().startsWith(lower));
}

function nearestMissionCandidates(missions, ref, limit = 5) {
  const raw = String(ref || '').trim().toLowerCase();
  return missions
    .map((mission) => {
      const id = String(mission.id || '').toLowerCase();
      const slug = String(mission.slug || '').toLowerCase();
      let score = 0;
      if (raw && (id.includes(raw) || slug.includes(raw))) score = 2;
      else if (raw && raw.length >= 3 && (id.slice(-6).includes(raw.slice(0, 3)) || slug.includes(raw.slice(0, 3)))) score = 1;
      return { mission, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.mission);
}

function listSiblingWorkspaceMissionHints(ref, root = process.cwd(), limit = 5) {
  if (!ref) return [];
  const baseRoot = path.resolve(root);
  const parent = path.dirname(baseRoot);
  let here = baseRoot;
  try {
    here = fs.realpathSync(baseRoot);
  } catch { /* keep raw path */ }
  let entries = [];
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true });
  } catch {
    return [];
  }
  const hints = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const candidateRoot = path.join(parent, entry.name);
    let candidateReal = candidateRoot;
    try {
      candidateReal = fs.realpathSync(candidateRoot);
    } catch {
      continue;
    }
    if (candidateReal === here) continue;
    if (!fs.existsSync(path.join(candidateRoot, '.atris', 'state', 'missions.jsonl'))) continue;
    const mission = listMissions(candidateRoot).find((row) => missionMatchesRef(row, ref));
    if (!mission) continue;
    hints.push({
      id: mission.id,
      status: mission.status,
      objective: mission.objective,
      workspace_root: candidateRoot,
      command: `cd ${shellQuote(candidateRoot)} && atris mission status ${mission.id}`,
    });
    if (hints.length >= limit) break;
  }
  return hints;
}

function exitMissingMission(ref, code = 1, asJson = false, root = process.cwd()) {
  const error = `Mission "${ref}" not found.`;
  const hints = listSiblingWorkspaceMissionHints(ref, root);
  // Only compute nearest-candidate hints for refs that actually look like a
  // mission handle (id/suffix/number). Plain garbage strings/objectives
  // passed to status/show keep the original bare "not found" shape.
  let candidates = [];
  if (missionRefLooksLikeHandle(ref)) {
    try {
      candidates = nearestMissionCandidates(canonicalMissionIndex(root), ref).map((mission) => ({
        n: mission.n,
        id: mission.id,
        status: mission.status,
        objective: mission.objective,
      }));
    } catch { /* best-effort hint only */ }
  }
  if (asJson) {
    const payload = { ok: false, error };
    if (hints.length) payload.workspace_hint = hints[0];
    if (hints.length > 1) payload.workspace_hints = hints;
    if (candidates.length) payload.nearest_candidates = candidates;
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.error(error);
    if (hints.length) {
      console.error(`Workspace hint: mission ${hints[0].id} exists in ${hints[0].workspace_root}.`);
      console.error(`Run: ${hints[0].command}`);
    } else if (candidates.length) {
      console.error('Nearest candidates:');
      for (const candidate of candidates) {
        console.error(`  #${candidate.n} ${candidate.id} (${candidate.status}) — ${candidate.objective}`);
      }
    } else {
      console.error('Mission ids are workspace-local — run this from the workspace that created the mission.');
    }
  }
  process.exit(code);
}

// BCK-1319: id/slug/suffix lookups search the same local+rollup set `mission
// list` renders (canonicalMissionIndex), so a full id or slug shown by list
// always resolves here too. Numeric n lookups stay scoped to the local root:
// n is a durable per-workspace handle (loadMissionMap assigns it once and
// never renumbers), so it's only guaranteed unique within its own workspace
// — searching rollups by n would let one worktree's #1 silently resolve to
// a different worktree's #1.
function resolveMission(ref, root = process.cwd()) {
  const localMissions = listMissions(root);
  if (!ref) {
    return localMissions.find((mission) => !TERMINAL_STATUSES.has(mission.status)) || localMissions[0] || null;
  }
  const rawRef = String(ref).trim();
  // exact id first, local root only: fuzzy prefix/suffix matching can hit a
  // sibling whose id contains this one (e.g. re-resolving "acked-..." matched
  // "newer-unacked-...")
  const exactLocal = localMissions.find((mission) => mission.id === rawRef);
  if (exactLocal) return exactLocal;

  const wantedNumber = displayNumber(rawRef.startsWith('#') ? rawRef.slice(1) : rawRef);
  if (wantedNumber) {
    const matches = localMissions.filter((mission) => recordMatchesRef(mission, ref));
    if (matches.length > 1) {
      const chosen = matches.find((mission) => !TERMINAL_STATUSES.has(mission.status)) || matches[0];
      console.warn(`warning: mission number #${wantedNumber} is shared by ${matches.map((mission) => mission.id).join(', ')}; using ${chosen.id}.`);
      return chosen;
    }
    if (matches.length) return matches[0];
    // No mission has this n. An all-digit ref can still be a hash suffix —
    // missionId()'s 8-hex-char suffix is purely numeric ~2.4% of the time
    // ((10/16)^8), and returning null here made those missions unresolvable
    // by suffix. Fall through to slug/suffix resolution instead.
  }

  const localSlugOrLegacyMatch = localMissions.find((mission) => missionMatchesRef(mission, rawRef));
  if (localSlugOrLegacyMatch) return localSlugOrLegacyMatch;

  // Not found locally by id/slug: widen to the canonical (local + rollup)
  // index before giving up, so an id/slug copied from `mission list` (which
  // includes rollups) resolves here too instead of 404ing.
  const missions = canonicalMissionIndex(root);
  const widerExact = missions.find((mission) => mission.id === rawRef || missionMatchesRef(mission, rawRef));
  if (widerExact) return widerExact;

  const fragmentMatches = missionsMatchingHandleFragment(missions, rawRef);
  if (fragmentMatches.length === 1) return fragmentMatches[0];
  if (fragmentMatches.length > 1) {
    const chosen = fragmentMatches.find((mission) => !TERMINAL_STATUSES.has(mission.status)) || fragmentMatches[0];
    console.warn(`warning: "${rawRef}" matches ${fragmentMatches.length} missions (${fragmentMatches.map((mission) => mission.id).join(', ')}); using ${chosen.id}.`);
    return chosen;
  }
  return null;
}

function missionMatchesStatusFilter(mission, statusFilter) {
  if (statusFilter === 'active') return !TERMINAL_STATUSES.has(mission.status);
  return mission.status === statusFilter;
}

function appendJsonLine(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(payload) + '\n', 'utf8');
}

function appendEvent(type, mission, payload = {}, root = process.cwd()) {
  const paths = statePaths(root);
  const event = {
    schema: 'atris.mission_event.v1',
    type,
    mission_id: mission.id,
    at: stampIso(),
    actor: process.env.ATRIS_AGENT_ID || process.env.USER || null,
    payload,
  };
  appendJsonLine(paths.eventsJsonl, event);
  return event;
}

function saveMission(mission, root = process.cwd(), eventType = 'mission_updated', payload = {}) {
  const paths = statePaths(root);
  const existing = mission && mission.id ? loadMissionMap(root).get(mission.id) : null;
  const stableMission = { ...mission };
  if (existing) {
    if (displayNumber(existing.n)) stableMission.n = existing.n;
    else delete stableMission.n;
  }
  const next = normalizeMissionState({
    ...stableMission,
    schema: 'atris.mission.v1',
    updated_at: stampIso(),
  });
  appendJsonLine(paths.missionsJsonl, next);
  const event = appendEvent(eventType, next, payload, root);
  renderMissionStatus(root);
  renderMemberMissionState(next.owner, root);
  return { mission: next, event };
}

function memberDir(owner, root = process.cwd()) {
  if (!owner || !/^[a-zA-Z0-9._-]+$/.test(owner)) return null;
  const dir = path.join(root, 'atris', 'team', owner);
  if (!fs.existsSync(path.join(dir, 'MEMBER.md'))) return null;
  return dir;
}

function appendMemberLog(owner, title, fields = {}, root = process.cwd()) {
  const dir = memberDir(owner, root);
  if (!dir) return null;
  const logsDir = path.join(dir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const logPath = path.join(logsDir, `${todayName()}.md`);
  const stamp = new Date().toTimeString().slice(0, 5);
  const rows = [
    `## ${stamp} · ${title}`,
    `- member: ${owner}`,
    ...Object.entries(fields)
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([key, value]) => `- ${key}: ${String(value).replace(/\n/g, ' ')}`),
    '',
  ];
  fs.appendFileSync(logPath, rows.join('\n'), 'utf8');
  return logPath;
}

function memberMissionFile(owner, root = process.cwd()) {
  const dir = memberDir(owner, root);
  if (!dir) return null;
  return path.join(dir, 'MISSION.md');
}

function missingOwnerMemberWarning(owner, root = process.cwd()) {
  if (!owner || fs.existsSync(path.join(root, 'atris', 'team', owner))) return null;
  const teamDir = path.join(root, 'atris', 'team');
  const hasKnownMembers = fs.existsSync(teamDir)
    && fs.readdirSync(teamDir, { withFileTypes: true }).some((entry) => (
      entry.isDirectory() && fs.existsSync(path.join(teamDir, entry.name, 'MEMBER.md'))
    ));
  if (!hasKnownMembers) return null;
  return {
    code: 'missing_owner_member',
    message: `owner "${owner}" has no atris/team/${owner}/ member. Create it (atris member create ${owner}) or pick an existing member (ls atris/team/).`,
  };
}

function ensureMemberMissionFile(owner, root = process.cwd(), objective = '') {
  const missionPath = memberMissionFile(owner, root);
  if (!missionPath || fs.existsSync(missionPath)) return missionPath;
  const purpose = String(objective || '').trim() || 'Define why this member exists and how it chooses goals.';
  const content = [
    '# Mission',
    '',
    '<!-- Human-authored purpose file. Keep this durable; runtime state belongs in .atris/state/*.jsonl and now.md. -->',
    '',
    '## North Star',
    '',
    purpose,
    '',
    '## How To Choose Goals',
    '',
    '- Read MEMBER.md, MISSION.md, current goals, now.md, and recent logs.',
    '- Choose one useful bounded goal toward the mission.',
    '- Verify the work, write the receipt, and update the log.',
    '- Ask the human when vision, taste, risk, or uncertainty matters.',
    '',
  ].join('\n');
  fs.writeFileSync(missionPath, content, 'utf8');
  return missionPath;
}

function removeLegacyGeneratedMissionViews(dir) {
  for (const name of ['missions.md', 'missions.json']) {
    const legacyPath = path.join(dir, name);
    if (!fs.existsSync(legacyPath)) continue;
    let text = '';
    try {
      text = fs.readFileSync(legacyPath, 'utf8');
    } catch {}
    const looksGenerated = name.endsWith('.json')
      ? text.includes('"schema": "atris.member_missions.v1"')
      : text.includes('Generated from local Mission state');
    if (looksGenerated) fs.unlinkSync(legacyPath);
  }
}

// Metric-verified missions (wish --metric) render their target expression plus
// the last observed value, read from the most recent verifier JSON line when a
// tick has run the verifier (metric_verify.py prints {"value": ..., "proof_uri": ...}).
function missionMetricLine(mission, indent = '  ') {
  const metric = mission?.metadata?.metric;
  if (!metric) return [];
  const stdout = String(mission?.verifier_result?.stdout || '');
  let last = null;
  for (const line of stdout.split(/\r?\n/).reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && parsed.value !== undefined) {
        last = parsed.value;
        break;
      }
    } catch {}
  }
  return [`${indent}metric: ${metric}${last === null ? '' : ` (last: ${last})`}`];
}

function renderMemberNowMarkdown(owner, missions) {
  const lines = [
    '# Now',
    '',
    '<!-- Generated by Atris. Do not hand-edit. Durable purpose belongs in MISSION.md. -->',
    '',
  ];
  if (!missions.length) {
    lines.push('No missions yet.', '');
    return lines.join('\n');
  }
  for (const mission of missions) {
    const taskSpine = missionTaskSpine(mission);
    const budgetContinuation = missionBudgetContinuationText(mission);
    lines.push(`## ${mission.objective}`);
    lines.push('');
    lines.push(`- id: ${mission.id}`);
    lines.push(`- status: ${missionHumanStatusText(mission)}`);
    lines.push(`- cadence: ${mission.cadence}`);
    lines.push(`- runner: ${mission.runner}${mission.model ? ` (${mission.model})` : ''}`);
    lines.push(`- lane: ${mission.lane}`);
    if (taskSpine.task_ref) lines.push(`- task: ${taskSpine.task_ref}`);
    if (taskSpine.current_step_command && !budgetContinuation) lines.push(`- task next: ${taskSpine.current_step_command}`);
    if (!taskSpine.has_task && taskSpine.ensure_task_command) lines.push(`- task setup: ${taskSpine.ensure_task_command}`);
    if (mission.xp_task?.ref) lines.push(`- AgentXP task: ${mission.xp_task.ref}`);
    if (mission.verifier) lines.push(`- verifier: ${mission.verifier}`);
    lines.push(...missionMetricLine(mission, '- '));
    if (mission.stop_condition) lines.push(`- stop: ${mission.stop_condition}`);
    if (budgetContinuation || mission.next_action) lines.push(`- next: ${budgetContinuation || mission.next_action}`);
    if (mission.receipt_path) lines.push(`- proof: ${missionStatusProofText(mission)}`);
    if (mission.human_asks?.length) {
      lines.push('- human asks:');
      for (const ask of mission.human_asks) lines.push(`  - ${ask}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function renderMemberMissionState(owner, root = process.cwd()) {
  const dir = memberDir(owner, root);
  if (!dir) return null;
  const missionPath = ensureMemberMissionFile(owner, root);
  const missions = listMissions(root).filter((mission) => mission.owner === owner);
  const nowPath = path.join(dir, 'now.md');
  removeLegacyGeneratedMissionViews(dir);
  fs.writeFileSync(nowPath, renderMemberNowMarkdown(owner, missions), 'utf8');
  return { missionPath, nowPath };
}

// One glanceable label for how a mission earned its completion: evidence
// source when the gate passed, an explicit marker when an operator forced it.
function completionGateLabel(gate) {
  if (!gate) return null;
  return gate.forced ? `forced override (${gate.source})` : gate.source;
}

function missionCompletionReceipt(mission, proof, xpNextCommand = null) {
  const gate = mission.completion_gate || {};
  const gateLabel = completionGateLabel(gate) || 'completion gate';
  const happened = `${mission.objective} is complete.`;
  const checked = gate.source === 'receipt' && gate.receipt_path
    ? `I checked the passing verifier receipt ${gate.receipt_path}.`
    : gate.source === 'mission_state'
      ? 'I checked mission state showing the verifier passed.'
      : gate.source === 'no_verifier'
        ? 'No verifier was configured, so completion used the no-verifier gate.'
        : `I checked the ${gateLabel} completion gate.`;
  const tested = mission.verifier_result?.passed
    ? missionVerifierHighLevelTestText(mission.verifier_result, mission)
    : mission.verifier
      ? `Completion proof is attached for verifier: ${mission.verifier}.`
      : 'No verifier command was recorded for this mission.';
  const landing = {
    happened,
    reason: missionHumanReasonText(mission, happened),
    checked,
    tested,
    saved: proof ? `Proof saved at ${proof}.` : 'Proof saved in mission state.',
    decision: xpNextCommand
      ? 'Ready for human review; accept in Atris if the proof looks right.'
      : 'Pick the next customer-facing move.',
  };
  const result = {
    changed: landing.happened,
    reason: landing.reason,
    checked: landing.checked,
    tested: landing.tested,
    saved: landing.saved,
    accept: landing.decision,
  };
  return { landing, result };
}

function missionResultLines(completion) {
  const landing = completion?.landing || {};
  const result = completion?.result || {};
  const lines = ['Landing:'];
  if (landing.happened) lines.push(`  Changed: ${landing.happened}`);
  if (landing.reason) lines.push(`  Why it matters: ${landing.reason}`);
  if (landing.artifact) lines.push(`  Artifact: ${landing.artifact}`);
  if (landing.checked) lines.push(`  How I checked: ${landing.checked}`);
  if (landing.tested) lines.push(`  What I tested: ${landing.tested}`);
  if (result.saved) lines.push(`  Proof: ${result.saved}`);
  if (landing.decision) lines.push(`  Next: ${landing.decision}`);
  return lines;
}

function missionSelfImprovementSeedAction(mission, root = process.cwd()) {
  try {
    const moves = require('../lib/next-moves');
    const seed = moves.nextMoves(root, 3).find((move) => (
      move
      && move.source === 'mission'
      && (!mission?.id || !move.ref || move.ref === mission.id)
      && move.title !== mission.objective
    ));
    return seed ? `${seed.title}.` : '';
  } catch {
    return '';
  }
}

function missionHumanNextAction(mission, root = process.cwd(), options = {}) {
  if (!mission) return 'Pick the next customer-facing move.';
  if (mission.goal_chain?.pause_ready) return 'Mission feels good; review proof, then complete, revise, or choose the next goal.';
  if (mission.status === 'ready' && /^queue AgentXP review:/i.test(mission.next_action || '')) {
    return 'Ready for human review; accept in Atris if the proof looks right.';
  }
  if (mission.status === 'ready' && mission.always_on) {
    return options.allowSelfImprovementSeed
      ? (missionSelfImprovementSeedAction(mission, root) || 'Run the next proof step.')
      : 'Run the next proof step.';
  }
  if (mission.status === 'ready') return 'Review the proof, then complete the mission.';
  if (mission.status === 'complete') return 'Pick the next customer-facing move.';
  if (mission.status === 'blocked') return 'Fix the verifier failure or revise the mission.';
  return 'Keep running the mission.';
}

function missionLandingStepSummary(summary) {
  const clean = String(summary || '')
    .replace(/[`*~]/g, '')
    .replace(/__+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^done[.!]\s*/i, '');
  if (!clean) return '';
  if (/^verifier pass(?:es|ed)(?:\s*\([^)]*\))?[.!]\s*(?:now (?:i|we) need|let me|next i)\b/i.test(clean)) {
    return 'This proof step recorded no operator-facing result.';
  }
  const withoutLabel = clean
    .replace(/^(?:landing|changed|summary|result|product proof|proof):\s*/i, '')
    .trim();
  if (!withoutLabel) return '';
  const withoutInternalId = withoutLabel.replace(/^(?:CLI|OBL|BCK)-\d+\s+/i, '').trim();
  const withoutProofTail = withoutInternalId.replace(/;\s+(?=(?:PR\s+\d+|(?:node|npm|git)\b)).*$/i, '').trim();
  const plainVerified = missionPlainVerifiedSummary(withoutProofTail);
  if (plainVerified) return plainVerified;
  const beforeInlineProof = withoutProofTail.split(/\s+(?:—|-)\s+verified by\b/i)[0] || withoutProofTail;
  const beforeChecks = (beforeInlineProof.split(/\s+(?:checks?|verified|proof):\s+/i)[0] || beforeInlineProof)
    .replace(/,\s*(?:verifier|proof|checks?)\s+(?:still|pending)[.!]?$/i, '')
    .trim();
  const clipped = missionLandingSentenceClip(beforeChecks, 220);
  return clipped ? `${clipped}.` : '';
}

function missionHumanReasonText(mission, changed = '') {
  const consequence = String(changed || '').match(/,\s+so\s+(.+?)\s*[.!?]*$/i)?.[1]?.trim();
  if (consequence) {
    const sentence = consequence.charAt(0).toUpperCase() + consequence.slice(1);
    return `${sentence.replace(/[.!?]+$/g, '')}.`;
  }
  const objective = String(mission?.objective || '').trim();
  const text = `${objective} ${changed}`.toLowerCase();
  if (/\b(human|plain|language|landing|proof|receipt|understand|readable)\b/.test(text)) {
    return 'It makes the result understandable before a human accepts or rejects it.';
  }
  if (/\b(update|install|runner|autopilot|mission run|heartbeat)\b/.test(text)) {
    return 'It proves the workflow works in the place people actually use it.';
  }
  return 'It turns the mission into a concrete result a human can accept, reject, or run again.';
}

function missionPlainVerifiedSummary(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  const shipped = clean.match(/^Verified\s+(.+?)\s+behavior\s+already\s+shipped\s+on\s+master\s*:/i);
  if (!shipped) return '';
  const topic = shipped[1].toLowerCase();
  if (topic.includes('npm auto-update')) {
    return 'Verified npm auto-update works for installed npm packages on master.';
  }
  if (topic.includes('runner-agnostic heartbeat')) {
    return 'Verified autopilot and mission run use the same runner setup on master.';
  }
  return `Verified ${shipped[1]} is already working on master.`;
}

function missionLandingSentenceClip(text, max) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  if (clean.length <= max) return clean.replace(/[.!?:;,]+$/g, '').trim();
  const sentence = clean.match(/^(.{24,220}?[.!?])\s+/);
  const base = sentence ? sentence[1] : clean.slice(0, max);
  return base
    .replace(/\s+\S*$/, '')
    .replace(/[.!?:;,]+$/g, '')
    .replace(/\b(?:and|or|but|with|to|for|from|by|through|via|using|including|include|includes|plus|then|both|the|a|an|of|in|on|at|as)$/i, '')
    .trim();
}

function missionLastStepSummary(ticks = []) {
  for (let index = ticks.length - 1; index >= 0; index -= 1) {
    const tick = ticks[index] || {};
    const summary = missionLandingStepSummary(tick.summary || tick.claude?.summary || tick.atris2?.receipt_text || '');
    if (summary) return summary;
  }
  return '';
}

function missionVerifierCheckedText(verifierResult, mission) {
  if (!verifierResult) return 'UNVERIFIED: tick recorded but nothing was checked; treat this increment as unproven.';
  if (verifierResult.mode === 'engine-unavailable') {
    return 'VERIFY FAILED: the engine verify pass was unavailable; treat this increment as unproven.';
  }
  if (verifierResult.mode === 'engine') {
    return verifierResult.passed
      ? 'Engine verify passed after running the changed surface on this computer.'
      : 'VERIFY FAILED: the engine verify pass did not end with VERDICT: PASS.';
  }
  const command = verifierResult.command || mission.verifier || 'configured verifier';
  if (verifierResult.passed) {
    if (/^git\s+diff\s+--check\b/i.test(command)) return 'I ran the diff cleanliness check.';
    if (/\bnode\s+--test\b/i.test(command)) return 'I ran the behavior checks.';
    if (/^test\s+-s\s+\S+/i.test(command)) return 'I checked that the saved artifact exists and is not empty.';
    if (/(?:node\s+\S*atris\.js|\batris)\s+land\s+status\b/i.test(command)) return 'I checked the live landing queue.';
    if (/(?:node\s+\S*atris\.js|\batris)\s+drill\b/i.test(command)) return 'I ran the no-model end-to-end workflow drill.';
    return `Verifier passed: ${command}.`;
  }
  if (/^git\s+diff\s+--check\b/i.test(command)) return 'VERIFY FAILED: diff cleanliness check failed.';
  if (/\bnode\s+--test\b/i.test(command)) return 'VERIFY FAILED: behavior checks failed.';
  return `VERIFY FAILED: ${command}.`;
}

function missionVerifierHighLevelTestText(verifierResult, mission) {
  if (!verifierResult) return 'No automated verifier ran for this receipt; judge it from the receipt, changed files, and next action.';
  if (verifierResult.mode === 'engine-unavailable') {
    return 'No changed-surface commands were confirmed because the engine verify pass was unavailable.';
  }
  if (verifierResult.mode === 'engine') {
    return verifierResult.passed
      ? 'The verify engine inspected the tick diff and reported real changed-surface command output.'
      : 'The verify engine did not provide a passing changed-surface verdict.';
  }
  const command = verifierResult.command || mission.verifier || 'configured verifier';
  const outcome = verifierResult.passed ? 'passed' : 'failed';
  if (/^git\s+diff\s+--check\b/i.test(command)) {
    return `Diff cleanliness check ${outcome}: no whitespace or patch-format issues in the changed files.`;
  }
  if (/\bnode\s+--test\b/i.test(command) && /\btest\/mission-status\.test\.js\b/i.test(command)) {
    return `Mission behavior checks ${outcome}: mission start, tick, completion, timeline landing, goal-chain, next-mission, and human-accept boundaries were exercised.`;
  }
  if (/\bnode\s+--test\b/i.test(command)) {
    return `Automated behavior checks ${outcome}: the touched code path was exercised by Node tests.`;
  }
  if (/^test\s+-s\s+\S+/i.test(command)) {
    return `Saved artifact check ${outcome}: the file exists and is not empty.`;
  }
  if (/(?:node\s+\S*atris\.js|\batris)\s+land\s+status\b/i.test(command)) {
    return `Landing status check ${outcome}: the queue and worktree state were readable.`;
  }
  if (/(?:node\s+\S*atris\.js|\batris)\s+drill\b/i.test(command)) {
    return `End-to-end workflow drill ${outcome} in a throwaway workspace.`;
  }
  return `Verifier command ${outcome}: ${command}.`;
}

function missionFallbackChangedText(mission, status, tickIndex, { ranTicks = null, effectiveMaxTicks = null } = {}) {
  if (mission?.always_on && (status === 'ready' || status === 'running')) {
    return 'Recorded a proof heartbeat for this always-on mission.';
  }
  if (status === 'ready') return `${mission.objective} is ready for review.`;
  if (status === 'complete') return `${mission.objective} is complete.`;
  if (status === 'blocked') return `${mission.objective} is blocked.`;
  if (ranTicks != null && effectiveMaxTicks != null) {
    return ranTicks > 0
      ? `${mission.objective} ran ${ranTicks}/${effectiveMaxTicks} tick(s).`
      : `${mission.objective} did not run a tick.`;
  }
  return `${mission.objective} recorded tick ${tickIndex}.`;
}

function missionTickResultLines(mission, tickIndex, receiptPath, verifierResult = null, stepSummary = '') {
  return missionLandingLines(missionReceiptLanding(mission, {
    tick: { tick_index: tickIndex },
    summary: stepSummary,
    verifier_result: verifierResult,
  }, receiptPath));
}

function missionReceiptSummaryText(result) {
  const tick = result?.tick || {};
  return tick.summary
    || tick.atris2?.receipt_text
    || tick.claude?.receipt_text
    || result?.summary
    || result?.reason
    || '';
}

function missionReceiptTickIndex(mission, result) {
  const value = Number(result?.tick?.tick_index || mission?.last_tick_index || 0);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function missionReceiptStatus(mission, result) {
  const tickStatus = String(result?.tick?.status || '').trim();
  if (tickStatus === 'blocked') return 'blocked';
  if (result?.verifier_result?.passed === false) return 'blocked';
  if (result?.verifier_result?.passed === true) return 'proof_ready';
  return String(mission?.status || 'running');
}

function missionReceiptNextText(mission, result, receiptPath = '') {
  if (result?.next) return String(result.next);
  if (result?.landing?.next) return String(result.landing.next);
  if (result?.verifier_result?.passed === true) {
    if (!mission?.always_on && receiptPath) {
      return `Review proof, then run: atris mission complete ${mission.id} --proof "${receiptPath}".`;
    }
    return mission?.always_on ? 'Run the next proof step.' : 'Review the proof, then complete the mission.';
  }
  if (result?.verifier_result) return 'Fix the verifier failure or revise the mission.';
  return missionHumanNextAction(mission);
}

function missionReceiptLanding(mission, result, receiptPath = '') {
  const verifierResult = result?.verifier_result || null;
  const status = missionReceiptStatus(mission, result);
  const summary = missionReceiptSummaryText(result);
  const changed = missionLandingStepSummary(summary)
    || missionFallbackChangedText(mission, status, missionReceiptTickIndex(mission, result));
  const checked = missionVerifierCheckedText(verifierResult, mission);
  const tested = missionVerifierHighLevelTestText(verifierResult, mission);
  const reason = missionHumanReasonText(mission, changed);
  return {
    schema: 'atris.result_landing.v1',
    status,
    changed,
    reason,
    checked,
    tested,
    proof: receiptPath ? `Receipt saved at ${receiptPath}.` : 'Receipt saved in mission run history.',
    next: missionReceiptNextText(mission, result, receiptPath),
    timeline_visible: !missionLandingChangedIsGenericTick(mission, changed),
  };
}

function missionLandingLines(landing) {
  if (!landing) return [];
  const rawChanged = landing.changed || landing.happened || 'Landing recorded.';
  const changed = missionLandingStepSummary(rawChanged) || rawChanged;
  const rawChecked = landing.checked || 'No check recorded.';
  const checked = /^Verifier passed:\s+test\s+-s\s+\S+/i.test(rawChecked)
    ? 'I checked that the saved artifact exists and is not empty.'
    : (/(?:node\s+\S*atris\.js|\batris)\s+land\s+status\b/i.test(rawChecked)
      ? 'I checked the live landing queue.'
      : (/(?:node\s+\S*atris\.js|\batris)\s+drill\b/i.test(rawChecked)
        ? 'I ran the no-model end-to-end workflow drill.'
        : rawChecked));
  const rawTested = landing.tested || 'No test summary recorded.';
  const tested = /^Verifier command passed:\s+test\s+-s\s+\S+/i.test(rawTested)
    ? 'Saved artifact check passed: the file exists and is not empty.'
    : (/(?:node\s+\S*atris\.js|\batris)\s+land\s+status\b/i.test(rawTested)
      ? 'Landing status check passed: the queue and worktree state were readable.'
      : (/(?:node\s+\S*atris\.js|\batris)\s+drill\b/i.test(rawTested)
        ? 'End-to-end workflow drill passed in a throwaway workspace.'
        : rawTested));
  return [
    'Landing:',
    `  Changed: ${changed}`,
    `  Why it matters: ${landing.reason || landing.why || 'This makes the work easier to judge.'}`,
    `  How I checked: ${checked}`,
    `  What I tested: ${tested}`,
    `  Proof: ${landing.proof || landing.saved || 'No proof path recorded.'}`,
    `  Next: ${landing.next || landing.decision || 'Pick the next useful move.'}`,
  ];
}

function missionStatusLandingLines(landing) {
  const statusLanding = landing?.receipt_path
    ? { ...landing, proof: 'Receipt saved in mission history.' }
    : landing;
  const lines = missionLandingLines(statusLanding);
  if (!lines.length) return [];
  return [
    '  last landing:',
    ...lines.slice(1).map((line) => `  ${line.trim()}`),
  ];
}

function missionStatusProofText(mission) {
  const ref = mission?.n || mission?.id;
  return `saved; inspect: atris mission timeline ${ref} --limit 5`;
}

function missionLastLanding(mission, root = process.cwd()) {
  const receipt = readMissionReceipt(mission?.receipt_path, mission?.worktree_root || root);
  const landing = receipt?.result?.landing;
  if (!landing || typeof landing !== 'object') return null;
  return {
    ...landing,
    receipt_path: mission.receipt_path || null,
  };
}

function missionLandingChangedIsGenericTick(mission, changed) {
  const text = String(changed || '').trim();
  const objective = String(mission?.objective || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!objective) return false;
  return new RegExp(`^${objective} recorded tick \\d+\\.$`).test(text);
}

function normalizeMissionReceiptResult(mission, result, receiptPath = '') {
  const object = result && typeof result === 'object' && !Array.isArray(result)
    ? { ...result }
    : { value: result };
  if (!object.landing) {
    object.landing = missionReceiptLanding(mission, object, receiptPath);
  }
  if (object.verifier_result && !('passed' in object)) {
    object.passed = !!object.verifier_result.passed;
  }
  return object;
}

function missionRunStartNextLine(mission, nextCommand, warnings = []) {
  const missingVerifier = warnings.some((warning) => warning && warning.code === 'missing_verifier');
  if (missingVerifier) return 'Add a verifier before completion, then run the first proof tick.';
  if (isCodexGoalMission(mission) && !codexNativeGoalAck(mission)) {
    return 'Start the visible goal, then continue this mission.';
  }
  if (/attach-task/.test(nextCommand || '')) return 'Attach task context, then continue this mission.';
  return 'Run the first proof tick.';
}

function missionRunTakeoffLines(mission, { warnings = [], nextCommand = '' } = {}) {
  const checked = mission.verifier
    ? `Verifier configured: ${mission.verifier}.`
    : 'No verifier was recorded for this mission.';
  return [
    'Takeoff:',
    `  Goal: ${mission.objective}`,
    `  Done when: ${mission.stop_condition || 'the mission has proof or a human decision'}.`,
    ...(missionBudgetLine(mission) ? [`  Budget: ${missionBudgetLine(mission)}`] : []),
    ...missionGoalChainLines(mission),
    '  Proof: Mission state saved in .atris/state/missions.jsonl.',
    `  Check: ${checked}`,
    `  Next: ${missionRunStartNextLine(mission, nextCommand, warnings)}`,
  ];
}

function missionRunPreflightSignals(text) {
  const lower = String(text || '').toLowerCase().replace(/\s+/g, ' ');
  return /\b(messy|shower|overnight|nonstop|forever|goal\s+after\s+goal|self[-\s]?improve|figure\s+out|think\s+through|thinkwell|what\s+to\s+do\s+next|keep\s+going|tell\s+me|right\s+mission\s+input|finish[-\s]+line)\b/i.test(lower);
}

function shouldMissionRunRoomPreflight(objective, args = []) {
  if (hasFlag(args, '--no-preflight')) return false;
  if (hasFlag(args, '--no-room-preflight')) return false;
  if (hasFlag(args, '--preflight')) return true;
  if (hasFlag(args, '--room-preflight')) return true;
  return true;
}

function missionRunTrustedRoomSignals(text) {
  const lower = String(text || '').toLowerCase().replace(/\s+/g, ' ');
  return /\b(one[-\s]?message|autonomy|autonomous|self[-\s]?improve|improve\s+(atris|this|it)|keep\s+going|work\s+on\s+this|next\s+useful|goes?\s+off|no\s+junk|junk\s+state)\b/i.test(lower);
}

function shouldMissionRunTrustedRoom(rawObjective, args = []) {
  if (hasFlag(args, '--no-room-auto-run')) return false;
  if (hasFlag(args, '--room-auto-run')) return true;
  return missionRunTrustedRoomSignals(rawObjective);
}

function missionRunConcreteTitle(value) {
  const title = String(value || '').replace(/\s+/g, ' ').trim();
  if (!title) return '';
  if (/^(go|go go|go go go|keep going|do it|start|run|continue)$/i.test(title)) return '';
  if (title.length < 8) return '';
  return title;
}

function selectMissionRunUsefulTarget(rawObjective, root = process.cwd()) {
  try {
    const moves = require('../lib/next-moves');
    const rawTitle = missionRunConcreteTitle(rawObjective);
    return moves.nextMoves(root, 8)
      .filter((move) => missionRunConcreteTitle(move?.title))
      .filter((move) => !rawTitle || String(move.title).trim() !== rawTitle)
      .find((move) => move.source === 'task')
      || moves.nextMoves(root, 8).find((move) => missionRunConcreteTitle(move?.title))
      || null;
  } catch {
    return null;
  }
}

function missionRunPreflightSentence(text, max = 140) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 3).replace(/\s+\S*$/, '').trimEnd()}...`;
}

function missionRunPreflightObjective(rawObjective, room, owner) {
  const name = room?.name || 'Mission Room';
  const task = room?.task_plan_preview?.task || room?.truth_snapshot || rawObjective;
  return `${name} with ${owner}: turn "${missionRunPreflightSentence(task)}" into one visible goal, task spine, proof receipt, and next action.`;
}

function missionRunTrustedObjective(rawObjective, room, target) {
  const targetTitle = missionRunConcreteTitle(target?.title);
  if (targetTitle) return targetTitle;
  if (missionRunTrustedRoomSignals(rawObjective)) {
    return 'Improve Atris one-message autonomy without creating junk mission state';
  }
  return missionRunPreflightObjective(rawObjective, room, room?.owner || 'mission-lead');
}

function buildMissionRunRoomPreflight(rawObjective, args = [], options = {}) {
  if (!shouldMissionRunRoomPreflight(rawObjective, args)) return null;
  const root = options.root || process.cwd();
  const owner = options.owner || readFlag(args, '--owner', process.env.ATRIS_AGENT_ID || 'mission-lead');
  const explicitPreflight = hasFlag(args, '--preflight') || hasFlag(args, '--room-preflight');
  const signalPreflight = missionRunPreflightSignals(rawObjective) || missionRunTrustedRoomSignals(rawObjective);
  const trustedRun = options.allowTrustedRun !== false && shouldMissionRunTrustedRoom(rawObjective, args);
  const selectedTarget = trustedRun ? selectMissionRunUsefulTarget(rawObjective, root) : null;
  const ownerResolution = resolveFunctionalOwner({
    requestedOwner: owner,
    title: selectedTarget?.title || rawObjective,
    tag: readFlag(args, '--lane', 'workspace'),
    goal: selectedTarget?.title || rawObjective,
    root,
    fallbackOwners: ['mission-lead', 'task-planner', 'architect', 'validator'],
  });
  const room = buildMissionRoom(rawObjective, {
    root,
    owner: ownerResolution.owner,
    ownerResolution,
    trustedRun,
    selectedTarget,
    verifier: trustedRun ? DEFAULT_LONG_RUN_VERIFIER : '',
  });
  const written = writeMissionRoomReceipt(room, { root });
  const shapedObjective = trustedRun
    ? missionRunTrustedObjective(rawObjective, written.room, selectedTarget)
    : missionRunPreflightObjective(rawObjective, written.room, ownerResolution.owner);
  const taskSpineRequired = !selectedTarget && (explicitPreflight || signalPreflight);
  return {
    schema: 'atris.mission_run_preflight.v1',
    source: 'mission_room',
    raw_objective: rawObjective,
    shaped_objective: shapedObjective,
    visible_goal_objective: shapedObjective,
    room_name: written.room.name,
    room_receipt_path: written.relativePath,
    owner: ownerResolution.owner,
    owner_resolution: ownerResolution.reason,
    trusted_run: trustedRun,
    selected_target: selectedTarget ? {
      title: selectedTarget.title,
      source: selectedTarget.source,
      task_id: selectedTarget.task_id || null,
      ref: selectedTarget.ref || null,
      why: selectedTarget.why || '',
    } : null,
    task_spine_required: taskSpineRequired,
    next_action: selectedTarget
      ? 'run one proof tick for the selected existing task'
      : (taskSpineRequired ? 'attach task spine, then run one proof tick' : 'run one proof tick'),
  };
}

function missionRunTaskLabel(task) {
  const ref = task?.ref || task?.display_id || task?.id || 'task';
  return [ref, task?.title].filter(Boolean).join(' ');
}

function missionRunSelectedTaskTarget(preflight) {
  const target = preflight?.selected_target;
  if (!target || target.source !== 'task') return null;
  const taskId = String(target.task_id || '').trim();
  const ref = String(target.ref || taskId || '').trim();
  if (!taskId && !ref) return null;
  return {
    task_id: taskId || ref,
    task_ref: ref || taskId,
    title: target.title || '',
  };
}

function attachSelectedTargetTaskSpine(mission) {
  const selected = missionRunSelectedTaskTarget(mission?.mission_run_preflight);
  if (!selected) return mission;
  const taskIds = Array.from(new Set([...(mission.task_ids || []), selected.task_id].filter(Boolean)));
  return {
    ...mission,
    task_ids: taskIds,
    current_task_id: selected.task_id,
    task_ref: selected.task_ref,
    task_scope_ref: selected.task_ref || selected.task_id,
    selected_target_task: selected,
    next_action: `work selected task then run: atris task current-step --goal-id ${selected.task_ref || selected.task_id} --as ${mission.owner} --proof "<proof>" --json`,
  };
}

function missionRunCreatedNextChangedText(createdNext) {
  const createdTask = createdNext?.ok ? createdNext.task : null;
  if (createdTask) {
    return `Created and claimed next task: ${missionRunTaskLabel(createdTask)}.`;
  }
  const activeTask = createdNext?.reason === 'active_task' ? createdNext.move : null;
  if (activeTask) {
    return `Kept active task: ${missionRunTaskLabel(activeTask)}. No duplicate was created.`;
  }
  return null;
}

function missionRunCreatedNextLine(createdNext, continuationGoal, mission) {
  const createdTask = createdNext?.ok ? createdNext.task : null;
  if (createdTask) {
    return `Created next task: ${missionRunTaskLabel(createdTask)}.`;
  }
  const activeTask = createdNext?.reason === 'active_task' ? createdNext.move : null;
  if (activeTask) {
    return `Continue active task: ${missionRunTaskLabel(activeTask)}.`;
  }
  return continuationGoal?.mission
    ? `Next mission: ${continuationGoal.mission.objective}.`
    : missionHumanNextAction(mission, process.cwd(), { allowSelfImprovementSeed: true });
}

function missionRunTimelineCommand(mission) {
  return `atris mission timeline ${mission.id} --limit 5`;
}

function missionRunExportCommand(mission) {
  return `atris mission timeline ${mission.id} --all --write`;
}

function missionRunPrunePreviewCommand(mission) {
  return `atris mission timeline ${mission.id} --prune-preview`;
}

function missionRunChangedText(mission, ranTicks, effectiveMaxTicks, ticks = [], createdNext = null) {
  const stepChanged = missionLastStepSummary(ticks);
  const createdNextChanged = missionRunCreatedNextChangedText(createdNext);
  return createdNextChanged || stepChanged || missionFallbackChangedText(mission, mission.status, null, { ranTicks, effectiveMaxTicks });
}

function missionBudgetLine(mission) {
  const contract = mission?.budget_contract;
  if (!contract) return null;
  return `${contract.plain_language} Limit: ${contract.budget_label}.`;
}

function missionSpendsFullBudget(mission) {
  return mission?.budget_contract?.policy === 'spend_full_budget';
}

function missionFullBudgetRemainingSeconds(mission, nowMs = Date.now()) {
  if (!missionSpendsFullBudget(mission)) return 0;
  const budgetSeconds = Number(mission?.budget_contract?.requested_seconds || mission?.max_wall_seconds || 0);
  if (!Number.isFinite(budgetSeconds) || budgetSeconds <= 0) return 0;
  const startedMs = Date.parse(mission.started_at || mission.created_at || mission.updated_at || '');
  if (!Number.isFinite(startedMs)) return 0;
  return Math.max(0, Math.ceil((startedMs + budgetSeconds * 1000 - nowMs) / 1000));
}

function missionBudgetContinuationText(mission, nowMs = Date.now()) {
  const remaining = missionFullBudgetRemainingSeconds(mission, nowMs);
  if (remaining <= 0) return null;
  const budget = String(mission?.budget_contract?.budget_label || 'promised time').trim();
  const measured = budget.match(/^(\d+)\s+(hours?|minutes?)$/i);
  const commitment = measured
    ? `${measured[1]}-${measured[2].replace(/s$/i, '').toLowerCase()}`
    : budget;
  return `keep shipping bounded improvements for the remaining ${formatDurationShort(remaining)} of the ${commitment} commitment`;
}

function missionHumanStatusText(mission, nowMs = Date.now()) {
  if (!missionBudgetContinuationText(mission, nowMs)) return String(mission?.status || 'unknown');
  const budget = String(mission?.budget_contract?.budget_label || 'promised time').trim();
  return `working for the full ${budget}`;
}

function missionGoalChainIntent(text) {
  const lower = String(text || '').toLowerCase().replace(/\s+/g, ' ');
  return /\b(3\s*(?:or|-)?\s*4|three\s+or\s+four|multiple|child|subgoals?|goal\s+after\s+goal|keeps?\s+goaling|mission\s+feeling\s+good|feels?\s+good|validated\s+and\s+i\s+can\s+understand)\b/.test(lower)
    || /\bset\s+a\s+goal\b.{0,160}\b(accomplish|complete|finish|prove)\w*\b.{0,200}\bnext\s+(?:useful\s+)?goal\b/.test(lower);
}

function missionGoalChainTargetCount(text) {
  const lower = String(text || '').toLowerCase();
  if (/\b3\s*(?:or|-)?\s*4\b|\bthree\s+or\s+four\b/.test(lower)) return 4;
  const explicit = lower.match(/\b([3-4])\s+(?:goals?|child\s+goals?|subgoals?)\b/);
  if (explicit) return Number(explicit[1]);
  return 4;
}

function buildMissionGoalChain(objective, options = {}) {
  const targetCount = Math.max(3, Math.min(4, Number(options.targetCount || missionGoalChainTargetCount(objective)) || 4));
  const baseGoals = [
    {
      title: 'Find the novel mission',
      done_when: 'A concrete mission is named with why it matters now.',
      validation: 'Plain-English reason plus the source signal that made it worth doing.',
    },
    {
      title: 'Split it into child goals',
      done_when: 'The mission has a 3-4 step path with a clear first move.',
      validation: 'Each child goal says what proof would make it done.',
    },
    {
      title: 'Run the smallest proof',
      done_when: 'One real artifact, code change, status output, or receipt exists.',
      validation: 'A verifier, receipt, or inspectable output proves the work happened.',
    },
    {
      title: 'Explain the pause or next goal',
      done_when: 'The result says what changed, how it was checked, and whether to accept, revise, or continue.',
      validation: 'The operator can understand the mission state without reading logs.',
    },
  ].slice(0, targetCount).map((goal, index) => ({
    order: index + 1,
    status: 'pending',
    ...goal,
  }));

  return {
    schema: 'atris.mission_goal_chain.v1',
    mode: 'validated_child_goals',
    status: 'planned',
    target_count: targetCount,
    done_count: 0,
    current_goal_order: 1,
    plain_language: 'One mission can be reached by several small goals, each with proof.',
    pause_rule: 'Pause when the chain has proof strong enough to understand, accept, revise, or choose the next mission.',
    validation_rule: 'Every child goal must leave a receipt, verifier result, artifact, or explicit stop reason.',
    goals: baseGoals,
  };
}

function missionGoalChainCounts(goalChain) {
  const goals = Array.isArray(goalChain?.goals) ? goalChain.goals : [];
  const done = goals.filter((goal) => goal?.status === 'done').length;
  return { done, total: goals.length };
}

function missionGoalChainPendingGoal(goalChain) {
  const goals = Array.isArray(goalChain?.goals) ? goalChain.goals : [];
  return goals.find((goal) => goal?.status !== 'done' && goal?.status !== 'blocked') || null;
}

function missionGoalChainNextAction(goalChain) {
  const goal = missionGoalChainPendingGoal(goalChain);
  if (!goal) return 'continue child-goal chain';
  return `continue child goal ${goal.order}: ${goal.title}`;
}

function advanceMissionGoalChain(goalChain, summary, verifierResult = null) {
  if (!goalChain || !Array.isArray(goalChain.goals) || !goalChain.goals.length) return goalChain || null;
  const cleanSummary = String(summary || '').replace(/\s+/g, ' ').trim();
  if (!cleanSummary && !verifierResult) return goalChain;

  const goals = goalChain.goals.map((goal) => ({ ...goal }));
  const nextIndex = goals.findIndex((goal) => goal.status !== 'done');
  if (nextIndex === -1) return goalChain;

  const validationResult = verifierResult
    ? (verifierResult.passed ? 'Verifier passed.' : 'Verifier failed; this goal needs repair.')
    : 'Summary receipt recorded.';
  goals[nextIndex] = {
    ...goals[nextIndex],
    status: verifierResult && !verifierResult.passed ? 'blocked' : 'done',
    completed_at: stampIso(),
    result: cleanSummary.slice(0, 240) || validationResult,
    validation_result: validationResult,
  };

  const counts = missionGoalChainCounts({ goals });
  const blocked = goals.some((goal) => goal.status === 'blocked');
  const nextPending = goals.find((goal) => goal.status !== 'done' && goal.status !== 'blocked');
  return {
    ...goalChain,
    goals,
    done_count: counts.done,
    current_goal_order: nextPending ? nextPending.order : null,
    status: blocked ? 'blocked' : counts.done >= counts.total ? 'validated' : 'running',
    pause_ready: !blocked && counts.done >= counts.total,
  };
}

function missionGoalChainLines(mission) {
  const chain = mission?.goal_chain;
  if (!chain || !Array.isArray(chain.goals) || !chain.goals.length) return [];
  const counts = missionGoalChainCounts(chain);
  const lines = [
    `  goal chain: ${counts.done}/${counts.total} done; ${chain.pause_rule}`,
  ];
  for (const goal of chain.goals) {
    const mark = goal.status === 'done' ? '[x]' : goal.status === 'blocked' ? '[!]' : '[ ]';
    lines.push(`    ${mark} ${goal.order}. ${goal.title} -> ${goal.validation}`);
  }
  return lines;
}

function missionBlockerReceiptLine(blocker) {
  if (!blocker?.taskId) return null;
  return blocker.dispatched
    ? `blocker filed as ${blocker.taskId}, dispatched to ${blocker.engine}`
    : `blocker filed as ${blocker.taskId}, no engine ready: ${blocker.reason}`;
}

function missionRunSummaryLines(mission, ranTicks, effectiveMaxTicks, finalReceipt, pauseReason = null, continuationGoal = null, ticks = [], createdNext = null, blocker = null) {
  const changed = missionRunChangedText(mission, ranTicks, effectiveMaxTicks, ticks, createdNext);
  const reason = missionHumanReasonText(mission, changed);
  const lastTick = ticks[ticks.length - 1] || null;
  const verifier = lastTick && lastTick.verifier_passed == null ? null : mission.verifier_result;
  const checked = verifier
    ? missionVerifierCheckedText(verifier, mission)
    : pauseReason === 'no-progress'
      ? `Run stopped: ${mission.stop_reason || 'no progress across consecutive ticks'}.`
      : pauseReason
        ? `Run paused: ${pauseReason}.`
        : 'UNVERIFIED: run recorded but nothing was checked; treat this increment as unproven.';
  const tested = verifier
    ? missionVerifierHighLevelTestText(verifier, mission)
    : mission.verifier
      ? `Verifier was configured but not completed: ${mission.verifier}.`
      : 'No verifier command was recorded for this mission.';
  const nextLine = missionRunCreatedNextLine(createdNext, continuationGoal, mission);
  const lines = [
    'Landing:',
    `  Changed: ${changed}`,
    `  Why it matters: ${reason}`,
    ...(missionBudgetLine(mission) ? [`  Budget: ${missionBudgetLine(mission)}`] : []),
    `  How I checked: ${checked}`,
    `  What I tested: ${tested}`,
    `  Proof: Summary receipt saved at ${finalReceipt}.`,
    ...(missionBlockerReceiptLine(blocker) ? [`  ${missionBlockerReceiptLine(blocker)}`] : []),
    `  Timeline: ${missionRunTimelineCommand(mission)}`,
    `  Export: ${missionRunExportCommand(mission)}`,
    `  Prune preview: ${missionRunPrunePreviewCommand(mission)}`,
    `  Next: ${nextLine}`,
  ];
  return lines;
}

function renderMissionStatus(root = process.cwd()) {
  const paths = statePaths(root);
  const missions = listMissions(root);
  fs.mkdirSync(path.dirname(paths.statusNow), { recursive: true });
  const active = missions.filter((mission) => !TERMINAL_STATUSES.has(mission.status));
  const lines = [
    '# Now',
    '',
    '## Missions',
    '',
  ];
  if (!missions.length) {
    lines.push('No missions yet.', '');
  } else {
    for (const mission of missions.slice(0, 12)) {
      const view = missionStatusView(mission);
      const taskSpine = view.task_spine || missionTaskSpine(view);
      const label = missionLabel(view);
      const objective = String(view.objective || '').trim();
      // short objectives ARE their own label; repeating them reads as a stutter
      lines.push(label.toLowerCase() === objective.toLowerCase()
        ? `- **${label}**`
        : `- **${label}** ${objective}`);
      lines.push(`  - owner: ${view.owner}`);
      lines.push(`  - state: ${missionHumanStatusText(view)}`);
      lines.push(`  - next: ${missionDisplayText(view, view.next_action || 'tick or verify')}`);
      if (taskSpine?.task_ref) lines.push(`  - task: ${taskSpine.task_ref}`);
      if (taskSpine?.current_step_command) lines.push(`  - task next: ${missionDisplayText(view, taskSpine.current_step_command)}`);
      if (taskSpine && !taskSpine.has_task && taskSpine.ensure_task_command) lines.push(`  - task setup: ${missionDisplayText(view, taskSpine.ensure_task_command)}`);
      if (view.xp_task?.ref) lines.push(`  - AgentXP task: ${view.xp_task.ref}`);
      if (view.proof_needed) lines.push(`  - proof needed: ${view.proof_needed}`);
      if (view.receipt_path) lines.push(`  - proof: ${missionStatusProofText(view)}`);
      const gateLabel = completionGateLabel(view.completion_gate);
      if (gateLabel) lines.push(`  - gate: ${gateLabel}`);
    }
    lines.push('');
  }
  lines.push(`Active missions: ${active.length}`);
  lines.push('');
  fs.writeFileSync(paths.statusNow, lines.join('\n'), 'utf8');
  return paths.statusNow;
}

function missionXpTaskRefFromMission(mission) {
  if (mission?.xp_task?.ref) return mission.xp_task.ref;
  if (mission?.xp_task_enabled && mission?.task_ids?.[0]) return mission.task_ids[0];
  return '';
}

function missionRequiresZeroPapercutEndToEnd(mission) {
  const text = [
    mission?.objective,
    mission?.stop_condition,
    mission?.next_action,
    mission?.xp_task?.title,
  ].filter(Boolean).join(' ');
  return Boolean(mission?.xp_task_enabled || mission?.xp_task || missionXpTaskRefFromMission(mission))
    && /\b(?:golden[- ]path|zero[- ]knowledge|zero\s+new\s+papercuts?|fresh[- ]environment|fresh[- ]laptop|self[- ]landed)\b/i.test(text);
}

function missionProofPlaceholder(mission) {
  return missionRequiresZeroPapercutEndToEnd(mission)
    ? '<zero-papercut end-to-end receipt>'
    : '<proof>';
}

function resolveMissionOwner(mission, root = process.cwd()) {
  const requestedOwner = mission?.owner || process.env.ATRIS_AGENT_ID || 'mission-lead';
  const resolved = resolveFunctionalOwner({
    requestedOwner,
    title: mission?.objective || '',
    tag: mission?.lane || 'mission',
    note: mission?.next_action || '',
    goal: mission?.objective || '',
    root,
    fallbackOwners: ['mission-lead', 'task-planner', 'architect', 'validator'],
  });
  const requested = mission?.requested_owner || (
    resolved.requested_owner && resolved.requested_owner !== resolved.owner ? resolved.requested_owner : null
  );
  return {
    ...resolved,
    reason: mission?.owner_resolution || resolved.reason,
    requested_owner: requested,
    executed_by: mission?.executed_by || resolved.executed_by || null,
  };
}

function applyMissionOwnerResolution(mission, root = process.cwd()) {
  const ownerResolution = resolveMissionOwner(mission, root);
  const next = {
    ...mission,
    owner: ownerResolution.owner,
    owner_resolution: ownerResolution.reason,
  };
  if (ownerResolution.requested_owner && ownerResolution.requested_owner !== ownerResolution.owner) {
    next.requested_owner = ownerResolution.requested_owner;
  }
  if (ownerResolution.executed_by) {
    next.executed_by = normalizeOwnerSlug(ownerResolution.executed_by);
  }
  if (ownerResolution.proposed_member) {
    next.proposed_member = ownerResolution.proposed_member;
  }
  return { mission: next, ownerResolution };
}

function missionXpReadyAction(mission, receiptPath) {
  const ref = missionXpTaskRefFromMission(mission);
  if (!ref || !receiptPath) return null;
  const owner = resolveMissionOwner(mission).owner;
  return `queue AgentXP review: atris task current-step --goal-id ${mission.id} --as ${owner} --proof "${missionProofPlaceholder(mission)}" --json`;
}

function missionTaskSpine(mission) {
  if (!mission || !mission.id) return null;
  const ownerResolution = resolveMissionOwner(mission);
  const taskIds = Array.isArray(mission.task_ids) ? mission.task_ids.filter(Boolean) : [];
  const taskId = mission.xp_task?.task_id
    || mission.current_task_id
    || mission.task_id
    || taskIds[0]
    || null;
  const taskRef = mission.xp_task?.ref
    || mission.task_ref
    || (taskId ? String(taskId) : null);
  const taskScopeRef = mission.task_scope_ref || mission.id;
  const owner = ownerResolution.owner;
  return {
    schema: 'atris.mission_task_spine.v1',
    goal_id: mission.id,
    owner,
    requested_owner: ownerResolution.requested_owner || null,
    owner_resolution: ownerResolution.reason,
    executed_by: ownerResolution.executed_by ? normalizeOwnerSlug(ownerResolution.executed_by) : null,
    lane: mission.lane || 'workspace',
    runner: mission.runner || 'manual',
    task_id: taskId,
    current_task_id: taskId,
    task_ref: taskRef,
    has_task: Boolean(taskId || taskRef),
    current_step_command: taskId || taskRef
      ? `atris task current-step --goal-id ${taskScopeRef} --as ${owner} --proof "${missionProofPlaceholder(mission)}" --json`
      : null,
    ensure_task_command: taskId || taskRef
      ? null
      : `atris mission attach-task ${mission.id} --json`,
  };
}

function missionStatusView(mission) {
  const taskSpine = missionTaskSpine(mission);
  if (!taskSpine) return mission;
  const needsEndToEndProof = missionRequiresZeroPapercutEndToEnd(mission);
  const budgetContinuation = missionBudgetContinuationText(mission);
  const safeNextAction = budgetContinuation
    || (needsEndToEndProof && /^queue AgentXP review:/i.test(String(mission.next_action || ''))
      ? missionXpReadyAction(mission, mission.receipt_path) || mission.next_action
      : mission.next_action);
  const visibleTaskSpine = budgetContinuation
    ? { ...taskSpine, current_step_command: null }
    : taskSpine;
  const lastLanding = missionLastLanding(mission);
  const visibleLastLanding = budgetContinuation && lastLanding
    ? { ...lastLanding, next: budgetContinuation }
    : lastLanding;
  const requestedOwner = taskSpine.requested_owner
    || mission.requested_owner
    || (mission.owner && mission.owner !== taskSpine.owner ? mission.owner : null);
  return {
    ...mission,
    owner: taskSpine.owner,
    next_action: safeNextAction,
    proof_needed: needsEndToEndProof
      ? 'zero-papercut end-to-end fresh-laptop receipt; latest mission/tick receipt alone is not enough'
      : mission.proof_needed || null,
    functional_owner: taskSpine.owner,
    requested_owner: requestedOwner,
    owner_resolution: taskSpine.owner_resolution,
    executed_by: taskSpine.executed_by || mission.executed_by || null,
    goal_id: taskSpine.goal_id,
    task_id: taskSpine.task_id,
    current_task_id: taskSpine.current_task_id,
    task_ref: taskSpine.task_ref,
    task_spine: visibleTaskSpine,
    last_landing: visibleLastLanding,
  };
}

function missionFromArgs(args) {
  const objectiveParts = stripKnownFlags(args, [
    '--owner',
    '--cadence',
    '--loop',
    '--runner',
    '--lane',
    '--verify',
    '--stop',
    '--max-wall',
    '--max-ticks',
    '--minutes',
    '--hours',
    '--budget',
    '--base',
    '--task',
    '--ask',
    '--model',
    '--native-goal-status',
    '--native-goal-objective',
    '--visible-goal-status',
    '--visible-goal-objective',
  ], ['--json', '--always-on', '--xp-task', '--agent-xp', '--worktree', '--duplicate', '--no-verify', '--spend-full-budget', '--use-whole-budget', '--stop-when-done', '--preflight', '--no-preflight', '--room-preflight', '--no-room-preflight', '--manual-ack', '--allow-native-goal-supersede', '--supersede-paused-native-goal', '--take-goal-slot'])
    .filter((part) => String(part || '').trim() !== '...');
  const objective = objectiveParts.join(' ').trim();
  if (!objective) {
    exitMissionError('Usage: atris mission start "<objective>" --owner <member> [--verify "..."] [--cadence manual] [--worktree]', 1, wantsJson(args));
  }
  const budgetTier = readMissionBudgetTier(args, { json: wantsJson(args) });
  const budgetContract = inferRunObjectiveBudgetContract(objective, args);
  const maxTicksOverride = readPositiveIntegerFlag(args, '--max-ticks', null, { json: wantsJson(args) });
  const requestedOwner = readFlag(args, '--owner', process.env.ATRIS_AGENT_ID || 'mission-lead');
  const cadence = readFlag(args, '--cadence', readFlag(args, '--loop', 'manual')) || 'manual';
  const runnerSelection = resolveMissionRunnerSelection(readFlag(args, '--runner', 'manual'), { asJson: wantsJson(args), label: 'runner' });
  const runner = runnerSelection.runner;
  const model = readFlag(args, '--model', '') || (String(runner).toLowerCase() === 'atris2' ? 'atris:fast' : '');
  const lane = readFlag(args, '--lane', 'workspace');
  const ownerResolution = resolveFunctionalOwner({
    requestedOwner,
    title: objective,
    tag: lane,
    goal: objective,
    root: process.cwd(),
    fallbackOwners: ['mission-lead', 'task-planner', 'architect', 'validator'],
  });
  const owner = ownerResolution.owner;
  const verifier = readFlag(args, '--verify', '');
  assertMissionVerifier(verifier, wantsJson(args));
  const stopCondition = readFlag(args, '--stop', budgetStopCondition(budgetContract) || (verifier ? 'verifier passes and no human asks remain' : 'human marks complete with proof'));
  const taskIds = readRepeatedFlag(args, '--task');
  const humanAsks = readRepeatedFlag(args, '--ask');
  const alwaysOn = hasFlag(args, '--always-on');
  const xpTaskEnabled = hasFlag(args, '--xp-task') || hasFlag(args, '--agent-xp');
  const businessBinding = readBusinessBinding(process.cwd());
  const id = missionId(objective);
  const mission = {
    schema: 'atris.mission.v1',
    id,
    slug: slugify(objective),
    objective,
    owner,
    owner_resolution: ownerResolution.reason,
    ...(ownerResolution.requested_owner && ownerResolution.requested_owner !== owner ? { requested_owner: ownerResolution.requested_owner } : {}),
    ...(ownerResolution.executed_by ? { executed_by: normalizeOwnerSlug(ownerResolution.executed_by) } : {}),
    ...(ownerResolution.proposed_member ? { proposed_member: ownerResolution.proposed_member } : {}),
    status: 'planning',
    cadence,
    runner,
    runner_kind: runnerSelection.kind,
    ...(model ? { model } : {}),
    ...(businessBinding?.business_id ? { business_id: businessBinding.business_id } : {}),
    ...(businessBinding?.workspace_id ? { workspace_id: businessBinding.workspace_id } : {}),
    lane,
    verifier,
    always_on: alwaysOn,
    xp_task_enabled: xpTaskEnabled,
    stop_condition: stopCondition,
    task_ids: taskIds,
    human_asks: humanAsks,
    next_action: verifier ? 'run verifier with `atris mission tick <id> --verify`' : 'define verifier or run next task',
    receipt_path: null,
    created_at: stampIso(),
    updated_at: stampIso(),
  };
  if (budgetContract) {
    mission.budget_contract = budgetContract;
    if (budgetContract.requested_seconds) mission.max_wall_seconds = budgetContract.requested_seconds;
  }
  if (budgetTier || maxTicksOverride) {
    mission.max_ticks = maxTicksOverride || budgetTier.max_ticks;
  }
  if (alwaysOn) mission.next_action = nextCandidateTickAction(mission);
  return mission;
}

function applyMissionStartPatch(mission, patch) {
  if (!patch || typeof patch !== 'object') return mission;
  const { metadata, ...rest } = patch;
  Object.assign(mission, rest);
  if (metadata && typeof metadata === 'object') {
    mission.metadata = {
      ...(mission.metadata || {}),
      ...metadata,
    };
  }
  return mission;
}

function missingVerifierWarning(mission) {
  if (effectiveMissionVerifier(mission)) return null;
  return {
    code: 'missing_verifier',
    message: 'Mission has no verifier; it cannot complete automatically and future runs will report unverified worktree side effects.',
  };
}

function missionRunSmokeVerifier() {
  const script = [
    "const fs=require('fs')",
    "const os=require('os')",
    "const path=require('path')",
    "const {spawnSync}=require('child_process')",
    "const root=fs.mkdtempSync(path.join(os.tmpdir(),'atris-mission-run-verifier-'))",
    "process.on('exit',()=>fs.rmSync(root,{recursive:true,force:true}))",
    "fs.mkdirSync(path.join(root,'atris'),{recursive:true})",
    "const r=spawnSync('atris',['mission','run','verifier smoke objective','--json'],{cwd:root,encoding:'utf8',env:{...process.env,ATRIS_SKIP_UPDATE_CHECK:'1'}})",
    "if(r.status!==0){process.stderr.write(r.stderr||r.stdout);process.exit(1)}",
    "const p=JSON.parse(r.stdout)",
    "if(p.action!=='mission_run_started')process.exit(2)",
    "if(p.mission?.runner!=='codex_goal')process.exit(3)",
    "if(p.codex_goal_state?.goal?.visible_goal?.schema!=='atris.visible_chat_goal_bridge.v1')process.exit(4)",
    "if(p.requires_native_goal_start!==true)process.exit(5)",
    "if(p.native_goal_action?.tool!=='create_goal')process.exit(6)",
    "if(!/create_goal/.test(p.next_command||''))process.exit(7)",
  ].join(';');
  return `node -e ${JSON.stringify(script)}`;
}

function inferRunObjectiveVerifier(objective, root = process.cwd()) {
  const text = String(objective || '').toLowerCase();
  if (!/\bmission\s+run\b/.test(text)) return '';
  const sourceTest = path.join(root, 'test', 'mission-status.test.js');
  const sourceCommand = path.join(root, 'commands', 'mission.js');
  if (fs.existsSync(sourceTest) && fs.existsSync(sourceCommand)) {
    return 'node --test test/mission-status.test.js';
  }
  return missionRunSmokeVerifier();
}

function durationSecondsFromText(text) {
  const match = String(text || '').match(/\b(\d+(?:\.\d+)?)[-\s]*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\b/i);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = match[2].toLowerCase();
  if (/^d/.test(unit)) return Math.round(value * 86400);
  if (/^h/.test(unit)) return Math.round(value * 3600);
  if (/^m(?!s)/.test(unit)) return Math.round(value * 60);
  return Math.round(value);
}

function durationLabel(seconds, fallback = 'the requested time') {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  if (value % 86400 === 0) {
    const days = value / 86400;
    return `${days} day${days === 1 ? '' : 's'}`;
  }
  if (value % 3600 === 0) {
    const hours = value / 3600;
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  if (value % 60 === 0) {
    const minutes = value / 60;
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  }
  return `${value} second${value === 1 ? '' : 's'}`;
}

function readMissionBudgetTier(args = [], options = {}) {
  const raw = readFlag(args, '--budget', '');
  if (!raw) return null;
  const name = String(raw || '').trim().toLowerCase();
  const tier = MISSION_BUDGET_TIERS[name];
  if (!tier) {
    exitMissionError(`Unknown --budget "${raw}". Use quick, long, or deep.`, 2, options.json);
  }
  return { name, ...tier };
}

function wantsFullBudget(text, args = []) {
  if (hasFlag(args, '--spend-full-budget') || hasFlag(args, '--use-whole-budget')) return true;
  if (hasFlag(args, '--hours') || hasFlag(args, '--minutes')) return true;
  const compact = String(text || '').toLowerCase().replace(/\s+/g, ' ');
  const duration = '\\d+(?:\\.\\d+)?[-\\s]*(?:s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)';
  return /\b(use|spend)\s+(the\s+)?(whole|full|entire)\s+(time|budget|window)\b/.test(compact)
    || /\b(use|spend)\s+(the\s+)?(whole|full|entire)\s+\d/.test(compact)
    || new RegExp(`\\b(?:spend|use)\\s+${duration}\\b`).test(compact)
    || new RegExp(`(?:^|\\b)(?:run|work|think|research|investigate|brainstorm|plan|map|audit|explore|study|analyze|build)\\s+(?:[^.!?;]{0,80}\\s+)?for\\s+${duration}\\b`).test(compact)
    || new RegExp(`^\\s*for\\s+${duration}\\b`).test(compact)
    || /\bfor\s+the\s+(whole|full|entire)\s+/.test(compact)
    || /\bkeep\s+going\s+until\s+(time|the\s+time|budget|the\s+budget)\s+(is\s+)?(up|done|spent|used)\b/.test(compact)
    || /\b(run|work|stop|continue)\s+(until|till)\s+(the\s+)?(time|budget)\s+(is\s+)?(up|done|spent|used)\b/.test(compact);
}

function sleepLengthBudgetIntent(requestedSeconds, text = '') {
  const seconds = Number(requestedSeconds);
  return /\b(overnight|while\s+i\s+(?:sleep|am\s+sleeping|['’]?m\s+sleeping)|sleep(?:ing)?\s+run)\b/i.test(text)
    || (Number.isFinite(seconds) && seconds >= SLEEP_LENGTH_BUDGET_SECONDS);
}

function buildMissionBudgetContract(requestedSeconds, args = [], options = {}) {
  const seconds = Number(requestedSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const text = String(options.text || '');
  const budgetLabel = options.budgetLabel || durationLabel(seconds);
  const spendBudget = !hasFlag(args, '--stop-when-done')
    && (wantsFullBudget(text, args) || sleepLengthBudgetIntent(seconds, text));
  const policy = spendBudget
    ? 'spend_full_budget'
    : 'stop_when_done';
  const plainLanguage = policy === 'spend_full_budget'
    ? 'Use the whole time.'
    : 'Finish early if solved.';
  const stopRule = policy === 'spend_full_budget'
    ? `Use the whole ${budgetLabel}; keep picking the next useful move until time is up, unless blocked or unsafe.`
    : `Use up to ${budgetLabel}; stop early when the mission is done, proven, or blocked.`;
  return {
    schema: 'atris.mission_budget_contract.v1',
    requested_seconds: seconds,
    budget_label: budgetLabel,
    policy,
    plain_language: plainLanguage,
    stop_rule: stopRule,
    ...(options.budgetTier ? { budget_tier: options.budgetTier } : {}),
  };
}

function budgetContractFromTier(tier, args = []) {
  if (!tier) return null;
  return buildMissionBudgetContract(tier.requested_seconds, args, {
    text: `${tier.name} budget ${Array.isArray(args) ? args.join(' ') : ''}`,
    budgetLabel: durationLabel(tier.requested_seconds),
    budgetTier: tier.name,
  });
}

function inferRunObjectiveBudgetContract(objective, args = []) {
  const budgetTier = readMissionBudgetTier(args, { json: wantsJson(args) });
  if (budgetTier) return budgetContractFromTier(budgetTier, args);
  const text = `${objective || ''} ${Array.isArray(args) ? args.join(' ') : ''}`;
  const explicitHours = Number(readFlag(args, '--hours', ''));
  const explicitMinutes = Number(readFlag(args, '--minutes', ''));
  const explicitMaxWall = Number(readFlag(args, '--max-wall', ''));
  const explicitSeconds = Number.isFinite(explicitHours) && explicitHours > 0
    ? Math.round(explicitHours * 3600)
    : (Number.isFinite(explicitMinutes) && explicitMinutes > 0
      ? Math.round(explicitMinutes * 60)
      : (Number.isFinite(explicitMaxWall) && explicitMaxWall > 0 ? Math.round(explicitMaxWall) : null));
  const requestedSeconds = explicitSeconds || durationSecondsFromText(text);
  const overnight = /\bovernight\b/i.test(text);
  if (!requestedSeconds && !overnight) return null;
  const budgetLabel = requestedSeconds
    ? durationLabel(requestedSeconds)
    : 'the overnight window';
  if (!requestedSeconds) {
    const policy = hasFlag(args, '--stop-when-done') ? 'stop_when_done' : 'spend_full_budget';
    return {
      schema: 'atris.mission_budget_contract.v1',
      requested_seconds: requestedSeconds,
      budget_label: budgetLabel,
      policy,
      plain_language: policy === 'spend_full_budget' ? 'Use the whole time.' : 'Finish early if solved.',
      stop_rule: policy === 'spend_full_budget'
        ? `Use the whole ${budgetLabel}; keep picking the next useful move until time is up, unless blocked or unsafe.`
        : `Use up to ${budgetLabel}; stop early when the mission is done, proven, or blocked.`,
    };
  }
  return buildMissionBudgetContract(requestedSeconds, args, { text, budgetLabel });
}

function budgetStopCondition(contract) {
  if (!contract) return '';
  if (contract.policy === 'spend_full_budget') {
    return `run for ${contract.budget_label}; use the whole time unless blocked or unsafe`;
  }
  return `run for ${contract.budget_label}, or stop early when proof is strong enough`;
}

function inferRunObjectiveLoopOptions(objective, args = []) {
  const text = `${objective || ''} ${Array.isArray(args) ? args.join(' ') : ''}`;
  const hoursMatch = text.match(/\b(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours)\b/i);
  const requestedHours = hoursMatch ? Number(hoursMatch[1]) : null;
  const wantsLongRun = /\b(overnight|nonstop|forever|goal\s+after\s+goal|self[-\s]?improve)\b/i.test(text)
    || (Number.isFinite(requestedHours) && requestedHours > 0);
  if (!wantsLongRun) return { wantsLongRun: false, requestedHours: null, cadence: '' };
  return {
    wantsLongRun: true,
    requestedHours: Number.isFinite(requestedHours) && requestedHours > 0 ? requestedHours : null,
    cadence: readFlag(args, '--cadence', '13m'),
  };
}

function missionLongRunIntent(mission) {
  const text = `${mission?.objective || ''} ${mission?.stop_condition || ''}`;
  return Boolean(mission?.overnight_loop)
    || /\b(overnight|nonstop|forever|goal\s+after\s+goal|self[-\s]?improve)\b/i.test(text);
}

function missionChoosesNextMission(mission) {
  return mission?.started_from === 'mission_run_continuation'
    && mission?.continuation_policy === 'choose_next_mission';
}

function isConcreteContinuationTarget(title) {
  const text = String(title || '').trim();
  if (!text) return false;
  if (/^decide and start the next useful mission after:/i.test(text)) return false;
  if (/<next useful mission>/i.test(text)) return false;
  if (/^create the next proof-backed self-improvement task$/i.test(text)) return false;
  return true;
}

function continuationTargetKey(title) {
  return String(title || '')
    .replace(/^mission xp:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function handledContinuationTargetKeys(root, moves) {
  const keys = new Set();
  const add = (title) => {
    const key = continuationTargetKey(title);
    if (key) keys.add(key);
  };
  try {
    for (const title of moves.readHandledTaskTitles(root)) add(title);
  } catch {
    // Best-effort guard; mission state below still catches completed missions.
  }
  try {
    for (const row of listMissions(root)) {
      add(row.objective);
    }
  } catch {
    // If mission state is unreadable, fall back to the remaining explicit filters.
  }
  return keys;
}

function readTaskProjectionForMission(root = process.cwd()) {
  const file = path.join(root, '.atris', 'state', 'tasks.projection.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed?.tasks) ? parsed.tasks : [];
  } catch {
    return [];
  }
}

function taskTags(task) {
  return [
    task?.tag,
    ...(Array.isArray(task?.tags) ? task.tags : []),
    ...(Array.isArray(task?.metadata?.tags) ? task.metadata.tags : []),
  ]
    .filter(Boolean)
    .map((tag) => String(tag).trim().toLowerCase())
    .filter(Boolean);
}

function certifiedReviewNextTaskCandidates(root = process.cwd()) {
  return readTaskProjectionForMission(root)
    .filter((task) => String(task?.status || '').toLowerCase() === 'review')
    .filter((task) => task?.review?.agent_certified === true || task?.metadata?.agent_certified === true)
    .map((task) => ({
      title: task?.review?.next_task || task?.metadata?.latest_agent_next_task || '',
      why: `certified review ${task.display_id || task.id || ''} suggested this next task`.trim(),
      source: 'certified_review_next_task',
      ref: task.display_id || task.id || null,
      weight: 95,
    }))
    .filter((move) => String(move.title || '').trim());
}

function endgameBacklogCandidates(root = process.cwd()) {
  return readTaskProjectionForMission(root)
    .filter((task) => String(task?.status || '').toLowerCase() === 'open')
    .filter((task) => taskTags(task).includes('endgame'))
    .map((task) => ({
      title: String(task.title || '').trim(),
      why: `open endgame backlog task ${task.display_id || task.id || ''}`.trim(),
      source: 'endgame_backlog',
      ref: task.display_id || task.id || null,
      weight: 85,
    }))
    .filter((move) => move.title);
}

function cleanWikiNextIngestTitle(value) {
  return String(value || '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^[-*]\s*/, '')
    .replace(/^next[- ]?ingests?\s*:\s*/i, '')
    .replace(/^next source\s*:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?:;,]+$/g, '');
}

function wikiStatusNextIngestCandidates(root = process.cwd()) {
  const file = path.join(root, 'atris', 'wiki', 'STATUS.md');
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  let inSection = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^#+\s+next[- ]?ingests?\b/i.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^#+\s+/.test(line)) inSection = false;
    const direct = line.match(/^[-*]?\s*next[- ]?ingests?\s*:\s*(.+)$/i)
      || line.match(/^[-*]?\s*next source\s*:\s*(.+)$/i);
    if (direct) {
      const title = cleanWikiNextIngestTitle(direct[1]);
      if (title) out.push(title);
      continue;
    }
    if (inSection && /^[-*]\s+/.test(line)) {
      const title = cleanWikiNextIngestTitle(line);
      if (title) out.push(title);
    }
  }
  return out.map((title) => ({
    title: /^ingest\b/i.test(title) ? title : `Ingest ${title}`,
    why: 'wiki STATUS listed this as a next ingest',
    source: 'wiki_status_next_ingest',
    ref: 'atris/wiki/STATUS.md',
    weight: 70,
  }));
}

function missionExtraNextCandidates(root = process.cwd()) {
  return [
    ...certifiedReviewNextTaskCandidates(root),
    ...endgameBacklogCandidates(root),
    ...wikiStatusNextIngestCandidates(root),
  ];
}

function uniqueMissionCandidates(candidates) {
  const seen = new Set();
  const out = [];
  for (const candidate of candidates) {
    const key = continuationTargetKey(candidate?.title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
}

function trustedNextMissionSource(source) {
  return new Set([
    'certified_review_next_task',
    'endgame_backlog',
    'wiki_status_next_ingest',
    'mission_report',
  ]).has(String(source || ''));
}

function rejectNextMissionCandidate(move, context) {
  const title = String(move?.title || '').trim();
  if (!title) return 'empty title';
  if (context.moves.isGenericInboxPlaceholder(title)) return 'placeholder';
  if (!isConcreteContinuationTarget(title)) return 'not a concrete mission';
  const key = continuationTargetKey(title);
  if (context.handledTargets.has(key)) return 'already handled';
  if (context.currentObjective && title === context.currentObjective) return 'same as current objective';
  if (context.parentObjective && title === context.parentObjective) return 'same as parent objective';
  if (context.mission?.id && move?.ref === context.mission.id && title === context.currentObjective) return 'same as current mission';
  const preview = missionValuePreview(move, context.mission, context.root);
  const score = Number(preview?.score?.total || 0);
  move.value_preview = preview;
  if (score <= 0 && !trustedNextMissionSource(move.source)) return 'zero value score';
  return '';
}

function nearMissPreview(nearMisses) {
  if (!nearMisses.length) return null;
  return {
    schema: 'atris.next_mission_stop_preview.v1',
    stop_reason: 'no concrete follow-up mission found in Atris state',
    near_misses: nearMisses.slice(0, 3),
    feynman: {
      what: 'Atris found possible next moves, but none passed the mission filter.',
      why_now: 'Stopping is safer than spending tokens on fake or low-value work.',
      risk: 'A human may want to promote one near-miss manually.',
      validation: 'Review the near-miss reasons, then add a concrete next task if one should run.',
    },
  };
}

function chooseNextMissionAnalysis(mission, root = process.cwd()) {
  try {
    const moves = require('../lib/next-moves');
    const currentObjective = String(mission?.objective || '').trim();
    const parentObjective = String(mission?.parent_objective || '').trim();
    const handledTargets = handledContinuationTargetKeys(root, moves);
    const latestTarget = moves.latestSuggestedTarget(root);
    const reportCandidates = latestTarget
      ? [{
        title: latestTarget,
        why: 'latest proof timeline suggested this follow-up mission',
        source: 'mission_report',
        weight: 75,
      }]
      : [];
    const context = { mission, root, moves, currentObjective, parentObjective, handledTargets };
    const nearMisses = [];
    const candidates = uniqueMissionCandidates([
      ...missionExtraNextCandidates(root),
      ...reportCandidates,
      ...moves.nextMoves(root, 8),
    ])
      .filter((move) => {
        const reason = rejectNextMissionCandidate(move, context);
        if (reason) {
          nearMisses.push({
            title: String(move?.title || '').trim() || '(empty)',
            source: move?.source || null,
            ref: move?.ref || null,
            reason,
          });
          return false;
        }
        return true;
      })
      .sort((a, b) => {
        const aScore = Number(a.value_preview?.score?.total || 0);
        const bScore = Number(b.value_preview?.score?.total || 0);
        if (aScore !== bScore) return bScore - aScore;
        return Number(b.weight || 0) - Number(a.weight || 0);
      });
    return { target: candidates[0] || null, near_misses: nearMisses.slice(0, 3) };
  } catch {
    // Fall through to an explicit stop command; never emit the old placeholder.
  }
  return { target: null, near_misses: [] };
}

function chooseNextMissionTarget(mission, root = process.cwd()) {
  return chooseNextMissionAnalysis(mission, root).target;
}

function normalizeMissionOwner(value) {
  return String(value || '').trim().toLowerCase();
}

function readMissionMemberRole(owner, root = process.cwd()) {
  const dir = memberDir(owner, root);
  if (!dir) return '';
  try {
    const text = fs.readFileSync(path.join(dir, 'MEMBER.md'), 'utf8');
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) return '';
    const role = match[1].match(/^role:\s*(.+)$/im);
    return role ? role[1].replace(/^["']|["']$/g, '').trim() : '';
  } catch {
    return '';
  }
}

function missionTasteProfileForRole(role) {
  const text = String(role || '').toLowerCase();
  if (!text) return null;
  if (/\b(security|risk|trust|privacy|compliance|safety|safe|guard|inspector)\b/.test(text)) {
    return {
      id: 'security_guard',
      name: 'Security / trust',
      bias: 'Prefer work that prevents unsafe behavior, privacy mistakes, or quiet trust breaks.',
      role_reason: 'Member role says guard risk before spending tokens.',
    };
  }
  if (/\b(demo|reliability|ux|usability|support|operator|launcher|customer|growth|onboarding)\b/.test(text)) {
    return {
      id: 'usability_operator',
      name: 'Usability / demo',
      bias: 'Prefer work that makes the product easier, faster, clearer, or more demo-ready.',
      role_reason: 'Member role says optimize usability before spending tokens.',
    };
  }
  if (/\b(technical|engineer|architect|research|improver|runtime|compiler|infra|backend|agent|model)\b/.test(text)) {
    return {
      id: 'technical_homerun',
      name: 'Technical homerun',
      bias: 'Prefer technical leaps, but require a usability or proof gate before spending serious tokens.',
      role_reason: 'Member role says chase validated technical homeruns.',
    };
  }
  return null;
}

function missionOwnerTasteProfile(owner) {
  const key = normalizeMissionOwner(owner);
  if (/\b(security|sync-inspector|proof-inspector|validator)\b/.test(key)) {
    return {
      id: 'security_guard',
      name: 'Security / trust',
      bias: 'Prefer work that prevents unsafe behavior, privacy mistakes, or quiet trust breaks.',
    };
  }
  if (/\b(researcher|architect|improver|auto-improver|problem-solver|objective-generator)\b/.test(key)) {
    return {
      id: 'technical_homerun',
      name: 'Technical homerun',
      bias: 'Prefer technical leaps, but require a usability or proof gate before spending serious tokens.',
    };
  }
  return {
    id: 'usability_operator',
    name: 'Usability / demo',
    bias: 'Prefer work that makes the product easier, faster, clearer, or more demo-ready.',
  };
}

function missionMemberTasteProfile(owner, root = process.cwd()) {
  const role = readMissionMemberRole(owner, root);
  const roleProfile = missionTasteProfileForRole(role);
  const profile = roleProfile || missionOwnerTasteProfile(owner);
  return {
    ...profile,
    role: role || null,
    role_source: roleProfile ? `atris/team/${normalizeMissionOwner(owner)}/MEMBER.md` : null,
    role_reason: roleProfile?.role_reason || null,
  };
}

function missionValueSignals(title) {
  const text = String(title || '').toLowerCase();
  const signals = [];
  const add = (id, label, pattern) => {
    if (pattern.test(text)) signals.push({ id, label });
  };
  add('usability', 'simplifies use', /\b(simple|simplify|previews?|clear|plain|feynman|demos?|onboarding|ux|workflow|usable|understand)\b/);
  add('speed', 'speeds the process', /\b(speed|fast|faster|latency|token|waste|friction|shortcut|automation|auto)\b/);
  add('users_revenue', 'can help users or revenue', /\b(user|users|customer|revenue|payment|checkout|pricing|conversion|retention|demo)\b/);
  add('trust', 'protects trust', /\b(security|safe|safety|trust|permission|approval|auth|privacy|gmail|email|connector|leak|isolation)\b/);
  add('technical', 'technical advancement', /\b(agent|ax|connector|isolation|research|benchmark|model|compiler|runtime|architecture|rl|experiment)\b/);
  add('freshness', 'keeps workflow current', /\b(up[- ]?to[- ]?date|fresh|sync|stale|current|latest)\b/);
  return signals;
}

function missionTasteSnippet(value, max = 180) {
  const text = String(value || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/[`*_#>]+/g, '')
    .replace(/^[-\d.()[\]\s]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 3).trim()}...` : text;
}

function missionTasteSnippets(text, limit = 4) {
  const tastePattern = /\b(plain|jargon|feynman|understand|simple|clarify|clarity|proof|receipt|verify|verified|checked|tested|accept|approval|runway|revenue|cash|user|customer|demo|technical|homerun|security|trust|privacy|logs|working memory|recent|speed|token|waste|simplify)\b/i;
  const snippets = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const snippet = missionTasteSnippet(line);
    if (!snippet || !tastePattern.test(snippet)) continue;
    snippets.push(snippet);
  }
  return snippets.slice(-limit);
}

function readTextFile(root, relativePath) {
  const file = path.join(root, ...relativePath.split('/'));
  try {
    return { path: relativePath, present: true, text: fs.readFileSync(file, 'utf8') };
  } catch {
    return { path: relativePath, present: false, text: '' };
  }
}

function recentMarkdownFiles(dir, limit = 2) {
  const files = [];
  try {
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        for (const child of recentMarkdownFiles(full, limit * 4)) files.push(child);
      } else if (/\.md$/i.test(entry)) {
        files.push(full);
      }
    }
  } catch {
    return [];
  }
  return files
    .sort((a, b) => {
      const aBase = path.basename(a);
      const bBase = path.basename(b);
      if (aBase !== bBase) return aBase.localeCompare(bBase);
      return a.localeCompare(b);
    })
    .slice(-limit);
}

function readRecentTasteLogs(root, owner, limit = 3) {
  const logFiles = [
    ...recentMarkdownFiles(path.join(root, 'atris', 'logs'), 2),
    ...recentMarkdownFiles(path.join(root, 'atris', 'team', owner || '', 'logs'), 2),
  ];
  const seen = new Set();
  return logFiles
    .filter((file) => {
      const key = path.resolve(file);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(-limit)
    .map((file) => {
      let text = '';
      try { text = fs.readFileSync(file, 'utf8'); } catch { text = ''; }
      return {
        path: path.relative(root, file),
        snippets: missionTasteSnippets(text, 3),
      };
    })
    .filter((entry) => entry.snippets.length);
}

function readTasteReviewHistory(root, limit = 4) {
  const file = path.join(root, '.atris', 'state', 'tasks.projection.json');
  let projection = null;
  try { projection = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { projection = null; }
  const tasks = Array.isArray(projection?.tasks) ? projection.tasks : [];
  const accepted = [];
  const revised = [];
  const sorted = tasks
    .filter(Boolean)
    .sort((a, b) => Number(b.updated_at || 0) - Number(a.updated_at || 0));
  for (const task of sorted) {
    const title = missionTasteSnippet(task.title, 120);
    for (const event of Array.isArray(task.events) ? task.events : []) {
      const type = String(event?.event_type || '');
      const payload = event?.payload || {};
      if ((type === 'accepted' || (type === 'reviewed' && Number(payload.reward || 0) > 0)) && accepted.length < limit) {
        accepted.push(missionTasteSnippet(`${title}: ${payload.proof || payload.note || 'accepted'}`));
      }
      if (type === 'revision_requested' && revised.length < limit) {
        revised.push(missionTasteSnippet(`${title}: ${payload.note || 'revision requested'}`));
      }
    }
  }
  return { accepted, revised };
}

function missionTasteMemorySignals(text) {
  const definitions = [
    ['plain_language', 'Keshav asks for plain English', /\b(plain|jargon|feynman|understand|simple|clarify|clarity)\b/i],
    ['proof_gate', 'Keshav wants proof before accept', /\b(proof|receipt|verify|verified|checked|tested|accept|approval)\b/i],
    ['runway_revenue', 'runway pushes user or revenue work', /\b(runway|revenue|cash|user|users|customer|demo|adoption|retention)\b/i],
    ['technical_ambition', 'technical advancement still matters', /\b(technical|homerun|research|runtime|architecture|model|benchmark|agent)\b/i],
    ['trust_boundary', 'trust and approval boundaries matter', /\b(security|safe|safety|trust|privacy|approval|permission|gmail|email|connector)\b/i],
    ['working_memory', 'recent logs are working memory', /\b(logs?|working memory|recent|today|now)\b/i],
    ['speed_token', 'avoid wasted time and tokens', /\b(speed|fast|faster|token|waste|friction|simplify)\b/i],
  ];
  return definitions
    .filter(([, , pattern]) => pattern.test(text))
    .map(([id, label]) => ({ id, label }));
}

function readMissionTasteMemory(root = process.cwd(), owner = '') {
  const safeOwner = normalizeMissionOwner(owner || process.env.ATRIS_AGENT_ID || 'mission-lead') || 'mission-lead';
  const thinking = readTextFile(root, 'atris/thinking.md');
  const memberMission = readTextFile(root, `atris/team/${safeOwner}/MISSION.md`);
  const recentLogs = readRecentTasteLogs(root, safeOwner);
  const taskHistory = readTasteReviewHistory(root);
  const thinkingSnippets = missionTasteSnippets(thinking.text, 5);
  const memberMissionSnippets = missionTasteSnippets(memberMission.text, 5);
  const allText = [
    ...thinkingSnippets,
    ...memberMissionSnippets,
    ...recentLogs.flatMap((entry) => entry.snippets),
    ...taskHistory.accepted,
    ...taskHistory.revised,
  ].join('\n');
  const signals = missionTasteMemorySignals(allText);
  return {
    schema: 'atris.mission_taste_memory.v1',
    owner: safeOwner,
    sources: {
      thinking_md: {
        path: thinking.path,
        present: thinking.present,
        snippets: thinkingSnippets,
      },
      member_mission: {
        path: memberMission.path,
        present: memberMission.present,
        snippets: memberMissionSnippets,
      },
      recent_logs: recentLogs,
      task_history: taskHistory,
    },
    signals,
  };
}

function missionTasteMemoryBoost(signals, tasteMemory, profile) {
  const candidateIds = new Set((signals || []).map((signal) => signal.id));
  const memoryIds = new Set((tasteMemory?.signals || []).map((signal) => signal.id));
  const hasCandidate = (id) => candidateIds.has(id) ? 1 : 0;
  const hasMemory = (id) => memoryIds.has(id);
  let boost = 0;
  if (hasMemory('plain_language')) boost += hasCandidate('usability') * 2;
  if (hasMemory('proof_gate')) boost += (hasCandidate('trust') || hasCandidate('usability') || hasCandidate('technical')) ? 1 : 0;
  if (hasMemory('runway_revenue')) boost += hasCandidate('users_revenue') * 3;
  if (hasMemory('technical_ambition')) boost += profile.id === 'technical_homerun' ? hasCandidate('technical') * 2 : hasCandidate('technical');
  if (hasMemory('trust_boundary')) boost += hasCandidate('trust') * 2;
  if (hasMemory('working_memory')) boost += (hasCandidate('freshness') || hasCandidate('speed')) ? 1 : 0;
  if (hasMemory('speed_token')) boost += hasCandidate('speed') * 2;
  return boost;
}

function missionValueScore(signals, profile, tasteMemory = null) {
  const ids = new Set((signals || []).map((signal) => signal.id));
  const has = (id) => ids.has(id) ? 1 : 0;
  const base = has('usability') + has('speed') + has('users_revenue') + has('trust') + has('freshness');
  let profileBoost = 0;
  if (profile.id === 'technical_homerun') profileBoost = (has('technical') * 2) + has('trust') + has('speed');
  else if (profile.id === 'security_guard') profileBoost = (has('trust') * 3) + has('freshness');
  else profileBoost = (has('usability') * 2) + has('speed') + has('users_revenue');
  const memoryBoost = missionTasteMemoryBoost(signals, tasteMemory, profile);
  return {
    total: base + profileBoost + memoryBoost,
    signals: Array.from(ids),
    memory_boost: memoryBoost,
  };
}

function missionPlainTaskPreview(title) {
  const text = String(title || '').replace(/\s+/g, ' ').trim();
  if (!text) return 'Do one concrete useful thing.';
  if (/ax\b/i.test(text) && /gmail/i.test(text) && /turn isolation/i.test(text)) {
    return 'Make ax safer with Gmail: keep each chat request separate, and show a clear preview or receipt before Gmail actions.';
  }
  const cleaned = text
    .replace(/^mission xp:\s*/i, '')
    .replace(/^ship\s+/i, '')
    .replace(/\bturn isolation\b/ig, 'separate chat requests')
    .replace(/\breceipt previews?\b/ig, 'clear before/after receipts')
    .replace(/\bconnector\b/ig, 'connected-app path');
  return `${cleaned.charAt(0).toUpperCase()}${cleaned.slice(1)}`.replace(/[.!?:;,]+$/g, '') + '.';
}

function missionTasteMemoryReason(tasteMemory, signals) {
  const candidateIds = new Set((signals || []).map((signal) => signal.id));
  const memoryIds = new Set((tasteMemory?.signals || []).map((signal) => signal.id));
  if (memoryIds.has('runway_revenue') && candidateIds.has('users_revenue')) return 'Keshav has been steering toward user/revenue proof because runway is tight.';
  if (memoryIds.has('plain_language') && candidateIds.has('usability')) return 'Keshav keeps asking for plain-English, understandable work.';
  if (memoryIds.has('proof_gate') && (candidateIds.has('trust') || candidateIds.has('technical'))) return 'Keshav wants proof and receipts before serious work is accepted.';
  if (memoryIds.has('working_memory')) return 'Recent logs are being used as working memory for what matters now.';
  if (memoryIds.has('technical_ambition') && candidateIds.has('technical')) return 'The member memory still values technical advancement when it has proof.';
  return '';
}

function missionPreviewWhyNow(move, profile, signals, tasteMemory = null) {
  const ids = new Set((signals || []).map((signal) => signal.id));
  const roleReason = profile?.role_reason ? `${profile.role_reason} ` : '';
  let base = '';
  if (profile.id === 'technical_homerun') {
    base = ids.has('technical')
      ? 'This is a technical bet; run it only because it can make the product stronger without making the user think harder.'
      : 'This is not a technical homerun on its face, so it needs clear usability proof before it should win.';
  } else if (profile.id === 'security_guard') {
    base = ids.has('trust')
      ? 'This matters because trust failures are expensive and should be blocked before users feel them.'
      : 'This is not mainly security work, so it should only run if the current trust queue is quiet.';
  } else if (ids.has('users_revenue')) {
    base = 'This matters now because it can help demos, users, retention, or revenue.';
  } else if (ids.has('usability') || ids.has('speed')) {
    base = 'This matters now because it can make the product easier or faster to use.';
  } else {
    base = move?.why || 'This needs a clear reason before it should spend serious tokens.';
  }
  const memoryReason = missionTasteMemoryReason(tasteMemory, signals);
  return memoryReason ? `${roleReason}${base} Taste memory says: ${memoryReason}` : `${roleReason}${base}`;
}

function missionPreviewRisk(signals) {
  const ids = new Set((signals || []).map((signal) => signal.id));
  if (ids.has('technical') && !ids.has('usability')) return 'Risk: it becomes clever infrastructure that does not make the product easier.';
  if (ids.has('trust')) return 'Risk: changing connected-tool behavior can hide or create approval/privacy mistakes.';
  return 'Risk: it adds complexity without a visible product win.';
}

function missionPreviewValidation(signals) {
  const ids = new Set((signals || []).map((signal) => signal.id));
  if (ids.has('trust')) return 'Validate with a before/after receipt and a test proving unsafe state does not carry across turns.';
  if (ids.has('users_revenue')) return 'Validate with a customer-visible proof: demo path, signup/payment path, or retention signal.';
  if (ids.has('technical')) return 'Validate with a small benchmark, regression test, or artifact that proves the technical bet helped.';
  return 'Validate with a simple before/after check that a human can understand.';
}

function missionValuePreview(move, mission, root = process.cwd()) {
  const profile = missionMemberTasteProfile(mission?.owner, root);
  const signals = missionValueSignals(move?.title);
  const tasteMemory = readMissionTasteMemory(root, mission?.owner);
  const score = missionValueScore(signals, profile, tasteMemory);
  return {
    schema: 'atris.mission_value_preview.v1',
    member: mission?.owner || null,
    profile,
    candidate: {
      title: move?.title || '',
      source: move?.source || null,
      ref: move?.ref || null,
    },
    feynman: {
      what: missionPlainTaskPreview(move?.title),
      why_now: missionPreviewWhyNow(move, profile, signals, tasteMemory),
      risk: missionPreviewRisk(signals),
      validation: missionPreviewValidation(signals),
      taste: missionTasteMemoryReason(tasteMemory, signals) || 'No live taste memory matched this candidate yet.',
    },
    value_signals: signals,
    taste_memory: tasteMemory,
    score,
  };
}

function resumableActiveMissions(mission, root = process.cwd()) {
  const selfId = String(mission?.id || '');
  const parentId = String(mission?.parent_mission_id || '');
  try {
    // Only planning missions resume: ready missions wait for human review, and
    // running missions already have an actor.
    return listMissions(root).filter((row) => {
      if (!row || row.status !== 'planning') return false;
      if (row.id === selfId || row.id === parentId) return false;
      if (String(row.started_from || '') === 'mission_run_continuation') return false;
      if (!isConcreteContinuationTarget(row.objective)) return false;
      return true;
    });
  } catch {
    return [];
  }
}

function chooseResumeMissionPlan(mission, nearMisses, root = process.cwd()) {
  const ranked = resumableActiveMissions(mission, root)
    .map((row) => ({
      row,
      preview: missionValuePreview({ title: row.objective, source: 'resume_active_mission', ref: row.id }, mission, root),
    }))
    .sort((a, b) => {
      const aScore = Number(a.preview?.score?.total || 0);
      const bScore = Number(b.preview?.score?.total || 0);
      if (aScore !== bScore) return bScore - aScore;
      return String(b.row.updated_at || '').localeCompare(String(a.row.updated_at || ''));
    });
  const best = ranked[0];
  if (!best) return null;
  return {
    target: {
      title: best.row.objective,
      source: 'resume_active_mission',
      ref: best.row.id,
      value_preview: best.preview,
    },
    command: `atris mission run ${best.row.id} --json`,
    preview: {
      schema: 'atris.next_mission_resume_preview.v1',
      resume_mission_id: best.row.id,
      resume_objective: best.row.objective,
      resume_status: best.row.status,
      resume_owner: best.row.owner || null,
      near_misses: nearMisses.slice(0, 3),
      feynman: {
        what: 'Every new candidate is already tracked, and one active mission is still in planning.',
        why_now: 'Resuming chosen work beats stopping when real work is already on the board.',
        risk: 'The resumed mission may deserve a fresher objective; stop it if it no longer matters.',
        validation: 'Run the resume command, then check the mission landing and receipt.',
      },
    },
  };
}

function chooseNextMissionPlan(mission, root = process.cwd()) {
  const owner = mission?.owner || process.env.ATRIS_AGENT_ID || 'mission-lead';
  const analysis = chooseNextMissionAnalysis(mission, root);
  const target = analysis.target;
  if (target?.title) {
    return {
      target,
      command: `atris mission run ${shellQuote(target.title)} --owner ${owner}`,
      preview: target.value_preview || missionValuePreview(target, mission, root),
    };
  }
  const resume = chooseResumeMissionPlan(mission, analysis.near_misses || [], root);
  if (resume) return resume;
  const missionId = mission?.id || '<mission-id>';
  return {
    target: null,
    command: `atris mission stop ${missionId} --reason ${shellQuote('no concrete follow-up mission found in Atris state')} --json`,
    preview: nearMissPreview(analysis.near_misses || []),
  };
}

function chooseNextMissionCommand(mission, root = process.cwd()) {
  return chooseNextMissionPlan(mission, root).command;
}

function chooseNextMissionPreview(mission, root = process.cwd()) {
  return chooseNextMissionPlan(mission, root).preview;
}

function effectiveMissionVerifier(mission) {
  const explicit = String(mission?.verifier || '').trim();
  if (explicit) return explicit;
  if (missionChoosesNextMission(mission)) return '';
  const runner = String(mission?.runner || '').trim().toLowerCase();
  if (missionLongRunIntent(mission) && (!runner || runner === 'codex_goal')) {
    return DEFAULT_LONG_RUN_VERIFIER;
  }
  return '';
}

function markMissionRunContinuation(mission) {
  return {
    ...mission,
    started_from: 'mission_run_objective',
    continue_on_complete: true,
    continuation_policy: 'decide_and_start_next_useful_mission',
  };
}

function continuationObjective(parent) {
  return `Decide and start the next useful mission after: ${parent.objective}`;
}

function findActiveContinuationMission(parent, root = process.cwd()) {
  return listMissions(root).find((mission) => (
    mission.parent_mission_id === parent.id
    && mission.started_from === 'mission_run_continuation'
    && !TERMINAL_STATUSES.has(mission.status)
  )) || null;
}

function findActiveMissionRunContinuation(root = process.cwd(), excludeId = '') {
  const excluded = String(excludeId || '');
  const candidates = listMissions(root)
    .filter((mission) => (
      mission.id !== excluded
      && mission.started_from === 'mission_run_continuation'
      && mission.continuation_policy === 'choose_next_mission'
      && !TERMINAL_STATUSES.has(mission.status)
    ));
  candidates.sort((a, b) => missionSortTime(b) - missionSortTime(a));
  return candidates[0] || null;
}

function completeActiveContinuationForStartedMission(nextMission, root = process.cwd()) {
  const continuation = findActiveMissionRunContinuation(root, nextMission?.id);
  if (!continuation || !nextMission) return null;
  if (continuation.objective === nextMission.objective) return null;

  const proof = `Started next mission ${nextMission.id}: ${nextMission.objective}`;
  const completionGate = { ok: true, source: 'mission_run_continuation', forced: false };
  const baseNext = {
    ...continuation,
    status: 'complete',
    completed_at: stampIso(),
    proof,
    completion_gate: completionGate,
    continued_by_mission_id: nextMission.id,
    continued_by_objective: nextMission.objective,
    next_action: 'mission complete',
  };
  const completion = missionCompletionReceipt(baseNext, proof);
  const { mission: saved } = saveMission({
    ...baseNext,
    landing: completion.landing,
    result: completion.result,
  }, root, 'mission_continuation_completed', {
    proof,
    continued_by_mission_id: nextMission.id,
    continued_by_objective: nextMission.objective,
  });
  appendMemberLog(saved.owner, 'Mission continuation completed', {
    mission: saved.objective,
    continued_by: nextMission.id,
    proof,
  }, root);
  return {
    completed: true,
    mission: saved,
    continued_by: {
      mission_id: nextMission.id,
      objective: nextMission.objective,
    },
  };
}

function missionCanSeedContinuation(parent) {
  if (!parent) return false;
  if (parent.status === 'complete') return true;
  return GOAL_LOOP_STATUSES.has(String(parent.status || '')) && missionTaskHumanAcceptWaiting(parent);
}

function seedMissionRunContinuation(parent, root = process.cwd(), proof = '') {
  if (!missionCanSeedContinuation(parent)) return null;
  if (parent.continue_on_complete !== true) return null;
  if (parent.continuation_seeded_mission_id) {
    const seeded = resolveMission(parent.continuation_seeded_mission_id, root);
    if (seeded && TERMINAL_STATUSES.has(String(seeded.status || '')) && seeded.continued_by_mission_id) {
      return {
        inserted: false,
        reason: 'already_continued',
        mission_id: parent.continuation_seeded_mission_id,
        mission: null,
        continued_by_mission_id: seeded.continued_by_mission_id,
      };
    }
    return {
      inserted: false,
      reason: 'already_seeded',
      mission_id: parent.continuation_seeded_mission_id,
      mission: seeded || null,
    };
  }

  const existing = findActiveContinuationMission(parent, root);
  if (existing) return { inserted: false, reason: 'active_continuation_exists', mission: existing };

  const owner = parent.owner || process.env.ATRIS_AGENT_ID || 'mission-lead';
  const objective = continuationObjective(parent);
  const parentRunner = String(parent.runner || '').trim().toLowerCase();
  const continuationRunner = parentRunner === 'atris2' ? 'atris2' : 'codex_goal';
  const mission = missionFromArgs([
    objective,
    '--owner',
    owner,
    '--runner',
    continuationRunner,
    '--lane',
    parent.lane || 'workspace',
    '--cadence',
    'manual',
    '--stop',
    'next useful mission is started, or no useful next mission remains',
  ]);
  const nextMission = {
    ...mission,
    started_from: 'mission_run_continuation',
    parent_mission_id: parent.id,
    parent_objective: parent.objective,
    continue_on_complete: false,
    continuation_policy: 'choose_next_mission',
    parent_proof: proof || parent.receipt_path || null,
    next_action: '',
  };
  const nextPlan = chooseNextMissionPlan(nextMission, root);
  nextMission.next_action = `decide next mission, then run: ${nextPlan.command}`;
  nextMission.next_action_preview = nextPlan.preview;

  ensureMemberMissionFile(nextMission.owner, root, nextMission.objective);
  const { mission: saved } = saveMission(assignMissionNumber(nextMission, root), root, 'mission_continuation_started', {
    parent_mission_id: parent.id,
    parent_objective: parent.objective,
    proof: proof || null,
  });
  const worktreeBaseline = captureMissionWorktreeBaseline(saved, root);
  const seededAt = stampIso();
  const { mission: updatedParent } = saveMission({
    ...parent,
    continuation_seeded_mission_id: saved.id,
    continuation_seeded_at: seededAt,
    continuation_seeded_objective: saved.objective,
  }, root, 'mission_continuation_seeded', {
    continuation_mission_id: saved.id,
    continuation_objective: saved.objective,
  });
  return {
    inserted: true,
    mission: saved,
    parent: updatedParent,
    worktree_baseline: worktreeBaseline ? {
      path: path.relative(root, missionBaselinePath(saved.id, root)),
      dirty_count: worktreeBaseline.dirty_count,
      dirty_hash: worktreeBaseline.dirty_hash,
    } : null,
  };
}

function seedNextMoveContinuationGoal(root = process.cwd()) {
  const candidates = listMissions(root)
    .filter((mission) => runnerUsesCallerSession(mission.runner))
    .filter((mission) => mission.continue_on_complete === true)
    .filter((mission) => missionCanSeedContinuation(mission));
  candidates.sort((a, b) => missionSortTime(b) - missionSortTime(a));
  for (const parent of candidates) {
    const seeded = seedMissionRunContinuation(parent, root, parent.receipt_path || 'agent-certified task waiting for human accept');
    if (seeded?.mission && missionSelectableForCodexGoal(seeded.mission)) return { ...seeded, parent: seeded.parent || parent };
  }
  return null;
}

// Continuation runs started from inside an existing agent worktree must build
// on that work, not restart clean from origin/master. Returns the current HEAD
// sha (a sha survives normalizeTargetRef; an unpushed branch name would be
// rewritten to a nonexistent origin/ ref) when cwd is an agent worktree.
function inheritedWorktreeBase(cwd) {
  try {
    const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' });
    const root = String(top.stdout || '').trim();
    if (top.status !== 0 || !root) return '';
    if (!fs.existsSync(path.join(root, '.atris', 'agent-worktree.json'))) return '';
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
    return head.status === 0 ? String(head.stdout || '').trim() : '';
  } catch {
    return '';
  }
}

// Dedup gate: the same objective + owner already active anywhere in the
// workspace family (this store or any worktree's) is reused, never cloned.
// Born 2026-07-02: an hourly alive loop spawned six identical auto-improver
// missions in six fresh worktrees in one day — pure token burn. --duplicate
// is the explicit escape hatch.
const TWIN_ACTIVE_STATUSES = new Set(['planning', 'ready', 'running']);

function normalizedObjective(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function findActiveTwinMission(objective, owner, root = process.cwd()) {
  const wantObjective = normalizedObjective(objective);
  const wantOwner = String(owner || '').trim().toLowerCase();
  if (!wantObjective) return null;
  const candidates = [
    ...listMissions(root),
    ...listWorktreeRollupMissions(root),
  ];
  for (const m of candidates) {
    if (!m || !TWIN_ACTIVE_STATUSES.has(m.status)) continue;
    if (normalizedObjective(m.objective) !== wantObjective) continue;
    if (String(m.owner || '').trim().toLowerCase() !== wantOwner) continue;
    return m;
  }
  return null;
}

function startMission(args, options = {}) {
  const asJson = wantsJson(args);
  const firstArg = String(args[0] || '').trim().toLowerCase();
  if (hasFlag(args, '--help') || hasFlag(args, '-h') || firstArg === 'help') {
    console.log('Usage: atris mission start "<objective>" --owner <member> --verify "..." [--no-verify] [--always-on] [--budget quick|long|deep] [--runner manual|claude|atris2|codex_goal|auto]');
    console.log('Run `atris mission --help` for the full option list.');
    process.exit(0);
  }
  let mission = applyMissionStartPatch(missionFromArgs(args), options.missionPatch);
  // A flag-looking or empty objective is a typo, not a mission.
  const rawObjective = String(mission.objective || '').trim();
  if (!rawObjective || rawObjective.startsWith('-')) {
    exitMissionError(`mission start needs a quoted objective (got ${rawObjective ? `"${rawObjective}"` : 'nothing'}). Usage: atris mission start "<objective>" --owner <member>`, 1, asJson);
  }
  // Pasting a mission id where an objective goes is an id mismatch, not a new
  // mission: recover the existing record or explain where it actually lives.
  const idLikeObjective = String(mission.objective || '').trim();
  if (/^mission-\d{4}-\d{2}-\d{2}-/.test(idLikeObjective)) {
    const existing = resolveMission(idLikeObjective);
    if (existing) {
      printJsonOrText(
        { ok: true, action: 'mission_recovered', recovered: true, mission: existing, note: 'objective looked like a mission id; recovered the existing mission instead of creating a new one' },
        [
          `That's a mission id, not an objective — recovered ${existing.id} (${existing.status}).`,
          `Resume: atris mission run ${existing.id}`,
        ],
        asJson,
      );
      return;
    }
    exitMissingMission(idLikeObjective, 1, asJson);
  }
  if (!hasFlag(args, '--duplicate')) {
    const twin = findActiveTwinMission(mission.objective, mission.owner);
    if (twin) {
      printJsonOrText(
        { ok: true, action: 'mission_reused', reused: true, mission: twin, note: 'an active mission with this objective and owner already exists; resumed instead of cloning (pass --duplicate to force a second one)' },
        [
          `Already active: ${twin.id} (${twin.status})`,
          `Same objective, same owner — reusing it instead of starting a clone.`,
          `Resume: atris mission run ${twin.id}`,
          `Really want a second one: re-run with --duplicate`,
        ],
        asJson,
      );
      return;
    }
  }
  // Intake gate: a mission without a verifier is a planning wish, and planning
  // wishes silt up the queue (11 swept on 2026-07-06 with zero ticks). Refuse
  // to create one unless the caller explicitly opts out with --no-verify.
  if (!effectiveMissionVerifier(mission) && !hasFlag(args, '--no-verify')) {
    exitMissionError(
      `mission start refused: no verifier. Add --verify "<command that proves the objective>" so the mission can tick and complete, or pass --no-verify to explicitly create an unverified mission.`,
      2,
      asJson,
    );
  }
  // --worktree: bind the mission to its own isolated checkout. We chdir before
  // any state writes so the mission record, baseline sidecar, receipts, and
  // member files all land inside the worktree — ticks run there, and the main
  // checkout's dirt never reaches the mission baseline.
  if (hasFlag(args, '--worktree')) {
    let created;
    try {
      const { createAgentWorktree } = require('./worktree');
      const base = readFlag(args, '--base', '') || inheritedWorktreeBase(process.cwd());
      created = createAgentWorktree({ member: mission.owner, task: mission.objective, ...(base ? { base } : {}) });
    } catch (e) {
      exitMissionError(`[mission start] worktree creation failed: ${e.message}`, 2, asJson);
    }
    mission.worktree = { path: created.path, branch: created.branch, base: created.base };
    process.chdir(created.path);
  }
  if (mission.xp_task_enabled) {
    const xpTask = createMissionXpTask(mission, process.cwd(), asJson);
    mission.xp_task = xpTask;
    mission.task_ids = Array.from(new Set([...(mission.task_ids || []), xpTask.task_id]));
    if (!mission.verifier && !mission.always_on) {
      mission.next_action = `work task then run: atris task current-step --goal-id ${mission.id} --as ${mission.owner} --proof "<proof>" --json`;
    }
  }
  if (typeof options.beforeMissionSave === 'function') {
    mission = options.beforeMissionSave(mission) || mission;
  }
  const warnings = [missingVerifierWarning(mission), missingOwnerMemberWarning(mission.owner)].filter(Boolean);
  ensureMemberMissionFile(mission.owner, process.cwd(), mission.objective);
  const { mission: saved } = saveMission(assignMissionNumber(mission, process.cwd()), process.cwd(), 'mission_started', { objective: mission.objective });
  const goalSlotHandoff = hasFlag(args, '--take-goal-slot') && isCodexGoalMission(saved)
    ? takeCodexGoalSlotForMission(saved, process.cwd())
    : null;
  const memberState = renderMemberMissionState(saved.owner);
  const logPath = appendMemberLog(saved.owner, 'Mission started', {
    mission: saved.objective,
    cadence: saved.cadence,
    runner: saved.runner,
    lane: saved.lane,
    verifier: saved.verifier,
  });
  const worktreeBaseline = captureMissionWorktreeBaseline(saved, process.cwd());
  const nextTickCommand = `atris mission tick ${saved.id}${saved.verifier ? ' --verify' : ''}`;
  const payload = {
    ok: true,
    action: 'mission_started',
    mission: saved,
    warnings,
    goal_slot_handoff: goalSlotHandoff,
    state_path: statePaths().missionsJsonl,
    member_state: memberState,
    log_path: logPath,
    worktree_baseline: worktreeBaseline ? {
      path: path.relative(process.cwd(), missionBaselinePath(saved.id)),
      dirty_count: worktreeBaseline.dirty_count,
      dirty_hash: worktreeBaseline.dirty_hash,
    } : null,
  };
  if (!options.silent) {
    printJsonOrText(
      payload,
      [
        `Started mission: ${saved.objective}`,
        `Owner: ${saved.owner}`,
        `State: ${saved.status}`,
        ...(saved.worktree ? [`Worktree: ${saved.worktree.path}`, `Branch: ${saved.worktree.branch}`] : []),
        ...warnings.map((warning) => `Warning: ${warning.message}`),
        ...(saved.xp_task ? [`AgentXP task: ${saved.xp_task.ref}`] : []),
        ...(saved.worktree ? [`Next: cd ${saved.worktree.path} && ${nextTickCommand}`] : [`Next: ${nextTickCommand}`]),
      ],
      asJson,
    );
  }
  return payload;
}

async function startMissionFromRunObjective(objective, args) {
  const asJson = wantsJson(args);
  const rawObjective = String(objective || '').trim();
  const landRun = hasFlag(args, '--land');
  const dryRun = hasFlag(args, '--dry-run');
  const inferredLoop = inferRunObjectiveLoopOptions(rawObjective, args);
  const budgetTier = readMissionBudgetTier(args, { json: asJson });
  const maxTicksOverride = readPositiveIntegerFlag(args, '--max-ticks', null, { json: asJson });
  const budgetContract = inferRunObjectiveBudgetContract(rawObjective, args);
  const inferredOwner = inferredLoop.wantsLongRun && /\bself[-\s]?improve\b/i.test(rawObjective)
    ? 'auto-improver'
    : (process.env.ATRIS_AGENT_ID || 'mission-lead');
  const preflightOwner = readFlag(args, '--owner', inferredOwner);
  const missionRunPreflight = landRun && dryRun ? null : buildMissionRunRoomPreflight(rawObjective, args, {
    root: process.cwd(),
    owner: preflightOwner,
    allowTrustedRun: !inferredLoop.wantsLongRun,
  });
  const missionObjective = missionRunPreflight?.shaped_objective || rawObjective;
  const landOwnerResolution = landRun
    ? (missionRunPreflight
      ? { owner: missionRunPreflight.owner, reason: missionRunPreflight.owner_resolution, requested_owner: preflightOwner, source: 'mission_run_preflight' }
      : resolveFunctionalOwner({
        requestedOwner: preflightOwner,
        title: rawObjective,
        tag: readFlag(args, '--lane', 'workspace'),
        goal: rawObjective,
        root: process.cwd(),
        fallbackOwners: ['mission-lead', 'task-planner', 'architect', 'validator'],
      }))
    : null;
  const runOwner = landOwnerResolution?.owner || readFlag(args, '--owner', inferredOwner);
  const verifier = readFlag(
    args,
    '--verify',
    landRun ? DEFAULT_LONG_RUN_VERIFIER : inferRunObjectiveVerifier(missionObjective)
      || inferRunObjectiveVerifier(rawObjective)
      || (missionRunPreflight?.trusted_run ? DEFAULT_LONG_RUN_VERIFIER : '')
      || (inferredLoop.wantsLongRun ? DEFAULT_LONG_RUN_VERIFIER : ''),
  );
  const stopCondition = readFlag(
    args,
    '--stop',
    budgetStopCondition(budgetContract) || (inferredLoop.wantsLongRun
      ? `run for ${inferredLoop.requestedHours || 'the requested overnight window'} hour${inferredLoop.requestedHours === 1 ? '' : 's'}, or stop when proof is ready`
      : (verifier ? 'verifier passes and visible goal lands' : 'visible goal lands and proof is ready')),
  );
  const startArgs = [
    missionObjective,
    '--owner',
    runOwner,
    '--runner',
    readFlag(args, '--runner', 'codex_goal'),
    '--lane',
    readFlag(args, '--lane', 'workspace'),
    '--cadence',
    readFlag(args, '--cadence', inferredLoop.wantsLongRun ? inferredLoop.cadence : 'manual'),
    '--stop',
    stopCondition,
  ];
  if (verifier) startArgs.push('--verify', verifier);
  if (budgetTier) startArgs.push('--budget', budgetTier.name);
  if (maxTicksOverride) startArgs.push('--max-ticks', String(maxTicksOverride));
  const model = readFlag(args, '--model', '');
  if (model) startArgs.push('--model', model);
  if (hasFlag(args, '--always-on') || inferredLoop.wantsLongRun) startArgs.push('--always-on');
  if (hasFlag(args, '--xp-task') || hasFlag(args, '--agent-xp') || missionRunPreflight?.task_spine_required) startArgs.push('--xp-task');

  const mission = markMissionRunContinuation(missionFromArgs(startArgs));
  if (landOwnerResolution) {
    mission.owner = runOwner;
    mission.owner_resolution = landOwnerResolution.reason || mission.owner_resolution;
    mission.mission_land_owner = landOwnerResolution;
  }
  if (missionGoalChainIntent(rawObjective) || missionGoalChainIntent(missionObjective)) {
    mission.goal_chain = buildMissionGoalChain(missionObjective || rawObjective);
    mission.next_action = missionGoalChainNextAction(mission.goal_chain);
  }
  if (missionRunPreflight) {
    mission.mission_run_preflight = missionRunPreflight;
    mission.raw_objective = rawObjective;
  }
  const selectedTargetTask = missionRunSelectedTaskTarget(missionRunPreflight);
  if (selectedTargetTask) {
    Object.assign(mission, attachSelectedTargetTaskSpine(mission));
  }
  if (budgetContract) {
    mission.budget_contract = budgetContract;
    if (budgetContract.requested_seconds) mission.max_wall_seconds = budgetContract.requested_seconds;
  }
  if (inferredLoop.wantsLongRun) {
    mission.overnight_loop = {
      requested_hours: inferredLoop.requestedHours,
      cadence: mission.cadence,
      install_command: inferredLoop.requestedHours
        ? `atris loop start --overnight --cadence ${mission.cadence} --hours ${inferredLoop.requestedHours}`
        : `atris loop start --overnight --cadence ${mission.cadence}`,
    };
  }
  if (mission.xp_task_enabled && !selectedTargetTask) {
    const xpTask = createMissionXpTask(mission, process.cwd(), asJson);
    mission.xp_task = xpTask;
    mission.task_ids = Array.from(new Set([...(mission.task_ids || []), xpTask.task_id]));
  }
  if (landRun) {
    const repoPath = path.resolve(readFlag(args, '--repo', process.cwd()));
    const verifyCmd = verifier || DEFAULT_LONG_RUN_VERIFIER;
    const brief = [
      `Mission objective: ${mission.objective}`,
      rawObjective !== mission.objective ? `Original request: ${rawObjective}` : '',
      `Owner: ${mission.owner}`,
      `Owner context: ${mission.owner_resolution || 'resolved from the mission objective'}`,
      mission.mission_run_preflight?.room_name ? `Mission Room: ${mission.mission_run_preflight.room_name}` : '',
      `Stop condition: ${mission.stop_condition || 'verifier passes and work is landed'}`,
    ].filter(Boolean).join('\n');
    const { dispatchCodexFlight } = require('../lib/codex-flight');
    const flight = await dispatchCodexFlight({
      repoPath,
      slug: mission.slug,
      brief,
      verifyCmd,
      dryRun,
    });
    if (dryRun) {
      printJsonOrText(
        { ok: true, action: 'mission_land_dry_run', mission, codex_flight: { dryRun: true } },
        [
          'Codex flight dry-run complete.',
          `Owner: ${mission.owner}`,
          `Repo: ${repoPath}`,
          `Verify: ${verifyCmd}`,
        ],
        asJson,
      );
      return;
    }
    mission.status = 'running';
    mission.codex_flight = {
      taskId: flight.taskId,
      worktreePath: flight.worktreePath,
      branch: flight.branch,
      repoPath,
      verifyCmd,
      dispatched_at: stampIso(),
    };
    mission.next_action = `watch codex flight ${flight.taskId}`;
  }
  const warnings = [missingVerifierWarning(mission), missingOwnerMemberWarning(mission.owner)].filter(Boolean);
  ensureMemberMissionFile(mission.owner, process.cwd(), mission.objective);
  const { mission: saved } = saveMission(assignMissionNumber(mission, process.cwd()), process.cwd(), 'mission_started', { objective: mission.objective, source: 'mission_run_objective' });
  if (landRun) {
    const memberState = renderMemberMissionState(saved.owner);
    const logPath = appendMemberLog(saved.owner, 'Mission landing flight dispatched', {
      mission: saved.objective,
      task_id: saved.codex_flight?.taskId,
      worktree: saved.codex_flight?.worktreePath,
      branch: saved.codex_flight?.branch,
      verifier: saved.codex_flight?.verifyCmd,
    });
    printJsonOrText(
      { ok: true, action: 'mission_land_dispatched', mission: saved, codex_flight: saved.codex_flight, warnings, state_path: statePaths().missionsJsonl, member_state: memberState, log_path: logPath },
      [
        `Dispatched Codex flight: ${saved.objective}`,
        `Owner: ${saved.owner}`,
        `Task: ${saved.codex_flight.taskId}`,
        `Worktree: ${saved.codex_flight.worktreePath}`,
        `Branch: ${saved.codex_flight.branch}`,
      ],
      asJson,
    );
    return;
  }
  const directGoalRequest = writeDirectRunCodexGoalRequest(saved, process.cwd());
  const memberState = renderMemberMissionState(saved.owner);
  const logPath = appendMemberLog(saved.owner, 'Mission started from run', {
    mission: saved.objective,
    cadence: saved.cadence,
    runner: saved.runner,
    lane: saved.lane,
    verifier: saved.verifier,
  });
  const worktreeBaseline = captureMissionWorktreeBaseline(saved, process.cwd());
  const completedContinuationGoal = completeActiveContinuationForStartedMission(saved, process.cwd());
  const nativeGoalOptions = codexNativeGoalOptionsFromArgs(args);
  const goalSlotHandoff = hasFlag(args, '--take-goal-slot') && isCodexGoalMission(saved)
    ? takeCodexGoalSlotForMission(saved, process.cwd(), nativeGoalOptions)
    : null;
  const atrisGoalState = refreshAtrisGoalController(process.cwd(), { missionId: saved.id });
  const codexGoalState = runnerUsesCallerSession(saved.runner)
    ? refreshCodexGoalController(process.cwd(), { missionId: saved.id, ...nativeGoalOptions })
    : null;
  const outputMission = resolveMission(saved.id, process.cwd()) || saved;
  const nativeGoal = codexGoalState?.native_goal_action
    || (codexGoalState?.goal?.requires_native_goal_start ? codexGoalState.goal.native_goal_action : null);
  const nextCommand = codexGoalState?.next_command || codexGoalState?.goal?.next_command || atrisGoalState.goal?.next_command || `atris mission tick ${saved.id} --summary "<what changed>"`;
  printJsonOrText(
    {
      ok: true,
      action: 'mission_run_started',
      mission: outputMission,
      budget_contract: saved.budget_contract || null,
      warnings,
      state_path: statePaths().missionsJsonl,
      member_state: memberState,
      log_path: logPath,
      worktree_baseline: worktreeBaseline ? {
        path: path.relative(process.cwd(), missionBaselinePath(saved.id)),
        dirty_count: worktreeBaseline.dirty_count,
        dirty_hash: worktreeBaseline.dirty_hash,
      } : null,
      completed_continuation_goal: completedContinuationGoal,
      direct_goal_request: directGoalRequest,
      goal_slot_handoff: goalSlotHandoff,
      atris_goal_state: atrisGoalState,
      codex_goal_state: codexGoalState,
      requires_native_goal_start: codexGoalState?.requires_native_goal_start === true || codexGoalState?.goal?.requires_native_goal_start === true,
      requires_native_goal_replace: codexGoalState?.requires_native_goal_replace === true || codexGoalState?.goal?.requires_native_goal_replace === true,
      native_goal_action: nativeGoal,
      native_goal_ack_command: codexGoalState?.goal?.native_goal_ack_command || codexGoalState?.active_goal_conflict?.commands?.ack_new_mission || null,
      next_command: nextCommand,
    },
    missionRunTakeoffLines(outputMission, { warnings, nextCommand }),
    asJson,
  );
}

function attachMissionTask(args) {
  const asJson = wantsJson(args);
  const ref = stripKnownFlags(args, [], ['--json'])[0] || '';
  if (!ref) {
    exitMissionError('Usage: atris mission attach-task <id> [--json]', 1, asJson);
  }
  let mission = resolveMission(ref);
  if (!mission) {
    exitMissingMission(ref, 1, asJson);
  }

  const lock = acquireMissionLock(mission.id, process.cwd(), { waitMs: 2000 });
  if (!lock.ok) {
    exitMissionError(`[mission attach-task] lock busy (held by pid ${lock.holder?.pid || '?'} since ${lock.holder?.started_at || '?'}). Exit.`, 3, asJson);
  }

  try {
    mission = resolveMission(mission.id) || mission;
    if (TERMINAL_STATUSES.has(mission.status)) {
      releaseMissionLock(lock);
      exitMissionError(`Mission "${ref}" is ${mission.status}; task spines attach only to active missions.`, 2, asJson);
    }

    const existingSpine = missionTaskSpine(mission);
    if (existingSpine?.has_task) {
      let currentMission = mission;
      if (missionChoosesNextMission(currentMission)) {
        const nextPlan = chooseNextMissionPlan(currentMission);
        const nextAction = `decide next mission, then run: ${nextPlan.command}`;
        const currentPreviewTitle = currentMission.next_action_preview?.candidate?.title || null;
        const nextPreviewTitle = nextPlan.preview?.candidate?.title || null;
        const previewChanged = Boolean(currentMission.next_action_preview) !== Boolean(nextPlan.preview)
          || currentPreviewTitle !== nextPreviewTitle;
        if (currentMission.next_action !== nextAction || previewChanged) {
          currentMission = saveMission(
            {
              ...currentMission,
              next_action: nextAction,
              next_action_preview: nextPlan.preview,
            },
            process.cwd(),
            'mission_next_action_refreshed',
            {
              next_command: nextPlan.command,
              target: nextPreviewTitle,
            },
          ).mission;
        }
      }
      const view = missionStatusView(currentMission);
      printJsonOrText(
        { ok: true, action: 'mission_task_spine_exists', mission: view, task_spine: view.task_spine },
        [
          `Mission task spine already exists: ${mission.objective}`,
          `Task: ${view.task_spine.task_ref}`,
          `Next: ${view.task_spine.current_step_command}`,
        ],
        asJson,
      );
      return;
    }

    const ownership = applyMissionOwnerResolution(mission, process.cwd());
    const baseMission = ownership.mission;
    const selectedTargetMission = attachSelectedTargetTaskSpine(baseMission);
    if (missionTaskSpine(selectedTargetMission)?.has_task) {
      const { mission: saved } = saveMission(
        selectedTargetMission,
        process.cwd(),
        'mission_selected_task_spine_attached',
        {
          task_id: selectedTargetMission.current_task_id || selectedTargetMission.task_ids?.[0] || null,
          task_ref: selectedTargetMission.task_ref || null,
        },
      );
      const memberState = renderMemberMissionState(saved.owner);
      const logPath = appendMemberLog(saved.owner, 'Mission selected task spine attached', {
        mission: saved.objective,
        task: saved.task_ref || saved.current_task_id,
      });
      const view = missionStatusView(saved);
      printJsonOrText(
        { ok: true, action: 'mission_selected_task_spine_attached', mission: view, task_spine: view.task_spine, member_state: memberState, log_path: logPath },
        [
          `Attached selected task spine: ${saved.objective}`,
          `Task: ${view.task_spine.task_ref}`,
          `Next: ${view.task_spine.current_step_command}`,
        ],
        asJson,
      );
      return;
    }
    const xpTask = createMissionXpTask(baseMission, process.cwd(), asJson);
    const nextMission = {
      ...baseMission,
      xp_task_enabled: true,
      xp_task: xpTask,
      task_ids: Array.from(new Set([...(baseMission.task_ids || []), xpTask.task_id])),
    };
    if (nextMission.status === 'ready' && nextMission.receipt_path) {
      nextMission.next_action = missionXpReadyAction(nextMission, nextMission.receipt_path) || nextMission.next_action;
    } else if (missionChoosesNextMission(nextMission)) {
      const nextPlan = chooseNextMissionPlan(nextMission);
      nextMission.next_action = `decide next mission, then run: ${nextPlan.command}`;
      nextMission.next_action_preview = nextPlan.preview;
    } else if (!nextMission.verifier && !nextMission.always_on) {
      nextMission.next_action = `work task then run: atris task current-step --goal-id ${nextMission.id} --as ${nextMission.owner} --proof "<proof>" --json`;
    }

    const { mission: saved } = saveMission(nextMission, process.cwd(), 'mission_task_spine_attached', { task_id: xpTask.task_id, task_ref: xpTask.ref });
    const memberState = renderMemberMissionState(saved.owner);
    const logPath = appendMemberLog(saved.owner, 'Mission task spine attached', {
      mission: saved.objective,
      task: xpTask.ref,
    });
    const view = missionStatusView(saved);
    printJsonOrText(
      { ok: true, action: 'mission_task_spine_attached', mission: view, task: xpTask, task_spine: view.task_spine, member_state: memberState, log_path: logPath },
      [
        `Attached task spine: ${saved.objective}`,
        `Task: ${xpTask.ref}`,
        `Next: ${view.task_spine.current_step_command}`,
      ],
      asJson,
    );
  } finally {
    releaseMissionLock(lock);
  }
}

function setMissionRunner(args) {
  const asJson = wantsJson(args);
  if (hasFlag(args, '--help') || hasFlag(args, '-h') || String(args[0] || '').trim() === 'help') {
    console.log('Usage: atris mission set-runner <id> <runner|engine> [--model <id>] [--json]');
    console.log(knownMissionRunnerText());
    return;
  }
  const positionals = stripKnownFlags(args, ['--model'], ['--json']);
  const ref = String(positionals[0] || '').trim();
  const runnerArg = String(positionals[1] || '').trim();
  if (!ref || !runnerArg) {
    exitMissionError(`Usage: atris mission set-runner <id> <runner|engine> [--model <id>]. ${knownMissionRunnerText()}.`, 1, asJson);
  }

  const selection = resolveMissionRunnerSelection(runnerArg, { asJson, label: 'runner' });
  const model = readFlag(args, '--model', '');
  let mission = resolveMission(ref);
  if (!mission) exitMissingMission(ref, 1, asJson);

  const lock = acquireMissionLock(mission.id);
  if (!lock.ok) {
    exitMissionError(`[mission set-runner] lock busy (held by pid ${lock.holder?.pid || '?'} since ${lock.holder?.started_at || '?'}). Exit.`, 3, asJson);
  }

  try {
    mission = resolveMission(mission.id) || mission;
    const previous = { runner: mission.runner || null, model: mission.model || null };
    const nextMission = {
      ...mission,
      runner: selection.runner,
      runner_kind: selection.kind,
      next_action: mission.next_action || `run: atris mission run ${mission.id}`,
    };
    delete nextMission.model;
    Object.assign(nextMission, runnerModelPatch(selection.runner, model));

    const { mission: saved, event } = saveMission(
      nextMission,
      process.cwd(),
      'mission_runner_changed',
      {
        previous_runner: previous.runner,
        previous_model: previous.model,
        runner: nextMission.runner,
        requested_runner: selection.requested,
        kind: selection.kind,
        model: nextMission.model || null,
      },
    );
    const logPath = appendMemberLog(saved.owner, 'Mission runner changed', {
      mission: saved.objective,
      previous_runner: previous.runner || undefined,
      runner: saved.runner,
      model: saved.model || undefined,
    });
    printJsonOrText(
      { ok: true, action: 'mission_runner_changed', mission: saved, event, log_path: logPath },
      [
        `Mission runner changed: ${saved.id}`,
        `Runner: ${previous.runner || 'none'} -> ${saved.runner}${saved.model ? ` (${saved.model})` : ''}`,
        `Next: atris mission run ${saved.id}`,
      ],
      asJson,
    );
  } finally {
    releaseMissionLock(lock);
  }
}

function statusMission(args) {
  if (hasFlag(args, '--help') || hasFlag(args, '-h') || String(args[0] || '').trim() === 'help') {
    console.log('Usage: atris mission status [id] [--status <state>] [--limit <n>] [--local] [--json]');
    console.log('List mission state, remaining budget, next action, and proof inspection command.');
    console.log('Use --status active for planning, running, ready, paused, and blocked missions.');
    return;
  }
  const asJson = wantsJson(args);
  const localOnly = hasFlag(args, '--local');
  const ref = stripKnownFlags(args, ['--status', '--limit'], ['--json', '--local'])[0] || '';
  const statusFilter = readFlag(args, '--status', '');
  if (statusFilter && !VALID_STATUSES.has(statusFilter) && !STATUS_ALIASES.has(statusFilter)) {
    exitMissionError(`Invalid --status: ${statusFilter}`, 2, asJson);
  }
  const limit = readPositiveIntegerFlag(args, '--limit', null, { json: asJson });
  // BCK-1319: same canonical local+rollup index the resolver uses, so the n
  // this renders is the exact n `mission run/tick/show <n>` resolves.
  let missions = ref ? [resolveMission(ref)].filter(Boolean) : (localOnly ? listMissions() : canonicalMissionIndex());
  if (!ref && statusFilter) missions = missions.filter((mission) => missionMatchesStatusFilter(mission, statusFilter));
  if (!ref && limit) missions = missions.slice(0, limit);
  if (ref && !missions.length) {
    exitMissingMission(ref, 1, asJson);
  }
  const missionViews = missions.map(missionStatusView);
  // Member state renders are cwd-local writes; rolled-up missions stay read-only.
  for (const owner of new Set(missionViews.filter((mission) => !mission.worktree_root).map((mission) => mission.owner).filter(Boolean))) {
    renderMemberMissionState(owner);
  }
  const payload = {
    ok: true,
    action: 'mission_status',
    missions: missionViews,
    state_path: statePaths().missionsJsonl,
    events_path: statePaths().eventsJsonl,
    status_path: renderMissionStatus(),
  };
  printJsonOrText(
    payload,
    missions.length
      ? missionViews.flatMap((mission) => [
        `Mission: ${missionLabel(mission)}`,
        `  objective: ${mission.objective}`,
        `  owner: ${mission.owner}`,
        ...(mission.executed_by ? [`  executed_by: ${mission.executed_by}`] : []),
	        `  state: ${missionHumanStatusText(mission)}`,
	        ...missionMetricLine(mission),
	        ...missionHeartbeatLines(mission),
	        ...(mission.worktree_root ? [`  worktree: ${mission.worktree_root}`] : []),
	        `  next: ${missionDisplayText(mission, mission.next_action || 'tick or verify')}`,
	        ...(mission.next_action_preview?.feynman?.what ? [`  preview: ${mission.next_action_preview.feynman.what}`] : []),
	        ...missionGoalChainLines(mission),
        ...(mission.task_spine?.task_ref ? [`  task: ${mission.task_spine.task_ref}`] : []),
        ...(mission.task_spine?.current_step_command ? [`  task next: ${missionDisplayText(mission, mission.task_spine.current_step_command)}`] : []),
        ...(!mission.task_spine?.has_task && mission.task_spine?.ensure_task_command ? [`  task setup: ${missionDisplayText(mission, mission.task_spine.ensure_task_command)}`] : []),
        ...(mission.proof_needed ? [`  proof needed: ${mission.proof_needed}`] : []),
        ...(mission.receipt_path ? [`  proof: ${missionStatusProofText(mission)}`] : []),
        ...missionStatusLandingLines(mission.last_landing),
        ...(completionGateLabel(mission.completion_gate) ? [`  gate: ${completionGateLabel(mission.completion_gate)}`] : []),
      ])
      : ['No missions yet. Run: atris mission start "..." --owner <member>'],
    asJson,
  );
}

function readMissionReceipt(receiptPath, root = process.cwd()) {
  if (!receiptPath) return null;
  const file = path.isAbsolute(receiptPath) ? receiptPath : path.join(root, receiptPath);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function firstUsefulLine(text, fallback = '') {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*\s#]+/, '').trim())
    .filter(Boolean)
    .find((line) => !/^(receipt|summary|final|result)$/i.test(line))
    || fallback;
}

function missionWorkerLabel(mission) {
  const runner = String(mission && mission.runner || 'manual').toLowerCase();
  if (runner === 'atris2') return `Remote Atris2 computer${mission.model ? ` using ${mission.model}` : ''}`;
  if (runner === 'claude') return `Claude worker${mission.model ? ` using ${mission.model}` : ''}`;
  if (runner === 'codex_goal') return 'Codex goal handoff';
  return 'Local mission tick';
}

function missionWorkerSummary(mission, receipt) {
  if (mission && mission.worker_summary) return mission.worker_summary;
  const tick = receipt && receipt.result && (receipt.result.tick || (Array.isArray(receipt.result.ticks) ? receipt.result.ticks[receipt.result.ticks.length - 1] : null));
  if (!tick) return mission && mission.last_tick_reason ? `Last tick: ${mission.last_tick_reason}` : 'No worker receipt yet.';
  return missionTickReportSummary(tick);
}

function missionTickReportSummary(tick) {
  if (!tick) return 'Worker tick recorded.';
  if (tick.atris2) {
    return firstUsefulLine(tick.atris2.receipt_text, tick.atris2.ok ? 'Remote worker ran and returned a response.' : 'Remote worker failed.');
  }
  if (tick.claude) {
    if (tick.claude.skipped) {
      const skipReason = tick.claude.reason || tick.reason || '';
      if (!tick.summary && ['runner-uses-caller-session', 'orchestrator-is-caller-session'].includes(skipReason)) {
        return 'Goal handed to the active Codex session.';
      }
      return tick.summary || `Worker step skipped: ${tick.claude.reason || tick.reason || 'not needed'}.`;
    }
    return tick.claude.summary || firstUsefulLine(tick.claude.receipt_text, tick.claude.ok ? 'Worker ran and returned a response.' : 'Worker failed.');
  }
  if (tick.summary) return tick.summary;
  return tick.reason ? `Worker tick: ${tick.reason}` : 'Worker tick recorded.';
}

function missionReceiptTicks(receipt) {
  const result = receipt && receipt.result;
  if (!result) return [];
  if (result.tick) return [result.tick];
  if (Array.isArray(result.ticks)) return result.ticks.filter(Boolean);
  return [];
}

function missionTickAt(receipt, tick) {
  return tick.finished_at || tick.started_at || receipt.at || '';
}

function missionTimelineTitle(tick, summary) {
  const tickIndex = Number(tick && tick.tick_index);
  const prefix = Number.isInteger(tickIndex) && tickIndex > 0 ? `Goal ${tickIndex}` : 'Goal';
  const text = String(summary || '').trim();
  const explicitGoal = text.match(/^(Goal\s+\d+)\s*:\s*(.*)$/i);
  if (explicitGoal) {
    return missionTimelineTitleLine(`${explicitGoal[1].replace(/\s+/g, ' ')}: ${explicitGoal[2].trim()}`);
  }
  return missionTimelineTitleLine(`${prefix}: ${text.replace(/^Goal\s*:\s*/i, '').trim()}`);
}

function missionTimelineTitleLine(title) {
  const text = String(title || '').replace(/\s+/g, ' ').trim();
  const firstSentence = text.match(/^(.+?[.!?])(?:\s+|$)/);
  const candidate = firstSentence ? firstSentence[1].trim() : text;
  if (candidate.length <= 180) return candidate;
  return `${candidate.slice(0, 177).trimEnd()}...`;
}

function missionTimelineSummaryIsUseful(summary) {
  const text = String(summary || '').trim();
  if (!text) return false;
  return ![
    'Goal handed to the active Codex session.',
    'Worker tick recorded.',
  ].includes(text) && !/^Worker step skipped:/i.test(text);
}

function missionTimelineTickIndex(tick) {
  const tickIndex = Number(tick && tick.tick_index);
  return Number.isInteger(tickIndex) && tickIndex > 0 ? tickIndex : null;
}

function missionReportTimeline(mission, root = process.cwd(), limit = 6) {
  const paths = statePaths(root);
  let files = [];
  try {
    files = fs.readdirSync(paths.runsDir)
      .filter((file) => file.startsWith('mission-') && file.endsWith('.json'))
      .map((file) => path.join(paths.runsDir, file));
  } catch {
    files = [];
  }

  const items = [];
  const seen = new Set();
  for (const file of files) {
    let receipt = null;
    try {
      receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    if (!receipt || receipt.mission_id !== mission.id) continue;
    const receiptPath = path.relative(root, file);
    for (const tick of missionReceiptTicks(receipt)) {
      const summary = missionTickReportSummary(tick);
      if (!missionTimelineSummaryIsUseful(summary)) continue;
      const at = missionTickAt(receipt, tick);
      const key = `${tick.tick_index || ''}:${at}:${summary}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({
        at,
        tick_index: missionTimelineTickIndex(tick),
        title: missionTimelineTitle(tick, summary),
        summary,
        receipt_path: receiptPath,
      });
    }
  }

  items.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
  return items.slice(Math.max(0, items.length - limit));
}

function missionLandingTimeline(mission, root = process.cwd(), limit = 12, { kind = null, since = null } = {}) {
  const paths = statePaths(root);
  let files = [];
  try {
    files = fs.readdirSync(paths.runsDir)
      .filter((file) => file.startsWith('mission-') && file.endsWith('.json'))
      .map((file) => path.join(paths.runsDir, file));
  } catch {
    files = [];
  }

  const kindFilter = kind ? String(kind).trim() : null;
  const sinceFilter = since ? String(since).trim() : null;
  const items = [];
  const seen = new Set();
  for (const file of files) {
    let receipt = null;
    try {
      receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    if (!receipt || receipt.mission_id !== mission.id) continue;
    const receiptKind = receipt.result && receipt.result.kind ? String(receipt.result.kind) : (receipt.kind ? String(receipt.kind) : '');
    if (kindFilter && receiptKind !== kindFilter) continue;
    if (sinceFilter && String(receipt.at || '') < sinceFilter) continue;
    const landing = receipt.result && receipt.result.landing;
    if (landing && landing.timeline_visible === false) continue;
    const rawChanged = String(landing && landing.changed || '').trim();
    const changed = missionLandingStepSummary(rawChanged) || rawChanged;
    const next = String(landing && landing.next || '').trim();
    if (!changed && !next) continue;
    const receiptPath = path.relative(root, file);
    const key = `${receipt.at || ''}:${changed}:${next}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      at: receipt.at || '',
      changed,
      next,
      receipt_path: receiptPath,
      created_next: receipt.result.created_next || null,
    });
  }
  items.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
  const normalizedLimit = Number.isFinite(limit) && limit > 0 ? limit : items.length;
  const shown = items.slice(Math.max(0, items.length - normalizedLimit));
  return {
    items: shown,
    meta: {
      shown_count: shown.length,
      total_count: items.length,
      hidden_count: Math.max(0, items.length - shown.length),
      truncated: shown.length < items.length,
      limit: normalizedLimit === Number.MAX_SAFE_INTEGER ? null : normalizedLimit,
    },
  };
}

function formatInteger(value) {
  return String(Math.max(0, Number(value || 0))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function missionTimelinePruneSummaryMarkdown(prunePreview) {
  if (!prunePreview) return [];
  if (prunePreview.error) {
    return [
      '',
      '## Latest prune dry-run',
      '',
      `- Not available: ${prunePreview.error}`,
    ];
  }
  return [
    '',
    '## Latest prune dry-run',
    '',
    `- Policy: keep newest ${formatInteger(prunePreview.policy?.keep_newest)}; keep ${formatInteger(prunePreview.policy?.keep_days)} days`,
    `- Total run files: ${formatInteger(prunePreview.total_files)}`,
    `- Total run bytes: ${formatInteger(prunePreview.total_bytes)} (${formatBytes(prunePreview.total_bytes)})`,
    `- Referenced files kept: ${formatInteger(prunePreview.referenced_files)}`,
    `- Recent files kept: ${formatInteger(prunePreview.recent_files)}`,
    `- Would prune: ${formatInteger(prunePreview.prune_count)} files / ${formatInteger(prunePreview.prune_bytes)} bytes (${formatBytes(prunePreview.prune_bytes)})`,
    `- Deleted files: ${formatInteger(prunePreview.deleted_count)}`,
  ];
}

function missionTimelinePruneSummaryLine(prunePreview) {
  if (!prunePreview) return null;
  if (prunePreview.error) return `Prune dry-run: not available (${prunePreview.error}).`;
  return `Prune dry-run: ${formatInteger(prunePreview.prune_count)} files / ${formatBytes(prunePreview.prune_bytes)} would prune; ${formatInteger(prunePreview.deleted_count)} deleted.`;
}

function missionTimelinePruneSummaryObject(prunePreview) {
  if (!prunePreview) return null;
  if (prunePreview.error) {
    return {
      ok: false,
      error: prunePreview.error,
      text: missionTimelinePruneSummaryLine(prunePreview),
    };
  }
  return {
    ok: true,
    text: missionTimelinePruneSummaryLine(prunePreview),
    total_files: prunePreview.total_files,
    total_bytes: prunePreview.total_bytes,
    referenced_files: prunePreview.referenced_files,
    recent_files: prunePreview.recent_files,
    prune_count: prunePreview.prune_count,
    prune_bytes: prunePreview.prune_bytes,
    prune_bytes_text: formatBytes(prunePreview.prune_bytes),
    deleted_count: prunePreview.deleted_count,
  };
}

function missionTimelineCurrentLanding(timeline) {
  if (!timeline.length) return null;
  const latest = timeline[timeline.length - 1];
  return {
    at: latest.at || '',
    changed: latest.changed || '',
    next: latest.next || '',
    receipt_path: latest.receipt_path || '',
  };
}

function missionTimelineEmptyStateDisplay(mission, timelineLength = 0) {
  const hasMission = Boolean(mission);
  const isEmpty = !timelineLength;
  return {
    label: 'Empty state',
    is_empty: isEmpty,
    has_mission: hasMission,
    title: isEmpty ? (hasMission ? 'No timeline items yet.' : 'No missions yet.') : null,
    message: isEmpty
      ? (hasMission ? 'Run the mission once to create the first timeline item.' : 'Start a mission to create the first timeline item.')
      : null,
    action_label: isEmpty ? (hasMission ? 'Run mission' : 'Start mission') : null,
    command: isEmpty ? (hasMission ? `atris mission run ${mission.id} --create-next` : 'atris mission start "..." --owner <member>') : null,
  };
}

function missionTimelineNextMove(mission, landing) {
  const latestNext = landing ? String(landing.next || '').trim() : '';
  return latestNext || `atris mission run ${mission.id} --create-next`;
}

function missionTimelineCountLine(meta) {
  if (!meta) return null;
  const shown = Number(meta.shown_count || 0);
  const total = Number(meta.total_count || 0);
  if (meta.truncated) {
    return `Showing latest ${formatInteger(shown)} of ${formatInteger(total)} ${total === 1 ? 'item' : 'items'}.`;
  }
  return `Showing ${formatInteger(shown)} ${shown === 1 ? 'item' : 'items'}.`;
}

function missionTimelineCurrentLandingLines(mission, landing) {
  if (!landing) return [];
  const next = missionBudgetContinuationText(mission) || landing.next;
  return [
    'Current landing:',
    `  Changed: ${landing.changed || 'Landing recorded.'}`,
    ...(next ? [`  Next: ${next}`] : []),
    '  Proof: saved in mission history.',
    '',
  ];
}

function missionTimelineMarkdown(mission, timeline, { prunePreview = null, generatedAt = stampIso(), timelineMeta = null } = {}) {
  const latestLanding = timeline.length ? timeline[timeline.length - 1] : null;
  const nextMove = missionTimelineNextMove(mission, latestLanding);
  const lines = [
    `# Mission timeline: ${mission.objective}`,
    '',
    `Mission: ${mission.id}`,
    `Status: ${mission.status}`,
    `Generated at: ${generatedAt}`,
    ...(timelineMeta ? [missionTimelineCountLine(timelineMeta)] : []),
    '',
    '## Operator commands',
    '',
    `- Timeline: \`${missionRunTimelineCommand(mission)}\``,
    `- Export: \`${missionRunExportCommand(mission)}\``,
    `- Prune preview: \`${missionRunPrunePreviewCommand(mission)}\``,
    '',
  ];
  if (latestLanding) {
    lines.push(
      '## Current landing',
      '',
      `Changed: ${latestLanding.changed || 'Landing recorded.'}`,
      ...(latestLanding.next ? [`Next: ${latestLanding.next}`] : []),
      `Proof: ${latestLanding.receipt_path}`,
      '',
    );
  }
  if (!timeline.length) {
    lines.push('No landing receipts yet.');
    lines.push(
      '',
      '## Next move',
      '',
      nextMove,
    );
    lines.push(
      '',
      '## Keep it concise',
      '',
      '- Dry run: `atris mission prune-runs --days 14 --keep-newest 200`',
      '- Apply only after review: add `--apply`.',
    );
    lines.push(...missionTimelinePruneSummaryMarkdown(prunePreview));
    lines.push('');
    return lines.join('\n');
  }
  timeline.forEach((item, index) => {
    if (index === 0) lines.push('## Full history', '');
    lines.push(`${index + 1}. ${item.changed || 'Landing recorded.'}`);
    if (item.next) lines.push(`   - Next: ${item.next}`);
    lines.push(`   - Proof: ${item.receipt_path}`);
  });
  lines.push('', '## Next move', '', nextMove);
  lines.push(
    '',
    '## Keep it concise',
    '',
    '- Dry run: `atris mission prune-runs --days 14 --keep-newest 200`',
    '- Apply only after review: add `--apply`.',
  );
  lines.push(...missionTimelinePruneSummaryMarkdown(prunePreview));
  lines.push('');
  return lines.join('\n');
}

function defaultMissionTimelinePath(root, mission) {
  const safeId = String(mission.id || 'mission')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'mission';
  return path.join(root, 'atris', 'reports', `${safeId}-timeline.md`);
}

function missionReportFor(mission, root = process.cwd()) {
  const verifierReceiptPath = mission.receipt_path || null;
  const receipt = readMissionReceipt(verifierReceiptPath, root);
  const workerReceiptPath = mission.worker_receipt_path || (receipt && verifierReceiptPath) || null;
  const verifierPassed = mission.verifier_result && mission.verifier_result.passed === true;
  const budgetContinuation = missionBudgetContinuationText(mission);
  const operatorOutcome = budgetContinuation
    ? 'The last verifier passed; full-budget work is continuing.'
    : mission.operator_outcome
    || (verifierPassed ? 'Verifier passed.' : mission.status === 'complete' ? 'Mission is complete.' : mission.status === 'blocked' ? 'Mission is blocked.' : 'Mission is still in progress.');
  return {
    id: mission.id,
    objective: mission.objective,
    status: mission.status,
    human_status: missionHumanStatusText(mission),
    budget_continuation: budgetContinuation,
    operator_outcome: operatorOutcome,
    worker: mission.worker || missionWorkerLabel(mission),
    worker_summary: missionWorkerSummary(mission, receipt),
    timeline: missionReportTimeline(mission, root),
    worker_receipt_path: workerReceiptPath,
    verifier_receipt_path: verifierReceiptPath,
    proof_text: mission.receipt_path ? missionStatusProofText(mission) : null,
    operator_next: budgetContinuation || mission.operator_next || mission.next_action || 'Review the mission state.',
  };
}

function missionReportNextText(nextAction) {
  return String(nextAction || 'Review the mission state.')
    .replace(/^next move:\s*run\s+/i, '')
    .trim();
}

function reportMission(args) {
  if (hasFlag(args, '--help') || hasFlag(args, '-h') || String(args[0] || '').trim() === 'help') {
    console.log('Usage: atris mission report [id] [--limit <n>] [--local] [--json]');
    console.log('Show the mission outcome, worker summary, proof receipts, timeline, and next move.');
    return;
  }
  const asJson = wantsJson(args);
  const localOnly = hasFlag(args, '--local');
  const ref = stripKnownFlags(args, ['--limit'], ['--json', '--local'])[0] || '';
  const limit = readPositiveIntegerFlag(args, '--limit', ref ? 1 : 3, { json: asJson });
  let missions = ref ? [resolveMission(ref)].filter(Boolean) : listMissions();
  if (!ref && !localOnly) {
    const seen = new Set(missions.map((mission) => mission.id));
    for (const rolled of listWorktreeRollupMissions()) {
      if (seen.has(rolled.id)) continue;
      seen.add(rolled.id);
      missions.push(rolled);
    }
    missions.sort((a, b) => String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || '')));
  }
  if (ref && !missions.length) {
    exitMissingMission(ref, 1, asJson);
  }
  missions = missions.slice(0, limit);
  const reports = missions.map((mission) => missionReportFor(mission, mission.worktree_root || process.cwd()));
  printJsonOrText(
    { ok: true, action: 'mission_report', reports },
    reports.length
      ? reports.flatMap((report) => [
        `Mission: ${report.objective}`,
        `  state: ${report.human_status}`,
        `  What happened: ${report.operator_outcome}`,
        `  Worker: ${report.worker}`,
        `  Worker summary: ${report.worker_summary}`,
        ...(report.timeline && report.timeline.length ? [
          '  Timeline:',
          ...report.timeline.map((item) => `    - ${report.budget_continuation ? item.summary : item.title}`),
        ] : []),
        ...(report.budget_continuation && report.proof_text ? [`  Proof: ${report.proof_text}`] : []),
        ...(!report.budget_continuation && report.worker_receipt_path ? [`  Worker receipt: ${report.worker_receipt_path}`] : []),
        ...(!report.budget_continuation && report.verifier_receipt_path ? [`  Verifier receipt: ${report.verifier_receipt_path}`] : []),
        `  Next: ${missionReportNextText(report.operator_next)}`,
      ])
      : ['No missions yet. Run: atris mission start "..." --owner <member>'],
    asJson,
  );
}

function timelineMission(args) {
  if (hasFlag(args, '--help') || hasFlag(args, '-h') || String(args[0] || '').trim() === 'help') {
    console.log('Usage: atris mission timeline [id] [--limit <n>] [--all] [--prune-preview] [--write] [--json]');
    console.log('Show saved landing outcomes; use --all --write for the full report.');
    return;
  }
  const asJson = wantsJson(args);
  const write = hasFlag(args, '--write');
  const all = hasFlag(args, '--all');
  const prunePreviewRequested = hasFlag(args, '--prune-preview');
  const outputPath = readFlag(args, '--output', '') || readFlag(args, '--out', '');
  const kindFilter = readFlag(args, '--kind', '') || null;
  const sinceFilter = readFlag(args, '--since', '') || null;
  const ref = stripKnownFlags(args, ['--limit', '--output', '--out', '--kind', '--since'], ['--json', '--write', '--all', '--prune-preview'])[0] || '';
  const limit = all ? Number.MAX_SAFE_INTEGER : readPositiveIntegerFlag(args, '--limit', 12, { json: asJson });
  const missions = listMissions();
  const mission = ref
    ? resolveMission(ref)
    : (missions.find((row) => !TERMINAL_STATUSES.has(row.status)) || missions[0] || null);
  if (ref && !mission) {
    exitMissingMission(ref, 1, asJson);
  }
  if (!mission) {
    printJsonOrText(
      {
        ok: true,
        action: 'mission_timeline',
        mission: null,
        timeline: [],
        empty_state_display: missionTimelineEmptyStateDisplay(null, 0),
      },
      ['No missions yet. Run: atris mission start "..." --owner <member>'],
      asJson,
    );
    return;
  }
  const root = mission.worktree_root || process.cwd();
  const timelineResult = missionLandingTimeline(mission, root, limit, { kind: kindFilter, since: sinceFilter });
  const timeline = timelineResult.items;
  const currentLanding = missionTimelineCurrentLanding(timeline);
  const timelineItemDisplay = (item) => ({
    changed_label: 'Changed',
    changed: item.changed || 'Landing recorded.',
    next_label: 'Next',
    next: item.next || null,
    proof_label: 'Proof',
    proof: item.receipt_path || null,
  });
  const currentLandingDisplay = currentLanding ? {
    label: 'Current landing',
    ...timelineItemDisplay(currentLanding),
  } : null;
  const historyWithoutCurrent = currentLanding ? timeline.slice(0, -1) : timeline;
  const historyWithoutCurrentDisplay = historyWithoutCurrent.map((item, index) => ({
    index: index + 1,
    label: `History item ${index + 1}`,
    ...timelineItemDisplay(item),
  }));
  const timelineDisplay = timeline.map((item, index) => ({
    index: index + 1,
    label: `Timeline item ${index + 1}`,
    at_label: 'When',
    at: item.at || null,
    ...timelineItemDisplay(item),
  }));
  const nextMove = missionTimelineNextMove(mission, currentLanding);
  const generatedAt = stampIso();
  let artifactPath = null;
  let prunePreview = null;
  if (write || prunePreviewRequested) {
    try {
      prunePreview = pruneRuns(root, { keepNewest: 200, keepDays: 14 });
    } catch (error) {
      prunePreview = { error: error.message || String(error) };
    }
  }
  if (write) {
    const outPath = outputPath
      ? path.resolve(root, outputPath)
      : defaultMissionTimelinePath(root, mission);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, missionTimelineMarkdown(mission, timeline, { prunePreview, generatedAt, timelineMeta: timelineResult.meta }), 'utf8');
    artifactPath = path.relative(root, outPath);
  }
  const pruneSummary = missionTimelinePruneSummaryObject(prunePreview);
  const pruneDisplay = {
    label: 'Prune preview',
    command: missionRunPrunePreviewCommand(mission),
    available: Boolean(pruneSummary),
    ok: pruneSummary?.ok ?? null,
    summary: pruneSummary?.text || null,
    would_prune_label: 'Would prune',
    prune_count: pruneSummary?.prune_count ?? null,
    prune_bytes_text: pruneSummary?.prune_bytes_text || null,
    deleted_label: 'Deleted',
    deleted_count: pruneSummary?.deleted_count ?? null,
  };
  const payload = {
    ok: true,
    action: 'mission_timeline',
    generated_at: generatedAt,
    generated: {
      label: 'Generated at',
      at: generatedAt,
    },
    schema_display: {
      label: 'Schema',
      name: 'atris.mission_timeline',
      version: 1,
      primary_objects: [
        'display',
        'summary_display',
        'navigation_display',
        'filter_display',
        'mission_display',
        'current_landing_display',
        'history_without_current_display',
        'timeline_display',
        'timeline_meta_display',
        'empty_state_display',
        'status_display',
        'actions_display',
        'proof_display',
        'receipt_display',
        'export_display',
        'prune_display',
        'artifact_display',
      ],
    },
    summary_display: {
      label: 'Summary',
      title: `Mission timeline: ${mission.objective}`,
      count: missionTimelineCountLine(timelineResult.meta),
      latest_label: 'Latest',
      latest: currentLanding?.changed || null,
      proof_label: 'Proof',
      proof: currentLanding?.receipt_path || null,
      next_label: 'Next',
      next: nextMove,
    },
    display: {
      title: `Mission timeline: ${mission.objective}`,
      generated: `Generated at: ${generatedAt}`,
      count: missionTimelineCountLine(timelineResult.meta),
      current_landing_label: 'Current landing',
      history_label: 'History',
      next_label: 'Next',
    },
    status_display: {
      label: 'Status',
      mission_status_label: 'Mission status',
      mission_status: mission.status,
      history_status_label: 'History status',
      history_status: timelineResult.meta.truncated ? 'Compact history' : 'Full history',
      count: missionTimelineCountLine(timelineResult.meta),
      truncated: Boolean(timelineResult.meta.truncated),
      hidden_count: timelineResult.meta.hidden_count,
    },
    empty_state_display: missionTimelineEmptyStateDisplay(mission, timeline.length),
    mission: {
      id: mission.id,
      objective: mission.objective,
      status: mission.status,
    },
    mission_labels: {
      mission: 'Mission',
      objective: 'Objective',
      status: 'Status',
    },
    mission_display: {
      label: 'Mission',
      title: mission.objective,
      id: mission.id,
      status: mission.status,
    },
    operator_commands: {
      timeline: missionRunTimelineCommand(mission),
      export: missionRunExportCommand(mission),
      prune_preview: missionRunPrunePreviewCommand(mission),
    },
    commands: {
      timeline: missionRunTimelineCommand(mission),
      export: missionRunExportCommand(mission),
      prune_preview: missionRunPrunePreviewCommand(mission),
    },
    actions_display: {
      label: 'Actions',
      items: [
        { label: 'Timeline', command: missionRunTimelineCommand(mission) },
        { label: 'Export', command: missionRunExportCommand(mission) },
        { label: 'Prune preview', command: missionRunPrunePreviewCommand(mission) },
      ],
    },
    navigation_display: {
      label: 'Navigation',
      current_label: 'Current view',
      current: 'timeline',
      items: [
        { key: 'timeline', label: 'Timeline', command: missionRunTimelineCommand(mission), active: true },
        { key: 'export', label: 'Full history', command: missionRunExportCommand(mission), active: false },
        { key: 'prune_preview', label: 'Prune preview', command: missionRunPrunePreviewCommand(mission), active: false },
      ],
    },
    filter_display: {
      label: 'Filters',
      active_label: 'Active filter',
      active: all ? 'full_history' : 'latest',
      mission_label: 'Mission',
      mission: mission.id,
      limit_label: 'Limit',
      limit: timelineResult.meta.limit,
      kind_label: 'Kind',
      kind: kindFilter,
      since_label: 'Since',
      since: sinceFilter,
      shown_count: timelineResult.meta.shown_count,
      total_count: timelineResult.meta.total_count,
      hidden_count: timelineResult.meta.hidden_count,
      truncated_label: 'Truncated',
      truncated: Boolean(timelineResult.meta.truncated),
      items: [
        { key: 'latest', label: 'Latest', command: missionRunTimelineCommand(mission), active: !all },
        { key: 'full_history', label: 'Full history', command: `atris mission timeline ${mission.id} --all`, active: Boolean(all) },
      ],
    },
    current_landing: currentLanding,
    current_landing_display: currentLandingDisplay,
    current_landing_label: 'Current landing',
    history_without_current: historyWithoutCurrent,
    history_without_current_display: historyWithoutCurrentDisplay,
    history_without_current_count: historyWithoutCurrent.length,
    has_history_without_current: historyWithoutCurrent.length > 0,
    history_label: 'History',
    labels: {
      current_landing: 'Current landing',
      history: 'History',
    },
    counts: {
      timeline: timeline.length,
      history_without_current: historyWithoutCurrent.length,
      total: timelineResult.meta.total_count,
      hidden: timelineResult.meta.hidden_count,
      shown: timelineResult.meta.shown_count,
    },
    booleans: {
      has_current_landing: Boolean(currentLanding),
      has_history_without_current: historyWithoutCurrent.length > 0,
      truncated: Boolean(timelineResult.meta.truncated),
      all: Boolean(all),
    },
    next_move: nextMove,
    next: {
      label: 'Next',
      move: nextMove,
      has_move: Boolean(nextMove),
    },
    timeline,
    timeline_display: timelineDisplay,
    timeline_meta: timelineResult.meta,
    timeline_meta_display: {
      label: 'Timeline metadata',
      shown_label: 'Shown',
      shown_count: timelineResult.meta.shown_count,
      total_label: 'Total',
      total_count: timelineResult.meta.total_count,
      hidden_label: 'Hidden',
      hidden_count: timelineResult.meta.hidden_count,
      limit_label: 'Limit',
      limit: timelineResult.meta.limit,
      truncated_label: 'Truncated',
      truncated: Boolean(timelineResult.meta.truncated),
    },
    all,
    prune_summary: pruneSummary,
    prune_display: pruneDisplay,
    prune_preview: prunePreview,
    artifact: {
      path: artifactPath,
      written: Boolean(artifactPath),
      format: artifactPath ? 'markdown' : null,
    },
    artifact_display: {
      label: 'Artifact',
      path_label: 'Path',
      path: artifactPath,
      written_label: 'Written',
      written: Boolean(artifactPath),
      format_label: 'Format',
      format: artifactPath ? 'markdown' : null,
    },
    export_display: {
      label: 'Export',
      command: missionRunExportCommand(mission),
      report_label: 'Saved report',
      report_path: artifactPath,
      report_written: Boolean(artifactPath),
      report_format: artifactPath ? 'markdown' : null,
    },
    receipt_display: {
      label: 'Receipts',
      latest_label: 'Latest receipt',
      latest_path: currentLanding?.receipt_path || null,
      has_latest: Boolean(currentLanding?.receipt_path),
      count_label: 'Receipts',
      count: timeline.filter((item) => item.receipt_path).length,
      items: timeline.map((item, index) => ({
        index: index + 1,
        label: `Receipt ${index + 1}`,
        path: item.receipt_path || null,
        at: item.at || null,
        current: Boolean(currentLanding?.receipt_path && item.receipt_path === currentLanding.receipt_path),
      })),
    },
    proof_display: {
      label: 'Proof',
      latest_receipt_label: 'Latest receipt',
      latest_receipt_path: currentLanding?.receipt_path || null,
      report_label: 'Saved report',
      report_path: artifactPath,
      report_written: Boolean(artifactPath),
      report_format: artifactPath ? 'markdown' : null,
    },
    artifact_path: artifactPath,
  };
  const hideHistoricalNext = Boolean(missionBudgetContinuationText(mission));
  const lines = timeline.length
    ? [
      `Mission timeline: ${mission.objective}`,
      `Generated at: ${generatedAt}`,
      missionTimelineCountLine(timelineResult.meta),
      ...missionTimelineCurrentLandingLines(mission, currentLanding),
      ...(historyWithoutCurrent.length ? ['History:'] : []),
      ...historyWithoutCurrent.flatMap((item, index) => [
        `  ${index + 1}. ${item.changed || 'Landing recorded.'}`,
        ...(item.next && !hideHistoricalNext ? [`     Next at the time: ${item.next}`] : []),
      ]),
    ]
    : [
      `Mission timeline: ${mission.objective}`,
      `Generated at: ${generatedAt}`,
      missionTimelineCountLine(timelineResult.meta),
      '  No landing receipts yet.',
      `  Next: atris mission run ${mission.id} --create-next`,
    ];
  if (timelineResult.meta.truncated) lines.push(`Full history: ${missionRunExportCommand(mission)}`);
  if (artifactPath) lines.push(`Saved: ${artifactPath}`);
  const pruneLine = missionTimelinePruneSummaryLine(prunePreview);
  if (pruneLine) lines.push(pruneLine);
  printJsonOrText(payload, lines, asJson);
}

function missionReceiptHealth(mission, root = process.cwd()) {
  const receiptPath = String(mission?.receipt_path || '').trim();
  if (!receiptPath) return { ok: false, reason: 'missing_receipt_path' };
  const file = path.isAbsolute(receiptPath) ? receiptPath : path.join(root, receiptPath);
  let receipt = null;
  try {
    receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { ok: false, reason: 'receipt_not_found', receipt_path: receiptPath };
  }
  const missionVerifierPassedState = mission?.verifier_result?.passed === true;
  const receiptPassed = receipt?.result?.passed === true
    || receipt?.result?.verifier_result?.passed === true;
  if (!missionVerifierPassedState || !receiptPassed) {
    return { ok: false, reason: 'verifier_not_passed', receipt_path: receiptPath };
  }
  return { ok: true, reason: 'verifier_passed', receipt_path: receiptPath };
}

function missionIsDriveParked(mission) {
  if (String(mission?.status || '').toLowerCase() !== 'paused') return false;
  const reason = String(mission?.stop_reason || '').toLowerCase();
  return reason.startsWith('drive:') && reason.includes('auto-parked');
}

function collectMissionDoctorFindings(root = process.cwd(), options = {}) {
  const localOnly = options.localOnly === true;
  let missions = listMissions(root);
  if (!localOnly) {
    const seen = new Set(missions.map((mission) => mission.id));
    for (const rolled of listWorktreeRollupMissions(root)) {
      if (seen.has(rolled.id)) continue;
      seen.add(rolled.id);
      missions.push(rolled);
    }
  }
  missions = missions.map(missionStatusView);
  const findings = [];
  const add = (mission, code, message, severity = 'high', extra = {}) => {
    findings.push({
      severity,
      code,
      mission_id: mission.id,
      owner: mission.owner,
      status: mission.status,
      objective: mission.objective,
      message,
      next: extra.next || `atris mission status ${mission.id}`,
      ...extra,
    });
  };

  for (const mission of missions) {
    const status = String(mission.status || '');
    const active = !TERMINAL_STATUSES.has(status);
    const objective = String(mission.objective || '').trim();
    // Only drive's explicit auto-park reason settles a no-verifier mission.
    // Other paused no-verifier missions still need a verifier or a deliberate
    // park, otherwise doctor and drive silently disagree about stale work.
    if (active && !missionIsDriveParked(mission) && !effectiveMissionVerifier(mission)) {
      add(
        mission,
        'missing_verifier',
        'Mission has no verifier, so it cannot prove done work.',
        'high',
        { next: `atris mission start "${objective}" --owner ${mission.owner} --verify "<cmd>"` },
      );
    }
    if (active && /^(?:--)?help$/i.test(objective)) {
      add(
        mission,
        'accidental_help_mission',
        'Looks like a help flag became a mission.',
        'medium',
        { next: `atris mission stop ${mission.id} --reason "accidental help mission"` },
      );
    }
    if (status === 'ready') {
      const receiptRoot = mission.worktree_root || root;
      const health = missionReceiptHealth(mission, receiptRoot);
      if (!health.ok) {
        add(
          mission,
          'stale_ready_receipt',
          `Ready mission does not have a fresh passing receipt (${health.reason}).`,
          'high',
          {
            receipt_path: health.receipt_path || mission.receipt_path || null,
            receipt_reason: health.reason,
            next: `atris mission tick ${mission.id} --verify`,
          },
        );
      }
    }
    if (mission.always_on === true && status === 'blocked') {
      add(
        mission,
        'blocked_always_on_loop',
        'Always-on mission is blocked and will not keep improving.',
        'high',
        { next: `atris mission run ${mission.id} --max-ticks 1` },
      );
    }
  }

  findings.sort((a, b) => {
    const rank = { high: 0, medium: 1, low: 2 };
    return (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9)
      || String(a.code).localeCompare(String(b.code))
      || String(a.objective).localeCompare(String(b.objective));
  });
  return { missions, findings };
}

function doctorMission(args) {
  if (hasFlag(args, '--help') || hasFlag(args, '-h') || String(args[0] || '').trim() === 'help') {
    console.log('Usage: atris mission doctor [--local] [--json]');
    console.log('Check verifier, receipt, and loop health without changing mission state.');
    return;
  }
  const asJson = wantsJson(args);
  const localOnly = hasFlag(args, '--local');
  const { missions, findings } = collectMissionDoctorFindings(process.cwd(), { localOnly });
  const payload = {
    ok: findings.length === 0,
    action: 'mission_doctor',
    checked_count: missions.length,
    finding_count: findings.length,
    findings,
  };
  const lines = findings.length
    ? [
      `Mission doctor: ${findings.length} problem(s) across ${missions.length} mission(s)`,
      ...findings.map((finding) => `${finding.severity.toUpperCase()} ${finding.code}: ${finding.objective} -> ${finding.next}`),
    ]
    : [`Mission doctor: clean (${missions.length} mission(s) checked)`];
  printJsonOrText(payload, lines, asJson);
  if (findings.length) process.exitCode = 1;
}

// `atris mission watch [id]` — read-only live heartbeat. Prints a line per tick as it
// lands so a human (or any terminal) can see the loop is alive without rerunning status.
function watchMission(args) {
  if (hasFlag(args, '--help') || hasFlag(args, '-h') || String(args[0] || '').trim() === 'help') {
    console.log('Usage: atris mission watch [id] [--interval <s>] [--idle-every <s>]');
    console.log('Watch live mission heartbeat lines without changing mission state.');
    return;
  }
  const ref = stripKnownFlags(args, ['--interval', '--idle-every'], [])[0] || '';
  const intervalSeconds = Math.max(1, parseInt(readFlag(args, '--interval', '2'), 10) || 2);
  const idleEverySeconds = Math.max(1, parseInt(readFlag(args, '--idle-every', '30'), 10) || 30);
  const loadTargets = () => {
    if (ref) {
      const mission = resolveMission(ref);
      return mission ? [mission] : [];
    }
    return listMissions().filter((mission) => !HEARTBEAT_TERMINAL_STATUSES.has(mission.status));
  };
  if (ref && !loadTargets().length) {
    exitMissingMission(ref, 1, false);
  }
  const stamp = () => new Date().toTimeString().slice(0, 8);
  const emit = (mission, note) => console.log(`[${stamp()}] ${mission.owner} ${missionLabel(mission)} - ${note}`);
  const fingerprint = (mission) => [mission.status, mission.last_tick_at, mission.last_tick_index, mission.receipt_path].join('|');
  const tickNote = (mission) => {
    const heartbeat = missionHeartbeatLines(mission).map((line) => line.trim()).join(', ');
    return `${heartbeat || `state: ${mission.status}`}${mission.receipt_path ? ` — proof: ${mission.receipt_path}` : ''}`;
  };
  const seen = new Map();
  let lastIdleAt = Date.now();
  console.log(`watching ${ref || 'active missions'} every ${intervalSeconds}s - ctrl+c to stop`);
  const poll = () => {
    const targets = loadTargets();
    if (!targets.length && !seen.size) {
      emitOnce('no active missions yet — waiting');
    }
    let changed = false;
    for (const mission of targets) {
      const fp = fingerprint(mission);
      if (seen.get(mission.id) !== fp) {
        seen.set(mission.id, fp);
        emit(mission, tickNote(mission));
        changed = true;
      }
    }
    if (changed) {
      lastIdleAt = Date.now();
    } else if (Date.now() - lastIdleAt >= idleEverySeconds * 1000) {
      lastIdleAt = Date.now();
      for (const mission of targets) {
        emit(mission, `alive, ${missionHeartbeatLines(mission).map((line) => line.trim()).join(', ') || `state: ${mission.status}`}`);
      }
    }
  };
  let warnedEmpty = false;
  const emitOnce = (message) => {
    if (warnedEmpty) return;
    warnedEmpty = true;
    console.log(`[${stamp()}] ${message}`);
  };
  poll();
  setInterval(poll, intervalSeconds * 1000);
  // The bin router exits when the command's promise settles; watch runs until ctrl+c.
  return new Promise(() => {});
}

function writeReceipt(mission, result, root = process.cwd()) {
  const paths = statePaths(root);
  fs.mkdirSync(paths.runsDir, { recursive: true });
  const safeTime = stampIso().replace(/[:.]/g, '-');
  const receiptPath = path.join(paths.runsDir, `mission-${mission.id}-${safeTime}.json`);
  const relativeReceiptPath = path.relative(root, receiptPath);
  const finalResult = normalizeMissionReceiptResult(mission, result, relativeReceiptPath);
  const receipt = {
    schema: 'atris.mission_receipt.v1',
    mission_id: mission.id,
    objective: mission.objective,
    owner: mission.owner,
    at: stampIso(),
    verifier: mission.verifier || null,
    result: finalResult,
  };
  receipt.render = {
    version: 1,
    card: renderCard(receipt),
    page_section: renderPageSection(receipt),
    email_line: renderEmailLine(receipt),
    morning_card_row: renderMorningCardRow(receipt),
  };
  fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', 'utf8');
  return relativeReceiptPath;
}

function shellQuote(value) {
  return `'${String(value || '').replace(/'/g, `'\\''`)}'`;
}

function resolveVerifierCommand(command) {
  const raw = String(command || '');
  const leading = raw.match(/^\s*/)?.[0] || '';
  const trimmed = raw.trimStart();
  if (!trimmed || !/^atris(?:\s|$)/.test(trimmed)) return raw;
  const cliPath = path.resolve(__dirname, '..', 'bin', 'atris.js');
  return `${leading}${shellQuote(process.execPath)} ${shellQuote(cliPath)}${trimmed.slice('atris'.length)}`;
}

function missionVerifierTimeoutMs(env = process.env) {
  const parsed = Number(env.ATRIS_MISSION_VERIFIER_TIMEOUT_MS);
  if (Number.isFinite(parsed) && parsed >= 1000) return Math.floor(parsed);
  return 120000;
}

function runVerifier(command, root = process.cwd()) {
  if (!command) return null;
  const resolvedCommand = resolveVerifierCommand(command);
  const { envWithNodeDir } = require('../lib/spawn-env');
  const result = spawnSync(resolvedCommand, {
    cwd: root,
    shell: true,
    encoding: 'utf8',
    timeout: missionVerifierTimeoutMs(),
    env: envWithNodeDir(process.env),
  });
  return {
    command,
    resolved_command: resolvedCommand === command ? null : resolvedCommand,
    status: result.status,
    signal: result.signal || null,
    passed: result.status === 0,
    stdout: String(result.stdout || '').slice(-4000),
    stderr: String(result.stderr || '').slice(-4000),
  };
}

const REVIEW_LANE_DRAIN_TIMEOUT_MS = 120000;

// Bounded agent-side review sweep, recorded on the tick. Failures never break
// the mission loop; they surface in the tick record instead.
function runReviewLaneDrain(root = process.cwd()) {
  const cliPath = path.resolve(__dirname, '..', 'bin', 'atris.js');
  const res = spawnSync(process.execPath, [cliPath, 'task', 'review-lane-run', '--json'], {
    cwd: root,
    encoding: 'utf8',
    timeout: REVIEW_LANE_DRAIN_TIMEOUT_MS,
  });
  let receipt = null;
  try {
    receipt = JSON.parse(res.stdout);
  } catch { /* fall through to error shape */ }
  if (!receipt) {
    return {
      ok: false,
      error: 'review_lane_run_unparseable',
      status: res.status ?? null,
      stderr: String(res.stderr || '').slice(-400),
    };
  }
  return {
    ok: receipt.ok === true,
    run_count: receipt.run_count ?? null,
    total_acted_count: receipt.total_acted_count ?? 0,
    stopped_reason: receipt.stopped_reason || null,
    receipt_path: receipt.receipt_path || null,
  };
}

function gitWorktreeSnapshot(root = process.cwd()) {
  const inside = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 5000,
  });
  if (inside.status !== 0 || String(inside.stdout || '').trim() !== 'true') {
    return { available: false, reason: 'not-git-worktree' };
  }
  const status = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 10000,
  });
  if (status.status !== 0) {
    return {
      available: false,
      reason: 'git-status-failed',
      stderr: String(status.stderr || '').slice(-1000),
    };
  }
  const entries = String(status.stdout || '').split(/\r?\n/).filter(Boolean).sort();
  const digest = crypto.createHash('sha1').update(entries.join('\n')).digest('hex');
  return {
    available: true,
    dirty_count: entries.length,
    dirty_hash: digest,
    dirty_sample: entries.slice(0, 25),
    entries,
  };
}

// Porcelain v1 entries are "XY path" or "XY old -> new"; baselines compare by
// post-rename path so a status-letter change alone never counts as new dirt.
function porcelainEntryPath(line) {
  const trimmed = String(line || '').slice(3);
  const arrow = trimmed.indexOf(' -> ');
  return arrow >= 0 ? trimmed.slice(arrow + 4) : trimmed;
}

const LOOP_EXHAUST_PREFIXES = ['.atris/', 'atris/runs/', 'atris/status/'];

function isLoopExhaustPath(entryPath) {
  return LOOP_EXHAUST_PREFIXES.some((prefix) => String(entryPath).startsWith(prefix));
}

function missionBaselinePath(missionId, root = process.cwd()) {
  return path.join(root, '.atris', 'state', 'mission-baselines', `${missionId}.json`);
}

// Write-once sidecar capturing the dirt the mission inherited. Receipts subtract
// these paths so pre-existing workspace noise stops flagging unverified_dirty.
// Stored outside missions.jsonl because that log re-appends the full mission
// record on every save. Captured after start bookkeeping so the mission's own
// state writes land inside the baseline, not in new_since_baseline.
function captureMissionWorktreeBaseline(mission, root = process.cwd()) {
  const snapshot = gitWorktreeSnapshot(root);
  if (!snapshot.available) return null;
  const baselineFile = missionBaselinePath(mission.id, root);
  const paths = new Set((snapshot.entries || []).map(porcelainEntryPath));
  // The sidecar itself and the per-tick lock are mission bookkeeping; without
  // these the mission would flag its own state files as unverified dirt.
  paths.add(path.relative(root, baselineFile));
  paths.add(path.relative(root, path.join(root, '.atris', 'state', `mission-${mission.id}.lock`)));
  const baseline = {
    schema: 'atris.mission_worktree_baseline.v1',
    mission_id: mission.id,
    captured_at: stampIso(),
    dirty_count: snapshot.dirty_count,
    dirty_hash: snapshot.dirty_hash,
    paths: Array.from(paths).sort(),
  };
  fs.mkdirSync(path.dirname(baselineFile), { recursive: true });
  fs.writeFileSync(baselineFile, JSON.stringify(baseline, null, 2) + '\n', 'utf8');
  return baseline;
}

function loadMissionWorktreeBaseline(missionId, root = process.cwd()) {
  try {
    const baseline = JSON.parse(fs.readFileSync(missionBaselinePath(missionId, root), 'utf8'));
    return Array.isArray(baseline?.paths) ? baseline : null;
  } catch {
    return null;
  }
}

// Closed missions no longer tick, so the sidecar is dead weight; prune it and
// fold a compact audit summary into the mission record (full path lists stay
// out of missions.jsonl, which re-appends the whole record on every save).
// Paused missions keep their sidecar — resume ticks still subtract it.
function pruneMissionWorktreeBaseline(mission, root = process.cwd()) {
  const baseline = loadMissionWorktreeBaseline(mission.id, root);
  try { fs.rmSync(missionBaselinePath(mission.id, root), { force: true }); } catch {}
  if (!baseline) return null;
  return {
    captured_at: baseline.captured_at,
    dirty_count: baseline.dirty_count,
    dirty_hash: baseline.dirty_hash,
    path_count: baseline.paths.length,
  };
}

function worktreeReceipt(before, after, { verifier = '', baseline = null } = {}) {
  if (!before?.available || !after?.available) {
    return {
      available: false,
      before_reason: before?.reason || null,
      after_reason: after?.reason || null,
    };
  }
  const beforeSet = new Set(before.entries || []);
  const afterSet = new Set(after.entries || []);
  const newDirty = (after.entries || []).filter((entry) => !beforeSet.has(entry));
  const clearedDirty = (before.entries || []).filter((entry) => !afterSet.has(entry));
  const changed = before.dirty_hash !== after.dirty_hash;
  const hasVerifier = !!String(verifier || '').trim();
  // Baseline = dirt the mission inherited (mission-start sidecar when present,
  // tick-start snapshot for legacy missions). Only paths dirtied beyond that
  // baseline count toward the unverified signal. Loop exhaust the mission
  // writes about itself (state plane, receipts, rendered status) is not work
  // product, so it never counts — otherwise every multi-tick mission in a repo
  // that doesn't gitignore those dirs would flag its own bookkeeping.
  const baselinePaths = baseline
    ? new Set(baseline.paths)
    : new Set((before.entries || []).map(porcelainEntryPath));
  const newSinceBaseline = Array.from(new Set((after.entries || []).map(porcelainEntryPath)))
    .filter((entryPath) => !baselinePaths.has(entryPath) && !isLoopExhaustPath(entryPath));
  return {
    available: true,
    before_dirty_count: before.dirty_count,
    after_dirty_count: after.dirty_count,
    changed,
    baseline_source: baseline ? 'mission_start' : 'tick_start',
    baseline_dirty_count: baseline ? baseline.dirty_count : before.dirty_count,
    new_since_baseline_count: newSinceBaseline.length,
    new_since_baseline_sample: newSinceBaseline.slice(0, 25),
    unverified_dirty: !hasVerifier && newSinceBaseline.length > 0,
    unverified_change: !hasVerifier && changed,
    new_dirty_count: newDirty.length,
    cleared_dirty_count: clearedDirty.length,
    dirty_sample_after: after.dirty_sample,
    new_dirty_sample: newDirty.slice(0, 25),
    cleared_dirty_sample: clearedDirty.slice(0, 25),
    before_dirty_hash: before.dirty_hash,
    after_dirty_hash: after.dirty_hash,
  };
}

// ---------------------------------------------------------------------------
// `atris mission run <id>` — bounded local headless loop. v0.1.
// Spawns `claude -p --resume <session>` per tick. Honors cadence, active-hours,
// rate-limit info, and a flock per mission. `max-ticks` bounds total attempts;
// `ran_ticks` separately reports ticks that actually made progress.
// ---------------------------------------------------------------------------

const MISSION_RUN_DEFAULTS = {
  maxTicks: 4,
  maxWallSeconds: 3600,
  claudeTimeoutMs: 10 * 60 * 1000,
  backoff: { initialMs: 30_000, maxMs: 10 * 60_000, factor: 2, jitter: 0.3 },
  // BCK-1324: consecutive no-progress ticks before an honest early stop.
  maxIdleTicks: 3,
};

// Claude sessions accumulate context across resumed ticks; an always-on
// mission would grow without bound. Continuity lives on disk (receipts, logs,
// now.md), so a healthy session is disposable: rotate to a fresh one every N
// ran ticks. Failure-path rotation (stale lock) stays separate below.
const CLAUDE_SESSION_CONTEXT_ROTATE_TICKS = Math.max(
  1,
  Number(process.env.ATRIS_CLAUDE_SESSION_ROTATE_TICKS) || 8,
);

function runnerUsesCallerSession(runner) {
  return new Set(['codex_goal', 'caller_session', 'current_agent']).has(String(runner || '').trim().toLowerCase());
}

function isCodexGoalMission(mission) {
  return String(mission?.runner || '').trim().toLowerCase() === 'codex_goal';
}

function nextCandidateTickAction(mission) {
  const completeFlag = mission.always_on ? '' : ' --complete-on-pass';
  return `next move: run atris mission run ${mission.id}${completeFlag}`;
}

function nextCandidateRunCommand(mission) {
  return `atris mission run ${mission.id}`;
}

function missionVerifierPassed(mission) {
  return (mission && mission.verifier_result && mission.verifier_result.passed) === true;
}

function missionDueAt(mission, now = new Date()) {
  const cadenceSeconds = parseCadenceSeconds(mission.cadence);
  if (!mission.last_tick_at) return true;
  if (cadenceSeconds === 0) return !(mission.always_on && missionVerifierPassed(mission));
  const lastTickAt = Date.parse(mission.last_tick_at);
  if (!Number.isFinite(lastTickAt)) return true;
  return now.getTime() - lastTickAt >= cadenceSeconds * 1000;
}

function missionSelectableForLoop(mission, now = new Date()) {
  return missionIsRunnable(mission)
    && !(mission.always_on && missionVerifierPassed(mission) && !missionDueAt(mission, now));
}

function secondsUntilMissionDue(mission, now = new Date()) {
  const cadenceSeconds = parseCadenceSeconds(mission?.cadence);
  if (!mission || !mission.last_tick_at || cadenceSeconds === 0) return 0;
  const lastTickAt = Date.parse(mission.last_tick_at);
  if (!Number.isFinite(lastTickAt)) return 0;
  const dueAt = lastTickAt + cadenceSeconds * 1000;
  return Math.max(0, Math.ceil((dueAt - now.getTime()) / 1000));
}

function formatDurationShort(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.round((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d`;
}

const HEARTBEAT_TERMINAL_STATUSES = new Set(['complete', 'stopped', 'paused']);

function missionHeartbeatLines(mission, now = new Date()) {
  const lines = [];
  const lastTickAt = mission.last_tick_at ? Date.parse(mission.last_tick_at) : NaN;
  if (Number.isFinite(lastTickAt)) {
    const age = formatDurationShort((now.getTime() - lastTickAt) / 1000);
    const verifier = effectiveMissionVerifier(mission)
      ? (mission.verifier_result ? (mission.verifier_result.passed ? 'verifier passed' : 'verifier failed') : 'verifier not run')
      : 'no verifier';
    const tickIdx = mission.last_tick_index != null ? `#${mission.last_tick_index}, ` : '';
    const layerSuffix = mission.last_tick_layer ? `, layer: ${mission.last_tick_layer}` : '';
    const activityLabel = missionBudgetContinuationText(mission, now.getTime())
      ? 'last mission receipt'
      : 'last tick';
    lines.push(`  ${activityLabel}: ${age} ago (${tickIdx}${mission.last_tick_status || 'unknown'}, ${verifier}${layerSuffix})`);
  } else if (!HEARTBEAT_TERMINAL_STATUSES.has(mission.status)) {
    lines.push('  last tick: never');
  }
  if (parseCadenceSeconds(mission.cadence) > 0 && !HEARTBEAT_TERMINAL_STATUSES.has(mission.status)) {
    const budgetRemaining = missionFullBudgetRemainingSeconds(mission, now.getTime());
    if (budgetRemaining > 0) {
      lines.push(`  budget: ${formatDurationShort(budgetRemaining)} remaining`);
    } else {
      const dueIn = secondsUntilMissionDue(mission, now);
      lines.push(dueIn === 0 ? '  due: now' : `  due: in ${formatDurationShort(dueIn)}`);
    }
  }
  return lines;
}

function missionHasHumanAsks(mission) {
  return Array.isArray(mission?.human_asks)
    && mission.human_asks.some((ask) => String(ask || '').trim());
}

function missionTaskHumanAcceptWaiting(mission) {
  const taskId = missionTaskSpine(mission)?.task_id;
  if (!taskId) return false;
  try {
    const taskDb = require('../lib/task-db');
    const db = taskDb.open();
    const task = taskDb.getTask(db, taskId);
    if (!task) return false;
    const metadata = task.metadata || {};
    return task.status === 'review'
      && metadata.approval_status === 'pending'
      && metadata.agent_certified === true;
  } catch {
    return false;
  }
}

function missionIsRunnable(mission) {
  return mission
    && GOAL_LOOP_STATUSES.has(String(mission.status || ''))
    && !missionHasHumanAsks(mission);
}

// Fresh goal selection: moving work outranks review-parked work. A ready
// mission stays selectable (its next action is native-goal completion /
// review), but it must never beat a running or planning mission on recency.
const GOAL_SELECTION_STATUS_RANK = { running: 0, planning: 1, ready: 2 };

function missionGoalSelectionRank(mission) {
  const rank = GOAL_SELECTION_STATUS_RANK[String(mission?.status || '')];
  return Number.isFinite(rank) ? rank : 3;
}

function missionSortTime(mission) {
  return Date.parse(mission?.updated_at || mission?.created_at || '') || 0;
}

function selectDueMission(root = process.cwd(), now = new Date(), options = {}) {
  const candidates = listMissions(root)
    .filter((mission) => missionSelectableForLoop(mission, now))
    .filter((mission) => !options.headlessOnly || !runnerUsesCallerSession(mission.runner))
    .filter((mission) => !missionTaskHumanAcceptWaiting(mission))
    .filter((mission) => effectiveMissionVerifier(mission) || callerSessionMissionReadyForDue(mission))
    .filter((mission) => mission.always_on || !missionVerifierPassed(mission))
    .filter((mission) => missionDueAt(mission, now));

  candidates.sort((a, b) => {
    const aCaller = runnerUsesCallerSession(a.runner) ? 1 : 0;
    const bCaller = runnerUsesCallerSession(b.runner) ? 1 : 0;
    if (aCaller !== bCaller) return bCaller - aCaller;

    const aTime = missionSortTime(a);
    const bTime = missionSortTime(b);
    return bTime - aTime;
  });
  return candidates[0] || null;
}

function callerSessionMissionReadyForDue(mission) {
  return runnerUsesCallerSession(mission?.runner)
    && mission?.always_on === true
    && Boolean(codexNativeGoalAck(mission))
    && missionTaskSpine(mission)?.has_task === true;
}

function missionSelectableForCodexGoal(mission, now = new Date()) {
  if (!missionIsRunnable(mission)) return false;
  if (missionTaskHumanAcceptWaiting(mission)) return false;
  if (mission.always_on && missionVerifierPassed(mission) && !missionDueAt(mission, now)) {
    return parseCadenceSeconds(mission.cadence) > 0;
  }
  return true;
}

function selectCodexGoalMission(root = process.cwd(), options = {}, now = new Date()) {
  const requestedId = String(options.missionId || '').trim();
  const candidates = listMissions(root)
    .filter((mission) => runnerUsesCallerSession(mission.runner))
    .filter((mission) => missionSelectableForCodexGoal(mission, now));
  if (requestedId) {
    const exact = candidates.find((mission) => missionMatchesRef(mission, requestedId));
    if (exact) {
      const due = effectiveMissionVerifier(exact) && missionDueAt(exact, now);
      return { mission: exact, reason: due ? 'due' : 'selected' };
    }
  }

  candidates.sort((a, b) => {
    const aRank = missionGoalSelectionRank(a);
    const bRank = missionGoalSelectionRank(b);
    if (aRank !== bRank) return aRank - bRank;

    const aCaller = runnerUsesCallerSession(a.runner) ? 1 : 0;
    const bCaller = runnerUsesCallerSession(b.runner) ? 1 : 0;
    if (aCaller !== bCaller) return bCaller - aCaller;

    const aVerifier = effectiveMissionVerifier(a) ? 1 : 0;
    const bVerifier = effectiveMissionVerifier(b) ? 1 : 0;
    if (aVerifier !== bVerifier) return bVerifier - aVerifier;

    const aTime = missionSortTime(a);
    const bTime = missionSortTime(b);
    return bTime - aTime;
  });

  const mission = candidates[0] || null;
  if (!mission) return null;
  const due = effectiveMissionVerifier(mission) && missionDueAt(mission, now);
  return { mission, reason: due ? 'due' : 'active' };
}

function selectAtrisGoalMission(root = process.cwd(), options = {}, now = new Date()) {
  const requestedId = String(options.missionId || '').trim();
  const runnable = listMissions(root).filter((mission) => missionIsRunnable(mission));
  if (requestedId) {
    const exact = runnable.find((mission) => missionMatchesRef(mission, requestedId));
    if (exact) return { mission: exact, reason: 'selected' };
  }
  runnable.sort((a, b) => {
    const aRank = missionGoalSelectionRank(a);
    const bRank = missionGoalSelectionRank(b);
    if (aRank !== bRank) return aRank - bRank;

    const aDue = effectiveMissionVerifier(a) && missionDueAt(a, now) ? 1 : 0;
    const bDue = effectiveMissionVerifier(b) && missionDueAt(b, now) ? 1 : 0;
    if (aDue !== bDue) return bDue - aDue;

    const aTime = missionSortTime(a);
    const bTime = missionSortTime(b);
    return bTime - aTime;
  });
  const mission = runnable[0] || null;
  if (!mission) return null;
  const due = effectiveMissionVerifier(mission) && missionDueAt(mission, now);
  return { mission, reason: due ? 'due' : 'active' };
}

function codexGoalObjective(mission) {
  return mission.objective;
}

function codexNativeGoalAck(mission) {
  const ack = mission?.native_goal_ack || null;
  if (!ack || String(ack.runtime || '').toLowerCase() !== 'codex') return null;
  if (ack.status !== 'active') return null;
  if (ack.mission_id && String(ack.mission_id) !== String(mission?.id || '')) return null;
  return ack;
}

function supersedeOtherCodexNativeGoalAcks(root, activeMission, activeAck) {
  const activeMissionId = String(activeMission?.id || '');
  if (!activeMissionId) return [];
  const supersededAt = stampIso();
  const superseded = [];
  for (const mission of listMissions(root)) {
    if (String(mission.id || '') === activeMissionId) continue;
    const priorAck = codexNativeGoalAck(mission);
    if (!priorAck) continue;
    const nextAck = {
      ...priorAck,
      status: 'superseded',
      superseded_at: supersededAt,
      superseded_by_mission_id: activeMissionId,
      superseded_by_objective: activeAck?.objective || activeMission.objective,
    };
    const { mission: saved } = saveMission(
      { ...mission, native_goal_ack: nextAck },
      root,
      'mission_native_goal_ack_superseded',
      {
        superseded_by_mission_id: activeMissionId,
        superseded_by_objective: activeAck?.objective || activeMission.objective,
        previous_ack: priorAck,
      },
    );
    superseded.push({
      mission_id: saved.id,
      objective: saved.objective,
      previous_ack: priorAck,
      native_goal_ack: nextAck,
    });
  }
  return superseded;
}

function codexRuntimeGoalStateFromOptions(options = {}) {
  const rawStatus = String(options.nativeGoalStatus || options.visibleGoalStatus || '').trim();
  const status = normalizeCodexNativeGoalStatus(rawStatus);
  const objective = String(options.nativeGoalObjective || options.visibleGoalObjective || '').trim();
  if (!status && !objective) return null;
  return {
    status: status || null,
    raw_status: rawStatus || null,
    objective: objective || null,
  };
}

function normalizeCodexNativeGoalStatus(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const compact = raw.toLowerCase().replace(/[-_\s]+/g, '');
  if (compact === 'usagelimited') return 'usage_limited';
  if (compact === 'active') return 'active';
  if (compact === 'paused') return 'paused';
  return raw.toLowerCase();
}

function codexRuntimeGoalStatusLabel(runtimeGoalState) {
  const status = runtimeGoalState?.status || '';
  if (status === 'usage_limited') return 'usageLimited';
  return runtimeGoalState?.raw_status || status || 'unknown';
}

function codexRuntimeGoalMatchesObjective(runtimeGoalState, objective) {
  if (!runtimeGoalState || !CODEX_NATIVE_GOAL_SLOT_STATUSES.has(runtimeGoalState.status)) return false;
  return Boolean(runtimeGoalState.objective) && runtimeGoalState.objective === String(objective || '');
}

function codexRuntimeStateBlocksMissionSlot(runtimeGoalState, mission) {
  if (!runtimeGoalState) return true;
  if (runtimeGoalState.status && !CODEX_NATIVE_GOAL_SLOT_STATUSES.has(runtimeGoalState.status)) return false;
  if (!runtimeGoalState.objective) return CODEX_NATIVE_GOAL_SLOT_STATUSES.has(runtimeGoalState.status);
  return runtimeGoalState.objective === codexGoalObjective(mission);
}

function codexRuntimeStateCanAutoAckMission(runtimeGoalState, mission) {
  if (!runtimeGoalState || !mission) return false;
  if (runtimeGoalState.status !== 'active') return false;
  if (!runtimeGoalState.objective) return false;
  return codexRuntimeStateBlocksMissionSlot(runtimeGoalState, mission);
}

function codexGoalAckCommand(mission, objective = codexGoalObjective(mission)) {
  return `atris mission goal ack ${mission.id} --runtime codex --status active --objective ${shellQuote(objective)} --json`;
}

function recordCodexNativeGoalAck(mission, root = process.cwd(), options = {}) {
  const canonicalObjective = codexGoalObjective(mission);
  const reportedObjective = String(options.reportedObjective || canonicalObjective).trim();
  const ack = {
    runtime: 'codex',
    status: 'active',
    mission_id: mission.id,
    objective: canonicalObjective,
    ...(reportedObjective && reportedObjective !== canonicalObjective ? { reported_objective: reportedObjective } : {}),
    acknowledged_at: stampIso(),
  };
  const nextMission = {
    ...mission,
    native_goal_ack: ack,
    next_action: codexGoalNextCommand({ ...mission, native_goal_ack: ack }),
  };
  const supersededNativeGoalAcks = supersedeOtherCodexNativeGoalAcks(root, nextMission, ack);
  const { mission: saved } = saveMission(
    nextMission,
    root,
    options.eventName || 'mission_native_goal_ack',
    { ack, ...(options.eventDetail || {}) },
  );
  return { saved, ack, supersededNativeGoalAcks };
}

function maybeAutoAckCodexNativeGoal(mission, root = process.cwd(), options = {}) {
  if (options.manualAck === true) return null;
  if (!isCodexGoalMission(mission) || codexNativeGoalAck(mission)) return null;
  const runtimeGoalState = codexRuntimeGoalStateFromOptions(options);
  if (!codexRuntimeStateCanAutoAckMission(runtimeGoalState, mission)) return null;
  return recordCodexNativeGoalAck(mission, root, {
    reportedObjective: runtimeGoalState.objective,
    eventName: 'mission_native_goal_auto_ack',
    eventDetail: { runtime_goal_state: runtimeGoalState },
  });
}

function codexNativeGoalReplaceAction(newMission, activeMission, runtimeGoalState = null, commands = {}) {
  const fromObjective = codexGoalObjective(activeMission);
  const toObjective = codexGoalObjective(newMission);
  return {
    runtime: 'codex',
    tool: 'replace_goal',
    available: false,
    blocked_by: 'codex_runtime_missing_replace_goal_tool',
    args: {
      objective: toObjective,
      from_objective: fromObjective,
      to_objective: toObjective,
      from_mission_id: activeMission.id,
      to_mission_id: newMission.id,
      current_status: runtimeGoalState?.status || null,
    },
    after_success: {
      ack_new_mission: commands.ack_new_mission || codexGoalAckCommand(newMission, toObjective),
    },
    fallback: {
      reason: 'This Codex runtime exposes get_goal/create_goal/update_goal but not replace_goal or resume_goal.',
      commands,
    },
  };
}

function codexNativeGoalRuntimeReplaceAction(newMission, runtimeGoalState = null, commands = {}) {
  const toObjective = codexGoalObjective(newMission);
  const fromObjective = runtimeGoalState?.objective || null;
  const ackNewMission = commands.ack_new_mission || codexGoalAckCommand(newMission, toObjective);
  const completeCurrentGoal = 'update_goal({ status: "complete" })';
  const createNewGoal = `create_goal({ objective: ${JSON.stringify(toObjective)} })`;
  const supersedeApproved = commands.allow_native_goal_supersede === true;
  return {
    runtime: 'codex',
    tool: 'replace_goal',
    available: false,
    blocked_by: 'codex_runtime_missing_replace_goal_tool',
    args: {
      objective: toObjective,
      from_objective: fromObjective,
      to_objective: toObjective,
      from_mission_id: null,
      to_mission_id: newMission.id,
      current_status: runtimeGoalState?.status || null,
    },
    after_success: {
      ack_new_mission: ackNewMission,
    },
    fallback: {
      reason: 'This Codex runtime exposes get_goal/create_goal/update_goal but not replace_goal or resume_goal.',
      automatic: supersedeApproved,
      approved: supersedeApproved,
      executable_now: supersedeApproved,
      blocked_by: supersedeApproved ? null : 'native_goal_cancel_or_supersede_tool_missing',
      safe_when: 'Use only when a mission handoff proves the paused goal is intentionally superseded; update_goal complete otherwise misrepresents abandoned work as finished.',
      sequence_name: 'complete_paused_goal_then_create_new_goal',
      sequence: [
        completeCurrentGoal,
        createNewGoal,
        ackNewMission,
      ],
      commands: {
        ...commands,
        complete_current_goal: completeCurrentGoal,
        create_new_goal: createNewGoal,
        ack_new_mission: ackNewMission,
      },
    },
  };
}

function codexRuntimeGoalNeedsReplace(runtimeGoalState, objective) {
  if (!runtimeGoalState) return false;
  if (!CODEX_NATIVE_GOAL_REPLACE_STATUSES.has(runtimeGoalState.status)) return false;
  if (!runtimeGoalState.objective) return true;
  return runtimeGoalState.objective !== objective;
}

function codexNativeGoalRecovery(mission, runtimeGoalState, root = process.cwd()) {
  const objective = codexGoalObjective(mission);
  if (!codexRuntimeGoalMatchesObjective(runtimeGoalState, objective)) return null;
  const ackCurrentGoal = codexGoalAckCommand(mission, objective);
  const handoffToFreshAgent = `cd ${shellQuote(root)} && atris mission status ${mission.id}`;
  const refreshAfterAck = `atris mission goal --native-goal-status active --native-goal-objective ${shellQuote(objective)} --json`;
  const status = codexRuntimeGoalStatusLabel(runtimeGoalState);
  const nextCommand = `Native Codex goal already matches this mission but is ${status}; do not call create_goal. Run ${ackCurrentGoal}, then retry. If this Codex thread is usage-limited, hand off to a fresh agent with: ${handoffToFreshAgent}`;
  return {
    schema: 'atris.codex_native_goal_recovery.v1',
    status: 'native_goal_recovery_required',
    reason: 'matching_native_goal_not_acknowledged',
    runtime_goal_state: runtimeGoalState,
    mission_id: mission.id,
    objective,
    next_command: nextCommand,
    commands: {
      ack_current_goal: ackCurrentGoal,
      refresh_after_ack: refreshAfterAck,
      handoff_to_fresh_agent: handoffToFreshAgent,
    },
  };
}

function writeDirectRunCodexGoalRequest(mission, root = process.cwd()) {
  if (!isCodexGoalMission(mission)) return null;
  const request = {
    schema: 'atris.codex_goal_direct_run_request.v1',
    source: 'mission_run_objective',
    mission_id: mission.id,
    objective: codexGoalObjective(mission),
    mission_run_preflight: mission.mission_run_preflight || null,
    requested_at: stampIso(),
  };
  const paths = statePaths(root);
  fs.mkdirSync(path.dirname(paths.codexGoalRequestJson), { recursive: true });
  fs.writeFileSync(paths.codexGoalRequestJson, JSON.stringify(request, null, 2) + '\n', 'utf8');
  return request;
}

function readDirectRunCodexGoalRequest(root = process.cwd(), now = new Date()) {
  const file = statePaths(root).codexGoalRequestJson;
  let request = null;
  try {
    request = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  const missionId = String(request?.mission_id || '').trim();
  if (!missionId) return null;
  const mission = resolveMission(missionId, root);
  if (!mission || !isCodexGoalMission(mission)) return null;
  if (!missionSelectableForCodexGoal(mission, now)) return null;
  return { request, mission };
}

function clearDirectRunCodexGoalRequestForMission(missionId, root = process.cwd()) {
  const file = statePaths(root).codexGoalRequestJson;
  let request = null;
  try {
    request = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
  if (String(request?.mission_id || '') !== String(missionId || '')) return false;
  try {
    fs.rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

function activeCodexVisibleGoalOwner(root = process.cwd(), excludeId = '', now = new Date(), runtimeGoalState = null) {
  const excluded = String(excludeId || '');
  const candidates = listMissions(root)
    .filter((mission) => mission.id !== excluded)
    .filter((mission) => isCodexGoalMission(mission))
    .filter((mission) => missionSelectableForCodexGoal(mission, now))
    .filter((mission) => Boolean(codexNativeGoalAck(mission)))
    .filter((mission) => codexRuntimeStateBlocksMissionSlot(runtimeGoalState, mission));
  candidates.sort((a, b) => {
    const aAck = Date.parse(a.native_goal_ack?.acknowledged_at || '') || 0;
    const bAck = Date.parse(b.native_goal_ack?.acknowledged_at || '') || 0;
    if (aAck !== bAck) return bAck - aAck;
    return missionSortTime(b) - missionSortTime(a);
  });
  return candidates[0] || null;
}

function pauseMissionRecord(mission, reason, root = process.cwd()) {
  const next = {
    ...mission,
    status: 'paused',
    paused_at: stampIso(),
    stop_reason: reason,
    next_action: `resume with: atris mission tick ${mission.id}`,
  };
  const { mission: saved } = saveMission(next, root, 'mission_paused', { reason, source: 'goal_slot_handoff' });
  appendMemberLog(saved.owner, 'Mission paused', { mission: saved.objective, reason });
  return saved;
}

function takeCodexGoalSlotForMission(newMission, root = process.cwd(), options = {}) {
  if (!newMission || !isCodexGoalMission(newMission)) return null;
  const runtimeGoalState = codexRuntimeGoalStateFromOptions(options);
  const activeOwner = activeCodexVisibleGoalOwner(root, newMission.id, new Date(), runtimeGoalState);
  if (!activeOwner) return null;
  const reason = `visible goal replaced by ${newMission.id}`;
  const paused = pauseMissionRecord(activeOwner, reason, root);
  return {
    paused_mission_id: paused.id,
    paused_mission: missionStatusView(paused),
    reason,
  };
}

function codexGoalActiveConflictPayload(newMission, activeMission, request = null, heartbeatMode = false, runtimeGoalState = null) {
  const newObjective = codexGoalObjective(newMission);
  const pausedConflict = runtimeGoalState?.status === 'paused';
  const holdOldMission = `atris mission pause ${activeMission.id} --reason ${shellQuote(`visible goal replaced by ${newMission.id}`)} --json`;
  const ackNewMission = codexGoalAckCommand(newMission, newObjective);
  const completeOldMission = `atris mission complete ${activeMission.id} --proof "<proof>" --json`;
  const refreshAfterResume = `atris mission goal --native-goal-status active --native-goal-objective ${shellQuote(codexGoalObjective(activeMission))} --json`;
  const nextCommand = pausedConflict
    ? `Resume the paused Codex goal, then run ${refreshAfterResume}`
    : `${holdOldMission} && ${ackNewMission}`;
  const commands = {
    hold_old_mission: holdOldMission,
    complete_old_mission: completeOldMission,
    refresh_after_resume: refreshAfterResume,
    ack_new_mission: ackNewMission,
  };
  const nativeGoalAction = codexNativeGoalReplaceAction(newMission, activeMission, runtimeGoalState, commands);
  const nativeGoalResolution = {
    action: 'replace_visible_goal',
    automatic_decision: true,
    executable_now: false,
    blocked_by: nativeGoalAction.blocked_by,
    required_tool: nativeGoalAction.tool,
    from_mission_id: activeMission.id,
    to_mission_id: newMission.id,
  };
  const conflict = {
    schema: 'atris.codex_active_goal_conflict.v1',
    message: pausedConflict
      ? `new mission created, but old mission ${activeMission.id} is paused and still occupies the visible slot.`
      : `new mission created, but old mission ${activeMission.id} still owns the visible slot.`,
    source: request?.source || 'mission_run_objective',
    status: pausedConflict ? 'paused_goal_conflict' : 'active_goal_conflict',
    new_mission_id: newMission.id,
    new_objective: newObjective,
    active_mission_id: activeMission.id,
    active_objective: codexGoalObjective(activeMission),
    next_command: nextCommand,
    native_goal_action: nativeGoalAction,
    native_goal_resolution: nativeGoalResolution,
    commands,
    new_mission: missionStatusView(newMission),
    active_mission: missionStatusView(activeMission),
    request,
    runtime_goal_state: runtimeGoalState,
  };
  return {
    ok: true,
    action: pausedConflict ? 'paused_goal_conflict' : 'active_goal_conflict',
    active_goal_conflict: conflict,
    mission: conflict.new_mission,
    conflicting_mission: conflict.active_mission,
    goal: null,
    heartbeat: heartbeatMode ? { heavy_work_performed: false, next_heavy_command: nextCommand } : undefined,
    requires_native_goal_start: true,
    requires_native_goal_replace: true,
    native_goal_action: nativeGoalAction,
    native_goal_resolution: nativeGoalResolution,
    next_command: nextCommand,
  };
}

function codexNativeGoalAction(mission, objective = codexGoalObjective(mission)) {
  return {
    runtime: 'codex',
    tool: 'create_goal',
    args: { objective },
  };
}

function codexNativeGoalStartInstruction(mission, objective = codexGoalObjective(mission)) {
  return `Call native Codex create_goal({ objective: ${JSON.stringify(objective)} }), then run ${codexGoalAckCommand(mission, objective)}`;
}

function codexNativeGoalReplaceInstruction(mission, runtimeGoalState = null, objective = codexGoalObjective(mission), options = {}) {
  const fromObjective = runtimeGoalState?.objective
    ? ` from paused objective ${JSON.stringify(runtimeGoalState.objective)}`
    : '';
  if (options.allowNativeGoalSupersede === true) {
    return `Supersede approved: run update_goal({ status: "complete" }), then create_goal({ objective: ${JSON.stringify(objective)} }), then run ${codexGoalAckCommand(mission, objective)}. Atris records the old paused goal as superseded.`;
  }
  return `Native Codex replace_goal is required${fromObjective} to ${JSON.stringify(objective)}, then run ${codexGoalAckCommand(mission, objective)}; this runtime currently lacks replace_goal. Fallback is update_goal({ status: "complete" }) -> create_goal({ objective: ${JSON.stringify(objective)} }) -> mission goal ack only after handoff proof says the paused goal is intentionally superseded.`;
}

function codexNativeGoalBlockPayload(mission, options = {}) {
  const objective = codexGoalObjective(mission);
  const runtimeGoalState = codexRuntimeGoalStateFromOptions(options);
  const recovery = codexNativeGoalRecovery(mission, runtimeGoalState);
  if (recovery) {
    return {
      ok: false,
      code: 'native_goal_recovery_required',
      mission_id: mission.id,
      objective,
      runtime_goal_state: runtimeGoalState,
      requires_native_goal_start: false,
      requires_native_goal_recovery: true,
      native_goal_action: null,
      native_goal_recovery: recovery,
      native_goal_ack_command: recovery.commands.ack_current_goal,
      next_action: recovery.next_command,
    };
  }
  return {
    ok: false,
    code: 'native_goal_not_started',
    mission_id: mission.id,
    objective,
    requires_native_goal_start: true,
    native_goal_action: codexNativeGoalAction(mission, objective),
    native_goal_ack_command: codexGoalAckCommand(mission, objective),
    next_action: codexNativeGoalStartInstruction(mission, objective),
  };
}

function maybeBlockUntilCodexNativeGoalStarted(mission, asJson, options = {}) {
  if (!isCodexGoalMission(mission) || codexNativeGoalAck(mission)) return;
  if (options.manualAck === false) return;
  const payload = codexNativeGoalBlockPayload(mission, options);
  if (asJson) console.log(JSON.stringify(payload, null, 2));
  else console.error(payload.next_action);
  process.exit(2);
}

function returnIfCodexNativeGoalNotStarted(mission, asJson, options = {}) {
  if (!isCodexGoalMission(mission) || codexNativeGoalAck(mission)) return false;
  if (options.manualAck === false) return false;
  const payload = codexNativeGoalBlockPayload(mission, options);
  if (asJson) console.log(JSON.stringify(payload, null, 2));
  else console.error(payload.next_action);
  process.exitCode = 2;
  return true;
}

function codexGoalNextCommand(mission) {
  if (isCodexGoalMission(mission) && !codexNativeGoalAck(mission)) {
    return codexNativeGoalStartInstruction(mission);
  }
  const taskSpine = missionTaskSpine(mission);
  if (taskSpine && !taskSpine.has_task && taskSpine.ensure_task_command) {
    return taskSpine.ensure_task_command;
  }
  if (missionBudgetContinuationText(mission)) {
    const verifyFlag = effectiveMissionVerifier(mission) ? ' --verify' : '';
    return `atris mission tick ${mission.id}${verifyFlag} --summary "<what changed>"`;
  }
  if (missionChoosesNextMission(mission)) {
    return chooseNextMissionCommand(mission);
  }
  if (mission.status === 'ready' && mission.always_on) {
    return nextCandidateRunCommand(mission);
  }
  if (mission.status === 'ready') {
    const xpAction = missionXpReadyAction(mission, mission.receipt_path);
    if (xpAction) return xpAction.replace(/^queue AgentXP review: /, '');
  }
  const verifier = effectiveMissionVerifier(mission);
  if (verifier && missionDueAt(mission)) {
    const completeFlag = mission.always_on ? '' : ' --complete-on-pass';
    return `atris mission run --due --max-ticks 1${completeFlag}`;
  }
  if (verifier) {
    return `atris mission tick ${mission.id} --verify --summary "<what changed>"`;
  }
  return `atris mission tick ${mission.id} --summary "<what changed>"`;
}

function codexGoalCompletionInstruction(mission) {
  const continuation = missionBudgetContinuationText(mission);
  if (!continuation) return 'update_goal({ status: "complete" })';
  return `${continuation}; do not call update_goal until the full budget is used`;
}

function codexGoalReplaceAfterInstruction(mission) {
  if (missionBudgetContinuationText(mission)) {
    return 'After each proof, run atris mission goal --json again and keep the matching Codex /goal active until the full budget is used.';
  }
  return 'After proof or verifier pass, run atris mission goal --json again and replace the Codex /goal with the returned objective.';
}

function codexVisibleGoalBridge(mission, goalObjective, options = {}) {
  const ack = codexNativeGoalAck(mission, goalObjective);
  const recovery = options.nativeGoalRecovery || null;
  return {
    schema: 'atris.visible_chat_goal_bridge.v1',
    runtime: 'codex',
    source: 'atris_mission',
    mission_id: mission.id,
    desired_objective: goalObjective,
    status: ack ? 'active' : (recovery ? 'needs_ack_recovery' : 'needs_runtime_write'),
    acknowledged_at: ack?.acknowledged_at || null,
    state_file: '.atris/state/codex_goal.json',
    status_file: 'atris/status/codex-goal.md',
    operations: {
      read_current_goal: 'get_goal',
      keep_if_matching: 'if current goal objective equals goal.objective, continue the mission',
      create_when_empty_or_completed: ack || recovery ? null : 'create_goal({ objective: goal.objective })',
      ack_existing_matching_goal: recovery?.commands?.ack_current_goal || null,
      handoff_when_usage_limited: recovery?.commands?.handoff_to_fresh_agent || null,
      ack_after_create: codexGoalAckCommand(mission, goalObjective),
      complete_after_proof: codexGoalCompletionInstruction(mission),
      refresh_on_phase_change: 'atris mission goal --json before continuing changed work',
      refresh_next_candidate: 'atris mission goal --json',
    },
    guardrails: [
      ...(missionBudgetContinuationText(mission)
        ? ['Keep the matching native goal active until the full budget is used, even when an intermediate verifier passes.']
        : []),
      'Do not complete a human-set active goal unless it matches this mission goal or the mission receipt proves handoff.',
      'If create_goal fails because another goal is active, keep this bridge waiting for the visible goal slot.',
      'Do not run mission work for runner=codex_goal until ack_after_create has been recorded.',
      'When the work changes phase or objective, refresh the mission goal before continuing.',
    ],
  };
}

function codexGoalToolContract(mission, nativeGoalRecovery = null) {
  if (nativeGoalRecovery) {
    return {
      current_policy: 'keep one visible Codex /goal active for the selected Atris mission',
      read_current_goal: 'get_goal',
      complete_current_goal: codexGoalCompletionInstruction(mission),
      select_next_goal: 'atris mission goal --json',
      set_next_goal: 'do not call create_goal; the matching native goal already exists',
      visible_goal_bridge: 'goal.visible_goal',
      platform_requirement: 'When Codex reports the same objective with usageLimited or another occupied-slot status, re-ack the existing goal in Atris or hand off to a fresh agent.',
      phase_change_refresh: 'before changed follow-up work, run atris mission goal --json and mirror the returned visible goal',
      runtime_tool_sequence: 'get_goal -> if objective matches, run native_goal_recovery.commands.ack_current_goal -> do work or hand off with native_goal_recovery.commands.handoff_to_fresh_agent',
      blocked_without_platform_goal_write: false,
      mission_id: mission.id,
    };
  }
  return {
    current_policy: 'keep one visible Codex /goal active for the selected Atris mission',
    read_current_goal: 'get_goal',
    complete_current_goal: codexGoalCompletionInstruction(mission),
    select_next_goal: 'atris mission goal --json',
    set_next_goal: 'use goal.visible_goal: create_goal({ objective: goal.objective }) when no active goal blocks the slot',
    visible_goal_bridge: 'goal.visible_goal',
    platform_requirement: 'Codex runtime must expose replace_goal/set_goal, or allow update_goal({ status: "complete" }) followed by create_goal({ objective }).',
    phase_change_refresh: 'before changed follow-up work, run atris mission goal --json and mirror the returned visible goal',
    runtime_tool_sequence: 'get_goal -> create_goal({ objective }) -> atris mission goal ack <mission-id> --runtime codex --status active --objective "<objective>" --json -> do work -> update_goal({ status: "complete" }) after proof or phase change -> atris mission goal --json',
    blocked_without_platform_goal_write: true,
    mission_id: mission.id,
  };
}

function codexGoalHeartbeat(goal, mission, now = new Date()) {
  const secondsUntilDue = secondsUntilMissionDue(mission, now);
  return {
    due: mission ? missionDueAt(mission, now) : false,
    seconds_until_due: secondsUntilDue,
    recommended_sleep_seconds: secondsUntilDue === 0 ? 0 : Math.min(Math.max(secondsUntilDue, 15), 900),
    heavy_work_performed: false,
    next_heavy_command: goal?.next_command || null,
  };
}

function writeCodexGoalState(payload, root = process.cwd()) {
  const paths = statePaths(root);
  const state = {
    schema: 'atris.codex_goal_controller.v1',
    updated_at: stampIso(),
    ...payload,
  };
  fs.mkdirSync(path.dirname(paths.codexGoalJson), { recursive: true });
  fs.writeFileSync(paths.codexGoalJson, JSON.stringify(state, null, 2) + '\n', 'utf8');

  const lines = [
    '# Codex Goal Controller',
    '',
    '<!-- Generated by Atris. Do not hand-edit. -->',
    '',
    `- updated: ${state.updated_at}`,
    `- action: ${state.action}`,
  ];
  if (state.goal) {
    lines.push(`- mission: ${state.goal.mission_id}`);
    lines.push(`- status: ${missionHumanStatusText(state.mission || { status: state.goal.mission_status })}`);
    lines.push(`- reason: ${state.goal.reason}`);
    lines.push(`- objective: ${state.goal.objective}`);
    lines.push(`- next: ${state.goal.next_command}`);
    if (state.goal.visible_goal) {
      lines.push(`- visible goal: ${state.goal.visible_goal.status}`);
      lines.push(`- visible goal desired: ${state.goal.visible_goal.desired_objective}`);
      if (state.goal.visible_goal.operations.create_when_empty_or_completed) {
        lines.push(`- visible goal create: ${state.goal.visible_goal.operations.create_when_empty_or_completed}`);
      }
      if (state.goal.visible_goal.operations.ack_existing_matching_goal) {
        lines.push(`- visible goal ack recovery: ${state.goal.visible_goal.operations.ack_existing_matching_goal}`);
      }
      if (state.goal.visible_goal.operations.handoff_when_usage_limited) {
        lines.push(`- usage-limited handoff: ${state.goal.visible_goal.operations.handoff_when_usage_limited}`);
      }
      const completionLabel = missionBudgetContinuationText(state.mission)
        ? 'visible goal hold'
        : 'visible goal complete';
      lines.push(`- ${completionLabel}: ${state.goal.visible_goal.operations.complete_after_proof}`);
    }
    if (state.goal.native_goal_recovery) {
      lines.push(`- native goal recovery: ${state.goal.native_goal_recovery.next_command}`);
    }
    lines.push(`- platform goal write required: ${state.goal.requires_native_goal_start === true || state.goal.requires_native_goal_replace === true}`);
  } else if (state.active_goal_conflict) {
    lines.push(`- conflict: ${state.active_goal_conflict.message}`);
    lines.push(`- new mission: ${state.active_goal_conflict.new_mission_id}`);
    lines.push(`- active mission: ${state.active_goal_conflict.active_mission_id}`);
    if (state.active_goal_conflict.native_goal_action) {
      lines.push(`- native goal action: ${state.active_goal_conflict.native_goal_action.tool}`);
      lines.push(`- native goal executable now: ${state.active_goal_conflict.native_goal_action.available !== false}`);
    }
    lines.push(`- next: ${state.active_goal_conflict.next_command}`);
  } else {
    lines.push('- mission: none');
  }
  lines.push('');
  fs.mkdirSync(path.dirname(paths.codexGoalStatus), { recursive: true });
  fs.writeFileSync(paths.codexGoalStatus, lines.join('\n'), 'utf8');
  return {
    state_path: paths.codexGoalJson,
    status_path: paths.codexGoalStatus,
    state,
  };
}

function buildCodexGoalPayload(root = process.cwd(), options = {}) {
  const heartbeatMode = options.heartbeat === true;
  const runtimeGoalState = codexRuntimeGoalStateFromOptions(options);
  const directRequest = options.missionId
    ? (() => {
      const mission = resolveMission(options.missionId, root);
      return mission && isCodexGoalMission(mission) && missionSelectableForCodexGoal(mission)
        ? { mission, request: null }
        : null;
    })()
    : readDirectRunCodexGoalRequest(root);
  const activeGoalOwner = directRequest
    ? activeCodexVisibleGoalOwner(root, directRequest.mission.id, new Date(), runtimeGoalState)
    : null;
  if (directRequest && activeGoalOwner) {
    return codexGoalActiveConflictPayload(directRequest.mission, activeGoalOwner, directRequest.request, heartbeatMode, runtimeGoalState);
  }
  let selected = directRequest
    ? { mission: directRequest.mission, reason: 'direct_run', direct_goal_request: directRequest.request }
    : selectCodexGoalMission(root, options);
  if (!selected && !directRequest) {
    const continuation = seedNextMoveContinuationGoal(root);
    if (continuation?.mission) {
      selected = {
        mission: continuation.mission,
        reason: continuation.inserted ? 'next_move_continuation_seeded' : 'next_move_continuation_active',
        seeded_continuation_goal: continuation,
      };
    }
  }
  if (!selected) {
    const heartbeat = heartbeatMode ? codexGoalHeartbeat(null, null) : undefined;
    return {
      ok: true,
      action: heartbeatMode ? 'codex_goal_heartbeat' : 'no_goal_candidate',
      mission: null,
      heartbeat,
    };
  }

  let { mission } = selected;
  const { reason, direct_goal_request: directGoalRequest, seeded_continuation_goal: seededContinuationGoal } = selected;
  const autoNativeGoalAck = maybeAutoAckCodexNativeGoal(mission, root, options);
  if (autoNativeGoalAck) mission = autoNativeGoalAck.saved;
  const taskSpine = missionTaskSpine(mission);
  const missionView = missionStatusView(mission);
  const objective = codexGoalObjective(mission);
  const ack = codexNativeGoalAck(mission);
  const nativeGoalRecovery = !ack ? codexNativeGoalRecovery(mission, runtimeGoalState, root) : null;
  const runtimeNeedsReplace = !ack && !nativeGoalRecovery && codexRuntimeGoalNeedsReplace(runtimeGoalState, objective);
  const nativeGoalAction = ack
    ? null
    : nativeGoalRecovery
      ? null
      : runtimeNeedsReplace
      ? codexNativeGoalRuntimeReplaceAction(mission, runtimeGoalState, {
        ack_new_mission: codexGoalAckCommand(mission, objective),
        allow_native_goal_supersede: options.allowNativeGoalSupersede === true,
      })
      : codexNativeGoalAction(mission, objective);
  const goal = {
    objective,
    mission_id: mission.id,
    mission_objective: mission.objective,
    mission_status: mission.status,
    owner: taskSpine?.owner || mission.owner,
    executed_by: taskSpine?.executed_by || mission.executed_by || null,
    task_spine: taskSpine,
    reason,
    next_command: nativeGoalRecovery
      ? nativeGoalRecovery.next_command
      : runtimeNeedsReplace
      ? codexNativeGoalReplaceInstruction(mission, runtimeGoalState, objective, {
        allowNativeGoalSupersede: options.allowNativeGoalSupersede === true,
      })
      : codexGoalNextCommand(mission),
    replace_after: codexGoalReplaceAfterInstruction(mission),
    visible_goal: codexVisibleGoalBridge(mission, objective, { nativeGoalRecovery }),
    codex_tool_contract: codexGoalToolContract(mission, nativeGoalRecovery),
    requires_native_goal_start: !ack && !nativeGoalRecovery,
    requires_native_goal_recovery: Boolean(nativeGoalRecovery),
    requires_native_goal_replace: runtimeNeedsReplace,
    native_goal_action: nativeGoalAction,
    native_goal_recovery: nativeGoalRecovery,
    native_goal_ack_command: codexGoalAckCommand(mission, objective),
    native_goal_ack: ack,
    auto_native_goal_ack: autoNativeGoalAck ? {
      native_goal_ack: autoNativeGoalAck.ack,
      superseded_native_goal_acks: autoNativeGoalAck.supersededNativeGoalAcks,
    } : null,
    direct_goal_request: directGoalRequest || null,
    seeded_continuation_goal: seededContinuationGoal || null,
    next_action_preview: missionChoosesNextMission(mission) ? chooseNextMissionPreview(mission, root) : (mission.next_action_preview || null),
    runtime_goal_state: runtimeGoalState,
  };
  const heartbeat = heartbeatMode ? codexGoalHeartbeat(goal, mission) : undefined;
  return {
    ok: true,
    action: heartbeatMode ? 'codex_goal_heartbeat' : 'codex_goal_candidate',
    goal,
    mission: missionView,
    heartbeat,
    requires_native_goal_start: goal.requires_native_goal_start,
    requires_native_goal_recovery: goal.requires_native_goal_recovery,
    requires_native_goal_replace: goal.requires_native_goal_replace,
    native_goal_action: goal.native_goal_action,
    native_goal_recovery: goal.native_goal_recovery,
    auto_native_goal_ack: goal.auto_native_goal_ack,
    runtime_goal_state: runtimeGoalState,
  };
}

function refreshCodexGoalController(root = process.cwd(), options = {}) {
  const payload = buildCodexGoalPayload(root, options);
  const rendered = writeCodexGoalState(payload, root);
  return {
    ...payload,
    state_path: rendered.state_path,
    status_path: rendered.status_path,
  };
}

function atrisVisibleGoalBridge(mission, goalObjective) {
  return {
    schema: 'atris.visible_goal_bridge.v1',
    runtime: String(mission.runner || 'manual'),
    source: 'atris_mission',
    mission_id: mission.id,
    desired_objective: goalObjective,
    status: 'active',
    state_file: '.atris/state/atris_goal.json',
    status_file: 'atris/status/atris-goal.md',
    operations: {
      read_current_goal: 'atris mission goal --runtime atris --json',
      update_from_mission: 'atris mission tick <mission-id> --summary "<what changed>" --json',
      refresh_on_phase_change: 'atris mission goal --runtime atris --json before continuing changed work',
      complete_after_proof: 'atris mission complete <mission-id> --proof "<receipt_path>" --json',
    },
    guardrails: [
      'Atris owns this goal state; no external native-goal tool ack is required.',
      'Do not claim completion until the mission has proof or a recorded blocked human ask.',
      'Use the mission task spine when task_spine.current_step_command is present.',
    ],
  };
}

function atrisGoalToolContract(mission) {
  return {
    current_policy: 'keep one Atris-owned visible goal active for mission/chat/fast runtimes',
    read_current_goal: 'atris mission goal --runtime atris --json',
    set_next_goal: 'atris mission run "<objective>" --runner atris2|manual|claude',
    complete_current_goal: 'atris mission complete <mission-id> --proof "<receipt_path>" --json',
    visible_goal_bridge: 'goal.visible_goal',
    platform_requirement: 'No native platform goal tool is required; Atris mission/task state is the source of truth.',
    runtime_tool_sequence: 'atris mission run -> atris_goal_state active -> ax fast / atris chat shows goal -> mission tick/task proof -> mission complete',
    blocked_without_platform_goal_write: false,
    mission_id: mission.id,
  };
}

function buildAtrisGoalPayload(root = process.cwd(), options = {}) {
  const heartbeatMode = options.heartbeat === true;
  const selected = selectAtrisGoalMission(root, options);
  if (!selected) {
    return {
      ok: true,
      action: heartbeatMode ? 'atris_goal_heartbeat' : 'no_goal_candidate',
      mission: null,
      heartbeat: heartbeatMode ? { heavy_work_performed: false, next_heavy_command: null } : undefined,
    };
  }

  const { mission, reason } = selected;
  const taskSpine = missionTaskSpine(mission);
  const missionView = missionStatusView(mission);
  const objective = mission.objective;
  const goal = {
    objective,
    mission_id: mission.id,
    mission_objective: mission.objective,
    mission_status: mission.status,
    owner: taskSpine?.owner || mission.owner,
    executed_by: taskSpine?.executed_by || mission.executed_by || null,
    runner: mission.runner || 'manual',
    model: mission.model || null,
    task_spine: taskSpine,
    reason,
    next_command: codexGoalNextCommand(mission),
    replace_after: 'After proof or phase change, run atris mission goal --runtime atris --json and continue from the returned next_command.',
    visible_goal: atrisVisibleGoalBridge(mission, objective),
    atris_tool_contract: atrisGoalToolContract(mission),
    requires_native_goal_start: false,
    native_goal_action: null,
  };
  return {
    ok: true,
    action: heartbeatMode ? 'atris_goal_heartbeat' : 'atris_goal_candidate',
    goal,
    mission: missionView,
    heartbeat: heartbeatMode ? codexGoalHeartbeat(goal, mission) : undefined,
    requires_native_goal_start: false,
    native_goal_action: null,
  };
}

function writeAtrisGoalState(payload, root = process.cwd()) {
  const paths = statePaths(root);
  const state = {
    schema: 'atris.goal_controller.v1',
    updated_at: stampIso(),
    ...payload,
  };
  fs.mkdirSync(path.dirname(paths.atrisGoalJson), { recursive: true });
  fs.writeFileSync(paths.atrisGoalJson, JSON.stringify(state, null, 2) + '\n', 'utf8');

  const lines = [
    '# Atris Goal Controller',
    '',
    '<!-- Generated by Atris. Do not hand-edit. -->',
    '',
    `- updated: ${state.updated_at}`,
    `- action: ${state.action}`,
  ];
  if (state.goal) {
    lines.push(`- mission: ${state.goal.mission_id}`);
    lines.push(`- runner: ${state.goal.runner}`);
    lines.push(`- status: ${state.goal.mission_status}`);
    lines.push(`- reason: ${state.goal.reason}`);
    lines.push(`- objective: ${state.goal.objective}`);
    lines.push(`- next: ${state.goal.next_command}`);
    lines.push(`- visible goal: ${state.goal.visible_goal.status}`);
  } else {
    lines.push('- mission: none');
  }
  lines.push('');
  fs.mkdirSync(path.dirname(paths.atrisGoalStatus), { recursive: true });
  fs.writeFileSync(paths.atrisGoalStatus, lines.join('\n'), 'utf8');
  return {
    state_path: paths.atrisGoalJson,
    status_path: paths.atrisGoalStatus,
    state,
  };
}

function refreshAtrisGoalController(root = process.cwd(), options = {}) {
  const payload = buildAtrisGoalPayload(root, options);
  const rendered = writeAtrisGoalState(payload, root);
  return {
    ...payload,
    state_path: rendered.state_path,
    status_path: rendered.status_path,
  };
}

function runAtrisMissionJsonCommand(root, args, options = {}) {
  const cliPath = path.join(__dirname, '..', 'bin', 'atris.js');
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' },
  });
  let payload = null;
  try {
    payload = JSON.parse(result.stdout || '{}');
  } catch {}
  return {
    action: options.action || null,
    command: `atris ${args.join(' ')}`,
    status: result.status,
    ok: result.status === 0,
    heavy_work: options.heavyWork === true,
    setup_work: options.setupWork === true,
    stdout: String(result.stdout || '').slice(-4000),
    stderr: String(result.stderr || '').slice(-4000),
    payload,
  };
}

function runMissionRunDueOnce(root = process.cwd(), options = {}) {
  const args = ['mission', 'run', '--due', '--max-ticks', '1', '--complete-on-pass', '--json'];
  if (options.noClaude) args.push('--no-claude');
  return runAtrisMissionJsonCommand(root, args, {
    action: 'mission_run_due',
    heavyWork: true,
  });
}

function goalLoopNextCommandPlan(goal) {
  const command = String(goal?.next_command || '').trim();
  const attach = command.match(/^atris\s+mission\s+(attach-task|ensure-task|task-spine)\s+([A-Za-z0-9_.:-]+)\s+--json$/);
  if (attach) {
    return {
      action: 'mission_attach_task',
      command,
      args: ['mission', 'attach-task', attach[2], '--json'],
      heavy_work: false,
      setup_work: true,
      run_when_due_only: false,
    };
  }

  const dueRun = command.match(/^atris\s+mission\s+run\s+--due\s+--max-ticks\s+([0-9]+)(\s+--complete-on-pass)?(?:\s+--json)?$/);
  if (dueRun) {
    const args = ['mission', 'run', '--due', '--max-ticks', dueRun[1]];
    if (dueRun[2]) args.push('--complete-on-pass');
    args.push('--json');
    return {
      action: 'mission_run_due',
      command: `atris ${args.join(' ')}`,
      args,
      heavy_work: true,
      setup_work: false,
      run_when_due_only: true,
    };
  }

  return null;
}

function shouldRunGoalLoopCommand(heartbeat, plan) {
  if (!heartbeat?.goal) return false;
  if (heartbeat.goal.requires_native_goal_start === true) return false;
  if (plan && plan.run_when_due_only === false) return true;
  return heartbeat.heartbeat?.due === true;
}

function runMissionGoalNextCommand(root = process.cwd(), heartbeat, options = {}) {
  const plan = goalLoopNextCommandPlan(heartbeat?.goal);
  if (plan) {
    const args = [...plan.args];
    if (options.noClaude && plan.action === 'mission_run_due') args.push('--no-claude');
    return runAtrisMissionJsonCommand(root, args, {
      action: plan.action,
      heavyWork: plan.heavy_work,
      setupWork: plan.setup_work,
    });
  }
  return runMissionRunDueOnce(root, options);
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (ms <= 0) return resolve();
    const onAbort = () => { clearTimeout(timer); reject(Object.assign(new Error('aborted'), { code: 'ABORTED' })); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function parseCadenceSeconds(cadence) {
  const text = String(cadence || '').trim().toLowerCase();
  if (!text || text === 'manual' || text === 'once') return 0;
  const m = text.match(/^(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hour|hours|d|day|days)$/);
  if (!m) return 0;
  const n = Number(m[1]);
  const unit = m[2];
  if (/^d/.test(unit)) return n * 86400;
  if (/^h/.test(unit)) return n * 3600;
  if (/^m(?!s)/.test(unit)) return n * 60;
  return n; // seconds
}

function computeBackoff(policy, attempt) {
  const base = policy.initialMs * Math.pow(policy.factor, Math.max(attempt - 1, 0));
  const jitter = base * policy.jitter * Math.random();
  return Math.min(policy.maxMs, Math.round(base + jitter));
}

function missionBudgetPromptLines(mission) {
  const contract = mission?.budget_contract;
  if (!contract) return [];
  return [
    ``,
    `## Budget`,
    `Plain rule: ${contract.plain_language}`,
    `Limit: ${contract.budget_label}`,
    `Stop rule: ${contract.stop_rule}`,
    `Before acting, state the current bottleneck, the next useful move, and what proof or stop reason will make the tick honest.`,
  ];
}

function consecutiveVerifierFails(ticks) {
  let n = 0;
  for (let i = ticks.length - 1; i >= 0; i--) {
    const t = ticks[i];
    if (t.status !== 'ran') break;
    if (t.verifier_passed === false) n++;
    else break;
  }
  return n;
}

// BCK-1324: a "holding tick" is a tick that reports status=ran/reason=tick-ok
// (so it never trips the error-streak breakers) but left no structural trace —
// no new or cleared dirty files beyond whatever was already dirty at tick
// start, and no fresh verifier pass. Claude's own summary text ("holding
// tick, no drift") is not the signal: agents self-label busywork as progress
// constantly. The worktree diff and verifier result are ground truth.
function tickMadeProgress(tick) {
  if (!tick || tick.status !== 'ran') return true; // errors/skips aren't "idle" — other breakers own those
  const wt = tick.worktree;
  if (wt && wt.available) {
    if ((wt.new_dirty_count || 0) > 0) return true;
    if ((wt.cleared_dirty_count || 0) > 0) return true;
  } else if (!wt) {
    // No worktree signal available (e.g. git unavailable) — don't punish a
    // tick we have no evidence against.
    return true;
  }
  if (tick.verifier_passed === true) return true;
  return false;
}

// Count the trailing run of ticks (most recent first) that made no progress
// per tickMadeProgress. A single progressing tick anywhere in the run resets
// this to 0 — only the tail streak matters.
function consecutiveNoProgressTicks(ticks) {
  let n = 0;
  for (let i = ticks.length - 1; i >= 0; i--) {
    if (tickMadeProgress(ticks[i])) break;
    n++;
  }
  return n;
}

// Count the trailing run of errored ticks that all share the most-recent error's
// reason. Backoff caps at 10min, so an error that recurs identically (claude-timeout,
// atris2-error, a dead model) otherwise retries forever until max-ticks/max-wall.
// Two identical failures in a row is the MEMBER.md "same approach failed twice" signal.
function consecutiveSameReasonErrors(ticks) {
  const last = ticks[ticks.length - 1];
  if (!last || last.status !== 'errored' || !last.reason) return { reason: null, count: 0 };
  let count = 0;
  for (let i = ticks.length - 1; i >= 0; i--) {
    const t = ticks[i];
    if (t.status === 'errored' && t.reason === last.reason) count++;
    else break;
  }
  return { reason: last.reason, count };
}

function isTransientAtris2BackendError(error) {
  const text = String(error || '');
  if (!text) return false;
  return /\b(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE)\b/i.test(text)
    || /\b(?:socket hang up|request timeout|no response headers|stream stalled)\b/i.test(text)
    || /\bHTTP\s+(?:502|503|504|522|523|524)\b/i.test(text)
    // A stopped AtrisOS computer answers 409 "Computer must be running": the
    // backend will come back, so the mission keeps waiting instead of pausing.
    || (/\bHTTP\s+409\b/i.test(text) && /computer must be running/i.test(text));
}

function atris2TurnErrorReason(error) {
  return isTransientAtris2BackendError(error) ? 'atris2-backend-unavailable' : 'atris2-error';
}

function missionRunKeepsRetryingError(reason) {
  return reason === 'atris2-backend-unavailable';
}

function isWithinActiveHours(activeHours, now = new Date()) {
  if (!activeHours || !activeHours.start || !activeHours.end) return true;
  const tz = activeHours.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const map = Object.fromEntries(parts.filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
  const cur = Number(map.hour) * 60 + Number(map.minute);
  const [sh, sm] = String(activeHours.start).split(':').map(Number);
  const [eh, em] = String(activeHours.end).split(':').map(Number);
  const start = sh * 60 + (sm || 0);
  const end = (eh === 24 ? 24 * 60 : eh * 60 + (em || 0));
  if (start === end) return false;
  if (end > start) return cur >= start && cur < end;
  return cur >= start || cur < end;
}

function sleepSync(ms) {
  const waitMs = Math.max(0, Number(ms) || 0);
  if (!waitMs) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
}

function missionLockOwnerIsAlive(pid) {
  const ownerPid = Number(pid);
  if (!Number.isInteger(ownerPid) || ownerPid <= 0) return false;
  try {
    process.kill(ownerPid, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

function acquireMissionLock(missionId, root = process.cwd(), options = {}) {
  const dir = path.join(root, '.atris', 'state');
  fs.mkdirSync(dir, { recursive: true });
  const lockFile = path.join(dir, `mission-${missionId}.lock`);
  const waitMs = Math.max(0, Number(options.waitMs) || 0);
  const deadline = waitMs ? Date.now() + waitMs : 0;
  let fd;
  while (true) {
    try {
      fd = fs.openSync(lockFile, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, started_at: stampIso(), mission_id: missionId }));
      return { ok: true, lockFile, fd };
    } catch (e) {
      if (e.code === 'EEXIST') {
        let info = {};
        try { info = JSON.parse(fs.readFileSync(lockFile, 'utf8') || '{}'); } catch {}
        if (!missionLockOwnerIsAlive(info.pid)) {
          try {
            fs.unlinkSync(lockFile);
            continue;
          } catch {}
        }
        if (deadline && Date.now() < deadline) {
          sleepSync(Math.min(25, deadline - Date.now()));
          continue;
        }
        return { ok: false, lockFile, busy: true, holder: info };
      }
      return { ok: false, lockFile, error: e.message };
    }
  }
}

function releaseMissionLock(lock) {
  if (!lock || !lock.ok) return;
  try { if (lock.fd != null) fs.closeSync(lock.fd); } catch {}
  try { fs.unlinkSync(lock.lockFile); } catch {}
}

function probeClaudeBinary() {
  const runnerBin = resolveClaudeRunnerBin();
  if (resolveClaudeRunnerCommandTemplate()) {
    const probe = spawnSync('sh', ['-c', `command -v ${shellQuote(runnerBin)}`], { encoding: 'utf8', timeout: 8000 });
    if (probe.status !== 0) return { ok: false, error: `${runnerBin} CLI not found` };
    return { ok: true };
  }
  const help = spawnSync(runnerBin, ['--help'], { encoding: 'utf8', timeout: 8000 });
  if (help.status !== 0) return { ok: false, error: `${runnerBin} --help failed` };
  const text = String(help.stdout || '');
  const required = ['--output-format', '--permission-mode', '--resume', '--session-id', '--include-partial-messages'];
  const missing = required.filter((flag) => !text.includes(flag));
  if (missing.length) return { ok: false, error: `claude binary missing flags: ${missing.join(', ')}` };
  return { ok: true };
}

// Pull unread operator pings off the mission and mark them consumed, so the
// next tick's prompt carries them exactly once. Pings are how a human talks to
// an always-on member mid-run: atris member ping <name> "<msg>".
function consumeMissionPings(mission, cwd) {
  const pending = (Array.isArray(mission.pings) ? mission.pings : []).filter((p) => p && !p.consumed_at);
  if (!pending.length) return { mission, pings: [] };
  const consumedAt = stampIso();
  const pings = (mission.pings || []).map((p) => (p && !p.consumed_at ? { ...p, consumed_at: consumedAt } : p));
  const saved = saveMission({ ...mission, pings }, cwd, 'mission_pings_consumed', { count: pending.length }).mission;
  return { mission: saved, pings: pending };
}

function buildTickPrompt(mission, tickIndex, maxTicks, frozen, pings = []) {
  const pingLines = pings.length
    ? [
      ``,
      `## Operator pings (read these first)`,
      `Your operator sent ${pings.length === 1 ? 'a message' : 'messages'} mid-run. Treat them as fresh direction for this tick (they do not change the frozen verifier or lane):`,
      ...pings.map((p) => `- [${p.at}] ${p.from || 'operator'}: ${p.text}`),
    ]
    : [];
  const lines = [
    `# Mission Tick ${tickIndex}/${maxTicks}`,
    ...pingLines,
    ``,
    `**Objective:** ${mission.objective}`,
    `**Owner:** ${mission.owner}`,
    `**Lane:** ${frozen.lane}`,
    `**Cadence:** ${mission.cadence}`,
    `**Stop condition:** ${mission.stop_condition || 'human marks complete'}`,
    `**Verifier (frozen):** ${frozen.verifier || '(none — receipt only)'}`,
    `**Last status:** ${mission.status}`,
    `**Last tick:** ${mission.last_tick_at || 'never'}`,
    ...missionBudgetPromptLines(mission),
    ``,
    `## Your task`,
    `Do ONE increment of work toward the stop condition. ONE. No more.`,
    `- You are the member "${mission.owner}". Read atris/team/${mission.owner}/MEMBER.md (and SOUL.md if present) before acting — work in that identity, inside its scope and stop rules. After your work, append what you did and what you learned to atris/team/${mission.owner}/logs/<today's date>.md.`,
    `- FIRST: inspect current mission/task state before acting. Read the relevant files, run \`atris mission status ${mission.id}\`, \`git status\`, or \`atris task list\` as needed so you know what's already done.`,
    `- Pick the smallest concrete action that moves the mission forward.`,
    `- Before acting, state your single next move in one sentence.`,
    `- Edit / run / research as needed for the lane.`,
    `- The tick is not done until the verify step passes. If a frozen verifier exists, the harness runs it. If no frozen verifier exists, finish by actually running the surface you changed on this computer and paste the real command output into your receipt.`,
    `- After that one verify step, STOP. Never start a second slice in one tick.`,
    `- Write the tick summary in operator language: what changed and what it buys or costs in plain words, with no flags, task ids, or code identifiers.`,
    `- If you can't make progress this tick, say why explicitly. Don't fake it.`,
    ``,
    `## Constraints`,
    `- Lane = ${frozen.lane}: stay inside that lane.`,
    `- Do NOT modify mission.verifier, mission.lane, or any tool policy.`,
    `- Do NOT start new missions, modify other missions, or expand scope.`,
    `- Do NOT run destructive commands without strong evidence they're correct.`,
    ``,
    `When done, output a short receipt. The summary's first line must name what changed and how it was verified. Then include: (1) the exact files edited / commands run / artifacts produced — name them, (1b) one verify command a reviewer can rerun to check the work, (2) the metric of progress, (3) what the next tick should pick up. End the receipt with one line naming the layer this tick touched: \`layer: identity|beliefs|capabilities|behaviors|environment\` (final line — the harness parses it).`,
  ];
  if (mission.task_ids?.length) {
    lines.push('', `## Task ids`, mission.task_ids.map((t) => `- ${t}`).join('\n'));
  }
  if (mission.human_asks?.length) {
    lines.push('', `## Human asks (don't act on these — surface them)`, mission.human_asks.map((t) => `- ${t}`).join('\n'));
  }
  return lines.join('\n');
}

// resolveClaudeRunnerModel / resolveClaudeRunnerBin + the runner-resolution rationale now live in
// lib/runner-command.js so missions, autopilot, and run share one resolver
// (imported at the top, re-exported below for test/mission-model-resolution.test.js).

// The claude CLI prints "...issue with the selected model (<id>). It may not exist
// or you may not have access to it." when a model id is retired or inaccessible.
// Detect it so the tick reason becomes the actionable 'model-unavailable' (+the id)
// instead of a generic 'claude-error' that buries the root cause.
function detectUnavailableModel(text) {
  const s = String(text || '');
  const m = s.match(/issue with the selected model \(([^)]+)\)/i);
  if (m) return m[1].trim();
  if (/selected model/i.test(s) && /may not (?:exist|have access)/i.test(s)) return 'unknown';
  return null;
}

// Human-facing guidance written to a paused mission's next_action. Most pauses just
// need a resume; a model-unavailable pause is a config error a bare resume won't fix,
// so name the dead id and the two knobs that change it.
function missionPauseNextAction(pauseReason, missionId, deadModel = null, lastErrorReason = null) {
  if (pauseReason === 'model-unavailable' && deadModel) {
    return `model "${deadModel}" is unavailable — set a live model (mission.model, ATRIS_RUNNER_MODEL, or legacy ATRIS_CLAUDE_MODEL), then: atris mission run ${missionId}`;
  }
  if (typeof pauseReason === 'string' && pauseReason.startsWith('repeated-error:')) {
    const reason = pauseReason.slice('repeated-error:'.length);
    return `tick kept failing with "${reason}" — inspect the last receipt, fix the cause, then: atris mission run ${missionId}`;
  }
  // Single-tick cron runs pause via max-ticks-reached on the very first errored tick.
  // A bare "resume" there just re-errors; point the operator at the cause instead.
  if (pauseReason === 'max-ticks-reached' && lastErrorReason) {
    return `hit the tick budget while erroring ("${lastErrorReason}") — inspect the last receipt before resuming: atris mission run ${missionId}`;
  }
  return `resume with: atris mission run ${missionId}`;
}

function humanBlockingPauseReason(value) {
  const reason = String(value || '').trim();
  return HUMAN_BLOCKING_PAUSE_REASONS.has(reason) ? reason : null;
}

function missionPauseResumeCommand(missionId) {
  return `atris mission run ${missionId}`;
}

function humanBlockingPauseCause(reason, { deadModel = null } = {}) {
  if (reason === 'auth-required') {
    return 'the runner needs the operator to log in before it can continue';
  }
  if (reason === 'model-unavailable') {
    return deadModel
      ? `the configured model "${deadModel}" is unavailable or inaccessible`
      : 'the configured model is unavailable or inaccessible';
  }
  if (reason === 'rate-limit-exceeded-wall') {
    return 'the rate-limit reset is beyond this run window';
  }
  return 'the pause needs operator action before the mission can continue';
}

function composeHumanBlockingPauseMessage(mission, pauseReason, options = {}) {
  const command = missionPauseResumeCommand(mission.id);
  return [
    `Mission ${mission.id} paused: ${pauseReason}`,
    `Cause: ${humanBlockingPauseCause(pauseReason, options)}.`,
    `Resume: ${command}`,
  ].join('\n');
}

function missionPauseEscalationAlreadyRecorded(mission, pauseReason, pausedAt) {
  const marker = mission && mission.human_blocking_pause_escalation;
  return Boolean(marker && marker.reason === pauseReason && marker.paused_at === pausedAt);
}

function escalateHumanBlockingPause(mission, root = process.cwd(), options = {}) {
  const pauseReason = humanBlockingPauseReason(options.pauseReason || mission?.stop_reason);
  if (!mission || !pauseReason) {
    return { mission, escalated: false, skipped: 'not-human-blocking' };
  }
  const pausedAt = options.pausedAt || mission.paused_at || stampIso();
  if (missionPauseEscalationAlreadyRecorded(mission, pauseReason, pausedAt)) {
    return { mission, escalated: false, skipped: 'already-escalated' };
  }
  const policy = options.policy || autolandLib.readPolicy(root) || {};
  const message = composeHumanBlockingPauseMessage(mission, pauseReason, options);
  const command = missionPauseResumeCommand(mission.id);
  const marker = {
    reason: pauseReason,
    paused_at: pausedAt,
    escalated_at: options.now || stampIso(),
    resume_command: command,
    cause: humanBlockingPauseCause(pauseReason, options),
    message,
  };
  let eventType = 'mission_pause_escalated';
  let eventPayload = { reason: pauseReason, resume_command: command };
  if (policy.imessage_to) {
    const sendImessage = options.sendImessage || autolandLib.sendImessage;
    const sent = sendImessage(root, policy.imessage_to, message);
    marker.channel = 'imessage';
    marker.imessage_to = policy.imessage_to;
    marker.sent = Boolean(sent && sent.ok);
    if (!marker.sent) marker.error = String((sent && sent.output) || 'send failed').slice(0, 200);
    eventPayload = {
      ...eventPayload,
      channel: 'imessage',
      imessage_to: policy.imessage_to,
      sent: marker.sent,
      ...(marker.error ? { error: marker.error } : {}),
    };
  } else {
    const warning = `WARN mission ${mission.id} paused for ${pauseReason}: ${marker.cause}. Resume: ${command}`;
    marker.channel = 'mission-log';
    marker.warning = warning;
    eventType = 'mission_pause_escalation_warn';
    eventPayload = { ...eventPayload, channel: 'mission-log', warning };
  }
  const nextMission = { ...mission, paused_at: pausedAt, human_blocking_pause_escalation: marker };
  try {
    appendEvent(eventType, nextMission, eventPayload, root);
  } catch {}
  if (!policy.imessage_to) {
    try {
      appendMemberLog(nextMission.owner, 'Mission pause needs operator', { warning: marker.warning }, root);
    } catch {}
  }
  return {
    mission: nextMission,
    escalated: true,
    channel: marker.channel,
    sent: Boolean(marker.sent),
    warning: marker.warning || null,
    message,
    reason: pauseReason,
  };
}

function writeRunnerPromptFile(cwd, missionId, prompt) {
  const dir = path.join(cwd, '.atris', 'state', 'runner-prompts');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${missionId || 'mission'}-${Date.now()}-${crypto.randomUUID()}.md`);
  fs.writeFileSync(file, prompt, 'utf8');
  return file;
}

function spawnGenericRunnerTick(mission, opts) {
  const { sessionId, cwd, signal, timeoutMs, prompt, model } = opts;
  return new Promise((resolve) => {
    let promptFile = null;
    let cmd = '';
    let briefId = null;
    try {
      promptFile = writeRunnerPromptFile(cwd, mission.id, prompt);
      cmd = buildRunnerCommand({ promptFile, model });
      const engine = canonicalEngineName(mission.runner);
      if (engine) {
        const record = appendBriefRecord(cwd, {
          author: mission.owner || 'mission',
          engine,
          task_id: mission.task_id || mission.task_ref || '',
          mission_id: mission.id,
          prompt_text: prompt,
          context: {
            worktree: cwd,
            base_ref: worktreeBaseRef(cwd, ''),
          },
        });
        briefId = record.brief_id;
      }
    } catch (e) {
      resolve({ ok: false, error: e.message, sessionIds: [], aborted: false, timedOut: false, authExpired: false, brief_id: briefId });
      return;
    }

    const startedAt = Date.now();
    const proc = spawn('sh', ['-lc', cmd], { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;

    const cleanupPrompt = () => {
      try { if (promptFile) fs.unlinkSync(promptFile); } catch {}
    };
    const kill = () => {
      const killGroup = (sig) => {
        try { process.kill(-proc.pid, sig); } catch { try { proc.kill(sig); } catch {} }
      };
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), 3000).unref();
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    const onAbort = () => { aborted = true; kill(); };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    proc.on('close', (code) => {
      clearTimeout(timer);
      cleanupPrompt();
      if (signal) signal.removeEventListener?.('abort', onAbort);
      const finalText = String(stdout || '').trim();
      const errStr = String(stderr || '').slice(-2000);
      const ok = code === 0 && !timedOut && !aborted;
      const authExpired = /not authenticated|please log in|login required|auth(?:entication)? expired/i.test(errStr);
      resolve({
        ok,
        brief_id: briefId,
        timedOut,
        aborted,
        authExpired,
        exitCode: code,
        sessionIds: sessionId ? [sessionId] : [],
        result: finalText,
        summary: usefulClaudeReceiptSummary(finalText || errStr, ok ? 'no-text' : 'error'),
        receipt_text: cappedClaudeReceiptText(finalText || errStr),
        duration_total_ms: Date.now() - startedAt,
        num_turns: null,
        stop_reason: null,
        stderr: errStr,
        parse_errors: 0,
      });
    });

    proc.on('error', (e) => {
      clearTimeout(timer);
      cleanupPrompt();
      if (signal) signal.removeEventListener?.('abort', onAbort);
      resolve({ ok: false, error: e.message, sessionIds: [], aborted, timedOut, authExpired: false, brief_id: briefId });
    });
  });
}

function stampMissionRunnerBrief(root, briefId, result, verifierResult) {
  if (!briefId) return;
  let outcome = 'fail';
  if (result.status === 'ran' && verifierResult?.passed) outcome = 'pass';
  else if (result.status === 'ran') outcome = 'partial';
  const verifier = verifierResult ? (verifierResult.passed ? 'verifier passed' : 'verifier failed') : 'no verifier result';
  try {
    stampBriefOutcome(root, briefId, {
      result: outcome,
      note: `mission tick ${result.tick_index || ''} ${result.reason || result.status || 'ran'}; ${verifier}`.replace(/\s+/g, ' ').trim(),
    });
  } catch {}
}

function runDrillRunnerTick(cwd, mission, tickIdx) {
  const startedAt = Date.now();
  const relPath = path.join('.atris', 'state', 'drill-runner-touch.txt');
  const file = path.join(cwd, relPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    `mission=${mission.id}`,
    `tick=${tickIdx}`,
    `at=${stampIso()}`,
    '',
  ].join('\n'), 'utf8');
  const receiptText = `drill runner touched ${relPath}\nlayer: capabilities`;
  return {
    ok: true,
    touched: relPath,
    summary: `drill runner touched ${relPath}`,
    receipt_text: receiptText,
    duration_total_ms: Date.now() - startedAt,
  };
}

function spawnClaudeTick(mission, opts) {
  if (resolveClaudeRunnerCommandTemplate()) return spawnGenericRunnerTick(mission, opts);
  const { sessionMode, sessionId, cwd, signal, timeoutMs, prompt, model } = opts;
  return new Promise((resolve) => {
    const args = [
      '-p', prompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'bypassPermissions',
      '--include-partial-messages',
    ];
    if (model) args.push('--model', model);
    if (sessionMode === 'set') args.push('--session-id', sessionId);
    else if (sessionMode === 'resume') args.push('--resume', sessionId);

    const startedAt = Date.now();
    // detached: the runner spawns its own children; killing only the direct
    // child on timeout leaves them holding the session lock, and the next
    // tick's resume fails with "Session ID ... is already in use".
    const proc = spawn(resolveClaudeRunnerBin(), args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true });

    let stdoutBuf = '';
    let observedSessionIds = new Set();
    let finalText = null;
    let isError = false;
    let costEstimate = null;
    let durationApiMs = null;
    let numTurns = null;
    let rateLimitInfo = null;
    let stopReason = null;
    let parseErrors = 0;
    let stderr = '';
    let timedOut = false;
    let aborted = false;

    const kill = (reason) => {
      const killGroup = (sig) => {
        try { process.kill(-proc.pid, sig); } catch { try { proc.kill(sig); } catch {} }
      };
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), 3000).unref();
    };
    const timer = setTimeout(() => { timedOut = true; kill('timeout'); }, timeoutMs);
    const onAbort = () => { aborted = true; kill('aborted'); };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    proc.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString();
      let nl;
      while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.session_id) observedSessionIds.add(ev.session_id);
          if (ev.type === 'rate_limit_event' && ev.rate_limit_info) {
            rateLimitInfo = ev.rate_limit_info;
          }
          if (ev.type === 'result') {
            if (typeof ev.result === 'string') finalText = ev.result;
            if (ev.is_error) isError = true;
            if (typeof ev.total_cost_usd === 'number') costEstimate = ev.total_cost_usd;
            if (typeof ev.duration_api_ms === 'number') durationApiMs = ev.duration_api_ms;
            if (typeof ev.num_turns === 'number') numTurns = ev.num_turns;
            if (ev.stop_reason) stopReason = ev.stop_reason;
          }
        } catch {
          parseErrors++;
        }
      }
    });

    proc.stderr.on('data', (c) => { stderr += c.toString(); });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener?.('abort', onAbort);
      const ok = code === 0 && !isError && !timedOut && !aborted;
      const errStr = stderr.slice(-2000);
      const authExpired = /not authenticated|please log in|login required|auth(?:entication)? expired/i.test(errStr);
      resolve({
        ok,
        timedOut,
        aborted,
        authExpired,
        exitCode: code,
        sessionIds: Array.from(observedSessionIds),
        result: finalText,
        summary: usefulClaudeReceiptSummary(finalText, ok ? 'no-text' : 'error'),
        receipt_text: cappedClaudeReceiptText(finalText),
        api_equivalent_estimate: costEstimate,
        duration_api_ms: durationApiMs,
        duration_total_ms: Date.now() - startedAt,
        num_turns: numTurns,
        stop_reason: stopReason,
        is_error: isError,
        rate_limit_info: rateLimitInfo,
        stderr: errStr,
        parse_errors: parseErrors,
      });
    });

    proc.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: e.message, sessionIds: [], aborted, timedOut, authExpired: false });
    });
  });
}

const ENGINE_VERIFY_TIMEOUT_MS = 5 * 60 * 1000;
const ENGINE_VERIFY_OUTPUT_LIMIT = 4000;

function buildEngineVerifyPrompt(mission, tickIndex) {
  return [
    `# Verify Mission Tick ${tickIndex}`,
    ``,
    `This is a bounded verify-only pass for mission: ${mission.objective}`,
    `Read the diff this tick produced. Do not edit files and do not start another work slice.`,
    `ACTUALLY RUN the changed surface on this computer using real commands and real exit codes.`,
    `Paste the commands and their real output. Do not accept a receipt claim or static inspection as execution proof.`,
    `End your reply with a final line exactly 'VERDICT: PASS' or 'VERDICT: FAIL'.`,
  ].join('\n');
}

function engineVerifierResultFromRun(engineResult, engine = 'codex') {
  const output = String(
    engineResult?.result
    || engineResult?.receipt_text
    || engineResult?.stderr
    || engineResult?.error
    || '',
  ).slice(-ENGINE_VERIFY_OUTPUT_LIMIT);
  if (!engineResult?.ok || engineResult?.timedOut || engineResult?.aborted) {
    return {
      passed: false,
      mode: 'engine-unavailable',
      engine,
      timed_out: Boolean(engineResult?.timedOut),
      output,
    };
  }
  const finalLine = output.trim().split(/\r?\n/).pop() || '';
  return {
    passed: finalLine === 'VERDICT: PASS',
    mode: 'engine',
    engine,
    output,
  };
}

async function runEngineVerifier(mission, options = {}) {
  const cwd = options.cwd || process.cwd();
  const engine = 'codex';
  const verifyMission = { ...mission, runner: engine, runner_kind: 'engine' };
  const restoreRunnerProfile = applyMissionRunnerProfile(engine);
  let engineResult;
  try {
    engineResult = await spawnClaudeTick(verifyMission, {
      sessionMode: 'set',
      sessionId: crypto.randomUUID(),
      cwd,
      signal: options.signal,
      timeoutMs: ENGINE_VERIFY_TIMEOUT_MS,
      prompt: buildEngineVerifyPrompt(mission, options.tickIndex || 1),
      model: resolveClaudeRunnerModel(verifyMission),
    });
  } catch (error) {
    engineResult = { ok: false, error: error.message };
  } finally {
    restoreRunnerProfile();
  }
  return engineVerifierResultFromRun(engineResult, engine);
}

function stripClaudeReceiptLine(line) {
  return String(line || '')
    .trim()
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[-*]\s+/, '')
    .replace(/^\d+[.)]\s+/, '')
    .trim();
}

function usefulClaudeReceiptSummary(text, fallback = 'no-text') {
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    const clean = stripClaudeReceiptLine(line);
    if (!clean) continue;
    if (/^(receipt|summary|final|final answer|result)$/i.test(clean)) continue;
    return clean.slice(0, 240);
  }
  return fallback;
}

function cappedClaudeReceiptText(text, limit = 4000) {
  const clean = String(text || '').trim();
  if (!clean) return '';
  if (clean.length <= limit) return clean;
  return clean.slice(0, limit - 16).trimEnd() + '\n...[truncated]';
}

async function runMission(args) {
  const asJson = wantsJson(args);
  if (hasFlag(args, '--help') || hasFlag(args, '-h')) {
    help();
    return;
  }
  if (hasFlag(args, '--cloud')) {
    const result = await runCloudMissionCommand(args);
    process.exitCode = result.exitCode;
    return result;
  }
  // --fleet: staff every idle capable engine on the board's claimable
  // safe-lane tasks, build in parallel worktrees, land serially. Humble flag,
  // full loop — see lib/fleet.js. --dry-run previews the staffing only.
  if (hasFlag(args, '--fleet')) {
    const { runFleetFlight } = require('../lib/fleet');
    const slots = Math.max(1, Number(readFlag(args, '--slots', '')) || 3);
    // Default: cut build worktrees from origin/master (checkoutBase). --base
    // keeps launcher-HEAD only when the operator asks for it explicitly.
    const baseOverride = readFlag(args, '--base', '');
    const flight = await runFleetFlight({
      slots,
      dryRun: hasFlag(args, '--dry-run'),
      log: asJson ? () => {} : console.log,
      ...(baseOverride ? { checkoutBase: baseOverride } : {}),
    });
    if (asJson) console.log(JSON.stringify(flight, null, 2));
    process.exitCode = flight.paused && flight.paused.length > 0 ? 1 : 0;
    return;
  }
  const dueMode = hasFlag(args, '--due');
  const headlessOnly = hasFlag(args, '--headless');
  const selfDrive = dueMode || headlessOnly || hasFlag(args, '--self-drive');
  const skipClaude = hasFlag(args, '--no-claude');
  const verifyEach = !hasFlag(args, '--no-verify');
  const completeOnPass = hasFlag(args, '--complete-on-pass');
  const skipDrain = hasFlag(args, '--no-drain');
  const createNext = hasFlag(args, '--create-next');
  const budgetTier = readMissionBudgetTier(args, { json: asJson });
  const runBudgetContract = budgetContractFromTier(budgetTier, args);
  const maxTicksFlag = readFlag(args, '--max-ticks', '');
  let maxTicks = Math.max(1, Number(maxTicksFlag) || (budgetTier ? budgetTier.max_ticks : MISSION_RUN_DEFAULTS.maxTicks));
  // BCK-1324: a tick that "ran" but left no structural trace (no new/cleared
  // dirty files, no verifier pass) is a no-op wearing a success label — the
  // live 6h run e7b93c4d burned 15 consecutive ticks stuck at
  // new_since_baseline_count=4 with reason=tick-ok every time. Stop honestly
  // instead of grinding the tick budget. 0 disables the guard.
  const maxIdleTicks = readNonNegativeIntegerFlag(args, '--max-idle-ticks', MISSION_RUN_DEFAULTS.maxIdleTicks);
  const maxWallFlag = readFlag(args, '--max-wall', '');
  let maxWallSeconds = Math.max(0.001, Number(maxWallFlag) || (budgetTier ? budgetTier.requested_seconds : MISSION_RUN_DEFAULTS.maxWallSeconds));
  const cadenceOverride = readFlag(args, '--cadence', '');
  const engineOverrideRaw = readFlag(args, '--engine', '');
  const runnerOverride = engineOverrideRaw
    ? resolveMissionRunnerSelection(engineOverrideRaw, { asJson, engineOnly: true, label: 'engine' })
    : null;
  const modelOverride = readFlag(args, '--model', '');
  const runtimeView = (baseMission) => missionRunRuntimeView(baseMission, runnerOverride, modelOverride);
  const input = missionRunInputFromArgs(args);
  const ref = input.ref;
  const runArgs = input.args;

  if (!dueMode && !ref) {
    if (asJson || !process.stdin.isTTY || !process.stderr.isTTY) {
      missionRunInputRequired(asJson, input.owner);
    }
    const prompted = await promptMissionRunInput(runArgs);
    await startMissionFromRunObjective(prompted.objective, prompted.args);
    return;
  }

  let mission = dueMode && !ref ? selectDueMission(process.cwd(), new Date(), { headlessOnly }) : resolveMission(ref);
  if (!mission && dueMode && !ref) {
    printJsonOrText(
      { ok: true, action: 'run_skipped', reason: 'no_due_mission', mission: null },
      ['No due mission found.'],
      asJson,
    );
    return;
  }
  // BCK-1319: a bare single token that looks like an id/suffix/number (no
  // whitespace, hex/id/numeric shape) is a mistyped or stale mission handle,
  // not a new objective. Silently starting a fresh mission from it is the
  // worst failure mode — it buries the mission the operator meant to run.
  // Only a genuine multi-word (or non-handle-shaped) ref keeps the
  // start-a-new-mission shortcut.
  if (!mission && ref && missionRefLooksLikeHandle(ref)) {
    exitMissingMission(ref, 1, asJson);
  }
  if (!mission && ref) {
    await startMissionFromRunObjective(ref, runArgs);
    return;
  }
  if (!mission) {
    exitMissionError('Usage: atris mission run <id|objective> [--max-ticks 4] [--max-wall 3600]', 1, asJson);
  }
  if (!maxTicksFlag && !budgetTier && Number(mission.max_ticks) > 0) {
    maxTicks = Math.max(1, Number(mission.max_ticks));
  }
  if (!maxWallFlag && budgetTier) {
    maxWallSeconds = Math.max(60, Number(budgetTier.requested_seconds));
  } else if (!maxWallFlag && Number(mission.budget_contract?.requested_seconds) > 0) {
    maxWallSeconds = Math.max(60, Number(mission.budget_contract.requested_seconds));
  }
  if (['complete', 'stopped'].includes(mission.status)) {
    if (asJson) {
      printJsonOrText(
        { ok: true, action: 'run_skipped', reason: mission.status, mission },
        [],
        true,
      );
      return;
    }
    console.error(`Mission ${mission.id} is ${mission.status}; nothing to run.`);
    process.exit(0);
  }

  const nativeGoalRunOptions = codexNativeGoalOptionsFromArgs(args);
  const autoAck = maybeAutoAckCodexNativeGoal(mission, process.cwd(), nativeGoalRunOptions);
  if (autoAck) mission = autoAck.saved;
  maybeBlockUntilCodexNativeGoalStarted(runtimeView(mission), asJson, nativeGoalRunOptions);

  // No pre-lock claude probe here: the runner profile isn't applied yet, so
  // probing would test the default claude bin even when the effective runner
  // (e.g. --engine cursor) never invokes claude. The in-lock probe below runs
  // after applyMissionRunnerProfile and checks the right binary.

  const lock = acquireMissionLock(mission.id);
  if (!lock.ok) {
    exitMissionError(`[mission run] lock busy (held by pid ${lock.holder?.pid || '?'} since ${lock.holder?.started_at || '?'}). Exit.`, 3, asJson);
  }

  // Everything past lock acquisition runs inside try/finally so the lock + signal handlers
  // always get cleaned up — including saveMission failures during pending-session setup.
  let pauseReason = null;
  let sessionId = null;
  let pendingSessionId = null;
  let ranTicks = 0;
  const ticks = [];
  let onSig = null;
  let restoreRunnerProfile = null;
  let blocker = null;

  try {
    const cwd = process.cwd();
    const controller = new AbortController();
    onSig = () => { controller.abort(); };
    process.on('SIGINT', onSig);
    process.on('SIGTERM', onSig);

    // Re-read inside the lock. The initial resolveMission ran pre-lock, so a concurrent
    // `mission tick` could have written between resolveMission and acquireMissionLock.
    // Derive sessionId, pendingSessionId, and the frozen contract from the fresh record
    // so a fast tick's writes can't be silently overwritten by this run loop.
    mission = resolveMission(mission.id) || mission;
    let runtimeMission = runtimeView(mission);
    if (['complete', 'stopped'].includes(mission.status)) {
      console.error(`Mission ${mission.id} is ${mission.status}; nothing to run.`);
      return;
    }
    if (returnIfCodexNativeGoalNotStarted(runtimeMission, asJson, nativeGoalRunOptions)) return;
    if (mission.status === 'paused') {
      mission = saveMission({
        ...mission,
        status: 'running',
        paused_at: null,
        resumed_at: stampIso(),
        stop_reason: null,
        next_action: `running: atris mission run ${mission.id}`,
      }, cwd, 'mission_run_resumed', { reason: 'operator-resume' }).mission;
      runtimeMission = runtimeView(mission);
    }
    sessionId = mission.claude_session_id || null;
    pendingSessionId = mission.pending_session_id || null;
    const autoRunner = String(runtimeMission.runner || '').trim().toLowerCase() === MISSION_AUTO_RUNNER;
    restoreRunnerProfile = autoRunner ? () => {} : applyMissionRunnerProfile(runtimeMission.runner);
    const callerSessionRunner = runnerUsesCallerSession(runtimeMission.runner);
    const runnerName = String(runtimeMission.runner || '').trim().toLowerCase();
    const atris2Runner = runnerName === 'atris2';
    const drillRunner = runnerName === 'drill';
    const skipWorker = skipClaude || callerSessionRunner;
    if (!autoRunner && !skipClaude && !callerSessionRunner && !atris2Runner && !drillRunner) {
      const probe = probeClaudeBinary();
      if (!probe.ok) {
        console.error(`[mission run] claude probe failed: ${probe.error}`);
        process.exit(2);
      }
    }

    // Freeze run-start contract (verifier, lane). Stored on receipts, not the mission record.
    const frozen = {
      verifier: effectiveMissionVerifier(mission),
      lane: mission.lane || 'workspace',
      runner: runtimeMission.runner || 'manual',
      model: runtimeMission.model || null,
      ...(runnerOverride ? { stored_runner: mission.runner || null, stored_model: mission.model || null } : {}),
      started_at: stampIso(),
    };
    const runWorktreeBefore = gitWorktreeSnapshot(cwd);
    const runWorktreeBaseline = loadMissionWorktreeBaseline(mission.id, cwd);
    const cadence = cadenceOverride || mission.cadence || 'manual';
    let cadenceSeconds = parseCadenceSeconds(cadence);
    // cadence=manual|once: exactly 1 tick unless user explicitly raised --max-ticks
    const hasExplicitTickBudget = Boolean(maxTicksFlag || budgetTier || Number(mission.max_ticks) > 0);
    const effectiveMaxTicks = (cadenceSeconds === 0 && !hasExplicitTickBudget) ? 1 : maxTicks;

    // Session setup: only Claude-backed workers need a persisted session id.
    // atris2 turns are stateless per tick — continuity lives on disk (logs, receipts, now.md).
    if (!skipWorker && !atris2Runner && !drillRunner && !sessionId && !pendingSessionId) {
      pendingSessionId = crypto.randomUUID();
      mission = saveMission({ ...mission, pending_session_id: pendingSessionId }, cwd, 'mission_session_pending', { session_id: pendingSessionId }).mission;
      runtimeMission = runtimeView(mission);
    }

    const startedAt = Date.now();
    let backoffAttempt = 0;
    let lastRateLimit = null;
    let continuationGoal = null;

    const sessionLabel = skipWorker
      ? 'caller-session'
      : atris2Runner
        ? `atris2 (${runtimeMission.model || 'atris:fast'})`
        : drillRunner
          ? 'drill'
          : (sessionId || `pending=${pendingSessionId}`);
    if (!asJson) {
      console.error(`[mission run] ${mission.id}\n  objective: ${mission.objective}\n  lane: ${frozen.lane}\n  cadence: ${cadence} (${cadenceSeconds}s)\n  max_ticks: ${effectiveMaxTicks}, max_wall: ${maxWallSeconds}s\n  session: ${sessionLabel}`);
    }

    while (ticks.length < effectiveMaxTicks) {
      const elapsedSec = (Date.now() - startedAt) / 1000;
      const remainingWall = maxWallSeconds - elapsedSec;
      if (remainingWall <= 0) { pauseReason = 'max-wall-reached'; break; }
      if (controller.signal.aborted) { pauseReason = 'aborted'; break; }

      // Re-read mission, detect mutation of frozen fields
      mission = resolveMission(mission.id) || mission;
      runtimeMission = runtimeView(mission);
      if (['complete', 'stopped', 'paused'].includes(mission.status)) { pauseReason = mission.status; break; }
      if (effectiveMissionVerifier(mission) !== frozen.verifier) { pauseReason = 'verifier-mutated'; break; }
      if ((mission.lane || 'workspace') !== frozen.lane) { pauseReason = 'lane-mutated'; break; }

      const tickIdx = Number(mission.last_tick_index || 0) + 1;
      const tickStart = stampIso();
      const tickWorktreeBefore = gitWorktreeSnapshot(cwd);
      let result = { status: 'skipped', reason: 'unknown', tick_index: tickIdx, ran: false, started_at: tickStart };
      const tickSelection = resolveMissionTickRunner(runtimeMission, cwd);
      const tickRuntimeMission = tickSelection.mission;
      const tickRunnerName = String(tickRuntimeMission.runner || '').trim().toLowerCase();
      const tickCallerSessionRunner = runnerUsesCallerSession(tickRunnerName);
      const tickAtris2Runner = tickRunnerName === 'atris2';
      const tickDrillRunner = tickRunnerName === 'drill';
      const tickSkipWorker = skipClaude || tickCallerSessionRunner;
      const inferredEngineId = canonicalEngineName(tickRunnerName);
      const engineBackedTick = autoRunner
        || runtimeMission.runner_kind === 'engine'
        || (inferredEngineId && !MISSION_NATIVE_RUNNER_SET.has(tickRunnerName));
      const tickEngineId = engineBackedTick ? (tickSelection.engine_id || inferredEngineId) : null;
      if (engineBackedTick) {
        result.engine_id = tickEngineId;
        result.requested_engine = tickSelection.requested_engine;
        result.engine_fallback_reason = tickSelection.engine_fallback_reason;
      }

      // Active-hours gate
      if (engineBackedTick && !tickEngineId) {
        result = { ...result, status: 'errored', reason: 'no-ready-engine' };
      } else if (!isWithinActiveHours(mission.active_hours)) {
        result = { ...result, status: 'skipped', reason: 'quiet-hours' };
      }
      // Rate-limit cooldown
      else if (lastRateLimit && lastRateLimit.resetsAt && Date.now() / 1000 < Number(lastRateLimit.resetsAt)) {
        const waitSec = Number(lastRateLimit.resetsAt) - Math.floor(Date.now() / 1000);
        if (waitSec > remainingWall) { pauseReason = 'rate-limit-exceeded-wall'; break; }
        result = { ...result, status: 'skipped', reason: 'rate-limited', resets_at: lastRateLimit.resetsAt };
      }
      // Real tick
      else if (tickSkipWorker) {
        result = {
          ...result,
          status: 'ran',
          reason: tickCallerSessionRunner ? 'caller-session-runner' : 'no-claude-mode',
          ran: true,
          claude: { skipped: true, reason: tickCallerSessionRunner ? 'runner-uses-caller-session' : 'no-claude-mode' },
        };
      } else if (tickDrillRunner) {
        const drillResult = runDrillRunnerTick(cwd, tickRuntimeMission, tickIdx);
        result = {
          ...result,
          status: 'ran',
          reason: 'drill-runner',
          ran: true,
          drill: drillResult,
        };
      } else if (tickAtris2Runner) {
        const pingDrain = consumeMissionPings(mission, cwd);
        mission = pingDrain.mission;
        runtimeMission = runtimeView(mission);
        const prompt = buildTickPrompt(tickRuntimeMission, tickIdx, effectiveMaxTicks, frozen, pingDrain.pings);
        const { runAtris2Turn } = require('./probe');
        const businessId = businessIdForAtris2Mission(tickRuntimeMission, cwd);
        const tickController = new AbortController();
        let wallExpired = false;
        const abortTick = () => tickController.abort();
        controller.signal.addEventListener('abort', abortTick, { once: true });
        const tickTimer = setTimeout(() => {
          wallExpired = true;
          tickController.abort();
        }, Math.max(1, Math.floor(remainingWall * 1000)));
        let turn;
        try {
          turn = await runAtris2Turn({
            prompt,
            model: tickRuntimeMission.model || 'atris:fast',
            business: businessId,
            maxTurns: 16,
            signal: tickController.signal,
            // CLI-231: mission ticks execute relayed ops in the mission's own
            // workspace, not the hosted ai-computer filesystem.
            localCwd: cwd,
          });
        } finally {
          clearTimeout(tickTimer);
          controller.signal.removeEventListener('abort', abortTick);
        }
        result.atris2 = {
          ok: turn.ok,
          engine: turn.engine,
          model: tickRuntimeMission.model || 'atris:fast',
          tools_run: turn.tools_run,
          unsupported: turn.unsupported,
          duration_ms: turn.duration_ms,
          error: turn.error,
          backend_unavailable: isTransientAtris2BackendError(turn.error) || undefined,
          receipt_text: String(turn.text || '').slice(0, 4000),
        };
        if (controller.signal.aborted) { pauseReason = 'aborted-during-atris2'; break; }
        if (turn.error === 'not-logged-in') { pauseReason = 'auth-required'; break; }
        if (wallExpired) {
          result = { ...result, status: 'errored', reason: 'wall-exceeded-during-tick' };
        } else if (!turn.ok || !String(turn.text || '').trim()) {
          result = { ...result, status: 'errored', reason: atris2TurnErrorReason(turn.error) };
        } else {
          result = { ...result, status: 'ran', reason: 'tick-ok', ran: true };
        }
      } else {
        const sessionMode = sessionId ? 'resume' : 'set';
        const useId = sessionId || pendingSessionId;
        const pingDrain = consumeMissionPings(mission, cwd);
        mission = pingDrain.mission;
        runtimeMission = runtimeView(mission);
        const prompt = buildTickPrompt(tickRuntimeMission, tickIdx, effectiveMaxTicks, frozen, pingDrain.pings);
        const restoreTickRunnerProfile = tickEngineId ? applyMissionRunnerProfile(tickEngineId) : () => {};
        let claudeResult;
        try {
          claudeResult = await spawnClaudeTick(tickRuntimeMission, {
            sessionMode, sessionId: useId, cwd, signal: controller.signal,
            timeoutMs: Math.min(MISSION_RUN_DEFAULTS.claudeTimeoutMs, Math.max(1, Math.floor(remainingWall * 1000))), prompt,
            model: resolveClaudeRunnerModel(tickRuntimeMission),
          });
        } finally {
          restoreTickRunnerProfile();
        }
        result.claude = {
          ok: claudeResult.ok,
          brief_id: claudeResult.brief_id || null,
          summary: claudeResult.summary,
          receipt_text: claudeResult.receipt_text,
          stop_reason: claudeResult.stop_reason,
          api_equivalent_estimate: claudeResult.api_equivalent_estimate,
          duration_total_ms: claudeResult.duration_total_ms,
          num_turns: claudeResult.num_turns,
          observed_session_ids: claudeResult.sessionIds,
          parse_errors: claudeResult.parse_errors,
          stderr: claudeResult.stderr?.slice(-1000),
          timed_out: claudeResult.timedOut,
          aborted: claudeResult.aborted,
        };
        if (claudeResult.rate_limit_info) {
          // Claude reports the five-hour window's resetsAt on every turn, even
          // when status is "allowed". Only a non-allowed status is a cooldown;
          // treating an allowed resetsAt as one pauses every timed run after
          // tick 1 with rate-limit-exceeded-wall.
          lastRateLimit = claudeResult.rate_limit_info.status === 'allowed' ? null : claudeResult.rate_limit_info;
        }
        if (claudeResult.aborted) { pauseReason = 'aborted-during-claude'; break; }
        if (claudeResult.authExpired) { pauseReason = 'auth-required'; break; }

        if (!claudeResult.ok) {
          const deadModel = detectUnavailableModel(claudeResult.summary || claudeResult.receipt_text);
          const wallBoundTimeout = remainingWall * 1000 <= MISSION_RUN_DEFAULTS.claudeTimeoutMs;
          let reason = claudeResult.timedOut
            ? (wallBoundTimeout ? 'wall-exceeded-during-tick' : 'claude-timeout')
            : 'claude-error';
          if (deadModel) { reason = 'model-unavailable'; result.model_unavailable = deadModel; }
          // A killed tick (usually claude-timeout) can leave the session lock
          // held, so the next resume fails with "already in use". A session
          // that was cleaned up between ticks fails the resume the other way,
          // with "No conversation found with session ID". Both mean the stored
          // id is dead. Session continuity is disposable — mission state lives
          // on disk (receipts, logs, now.md) — so rotate to a fresh id instead
          // of grinding the repeated-error breaker on a stale session.
          const staleSession = /session id .* is already in use/i.test(claudeResult.stderr || '')
            || /no conversation found with session id/i.test(claudeResult.stderr || '');
          if (staleSession) {
            reason = 'claude-session-busy';
            pendingSessionId = crypto.randomUUID();
            sessionId = null;
            mission = saveMission(
              { ...mission, claude_session_id: null, pending_session_id: pendingSessionId },
              cwd, 'mission_session_rotated', { reason: 'session-lock-busy', session_id: pendingSessionId },
            ).mission;
          }
          result = { ...result, status: 'errored', reason };
        } else {
          // Promote pending session id ONLY if claude confirmed the exact UUID we requested.
          // Mismatch is an invariant failure (we sent --session-id X, got Y) → pause, don't rotate.
          if (!sessionId && pendingSessionId) {
            if (claudeResult.sessionIds.includes(pendingSessionId)) {
              sessionId = pendingSessionId;
              mission = saveMission({ ...mission, claude_session_id: sessionId, pending_session_id: null }, cwd, 'mission_session_started', { session_id: sessionId }).mission;
            } else if (claudeResult.sessionIds.length > 0) {
              const observed = claudeResult.sessionIds[0];
              mission = saveMission({ ...mission, session_id_mismatch: { requested: pendingSessionId, observed } }, cwd, 'mission_session_mismatch', { requested: pendingSessionId, observed }).mission;
              pauseReason = 'session-id-mismatch-first-tick';
              break;
            }
          } else if (sessionId && claudeResult.sessionIds.length > 0 && !claudeResult.sessionIds.includes(sessionId)) {
            // session_id mismatch on a resumed session — abort run
            pauseReason = 'session-id-mismatch';
            break;
          }
          result = { ...result, status: 'ran', reason: 'tick-ok', ran: true };
        }
      }

      if (tickEngineId) {
        result.rate_limit_info = lastRateLimit;
        const engineHealth = recordMissionEngineTickOutcome(tickEngineId, result, cwd);
        if (engineHealth) result.engine_health = engineHealth.health;
      }

      // Verifier (only if claude succeeded or no-claude mode)
      let verifierResult = null;
      let receiptPath = null;
      if (result.status === 'ran' && verifyEach) {
        if (frozen.verifier) {
          verifierResult = runVerifier(frozen.verifier);
        } else if (!tickSkipWorker) {
          verifierResult = await runEngineVerifier(tickRuntimeMission, {
            cwd,
            signal: controller.signal,
            tickIndex: tickIdx,
          });
        }
        if (verifierResult) result.verifier_passed = verifierResult.passed;
      }
      stampMissionRunnerBrief(cwd, result.claude?.brief_id, result, verifierResult);

      // Review-lane drain: always-on loops sweep the agent-safe review actions
      // each tick so proof-backed work reaches certified on cadence with zero
      // human turns. Human accept stays the only path to Done; --no-drain opts out.
      if (mission.always_on && result.status === 'ran') {
        result.review_lane = skipDrain
          ? { skipped: true, reason: 'no-drain-flag' }
          : runReviewLaneDrain(cwd);
      }
      const tickWorktree = worktreeReceipt(tickWorktreeBefore, gitWorktreeSnapshot(cwd), { verifier: frozen.verifier, baseline: runWorktreeBaseline });

      // Layer classification needs the receipt text AND the worktree receipt, so it
      // runs here — after both exist — covering the claude and atris2 branches alike.
      const tickReceiptText = result.atris2?.receipt_text || result.claude?.receipt_text || result.drill?.receipt_text || '';
      const layerInfo = extractLayerFromReceiptText(tickReceiptText, tickWorktree?.new_since_baseline_sample);
      result.layer = layerInfo.layer;
      result.layer_source = layerInfo.source;

      // Persist tick to mission state + write structured receipt
      const finishedAt = stampIso();
      const tickRecord = { ...result, started_at: tickStart, finished_at: finishedAt, worktree: tickWorktree };
      ticks.push(tickRecord);
      receiptPath = writeReceipt(runtimeMission, {
        kind: 'mission_run_tick',
        tick: tickRecord,
        frozen,
        verifier_result: verifierResult,
        rate_limit_info: lastRateLimit,
        worktree: tickWorktree,
      });

      const xpReadyAction = missionXpReadyAction(mission, receiptPath);
      const budgetRemainingSeconds = missionFullBudgetRemainingSeconds(mission);
      const fullBudgetMode = budgetRemainingSeconds > 0;
      const newStatus = (verifierResult?.passed && mission.always_on) ? 'ready' :
                        (verifierResult?.passed && xpReadyAction) ? 'ready' :
                        (verifierResult?.passed && completeOnPass && !fullBudgetMode) ? 'complete' :
                        (verifierResult?.passed && fullBudgetMode) ? 'running' :
                        (verifierResult?.passed ? 'ready' :
                        (verifierResult ? 'blocked' :
                        (result.status === 'ran' ? 'running' : mission.status)));
      let nextAction = mission.next_action;
      if (verifierResult?.passed && mission.always_on) {
        nextAction = nextCandidateTickAction(mission);
      } else if (verifierResult?.passed && xpReadyAction) {
        nextAction = xpReadyAction;
      } else if (verifierResult?.passed && completeOnPass && !fullBudgetMode) {
        nextAction = 'mission complete';
      } else if (verifierResult?.passed && fullBudgetMode) {
        nextAction = `proof passed with ${durationLabel(budgetRemainingSeconds)} left on the budget; pick the next useful move, then: atris mission tick ${mission.id} --verify --summary "<what changed>"`;
      } else if (verifierResult?.passed) {
        nextAction = `review proof then run: atris mission complete ${mission.id} --proof "${receiptPath}"`;
      } else if (verifierResult) {
        nextAction = 'fix verifier failure or revise mission';
      } else if (result.status === 'ran' && mission.always_on) {
        nextAction = nextCandidateTickAction(mission);
      }
      // Context hygiene: count ran claude ticks on this session; at the
      // rotation threshold, drop the session so the next tick starts fresh.
      const claudeRanTick = Boolean(result.claude) && result.status === 'ran';
      const claudeSessionTicks = claudeRanTick ? Number(mission.claude_session_ticks || 0) + 1 : Number(mission.claude_session_ticks || 0);
      const rotateSessionForContext = claudeRanTick && claudeSessionTicks >= CLAUDE_SESSION_CONTEXT_ROTATE_TICKS;
      mission = saveMission({
        ...mission,
        status: newStatus,
        paused_at: null,
        stop_reason: null,
        last_tick_at: finishedAt,
        last_tick_status: result.status,
        last_tick_reason: result.reason,
        last_tick_index: tickIdx,
        last_tick_layer: result.layer,
        last_tick_layer_source: result.layer_source,
        verifier_result: verifierResult || mission.verifier_result || null,
        receipt_path: receiptPath,
        next_action: nextAction,
        claude_session_ticks: rotateSessionForContext ? 0 : claudeSessionTicks,
      }, cwd, 'mission_tick', {
        tick_index: tickIdx, status: result.status, reason: result.reason, receipt_path: receiptPath, layer: result.layer,
      }).mission;
      if (rotateSessionForContext) {
        // Same shape as the stale-lock rotation above: mint the fresh pending
        // id AND reset the loop locals, or the next tick resumes the old
        // session from its stale local and the rotation is a no-op.
        pendingSessionId = crypto.randomUUID();
        sessionId = null;
        mission = saveMission(
          { ...mission, claude_session_id: null, pending_session_id: pendingSessionId },
          cwd, 'mission_session_rotated', {
            reason: 'context-refresh', after_ticks: claudeSessionTicks, session_id: pendingSessionId,
          },
        ).mission;
      }
      appendMemberLog(mission.owner, `Mission run tick ${tickIdx}`, {
        mission: mission.objective,
        state: mission.status,
        tick_status: result.status,
        reason: result.reason,
        layer: result.layer || undefined,
        verifier: verifierResult ? (verifierResult.passed ? 'passed' : 'failed') : 'not_run',
        receipt: receiptPath,
      });
      if (newStatus === 'complete') {
        continuationGoal = seedMissionRunContinuation(mission, cwd, receiptPath);
        if (continuationGoal?.parent) mission = continuationGoal.parent;
      }
      refreshCodexGoalController(cwd);

      if (!asJson) {
        console.error(`[tick ${tickIdx}] status=${result.status} reason=${result.reason} verifier=${verifierResult ? (verifierResult.passed ? 'pass' : 'fail') : 'skip'} -> ${receiptPath || '-'}`);
      }

      if (result.status === 'ran') {
        ranTicks++;
        backoffAttempt = 0;
      } else if (result.status === 'errored' && result.reason !== 'claude-session-busy') {
        // A rotated session is already healed — the next tick starts on a
        // fresh id, so backing off just burns wall clock. If rotation itself
        // keeps failing, the repeated-error breaker below still stops the run.
        backoffAttempt++;
      }

      if (result.status === 'errored' && result.reason === 'wall-exceeded-during-tick') {
        pauseReason = 'max-wall-reached';
        break;
      }

      if (callerSessionRunner && result.status === 'ran') break;
      if (newStatus === 'complete' || (newStatus === 'ready' && !mission.always_on && !fullBudgetMode)) break;
      if (consecutiveVerifierFails(ticks) >= 2) { pauseReason = 'consecutive-verifier-fails'; break; }
      // BCK-1324: N consecutive ticks that each self-report "ran" but leave no
      // structural trace is a manufactured-busywork loop, not progress. Stop
      // honestly (clean stop, not a pause/blocker) rather than burn the rest
      // of the tick budget. --max-idle-ticks 0 disables this guard.
      if (maxIdleTicks > 0 && consecutiveNoProgressTicks(ticks) >= maxIdleTicks) { pauseReason = 'no-progress'; break; }
      // A retired/inaccessible model is deterministic: the id is fixed for the run, so
      // every remaining tick (and every future cron firing) fails identically. Backoff
      // only slows the bleeding. Stop on first detection and surface the dead id —
      // CLI-245 named this failure; this stops the loop from grinding on it forever.
      if (result.status === 'errored' && result.reason === 'model-unavailable') { pauseReason = 'model-unavailable'; break; }
      // Any OTHER error that recurs identically (claude-timeout, atris2-error, claude-error)
      // is the same trap one step less deterministic: keep retrying and the loop burns every
      // tick + cron firing on it. Halt at two-in-a-row and surface the reason for a human.
      const errStreak = consecutiveSameReasonErrors(ticks);
      // Sleeping Atris2 backends are different: leave the mission running so the
      // next tick or heartbeat can catch the backend after it wakes.
      if (errStreak.count >= 2 && !missionRunKeepsRetryingError(errStreak.reason)) { pauseReason = `repeated-error:${errStreak.reason}`; break; }

      // Sleep until next tick
      let sleepMs = 0;
      if (result.status === 'errored' && result.reason !== 'claude-session-busy') {
        sleepMs = computeBackoff(MISSION_RUN_DEFAULTS.backoff, backoffAttempt);
      } else if (cadenceSeconds > 0) {
        sleepMs = cadenceSeconds * 1000;
      } else if (result.status === 'skipped' && result.reason === 'quiet-hours') {
        sleepMs = 60_000; // 1min poll while waiting for window
      } else if (result.status === 'skipped' && result.reason === 'rate-limited') {
        sleepMs = Math.min(60_000, (Number(lastRateLimit.resetsAt) * 1000) - Date.now());
      }
      const remainingMs = remainingWall * 1000 - 1;
      sleepMs = Math.min(Math.max(0, sleepMs), Math.max(0, remainingMs));
      if (sleepMs > 0 && ticks.length < effectiveMaxTicks) {
        try { await sleep(sleepMs, controller.signal); }
        catch (e) { if (e.code === 'ABORTED') { pauseReason = 'aborted'; break; } throw e; }
      }
    }

    if (!pauseReason && ticks.length >= effectiveMaxTicks) {
      const lastTick = ticks[ticks.length - 1];
      if (lastTick && lastTick.status !== 'ran' && !missionRunKeepsRetryingError(lastTick.reason)) pauseReason = 'max-ticks-reached';
    }

    // BCK-1324: no-progress is a clean, honest stop — the run did what it
    // could and correctly recognized there was nothing left to do. It is NOT
    // a failure/blocker: pausing it (resumable, retried by cron/self-drive)
    // or dispatching handleMissionBlocker (files a fleet task, dispatches an
    // engine) would recreate the exact busywork loop this guard exists to
    // stop. Give it its own branch, shaped like stopMission()'s stop path —
    // status=stopped, a receipt, no escalation, no blocker.
    if (pauseReason === 'no-progress') {
      const stoppedAt = stampIso();
      const idleCount = consecutiveNoProgressTicks(ticks);
      const noProgressReason = `no-progress: ${idleCount} consecutive tick(s) with no new/cleared dirty files and no verifier pass`;
      const snapshot = gitWorktreeSnapshot(cwd);
      const stopWorktree = worktreeReceipt(snapshot, snapshot, { verifier: frozen.verifier, baseline: runWorktreeBaseline });
      const noProgressReceipt = writeReceipt(runtimeView(mission), { kind: 'mission_stop', reason: noProgressReason, worktree: stopWorktree });
      const baselineSummary = pruneMissionWorktreeBaseline(mission, cwd);
      mission = saveMission({
        ...mission,
        status: 'stopped',
        stopped_at: stoppedAt,
        paused_at: null,
        stop_reason: noProgressReason,
        receipt_path: noProgressReceipt || mission.receipt_path || null,
        worktree_baseline: baselineSummary || mission.worktree_baseline || null,
        next_action: 'mission stopped: no progress — inspect the last few receipts, then start a fresh mission or resume with new context',
      }, cwd, 'mission_run_stopped_no_progress', {
        reason: noProgressReason,
        idle_ticks: idleCount,
        receipt_path: noProgressReceipt,
      }).mission;
      clearDirectRunCodexGoalRequestForMission(mission.id, cwd);
      appendMemberLog(mission.owner, 'Mission stopped: no progress', { mission: mission.objective, reason: noProgressReason });
    } else if (pauseReason && !['complete', 'ready', 'max-wall-reached'].includes(pauseReason)) {
      const lastTick = ticks[ticks.length - 1];
      const deadModel = pauseReason === 'model-unavailable' ? (lastTick && lastTick.model_unavailable) || null : null;
      const lastErrorReason = lastTick && lastTick.status === 'errored' ? lastTick.reason : null;
      const pausedAt = stampIso();
      const pausedMission = {
        ...mission,
        status: 'paused',
        paused_at: pausedAt,
        stop_reason: pauseReason,
        next_action: missionPauseNextAction(pauseReason, mission.id, deadModel, lastErrorReason),
      };
      const escalation = escalateHumanBlockingPause(pausedMission, cwd, { pauseReason, pausedAt, deadModel });
      mission = saveMission(escalation.mission, cwd, 'mission_run_paused', {
        reason: pauseReason,
        ...(deadModel ? { model_unavailable: deadModel } : {}),
        ...(escalation.escalated ? { escalation: { channel: escalation.channel, sent: escalation.sent } } : {}),
      }).mission;
    }

    // 'no-progress' is a clean stop the run diagnosed itself — never route it
    // through handleMissionBlocker (that would file a blocker task and
    // dispatch an engine to "fix" a mission that correctly stopped itself).
    const blockerReason = pauseReason === 'no-progress'
      ? null
      : (pauseReason || mission.stop_reason || (mission.status === 'blocked' ? 'verifier-failed' : null));
    if (selfDrive && blockerReason) {
      blocker = require('../lib/self-drive').handleMissionBlocker({
        mission,
        stopReason: blockerReason,
        workspaceRoot: cwd,
        appendEvent: (type, payload) => appendEvent(type, mission, payload, cwd),
      });
    }

    const summaryWorktree = worktreeReceipt(runWorktreeBefore, gitWorktreeSnapshot(cwd), { verifier: frozen.verifier, baseline: runWorktreeBaseline });
    const createdNext = createNext
      ? require('./loop-front').createNextLoopTask(['--as', mission.owner || 'auto-improver', '--json'], cwd, { print: false })
      : null;
    const landingSummary = {
      changed: missionRunChangedText(mission, ranTicks, effectiveMaxTicks, ticks, createdNext),
      timeline_command: missionRunTimelineCommand(mission),
      export_command: missionRunExportCommand(mission),
      prune_preview_command: missionRunPrunePreviewCommand(mission),
      next: missionRunCreatedNextLine(createdNext, continuationGoal, mission),
    };
    landingSummary.reason = missionHumanReasonText(mission, landingSummary.changed);
    const finalRuntimeMission = runtimeView(mission);
    const effectiveBudgetContract = runBudgetContract || mission.budget_contract || null;
    const finalReceipt = writeReceipt(finalRuntimeMission, {
      kind: 'mission_run_summary',
      frozen,
      pause_reason: pauseReason,
      ran_ticks: ranTicks,
      tick_count: ticks.length,
      ticks,
      session_id: sessionId,
      pending_session_id: mission.pending_session_id || null,
      elapsed_seconds: (Date.now() - startedAt) / 1000,
      budget_contract: effectiveBudgetContract,
      worktree: summaryWorktree,
      created_next: createdNext,
      landing: landingSummary,
    });
    const atrisGoalState = refreshAtrisGoalController(cwd, { missionId: mission.id });
    const codexGoalState = refreshCodexGoalController(cwd);

    printJsonOrText(
      { ok: true, action: 'mission_run', mission, runner_override: runnerOverride ? finalRuntimeMission.run_runner_override : null, ran_ticks: ranTicks, tick_count: ticks.length, ticks, pause_reason: pauseReason, blocker, session_id: sessionId, summary_receipt: finalReceipt, budget_contract: effectiveBudgetContract, worktree: summaryWorktree, atris_goal_state: atrisGoalState, codex_goal_state: codexGoalState, continuation_goal: continuationGoal, created_next: createdNext },
      missionRunSummaryLines(mission, ranTicks, effectiveMaxTicks, finalReceipt, pauseReason, continuationGoal, ticks, createdNext, blocker),
      asJson,
    );
  } finally {
    if (onSig) {
      try { process.removeListener('SIGINT', onSig); } catch {}
      try { process.removeListener('SIGTERM', onSig); } catch {}
    }
    if (restoreRunnerProfile) {
      try { restoreRunnerProfile(); } catch {}
    }
    releaseMissionLock(lock);
  }
}

function tickMission(args) {
  const asJson = wantsJson(args);
  if (hasFlag(args, '--help') || hasFlag(args, '-h') || String(args[0] || '').trim() === 'help') {
    console.log('Usage: atris mission tick <id> [--verify] [--summary "..."] [--complete-on-pass] [--self-drive]');
    console.log('Run `atris mission --help` for the full option list.');
    process.exit(0);
  }
  const verify = hasFlag(args, '--verify');
  const verifyOverride = readFlag(args, '--verify', '');
  const completeOnPass = hasFlag(args, '--complete-on-pass');
  const summary = readFlag(args, '--summary', '');
  const selfDrive = hasFlag(args, '--self-drive');
  const nativeGoalOptions = codexNativeGoalOptionsFromArgs(args);
  const operatorSummaryWarning = warnIfSummaryNeedsOperatorWhy(summary);
  const ref = stripKnownFlags(args, ['--summary', '--verify', '--native-goal-status', '--native-goal-objective', '--visible-goal-status', '--visible-goal-objective'], ['--json', '--complete-on-pass', '--self-drive', '--manual-ack', '--allow-native-goal-supersede', '--supersede-paused-native-goal'])[0] || '';
  let mission = resolveMission(ref);
  if (!mission) {
    if (ref) exitMissingMission(ref, 1, asJson);
    exitMissionError('No mission found. Run: atris mission start "..."', 1, asJson);
  }

  // Same per-mission flock that `mission run` uses. Without it, a tick could
  // increment last_tick_index/receipt_path concurrently with a run loop and
  // get its mutation overwritten by the run's saveMission on the next tick.
  const lock = acquireMissionLock(mission.id);
  if (!lock.ok) {
    exitMissionError(`[mission tick] lock busy (held by pid ${lock.holder?.pid || '?'} since ${lock.holder?.started_at || '?'}). Exit.`, 3, asJson);
  }

  try {
    // Re-read inside the lock — the initial resolveMission ran before we held it.
    mission = resolveMission(mission.id) || mission;

    if (['complete', 'stopped'].includes(mission.status)) {
      const { mission: saved } = saveMission({ ...mission, next_action: 'mission is closed' }, process.cwd(), 'mission_tick_skipped', { reason: mission.status });
      printJsonOrText({ ok: true, action: 'tick_skipped', mission: saved }, [`Skipped ${mission.id}: ${mission.status}`], asJson);
      return;
    }
    if (returnIfCodexNativeGoalNotStarted(mission, asJson, nativeGoalOptions)) return;

    // Per the /mission skill design, the calling Claude session IS the per-tick LLM.
    // This CLI subcommand records the tick: writes a structured receipt (matching the
    // `mission_run_tick` envelope) and runs the verifier when asked. Always emit a
    // receipt so every tick has its own audit row, not just verifier ticks.
    const cwd = process.cwd();
    const tickStart = stampIso();
    const lastTickIndex = Number(mission.last_tick_index || 0);
    const tickIdx = lastTickIndex + 1;
    const tickWorktreeBefore = gitWorktreeSnapshot(cwd);
    const worktreeBaseline = loadMissionWorktreeBaseline(mission.id, cwd);

    const effectiveVerifier = effectiveMissionVerifier(mission);
    const verifierCommand = verify
      ? String(verifyOverride || effectiveVerifier || '').trim()
      : '';
    if (verifierCommand) assertMissionVerifier(verifierCommand, asJson);

    let verifierResult = null;
    if (verify && verifierCommand) {
      verifierResult = runVerifier(verifierCommand);
    }
    const tickWorktree = worktreeReceipt(tickWorktreeBefore, gitWorktreeSnapshot(cwd), { verifier: verifierCommand || effectiveVerifier, baseline: worktreeBaseline });

    // Same layer classification as the run-tick path; manual ticks carry their
    // receipt text in --summary.
    const layerInfo = extractLayerFromReceiptText(summary || '', tickWorktree?.new_since_baseline_sample);
    const tickRecord = {
      status: 'ran',
      reason: 'tick-recorded',
      tick_index: tickIdx,
      ran: true,
      started_at: tickStart,
      claude: { skipped: true, reason: 'orchestrator-is-caller-session' },
      summary: summary || null,
      layer: layerInfo.layer,
      layer_source: layerInfo.source,
      verifier_passed: verifierResult ? !!verifierResult.passed : null,
      finished_at: stampIso(),
      worktree: tickWorktree,
    };
    const receiptPath = writeReceipt(mission, {
      kind: 'mission_tick',
      tick: tickRecord,
      frozen: {
        verifier: verifierCommand || effectiveVerifier || '',
        lane: mission.lane || 'workspace',
        started_at: tickStart,
      },
      verifier_result: verifierResult,
      rate_limit_info: null,
      worktree: tickWorktree,
    });

	    let status = 'running';
	    let nextAction = (verifierCommand || effectiveVerifier)
	      ? `run verifier: ${verifierCommand || effectiveVerifier}`
	      : (mission.always_on && missionTaskSpine(mission)?.has_task
	        ? nextCandidateTickAction(mission)
	        : 'attach task, verifier, or proof');
	    const nextGoalChain = advanceMissionGoalChain(mission.goal_chain, summary, verifierResult);
	    if (verifierResult?.passed && nextGoalChain && !nextGoalChain.pause_ready) {
	      status = 'running';
	      nextAction = missionGoalChainNextAction(nextGoalChain);
    } else if (verifierResult?.passed) {
      const xpReadyAction = missionXpReadyAction(mission, receiptPath);
      const budgetRemainingSeconds = missionFullBudgetRemainingSeconds(mission);
      const budgetOpen = budgetRemainingSeconds > 0;
      status = (completeOnPass && !mission.always_on && !xpReadyAction && !budgetOpen) ? 'complete'
        : (budgetOpen && !mission.always_on && !xpReadyAction ? 'running' : 'ready');
      nextAction = mission.always_on ? nextCandidateTickAction(mission) :
        (xpReadyAction
          || (budgetOpen
            ? `proof passed with ${durationLabel(budgetRemainingSeconds)} left on the budget; pick the next useful move, then: atris mission tick ${mission.id} --verify --summary "<what changed>"`
            : (completeOnPass ? 'mission complete' : `review proof then run: atris mission complete ${mission.id} --proof "${receiptPath}"`)));
	    } else if (verifierResult) {
	      status = 'blocked';
	      nextAction = 'fix verifier failure or revise mission';
	    } else if (nextGoalChain?.pause_ready) {
	      status = 'ready';
	      nextAction = `mission feels good; review proof then run: atris mission complete ${mission.id} --proof "${receiptPath}"`;
	    } else if (nextGoalChain) {
	      nextAction = missionGoalChainNextAction(nextGoalChain);
	    }
	    const clearsPauseState = !['paused', 'stopped'].includes(status);
	    const nextMission = {
	      ...mission,
	      status,
      paused_at: clearsPauseState ? null : mission.paused_at || null,
      stop_reason: clearsPauseState ? null : mission.stop_reason || null,
      resumed_at: clearsPauseState && mission.status === 'paused' ? tickRecord.finished_at : mission.resumed_at || null,
      receipt_path: receiptPath,
      last_tick_at: tickRecord.finished_at,
      last_tick_status: tickRecord.status,
      last_tick_reason: tickRecord.reason,
      last_tick_index: tickIdx,
	      last_tick_layer: tickRecord.layer,
	      last_tick_layer_source: tickRecord.layer_source,
	      verifier_result: verifierResult || mission.verifier_result || null,
	      ...(nextGoalChain ? { goal_chain: nextGoalChain } : {}),
	      next_action: nextAction,
	    };
    const { mission: saved } = saveMission(nextMission, cwd, 'mission_tick', {
      tick_index: tickIdx, verify, verifier_result: verifierResult, receipt_path: receiptPath, layer: tickRecord.layer,
    });
    const blocker = selfDrive && saved.status === 'blocked'
      ? require('../lib/self-drive').handleMissionBlocker({
        mission: saved,
        stopReason: 'verifier-failed',
        workspaceRoot: cwd,
        appendEvent: (type, payload) => appendEvent(type, saved, payload, cwd),
      })
      : null;
    const logPath = appendMemberLog(saved.owner, 'Mission tick', {
      mission: saved.objective,
      state: saved.status,
      tick_index: tickIdx,
      layer: tickRecord.layer || undefined,
      verifier: verifierResult ? (verifierResult.passed ? 'passed' : 'failed') : 'not_run',
      receipt: receiptPath,
      summary: summary || undefined,
    });
    const continuationGoal = saved.status === 'complete'
      ? seedMissionRunContinuation(saved, cwd, receiptPath)
      : null;
    const outputMission = continuationGoal?.parent || saved;
    const atrisGoalState = refreshAtrisGoalController(process.cwd(), { missionId: outputMission.id });
    const codexGoalState = refreshCodexGoalController(process.cwd());
    printJsonOrText(
      { ok: true, action: 'mission_tick', mission: outputMission, tick: tickRecord, verifier_result: verifierResult, blocker, receipt_path: receiptPath, log_path: logPath, atris_goal_state: atrisGoalState, codex_goal_state: codexGoalState, continuation_goal: continuationGoal, operator_summary_warning: operatorSummaryWarning },
      [
        ...missionTickResultLines(outputMission, tickIdx, receiptPath, verifierResult, summary),
        ...(missionBlockerReceiptLine(blocker) ? [missionBlockerReceiptLine(blocker)] : []),
        ...(continuationGoal?.mission ? [`Next goal: ${continuationGoal.mission.objective}`] : []),
      ],
      asJson,
    );
  } finally {
    releaseMissionLock(lock);
  }
}

// Proof receipts are JSON files written by writeReceipt(); anything else
// (free text, command strings, missing paths) reads as null and falls back
// to durable mission state.
function readReceiptProof(proof, root = process.cwd()) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.resolve(root, String(proof || '')), 'utf8'));
    return parsed?.schema === 'atris.mission_receipt.v1' ? parsed : null;
  } catch {
    return null;
  }
}

function receiptShowsPass(receipt) {
  const result = receipt?.result;
  return result?.passed === true
    || result?.verifier_result?.passed === true
    || result?.tick?.verifier_passed === true;
}

// Terminal gate: a verifier mission may only complete on real evidence — a
// passing receipt belonging to this mission, or durable state showing the
// verifier passed. Mirrors the task plane's proof-only accept guard so the
// final transition consumes the receipts instead of trusting free text.
function missionCompletionGate(mission, proof, root = process.cwd()) {
  const remainingSeconds = missionFullBudgetRemainingSeconds(mission);
  if (remainingSeconds > 0) {
    return {
      ok: false,
      source: 'budget_contract',
      reason: `full-budget mission still has ${durationLabel(remainingSeconds)} left; keep picking the next useful move or use --force if blocked/unsafe`,
    };
  }
  const receipt = readReceiptProof(proof, root);
  if (receipt) {
    if (receipt.mission_id !== mission.id) {
      return { ok: false, source: 'receipt', reason: `proof receipt belongs to mission ${receipt.mission_id}, not ${mission.id}` };
    }
    return receiptShowsPass(receipt)
      ? { ok: true, source: 'receipt', receipt_path: String(proof) }
      : { ok: false, source: 'receipt', reason: 'proof receipt does not show a passing verifier' };
  }
  if (mission.verifier_result?.passed === true) return { ok: true, source: 'mission_state' };
  if (!effectiveMissionVerifier(mission)) return { ok: true, source: 'no_verifier' };
  return { ok: false, source: 'mission_state', reason: 'verifier has not passed for this mission and proof is not a passing receipt' };
}

function completeMission(args) {
  const asJson = wantsJson(args);
  const force = hasFlag(args, '--force');
  const proof = readFlag(args, '--proof', '');
  const ref = stripKnownFlags(args, ['--proof'], ['--json', '--force'])[0] || '';
  const root = process.cwd();
  if (!ref || !proof) {
    exitMissionError('Usage: atris mission complete <id> --proof "..."', 1, asJson);
  }
  const mission = resolveMission(ref);
  if (!mission) {
    exitMissingMission(ref, 1, asJson);
  }
  const gate = missionCompletionGate(mission, proof, root);
  if (!gate.ok && !force) {
    exitMissionError(`[mission complete] ${gate.reason}. Run: atris mission tick ${mission.id} --verify (or override as operator with --force)`, 2, asJson);
  }
  const baselineSummary = pruneMissionWorktreeBaseline(mission, root);
  const completionGate = { ...gate, forced: force && !gate.ok };
  const baseNext = {
    ...mission,
    status: 'complete',
    completed_at: stampIso(),
    proof,
    completion_gate: completionGate,
    worktree_baseline: baselineSummary || mission.worktree_baseline || null,
    next_action: 'mission complete',
  };
  const xpNextCommand = missionXpReadyAction(baseNext, proof);
  const completion = missionCompletionReceipt(baseNext, proof, xpNextCommand);
  const artifactPreview = missionArtifactPaths(baseNext, root);
  completion.landing.artifact = `Open timeline at ${artifactPreview.relativeIndexHtml}.`;
  completion.result.artifact = artifactPreview.relativeIndexHtml;
  const next = {
    ...baseNext,
    landing: completion.landing,
    result: completion.result,
  };
  const { mission: saved } = saveMission(next, root, 'mission_completed', { proof, completion_gate: next.completion_gate });
  const continuationGoal = seedMissionRunContinuation(saved, root, proof);
  const outputMission = continuationGoal?.parent || saved;
  const artifact = writeMissionArtifact(outputMission, {
    root,
    proof,
    completion,
    xpNextCommand,
    continuationGoal,
  });
  const logPath = appendMemberLog(outputMission.owner, 'Mission completed', {
    mission: outputMission.objective,
    proof,
    artifact: artifact.index_html,
  }, root);
  const atrisGoalState = refreshAtrisGoalController(root, { missionId: continuationGoal?.mission?.id || outputMission.id });
  const codexGoalState = refreshCodexGoalController(root);
  printJsonOrText(
    {
      ok: true,
      action: 'mission_completed',
      mission: outputMission,
      landing: completion.landing,
      result: completion.result,
      artifact,
      log_path: logPath,
      atris_goal_state: atrisGoalState,
      codex_goal_state: codexGoalState,
      xp_next_command: xpNextCommand,
      continuation_goal: continuationGoal,
    },
    [
      ...missionResultLines(completion),
      ...(continuationGoal?.mission ? [`Next goal: ${continuationGoal.mission.objective}`] : []),
    ],
    asJson,
  );
}

function stopMission(args) {
  const asJson = wantsJson(args);
  const reason = readFlag(args, '--reason', 'stopped by operator');
  const pause = hasFlag(args, '--pause');
  const ref = stripKnownFlags(args, ['--reason'], ['--json', '--pause'])[0] || '';
  if (!ref) {
    exitMissionError('Usage: atris mission stop <id> [--pause] [--reason "..."]', 1, asJson);
  }
  const mission = resolveMission(ref);
  if (!mission) {
    exitMissingMission(ref, 1, asJson);
  }
  const status = pause ? 'paused' : 'stopped';
  // Full stops abandon work, so leave evidence: snapshot the worktree against
  // the mission baseline (what did this mission leave dirty?) before pruning it.
  let receiptPath = null;
  if (!pause) {
    const snapshot = gitWorktreeSnapshot(process.cwd());
    const worktree = worktreeReceipt(snapshot, snapshot, {
      verifier: mission.verifier,
      baseline: loadMissionWorktreeBaseline(mission.id, process.cwd()),
    });
    receiptPath = writeReceipt(mission, { kind: 'mission_stop', reason, worktree });
  }
  const baselineSummary = pause ? null : pruneMissionWorktreeBaseline(mission, process.cwd());
  const next = {
    ...mission,
    status,
    stopped_at: status === 'stopped' ? stampIso() : mission.stopped_at || null,
    paused_at: status === 'paused' ? stampIso() : mission.paused_at || null,
    stop_reason: reason,
    receipt_path: receiptPath || mission.receipt_path || null,
    worktree_baseline: baselineSummary || mission.worktree_baseline || null,
    next_action: status === 'paused' ? `resume with: atris mission tick ${mission.id}` : 'mission stopped',
  };
  const { mission: saved } = saveMission(next, process.cwd(), pause ? 'mission_paused' : 'mission_stopped', { reason, receipt_path: receiptPath });
  const directGoalRequestCleared = pause ? false : clearDirectRunCodexGoalRequestForMission(saved.id, process.cwd());
  const logPath = appendMemberLog(saved.owner, pause ? 'Mission paused' : 'Mission stopped', { mission: saved.objective, reason });
  printJsonOrText(
    { ok: true, action: pause ? 'mission_paused' : 'mission_stopped', mission: saved, receipt_path: receiptPath, log_path: logPath, direct_goal_request_cleared: directGoalRequestCleared },
    [
      `${pause ? 'Paused' : 'Stopped'} mission: ${saved.objective}`,
      `Reason: ${reason}`,
      ...(receiptPath ? [`Receipt: ${receiptPath}`] : []),
    ],
    asJson,
  );
}

// A mission parked in paused/planning/ready and untouched for a week is
// abandoned in practice — nobody resumes it, and each one is a line the
// operator re-reads forever. The daily autoland tick expires them to
// stopped with a revive hint; running missions and anything touched
// recently are never aged out, and a tick on an expired id revives it.
const MISSION_IDLE_EXPIRY_DAYS = 7;
const EXPIRABLE_STATUSES = new Set(['paused', 'planning', 'ready']);

function missionHeldForHumanBlockingPause(mission, status) {
  if (status !== 'paused') return null;
  const reason = humanBlockingPauseReason(mission.stop_reason || mission.pause_reason);
  if (!reason) return null;
  return {
    id: mission.id,
    owner: mission.owner,
    previous_status: status,
    objective: String(mission.objective || '').slice(0, 120),
    reason,
    cause: humanBlockingPauseCause(reason),
    resume_command: missionPauseResumeCommand(mission.id),
  };
}

function attachHeldMissions(expired, held) {
  Object.defineProperty(expired, 'held', {
    value: held,
    enumerable: false,
    configurable: true,
  });
  return expired;
}

function expireStaleMissions(root = process.cwd(), { idleDays = MISSION_IDLE_EXPIRY_DAYS, idleHours = null, dryRun = false, statuses = EXPIRABLE_STATUSES } = {}) {
  const windowMs = idleHours != null ? idleHours * 60 * 60 * 1000 : idleDays * 24 * 60 * 60 * 1000;
  const windowLabel = idleHours != null
    ? `${idleHours}+ idle hour${idleHours === 1 ? '' : 's'}`
    : `${idleDays}+ idle day${idleDays === 1 ? '' : 's'}`;
  const cutoff = Date.now() - windowMs;
  const expired = [];
  const held = [];
  for (const mission of listMissions(root)) {
    const status = String(mission.status || '').toLowerCase();
    if (!statuses.has(status)) continue;
    // updated_at and paused_at are machine-polluted — status renders and
    // goal controllers re-save parked missions daily, so a mission nobody
    // has run since May reads as "touched today". Real activity is the
    // last tick (or creation, for missions that never ran).
    const touched = Math.max(
      Date.parse(mission.last_tick_at || '') || 0,
      Date.parse(mission.created_at || '') || 0,
    );
    if (!touched || touched > cutoff) continue;
    const heldMission = missionHeldForHumanBlockingPause(mission, status);
    if (heldMission) {
      held.push(heldMission);
      continue;
    }
    const reason = `expired after ${windowLabel} (was ${status}); revive with: atris mission tick ${mission.id}`;
    if (!dryRun) {
      const next = {
        ...mission,
        status: 'stopped',
        stopped_at: stampIso(),
        stop_reason: reason,
      };
      const { mission: saved } = saveMission(next, root, 'mission_expired', { reason, previous_status: status, idle_days: idleDays, idle_hours: idleHours });
      appendMemberLog(saved.owner, 'Mission expired', { mission: saved.objective, reason }, root);
    }
    expired.push({
      id: mission.id,
      owner: mission.owner,
      previous_status: status,
      objective: String(mission.objective || '').slice(0, 120),
      reason: String(mission.stop_reason || '').trim() || `${status}-idle`,
    });
  }
  return attachHeldMissions(expired, held);
}

// Zombie-mission reap: a mission left paused past a short leash (48h default)
// is dead in practice long before the 7-day general idle expiry ever fires —
// nobody is coming back to it inside a session, and it just sits on
// `mission list` as noise. Narrower than expireStaleMissions on purpose: only
// `paused`, never planning/ready, so the weekly cadence for those is unchanged.
const MISSION_PAUSED_REAP_HOURS = 48;

function reapPausedMissions(root = process.cwd(), { hours = MISSION_PAUSED_REAP_HOURS, dryRun = false } = {}) {
  return expireStaleMissions(root, { idleHours: hours, dryRun, statuses: new Set(['paused']) });
}

function missionGoalHelp() {
  console.log('Usage: atris mission goal [--runtime codex|atris] [--heartbeat] [--native-goal-status active|paused|usageLimited] [--native-goal-objective "..."] [--manual-ack] [--allow-native-goal-supersede] [--json]');
  console.log('Refresh the visible native goal from active mission state. Help is read-only.');
}

function missionGoalLoopHelp() {
  console.log('Usage: atris mission goal-loop [--max-wall 28800] [--max-iterations 32] [--no-claude] [--dry-run] [--once] [--json]');
  console.log('Run the bounded native-goal controller. Help is read-only and never starts due work.');
}

function goalMission(args) {
  if (args.some((arg) => arg === 'help' || arg === '--help' || arg === '-h')) {
    return missionGoalHelp();
  }
  const asJson = wantsJson(args);
  if (args[0] === 'ack') {
    return ackMissionGoal(args.slice(1));
  }
  const runtime = String(readFlag(args, '--runtime', 'codex') || 'codex').trim().toLowerCase();
  if (runtime === 'atris' || runtime === 'atris2' || runtime === 'ax') {
    const heartbeatMode = hasFlag(args, '--heartbeat');
    const payload = refreshAtrisGoalController(process.cwd(), { heartbeat: heartbeatMode });
    if (!payload.goal) {
      printJsonOrText(payload, ['No active mission found for Atris goal.'], asJson);
      return;
    }
    printJsonOrText(
      payload,
      [
        `Atris goal: ${payload.goal.objective}`,
        `Runner: ${payload.goal.runner}`,
        `Next: ${payload.goal.next_command}`,
        payload.goal.replace_after,
      ],
      asJson,
    );
    return;
  }
  const heartbeatMode = hasFlag(args, '--heartbeat');
  const payload = refreshCodexGoalController(process.cwd(), {
    heartbeat: heartbeatMode,
    ...codexNativeGoalOptionsFromArgs(args),
  });
  if (payload.active_goal_conflict) {
    printJsonOrText(
      payload,
      [
        payload.active_goal_conflict.message,
        `Next: ${payload.active_goal_conflict.next_command}`,
      ],
      asJson,
    );
    return;
  }
  if (!payload.goal) {
    printJsonOrText(
      payload,
      ['No active mission found for Codex /goal.'],
      asJson,
    );
    return;
  }

  printJsonOrText(
    payload,
    [
      `Codex /goal: ${payload.goal.objective}`,
      `Reason: ${payload.goal.reason}`,
      `Next: ${payload.goal.next_command}`,
      payload.goal.replace_after,
    ],
    asJson,
  );
}

function ackMissionGoal(args) {
  const asJson = wantsJson(args);
  const ref = stripKnownFlags(args, ['--runtime', '--status', '--objective'], ['--json', '--manual-ack'])[0] || '';
  if (!ref) {
    exitMissionError('Usage: atris mission goal ack <mission-id> --runtime codex --status active --objective "<objective>" --json', 1, asJson);
  }
  const runtime = String(readFlag(args, '--runtime', 'codex') || 'codex').trim().toLowerCase();
  const status = String(readFlag(args, '--status', 'active') || 'active').trim().toLowerCase();
  let mission = resolveMission(ref);
  if (!mission) {
    exitMissingMission(ref, 1, asJson);
  }
  if (runtime !== 'codex') {
    const payload = {
      ok: true,
      action: 'native_goal_ack_skipped',
      mission: missionStatusView(mission),
      runtime,
      status,
      reason: 'runtime_not_codex',
      requires_native_goal_start: false,
      next_command: codexGoalNextCommand(mission),
    };
    printJsonOrText(
      payload,
      [
        `Native goal ack skipped for runtime=${runtime}.`,
        `Next: ${payload.next_command}`,
      ],
      asJson,
    );
    return;
  }
  if (status !== 'active') {
    exitMissionError('Native goal ack requires --runtime codex --status active.', 2, asJson);
  }

  const lock = acquireMissionLock(mission.id, process.cwd(), { waitMs: 2000 });
  if (!lock.ok) {
    exitMissionError(`[mission goal ack] lock busy (held by pid ${lock.holder?.pid || '?'} since ${lock.holder?.started_at || '?'}). Exit.`, 3, asJson);
  }

  try {
    mission = resolveMission(mission.id) || mission;
    if (!isCodexGoalMission(mission)) {
      releaseMissionLock(lock);
      exitMissionError(`Mission "${ref}" uses runner=${mission.runner || 'manual'}; native Codex goal ack is only for runner=codex_goal.`, 2, asJson);
    }
    const canonicalObjective = codexGoalObjective(mission);
    const reportedObjective = readFlag(args, '--objective', canonicalObjective);
    const { saved, ack, supersededNativeGoalAcks } = recordCodexNativeGoalAck(mission, process.cwd(), { reportedObjective });
    const payload = refreshCodexGoalController(process.cwd());
    printJsonOrText(
      {
        ok: true,
        action: 'native_goal_acknowledged',
        mission: saved,
        native_goal_ack: ack,
        superseded_native_goal_acks: supersededNativeGoalAcks,
        codex_goal_state: payload,
        next_command: payload.goal?.next_command || `atris mission tick ${saved.id} --summary "<what changed>"`,
      },
      [
        `Native goal active: ${saved.objective}`,
        `Next: ${payload.goal?.next_command || saved.next_action}`,
      ],
      asJson,
    );
  } finally {
    releaseMissionLock(lock);
  }
}

async function goalLoopMission(args) {
  if (args.some((arg) => arg === 'help' || arg === '--help' || arg === '-h')) {
    return missionGoalLoopHelp();
  }
  const asJson = wantsJson(args);
  const noClaude = hasFlag(args, '--no-claude');
  const dryRun = hasFlag(args, '--dry-run');
  const once = hasFlag(args, '--once');
  const maxIterations = once ? 1 : Math.max(1, Number(readFlag(args, '--max-iterations', '')) || 32);
  const maxWallSeconds = Math.max(1, Number(readFlag(args, '--max-wall', '')) || 8 * 60 * 60);
  const root = process.cwd();
  const startedAt = Date.now();
  const events = [];

  for (let index = 0; index < maxIterations; index += 1) {
    const heartbeat = refreshCodexGoalController(root, { heartbeat: true });
    const event = {
      iteration: index + 1,
      heartbeat,
      ran_heavy_work: false,
      ran_setup_work: false,
      dry_run: dryRun,
    };

    const commandPlan = goalLoopNextCommandPlan(heartbeat.goal);
    if (shouldRunGoalLoopCommand(heartbeat, commandPlan)) {
      if (dryRun) {
        event.ran_heavy_work = false;
        event.ran_setup_work = false;
        event.run = {
          skipped: true,
          reason: 'dry-run',
          action: commandPlan?.action || 'mission_run_due',
          command: commandPlan?.command || 'atris mission run --due --max-ticks 1 --complete-on-pass --json',
          heavy_work: commandPlan?.heavy_work === true,
          setup_work: commandPlan?.setup_work === true,
        };
      } else {
        event.run = runMissionGoalNextCommand(root, heartbeat, { noClaude });
        event.ran_heavy_work = event.run.ok === true && event.run.heavy_work === true;
        event.ran_setup_work = event.run.ok === true && event.run.setup_work === true;
        event.after_run = refreshCodexGoalController(root, { heartbeat: true });
      }
    }
    events.push(event);

    if (index + 1 >= maxIterations) break;
    const elapsedSeconds = (Date.now() - startedAt) / 1000;
    const remainingSeconds = maxWallSeconds - elapsedSeconds;
    if (remainingSeconds <= 0) break;

    const sleepSeconds = Math.min(
      Number(event.after_run?.heartbeat?.recommended_sleep_seconds ?? event.heartbeat?.heartbeat?.recommended_sleep_seconds ?? 15) || 15,
      remainingSeconds,
    );
    if (sleepSeconds <= 0) continue;
    await sleep(sleepSeconds * 1000);
  }

  const finalState = refreshCodexGoalController(root, { heartbeat: true });
  const payload = {
    ok: true,
    action: 'codex_goal_loop',
    iterations: events.length,
    max_iterations: maxIterations,
    max_wall_seconds: maxWallSeconds,
    heavy_runs: events.filter((event) => event.ran_heavy_work).length,
    setup_runs: events.filter((event) => event.ran_setup_work).length,
    events,
    final_state: finalState,
  };
  printJsonOrText(
    payload,
    [
      `Codex goal loop iterations: ${payload.iterations}`,
      `Heavy runs: ${payload.heavy_runs}`,
      `Final action: ${finalState.action}`,
      finalState.goal ? `Final mission: ${finalState.goal.mission_id}` : 'Final mission: none',
    ],
    asJson,
  );
}

function help() {
  console.log(`
atris mission - durable goal + loop + owner + proof state

  atris mission start "<objective>" --owner <member> [--verify "..."] [--always-on] [--budget quick|long|deep] [--xp-task] [--worktree] [--take-goal-slot]
                      [--runner manual|claude|atris2|codex_goal] [--model <id>]
                      (runner claude spawns local claude -p per tick, --model passes through;
                       runner atris2 runs each tick as one /atris2/turn on the AtrisOS backend,
                       default model atris:fast; runner codex_goal publishes the goal for a live
                       Codex session to pull via atris mission goal)
  atris mission status [id] [--status <state>] [--limit <n>] [--local] [--json]
  atris mission status --cloud <task_id> [--watch]
  atris mission inspect <id> --fields status,runner,ack,pings [--json]
                       Field-selectable mission state (status, runner, native goal ack, ping counts)
  atris mission doctor [--local] [--json]   Flag no-verifier missions, help missions, stale ready receipts, and blocked always-on loops
  atris mission attach-task <id> [--json]   Create the missing task spine for an existing active mission
  atris mission report [id] [--limit <n>] [--local] [--json]   Plain outcome, worker receipt, verifier receipt, and next move
  atris mission timeline [id] [--limit <n>] [--all] [--prune-preview] [--write] [--json]   Saved landing Changed/Next lines from mission receipts
  atris mission watch [id] [--interval <s>] [--idle-every <s>]   Live heartbeat: prints a line per tick as it lands
  atris mission layers [--mission <id-substr>] [--since <date>] [--json]   Per-layer growth curve across tick receipts
                       (rolls up sibling git-worktree missions; --local scopes to this checkout)
  atris mission room "<messy input>" [--owner <member>] [--room-auto-run] [--json]   Create a Mission Room card and shareable receipt from messy intent
  atris mission prune-runs [--apply] [--days <n>] [--keep-newest <n>] [--json]   Compress old run receipts into a manifest and prune unreferenced clutter
  atris mission goal [--runtime codex|atris] [--heartbeat] [--native-goal-status active|paused|usageLimited] [--native-goal-objective "..."] [--manual-ack] [--allow-native-goal-supersede] [--json]
  atris mission goal ack <id> --runtime codex --status active --objective "<objective>" --json
  atris mission goal-loop [--max-wall 28800] [--max-iterations 32] [--no-claude] [--json]
  atris mission tick <id> [--verify ["cmd"]] [--complete-on-pass] [--self-drive] [--summary "..."]
                       [--native-goal-status active|paused|usageLimited] [--native-goal-objective "..."] [--json]
  atris mission set-runner <id> <runner|engine> [--model <id>] [--json]
  atris mission "<objective>" [--owner <member>]   Shortcut for: atris mission run "<objective>"
  atris mission run --fleet [--slots 3] [--dry-run] [--json]   Staff every idle capable engine on claimable safe-lane tasks: parallel worktree builds, serial rebase-before-ship landings, receipt in atris/runs/
  atris mission run "<objective>" --cloud [--lane fast|pro|max] [--agent <id>]   Enqueue on the Atris backend instead of running local ticks
  atris mission run ["objective"|<member> ["objective"]|id|--due] [--owner <member>] [--budget quick|long|deep] [--max-ticks 4] [--max-wall 3600] [--cadence "15m"] [--land --repo <path> --verify "git diff --check"]
                                [--native-goal-status active|paused|usageLimited] [--native-goal-objective "..."] [--manual-ack] [--allow-native-goal-supersede] [--take-goal-slot]
                                [--engine <name>]
                                [--spend-full-budget|--use-whole-budget|--stop-when-done] [--preflight|--no-preflight|--room-preflight|--no-room-preflight]
                                [--room-auto-run|--no-room-auto-run]
                                [--headless] [--self-drive] [--no-claude] [--no-verify] [--complete-on-pass] [--no-drain] [--create-next] [--json]
                       (bare/member-only run prompts; one-word fuzzy intent starts a new visible-goal mission; --due runs the saved queue; --headless skips caller-session runners)
                       (short time like "20 minutes" means finish early; long/sleep time like "5 hours" keeps using the budget; --stop-when-done overrides)
                       (--budget quick|long|deep sets max ticks/wall to 4/15m, 12/60m, or 30/180m; explicit --max-ticks wins)
                       (messy, shower, and overnight requests preflight through Mission Room before the visible goal is written)
                       (--room-auto-run makes trusted self-improvement asks preview through Mission Room, select real work, then start one bounded goal)
                       (mission-run completions seed the next visible goal: decide and start the next useful mission)
  atris mission complete <id> --proof "..."
  atris mission stop <id> [--pause] [--reason "..."]

Autonomy recipe:
  1. Pick an owner member: atris member create <member>  (if missing)
  2. Start a current-agent mission with a verifier:
     atris mission start "ship one proof" --owner <member> --runner codex_goal --lane code --verify "npm test" --stop "verifier passes" --xp-task
  3. Codex sessions: read native get_goal, then pass its status into atris mission goal --native-goal-status <status> --native-goal-objective "<objective>" --json
     Overnight controller: atris mission goal --heartbeat --json
     Bounded overnight runner: atris mission goal-loop --max-wall 28800 --no-claude --json
  4. Do one bounded step, then record it:
     atris mission tick <id> --verify --summary "what changed"
  5. Close or continue from the receipt:
     atris task current-step --goal-id <mission_id> --as <owner> --proof "<receipt_path>" --json  (if --xp-task)
     atris task accept <xp_task_ref> --reward <n>             (human accept mints AgentXP)
     atris mission complete <id> --proof "<receipt_path>"
     repeat status -> step -> tick for current-agent work
     atris mission run <id> --max-ticks 4 --complete-on-pass  (Claude/always-on runner)
     atris mission run --due --max-ticks 1 --complete-on-pass  (/loop heartbeat)
  Headless: start with --runner claude --cadence "15m" --always-on, then run.

Backend/web agents:
  In atrisos-backend and atrisos-web, check active missions before choosing work.
  If no active mission exists and autonomy was requested, create one with owner,
  verifier, lane, and stop condition before starting the loop.

Filters:
  --status active shows planning/running/ready/paused/blocked missions.
  --status complete|stopped|planning|running|ready|paused|blocked shows that exact state.

State:
  .atris/state/missions.jsonl
  .atris/state/mission_events.jsonl
  .atris/state/codex_goal.json
  atris/status/codex-goal.md
  atris/team/<owner>/MISSION.md
  atris/team/<owner>/now.md
  atris/status/now.md
`.trim());
}

// Extract layer classification from receipt text.
// Priority: layer tag on the last non-empty line (source: explicit) >
// last strictly-matching layer line anywhere in the text (source: explicit-inline) >
// changed-path classification (source: fallback). The single-token regex keeps the
// enum docs line ("layer: identity|beliefs|...") from ever matching.
function extractLayerFromReceiptText(text, fallbackPaths = []) {
  const text_str = String(text || '').trim();

  if (text_str) {
    // Matches a standalone "layer: x" line, or a one-line summary ending in
    // "...; layer: x". Quoted bullets ("- layer: x") and the enum-doc line stay inert.
    const layerPattern = /^(?:.*;\s*)?layer:\s*(identity|beliefs|capabilities|behaviors|environment)\s*$/i;
    const lines = text_str.split(/\r?\n/).reverse();
    let isLastNonEmpty = true;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const match = trimmed.match(layerPattern);
      if (match) {
        return { layer: match[1].toLowerCase(), source: isLastNonEmpty ? 'explicit' : 'explicit-inline' };
      }
      isLastNonEmpty = false;
    }
  }

  // Fallback to path classification
  if (Array.isArray(fallbackPaths) && fallbackPaths.length > 0) {
    const classified = classifyPathsByLayer(fallbackPaths);
    if (classified && classified.layer) {
      return { layer: classified.layer, source: classified.source };
    }
  }

  return { layer: null, source: 'unknown' };
}

// Classify paths into layers. Returns { layer: string, source: string, confidence: number }
// Rules: atris/team/ => identity, atris/lessons.md|atris/wiki/ => beliefs,
// test/|skills/ => capabilities, commands/|bin/ => behaviors, else environment
function classifyPathsByLayer(paths) {
  if (!Array.isArray(paths) || paths.length === 0) {
    return { layer: null, source: 'unknown' };
  }

  const counts = {
    identity: 0,
    beliefs: 0,
    capabilities: 0,
    behaviors: 0,
    environment: 0,
  };

  for (const pathStr of paths) {
    const p = String(pathStr || '');
    if (p.includes('atris/team/')) {
      counts.identity++;
    } else if (p.includes('atris/lessons.md') || p.includes('atris/wiki/')) {
      counts.beliefs++;
    } else if (p.includes('test/') || p.includes('skills/')) {
      counts.capabilities++;
    } else if (p.includes('commands/') || p.includes('bin/')) {
      counts.behaviors++;
    } else {
      counts.environment++;
    }
  }

  // Find max with tie-break: identity > beliefs > capabilities > behaviors > environment
  const tieBreakOrder = ['identity', 'beliefs', 'capabilities', 'behaviors', 'environment'];
  let maxCount = 0;
  let winnerLayer = null;
  for (const layer of tieBreakOrder) {
    if (counts[layer] > maxCount) {
      maxCount = counts[layer];
      winnerLayer = layer;
    }
  }

  return winnerLayer ? { layer: winnerLayer, source: 'fallback' } : { layer: null, source: 'unknown' };
}

// `atris mission layers` — per-layer growth curve across tick receipts. The member
// proof standard says: if every tick is one layer and none touch the others, the
// loop is doing work but not getting smarter. This makes that check one command.
function layersMission(args) {
  if (hasFlag(args, '--help') || hasFlag(args, '-h') || String(args[0] || '').trim() === 'help') {
    console.log('Usage: atris mission layers [--mission <id-substr>] [--since <date>] [--json]');
    console.log('Show the per-layer growth curve across saved tick receipts.');
    return;
  }
  const asJson = args.includes('--json');
  const missionFilter = readFlag(args, '--mission', '');
  const sinceRaw = readFlag(args, '--since', '');
  // --since accepts a date (2026-06-13) or full ISO; filters on the receipt's `at`
  // stamp so the curve can be read over a window (e.g. "what did today's ticks touch?").
  const sinceMs = sinceRaw ? Date.parse(sinceRaw) : null;
  if (sinceRaw && Number.isNaN(sinceMs)) {
    exitMissionError(`--since "${sinceRaw}" is not a parseable date (try 2026-06-13 or an ISO timestamp).`, 1, asJson);
  }
  const paths = statePaths(process.cwd());
  const LAYERS = ['identity', 'beliefs', 'capabilities', 'behaviors', 'environment'];
  const byLayer = Object.fromEntries(LAYERS.map((l) => [l, 0]));
  const bySource = { explicit: 0, 'explicit-inline': 0, fallback: 0, unknown: 0 };
  let total = 0;
  let untagged = 0;
  let files = [];
  try {
    files = fs.readdirSync(paths.runsDir).filter((f) => f.startsWith('mission-') && f.endsWith('.json'));
  } catch {
    files = [];
  }
  for (const file of files) {
    if (missionFilter && !file.includes(missionFilter)) continue;
    let receipt;
    try {
      receipt = JSON.parse(fs.readFileSync(path.join(paths.runsDir, file), 'utf8'));
    } catch {
      continue;
    }
    if (sinceMs != null) {
      const atMs = Date.parse(receipt && receipt.at);
      if (Number.isNaN(atMs) || atMs < sinceMs) continue;
    }
    const tick = receipt?.result?.tick;
    if (!tick) continue; // summaries, stop receipts, legacy shapes
    total++;
    const layer = String(tick.layer || '').toLowerCase();
    const source = String(tick.layer_source || 'unknown');
    if (LAYERS.includes(layer)) {
      byLayer[layer]++;
      bySource[source in bySource ? source : 'unknown']++;
    } else {
      untagged++;
    }
  }
  const tagged = total - untagged;
  const dominant = LAYERS.reduce((a, b) => (byLayer[b] > byLayer[a] ? b : a), LAYERS[0]);
  const skewed = tagged >= 5 && byLayer[dominant] / tagged >= 0.8;
  const scopeBits = [
    missionFilter ? `mission filter: ${missionFilter}` : null,
    sinceRaw ? `since: ${sinceRaw}` : null,
  ].filter(Boolean);
  const lines = [
    `Layer growth curve${scopeBits.length ? ` (${scopeBits.join(', ')})` : ''}: ${tagged} tagged / ${total} tick receipts`,
    ...LAYERS.map((l) => `  ${l.padEnd(12)} ${String(byLayer[l]).padStart(3)}${byLayer[l] ? ' ' + '█'.repeat(Math.min(byLayer[l], 40)) : ''}`),
    ...(untagged ? [`  untagged     ${String(untagged).padStart(3)} (pre-layer receipts or missing tag)`] : []),
    `  provenance: explicit ${bySource.explicit}, explicit-inline ${bySource['explicit-inline']}, fallback ${bySource.fallback}`,
    ...(skewed ? [`  rebalance: ${Math.round((byLayer[dominant] / tagged) * 100)}% of tagged ticks are "${dominant}" — the proof standard wants the other layers moving too`] : []),
  ];
  printJsonOrText({ ok: true, since: sinceRaw || null, total, tagged, untagged, by_layer: byLayer, by_source: bySource, dominant: tagged ? dominant : null, skewed }, lines, asJson);
}

function roomMission(args) {
  const asJson = wantsJson(args);
  const explicitOwner = readFlag(args, '--owner', '');
  const input = stripKnownFlags(args, ['--owner'], ['--json', '--room-auto-run', '--no-room-auto-run']).join(' ').trim();
  if (!input) {
    exitMissionError('Usage: atris mission room "<messy input>" [--owner <member>] [--room-auto-run] [--json]', 1, asJson);
  }
  const requestedOwner = explicitOwner || process.env.ATRIS_AGENT_ID || '';
  const ownerResolution = resolveFunctionalOwner({
    requestedOwner,
    title: input,
    note: input,
    root: process.cwd(),
    fallbackOwners: ['mission-lead', 'task-planner', 'architect', 'validator'],
  });
  const owner = ownerResolution.owner || requestedOwner || 'mission-lead';

  let room;
  try {
    room = buildMissionRoom(input, {
      owner,
      root: process.cwd(),
      ownerResolution,
      trustedRun: hasFlag(args, '--room-auto-run') && !hasFlag(args, '--no-room-auto-run'),
      verifier: DEFAULT_LONG_RUN_VERIFIER,
    });
  } catch (error) {
    exitMissionError(error.message || String(error), 1, asJson);
  }
  const { receipt, relativePath, room: persistedRoom } = writeMissionRoomReceipt(room, { root: process.cwd() });
  const payload = {
    ok: true,
    action: 'mission_room_created',
    room: persistedRoom,
    receipt_path: relativePath,
    receipt,
  };
  printJsonOrText(payload, missionRoomLines(persistedRoom, relativePath), asJson);
}

function pruneRunsMission(args) {
  if (hasFlag(args, '--help') || hasFlag(args, '-h') || String(args[0] || '').trim() === 'help') {
    console.log('Usage: atris mission prune-runs [--apply] [--days <n>] [--keep-newest <n>] [--json]');
    console.log('Preview old unreferenced run receipts; add --apply only after review.');
    return;
  }
  const asJson = wantsJson(args);
  let keepNewest;
  let keepDays;
  try {
    keepNewest = readNonNegativeIntegerFlag(args, '--keep-newest', 200);
    keepDays = readNonNegativeIntegerFlag(args, '--days', 14);
  } catch (error) {
    exitMissionError(error.message || String(error), 1, asJson);
  }
  const result = pruneRuns(process.cwd(), {
    apply: hasFlag(args, '--apply'),
    archive: !hasFlag(args, '--no-archive'),
    keepNewest,
    keepDays,
  });
  printJsonOrText(
    { ok: !result.errors.length, ...result },
    runsPruneLines(result),
    asJson,
  );
  if (result.errors.length) process.exitCode = 1;
}

// Locate a mission whose state may live in a sibling worktree (--worktree
// missions keep their jsonl there). Returns the mission plus the root whose
// state file owns it, so writes land where the runner reads.
function findMissionAcrossWorktrees(ref, root = process.cwd()) {
  const local = resolveMission(ref, root);
  if (local) return { mission: local, root };
  for (const rolled of listWorktreeRollupMissions(root)) {
    if (rolled.id === ref || rolled.id.startsWith(ref) || rolled.slug === ref) {
      const { worktree_root, worktree_branch, ...mission } = rolled;
      return { mission, root: worktree_root };
    }
  }
  return null;
}

// atris mission ping <id> "<message>" — leave a note the mission's next tick
// reads (and consumes) as operator direction. This is how you talk to an
// always-on member mid-run without stopping it.
function inspectMission(args) {
  const asJson = wantsJson(args);
  const parsed = readFieldsFlag(args, '--fields');
  if (!parsed || parsed.error) {
    exitMissionError(
      parsed?.error || 'Usage: atris mission inspect <id> --fields status,runner,ack,pings [--json]',
      2,
      asJson,
    );
  }
  const fieldError = validateFields(parsed.fields, MISSION_INSPECT_FIELDS, 'mission');
  if (fieldError) exitMissionError(fieldError, 2, asJson);
  const ref = stripInspectArgs(args)[0] || '';
  if (!ref) {
    exitMissionError('Usage: atris mission inspect <id> --fields status,runner,ack,pings [--json]', 2, asJson);
  }
  const found = findMissionAcrossWorktrees(ref);
  if (!found) exitMissingMission(ref, 1, asJson);
  const { mission } = found;
  const values = missionInspectFieldValues(mission, parsed.fields);
  const payload = buildInspectPayload({
    action: 'mission_inspect',
    idKey: 'mission_id',
    idValue: mission.id,
    fields: parsed.fields,
    values,
  });
  const humanValues = parsed.fields.includes('status')
    ? { ...values, status: missionHumanStatusText(mission) }
    : values;
  printJsonOrText(payload, inspectTextLines(parsed.fields, humanValues), asJson);
}

// always-on member mid-run without stopping it. opts.silent skips console
// output so callers (member ping) can compose their own multi-lane report.
function pingMission(args, opts = {}) {
  const asJson = args.includes('--json');
  const rest = args.filter((a) => a !== '--json');
  let from = process.env.USER || 'operator';
  const fromIdx = rest.indexOf('--from');
  if (fromIdx !== -1) {
    from = rest[fromIdx + 1] || from;
    rest.splice(fromIdx, 2);
  }
  const [ref, ...textParts] = rest;
  const text = textParts.join(' ').trim();
  if (!ref || !text) {
    console.error('usage: atris mission ping <id> "<message>" [--from <name>]');
    process.exit(2);
  }
  const found = findMissionAcrossWorktrees(ref);
  if (!found) {
    exitMissingMission(ref, 1, asJson);
  }
  const { mission, root } = found;
  if (TERMINAL_STATUSES.has(mission.status)) {
    console.error(`Mission ${mission.id} is ${mission.status}; pings only reach live missions.`);
    process.exit(1);
  }
  const ping = { at: stampIso(), from, text };
  const saved = saveMission(
    { ...mission, pings: [...(Array.isArray(mission.pings) ? mission.pings : []), ping] },
    root,
    'mission_ping',
    { from, text: text.slice(0, 200) },
  ).mission;
  const pending = (saved.pings || []).filter((p) => p && !p.consumed_at).length;
  if (!opts.silent) {
    if (asJson) {
      console.log(JSON.stringify({ ok: true, action: 'mission_ping', mission_id: saved.id, pending_pings: pending, ping }));
    } else {
      console.log(`pinged ${saved.id} — the next tick reads it (${pending} unread).`);
    }
  }
  return saved;
}

function missionCommand(args) {
  const subcommand = args[0] || 'status';
  const rest = args.slice(1);
  switch (subcommand) {
    case 'start':
    case 'create':
    case 'new':
      return startMission(rest);
    case 'status':
    case 'list':
    case 'ls':
    case 'show':
    case 'info':
    case 'view':
      if (hasFlag(rest, '--cloud')) {
        return statusCloudMissionCommand(rest).then((result) => {
          process.exitCode = result.exitCode;
          return result;
        });
      }
      return statusMission(rest);
    case 'doctor':
    case 'check':
      return doctorMission(rest);
    case 'attach-task':
    case 'ensure-task':
    case 'task-spine':
      return attachMissionTask(rest);
    case 'report':
    case 'debrief':
      return reportMission(rest);
    case 'timeline':
    case 'landings':
      return timelineMission(rest);
    case 'watch':
      return watchMission(rest);
    case 'layers':
      return layersMission(rest);
    case 'room':
      return roomMission(rest);
    case 'prune-runs':
    case 'runs-prune':
    case 'clean-runs':
      return pruneRunsMission(rest);
    case 'goal':
    case 'codex-goal':
      return goalMission(rest);
    case 'goal-loop':
    case 'codex-goal-loop':
      return goalLoopMission(rest);
    case 'ping':
      return pingMission(rest);
    case 'inspect':
      return inspectMission(rest);
    case 'tick':
      return tickMission(rest);
    case 'set-runner':
    case 'runner':
      return setMissionRunner(rest);
    case 'run':
      return runMission(rest);
    case 'complete':
    case 'done':
      return completeMission(rest);
    case 'stop':
    case 'pause':
      return stopMission(subcommand === 'pause' ? ['--pause', ...rest] : rest);
    case 'help':
    case '--help':
    case '-h':
      return help();
    default: {
      const first = String(subcommand || '');
      if (first && !first.startsWith('-')) {
        // Shortcut forms: a mission id, or an objective (quoted or spread
        // across argv: `atris mission fix the issue`). Two shapes are
        // mistyped verbs, not objectives — a later arg naming a mission id
        // (`mission say <id> ...`), and a single bare word with no objective
        // after it. Creating a mission from those silently is worse than erroring.
        const positionals = args.filter((value) => !String(value).startsWith('-'));
        const referencesMissionId = positionals.slice(1).some((value) => /^mission-/.test(String(value)));
        const loneWord = positionals.length === 1 && !first.includes(' ');
        if (first.startsWith('mission-') || (!referencesMissionId && !loneWord)) return runMission(args);
        console.error(`Unknown mission subcommand "${first}".`);
        console.error('To steer a running wish mission use: atris wish say "<note>" <wish-id>');
        console.error('Run "atris mission help" for the full verb list.');
        process.exitCode = 1;
        return undefined;
      }
      return help();
    }
  }
}

module.exports = {
  missionCommand,
  startMission,
  completeMission,
  inspectMission,
  expireStaleMissions,
  reapPausedMissions,
  missionHeartbeatLines,
  listMissions,
  listWorktreeRollupMissions,
  findActiveTwinMission,
  TWIN_ACTIVE_STATUSES,
  pingMission,
  buildTickPrompt,
  loadMissionMap,
  renderMissionStatus,
  selectDueMission,
  selectAtrisGoalMission,
  selectCodexGoalMission,
  codexGoalNextCommand,
  usefulClaudeReceiptSummary,
  cappedClaudeReceiptText,
  extractLayerFromReceiptText,
  classifyPathsByLayer,
  collectMissionDoctorFindings,
  resolveClaudeRunnerModel,
  resolveClaudeRunnerBin,
  businessIdForAtris2Mission,
  detectUnavailableModel,
  missionPauseNextAction,
  HUMAN_BLOCKING_PAUSE_REASONS,
  composeHumanBlockingPauseMessage,
  escalateHumanBlockingPause,
  humanBlockingPauseReason,
  consecutiveSameReasonErrors,
  missionVerifierTimeoutMs,
  missionLandingStepSummary,
  missionLandingLines,
  missionVerifierCheckedText,
  missionVerifierHighLevelTestText,
  buildEngineVerifyPrompt,
  engineVerifierResultFromRun,
  missionFullBudgetRemainingSeconds,
  missionBudgetContinuationText,
  resolveMissionRunnerSelection,
  resolveMissionTickRunner,
  engineFailureHealthStatus,
  recordMissionEngineTickOutcome,
  tickMadeProgress,
  consecutiveNoProgressTicks,
};
