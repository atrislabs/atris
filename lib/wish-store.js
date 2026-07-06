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
    if (event && event.kind === 'review') {
      const wishId = String(event.wish_id || '').trim();
      if (!wishId) continue;
      const current = byId.get(wishId) || {
        id: wishId,
        ts: event.ts,
        text: '',
        answers: [],
        reviews: [],
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
      first_ts: event.ts,
    };
    const next = {
      ...current,
      ...event,
      first_ts: current.first_ts || event.ts,
      answers: current.answers || [],
      reviews: current.reviews || [],
    };
    const answers = eventAnswers(event);
    if (answers.length) next.answers = [...next.answers, ...answers];
    byId.set(event.id, next);
  }
  return Array.from(byId.values())
    .sort((a, b) => String(a.first_ts || a.ts || '').localeCompare(String(b.first_ts || b.ts || '')));
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
