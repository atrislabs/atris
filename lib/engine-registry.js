'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  RUNNER_PROFILE_DEFS,
  RUNNER_PROFILE_ALIASES,
  RUNNER_PROFILE_NAMES,
} = require('./runner-command');

const ENGINE_REGISTRY_SCHEMA = 'atris.engine_registry.v2';
const ENGINE_TIERS = Object.freeze(['fast', 'pro', 'max']);
const ENGINE_ROLES = Object.freeze(['navigator', 'executor', 'validator']);
const ENGINE_HEALTH_STATUSES = Object.freeze(['ready', 'not_installed', 'credit_out', 'error']);

const ENGINE_SEED_META = Object.freeze({
  'atris-fast': Object.freeze({ tier: 'fast', roles: Object.freeze(['navigator']), fallback_order: 10 }),
  codex: Object.freeze({ tier: 'pro', roles: Object.freeze(['executor']), fallback_order: 10 }),
  claude: Object.freeze({ tier: 'max', roles: Object.freeze(['validator', 'executor']), fallback_order: 20 }),
  cursor: Object.freeze({ tier: 'pro', roles: Object.freeze(['executor']), fallback_order: 30 }),
  devin: Object.freeze({ tier: 'max', roles: Object.freeze(['executor']), fallback_order: 40 }),
  grok: Object.freeze({ tier: 'pro', roles: Object.freeze(['executor']), fallback_order: 45 }),
  fable: Object.freeze({ tier: 'max', roles: Object.freeze(['validator', 'executor']), fallback_order: 50 }),
  composer: Object.freeze({ tier: 'fast', roles: Object.freeze(['navigator', 'executor']), fallback_order: 60 }),
  haiku: Object.freeze({ tier: 'fast', roles: Object.freeze(['validator']), fallback_order: 70 }),
  hermes: Object.freeze({ tier: 'pro', roles: Object.freeze(['executor']), fallback_order: 80 }),
  droid: Object.freeze({ tier: 'pro', roles: Object.freeze(['executor']), fallback_order: 90 }),
});

function engineRegistryFile(root = process.cwd()) {
  return path.join(root, '.atris', 'state', 'engines.json');
}

function binInstalled(bin) {
  const safe = String(bin || '').replace(/[^A-Za-z0-9_.-]/g, '');
  if (!safe) return false;
  const probe = spawnSync('sh', ['-c', `command -v ${safe}`], { encoding: 'utf8' });
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

function normalizeFallbackOrder(value, fallback) {
  const order = Number(value);
  return Number.isInteger(order) ? order : fallback;
}

function normalizeEngineEntry(id, saved = {}) {
  const def = RUNNER_PROFILE_DEFS[id];
  const seed = ENGINE_SEED_META[id] || { tier: 'pro', roles: ['executor'], fallback_order: 100 };
  const installed = binInstalled(def.bin);
  const savedHealth = saved && saved.health && typeof saved.health === 'object' ? saved.health : {};
  const savedStatus = String(savedHealth.status || '').trim();
  const savedFailure = savedStatus === 'credit_out'
    || savedStatus === 'error'
    || (savedStatus === 'not_installed' && Boolean(savedHealth.last_failure_ts));
  const status = savedFailure ? savedStatus : (installed ? 'ready' : 'not_installed');
  const health = { status };
  if (savedFailure && savedHealth.last_failure_ts) health.last_failure_ts = String(savedHealth.last_failure_ts);
  return {
    id,
    name: id,
    bin: def.bin,
    tier: normalizeTier(saved.tier, seed.tier),
    roles: normalizeRoles(saved.roles, Array.from(seed.roles)),
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

function resolveEngineForRole(role, root = process.cwd()) {
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
  return engines[0] || null;
}

function resolveEngineForRoleWithPreference(role, root = process.cwd(), preferredEngineId = '') {
  const requested = String(preferredEngineId || '').trim();
  if (!requested) {
    return {
      engine: resolveEngineForRole(role, root),
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
  const fallback = resolveEngineForRole(role, root);
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

module.exports = {
  ENGINE_REGISTRY_SCHEMA,
  ENGINE_TIERS,
  ENGINE_ROLES,
  ENGINE_HEALTH_STATUSES,
  engineRegistryFile,
  binInstalled,
  canonicalEngineName,
  readEngineRegistry,
  engineRegistryView,
  registeredEngineIds,
  resolveRegisteredEngine,
  resolveEngineForRole,
  resolveEngineForRoleWithPreference,
  setEngineHealth,
};
