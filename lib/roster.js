'use strict';

// The roster's layers and how a job resolves through them: this session's
// changes, this project's atris/ROSTER.md, and the all-projects
// ~/.atris/ROSTER.md (each falls back to its older JSON file), read into
// picks; a job's workers walked in order against the engine registry; and
// the edits (assign one job, confirm every dated worker). Only the lines an
// edit names move; comments, order, and every other line stay as written.
// Words (text to pick and back) live in roster-words.js.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EFFORT_WORDS, engineTakesModel, engineEffortLevels } = require('./runner-command');
const {
  ENGINE_ROLES, canonicalEngineName, coolingView, engineCooling, engineHasRole, engineReadyAt,
  engineRegistryFile, readEngineRegistry, resolveEngineForRoleRanked, writeEngineRegistry,
} = require('./engine-registry');
const {
  ROSTER_MARKDOWN_TEMPLATE, OLD_ROSTER_NOTE, ROSTER_NOTE, isBlank, jobSections, joinLines,
  replaceJobSection, rewriteRosterValues, scanRosterMarkdown,
} = require('./roster-markdown');
const { homeLabel } = require('./roster-models');
const {
  ENGINE_JOBS, SMALL_BUILD_JOB, customPickRole, customRosterJobKeys, effortRefusal, inferJobKind,
  jobBlock, jobHeadingText, namesATool, normalizeRosterModel, parseRosterMax, pickRoleForKey,
  pickWorkers, resolveRosterWords, rosterDate, rosterJob, rosterJobHeading, rosterJobKey,
  rosterJobLabel, rosterJobNameError, rosterPickExpired, rosterPickFromValue, rosterPickObject,
  rosterToolName, rosterUntil, rosterWorkerFromValue, savedRosterEffort, savedRosterModel,
  selfPrepWarning, splitJobName, workerLineText,
} = require('./roster-words');

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

function machineRosterFile(options = {}) {
  return options.machineRosterFile
    || process.env.ATRIS_MACHINE_ROSTER_PATH
    || path.join(os.homedir(), '.atris', 'roster.json');
}

