const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  loadLessonMetadata,
  parseLessons,
  runLessonDetector,
  isLessonResolved,
  isLessonResolvedLegacy,
  pickUnresolvedFailLesson
} = require('../commands/autopilot');
const { autoResolveLessons } = require('../commands/lesson');
const { parseLessons: parseLessonsView, buildMemorySpec } = require('../lib/memory-view');

function makeTempRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-typed-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'commands'), { recursive: true });
  return dir;
}

function writeLessonsMd(dir, body) {
  fs.writeFileSync(path.join(dir, 'atris', 'lessons.md'), body);
}

function writeLessonsJson(dir, obj) {
  fs.writeFileSync(path.join(dir, 'atris', 'lessons.json'), JSON.stringify(obj, null, 2));
}

test('loadLessonMetadata returns empty object when sidecar absent', (t) => {
  const dir = makeTempRepo(t);
  assert.deepEqual(loadLessonMetadata(dir), {});
});

test('loadLessonMetadata returns parsed object when sidecar valid', (t) => {
  const dir = makeTempRepo(t);
  writeLessonsJson(dir, { foo: { detector: 'true', status: 'open' } });
  const m = loadLessonMetadata(dir);
  assert.equal(m.foo.detector, 'true');
  assert.equal(m.foo.status, 'open');
});

test('loadLessonMetadata returns empty object on malformed JSON (no crash)', (t) => {
  const dir = makeTempRepo(t);
  fs.writeFileSync(path.join(dir, 'atris', 'lessons.json'), '{not json');
  assert.deepEqual(loadLessonMetadata(dir), {});
});

test('parseLessons returns empty when lessons.md missing', (t) => {
  const dir = makeTempRepo(t);
  assert.deepEqual(parseLessons(dir), []);
});

test('parseLessons extracts id/date/verdict/body from prose lines', (t) => {
  const dir = makeTempRepo(t);
  writeLessonsMd(dir, [
    '# lessons.md',
    '',
    '- **[2026-04-01] foo-bar** \u2014 fail \u2014 Something broke in `commands/foo.js:10`.',
    '- **[2026-04-02] baz-qux** \u2014 pass \u2014 [resolved] Worked.',
    '- random prose line, not a lesson',
    ''
  ].join('\n'));
  const l = parseLessons(dir);
  assert.equal(l.length, 2);
  assert.equal(l[0].id, 'foo-bar');
  assert.equal(l[0].date, '2026-04-01');
  assert.equal(l[0].verdict, 'fail');
  assert.equal(l[0].resolvedTag, false);
  assert.equal(l[0].legacy, true, 'legacy true when no sidecar entry');
  assert.equal(l[1].verdict, 'pass');
  assert.equal(l[1].resolvedTag, true);
});

test('parseLessons joins sidecar metadata by slug', (t) => {
  const dir = makeTempRepo(t);
  writeLessonsMd(dir, '- **[2026-04-01] foo-bar** \u2014 fail \u2014 Body.\n');
  writeLessonsJson(dir, { 'foo-bar': { detector: 'exit 0', status: 'open' } });
  const [first] = parseLessons(dir);
  assert.equal(first.legacy, false);
  assert.equal(first.meta.detector, 'exit 0');
  assert.equal(first.meta.status, 'open');
});

test('runLessonDetector returns true on exit 0, false on non-zero', (t) => {
  const dir = makeTempRepo(t);
  assert.equal(runLessonDetector('exit 0', dir), true);
  assert.equal(runLessonDetector('exit 1', dir), false);
  assert.equal(runLessonDetector('', dir), false);
  assert.equal(runLessonDetector(null, dir), false);
});

test('isLessonResolved uses detector when sidecar provides one (exit 0 → resolved)', (t) => {
  const dir = makeTempRepo(t);
  writeLessonsMd(dir, '- **[2026-04-01] foo-bar** \u2014 fail \u2014 In `commands/foo.js:1`.\n');
  fs.writeFileSync(path.join(dir, 'commands', 'foo.js'), 'const bar = 1;\n');
  writeLessonsJson(dir, { 'foo-bar': { detector: 'exit 0' } });
  const [l] = parseLessons(dir);
  assert.equal(isLessonResolved(l.line, dir, { meta: l.meta }), true);
});

