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

function makeTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-typed-'));
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

test('loadLessonMetadata returns empty object when sidecar absent', () => {
  const dir = makeTempRepo();
  try {
    assert.deepEqual(loadLessonMetadata(dir), {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadLessonMetadata returns parsed object when sidecar valid', () => {
  const dir = makeTempRepo();
  try {
    writeLessonsJson(dir, { foo: { detector: 'true', status: 'open' } });
    const m = loadLessonMetadata(dir);
    assert.equal(m.foo.detector, 'true');
    assert.equal(m.foo.status, 'open');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadLessonMetadata returns empty object on malformed JSON (no crash)', () => {
  const dir = makeTempRepo();
  try {
    fs.writeFileSync(path.join(dir, 'atris', 'lessons.json'), '{not json');
    assert.deepEqual(loadLessonMetadata(dir), {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parseLessons returns empty when lessons.md missing', () => {
  const dir = makeTempRepo();
  try {
    assert.deepEqual(parseLessons(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parseLessons extracts id/date/verdict/body from prose lines', () => {
  const dir = makeTempRepo();
  try {
    writeLessonsMd(dir, [
      '# lessons.md',
      '',
      '- **[2026-04-01] foo-bar** — fail — Something broke in `commands/foo.js:10`.',
      '- **[2026-04-02] baz-qux** — pass — [resolved] Worked.',
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
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parseLessons joins sidecar metadata by slug', () => {
  const dir = makeTempRepo();
  try {
    writeLessonsMd(dir, '- **[2026-04-01] foo-bar** — fail — Body.\n');
    writeLessonsJson(dir, { 'foo-bar': { detector: 'exit 0', status: 'open' } });
    const [first] = parseLessons(dir);
    assert.equal(first.legacy, false);
    assert.equal(first.meta.detector, 'exit 0');
    assert.equal(first.meta.status, 'open');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runLessonDetector returns true on exit 0, false on non-zero', () => {
  const dir = makeTempRepo();
  try {
    assert.equal(runLessonDetector('exit 0', dir), true);
    assert.equal(runLessonDetector('exit 1', dir), false);
    assert.equal(runLessonDetector('', dir), false);
    assert.equal(runLessonDetector(null, dir), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('isLessonResolved uses detector when sidecar provides one (exit 0 → resolved)', () => {
  const dir = makeTempRepo();
  try {
    writeLessonsMd(dir, '- **[2026-04-01] foo-bar** — fail — In `commands/foo.js:1`.\n');
    fs.writeFileSync(path.join(dir, 'commands', 'foo.js'), 'const bar = 1;\n');
    writeLessonsJson(dir, { 'foo-bar': { detector: 'exit 0' } });
    const [l] = parseLessons(dir);
    assert.equal(isLessonResolved(l.line, dir, { meta: l.meta }), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('isLessonResolved uses detector when sidecar provides one (exit 1 → not resolved)', () => {
  const dir = makeTempRepo();
  try {
    writeLessonsMd(dir, '- **[2026-04-01] foo-bar** — fail — In `commands/foo.js:1`.\n');
    fs.writeFileSync(path.join(dir, 'commands', 'foo.js'), '// clean\n');
    writeLessonsJson(dir, { 'foo-bar': { detector: 'exit 1' } });
    const [l] = parseLessons(dir);
    assert.equal(isLessonResolved(l.line, dir, { meta: l.meta }), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('isLessonResolved falls back to legacy grep when no sidecar detector', () => {
  const dir = makeTempRepo();
  try {
    // Legacy path: slug keywords present in named file → not resolved
    writeLessonsMd(dir, '- **[2026-04-01] parser-eats-thing** — fail — In `commands/foo.js:1`.\n');
    fs.writeFileSync(path.join(dir, 'commands', 'foo.js'), 'const parser = 1;\n');
    const [l] = parseLessons(dir);
    assert.equal(isLessonResolved(l.line, dir, { meta: null }), false, 'still present → not resolved');

    fs.writeFileSync(path.join(dir, 'commands', 'foo.js'), '// clean\n');
    assert.equal(isLessonResolved(l.line, dir, { meta: null }), true, 'absent → resolved');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pickUnresolvedFailLesson prefers typed+detector over legacy', () => {
  const dir = makeTempRepo();
  try {
    fs.writeFileSync(path.join(dir, 'commands', 'foo.js'), 'const parser = 1;\n');
    writeLessonsMd(dir, [
      '- **[2026-03-01] parser-eats-thing** — fail — Bug in `commands/foo.js:1`.',
      '- **[2026-04-01] typed-open** — fail — Typed open fail.',
      '- **[2026-04-02] typed-resolved** — fail — Typed but already resolved.',
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
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pickUnresolvedFailLesson respects status:resolved sidecar tag', () => {
  const dir = makeTempRepo();
  try {
    writeLessonsMd(dir, '- **[2026-04-01] foo** — fail — In `commands/foo.js:1`.\n');
    fs.writeFileSync(path.join(dir, 'commands', 'foo.js'), 'const foo = 1;\n');
    writeLessonsJson(dir, { foo: { status: 'resolved' } });
    assert.equal(pickUnresolvedFailLesson(dir), null, 'status:resolved shortcuts to null');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pickUnresolvedFailLesson skips status:observed (process rules, not code bugs)', () => {
  const dir = makeTempRepo();
  try {
    // Legacy grep would pick this up, but sidecar says observed
    writeLessonsMd(dir, '- **[2026-04-01] note-only** — fail — Process rule about `commands/foo.js:1`.\n');
    fs.writeFileSync(path.join(dir, 'commands', 'foo.js'), 'const note = 1;\n');
    writeLessonsJson(dir, { 'note-only': { status: 'observed' } });
    assert.equal(pickUnresolvedFailLesson(dir), null, 'observed status bypasses legacy grep promotion');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pickUnresolvedFailLesson still picks status:open even with detector showing non-zero', () => {
  const dir = makeTempRepo();
  try {
    writeLessonsMd(dir, '- **[2026-04-01] still-open** — fail — Bug in `commands/foo.js:1`.\n');
    fs.writeFileSync(path.join(dir, 'commands', 'foo.js'), 'const bar = 1;\n');
    writeLessonsJson(dir, { 'still-open': { detector: 'exit 1', status: 'open' } });
    const picked = pickUnresolvedFailLesson(dir);
    assert.ok(picked, 'should pick');
    assert.equal(picked.slug, 'still-open');
    assert.equal(picked.detector, 'exit 1');
    assert.equal(picked.typed, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
