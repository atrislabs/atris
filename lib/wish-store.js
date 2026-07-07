'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { nextRecordNumber } = require('./short-name');

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

function nextWishNumber(root = process.cwd()) {
  return nextRecordNumber(readJsonLines(stateFile(root)));
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

function readLessonsSection(root, heading, cap = Infinity) {
  try {
    const content = fs.readFileSync(lessonsFile(root), 'utf8');
    const match = content.match(new RegExp(`## ${heading}\\n([\\s\\S]*?)(?=\\n## |$)`));
    if (!match) return [];
    return match[1]
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('- '))
      .slice(0, cap);
  } catch {
    return [];
  }
}

function readWishLessonLines(root = process.cwd(), cap = 10) {
  return readLessonsSection(root, 'Lessons', cap);
}

function wishLessonsSummary(root = process.cwd()) {
  const scores = readWishEvents(root)
    .filter((event) => event && event.kind === 'review' && typeof event.review_score === 'number')
    .sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')))
    .map((event) => event.review_score);
  const avg = (list) => (list.length ? Number((list.reduce((s, n) => s + n, 0) / list.length).toFixed(2)) : null);
  return {
    lessons: readLessonsSection(root, 'Lessons'),
    pruned: readLessonsSection(root, 'Pruned \\(did not move the score\\)'),
    inbox: readLessonsSection(root, 'Review inbox \\(raw, distill me\\)').length,
    reviews: scores.length,
    avg_all: avg(scores),
    avg_last5: avg(scores.slice(-5)),
  };
}

function wishLessonsBrief(root = process.cwd(), cap = 10) {
  const lines = readWishLessonLines(root, cap);
  if (!lines.length) return '';
  return ['Lessons from past wishes (apply these):', ...lines].join('\n');
}

const PRUNE_MIN_REVIEWS_AFTER = 3;

function pruneWishLessons(root = process.cwd(), options = {}) {
  const quiet = options.quiet === true;
  const say = quiet ? () => {} : console.log.bind(console);
  const file = lessonsFile(root);
  if (!fs.existsSync(file)) return [];
  const content = fs.readFileSync(file, 'utf8');
  const match = content.match(/## Lessons\n([\s\S]*?)(?=\n## |$)/);
  if (!match) return [];
  const scored = readWishEvents(root)
    .filter((event) => event && event.kind === 'review' && typeof event.review_score === 'number')
    .map((event) => ({ ts: String(event.ts || ''), score: event.review_score }))
    .filter((event) => event.ts)
    .sort((a, b) => a.ts.localeCompare(b.ts));
  const avg = (list) => list.reduce((sum, item) => sum + item.score, 0) / list.length;
  const pruned = [];
  const kept = match[1].split('\n').filter((line) => {
    const trimmed = line.trim();
    const dated = trimmed.match(/^- (\d{4}-\d{2}-\d{2}):/);
    if (!dated) return true;
    const since = dated[1];
    const before = scored.filter((event) => event.ts.slice(0, 10) < since);
    const after = scored.filter((event) => event.ts.slice(0, 10) >= since);
    if (!before.length || after.length < PRUNE_MIN_REVIEWS_AFTER) return true;
    if (avg(after) >= avg(before)) return true;
    pruned.push({
      lesson: trimmed,
      avg_before: Number(avg(before).toFixed(2)),
      avg_after: Number(avg(after).toFixed(2)),
      reviews_after: after.length,
    });
    return false;
  });
  if (!pruned.length) return [];
  let next = content.replace(match[0], `## Lessons\n${kept.join('\n')}`);
  const graveyard = pruned.map((item) =>
    `${item.lesson} [pruned ${todayName()}: avg ${item.avg_before} -> ${item.avg_after} over ${item.reviews_after} reviews]`);
  if (next.includes('## Pruned (did not move the score)')) {
    next = next.replace('## Pruned (did not move the score)', `## Pruned (did not move the score)\n${graveyard.join('\n')}`);
  } else {
    next = `${next.replace(/\s*$/, '')}\n\n## Pruned (did not move the score)\n${graveyard.join('\n')}\n`;
  }
  fs.writeFileSync(file, next, 'utf8');
  for (const item of pruned) {
    say(`wish improve: pruned lesson (avg ${item.avg_before} -> ${item.avg_after} over ${item.reviews_after} reviews): ${item.lesson}`);
  }
  return pruned;
}

function improveWishes(root = process.cwd(), options = {}) {
  const quiet = options.quiet === true;
  const say = quiet ? () => {} : console.log.bind(console);
  const cursor = readImproveCursor(root);
  pruneWishLessons(root, options);
  const reviews = readWishEvents(root)
    .filter((event) => event && event.kind === 'review' && String(event.ts || ''))
    .filter((event) => String(event.ts) > cursor)
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  if (!reviews.length) {
    say('wish improve: nothing new.');
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
  say(`wish improve: ingested ${reviews.length} review${reviews.length === 1 ? '' : 's'} (avg score ${avg}, ${negatives} negative) into ${path.relative(root, file)}.`);
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
  pruneWishLessons,
  readWishLessonLines,
  wishLessonsBrief,
  wishLessonsSummary,
  latestWishEventMap,
  nextWishNumber,
  readJsonLines,
  readWishEvents,
  readWishes,
  slugify,
  stampIso,
  stateFile,
  todayName,
  wishId,
};
