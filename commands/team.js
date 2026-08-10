'use strict';

const fs = require('fs');
const path = require('path');

const { canonicalEngineName } = require('../lib/engine-registry');
const taskDb = require('../lib/task-db');
const { buildTeamPresence, DEFAULT_FRESHNESS_WINDOW_MS, renderTeamPresence } = require('../lib/team-presence');
const { readEngineRegistry } = require('./engine');
const { listMissions, listWorktreeRollupMissions } = require('./mission');
const { collectSnapshot, collectStreamEvents, repoRoot } = require('./stream');

function collectTasks(root, deps = {}) {
  if (Array.isArray(deps.tasks)) return deps.tasks;
  const dbModule = deps.taskDb || taskDb;
  const db = dbModule.open();
  return dbModule.taskProjection(db, { workspaceRoot: root, limit: 500 }).tasks || [];
}

function collectMissions(root, deps = {}) {
  if (Array.isArray(deps.missions)) return deps.missions;
  const local = listMissions(root);
  const rolled = listWorktreeRollupMissions(root);
  const byId = new Map();
  for (const mission of [...local, ...rolled]) {
    const key = String(mission?.id || '');
    if (key && !byId.has(key)) byId.set(key, mission);
  }
  return [...byId.values()];
}

function collectTeamPresence(deps = {}) {
  const root = deps.root || repoRoot(deps.cwd || process.cwd());
  const nowMs = typeof deps.now === 'function' ? deps.now() : Date.now();
  const freshnessWindowMs = deps.freshnessWindowMs || DEFAULT_FRESHNESS_WINDOW_MS;
  const stream = deps.stream || collectSnapshot({ root, deps: deps.streamDeps });
  const streamEvents = deps.streamEvents || collectStreamEvents({
    root,
    sinceMs: nowMs - freshnessWindowMs,
    nowMs,
    deps: deps.streamDeps,
  });
  return buildTeamPresence({
    nowMs,
    freshnessWindowMs,
    stream,
    streamEvents,
    missions: collectMissions(root, deps),
    tasks: collectTasks(root, deps),
  });
}

// One team view: member folders under atris/team/ are the who, live missions
// are the what-they-run-on. The fleet keeps no state file, so an engine
// "assignment" is read straight from missions still in flight.
const ROSTER_LIVE_MISSION_STATUSES = new Set(['running', 'planning']);

function collectMembers(root, deps = {}) {
  if (Array.isArray(deps.members)) return deps.members;
  const memberModule = deps.memberModule || require('./member');
  return memberModule.findAllMembers(path.join(root, 'atris', 'team'));
}

// The MEMBER.md role line, made safe for a human sentence: lowercase, no em
// dashes, no repeated name prefix ("Linguist - operator language" -> "operator
// language" when the member is already named on the line).
function plainRole(member) {
  // findAllMembers stamps '(no role)' on members without a role line; treat
  // that placeholder as empty so the description can fill in.
  const role = String(member?.role || '').trim();
  const raw = (role && role !== '(no role)' ? role : String(member?.description || '')).trim();
  const cleaned = raw
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/[.\s]+$/, '');
  const name = String(member?.name || '').trim().toLowerCase();
  const deduped = name && cleaned.startsWith(name)
    ? cleaned.slice(name.length).replace(/^[\s:,-]+/, '')
    : cleaned;
  if (!deduped) return 'no role written yet';
  // Keep the sentence readable: descriptions can run long, roles never should.
  if (deduped.length <= 100) return deduped;
  const cut = deduped.slice(0, 100);
  return `${cut.slice(0, cut.lastIndexOf(' '))}`.replace(/[,;:]+$/, '');
}

function missionEngine(mission) {
  return canonicalEngineName(mission?.runner) || canonicalEngineName(mission?.engine);
}

function formatEngineModel(engineId, engineRoster) {
  const id = String(engineId || '').trim();
  if (!id) return '-';
  const entry = (Array.isArray(engineRoster) ? engineRoster : []).find((row) => row.id === id);
  if (!entry) return id;
  const models = Array.isArray(entry.models) ? entry.models.filter(Boolean) : [];
  if (!models.length) return id;
  return `${id} (${models.join(', ')})`;
}

function isTemplateMember(member) {
  const name = String(member?.name || '').trim();
  if (name === '<name>') return true;
  const dir = String(member?.dir || '').trim();
  return dir.includes('<') || dir.includes('>');
}

function readMemberNow(member, root) {
  const nowPath = member?.dir
    ? path.join(member.dir, 'now.md')
    : path.join(root, 'atris', 'team', String(member?.name || '').trim(), 'now.md');
  let text = '';
  try { text = fs.readFileSync(nowPath, 'utf8'); } catch { return '-'; }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = String(line || '').trim();
    if (!trimmed || /^#+\s/.test(trimmed) || /^<!--/.test(trimmed) || /-->$/.test(trimmed)) continue;
    if (/^---+$/.test(trimmed)) continue;
    const content = trimmed
      .replace(/^[-*]\s+/, '')
      .replace(/^\[[ xX]\]\s+/, '')
      .trim();
    if (!content || /^[A-Za-z_-]+:\s/.test(content)) continue;
    return content.length <= 40 ? content : `${content.slice(0, 37).trim()}...`;
  }
  return '-';
}

