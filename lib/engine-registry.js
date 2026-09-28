'use strict';

// The engine registry: engine seeds, .atris/state/engines.json read and
// write, health and cooling, and role resolution. A roster pick decides a
// role first; the roster itself lives in roster.js (ROSTER.md layers,
// resolution, assign) and roster-words.js. roster.js reads this file at
// load, so this file reads roster.js only inside the resolvers.

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const {
  RUNNER_PROFILE_DEFS,
  RUNNER_PROFILE_ALIASES,
  RUNNER_PROFILE_NAMES,
} = require('./runner-command');
// Through the module object so tests can see when ranking runs.
const routerBrain = require('./router-brain');
const { routerPickExplanation } = routerBrain;

const ENGINE_REGISTRY_SCHEMA = 'atris.engine_registry.v2';
const ENGINE_TIERS = Object.freeze(['fast', 'pro', 'max']);
const ENGINE_ROLES = Object.freeze(['navigator', 'executor', 'validator']);
const ENGINE_DUTIES = Object.freeze(['leader', 'errands', 'learning']);
const ENGINE_HEALTH_STATUSES = Object.freeze(['ready', 'not_installed', 'credit_out', 'error', 'cooling']);
const DEFAULT_ENGINE_COOLDOWN_MINUTES = 30;

// How long a stalled engine sits out: ATRIS_ENGINE_COOLDOWN_MINUTES, else 30.
function engineCooldownMs() {
  const minutes = Number(process.env.ATRIS_ENGINE_COOLDOWN_MINUTES);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_ENGINE_COOLDOWN_MINUTES) * 60000;
}

function nowMs(now) {
  if (now === undefined || now === null) return Date.now();
  const ms = now instanceof Date ? now.getTime() : Date.parse(now);
  return Number.isFinite(ms) ? ms : Date.now();
}

// True while an engine sits out after a stall. Once the cooldown passes the
// engine is ready again with no human step.
function engineCooling(engine, now) {
  const health = engine && engine.health;
  if (!health || health.status !== 'cooling') return false;
  const until = Date.parse(health.cooling_until || '');
  return Number.isFinite(until) && until > nowMs(now);
}

// Every resolver asks this one question: can this engine take work now?
function engineReadyAt(engine, now) {
  const health = engine && engine.health;
  const status = health && health.status;
  if (status === 'ready') return true;
  if (status === 'cooling') return !engineCooling(engine, now);
  // 'error' survives from before failed runs stopped benching their engine:
  // it came from any errored run, real task failures included. It sits out
  // the same window as a stall; a missing stamp (older saves) routes at once.
  if (status === 'error') {
    const failedAt = Date.parse(health.last_failure_ts || '');
    return !Number.isFinite(failedAt) || failedAt + engineCooldownMs() <= nowMs(now);
  }
  return false;
}

const TRANSIENT_FAILURE_PATTERN = /\b(?:econnreset|econnrefused|econnaborted|etimedout|enotfound|eai_again|epipe|enetunreach|ehostunreach)\b|socket hang up|connection (?:reset|refused|closed|dropped|lost|error|timed out|interrupted)|lost (?:the )?connection|network (?:error|failure|is unreachable)|stream (?:disconnected|error|closed)|\bdisconnected\b|(?:service|server|model|temporarily|currently)[ _-]unavailable|overloaded|bad gateway|gateway time-?out/;

function tailText(value, size = 600) {
  const text = String(value || '');
  return text.length > size ? text.slice(-size) : text;
}

