'use strict';

const path = require('path');

const { canonicalEngineName } = require('../lib/engine-registry');
const taskDb = require('../lib/task-db');
const { buildTeamPresence, DEFAULT_FRESHNESS_WINDOW_MS, renderTeamPresence } = require('../lib/team-presence');
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

function collectTeamRoster(deps = {}) {
  const root = deps.root || repoRoot(deps.cwd || process.cwd());
  const engineByOwner = new Map();
  for (const mission of collectMissions(root, deps)) {
    if (!ROSTER_LIVE_MISSION_STATUSES.has(String(mission?.status || '').toLowerCase())) continue;
    const owner = String(mission?.owner || mission?.member || '').trim().toLowerCase();
    const engine = missionEngine(mission);
    // Missions arrive newest-first; the first live one per owner wins.
    if (owner && engine && !engineByOwner.has(owner)) engineByOwner.set(owner, engine);
  }
  return collectMembers(root, deps)
    .map((member) => {
      const name = String(member?.name || '').trim().toLowerCase();
      return { name, role: plainRole(member), engine: engineByOwner.get(name) || '' };
    })
    .filter((entry) => entry.name)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function renderTeamRoster(roster) {
  if (!roster.length) {
    return 'no team members yet. create one with: atris member create <name> --role="..."';
  }
  return roster
    .map((entry) => `${entry.name} - ${entry.role}${entry.engine ? `, on ${entry.engine}` : ''}.`)
    .join('\n');
}

function helpText() {
  return [
    'atris team - one team view: every member, their role, and any engine running their work',
    'atris team presence - show who is awake and what they are doing',
    '',
    'usage: atris team [roster|presence] [--json]',
  ].join('\n');
}

function teamCommand(args = [], deps = {}) {
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    (deps.write || process.stdout.write.bind(process.stdout))(`${helpText()}\n`);
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
    (deps.error || process.stderr.write.bind(process.stderr))('usage: atris team [roster|presence] [--json]\n');
    return 2;
  }
  const presence = deps.presence || collectTeamPresence(deps);
  const output = args.includes('--json')
    ? JSON.stringify(presence, null, 2)
    : renderTeamPresence(presence);
  (deps.write || process.stdout.write.bind(process.stdout))(`${output}\n`);
  return 0;
}

module.exports = { collectMissions, collectTasks, collectTeamPresence, collectTeamRoster, renderTeamRoster, teamCommand };
