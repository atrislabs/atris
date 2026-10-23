const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const autoLessons = require('../lib/auto-lessons');

const { fileAutoLessons, lessonSlug, TASK_EPISODES_FILE, TYPED_LESSONS_FILE } = autoLessons;

const roots = [];

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-auto-lessons-lib-'));
  roots.push(root);
  return root;
}

test.after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function revision(id, taskId, note, overrides = {}) {
  return {
    episode_id: id,
    task_id: taskId,
    created_at: '2026-10-20T12:00:00.000Z',
    action: { event_type: 'revision_requested' },
    human_feedback: { human_revision_note: note },
    rl: { label: 'rework_requested' },
    ...overrides,
  };
}

function lessonsPath(root) {
  return path.join(root, TYPED_LESSONS_FILE);
}

function readLessons(root) {
  return JSON.parse(fs.readFileSync(lessonsPath(root), 'utf8'));
}

function writeLessons(root, value) {
  fs.mkdirSync(path.dirname(lessonsPath(root)), { recursive: true });
  fs.writeFileSync(lessonsPath(root), typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
}

test('exports the two file paths and the two functions', () => {
  assert.deepStrictEqual(Object.keys(autoLessons).sort(), [
    'TASK_EPISODES_FILE',
    'TYPED_LESSONS_FILE',
    'fileAutoLessons',
    'lessonSlug',
  ]);
  assert.strictEqual(TASK_EPISODES_FILE, path.join('.atris', 'state', 'task_episodes.jsonl'));
  assert.strictEqual(TYPED_LESSONS_FILE, path.join('atris', 'lessons.json'));
});

test('lessonSlug lowercases, hyphenates, and drops trailing punctuation', () => {
  assert.strictEqual(lessonSlug('Use plain words!'), 'use-plain-words');
  assert.strictEqual(lessonSlug('  Use   PLAIN\twords...  '), 'use-plain-words');
  assert.strictEqual(lessonSlug('Show the file:line, not the summary?'), 'show-the-file-line-not-the-summary');
});

test('lessonSlug folds accents and full-width characters', () => {
  assert.strictEqual(lessonSlug('Café résumé'), 'cafe-resume');
  assert.strictEqual(lessonSlug('ＵＳＥ plain words'), 'use-plain-words');
});

test('lessonSlug shortens long corrections to 80 characters with a stable hash suffix', () => {
  const long = 'Always include the exact file path when reporting a failing test so the reviewer can reopen it quickly without searching';
  const slug = lessonSlug(long);

  assert.ok(slug.length <= 80, `slug is ${slug.length} characters`);
  assert.match(slug, /^always-include-the-exact-file-path-when-reporting-a-failing-test-so-the-[0-9a-f]{8}$/);
  assert.strictEqual(slug, lessonSlug(`${long}.`));
  assert.strictEqual(slug, lessonSlug(long.toUpperCase()));

  const sibling = lessonSlug(`${long} twice`);
  assert.notStrictEqual(sibling, slug);
  assert.ok(sibling.length <= 80);
});

test('lessonSlug falls back to a hashed name when nothing alphanumeric is left', () => {
  const empty = lessonSlug('');
  const symbols = lessonSlug('@@@');
  const other = lessonSlug('###');

  assert.match(empty, /^correction-[0-9a-f]{12}$/);
  assert.match(symbols, /^correction-[0-9a-f]{12}$/);
  assert.strictEqual(lessonSlug(null), empty);
  assert.strictEqual(lessonSlug('!!!'), empty);
  assert.notStrictEqual(symbols, other);
  assert.notStrictEqual(symbols, empty);
});

test('fileAutoLessons does nothing and writes nothing when there are no repeats', () => {
  const root = makeRoot();

  assert.deepStrictEqual(fileAutoLessons(root), { added: [], detected: [] });
  assert.strictEqual(fs.existsSync(lessonsPath(root)), false);

  const once = fileAutoLessons(root, {
    episodes: [revision('e1', 'task-1', 'Name the exact file')],
  });
  assert.deepStrictEqual(once, { added: [], detected: [] });
  assert.strictEqual(fs.existsSync(lessonsPath(root)), false);
});

test('fileAutoLessons files a typed lesson once a note repeats', () => {
  const root = makeRoot();
  const now = new Date(2026, 9, 23, 23, 30);
  const result = fileAutoLessons(root, {
    now,
    scope: '  atris-cli  ',
    episodes: [
      revision('e1', 'task-1', 'Name the exact file.'),
      revision('e2', 'task-2', '  name   the EXACT file!  ', { rl: { label: 'revised' } }),
      revision('e3', 'task-1', 'Name the exact file'),
    ],
  });

  assert.deepStrictEqual(result, { added: ['name-the-exact-file'], detected: ['name-the-exact-file'] });

  const lessons = readLessons(root);
  assert.deepStrictEqual(Object.keys(lessons), ['name-the-exact-file']);
  assert.deepStrictEqual(lessons['name-the-exact-file'], {
    name: 'Name the exact file.',
    date: '2026-10-23',
    scope: 'atris-cli',
    rule: 'Name the exact file.',
    detector: 'repeated_human_revision_note',
    source_signal: {
      type: 'repeated_human_revision_note',
      path: TASK_EPISODES_FILE,
      normalized_correction: 'name the exact file',
      occurrences: 3,
      task_ids: ['task-1', 'task-2'],
      episode_ids: ['e1', 'e2', 'e3'],
    },
    status: 'observed',
    last_detected: '2026-10-23',
  });
});

test('fileAutoLessons defaults the scope to workspace', () => {
  const root = makeRoot();
  fileAutoLessons(root, {
    now: new Date(2026, 0, 5, 9),
    episodes: [revision('e1', 't1', 'Keep it short'), revision('e2', 't2', 'Keep it short')],
  });

  const lesson = readLessons(root)['keep-it-short'];
  assert.strictEqual(lesson.scope, 'workspace');
  assert.strictEqual(lesson.date, '2026-01-05');
});

test('fileAutoLessons ignores episodes that are not real revision requests', () => {
  const root = makeRoot();
  const episodes = [
    revision('e1', 't1', 'Keep it short'),
    revision('e2', 't2', 'Keep it short', { action: { event_type: 'task_completed' } }),
    revision('e3', 't3', 'Keep it short', { rl: { label: 'accepted' } }),
    revision('e4', 't4', '   ', {}),
    revision('e1', 't5', 'Keep it short'),
    null,
    'not an episode',
  ];

  assert.deepStrictEqual(fileAutoLessons(root, { episodes }), { added: [], detected: [] });
  assert.strictEqual(fs.existsSync(lessonsPath(root)), false);
});

test('fileAutoLessons honors a higher threshold and ignores one that is too low', () => {
  const root = makeRoot();
  const episodes = [revision('e1', 't1', 'Keep it short'), revision('e2', 't2', 'Keep it short')];

  assert.deepStrictEqual(fileAutoLessons(root, { episodes, threshold: 3 }), { added: [], detected: [] });
  assert.deepStrictEqual(fileAutoLessons(root, { episodes, threshold: 1 }).added, ['keep-it-short']);
});

test('fileAutoLessons keeps existing lessons and reports repeats as detected only', () => {
  const root = makeRoot();
  const existing = { 'keep-it-short': { name: 'hand written', rule: 'do not touch' } };
  writeLessons(root, existing);
  const episodes = [
    revision('e1', 't1', 'Keep it short'),
    revision('e2', 't2', 'Keep it short'),
    revision('e3', 't3', 'Link the receipt'),
    revision('e4', 't4', 'Link the receipt'),
  ];

  const first = fileAutoLessons(root, { episodes, now: new Date(2026, 9, 23, 12) });
  assert.deepStrictEqual(first, { added: ['link-the-receipt'], detected: ['keep-it-short', 'link-the-receipt'] });

  const lessons = readLessons(root);
  assert.deepStrictEqual(lessons['keep-it-short'], existing['keep-it-short']);
  assert.strictEqual(lessons['link-the-receipt'].status, 'observed');

  const second = fileAutoLessons(root, { episodes, now: new Date(2026, 9, 24, 12) });
  assert.deepStrictEqual(second, { added: [], detected: ['keep-it-short', 'link-the-receipt'] });
  assert.strictEqual(readLessons(root)['link-the-receipt'].date, '2026-10-23');
});

test('fileAutoLessons reads the episode log from disk and skips bad lines', () => {
  const root = makeRoot();
  const episodesPath = path.join(root, TASK_EPISODES_FILE);
  fs.mkdirSync(path.dirname(episodesPath), { recursive: true });
  fs.writeFileSync(episodesPath, [
    JSON.stringify(revision('e1', 't1', 'Cite the source')),
    '{ this is not json',
    '',
    JSON.stringify(revision('e2', 't2', 'Cite the source?')),
    '',
  ].join('\n'), 'utf8');

  const result = fileAutoLessons(root, { now: new Date(2026, 9, 23, 12) });

  assert.deepStrictEqual(result, { added: ['cite-the-source'], detected: ['cite-the-source'] });
  const signal = readLessons(root)['cite-the-source'].source_signal;
  assert.strictEqual(signal.occurrences, 2);
  assert.deepStrictEqual(signal.episode_ids, ['e1', 'e2']);
});

test('fileAutoLessons refuses to overwrite a lessons file it cannot trust', () => {
  const episodes = [revision('e1', 't1', 'Keep it short'), revision('e2', 't2', 'Keep it short')];

  const malformed = makeRoot();
  writeLessons(malformed, '{ not json');
  assert.throws(
    () => fileAutoLessons(malformed, { episodes }),
    (error) => {
      assert.strictEqual(error.name, 'AutoLessonsError');
      assert.strictEqual(error.code, 'AUTO_LESSONS_ERROR');
      assert.match(error.message, /malformed JSON/);
      return true;
    },
  );
  assert.strictEqual(fs.readFileSync(lessonsPath(malformed), 'utf8'), '{ not json');

  const array = makeRoot();
  writeLessons(array, '[]');
  assert.throws(() => fileAutoLessons(array, { episodes }), /must contain a JSON object/);
  assert.strictEqual(fs.readFileSync(lessonsPath(array), 'utf8'), '[]');
});

test('fileAutoLessons rejects an invalid date before writing anything', () => {
  const root = makeRoot();
  const episodes = [revision('e1', 't1', 'Keep it short'), revision('e2', 't2', 'Keep it short')];

  assert.throws(
    () => fileAutoLessons(root, { episodes, now: new Date('not a date') }),
    /invalid date/,
  );
  assert.strictEqual(fs.existsSync(lessonsPath(root)), false);
});
