// Memory view — another way to look at memory updates. Reads the workspace's
// compounding memory (lessons.md, learnings.jsonl, task projection) and builds a
// content spec rendered as a beautiful HTML page by lib/html-render.
//
// Pure-ish: file reads in, a { theme, brand, slides } spec out. Anti-slop by
// construction (the renderer sanitizes, so em dashes in the raw lessons file
// never reach the page).

const fs = require('fs');
const path = require('path');

// "- **[2026-06-18] some-id** — pass — text..." -> { date, id, status, text }
function parseLessons(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^-\s*\*\*\[([^\]]+)\]\s*([^*]+?)\*\*\s*[—:-]*\s*(pass|fail)?\s*[—:-]*\s*(.*)$/i);
    if (!m) continue;
    out.push({ date: m[1].trim(), id: m[2].trim(), status: (m[3] || '').toLowerCase(), text: m[4].trim() });
  }
  return out; // append-only file: oldest first
}

function parseLearnings(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    try { const j = JSON.parse(line); out.push({ ts: j.ts, type: j.type, key: j.key, insight: j.insight }); } catch {}
  }
  return out;
}

function readFileSafe(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } }

function readTaskCounts(root) {
  try {
    const j = JSON.parse(readFileSafe(path.join(root, '.atris', 'state', 'tasks.projection.json')));
    const tasks = Array.isArray(j.tasks) ? j.tasks : [];
    const by = (s) => tasks.filter((t) => (t.status || '').toLowerCase() === s).length;
    return { total: tasks.length, done: by('done') + by('accepted'), active: by('active') + by('in_progress'), review: by('review') + by('ready') };
  } catch { return null; }
}

function gatherMemory(root = process.cwd()) {
  const lessons = parseLessons(readFileSafe(path.join(root, 'atris', 'lessons.md')));
  const learnings = parseLearnings(readFileSafe(path.join(root, 'atris', 'learnings.jsonl')));
  const tasks = readTaskCounts(root);
  return { lessons, learnings, tasks };
}

function clip(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s; }
function titleize(id) { return String(id || '').replace(/[-_]+/g, ' ').trim(); }
function plural(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }

function buildMemorySpec(root = process.cwd(), opts = {}) {
  const theme = opts.theme || 'atris';
  const brand = { name: opts.brand || 'Atris', accent: '.' };
  const { lessons, learnings, tasks } = gatherMemory(root);
  const recent = lessons.slice(-8).reverse(); // newest first

  const slides = [];
  slides.push({
    type: 'title',
    headline: 'What the workspace **learned**',
    sub: `${plural(lessons.length, 'lesson')} and ${plural(learnings.length, 'note')} compounded into memory${tasks ? `, ${plural(tasks.done, 'task')} done` : ''}.`,
  });
  slides.push({ type: 'bignumber', number: String(lessons.length), label: 'lessons compounded into the workspace' });

  if (recent.length) {
    slides.push({
      type: 'columns', heading: 'Most recent lessons',
      columns: recent.slice(0, 3).map((l) => ({ h: titleize(l.id), b: clip(l.text, 150) })),
    });
    slides.push({
      type: 'panel', heading: 'Memory updates', sub: 'Lessons and notes, newest first.',
      panel: {
        header: { title: 'Recent updates', meta: `${recent.length} shown` },
        rows: recent.map((l, i) => ({
          title: titleize(l.id), sub: l.date,
          value: l.status || 'note', sev: l.status === 'fail' ? 0 : (l.status === 'pass' ? 2 : 1),
          active: i === 0,
        })),
      },
    });
  }
  if (learnings.length) {
    slides.push({
      type: 'columns', heading: 'Notes from the field',
      columns: learnings.slice(-3).reverse().map((n) => ({ h: titleize(n.key || n.type || 'note'), b: clip(n.insight, 150) })),
    });
  }
  slides.push({ type: 'close', tagline: 'Memory lives in the filesystem, not the model.', footer: `${brand.name} workspace memory` });
  return { theme, brand, slides };
}

module.exports = { buildMemorySpec, gatherMemory, parseLessons, parseLearnings, readTaskCounts };