// Why a run stalled, in plain words, or null when it failed for a real task
// reason. A stall is a time cap (the run hit its max, a spawn timeout, or the
// codex watchdog's 124/125) or a transient error (a dropped connection, a
// network error, an unavailable service). Only engine-level signals count:
// the task's own output (report, stdout, the claude summary and receipt) is
// the work it produced, and its words must not decide the engine's health.
function engineStallReason(result) {
  if (!result || typeof result !== 'object') return null;
  const claude = result.claude || {};
  const reason = String(result.reason || '');
  if (/wall-exceeded/.test(reason)) return null;
  const exitCode = Number.isInteger(result.exitCode) ? result.exitCode
    : Number.isInteger(result.exit_code) ? result.exit_code : null;
  const capSecondsValue = Math.floor(Number(result.max_seconds || result.maxSeconds)) || 0;
  const capText = capSecondsValue >= 60 ? `stalled at ${Math.round(capSecondsValue / 60)} min`
    : capSecondsValue > 0 ? `stalled at ${capSecondsValue}s`
      : 'hit its time limit';
  if (exitCode === 124) return { kind: 'time_cap', text: 'stalled at startup' };
  if (result.timed_out === true || claude.timed_out === true || exitCode === 125
    || /\bclaude-timeout\b|(?:^|\n)timeout(?:\n|$)/.test(reason)) {
    return { kind: 'time_cap', text: capText };
  }
  const text = [
    reason,
    result.error && (result.error.message || result.error.code || result.error),
    result.model_unavailable,
    tailText(result.stderr),
    tailText(claude.stderr),
  ].filter(Boolean).map(String).join('\n').toLowerCase();
  if (/spawn[^\n]*etimedout/.test(text)) return { kind: 'time_cap', text: 'timed out starting up' };
  if (TRANSIENT_FAILURE_PATTERN.test(text)) return { kind: 'transient', text: 'lost its connection' };
  return null;
}

function engineFailureHealthStatus(result) {
  if (!result || result.status !== 'errored') return null;
  // Same rule as engineStallReason: only engine-level signals decide engine
  // health. The task's own output (report, stdout, the claude summary and
  // receipt) is the work product, never the engine's vital signs.
  const rateLimitInfo = result.rate_limit_info;
  const rateLimitStatus = String(
    rateLimitInfo && typeof rateLimitInfo === 'object' ? rateLimitInfo.status || '' : rateLimitInfo || '',
  ).trim().toLowerCase();
  // The engine's own rate-limit event is a credit wall only when the window
  // is actually closed: claude reports resetsAt with status 'allowed' on
  // healthy turns too.
  if (rateLimitStatus && rateLimitStatus !== 'allowed') return 'credit_out';
  const signalText = [
    result.reason,
    result.model_unavailable,
    result.stderr,
    result.error && (result.error.message || result.error.code || result.error),
    result.claude && result.claude.stderr,
    rateLimitStatus,
  ].filter(Boolean).join('\n').toLowerCase();
  if (/usage[ _-]?limit|purchase more credits|insufficient credits|credit(?:s)?[ _-]?(?:out|limit)|rate[ _-]?limit|not authenticated|please log in|login required|auth(?:entication)?[ _-]?expired|payment required|subscription/.test(signalText)) {
    return 'credit_out';
  }
  if (/not installed|command not found|\benoent\b/.test(signalText)) return 'not_installed';
  // A real task failure (its tests failed, its report says why) says nothing
  // about the engine, so health stays. 'error' survives only as the stall
  // marker: the caller walks it through the cooling path.
  return engineStallReason(result) ? 'error' : null;
}

