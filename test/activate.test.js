'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { activateAtris } = require('../commands/activate');

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-activate-narration-'));
  const atrisDir = path.join(root, 'atris');
  fs.mkdirSync(path.join(atrisDir, 'logs', '9999'), { recursive: true });
  fs.mkdirSync(path.join(root, '.atris', 'state'), { recursive: true });
  fs.writeFileSync(path.join(atrisDir, 'PERSONA.md'), '# persona\n', 'utf8');
  fs.writeFileSync(path.join(atrisDir, 'MAP.md'), '# map\n', 'utf8');
  fs.writeFileSync(
    path.join(atrisDir, 'TODO.md'),
    [
      '# work',
      '',
      '## Backlog',
      '',
      '- write the follow-up',
      '',
      '## In Progress',
      '',
      '- keep the session story moving',
      '',
      '## Completed',
      '',
    ].join('\n'),
    'utf8',
  );
  fs.writeFileSync(
    path.join(atrisDir, 'logs', '9999', '9999-12-31.md'),
    [
      '# session',
      '',
      '## Completed ✅',
      '- **C1: Ship the strongest onboarding story**',
      '- **C2: Tighten the daily review**',
      '- **C3: Remove stale boot chrome**',
      '',
      '## Notes',
      '',
    ].join('\n'),
    'utf8',
  );
  fs.writeFileSync(
    path.join(root, '.atris', 'state', 'tasks.projection.json'),
    JSON.stringify({
      tasks: [1, 2, 3].map((number) => ({
        id: `review-${number}`,
        title: `review item ${number}`,
        status: 'review',
      })),
    }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(root, 'ROADMAP.md'),
    '# roadmap\n\n## Open loop items\n\n- [ ] make the first screen tell one story\n',
    'utf8',
  );
  return root;
}

test('activate narrates the session start without visual markers', () => {
  const root = makeFixture();
  const previousCwd = process.cwd();
  const originalLog = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(' '));
  try {
    process.chdir(root);
    activateAtris();
    const output = lines.join('\n');

    assert.equal(lines[0], 'atris is up.');
    assert.deepEqual(lines, [
      'atris is up.',
      '',
      'since last time: three things landed; the biggest: ship the strongest onboarding story.',
      'right now: one task is in progress; the focus is keep the session story moving.',
      'waiting on you: three approvals. see them: atris task reviews',
      '',
      'Tip: run atris clarity once so agents learn how you work.',
      '',
      "today's move: make the first screen tell one story.",
    ]);
    assert.match(output, /waiting on you: three approvals/);
    assert.match(output, /^today's move: /m);
    assert.doesNotMatch(output, /[\u2500-\u257f]/u);
    assert.doesNotMatch(output, /\p{Extended_Pictographic}/u);
  } finally {
    console.log = originalLog;
    process.chdir(previousCwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('activate keeps one readable clause and stays quiet when nothing waits', () => {
  const root = makeFixture();
  fs.writeFileSync(
    path.join(root, 'atris', 'TODO.md'),
    [
      '# work',
      '',
      '## In Progress',
      '',
      '- [cli-1123] master test board is red again after the healing change; fix the dry-run heal test so breakage is visible [maintenance]',
      '',
    ].join('\n'),
    'utf8',
  );
  fs.writeFileSync(
    path.join(root, '.atris', 'state', 'tasks.projection.json'),
    JSON.stringify({ tasks: [] }),
    'utf8',
  );
  const previousCwd = process.cwd();
  const originalLog = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(' '));
  try {
    process.chdir(root);
    activateAtris();
    const output = lines.join('\n');

    assert.match(output, /right now: one task is in progress; the focus is master test board is red again after the healing change\./);
    assert.doesNotMatch(output, /\[[a-z0-9-]+\]/);
    assert.match(output, /^nothing is waiting on you\.$/m);
    assert.doesNotMatch(output, /zero approvals/);
  } finally {
    console.log = originalLog;
    process.chdir(previousCwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
