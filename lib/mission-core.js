'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { hasFlag, readFlag } = require('./arg-parser');
const {
  compactErrorPayload,
  printCliJson,
} = require('./cli-json');
const {
  resolveClaudeRunnerModel,
  resolvePinnedRunnerModel,
  runnerModelFor,
  RUNNER_PROFILE_DEFS,
  RUNNER_PROFILE_ALIASES,
  RUNNER_PROFILE_NAMES,
} = require('./runner-command');
const {
  resolveEngineForRoleWithPreference,
  engineFailureHealthStatus,
  engineStallReason,
  recordEngineRunHealth,
  setEngineHealth,
} = require('./engine-registry');
const { appendRosterRun } = require('./roster-runs');
const {
  FUNCTIONAL_MEMBER_TOPICS,
  listWorkspaceMemberSlugs,
  normalizeOwnerSlug,
} = require('./functional-owner');
const { hasAgentJargon } = require('../commands/autoland');
const {
  displayNumber,
  meaningfulWords,
  recordMatchesRef,
  shortRecordLabel,
  shortRecordRef,
} = require('./short-name');
const { readJson, writeJson, writeFileAtomic } = require('./json-file');

const VALID_STATUSES = new Set(['planning', 'running', 'ready', 'paused', 'blocked', 'stopped', 'complete']);
const TERMINAL_STATUSES = new Set(['stopped', 'complete']);
const GOAL_LOOP_STATUSES = new Set(['planning', 'running', 'ready']);
const STATUS_ALIASES = new Set(['active']);
const CODEX_NATIVE_GOAL_SLOT_STATUSES = new Set(['active', 'paused', 'usage_limited']);
const CODEX_NATIVE_GOAL_REPLACE_STATUSES = new Set(['active', 'paused', 'usage_limited']);
const CODEX_NATIVE_GOAL_CLOSED_STATUSES = new Set(['complete', 'completed', 'achieved']);
const DEFAULT_LONG_RUN_VERIFIER = 'git diff --check';
const SLEEP_LENGTH_BUDGET_SECONDS = 3600;
const HUMAN_BLOCKING_PAUSE_REASONS = new Set(['auth-required', 'model-unavailable', 'rate-limit-exceeded-wall']);
// Claude prints its logged-out message on stdout ("Invalid API key · Please
// run /login"), not stderr, so the check has to read the captured result text
// too or a dead login masquerades as a generic claude-error.
const MISSION_RUNNER_AUTH_EXPIRED_RE = /not authenticated|please log in|login required|auth(?:entication)? expired|invalid (?:api|connection) key|run \/login/i;

function missionRunnerAuthExpired(...texts) {
  return texts.some((text) => Boolean(text) && MISSION_RUNNER_AUTH_EXPIRED_RE.test(String(text)));
}

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

function destinationHash(destination) {
  return crypto.createHash('sha256').update(String(destination || '')).digest('hex');
}

function missionDrive(destination) {
  const value = String(destination || '').trim();
  if (!value) return null;
  return {
    schema: 'atris.mission.drive.v1',
    destination: value,
    destination_hash: destinationHash(value),
    autonomy_level: 'L1',
    route_version: 1,
    position: 0,
    legs: [],
    hard_gates: [],
    budget: null,
    stop_reason: null,
  };
}

function proposeMissionDestinationChange(mission, destination) {
  const value = String(destination || '').trim();
  if (!mission?.drive || !value || value === mission.drive.destination) return mission;
  return {
    ...mission,
    drive: {
      ...mission.drive,
      pending_destination_proposal: {
        destination: value,
        destination_hash: destinationHash(value),
        reason: 'destination changes require operator approval',
        operator_gated: true,
        proposed_at: stampIso(),
      },
    },
  };
}

const SUPPORTED_MISSION_HARD_GATES = new Set([
  'money_movement',
  'outbound_communication',
  'destructive_change',
  'irreversible_change',
  'secret_access',
  'destination_change',
]);

function missionRouteLegId(leg, index) {
  return String(leg?.id || leg?.key || `leg-${index + 1}`).trim();
}