const ENGINE_SEED_META = Object.freeze({
  'atris-fast': Object.freeze({ tier: 'fast', roles: Object.freeze(['navigator']), models: Object.freeze(['atris fast']), duty: 'learning', fallback_order: 10 }),
  // roster_only_roles: jobs a roster pick may give this engine, but the router
  // never hands it on its own. Claude and haiku can own search when picked;
  // with no pick, search stays with atris-fast, then composer. Codex can own
  // review when picked; it stays out of roles, so every review list built
  // from roles (the router, one lap, wish audit, the chart) is unchanged.
  codex: Object.freeze({ tier: 'pro', roles: Object.freeze(['executor']), roster_only_roles: Object.freeze(['validator']), models: Object.freeze(['codex']), fallback_order: 10 }),
  claude: Object.freeze({ tier: 'max', roles: Object.freeze(['validator', 'executor', 'navigator']), roster_only_roles: Object.freeze(['navigator']), models: Object.freeze(['opus 5.5', 'opus 5', 'fable', 'haiku']), fallback_order: 20 }),
  cursor: Object.freeze({ tier: 'pro', roles: Object.freeze(['executor']), models: Object.freeze(['composer 2.5', 'grok 4.6', 'kimi 3']), fallback_order: 30 }),
  // Devin gathers context for search only when a roster picks it.
  devin: Object.freeze({ tier: 'max', roles: Object.freeze(['executor']), roster_only_roles: Object.freeze(['navigator']), models: Object.freeze(['built-in router']), duty: 'errands', fallback_order: 40 }),
  grok: Object.freeze({ tier: 'pro', roles: Object.freeze(['executor']), models: Object.freeze(['grok 4.7 fast', 'grok 4.7']), fallback_order: 45 }),
  fable: Object.freeze({ tier: 'max', roles: Object.freeze(['validator', 'executor']), models: Object.freeze(['opus 5.5', 'opus 5', 'fable', 'haiku']), duty: 'leader', fallback_order: 50 }),
  composer: Object.freeze({ tier: 'fast', roles: Object.freeze(['navigator', 'executor']), models: Object.freeze(['composer 2.5']), fallback_order: 60 }),
  haiku: Object.freeze({ tier: 'fast', roles: Object.freeze(['validator', 'navigator']), roster_only_roles: Object.freeze(['navigator']), models: Object.freeze(['haiku']), fallback_order: 70 }),
  agy: Object.freeze({
    tier: 'pro',
    roles: Object.freeze(['executor']),
    models: Object.freeze([
      'gemini-3.8-flash-high',
      'gemini-3.7-flash-high',
      'gemini-3.1-pro-high',
      'claude-sonnet-4-6',
      'claude-opus-4-6-thinking',
      'gpt-oss-120b-medium',
    ]),
    duty: 'errands',
    fallback_order: 90,
  }),
  opencode: Object.freeze({ tier: 'pro', roles: Object.freeze(['executor']), models: Object.freeze(['opencode/big-pickle', 'opencode/claude-opus-5-5', 'opencode/gpt-5.2']), fallback_order: 95 }),
  commandcode: Object.freeze({
    tier: 'max',
    roles: Object.freeze(['validator', 'executor']),
    // No pinned model: the engine rides this machine's Command Code default.
    models: Object.freeze(['machine default']),
    duty: 'errands',
    fallback_order: 98,
  }),
});

function engineRegistryFile(root = process.cwd()) {
  return path.join(root, '.atris', 'state', 'engines.json');
}

// A scratch folder is not a room. First-touch seed must not mint .atris/.
// Updates stay allowed once the file or a real workspace already exists.
function canPersistEngineRegistry(root = process.cwd()) {
  if (fs.existsSync(engineRegistryFile(root))) return true;
  return fs.existsSync(path.join(root, 'atris'))
    || fs.existsSync(path.join(root, '.atris', 'business.json'));
}

// Machine probe. Routing never calls this on a settled registry: it runs once
// when an engine first appears (seeding the policy file), at the execution
// stage right before a spawn, and on the explicit `atris engine doctor`.
function binInstalled(bin) {
  const safe = String(bin || '').replace(/[^A-Za-z0-9_.-]/g, '');
  if (!safe) return false;
  const probe = childProcess.spawnSync('sh', ['-c', `command -v ${safe}`], { encoding: 'utf8' });
  return probe.status === 0 && Boolean(String(probe.stdout || '').trim());
}

function canonicalEngineName(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return '';
  if (RUNNER_PROFILE_DEFS[trimmed]) return trimmed;
  if (RUNNER_PROFILE_ALIASES[trimmed]) return RUNNER_PROFILE_ALIASES[trimmed];
  return '';
}

function readRawRegistry(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(parsed)) return { engines: parsed };
    if (parsed && Array.isArray(parsed.engines)) return parsed;
  } catch {}
  return { engines: [] };
}

