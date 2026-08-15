'use strict';

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const {
  RUNNER_PROFILE_DEFS,
  RUNNER_PROFILE_ALIASES,
  RUNNER_PROFILE_NAMES,
} = require('./runner-command');
const { rankEnginesDetailed, routerPickExplanation } = require('./router-brain');

const ENGINE_REGISTRY_SCHEMA = 'atris.engine_registry.v2';
const ENGINE_TIERS = Object.freeze(['fast', 'pro', 'max']);
const ENGINE_ROLES = Object.freeze(['navigator', 'executor', 'validator']);
const ENGINE_DUTIES = Object.freeze(['leader', 'errands', 'learning']);
const ENGINE_HEALTH_STATUSES = Object.freeze(['ready', 'not_installed', 'credit_out', 'error']);

function engineFailureHealthStatus(result) {
  if (!result || result.status !== 'errored') return null;
  const signalText = [
    result.reason,
    result.model_unavailable,
    result.report,
    result.stdout,
    result.stderr,
    result.error,
    result.claude && result.claude.summary,
    result.claude && result.claude.receipt_text,
    result.claude && result.claude.stderr,
    result.rate_limit_info && JSON.stringify(result.rate_limit_info),
  ].filter(Boolean).join('\n').toLowerCase();
  if (/usage[ _-]?limit|purchase more credits|insufficient credits|credit(?:s)?[ _-]?(?:out|limit)|rate[ _-]?limit|not authenticated|please log in|login required|auth(?:entication)?[ _-]?expired|payment required|subscription/.test(signalText)) {
    return 'credit_out';
  }
  if (/timeout|model-unavailable/.test(signalText)) return 'not_installed';
  return 'error';
}

const ENGINE_SEED_META = Object.freeze({
  'atris-fast': Object.freeze({ tier: 'fast', roles: Object.freeze(['navigator']), models: Object.freeze(['atris fast']), duty: 'learning', fallback_order: 10 }),
  codex: Object.freeze({ tier: 'pro', roles: Object.freeze(['executor']), models: Object.freeze(['codex']), fallback_order: 10 }),
  claude: Object.freeze({ tier: 'max', roles: Object.freeze(['validator', 'executor']), models: Object.freeze(['opus 5', 'opus 4.8', 'fable', 'haiku']), fallback_order: 20 }),
  cursor: Object.freeze({ tier: 'pro', roles: Object.freeze(['executor']), models: Object.freeze(['composer 2.5', 'grok 4.6', 'kimi 3']), fallback_order: 30 }),
  devin: Object.freeze({ tier: 'max', roles: Object.freeze(['executor']), models: Object.freeze(['built-in router']), duty: 'errands', fallback_order: 40 }),
  grok: Object.freeze({ tier: 'pro', roles: Object.freeze(['executor']), models: Object.freeze(['grok 4.6', 'grok 4.5']), fallback_order: 45 }),
  fable: Object.freeze({ tier: 'max', roles: Object.freeze(['validator', 'executor']), models: Object.freeze(['opus 5', 'opus 4.8', 'fable', 'haiku']), duty: 'leader', fallback_order: 50 }),
  composer: Object.freeze({ tier: 'fast', roles: Object.freeze(['navigator', 'executor']), models: Object.freeze(['composer 2.5']), fallback_order: 60 }),
  haiku: Object.freeze({ tier: 'fast', roles: Object.freeze(['validator']), models: Object.freeze(['haiku']), fallback_order: 70 }),
  droid: Object.freeze({ tier: 'pro', roles: Object.freeze(['executor']), models: Object.freeze(['built-in router']), duty: 'errands', fallback_order: 90 }),
});

