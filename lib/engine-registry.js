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
// the same; any other name is a custom job under its slug. A built-in job
// only answers to its exact name or alias: "builder!" would slug onto build
// and quietly replace the real build pick, so it gets no key at all.
function rosterJobKey(name) {
  const builtIn = rosterJob(name);
  if (builtIn) return ENGINE_JOBS[builtIn];
  const slug = rosterJobSlug(name);
  if (!slug || rosterJob(slug)) return '';
  return slug;
}

// The plain refusal for a job name that has no key.
function rosterJobNameError(name) {
  const near = rosterJob(rosterJobSlug(name));
  if (near) return `"${String(name || '').trim()}" is too close to the built-in ${near} job. type ${near} to change that job, or pick another name`;
  return 'name the job, for example: build, review, search, or "small build"';
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

// A pick that can decide right now: it names a kind, has not expired, and
// names an engine and model that can run.
function rosterPickLive(pick, now) {
  return Boolean(pick
    && customPickRole(pick)
    && canonicalEngineName(pick.engine)
    && !rosterPickExpired(pick, now)
    && savedRosterModel(pick.engine, pick.model) !== null);
}

// The role a job name resolves as: a built-in job's own role, else the kind
// of the first live pick in line (this project, then all projects), then the
// kind the name says, then any saved kind. An expired or broken project pick
// never decides the kind, so it cannot hide a live all-projects pick.
function rosterJobRole(name, root = process.cwd(), options = {}) {
  const key = rosterJobKey(name);
  if (!key) return '';
  if (ENGINE_ROLES.includes(key)) return key;
  const project = options.projectRosterPicks || readProjectRoster(root, options).picks;
  const machine = options.machineRosterPicks || readMachineRoster(options);
  const picks = [project && project[key], machine && machine[key]].map(rosterPickObject).filter(Boolean);
  const live = picks.find((pick) => rosterPickLive(pick, options.now));
  if (live) return customPickRole(live);
  const kind = inferJobKind(name);
  if (kind) return ENGINE_JOBS[kind];
  return picks.map(customPickRole).find(Boolean) || '';
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

// A ROSTER.md line with no until never expires; a saved JSON pick always
// carries its date.
function rosterPickExpired(pick, now = new Date()) {
  if (pick && pick.never_expires === true && !pick.until) return false;
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

// The all-projects ROSTER.md. A scratch roster.json path (tests, sandboxes)
// keeps its markdown beside it, so pointing one override away from the home
// folder moves both files.
function machineRosterMarkdownFile(options = {}) {
  if (options.machineRosterMarkdownFile) return options.machineRosterMarkdownFile;
  if (process.env.ATRIS_MACHINE_ROSTER_MD_PATH) return process.env.ATRIS_MACHINE_ROSTER_MD_PATH;
  if (options.machineRosterFile || process.env.ATRIS_MACHINE_ROSTER_PATH) {
    return path.join(path.dirname(machineRosterFile(options)), 'ROSTER.md');
  }
  return path.join(os.homedir(), '.atris', 'ROSTER.md');
}

function projectRosterFile(root = process.cwd()) {
  return path.join(root, 'atris', 'ROSTER.md');
}

// The machine roster is personal policy from the home folder. Test runs never
// read it unless they point at a file on purpose, so one person's picks
// cannot change what the suite routes to.
function machineRosterEnabled(options = {}) {
  if (options.machineRoster === false) return false;
  if (options.machineRosterFile || options.machineRosterMarkdownFile) return true;
  if (process.env.ATRIS_MACHINE_ROSTER_PATH || process.env.ATRIS_MACHINE_ROSTER_MD_PATH) return true;
  return !process.env.NODE_TEST_CONTEXT;
}

function readMachineRosterJson(options = {}) {
  if (!machineRosterEnabled(options)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(machineRosterFile(options), 'utf8'));
    return parsed && parsed.roster && typeof parsed.roster === 'object' ? parsed.roster : {};
  } catch {
    return {};
  }
}

// The all-projects picks: ROSTER.md when it exists, else the older JSON file.
function readMachineRoster(options = {}) {
  return readMachineRosterLayer(options).picks;
}

function writeAtomic(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, body, 'utf8');
  fs.renameSync(tmp, file);
}

function writeMachineRoster(roster, options = {}) {
  if (!machineRosterEnabled(options)) throw new Error('the all-projects roster is off in test runs; set ATRIS_MACHINE_ROSTER_PATH to a scratch file');
  const body = { schema: MACHINE_ROSTER_SCHEMA, updated_at: new Date().toISOString(), roster };
  writeAtomic(machineRosterFile(options), `${JSON.stringify(body, null, 2)}\n`);
}

// --- ROSTER.md: words to picks ------------------------------------------

const MONTH_NAMES = Object.freeze(['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']);

// "2026-10-24", "oct 24", "october 24 2026", or "24 oct". A date with no year
// is the nearest one not in the past. null means the words are not a date.
function parseRosterUntilWords(text, now = new Date()) {
  const raw = String(text || '').trim().toLowerCase().replace(/,/g, ' ').replace(/\s+/g, ' ');
  if (!raw) return null;
  const iso = parseRosterUntil(raw);
  if (iso) return localDayText(iso);
  const monthFirst = /^([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s+(\d{4}))?$/.exec(raw);
  const dayFirst = /^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\.?(?:\s+(\d{4}))?$/.exec(raw);
  const monthWord = monthFirst ? monthFirst[1] : dayFirst ? dayFirst[2] : '';
  const day = Number(monthFirst ? monthFirst[2] : dayFirst ? dayFirst[1] : NaN);
  const yearText = monthFirst ? monthFirst[3] : dayFirst ? dayFirst[3] : '';
  if (!monthWord || monthWord.length < 3) return null;
  const month = MONTH_NAMES.findIndex((name) => name.startsWith(monthWord) || (monthWord === 'sept' && name === 'september'));
  if (month === -1) return null;
  const today = localDay(rosterDate(now));
  const build = (year) => {
    const date = new Date(year, month, day);
    return date.getMonth() === month && date.getDate() === day ? date : null;
  };
  if (yearText) {
    const date = build(Number(yearText));
    return date ? localDayText(date) : null;
  }
  for (const year of [today.getFullYear(), today.getFullYear() + 1, today.getFullYear() + 4]) {
    const date = build(year);
    if (date && date.getTime() >= today.getTime()) return localDayText(date);
  }
  return null;
}

// Words that name an engine, a model, or both, turned into one engine and
// one model the engine takes. "devin swe-2-max", "claude haiku", "opus 5.5",
// "grok 4.7 fast". Throws a plain sentence when the words name nothing.
function resolveRosterWords(text) {
  const clean = String(text || '').trim().replace(/\s+/g, ' ');
  if (!clean) throw new Error('names no engine');
  const lower = clean.toLowerCase();
  const words = clean.split(' ');
  const first = canonicalEngineName(words[0].toLowerCase());
  const rest = words.slice(1).join(' ');
  const model = (engine, value) => {
    try {
      return normalizeRosterModel(engine, value);
    } catch {
      throw new Error(`${engine} cannot take the model "${value}"`);
    }
  };
  if (first && !rest) return { engine: first, model: '' };
  const bare = lower.replace(CLAUDE_LONG_CONTEXT, '').replace(/^claude[\s_-]*/, '');
  if (CLAUDE_MODEL_SPELLING.test(bare) || lower.startsWith('claude-')) return { engine: 'claude', model: model('claude', clean) };
  if (GROK_MODEL_SPELLING.test(lower) || lower.startsWith('grok-')) return { engine: 'grok', model: model('grok', clean) };
  if (first) {
    const value = first === 'grok' && /^\d/.test(rest) ? `grok ${rest}` : rest;
    return { engine: first, model: model(first, value) };
  }
  if (/^(opus|sonnet|haiku|fable|opusplan)\b/.test(lower)) return { engine: 'claude', model: model('claude', clean) };
  if (/^grok/.test(lower)) return { engine: 'grok', model: model('grok', clean) };
  if (/^swe-/.test(lower)) return { engine: 'devin', model: clean };
  throw new Error(`"${clean}" is not an engine or a model atris knows`);
}

// What an engine can do by its seed, used to check hand-written lines before
// any registry is read.
function engineCanTake(engineId, role) {
  const seed = ENGINE_SEED_META[engineId];
  return Boolean(seed && engineHasRole({ id: engineId, roles: Array.from(seed.roles) }, role));
}

// One line value, "<words>[, backup <words>][, until <date>]", checked
// against the kind of job it fills. Throws a plain sentence on anything wrong.
function rosterPickFromValue(value, role, options = {}) {
  const kind = Object.keys(ENGINE_JOBS).find((name) => ENGINE_JOBS[name] === role) || role;
  const parts = String(value || '').split(',').map((part) => part.trim()).filter(Boolean);
  // "until oct 24, 2026": a lone year belongs to the part before it.
  for (let i = parts.length - 1; i > 0; i -= 1) {
    if (/^\d{4}$/.test(parts[i])) parts.splice(i - 1, 2, `${parts[i - 1]} ${parts[i]}`);
  }
  if (!parts.length) throw new Error('names no engine');
  const [main, ...extras] = parts;
  if (/^(backup|until)\b/i.test(main)) throw new Error('names no engine before its backup or until');
  const primary = resolveRosterWords(main);
  if (!engineCanTake(primary.engine, role)) throw new Error(`${primary.engine} cannot do ${kind} work`);
  let backup = null;
  let until = '';
  for (const part of extras) {
    const backupMatch = /^backup\s+(.+)$/i.exec(part);
    const untilMatch = /^until\s+(.+)$/i.exec(part);
    if (backupMatch && !backup) {
      backup = resolveRosterWords(backupMatch[1]);
      if (!engineCanTake(backup.engine, role)) throw new Error(`the backup ${backup.engine} cannot do ${kind} work`);
    } else if (untilMatch && !until) {
      until = parseRosterUntilWords(untilMatch[1], options.now);
      if (!until) throw new Error(`"${untilMatch[1]}" is not a date; use 2026-10-24 or oct 24`);
    } else {
      throw new Error(`does not understand "${part}"`);
    }
  }
  return {
    engine: primary.engine,
    model: primary.model,
    backup: backup ? backup.engine : '',
    ...(backup && backup.model ? { backup_model: backup.model } : {}),
    until,
    ...(until ? {} : { never_expires: true }),
  };
}

// The words a written line uses for one engine and model: the model alone
// when it already says the engine ("opus 5.5"), else engine then model.
function rosterWordsFor(engine, model) {
  if (!model) return engine;
  const label = rosterModelLabel(model);
  try {
    const read = resolveRosterWords(label);
    if (read.engine === engine && read.model === model) return label;
  } catch {}
  return `${engine} ${label}`;
}

// A job line's name part, "small build (like build)", split into the name
// and the kind it says it is like.
function splitJobName(text) {
  const match = /^(.*?)\s*\(\s*like\s+([a-z]+)\s*\)\s*$/i.exec(String(text || '').trim());
  return match ? { name: match[1].trim(), like: match[2].trim().toLowerCase() } : { name: String(text || '').trim(), like: '' };
}

function rosterLineText(key, pick) {
  const label = rosterJobLabel(key);
  const custom = !ENGINE_ROLES.includes(key);
  const kind = custom ? String(pick.like || '') : '';
  const likeText = custom && kind && inferJobKind(label) !== kind ? ` (like ${kind})` : '';
  const parts = [rosterWordsFor(pick.engine, pick.model || '')];
  if (pick.backup) parts.push(`backup ${rosterWordsFor(pick.backup, pick.backup_model || '')}`);
  if (pick.until) parts.push(`until ${pick.until}`);
  return `${label}${likeText}: ${parts.join(', ')}`;
}

function rosterFileLabel(file, root = process.cwd()) {
  const abs = path.resolve(file);
  const rel = path.relative(path.resolve(root), abs);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  const home = os.homedir();
  const fromHome = path.relative(home, abs);
  if (fromHome && !fromHome.startsWith('..') && !path.isAbsolute(fromHome)) return `~/${fromHome}`;
  return abs;
}

// Read one ROSTER.md into picks keyed like the JSON roster, the raw team
// lines, and one warning per line that could not be used. Never throws on
// what the file says.
function parseRosterMarkdown(text, file, options = {}) {
  const { scanRosterMarkdown } = require('./roster-markdown');
  const display = rosterFileLabel(file, options.root || process.cwd());
  const picks = {};
  const team = [];
  const warnings = [];
  const warn = (entry, message) => warnings.push({ file: display, line: entry.lineNumber, text: entry.raw, message });
  for (const entry of scanRosterMarkdown(text).entries) {
    if (entry.malformed) {
      warn(entry, entry.section === 'team' ? 'is not "member: job or engine", so it is skipped' : 'is not "job: engine", so it is skipped');
      continue;
    }
    if (entry.section === 'team') {
      team.push({ member: entry.name.trim().toLowerCase(), value: entry.value, line: entry.lineNumber, text: entry.raw, file: display });
      continue;
    }
    const { name, like } = splitJobName(entry.name);
    const key = rosterJobKey(name);
    if (!key) {
      warn(entry, `${rosterJobNameError(name)}, so the line is skipped`);
      continue;
    }
    const builtIn = ENGINE_ROLES.includes(key);
    const label = rosterJobLabel(key);
    const likeKind = like ? rosterJob(like) : '';
    if (like && !likeKind) {
      warn(entry, `"like ${like}" is not search, build, or review, so ${label} uses the next pick in line`);
      continue;
    }
    if (builtIn && likeKind && ENGINE_JOBS[likeKind] !== key) {
      warn(entry, `${label} is a built-in job and cannot be like ${likeKind}, so the line is skipped`);
      continue;
    }
    const kind = builtIn ? label : likeKind || inferJobKind(name);
    if (!kind) {
      warn(entry, `say what kind of job "${label}" is, for example "${label} (like build)", so the line is skipped`);
      continue;
    }
    if (picks[key]) {
      warn(entry, `sets ${label} a second time; line ${picks[key].line} wins`);
      continue;
    }
    try {
      const pick = rosterPickFromValue(entry.value, ENGINE_JOBS[kind], options);
      picks[key] = { ...pick, ...(builtIn ? {} : { like: kind }), file: display, line: entry.lineNumber };
    } catch (error) {
      warn(entry, `${error.message}, so ${label} uses the next pick in line`);
    }
  }
  return { picks, team, warnings };
}

function readRosterMarkdownLayer(scope, file, options = {}) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  return { scope, format: 'markdown', path: file, ...parseRosterMarkdown(text, file, options) };
}

function readProjectRoster(root = process.cwd(), options = {}) {
  const md = readRosterMarkdownLayer('project', projectRosterFile(root), { ...options, root });
  if (md) return { ...md, file: rosterFileLabel(md.path, root) };
  const registry = options.registry || readEngineRegistry(root, { persist: false });
  const picks = registry.roster && typeof registry.roster === 'object' && !Array.isArray(registry.roster) ? registry.roster : {};
  const jsonFile = engineRegistryFile(root);
  return { scope: 'project', format: Object.keys(picks).length ? 'json' : 'none', path: jsonFile, file: rosterFileLabel(jsonFile, root), picks, team: [], warnings: [] };
}

function readMachineRosterLayer(options = {}) {
  const root = options.root || process.cwd();
  if (!machineRosterEnabled(options)) return { scope: 'machine', format: 'none', path: '', file: '', picks: {}, team: [], warnings: [] };
  const mdFile = machineRosterMarkdownFile(options);
  const md = readRosterMarkdownLayer('machine', mdFile, { ...options, root });
  if (md) return { ...md, file: rosterFileLabel(mdFile, root) };
  const picks = readMachineRosterJson(options);
  const jsonFile = machineRosterFile(options);
  return { scope: 'machine', format: Object.keys(picks).length ? 'json' : 'none', path: jsonFile, file: rosterFileLabel(jsonFile, root), picks, team: [], warnings: [] };
}

// Both layers at once: this project's roster and the all-projects roster,
// each from ROSTER.md when it exists, else from the older JSON file.
function readRosterState(root = process.cwd(), options = {}) {
  return {
    project: readProjectRoster(root, options),
    machine: readMachineRosterLayer({ ...options, root }),
  };
}

// The first write to a layer with no ROSTER.md carries its JSON picks over,
// dates included. The JSON file stays where it is, untouched.
function rosterMarkdownFromPicks(picks) {
  const { ROSTER_MARKDOWN_TEMPLATE } = require('./roster-markdown');
  const keys = [...ENGINE_ROLES.filter((role) => role in (picks || {})), ...customRosterJobKeys(picks)];
  const order = ['navigator', 'executor', 'validator'];
  keys.sort((a, b) => {
    const ai = order.indexOf(a);
    const bi = order.indexOf(b);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });
  const lines = keys
    .map((key) => ({ key, pick: rosterPickObject(picks[key]) }))
    .filter(({ key, pick }) => pick && (ENGINE_ROLES.includes(key) || customPickRole(pick)))
    .map(({ key, pick }) => rosterLineText(key, pick));
  return [...ROSTER_MARKDOWN_TEMPLATE, ...lines, ''].join('\n');
}

function rosterEntryKey(entry) {
  return rosterJobKey(splitJobName(entry.name).name);
}

// Assign one job's pick by editing its line in ROSTER.md: this project's
// atris/ROSTER.md, or ~/.atris/ROSTER.md with everywhere. Only that line
// changes; comments, order, and every other line stay as written. The three
// built-in jobs keep their role keys; any other name is a custom job whose
// kind (search, build, or review) comes from --like, its name, or its saved
// line, and engines are checked against that kind.
function setRosterPick(jobName, engineName, options = {}, root = process.cwd()) {
  const { upsertRosterLine } = require('./roster-markdown');
  const key = rosterJobKey(jobName);
  if (!key) throw new Error(rosterJobNameError(jobName));
  const builtIn = ENGINE_ROLES.includes(key);
  const label = rosterJobLabel(key);
  const everywhere = options.everywhere === true;
  if (everywhere && !machineRosterEnabled(options)) throw new Error('the all-projects roster is off in test runs; set ATRIS_MACHINE_ROSTER_PATH to a scratch file');
  const registry = readEngineRegistry(root, { persist: false });
  const layer = everywhere ? readMachineRosterLayer({ ...options, root }) : readProjectRoster(root, { ...options, registry });
  const file = everywhere ? machineRosterMarkdownFile(options) : projectRosterFile(root);
  const existing = layer.format === 'markdown' ? fs.readFileSync(file, 'utf8') : null;
  let line = null;
  if (!options.clear) {
    const likeName = String(options.like || '').trim();
    const likeKind = likeName ? rosterJob(likeName) : '';
    if (likeName && !likeKind) throw new Error(`unknown kind "${likeName}". use --like search, build, or review`);
    if (builtIn && likeKind && ENGINE_JOBS[likeKind] !== key) throw new Error(`${label} is a built-in job; --like is only for your own jobs`);
    const savedKind = builtIn ? '' : Object.keys(ENGINE_JOBS).find((kind) => ENGINE_JOBS[kind] === customPickRole(rosterPickObject(layer.picks[key]))) || '';
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
    // No --days means the pick holds until someone changes the line.
    const days = options.days === undefined ? null : Number(options.days);
    if (days !== null && (!Number.isSafeInteger(days) || days < 1)) throw new Error('days must be a positive whole number');
    const model = normalizeRosterModel(engine.id, options.model);
    const now = rosterDate(options.now);
    line = rosterLineText(key, {
      engine: engine.id,
      model,
      backup: backup ? backup.id : '',
      until: days ? rosterUntil(now, days) : '',
      ...(builtIn ? {} : { like: kind }),
    });
  }
  if (existing === null && line === null && !Object.keys(layer.picks || {}).length) return {};
  const base = existing !== null ? existing : rosterMarkdownFromPicks(layer.picks);
  const next = upsertRosterLine(base, { section: 'jobs', matches: (entry) => rosterEntryKey(entry) === key, line });
  writeAtomic(file, next);
  return everywhere ? readMachineRoster(options) : readProjectRoster(root, options).picks;
}

function renewRoster(roster, date) {
  const next = { ...(roster || {}) };
  for (const key of [...ENGINE_ROLES, ...customRosterJobKeys(next)]) {
    if (next[key]) next[key] = { ...next[key], until: rosterUntil(date, 30), set_at: date.toISOString() };
  }
  return next;
}

// Renew every dated line in one ROSTER.md for thirty days. Lines with no
// until never expire, so they stay exactly as written.
function renewRosterMarkdown(file, date, options = {}) {
  const { rewriteRosterValues } = require('./roster-markdown');
  const text = fs.readFileSync(file, 'utf8');
  const parsed = parseRosterMarkdown(text, file, options);
  const renewLines = new Set(Object.values(parsed.picks).filter((pick) => pick.until).map((pick) => pick.line));
  if (!renewLines.size) return;
  const byLine = new Map(Object.entries(parsed.picks).map(([key, pick]) => [pick.line, { key, pick }]));
  const next = rewriteRosterValues(text, (entry) => {
    if (entry.section !== 'jobs' || !renewLines.has(entry.lineNumber)) return undefined;
    const { key, pick } = byLine.get(entry.lineNumber);
    return rosterLineText(key, { ...pick, until: rosterUntil(date, 30) });
  });
  writeAtomic(file, next);
}

// Confirm renews this project's picks and the all-projects picks together.
// In a ROSTER.md only lines that carry an until date are renewed.
function confirmRoster(root = process.cwd(), now = new Date(), options = {}) {
  const date = rosterDate(now);
  const projectMd = projectRosterFile(root);
  if (fs.existsSync(projectMd)) {
    renewRosterMarkdown(projectMd, date, { ...options, root, now: date });
  } else {
    const registry = readEngineRegistry(root, { persist: false });
    if (registry.roster) writeEngineRegistry(root, { ...registry, updated_at: date.toISOString(), roster: renewRoster(registry.roster, date) });
  }
  if (machineRosterEnabled(options)) {
    const machineMd = machineRosterMarkdownFile(options);
    if (fs.existsSync(machineMd)) {
      renewRosterMarkdown(machineMd, date, { ...options, root, now: date });
    } else {
      const machine = readMachineRosterJson(options);
      if (Object.keys(machine).length) writeMachineRoster(renewRoster(machine, date), options);
    }
  }
  return readProjectRoster(root, { ...options, now: date }).picks;
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

// One pick's walk: the pick itself, then its backup. The first ready engine
// that can do the role wins; null means the next pick in line decides. A
// custom pick only counts when its kind matches the role being resolved.
function rosterChoiceForPick(pick, role, registry, { key, label, source, scopeText = '', now } = {}) {
  if (!pick || !pick.engine) return null;
  if (key !== undefined && pickRoleForKey(key, pick) !== role) return null;
  const ready = registry.engines
    .filter((engine) => engine.health && engine.health.status === 'ready')
    .filter((engine) => engineHasRole(engine, role));
  const expired = rosterPickExpired(pick, now);
  const model = savedRosterModel(pick.engine, pick.model);
  const primary = expired || model === null ? null : ready.find((engine) => engine.id === pick.engine) || null;
  const backup = pick.backup ? ready.find((engine) => engine.id === pick.backup) || null : null;
  const chosen = primary || backup;
  if (!chosen) return null;
  const backupModel = backup && pick.backup_model ? savedRosterModel(backup.id, pick.backup_model) : '';
  const engine = chosen === primary
    ? (model ? { ...chosen, roster_model: model } : chosen)
    : (backupModel ? { ...chosen, roster_model: backupModel } : chosen);
  const why = expired ? 'expired' : model === null ? `names a model ${pick.engine} cannot run` : 'is not ready';
  return {
    engine,
    backup: chosen === primary ? backup : null,
    source,
    job: label,
    pick,
    reason: chosen === primary
      ? `roster pick for ${label}${scopeText}: ${chosen.id}`
      : `roster pick for ${label}${scopeText} ${why}, using backup: ${chosen.id}`,
  };
}

// Walk one job's roster layers in order: this project's pick, its backup,
// the all-projects pick, its backup. The first ready engine wins; null means
// the next job in line (or the router) decides.
function rosterChoiceForKey(key, role, registry, machine, options = {}) {
  const label = rosterJobLabel(key);
  const layers = [
    { source: 'project', pick: registry.roster && registry.roster[key] },
    { source: 'machine', pick: machine && machine[key] },
  ];
  for (const { source, pick } of layers) {
    const choice = rosterChoiceForPick(pick, role, registry, {
      key,
      label,
      source,
      scopeText: source === 'machine' ? ' (all projects)' : '',
      now: options.now,
    });
    if (choice) return choice;
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

// The registry with this project's picks swapped in from wherever they live
// now: atris/ROSTER.md when it exists, else the roster saved in engines.json.
function withProjectRoster(registry, root, options = {}) {
  const roster = options.projectRosterPicks || readProjectRoster(root, { ...options, registry }).picks;
  return { ...registry, roster };
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
  const choice = rosterChoice(normalizedRole, withProjectRoster(registry, root, options), options);
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
  const choice = rosterChoice(normalizedRole, withProjectRoster(readEngineRegistry(root, { persist: false }), root, options), options);
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
  rosterJobKey,
  rosterJobLabel,
  rosterJobNameError,
  rosterJobRole,
  inferJobKind,
  readRosterState,
  rosterPickFromValue,
  rosterChoiceForPick,
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
