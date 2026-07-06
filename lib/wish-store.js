'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function stateFile(root = process.cwd()) {
  return path.join(root, '.atris', 'state', 'wishes.jsonl');
}

function stampIso() {
  return new Date().toISOString();
}

function todayName(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function slugify(value) {
  return String(value || 'wish')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36) || 'wish';
}

function wishId(text, ts = stampIso()) {
  const hash = crypto.createHash('sha1').update(`${text}:${ts}`).digest('hex').slice(0, 8);
  return `wish-${todayName(new Date(ts))}-${slugify(text)}-${hash}`;
}

function appendJsonLine(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
  return file;
}

function appendWishRecord(root, record) {
  return appendJsonLine(stateFile(root), record);
}

function readJsonLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function eventAnswers(event) {
  const answers = [];
  for (const key of ['answer', 'answer_text', 'grant_answer']) {
    const value = event && event[key];
    if (String(value || '').trim()) answers.push(String(value));
  }
  if (Array.isArray(event && event.answers)) {
    answers.push(...event.answers.map(String).filter((value) => value.trim()));
  }
  return answers;
}

function readWishEvents(root = process.cwd()) {
  return readJsonLines(stateFile(root));
}

function readWishes(root = process.cwd()) {
  const byId = new Map();
  for (const event of readWishEvents(root)) {
    if (event && event.kind === 'steer') {
      const wishId = String(event.wish_id || '').trim();
      if (!wishId) continue;
      const current = byId.get(wishId) || {
        id: wishId,
        ts: event.ts,
        text: '',
        answers: [],
        reviews: [],
        steers: [],
        first_ts: event.ts,
      };
      const steer = {
        ts: event.ts,
        note: event.note || '',
        steered_by: event.steered_by || null,
        mission_id: event.mission_id || null,
      };
      const steers = [...(current.steers || []), steer];
      byId.set(wishId, {
        ...current,
        steers,
        steer_count: steers.length,
        latest_steer: steer,
      });
      continue;
    }
    if (event && event.kind === 'review') {
      const wishId = String(event.wish_id || '').trim();
      if (!wishId) continue;
      const current = byId.get(wishId) || {
        id: wishId,
        ts: event.ts,
        text: '',
        answers: [],
        reviews: [],
        steers: [],
        first_ts: event.ts,
      };
      const review = {
        ts: event.ts,
        review_text: event.review_text || '',
        review_score: event.review_score === undefined ? null : event.review_score,
        reviewed_by: event.reviewed_by || null,
      };
      const reviews = [...(current.reviews || []), review];
      byId.set(wishId, {
        ...current,
        reviews,
        reviewed: true,
        review_count: reviews.length,
        latest_review: review,
      });
      continue;
    }
    if (!event || !event.id) continue;
    const current = byId.get(event.id) || {
      id: event.id,
      ts: event.ts,
      text: event.text || '',
      answers: [],
      reviews: [],
      steers: [],
      first_ts: event.ts,
    };
    const next = {
      ...current,
      ...event,
      first_ts: current.first_ts || event.ts,
      answers: current.answers || [],
      reviews: current.reviews || [],
      steers: current.steers || [],
    };
    const answers = eventAnswers(event);
    if (answers.length) next.answers = [...next.answers, ...answers];
    byId.set(event.id, next);
  }
  return Array.from(byId.values())
    .sort((a, b) => String(a.first_ts || a.ts || '').localeCompare(String(b.first_ts || b.ts || '')));
}

function improveCursorFile(root = process.cwd()) {
  return path.join(root, '.atris', 'state', 'wish-improve.cursor.json');
}

function lessonsFile(root = process.cwd()) {
  return path.join(root, '.claude', 'skills', 'wish', 'LESSONS.md');
}

const LESSONS_HEADER = [
  '# Wish lessons',
  '',
  'Reviews from `atris wish review` land here via `atris wish improve`.',
  'The model running the wish skill distills raw inbox entries into one-line lessons, then deletes the raw entries.',
  '',
  '## Lessons',
  '',
  '## Review inbox (raw, distill me)',
  '',
].join('\n');

function readImproveCursor(root = process.cwd()) {
  try {
    const parsed = JSON.parse(fs.readFileSync(improveCursorFile(root), 'utf8'));
    return String((parsed && parsed.last_ts) || '');
  } catch {
    return '';
  }
}

function writeImproveCursor(root, lastTs) {
  const file = improveCursorFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ last_ts: lastTs, updated: stampIso() }, null, 2)}\n`, 'utf8');
}

function improveWishes(root = process.cwd()) {
  const cursor = readImproveCursor(root);
  const reviews = readWishEvents(root)
    .filter((event) => event && event.kind === 'review' && String(event.ts || ''))
    .filter((event) => String(event.ts) > cursor)
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  if (!reviews.length) {
    console.log('wish improve: nothing new.');
    return 0;
  }
  const scores = reviews
    .map((event) => event.review_score)
    .filter((score) => typeof score === 'number');
  const avg = scores.length
    ? (scores.reduce((sum, score) => sum + score, 0) / scores.length).toFixed(2)
    : 'n/a';
  const negatives = scores.filter((score) => score < 0).length;
  const file = lessonsFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : LESSONS_HEADER;
  if (!content.includes('## Review inbox (raw, distill me)')) {
    content = `${content.replace(/\s*$/, '')}\n\n## Review inbox (raw, distill me)\n`;
  }
  const lines = reviews.map((event) => {
    const score = event.review_score === null || event.review_score === undefined ? 'none' : event.review_score;
    return `- ${event.ts} | ${event.wish_id || 'unknown-wish'} | score ${score} | ${String(event.review_text || '').trim()} (by ${event.reviewed_by || 'unknown'})`;
  });
  content = `${content.replace(/\s*$/, '')}\n${lines.join('\n')}\n`;
  fs.writeFileSync(file, content, 'utf8');
  writeImproveCursor(root, String(reviews[reviews.length - 1].ts));
  console.log(`wish improve: ingested ${reviews.length} review${reviews.length === 1 ? '' : 's'} (avg score ${avg}, ${negatives} negative) into ${path.relative(root, file)}.`);
  return 0;
}

function latestWishEventMap(root = process.cwd()) {
  const byId = new Map();
  for (const event of readWishEvents(root)) {
    if (event && event.id) byId.set(event.id, event);
  }
  return byId;
}

module.exports = {
  appendJsonLine,
  appendWishRecord,
  eventAnswers,
  improveWishes,
  lessonsFile,
  latestWishEventMap,
  readJsonLines,
  readWishEvents,
  readWishes,
  slugify,
  stampIso,
  stateFile,
  todayName,
  wishId,
};
