'use strict';

// What the project already knows, small enough for every idea round and talk
// turn: the goal, the last few days of the journal, the features and where
// each stands, the wiki pages nearest the goal, open and recently finished
// tasks, and what the owner decided. Built by plain rules (no model), from
// index files first and never from raw archives, cached on disk and rebuilt
// only when those files change.
//
// Also the notes the owner teaches the team in card conversations ("never
// suggest paid ads"): a member's own in atris/team/<member>/lessons.md, the
// team's in atris/lessons.md, each under its own heading, so every agent that
// already reads those files sees them too.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// The whole digest, in tokens (about four characters each).
const DIGEST_TOKEN_BUDGET = 1500;
const CHARS_PER_TOKEN = 4;
const SECTION_SHARE = { goal: 0.05, journal: 0.3, features: 0.18, wiki: 0.2, tasks: 0.15, decisions: 0.12 };
const JOURNAL_DAYS = 3;
const KEPT_FIELDS = new Set(['title', 'note', 'notes', 'summary', 'result', 'lesson', 'learned', 'decision', 'said', 'reason']);
const WIKI_PAGES = 2;
const NOTES_HEADING = '## What the owner taught us in the feed';
const NOTES_MAX = 20;
const NOTE_MAX_CHARS = 160;
const NOTES_IN_PROMPT = 8;

function core() {
  return require('./feed-core')._internal;
}

function read(file, max = 200000) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > max) return '';
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function mtime(file) {
  try { return Math.round(fs.statSync(file).mtimeMs); } catch { return 0; }
}

function clip(text, max) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function plainLine(line) {
  return String(line)
    .replace(/\[\[([^\]]+)\]\]/g, (_, p) => path.basename(p).replace(/\.md$/, '').replace(/-/g, ' '))
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_>#]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function fit(lines, chars) {
  const out = [];
  let used = 0;
  for (const line of lines) {
    if (!line) continue;
    if (used + line.length + 1 > chars) break;
    out.push(line);
    used += line.length + 1;
  }
  return out;
}

// --------------------------------------------------------------- sources

function journalFiles(root) {
  const base = path.join(root, 'atris', 'logs');
  let years = [];
  try { years = fs.readdirSync(base).filter((y) => /^\d{4}$/.test(y)).sort().slice(-2); } catch { return []; }
  const files = [];
  for (const year of years) {
    let names = [];
    try { names = fs.readdirSync(path.join(base, year)).filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n)); } catch {}
    for (const name of names) files.push(path.join(base, year, name));
  }
  return files.sort().slice(-JOURNAL_DAYS).reverse();
}

