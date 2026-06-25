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
  const section = text.match(/##\s+Open loop items\s*\r?\n([\s\S]*?)(?=\r?\n##\s|$)/i);
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
  const inbox = text.match(/##\s+Inbox\s*\r?\n([\s\S]*?)(?=\r?\n##\s|$)/i);
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

// Pure ranking: dedupe by title, drop killed, sort by weight, take `limit`.
function pickNextMoves(candidates, { limit = 3, killedIds = [] } = {}) {
  const killed = new Set(killedIds);
  const seen = new Set();
  return candidates
    .map((c) => ({ ...c, id: moveId(c.source, c.title) }))
    .filter((c) => !killed.has(c.id))
    .filter((c) => {
      const k = c.title.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => (b.weight || 0) - (a.weight || 0))
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
  const killedIds = rows.filter((r) => r.decision === 'kill').map((r) => r.id);
  const approvedIds = rows.filter((r) => r.decision === 'approve').map((r) => r.id);
  return { killedIds, approvedIds, rows };
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

// Seed an approved move into today's inbox so the loop's hasWork() finds it.
function seedInboxFromMove(root, move, date) {
  const { file, dateFormatted } = todayLogFile(root, date);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let content = safeRead(file);
  if (!content) {
    content = `# ${dateFormatted}\n\n## Inbox\n\n## Notes\n`;
  }
  if (!/##\s+Inbox/i.test(content)) {
    content = content.replace(/^(#.*\n)/, `$1\n## Inbox\n`);
    if (!/##\s+Inbox/i.test(content)) content += `\n## Inbox\n`;
  }
  const existingIds = (content.match(/-\s*\*\*I(\d+):/g) || []).map((m2) => parseInt(m2.match(/I(\d+)/)[1], 10));
  const nextId = existingIds.length ? Math.max(...existingIds) + 1 : 1;
  const line = `- **I${nextId}:** ${move.title}`;
  content = content.replace(/(##\s+Inbox\s*\r?\n)/i, `$1${line}\n`);
  fs.writeFileSync(file, content, 'utf8');
  return { file, line, nextId };
}

// The top open ROADMAP item not already sitting in the inbox. The loop calls
// this when it is otherwise idle, so an unattended run pursues the goal in
// ROADMAP.md instead of stopping. Root-explicit and pure of cwd, so it is
// testable without a live runner.
function pickRoadmapSeed(root = process.cwd()) {
  const items = readRoadmapOpenItems(root);
  if (!items.length) return null;
  const inboxTitles = latestInboxItems(root).map((i) => i.title);
  return items.find((it) => !inboxTitles.includes(it.title)) || null;
}

module.exports = {
  moveId,
  WEIGHT,
  readRoadmapOpenItems,
  readActiveTasks,
  latestInboxItems,
  gatherCandidates,
  pickNextMoves,
  readDecisions,
  recordDecision,
  seedInboxFromMove,
  pickRoadmapSeed,
  todayLogFile,
};
