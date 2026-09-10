'use strict';

// Two-level daily logging. Member logs (atris/team/<member>/logs/<date>.md)
// keep the detailed workstream: claims, notes, result receipts, completions.
// The master journal (atris/logs/<YYYY>/<date>.md) stays curated and receives
// only consequential entries: terminal task events and explicitly major
// updates such as decisions, handoffs, and shipped work.

const fs = require('fs');
const path = require('path');

function todayLogName(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}.md`;
}

function logStamp(now = new Date()) {
  return now.toTimeString().slice(0, 5);
}

function compactLogText(value, max = 240) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, Math.max(0, max - 3)).trim()}...` : text;
}

function logFieldRows(fields) {
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `- ${key}: ${compactLogText(value, 500)}`);
}

function appendDailyEntry(logPath, title, fields) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, [
    `## ${logStamp()} · ${title}`,
    ...logFieldRows(fields),
    '',
  ].join('\n'), 'utf8');
  return logPath;
}

function memberSlug(root, member) {
  const slug = String(member || '').trim();
  if (!/^[A-Za-z0-9._-]+$/.test(slug)) return null;
  if (!fs.existsSync(path.join(root, 'atris', 'team', slug, 'MEMBER.md'))) return null;
  return slug;
}

function appendMemberDailyEntry(root, member, title, fields) {
  const slug = memberSlug(root, member);
  if (!slug || !fs.existsSync(path.join(root, 'atris'))) return null;
  const logPath = path.join(root, 'atris', 'team', slug, 'logs', todayLogName());
  appendDailyEntry(logPath, title, { ...fields, member: slug });
  return logPath;
}

function appendMasterDailyEntry(root, title, fields) {
  if (!fs.existsSync(path.join(root, 'atris'))) return null;
  const logName = todayLogName();
  const logPath = path.join(root, 'atris', 'logs', logName.slice(0, 4), logName);
  appendDailyEntry(logPath, title, fields);
  return logPath;
}

// Notes a person deliberately escalates to the day record. Anything else stays
// in the member's own log so the master journal does not become a transcript.
const MASTER_NOTE = /^(decision|decided|milestone|handoff|shipped|launched|landed|blocked)\b\s*[:\-]/i;

function noteTitle(content) {
  const key = String(content || '').trim().match(/^([a-z]+)\s*[:\-]/i);
  const word = key ? key[1].toLowerCase() : '';
  if (word === 'decision' || word === 'decided') return 'Task decision';
  if (word === 'handoff') return 'Task handoff';
  if (word === 'shipped' || word === 'launched' || word === 'landed') return 'Task shipped';
  if (word === 'blocked') return 'Task blocked';
  if (word === 'milestone') return 'Task milestone';
  return 'Task update';
}

module.exports = {
  todayLogName,
  logStamp,
  compactLogText,
  logFieldRows,
  appendDailyEntry,
  memberSlug,
  appendMemberDailyEntry,
  appendMasterDailyEntry,
  MASTER_NOTE,
  noteTitle,
};