function journalLines(files, chars) {
  const perDay = Math.max(200, Math.floor(chars / Math.max(1, files.length)));
  const lines = [];
  for (const file of files) {
    const day = path.basename(file, '.md');
    const picked = read(file).split('\n')
      .filter((line) => /^\s*(#{2,4}\s|[-*]\s)/.test(line))
      // Machine fields under an entry (task: PRJ-2, status: archived) are
      // noise; the words a person or member wrote are kept.
      .filter((line) => { const field = /^\s*[-*]\s*([a-z_]+):\s/.exec(line); return !field || KEPT_FIELDS.has(field[1]); })
      .map((line) => plainLine(line).replace(/^\d\d:\d\d\s*·\s*/, ''))
      .filter((line) => line.length > 8);
    const kept = fit(picked.map((line) => `  ${clip(line, 140)}`), perDay - day.length - 2);
    if (kept.length) lines.push(`${day}:`, ...kept);
  }
  return fit(lines, chars);
}

function featureFiles(root) {
  const dir = path.join(root, 'atris', 'features');
  const index = path.join(dir, 'index.md');
  if (fs.existsSync(index)) return { index, folders: [] };
  let names = [];
  try { names = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && !/^[._]/.test(d.name)).map((d) => d.name).sort(); } catch {}
  return { index: null, folders: names.map((name) => path.join(dir, name)) };
}

function featureState(folder) {
  for (const name of ['STATUS.md', 'status.md', 'idea.md', 'README.md', 'PLAN.md', 'build.md']) {
    const text = read(path.join(folder, name));
    if (!text) continue;
    const status = /^\s*(?:[-*]\s*)?\**status\**\s*[:-]\s*(.+)$/im.exec(text);
    if (status) return { file: path.join(folder, name), state: plainLine(status[1]) };
    const sentence = text.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#') && !l.startsWith('---') && !/^\w+:\s/.test(l));
    return { file: path.join(folder, name), state: sentence ? plainLine(sentence) : 'no state written' };
  }
  return { file: null, state: 'no notes yet' };
}

function featureLines(found, chars) {
  if (found.index) {
    const lines = read(found.index).split('\n').filter((l) => /^\s*[-*]\s|^\s*\|/.test(l)).map(plainLine).filter((l) => l.length > 3 && !/^[-| ]+$/.test(l));
    return fit(lines.map((l) => `  ${clip(l, 150)}`), chars);
  }
  return fit(found.folders.map((folder) => `  ${path.basename(folder).replace(/-/g, ' ')}: ${clip(featureState(folder).state, 110)}`), chars);
}

function wikiPicks(root, goal) {
  const dir = path.join(root, 'atris', 'wiki');
  const index = path.join(dir, 'index.md');
  const text = read(index);
  const links = [];
  for (const line of text.split('\n')) {
    const match = /\[\[([^\]]+\.md)\]\]|\]\(([^)]+\.md)\)|`(atris\/[^`]+\.md)`/.exec(line);
    if (!match) continue;
    const rel = (match[1] || match[2] || match[3]).replace(/^\.?\//, '');
    const file = rel.startsWith('atris/') ? path.join(root, rel) : path.join(dir, rel);
    links.push({ file, line: plainLine(line) });
  }
  const { ideaTokens } = require('./feed-core');
  const goalWords = ideaTokens(goal || '');
  const scored = links.map((link) => {
    const linkWords = ideaTokens(link.line);
    const overlap = [...linkWords].filter((w) => goalWords.has(w)).length;
    return { ...link, overlap };
  }).filter((link) => fs.existsSync(link.file));
  scored.sort((a, b) => b.overlap - a.overlap);
  return { index: fs.existsSync(index) ? index : null, links, pages: scored.slice(0, WIKI_PAGES) };
}

function wikiLines(picks, chars) {
  const lines = [];
  const half = Math.floor(chars / 2);
  lines.push(...fit(picks.links.slice(0, 14).map((l) => `  ${clip(l.line, 110)}`), half));
  for (const page of picks.pages) {
    const body = read(page.file).replace(/^---[\s\S]*?---/, '').split('\n')
      .filter((l) => l.trim() && !/^#\s/.test(l) && !/^Checked /.test(l)).map(plainLine).join(' ');
    lines.push(`  page ${path.basename(page.file, '.md').replace(/-/g, ' ')}: ${clip(body, Math.floor((chars - half) / Math.max(1, picks.pages.length)) - 40)}`);
  }
  return fit(lines, chars);
}

function taskRows(root) {
  const c = core();
  const db = c.openReadOnly();
  if (!db) return { open: [], done: [], stamp: 0 };
  try {
    const roots = c.viewRoots(root);
    const marks = roots.map(() => '?').join(', ');
    const open = db.prepare(`SELECT title, status, updated_at FROM tasks WHERE workspace_root IN (${marks})
      AND status IN ('open', 'claimed', 'review') ORDER BY updated_at DESC LIMIT 10`).all(...roots);
    const done = db.prepare(`SELECT title, status, updated_at, done_at FROM tasks WHERE workspace_root IN (${marks})
      AND status = 'done' AND COALESCE(done_at, updated_at) > ? ORDER BY COALESCE(done_at, updated_at) DESC LIMIT 6`).all(...roots, Date.now() - 7 * 86400000);
    const stamp = db.prepare(`SELECT MAX(updated_at) AS m, COUNT(*) AS n FROM tasks WHERE workspace_root IN (${marks})`).get(...roots);
    return { open, done, stamp: `${stamp.m || 0}:${stamp.n || 0}` };
  } finally {
    db.close();
  }
}

function taskLines(tasks, chars) {
  const label = { open: 'open', claimed: 'being worked on', review: 'waiting for the owner' };
  return fit([
    ...tasks.open.map((t) => `  ${label[t.status] || t.status}: ${clip(t.title, 110)}`),
    ...tasks.done.map((t) => `  finished: ${clip(t.title, 110)}`),
  ], chars);
}

function decisionLines(root, chars) {
  const c = core();
  const rows = c.ideaRows(root);
  const items = [];
  for (const row of rows) {
    for (const record of Object.values(c.obj(c.feedOf(row.metadata).decisions))) {
      if (!record || !record.choice) continue;
      const what = record.subject === 'accept' ? (record.choice === 'approve' ? 'accepted the result' : 'turned down the result')
        : record.choice === 'approve' ? 'said yes' : 'said no';
      items.push({ at: record.at || '', line: `  ${what}: ${clip(row.title, 90)}${record.note ? ` (${clip(record.note, 60)})` : ''}` });
    }
  }
  items.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return fit(items.map((i) => i.line), chars);
}

// --------------------------------------------------------------- digest

function signature(root, parts) {
  const items = [
    parts.goal,
    ...parts.journal.map((f) => `${f}:${mtime(f)}`),
    parts.features.index ? `${parts.features.index}:${mtime(parts.features.index)}` : '',
    ...parts.features.folders.map((f) => `${f}:${mtime(f)}:${mtime(featureState(f).file || f)}`),
    parts.wiki.index ? `${parts.wiki.index}:${mtime(parts.wiki.index)}` : '',
    ...parts.wiki.pages.map((p) => `${p.file}:${mtime(p.file)}`),
    parts.tasks.stamp,
  ];
  return crypto.createHash('sha1').update(items.join('\n')).digest('hex');
}

function cacheFile(root) {
  return path.join(root, '.atris', 'state', 'feed', 'digest.json');
}

// The project digest as one block of text, from the cache when nothing it
// reads has changed.
function projectDigest(root, { budget = DIGEST_TOKEN_BUDGET } = {}) {
  const c = core();
  const goal = c.themeText(root) || '';
  const parts = { goal, journal: journalFiles(root), features: featureFiles(root), wiki: wikiPicks(root, goal), tasks: taskRows(root) };
  const sig = signature(root, parts);
  let cached = null;
  try { cached = JSON.parse(fs.readFileSync(cacheFile(root), 'utf8')); } catch {}
  if (cached && cached.signature === sig && cached.budget === budget && typeof cached.text === 'string') return { text: cached.text, cached: true };
  const chars = budget * CHARS_PER_TOKEN;
  const section = (name, lines) => (lines.length ? [`${name}`, ...lines] : []);
  const text = [
    ...section('Goal:', goal ? [`  ${clip(goal, Math.floor(chars * SECTION_SHARE.goal))}`] : ['  none set yet']),
    ...section('Journal, newest day first:', journalLines(parts.journal, Math.floor(chars * SECTION_SHARE.journal))),
    ...section('Features and where each stands:', featureLines(parts.features, Math.floor(chars * SECTION_SHARE.features))),
    ...section('Wiki (index, then the pages nearest the goal):', wikiLines(parts.wiki, Math.floor(chars * SECTION_SHARE.wiki))),
    ...section('Tasks:', taskLines(parts.tasks, Math.floor(chars * SECTION_SHARE.tasks))),
    ...section('What the owner decided lately:', decisionLines(root, Math.floor(chars * SECTION_SHARE.decisions))),
  ].join('\n').slice(0, chars);
  try {
    fs.mkdirSync(path.dirname(cacheFile(root)), { recursive: true });
    const temp = `${cacheFile(root)}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ signature: sig, budget, built_at: new Date().toISOString(), text }));
    fs.renameSync(temp, cacheFile(root));
  } catch {}
  return { text, cached: false };
}

