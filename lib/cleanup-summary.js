'use strict';

// One plain line per cleanup run, in the daily journal's "## <project>
// overnight" section: the hourly autoland tick writes its own line there and
// so do project jobs (project-obelisk's review sweep and state sync). The
// session start screen reads the latest one back, so the owner sees what the
// background work did without opening anything.

const fs = require('fs');
const path = require('path');

const CLEANUP_WORDS = /\b(landed|land on|closed|put away|parked|need you|reran|archived)\b/i;

function localDate(now) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function journalFile(root, now) {
  return path.join(root, 'atris', 'logs', String(now.getFullYear()), `${localDate(now)}.md`);
}

function sectionName(root) {
  return `${path.basename(path.resolve(root)).replace(/^project-/, '')} overnight`;
}

// Same text twice in one day is written once.
function appendOvernightNote(root, line, now = new Date()) {
  const text = String(line || '').trim();
  if (!text || !fs.existsSync(path.join(root, 'atris'))) return false;
  const file = journalFile(root, now);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const bullet = `- ${text}`;
  if (body.split('\n').some((l) => l.trim() === bullet)) return false;
  const marker = `## ${sectionName(root)}`;
  const idx = body.split('\n').findIndex((l) => l.trim() === marker);
  let next;
  if (idx === -1) {
    next = `${body}${body && !body.endsWith('\n') ? '\n' : ''}\n${marker}\n${bullet}\n`;
  } else {
    const lines = body.split('\n');
    let end = idx + 1;
    while (end < lines.length && !lines[end].startsWith('## ')) end += 1;
    let insertAt = end;
    while (insertAt > idx + 1 && !lines[insertAt - 1].trim()) insertAt -= 1;
    lines.splice(insertAt, 0, bullet);
    next = lines.join('\n');
  }
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, next);
  fs.renameSync(tmp, file);
  return true;
}

function overnightBullets(text) {
  const bullets = [];
  let inSection = false;
  for (const line of String(text || '').split('\n')) {
    if (line.startsWith('## ')) {
      inSection = /\bovernight\s*$/i.test(line.trim());
      continue;
    }
    if (inSection && line.trim().startsWith('- ')) bullets.push(line.trim().slice(2).trim());
  }
  return bullets;
}

function parkedBranchCount(root) {
  try {
    return fs.readFileSync(path.join(root, 'atris', 'reports', 'parked-branches.md'), 'utf8')
      .split('\n').filter((l) => /^- \d{4}-\d{2}-\d{2} · /.test(l)).length;
  } catch {
    return 0;
  }
}

function shorten(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const stop = Math.max(cut.lastIndexOf('; '), cut.lastIndexOf(', '));
  return `${(stop > max * 0.5 ? cut.slice(0, stop) : cut).replace(/[\s,;.]+$/, '')}...`;
}

// The newest cleanup line from today's journal (yesterday's if today has
// none), plus the parked-branch count when the line does not already say it.
// Two small file reads; never throws.
function latestCleanupLine(root, { now = new Date(), max = 150 } = {}) {
  try {
    let line = '';
    for (const offset of [0, 1]) {
      const day = new Date(now);
      day.setDate(day.getDate() - offset);
      let text = '';
      try { text = fs.readFileSync(journalFile(root, day), 'utf8'); } catch { continue; }
      const bullets = overnightBullets(text).filter((b) => CLEANUP_WORDS.test(b));
      if (bullets.length) { line = bullets[bullets.length - 1]; break; }
    }
    const parked = parkedBranchCount(root);
    if (parked && !/parked/i.test(line)) {
      const note = `${parked} agent branch${parked === 1 ? '' : 'es'} parked for you`;
      line = line ? `${shorten(line.replace(/\.$/, ''), max - note.length - 2)}; ${note}` : `${note}.`;
    }
    return line ? shorten(line, max) : '';
  } catch {
    return '';
  }
}

function plural(n, word, many = `${word}s`) {
  return `${n} ${n === 1 ? word : many}`;
}

// The autoland tick's own line. Null when the tick did nothing worth a line.
function tickSummaryLine({ landed = 0, closed = 0, putAway = 0, needYou = 0 } = {}) {
  const parts = [];
  if (landed) parts.push(`landed ${plural(landed, 'finished item')}`);
  if (closed) parts.push(`closed ${plural(closed, 'idle item')} that could never land on their own, each with a plain reason`);
  if (putAway) parts.push(`put away ${plural(putAway, 'done or long-idle item')}`);
  if (!parts.length) return null;
  if (needYou) parts.push(`${needYou} need you (money, deploys, security, or customers)`);
  const text = parts.join('; ');
  return `Autoland: ${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

module.exports = {
  appendOvernightNote,
  latestCleanupLine,
  tickSummaryLine,
};
