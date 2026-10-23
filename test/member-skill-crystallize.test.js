'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { crystallizeMemberSkillLesson } = require('../commands/mission');

function workspace() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-skill-')));
  fs.mkdirSync(path.join(root, 'atris', 'team', 'nav'), { recursive: true });
  fs.writeFileSync(path.join(root, 'atris', 'team', 'nav', 'MEMBER.md'), '# nav\n');
  return root;
}

test('a learned lesson never ends mid-word and keeps its whole check command', () => {
  const root = workspace();
  try {
    const summary = 'The pruner now runs every day at 6:05 from cron and lands its own result on master, '
      + 'and the README shows that exact line so anyone can install it again later without guessing.';
    const verifier = "python3 atris/features/context-pruning/judge.py | grep -q 'lands on its own yes'";
    const file = crystallizeMemberSkillLesson('nav', { summary, verifier, next_push: 'warn when a map file passes 12 KB' }, root);
    const bullet = fs.readFileSync(file, 'utf8').split('\n').find((l) => l.startsWith('- **'));
    assert.ok(bullet.includes(`Verify: \`${verifier}\``), bullet);
    const lesson = bullet.split(' -> ')[0];
    assert.ok(summary.startsWith(lesson.replace(/^- \*\*[^*]+\*\*: /, '').replace(/\.\.\.$/, '')), lesson);
    assert.match(lesson, /\w\.\.\.$|\.$/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a new lesson keeps the sections a person wrote around the lessons', () => {
  const root = workspace();
  try {
    const file = path.join(root, 'atris', 'team', 'nav', 'skills', 'auto-learned', 'SKILL.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [
      '---', 'name: auto-learned', 'description: Use when pruning context.', '---', '',
      '## When to use', '', 'Before editing the pruner.', '',
      '## What we learned', '', '- **2026-10-15 (environment)**: old lesson.', '',
      '## Done when', '', 'The judge passes.', '',
    ].join('\n'));

    crystallizeMemberSkillLesson('nav', { summary: 'A new verified lesson.' }, root);
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /description: Use when pruning context\./);
    assert.match(text, /## When to use\n\nBefore editing the pruner\./);
    assert.match(text, /## Done when\n\nThe judge passes\./);
    assert.match(text, /- \*\*[^*]+\*\*: A new verified lesson\.\n- \*\*2026-10-15 \(environment\)\*\*: old lesson\./);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
