'use strict';

// skill audit's no-xml-tags rule must not flag placeholders inside code
// blocks/spans or single-letter prose placeholders — only real XML in prose.

const test = require('node:test');
const assert = require('node:assert/strict');
const { runAuditChecks, parseFrontmatter } = require('../commands/skill');

function makeSkill(body) {
  const content = [
    '---',
    'name: fixture-skill',
    'description: Fixture skill. Use when testing the audit rules.',
    'version: 1.0.0',
    'tags: [test]',
    '---',
    '',
    body,
  ].join('\n');
  return {
    name: 'fixture-skill',
    path: '/tmp/skills/fixture-skill/SKILL.md',
    content,
    frontmatter: parseFrontmatter(content),
  };
}

function xmlCheck(skill) {
  return runAuditChecks(skill).find((check) => check.id === 'no-xml-tags');
}

test('placeholders inside fenced code blocks do not count as XML', () => {
  const check = xmlCheck(makeSkill([
    '# Fixture',
    '',
    '1. Run the command below.',
    '',
    '```bash',
    'atris write aeo "<topic>"',
    'cat /workspace/atris/aeo/drafts/<slug>.md',
    '```',
  ].join('\n')));
  assert.equal(check.pass, true, check.message);
});

test('placeholders inside longer fenced code examples do not count as XML', () => {
  const check = xmlCheck(makeSkill([
    '# Fixture',
    '',
    '1. Show the nested example below.',
    '',
    '````markdown',
    '```bash',
    'cd <worktree-path>',
    '```',
    '````',
  ].join('\n')));
  assert.equal(check.pass, true, check.message);
});

test('placeholders inside inline code spans do not count as XML', () => {
  const check = xmlCheck(makeSkill([
    '# Fixture',
    '',
    '1. Save the draft to `/workspace/atris/aeo/drafts/<slug>.md` first.',
    '2. Then audit `<slug>-<date>.md` for citations.',
  ].join('\n')));
  assert.equal(check.pass, true, check.message);
});

test('placeholders inside longer inline code spans do not count as XML', () => {
  const check = xmlCheck(makeSkill([
    '# Fixture',
    '',
    '1. Run ``cd <worktree-path>`` before shipping.',
  ].join('\n')));
  assert.equal(check.pass, true, check.message);
});

test('single-letter prose placeholders like <X> and <N> are allowed', () => {
  const check = xmlCheck(makeSkill([
    '# Fixture',
    '',
    '1. Tell the user: "job id <X>. fires roughly every <N> minutes."',
  ].join('\n')));
  assert.equal(check.pass, true, check.message);
});

test('real XML tags in prose still fail the audit', () => {
  const check = xmlCheck(makeSkill([
    '# Fixture',
    '',
    '1. Wrap output in <answer>...</answer> tags.',
  ].join('\n')));
  assert.equal(check.pass, false);
  assert.match(check.message, /<answer>/);
});

test('known placeholder words in prose stay allowed', () => {
  const check = xmlCheck(makeSkill([
    '# Fixture',
    '',
    '1. Replace <name> with the member and <path> with the target file.',
  ].join('\n')));
  assert.equal(check.pass, true, check.message);
});
