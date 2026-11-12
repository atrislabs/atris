'use strict';

// Which engine a team member runs on. Every member in atris/team/*/MEMBER.md
// gets a job on its own: navigators, researchers, and scouts search;
// validators, reviewers, judges, critics, and verifiers review; everyone else
// builds. A line under "## team" in ROSTER.md overrides that, either with a
// job ("researcher: search", "fixer: small build") or with engine or model
// words ("judge: opus"). The job's pick then comes from the roster.
// An "on:" part says where the member works ("on: atris computer",
// "on: grok bot"); only a member that runs here gets an engine here.

const fs = require('fs');
const { memberRefusalReason } = require('./member-type');
const path = require('path');
const {
  ENGINE_JOBS,
  ENGINE_ROLES,
  inferJobKind,
  mainCheckoutRoot,
  readEngineRegistry,
  readRosterState,
  resolveEngineForRoleRanked,
  rosterChoiceForPick,
  rosterDecided,
  ROSTER_LAYERS,
  rosterJobKey,
  rosterJobLabel,
  rosterJobRole,
  rosterModelLabel,
  rosterPickFromValue,
} = require('./engine-registry');
const { isParkedText } = require('./member-park');
const { readRunsOn, splitRunsOn, machineName } = require('./runs-on');

// The engine id words name, or '' when they name none atris knows.
function engineNamed(words) {
  try {
    return require('./engine-registry').canonicalEngineName(words) || '';
  } catch { return ''; }
}

// The place one team line names, or local when it names none.
function placeFromOn(on) {
  if (!on) return { id: 'local', label: machineName(), here: true };
  return readRunsOn(on, { isEngine: engineNamed });
}

const SEARCH_WORDS = Object.freeze(['navigator', 'researcher', 'research', 'search', 'scout']);
const REVIEW_WORDS = Object.freeze(['validator', 'reviewer', 'review', 'judge', 'critic', 'verifier']);

function memberCardFile(root, name) {
  return path.join(root, 'atris', 'team', name, 'MEMBER.md');
}

// This folder's card, else the main checkout's when this is a git worktree:
// the same fallback the roster file uses, so a card not yet committed still
// counts from a worktree. '' when neither has one.
function findMemberCard(root, name) {
  const own = memberCardFile(root, name);
  if (fs.existsSync(own)) return own;
  const main = mainCheckoutRoot(root);
  const shared = main ? memberCardFile(main, name) : '';
  return shared && fs.existsSync(shared) ? shared : '';
}

// name and role from the MEMBER.md frontmatter; found is false when there is
// no card for this name.
function readMemberCard(root, name) {
  let text = '';
  try {
    text = fs.readFileSync(findMemberCard(root, name), 'utf8');
  } catch {
    return { name, role: '', found: false };
  }
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const field = (key) => {
    const match = block ? new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(block[1]) : null;
    return match ? match[1].trim().replace(/^["']|["']$/g, '') : '';
  };
  return { name: field('name') || name, role: field('role'), found: true };
}

function listTeamMembers(root = process.cwd()) {
  const dir = path.join(root, 'atris', 'team');
  let names = [];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !entry.name.startsWith('_'))
      .map((entry) => entry.name)
      .filter((name) => fs.existsSync(memberCardFile(root, name)));
  } catch {
    return [];
  }
  return names.sort();
}

