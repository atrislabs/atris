'use strict';

// A parked member keeps its folder and saved state; only the views skip it.
// Parking is two frontmatter lines in MEMBER.md:
//   status: parked
//   parked_note: <date> <reason>
// Views (`atris team`, the roster team block, the boot lineup, owner
// inference) read isParked*. Nothing that runs a member reads it, so a
// parked member still runs when called by name.

const fs = require('fs');
const path = require('path');

const FRONTMATTER_RE = /^(﻿?---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/;
const STATUS_LINE_RE = /^status:[ \t]*(['"]?)([^'"#\r\n]*?)\1[ \t]*(?:#.*)?$/m;
const MEMBER_NAME_RE = /^[a-zA-Z0-9._-]+$/;

function memberCardPath(root, name) {
  return path.join(root, 'atris', 'team', name, 'MEMBER.md');
}

function frontmatterStatus(text) {
  const block = FRONTMATTER_RE.exec(String(text || ''));
  if (!block) return '';
  const match = STATUS_LINE_RE.exec(block[2]);
  return match ? match[2].trim().toLowerCase() : '';
}

function isParkedText(text) {
  return frontmatterStatus(text) === 'parked';
}

// For a frontmatter object already parsed by commands/member.js.
function isParkedFrontmatter(frontmatter) {
  return String((frontmatter && frontmatter.status) || '').trim().toLowerCase() === 'parked';
}

function isMemberParked(root, name) {
  const key = String(name || '').trim();
  if (!key || !MEMBER_NAME_RE.test(key)) return false;
  try {
    return isParkedText(fs.readFileSync(memberCardPath(root, key), 'utf8'));
  } catch {
    return false;
  }
}

function todayStamp(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function oneLine(text) {
  return String(text || '').replace(/[\r\n]+/g, ' ').replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();
}

// Rewrites only the status and parked_note lines; every other byte of the
// file stays as it was. Returns { ok, changed, message } or { ok: false, error }.
function setMemberParked(root, name, { parked, note = '', now = new Date() } = {}) {
  const key = String(name || '').trim();
  if (!key || !MEMBER_NAME_RE.test(key)) {
    return { ok: false, error: `no team member named ${key || '(blank)'}. see the team with: atris team --all` };
  }
  const file = memberCardPath(root, key);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { ok: false, error: `no team member named ${key}. see the team with: atris team --all` };
  }
  const block = FRONTMATTER_RE.exec(text);
  const already = isParkedText(text);
  if (parked && already) return { ok: true, changed: false, message: `${key} is already parked` };
  if (!parked && !already) return { ok: true, changed: false, message: `${key} is not parked` };

  const eol = (block ? block[1].endsWith('\r\n') : /\r\n/.test(text)) ? '\r\n' : '\n';
  let next;
  if (parked) {
    const reason = oneLine(note) || 'parked by hand';
    const statusLine = 'status: parked';
    const noteLine = `parked_note: ${todayStamp(now)} ${reason}; unpark with atris team unpark ${key}`;
    if (!block) {
      next = `---${eol}name: ${key}${eol}${statusLine}${eol}${noteLine}${eol}---${eol}${text}`;
    } else {
      let body = block[2];
      const lines = body.split(/\r?\n/);
      const statusAt = lines.findIndex((line) => /^status:/.test(line));
      const noteAt = lines.findIndex((line) => /^parked_note:/.test(line));
      if (statusAt >= 0) lines[statusAt] = statusLine;
      if (noteAt >= 0) lines[noteAt] = noteLine;
      if (statusAt < 0 || noteAt < 0) {
        const nameAt = lines.findIndex((line) => /^name:/.test(line));
        const anchor = statusAt >= 0 ? statusAt : nameAt;
        const insert = [...(statusAt < 0 ? [statusLine] : []), ...(noteAt < 0 ? [noteLine] : [])];
        lines.splice(anchor + 1, 0, ...insert);
      }
      body = lines.join(eol);
      next = text.slice(0, block.index + block[1].length) + body + text.slice(block.index + block[1].length + block[2].length);
    }
  } else {
    const body = block[2]
      .split(/\r?\n/)
      .filter((line) => !/^status:/.test(line) && !/^parked_note:/.test(line))
      .join(eol);
    next = text.slice(0, block.index + block[1].length) + body + text.slice(block.index + block[1].length + block[2].length);
  }
  fs.writeFileSync(file, next, 'utf8');
  return { ok: true, changed: true, message: parked ? `parked ${key}` : `unparked ${key}` };
}

module.exports = {
  isMemberParked,
  isParkedFrontmatter,
  isParkedText,
  setMemberParked,
};
