'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { improveWishes } = require('../commands/wish');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wish-improve-direct-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const state = path.join(root, '.atris', 'state');
  fs.mkdirSync(state, { recursive: true });
  return {
    root,
    events: path.join(state, 'wishes.jsonl'),
    cursor: path.join(state, 'wish-improve.cursor.json'),
    lessons: path.join(root, '.claude', 'skills', 'wish', 'LESSONS.md'),
  };
}

function writeEvents(file, events) {
  fs.writeFileSync(file, events.map((event) => JSON.stringify(event)).join('\n') + '\n');
}

test('improveWishes ingests reviews in date order and does not ingest them twice', (t) => {
  const f = fixture(t);
  writeEvents(f.events, [
    { kind: 'review', ts: '2024-03-02T12:00:00Z', wish_id: 'second', review_score: -1, review_text: '  Be clearer.  ', reviewed_by: 'sam' },
    { kind: 'capture', ts: '2024-03-03T12:00:00Z', id: 'ignored', text: 'not a review' },
    { kind: 'review', ts: '2024-03-01T12:00:00Z', wish_id: 'first', review_score: 1, review_text: 'Keep this.', reviewed_by: 'lee' },
  ]);

  assert.strictEqual(improveWishes(f.root, { quiet: true }), 0);
  const content = fs.readFileSync(f.lessons, 'utf8');
  assert.ok(content.startsWith('# Wish lessons\n'));
  assert.ok(content.includes('## Review inbox (raw, distill me)\n'));
  assert.deepStrictEqual(content.split('\n').filter((line) => line.startsWith('- ')), [
    '- 2024-03-01T12:00:00Z | first | score 1 | Keep this. (by lee)',
    '- 2024-03-02T12:00:00Z | second | score -1 | Be clearer. (by sam)',
  ]);
  assert.strictEqual(JSON.parse(fs.readFileSync(f.cursor, 'utf8')).last_ts, '2024-03-02T12:00:00Z');
  const cursor = fs.readFileSync(f.cursor, 'utf8');
  assert.strictEqual(improveWishes(f.root, { quiet: true }), 0);
  assert.strictEqual(fs.readFileSync(f.lessons, 'utf8'), content);
  assert.strictEqual(fs.readFileSync(f.cursor, 'utf8'), cursor);
});

test('improveWishes respects the cursor and supplies defaults for missing review fields', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.cursor, JSON.stringify({ last_ts: '2024-03-01T12:00:00Z' }));
  fs.mkdirSync(path.dirname(f.lessons), { recursive: true });
  fs.writeFileSync(f.lessons, '# Existing notes\n\n## Lessons\n- Keep answers short.\n');
  writeEvents(f.events, [
    { kind: 'review', ts: '2024-02-29T12:00:00Z', review_text: 'too old' },
    { kind: 'review', ts: '2024-03-01T12:00:00Z', review_text: 'already ingested' },
    { kind: 'review', review_text: 'no timestamp' },
    { kind: 'review', ts: '2024-03-02T12:00:00Z' },
  ]);

  assert.strictEqual(improveWishes(f.root, { quiet: true }), 0);
  assert.strictEqual(fs.readFileSync(f.lessons, 'utf8'),
    '# Existing notes\n\n## Lessons\n- Keep answers short.\n\n## Review inbox (raw, distill me)\n' +
    '- 2024-03-02T12:00:00Z | unknown-wish | score none |  (by unknown)\n');
  assert.strictEqual(JSON.parse(fs.readFileSync(f.cursor, 'utf8')).last_ts, '2024-03-02T12:00:00Z');
});

test('improveWishes leaves empty or malformed event input without generated files', (t) => {
  const f = fixture(t);
  assert.strictEqual(improveWishes(f.root, { quiet: true }), 0);
  assert.strictEqual(fs.existsSync(f.lessons), false);
  assert.strictEqual(fs.existsSync(f.cursor), false);

  fs.writeFileSync(f.events, '\nnot json\nnull\n');
  fs.writeFileSync(f.cursor, 'invalid cursor json');
  assert.strictEqual(improveWishes(f.root, { quiet: true }), 0);
  assert.strictEqual(fs.existsSync(f.lessons), false);
  assert.strictEqual(fs.readFileSync(f.cursor, 'utf8'), 'invalid cursor json');
});