function words(text) {
  return String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function kindFromWords(list) {
  if (list.some((word) => SEARCH_WORDS.includes(word))) return 'search';
  if (list.some((word) => REVIEW_WORDS.includes(word))) return 'review';
  return '';
}

// The job a member gets with no team line: its name decides first, then its
// role title, else build.
function autoJobForMember(name, role = '') {
  return kindFromWords(words(name)) || kindFromWords(words(role)) || 'build';
}

// This session's team line wins, then this project's, then the
// all-projects one.
function teamLineFor(state, member) {
  const key = String(member || '').trim().toLowerCase();
  const find = (layer) => (layer && Array.isArray(layer.team) ? layer.team.filter((line) => line.member === key)[0] : null);
  for (const scope of ROSTER_LAYERS) {
    const line = find(state[scope]);
    if (line) return { ...line, scope };
  }
  return null;
}

// What a team line value means: a job (built-in name, a job the roster
// already has, or a name that says its kind) or a direct engine pick for the
// member's own kind of work. error is a plain sentence for a line that means
// neither.
function interpretTeamValue(value, state, memberKind, options = {}) {
  let split;
  let place;
  try {
    split = splitRunsOn(value);
    place = placeFromOn(split.on);
  } catch (error) {
    return { error: error.message };
  }
  // "on: muse" with nothing else: that engine, here.
  const text = split.rest || (place.engine || '');
  if (!text) return split.on ? { type: 'place', place } : { error: 'names no job or engine' };
  const key = rosterJobKey(text);
  if (key && ENGINE_ROLES.includes(key)) return { type: 'job', key, place };
  const saved = (layer) => Boolean(key && layer && layer.picks && layer.picks[key]);
  if (saved(state.session) || saved(state.project) || saved(state.machine)) return { type: 'job', key, place };
  try {
    return { type: 'pick', pick: rosterPickFromValue(text, ENGINE_JOBS[memberKind], options), place };
  } catch (error) {
    if (key && inferJobKind(text)) return { type: 'job', key, place };
    return { error: error.message };
  }
}

function engineText(engine) {
  if (!engine) return 'no ready engine';
  return `${engine.id}${engine.roster_model ? ` ${rosterModelLabel(engine.roster_model)}` : ''}`;
}

// The engine one member runs on, with a plain reason ("researcher does
// search: claude haiku"). roster_backed is true when a roster line decided
// (a job pick or a team line); when false the router decided, and callers
// keep whatever they did before the roster existed.
function resolveEngineForMember(memberName, root = process.cwd(), options = {}) {
  const name = String(memberName || '').trim();
  const card = readMemberCard(root, name);
  const state = options.rosterState || readRosterState(root, options);
  const autoKind = autoJobForMember(name, card.role);
  const line = teamLineFor(state, name);
  const read = line ? interpretTeamValue(line.value, state, autoKind, options) : null;
  const override = read && !read.error ? read : null;
  const yearless = override && override.type === 'pick' && override.pick.until_needs_year;
  const place = override && override.place ? override.place : placeFromOn('');
  const pickOptions = {
    ...options,
    sessionRosterPicks: state.session ? state.session.picks : {},
    projectRosterPicks: state.project.picks,
    machineRosterPicks: state.machine.picks,
  };
  const base = {
    member: name,
    title: card.role || '',
    found: card.found || Boolean(line),
    source: override ? 'file' : 'auto',
    file: override ? line.file : null,
    line: override ? line.line : null,
    runs_on: place.id,
    runs_on_label: place.label,
    runs_here: place.here,
    ...(read && read.error ? { warning: read.error } : {}),
    ...(yearless ? { until_warning: `has no year in its until date, so it counts as expired; write until ${yearless}` } : {}),
  };

  if (override && override.type === 'pick') {
    const role = ENGINE_JOBS[autoKind];
    const registry = readEngineRegistry(root, { persist: false });
    const choice = rosterChoiceForPick(override.pick, role, registry, { label: autoKind, source: line.scope, now: options.now });
    if (choice) {
      return {
        ...base,
        job: autoKind,
        job_key: role,
        role,
        engine: choice.engine,
        model: choice.engine.roster_model || '',
        pick_source: 'team',
        roster_backed: true,
        reason: `${name} does ${autoKind}: ${engineText(choice.engine)}`,
      };
    }
  }

  const jobKey = override && override.type === 'job' ? override.key : ENGINE_JOBS[autoKind];
  const role = rosterJobRole(jobKey, root, pickOptions) || ENGINE_JOBS[autoKind];
  const custom = !ENGINE_ROLES.includes(jobKey);
  const resolved = resolveEngineForRoleRanked(role, root, { ...pickOptions, ...(custom ? { job: jobKey } : {}) });
  const job = rosterJobLabel(jobKey);
  const fromRoster = rosterDecided(resolved.source);
  return {
    ...base,
    ...(override && override.type === 'place' ? { source: 'file', file: line.file, line: line.line } : {}),
    job,
    job_key: jobKey,
    role,
    engine: resolved.engine || null,
    model: resolved.engine && resolved.engine.roster_model ? resolved.engine.roster_model : '',
    pick_source: resolved.source,
    roster_backed: fromRoster || Boolean(override),
    reason: `${name} does ${job}: ${engineText(resolved.engine)}`,
  };
}

// The member's engine only when the roster decided it and the member is on
// the team (a MEMBER.md or a team line). null means keep the old routing.
// Never throws: a broken roster must not stop a run.
function memberRosterEngine(memberName, root = process.cwd(), options = {}) {
  const name = String(memberName || '').trim();
  if (!name || name.includes('/') || name.includes('\\')) return null;
  try {
    if (!memberCardRunnable(root, name)) return null;
    const picked = resolveEngineForMember(name, root, options);
    if (!picked.found && options.requireMember !== false) return null;
    return picked.roster_backed && picked.engine ? picked : null;
  } catch {
    return null;
  }
}

// The place a member works when it is not this machine ("Grok bot",
// "Atris computer"), or '' when it runs here. Never throws: a broken roster
// must not stop a run.
function memberRunsElsewhere(memberName, root = process.cwd(), options = {}) {
  const name = String(memberName || '').trim();
  if (!name || name.includes('/') || name.includes('\\')) return '';
  try {
    const picked = resolveEngineForMember(name, root, options);
    return picked.runs_here === false ? picked.runs_on_label || picked.runs_on : '';
  } catch {
    return '';
  }
}

// A person or odd-typed card never runs on an engine.
function memberCardRunnable(root, name) {
  const card = findMemberCard(root, name);
  if (!card) return true;
  try {
    const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(fs.readFileSync(card, 'utf8'));
    const match = block ? /^type:\s*(.*)$/m.exec(block[1]) : null;
    const value = match ? match[1].trim().replace(/^["']|["']$/g, '') : '';
    return !memberRefusalReason(name, value ? { type: value } : {});
  } catch { return true; }
}

// A parked card stays on disk and still runs by name; this view (the roster
// team block and the boot lineup) just leaves it out.
function memberCardParked(root, name) {
  const card = findMemberCard(root, name);
  if (!card) return false;
  try { return isParkedText(fs.readFileSync(card, 'utf8')); } catch { return false; }
}

// One row per member for `atris engine roster`, plus a warning for every
// team line that could not be used. Parked members are skipped.
function teamRosterView(root = process.cwd(), options = {}) {
  const state = options.rosterState || readRosterState(root, options);
  const names = new Set(listTeamMembers(root));
  const warnings = [];
  for (const layer of [state.session, state.project, state.machine]) {
    for (const line of (layer && layer.team) || []) {
      if (findMemberCard(root, line.member)) names.add(line.member);
      else if (layer.scope === 'project') warnings.push({ file: line.file, line: line.line, text: line.text, message: `there is no team member named ${line.member}, so the line does nothing` });
    }
  }
  for (const name of [...names]) if (memberCardParked(root, name) || !memberCardRunnable(root, name)) names.delete(name);
  const rows = [...names].sort().map((name) => {
    const picked = resolveEngineForMember(name, root, { ...options, rosterState: state });
    const line = teamLineFor(state, name);
    if (picked.warning && line) {
      warnings.push({ file: line.file, line: line.line, text: line.text, message: `${picked.warning}, so ${name} picks automatically` });
    }
    if (picked.until_warning && line) warnings.push({ file: line.file, line: line.line, text: line.text, message: picked.until_warning });
    // A member working on another machine runs whatever that machine runs,
    // unless its line names the engine; this machine's router has no say.
    const theirs = picked.runs_here === false && picked.pick_source !== 'team';
    return {
      member: name,
      job: picked.job,
      engine: picked.engine && !theirs ? picked.engine.id : null,
      model: theirs ? null : picked.model || null,
      effort: picked.engine && picked.engine.roster_effort ? picked.engine.roster_effort : null,
      max_seconds: picked.engine && picked.engine.roster_max_seconds ? picked.engine.roster_max_seconds : null,
      runs_on: picked.runs_on,
      runs_on_label: picked.runs_on_label,
      runs_here: picked.runs_here,
      source: picked.source,
      file: picked.file,
      reason: picked.reason,
    };
  });
  return { rows, warnings };
}

module.exports = {
  autoJobForMember,
  readMemberCard,
  resolveEngineForMember,
  memberRosterEngine,
  memberRunsElsewhere,
  teamRosterView,
};
