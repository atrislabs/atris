'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { canonicalEngineName, mainCheckoutRoot } = require('../lib/engine-registry');
const taskDb = require('../lib/task-db');
const {
  buildMemberActivity,
  buildTeamPresence,
  DEFAULT_FRESHNESS_WINDOW_MS,
  IDLE_AFTER_DAYS,
  activeWindowStartDay,
  logFileDay,
  memberActivityRows,
  parseGitLog,
  renderTeamPresence,
} = require('../lib/team-presence');
const { readRosterRuns } = require('../lib/roster-runs');
const { engineModelText, engineRunsView, modelLabel } = require('../lib/roster-models');
const { LINEUP_UNREADABLE, TEAM_FOOTER, memberLineup, readLineupSafe } = require('../lib/team-lineup');
const { listLiveEngineRuns, liveRunEngineText, shortElapsed } = require('../lib/engine-processes');
const { renderTable, terminalWidth } = require('../lib/text-table');
const { isMemberParked, isParkedFrontmatter, setMemberParked } = require('../lib/member-park');
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
  const skipLanding = Boolean(deps.skipLanding);
  const stream = deps.stream || collectSnapshot({ root, deps: deps.streamDeps, skipLanding });
  const streamEvents = deps.streamEvents || collectStreamEvents({
    root,
    sinceMs: nowMs - freshnessWindowMs,
    nowMs,
    deps: deps.streamDeps,
    skipLanding,
  });
  return buildTeamPresence({
    nowMs,
    freshnessWindowMs,
    operator: deps.operator || process.env.USER || process.env.USERNAME || '',
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
    return content;
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

function memberIsActive({ awake, activity }) {
  // Only real work makes a member active: live presence, or evidence in the
  // last 7 days (a dated log, a commit that names it, a recorded run, a task
  // or mission event). An engine in MEMBER.md or a focus line in now.md is
  // a plan, not work.
  return Boolean(awake) || Boolean(activity && activity.status === 'active');
}

// --- activity evidence, read once for the whole team ----------------------

const ACTIVITY_WINDOW_MS = IDLE_AFTER_DAYS * 24 * 60 * 60 * 1000;

// Dated file names under the member's logs/ folder and one level below it
// (logs/2026/2026-09-28.md). The date in the name, never the file time: a
// fresh checkout stamps every file with today.
function memberLogDays(member, root) {
  const dir = member?.dir
    ? path.join(member.dir, 'logs')
    : path.join(root, 'atris', 'team', String(member?.name || '').trim(), 'logs');
  const days = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return days; }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      let inner = [];
      try { inner = fs.readdirSync(path.join(dir, entry.name)); } catch { inner = []; }
      for (const name of inner) {
        const day = logFileDay(name);
        if (day) days.push(day);
      }
      continue;
    }
    const day = logFileDay(entry.name);
    if (day) days.push(day);
  }
  return days;
}

// One git log for the window, for every member at once.
function readTeamCommits(root, sinceMs, deps = {}) {
  if (Array.isArray(deps.commits)) return deps.commits;
  const run = deps.runGit || ((args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 5000, maxBuffer: 32 * 1024 * 1024 }));
  const result = run(['log', `--since=${new Date(sinceMs).toISOString()}`, '--format=%x1e%aI%x1f%B', 'HEAD']);
  if (!result || result.status !== 0) return [];
  return parseGitLog(result.stdout);
}

// Activity per member name (lowercase), without the per-day buckets.
function collectMemberActivity(root, members, deps = {}) {
  const nowMs = deps.nowMs || (typeof deps.now === 'function' ? deps.now() : Date.now());
  const sinceMs = nowMs - ACTIVITY_WINDOW_MS;
  const logDays = {};
  for (const member of members) {
    const name = String(member?.name || '').trim().toLowerCase();
    if (name) logDays[name] = memberLogDays(member, root);
  }
  const events = Array.isArray(deps.streamEvents)
    ? deps.streamEvents
    : collectStreamEvents({ root, sinceMs, nowMs, deps: deps.streamDeps, skipLanding: true });
  return buildMemberActivity({
    nowMs,
    members: Object.keys(logDays),
    logDays,
    commits: readTeamCommits(root, sinceMs, deps),
    runs: Array.isArray(deps.runs) ? deps.runs : readRosterRuns(root, { now: nowMs, days: IDLE_AFTER_DAYS }),
    events,
  });
}

