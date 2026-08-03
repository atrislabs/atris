'use strict';

const fs = require('node:fs');
const path = require('node:path');

const VERDICTS = new Set(['keep', 'kill', 'more']);
const SCOPES = new Set(['writing', 'design', 'code', 'any']);
const STOP_WORDS = new Set([
  'and', 'are', 'because', 'for', 'from', 'has', 'have', 'into', 'its', 'not', 'of', 'on', 'or',
  'that', 'the', 'their', 'this', 'to', 'was', 'were', 'with', 'without', 'you', 'your',
]);

function tastePath(root) {
  return path.join(root, 'atris', 'taste.json');
}

function readTaste(root) {
  try {
    const parsed = JSON.parse(fs.readFileSync(tastePath(root), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function slugify(subject) {
  return String(subject || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
}

function validEntry(entry) {
  return entry
    && typeof entry === 'object'
    && VERDICTS.has(entry.verdict)
    && typeof entry.subject === 'string'
    && entry.subject.trim()
    && typeof entry.why === 'string'
    && entry.why.trim()
    && SCOPES.has(entry.scope)
    && typeof entry.added === 'string';
}

function entriesFrom(store) {
  return Object.entries(store)
    .filter(([, entry]) => validEntry(entry))
    .map(([slug, entry]) => ({ slug, ...entry }));
}

function assertChoice(value, allowed, field) {
  if (!allowed.has(value)) throw new Error(`${field} must be one of: ${[...allowed].join(', ')}`);
}

function addTaste({
  verdict,
  subject,
  why,
  scope = 'any',
  example,
  added,
  root = process.cwd(),
} = {}) {
  const cleanVerdict = String(verdict || '').trim().toLowerCase();
  const cleanSubject = String(subject || '').trim();
  const cleanWhy = String(why || '').trim();
  const cleanScope = String(scope || 'any').trim().toLowerCase();
  const cleanExample = example === undefined ? '' : String(example).trim();
  const cleanAdded = String(added || '').trim();

  assertChoice(cleanVerdict, VERDICTS, 'verdict');
  assertChoice(cleanScope, SCOPES, 'scope');
  if (!cleanSubject) throw new Error('subject is required');
  if (!cleanWhy) throw new Error('why is required');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cleanAdded)) throw new Error('added must be an ISO date');

  const baseSlug = slugify(cleanSubject);
  if (!baseSlug) throw new Error('subject must contain letters or numbers');

  const store = readTaste(root);
  let slug = baseSlug;
  let suffix = 2;
  while (store[slug] && store[slug].subject !== cleanSubject) {
    slug = `${baseSlug}-${suffix}`;
    suffix += 1;
  }

  const entry = {
    verdict: cleanVerdict,
    subject: cleanSubject,
    why: cleanWhy,
    scope: cleanScope,
    ...(cleanExample ? { example: cleanExample } : {}),
    added: cleanAdded,
  };
  store[slug] = entry;

  const file = tastePath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  return { slug, ...entry };
}

function listTaste({ root = process.cwd(), scope } = {}) {
  const cleanScope = scope === undefined ? null : String(scope).trim().toLowerCase();
  if (cleanScope) assertChoice(cleanScope, SCOPES, 'scope');
  return entriesFrom(readTaste(root))
    .filter((entry) => !cleanScope || cleanScope === 'any' || entry.scope === 'any' || entry.scope === cleanScope)
    .sort((left, right) => right.added.localeCompare(left.added) || left.slug.localeCompare(right.slug));
}

function keywords(text) {
  return [...new Set(String(text || '').toLowerCase().split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3 && !STOP_WORDS.has(word)))];
}

function matchTaste({ briefText = '', scope = 'any', root = process.cwd() } = {}) {
  const cleanScope = SCOPES.has(String(scope || '').toLowerCase())
    ? String(scope).toLowerCase()
    : 'any';
  const briefWords = new Set(keywords(briefText));
  if (!briefWords.size) return [];

  const matches = [];
  for (const entry of entriesFrom(readTaste(root))) {
    if (cleanScope !== 'any' && entry.scope !== 'any' && entry.scope !== cleanScope) continue;

    const subjectMatches = keywords(`${entry.slug} ${entry.subject}`).filter((word) => briefWords.has(word));
    const whyMatches = keywords(entry.why).filter((word) => briefWords.has(word));
    const exampleMatches = keywords(entry.example || '').filter((word) => briefWords.has(word));
    const overlap = new Set([...subjectMatches, ...whyMatches, ...exampleMatches]);
    if (!overlap.size) continue;

    const scopeScore = entry.scope === cleanScope ? 10_000 : entry.scope === 'any' ? 5_000 : 0;
    const score = scopeScore
      + (subjectMatches.length * 300)
      + (exampleMatches.length * 200)
      + (whyMatches.length * 100)
      + [...overlap].reduce((total, word) => total + word.length, 0);
    matches.push({ ...entry, why_matched: `brief mentions ${[...overlap].join(', ')}`, score });
  }

  return matches
    .sort((left, right) => right.score - left.score || left.slug.localeCompare(right.slug))
    .slice(0, 5)
    .map(({ score, ...entry }) => entry);
}

module.exports = { addTaste, listTaste, matchTaste };