// The member's own notes and mission, kept short.
function memberBrief(root, slug, chars = 900) {
  const mission = read(path.join(root, 'atris', 'team', slug, 'MISSION.md'), 50000)
    .split('\n').filter((l) => l.trim() && !l.startsWith('---')).map(plainLine).join(' ');
  return mission ? `Your mission: ${clip(mission, chars)}` : '';
}

// --------------------------------------------------------------- notes

function notesFile(root, scope, member) {
  return scope === 'team'
    ? path.join(root, 'atris', 'lessons.md')
    : path.join(root, 'atris', 'team', member, 'lessons.md');
}

function usageFile(root) {
  return path.join(root, '.atris', 'state', 'feed', 'notes-usage.json');
}

const NOTE_LINE = /^- \[(fn-[a-f0-9]{8})\] (.+?) \(from "(.*)", (\d{4}-\d{2}-\d{2})\)$/;

function readNotesIn(file, scope, member) {
  const text = read(file, 2000000);
  const at = text.indexOf(NOTES_HEADING);
  if (at < 0) return [];
  const notes = [];
  for (const line of text.slice(at + NOTES_HEADING.length).split('\n')) {
    if (/^##\s/.test(line)) break;
    const match = NOTE_LINE.exec(line.trim());
    if (match) notes.push({ id: match[1], text: match[2], from: match[3], at: match[4], scope, member: scope === 'team' ? null : member });
  }
  return notes;
}

function writeNotesIn(file, notes) {
  const text = read(file, 2000000);
  const lines = notes.map((n) => `- [${n.id}] ${n.text} (from "${n.from}", ${n.at})`);
  const block = `${NOTES_HEADING}\n\nShort lasting notes from the owner's card conversations. Remove one with: atris feed notes forget <id>\n\n${lines.join('\n')}\n`;
  let next;
  const at = text.indexOf(NOTES_HEADING);
  if (at < 0) next = `${text}${text && !text.endsWith('\n') ? '\n' : ''}${text ? '\n' : ''}${block}`;
  else {
    const rest = text.slice(at + NOTES_HEADING.length);
    const end = rest.search(/\n##\s/);
    next = `${text.slice(0, at)}${block}${end >= 0 ? rest.slice(end + 1) : ''}`;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, next);
  fs.renameSync(temp, file);
}

function usage(root) {
  try { return JSON.parse(fs.readFileSync(usageFile(root), 'utf8')); } catch { return {}; }
}

function listNotes(root, { member = null } = {}) {
  const team = core().teamMembers(root);
  const members = member ? [member] : team;
  const used = usage(root);
  const all = [...readNotesIn(notesFile(root, 'team'), 'team', null)];
  for (const slug of members) all.push(...readNotesIn(notesFile(root, 'member', slug), 'member', slug));
  return all.map((n) => ({ ...n, uses: Number(used[n.id]) || 0 }))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)) || b.uses - a.uses);
}