function normalizeTier(value, fallback = 'pro') {
  const tier = String(value || '').trim();
  return ENGINE_TIERS.includes(tier) ? tier : fallback;
}

function normalizeRoles(value, fallback = ['executor']) {
  const roles = Array.isArray(value) ? value.map((role) => String(role || '').trim()) : [];
  const filtered = roles.filter((role, index) => ENGINE_ROLES.includes(role) && roles.indexOf(role) === index);
  return filtered.length ? filtered : fallback;
}

function normalizeModels(value, fallback = []) {
  const models = Array.isArray(value) ? value.map((model) => String(model || '').trim()) : [];
  const filtered = models.filter((model, index) => model && models.indexOf(model) === index);
  return filtered.length ? filtered : fallback;
}

function normalizeDuty(value, fallback = '') {
  if (value === undefined) return fallback || '';
  const duty = String(value || '').trim();
  return ENGINE_DUTIES.includes(duty) ? duty : '';
}

function normalizeFallbackOrder(value, fallback) {
  const order = Number(value);
  return Number.isInteger(order) ? order : fallback;
}

function normalizeEngineEntry(id, saved = {}, now) {
  const def = RUNNER_PROFILE_DEFS[id];
  const seed = ENGINE_SEED_META[id] || { tier: 'pro', roles: ['executor'], models: [id], fallback_order: 100 };
  const savedHealth = saved && saved.health && typeof saved.health === 'object' ? saved.health : {};
  const savedStatus = String(savedHealth.status || '').trim();
  // Policy over probes: a saved health status is the routing truth, verbatim.
  // Only an engine the registry has never seen gets one seeding probe; after
  // that, installed-state changes flow through `atris engine doctor` (or
  // `atris engine health`), never through the resolve path.
  let status;
  let installed;
  if (ENGINE_HEALTH_STATUSES.includes(savedStatus)) {
    status = savedStatus;
    installed = typeof saved.installed === 'boolean' ? saved.installed : status !== 'not_installed';
  } else {
    installed = binInstalled(def.bin);
    status = installed ? 'ready' : 'not_installed';
  }
  let health = { status };
  if (status !== 'ready' && savedHealth.last_failure_ts) health.last_failure_ts = String(savedHealth.last_failure_ts);
  if (status === 'cooling') {
    // A cooldown that has passed reads as ready, so the engine comes back
    // with no human step.
    if (engineCooling({ health: savedHealth }, now)) {
      health.cooling_until = String(savedHealth.cooling_until);
      if (savedHealth.cooling_reason) health.cooling_reason = String(savedHealth.cooling_reason);
    } else {
      health = { status: 'ready' };
    }
  }
  return {
    ...saved,
    id,
    name: id,
    bin: def.bin,
    tier: normalizeTier(saved.tier, seed.tier),
    roles: normalizeRoles(saved.roles, Array.from(seed.roles)),
    // The seed model list is the live catalog and always wins on read, unless
    // the owner set models on purpose: `atris engine set --models` saves
    // models_set_by_owner next to the list. A list copied in at seed time has
    // no mark, so it thaws to the current seed instead of pinning stale names.
    models: saved.models_set_by_owner === true
      ? normalizeModels(saved.models, Array.from(seed.models))
      : Array.from(seed.models),
    duty: normalizeDuty(saved.duty, seed.duty),
    fallback_order: normalizeFallbackOrder(saved.fallback_order, seed.fallback_order),
    installed,
    health,
  };
}

// Saved entries by engine id; a later entry for the same engine wins.
function savedEnginesById(raw, keep = () => true) {
  const savedById = new Map();
  for (const entry of raw.engines || []) {
    const id = canonicalEngineName(entry && (entry.id || entry.name));
    if (id && keep(id)) savedById.set(id, entry);
  }
  return savedById;
}

