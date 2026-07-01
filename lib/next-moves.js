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

function titleKey(title) {
  return norm(String(title == null ? '' : title).replace(/\s+/g, ' ').replace(/^title\s*:\s*/i, ''));
}

function isGenericInboxPlaceholder(title) {
  const key = titleKey(title);
  return /^(dogfood tick|autopilot tick|mission tick|run (one )?tick|tick)$/.test(key);
}

function cleanInboxMoveTitle(title) {
  const raw = String(title == null ? '' : title).trim();
  if (!raw) return null;
  const titleLine = raw.match(/^title\s*:\s*(.+)$/i);
  if (/^(task|status|action|tag|member|actor|proof|verify|checked|saved|changed|result|files?|commands?)\s*:/i.test(raw)) {
    return null;
  }
  const cleaned = titleLine ? titleLine[1].trim() : raw;
  if (isGenericInboxPlaceholder(cleaned)) return null;
  return cleaned;
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

const WEIGHT = { roadmap: 100, mission: 90, endgame: 80, task: 60, inbox: 40 };
const SELF_IMPROVEMENT_SEED_TITLE = 'Create the next proof-backed self-improvement task';

// One section-boundary shape for every reader and writer: tolerate a header
// suffix (e.g. "(priority)"), stop at a sibling/parent heading (## or #) or a
// malformed "##Next", but NOT at a child ### inside the section. Keeping a single
// definition is the whole point: divergent boundaries are how the gate and the
// picker drift apart.
const SECTION_TAIL = '\\b[^\\n]*\\r?\\n([\\s\\S]*?)(?=\\r?\\n##[^#]|\\r?\\n# |$)';
const OPEN_ITEMS_RE = new RegExp(`##\\s+Open loop items${SECTION_TAIL}`, 'i');
const INBOX_RE = new RegExp(`##\\s+Inbox${SECTION_TAIL}`, 'i');

// Locate a section's body and its character span, so a writer can splice an edit
// back into exactly the region a reader parsed.
function findSection(text, re) {
  const m = text.match(re);
  if (!m) return null;
  const bodyStart = m.index + m[0].length - m[1].length;
  return { body: m[1], start: bodyStart, end: bodyStart + m[1].length };
}

// Clean inbox titles out of a journal's ## Inbox section. The one inbox parser,
// shared by latestInboxItems, todayInboxItems, and the run.js work gate.
function parseInboxTitles(text) {
  const m = (text || '').match(INBOX_RE);
  if (!m) return [];
  return m[1]
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- ') && l.length > 2)
    .map((l) => l.replace(/^-\s*\*\*[IC]?\d*:?\*\*\s*/, '').replace(/^-\s*\*\*/, '').replace(/\*\*$/, '').replace(/^-\s*/, '').trim())
    .filter(Boolean);
}

function readRoadmapOpenItems(root) {
  const text = safeRead(path.join(root, 'ROADMAP.md'));
  if (!text) return [];
  const section = findSection(text, OPEN_ITEMS_RE);
  if (!section) return [];
  return section.body
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
    .filter((t) => !isInternalNextMoveTask(t))
    .map((t) => ({
      title: String(t.title).trim(),
      why: `task in flight (${t.status}${t.claimed_by ? `, ${t.claimed_by}` : ''})`,
      source: 'task',
      task_id: t.id || null,
      ref: t.display_id || t.id || null,
      weight: WEIGHT.task,
    }));
}

function isInternalNextMoveTask(task) {
  const title = String(task?.title || '').trim();
  const tags = [task?.tag, ...(Array.isArray(task?.tags) ? task.tags : [])]
    .filter(Boolean)
    .map((tag) => String(tag).toLowerCase());
  return tags.includes('agent-xp') || /^mission xp\s*:/i.test(title);
}

function readHandledTaskTitles(root) {
  const text = safeRead(path.join(root, '.atris', 'state', 'tasks.projection.json'));
  if (!text) return [];
  let proj;
  try { proj = JSON.parse(text); } catch { return []; }
  const tasks = Array.isArray(proj && proj.tasks) ? proj.tasks : [];
  return tasks
    .filter((t) => t && t.title && ['review', 'done'].includes(String(t.status || '').toLowerCase()))
    .map((t) => String(t.title).trim())
    .filter(Boolean);
}

function readJsonLines(file) {
  const text = safeRead(file);
  if (!text) return [];
  return text.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function readActiveMissions(root) {
  const rows = readJsonLines(path.join(root, '.atris', 'state', 'missions.jsonl'));
  const latest = new Map();
  for (const row of rows) {
    if (row && row.id) latest.set(row.id, row);
  }
  return Array.from(latest.values())
    .filter((m) => m && m.objective && !['complete', 'stopped', 'paused'].includes(String(m.status || '').toLowerCase()))
    .map((m) => ({
      title: String(m.objective).trim(),
      why: `active mission (${m.status || 'unknown'}${m.owner ? `, ${m.owner}` : ''})`,
      source: 'mission',
      ref: m.id || null,
      weight: m.status === 'blocked' ? WEIGHT.mission + 5 : WEIGHT.mission,
    }));
}

function activeEndgameTaskCount(root) {
  const text = safeRead(path.join(root, '.atris', 'state', 'tasks.projection.json'));
  if (!text) return 0;
  let proj;
  try { proj = JSON.parse(text); } catch { return 0; }
  const tasks = Array.isArray(proj && proj.tasks) ? proj.tasks : [];
  return tasks.filter((t) => {
    if (!t) return false;
    const status = String(t.status || '').toLowerCase();
    const tags = [t.tag, ...(Array.isArray(t.tags) ? t.tags : [])].filter(Boolean).map((tag) => String(tag).toLowerCase());
    return tags.includes('endgame') && ['open', 'claimed', 'review'].includes(status);
  }).length;
}

function todoKeepsEndgameActive(root) {
  const text = safeRead(path.join(root, 'atris', 'TODO.md'));
  if (!text) return true;
  if (activeEndgameTaskCount(root) > 0) return true;

  let sawEndgameHeader = false;
  let section = '';
  for (const raw of text.split(/\r?\n/)) {
    const heading = raw.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      section = heading[1].trim().toLowerCase();
      if (section === 'endgame') sawEndgameHeader = true;
      continue;
    }
    if (!/\[endgame\]/i.test(raw)) continue;
    if (['backlog', 'in progress', 'review'].includes(section)) return true;
  }
  return !sawEndgameHeader;
}

function readEndgameMove(root) {
  if (!todoKeepsEndgameActive(root)) return [];
  let state = null;
  try { state = JSON.parse(safeRead(path.join(root, 'atris', 'brain', 'state.json'))); } catch { state = null; }
  const horizon = String(state?.endgame?.horizon || '').trim();
  if (!horizon) return [];
  return [{
    title: horizon,
    why: state?.endgame?.source ? `endgame: ${state.endgame.source}` : 'endgame horizon from compiled brain',
    source: 'endgame',
    weight: WEIGHT.endgame,
  }];
}

function inboxItemsFrom(text) {
  return parseInboxTitles(text)
    .map(cleanInboxMoveTitle)
    .filter(Boolean)
    .map((title) => ({ title, why: 'fresh idea in today\'s inbox', source: 'inbox', weight: WEIGHT.inbox }));
}

// Most recent journal under atris/logs/YYYY/, parsed for ## Inbox items. Used to
// SURFACE ideas in `atris moves`.
function latestInboxItems(root) {
  const logsDir = path.join(root, 'atris', 'logs');
  let years;
  try { years = fs.readdirSync(logsDir).filter((d) => /^\d{4}$/.test(d)).sort(); } catch { return []; }
  if (!years.length) return [];
  const yearDir = path.join(logsDir, years[years.length - 1]);
  let files;
  try { files = fs.readdirSync(yearDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort(); } catch { return []; }
  if (!files.length) return [];
  return inboxItemsFrom(safeRead(path.join(yearDir, files[files.length - 1])));
}

// TODAY's journal inbox only. The loop's work gate and the seed-suppression must
// read the SAME file the seeder writes (today's), or a prior-day duplicate makes
// them disagree. Returns [] if today's file is absent.
function todayInboxItems(root) {
  const { file } = todayLogFile(root);
  if (!fs.existsSync(file)) return [];
  return inboxItemsFrom(safeRead(file));
}

function gatherCandidates(root = process.cwd()) {
  return [
    ...readRoadmapOpenItems(root),
    ...readActiveMissions(root),
    ...readEndgameMove(root),
    ...readActiveTasks(root),
    ...latestInboxItems(root),
  ];
}

// Pure ranking: drop killed/approved, sort by weight, then dedupe by title
// (keeping the highest-weight copy), take `limit`.
//
// Suppression: the exact move the operator acted on is dropped by id. Titles are
// only suppressed for IDEAS (roadmap/inbox), never for a real `task`, so killing
// or approving an idea can't hide a genuine in-flight task that happens to share
// the title.
function pickNextMoves(candidates, {
  limit = 3,
  killedIds = [],
  killedTitles = [],
  approvedIds = [],
  approvedTitles = [],
  handledTaskTitles = [],
} = {}) {
  const blockedIds = new Set([...killedIds, ...approvedIds]);
  const blockedTitles = new Set([...killedTitles, ...approvedTitles].map(titleKey));
  const handledTitles = new Set(handledTaskTitles.map(titleKey));
  const seen = new Set();
  return candidates
    .map((c) => ({ ...c, id: moveId(c.source, c.title), _key: titleKey(c.title) }))
    .filter((c) => {
      if (!c._key) return false;
      if (blockedIds.has(c.id)) return false;
      if (c.source !== 'task' && blockedTitles.has(c._key)) return false;
      if (c.source !== 'task' && handledTitles.has(c._key)) return false;
      return true;
    })
    .sort((a, b) => (b.weight || 0) - (a.weight || 0))
    .filter((c) => {
      if (seen.has(c._key)) return false;
      seen.add(c._key);
      return true;
    })
    .map(({ _key, ...c }) => c)
    .slice(0, limit);
}

function cleanSuggestedTargetTitle(text) {
  const clean = String(text || '')
    .replace(/[`*_#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?:;,]+$/g, '');
  if (!clean) return '';
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

function suggestedTargetFromReportText(text) {
  const lines = String(text || '').split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = lines[index].match(/^\s*Suggested target:\s*(.+?)\s*$/i);
    if (match) return cleanSuggestedTargetTitle(match[1]);
  }
  return '';
}

function latestSuggestedTarget(root = process.cwd()) {
  const reportsDir = path.join(root, 'atris', 'reports');
  let files;
  try {
    files = fs.readdirSync(reportsDir).filter((file) => /\.md$/i.test(file)).sort().reverse();
  } catch {
    return '';
  }
  for (const file of files) {
    const target = suggestedTargetFromReportText(safeRead(path.join(reportsDir, file)));
    if (target) return target;
  }
  return '';
}

function addMissionOnlyFallback(moves, limit = 3, root = process.cwd()) {
  if (!Array.isArray(moves) || moves.length !== 1 || limit <= 1) return moves;
  const mission = moves[0];
  if (!mission || mission.source !== 'mission') return moves;
  const target = latestSuggestedTarget(root) || SELF_IMPROVEMENT_SEED_TITLE;
  return [
    mission,
    {
      title: target,
      why: target === SELF_IMPROVEMENT_SEED_TITLE
        ? 'active mission has no concrete task queued'
        : 'latest proof timeline suggested this self-improvement target',
      source: 'mission',
      ref: mission.ref || null,
      weight: WEIGHT.mission - 35,
      id: moveId('mission', target),
    },
  ].slice(0, limit);
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
  const idsFor = (decision) => rows.filter((r) => r.decision === decision).map((r) => r.id);
  const titlesFor = (decision) => rows.filter((r) => r.decision === decision).map((r) => norm(r.title));
  return {
    killedIds: idsFor('kill'),
    killedTitles: titlesFor('kill'),
    approvedIds: idsFor('approve'),
    approvedTitles: titlesFor('approve'),
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
// Idempotent by title: if the same title is already in today's inbox, it is not
// appended again (so a retry or a concurrent cycle cannot duplicate it).
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
  const target = norm(move.title);
  if (parseInboxTitles(content).some((t) => norm(t) === target)) {
    return { file, line: null, nextId: null, alreadyPresent: true };
  }
  const existingIds = (content.match(/-\s*\*\*I(\d+):/g) || []).map((m2) => parseInt(m2.match(/I(\d+)/)[1], 10));
  const nextId = existingIds.length ? Math.max(...existingIds) + 1 : 1;
  const line = `- **I${nextId}:** ${move.title}`;
  // Insert right after the Inbox header line only (do not consume blank lines or
  // following sections). Use a function replacer so a title containing $ tokens
  // ($1, $&, $$) is inserted literally, not interpreted as a replacement pattern.
  content = content.replace(/(##\s+Inbox[^\n]*\r?\n)/i, (m) => `${m}${line}\n`);
  fs.writeFileSync(file, content, 'utf8');
  return { file, line, nextId };
}

// Claim an open ROADMAP item for the loop by flipping its `- [ ]` to `- [~]`
// (claimed, in flight) WITHIN the "## Open loop items" section only. This is the
// single source of truth for "the loop took this on": readRoadmapOpenItems only
// returns `- [ ]`, so a claimed item is excluded, and the work gate and the seed
// picker stay in agreement. Scoped to the section so a same-titled `- [ ]` in
// another section (Big jobs, an example block) is never flipped by mistake.
// `- [~]` is distinct from human `- [x]` (done) so a reader is not misled.
function claimRoadmapItem(root, title) {
  const p = path.join(root, 'ROADMAP.md');
  const text = safeRead(p);
  if (!text) return false;
  const section = findSection(text, OPEN_ITEMS_RE);
  if (!section) return false;
  const target = norm(title);
  let changed = false;
  const newBody = section.body.split(/\r?\n/).map((line) => {
    if (changed) return line;
    const m = line.match(/^(\s*)- \[ \]\s*(.+?)\s*$/);
    if (m && norm(m[2]) === target) {
      changed = true;
      return `${m[1]}- [~] ${m[2].trim()}`;
    }
    return line;
  }).join('\n');
  if (!changed) return false;
  const out = text.slice(0, section.start) + newBody + text.slice(section.end);
  fs.writeFileSync(p, out, 'utf8');
  return true;
}

// Add one bounded item to the "## Open loop items" section so the loop (and
// `atris moves`) will pursue it: messy input straight into the working queue,
// no markdown editing. Creates ROADMAP.md and the section if missing. Dedups
// against existing OPEN items only (a done/claimed one can be re-added).
function addRoadmapItem(root, text) {
  // Collapse any whitespace/newlines to single spaces (a multi-line title would
  // break the markdown line) and strip a leading bullet/checkbox the user may
  // have pasted, so the item is exactly one well-formed `- [ ]` line.
  const title = String(text || '').replace(/\s+/g, ' ').trim().replace(/^- \[[ x~]\]\s*/, '').replace(/^- /, '').trim();
  if (!title) return { added: false, reason: 'empty', title: null };
  const p = path.join(root, 'ROADMAP.md');
  let content = safeRead(p);
  if (!content) content = '# Roadmap\n\n## Open loop items\n\n';
  let section = findSection(content, OPEN_ITEMS_RE);
  if (!section) {
    if (!content.endsWith('\n')) content += '\n';
    content += '\n## Open loop items\n\n';
    section = findSection(content, OPEN_ITEMS_RE);
  }
  const openTitles = section.body.split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^- \[ \]/.test(l))
    .map((l) => norm(l.replace(/^- \[ \]\s*/, '')));
  if (openTitles.includes(norm(title))) return { added: false, reason: 'already an open item', title };
  // Insert at the top of the section body so the loop pulls it next.
  const out = `${content.slice(0, section.start)}\n- [ ] ${title}\n${content.slice(section.start)}`;
  fs.writeFileSync(p, out, 'utf8');
  return { added: true, title };
}

// Group the Open loop items by state: queued `- [ ]`, in-flight `- [~]` (claimed
// by the loop), done `- [x]`. The evidence for a loop report.
function roadmapItemsByState(root) {
  const out = { open: [], claimed: [], done: [] };
  const text = safeRead(path.join(root, 'ROADMAP.md'));
  if (!text) return out;
  const section = findSection(text, OPEN_ITEMS_RE);
  if (!section) return out;
  for (const raw of section.body.split(/\r?\n/)) {
    const l = raw.trim();
    let m;
    if ((m = l.match(/^- \[ \]\s*(.+)$/))) out.open.push(m[1].trim());
    else if ((m = l.match(/^- \[~\]\s*(.+)$/))) out.claimed.push(m[1].trim());
    else if ((m = l.match(/^- \[x\]\s*(.+)$/))) out.done.push(m[1].trim());
  }
  return out;
}

// The top open ROADMAP item the loop has not already handled. Claimed items are
// marked `- [~]` (so readRoadmapOpenItems drops them); this also skips anything
// already in TODAY's inbox or killed/approved, so an idle loop advances to the
// next item each cycle. todayInboxItems (not latestInboxItems) so the picker, the
// work gate, and the seeder all read the same file. Root-explicit and pure of
// cwd, so it is testable without a live runner.
function pickRoadmapSeed(root = process.cwd()) {
  const items = readRoadmapOpenItems(root);
  if (!items.length) return null;
  const inbox = todayInboxItems(root).map((i) => norm(i.title));
  const { killedTitles, approvedTitles } = readDecisions(root);
  const blocked = new Set([...inbox, ...killedTitles, ...approvedTitles]);
  return items.find((it) => !blocked.has(norm(it.title))) || null;
}

// Shared "3 next moves" recipe used by both `atris moves` and `atris activate`,
// so the ranking inputs live in one place.
function nextMoves(root = process.cwd(), limit = 3) {
  const { killedIds, killedTitles, approvedIds, approvedTitles } = readDecisions(root);
  const handledTaskTitles = readHandledTaskTitles(root);
  const picked = pickNextMoves(gatherCandidates(root), { limit, killedIds, killedTitles, approvedIds, approvedTitles, handledTaskTitles });
  return addMissionOnlyFallback(picked, limit, root);
}

module.exports = {
  moveId,
  norm,
  titleKey,
  isGenericInboxPlaceholder,
  WEIGHT,
  SELF_IMPROVEMENT_SEED_TITLE,
  cleanSuggestedTargetTitle,
  suggestedTargetFromReportText,
  latestSuggestedTarget,
  parseInboxTitles,
  cleanInboxMoveTitle,
  readRoadmapOpenItems,
  readActiveMissions,
  readEndgameMove,
  readActiveTasks,
  isInternalNextMoveTask,
  readHandledTaskTitles,
  latestInboxItems,
  todayInboxItems,
  gatherCandidates,
  pickNextMoves,
  addMissionOnlyFallback,
  nextMoves,
  readDecisions,
  recordDecision,
  seedInboxFromMove,
  pickRoadmapSeed,
  claimRoadmapItem,
  addRoadmapItem,
  roadmapItemsByState,
  todayLogFile,
};
