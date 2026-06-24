const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildMemorySpec, parseLessons, parseLearnings } = require('../lib/memory-view');
const { renderHtml } = require('../lib/html-render');
const { scanFile } = require('../commands/slop');

function mkWorkspace(lessonsMd, learningsJsonl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-'));
  fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
  if (lessonsMd != null) fs.writeFileSync(path.join(dir, 'atris', 'lessons.md'), lessonsMd);
  if (learningsJsonl != null) fs.writeFileSync(path.join(dir, 'atris', 'learnings.jsonl'), learningsJsonl);
  return dir;
}

test('parseLessons reads the lessons.md line format (date, id, status, text)', () => {
  const ls = parseLessons('- **[2026-06-18] git-first-check** — pass — verify with git diff before git log.\nnoise\n');
  assert.equal(ls.length, 1);
  assert.equal(ls[0].date, '2026-06-18');
  assert.equal(ls[0].id, 'git-first-check');
  assert.equal(ls[0].status, 'pass');
  assert.match(ls[0].text, /git diff/);
});

test('parseLearnings reads JSONL notes', () => {
  const ns = parseLearnings('{"ts":"t","type":"pitfall","key":"narrow-grep","insight":"grep wide"}\n\n');
  assert.equal(ns.length, 1);
  assert.equal(ns[0].key, 'narrow-grep');
});

test('buildMemorySpec turns memory into a renderable, slop-clean page', () => {
  const lessons = Array.from({ length: 5 }, (_, i) =>
    `- **[2026-06-1${i}] lesson-${i}-thing** — ${i % 2 ? 'fail' : 'pass'} — something we learned number ${i} about the loop.`).join('\n');
  const dir = mkWorkspace(lessons + '\n', '{"ts":"t","type":"note","key":"k","insight":"a field note"}\n');
  const spec = buildMemorySpec(dir);
  assert.equal(spec.theme, 'atris');
  assert.ok(spec.slides.some((s) => s.type === 'bignumber'));
  assert.ok(spec.slides.some((s) => s.type === 'panel'));
  // renders and passes the slop gate
  const out = path.join(dir, 'mem.html');
  fs.writeFileSync(out, renderHtml(spec));
  assert.equal(scanFile(out).length, 0);
});

test('em dashes in the raw lessons file never reach the rendered page', () => {
  const dir = mkWorkspace('- **[2026-06-18] x-thing** — pass — a — b — c with dashes everywhere.\n');
  const html = renderHtml(buildMemorySpec(dir));
  assert.ok(!html.includes('—'), 'renderer sanitizes the source');
});

test('missing/empty memory still yields a usable spec', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-empty-'));
  const spec = buildMemorySpec(dir);
  assert.ok(spec.slides.length >= 2);
  assert.ok(spec.slides[0].type === 'title');
});
