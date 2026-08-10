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

function memberIsActive({ frontmatterEngine, awake }) {
  // A stale focus line in now.md does not make a member active — only an
  // assigned engine or live presence does.
  return Boolean(frontmatterEngine) || awake;
}

function clipCell(text, max) {
  const value = String(text || '').trim();
  if (!max || value.length <= max) return value;
  if (max <= 0) return '';
  return value.slice(0, max);
}

function rosterStatus(entry) {
  if (entry.status === 'awake') return 'live';
  if (String(entry.engine || '').trim()) return 'assigned';
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

function renderTeamRoster(rosterRows, deps = {}) {
  if (!rosterRows.length) {
    return 'no team members yet. create one with: atris member create <name> --role="..."';
  }
  const activeRows = rosterRows.filter((entry) => entry.active);
  const restRows = rosterRows.filter((entry) => !entry.active);
  const termWidth = deps.termWidth || process.stdout.columns || 80;
  const memberW = Math.max(6, ...activeRows.map((entry) => entry.name.length));
  const engineW = Math.max(6, ...activeRows.map((entry) => (entry.engine || '-').length));
  const statusW = 8;
  const sep = 3;
  const focusW = Math.max(8, termWidth - memberW - engineW - statusW - sep * 3);
  const lines = ['active team:'];
  if (activeRows.length) {
    for (const entry of activeRows) {
      const engine = entry.engine || '-';
      const status = rosterStatus(entry);
      const focus = clipCell(entry.focus || '-', focusW);
      lines.push(
        `${clipCell(entry.name, memberW).padEnd(memberW)} | ${clipCell(engine, engineW).padEnd(engineW)} | ${status.padEnd(statusW)} | ${focus}`,
      );
    }
  } else {
    lines.push('(none)');
  }
  lines.push('');
  lines.push('rest of the team:');
  if (restRows.length) {
    lines.push(wrapCommaNames(restRows.map((entry) => entry.name), termWidth));
  } else {
    lines.push('(none)');
  }
  return lines.join('\n');
}

function renderTeamRosterHtml(rosterRows, meta = {}) {
  const activeRows = rosterRows.filter((entry) => entry.active);
  const restRows = rosterRows.filter((entry) => !entry.active);
  const generatedAt = meta.generatedAt || new Date().toISOString();
  const workspace = meta.workspace || process.cwd();

  const statusDot = (entry) => {
    const status = rosterStatus(entry);
    if (status === 'live') return '<span class="dot dot-live" title="live"></span><span class="status-label">live</span>';
    if (status === 'assigned') return '<span class="dot dot-assigned" title="assigned"></span><span class="status-label">assigned</span>';
    return '<span class="dot dot-idle" title="idle"></span><span class="status-label">idle</span>';
  };

  const activeRowsHtml = activeRows.length
    ? activeRows.map((entry) => `
        <tr>
          <td class="col-member">${escapeHtml(entry.name)}</td>
          <td class="col-engine">${escapeHtml(entry.engine || '-')}</td>
          <td class="col-status">${statusDot(entry)}</td>
          <td class="col-focus">${escapeHtml(entry.focus || '-')}</td>
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

function writeTeamBoardHtml(rosterRows, deps = {}) {
  const workspace = deps.cwd || process.cwd();
  const outPath = path.join(workspace, 'atris', 'team', 'team-board.html');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const html = renderTeamRosterHtml(rosterRows, {
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
    'usage: atris team [roster|presence] [--json] [--html]',
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
  const rosterFlags = new Set(['--json', '--html']);
  if (args[0] !== 'presence' && rosterArgs.every((arg) => rosterFlags.has(arg))) {
    const html = rosterArgs.includes('--html');
    const json = rosterArgs.includes('--json');
    if (html && json) {
      (deps.error || process.stderr.write.bind(process.stderr))('usage: atris team [--json] [--html] (not both)\n');
      return 2;
    }
    const roster = deps.roster || collectTeamRoster(deps);
    if (html) {
      const outPath = writeTeamBoardHtml(roster, deps);
      (deps.write || process.stdout.write.bind(process.stdout))(`${outPath}\n`);
      return 0;
    }
    const output = json
      ? JSON.stringify(roster, null, 2)
      : renderTeamRoster(roster, deps);
    (deps.write || process.stdout.write.bind(process.stdout))(`${output}\n`);
    return 0;
  }
  if (args[0] !== 'presence' || args.some((arg, index) => index > 0 && arg !== '--json')) {
    (deps.error || process.stderr.write.bind(process.stderr))('usage: atris team [roster|presence|prune] [--json] [--html]\n');
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
  collectMissions,
  collectTasks,
  collectTeamPresence,
  collectTeamPrune,
  collectTeamRoster,
  renderTeamPrune,
  renderTeamRoster,
  renderTeamRosterHtml,
  writeTeamBoardHtml,
  teamCommand,
};
