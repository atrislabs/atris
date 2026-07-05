// Brain consistency contract for this repo's atris/ root (CLI-860).
// Guards the consolidation: one lesson format, doctrine folded, boot files stable.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ATRIS = path.join(__dirname, '..', 'atris');

test('exactly one lesson format: lessons.md + typed sidecar lessons.json', () => {
  assert.ok(fs.existsSync(path.join(ATRIS, 'lessons.md')), 'lessons.md must exist');
  assert.ok(fs.existsSync(path.join(ATRIS, 'lessons.json')), 'lessons.json sidecar must exist');
});

test('retired lesson/doctrine stores are folded, not left as parallel files', () => {
  // learnings.jsonl (memory jsonl) folded into lessons.md; INTUITION.md was a dead
  // init template that documented the 3-file confusion. Both removed by CLI-860.
  assert.ok(!fs.existsSync(path.join(ATRIS, 'learnings.jsonl')),
    'atris/learnings.jsonl should be folded into lessons.md, not kept as a second lesson store');
  assert.ok(!fs.existsSync(path.join(ATRIS, 'INTUITION.md')),
    'atris/INTUITION.md (unused init template) should be deleted, not kept as parallel doctrine');
});

test('the folded learnings.jsonl entry survives in lessons.md (no memory loss)', () => {
  const md = fs.readFileSync(path.join(ATRIS, 'lessons.md'), 'utf8');
  assert.match(md, /narrow-grep-hides-matches/,
    'the folded learnings.jsonl lesson must remain in lessons.md');
});

test('lessons.md and lessons.json are slug-consistent (no orphan typed sidecar entries)', () => {
  const md = fs.readFileSync(path.join(ATRIS, 'lessons.md'), 'utf8');
  const json = JSON.parse(fs.readFileSync(path.join(ATRIS, 'lessons.json'), 'utf8'));
  const mdSlugs = new Set();
  for (const line of md.split('\n')) {
    const m = line.match(/^- \*\*\[[0-9-]+\]\s+([a-z0-9-]+)\*\*/);
    if (m) mdSlugs.add(m[1]);
  }
  const orphans = Object.keys(json)
    .filter((k) => k !== '_schema')
    .filter((slug) => !mdSlugs.has(slug));
  assert.deepStrictEqual(orphans, [],
    `every typed sidecar slug needs a prose lesson line; orphans: ${orphans.join(', ')}`);
});

test('the doctrine home (thinking.md) documents the one lesson format', () => {
  const thinking = fs.readFileSync(path.join(ATRIS, 'thinking.md'), 'utf8');
  assert.match(thinking, /lessons\.md/, 'thinking.md should name the canonical lesson store');
});

test('boot files remain present and stable', () => {
  // The files brain activate/compile load on boot must survive consolidation.
  const bootFiles = [
    'atris/now.md',
    'atris/PERSONA.md',
    'atris/MAP.md',
    'atris/TODO.md',
    'atris/thinking.md',
    'atris/brain/STATUS.md',
  ];
  const root = path.join(__dirname, '..');
  for (const rel of bootFiles) {
    assert.ok(fs.existsSync(path.join(root, rel)), `boot file ${rel} must exist`);
  }
});