function rosterStatus(entry) {
  if (entry.status === 'awake') return 'live';
  if (entry.active) return 'active';
  return 'idle';
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function collectTeamRoster(deps = {}) {
  const root = deps.root || repoRoot(deps.cwd || process.cwd());
  const nowMs = typeof deps.now === 'function' ? deps.now() : Date.now();
  const missions = collectMissions(root, deps);
  const members = collectMembers(root, deps).filter((member) => !isTemplateMember(member));
  // One read of the stream feeds both views: presence keeps its 15-minute
  // awake window, activity looks back 14 days.
  const streamEvents = Array.isArray(deps.streamEvents) || deps.activity
    ? (deps.streamEvents || [])
    : collectStreamEvents({ root, sinceMs: nowMs - ACTIVITY_WINDOW_MS, nowMs, deps: deps.streamDeps, skipLanding: true });
  // The roster only reads who is awake, never the landing wait, so it skips
  // the landing board entirely.
  const presence = deps.presence || collectTeamPresence({ ...deps, missions, streamEvents, skipLanding: true });
  const awake = new Set(presence.members.map((member) => String(member.name || '').trim().toLowerCase()));
  const activityRows = deps.activity || collectMemberActivity(root, members, { ...deps, nowMs, streamEvents });
  const activityByName = new Map(activityRows.map((row) => [row.name, row]));
  const engineRoster = deps.engineRoster || readEngineRegistry(root, { persist: false }).engines;
  const engineByOwner = new Map();
  for (const mission of missions) {
    if (!ROSTER_LIVE_MISSION_STATUSES.has(String(mission?.status || '').toLowerCase())) continue;
    const owner = String(mission?.owner || mission?.member || '').trim().toLowerCase();
    const engine = missionEngine(mission);
    // Missions arrive newest-first; the first live one per owner wins.
    if (owner && engine && !engineByOwner.has(owner)) engineByOwner.set(owner, engine);
  }
  return members
    .map((member) => {
      const name = String(member?.name || '').trim().toLowerCase();
      const missionEngine = engineByOwner.get(name) || '';
      const frontmatterEngine = memberFrontmatterEngine(member);
      const alwaysOn = memberAlwaysOn(member);
      const isAwake = awake.has(name);
      const rawNow = readMemberNow(member, root);
      const activity = activityByName.get(name) || null;
      const active = memberIsActive({ awake: isAwake, activity });
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
        activity,
        parked: isParkedFrontmatter(member?.frontmatter),
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

// Parked members leave the lists and come back as one line, unless --all
// asks for them in place.
function parkedSummaryLine(parkedRows, width = 80) {
  if (!parkedRows.length) return '';
  const names = parkedRows.map((entry) => entry.name);
  names[0] = `parked (${parkedRows.length}): ${names[0]}`;
  names[names.length - 1] = `${names[names.length - 1]} · atris team --all to show them`;
  return wrapCommaNames(names, width);
}

function withParkedLabels(rosterRows, all) {
  const parkedRows = rosterRows.filter((entry) => entry.parked);
  if (!all) return { rows: rosterRows.filter((entry) => !entry.parked), parkedRows };
  return {
    rows: rosterRows.map((entry) => (entry.parked ? { ...entry, name: `${entry.name} (parked)` } : entry)),
    parkedRows: [],
  };
}

function shortDate(day) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));
  if (!match) return '';
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toLowerCase();
}

function lastActiveText(activity) {
  if (!activity || !activity.last_active) return '';
  if (activity.days_since === 0) return 'last active today';
  if (activity.days_since === 1) return 'last active yesterday';
  return `last active ${shortDate(activity.last_active)}`;
}

// "on <tool> <model>", or just the model for claude-family tools, only
// when a run recorded it.
function activityEngineText(activity) {
  if (!activity || !activity.engine) return '';
  if (!activity.model) return `on ${activity.engine}`;
  const label = modelLabel(activity.model);
  return label.startsWith(activity.engine) || ['claude', 'fable', 'haiku'].includes(activity.engine)
    ? `on ${label}`
    : `on ${activity.engine} ${label}`;
}

// One line of facts per active member: when, how much, on what, how it went.
function activityLine(entry) {
  const activity = entry.activity || {};
  const parts = [];
  if (entry.status === 'awake') parts.push(entry.focus && entry.focus !== '-' ? `live now: ${entry.focus.replace(/ \(live\)$/, '')}` : 'live now');
  const last = lastActiveText(activity);
  if (last && !(entry.status === 'awake' && activity.days_since === 0)) parts.push(last);
  const runs = Number(activity.runs_7d) || 0;
  if (runs) parts.push(`${runs} run${runs === 1 ? '' : 's'} in 7 days`);
  const engine = activityEngineText(activity);
  if (engine) parts.push(engine);
  for (const outcome of ['landed', 'failed', 'reverted']) {
    if (Number(activity[outcome]) > 0) parts.push(`${activity[outcome]} ${outcome}`);
  }
  return parts.join(', ');
}

// --- the team table --------------------------------------------------------
//
// One row per member: its job and engine from the roster (the roster file is
// the truth, MEMBER.md frontmatter is not), whether it is working now (a live
// engine run names it), worked this week, or is quiet, what it is doing, and
// when it last did anything. Runs that name no member get their own rows.
// DOING is the live prompt for a running member; for a member that worked
// this week it is the week's record (runs and outcomes), which is fresher
// than the status line in now.md, used only when there is no record.

const STATE_ORDER = Object.freeze({ 'working now': 0, 'this week': 1, quiet: 2, parked: 3 });

// "today", "2d", or "-" when nothing was ever seen.
function lastSeenText(activity) {
  const days = activity ? activity.days_since : null;
  if (days === null || days === undefined || !Number.isFinite(Number(days))) return '-';
  return Number(days) === 0 ? 'today' : `${days}d`;
}

// "23 runs this week, 2 landed", from the activity evidence.
function activityFacts(activity) {
  if (!activity) return '';
  const runs = Number(activity.runs_7d) || 0;
  const parts = runs ? [`${runs} run${runs === 1 ? '' : 's'} this week`] : [];
  for (const outcome of ['landed', 'failed', 'reverted']) {
    if (Number(activity[outcome]) > 0) parts.push(`${activity[outcome]} ${outcome}`);
  }
  return parts.join(', ');
}

// The tool and model a member runs per the roster, with the model each tool
// picks on its own filled in (claude's atris default, codex settings).
function placedEngineText(place) {
  const view = engineRunsView(place.engine, { model: place.model || '', effort: place.effort || '' });
  return engineModelText(view.engine, view.model);
}

function liveDoing(runs) {
  const [first] = runs;
  const text = first.doing && first.doing !== '-' ? first.doing : 'running';
  return runs.length > 1 ? `${runs.length} runs: ${text}` : text;
}

function liveRunJson(run) {
  return {
    pid: run.pid,
    engine: run.engine,
    model: run.model || null,
    effort: run.effort || null,
    member: run.member || null,
    doing: run.doing,
    elapsed_seconds: run.elapsed_seconds,
  };
}

// The table's rows, in order, for text and json alike. Parked members are
// left out unless `all` (or unless they are working right now).
function teamTableRows(rosterRows, { lineup = null, liveRuns = [], all = false } = {}) {
  const runsByMember = new Map();
  const loose = [];
  const members = new Set(rosterRows.map((entry) => entry.name));
  for (const run of Array.isArray(liveRuns) ? liveRuns : []) {
    // "acting as <name>" that names no member here ("acting as an expert",
    // a member of another project) is an unattached run that keeps the name.
    if (!run.member || !members.has(run.member)) { loose.push(run); continue; }
    if (!runsByMember.has(run.member)) runsByMember.set(run.member, []);
    runsByMember.get(run.member).push(run);
  }
  const rows = [];
  const placed = (name) => memberLineup(lineup, name);
  const add = (entry, name, runs) => {
    const place = placed(name);
    const working = runs.length > 0;
    const state = working ? 'working now' : entry && entry.parked ? 'parked' : entry && entry.active ? 'this week' : 'quiet';
    const focus = entry ? String(entry.focus || '').replace(/ \(live\)$/, '').replace(/^-$/, '') : '';
    const doing = working ? liveDoing(runs)
      : state === 'this week' ? (activityFacts(entry.activity) || focus || '-')
        : '-';
    rows.push({
      member: name,
      job: place && place.job ? place.job : '-',
      engine_model: working ? liveRunEngineText(runs[0]) : place && place.engine ? placedEngineText(place) : '-',
      state,
      doing,
      last: working ? shortElapsed(runs[0].elapsed_seconds) : lastSeenText(entry && entry.activity),
      days_since: entry && entry.activity && Number.isFinite(Number(entry.activity.days_since)) ? Number(entry.activity.days_since) : null,
      elapsed_seconds: working ? runs[0].elapsed_seconds : null,
      live_runs: runs.map(liveRunJson),
      entry,
    });
  };
  for (const entry of rosterRows) {
    const runs = runsByMember.get(entry.name) || [];
    if (entry.parked && !all && !runs.length) continue;
    add(entry, entry.name, runs);
  }
  for (const run of loose) {
    rows.push({
      member: '(no member)',
      job: '-',
      engine_model: liveRunEngineText(run),
      state: 'working now',
      doing: run.member ? `as ${run.member}: ${run.doing || '-'}` : (run.doing || '-'),
      last: shortElapsed(run.elapsed_seconds),
      days_since: null,
      elapsed_seconds: run.elapsed_seconds,
      live_runs: [liveRunJson(run)],
      entry: null,
    });
  }
  const far = (value) => (value === null || value === undefined ? Infinity : value);
  return rows.sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state]
    || far(a.elapsed_seconds) - far(b.elapsed_seconds)
    || far(a.days_since) - far(b.days_since)
    || (a.member === '(no member)') - (b.member === '(no member)')
    || a.member.localeCompare(b.member));
}

