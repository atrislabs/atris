const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pickUnresolvedFailLesson } = require('../commands/autopilot');

function makeTempRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-heal-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'commands'), { recursive: true });
  return dir;
}

test('pickUnresolvedFailLesson returns null when no lessons.md', (t) => {
  const dir = makeTempRepo(t);
  assert.equal(pickUnresolvedFailLesson(dir), null);
});

test('pickUnresolvedFailLesson skips [resolved] and pass lessons', (t) => {
  const dir = makeTempRepo(t);
  fs.writeFileSync(path.join(dir, 'commands', 'foo.js'), '// empty\n');
  const lessons = [
    '# lessons.md',
    '',
    '- **[2026-04-01] already-fixed** \u2014 fail \u2014 [resolved] Bug was in `commands/foo.js:10`.',
    '- **[2026-04-02] worked-fine** \u2014 pass \u2014 Nothing to heal.',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'atris', 'lessons.md'), lessons);
  assert.equal(pickUnresolvedFailLesson(dir), null);
});

test('pickUnresolvedFailLesson picks oldest unresolved fail whose bug grep still hits', (t) => {
  const dir = makeTempRepo(t);
  // Source contains the keyword "parser" from slug "inbox-parser-eats-hr-separator"
  fs.writeFileSync(path.join(dir, 'commands', 'foo.js'), 'const parser = true;\n');
  const lessons = [
    '# lessons.md',
    '',
    '- **[2026-03-05] inbox-parser-eats-hr-separator** \u2014 fail \u2014 Pattern still in `commands/foo.js:1`.',
    '- **[2026-04-02] newer-fail** \u2014 fail \u2014 Something in `commands/foo.js:1` about parser logic.',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'atris', 'lessons.md'), lessons);

  const picked = pickUnresolvedFailLesson(dir);
  assert.ok(picked, 'should return a candidate');
  assert.equal(picked.slug, 'inbox-parser-eats-hr-separator', 'should pick oldest');
  assert.equal(picked.date, '2026-03-05');
});

test('pickUnresolvedFailLesson skips lessons whose grep no longer matches', (t) => {
  const dir = makeTempRepo(t);
  // Source does NOT contain "parser", so the bug pattern is gone
  fs.writeFileSync(path.join(dir, 'commands', 'foo.js'), '// clean\n');
  const lessons = [
    '# lessons.md',
    '',
    '- **[2026-03-05] inbox-parser-eats-hr-separator** \u2014 fail \u2014 Bug in `commands/foo.js:1`.',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'atris', 'lessons.md'), lessons);

  assert.equal(pickUnresolvedFailLesson(dir), null, 'resolved lesson should be skipped');
});
