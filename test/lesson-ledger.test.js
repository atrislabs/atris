const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateDetector, appendLedgerEntry, readLedger, ledgerPath } = require('../lib/lesson-ledger');
const { addLesson, revertLessonResolution, autoResolveLessons } = require('../commands/lesson');
const { loadLessonMetadata, parseLessons } = require('../commands/autopilot');

function makeTempRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-ledger-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
  return dir;
}

test('validateDetector accepts commands that run, either exit code', (t) => {
  const dir = makeTempRepo(t);
  assert.equal(validateDetector('exit 0', dir).ok, true);
  assert.equal(validateDetector('exit 1', dir).ok, true);
  assert.equal(validateDetector('exit 1', dir).exitCode, 1);
});

test('validateDetector rejects empty and not-found commands', (t) => {
  const dir = makeTempRepo(t);
  assert.equal(validateDetector('', dir).ok, false);
  assert.equal(validateDetector(null, dir).ok, false);
  const missing = validateDetector('definitely-not-a-real-binary-xyz', dir);
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /not found/);
});

test('appendLedgerEntry creates the state dir and readLedger round-trips', (t) => {
  const dir = makeTempRepo(t);
  const rec = appendLedgerEntry(dir, { action: 'add', slug: 'foo', evidence: 'e' });
  assert.ok(rec.id.startsWith('ll-'));
  assert.match(rec.ts, /^\d{4}-\d{2}-\d{2}T/);
  const records = readLedger(dir);
  assert.equal(records.length, 1);
  assert.equal(records[0].slug, 'foo');
});

test('readLedger skips torn lines and honors limit + slug filter', (t) => {
  const dir = makeTempRepo(t);
  appendLedgerEntry(dir, { action: 'add', slug: 'a' });
  fs.appendFileSync(ledgerPath(dir), '{torn json\n');
  appendLedgerEntry(dir, { action: 'resolve', slug: 'a' });
  appendLedgerEntry(dir, { action: 'add', slug: 'b' });
  assert.equal(readLedger(dir).length, 3);
  assert.equal(readLedger(dir, { slug: 'a' }).length, 2);
  const limited = readLedger(dir, { limit: 1 });
  assert.equal(limited.length, 1);
  assert.equal(limited[0].slug, 'b', 'limit keeps the newest');
});

test('addLesson with detector writes md + sidecar + ledger in one step', (t) => {
  const dir = makeTempRepo(t);
  const res = addLesson(dir, 'bug-x', 'fail', 'Broke in `lib/foo.js:1`.', { detector: 'exit 1', scope: 'lib' });
  assert.equal(res.ok, true);

  const meta = loadLessonMetadata(dir);
  assert.equal(meta['bug-x'].detector, 'exit 1');
  assert.equal(meta['bug-x'].scope, 'lib');
  assert.equal(meta['bug-x'].status, 'open');

  const [lesson] = parseLessons(dir);
  assert.equal(lesson.id, 'bug-x');
  assert.equal(lesson.legacy, false, 'typed from birth, no hand-edited sidecar');

  const ledger = readLedger(dir);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].action, 'add');
  assert.match(ledger[0].evidence, /detector validated/);
});

test('addLesson rejects a detector that cannot run, writes nothing', (t) => {
  const dir = makeTempRepo(t);
  const res = addLesson(dir, 'bug-y', 'fail', 'Body.', { detector: 'no-such-binary-abc' });
  assert.equal(res.ok, false);
  assert.match(res.error, /detector rejected/);
  assert.equal(fs.existsSync(path.join(dir, 'atris', 'lessons.md')), false);
  assert.equal(readLedger(dir).length, 0);
});

test('addLesson without detector still records a prose-only ledger entry', (t) => {
  const dir = makeTempRepo(t);
  const res = addLesson(dir, 'note-a', 'pass', 'Process note.');
  assert.equal(res.ok, true);
  const ledger = readLedger(dir);
  assert.equal(ledger.length, 1);
  assert.match(ledger[0].evidence, /prose-only/);
  assert.deepEqual(loadLessonMetadata(dir), {}, 'no sidecar entry without detector/scope');
});

test('autoResolveLessons records a resolve entry with detector evidence', (t) => {
  const dir = makeTempRepo(t);
  addLesson(dir, 'bug-z', 'fail', 'In `lib/foo.js:1`.', { detector: 'exit 0' });
  const res = autoResolveLessons(dir);
  assert.deepEqual(res.resolved, ['bug-z']);
  const ledger = readLedger(dir);
  assert.equal(ledger.length, 2, 'add + resolve');
  assert.equal(ledger[1].action, 'resolve');
  assert.match(ledger[1].evidence, /detector passed: exit 0/);
});

test('revertLessonResolution reopens the lesson and logs the revert', (t) => {
  const dir = makeTempRepo(t);
  addLesson(dir, 'bug-w', 'fail', 'In `lib/foo.js:1`.', { detector: 'exit 0' });
  autoResolveLessons(dir);
  assert.equal(loadLessonMetadata(dir)['bug-w'].status, 'resolved');
  assert.match(fs.readFileSync(path.join(dir, 'atris', 'lessons.md'), 'utf8'), /\[resolved\]/);

  const res = revertLessonResolution(dir, 'bug-w', 'detector passed because call site was deleted');
  assert.equal(res.ok, true);

  const meta = loadLessonMetadata(dir)['bug-w'];
  assert.equal(meta.status, 'open');
  assert.equal(meta.resolved_at, undefined);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'atris', 'lessons.md'), 'utf8'), /\[resolved\]/);

  const ledger = readLedger(dir);
  assert.equal(ledger[ledger.length - 1].action, 'revert');
  assert.match(ledger[ledger.length - 1].evidence, /call site was deleted/);
});

test('revertLessonResolution refuses lessons that are not resolved', (t) => {
  const dir = makeTempRepo(t);
  addLesson(dir, 'bug-v', 'fail', 'Body.', { detector: 'exit 1' });
  const res = revertLessonResolution(dir, 'bug-v');
  assert.equal(res.ok, false);
  assert.match(res.error, /not resolved/);
  const missing = revertLessonResolution(dir, 'no-such-slug');
  assert.equal(missing.ok, false);
  assert.match(missing.error, /no sidecar entry/);
});