test('isLessonResolved uses detector when sidecar provides one (exit 1 → not resolved)', (t) => {
  const dir = makeTempRepo(t);
  writeLessonsMd(dir, '- **[2026-04-01] foo-bar** \u2014 fail \u2014 In `commands/foo.js:1`.\n');
  fs.writeFileSync(path.join(dir, 'commands', 'foo.js'), '// clean\n');
  writeLessonsJson(dir, { 'foo-bar': { detector: 'exit 1' } });
  const [l] = parseLessons(dir);
  assert.equal(isLessonResolved(l.line, dir, { meta: l.meta }), false);
});

test('isLessonResolved falls back to legacy grep when no sidecar detector', (t) => {
  const dir = makeTempRepo(t);
  // Legacy path: slug keywords present in named file → not resolved
  writeLessonsMd(dir, '- **[2026-04-01] parser-eats-thing** \u2014 fail \u2014 In `commands/foo.js:1`.\n');
  fs.writeFileSync(path.join(dir, 'commands', 'foo.js'), 'const parser = 1;\n');
  const [l] = parseLessons(dir);
  assert.equal(isLessonResolved(l.line, dir, { meta: null }), false, 'still present → not resolved');

  fs.writeFileSync(path.join(dir, 'commands', 'foo.js'), '// clean\n');
  assert.equal(isLessonResolved(l.line, dir, { meta: null }), true, 'absent → resolved');
});

test('pickUnresolvedFailLesson prefers typed+detector over legacy', (t) => {
  const dir = makeTempRepo(t);
  fs.writeFileSync(path.join(dir, 'commands', 'foo.js'), 'const parser = 1;\n');
  writeLessonsMd(dir, [
    '- **[2026-03-01] parser-eats-thing** \u2014 fail \u2014 Bug in `commands/foo.js:1`.',
    '- **[2026-04-01] typed-open** \u2014 fail \u2014 Typed open fail.',
    '- **[2026-04-02] typed-resolved** \u2014 fail \u2014 Typed but already resolved.',
    ''
  ].join('\n'));
  writeLessonsJson(dir, {
    'typed-open': { detector: 'exit 1', status: 'open' },
    'typed-resolved': { detector: 'exit 0', status: 'resolved' }
  });
  const picked = pickUnresolvedFailLesson(dir);
  assert.ok(picked, 'should pick something');
  // Oldest first: parser-eats-thing (2026-03-01) is legacy and still present → should win
  assert.equal(picked.slug, 'parser-eats-thing');
});

test('pickUnresolvedFailLesson respects status:resolved sidecar tag', (t) => {
  const dir = makeTempRepo(t);
  writeLessonsMd(dir, '- **[2026-04-01] foo** \u2014 fail \u2014 In `commands/foo.js:1`.\n');
  fs.writeFileSync(path.join(dir, 'commands', 'foo.js'), 'const foo = 1;\n');
  writeLessonsJson(dir, { foo: { status: 'resolved' } });
  assert.equal(pickUnresolvedFailLesson(dir), null, 'status:resolved shortcuts to null');
});

test('pickUnresolvedFailLesson skips status:observed (process rules, not code bugs)', (t) => {
  const dir = makeTempRepo(t);
  // Legacy grep would pick this up, but sidecar says observed
  writeLessonsMd(dir, '- **[2026-04-01] note-only** \u2014 fail \u2014 Process rule about `commands/foo.js:1`.\n');
  fs.writeFileSync(path.join(dir, 'commands', 'foo.js'), 'const note = 1;\n');
  writeLessonsJson(dir, { 'note-only': { status: 'observed' } });
  assert.equal(pickUnresolvedFailLesson(dir), null, 'observed status bypasses legacy grep promotion');
});

test('pickUnresolvedFailLesson still picks status:open even with detector showing non-zero', (t) => {
  const dir = makeTempRepo(t);
  writeLessonsMd(dir, '- **[2026-04-01] still-open** \u2014 fail \u2014 Bug in `commands/foo.js:1`.\n');
  fs.writeFileSync(path.join(dir, 'commands', 'foo.js'), 'const bar = 1;\n');
  writeLessonsJson(dir, { 'still-open': { detector: 'exit 1', status: 'open' } });
  const picked = pickUnresolvedFailLesson(dir);
  assert.ok(picked, 'should pick');
  assert.equal(picked.slug, 'still-open');
  assert.equal(picked.detector, 'exit 1');
  assert.equal(picked.typed, true);
});

