'use strict';

// Which engine a team member runs on. Every member in atris/team/*/MEMBER.md
// gets a job on its own: navigators, researchers, and scouts search;
// validators, reviewers, judges, critics, and verifiers review; everyone else
// builds. A line under "## team" in ROSTER.md overrides that, either with a
// job ("researcher: search", "fixer: small build") or with engine or model
// words ("judge: opus 5.5"). The job's pick then comes from the roster.

const fs = require('fs');
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
  rosterJobKey,
  rosterJobLabel,
  rosterJobRole,
  rosterModelLabel,
  rosterPickFromValue,
} = require('./engine-registry');

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

// This project's team line wins over the all-projects one.
function teamLineFor(state, member) {
  const key = String(member || '').trim().toLowerCase();
  const find = (layer) => (layer && Array.isArray(layer.team) ? layer.team.filter((line) => line.member === key)[0] : null);
  const project = find(state.project);
  if (project) return { ...project, scope: 'project' };
  const machine = find(state.machine);
  return machine ? { ...machine, scope: 'machine' } : null;
}

// What a team line value means: a job (built-in name, a job the roster
// already has, or a name that says its kind) or a direct engine pick for the
// member's own kind of work. error is a plain sentence for a line that means
// neither.
function interpretTeamValue(value, state, memberKind, options = {}) {
  const text = String(value || '').trim();
  if (!text) return { error: 'names no job or engine' };
  const key = rosterJobKey(text);
  if (key && ENGINE_ROLES.includes(key)) return { type: 'job', key };
  const saved = (layer) => Boolean(key && layer && layer.picks && layer.picks[key]);
  if (saved(state.project) || saved(state.machine)) return { type: 'job', key };
  try {
    return { type: 'pick', pick: rosterPickFromValue(text, ENGINE_JOBS[memberKind], options) };
  } catch (error) {
    if (key && inferJobKind(text)) return { type: 'job', key };
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
  const pickOptions = { ...options, projectRosterPicks: state.project.picks, machineRosterPicks: state.machine.picks };
  const base = {
    member: name,
    title: card.role || '',
    found: card.found || Boolean(line),
    source: override ? 'file' : 'auto',
    file: override ? line.file : null,
    line: override ? line.line : null,
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
  const fromRoster = resolved.source === 'project' || resolved.source === 'machine';
  return {
    ...base,
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
    const picked = resolveEngineForMember(name, root, options);
    if (!picked.found && options.requireMember !== false) return null;
    return picked.roster_backed && picked.engine ? picked : null;
  } catch {
    return null;
  }
}

// One row per member for `atris engine roster`, plus a warning for every
// team line that could not be used.
function teamRosterView(root = process.cwd(), options = {}) {
  const state = options.rosterState || readRosterState(root, options);
  const names = new Set(listTeamMembers(root));
  const warnings = [];
  for (const layer of [state.project, state.machine]) {
    for (const line of (layer && layer.team) || []) {
      if (findMemberCard(root, line.member)) names.add(line.member);
      else if (layer.scope === 'project') warnings.push({ file: line.file, line: line.line, text: line.text, message: `there is no team member named ${line.member}, so the line does nothing` });
    }
  }
  const rows = [...names].sort().map((name) => {
    const picked = resolveEngineForMember(name, root, { ...options, rosterState: state });
    const line = teamLineFor(state, name);
    if (picked.warning && line) {
      warnings.push({ file: line.file, line: line.line, text: line.text, message: `${picked.warning}, so ${name} picks automatically` });
    }
    if (picked.until_warning && line) warnings.push({ file: line.file, line: line.line, text: line.text, message: picked.until_warning });
    return {
      member: name,
      job: picked.job,
      engine: picked.engine ? picked.engine.id : null,
      model: picked.model || null,
      effort: picked.engine && picked.engine.roster_effort ? picked.engine.roster_effort : null,
      max_seconds: picked.engine && picked.engine.roster_max_seconds ? picked.engine.roster_max_seconds : null,
      source: picked.source,
      file: picked.file,
      reason: picked.reason,
    };
  });
  return { rows, warnings };
}

module.exports = {
  autoJobForMember,
  resolveEngineForMember,
  memberRosterEngine,
  teamRosterView,
};
