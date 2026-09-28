'use strict';

// Roster words: job names, dates, time caps, tool and model words, and the
// worker lines they turn into. Pure text to pick and pick to text; nothing
// here reads or writes a file. Which roster layer a pick came from and how
// it resolves lives in roster.js; edits to ROSTER.md live in roster-assign.js.

const {
  EFFORT_WORDS,
  engineTakesModel,
  engineEffortLevels,
} = require('./runner-command');
const { ENGINE_ROLES, canonicalEngineName, engineHasRole } = require('./engine-registry');
const { CLAUDE_FAMILY, modelLabel } = require('./roster-models');

const ENGINE_JOBS = Object.freeze({ search: 'navigator', build: 'executor', review: 'validator' });
const ENGINE_JOB_ALIASES = Object.freeze({ navigator: 'search', builder: 'build', executor: 'build', reviewer: 'review', validator: 'review' });
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
  if (!CLAUDE_FAMILY.includes(engineId)) return raw;
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
  // What the engine can do by its seed, checked before any registry is read.
  if (!engineHasRole({ id: primary.engine }, role)) throw new Error(`${primary.engine} cannot do ${kind} work`);
  let backup = null;
  let until = '';
  let untilYearless = '';
  let maxSeconds = null;
  let namedModel = false;
  let namedEffort = false;
  let prep = '';
  for (const raw of extras) {
    // "max: 20 min" and "until: 2026-10-24" read like "max 20 min".
    const part = raw.replace(/^(max|until)\s*:\s*/i, '$1 ');
    const backupMatch = /^backup\s+(.+)$/i.exec(part);
    const untilMatch = /^until\s+(.+)$/i.exec(part);
    const maxMatch = /^max\b/i.test(part) && !/^max$/i.test(part);
    const modelMatch = /^model\s*(?::\s*|\s+)(.+)$/i.exec(part);
    const effortMatch = /^effort\s*(?::\s*|\s+)(.+)$/i.exec(part);
    const prepMatch = /^prep\s*(?::\s*|\s+)(.+)$/i.exec(part);
    if (prepMatch && !prep) {
      // "prep: search": that job's lead reads the task first and hands this
      // worker a trimmed brief. Whether it names this same job is checked
      // where the job is known.
      const words = prepMatch[1].trim();
      prep = rosterJobKey(splitJobName(words).name);
      if (!prep) throw new Error(`"prep: ${words}" does not name a job; use prep: search or another job name`);
    } else if (modelMatch && !namedModel) {
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
      if (!engineHasRole({ id: backup.engine }, role)) throw new Error(`the backup ${backup.engine} cannot do ${kind} work`);
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
    ...(prep ? { prep } : {}),
    until,
    ...(until ? {} : { never_expires: true }),
    ...(untilYearless ? { until_needs_year: untilYearless } : {}),
  };
}

// A worker that names its own job as prep would wait on itself. The line
// still counts; only the prep is dropped, with a plain warning.
function selfPrepWarning(worker, key, label) {
  if (!worker || !worker.prep || worker.prep !== key) return '';
  delete worker.prep;
  return `asks ${label} to prep for itself, so this worker runs without prep`;
}

// A job line's name part, "small build (like build)", split into the name
// and the kind it says it is like.
function splitJobName(text) {
  const match = /^(.*?)\s*\(\s*like\s+([a-z]+)\s*\)\s*$/i.exec(String(text || '').trim());
  return match ? { name: match[1].trim(), like: match[2].trim().toLowerCase() } : { name: String(text || '').trim(), like: '' };
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
    ...(pick.prep ? { prep: pick.prep } : {}),
    until: pick.until,
    ...(pick.never_expires ? { never_expires: true } : {}),
    ...(pick.until_needs_year ? { until_needs_year: pick.until_needs_year } : {}),
  };
}

// A job name, "small build (like build)", read as a job: its key, its label,
// and the kind of work it is. error says why it is not one, and failure names
// which check it failed (name, like, built-in, kind). A "## " heading and a
// one-line "job: engine" name read the same; only the example differs.
function rosterJobHeading(title, { example = '## ' } = {}) {
  const { name, like } = splitJobName(title);
  const key = rosterJobKey(name);
  if (!key) return { failure: 'name', error: rosterJobNameError(name) };
  const builtIn = ENGINE_ROLES.includes(key);
  const label = rosterJobLabel(key);
  const likeKind = like ? rosterJob(like) : '';
  if (like && !likeKind) return { key, label, failure: 'like', error: `"like ${like}" is not search, build, or review` };
  if (builtIn && likeKind && ENGINE_JOBS[likeKind] !== key) return { key, label, failure: 'built-in', error: `${label} is a built-in job and cannot be like ${likeKind}` };
  const kind = builtIn ? label : likeKind || inferJobKind(name);
  if (!kind) return { key, label, failure: 'kind', error: `say what kind of job "${label}" is, for example "${example}${label} (like build)"` };
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
    ...(pick.prep ? { prep: pick.prep } : {}),
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

// --- writing the sectioned shape ------------------------------------------

// A model the way a person writes it on a worker line, when that spelling
// reads back as the same model; else the saved id itself.
function workerModelText(engine, model) {
  const label = modelLabel(model);
  try {
    if (normalizeRosterModel(engine, label) === model) return label;
  } catch {}
  return model;
}

// One worker line: "- claude code, model: opus 5.5, effort: high, max: 20 min, prep: search, until 2026-10-24".
function workerLineText(worker) {
  const parts = [rosterToolLabel(worker.engine)];
  if (worker.model) parts.push(`model: ${workerModelText(worker.engine, worker.model)}`);
  if (worker.effort) parts.push(`effort: ${worker.effort}`);
  if (Number(worker.max_seconds) > 0) parts.push(`max: ${rosterMaxText(worker.max_seconds).replace(/^max /, '')}`);
  if (worker.prep) parts.push(`prep: ${rosterJobLabel(worker.prep)}`);
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

module.exports = {
  ENGINE_JOBS,
  SMALL_BUILD_JOB,
  customPickRole,
  customRosterJobKeys,
  effortRefusal,
  inferJobKind,
  jobBlock,
  jobHeadingText,
  namesATool,
  normalizeRosterModel,
  parseRosterMax,
  parseRosterUntil,
  pickRoleForKey,
  pickWorkers,
  resolveRosterWords,
  rosterDate,
  rosterJob,
  rosterJobHeading,
  rosterJobKey,
  rosterJobLabel,
  rosterJobNameError,
  rosterMaxText,
  rosterPickExpired,
  rosterPickFromValue,
  rosterPickObject,
  rosterToolLabel,
  rosterToolName,
  rosterUntil,
  rosterWorkerFromValue,
  savedRosterEffort,
  savedRosterModel,
  selfPrepWarning,
  splitJobName,
  workerLineText,
};