function missionRouteHardGates(proposal) {
  const gates = [];
  const add = (value) => {
    const values = Array.isArray(value) ? value : value ? [value] : [];
    for (const entry of values) {
      const gate = String(entry || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
      if (gate && !gates.includes(gate)) gates.push(gate);
    }
  };
  add(proposal?.hard_gates);
  for (const leg of proposal?.legs || []) {
    add(leg?.hard_gates);
    add(leg?.hard_gate);
  }
  return gates;
}

function missionRouteScopePresent(leg) {
  const files = Array.isArray(leg?.files) ? leg.files : leg?.files ? [leg.files] : [];
  const surfaces = Array.isArray(leg?.surface) ? leg.surface : leg?.surface ? [leg.surface] : [];
  return [...files, ...surfaces].some((value) => String(value || '').trim());
}

function missionRouteCycle(legs) {
  const ids = legs.map(missionRouteLegId);
  const dependencies = new Map(legs.map((leg, index) => [
    ids[index],
    Array.isArray(leg.dependencies) ? leg.dependencies.map((value) => String(value || '').trim()).filter(Boolean) : [],
  ]));
  const visiting = new Set();
  const visited = new Set();
  const stack = [];

  function visit(id) {
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      return [...stack.slice(start), id];
    }
    if (visited.has(id)) return null;
    visiting.add(id);
    stack.push(id);
    for (const dependency of dependencies.get(id) || []) {
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
    return null;
  }

  for (const id of ids) {
    const cycle = visit(id);
    if (cycle) return cycle;
  }
  return null;
}

function validateMissionRouteProposal(proposal) {
  const legs = proposal?.legs;
  if (!Array.isArray(legs) || legs.length === 0) {
    return { code: 'missing_legs', reason: 'route proposal must contain at least one leg' };
  }

  const ids = legs.map(missionRouteLegId);
  const idSet = new Set(ids);
  if (idSet.size !== ids.length) {
    return { code: 'duplicate_leg_id', reason: 'route proposal contains duplicate leg ids' };
  }

  for (let index = 0; index < legs.length; index += 1) {
    const leg = legs[index];
    const id = ids[index];
    if (!leg || typeof leg !== 'object' || Array.isArray(leg)) {
      return { code: 'invalid_leg', reason: `route leg ${id} must be an object` };
    }
    if (!String(leg.objective || '').trim()) {
      return { code: 'missing_objective', reason: `route leg ${id} is missing an objective` };
    }
    if (!String(leg.verifier || '').trim()) {
      return { code: 'missing_verifier', reason: `route leg ${id} is missing a verifier command` };
    }
    if (!String(leg.stop_condition || leg.terminal_condition || leg.terminal_state || '').trim()) {
      return { code: 'missing_stop_condition', reason: `route leg ${id} is missing a stop or terminal condition` };
    }
    if (!missionRouteScopePresent(leg)) {
      return { code: 'missing_scope', reason: `route leg ${id} has no files or surface scope` };
    }
    if (leg.dependencies !== undefined && !Array.isArray(leg.dependencies)) {
      return { code: 'invalid_dependencies', reason: `route leg ${id} dependencies must be a list` };
    }
    for (const dependency of leg.dependencies || []) {
      const dependencyId = String(dependency || '').trim();
      if (!idSet.has(dependencyId)) {
        return { code: 'unknown_dependency', reason: `route leg ${id} depends on unknown leg ${dependencyId || '(empty)'}` };
      }
    }
  }

  const unsupportedGate = missionRouteHardGates(proposal)
    .find((gate) => !SUPPORTED_MISSION_HARD_GATES.has(gate));
  if (unsupportedGate) {
    return { code: 'unsupported_hard_gate', reason: `route uses unsupported hard gate ${unsupportedGate}` };
  }

  const cycle = missionRouteCycle(legs);
  if (cycle) {
    return { code: 'dependency_cycle', reason: `route dependencies form a cycle: ${cycle.join(' -> ')}` };
  }
  return null;
}

function readMissionRouteProposal(args, asJson) {
  const source = readFlag(args, '--file', '');
  let raw = '';
  try {
    raw = source && source !== '-'
      ? fs.readFileSync(path.resolve(process.cwd(), source), 'utf8')
      : fs.readFileSync(0, 'utf8');
  } catch (error) {
    exitMissionError(`Could not read route proposal: ${error.message}`, 1, asJson);
  }
  if (!String(raw || '').trim()) {
    exitMissionError('Route proposal JSON is required on stdin or with --file <path>.', 1, asJson);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    exitMissionError(`Route proposal is not valid JSON: ${error.message}`, 1, asJson);
  }
  if (Array.isArray(parsed)) return { legs: parsed, hard_gates: [] };
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    exitMissionError('Route proposal must be a list of legs or an object with a legs list.', 1, asJson);
  }
  return {
    ...parsed,
    legs: parsed.legs,
    hard_gates: parsed.hard_gates ?? [],
  };
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

// The roster line's effort and time cap for this tick, when it sets them.
function rosterTickPins(engine) {
  return {
    ...(engine && engine.roster_effort ? { roster_effort: engine.roster_effort } : {}),
    ...(engine && engine.roster_max_seconds ? { roster_max_seconds: engine.roster_max_seconds } : {}),
    ...(engine && engine.roster_prep ? { roster_prep: engine.roster_prep } : {}),
  };
}

// A tick whose roster worker asks for prep ("prep: search") runs the same
// prep pass fleet runs before the worker starts, and the worker's prompt
// gets the brief. No prep line means the prompt goes out as it was.
async function missionTickPrep(root, { mission, runtimeMission, job, prompt, ask } = {}) {
  const prepJob = String(runtimeMission && runtimeMission.roster_prep || '').trim();
  if (!prepJob) return { prompt, prep: null };
  const { runPrepPass, withPrepBrief } = require('./roster-prep');
  const prep = await runPrepPass({
    prepJob,
    forJob: job || 'build',
    task: { display_id: (mission && mission.id) || '', title: (mission && (mission.objective || mission.slug)) || '' },
    prompt,
    root,
    record: { member: (mission && mission.owner) || '' },
    ...(ask ? { ask } : {}),
  });
  return { prompt: withPrepBrief(prompt, prep), prep };
}

// The reason a member log shows for a tick. A failed engine tick names its
// engine beside the reason, so a codex run that timed out stops counting as
// a claude timeout in the repeat-problem scan. The reason itself is left as
// is because engine health and backoff match on it.
function memberLogTickReason(result) {
  const reason = result && result.reason;
  if (!reason || !result.engine_id || result.status !== 'errored') return reason;
  return `${reason} (engine: ${result.engine_id})`;
}

function resolveMissionTickRunner(mission, root = process.cwd(), options = {}) {
  if (String(mission && mission.runner || '').trim().toLowerCase() !== MISSION_AUTO_RUNNER) {
    // A named engine still gets the roster's time limit for that engine.
    const runner = String(mission && mission.runner || '').trim().toLowerCase();
    const pin = runner && !(Number(mission && mission.roster_max_seconds) > 0)
      ? require('./engine-registry').rosterPinFor('executor', runner, root, options)
      : {};
    const limited = pin.roster_max_seconds ? { ...mission, roster_max_seconds: pin.roster_max_seconds } : mission;
    return { mission: limited, engine_id: null, requested_engine: null, engine_fallback_reason: null };
  }
  // A mission owned by a team member runs on that member's roster pick. An
  // explicit preferred engine (or a run's --engine) still wins, and with no
  // roster line behind the member, routing stays exactly as it was.
  if (!String(mission.preferred_engine || '').trim() && mission.owner) {
    const { memberRosterEngine } = require('./member-engine');
    const member = memberRosterEngine(mission.owner, root, options);
    if (member) {
      if (process.env.ATRIS_ROUTER_EXPLAIN !== '0') console.error(member.reason);
      return {
        mission: {
          ...mission,
          runner: member.engine.id,
          runner_kind: 'engine',
          ...(!mission.model && member.model ? { model: member.model } : {}),
          ...rosterTickPins(member.engine),
        },
        engine_id: member.engine.id,
        requested_engine: null,
        engine_fallback_reason: null,
        member_engine_reason: member.reason,
        roster_job: member.job || 'build',
      };
    }
  }
  const resolved = resolveEngineForRoleWithPreference('executor', root, mission.preferred_engine, options);
  return {
    mission: resolved.engine ? {
      ...mission,
      runner: resolved.engine.id,
      runner_kind: 'engine',
      ...(!mission.model && resolved.engine.roster_model ? { model: resolved.engine.roster_model } : {}),
      ...rosterTickPins(resolved.engine),
    } : mission,
    engine_id: resolved.engine ? resolved.engine.id : null,
    requested_engine: resolved.requested_engine,
    engine_fallback_reason: resolved.engine_fallback_reason,
  };
}

// A stalled tick benches its engine for the cooldown, so the next tick's
// roster pick is the backup; no retry inside the tick is needed.
function recordMissionEngineTickOutcome(engineId, result, root = process.cwd()) {
  if (!engineId) return null;
  if (result && result.status === 'ran') return setEngineHealth(engineId, 'ready', root);
  if (!engineFailureHealthStatus(result)) return null;
  return recordEngineRunHealth(engineId, result, root);
}

// One run-record line per engine tick: how long the worker ran, and how it
// ended. A tick that ran and passed (or had no verifier) landed; a failing
// verifier or a real error failed; a time cap or dropped connection stalled;
// a closed credit window is credit out. Never throws into the tick.
function missionTickRunOutcome(result, verifierResult, maxSeconds) {
  if (result && result.status === 'ran') {
    const review = verifierResult?.referee;
    if (verifierResult?.passed === false && verifierResult.status === 0 && !verifierResult.timed_out
      && review?.mode === 'engine-unavailable' && review.reason !== 'code changed during review') {
      return { outcome: 'review unavailable', detail: review.timed_out
        ? 'the build check passed, but the second review timed out'
        : 'the build check passed, but the second review was unavailable' };
    }
    return verifierResult && verifierResult.passed === false
      ? { outcome: 'failed', detail: 'the verifier failed' }
      : { outcome: 'landed' };
  }
  if (engineFailureHealthStatus(result) === 'credit_out') return { outcome: 'credit out', detail: 'the engine hit its usage limit' };
  const stall = engineStallReason({ ...result, ...(maxSeconds ? { max_seconds: maxSeconds } : {}) });
  if (stall) return { outcome: 'stalled', detail: stall.text };
  if (/wall-exceeded/.test(String(result && result.reason || ''))) return { outcome: 'failed', detail: 'the mission ran out of time' };
  const summary = String(result && result.claude && result.claude.summary || '').split('\n')[0].trim();
  return { outcome: 'failed', detail: summary && summary !== 'error' ? summary : String(result && result.reason || 'the tick failed').replace(/-/g, ' ') };
}

function recordMissionTickRosterRun(root, { mission, runtimeMission, engineId, job, result, verifierResult, startedAt, endedMs, usage, prep = null } = {}) {
  if (!engineId) return null;
  try {
    const { engineRunsView } = require('./roster-models');
    const { prepRecordFields } = require('./roster-prep');
    const run = runtimeMission || mission || {};
    const startedMs = Date.parse(startedAt);
    const maxSeconds = Number(run.roster_max_seconds) || 0;
    return appendRosterRun(root, {
      at: startedAt,
      job: job || 'build',
      member: (mission && mission.owner) || '',
      engine: engineId,
      model: run.model || engineRunsView(engineId).model || '',
      effort: run.roster_effort || '',
      max_seconds: maxSeconds,
      seconds: Number.isFinite(startedMs) ? Math.max(0, (endedMs - startedMs) / 1000) : undefined,
      task: (mission && mission.id) || '',
      source: 'mission',
      ...prepRecordFields(prep),
      ...(usage || {}),
      ...missionTickRunOutcome(result, verifierResult, maxSeconds),
    });
  } catch {
    return null;
  }
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

// Claude-family engines share the claude CLI, so they keep the resolved
// default model pin. Every other engine's CLI rejects a claude model name, so
// it only ever takes an explicit pin (the mission's model or the roster
// line's); '' lets the engine ride its own default.
// A mission often still carries the claude model it was created with; an
// engine that runs only its own models (codex, grok) drops it.
const CLAUDE_FAMILY_RUNNER_ENGINES = new Set(['claude', 'fable', 'haiku']);

function resolveMissionTickRunnerModel(mission) {
  const engine = canonicalEngineName(mission && mission.runner);
  if (!engine || CLAUDE_FAMILY_RUNNER_ENGINES.has(engine)) {
    return resolveClaudeRunnerModel(mission);
  }
  return runnerModelFor(engine, resolvePinnedRunnerModel(mission));
}

function exitMissionError(message, code = 1, asJson = false) {
  if (asJson) {
    printCliJson(
      {
        ok: false,
        error: message,
        reason: 'mission_error',
        detail: message,
        selected_ref: null,
        next_command: null,
      },
      compactErrorPayload({ reason: 'mission_error', detail: message }),
      process.argv.slice(2),
    );
  } else {
    console.error(message);
  }
  process.exit(code);
}

// Write-time warnings judge only what a machine can truly judge: identifiers,
// flags, and task ids. Whether a why is present is a judgment call, the tick
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
      values.push(readFlag([name, args[i + 1]], name, ''));
      i += 1;
      continue;
    }
    if (arg.startsWith(prefix)) values.push(readFlag([arg], name, ''));
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
  const booleanSet = new Set(['--full', '--verbose', ...booleanNames]);
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
  '--pick',
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
  '--referee-engine',
  '--budget',
  '--campaign',
  '--reserve',
  '--repo',
  '--native-goal-status',
  '--native-goal-objective',
  '--visible-goal-status',
  '--visible-goal-objective',
];
const MISSION_RUN_BOOLEAN_FLAGS = [
  '--json',
  '--full',
  '--verbose',
  '--due',
  '--detach',
  '--headless',
  '--self-drive',
  '--fleet',
  '--dry-run',
  '--land',
  '--no-claude',
  '--no-verify',
  '--referee',
  '--referee-if-check-edited',
  '--no-referee',
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
    return require('./task-db');
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    if (error?.code === 'ERR_UNKNOWN_BUILTIN_MODULE' || /node:sqlite/.test(message)) {
      exitMissionError('AgentXP mission tasks require Node 22+ with node:sqlite.', 2, asJson);
    }
    throw error;
  }
}

