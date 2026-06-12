const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { detectLessonContradictions } = require('../lib/lesson-contradiction');

function makeTempWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lesson-sweep-test-'));
  const atrisDir = path.join(dir, 'atris');
  fs.mkdirSync(atrisDir, { recursive: true });
  return { dir, atrisDir };
}

test('detects P1: same slug with opposite outcomes at later date', () => {
  const { dir, atrisDir } = makeTempWorkspace();
  try {
    const lessonsMd = [
      '# lessons.md',
      '',
      '- **[2026-04-09] test-lesson** — pass — Initial success',
      '- **[2026-04-20] test-lesson** — fail — Later failure contradicts earlier pass',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(atrisDir, 'lessons.md'), lessonsMd);

    const contradictions = detectLessonContradictions(dir);

    assert.equal(contradictions.length, 1, 'should find 1 contradiction');
    assert.equal(contradictions[0].type, 'P1_opposite_outcomes');
    assert.equal(contradictions[0].slug, 'test-lesson');
    assert.match(contradictions[0].evidence, /pass.*fail/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('detects P2: applies_to file no longer exists', () => {
  const { dir, atrisDir } = makeTempWorkspace();
  try {
    const lessonsJson = {
      'missing-file-lesson': {
        scope: 'test-repo',
        applies_to: ['commands/deleted.js'],
        detector: 'grep -q "pattern" commands/deleted.js',
        status: 'open',
      },
    };
    fs.writeFileSync(
      path.join(atrisDir, 'lessons.json'),
      JSON.stringify(lessonsJson, null, 2)
    );

    const contradictions = detectLessonContradictions(dir);

    assert.equal(contradictions.length, 1, 'should find 1 missing file');
    assert.equal(contradictions[0].type, 'P2_missing_file');
    assert.equal(contradictions[0].slug, 'missing-file-lesson');
    assert.match(contradictions[0].evidence, /commands\/deleted\.js/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('skips [resolved] lessons in P1 check', () => {
  const { dir, atrisDir } = makeTempWorkspace();
  try {
    const lessonsMd = [
      '# lessons.md',
      '',
      '- **[2026-04-09] resolved-lesson** — pass — Initial pass',
      '- **[2026-04-20] resolved-lesson** — fail — [resolved] Contradicts but marked resolved',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(atrisDir, 'lessons.md'), lessonsMd);

    const contradictions = detectLessonContradictions(dir);

    assert.equal(contradictions.length, 0, 'should skip [resolved] entries');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('skips status:observed in P2 check', () => {
  const { dir, atrisDir } = makeTempWorkspace();
  try {
    const lessonsJson = {
      'observed-lesson': {
        scope: 'test-repo',
        applies_to: ['commands/gone.js'],
        detector: 'grep -q "pattern" commands/gone.js',
        status: 'observed',
      },
    };
    fs.writeFileSync(
      path.join(atrisDir, 'lessons.json'),
      JSON.stringify(lessonsJson, null, 2)
    );

    const contradictions = detectLessonContradictions(dir);

    assert.equal(contradictions.length, 0, 'should skip status:observed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('skips attempted >= 3 in P2 check', () => {
  const { dir, atrisDir } = makeTempWorkspace();
  try {
    const lessonsJson = {
      'stuck-lesson': {
        scope: 'test-repo',
        applies_to: ['commands/stuck.js'],
        detector: 'grep -q "pattern" commands/stuck.js',
        status: 'attempted',
        attempts: 3,
      },
    };
    fs.writeFileSync(
      path.join(atrisDir, 'lessons.json'),
      JSON.stringify(lessonsJson, null, 2)
    );

    const contradictions = detectLessonContradictions(dir);

    assert.equal(contradictions.length, 0, 'should skip attempted >= 3');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('handles existing applies_to files in P2 check', () => {
  const { dir, atrisDir } = makeTempWorkspace();
  try {
    const cmdDir = path.join(dir, 'commands');
    fs.mkdirSync(cmdDir, { recursive: true });
    fs.writeFileSync(path.join(cmdDir, 'existing.js'), 'console.log("hi");');

    const lessonsJson = {
      'existing-file-lesson': {
        scope: 'test-repo',
        applies_to: ['commands/existing.js'],
        detector: 'grep -q "pattern" commands/existing.js',
        status: 'open',
      },
    };
    fs.writeFileSync(
      path.join(atrisDir, 'lessons.json'),
      JSON.stringify(lessonsJson, null, 2)
    );

    const contradictions = detectLessonContradictions(dir);

    assert.equal(contradictions.length, 0, 'should not flag existing files');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('detects multiple contradictions in one run', () => {
  const { dir, atrisDir } = makeTempWorkspace();
  try {
    const lessonsMd = [
      '# lessons.md',
      '',
      '- **[2026-04-09] lesson-a** — pass — Pass',
      '- **[2026-04-20] lesson-a** — fail — Fail',
      '- **[2026-04-09] lesson-b** — fail — Fail',
      '- **[2026-04-20] lesson-b** — pass — Pass',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(atrisDir, 'lessons.md'), lessonsMd);

    const lessonsJson = {
      'lesson-c': {
        scope: 'test-repo',
        applies_to: ['cmd/gone1.js'],
        detector: 'true',
        status: 'open',
      },
      'lesson-d': {
        scope: 'test-repo',
        applies_to: ['cmd/gone2.js'],
        detector: 'true',
        status: 'open',
      },
    };
    fs.writeFileSync(
      path.join(atrisDir, 'lessons.json'),
      JSON.stringify(lessonsJson, null, 2)
    );

    const contradictions = detectLessonContradictions(dir);

    assert.equal(contradictions.length, 4, 'should find 2 P1 + 2 P2 contradictions');

    const p1Count = contradictions.filter(c => c.type === 'P1_opposite_outcomes').length;
    const p2Count = contradictions.filter(c => c.type === 'P2_missing_file').length;
    assert.equal(p1Count, 2, 'should find 2 P1 contradictions');
    assert.equal(p2Count, 2, 'should find 2 P2 contradictions');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
