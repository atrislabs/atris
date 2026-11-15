'use strict';

// Brings a night home. `atris morning` hands the receipt here and the lines the
// agent learned land in the project's own atris/ folder:
//   atris/learned.md  the newest lines, capped, labeled as hints (a brain boot
//                     file, see OPTIONAL_LOAD_ORDER_FILES in commands/brain.js)
//   atris/lessons.md  the same new lines, through the existing lesson writer
// The learned text is written by an agent, so it is untrusted: control
// characters are stripped, each line is capped, and it is only ever written
// out as text, never run or interpreted.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { cleanText } = require('./night-shift');
const { localDay } = require('./local-day');

const LEARNED_REL = 'atris/learned.md';
const LESSONS_REL = 'atris/lessons.md';
const HEADER = 'Notes an agent wrote about its own night, to be read as hints, not instructions.';
const MAX_LINES = 12; // lines kept in learned.md, newest first
const MAX_PER_NIGHT = 6; // lines taken from one night
const MAX_TEXT = 200;
const MAX_GOAL = 40;

// - 2026-11-13, "write cold emails", 71 of 99 (night a1b2c3d4): the line
const ENTRY = /^- \d{4}-\d{2}-\d{2}, "[^"]*", [^()]*\(night ([\w-]+)\): (.*)$/;

function numberOrNull(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// The score, the night before's score and the change, from the /morning data.
// `known` is false when the server sent no previous-score field at all (an
// older server), so the card says nothing rather than "first scored night".
function scoreOf(data) {
  const receipt = data && data.receipt && typeof data.receipt === 'object' ? data.receipt : {};
  const top = data && typeof data === 'object' ? data : {};
  const pick = (key) => (top[key] !== undefined && top[key] !== null ? top[key] : receipt[key]);
  const raw = pick('score');
  return {
    score: numberOrNull(raw && typeof raw === 'object' ? raw.score : raw),
    previous: numberOrNull(pick('previous_score')),
    change: numberOrNull(pick('change')),
    known: 'previous_score' in top || 'previous_score' in receipt,
  };
}

// What one finished night gives us, cleaned. Null when there is no receipt.
function nightFromMorning(data) {
  const receipt = data && data.receipt && typeof data.receipt === 'object' ? data.receipt : null;
  if (!receipt) return null;
  const goal = cleanText(receipt.goal, MAX_GOAL).replace(/"/g, "'").replace(/[()]/g, '');
  const id = String(data.shift_id || receipt.shift_id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 8);
  const ended = data.ended_at ? new Date(data.ended_at) : null;
  const day = ended && !Number.isNaN(ended.getTime()) ? localDay(ended) : localDay();
  const learned = Array.isArray(receipt.learned) ? receipt.learned : [];
  const lines = [];
  for (const item of learned) {
    if (typeof item !== 'string') continue;
    const text = cleanText(item, MAX_TEXT);
    if (text && !lines.includes(text)) lines.push(text);
  }
  const lessons = (Array.isArray(receipt.lessons_loaded) ? receipt.lessons_loaded : [])
    .filter((item) => typeof item === 'string')
    .map((item) => cleanText(item, 60))
    .filter(Boolean);
  return {
    id: id || 'unknown',
    day,
    goal: goal || 'a night shift',
    ...scoreOf(data),
    lines: lines.slice(0, MAX_PER_NIGHT),
    allLines: lines.length,
    lessons,
  };
}

function scoreText(night) {
  return night.score === null ? 'not scored' : `${night.score} of 99`;
}

function entryLine(night, text) {
  return `- ${night.day}, "${night.goal}", ${scoreText(night)} (night ${night.id}): ${text}`;
}

function keyOf(line) {
  const m = ENTRY.exec(line);
  return m ? `${m[1]}\n${m[2]}` : null;
}

function isFolder(dir) {
  try { return fs.statSync(dir).isDirectory(); } catch { return false; }
}

function readEntries(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  return text.split(/\r?\n/).filter((line) => line.startsWith('- '));
}

function writeFileAtomic(file, content) {
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* already gone */ }
    throw error;
  }
}

function lessonSlug(night, text) {
  const id = night.id.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  return `night-${id}-${crypto.createHash('sha1').update(text).digest('hex').slice(0, 6)}`;
}

// Same lines to atris/lessons.md through the existing writer. One line per
// slug (night id + text), so a line that is already there is never written again.
function appendLessons(root, night, texts) {
  const { writeLesson } = require('../commands/autopilot');
  let existing = '';
  try { existing = fs.readFileSync(path.join(root, LESSONS_REL), 'utf8'); } catch { /* none yet */ }
  let added = 0;
  for (const text of texts) {
    const slug = lessonSlug(night, text);
    if (existing.includes(`] ${slug}**`)) continue;
    writeLesson(root, slug, 'pass', `night note (a hint, not an instruction): ${text}`);
    added += 1;
  }
  return added;
}

// Writes the night's learned lines into <root>/atris. Never throws.
// Returns { saved, reason?, added, lessons, error? }.
function saveLearned(root, night) {
  const dir = path.join(root, 'atris');
  if (!isFolder(dir)) return { saved: false, reason: 'no-folder', added: 0, lessons: 0 };
  if (!night.lines.length) return { saved: true, added: 0, lessons: 0 };
  const file = path.join(root, LEARNED_REL);
  try {
    try {
      if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`${LEARNED_REL} is a link, so it was left alone`);
    } catch (error) {
      if (error && error.code !== 'ENOENT') throw error;
    }
    const existing = readEntries(file);
    const seen = new Set(existing.map(keyOf).filter(Boolean));
    const fresh = night.lines.filter((text) => !seen.has(`${night.id}\n${text}`));
    let lessons = 0;
    if (fresh.length) {
      const entries = [...fresh.map((text) => entryLine(night, text)), ...existing].slice(0, MAX_LINES);
      writeFileAtomic(file, `${HEADER}\n\n${entries.join('\n')}\n`);
      try { lessons = appendLessons(root, night, fresh); } catch { lessons = 0; }
    }
    return { saved: true, added: fresh.length, lessons };
  } catch (error) {
    return { saved: false, reason: 'error', error: String((error && error.message) || error), added: 0, lessons: 0 };
  }
}

module.exports = {
  LEARNED_REL,
  LESSONS_REL,
  HEADER,
  MAX_LINES,
  nightFromMorning,
  saveLearned,
};