// The projection has one writer and one shape: `atris task`'s writeDefaultProjection, which
// enriches the rows and writes through a temp file and a rename. Writing the bare rows here
// left readers a different shape depending on which command ran last. The fallback (only if
// the task command cannot load) still writes atomically.
function writeMissionTaskProjection(taskDb, db, workspaceRoot) {
  let writer = null;
  try { writer = require('../commands/task').writeDefaultProjection; } catch { writer = null; }
  if (typeof writer === 'function') return writer(taskDb, db, { root: workspaceRoot });
  const projection = taskDb.taskProjection(db, { workspaceRoot, limit: 500 });
  const outPath = path.join(workspaceRoot, '.atris', 'state', 'tasks.projection.json');
  writeFileAtomic(outPath, JSON.stringify(projection, null, 2) + '\n');
  return { projection, outPath };
}

function missionTaskRef(task) {
  return task?.display_id || task?.legacy_ref || String(task?.id || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 8);
}

function missionXpTaskTitle(objective) {
  const prefix = 'Mission XP: ';
  const normalized = String(objective || '').replace(/\s+/g, ' ').trim();
  const boundary = normalized.search(/:|[.!?](?=\s|$)/);
  const firstClause = (boundary > 0 ? normalized.slice(0, boundary) : normalized) || 'mission work';
  const maxClauseLength = 64 - prefix.length;
  if (firstClause.length <= maxClauseLength) return `${prefix}${firstClause}`;
  const clipped = firstClause.slice(0, maxClauseLength + 1);
  const wordBoundary = clipped.lastIndexOf(' ');
  const shortClause = clipped.slice(0, wordBoundary > 0 ? wordBoundary : maxClauseLength).trim();
  return `${prefix}${shortClause || 'mission work'}`;
}

