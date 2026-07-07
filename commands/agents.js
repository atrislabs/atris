'use strict';

// atris agents — one glanceable view of every member's state.
// Reads .atris/state/missions.jsonl (schema atris.mission.v1) plus the
// directories in atris/team/, and prints who is stuck, waiting on you,
// working, or resting. Built from a dream card: "validator cannot plan
// missions without seeing which agents are idle or blocked."

const fs = require('fs');
const path = require('path');
const { listMissions } = require('./mission');
const { normalizeOwnerSlug } = require('../lib/functional-owner');
const { shortRecordLabel } = require('../lib/short-name');

const WORKING_STATUSES = new Set(['running', 'planning']);
const STUCK_STATUSES = new Set(['blocked', 'stuck', 'failed']);
const RESTING_STATUSES = new Set(['complete', 'stopped', 'paused']);

const STATE_RANK = {
  stuck: 0,
  'waiting on you': 1,
  working: 2,
  resting: 3,
  idle: 4,
};

function listTeamDirs(root) {
  const teamDir = path.join(root, 'atris', 'team');
  try {
    return fs.readdirSync(teamDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => name !== '_template' && !name.startsWith('.'));
  } catch {
    return [];
  }
}

// Given a member's missions (already newest-first), pick one state word.
// Priority: a stuck mission always wins (that is the whole point of this
// view). Otherwise, if the newest mission is ready, they are waiting on a
// human. Otherwise, any running/planning mission means they are working.
// Anything left over (complete/stopped/paused, or nothing at all) rests.
function ownerState(missions) {
  if (!missions.length) return { state: 'idle', current: null };
  const stuckMission = missions.find((m) => STUCK_STATUSES.has(m.status));
  if (stuckMission) return { state: 'stuck', current: stuckMission };
  const latest = missions[0];
  if (latest.status === 'ready') return { state: 'waiting on you', current: latest };
  const workingMission = missions.find((m) => WORKING_STATUSES.has(m.status));
  if (workingMission) return { state: 'working', current: workingMission };
  const restingMission = missions.find((m) => RESTING_STATUSES.has(m.status)) || latest;
  return { state: 'resting', current: restingMission };
}

function missionLabel(mission) {
  if (!mission) return null;
  return shortRecordLabel(mission, mission.objective || mission.slug || mission.id, { wordLimit: 4 });
}

// Build one row per member: team directories plus anyone who owns a
// mission but has no directory yet. Returns rows sorted stuck first, then
// waiting on you, then working, then resting/idle.
function buildAgentRows(root = process.cwd()) {
  const missions = listMissions(root);
  const displayNames = new Map(); // normalized slug -> name to print
  const missionsByOwner = new Map(); // normalized slug -> missions (newest-first)

  for (const name of listTeamDirs(root)) {
    const slug = normalizeOwnerSlug(name);
    if (!slug) continue;
    if (!displayNames.has(slug)) displayNames.set(slug, name);
    if (!missionsByOwner.has(slug)) missionsByOwner.set(slug, []);
  }

  for (const mission of missions) {
    const raw = String(mission.owner || '').trim();
    if (!raw) continue;
    const slug = normalizeOwnerSlug(raw);
    if (!slug) continue;
    if (!displayNames.has(slug)) displayNames.set(slug, raw);
    if (!missionsByOwner.has(slug)) missionsByOwner.set(slug, []);
    missionsByOwner.get(slug).push(mission);
  }

  const rows = [];
  for (const [slug, ownerMissions] of missionsByOwner.entries()) {
    const { state, current } = ownerState(ownerMissions);
    rows.push({
      owner: displayNames.get(slug) || slug,
      state,
      label: missionLabel(current),
    });
  }

  rows.sort((a, b) => {
    const rankDiff = STATE_RANK[a.state] - STATE_RANK[b.state];
    if (rankDiff !== 0) return rankDiff;
    return a.owner.localeCompare(b.owner);
  });

  return rows;
}

function formatRow(row) {
  return row.label ? `${row.owner} - ${row.state} - ${row.label}` : `${row.owner} - ${row.state}`;
}

// Split rows into the always-shown head (stuck, waiting on you, working)
// and the foldable tail (resting, idle). When `all` is false, the tail
// collapses into a single count line so a big roster stays glanceable.
function renderAgentLines(rows, { all = false } = {}) {
  const head = [];
  const tail = [];
  for (const row of rows) {
    if (row.state === 'resting' || row.state === 'idle') tail.push(row);
    else head.push(row);
  }

  const lines = head.map(formatRow);
  if (all) {
    lines.push(...tail.map(formatRow));
  } else if (tail.length) {
    const noun = tail.length === 1 ? 'member' : 'members';
    lines.push(`${tail.length} ${noun} resting or idle. See them with atris agents --all`);
  }

  if (!lines.length) lines.push('No agents found. Add someone to atris/team or start a mission.');
  return lines;
}

function printHelp() {
  console.log('Usage: atris agents [--all] [--json]');
  console.log('Shows every member: stuck, waiting on you, working, or resting.');
}

function agentsCommand(args = [], { root = process.cwd() } = {}) {
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return 0;
  }
  const all = args.includes('--all');
  const rows = buildAgentRows(root);

  if (args.includes('--json')) {
    console.log(JSON.stringify({
      schema: 'atris.agents.v1',
      all,
      agents: rows,
    }));
    return 0;
  }

  for (const line of renderAgentLines(rows, { all })) {
    console.log(line);
  }
  return 0;
}

module.exports = {
  agentsCommand,
  buildAgentRows,
  renderAgentLines,
  ownerState,
  missionLabel,
};