function engineRegistryFile(root = process.cwd()) {
  return path.join(root, '.atris', 'state', 'engines.json');
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

function normalizeEngineEntry(id, saved = {}) {
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
  const health = { status };
  if (status !== 'ready' && savedHealth.last_failure_ts) health.last_failure_ts = String(savedHealth.last_failure_ts);
  return {
    id,
    name: id,
    bin: def.bin,
    tier: normalizeTier(saved.tier, seed.tier),
    roles: normalizeRoles(saved.roles, Array.from(seed.roles)),
    models: normalizeModels(saved.models, Array.from(seed.models)),
    duty: normalizeDuty(saved.duty, seed.duty),
    fallback_order: normalizeFallbackOrder(saved.fallback_order, seed.fallback_order),
    installed,
    health,
  };
}

function seededRegistry(root = process.cwd()) {
  const file = engineRegistryFile(root);
  const raw = readRawRegistry(file);
  const savedById = new Map();
  for (const entry of raw.engines || []) {
    const id = canonicalEngineName(entry && (entry.id || entry.name));
    if (id) savedById.set(id, entry);
  }
  return {
    schema: ENGINE_REGISTRY_SCHEMA,
    updated_at: new Date().toISOString(),
    engines: RUNNER_PROFILE_NAMES.map((id) => normalizeEngineEntry(id, savedById.get(id) || {})),
  };
}

function writeEngineRegistry(root, registry) {
  const file = engineRegistryFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
}

function setEngineOverrides(name, overrides = {}, root = process.cwd()) {
  const id = canonicalEngineName(name);
  const knownIds = RUNNER_PROFILE_NAMES.filter((engineId) => ENGINE_SEED_META[engineId]);
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
  }
  if (!Object.keys(nextOverrides).length) throw new Error('set requires --duty or --models');

  const file = engineRegistryFile(root);
  const raw = readRawRegistry(file);
  const savedById = new Map();
  for (const entry of raw.engines || []) {
    const savedId = canonicalEngineName(entry && (entry.id || entry.name));
    if (savedId && knownIds.includes(savedId)) savedById.set(savedId, entry);
  }

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

function readEngineRegistry(root = process.cwd(), options = {}) {
  const registry = seededRegistry(root);
  if (options.persist !== false) writeEngineRegistry(root, registry);
  return registry;
}

function engineRegistryView(root = process.cwd()) {
  return readEngineRegistry(root).engines;
}

function registeredEngineIds(root = process.cwd()) {
  return engineRegistryView(root).map((engine) => engine.id);
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

function resolveEngineForRoleRanked(role, root = process.cwd(), options = {}) {
  const normalizedRole = String(role || '').trim().toLowerCase();
  if (!ENGINE_ROLES.includes(normalizedRole)) {
    throw new Error(`Unknown role "${role}". Known roles: ${ENGINE_ROLES.join(', ')}`);
  }
  const engines = engineRegistryView(root)
    .filter((engine) => engine.roles.includes(normalizedRole))
    .filter((engine) => engine.health && engine.health.status === 'ready')
    .sort((a, b) => {
      const byOrder = Number(a.fallback_order) - Number(b.fallback_order);
      return byOrder || String(a.id).localeCompare(String(b.id));
    });
  const ranked = rankEnginesDetailed(engines, {
    root,
    taskType: options.taskType || options.task_type || normalizedRole,
    lowStakes: options.lowStakes,
    stakes: options.stakes,
  });
  return {
    engine: ranked.candidates[0] || null,
    reason: routerPickExplanation(ranked),
    ranked: ranked.candidates,
  };
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
  if (preferred.health && preferred.health.status === 'ready') {
    return {
      engine: preferred,
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
  const registry = readEngineRegistry(root, { persist: false });
  const engines = registry.engines.map((engine) => {
    if (engine.id !== id) return engine;
    const health = { status: normalizedStatus };
    if (normalizedStatus !== 'ready') health.last_failure_ts = new Date().toISOString();
    return { ...engine, health };
  });
  const next = { ...registry, updated_at: new Date().toISOString(), engines };
  writeEngineRegistry(root, next);
  return engines.find((engine) => engine.id === id);
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
  engineRegistryFile,
  binInstalled,
  canonicalEngineName,
  readEngineRegistry,
  requireEngineBin,
  engineDoctorReport,
  engineRegistryView,
  resolveRegisteredEngine,
  resolveEngineForRoleRanked,
  resolveEngineForRole,
  resolveEngineForRoleWithPreference,
  engineFailureHealthStatus,
  setEngineOverrides,
  setEngineHealth,
};