function normalizeMissionTaskMatchText(text) {
  return String(text || '')
    .replace(/^Mission XP:\s*/i, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function missionObjectiveTaskMatch(objective, title) {
  const want = normalizeMissionTaskMatchText(objective);
  const have = normalizeMissionTaskMatchText(title);
  if (!want || !have) return false;
  if (want === have) return true;
  // First clause of a long objective often matches the claimed task title.
  const wantClause = want.split(/:|[.!?](?=\s|$)/)[0].trim();
  const haveClause = have.split(/:|[.!?](?=\s|$)/)[0].trim();
  if (wantClause && haveClause && (wantClause === haveClause || want.startsWith(haveClause) || have.startsWith(wantClause))) {
    return true;
  }
  return false;
}

function taskRowToMissionXpBinding(task, ownerResolution, outPath, { inserted = false, reused = true } = {}) {
  return {
    task_id: task.id,
    ref: missionTaskRef(task) || task.id,
    title: task.title,
    operator_title_warning: warnIfTaskTitleNeedsOperatorWhy(task.title),
    status: task.status || 'claimed',
    assigned_to: task.claimed_by || ownerResolution.owner,
    owner_resolution: ownerResolution.reason,
    executed_by: ownerResolution.executed_by ? normalizeOwnerSlug(ownerResolution.executed_by) : null,
    inserted,
    reused,
    projection_path: outPath,
  };
}

function findOpenTaskMatchingMissionObjective(mission, root = process.cwd(), asJson = false) {
  const taskDb = loadTaskDb(asJson);
  const db = taskDb.open();
  const workspaceRoot = taskDb.workspaceRoot(root);
  const rows = taskDb.withTaskDisplayRefs(taskDb.listTasks(db, { workspaceRoot }));
  const open = rows.filter((row) => row && ['open', 'claimed', 'review'].includes(row.status));
  const explicitIds = Array.isArray(mission.task_ids) ? mission.task_ids.filter(Boolean) : [];
  for (const id of explicitIds) {
    const hit = open.find((row) => row.id === id || row.display_id === id || missionTaskRef(row) === id);
    if (hit) return hit;
  }
  return open.find((row) => missionObjectiveTaskMatch(mission.objective, row.title)) || null;
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
    statusForYou: path.join(root, 'atris', 'status', 'for-you.md'),
    runsDir: path.join(root, 'atris', 'runs'),
  };
}

function readBusinessBinding(root = process.cwd()) {
  const file = path.join(root, '.atris', 'business.json');
  const parsed = readJson(file);
  if (parsed == null) return null;
  return {
    business_id: parsed.business_id || '',
    workspace_id: parsed.workspace_id || '',
    slug: parsed.slug || '',
  };
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

function missionLabel(mission) {
  const displayHandle = String(mission && mission.display_handle || '').trim();
  if (displayHandle) {
    const words = meaningfulWords(mission && (mission.objective || mission.slug || mission.id), 3);
    return `${displayHandle}${words.length ? ` ${words.join(' ')}` : ''}`;
  }
  return shortRecordLabel(mission, mission && (mission.objective || mission.slug || mission.id));
}

function missionRef(mission) {
  const displayHandle = String(mission && mission.display_handle || '').trim();
  if (displayHandle) return displayHandle;
  return shortRecordRef(mission);
}

function missionDisplayText(mission, value) {
  const text = String(value || '');
  const id = String(mission && mission.id || '').trim();
  if (!id) return text;
  return text.split(id).join(missionRef(mission));
}

function missionNumberWinner(records = []) {
  return records.reduce((winner, candidate) => {
    if (!winner) return candidate;
    const winnerTerminal = TERMINAL_STATUSES.has(winner.status);
    const candidateTerminal = TERMINAL_STATUSES.has(candidate.status);
    if (winnerTerminal !== candidateTerminal) return candidateTerminal ? winner : candidate;
    const winnerUpdated = String(winner.updated_at || winner.created_at || '');
    const candidateUpdated = String(candidate.updated_at || candidate.created_at || '');
    if (candidateUpdated !== winnerUpdated) return candidateUpdated > winnerUpdated ? candidate : winner;
    return String(candidate.id || '').localeCompare(String(winner.id || '')) < 0 ? candidate : winner;
  }, null);
}

const MISSION_REF_SUFFIX_MIN_LENGTH = 6;

function uniqueMissionSuffix(mission, missions) {
  const id = String(mission && mission.id || '').trim();
  if (!id) return 'unknown';
  const minimum = Math.min(MISSION_REF_SUFFIX_MIN_LENGTH, id.length);
  for (let length = Math.min(8, id.length); length <= id.length; length += 1) {
    const suffix = id.slice(-Math.max(length, minimum));
    if (missions.filter((candidate) => String(candidate.id || '').endsWith(suffix)).length === 1) return suffix;
  }
  return id;
}

function missionNumberDisplayIndex(missions, canonicalMissions = missions) {
  const recordsByNumber = new Map();
  for (const mission of canonicalMissions) {
    const number = displayNumber(mission.n);
    if (!number) continue;
    const records = recordsByNumber.get(number) || [];
    records.push(mission);
    recordsByNumber.set(number, records);
  }
  const winnerIds = new Map();
  for (const [number, records] of recordsByNumber) {
    if (records.length > 1) winnerIds.set(number, missionNumberWinner(records)?.id);
  }
  return missions.map((mission) => {
    const number = displayNumber(mission.n);
    if (!number || !winnerIds.has(number) || winnerIds.get(number) === mission.id) return mission;
    return { ...mission, display_handle: uniqueMissionSuffix(mission, canonicalMissions) };
  });
}

// A ref that "looks like" an id/suffix/number is a single token with no
// whitespace matching a hex/id/numeric shape. Those must resolve or error,
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

// Sibling folders looked at for a hint. A missing-id error waited 26 seconds
// on a temp folder holding 276,000 entries, so the scan is capped and never
// walks the system temp folder.
const SIBLING_HINT_SCAN_LIMIT = 2000;

function missionMatchesStatusFilter(mission, statusFilter) {
  if (statusFilter === 'active') return !TERMINAL_STATUSES.has(mission.status);
  return mission.status === statusFilter;
}

function appendJsonLine(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(payload) + '\n', 'utf8');
}

function resolveMemberWorkspaceRoot(root = process.cwd()) {
  const resolved = path.resolve(root || process.cwd());
  const agentWorktreesMarker = `${path.sep}.agent-worktrees${path.sep}`;
  const agentIdx = resolved.indexOf(agentWorktreesMarker);
  if (agentIdx > 0) {
    const parentDir = resolved.slice(0, agentIdx);
    const after = resolved.slice(agentIdx + agentWorktreesMarker.length);
    const repoName = after.split(path.sep)[0];
    if (repoName) {
      const primaryRoot = path.join(parentDir, repoName);
      if (fs.existsSync(path.join(primaryRoot, 'atris'))) return primaryRoot;
    }
  }
  const marker = `${path.sep}.atris${path.sep}worktrees${path.sep}`;
  const idx = resolved.indexOf(marker);
  if (idx > 0) {
    const parentRoot = resolved.slice(0, idx);
    if (fs.existsSync(path.join(parentRoot, 'atris'))) return parentRoot;
  }
  return resolved;
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
  const parentRoot = resolveMemberWorkspaceRoot(root);
  if (type === 'mission_tick' && parentRoot !== path.resolve(root || process.cwd())) {
    try {
      appendJsonLine(statePaths(parentRoot).eventsJsonl, event);
    } catch {}
  }
  return event;
}

function memberDir(owner, root = process.cwd()) {
  if (!owner || !/^[a-zA-Z0-9._-]+$/.test(owner)) return null;
  const parentRoot = resolveMemberWorkspaceRoot(root);
  const candidates = parentRoot !== path.resolve(root || process.cwd())
    ? [parentRoot, root]
    : [root];
  for (const base of candidates) {
    const dir = path.join(base, 'atris', 'team', owner);
    if (fs.existsSync(path.join(dir, 'MEMBER.md'))) return dir;
  }
  return null;
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
  let lead = '';
  try {
    const size = fs.statSync(logPath).size;
    if (size > 0) {
      const fd = fs.openSync(logPath, 'r');
      const last = Buffer.alloc(1);
      fs.readSync(fd, last, 0, 1, size - 1);
      fs.closeSync(fd);
      if (last[0] !== 0x0a) lead = '\n';
    }
  } catch {}
  fs.appendFileSync(logPath, lead + rows.join('\n'), 'utf8');
  return logPath;
}

// Shorten at a word boundary so a lesson never ends mid-word.
function clipWords(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max + 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : text.slice(0, max)).replace(/[\s,;:.-]+$/, '')}...`;
}

function crystallizeMemberSkillLesson(owner, entry = {}, root = process.cwd()) {
  const dir = memberDir(owner, root);
  if (!dir) return null;
  const summary = String(entry.summary || entry.objective || '').replace(/\s+/g, ' ').trim();
  if (!summary) return null;
  const skillDir = path.join(dir, 'skills', 'auto-learned');
  fs.mkdirSync(skillDir, { recursive: true });
  const skillPath = path.join(skillDir, 'SKILL.md');
  let lines = null;
  if (fs.existsSync(skillPath)) {
    try {
      lines = fs.readFileSync(skillPath, 'utf8').split(/\r?\n/);
    } catch {}
  }
  const bulletAt = (lines || []).map((line, i) => (line.trim().startsWith('- **') ? i : -1)).filter((i) => i >= 0);
  const existingBullets = bulletAt.map((i) => lines[i].trim());
  const verifierText = String(entry.verifier || '').replace(/\s+/g, ' ').trim();
  const nextPushText = String(entry.next_push || '').replace(/\s+/g, ' ').trim();
  const layerLabel = String(entry.layer || 'capabilities').trim();
  const parts = [`- **${todayName()} (${layerLabel})**: ${clipWords(summary, 240)}`];
  // A cut-off command cannot be run, so a long one is left out, never clipped.
  if (verifierText && verifierText.length <= 300) parts.push(`Verify: \`${verifierText}\``);
  if (nextPushText) parts.push(`Next push: ${clipWords(nextPushText, 200)}`);
  const newBullet = parts.join(' -> ');
  const deduped = [
    newBullet,
    ...existingBullets.filter((b) => !b.includes(summary.slice(0, 80))),
  ].slice(0, 5);

  let content;
  if (bulletAt.length) {
    // Keep whatever a person or reviewer wrote around the lessons; only the
    // lesson list itself is rewritten.
    const first = bulletAt[0];
    const last = bulletAt[bulletAt.length - 1];
    content = [...lines.slice(0, first), ...deduped, ...lines.slice(last + 1)].join('\n');
  } else {
    content = [
      '---',
      'name: auto-learned',
      `description: Verified patterns crystallized from passing runs for ${owner}. Bounded to 5 newest patterns so context never bloats.`,
      '---',
      '',
      '# Auto-Learned Verified Patterns',
      '',
      ...deduped,
      '',
    ].join('\n');
  }
  fs.writeFileSync(skillPath, content, 'utf8');
  return skillPath;
}

