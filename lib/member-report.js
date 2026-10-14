'use strict';

// `atris member report [--since <time>] [--json]`: what the team did since a
// time, read from each member's daily diary (atris/team/<member>/logs/*.md).
// Diary headings are `## HH:MM · title` in local time; the file name holds the date.

const fs = require('fs');
const path = require('path');

const DEFAULT_SINCE = '24h';
const LOG_NAME_RE = /^(\d{4})-(\d{2})-(\d{2})\.md$/;
const HEADING_RE = /^##\s+(\d{1,2}):(\d{2})\s*(?:·|-|:)?\s*(.*)$/;
const FIELD_RE = /^-\s+([a-z_][a-z0-9_ ]*):\s*(.*)$/i;
// The field that best says what happened, in order of preference.
const DETAIL_FIELDS = ['did', 'summary', 'shipped', 'title', 'mission', 'note'];

function usage() {
  return [
    'usage:',
    '  atris member report [--since <time>] [--json]',
    '',
    'what the team did since a time, read from every member diary.',
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
  // A bare date means the start of that day where the diaries were written.
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
      if (index + 1 >= args.length) throw new Error('--since needs a time, like 2h or 2026-10-14T09:00:00Z');
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

function memberEntriesSince(root, member, since) {
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
  return entries.sort((a, b) => a.at - b.at);
}

function entryDetail(entry) {
  for (const key of DETAIL_FIELDS) {
    const value = entry.fields[key];
    if (value && value.toLowerCase() !== entry.title.toLowerCase()) return value;
  }
  return '';
}

function memberReport(root, { since = DEFAULT_SINCE, now = new Date() } = {}) {
  const sinceAt = parseSince(since, now);
  if (!sinceAt) throw new Error(`--since "${since}" is not a time; try 2h, yesterday, or 2026-10-14T09:00:00Z`);
  const names = memberNames(root);
  if (!names) throw new Error('no atris/team folder here; run this inside an atris workspace');
  const members = names
    .map((member) => {
      const entries = memberEntriesSince(root, member, sinceAt).map((entry) => ({
        at: entry.at.toISOString(),
        title: entry.title,
        detail: entryDetail(entry),
        fields: entry.fields,
      }));
      return { member, count: entries.length, last_at: entries.length ? entries[entries.length - 1].at : null, entries };
    })
    .filter((row) => row.count > 0)
    .sort((a, b) => Date.parse(b.last_at) - Date.parse(a.last_at) || a.member.localeCompare(b.member));
  return {
    ok: true,
    action: 'report',
    since: sinceAt.toISOString(),
    members_active: members.length,
    members_quiet: names.length - members.length,
    entries: members.reduce((sum, row) => sum + row.count, 0),
    members,
  };
}

function clip(text, max) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function stamp(iso, now) {
  const at = new Date(iso);
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const sameDay = localMidnight(at).getTime() === localMidnight(now).getTime();
  return sameDay ? time : `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${time}`;
}

function formatReport(report, { now = new Date() } = {}) {
  const lines = ['', `what the team did since ${stamp(report.since, now)}`];
  if (!report.members.length) {
    lines.push('', '  nothing written in any member diary since then.', '');
    return lines.join('\n');
  }
  const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  lines.push(`${count(report.members_active, 'member', 'members')} worked, ${count(report.entries, 'entry', 'entries')}, ${report.members_quiet} quiet`);
  for (const row of report.members) {
    lines.push('', `${row.member}  ${count(row.count, 'entry', 'entries')}`);
    for (const entry of row.entries) {
      lines.push(`  ${stamp(entry.at, now).padEnd(11)} ${clip(entry.title, 80)}`);
      if (entry.detail) lines.push(`  ${' '.repeat(11)} ${clip(entry.detail, 100)}`);
    }
  }
  lines.push('');
  return lines.join('\n');
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
    report = memberReport(process.cwd(), { since: parsed.since });
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
  parseDiary,
  parseReportArgs,
  parseSince,
};
