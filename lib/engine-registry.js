'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const crypto = require('crypto');
const {
  RUNNER_PROFILE_DEFS,
  RUNNER_PROFILE_ALIASES,
  RUNNER_PROFILE_NAMES,
  HIDDEN_PROFILE_NAMES,
  EFFORT_WORDS,
  engineTakesModel,
  engineEffortLevels,
} = require('./runner-command');
const { rankEnginesDetailed, routerPickExplanation } = require('./router-brain');
// Friendly name for a saved model: claude-opus-5-5 reads as "opus 5.5".
const { modelLabel: rosterModelLabel } = require('./roster-models');

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
  // Devin gathers context for search only when a roster picks it.
  devin: Object.freeze({ tier: 'max', roles: Object.freeze(['executor']), roster_only_roles: Object.freeze(['navigator']), models: Object.freeze(['built-in router']), duty: 'errands', fallback_order: 40 }),
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

// A pick that can decide right now: it names a kind, has not expired, names
// an engine and model that can run, and that engine (or its backup) is ready.
// A pick that cannot run never sets the job's kind, so it cannot block a
// ready all-projects pick of another kind.
function rosterPickLive(pick, now, registry) {
  const role = customPickRole(pick);
  if (!role || !canonicalEngineName(pick.engine)) return false;
  return Boolean(rosterChoiceForPick(pick, role, registry, { label: rosterJobLabel(role), now }));
}