// The all-projects ROSTER.md. A scratch roster.json path (tests, sandboxes)
// keeps its markdown beside it, so pointing one override away from the home
// folder moves both files.
function machineRosterMarkdownFile(options = {}) {
  return options.machineRosterMarkdownFile
    || process.env.ATRIS_MACHINE_ROSTER_MD_PATH
    || path.join(path.dirname(machineRosterFile(options)), 'ROSTER.md');
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

function rosterFileLabel(file, root = process.cwd()) {
  const abs = path.resolve(file);
  const rel = path.relative(path.resolve(root), abs);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  return homeLabel(abs);
}

// Read one ROSTER.md into picks keyed like the JSON roster, the raw team
// lines, and one warning per line that could not be used. Never throws on
// what the file says. A sectioned job's pick carries its workers in order;
// engine, model, and backup mirror its first two good workers.
function parseRosterMarkdown(text, file, options = {}) {
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
        const selfPrep = selfPrepWarning(worker, key, label);
        if (selfPrep) warn(entry, selfPrep);
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
      ...(first.prep ? { prep: first.prep } : {}),
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
    const job = rosterJobHeading(entry.name, { example: '' });
    if (job.error) {
      warn(entry, `${job.error}, so ${job.failure === 'like' ? `${job.label} uses the next pick in line` : 'the line is skipped'}`);
      continue;
    }
    const { key, label, kind, builtIn } = job;
    if (picks[key]) {
      warn(entry, `sets ${label} a second time; line ${picks[key].line} wins`);
      continue;
    }
    try {
      const pick = rosterPickFromValue(entry.value, ENGINE_JOBS[kind], options);
      const selfPrep = selfPrepWarning(pick, key, label);
      if (selfPrep) warn(entry, selfPrep);
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

// Beside the all-projects roster, so a scratch roster.json moves this too.
function sessionRosterDir(options = {}) {
  return options.sessionRosterDir
    || process.env.ATRIS_ROSTER_SESSIONS_DIR
    || path.join(path.dirname(machineRosterFile(options)), 'sessions');
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

const ROSTER_SOURCES = Object.freeze({ session: 'this session', project: 'this project', machine: 'all projects' });
const ROSTER_LAYERS = Object.freeze(['session', 'project', 'machine']);

// A pick's workers, each with the engine it would run (model, effort, and
// time cap pinned) or the reason it is skipped: bad line, expired, bad model,
// or not ready (down, or it cannot do this kind of work).
function rosterWorkerWalk(pick, role, registry, now) {
  const ready = registry.engines
    .filter((engine) => engineReadyAt(engine, now))
    .filter((engine) => engineHasRole(engine, role));
  return pickWorkers(pick).map((worker) => {
    if (worker.error) return { worker, skip: 'bad line', engine: null, raw: null };
    if (rosterPickExpired(worker, now)) return { worker, skip: 'expired', engine: null, raw: null };
    const saved = savedRosterModel(worker.engine, worker.model);
    if (saved === null && !worker.lenient_model) return { worker, skip: 'bad model', engine: null, raw: null };
    const raw = ready.find((engine) => engine.id === worker.engine) || null;
    if (!raw) {
      // A worker benched after a stall says so and when it comes back.
      const benched = registry.engines.find((engine) => engine.id === worker.engine && engineCooling(engine, now));
      if (benched) return { worker, skip: 'cooling', cooling: coolingView(benched), engine: null, raw: null };
      return { worker, skip: 'not ready', engine: null, raw: null };
    }
    // A backup runs its own model and effort, never the lead's.
    const model = saved || '';
    const effort = savedRosterEffort(raw.id, worker.effort);
    const maxSeconds = Number(worker.max_seconds) > 0 ? Number(worker.max_seconds) : 0;
    const prep = worker.prep || '';
    const engine = model || effort || maxSeconds || prep
      ? {
        ...raw,
        ...(model ? { roster_model: model } : {}),
        ...(effort ? { roster_effort: effort } : {}),
        ...(maxSeconds ? { roster_max_seconds: maxSeconds } : {}),
        ...(prep ? { roster_prep: prep } : {}),
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
    : first.skip === 'cooling' ? `is ${first.cooling.text}`
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

// --- edits ---------------------------------------------------------------

const MACHINE_ROSTER_SCHEMA = 'atris.machine_roster.v1';

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

// The first write to a layer with no ROSTER.md carries its JSON picks over,
// dates included. The JSON file stays where it is, untouched.
function rosterMarkdownFromPicks(picks) {
  // Build, review, search, then the owner's own jobs in saved order.
  const keys = [...['executor', 'validator', 'navigator'].filter((role) => role in (picks || {})), ...customRosterJobKeys(picks)];
  const blocks = keys
    .map((key) => ({ key, pick: rosterPickObject(picks[key]) }))
    .filter(({ key, pick }) => pick && (ENGINE_ROLES.includes(key) || customPickRole(pick)))
    .map(({ key, pick }) => [...jobBlock(key, pick), '']);
  return [...ROSTER_MARKDOWN_TEMPLATE, ...blocks.flat()].join('\n');
}

// A ROSTER.md in the one-line shape, rewritten into sections with the same
// meaning: each good job line becomes its own "## job" section (the backup is
// the second worker), team lines become "- member: value", and comments,
// notes, and every other line stay where they were. A line that could not be
// used stays as written, so it still warns; a second line for a job that was
// already set turns into a comment, since it never counted.
function sectionedRosterText(text, file, options = {}) {
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
  const tidy = out.filter((line, index) => !(isBlank(line) && index > 0 && isBlank(out[index - 1])));
  while (tidy.length && isBlank(tidy[tidy.length - 1])) tidy.pop();
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
  // --promote moves the first line naming exactly the tool and model (and
  // effort, if given) to the top, every line exactly as written. Unlike an
  // assign, it rewrites nothing: the demoted lead keeps its own cap, prep,
  // and notes. With no model the words match only a line with no model, so
  // promoting "claude" can never move "claude, model: ..." by accident.
  if (options.promote !== undefined) {
    const words = String(options.promote).trim();
    const want = resolveRosterWords(words);
    const matches = currentWorkers
      .map((worker, index) => index)
      .filter((index) => currentWorkers[index].engine === want.engine
        && (currentWorkers[index].model || '') === (want.model || '')
        && (currentWorkers[index].effort || '') === (want.effort || ''));
    if (!matches.length) throw new Error(`${label} has no ${words} worker to move up`);
    const index = matches[0];
    const note = matches.length > 1 ? `${label} has ${matches.length} workers named ${words}; the first moved up` : '';
    return { lines: [currentLines[index], ...currentLines.filter((line, i) => i !== index)], ...(note ? { note } : {}) };
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
  const prepWords = options.prep === undefined ? '' : String(options.prep).trim();
  const prep = prepWords ? rosterJobKey(splitJobName(prepWords).name) : '';
  if (options.prep !== undefined && !prep) throw new Error(`"${options.prep}" is not a job name; use --prep search or another job`);
  if (prep && prep === key) throw new Error(`${label} cannot prep for itself; pick another job, like --prep search`);
  const now = rosterDate(options.now);
  const line = workerLineText({
    engine: engine.id,
    model,
    ...(effort ? { effort } : {}),
    ...(maxSeconds ? { max_seconds: maxSeconds } : {}),
    ...(prep ? { prep } : {}),
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
  // Lead first, backup second, then every old worker in its old order with
  // its settings as written, keeping only the first line for each tool and
  // model pair: claude on haiku and claude on opus are two workers. The old
  // lead stays when it is a different pair, and then its note stays on its
  // own line.
  const pair = (tool, pinned) => `${tool}\u0000${pinned || ''}`;
  const placed = [pair(engine.id, model), pair(backup.id, backupRead.model || '')];
  const taken = new Set(placed);
  const others = currentLines.filter((text, index) => {
    const worker = pair(currentWorkers[index].engine, currentWorkers[index].model);
    if (taken.has(worker)) return false;
    taken.add(worker);
    return true;
  });
  const keptOldLead = currentLines.length > 0
    && !placed.includes(pair(currentWorkers[0].engine, currentWorkers[0].model));
  return { lines: [keptOldLead ? line : lead, backupLine, ...others], heading };
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
  const { lines, heading, note } = assignedWorkerLines(key, engineName, options, {
    registry,
    savedPick,
    currentLines: workerEntries.map((entry) => entry.raw),
    currentWorkers,
    jobName,
  });
  if (note && typeof options.note === 'function') options.note(note);
  const next = replaceJobSection(base, {
    matches: (title) => rosterJobHeading(title).key === key,
    // Only an assign names a heading, and only when the job's kind changes;
    // otherwise the heading stays exactly as the person wrote it.
    heading: section && heading && rosterJobHeading(section.heading.title).kind === rosterJobHeading(String(heading).replace(/^#+\s*/, '')).kind
      ? ''
      : heading,
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

module.exports = {
  ROSTER_SOURCES, ROSTER_LAYERS, NO_SESSION_MESSAGE, clearSessionRoster, confirmRoster,
  mainCheckoutRoot, readRosterState, resolveJobTeam, rosterChoice, rosterChoiceForPick,
  rosterDecided, rosterJobRole, rosterSessionKey, rosterWorkerWalk, setRosterPick,
  withProjectRoster,
};
