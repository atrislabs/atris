'use strict';

// Alive onboarding: the engine behind `atris moves`.
//
// It reads the workspace for the highest-leverage next moves (the goal in
// ROADMAP.md, work already in flight, fresh inbox ideas), ranks them, and lets
// the human approve, kill, or skip. Approved moves are seeded into today's
// inbox, which the loop's hasWork() already reads, so onboarding feeds the
// loop without touching the autonomous core.

const fs = require('fs');
const path = require('path');

function safeRead(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

// Normalize a title for dedup and suppression, the same way moveId does, so a
// move matches itself across case and whitespace.
function norm(title) {
  return String(title == null ? '' : title).trim().toLowerCase();
}

// Short, stable id so a kill on Tuesday still suppresses the same move on
// Wednesday. Pure function of (source, title).
function moveId(source, title) {
  const s = `${source}:${String(title).trim().toLowerCase()}`;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `m_${(h >>> 0).toString(36)}`;
}

const WEIGHT = { roadmap: 100, task: 60, inbox: 40 };

function readRoadmapOpenItems(root) {
  const text = safeRead(path.join(root, 'ROADMAP.md'));
  if (!text) return [];
  // Tolerate a header suffix (e.g. "(priority)") and stop at any next heading,
  // including a malformed "##Next" with no space after the hashes.
  const section = text.match(/##\s+Open loop items\b[^\n]*\r?\n([\s\S]*?)(?=\r?\n#{2,}|$)/i);
  if (!section) return [];
  return section[1]
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^- \[ \]/.test(l))
    .map((l) => l.replace(/^- \[ \]\s*/, '').trim())
    .filter(Boolean)
    .map((title) => ({
      title,
      why: 'open item in ROADMAP.md, the goal the loop pursues',
      source: 'roadmap',
      weight: WEIGHT.roadmap,
    }));
}

function readActiveTasks(root) {
  const text = safeRead(path.join(root, '.atris', 'state', 'tasks.projection.json'));
  if (!text) return [];
  let proj;
  try { proj = JSON.parse(text); } catch { return []; }
  const tasks = Array.isArray(proj && proj.tasks) ? proj.tasks : [];
  return tasks
    .filter((t) => t && t.title && ['open', 'claimed'].includes(String(t.status || '').toLowerCase()))
    .map((t) => ({
      title: String(t.title).trim(),
      why: `task in flight (${t.status}${t.claimed_by ? `, ${t.claimed_by}` : ''})`,
      source: 'task',
      ref: t.display_id || t.id || null,
      weight: WEIGHT.task,
    }));
}

// Most recent journal under atris/logs/YYYY/, parsed for ## Inbox items.
function latestInboxItems(root) {
  const logsDir = path.join(root, 'atris', 'logs');
  let years;
  try { years = fs.readdirSync(logsDir).filter((d) => /^\d{4}$/.test(d)).sort(); } catch { return []; }
  if (!years.length) return [];
  const yearDir = path.join(logsDir, years[years.length - 1]);
  let files;
  try { files = fs.readdirSync(yearDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort(); } catch { return []; }
  if (!files.length) return [];
  const text = safeRead(path.join(yearDir, files[files.length - 1]));
  const inbox = text.match(/##\s+Inbox\b[^\n]*\r?\n([\s\S]*?)(?=\r?\n#{2,}|$)/i);
  if (!inbox) return [];
  return inbox[1]
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- '))
    .map((l) => l.replace(/^-\s*\*\*[IC]?\d*:?\*\*\s*/, '').replace(/^-\s*\*\*/, '').replace(/\*\*$/, '').replace(/^-\s*/, '').trim())
    .filter(Boolean)
    .map((title) => ({ title, why: 'fresh idea in today\'s inbox', source: 'inbox', weight: WEIGHT.inbox }));
}

function gatherCandidates(root = process.cwd()) {
  return [
    ...readRoadmapOpenItems(root),
    ...readActiveTasks(root),
    ...latestInboxItems(root),
  ];
}

// Pure ranking: drop killed/approved, sort by weight, then dedupe by title
// (keeping the highest-weight copy), take `limit`. Killed and approved moves
// are suppressed by normalized title so the same title can't slip back in from
// a lower-weight source.
function pickNextMoves(candidates, { limit = 3, killedIds = [], killedTitles = [], approvedTitles = [] } = {}) {
  const killedIdSet = new Set(killedIds);
  const blockedTitles = new Set([...killedTitles, ...approvedTitles].map(norm));
  const seen = new Set();
  return candidates
    .map((c) => ({ ...c, id: moveId(c.source, c.title), _key: norm(c.title) }))
    .filter((c) => c._key && !killedIdSet.has(c.id) && !blockedTitles.has(c._key))
    .sort((a, b) => (b.weight || 0) - (a.weight || 0))
    .filter((c) => {
      if (seen.has(c._key)) return false;
      seen.add(c._key);
      return true;
    })
    .map(({ _key, ...c }) => c)
    .slice(0, limit);
}

const DECISIONS_FILE = ['.atris', 'state', 'moves.decisions.jsonl'];

function decisionsPath(root) {
  return path.join(root, ...DECISIONS_FILE);
}

function readDecisions(root = process.cwd()) {
  const text = safeRead(decisionsPath(root));
  const rows = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
  const titlesFor = (decision) => rows.filter((r) => r.decision === decision).map((r) => norm(r.title));
  return {
    killedIds: rows.filter((r) => r.decision === 'kill').map((r) => r.id),
    killedTitles: titlesFor('kill'),
    approvedTitles: titlesFor('approve'),
    seededTitles: titlesFor('seeded'),
  };
}

function recordDecision(root, move, decision, stamp) {
  const p = decisionsPath(root);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const row = { id: move.id, title: move.title, source: move.source, decision, at: stamp || null };
  fs.appendFileSync(p, `${JSON.stringify(row)}\n`, 'utf8');
  return row;
}

function todayLogFile(root, date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const dateFormatted = `${y}-${m}-${d}`;
  return { file: path.join(root, 'atris', 'logs', String(y), `${dateFormatted}.md`), dateFormatted };
}

// The canonical day-journal sections every reader expects (status, analytics,
// section parsers). Mirrors lib/journal.js createLogFile, minus the em dash in
// its title, so a journal first created by the idle-seed path is not malformed.
function canonicalJournal(dateFormatted) {
  return `# Log ${dateFormatted}\n\n## Handoff\n\n---\n\n## Completed ✅\n\n---\n\n## In Progress 🔄\n\n---\n\n## Backlog\n\n---\n\n## Notes\n\n---\n\n## Inbox\n\n`;
}

// Seed an approved move into today's inbox so the loop's hasWork() finds it.
function seedInboxFromMove(root, move, date) {
  const { file, dateFormatted } = todayLogFile(root, date);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let content = safeRead(file);
  if (!content) {
    content = canonicalJournal(dateFormatted);
  }
  if (!/##\s+Inbox/i.test(content)) {
    content = content.replace(/^(#.*\n)/, `$1\n## Inbox\n`);
    if (!/##\s+Inbox/i.test(content)) content += `\n## Inbox\n`;
  }
  const existingIds = (content.match(/-\s*\*\*I(\d+):/g) || []).map((m2) => parseInt(m2.match(/I(\d+)/)[1], 10));
  const nextId = existingIds.length ? Math.max(...existingIds) + 1 : 1;
  const line = `- **I${nextId}:** ${move.title}`;
  // Insert right after the Inbox header line only (do not consume blank lines
  // or following sections).
  content = content.replace(/(##\s+Inbox[^\n]*\r?\n)/i, `$1${line}\n`);
  fs.writeFileSync(file, content, 'utf8');
  return { file, line, nextId };
}

// The top open ROADMAP item the loop has not already handled. It skips items
// already in the inbox AND items previously seeded (recorded in the decisions
// ledger) or killed, so an idle loop advances to the next item each cycle
// instead of re-pulling the same one forever. Root-explicit and pure of cwd,
// so it is testable without a live runner.
function pickRoadmapSeed(root = process.cwd()) {
  const items = readRoadmapOpenItems(root);
  if (!items.length) return null;
  const inbox = latestInboxItems(root).map((i) => norm(i.title));
  const { seededTitles, killedTitles } = readDecisions(root);
  const blocked = new Set([...inbox, ...seededTitles, ...killedTitles]);
  return items.find((it) => !blocked.has(norm(it.title))) || null;
}

// Shared "3 next moves" recipe used by both `atris moves` and `atris activate`,
// so the ranking inputs live in one place.
function nextMoves(root = process.cwd(), limit = 3) {
  const { killedIds, killedTitles, approvedTitles } = readDecisions(root);
  return pickNextMoves(gatherCandidates(root), { limit, killedIds, killedTitles, approvedTitles });
}

module.exports = {
  moveId,
  norm,
  WEIGHT,
  readRoadmapOpenItems,
  readActiveTasks,
  latestInboxItems,
  gatherCandidates,
  pickNextMoves,
  nextMoves,
  readDecisions,
  recordDecision,
  seedInboxFromMove,
  pickRoadmapSeed,
  todayLogFile,
};