function autoQueueMemberNextPush(owner, nextPush, parentObjective = '', root = process.cwd(), { promote = false } = {}) {
  const cleanPush = String(nextPush || '').replace(/\s+/g, ' ').trim();
  if (!cleanPush) return null;
  const dir = memberDir(owner, root);
  if (!dir) return null;
  const goalsPath = path.join(dir, 'goals.json');
  let store = { schema_version: 1, member: owner, updated_at: stampIso(), goals: [] };
  if (fs.existsSync(goalsPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(goalsPath, 'utf8'));
      if (parsed && Array.isArray(parsed.goals)) store = parsed;
    } catch {}
  }
  const now = stampIso();
  const activeIdx = store.goals.findIndex((g) => g && g.status === 'active');
  if (activeIdx >= 0) {
    const prev = store.goals[activeIdx];
    store.goals[activeIdx] = {
      ...prev,
      ...(promote ? { previous_title: prev.title, title: cleanPush } : {}),
      next_push: cleanPush,
      updated_at: now,
    };
  } else {
    store.goals.push({
      id: `goal_${Date.now().toString(36)}`,
      member: owner,
      title: cleanPush,
      why: parentObjective ? `Compounds after verified win on: ${parentObjective}` : 'Self-proposed next optimization from verified run.',
      metric: 'verified_slices_shipped',
      target: '1',
      horizon: '7d',
      acceptance: ['Passes test check and cross-model referee'],
      next_push: cleanPush,
      status: 'active',
      created_at: now,
      updated_at: now,
    });
  }
  store.updated_at = now;
  fs.writeFileSync(goalsPath, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  return goalsPath;
}

