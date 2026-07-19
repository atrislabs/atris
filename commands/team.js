'use strict';

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

function helpText() {
  return [
    'atris team presence - show who is awake and what they are doing',
    '',
    'usage: atris team presence [--json]',
  ].join('\n');
}

function teamCommand(args = [], deps = {}) {
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    (deps.write || process.stdout.write.bind(process.stdout))(`${helpText()}\n`);
    return 0;
  }
  if (args[0] !== 'presence' || args.some((arg, index) => index > 0 && arg !== '--json')) {
    (deps.error || process.stderr.write.bind(process.stderr))('usage: atris team presence [--json]\n');
    return 2;
  }
  const presence = deps.presence || collectTeamPresence(deps);
  const output = args.includes('--json')
    ? JSON.stringify(presence, null, 2)
    : renderTeamPresence(presence);
  (deps.write || process.stdout.write.bind(process.stdout))(`${output}\n`);
  return 0;
}

module.exports = { collectMissions, collectTasks, collectTeamPresence, teamCommand };
