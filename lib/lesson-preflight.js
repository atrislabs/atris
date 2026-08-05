'use strict';

const fs = require('node:fs');
const path = require('node:path');
const escapeRegExp = require('./escape-regexp');

const ACTIVE_STATUSES = new Set(['observed', 'open', 'attempted']);
const KEYWORD_STOP_WORDS = new Set([
  'and', 'are', 'for', 'from', 'into', 'not', 'of', 'on', 'or', 'the', 'this', 'to', 'with', 'without',
]);

function readJson(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function readLessonText(filePath) {
  let content = '';
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return new Map();
  }

  const bySlug = new Map();
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*-\s*\*\*\[([^\]]+)\]\s*([a-z0-9][a-z0-9-]*)\*\*\s*[—:-]+\s*(?:pass|fail)?\s*[—:-]*\s*(.*)$/i);
    if (!match || bySlug.has(match[2])) continue;
    const text = match[3].replace(/^\[resolved\]\s*/i, '').trim();
    if (text) bySlug.set(match[2], text);
  }
  return bySlug;
}

function isPromptRule(mechanism) {
  if (mechanism && typeof mechanism === 'object') {
    const kind = String(mechanism.type || mechanism.kind || '').toLowerCase();
    return kind === 'prompt-rule' || kind === 'prompt_rule' || mechanism.prompt_rule === true;
  }
  return /^\s*prompt[-_\s]?rule\b/i.test(String(mechanism || ''));
}

function lessonIsEligible(lesson) {
  const status = String(lesson && lesson.status || '').toLowerCase();
  if (ACTIVE_STATUSES.has(status)) return true;
  return status === 'resolved' && isPromptRule(lesson.mechanism);
}

function normalizeFile(file) {
  return String(file || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/{2,}/g, '/')
    .replace(/\/$/, '');
}

function pathSpecificity(file) {
  const normalized = normalizeFile(file);
  const segments = normalized.split('/').filter(Boolean).length;
  return (segments * 100) + normalized.length;
}

function overlapStrength(appliesTo, file) {
  const lessonPath = normalizeFile(appliesTo).toLowerCase();
  const taskPath = normalizeFile(file).toLowerCase();
  if (!lessonPath || !taskPath) return 0;
  if (lessonPath === taskPath) return 3;
  if (taskPath.endsWith(`/${lessonPath}`) || lessonPath.endsWith(`/${taskPath}`)) return 3;
  if (taskPath.startsWith(`${lessonPath}/`) || lessonPath.startsWith(`${taskPath}/`)) return 2;
  return 0;
}

function slugKeywords(slug) {
  return [...new Set(String(slug || '').toLowerCase().split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3 && !KEYWORD_STOP_WORDS.has(word)))];
}

function keywordAppears(text, keyword) {
  const escaped = escapeRegExp(keyword);
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(text);
}

function bestMatch({ slug, lesson, briefText, files }) {
  const brief = String(briefText || '');
  const briefLower = brief.toLowerCase().replace(/\\/g, '/');
  const appliesTo = Array.isArray(lesson.applies_to) ? lesson.applies_to : [];
  let best = null;

  for (const lessonFile of appliesTo) {
    const normalizedLessonFile = normalizeFile(lessonFile);
    if (!normalizedLessonFile) continue;
    for (const taskFile of files) {
      const strength = overlapStrength(normalizedLessonFile, taskFile);
      if (!strength) continue;
      const score = 300000 + (strength * 10000) + pathSpecificity(normalizedLessonFile) - appliesTo.length;
      if (!best || score > best.score) {
        best = { score, why: `file overlaps ${normalizedLessonFile}` };
      }
    }
    if (briefLower.includes(normalizedLessonFile.toLowerCase())) {
      const score = 200000 + pathSpecificity(normalizedLessonFile) - appliesTo.length;
      if (!best || score > best.score) {
        best = { score, why: `brief mentions ${normalizedLessonFile}` };
      }
    }
  }

  const matchedKeywords = slugKeywords(slug).filter((keyword) => keywordAppears(brief, keyword));
  if (matchedKeywords.length) {
    const keywordLength = matchedKeywords.reduce((total, keyword) => total + keyword.length, 0);
    const score = 100000 + (matchedKeywords.length * 1000) + keywordLength;
    if (!best || score > best.score) {
      best = { score, why: `brief mentions ${matchedKeywords.join(', ')}` };
    }
  }

  return best;
}

function matchLessons({ briefText = '', files = [], root = process.cwd() } = {}) {
  const metadata = readJson(path.join(root, 'atris', 'lessons.json'));
  const lessonText = readLessonText(path.join(root, 'atris', 'lessons.md'));
  const normalizedFiles = (Array.isArray(files) ? files : [files]).map(normalizeFile).filter(Boolean);
  const matches = [];

  for (const [slug, lesson] of Object.entries(metadata)) {
    if (slug === '_schema' || !lesson || typeof lesson !== 'object') continue;
    if (!lessonIsEligible(lesson)) continue;
    const text = lessonText.get(slug);
    if (!text) continue;
    const matched = bestMatch({ slug, lesson, briefText, files: normalizedFiles });
    if (!matched) continue;
    matches.push({ slug, text, why_matched: matched.why, score: matched.score });
  }

  return matches
    .sort((left, right) => right.score - left.score || left.slug.localeCompare(right.slug))
    .slice(0, 5)
    .map(({ slug, text, why_matched }) => ({ slug, text, why_matched }));
}

module.exports = { matchLessons };
