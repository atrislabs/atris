'use strict';

// Edits to ROSTER.md: assign one job (lead, add, backup, promote, remove,
// clear) in this project, all projects, or this session, and confirm (renew
// every dated worker for thirty days). Only the lines a change names move;
// comments, order, and every other line stay as written.

const fs = require('fs');
const path = require('path');
const {
  ENGINE_ROLES,
  engineHasRole,
  readEngineRegistry,
  writeEngineRegistry,
} = require('./engine-registry');
const { EFFORT_WORDS, engineTakesModel, engineEffortLevels } = require('./runner-command');
const {
  ROSTER_MARKDOWN_TEMPLATE,
  OLD_ROSTER_NOTE,
  ROSTER_NOTE,
  isBlank,
  jobSections,
  joinLines,
  replaceJobSection,
  rewriteRosterValues,
  scanRosterMarkdown,
} = require('./roster-markdown');
const {
  ENGINE_JOBS,
  customPickRole,
  customRosterJobKeys,
  effortRefusal,
  inferJobKind,
  jobBlock,
  jobHeadingText,
  normalizeRosterModel,
  parseRosterMax,
  resolveRosterWords,
  rosterDate,
  rosterJob,
  rosterJobHeading,
  rosterJobKey,
  rosterJobLabel,
  rosterJobNameError,
  rosterPickObject,
  rosterToolName,
  rosterUntil,
  splitJobName,
  workerLineText,
} = require('./roster-words');
const {
  NO_SESSION_MESSAGE,
  machineRosterEnabled,
  machineRosterFile,
  machineRosterMarkdownFile,
  parseRosterMarkdown,
  projectRosterFile,
  projectRosterRoot,
  readMachineRoster,
  readMachineRosterJson,
  readMachineRosterLayer,
  readProjectRoster,
  readSessionRosterLayer,
  rosterSessionKey,
  sessionRosterEnabled,
  sessionRosterFile,
  sweepStaleSessionRosters,
} = require('./roster');

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
  setRosterPick,
  confirmRoster,
};
