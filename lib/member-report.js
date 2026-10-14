'use strict';

// `atris member report [--since <time>] [--json]`: a short per-member summary
// of what the team did. Four groups, newest first, one line per piece of work:
//   merged       diary "Task completed" with action merged, plus the PR link
//   finished     diary mission ticks whose check passed, accepted tasks, completed missions
//   turned down  tasks a person sent back (task db) and tasks set aside (diary), with the reason
//   waiting      tasks sitting in review for a person right now (task db)
// Diary headings are `## HH:MM · title` in local time and the file name holds
// the date, so every time here is local; nothing prints in UTC.
// Merged and finished lines also say how long the job took (first pickup to
// finish) and how many tries it needed (every run, failed or timed out too).

const fs = require('fs');
const path = require('path');

const DEFAULT_SINCE = '24h';
const PER_GROUP = 3;
// A job picked up before the window still gets its real start time.
const HISTORY_DAYS = 7;
const LOG_NAME_RE = /^(\d{4})-(\d{2})-(\d{2})\.md$/;
const HEADING_RE = /^##\s+(\d{1,2}):(\d{2})\s*(?:·|-|:)?\s*(.*)$/;
const FIELD_RE = /^-\s+([a-z_][a-z0-9_ ]*):\s*(.*)$/i;
const URL_RE = /https?:\/\/\S+/;
const GROUPS = [
  ['merged', 'merged'],
  ['finished', 'finished'],
  ['turned_down', 'turned down'],
  ['waiting', 'not merged yet'],
];

function usage() {
  return [
    'usage:',
    '  atris member report [--since <time>] [--json]',
    '',
    'a short summary of what each member got merged, finished, had turned down,',
    'and what is done but not merged yet.',
    '',
    'options:',
    '  --since <time>  2h, 30m, 3d, today, yesterday, a date, or an iso time (default: 24h)',
    '  --json          print the report as json',
  ].join('\n');
}

function localMidnight(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

// Returns a Date, or null when the text is not a time we understand.
function parseSince(text, now = new Date()) {
  const raw = String(text || '').trim().toLowerCase();
  if (!raw) return null;
  if (raw === 'today') return localMidnight(now);
  if (raw === 'yesterday') {
    const day = localMidnight(now);
    day.setDate(day.getDate() - 1);
    return day;
  }
  const relative = raw.match(/^(\d+)\s*(m|min|h|hr|d|day|days)$/);
  if (relative) {
    const unit = relative[2][0];
    const ms = Number(relative[1]) * (unit === 'm' ? 60e3 : unit === 'h' ? 3600e3 : 86400e3);
    return new Date(now.getTime() - ms);
  }
  const dateOnly = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) return new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]));
  const ms = Date.parse(String(text).trim());
  return Number.isFinite(ms) ? new Date(ms) : null;
}

function parseReportArgs(args = []) {
  let since = DEFAULT_SINCE;
  let json = false;
  let help = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index]);
    if (arg === '--help' || arg === '-h') { help = true; continue; }
    if (arg === '--json') { json = true; continue; }
    if (arg === '--since') {
      if (index + 1 >= args.length) throw new Error('--since needs a time, like 2h or yesterday');
      since = String(args[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith('--since=')) { since = arg.slice('--since='.length); continue; }
    throw new Error(`unknown option ${arg}\n${usage()}`);
  }
  return { help, since, json };
}

function parseDiary(text, year, month, day) {
  const entries = [];
  let current = null;
  for (const line of String(text || '').split('\n')) {
    const heading = line.match(HEADING_RE);
    if (heading) {
      const at = new Date(year, month - 1, day, Number(heading[1]), Number(heading[2]));
      current = { at, title: heading[3].trim(), fields: {} };
      entries.push(current);
      continue;
    }
    const field = current && line.match(FIELD_RE);
    if (field) {
      const key = field[1].trim().toLowerCase();
      if (!(key in current.fields)) current.fields[key] = field[2].trim();
    }
  }
  return entries;
}

