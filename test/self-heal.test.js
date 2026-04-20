const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pickUnresolvedFailLesson } = require('../commands/autopilot');

function makeTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-heal-'));
  fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'commands'), { recursive: true });
  return dir;
}

test('pickUnresolvedFailLesson returns null when no lessons.md', () => {
  const dir = makeTempRepo();
  try {
    assert.equal(pickUnresolvedFailLesson(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pickUnresolvedFailLesson skips [resolved] and pass lessons', () => {
  const dir = makeTempRepo();
  try {
    fs.writeFileSync(path.join(dir, 'commands', 'foo.js'), '// empty\n');
    const lessons = [
      '# lessons.md',
      '',
      '- **[2026-04-01] already-fixed** — fail — [resolved] Bug was in `commands/foo.js:10`.',
      '- **[2026-04-02] worked-fine** — pass — Nothing to heal.',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'atris', 'lessons.md'), lessons);
    assert.equal(pickUnresolvedFailLesson(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pickUnresolvedFailLesson picks oldest unresolved fail whose bug grep still hits', () => {
  const dir = makeTempRepo();
  try {
    // Source contains the keyword "parser" from slug "inbox-parser-eats-hr-separator"
    fs.writeFileSync(path.join(dir, 'commands', 'foo.js'), 'const parser = true;\n');
    const lessons = [
      '# lessons.md',
      '',
      '- **[2026-03-05] inbox-parser-eats-hr-separator** — fail — Pattern still in `commands/foo.js:1`.',
      '- **[2026-04-02] newer-fail** — fail — Something in `commands/foo.js:1` about parser logic.',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'atris', 'lessons.md'), lessons);

    const picked = pickUnresolvedFailLesson(dir);
    assert.ok(picked, 'should return a candidate');
    assert.equal(picked.slug, 'inbox-parser-eats-hr-separator', 'should pick oldest');
    assert.equal(picked.date, '2026-03-05');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pickUnresolvedFailLesson skips lessons whose grep no longer matches', () => {
  const dir = makeTempRepo();
  try {
    // Source does NOT contain "parser" — bug pattern is gone
    fs.writeFileSync(path.join(dir, 'commands', 'foo.js'), '// clean\n');
    const lessons = [
      '# lessons.md',
      '',
      '- **[2026-03-05] inbox-parser-eats-hr-separator** — fail — Bug in `commands/foo.js:1`.',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'atris', 'lessons.md'), lessons);

    assert.equal(pickUnresolvedFailLesson(dir), null, 'resolved lesson should be skipped');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