function memberFrontmatterEngine(member) {
  return String(member?.frontmatter?.engine || '').trim();
}

function memberAlwaysOn(member) {
  const raw = member?.frontmatter?.alwayson;
  if (raw === true) return true;
  return String(raw || '').trim().toLowerCase() === 'true';
}

function memberFocus(rawNow, { awake, alwaysOn }) {
  let focus = rawNow;
  if (alwaysOn && rawNow === '-') focus = 'always on';
  if (awake) focus = focus === '-' ? 'always on (live)' : `${focus} (live)`;
  return focus;
}

function memberIsActive({ frontmatterEngine, awake, rawNow }) {
  return Boolean(frontmatterEngine) || awake || rawNow !== '-';
}

function clipCell(text, max) {
  const value = String(text || '').trim();
  if (!max || value.length <= max) return value;
  if (max <= 1) return value.slice(0, max);
  return `${value.slice(0, max - 3)}...`;
}

function collectTeamRoster(deps = {}) {
  const root = deps.root || repoRoot(deps.cwd || process.cwd());
  const presence = deps.presence || collectTeamPresence(deps);
  const awake = new Set(presence.members.map((member) => String(member.name || '').trim().toLowerCase()));
  const engineRoster = deps.engineRoster || readEngineRegistry(root, { persist: false }).engines;
  const engineByOwner = new Map();
  for (const mission of collectMissions(root, deps)) {
    if (!ROSTER_LIVE_MISSION_STATUSES.has(String(mission?.status || '').toLowerCase())) continue;
    const owner = String(mission?.owner || mission?.member || '').trim().toLowerCase();
    const engine = missionEngine(mission);
    // Missions arrive newest-first; the first live one per owner wins.
    if (owner && engine && !engineByOwner.has(owner)) engineByOwner.set(owner, engine);
  }
  return collectMembers(root, deps)
    .filter((member) => !isTemplateMember(member))
    .map((member) => {
      const name = String(member?.name || '').trim().toLowerCase();
      const missionEngine = engineByOwner.get(name) || '';
      const frontmatterEngine = memberFrontmatterEngine(member);
      const alwaysOn = memberAlwaysOn(member);
      const isAwake = awake.has(name);
      const rawNow = readMemberNow(member, root);
      const active = memberIsActive({ frontmatterEngine, awake: isAwake, rawNow });
      const focus = memberFocus(rawNow, { awake: isAwake, alwaysOn });
      return {
        name,
        role: plainRole(member),
        engine: frontmatterEngine,
        mission_engine: missionEngine,
        engine_model: formatEngineModel(missionEngine, engineRoster),
        status: isAwake ? 'awake' : 'idle',
        now: rawNow,
        focus,
        active,
      };
    })
    .filter((entry) => entry.name)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function wrapCommaNames(names, width = 80) {
  const lines = [];
  let line = '';
  for (const name of names) {
    const candidate = line ? `${line}, ${name}` : name;
    if (candidate.length > width && line) {
      lines.push(line);
      line = name;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines.join('\n');
}

function renderTeamRoster(rosterRows) {
  if (!rosterRows.length) {
    return 'no team members yet. create one with: atris member create <name> --role="..."';
  }
  const activeRows = rosterRows.filter((entry) => entry.active);
  const restRows = rosterRows.filter((entry) => !entry.active);
  const lines = ['active team:'];
  if (activeRows.length) {
    for (const entry of activeRows) {
      const engine = entry.engine || '-';
      lines.push(`${entry.name} | ${engine} | ${entry.focus || '-'}`);
    }
  } else {
    lines.push('(none)');
  }
  lines.push('');
  lines.push('rest of the team:');
  if (restRows.length) {
    lines.push(wrapCommaNames(restRows.map((entry) => entry.name)));
  } else {
    lines.push('(none)');
  }
  return lines.join('\n');
}

// The pruning pass keeps the team lean like a real company: it flags members
// with no recent signal, and it never deletes anything. A signal is the newest
// of MEMBER.md, any logs/*.md, or a mission the member owns that is still
// active or running.
const PRUNE_ACTIVE_MISSION_STATUSES = new Set(['active', 'running']);
const DEFAULT_PRUNE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

function newestSignalMs(member) {
  const times = [];
  const stamp = (file) => {
    try { times.push(fs.statSync(file).mtimeMs); } catch { /* missing file is just no signal */ }
  };
  if (member?.path) stamp(member.path);
  if (member?.dir) {
    const logsDir = path.join(member.dir, 'logs');
    let entries = [];
    try { entries = fs.readdirSync(logsDir); } catch { entries = []; }
    for (const entry of entries) {
      if (entry.endsWith('.md')) stamp(path.join(logsDir, entry));
    }
  }
  return times.length ? Math.max(...times) : 0;
}

function collectTeamPrune(deps = {}) {
  const root = deps.root || repoRoot(deps.cwd || process.cwd());
  const days = Number.isFinite(deps.days) && deps.days > 0 ? deps.days : DEFAULT_PRUNE_DAYS;
  const nowMs = typeof deps.now === 'function' ? deps.now() : Date.now();
  const activeOwners = new Set();
  for (const mission of collectMissions(root, deps)) {
    if (!PRUNE_ACTIVE_MISSION_STATUSES.has(String(mission?.status || '').toLowerCase())) continue;
    const owner = String(mission?.owner || mission?.member || '').trim().toLowerCase();
    if (owner) activeOwners.add(owner);
  }
  const quiet = [];
  let activeCount = 0;
  for (const member of collectMembers(root, deps)) {
    const name = String(member?.name || '').trim().toLowerCase();
    if (!name) continue;
    const signalMs = newestSignalMs(member);
    if (activeOwners.has(name) || (signalMs && nowMs - signalMs < days * DAY_MS)) {
      activeCount += 1;
      continue;
    }
    quiet.push({
      name,
      days_quiet: signalMs ? Math.floor((nowMs - signalMs) / DAY_MS) : null,
      last_signal: signalMs ? new Date(signalMs).toISOString() : null,
    });
  }
  quiet.sort((a, b) => a.name.localeCompare(b.name));
  return { quiet, active_count: activeCount };
}

function renderTeamPrune(report, days = DEFAULT_PRUNE_DAYS) {
  if (!report.quiet.length && !report.active_count) {
    return 'no team members yet. create one with: atris member create <name> --role="..."';
  }
  if (!report.quiet.length) {
    return `everyone on the team has a signal newer than ${days} days. nothing to prune.`;
  }
  const lines = report.quiet.map((entry) => (entry.days_quiet === null
    ? `${entry.name} has no recorded activity; keep, hand off, or retire.`
    : `${entry.name} has been quiet for ${entry.days_quiet} days; keep, hand off, or retire.`));
  lines.push(`${report.active_count} member${report.active_count === 1 ? ' is' : 's are'} still active. nothing was deleted; this is a report.`);
  return lines.join('\n');
}

function helpText() {
  return [
    'atris team - active members and the rest of the roster',
    'atris team presence - show who is awake and what they are doing',
    'atris team prune - flag members with no recent activity; deletes nothing',
    '',
    'usage: atris team [roster|presence] [--json]',
    'usage: atris team prune [--days N] [--json]',
  ].join('\n');
}

function teamCommand(args = [], deps = {}) {
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    (deps.write || process.stdout.write.bind(process.stdout))(`${helpText()}\n`);
    return 0;
  }
  if (args[0] === 'prune') {
    const rest = args.slice(1);
    let days = DEFAULT_PRUNE_DAYS;
    let json = false;
    let bad = false;
    for (let i = 0; i < rest.length; i += 1) {
      const arg = rest[i];
      if (arg === '--json') { json = true; continue; }
      if (arg === '--days') { i += 1; days = Number(rest[i]); continue; }
      if (arg.startsWith('--days=')) { days = Number(arg.slice('--days='.length)); continue; }
      bad = true;
    }
    if (bad || !Number.isFinite(days) || days <= 0) {
      (deps.error || process.stderr.write.bind(process.stderr))('usage: atris team prune [--days N] [--json]\n');
      return 2;
    }
    const report = deps.prune || collectTeamPrune({ ...deps, days });
    const output = json ? JSON.stringify(report, null, 2) : renderTeamPrune(report, days);
    (deps.write || process.stdout.write.bind(process.stdout))(`${output}\n`);
    return 0;
  }
  const rosterArgs = args.filter((arg) => arg !== 'roster');
  if (args[0] !== 'presence' && rosterArgs.every((arg) => arg === '--json')) {
    const roster = deps.roster || collectTeamRoster(deps);
    const output = rosterArgs.includes('--json')
      ? JSON.stringify(roster, null, 2)
      : renderTeamRoster(roster);
    (deps.write || process.stdout.write.bind(process.stdout))(`${output}\n`);
    return 0;
  }
  if (args[0] !== 'presence' || args.some((arg, index) => index > 0 && arg !== '--json')) {
    (deps.error || process.stderr.write.bind(process.stderr))('usage: atris team [roster|presence|prune] [--json]\n');
    return 2;
  }
  const presence = deps.presence || collectTeamPresence(deps);
  const output = args.includes('--json')
    ? JSON.stringify(presence, null, 2)
    : renderTeamPresence(presence);
  (deps.write || process.stdout.write.bind(process.stdout))(`${output}\n`);
  return 0;
}

module.exports = { collectMissions, collectTasks, collectTeamPresence, collectTeamPrune, collectTeamRoster, renderTeamPrune, renderTeamRoster, teamCommand };
