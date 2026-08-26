const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const TASK_EPISODES_FILE = path.join('.atris', 'state', 'task_episodes.jsonl');
const TYPED_LESSONS_FILE = path.join('atris', 'lessons.json');
const REPEAT_THRESHOLD = 2;
const DETECTOR = 'repeated_human_revision_note';

class AutoLessonsError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = 'AutoLessonsError';
    this.code = 'AUTO_LESSONS_ERROR';
  }
}

function compactText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeCorrection(value) {
  return compactText(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[.!?]+$/, '');
}

function lessonSlug(value) {
  const normalized = normalizeCorrection(value);
  const slug = normalized
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) {
    return `correction-${crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 12)}`;
  }
  if (slug.length <= 80) return slug;
  const suffix = crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 8);
  return `${slug.slice(0, 71).replace(/-+$/g, '')}-${suffix}`;
}

function revisionNote(episode) {
  if (!episode || typeof episode !== 'object') return '';
  if (episode.action?.event_type !== 'revision_requested') return '';
  if (!['rework_requested', 'revised'].includes(episode.rl?.label)) return '';
  return compactText(episode.human_feedback?.human_revision_note);
}

function detectRepeatSignals(episodes, options = {}) {
  const threshold = Number.isInteger(options.threshold) && options.threshold > 1
    ? options.threshold
    : REPEAT_THRESHOLD;
  const groups = new Map();
  const seenEpisodes = new Set();

  for (const [index, episode] of (Array.isArray(episodes) ? episodes : []).entries()) {
    const note = revisionNote(episode);
    if (!note) continue;
    const episodeId = compactText(episode.episode_id);
    if (episodeId && seenEpisodes.has(episodeId)) continue;
    if (episodeId) seenEpisodes.add(episodeId);

    const normalized = normalizeCorrection(note);
    const slug = lessonSlug(normalized);
    if (!groups.has(slug)) {
      groups.set(slug, {
        slug,
        note,
        normalized,
        occurrences: [],
      });
    }
    groups.get(slug).occurrences.push({
      episode_id: episodeId || null,
      task_id: compactText(episode.task_id) || null,
      created_at: compactText(episode.created_at) || null,
      row: index + 1,
    });
  }

  return [...groups.values()].filter((signal) => signal.occurrences.length >= threshold);
}

function readJsonl(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw new AutoLessonsError(`cannot read automatic lesson signals from ${filePath}: ${error.message}`, error);
  }
  return raw.split('\n').map((line) => {
    const text = line.trim();
    if (!text) return null;
    try { return JSON.parse(text); } catch { return null; }
  }).filter(Boolean);
}

function readTypedLessons(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return {};
    throw new AutoLessonsError(`cannot read ${filePath}: ${error.message}`, error);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new AutoLessonsError(`cannot file automatic lessons because ${filePath} contains malformed JSON: ${error.message}`, error);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AutoLessonsError(`cannot file automatic lessons because ${filePath} must contain a JSON object`);
  }
  return parsed;
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.auto-lessons-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    try { fs.rmSync(temporaryPath, { force: true }); } catch {}
    throw new AutoLessonsError(`cannot write automatic lessons to ${filePath}: ${error.message}`, error);
  }
}

function isoDate(now) {
  const date = now instanceof Date ? now : new Date(now || Date.now());
  if (Number.isNaN(date.getTime())) throw new AutoLessonsError('cannot file automatic lessons with an invalid date');
  return date.toISOString().slice(0, 10);
}

function typedLesson(signal, options = {}) {
  const taskIds = [...new Set(signal.occurrences.map((item) => item.task_id).filter(Boolean))];
  const episodeIds = [...new Set(signal.occurrences.map((item) => item.episode_id).filter(Boolean))];
  return {
    name: signal.note,
    date: isoDate(options.now),
    scope: compactText(options.scope) || 'workspace',
    rule: signal.note,
    detector: DETECTOR,
    source_signal: {
      type: DETECTOR,
      path: TASK_EPISODES_FILE,
      normalized_correction: signal.normalized,
      occurrences: signal.occurrences.length,
      task_ids: taskIds,
      episode_ids: episodeIds,
    },
    status: 'observed',
    last_detected: isoDate(options.now),
  };
}

function fileAutoLessons(root, options = {}) {
  const episodes = Array.isArray(options.episodes)
    ? options.episodes
    : readJsonl(path.join(root, TASK_EPISODES_FILE));
  const signals = detectRepeatSignals(episodes, options);
  if (!signals.length) return { added: [], detected: [] };

  const lessonsPath = path.join(root, TYPED_LESSONS_FILE);
  const lessons = readTypedLessons(lessonsPath);
  const added = [];
  for (const signal of signals) {
    if (Object.prototype.hasOwnProperty.call(lessons, signal.slug)) continue;
    lessons[signal.slug] = typedLesson(signal, options);
    added.push(signal.slug);
  }
  if (added.length) writeJsonAtomic(lessonsPath, lessons);
  return { added, detected: signals.map((signal) => signal.slug) };
}

module.exports = {
  TASK_EPISODES_FILE,
  TYPED_LESSONS_FILE,
  fileAutoLessons,
  lessonSlug,
};