const TEAM_COLUMNS = Object.freeze([
  { header: 'MEMBER' },
  { header: 'JOB' },
  { header: 'ENGINE · MODEL' },
  { header: 'STATUS' },
  { header: 'DOING', clip: true, min: 12 },
  { header: 'LAST' },
]);

// The whole `atris team` text view: the table, the parked line, and two
// copyable commands. Pure: live runs and the lineup come in through deps.
function renderTeamRoster(allRows, deps = {}) {
  const liveRuns = Array.isArray(deps.liveRuns) ? deps.liveRuns : [];
  if (!allRows.length && !liveRuns.length) {
    return 'no team members yet. create one with: atris member create <name> --role="..."';
  }
  const width = terminalWidth(deps.termWidth);
  const all = Boolean(deps.all);
  const lineup = deps.lineup && deps.lineup.ok ? deps.lineup : null;
  const rows = teamTableRows(allRows, { lineup, liveRuns, all });
  // DOING sits before LAST, so it is clipped first and LAST keeps its place.
  const table = renderTable(TEAM_COLUMNS, rows.map((row) => [row.member, row.job, row.engine_model, row.state, row.doing, row.last]), { width });
  const lines = [table];
  const parkedRows = all ? [] : allRows.filter((entry) => entry.parked && !rows.some((row) => row.entry === entry));
  const parkedLine = parkedSummaryLine(parkedRows, width);
  if (parkedLine) lines.push('', parkedLine);
  if (deps.lineup && !deps.lineup.ok) lines.push('', LINEUP_UNREADABLE);
  lines.push('', ...TEAM_FOOTER);
  return lines.join('\n');
}

