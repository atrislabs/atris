'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-console-build-system-prompt-'));
process.env.HOME = root;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}

const { buildSystemPrompt } = require('../commands/console');

const HEADER = [
  '# Atris Console',
  'You are running inside the Atris Console, an AI workspace operating system.',
  '',
];

test('buildSystemPrompt includes every section for a full workspace', () => {
  const atrisRoot = path.join(root, 'atris');
  const prompt = buildSystemPrompt({
    hasAtris: true,
    atrisRoot,
    persona: 'Speak plainly.\nLeave a blank line between thoughts.',
    teamMembers: ['architect', 'editor'],
    skills: [
      {
        name: 'writer',
        description: 'drafts in a clear voice',
        path: path.join(atrisRoot, 'skills', 'writer', 'SKILL.md'),
      },
      {
        name: 'aeo',
        description: 'write for AI answers',
        path: path.join(atrisRoot, 'skills', 'aeo', 'SKILL.md'),
      },
    ],
    backlogCount: 3,
    todayJournal: path.join(atrisRoot, 'logs', '2020', '2020-01-15.md'),
  });

  assert.strictEqual(prompt, [
    ...HEADER,
    '## Persona',
    'Speak plainly.',
    'Leave a blank line between thoughts.',
    '',
    '## Team Members',
    'Available: architect, editor',
    `Each has a MEMBER.md in ${path.join(atrisRoot, 'team')}/<name>/ defining their role.`,
    '',
    '## Skills',
    'Before replying, scan these skills. If one applies, read its SKILL.md then follow it.',
    '',
    `- **writer**: drafts in a clear voice (${path.join(atrisRoot, 'skills', 'writer', 'SKILL.md')})`,
    `- **aeo**: write for AI answers (${path.join(atrisRoot, 'skills', 'aeo', 'SKILL.md')})`,
    '',
    '## Current Work',
    `3 tasks in backlog. Check ${path.join(atrisRoot, 'TODO.md')} for details.`,
    '',
    '## Journal',
    `Today's journal: ${path.join(atrisRoot, 'logs', '2020', '2020-01-15.md')}`,
    '',
  ].join('\n'));
});

test('buildSystemPrompt uses fallback paths and the singular task word', () => {
  const prompt = buildSystemPrompt({
    atrisRoot: '',
    persona: '',
    teamMembers: ['solo'],
    skills: [
      { name: 'solo', description: 'solo', path: 'skills/solo/SKILL.md' },
      { name: 'solo', description: 'kept as typed', path: 'skills/solo-copy/SKILL.md' },
    ],
    backlogCount: 1,
    todayJournal: null,
  });

  assert.strictEqual(prompt, [
    ...HEADER,
    '## Team Members',
    'Available: solo',
    'Each has a MEMBER.md in atris/team/<name>/ defining their role.',
    '',
    '## Skills',
    'Before replying, scan these skills. If one applies, read its SKILL.md then follow it.',
    '',
    '- **solo**: solo (skills/solo/SKILL.md)',
    '- **solo**: kept as typed (skills/solo-copy/SKILL.md)',
    '',
    '## Current Work',
    '1 task in backlog. Check atris/TODO.md for details.',
    '',
  ].join('\n'));
  assert.strictEqual(prompt.includes('## Persona'), false);
  assert.strictEqual(prompt.includes('## Journal'), false);
  assert.strictEqual(prompt.includes('1 tasks'), false);
});

test('buildSystemPrompt returns only the header for an empty workspace', () => {
  const prompt = buildSystemPrompt({
    hasAtris: false,
    atrisRoot: null,
    persona: null,
    teamMembers: [],
    skills: [],
    backlogCount: 0,
    todayJournal: null,
  });

  assert.strictEqual(prompt, HEADER.join('\n'));
  assert.strictEqual(prompt.includes('## '), false);
});

test('buildSystemPrompt throws when the context is missing its lists', () => {
  assert.throws(() => buildSystemPrompt(null), TypeError);
  assert.throws(() => buildSystemPrompt({
    persona: 'x',
    skills: [],
    backlogCount: 0,
  }), TypeError);
});
