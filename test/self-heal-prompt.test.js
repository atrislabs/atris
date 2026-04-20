const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPrompt } = require('../commands/autopilot');

const LESSON = '- **[2026-03-05] inbox-parser-eats-hr-separator** — fail — `commands/autopilot.js:116` filters inbox bullets with `startsWith(\'-\')`, treats `---` as a bullet.';

test('self-heal plan prompt carries the lesson line', () => {
  const prompt = buildPrompt(
    'plan',
    {
      task: 'Fix unresolved fail lesson: inbox-parser-eats-hr-separator',
      kind: 'self-heal',
      lessonLine: LESSON,
      lessonSlug: 'inbox-parser-eats-hr-separator'
    }
  );

  assert.match(prompt, /Unresolved fail lesson:/, 'should include lesson header');
  assert.match(prompt, /inbox-parser-eats-hr-separator/, 'should include lesson slug');
  assert.match(prompt, /commands\/autopilot\.js:116/, 'should preserve file:line ref from lesson');
  assert.match(prompt, /Self-heal task:/, 'should label as self-heal');
  assert.match(prompt, /planner only/i, 'should tell planner not to fix in this phase');
});

test('self-heal do prompt carries the lesson and commit slug', () => {
  const prompt = buildPrompt(
    'do',
    {
      task: 'Fix unresolved fail lesson: inbox-parser-eats-hr-separator',
      kind: 'self-heal',
      lessonLine: LESSON,
      lessonSlug: 'inbox-parser-eats-hr-separator'
    }
  );

  assert.match(prompt, /Unresolved fail lesson:/);
  assert.match(prompt, /commands\/autopilot\.js:116/);
  assert.match(prompt, /fix: inbox-parser-eats-hr-separator/, 'commit message should carry slug');
  assert.match(prompt, /smallest change/i);
  assert.match(prompt, /Verify command/i);
});

test('self-heal prompts degrade gracefully without lessonLine', () => {
  const plan = buildPrompt('plan', { task: 'Fix something', kind: 'self-heal' });
  const doP = buildPrompt('do', { task: 'Fix something', kind: 'self-heal' });

  assert.doesNotMatch(plan, /Unresolved fail lesson:/, 'omits header when no lessonLine');
  assert.doesNotMatch(doP, /Unresolved fail lesson:/);
  assert.match(plan, /Self-heal task:/);
  assert.match(doP, /fix: self-heal/, 'fallback commit slug when no lessonSlug');
});

test('non-self-heal kind does not get self-heal language', () => {
  const prompt = buildPrompt(
    'plan',
    { task: 'Do something generic', kind: 'backlog' }
  );
  assert.doesNotMatch(prompt, /Self-heal task:/);
  assert.doesNotMatch(prompt, /Unresolved fail lesson:/);
});