// For --json: every member (parked ones say so), with the table's fields
// next to today's, then one entry per run that names no member.
function teamJsonRows(allRows, deps = {}) {
  const rows = teamTableRows(allRows, { lineup: deps.lineup && deps.lineup.ok ? deps.lineup : null, liveRuns: deps.liveRuns || [], all: true });
  const byEntry = new Map(rows.filter((row) => row.entry).map((row) => [row.entry, row]));
  const table = (row) => ({ job: row.job, engine_model: row.engine_model, state: row.state, doing: row.doing, last: row.last, live_runs: row.live_runs });
  const members = allRows.map((entry) => ({ ...entry, lineup: memberLineup(deps.lineup, entry.name), ...table(byEntry.get(entry)) }));
  const others = rows.filter((row) => !row.entry).map((row) => ({ name: row.member, member: row.member !== '(no member)', lineup: null, ...table(row) }));
  return [...members, ...others];
}

function renderTeamRosterHtml(allRows, meta = {}) {
  const rosterRows = withParkedLabels(allRows, Boolean(meta.all)).rows;
  const activeRows = rosterRows.filter((entry) => entry.active);
  const restRows = rosterRows.filter((entry) => !entry.active);
  const generatedAt = meta.generatedAt || new Date().toISOString();
  const workspace = meta.workspace || process.cwd();

  const statusDot = (entry) => {
    const status = rosterStatus(entry);
    if (status === 'live') return '<span class="dot dot-live" title="live"></span><span class="status-label">live</span>';
    if (status === 'active') return '<span class="dot dot-assigned" title="active this week"></span><span class="status-label">active</span>';
    return '<span class="dot dot-idle" title="idle"></span><span class="status-label">idle</span>';
  };

  const activeRowsHtml = activeRows.length
    ? activeRows.map((entry) => `
        <tr>
          <td class="col-member">${escapeHtml(entry.name)}</td>
          <td class="col-engine">${escapeHtml(entry.engine || '-')}</td>
          <td class="col-status">${statusDot(entry)}</td>
          <td class="col-focus">${escapeHtml(activityLine(entry) || entry.focus || '-')}</td>
        </tr>`).join('')
    : '<tr><td colspan="4" class="empty">(none)</td></tr>';

  const restChipsHtml = restRows.length
    ? restRows.map((entry) => `<span class="chip">${escapeHtml(entry.name)}</span>`).join('')
    : '<span class="empty">(none)</span>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Team board</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial,
      "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    font-size: 14px;
    line-height: 1.5;
    color: #1c1917;
    background: #fafaf9;
    padding: 16px;
  }
  .board { max-width: 1200px; margin: 0 auto; }
  h2 {
    font-size: 16px;
    font-weight: 600;
    margin-bottom: 8px;
    padding-bottom: 4px;
    border-bottom: 2px solid #f59e0b;
  }
  section { margin-bottom: 16px; }
  table {
    width: 100%;
    border-collapse: collapse;
    background: #fff;
    border-radius: 4px;
    box-shadow: 0 1px 3px rgba(0,0,0,.08);
  }
  th, td {
    text-align: left;
    vertical-align: middle;
    padding: 8px 12px;
    border-bottom: 1px solid #f5f5f4;
  }
  th {
    font-size: 12px;
    font-weight: 600;
    color: #78716c;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  tr { min-height: 44px; }
  tr:last-child td { border-bottom: none; }
  .col-member { white-space: nowrap; }
  .col-engine { white-space: nowrap; }
  .col-status { white-space: nowrap; }
  .col-focus { word-wrap: break-word; overflow-wrap: break-word; }
  .dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    margin-right: 4px;
    vertical-align: middle;
  }
  .dot-live { background: #22c55e; }
  .dot-assigned { background: #f59e0b; }
  .dot-idle { background: #a8a29e; }
  .status-label { font-size: 14px; vertical-align: middle; }
  .chip-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .chip {
    display: inline-block;
    background: #fff;
    border: 1px solid #e7e5e4;
    border-radius: 4px;
    padding: 4px 8px;
    font-size: 14px;
    box-shadow: 0 1px 3px rgba(0,0,0,.08);
  }
  .empty { color: #78716c; font-style: italic; }
  footer {
    margin-top: 16px;
    font-size: 12px;
    color: #78716c;
  }
</style>
</head>
<body>
<div class="board">
  <section>
    <h2>Active team</h2>
    <table>
      <thead>
        <tr>
          <th>Member</th>
          <th>Engine</th>
          <th>Status</th>
          <th>Focus</th>
        </tr>
      </thead>
      <tbody>${activeRowsHtml}
      </tbody>
    </table>
  </section>
  <section>
    <h2>Rest of the team</h2>
    <div class="chip-grid">${restChipsHtml}</div>
  </section>
  <footer>generated ${escapeHtml(generatedAt)} · ${escapeHtml(workspace)}</footer>
</div>
</body>
</html>`;
}

// The self-improvement loop's feed: one row per member per day, so it can
// compare member and model pairs over time. Each record rewrites only the
// last 7 days (the window it can see) of the members this checkout knows;
// a member missing here keeps its rows, and older rows and lines it cannot
// read stay exactly as they were. The file lives in the main checkout, so
// every worktree of a project feeds one history.
const MEMBER_ACTIVITY_FILE = path.join('.atris', 'state', 'member_activity.jsonl');

function memberActivityFile(root) {
  const main = mainCheckoutRoot(root);
  return path.join(main && fs.existsSync(main) ? main : root, MEMBER_ACTIVITY_FILE);
}

function recordMemberActivity(root, rosterRows, nowMs = Date.now()) {
  const file = memberActivityFile(root);
  const activity = rosterRows.map((entry) => entry.activity).filter(Boolean);
  const rows = memberActivityRows(activity, nowMs);
  const observed = new Set(activity.map((member) => String(member.name || '').toLowerCase()));
  const since = activeWindowStartDay(nowMs);
  let kept = [];
  try {
    kept = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => {
      if (!line.trim()) return false;
      try {
        const row = JSON.parse(line);
        return !(row && typeof row.day === 'string' && row.day >= since
          && observed.has(String(row.member || '').toLowerCase()));
      } catch {
        return true;
      }
    });
  } catch { /* no file yet */ }
  const body = [...kept, ...rows.map((row) => JSON.stringify(row))].join('\n');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, body ? `${body}\n` : '', 'utf8');
  fs.renameSync(tmp, file);
  return { file, rows: rows.length, members: new Set(rows.map((row) => row.member)).size };
}

function writeTeamBoardHtml(rosterRows, deps = {}) {
  const workspace = deps.cwd || process.cwd();
  const outPath = path.join(workspace, 'atris', 'team', 'team-board.html');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const html = renderTeamRosterHtml(rosterRows, {
    all: Boolean(deps.all),
    workspace,
    generatedAt: deps.generatedAt || new Date().toISOString(),
  });
  fs.writeFileSync(outPath, html, 'utf8');
  return outPath;
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
    // A parked member is already set aside on purpose; flagging it again is noise.
    if (isMemberParked(root, name)) continue;
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
    'atris team - one table, one row per member: job, tool and model from the roster, working now / this week / quiet, what it is doing, and when it last worked',
    'atris team --all - also list parked members in place',
    'atris team --record - also save one row per member per day to .atris/state/member_activity.jsonl',
    'atris team presence - show who is awake and what they are doing',
    'atris team prune - flag members with no recent activity; deletes nothing',
    'atris team park <name> [--note "<reason>"] - hide a member from the team views; it still runs by name',
    'atris team unpark <name> - bring a parked member back',
    '',
    'usage: atris team [roster|presence] [--all] [--json] [--html] [--record]',
    'usage: atris team prune [--days N] [--json]',
    'usage: atris team park <name> [--note "<reason>"] | atris team unpark <name>',
  ].join('\n');
}

const PARK_USAGE = 'usage: atris team park <name> [--note "<reason>"] | atris team unpark <name>';

function teamParkCommand(parked, rest, deps = {}) {
  const write = deps.write || process.stdout.write.bind(process.stdout);
  const error = deps.error || process.stderr.write.bind(process.stderr);
  let name = '';
  let note = '';
  let bad = false;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (parked && arg === '--note') { i += 1; note = rest[i] || ''; if (!note) bad = true; continue; }
    if (parked && arg.startsWith('--note=')) { note = arg.slice('--note='.length); continue; }
    if (arg.startsWith('-') || name) { bad = true; continue; }
    name = arg;
  }
  if (bad || !name) {
    error(`${PARK_USAGE}\n`);
    return 2;
  }
  const root = deps.root || repoRoot(deps.cwd || process.cwd());
  const result = setMemberParked(root, name, { parked, note, now: deps.now ? new Date(deps.now()) : new Date() });
  if (!result.ok) {
    error(`${result.error}\n`);
    return 1;
  }
  write(`${result.message}\n`);
  return 0;
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
  if (args[0] === 'park' || args[0] === 'unpark') {
    return teamParkCommand(args[0] === 'park', args.slice(1), deps);
  }
  const rosterArgs = args.filter((arg) => arg !== 'roster');
  const rosterFlags = new Set(['--json', '--html', '--all', '--record']);
  if (args[0] !== 'presence' && rosterArgs.every((arg) => rosterFlags.has(arg))) {
    const html = rosterArgs.includes('--html');
    const json = rosterArgs.includes('--json');
    const all = rosterArgs.includes('--all');
    if (html && json) {
      (deps.error || process.stderr.write.bind(process.stderr))('usage: atris team [--json] [--html] (not both)\n');
      return 2;
    }
    const roster = deps.roster || collectTeamRoster(deps);
    let recordNote = '';
    if (rosterArgs.includes('--record')) {
      const root = deps.root || repoRoot(deps.cwd || process.cwd());
      const nowMs = typeof deps.now === 'function' ? deps.now() : Date.now();
      const saved = recordMemberActivity(root, roster, nowMs);
      recordNote = `recorded ${saved.rows} day${saved.rows === 1 ? '' : 's'} of work for ${saved.members} member${saved.members === 1 ? '' : 's'} to ${saved.file}\n`;
      // --json and --html keep stdout to their one answer; the note goes to stderr.
      if (json || html) (deps.error || process.stderr.write.bind(process.stderr))(recordNote);
    }
    if (html) {
      const outPath = writeTeamBoardHtml(roster, { ...deps, all });
      (deps.write || process.stdout.write.bind(process.stdout))(`${outPath}\n`);
      return 0;
    }
    // Which job, tool, and model each member runs, from the same resolver
    // as `atris engine roster`. A roster that cannot be read never hides the
    // team; it costs one plain line.
    const lineup = deps.lineup !== undefined
      ? deps.lineup
      : readLineupSafe(deps.root || repoRoot(deps.cwd || process.cwd()), deps.lineupNow || new Date());
    // Who is working this minute: live engine runs on this machine.
    const liveRuns = Array.isArray(deps.liveRuns) ? deps.liveRuns : listLiveEngineRuns(deps);
    const output = json
      ? JSON.stringify(teamJsonRows(roster, { lineup, liveRuns }), null, 2)
      : renderTeamRoster(roster, { ...deps, lineup, liveRuns, all });
    (deps.write || process.stdout.write.bind(process.stdout))(`${output}\n`);
    if (recordNote && !json) (deps.write || process.stdout.write.bind(process.stdout))(`\n${recordNote}`);
    return 0;
  }
  if (args[0] !== 'presence' || args.some((arg, index) => index > 0 && arg !== '--json')) {
    (deps.error || process.stderr.write.bind(process.stderr))('usage: atris team [roster|presence|prune|park|unpark] [--all] [--json] [--html]\n');
    return 2;
  }
  const presence = deps.presence || collectTeamPresence(deps);
  const output = args.includes('--json')
    ? JSON.stringify(presence, null, 2)
    : renderTeamPresence(presence);
  (deps.write || process.stdout.write.bind(process.stdout))(`${output}\n`);
  return 0;
}

module.exports = {
  collectMemberActivity,
  collectTeamPrune,
  recordMemberActivity,
  collectTeamRoster,
  renderTeamPrune,
  renderTeamRoster,
  teamCommand,
};