const DEFAULT_MEMBER_BATON_RELAY = {
  researcher: 'navigator',
  'customer-lead': 'navigator',
  navigator: 'executor',
  architect: 'executor',
  executor: 'validator',
  'auto-improver': 'validator',
};

function recordMemberHandoff(fromMember, toMember, sliceSummary, root = process.cwd(), extra = {}) {
  const from = String(fromMember || '').trim().toLowerCase();
  const to = String(toMember || DEFAULT_MEMBER_BATON_RELAY[from] || '').trim().toLowerCase();
  const cleanSummary = String(sliceSummary || '').replace(/\s+/g, ' ').trim();
  if (!from || !to || !cleanSummary) return null;
  const parentRoot = resolveMemberWorkspaceRoot(root);
  if (!memberDir(to, parentRoot)) return null;
  const now = stampIso();
  const handoff = {
    id: `handoff_${Date.now().toString(36)}`,
    from,
    to,
    summary: cleanSummary.slice(0, 180),
    status: extra.status || 'open',
    next_command: `atris member go ${to}`,
    created_at: now,
  };
  const handoffsFile = path.join(parentRoot, '.atris', 'state', 'member-handoffs.jsonl');
  try {
    withHandoffsLock(handoffsFile, () => fs.appendFileSync(handoffsFile, `${JSON.stringify(handoff)}\n`, 'utf8'));
  } catch {
    return null;
  }
  try {
    autoQueueMemberNextPush(to, `${from} handoff: ${cleanSummary}`, `Baton pass from ${from}`, parentRoot);
  } catch {}
  return handoff;
}

