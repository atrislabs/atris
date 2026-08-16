#!/usr/bin/env node
'use strict';

// Replace paraphrased ytnotes quotes with nearby caption words, or drop them.
// Usage: node ytquote-repair.js <notes.md> <clean-transcript.txt>
// Always exits 0. Summary goes to stderr.

const fs = require('node:fs');

const QUOTE_LINE = /^(\s*>\s*)(["“])(.+?)(["”])(\s*\[(\d{1,2}:\d{2}(?::\d{2})?)\])\s*$/;
const ANCHOR_LINE = /^\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*$/;
const NEAR_SEC = 60;
const OVERLAP_MIN = 0.6;
const QUOTE_MAX = 240;

function normalizeText(s) {
  return String(s)
    .toLowerCase()
    .replace(/[‘’“”'"]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseTimestamp(ts) {
  const parts = String(ts).split(':').map(Number);
  if (!parts.length || parts.some((n) => Number.isNaN(n))) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

function probeHits(quote, flatTranscript) {
  const words = normalizeText(quote).split(' ').filter(Boolean);
  const probe = words.slice(0, Math.min(6, words.length)).join(' ');
  return Boolean(probe && flatTranscript.includes(probe));
}

function parseTranscript(text) {
  const segments = [];
  let current = null;
  for (const line of String(text).split(/\r?\n/)) {
    const anchor = line.match(ANCHOR_LINE);
    if (anchor) {
      if (current) segments.push(current);
      current = { time: parseTimestamp(anchor[1]), words: [] };
      continue;
    }
    if (!current) continue;
    for (const word of line.trim().split(/\s+/).filter(Boolean)) {
      current.words.push(word);
    }
  }
  if (current) segments.push(current);
  return segments;
}

function nearbyWords(segments, time) {
  const words = [];
  for (const seg of segments) {
    if (seg.time == null || Math.abs(seg.time - time) > NEAR_SEC) continue;
    words.push(...seg.words);
  }
  return words;
}

function wordOverlap(quoteWords, windowWords) {
  const windowSet = new Set(windowWords.filter(Boolean));
  let hit = 0;
  for (const word of quoteWords) {
    if (word && windowSet.has(word)) hit += 1;
  }
  return quoteWords.length ? hit / quoteWords.length : 0;
}

function bestWindow(quoteWords, sourceExact) {
  const n = quoteWords.length;
  if (!n || !sourceExact.length) return null;

  const sourceNorm = sourceExact.map((word) => normalizeText(word));
  const limit = Math.max(1, sourceExact.length - n + 1);
  let bestScore = -1;
  let bestExact = '';

  for (let i = 0; i < limit; i += 1) {
    const size = Math.min(n, sourceExact.length - i);
    const score = wordOverlap(quoteWords, sourceNorm.slice(i, i + size));
    if (score > bestScore) {
      bestScore = score;
      bestExact = sourceExact.slice(i, i + size).join(' ');
    }
  }

  if (bestScore < OVERLAP_MIN) return null;
  return bestExact.length > QUOTE_MAX ? bestExact.slice(0, QUOTE_MAX).trim() : bestExact;
}

function repairNotes(notes, transcript) {
  const flat = normalizeText(transcript);
  const segments = parseTranscript(transcript);
  const nl = String(notes).includes('\r\n') ? '\r\n' : '\n';
  const raw = String(notes);
  const hadTrailing = /[\r\n]$/.test(raw);
  const lines = raw.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  if (lines.length === 1 && lines[0] === '' && raw === '') {
    return { text: '', kept: 0, repaired: 0, dropped: 0 };
  }

  const out = [];
  let kept = 0;
  let repaired = 0;
  let dropped = 0;

  for (const line of lines) {
    const match = line.match(QUOTE_LINE);
    if (!match) {
      out.push(line);
      continue;
    }

    const quote = match[3];
    if (probeHits(quote, flat)) {
      out.push(line);
      kept += 1;
      continue;
    }

    const time = parseTimestamp(match[6]);
    const quoteWords = normalizeText(quote).split(' ').filter(Boolean);
    const repairedText = time == null ? null : bestWindow(quoteWords, nearbyWords(segments, time));
    if (!repairedText) {
      dropped += 1;
      continue;
    }

    out.push(`${match[1]}"${repairedText}"${match[5]}`);
    repaired += 1;
  }

  let text = out.join(nl);
  if (hadTrailing || raw.length) text += nl;
  return { text, kept, repaired, dropped };
}

function main() {
  const notesPath = process.argv[2];
  const transcriptPath = process.argv[3];
  let kept = 0;
  let repaired = 0;
  let dropped = 0;

  try {
    if (notesPath && transcriptPath && fs.existsSync(notesPath)) {
      const notes = fs.readFileSync(notesPath, 'utf8');
      const transcript = fs.existsSync(transcriptPath)
        ? fs.readFileSync(transcriptPath, 'utf8')
        : '';
      const result = repairNotes(notes, transcript);
      fs.writeFileSync(notesPath, result.text);
      kept = result.kept;
      repaired = result.repaired;
      dropped = result.dropped;
    }
  } catch {
    kept = 0;
    repaired = 0;
    dropped = 0;
  }

  console.error(`quotes: ${kept} kept, ${repaired} repaired, ${dropped} dropped`);
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = {
  normalizeText,
  repairNotes,
};