function memberNames(root) {
  const teamDir = path.join(root, 'atris', 'team');
  if (!fs.existsSync(teamDir)) return null;
  return fs.readdirSync(teamDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !/^[._]/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

function diaryEntriesSince(root, member, since) {
  const logsDir = path.join(root, 'atris', 'team', member, 'logs');
  if (!fs.existsSync(logsDir)) return [];
  const sinceDay = localMidnight(since).getTime();
  const entries = [];
  for (const name of fs.readdirSync(logsDir).sort()) {
    const match = name.match(LOG_NAME_RE);
    if (!match) continue;
    const [year, month, day] = match.slice(1).map(Number);
    if (new Date(year, month - 1, day).getTime() < sinceDay) continue;
    const text = fs.readFileSync(path.join(logsDir, name), 'utf8');
    for (const entry of parseDiary(text, year, month, day)) {
      if (entry.at.getTime() >= since.getTime()) entries.push(entry);
    }
  }
  return entries;
}

// One diary entry becomes at most one summary item, or null when it is
// bookkeeping (claimed, started, notes, ticks that did not pass their check).
function classifyDiaryEntry(entry) {
  const f = entry.fields;
  const kind = entry.title.replace(/\s+\d+$/, '');
  if (kind === 'Task completed' && f.action === 'merged') {
    const link = (String(f.proof || '').match(URL_RE) || [''])[0].replace(/[).,]+$/, '');
    return { group: 'merged', title: f.title, link: link || null };
  }
  if (kind === 'Task completed' || kind === 'Task accepted') return { group: 'finished', title: f.title };
  if (kind === 'Mission completed') return { group: 'finished', title: f.mission || f.title };
  if (kind === 'Mission run tick' && f.verifier === 'passed') {
    return { group: 'finished', title: f.mission, detail: f.summary };
  }
  if (kind === 'Task archived' || kind === 'Task failed') {
    return { group: 'turned_down', title: f.title, reason: f.proof || f.reason || null };
  }
  return null;
}

// Rows from the task db for this workspace: who sent work back and what is
// waiting on a person. Tasks with no team member behind them are skipped.
function taskItems(tasks, sinceMs, members) {
  const known = new Set(members);
  const items = [];
  for (const task of tasks || []) {
    const meta = task && task.metadata && typeof task.metadata === 'object' ? task.metadata : {};
    const member = [meta.built_by, meta.assigned_to, task.claimed_by].find((name) => name && known.has(name));
    if (!member) continue;
    if (task.status !== 'review') continue;
    if (meta.approval_status === 'revise') {
      const at = Date.parse(meta.human_revision_at || '');
      if (Number.isFinite(at) && at >= sinceMs) {
        items.push({ member, at, group: 'turned_down', title: task.title, reason: meta.human_revision_note || null });
      }
      continue;
    }
    items.push({ member, at: Number(task.updated_at) || 0, group: 'waiting', title: task.title });
  }
  return items;
}

function jobKey(text) {
  return String(text || '').trim().toLowerCase();
}

// Walks one member's diary oldest first and returns, for each entry that
// finishes a job, { took_minutes, tries }. A job opens at its first pickup and
// stays open through failed runs and re-pickups; a pickup after a passing run
// opens a new job. Finishes with no pickup in the diary get nothing.
function jobTimings(entries) {
  const jobs = new Map();
  const stamps = new Map();
  for (const entry of [...entries].sort((a, b) => a.at - b.at)) {
    const f = entry.fields;
    const kind = entry.title.replace(/\s+\d+$/, '');
    if (kind === 'Task claimed' || kind === 'Mission started') {
      const key = jobKey(kind === 'Task claimed' ? f.title : f.mission);
      const job = jobs.get(key);
      if (key && (!job || job.done)) jobs.set(key, { startAt: entry.at.getTime(), tries: 0, done: false });
      continue;
    }
    const finishKey = kind === 'Mission run tick' ? jobKey(f.mission)
      : kind === 'Mission completed' ? jobKey(f.mission || f.title)
        : kind === 'Task completed' || kind === 'Task accepted' ? jobKey(f.title) : null;
    const job = finishKey && jobs.get(finishKey);
    if (!job) continue;
    if (kind === 'Mission run tick') {
      if (job.done) continue;
      job.tries += 1;
      if (f.verifier !== 'passed') continue;
      job.done = true;
    }
    const stamp = { took_minutes: Math.round((entry.at.getTime() - job.startAt) / 60e3) };
    if (job.tries) stamp.tries = job.tries;
    stamps.set(entry, stamp);
  }
  return stamps;
}

function sameTitle(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

function summarize(items) {
  const groups = { merged: [], finished: [], turned_down: [], waiting: [] };
  const sorted = [...items].sort((a, b) => b.at - a.at);
  for (const item of sorted) {
    if (!item.title) continue;
    // Newest word on a piece of work wins, and merged beats finished.
    if (Object.values(groups).some((list) => list.some((seen) => sameTitle(seen.title, item.title)))) continue;
    const { member, at, group, ...rest } = item;
    groups[group].push(rest);
  }
  return groups;
}

function memberReport(root, { since = DEFAULT_SINCE, now = new Date(), tasks = [] } = {}) {
  const sinceAt = parseSince(since, now);
  if (!sinceAt) throw new Error(`--since "${since}" is not a time; try 2h, yesterday, or 2026-10-14`);
  const names = memberNames(root);
  if (!names) throw new Error('no atris/team folder here; run this inside an atris workspace');
  const fromTasks = taskItems(tasks, sinceAt.getTime(), names);
  const historyAt = new Date(sinceAt.getTime() - HISTORY_DAYS * 86400e3);
  const members = names
    .map((member) => {
      const history = diaryEntriesSince(root, member, historyAt);
      const timings = jobTimings(history);
      const items = history
        .filter((entry) => entry.at.getTime() >= sinceAt.getTime())
        .map((entry) => {
          const item = classifyDiaryEntry(entry);
          if (!item) return null;
          const timing = item.group === 'merged' || item.group === 'finished' ? timings.get(entry) : null;
          return { member, at: entry.at.getTime(), ...item, ...timing };
        })
        .filter(Boolean)
        .concat(fromTasks.filter((item) => item.member === member));
      const groups = summarize(items);
      const total = Object.values(groups).reduce((sum, list) => sum + list.length, 0);
      return { member, total, ...groups };
    })
    .filter((row) => row.total > 0)
    .sort((a, b) => b.total - a.total || a.member.localeCompare(b.member));
  const totals = {};
  for (const [key] of GROUPS) totals[key] = members.reduce((sum, row) => sum + row[key].length, 0);
  return { ok: true, action: 'report', since: localStamp(sinceAt, now), totals, members };
}

function pad(n) {
  return String(n).padStart(2, '0');
}

// "14:05" today, "yesterday 14:05", or "10-12 14:05"; always the local clock.
function localStamp(at, now) {
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const days = Math.round((localMidnight(now) - localMidnight(at)) / 86400e3);
  if (days === 0) return time;
  if (days === 1) return `yesterday ${time}`;
  return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${time}`;
}

function clip(text, max) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

// The first sentence of a tick summary says what changed in plain words; the
// mission text is the job description, so it is only the fallback.
function firstSentence(text) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  const match = flat.match(/^.*?[.!?](?=\s|$)/);
  return match ? match[0] : flat;
}

// "took 3h 30m, 2 tries"; empty when the diary never showed the pickup.
function timingText(item) {
  if (!Number.isFinite(item.took_minutes)) return '';
  const minutes = item.took_minutes;
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  const took = minutes < 1 ? 'under a minute'
    : days ? `${days}d${hours ? ` ${hours}h` : ''}`
      : hours ? `${hours}h${mins ? ` ${mins}m` : ''}` : `${mins}m`;
  const tries = item.tries ? `, ${item.tries} ${item.tries === 1 ? 'try' : 'tries'}` : '';
  return `  took ${took}${tries}`;
}

function itemLine(key, item) {
  if (key === 'merged' || key === 'finished') return baseLine(key, item) + timingText(item);
  return baseLine(key, item);
}

function baseLine(key, item) {
  if (key === 'finished' && item.detail) return clip(firstSentence(item.detail), 90);
  if (key === 'merged') return item.link ? `${clip(item.title, 70)}  ${item.link}` : clip(item.title, 90);
  if (key === 'turned_down') return item.reason ? `${clip(item.title, 50)}: ${clip(item.reason, 70)}` : clip(item.title, 90);
  return clip(item.title, 90);
}

function formatReport(report) {
  const lines = ['', `what the team did since ${report.since}`];
  if (!report.members.length) {
    lines.push('', '  nothing merged, finished, turned down, or done since then.', '');
    return lines.join('\n');
  }
  lines.push(GROUPS.map(([key, label]) => `${report.totals[key]} ${label}`).join(', '));
  for (const row of report.members) {
    lines.push('', row.member);
    for (const [key, label] of GROUPS) {
      const list = row[key];
      list.slice(0, PER_GROUP).forEach((item, index) => {
        lines.push(`  ${(index === 0 ? label : '').padEnd(15)}${itemLine(key, item)}`);
      });
      if (list.length > PER_GROUP) lines.push(`  ${''.padEnd(15)}and ${list.length - PER_GROUP} more`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

function loadTasks(root) {
  try {
    const taskDb = require('./task-db');
    return taskDb.listTasks(taskDb.open(), { workspaceRoot: taskDb.workspaceRoot(root) });
  } catch {
    return [];
  }
}

function memberReportCommand(...args) {
  let parsed;
  try {
    parsed = parseReportArgs(args);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return null;
  }
  if (parsed.help) {
    console.log(usage());
    return null;
  }
  let report;
  try {
    const root = process.cwd();
    report = memberReport(root, { since: parsed.since, tasks: loadTasks(root) });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return null;
  }
  console.log(parsed.json ? JSON.stringify(report, null, 2) : formatReport(report));
  return report;
}

module.exports = {
  formatReport,
  memberReport,
  memberReportCommand,
  parseSince,
};