// A lasting note from a conversation. Plain words, short; the oldest note
// beyond the cap is let go.
// owner: the text is the owner's own words (a setup answer), saved as said:
// only a password or key is refused, never a plain-words rule meant for
// what the team writes.
function addNote(root, { text, scope = 'member', member, from, owner = false }) {
  const c = core();
  const clean = c.oneLine(text).slice(0, NOTE_MAX_CHARS + 1);
  if (!clean) throw new c.FeedError(400, 'A note needs words.');
  if (clean.length > NOTE_MAX_CHARS) throw new c.FeedError(400, `Keep a note under ${NOTE_MAX_CHARS} characters.`);
  if (owner) {
    const words = require('./feed-plain-words');
    // The owner's own lesson: the precise check, so a document link or a commit is kept.
    if (words.holdsKey(clean)) throw new c.FeedError(400, words.SECRET_REFUSED);
  } else c.requirePlain('note', clean);
  const where = scope === 'team' ? 'team' : 'member';
  const file = notesFile(root, where, member);
  const notes = readNotesIn(file, where, member);
  if (notes.some((n) => n.text.toLowerCase() === clean.toLowerCase())) return notes.find((n) => n.text.toLowerCase() === clean.toLowerCase());
  const note = { id: `fn-${crypto.randomBytes(4).toString('hex')}`, text: clean, from: c.oneLine(from || 'a card').replace(/"/g, "'").slice(0, 80), at: new Date().toISOString().slice(0, 10), scope: where, member: where === 'team' ? null : member };
  writeNotesIn(file, [note, ...notes].slice(0, NOTES_MAX));
  return note;
}

function forgetNote(root, id) {
  const c = core();
  const files = [notesFile(root, 'team'), ...c.teamMembers(root).map((m) => notesFile(root, 'member', m))];
  for (const file of files) {
    const scope = file === notesFile(root, 'team') ? 'team' : 'member';
    const member = scope === 'team' ? null : path.basename(path.dirname(file));
    const notes = readNotesIn(file, scope, member);
    const gone = notes.find((n) => n.id === id);
    if (gone) {
      writeNotesIn(file, notes.filter((n) => n.id !== id));
      return gone;
    }
  }
  throw new c.FeedError(404, `There is no note ${id}. See them with: atris feed notes`);
}

// The notes a member works from: the team's and its own, most used and
// newest first, a few of each. Counted as used.
function notesForPrompt(root, slug) {
  const pick = (scope) => listNotes(root, { member: slug }).filter((n) => n.scope === scope)
    .sort((a, b) => b.uses - a.uses || String(b.at).localeCompare(String(a.at))).slice(0, NOTES_IN_PROMPT);
  const chosen = [...pick('team'), ...pick('member')];
  if (!chosen.length) return '';
  try {
    const used = usage(root);
    for (const note of chosen) used[note.id] = (Number(used[note.id]) || 0) + 1;
    fs.mkdirSync(path.dirname(usageFile(root)), { recursive: true });
    fs.writeFileSync(usageFile(root), JSON.stringify(used));
  } catch {}
  return ['What the owner has taught the team (follow these):', ...chosen.map((n) => `- ${n.text}${n.scope === 'team' ? '' : ' (for you)'}`)].join('\n');
}

module.exports = {
  DIGEST_TOKEN_BUDGET,
  addNote,
  forgetNote,
  listNotes,
  memberBrief,
  notesForPrompt,
  projectDigest,
};
