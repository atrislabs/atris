const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-upsert-lesson-meta-home-'));
process.env.HOME = home;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

const { upsertLessonMeta } = require('../commands/autopilot');

function tempRepo(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-upsert-lesson-meta-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}

function lessonsPath(cwd) {
  return path.join(cwd, 'atris', 'lessons.json');
}

function readLessons(cwd) {
  return fs.readFileSync(lessonsPath(cwd), 'utf8');
}

function pretty(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

test('upsertLessonMeta writes a new sidecar and merges the next patch', (t) => {
  const cwd = tempRepo(t);

  const created = upsertLessonMeta(cwd, 'verify-gate', {
    status: 'pass',
    detector: 'node --test test/example.test.js',
    scope: 'atris-cli',
  });
  assert.strictEqual(created, true);
  assert.strictEqual(readLessons(cwd), pretty({
    'verify-gate': {
      status: 'pass',
      detector: 'node --test test/example.test.js',
      scope: 'atris-cli',
    },
  }));

  const added = upsertLessonMeta(cwd, 'neighbor', { status: 'observed' });
  assert.strictEqual(added, true);
  const merged = upsertLessonMeta(cwd, 'verify-gate', { note: 'still passing' });
  assert.strictEqual(merged, true);
  assert.strictEqual(readLessons(cwd), pretty({
    'verify-gate': {
      status: 'pass',
      detector: 'node --test test/example.test.js',
      scope: 'atris-cli',
      note: 'still passing',
    },
    neighbor: { status: 'observed' },
  }));
});

test('null detector is removed, an undefined field is kept, and a non-object entry is replaced', (t) => {
  const cwd = tempRepo(t);
  fs.mkdirSync(path.join(cwd, 'atris'));
  fs.writeFileSync(lessonsPath(cwd), pretty({
    'kept-slug': { status: 'pass', detector: 'exit 0' },
    'reverted-slug': {
      status: 'pass',
      detector: 'node --test x',
      scope: 'old',
      note: 'keep me',
    },
    'broken-entry': 'legacy-text',
  }));

  const cleared = upsertLessonMeta(cwd, 'reverted-slug', {
    status: 'observed',
    scope: 'atris-cli',
    detector: null,
    note: undefined,
  });
  assert.strictEqual(cleared, true);

  const replaced = upsertLessonMeta(cwd, 'broken-entry', { status: 'open' });
  assert.strictEqual(replaced, true);

  assert.strictEqual(readLessons(cwd), pretty({
    'kept-slug': { status: 'pass', detector: 'exit 0' },
    'reverted-slug': { status: 'observed', scope: 'atris-cli', note: 'keep me' },
    'broken-entry': { status: 'open' },
  }));
});

test('an empty patch records a blank entry, and a bad slug or broken file does not write', (t) => {
  const cwd = tempRepo(t);

  assert.strictEqual(upsertLessonMeta(cwd, '', { status: 'pass' }), false);
  assert.strictEqual(upsertLessonMeta(cwd, null, { status: 'pass' }), false);
  assert.strictEqual(upsertLessonMeta(cwd, 7, { status: 'pass' }), false);
  assert.strictEqual(fs.existsSync(path.join(cwd, 'atris')), false);

  const blank = upsertLessonMeta(cwd, 'bare-slug');
  assert.strictEqual(blank, true);
  assert.strictEqual(readLessons(cwd), pretty({ 'bare-slug': {} }));

  const broken = '{not json';
  fs.writeFileSync(lessonsPath(cwd), broken);
  assert.strictEqual(upsertLessonMeta(cwd, 'bare-slug', { status: 'pass' }), false);
  assert.strictEqual(fs.readFileSync(lessonsPath(cwd), 'utf8'), broken);

  const blocker = path.join(cwd, 'not-a-directory');
  fs.writeFileSync(blocker, 'file');
  assert.strictEqual(upsertLessonMeta(blocker, 'bare-slug', { status: 'pass' }), false);
  assert.strictEqual(fs.readFileSync(blocker, 'utf8'), 'file');
});
