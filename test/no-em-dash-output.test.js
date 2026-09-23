'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { syncLessonsMd } = require('../lib/policy-lessons');
const { writeScorecard, readScorecards, getScorecardsPath } = require('../lib/scorecard');
const { parseTodoFile } = require('../lib/todo-fallback');
const { detectLessonContradictions } = require('../lib/lesson-contradiction');
const { parseLessons: parseAutopilotLessons } = require('../commands/autopilot');
const { parseLessons: parseMemoryLessons } = require('../lib/memory-view');
const { matchLessons } = require('../lib/lesson-preflight');
const { autoResolveLessons } = require('../commands/lesson');
const { buildProbeLine } = require('../commands/probe');
const { reviewLearningLine } = require('../commands/workflow');
const prDescription = require('../scripts/det/pr-description');
const { catalogText } = require('../scripts/det/det');

const oldDash = '\u2014';

function workspace(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-no-em-dash-'));
  fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
  try { run(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('policy lesson sync writes clean lines and refreshes old lines', () => workspace((root) => {
  const file = path.join(root, 'atris', 'lessons.md');
  fs.writeFileSync(file, `- **[2026-09-22] policy-proof** ${oldDash} pass ${oldDash} stale\n`);
  syncLessonsMd(root, {
    mined_at: '2026-09-23T00:00:00Z',
    sources: { career_xp_receipts: 1, task_episodes: 2, scorecards: 3 },
    lessons: [{ id: 'proof', status: 'pass', lesson: 'Use a clear separator.' }],
  });
  const output = fs.readFileSync(file, 'utf8');
  assert.match(output, /\*\* - pass - Use a clear separator\./);
  assert.doesNotMatch(output, /\u2014/);
}));

test('scorecard writes clean lines and reads old and new formats', () => workspace((root) => {
  const atrisDir = path.join(root, 'atris');
  const file = getScorecardsPath(atrisDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `# scorecards.md: Endgame Results\n\n- **[2026-09-22] old** ${oldDash} shipped: 1/1 ${oldDash} wall-clock: 1.0h ${oldDash} halt: 0% ${oldDash} reward: 2 ${oldDash} lessons: 1\n`);
  writeScorecard(atrisDir, { slug: 'new', endDate: '2026-09-23', tasksShipped: 2, tasksAttempted: 2, totalReward: 3 });
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.doesNotMatch(lines.at(-1), /\u2014/);
  assert.deepEqual(readScorecards(atrisDir).map((row) => row.slug), ['old', 'new']);
}));

test('scorecard template has a clean heading', () => workspace((root) => {
  const atrisDir = path.join(root, 'atris');
  writeScorecard(atrisDir, { slug: 'first' });
  assert.doesNotMatch(fs.readFileSync(getScorecardsPath(atrisDir), 'utf8'), /\u2014/);
}));

test('todo title join emits a plain separator from legacy markdown', () => workspace((root) => {
  const file = path.join(root, 'atris', 'TODO.md');
  fs.writeFileSync(file, `## Backlog\n- **T1:** **Draft** ${oldDash} explain the change\n`);
  const todo = parseTodoFile(file);
  assert.equal(todo.backlog[0].title, 'Draft - explain the change');
}));

test('probe line builder emits clean terminal text', () => {
  const line = buildProbeLine({ stamp: '2026-09-23T00:00:00Z', where: 'personal', model: 'atris:fast', ok: true, secs: 1, toolsRun: 1, detail: 'answer: done' });
  assert.match(line, /personal/);
  assert.doesNotMatch(line, /\u2014/);
});

test('review learning line emits a clean timestamp separator', () => {
  const line = reviewLearningLine('13:44', 'A useful observation');
  assert.equal(line, '- 13:44 - A useful observation');
  assert.doesNotMatch(line, /\u2014/);
});

test('contradiction check reads mixed legacy and new lesson lines', () => workspace((root) => {
  fs.writeFileSync(path.join(root, 'atris', 'lessons.md'), [
    `- **[2026-09-22] changed-rule** ${oldDash} pass ${oldDash} First result`,
    '- **[2026-09-23] changed-rule** - fail - Later result',
    '',
  ].join('\n'));
  const contradictions = detectLessonContradictions(root);
  assert.equal(contradictions.length, 1);
  assert.equal(contradictions[0].slug, 'changed-rule');
}));

test('lesson views and resolution read both separators', () => {
  for (const separator of [oldDash, '-']) workspace((root) => {
    const line = `- **[2026-09-23] parser-rule** ${separator} fail ${separator} Check the parser.`;
    fs.writeFileSync(path.join(root, 'atris', 'lessons.md'), `${line}\n`);
    fs.writeFileSync(path.join(root, 'atris', 'lessons.json'), JSON.stringify({
      'parser-rule': { status: 'open', applies_to: ['lib/parser.js'], detector: 'true' },
    }));
    assert.equal(parseAutopilotLessons(root)[0].verdict, 'fail');
    assert.equal(parseMemoryLessons(line)[0].text, 'Check the parser.');
    assert.equal(matchLessons({ root, files: ['lib/parser.js'], briefText: '' })[0].text, 'Check the parser.');
    assert.deepEqual(autoResolveLessons(root).resolved, ['parser-rule']);
    assert.match(fs.readFileSync(path.join(root, 'atris', 'lessons.md'), 'utf8'), /\[resolved\]/);
  });
});

test('deterministic script output uses plain punctuation', () => {
  const result = prDescription.build({ commits: [], files: [{ path: 'lib/a.js', status: 'A', added: 1 }] });
  assert.doesNotMatch(result.summary.join('\n'), /\u2014/);
  assert.doesNotMatch(prDescription.build({ commits: [], files: [] }).error, /\u2014/);
  assert.doesNotMatch(catalogText(), /\u2014/);
});
