const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { markLessonAttempted, loadLessonMetadata, pickUnresolvedFailLesson } = require('../commands/autopilot');

function makeTempRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-attempted-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'commands'), { recursive: true });
  return dir;
}

test('markLessonAttempted creates lessons.json when absent', (t) => {
  const dir = makeTempRepo(t);
  const ok = markLessonAttempted(dir, 'new-slug', 'verify-failed');
  assert.equal(ok, true);
  const meta = loadLessonMetadata(dir);
  assert.equal(meta['new-slug'].status, 'attempted');
  assert.equal(meta['new-slug'].attempts, 1);
  assert.equal(meta['new-slug'].last_attempt_reason, 'verify-failed');
  assert.match(meta['new-slug'].last_attempt, /^\d{4}-\d{2}-\d{2}$/);
});

test('markLessonAttempted increments attempts counter on existing entry', (t) => {
  const dir = makeTempRepo(t);
  fs.writeFileSync(
    path.join(dir, 'atris', 'lessons.json'),
    JSON.stringify({ 'existing': { attempts: 2, status: 'open' } })
  );
  markLessonAttempted(dir, 'existing', 'review-rejected');
  const meta = loadLessonMetadata(dir);
  assert.equal(meta.existing.attempts, 3);
  assert.equal(meta.existing.status, 'attempted');
  assert.equal(meta.existing.last_attempt_reason, 'review-rejected');
});

test('markLessonAttempted preserves other sidecar entries', (t) => {
  const dir = makeTempRepo(t);
  fs.writeFileSync(
    path.join(dir, 'atris', 'lessons.json'),
    JSON.stringify({
      'other': { detector: 'exit 0', status: 'resolved' },
      'target': { attempts: 0, status: 'open' }
    })
  );
  markLessonAttempted(dir, 'target', 'halted');
  const meta = loadLessonMetadata(dir);
  assert.equal(meta.other.detector, 'exit 0', 'other entry unchanged');
  assert.equal(meta.other.status, 'resolved');
  assert.equal(meta.target.attempts, 1);
  assert.equal(meta.target.status, 'attempted');
});

test('markLessonAttempted returns false on malformed sidecar JSON', (t) => {
  const dir = makeTempRepo(t);
  fs.writeFileSync(path.join(dir, 'atris', 'lessons.json'), '{not valid');
  assert.equal(markLessonAttempted(dir, 'any', 'reason'), false);
});

test('markLessonAttempted rejects empty/invalid slug', (t) => {
  const dir = makeTempRepo(t);
  assert.equal(markLessonAttempted(dir, '', 'reason'), false);
  assert.equal(markLessonAttempted(dir, null, 'reason'), false);
  assert.equal(markLessonAttempted(dir, 42, 'reason'), false);
});

test('pickUnresolvedFailLesson skips attempted lessons at MAX_ATTEMPTS (3)', (t) => {
  const dir = makeTempRepo(t);
  fs.writeFileSync(
    path.join(dir, 'atris', 'lessons.md'),
    '- **[2026-04-01] stuck** \u2014 fail \u2014 Bug in `commands/foo.js:1`.\n'
  );
  fs.writeFileSync(path.join(dir, 'commands', 'foo.js'), 'const stuck = 1;\n');
  fs.writeFileSync(
    path.join(dir, 'atris', 'lessons.json'),
    JSON.stringify({ 'stuck': { status: 'attempted', attempts: 3 } })
  );
  assert.equal(pickUnresolvedFailLesson(dir), null, 'capped at 3, skipped');
});

test('pickUnresolvedFailLesson still picks attempted lesson below cap', (t) => {
  const dir = makeTempRepo(t);
  fs.writeFileSync(
    path.join(dir, 'atris', 'lessons.md'),
    '- **[2026-04-01] retry-me** \u2014 fail \u2014 Bug in `commands/foo.js:1`.\n'
  );
  fs.writeFileSync(path.join(dir, 'commands', 'foo.js'), 'const retry = 1;\n');
  fs.writeFileSync(
    path.join(dir, 'atris', 'lessons.json'),
    JSON.stringify({ 'retry-me': { status: 'attempted', attempts: 1 } })
  );
  const picked = pickUnresolvedFailLesson(dir);
  assert.ok(picked);
  assert.equal(picked.slug, 'retry-me');
  assert.equal(picked.attempts, 1);
});