function seededRegistry(root = process.cwd(), preloadedRaw = null, now) {
  const raw = preloadedRaw || readRawRegistry(engineRegistryFile(root));
  const savedById = savedEnginesById(raw);
  return {
    ...raw,
    schema: ENGINE_REGISTRY_SCHEMA,
    updated_at: new Date().toISOString(),
    // Hidden profiles are registered engines too: they seed, route, and take
    // health policy exactly like visible ones.
    engines: Object.keys(RUNNER_PROFILE_DEFS).map((id) => normalizeEngineEntry(id, savedById.get(id) || {}, now)),
  };
}

function writeEngineRegistry(root, registry) {
  const file = engineRegistryFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Atomic write: a concurrent reader must never see a torn file, because a
  // failed parse falls back to the seed registry and erases operator policy.
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function setEngineOverrides(name, overrides = {}, root = process.cwd()) {
  const id = canonicalEngineName(name);
  const knownIds = Object.keys(RUNNER_PROFILE_DEFS).filter((engineId) => ENGINE_SEED_META[engineId]);
  if (!id || !knownIds.includes(id)) {
    throw new Error(`Unknown engine "${name}". Known engines: ${knownIds.join(', ')}`);
  }

  const nextOverrides = {};
  if (Object.prototype.hasOwnProperty.call(overrides, 'duty')) {
    const duty = String(overrides.duty || '').trim();
    if (!ENGINE_DUTIES.includes(duty)) {
      throw new Error(`Unknown duty "${overrides.duty}". Known duties: ${ENGINE_DUTIES.join(', ')}`);
    }
    nextOverrides.duty = duty;
  }
  if (Object.prototype.hasOwnProperty.call(overrides, 'models')) {
    const models = normalizeModels(overrides.models, []);
    if (!models.length) throw new Error('models must include at least one name');
    nextOverrides.models = models;
    nextOverrides.models_set_by_owner = true;
  }
  if (!Object.keys(nextOverrides).length) throw new Error('set requires --duty or --models');

  const raw = readRawRegistry(engineRegistryFile(root));
  const savedById = savedEnginesById(raw, (savedId) => knownIds.includes(savedId));

  if (nextOverrides.duty === 'leader' || nextOverrides.duty === 'learning') {
    for (const engineId of knownIds) {
      if (engineId === id) continue;
      const saved = savedById.get(engineId) || {};
      const effectiveDuty = Object.prototype.hasOwnProperty.call(saved, 'duty')
        ? normalizeDuty(saved.duty, '')
        : normalizeDuty(undefined, ENGINE_SEED_META[engineId].duty);
      if (effectiveDuty === nextOverrides.duty) {
        savedById.set(engineId, { ...saved, id: engineId, name: engineId, duty: '' });
      }
    }
  }

  const saved = savedById.get(id) || {};
  savedById.set(id, { ...saved, id, name: id, ...nextOverrides });
  const ordered = knownIds.map((engineId) => savedById.get(engineId)).filter(Boolean);
  const next = {
    ...raw,
    schema: ENGINE_REGISTRY_SCHEMA,
    updated_at: new Date().toISOString(),
    engines: ordered,
  };
  writeEngineRegistry(root, next);
  return { id, ...nextOverrides };
}

// A read only writes when normalization actually changed the saved engines
// (first seed, schema drift) and this folder is already a room or already
// has engines.json. Empty scratch stays empty. Settled registries stay
// untouched, so read paths cannot stomp a mutation another process just
// landed. The comparison uses the same raw snapshot the seed was built from:
// one read, one decision.
function readEngineRegistry(root = process.cwd(), options = {}) {
  const raw = readRawRegistry(engineRegistryFile(root));
  const registry = seededRegistry(root, raw, options.now);
  const needsPersist = JSON.stringify(raw.engines || []) !== JSON.stringify(registry.engines);
  if (options.persist !== false && needsPersist && canPersistEngineRegistry(root)) {
    writeEngineRegistry(root, registry);
  }
  return registry;
}



// A registry saved before an engine learned a job keeps its old role list;
// the roster still honors the job the engine can do today, including a job
// it only takes by roster pick.
function engineHasRole(engine, role) {
  if (!engine) return false;
  if (Array.isArray(engine.roles) && engine.roles.includes(role)) return true;
  const seed = ENGINE_SEED_META[engine.id];
  return Boolean(seed && (seed.roles.includes(role) || (seed.roster_only_roles && seed.roster_only_roles.includes(role))));
}

// A job this engine only takes by roster pick. Read from the seed, so a
// registry saved with the role behaves the same as a fresh one.
function routerSkipsRole(engine, role) {
  const seed = engine && ENGINE_SEED_META[engine.id];
  return Boolean(seed && seed.roster_only_roles && seed.roster_only_roles.includes(role));
}

function engineRegistryView(root = process.cwd()) {
  return readEngineRegistry(root).engines;
}


function resolveRegisteredEngine(name, root = process.cwd()) {
  const requested = String(name || '').trim();
  const id = canonicalEngineName(requested);
  const engines = engineRegistryView(root);
  const knownIds = engines.map((engine) => engine.id);
  const engine = id ? engines.find((entry) => entry.id === id) : null;
  if (!engine) {
    throw new Error(`Unknown engine "${requested}". Registered engine ids: ${knownIds.join(', ')}`);
  }
  return engine;
}

const ROSTER_PIN_FIELDS = Object.freeze(['roster_model', 'roster_effort', 'roster_max_seconds', 'roster_prep']);

function resolveEngineForRoleRanked(role, root = process.cwd(), options = {}) {
  const normalizedRole = String(role || '').trim().toLowerCase();
  if (!ENGINE_ROLES.includes(normalizedRole)) {
    throw new Error(`Unknown role "${role}". Known roles: ${ENGINE_ROLES.join(', ')}`);
  }
  const registry = readEngineRegistry(root, { now: options.now });
  const engines = registry.engines
    .filter((engine) => engine.roles.includes(normalizedRole))
    .filter((engine) => !routerSkipsRole(engine, normalizedRole))
    .filter((engine) => engineReadyAt(engine, options.now))
    .sort((a, b) => {
      const byOrder = Number(a.fallback_order) - Number(b.fallback_order);
      return byOrder || String(a.id).localeCompare(String(b.id));
    });
  // Ranking reads the router's history off disk (task receipts, mission
  // events, dispatch receipts). A valid roster pick decides without it, so
  // rank only when something asks for the full ranked list.
  let rankedCache = null;
  const rank = () => {
    if (!rankedCache) {
      rankedCache = routerBrain.rankEnginesDetailed(engines, {
        root,
        taskType: options.taskType || options.task_type || normalizedRole,
        lowStakes: options.lowStakes,
        stakes: options.stakes,
      });
    }
    return rankedCache;
  };
  const { rosterChoice, withProjectRoster } = require('./roster');
  const choice = rosterChoice(normalizedRole, withProjectRoster(registry, root, options), options);
  if (choice) {
    // The job's own workers go first, in order, then the router's list.
    const after = choice.walk.slice(choice.lead_index + 1).filter((step) => !step.skip).map((step) => step.raw);
    const lead = [choice.engine, ...after].filter((engine, index, list) => list.findIndex((other) => other.id === engine.id) === index);
    const leadIds = new Set(lead.map((engine) => engine.id));
    const result = {
      engine: choice.engine,
      reason: choice.reason,
      source: choice.source,
      job: choice.job,
      team: choice.team,
    };
    let rankedList = null;
    Object.defineProperty(result, 'ranked', {
      enumerable: true,
      configurable: true,
      get() {
        if (!rankedList) rankedList = [...lead, ...rank().candidates.filter((candidate) => !leadIds.has(candidate.id))];
        return rankedList;
      },
      set(value) {
        rankedList = value;
      },
    });
    return result;
  }
  const ranked = rank();
  return { engine: ranked.candidates[0] || null, reason: routerPickExplanation(ranked), source: 'router', team: [], ranked: ranked.candidates };
}

function resolveEngineForRole(role, root = process.cwd(), options = {}) {
  const picked = resolveEngineForRoleRanked(role, root, options);
  // every pick logs one plain sentence saying which engine won and why;
  // set ATRIS_ROUTER_EXPLAIN=0 to silence it in quiet contexts.
  if (picked.engine && picked.reason && process.env.ATRIS_ROUTER_EXPLAIN !== '0') {
    console.error(picked.reason);
  }
  return picked.engine;
}

// Everything the roster pins on this job's live pick when that pick is this
// exact engine: roster_model, roster_effort, roster_max_seconds, roster_prep.
// {} otherwise.
// A caller that already chose an engine (a mission's preferred engine,
// --engine) still gets the pins.
function rosterPinFor(role, engineId, root = process.cwd(), options = {}) {
  const normalizedRole = String(role || '').trim().toLowerCase();
  if (!ENGINE_ROLES.includes(normalizedRole) || !engineId) return {};
  const { rosterChoice, withProjectRoster } = require('./roster');
  const choice = rosterChoice(normalizedRole, withProjectRoster(readEngineRegistry(root, { persist: false }), root, options), options);
  if (!choice || choice.engine.id !== engineId) return {};
  const pin = {};
  for (const field of ROSTER_PIN_FIELDS) {
    if (choice.engine[field]) pin[field] = choice.engine[field];
  }
  return pin;
}

function resolveEngineForRoleWithPreference(role, root = process.cwd(), preferredEngineId = '', options = {}) {
  const requested = String(preferredEngineId || '').trim();
  if (!requested) {
    return {
      engine: resolveEngineForRole(role, root, options),
      requested_engine: null,
      engine_fallback_reason: null,
    };
  }
  const preferred = resolveRegisteredEngine(requested, root);
  if (engineReadyAt(preferred, options.now)) {
    const pin = rosterPinFor(role, preferred.id, root, options);
    return {
      engine: Object.keys(pin).length ? { ...preferred, ...pin } : preferred,
      requested_engine: preferred.id,
      engine_fallback_reason: null,
    };
  }
  const fallback = resolveEngineForRole(role, root, options);
  const status = preferred.health && preferred.health.status ? preferred.health.status : 'unknown';
  return {
    engine: fallback,
    requested_engine: preferred.id,
    engine_fallback_reason: `Requested engine ${preferred.id} is not ready (${status}); fell back to ${fallback ? fallback.id : 'no ready executor'}.`,
  };
}

function setEngineHealth(name, status, root = process.cwd()) {
  const id = canonicalEngineName(name);
  if (!id) {
    throw new Error(`Unknown engine "${name}". Known engines: ${RUNNER_PROFILE_NAMES.join(', ')}`);
  }
  const normalizedStatus = String(status || '').trim();
  if (!ENGINE_HEALTH_STATUSES.includes(normalizedStatus)) {
    throw new Error(`Unknown health "${status}". Known health statuses: ${ENGINE_HEALTH_STATUSES.join(', ')}`);
  }
  if (normalizedStatus === 'cooling') return setEngineCooling(id, { root });
  const health = { status: normalizedStatus };
  if (normalizedStatus !== 'ready') health.last_failure_ts = new Date().toISOString();
  return writeEngineHealth(root, id, health);
}

// Save one engine's health and hand back that engine.
function writeEngineHealth(root, id, health, { now, at = Date.now() } = {}) {
  const registry = readEngineRegistry(root, { persist: false, now });
  const engines = registry.engines.map((engine) => (engine.id === id ? { ...engine, health } : engine));
  writeEngineRegistry(root, { ...registry, updated_at: new Date(at).toISOString(), engines });
  return engines.find((engine) => engine.id === id);
}

// Bench an engine after a stall: it is not ready until the cooldown passes,
// so every resolver hands its jobs to the roster's next worker meanwhile.
function setEngineCooling(name, { root = process.cwd(), now, reason = 'stalled', minutes } = {}) {
  const id = canonicalEngineName(name);
  if (!id) throw new Error(`Unknown engine "${name}". Known engines: ${RUNNER_PROFILE_NAMES.join(', ')}`);
  const at = nowMs(now);
  const ms = Number(minutes) > 0 ? Number(minutes) * 60000 : engineCooldownMs();
  return writeEngineHealth(root, id, {
    status: 'cooling',
    last_failure_ts: new Date(at).toISOString(),
    cooling_until: new Date(at + ms).toISOString(),
    cooling_reason: String(reason || 'stalled'),
  }, { now, at });
}

// "cooling until 14:32 (stalled)" for the roster and engine views.
function coolingView(engine) {
  const health = (engine && engine.health) || {};
  const until = new Date(health.cooling_until);
  const clock = Number.isFinite(until.getTime())
    ? `${String(until.getHours()).padStart(2, '0')}:${String(until.getMinutes()).padStart(2, '0')}`
    : 'later';
  const reason = String(health.cooling_reason || 'stalled');
  return { until: health.cooling_until || null, reason, text: `cooling until ${clock} (${reason})` };
}

// The one health write for a finished run: a stall benches the engine for
// the cooldown, a credit wall or a missing binary writes its own status, and
// a real task failure changes nothing. Returns the updated engine, or null.
function recordEngineRunHealth(engineId, result, root = process.cwd(), { ok = false, now } = {}) {
  if (!engineId) return null;
  if (ok) return setEngineHealth(engineId, 'ready', root);
  const status = engineFailureHealthStatus({ ...result, status: 'errored' });
  if (status === 'error') {
    const stall = engineStallReason(result);
    if (stall) return setEngineCooling(engineId, { root, now, reason: stall.kind === 'transient' ? 'connection dropped' : 'stalled' });
  }
  return status ? setEngineHealth(engineId, status, root) : null;
}

// Execution-stage guard. Routing hands out engines from policy without ever
// touching the machine, so the moment we are about to spawn one is where a
// missing binary has to fail loudly, in one plain sentence naming the binary.
function requireEngineBin(engineOrId) {
  const id = typeof engineOrId === 'string'
    ? canonicalEngineName(engineOrId)
    : canonicalEngineName(engineOrId && engineOrId.id);
  const def = RUNNER_PROFILE_DEFS[id];
  if (!def) {
    throw new Error(`Unknown engine "${engineOrId && engineOrId.id ? engineOrId.id : engineOrId}". Known engines: ${RUNNER_PROFILE_NAMES.join(', ')}`);
  }
  if (!binInstalled(def.bin)) {
    throw new Error(`${id} CLI (${def.bin}) is not installed here, so this run cannot start.`);
  }
  return def.bin;
}

// The explicit opt-in probe pass: check every engine binary on this machine,
// fold the result back into the policy file (a ready/not_installed flip only;
// credit_out and error are operator policy and survive), and report.
function engineDoctorReport(root = process.cwd()) {
  const registry = readEngineRegistry(root, { persist: false });
  const engines = registry.engines.map((engine) => {
    const installed = binInstalled(engine.bin);
    let health = engine.health && engine.health.status ? engine.health : { status: installed ? 'ready' : 'not_installed' };
    if (installed && health.status === 'not_installed') health = { status: 'ready' };
    if (!installed && health.status === 'ready') health = { status: 'not_installed' };
    return { ...engine, installed, health };
  });
  const next = { ...registry, updated_at: new Date().toISOString(), engines };
  writeEngineRegistry(root, next);
  return engines;
}

module.exports = {
  ENGINE_ROLES,
  ENGINE_DUTIES,
  ENGINE_HEALTH_STATUSES,
  ROSTER_PIN_FIELDS,
  engineRegistryFile,
  binInstalled,
  canonicalEngineName,
  readEngineRegistry,
  writeEngineRegistry,
  requireEngineBin,
  engineDoctorReport,
  engineRegistryView,
  engineHasRole,
  resolveRegisteredEngine,
  resolveEngineForRoleRanked,
  resolveEngineForRole,
  resolveEngineForRoleWithPreference,
  rosterPinFor,
  engineFailureHealthStatus,
  engineStallReason,
  engineReadyAt,
  engineCooling,
  coolingView,
  recordEngineRunHealth,
  setEngineOverrides,
  setEngineHealth,
};
