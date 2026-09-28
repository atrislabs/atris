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

const STATUS_LINE_RE = /^status:[ \t]*(['"]?)([^'"#\r\n]*?)\1[ \t]*(?:#.*)?$/m;
const MEMBER_NAME_RE = /^[a-zA-Z0-9._-]+$/;

function memberCardPath(root, name) {
  return path.join(root, 'atris', 'team', name, 'MEMBER.md');
}

// Splits text into lines that keep their own endings, so a rewrite can
// touch one line and leave every other byte, including mixed LF and CRLF,
// exactly as written.
function splitKeepEndings(text) {
  return String(text || '').match(/[^\n]*\n|[^\n]+$/g) || [];
}

const lineBody = (line) => line.replace(/\r?\n$/, '');

// The frontmatter is the lines between an opening "---" on the first line
// and the next line that is exactly "---". An empty block is fine. Returns
// { lines, open, close } as line indexes, or null when there is none.
function frontmatterBlock(lines) {
  if (!lines.length || lineBody(lines[0]).replace(/^\uFEFF/, '') !== '---') return null;
  for (let at = 1; at < lines.length; at += 1) {
    if (lineBody(lines[at]).trimEnd() === '---') return { open: 0, close: at };
  }
  return null;
}

function frontmatterStatus(text) {
  const lines = splitKeepEndings(text);
  const block = frontmatterBlock(lines);
  if (!block) return '';
  const inside = lines.slice(block.open + 1, block.close).map(lineBody).join('\n');
  const match = STATUS_LINE_RE.exec(inside);
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
  const already = isParkedText(text);
  if (parked && already) return { ok: true, changed: false, message: `${key} is already parked` };
  if (!parked && !already) return { ok: true, changed: false, message: `${key} is not parked` };

  const lines = splitKeepEndings(text);
  const block = frontmatterBlock(lines);
  const endingOf = (line) => (/\r\n$/.test(line) ? '\r\n' : '\n');
  let next;
  if (parked) {
    const reason = oneLine(note) || 'parked by hand';
    const statusLine = 'status: parked';
    const noteLine = `parked_note: ${todayStamp(now)} ${reason}; unpark with atris team unpark ${key}`;
    if (!block) {
      const eol = /\r\n/.test(text) ? '\r\n' : '\n';
      next = `---${eol}name: ${key}${eol}${statusLine}${eol}${noteLine}${eol}---${eol}${text}`;
    } else {
      const inside = (at) => at > block.open && at < block.close;
      const statusAt = lines.findIndex((line, at) => inside(at) && /^status:/.test(line));
      const noteAt = lines.findIndex((line, at) => inside(at) && /^parked_note:/.test(line));
      // A replaced line keeps its own ending; nothing else moves.
      if (statusAt >= 0) lines[statusAt] = statusLine + endingOf(lines[statusAt]);
      if (noteAt >= 0) lines[noteAt] = noteLine + endingOf(lines[noteAt]);
      if (statusAt < 0 || noteAt < 0) {
        const nameAt = lines.findIndex((line, at) => inside(at) && /^name:/.test(line));
        const anchor = statusAt >= 0 ? statusAt : nameAt >= 0 ? nameAt : block.open;
        const eol = endingOf(lines[anchor]);
        const insert = [...(statusAt < 0 ? [statusLine + eol] : []), ...(noteAt < 0 ? [noteLine + eol] : [])];
        lines.splice(anchor + 1, 0, ...insert);
      }
      next = lines.join('');
    }
  } else {
    next = lines
      .filter((line, at) => !(block && at > block.open && at < block.close && /^(status|parked_note):/.test(line)))
      .join('');
  }
  fs.writeFileSync(file, next, 'utf8');
  return { ok: true, changed: true, message: parked ? `parked ${key}` : `unparked ${key}` };
}

module.exports = {
  memberCardPath,
  isMemberParked,
  isParkedFrontmatter,
  isParkedText,
  setMemberParked,
};
