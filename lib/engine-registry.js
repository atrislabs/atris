'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const {
  RUNNER_PROFILE_DEFS,
  RUNNER_PROFILE_ALIASES,
  RUNNER_PROFILE_NAMES,
  HIDDEN_PROFILE_NAMES,
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
  if (/not installed|command not found|\benoent\b/.test(signalText)) return 'not_installed';
  // Timeouts and unavailable models are transient: 'error' keeps the engine
  // routable, while 'not_installed' would drop it from routing until a doctor run.
  return 'error';
}

const ENGINE_SEED_META = Object.freeze({
  'atris-fast': Object.freeze({ tier: 'fast', roles: Object.freeze(['navigator']), models: Object.freeze(['atris fast']), duty: 'learning', fallback_order: 10 }),
  // roster_only_roles: jobs a roster pick may give this engine, but the router
  // never hands it on its own. Claude and haiku can own search when picked;
  // with no pick, search stays with atris-fast, then composer. Codex can own
  // review when picked; it stays out of roles, so every review list built
  // from roles (the router, one lap, wish audit, the chart) is unchanged.
  codex: Object.freeze({ tier: 'pro', roles: Object.freeze(['executor']), roster_only_roles: Object.freeze(['validator']), models: Object.freeze(['codex']), fallback_order: 10 }),
  claude: Object.freeze({ tier: 'max', roles: Object.freeze(['validator', 'executor', 'navigator']), roster_only_roles: Object.freeze(['navigator']), models: Object.freeze(['opus 5.5', 'opus 5', 'opus 4.8', 'fable', 'haiku']), fallback_order: 20 }),
  cursor: Object.freeze({ tier: 'pro', roles: Object.freeze(['executor']), models: Object.freeze(['composer 2.5', 'grok 4.6', 'kimi 3']), fallback_order: 30 }),
  devin: Object.freeze({ tier: 'max', roles: Object.freeze(['executor']), models: Object.freeze(['built-in router']), duty: 'errands', fallback_order: 40 }),
  grok: Object.freeze({ tier: 'pro', roles: Object.freeze(['executor']), models: Object.freeze(['grok 4.7 fast', 'grok 4.7']), fallback_order: 45 }),
  fable: Object.freeze({ tier: 'max', roles: Object.freeze(['validator', 'executor']), models: Object.freeze(['opus 5.5', 'opus 5', 'opus 4.8', 'fable', 'haiku']), duty: 'leader', fallback_order: 50 }),
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
  opencode: Object.freeze({ tier: 'pro', roles: Object.freeze(['executor']), models: Object.freeze(['opencode/big-pickle', 'opencode/claude-opus-4-8', 'opencode/gpt-5.2']), fallback_order: 95 }),
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
    ...saved,
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

function seededRegistry(root = process.cwd(), preloadedRaw = null) {
  const file = engineRegistryFile(root);
  const raw = preloadedRaw || readRawRegistry(file);
  const savedById = new Map();
  for (const entry of raw.engines || []) {
    const id = canonicalEngineName(entry && (entry.id || entry.name));
    if (id) savedById.set(id, entry);
  }
  return {
    ...raw,
    schema: ENGINE_REGISTRY_SCHEMA,
    updated_at: new Date().toISOString(),
    // Hidden profiles are registered engines too: they seed, route, and take
    // health policy exactly like visible ones.
    engines: Object.keys(RUNNER_PROFILE_DEFS).map((id) => normalizeEngineEntry(id, savedById.get(id) || {})),
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

// A read only writes when normalization actually changed the saved engines
// (first seed, schema drift) and this folder is already a room or already
// has engines.json. Empty scratch stays empty. Settled registries stay
// untouched, so read paths cannot stomp a mutation another process just
// landed. The comparison uses the same raw snapshot the seed was built from:
// one read, one decision.
function readEngineRegistry(root = process.cwd(), options = {}) {
  const raw = readRawRegistry(engineRegistryFile(root));
  const registry = seededRegistry(root, raw);
  const needsPersist = JSON.stringify(raw.engines || []) !== JSON.stringify(registry.engines);
  if (options.persist !== false && needsPersist && canPersistEngineRegistry(root)) {
    writeEngineRegistry(root, registry);
  }
  return registry;
}

const ENGINE_JOBS = Object.freeze({ search: 'navigator', build: 'executor', review: 'validator' });
const ENGINE_JOB_ALIASES = Object.freeze({ navigator: 'search', builder: 'build', executor: 'build', reviewer: 'review', validator: 'review' });
const MACHINE_ROSTER_SCHEMA = 'atris.machine_roster.v1';
// The owner's own job for small, tightly specified builds. A build resolved
// with lowStakes checks this pick first, then the plain build pick.
const SMALL_BUILD_JOB = 'small-build';

function rosterJob(name) {
  const job = String(name || '').trim().toLowerCase();
  return ENGINE_JOBS[job] ? job : ENGINE_JOB_ALIASES[job] || '';
}

// "Small Build!" and "small build" save under the same key, small-build.
function rosterJobSlug(name) {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// The roster key for any job name: the three built-in jobs keep their role
// keys (navigator, executor, validator), so every saved roster still reads
// the same; any other name is a custom job under its slug.
function rosterJobKey(name) {
  const builtIn = rosterJob(name);
  if (builtIn) return ENGINE_JOBS[builtIn];
  const slug = rosterJobSlug(name);
  return rosterJob(slug) ? ENGINE_JOBS[rosterJob(slug)] : slug;
}

function rosterJobLabel(key) {
  const builtIn = Object.keys(ENGINE_JOBS).find((job) => ENGINE_JOBS[job] === key);
  return builtIn || String(key || '').replace(/-/g, ' ');
}

// A name says its kind when exactly one of build, review, or search is a
// word in it: "small build" is a build, "deep review" is a review.
function inferJobKind(name) {
  const words = rosterJobSlug(name).split('-');
  const kinds = Object.keys(ENGINE_JOBS).filter((kind) => words.includes(kind));
  return kinds.length === 1 ? kinds[0] : '';
}

// The role a saved custom pick runs as, read from its like field. '' means
// the pick does not say a kind the roster knows, so it never routes.
function customPickRole(pick) {
  const kind = rosterJob(pick && pick.like);
  return kind ? ENGINE_JOBS[kind] : '';
}

// Only an object naming an engine counts as a pick; a hand edit that left a
// string or a list reads as no pick.
function rosterPickObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && value.engine ? value : null;
}

function pickRoleForKey(key, pick) {
  return ENGINE_ROLES.includes(key) ? key : customPickRole(pick);
}

// Custom job keys set in a roster, in saved order.
function customRosterJobKeys(roster) {
  return Object.keys(roster || {}).filter((key) => !ENGINE_ROLES.includes(key) && rosterPickObject(roster[key]));
}

// The role a job name resolves as: a built-in job's own role, else the kind
// saved on this project's pick, then the all-projects pick, then the name.
function rosterJobRole(name, root = process.cwd(), options = {}) {
  const key = rosterJobKey(name);
  if (!key) return '';
  if (ENGINE_ROLES.includes(key)) return key;
  const registry = readEngineRegistry(root, { persist: false });
  const machine = options.machineRosterPicks || readMachineRoster(options);
  const saved = [registry.roster && registry.roster[key], machine && machine[key]]
    .map(rosterPickObject)
    .map(customPickRole)
    .find(Boolean);
  if (saved) return saved;
  const kind = inferJobKind(name);
  return kind ? ENGINE_JOBS[kind] : '';
}

function rosterDate(now = new Date()) {
  const date = new Date(now);
  if (Number.isNaN(date.getTime())) throw new Error('invalid roster date');
  return date;
}

function localDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function localDayText(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// until dates are local calendar days, inclusive: a pick set until
// 2026-10-24 still holds all day on the 24th, wherever this machine is.
function rosterUntil(now, days) {
  const date = localDay(rosterDate(now));
  date.setDate(date.getDate() + days);
  return localDayText(date);
}

// Only a real YYYY-MM-DD calendar day counts. Anything else ("garbage",
// "2026-9-1", "9999", "2026-02-30") reads as already expired.
function parseRosterUntil(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date;
}

function rosterPickExpired(pick, now = new Date()) {
  const until = parseRosterUntil(pick && pick.until);
  if (!until) return true;
  return localDay(rosterDate(now)).getTime() > until.getTime();
}

// Claude-family engines run through the claude CLI, which rejects loose
// spellings like "opus-5.5". Assign saves the id the CLI accepts, and every
// read normalizes again, so older saved picks and hand edits work too.
const CLAUDE_FAMILY_ENGINES = Object.freeze(['claude', 'fable', 'haiku']);
const CLAUDE_MODEL_ALIASES = Object.freeze(['opus', 'sonnet', 'haiku', 'fable', 'opusplan', 'default']);
const CLAUDE_MODEL_DATED_IDS = Object.freeze({ 'claude-haiku-4-5': 'claude-haiku-4-5-20251001' });
const CLAUDE_MODEL_SPELLING = /^(opus|sonnet|haiku|fable)[\s_-]*(\d+)(?:[\s._-]+(\d+))?$/;
const CLAUDE_LONG_CONTEXT = /\s*\[1m\]$/;

// Grok takes friendly names too: "grok 4.7 fast" is grok-4.7-build-fast and
// "grok 4.7" is grok-4.7. Any full grok- id passes through as typed.
const GROK_MODEL_SPELLING = /^grok[\s_-]*(\d+(?:\.\d+)?)(?:[\s_-]+(?:build[\s_-]+)?(fast))?$/;

function normalizeGrokModel(raw) {
  const match = GROK_MODEL_SPELLING.exec(raw.toLowerCase());
  if (match) return `grok-${match[1]}${match[2] ? '-build-fast' : ''}`;
  if (/^grok-[a-z0-9][a-z0-9._-]*$/i.test(raw)) return raw;
  throw new Error(`grok does not know the model "${raw}". use grok 4.7 fast, grok 4.7, or a full grok- id`);
}

function normalizeRosterModel(engineId, value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (engineId === 'grok') return normalizeGrokModel(raw);
  if (!CLAUDE_FAMILY_ENGINES.includes(engineId)) return raw;
  // "[1m]" asks the claude cli for the long context window; keep it on
  // whatever name it follows.
  const suffix = CLAUDE_LONG_CONTEXT.test(raw) ? '[1m]' : '';
  const base = raw.replace(CLAUDE_LONG_CONTEXT, '').trim();
  const lower = base.toLowerCase();
  if (CLAUDE_MODEL_ALIASES.includes(lower)) return `${lower}${suffix}`;
  const match = CLAUDE_MODEL_SPELLING.exec(lower.replace(/^claude[\s_-]*/, ''));
  if (match) {
    const id = `claude-${match[1]}-${match[2]}${match[3] ? `-${match[3]}` : ''}`;
    return `${CLAUDE_MODEL_DATED_IDS[id] || id}${suffix}`;
  }
  if (lower.startsWith('claude-')) return `${base}${suffix}`;
  throw new Error(`${engineId} does not know the model "${raw}". use opus, sonnet, haiku, fable, opusplan, default, a version like opus 5.5, sonnet 5, haiku 4.5, or fable 5.1, or a full claude- id; add [1m] for the long context window`);
}

// A saved pick's model, normalized the same way assign does. null means the
// saved name is one the claude cli would reject, so the pick cannot run.
function savedRosterModel(engineId, value) {
  try {
    return normalizeRosterModel(engineId, value);
  } catch {
    return null;
  }
}

// Friendly name for a saved model: claude-opus-5-5 reads as "opus 5.5".
function rosterModelLabel(model) {
  const text = String(model || '').trim();
  const grok = /^grok-(\d+(?:\.\d+)?)(-build-fast)?$/.exec(text);
  if (grok) return `grok ${grok[1]}${grok[2] ? ' fast' : ''}`;
  const match = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(text);
  if (!match) return text;
  return `${match[1]} ${match[2]}${match[3] ? `.${match[3]}` : ''}`;
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

function machineRosterFile(options = {}) {
  return options.machineRosterFile
    || process.env.ATRIS_MACHINE_ROSTER_PATH
    || path.join(os.homedir(), '.atris', 'roster.json');
}

// The machine roster is personal policy from the home folder. Test runs never
// read it unless they point at a file on purpose, so one person's picks
// cannot change what the suite routes to.
function machineRosterEnabled(options = {}) {
  if (options.machineRoster === false) return false;
  if (options.machineRosterFile || process.env.ATRIS_MACHINE_ROSTER_PATH) return true;
  return !process.env.NODE_TEST_CONTEXT;
}

function readMachineRoster(options = {}) {
  if (!machineRosterEnabled(options)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(machineRosterFile(options), 'utf8'));
    return parsed && parsed.roster && typeof parsed.roster === 'object' ? parsed.roster : {};
  } catch {
    return {};
  }
}

function writeMachineRoster(roster, options = {}) {
  if (!machineRosterEnabled(options)) throw new Error('the all-projects roster is off in test runs; set ATRIS_MACHINE_ROSTER_PATH to a scratch file');
  const file = machineRosterFile(options);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const body = { schema: MACHINE_ROSTER_SCHEMA, updated_at: new Date().toISOString(), roster };
  fs.writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

// Assign one job's pick. The three built-in jobs save under their role key;
// any other name saves under its slug with a like field naming the kind of
// work it is (search, build, or review), and engines are checked against
// that kind, roster-only jobs included.
function setRosterPick(jobName, engineName, options = {}, root = process.cwd()) {
  const key = rosterJobKey(jobName);
  if (!key) throw new Error('name the job, for example: build, review, search, or "small build"');
  const builtIn = ENGINE_ROLES.includes(key);
  const label = rosterJobLabel(key);
  const everywhere = options.everywhere === true;
  const registry = readEngineRegistry(root, { persist: false });
  const roster = { ...((everywhere ? readMachineRoster(options) : registry.roster) || {}) };
  if (options.clear) {
    delete roster[key];
  } else {
    const likeName = String(options.like || '').trim();
    const likeKind = likeName ? rosterJob(likeName) : '';
    if (likeName && !likeKind) throw new Error(`unknown kind "${likeName}". use --like search, build, or review`);
    if (builtIn && likeKind && ENGINE_JOBS[likeKind] !== key) throw new Error(`${label} is a built-in job; --like is only for your own jobs`);
    const savedKind = builtIn ? '' : Object.keys(ENGINE_JOBS).find((kind) => ENGINE_JOBS[kind] === customPickRole(rosterPickObject(roster[key]))) || '';
    const kind = builtIn ? label : likeKind || inferJobKind(jobName) || savedKind;
    if (!kind) throw new Error(`say what kind of job "${label}" is: add --like search, --like build, or --like review`);
    const role = ENGINE_JOBS[kind];
    const engineId = canonicalEngineName(engineName);
    const engine = registry.engines.find((entry) => entry.id === engineId);
    if (!engine) throw new Error(`unknown engine "${engineName}"`);
    if (!engineHasRole(engine, role)) throw new Error(`${engine.id} cannot do ${builtIn ? label : `${kind} work, so it cannot take ${label}`}`);
    const backupName = String(options.backup || '').trim();
    const backupId = backupName ? canonicalEngineName(backupName) : '';
    const backup = backupName ? registry.engines.find((entry) => entry.id === backupId) : null;
    if (backupName && !backup) throw new Error(`unknown backup engine "${backupName}"`);
    if (backup && !engineHasRole(backup, role)) throw new Error(`${backup.id} cannot do ${builtIn ? label : `${kind} work, so it cannot back up ${label}`}`);
    const days = options.days === undefined ? 30 : Number(options.days);
    if (!Number.isSafeInteger(days) || days < 1) throw new Error('days must be a positive whole number');
    const model = normalizeRosterModel(engine.id, options.model);
    const now = rosterDate(options.now);
    roster[key] = {
      engine: engine.id,
      model,
      backup: backup ? backup.id : '',
      until: rosterUntil(now, days),
      set_at: now.toISOString(),
      ...(builtIn ? {} : { like: kind }),
    };
  }
  if (everywhere) writeMachineRoster(roster, options);
  else writeEngineRegistry(root, { ...registry, updated_at: new Date().toISOString(), roster });
  return roster;
}

function renewRoster(roster, date) {
  const next = { ...(roster || {}) };
  for (const key of [...ENGINE_ROLES, ...customRosterJobKeys(next)]) {
    if (next[key]) next[key] = { ...next[key], until: rosterUntil(date, 30), set_at: date.toISOString() };
  }
  return next;
}

// Confirm renews this project's picks and the all-projects picks together.
function confirmRoster(root = process.cwd(), now = new Date(), options = {}) {
  const registry = readEngineRegistry(root, { persist: false });
  const date = rosterDate(now);
  const roster = renewRoster(registry.roster, date);
  writeEngineRegistry(root, { ...registry, updated_at: date.toISOString(), roster });
  const machine = readMachineRoster(options);
  if (Object.keys(machine).length) writeMachineRoster(renewRoster(machine, date), options);
  return roster;
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

const ROSTER_SOURCES = Object.freeze({ project: 'this project', machine: 'all projects' });

// Walk one job's roster layers in order: this project's pick, its backup,
// the all-projects pick, its backup. The first ready engine wins; null means
// the next job in line (or the router) decides. A custom pick only counts
// when its kind matches the role being resolved.
function rosterChoiceForKey(key, role, registry, machine, options = {}) {
  const label = rosterJobLabel(key);
  const ready = registry.engines
    .filter((engine) => engine.health && engine.health.status === 'ready')
    .filter((engine) => engineHasRole(engine, role));
  const layers = [
    { source: 'project', pick: registry.roster && registry.roster[key] },
    { source: 'machine', pick: machine && machine[key] },
  ];
  for (const { source, pick } of layers) {
    if (!pick || !pick.engine) continue;
    if (pickRoleForKey(key, pick) !== role) continue;
    const expired = rosterPickExpired(pick, options.now);
    const model = savedRosterModel(pick.engine, pick.model);
    const primary = expired || model === null ? null : ready.find((engine) => engine.id === pick.engine) || null;
    const backup = pick.backup ? ready.find((engine) => engine.id === pick.backup) || null : null;
    const chosen = primary || backup;
    if (!chosen) continue;
    const scope = source === 'machine' ? ' (all projects)' : '';
    const engine = chosen === primary && model ? { ...chosen, roster_model: model } : chosen;
    const why = expired ? 'expired' : model === null ? `names a model ${pick.engine} cannot run` : 'is not ready';
    return {
      engine,
      backup: chosen === primary ? backup : null,
      source,
      job: label,
      pick,
      reason: chosen === primary
        ? `roster pick for ${label}${scope}: ${chosen.id}`
        : `roster pick for ${label}${scope} ${why}, using backup: ${chosen.id}`,
    };
  }
  return null;
}

// The jobs to try, in order: the named job (options.job), else small build
// for a low-stakes build, then the role's own job.
function rosterJobKeysFor(role, options = {}) {
  const named = options.job ? rosterJobKey(options.job) : '';
  const first = named || (role === 'executor' && options.lowStakes === true ? SMALL_BUILD_JOB : '');
  return first && first !== role ? [first, role] : [role];
}

function rosterChoice(role, registry, options = {}) {
  const machine = options.machineRosterPicks || readMachineRoster(options);
  for (const key of rosterJobKeysFor(role, options)) {
    const choice = rosterChoiceForKey(key, role, registry, machine, options);
    if (choice) return choice;
  }
  return null;
}

function resolveEngineForRoleRanked(role, root = process.cwd(), options = {}) {
  const normalizedRole = String(role || '').trim().toLowerCase();
  if (!ENGINE_ROLES.includes(normalizedRole)) {
    throw new Error(`Unknown role "${role}". Known roles: ${ENGINE_ROLES.join(', ')}`);
  }
  const registry = readEngineRegistry(root);
  const engines = registry.engines
    .filter((engine) => engine.roles.includes(normalizedRole))
    .filter((engine) => !routerSkipsRole(engine, normalizedRole))
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
  const choice = rosterChoice(normalizedRole, registry, options);
  if (choice) {
    const lead = [choice.engine, ...(choice.backup ? [choice.backup] : [])];
    const leadIds = new Set(lead.map((engine) => engine.id));
    return {
      engine: choice.engine,
      reason: choice.reason,
      source: choice.source,
      job: choice.job,
      ranked: [...lead, ...ranked.candidates.filter((candidate) => !leadIds.has(candidate.id))],
    };
  }
  return { engine: ranked.candidates[0] || null, reason: routerPickExplanation(ranked), source: 'router', ranked: ranked.candidates };
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

// The model the roster pins for this job, but only when the roster's live
// pick for the job is this exact engine. A caller that already chose an
// engine (a mission's preferred engine, --engine) still gets the pinned model.
function rosterModelFor(role, engineId, root = process.cwd(), options = {}) {
  const normalizedRole = String(role || '').trim().toLowerCase();
  if (!ENGINE_ROLES.includes(normalizedRole) || !engineId) return '';
  const choice = rosterChoice(normalizedRole, readEngineRegistry(root, { persist: false }), options);
  return choice && choice.engine.id === engineId && choice.engine.roster_model ? choice.engine.roster_model : '';
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
    const model = rosterModelFor(role, preferred.id, root, options);
    return {
      engine: model ? { ...preferred, roster_model: model } : preferred,
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
  ENGINE_JOBS,
  SMALL_BUILD_JOB,
  ROSTER_SOURCES,
  rosterJob,
  rosterJobKey,
  rosterJobLabel,
  rosterJobRole,
  customRosterJobKeys,
  setRosterPick,
  confirmRoster,
  normalizeRosterModel,
  rosterModelLabel,
  parseRosterUntil,
  rosterPickExpired,
  readMachineRoster,
  rosterModelFor,
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
