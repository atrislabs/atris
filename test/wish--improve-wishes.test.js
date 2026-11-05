'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { improveWishes } = require('../commands/wish');
const { wishLessonsSummary } = require('../lib/wish-store');

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

test('separately ingests reviews sharing a timestamp, including identical repeats', (t) => {
  const f = fixture(t);
  const ts = '2026-11-05T16:00:00.000Z';
  const first = { kind: 'review', ts, wish_id: 'first', review_text: 'first' };
  const second = { kind: 'review', ts, wish_id: 'second', review_text: 'second' };
  writeEvents(f.events, [first]);
  improveWishes(f.root, { quiet: true });
  writeEvents(f.events, [first, second, second]);
  improveWishes(f.root, { quiet: true });
  const content = fs.readFileSync(f.lessons, 'utf8');
  assert.equal(content.split('\n').filter((line) => line.includes('| second |')).length, 2);
  improveWishes(f.root, { quiet: true });
  assert.equal(fs.readFileSync(f.lessons, 'utf8'), content);
});

test('legacy cursor stays untouched until a newer review establishes a boundary', (t) => {
  const f = fixture(t);
  const ts = '2026-11-05T16:00:00.000Z';
  const newer = '2026-11-05T16:00:01.000Z';
  const first = { kind: 'review', ts, wish_id: 'first', review_text: 'already handled' };
  const second = { kind: 'review', ts: newer, wish_id: 'second', review_text: 'new' };
  const third = { kind: 'review', ts: newer, wish_id: 'third', review_text: 'same time' };
  fs.writeFileSync(f.cursor, JSON.stringify({ last_ts: ts }));
  const originalCursor = fs.readFileSync(f.cursor, 'utf8');
  writeEvents(f.events, [first]);
  const originalWrite = fs.writeFileSync;
  try {
    fs.writeFileSync = (file, ...args) => {
      if (String(file) === f.cursor) throw new Error('idle cursor must not be written');
      return originalWrite.call(fs, file, ...args);
    };
    improveWishes(f.root, { quiet: true });
  } finally {
    fs.writeFileSync = originalWrite;
  }
  assert.equal(fs.existsSync(f.lessons), false);
  assert.equal(fs.readFileSync(f.cursor, 'utf8'), originalCursor);
  writeEvents(f.events, [first, second]);
  improveWishes(f.root, { quiet: true });
  writeEvents(f.events, [first, second, third]);
  improveWishes(f.root, { quiet: true });
  const content = fs.readFileSync(f.lessons, 'utf8');
  assert.doesNotMatch(content, /already handled/);
  assert.match(content, /\| second \|/);
  assert.match(content, /\| third \|/);
});

test('ingests a review into its existing inbox before a later section', (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.dirname(f.lessons), { recursive: true });
  fs.writeFileSync(f.lessons, '# Wish lessons\n\n## Review inbox (raw, distill me)\n- prior\n\n## Notes\n- preserve notes\n');
  writeEvents(f.events, [{ kind: 'review', ts: '2026-11-05T16:00:00.000Z', wish_id: 'new', review_text: 'useful' }]);
  improveWishes(f.root, { quiet: true });
  const content = fs.readFileSync(f.lessons, 'utf8');
  const review = content.indexOf('| new |');
  assert.ok(review > content.indexOf('## Review inbox (raw, distill me)'));
  assert.ok(review < content.indexOf('## Notes'));
  assert.match(content, /## Notes\n- preserve notes\n/);
  assert.equal(wishLessonsSummary(f.root).inbox, 2);
});

test('keeps fenced example headings and later sections unchanged', (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.dirname(f.lessons), { recursive: true });
  const source = '# Notes\r\n\r\n```md\r\n## Review inbox (raw, distill me)\r\n```\r\n\r\n## Review inbox (raw, distill me)\r\n- prior\r\n\r\n## Later\r\n- keep me\r\n';
  fs.writeFileSync(f.lessons, source);
  writeEvents(f.events, [{ kind: 'review', ts: '2026-11-05T16:00:00.000Z', wish_id: 'fenced', review_text: 'useful' }]);
  improveWishes(f.root, { quiet: true });
  const output = fs.readFileSync(f.lessons, 'utf8');
  assert.ok(output.includes('```md\r\n## Review inbox (raw, distill me)\r\n```'));
  assert.ok(output.indexOf('| fenced |') > output.lastIndexOf('## Review inbox (raw, distill me)'));
  assert.ok(output.indexOf('| fenced |') < output.indexOf('## Later'));
  assert.ok(output.includes('## Later\r\n- keep me\r\n'));
});

test('refuses ambiguous inbox headings without advancing the cursor', (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.dirname(f.lessons), { recursive: true });
  const original = '# Wish lessons\n\n## Review inbox (raw, distill me)\n\n## Review inbox (raw, distill me)\n';
  fs.writeFileSync(f.lessons, original);
  writeEvents(f.events, [{ kind: 'review', ts: '2026-11-05T16:00:00.000Z', wish_id: 'ambiguous' }]);
  assert.throws(() => improveWishes(f.root, { quiet: true }), /multiple wish review inbox/);
  assert.equal(fs.readFileSync(f.lessons, 'utf8'), original);
  assert.equal(fs.existsSync(f.cursor), false);
});