// Every write to member-handoffs.jsonl (append or whole-file rewrite) holds
// one lock file beside it, so concurrent handoffs never lose a row.
// (Codex review round 3 on #1483.)
function withHandoffsLock(handoffsFile, fn) {
  fs.mkdirSync(path.dirname(handoffsFile), { recursive: true });
  const lockFile = path.join(path.dirname(handoffsFile), 'member-handoffs.lock');
  return require('./handoff-wake').withFileLock(lockFile, fn, { staleMs: 60 * 1000, waitMs: 30 * 1000 });
}

function rewriteHandoffs(handoffsFile, lines) {
  const tmp = `${handoffsFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${lines.join('\n')}\n`, 'utf8');
  fs.renameSync(tmp, handoffsFile);
}

// Merge `patch` into the newest handoff row with this id. Returns the
// updated row, or null when it is not on file.
function updateMemberHandoff(handoffId, patch, root = process.cwd()) {
  const id = String(handoffId || '');
  if (!id || !patch) return null;
  const handoffsFile = path.join(resolveMemberWorkspaceRoot(root), '.atris', 'state', 'member-handoffs.jsonl');
  try {
    return withHandoffsLock(handoffsFile, () => {
      const lines = fs.readFileSync(handoffsFile, 'utf8').split(/\r?\n/).filter((l) => l.trim());
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        let row = null;
        try { row = JSON.parse(lines[i]); } catch {}
        if (!row || row.id !== id) continue;
        const updated = { ...row, ...patch };
        lines[i] = JSON.stringify(updated);
        rewriteHandoffs(handoffsFile, lines);
        return updated;
      }
      return null;
    });
  } catch {
    return null;
  }
}

