const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function runCli(args, cwd) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', NODE_NO_WARNINGS: '1' },
  });
}

test('wish improve ingests unprocessed reviews into LESSONS.md, then reruns clean', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-wish-improve-'));
  try {
    const stateDir = path.join(dir, '.atris', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const events = [
      { id: 'wish-1', ts: '2026-07-06T01:00:00.000Z', text: 'ship the thing' },
      { kind: 'review', wish_id: 'wish-1', ts: '2026-07-06T02:00:00.000Z', review_text: 'too slow', review_score: -1, reviewed_by: 'keshav' },
      { kind: 'review', wish_id: 'wish-1', ts: '2026-07-06T03:00:00.000Z', review_text: 'second pass was great', review_score: 5, reviewed_by: 'keshav' },
    ];
    fs.writeFileSync(path.join(stateDir, 'wishes.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');

    const first = runCli(['wish', 'improve'], dir);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /ingested 2 reviews/);
    assert.match(first.stdout, /1 negative/);

    const lessons = fs.readFileSync(path.join(dir, '.claude', 'skills', 'wish', 'LESSONS.md'), 'utf8');
    assert.match(lessons, /## Review inbox \(raw, distill me\)/);
    assert.match(lessons, /too slow/);
    assert.match(lessons, /second pass was great/);

    const cursor = JSON.parse(fs.readFileSync(path.join(stateDir, 'wish-improve.cursor.json'), 'utf8'));
    assert.equal(cursor.last_ts, '2026-07-06T03:00:00.000Z');

    const second = runCli(['wish', 'improve'], dir);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /nothing new/);
    const lessonsAfter = fs.readFileSync(path.join(dir, '.claude', 'skills', 'wish', 'LESSONS.md'), 'utf8');
    assert.equal(lessonsAfter, lessons);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('wishLessonsBrief includes lessons when present, empty when file absent', () => {
  const { wishLessonsBrief } = require('../lib/wish-store');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-wish-lessons-'));
  try {
    assert.equal(wishLessonsBrief(dir), '');

    const skillDir = path.join(dir, '.claude', 'skills', 'wish');
    fs.mkdirSync(skillDir, { recursive: true });
    const lessonLines = Array.from({ length: 12 }, (_, i) => `- lesson ${i + 1}`);
    fs.writeFileSync(path.join(skillDir, 'LESSONS.md'), [
      '# Wish lessons',
      '',
      '## Lessons',
      '',
      ...lessonLines,
      '',
      '## Review inbox (raw, distill me)',
      '- raw review entry that must not appear',
      '',
    ].join('\n'), 'utf8');

    const brief = wishLessonsBrief(dir);
    assert.match(brief, /^Lessons from past wishes \(apply these\):/);
    assert.match(brief, /- lesson 1\b/);
    assert.match(brief, /- lesson 10\b/);
    assert.doesNotMatch(brief, /lesson 11/);
    assert.doesNotMatch(brief, /raw review entry/);

    // Empty Lessons section -> no block
    fs.writeFileSync(path.join(skillDir, 'LESSONS.md'), '# Wish lessons\n\n## Lessons\n\n## Review inbox (raw, distill me)\n', 'utf8');
    assert.equal(wishLessonsBrief(dir), '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pruneWishLessons removes a lesson whose after-window average dropped, keeps the rest', () => {
  const { pruneWishLessons, lessonsFile, appendWishRecord } = require('../lib/wish-store');
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wish-prune-'));
  // reviews: before 2026-07-01 avg 3, after avg 1 (3 reviews -> prune eligible)
  appendWishRecord(root, { kind: 'review', wish_id: 'w1', ts: '2026-06-20T00:00:00Z', review_score: 3, review_text: 'good' });
  appendWishRecord(root, { kind: 'review', wish_id: 'w2', ts: '2026-06-25T00:00:00Z', review_score: 3, review_text: 'good' });
  appendWishRecord(root, { kind: 'review', wish_id: 'w3', ts: '2026-07-02T00:00:00Z', review_score: 1, review_text: 'meh' });
  appendWishRecord(root, { kind: 'review', wish_id: 'w4', ts: '2026-07-03T00:00:00Z', review_score: 1, review_text: 'meh' });
  appendWishRecord(root, { kind: 'review', wish_id: 'w5', ts: '2026-07-04T00:00:00Z', review_score: 1, review_text: 'meh' });
  const file = lessonsFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    '# Wish lessons', '', '## Lessons',
    '- 2026-07-01: bad lesson that tanked scores',
    '- 2026-07-04: too fresh to judge',
    '- undated lesson stays', '',
    '## Review inbox (raw, distill me)', '',
  ].join('\n'), 'utf8');
  const pruned = pruneWishLessons(root, { quiet: true });
  assert.equal(pruned.length, 1);
  const after = fs.readFileSync(file, 'utf8');
  assert.ok(!after.match(/## Lessons[\s\S]*bad lesson[\s\S]*## Review inbox/));
  assert.ok(after.includes('- 2026-07-04: too fresh to judge'));
  assert.ok(after.includes('undated lesson stays'));
  assert.ok(after.includes('## Pruned (did not move the score)'));
  assert.ok(after.includes('bad lesson that tanked scores [pruned'));
  // idempotent
  assert.equal(pruneWishLessons(root, { quiet: true }).length, 0);
});