// The role a job name resolves as: a built-in job's own role, else the kind
// of the first live pick in line (this project, then all projects), then the
// kind the name says, then any saved kind. An expired or broken project pick
// never decides the kind, so it cannot hide a live all-projects pick.
function rosterJobRole(name, root = process.cwd(), options = {}) {
  const key = rosterJobKey(name);
  if (!key) return '';
  if (ENGINE_ROLES.includes(key)) return key;
  const session = options.sessionRosterPicks || readSessionRosterLayer({ ...options, root }).picks;
  const project = options.projectRosterPicks || readProjectRoster(root, options).picks;
  const machine = options.machineRosterPicks || readMachineRoster(options);
  const picks = [session && session[key], project && project[key], machine && machine[key]].map(rosterPickObject).filter(Boolean);
  const registry = options.registry || readEngineRegistry(root, { persist: false });
  const live = picks.find((pick) => rosterPickLive(pick, options.now, registry));
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

// A git worktree of this project shares its roster: when the worktree has no
// atris/ROSTER.md of its own (an uncommitted file never reaches it), the main
// checkout's file applies. Read from the .git pointer file; no git process.
function projectRosterRoot(root = process.cwd()) {
  if (fs.existsSync(projectRosterFile(root))) return root;
  const main = mainCheckoutRoot(root);
  return main && fs.existsSync(projectRosterFile(main)) ? main : root;
}

// The main checkout behind a git worktree, read from the .git pointer file
// with no git process. '' when root is not a linked worktree.
function mainCheckoutRoot(root = process.cwd()) {
  try {
    const pointer = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(path.join(root, '.git'), 'utf8'));
    if (!pointer) return '';
    const gitdir = path.resolve(root, pointer[1].trim());
    if (path.basename(path.dirname(gitdir)) !== 'worktrees') return '';
    return path.dirname(path.dirname(path.dirname(gitdir)));
  } catch {
    return '';
  }
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

// Month and day words: "oct 24", "october 24 2026", "24 oct 2026".
function readRosterDateWords(text) {
  const raw = String(text || '').trim().toLowerCase().replace(/,/g, ' ').replace(/\s+/g, ' ');
  const monthFirst = /^([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s+(\d{4}))?$/.exec(raw);
  const dayFirst = /^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\.?(?:\s+(\d{4}))?$/.exec(raw);
  const monthWord = monthFirst ? monthFirst[1] : dayFirst ? dayFirst[2] : '';
  const day = Number(monthFirst ? monthFirst[2] : dayFirst ? dayFirst[1] : NaN);
  const yearText = monthFirst ? monthFirst[3] : dayFirst ? dayFirst[3] : '';
  if (!monthWord || monthWord.length < 3) return null;
  const month = MONTH_NAMES.findIndex((name) => name.startsWith(monthWord) || (monthWord === 'sept' && name === 'september'));
  if (month === -1) return null;
  const build = (year) => {
    const date = new Date(year, month, day);
    return date.getMonth() === month && date.getDate() === day ? date : null;
  };
  return { month, day, year: yearText ? Number(yearText) : null, build };
}

// "2026-10-24", "oct 24 2026", "october 24, 2026", or "24 oct 2026". The year
// is required: a year-less date would have to guess its year from when the
// file was saved, and an unrelated edit would then revive a passed pick.
// null means the words are not a full date.
function parseRosterUntilWords(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const iso = parseRosterUntil(raw);
  if (iso) return localDayText(iso);
  const words = readRosterDateWords(raw);
  if (!words || words.year === null) return null;
  const date = words.build(words.year);
  return date ? localDayText(date) : null;
}

// The full date a year-less "oct 24" most likely meant (the nearest one not
// in the past), offered in the warning. null when the words are no date.
function yearlessRosterDate(text, now = new Date()) {
  const words = readRosterDateWords(text);
  if (!words || words.year !== null) return null;
  const today = localDay(rosterDate(now));
  for (const year of [today.getFullYear(), today.getFullYear() + 1, today.getFullYear() + 4]) {
    const date = words.build(year);
    if (date && date.getTime() >= today.getTime()) return localDayText(date);
  }
  return null;
}

// "max 20 min", "max 90s", "max 2h": the time cap for one line, in seconds.
// null means the words are not a time cap.
const MAX_UNITS = Object.freeze({
  s: 1, sec: 1, secs: 1, second: 1, seconds: 1,
  m: 60, min: 60, mins: 60, minute: 60, minutes: 60,
  h: 3600, hr: 3600, hrs: 3600, hour: 3600, hours: 3600,
});

function parseRosterMax(text) {
  const match = /^max\s+(\d+(?:\.\d+)?)\s*([a-z]+)$/i.exec(String(text || '').trim());
  if (!match) return null;
  const unit = MAX_UNITS[match[2].toLowerCase()];
  const seconds = unit ? Math.round(Number(match[1]) * unit) : 0;
  return seconds > 0 ? seconds : null;
}

function rosterMaxText(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return '';
  if (value % 3600 === 0) return `max ${value / 3600}h`;
  if (value % 60 === 0) return `max ${value / 60} min`;
  return `max ${value}s`;
}

// Why an engine cannot take an effort word, in one plain sentence.
function effortRefusal(engineId, effort) {
  const levels = engineEffortLevels(engineId);
  if (!levels.length) return `${engineId} cannot take an effort level`;
  return `${engineId} takes effort ${levels.join(', ')}, not "${effort}"`;
}

// A saved effort word this engine takes, '' for none, null when it cannot.
function savedRosterEffort(engineId, value) {
  const effort = String(value || '').trim().toLowerCase();
  if (!effort) return '';
  return engineEffortLevels(engineId).includes(effort) ? effort : null;
}

// Words that name an engine, a model, or both, then an optional effort word,
// turned into one engine, one model, and one effort the engine takes.
// "devin swe-2-max", "claude haiku", "opus 5.5", "codex gpt-6-astra medium".
// Throws a plain sentence when the words name nothing or the engine cannot
// take the model or effort.
function resolveRosterWords(text) {
  const all = String(text || '').trim().replace(/\s+/g, ' ').split(' ').filter(Boolean);
  const last = all.length > 1 ? all[all.length - 1].toLowerCase() : '';
  const effort = EFFORT_WORDS.includes(last) ? last : '';
  const read = resolveEngineModelWords((effort ? all.slice(0, -1) : all).join(' '));
  if (read.model && !engineTakesModel(read.engine)) throw new Error(`${read.engine} runs one fixed model and cannot take "${read.model}"`);
  if (effort && !engineEffortLevels(read.engine).includes(effort)) throw new Error(effortRefusal(read.engine, effort));
  return { ...read, effort };
}

// Friendly tool names a roster line may use in place of an engine id.
const ROSTER_TOOL_NAMES = Object.freeze({
  'claude code': 'claude',
  ccs: 'claude',
  'atris fast': 'atris-fast',
  gemini: 'agy',
  antigravity: 'agy',
});
const ROSTER_TOOL_WORDS = /^(claude code|ccs|atris fast|gemini|antigravity)(?:\s+(.*))?$/i;

// The engine id for a tool name a person typed: an engine id, an alias, or a
// friendly name like "claude code". '' when it names no engine.
function rosterToolName(name) {
  const lower = String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
  return ROSTER_TOOL_NAMES[lower] || canonicalEngineName(lower);
}

// How a roster line names an engine: "claude code" for claude, "atris fast"
// for atris-fast, the id for the rest.
function rosterToolLabel(engineId) {
  if (engineId === 'claude') return 'claude code';
  if (engineId === 'atris-fast') return 'atris fast';
  return engineId;
}

function resolveEngineModelWords(text) {
  const clean = String(text || '').trim().replace(/\s+/g, ' ');
  if (!clean) throw new Error('names no engine');
  const lower = clean.toLowerCase();
  const words = clean.split(' ');
  const friendly = ROSTER_TOOL_WORDS.exec(clean);
  if (friendly) {
    const engine = ROSTER_TOOL_NAMES[friendly[1].toLowerCase()];
    const rest = String(friendly[2] || '').trim();
    if (!rest) return { engine, model: '' };
    try {
      return { engine, model: normalizeRosterModel(engine, rest) };
    } catch {
      throw new Error(`${engine} cannot take the model "${rest}"`);
    }
  }
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
  if (/^gemini-/.test(lower)) return { engine: 'agy', model: clean };
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
  let [main, ...extras] = parts;
  if (/^(backup|until|max)\b/i.test(main)) throw new Error('names no engine before its backup, until, or max');
  // "codex medium max 20 min" with no comma still reads the cap.
  const inlineMax = /\s+(max\s+\d+(?:\.\d+)?\s*[a-z]+)$/i.exec(main);
  if (inlineMax) {
    main = main.slice(0, inlineMax.index);
    extras = [inlineMax[1], ...extras];
  }
  const primary = resolveRosterWords(main);
  if (!engineCanTake(primary.engine, role)) throw new Error(`${primary.engine} cannot do ${kind} work`);
  let backup = null;
  let until = '';
  let untilYearless = '';
  let maxSeconds = null;
  let namedModel = false;
  let namedEffort = false;
  for (const raw of extras) {
    // "max: 20 min" and "until: 2026-10-24" read like "max 20 min".
    const part = raw.replace(/^(max|until)\s*:\s*/i, '$1 ');
    const backupMatch = /^backup\s+(.+)$/i.exec(part);
    const untilMatch = /^until\s+(.+)$/i.exec(part);
    const maxMatch = /^max\b/i.test(part) && !/^max$/i.test(part);
    const modelMatch = /^model\s*(?::\s*|\s+)(.+)$/i.exec(part);
    const effortMatch = /^effort\s*(?::\s*|\s+)(.+)$/i.exec(part);
    if (modelMatch && !namedModel) {
      if (primary.model) throw new Error(`names two models for ${primary.engine}`);
      const words = modelMatch[1].trim();
      if (!engineTakesModel(primary.engine)) throw new Error(`${primary.engine} runs one fixed model and cannot take "${words}"`);
      try {
        primary.model = normalizeRosterModel(primary.engine, words);
      } catch {
        throw new Error(`${primary.engine} cannot take the model "${words}"`);
      }
      namedModel = true;
    } else if (effortMatch && !namedEffort) {
      if (primary.effort) throw new Error(`names two efforts for ${primary.engine}`);
      const effort = effortMatch[1].trim().toLowerCase();
      if (!EFFORT_WORDS.includes(effort) || !engineEffortLevels(primary.engine).includes(effort)) throw new Error(effortRefusal(primary.engine, effort));
      primary.effort = effort;
      namedEffort = true;
    } else if (backupMatch && options.worker) {
      throw new Error('a worker line takes no backup; put the backup on the next line');
    } else if (backupMatch && !backup) {
      backup = resolveRosterWords(backupMatch[1]);
      if (!engineCanTake(backup.engine, role)) throw new Error(`the backup ${backup.engine} cannot do ${kind} work`);
    } else if (untilMatch && !until) {
      const words = untilMatch[1].trim();
      until = parseRosterUntilWords(words);
      if (!until) {
        untilYearless = yearlessRosterDate(words, options.now);
        if (!untilYearless) throw new Error(`"${words}" is not a date; use 2026-10-24 or oct 24 2026`);
        // Kept as typed, so the pick reads as expired until the year is added.
        until = words;
      }
    } else if (maxMatch && maxSeconds === null) {
      maxSeconds = parseRosterMax(part);
      if (!maxSeconds) throw new Error(`"${part}" is not a time cap; use max 20 min, max 90s, or max 2h`);
    } else {
      throw new Error(`does not understand "${part}"`);
    }
  }
  return {
    engine: primary.engine,
    model: primary.model,
    ...(primary.effort ? { effort: primary.effort } : {}),
    backup: backup ? backup.engine : '',
    ...(backup && backup.model ? { backup_model: backup.model } : {}),
    ...(backup && backup.effort ? { backup_effort: backup.effort } : {}),
    ...(maxSeconds ? { max_seconds: maxSeconds } : {}),
    until,
    ...(until ? {} : { never_expires: true }),
    ...(untilYearless ? { until_needs_year: untilYearless } : {}),
  };
}

// A job line's name part, "small build (like build)", split into the name
// and the kind it says it is like.
function splitJobName(text) {
  const match = /^(.*?)\s*\(\s*like\s+([a-z]+)\s*\)\s*$/i.exec(String(text || '').trim());
  return match ? { name: match[1].trim(), like: match[2].trim().toLowerCase() } : { name: String(text || '').trim(), like: '' };
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

// One worker line, "<tool>[, model: <m>][, effort: <e>][, max: <cap>][,
// until <date>]", checked against the kind of job it serves. Throws a plain
// sentence on anything wrong.
function rosterWorkerFromValue(value, role, options = {}) {
  const pick = rosterPickFromValue(value, role, { ...options, worker: true });
  return {
    engine: pick.engine,
    model: pick.model,
    ...(pick.effort ? { effort: pick.effort } : {}),
    ...(pick.max_seconds ? { max_seconds: pick.max_seconds } : {}),
    until: pick.until,
    ...(pick.never_expires ? { never_expires: true } : {}),
    ...(pick.until_needs_year ? { until_needs_year: pick.until_needs_year } : {}),
  };
}

// A job heading, "## small build (like build)", read as a job: its key, its
// label, and the kind of work it is. error says why it is not one.
function rosterJobHeading(title) {
  const { name, like } = splitJobName(title);
  const key = rosterJobKey(name);
  if (!key) return { error: rosterJobNameError(name) };
  const builtIn = ENGINE_ROLES.includes(key);
  const label = rosterJobLabel(key);
  const likeKind = like ? rosterJob(like) : '';
  if (like && !likeKind) return { key, label, error: `"like ${like}" is not search, build, or review` };
  if (builtIn && likeKind && ENGINE_JOBS[likeKind] !== key) return { key, label, error: `${label} is a built-in job and cannot be like ${likeKind}` };
  const kind = builtIn ? label : likeKind || inferJobKind(name);
  if (!kind) return { key, label, error: `say what kind of job "${label}" is, for example "## ${label} (like build)"` };
  return { key, label, kind, builtIn };
}

// Does this worker line start with a tool name? Only then does a line under
// a heading that is not a job deserve a warning; "- remember to renew" under
// "## notes" is just a note.
function namesATool(value) {
  const first = String(value || '').split(',')[0].trim();
  if (rosterToolName(first)) return true;
  try {
    resolveEngineModelWords(first);
    return true;
  } catch {
    return false;
  }
}

// A job's workers in order, whichever shape wrote them. A one-line pick reads
// as its engine, then its backup: the backup never expires and runs even with
// a model it cannot use, the way a one-line backup always has.
function pickWorkers(pick) {
  if (!pick) return [];
  if (Array.isArray(pick.workers)) return pick.workers;
  const cap = Number(pick.max_seconds) > 0 ? { max_seconds: Number(pick.max_seconds) } : {};
  const list = [{
    engine: pick.engine,
    model: pick.model || '',
    ...(pick.effort ? { effort: pick.effort } : {}),
    ...cap,
    until: pick.until,
    ...(pick.never_expires ? { never_expires: true } : {}),
    ...(pick.line ? { line: pick.line } : {}),
  }];
  if (pick.backup) {
    list.push({
      engine: pick.backup,
      model: pick.backup_model || '',
      ...(pick.backup_effort ? { effort: pick.backup_effort } : {}),
      ...cap,
      until: '',
      never_expires: true,
      lenient_model: true,
      backup: true,
      ...(pick.line ? { line: pick.line } : {}),
    });
  }
  return list;
}

// Read one ROSTER.md into picks keyed like the JSON roster, the raw team
// lines, and one warning per line that could not be used. Never throws on
// what the file says. A sectioned job's pick carries its workers in order;
// engine, model, and backup mirror its first two good workers.
function parseRosterMarkdown(text, file, options = {}) {
  const { scanRosterMarkdown, jobSections } = require('./roster-markdown');
  const display = rosterFileLabel(file, options.root || process.cwd());
  const picks = {};
  const team = [];
  const warnings = [];
  const warn = (entry, message) => warnings.push({ file: display, line: entry.lineNumber, text: entry.raw, message });
  const scan = scanRosterMarkdown(text);
  const sections = new Map(jobSections(scan).map((section) => [section.heading.index, section]));
  const done = new Set();
  const readSection = (section) => {
    const { heading, workers: lines } = section;
    const job = rosterJobHeading(heading.title);
    if (job.error) {
      if (lines.some((entry) => namesATool(entry.value))) warn(heading, `${job.error}, so the section is skipped`);
      return;
    }
    const { key, label, kind, builtIn } = job;
    if (picks[key]) {
      warn(heading, `sets ${label} a second time; line ${picks[key].line} wins`);
      return;
    }
    const workers = [];
    for (const entry of lines) {
      try {
        const worker = rosterWorkerFromValue(entry.value, ENGINE_JOBS[kind], options);
        workers.push({ ...worker, line: entry.lineNumber, text: entry.raw });
        if (worker.until_needs_year) warn(entry, `has no year in its until date, so this ${label} worker counts as expired; write until ${worker.until_needs_year}`);
      } catch (error) {
        warn(entry, `${error.message}, so ${label} skips this worker`);
        workers.push({ engine: rosterToolName(String(entry.value).split(',')[0]) || '', model: '', until: '', error: error.message, line: entry.lineNumber, text: entry.raw });
      }
    }
    const good = workers.filter((worker) => !worker.error);
    if (!good.length) return;
    const [first, second] = good;
    picks[key] = {
      engine: first.engine,
      model: first.model,
      ...(first.effort ? { effort: first.effort } : {}),
      backup: second ? second.engine : '',
      ...(second && second.model ? { backup_model: second.model } : {}),
      ...(first.max_seconds ? { max_seconds: first.max_seconds } : {}),
      until: first.until,
      ...(first.never_expires ? { never_expires: true } : {}),
      ...(builtIn ? {} : { like: kind }),
      workers,
      file: display,
      line: heading.lineNumber,
    };
  };
  for (const entry of scan.entries) {
    if (entry.section === 'job') {
      if (!done.has(entry.headingIndex)) {
        done.add(entry.headingIndex);
        readSection(sections.get(entry.headingIndex));
      }
      continue;
    }
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
      if (pick.until_needs_year) {
        warn(entry, `has no year in its until date, so ${label} counts as expired; write until ${pick.until_needs_year}`);
      }
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
  const md = readRosterMarkdownLayer('project', projectRosterFile(projectRosterRoot(root)), { ...options, root });
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

// --- session changes ----------------------------------------------------
//
// A session file sits above this project and all projects, one job at a
// time: a job it names replaces that job's whole list for this shell only.
// The key is ATRIS_ROSTER_SESSION, else the terminal's own session id. Agent
// shells have no terminal, so they set the variable. A file no resolution
// has read for a day is ignored and removed on the next read.

const SESSION_ROSTER_TTL_MS = 24 * 60 * 60 * 1000;
const NO_SESSION_MESSAGE = 'this shell has no session to attach changes to; set ATRIS_ROSTER_SESSION=<name> and run it again';
let terminalSessionMemo;

function terminalSessionKey() {
  if (terminalSessionMemo === undefined) {
    try {
      terminalSessionMemo = require('../utils/auth').getTerminalSessionId() || '';
    } catch {
      terminalSessionMemo = '';
    }
  }
  return terminalSessionMemo;
}

// Test runs only key off ATRIS_ROSTER_SESSION, never the terminal around them.
function rosterSessionKey(options = {}) {
  if (options.sessionKey !== undefined) return String(options.sessionKey || '').trim();
  const named = String(process.env.ATRIS_ROSTER_SESSION || '').trim();
  if (named) return named;
  if (process.env.NODE_TEST_CONTEXT) return '';
  return terminalSessionKey();
}

function sessionRosterDir(options = {}) {
  if (options.sessionRosterDir) return options.sessionRosterDir;
  if (process.env.ATRIS_ROSTER_SESSIONS_DIR) return process.env.ATRIS_ROSTER_SESSIONS_DIR;
  if (options.machineRosterFile || process.env.ATRIS_MACHINE_ROSTER_PATH) return path.join(path.dirname(machineRosterFile(options)), 'sessions');
  return path.join(os.homedir(), '.atris', 'sessions');
}

// Like the all-projects roster: off in test runs unless a test points the
// home folder somewhere scratch.
function sessionRosterEnabled(options = {}) {
  if (options.sessionRoster === false) return false;
  if (options.sessionRosterDir || process.env.ATRIS_ROSTER_SESSIONS_DIR) return true;
  if (options.machineRosterFile || process.env.ATRIS_MACHINE_ROSTER_PATH) return true;
  return !process.env.NODE_TEST_CONTEXT;
}

// The file name is a short readable part of the key plus a hash of the whole
// key, so "shell/b" and "shell-b", or two long keys that only differ at the
// end, never share a file. Only letters, digits, _ . - reach the name, and it
// never starts with a dot or dash, so a key cannot climb out of the folder.
function sessionRosterFile(options = {}) {
  const key = rosterSessionKey(options);
  if (!key) return '';
  const readable = key.replace(/[^A-Za-z0-9_.-]/g, '-').replace(/^[.-]+/, '').slice(0, 32).replace(/[.-]+$/, '');
  const hash = crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);
  return path.join(sessionRosterDir(options), `roster-${readable ? `${readable}-` : ''}${hash}.md`);
}

function sessionClock(options = {}) {
  const at = options.sessionClock !== undefined ? new Date(options.sessionClock).getTime() : Date.now();
  return Number.isFinite(at) ? at : Date.now();
}

// Remove a session file nobody has read for a day. true when it was stale.
function dropStaleSessionFile(file, clock) {
  try {
    if (clock - fs.statSync(file).mtimeMs <= SESSION_ROSTER_TTL_MS) return false;
  } catch {
    return false;
  }
  try { fs.unlinkSync(file); } catch {}
  return true;
}

function readSessionRosterLayer(options = {}) {
  const root = options.root || process.cwd();
  const key = sessionRosterEnabled(options) ? rosterSessionKey(options) : '';
  const file = key ? sessionRosterFile(options) : '';
  const empty = { scope: 'session', format: 'none', key, path: file, file: file ? rosterFileLabel(file, root) : '', picks: {}, team: [], warnings: [] };
  if (!file || !fs.existsSync(file)) return empty;
  const clock = sessionClock(options);
  if (dropStaleSessionFile(file, clock)) return { ...empty, stale: true };
  const md = readRosterMarkdownLayer('session', file, { ...options, root });
  if (!md) return empty;
  // Reading marks the file used, so an active session never goes stale.
  try { fs.utimesSync(file, new Date(clock), new Date(clock)); } catch {}
  return { ...md, key, file: rosterFileLabel(file, root) };
}

// Every other stale session roster in the folder goes when one is written.
function sweepStaleSessionRosters(options = {}) {
  const dir = sessionRosterDir(options);
  const clock = sessionClock(options);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (/^roster-.+\.md$/.test(name)) dropStaleSessionFile(path.join(dir, name), clock);
  }
}

function clearSessionRoster(options = {}) {
  const key = rosterSessionKey(options);
  if (!key) throw new Error(NO_SESSION_MESSAGE);
  const file = sessionRosterFile(options);
  if (!sessionRosterEnabled(options) || !fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  return true;
}

// Every layer at once: this session's changes, this project's roster, and
// the all-projects roster, each from ROSTER.md when it exists, else from the
// older JSON file.
function readRosterState(root = process.cwd(), options = {}) {
  return {
    session: readSessionRosterLayer({ ...options, root }),
    project: readProjectRoster(root, options),
    machine: readMachineRosterLayer({ ...options, root }),
  };
}

// --- writing the sectioned shape ------------------------------------------

// A model the way a person writes it on a worker line, when that spelling
// reads back as the same model; else the saved id itself.
function workerModelText(engine, model) {
  const label = rosterModelLabel(model);
  try {
    if (normalizeRosterModel(engine, label) === model) return label;
  } catch {}
  return model;
}

// One worker line: "- claude code, model: opus 5.5, effort: high, max: 20 min, until 2026-10-24".
function workerLineText(worker) {
  const parts = [rosterToolLabel(worker.engine)];
  if (worker.model) parts.push(`model: ${workerModelText(worker.engine, worker.model)}`);
  if (worker.effort) parts.push(`effort: ${worker.effort}`);
  if (Number(worker.max_seconds) > 0) parts.push(`max: ${rosterMaxText(worker.max_seconds).replace(/^max /, '')}`);
  if (worker.until) parts.push(`until ${worker.until}`);
  return `- ${parts.join(', ')}`;
}

// "## small build", or "## quick fixes (like build)" when the name does not
// say its kind.
function jobHeadingText(key, like = '') {
  const label = rosterJobLabel(key);
  const custom = !ENGINE_ROLES.includes(key);
  const likeText = custom && like && inferJobKind(label) !== like ? ` (like ${like})` : '';
  return `## ${label}${likeText}`;
}

// A one-line pick as worker lines with the same meaning: the engine keeps
// the line's until, the backup never expires, and both keep the time cap. A
// backup model the engine cannot run was never used, so it is left off.
function workerLinesForPick(pick) {
  return pickWorkers(pick).map((worker) => {
    const model = worker.lenient_model ? savedRosterModel(worker.engine, worker.model) || '' : worker.model;
    return workerLineText({ ...worker, model });
  });
}

function jobBlock(key, pick) {
  return [jobHeadingText(key, pick.like || ''), ...workerLinesForPick(pick)];
}

// The first write to a layer with no ROSTER.md carries its JSON picks over,
// dates included. The JSON file stays where it is, untouched.
function rosterMarkdownFromPicks(picks) {
  const { ROSTER_MARKDOWN_TEMPLATE } = require('./roster-markdown');
  const keys = [...ENGINE_ROLES.filter((role) => role in (picks || {})), ...customRosterJobKeys(picks)];
  const order = ['executor', 'validator', 'navigator'];
  keys.sort((a, b) => {
    const ai = order.indexOf(a);
    const bi = order.indexOf(b);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });
  const blocks = keys
    .map((key) => ({ key, pick: rosterPickObject(picks[key]) }))
    .filter(({ key, pick }) => pick && (ENGINE_ROLES.includes(key) || customPickRole(pick)))
    .map(({ key, pick }) => [...jobBlock(key, pick), '']);
  return [...ROSTER_MARKDOWN_TEMPLATE, ...blocks.flat()].join('\n');
}

function isBlankLine(line) {
  return !String(line || '').trim();
}

// A ROSTER.md in the one-line shape, rewritten into sections with the same
// meaning: each good job line becomes its own "## job" section (the backup is
// the second worker), team lines become "- member: value", and comments,
// notes, and every other line stay where they were. A line that could not be
// used stays as written, so it still warns; a second line for a job that was
// already set turns into a comment, since it never counted.
function sectionedRosterText(text, file, options = {}) {
  const { scanRosterMarkdown, joinLines, OLD_ROSTER_NOTE, ROSTER_NOTE } = require('./roster-markdown');
  const scan = scanRosterMarkdown(text);
  const oldJobs = scan.entries.filter((entry) => entry.section === 'jobs' && !entry.malformed);
  const plainTeam = scan.entries.filter((entry) => entry.section === 'team' && !entry.dashed && !entry.malformed);
  const oldNote = scan.lines.some((line) => line.trim() === OLD_ROSTER_NOTE);
  if (!oldJobs.length && !plainTeam.length && !oldNote) return text;
  const { picks } = parseRosterMarkdown(text, file, options);
  const pickAt = new Map(Object.entries(picks).filter(([, pick]) => !pick.workers).map(([key, pick]) => [pick.line, key]));
  const byIndex = new Map(scan.entries.map((entry) => [entry.index, entry]));
  const firstJob = oldJobs.length ? oldJobs[0].index : -1;
  const SLOT = '\u0000';
  const kept = [];
  const moved = [];
  const blocks = [];
  scan.lines.forEach((raw, index) => {
    const entry = byIndex.get(index);
    if (index === firstJob) kept.push(SLOT);
    if (entry && entry.section === 'jobs' && !entry.malformed) {
      const key = pickAt.get(entry.lineNumber);
      if (key) {
        // A comment right above the line and a note at its end go with it.
        const above = [];
        while (kept.length && kept[kept.length - 1] !== SLOT && /^\s*<!--.*-->\s*$/.test(kept[kept.length - 1])) above.unshift(kept.pop());
        const [heading, ...workers] = jobBlock(key, picks[key]);
        const note = /\s*(<!--.*?-->)\s*$/.exec(raw);
        blocks.push('', ...above, `${heading}${note ? ` ${note[1]}` : ''}`, ...workers);
        return;
      }
      const sameJob = rosterJobKey(splitJobName(entry.name).name);
      if (sameJob && picks[sameJob]) {
        moved.push(`<!-- never used, ${rosterJobLabel(sameJob)} was set on another line: ${raw.trim()} -->`);
        return;
      }
      // A line that could not be used keeps warning above the sections.
      moved.push(raw);
      return;
    }
    if (entry && entry.section === 'team' && !entry.dashed && !entry.malformed) {
      kept.push(`${/^\s*/.exec(raw)[0]}- ${raw.trim()}`);
      return;
    }
    kept.push(raw.trim() === OLD_ROSTER_NOTE ? ROSTER_NOTE : raw);
  });
  const out = [];
  for (const line of kept) {
    if (line === SLOT) out.push(...moved, ...blocks, '');
    else out.push(line);
  }
  // One blank line between blocks, never two, and none at the very end.
  const tidy = out.filter((line, index) => !(isBlankLine(line) && index > 0 && isBlankLine(out[index - 1])));
  while (tidy.length && isBlankLine(tidy[tidy.length - 1])) tidy.pop();
  return joinLines(tidy, scan.newline);
}

// Where an assign writes: this session, all projects (--everywhere), or this
// project.
function rosterWriteTarget(options, root) {
  if (options.session && options.everywhere) throw new Error('pick one: --session or --everywhere');
  if (options.session) {
    if (!rosterSessionKey(options)) throw new Error(NO_SESSION_MESSAGE);
    if (!sessionRosterEnabled(options)) throw new Error('session changes are off in test runs; set ATRIS_ROSTER_SESSIONS_DIR to a scratch folder');
    return { scope: 'session', file: sessionRosterFile(options), layer: readSessionRosterLayer({ ...options, root }) };
  }
  if (options.everywhere) {
    if (!machineRosterEnabled(options)) throw new Error('the all-projects roster is off in test runs; set ATRIS_MACHINE_ROSTER_PATH to a scratch file');
    return { scope: 'machine', file: machineRosterMarkdownFile(options), layer: readMachineRosterLayer({ ...options, root }) };
  }
  return { scope: 'project', file: projectRosterFile(projectRosterRoot(root)), layer: null };
}

// The new list of worker lines for one assign. null removes the job.
function assignedWorkerLines(key, engineName, options, context) {
  const { registry, savedPick, currentLines, currentWorkers, jobName } = context;
  const builtIn = ENGINE_ROLES.includes(key);
  const label = rosterJobLabel(key);
  if (options.clear) return { lines: null };
  if (options.remove !== undefined) {
    const tool = rosterToolName(options.remove);
    if (!tool) throw new Error(`unknown tool "${options.remove}"`);
    const keep = currentLines.filter((line, index) => currentWorkers[index].engine !== tool);
    if (keep.length === currentLines.length) throw new Error(`${label} has no ${tool} worker to remove`);
    return { lines: keep.length ? keep : null };
  }
  const likeName = String(options.like || '').trim();
  const likeKind = likeName ? rosterJob(likeName) : '';
  if (likeName && !likeKind) throw new Error(`unknown kind "${likeName}". use --like search, build, or review`);
  if (builtIn && likeKind && ENGINE_JOBS[likeKind] !== key) throw new Error(`${label} is a built-in job; --like is only for your own jobs`);
  const savedKind = builtIn ? '' : Object.keys(ENGINE_JOBS).find((kind) => ENGINE_JOBS[kind] === customPickRole(savedPick)) || '';
  const kind = builtIn ? label : likeKind || inferJobKind(jobName) || savedKind;
  if (!kind) throw new Error(`say what kind of job "${label}" is: add --like search, --like build, or --like review`);
  const role = ENGINE_JOBS[kind];
  const engineId = rosterToolName(engineName);
  const engine = registry.engines.find((entry) => entry.id === engineId);
  if (!engine) throw new Error(`unknown engine "${engineName}"`);
  if (!engineHasRole(engine, role)) throw new Error(`${engine.id} cannot do ${builtIn ? label : `${kind} work, so it cannot take ${label}`}`);
  // --backup takes engine words with an optional model and effort, the
  // same as a written line: --backup "claude opus 5.5".
  const backupName = String(options.backup || '').trim();
  if (backupName && options.add) throw new Error('use --backup without --add; --add puts a worker at the end of the list');
  let backupRead = null;
  if (backupName) {
    try {
      backupRead = resolveRosterWords(backupName);
    } catch (error) {
      throw new Error(rosterToolName(backupName.split(' ')[0]) ? `the backup ${error.message}` : `unknown backup engine "${backupName}"`);
    }
  }
  const backup = backupRead ? registry.engines.find((entry) => entry.id === backupRead.engine) : null;
  if (backupName && !backup) throw new Error(`unknown backup engine "${backupName}"`);
  if (backup && !engineHasRole(backup, role)) throw new Error(`${backup.id} cannot do ${builtIn ? label : `${kind} work, so it cannot back up ${label}`}`);
  // No --days means the worker holds until someone changes the line.
  const days = options.days === undefined ? null : Number(options.days);
  if (days !== null && (!Number.isSafeInteger(days) || days < 1)) throw new Error('days must be a positive whole number');
  const model = normalizeRosterModel(engine.id, options.model);
  if (model && !engineTakesModel(engine.id)) throw new Error(`${engine.id} runs one fixed model and cannot take "${model}"`);
  const effort = String(options.effort || '').trim().toLowerCase();
  if (effort && !EFFORT_WORDS.includes(effort)) throw new Error(`"${effort}" is not an effort; use ${EFFORT_WORDS.join(', ')}`);
  if (effort && !engineEffortLevels(engine.id).includes(effort)) throw new Error(effortRefusal(engine.id, effort));
  const maxSeconds = options.max === undefined ? null : parseRosterMax(`max ${String(options.max).replace(/^max\s*:?\s*/i, '')}`);
  if (options.max !== undefined && !maxSeconds) throw new Error(`"${options.max}" is not a time cap; use --max "20 min", --max 90s, or --max 2h`);
  const now = rosterDate(options.now);
  const line = workerLineText({
    engine: engine.id,
    model,
    ...(effort ? { effort } : {}),
    ...(maxSeconds ? { max_seconds: maxSeconds } : {}),
    until: days ? rosterUntil(now, days) : '',
  });
  const heading = jobHeadingText(key, builtIn ? '' : kind);
  if (options.add) return { lines: [...currentLines, line], heading };
  // A note the person left at the end of the old lead line stays with the lead.
  const leadNote = currentLines.length ? /\s*(<!--.*?-->)\s*$/.exec(currentLines[0]) : null;
  const lead = leadNote ? `${line} ${leadNote[1]}` : line;
  // The new lead replaces the first line; the same tool and model further
  // down would only repeat it, so that line goes.
  const same = (index) => currentWorkers[index].engine === engine.id && (currentWorkers[index].model || '') === model;
  const rest = currentLines.filter((text, index) => index > 0 && !same(index));
  if (!backup) return { lines: [lead, ...rest], heading };
  const backupLine = workerLineText({
    engine: backup.id,
    model: backupRead.model || '',
    ...(backupRead.effort ? { effort: backupRead.effort } : {}),
    ...(maxSeconds ? { max_seconds: maxSeconds } : {}),
    until: '',
  });
  return { lines: [lead, backupLine, ...rest.slice(1)], heading };
}

// Assign one job by editing its section in ROSTER.md: this project's
// atris/ROSTER.md, ~/.atris/ROSTER.md with everywhere, or this session's file
// with session. The default sets the lead worker (the first line) and keeps
// the rest; add appends a worker; remove drops every worker on that tool;
// backup sets the second worker; clear removes the job. Only that job's
// section changes; comments, order, and every other line stay as written. A
// file still in the one-line shape is rewritten into sections first, with
// the same meaning. The three built-in jobs keep their role keys; any other
// name is a custom job whose kind (search, build, or review) comes from
// --like, its name, or its saved section, and tools are checked against it.
function setRosterPick(jobName, engineName, options = {}, root = process.cwd()) {
  const { replaceJobSection, scanRosterMarkdown, jobSections } = require('./roster-markdown');
  const key = rosterJobKey(jobName);
  if (!key) throw new Error(rosterJobNameError(jobName));
  const registry = readEngineRegistry(root, { persist: false });
  const target = rosterWriteTarget(options, root);
  const layer = target.layer || readProjectRoster(root, { ...options, registry });
  const file = target.file;
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (existing === null && (options.clear || options.remove !== undefined) && !Object.keys(layer.picks || {}).length) return {};
  const base = existing !== null ? sectionedRosterText(existing, file, { ...options, root }) : rosterMarkdownFromPicks(layer.picks);
  const parsed = parseRosterMarkdown(base, file, { ...options, root });
  const savedPick = rosterPickObject(parsed.picks[key]);
  const section = jobSections(scanRosterMarkdown(base)).find((entry) => rosterJobHeading(entry.heading.title).key === key);
  const workerEntries = section ? section.workers : [];
  const currentWorkers = workerEntries.map((entry) => {
    const worker = savedPick && savedPick.workers ? savedPick.workers.find((item) => item.line === entry.lineNumber) : null;
    return worker || { engine: rosterToolName(String(entry.value).split(',')[0]), model: '' };
  });
  const { lines, heading } = assignedWorkerLines(key, engineName, options, {
    registry,
    savedPick,
    currentLines: workerEntries.map((entry) => entry.raw),
    currentWorkers,
    jobName,
  });
  const next = replaceJobSection(base, {
    matches: (title) => rosterJobHeading(title).key === key,
    heading: heading || jobHeadingText(key),
    lines,
  });
  writeAtomic(file, next);
  if (target.scope === 'session') {
    sweepStaleSessionRosters(options);
    return readSessionRosterLayer({ ...options, root }).picks;
  }
  return target.scope === 'machine' ? readMachineRoster(options) : readProjectRoster(root, options).picks;
}

function renewRoster(roster, date) {
  const next = { ...(roster || {}) };
  for (const key of [...ENGINE_ROLES, ...customRosterJobKeys(next)]) {
    if (next[key]) next[key] = { ...next[key], until: rosterUntil(date, 30), set_at: date.toISOString() };
  }
  return next;
}

// Renew every dated line in one ROSTER.md for thirty days. Only the date
// after "until" changes; lines with no until never expire, so they stay
// exactly as written, and so does everything else on a renewed line.
function renewRosterMarkdown(file, date, options = {}) {
  const { rewriteRosterValues } = require('./roster-markdown');
  const text = fs.readFileSync(file, 'utf8');
  const parsed = parseRosterMarkdown(text, file, options);
  const renewLines = new Set();
  for (const pick of Object.values(parsed.picks)) {
    if (!Array.isArray(pick.workers)) {
      if (pick.until) renewLines.add(pick.line);
      continue;
    }
    for (const worker of pick.workers) if (!worker.error && worker.until) renewLines.add(worker.line);
  }
  const until = rosterUntil(date, 30);
  const next = rewriteRosterValues(text, (entry) => {
    if ((entry.section !== 'jobs' && entry.section !== 'job') || !renewLines.has(entry.lineNumber)) return undefined;
    return entry.raw.replace(/(,\s*until\s*:?\s+)(\d{4}-\d{2}-\d{2})/i, `$1${until}`);
  });
  if (next !== text) writeAtomic(file, next);
}

// Confirm renews this project's picks and the all-projects picks together.
// In a ROSTER.md only lines that carry an until date are renewed.
function confirmRoster(root = process.cwd(), now = new Date(), options = {}) {
  const date = rosterDate(now);
  const projectMd = projectRosterFile(projectRosterRoot(root));
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

const ROSTER_SOURCES = Object.freeze({ session: 'this session', project: 'this project', machine: 'all projects' });
const ROSTER_LAYERS = Object.freeze(['session', 'project', 'machine']);

// A pick's workers, each with the engine it would run (model, effort, and
// time cap pinned) or the reason it is skipped: bad line, expired, bad model,
// or not ready (down, or it cannot do this kind of work).
function rosterWorkerWalk(pick, role, registry, now) {
  const ready = registry.engines
    .filter((engine) => engine.health && engine.health.status === 'ready')
    .filter((engine) => engineHasRole(engine, role));
  return pickWorkers(pick).map((worker) => {
    if (worker.error) return { worker, skip: 'bad line', engine: null, raw: null };
    if (rosterPickExpired(worker, now)) return { worker, skip: 'expired', engine: null, raw: null };
    const saved = savedRosterModel(worker.engine, worker.model);
    if (saved === null && !worker.lenient_model) return { worker, skip: 'bad model', engine: null, raw: null };
    const raw = ready.find((engine) => engine.id === worker.engine) || null;
    if (!raw) return { worker, skip: 'not ready', engine: null, raw: null };
    // A backup runs its own model and effort, never the lead's.
    const model = saved || '';
    const effort = savedRosterEffort(raw.id, worker.effort);
    const maxSeconds = Number(worker.max_seconds) > 0 ? Number(worker.max_seconds) : 0;
    const engine = model || effort || maxSeconds
      ? {
        ...raw,
        ...(model ? { roster_model: model } : {}),
        ...(effort ? { roster_effort: effort } : {}),
        ...(maxSeconds ? { roster_max_seconds: maxSeconds } : {}),
      }
      : raw;
    return { worker, skip: '', engine, raw };
  });
}

// One pick's walk down its workers in order. The first worker that can run
// leads; null means the next pick in line decides. A custom pick only counts
// when its kind matches the role being resolved. team is every worker that
// can run, lead first.
function rosterChoiceForPick(pick, role, registry, { key, label, source, scopeText = '', now } = {}) {
  if (!pick || !pick.engine) return null;
  if (key !== undefined && pickRoleForKey(key, pick) !== role) return null;
  const walk = rosterWorkerWalk(pick, role, registry, now);
  const leadIndex = walk.findIndex((step) => !step.skip);
  if (leadIndex === -1) return null;
  const lead = walk[leadIndex];
  const after = walk.slice(leadIndex + 1).filter((step) => !step.skip);
  const first = walk[0];
  const why = first.skip === 'expired' ? 'expired'
    : first.skip === 'bad model' ? `names a model ${first.worker.engine} cannot run`
      : first.skip === 'bad line' ? 'has a bad first line'
        : 'is not ready';
  return {
    engine: lead.engine,
    backup: leadIndex === 0 && after.length ? after[0].raw : null,
    team: [lead.engine, ...after.map((step) => step.engine)],
    lead_index: leadIndex,
    walk,
    source,
    job: label,
    pick,
    reason: leadIndex === 0
      ? `roster pick for ${label}${scopeText}: ${lead.engine.id}`
      : `roster pick for ${label}${scopeText} ${why}, using backup: ${lead.engine.id}`,
  };
}

const ROSTER_SCOPE_TEXT = Object.freeze({ session: ' (this session)', project: '', machine: ' (all projects)' });

// Walk one job's roster layers in order: this session, this project, all
// projects. Within a layer the job's workers go in order. The first worker
// that can run wins; null means the next job in line (or the router) decides.
function rosterChoiceForKey(key, role, registry, machine, options = {}) {
  const label = rosterJobLabel(key);
  const session = options.sessionRosterPicks || {};
  const layers = [
    { source: 'session', pick: session[key] },
    { source: 'project', pick: registry.roster && registry.roster[key] },
    { source: 'machine', pick: machine && machine[key] },
  ];
  for (const { source, pick } of layers) {
    const choice = rosterChoiceForPick(pick, role, registry, {
      key,
      label,
      source,
      scopeText: ROSTER_SCOPE_TEXT[source],
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
  const sessionRosterPicks = options.sessionRosterPicks || readSessionRosterLayer(options).picks;
  for (const key of rosterJobKeysFor(role, options)) {
    const choice = rosterChoiceForKey(key, role, registry, machine, { ...options, sessionRosterPicks });
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
    // The job's own workers go first, in order, then the router's list.
    const after = choice.walk.slice(choice.lead_index + 1).filter((step) => !step.skip).map((step) => step.raw);
    const lead = [choice.engine, ...after].filter((engine, index, list) => list.findIndex((other) => other.id === engine.id) === index);
    const leadIds = new Set(lead.map((engine) => engine.id));
    return {
      engine: choice.engine,
      reason: choice.reason,
      source: choice.source,
      job: choice.job,
      team: choice.team,
      ranked: [...lead, ...ranked.candidates.filter((candidate) => !leadIds.has(candidate.id))],
    };
  }
  return { engine: ranked.candidates[0] || null, reason: routerPickExplanation(ranked), source: 'router', team: [], ranked: ranked.candidates };
}

// The ordered team for one job: every worker that can run right now, lead
// first, each with its model, effort, and time cap pinned. Split work goes
// across the team in this order. With no roster line the router's single
// pick is the whole team.
function resolveJobTeam(job, root = process.cwd(), options = {}) {
  const key = rosterJobKey(job);
  if (!key) throw new Error(rosterJobNameError(job));
  const label = rosterJobLabel(key);
  const role = rosterJobRole(job, root, options);
  if (!role) return { job: label, key, role: '', source: 'none', lead: null, team: [], reason: `${label} names no kind of work yet` };
  const custom = !ENGINE_ROLES.includes(key);
  const resolved = resolveEngineForRoleRanked(role, root, { ...options, ...(custom ? { job: key } : {}) });
  const team = resolved.team && resolved.team.length ? resolved.team : resolved.engine ? [resolved.engine] : [];
  return { job: label, key, role, source: resolved.source, lead: resolved.engine || null, team, reason: resolved.reason };
}

// True when a roster line (not the router) decided.
function rosterDecided(source) {
  return ROSTER_LAYERS.includes(source);
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
// exact engine: roster_model, roster_effort, roster_max_seconds. {} otherwise.
// A caller that already chose an engine (a mission's preferred engine,
// --engine) still gets the pins.
function rosterPinFor(role, engineId, root = process.cwd(), options = {}) {
  const normalizedRole = String(role || '').trim().toLowerCase();
  if (!ENGINE_ROLES.includes(normalizedRole) || !engineId) return {};
  const choice = rosterChoice(normalizedRole, withProjectRoster(readEngineRegistry(root, { persist: false }), root, options), options);
  if (!choice || choice.engine.id !== engineId) return {};
  const pin = {};
  for (const field of ['roster_model', 'roster_effort', 'roster_max_seconds']) {
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
  if (preferred.health && preferred.health.status === 'ready') {
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
  rosterPinFor,
  rosterMaxText,
  mainCheckoutRoot,
  ROSTER_LAYERS,
  rosterDecided,
  rosterToolLabel,
  rosterWorkerWalk,
  resolveJobTeam,
  rosterSessionKey,
  clearSessionRoster,
  NO_SESSION_MESSAGE,
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