function closeMemberHandoffsForReceiver(receiverMember, root = process.cwd()) {
  const receiver = String(receiverMember || '').trim().toLowerCase();
  if (!receiver) return 0;
  const parentRoot = resolveMemberWorkspaceRoot(root);
  const handoffsFile = path.join(parentRoot, '.atris', 'state', 'member-handoffs.jsonl');
  if (!fs.existsSync(handoffsFile)) return 0;
  try {
    return withHandoffsLock(handoffsFile, () => closeHandoffRows(handoffsFile, receiver));
  } catch {
    return 0;
  }
}

function closeHandoffRows(handoffsFile, receiver) {
  const rawLines = fs.readFileSync(handoffsFile, 'utf8').split(/\r?\n/).filter((l) => l.trim());
  let closedCount = 0;
  const now = stampIso();
  const updatedLines = rawLines.map((line) => {
    try {
      const row = JSON.parse(line);
      if (row && String(row.to || '').toLowerCase() === receiver && (row.status || 'open') === 'open') {
        closedCount++;
        return JSON.stringify({ ...row, status: 'closed', closed_at: now });
      }
    } catch {}
    return line;
  });
  if (closedCount > 0) rewriteHandoffs(handoffsFile, updatedLines);
  return closedCount;
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

module.exports = {
  VALID_STATUSES,
  TERMINAL_STATUSES,
  GOAL_LOOP_STATUSES,
  STATUS_ALIASES,
  CODEX_NATIVE_GOAL_SLOT_STATUSES,
  CODEX_NATIVE_GOAL_REPLACE_STATUSES,
  CODEX_NATIVE_GOAL_CLOSED_STATUSES,
  DEFAULT_LONG_RUN_VERIFIER,
  SLEEP_LENGTH_BUDGET_SECONDS,
  HUMAN_BLOCKING_PAUSE_REASONS,
  MISSION_RUNNER_AUTH_EXPIRED_RE,
  missionRunnerAuthExpired,
  MISSION_BUDGET_TIERS,
  stampIso,
  todayName,
  slugify,
  shortHash,
  missionId,
  destinationHash,
  missionDrive,
  proposeMissionDestinationChange,
  SUPPORTED_MISSION_HARD_GATES,
  missionRouteLegId,
  missionRouteHardGates,
  missionRouteScopePresent,
  missionRouteCycle,
  validateMissionRouteProposal,
  readMissionRouteProposal,
  MISSION_NATIVE_RUNNER_NAMES,
  MISSION_NATIVE_RUNNER_SET,
  MISSION_AUTO_RUNNER,
  canonicalEngineName,
  knownMissionRunnerText,
  resolveMissionRunnerSelection,
  rosterTickPins,
  missionTickPrep,
  memberLogTickReason,
  resolveMissionTickRunner,
  recordMissionEngineTickOutcome,
  missionTickRunOutcome,
  recordMissionTickRosterRun,
  runnerModelPatch,
  missionRunRuntimeView,
  applyMissionRunnerProfile,
  CLAUDE_FAMILY_RUNNER_ENGINES,
  resolveMissionTickRunnerModel,
  exitMissionError,
  warnIfSummaryNeedsOperatorWhy,
  warnIfTaskTitleNeedsOperatorWhy,
  readPositiveIntegerFlag,
  readNonNegativeIntegerFlag,
  readRepeatedFlag,
  codexNativeGoalOptionsFromArgs,
  lintMissionVerifier,
  assertMissionVerifier,
  stripKnownFlags,
  wantsJson,
  printJsonOrText,
  MISSION_RUN_VALUE_FLAGS,
  MISSION_RUN_BOOLEAN_FLAGS,
  DEFAULT_MISSION_RUN_OWNER_SLUGS,
  missionRunInputRequired,
  askLine,
  removeValueFlag,
  missionRunOwnerRef,
  missionRunArgsWithOwner,
  missionRunInputFromArgs,
  promptMissionRunInput,
  loadTaskDb,
  writeMissionTaskProjection,
  missionTaskRef,
  missionXpTaskTitle,
  normalizeMissionTaskMatchText,
  missionObjectiveTaskMatch,
  taskRowToMissionXpBinding,
  findOpenTaskMatchingMissionObjective,
  statePaths,
  readBusinessBinding,
  businessIdForAtris2Mission,
  readJsonLines,
  missionLabel,
  missionRef,
  missionDisplayText,
  missionNumberWinner,
  MISSION_REF_SUFFIX_MIN_LENGTH,
  uniqueMissionSuffix,
  missionNumberDisplayIndex,
  missionRefLooksLikeHandle,
  missionMatchesRef,
  missionsMatchingHandleFragment,
  nearestMissionCandidates,
  SIBLING_HINT_SCAN_LIMIT,
  missionMatchesStatusFilter,
  appendJsonLine,
  resolveMemberWorkspaceRoot,
  appendEvent,
  memberDir,
  appendMemberLog,
  clipWords,
  crystallizeMemberSkillLesson,
  autoQueueMemberNextPush,
  DEFAULT_MEMBER_BATON_RELAY,
  recordMemberHandoff,
  withHandoffsLock,
  rewriteHandoffs,
  updateMemberHandoff,
  closeMemberHandoffsForReceiver,
  closeHandoffRows,
  memberMissionFile,
  missingOwnerMemberWarning,
  ensureMemberMissionFile,
  removeLegacyGeneratedMissionViews,
};