test('autoResolveLessons retires a fail lesson once its detector passes', (t) => {
  const dir = makeTempRepo(t);
  writeLessonsMd(dir, '# lessons.md\n\n- **[2026-04-01] bug-x** \u2014 fail \u2014 Bug in `commands/foo.js:1`.\n');
  writeLessonsJson(dir, { 'bug-x': { detector: 'exit 0', status: 'open' } });

  const res = autoResolveLessons(dir);
  assert.deepEqual(res.checked, ['bug-x']);
  assert.deepEqual(res.resolved, ['bug-x']);

  // sidecar stamped resolved, detector preserved
  const meta = loadLessonMetadata(dir);
  assert.equal(meta['bug-x'].status, 'resolved');
  assert.equal(meta['bug-x'].detector, 'exit 0');
  assert.match(meta['bug-x'].resolved_at, /^\d{4}-\d{2}-\d{2}$/);

  // lessons.md tagged [resolved] and parsers agree
  const md = fs.readFileSync(path.join(dir, 'atris', 'lessons.md'), 'utf8');
  assert.match(md, /\[resolved\]/);
  assert.equal(parseLessons(dir)[0].resolvedTag, true);

  // retired lesson is no longer re-picked by self-heal
  assert.equal(pickUnresolvedFailLesson(dir), null);
});

test('autoResolveLessons leaves a lesson open when its detector still fails', (t) => {
  const dir = makeTempRepo(t);
  writeLessonsMd(dir, '- **[2026-04-01] bug-y** \u2014 fail \u2014 Still broken in `commands/foo.js:1`.\n');
  writeLessonsJson(dir, { 'bug-y': { detector: 'exit 1', status: 'open' } });

  const res = autoResolveLessons(dir);
  assert.deepEqual(res.checked, ['bug-y']);
  assert.deepEqual(res.resolved, []);
  assert.equal(loadLessonMetadata(dir)['bug-y'].status, 'open');
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'atris', 'lessons.md'), 'utf8'), /\[resolved\]/);
});

test('autoResolveLessons dry-run reports resolvable lessons without writing', (t) => {
  const dir = makeTempRepo(t);
  writeLessonsMd(dir, '- **[2026-04-01] bug-z** \u2014 fail \u2014 In `commands/foo.js:1`.\n');
  writeLessonsJson(dir, { 'bug-z': { detector: 'exit 0', status: 'open' } });

  const res = autoResolveLessons(dir, { dryRun: true });
  assert.deepEqual(res.resolved, ['bug-z']);
  // nothing persisted
  assert.equal(loadLessonMetadata(dir)['bug-z'].status, 'open');
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'atris', 'lessons.md'), 'utf8'), /\[resolved\]/);
});

test('autoResolveLessons never auto-resolves observed or prose-only lessons', (t) => {
  const dir = makeTempRepo(t);
  writeLessonsMd(dir, [
    '- **[2026-04-01] observed-rule** \u2014 fail \u2014 Process note about `commands/foo.js:1`.',
    '- **[2026-04-02] prose-only** \u2014 fail \u2014 No detector, in `commands/foo.js:1`.',
    ''
  ].join('\n'));
  // observed has a passing detector but must be skipped; prose-only has none
  writeLessonsJson(dir, { 'observed-rule': { detector: 'exit 0', status: 'observed' } });

  const res = autoResolveLessons(dir);
  assert.deepEqual(res.checked, [], 'neither lesson is even detector-checked');
  assert.deepEqual(res.resolved, []);
  assert.equal(loadLessonMetadata(dir)['observed-rule'].status, 'observed');
});

test('memory view retires [resolved] lessons from the open count', (t) => {
  const md = [
    '- **[2026-04-01] bug-x** — fail — [resolved] Was broken, now fixed.',
    '- **[2026-04-02] bug-y** — fail — Still open bug.',
    ''
  ].join('\n');
  const parsed = parseLessonsView(md);
  assert.equal(parsed[0].resolved, true);
  assert.equal(parsed[0].text, 'Was broken, now fixed.', 'tag stripped from text');
  assert.equal(parsed[1].resolved, false);

  const dir = makeTempRepo(t);
  writeLessonsMd(dir, md);
  const spec = buildMemorySpec(dir);
  const big = spec.slides.find((s) => s.type === 'bignumber');
  assert.equal(big.number, '1', 'only the open lesson counts');
  assert.match(big.label, /retired/);
});
