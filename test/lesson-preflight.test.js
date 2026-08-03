'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { matchLessons } = require('../lib/lesson-preflight');
const { buildFleetPrompt } = require('../lib/fleet');

function withLessons(metadata, prose, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lesson-preflight-'));
  const atrisDir = path.join(root, 'atris');
  fs.mkdirSync(atrisDir, { recursive: true });
  fs.writeFileSync(path.join(atrisDir, 'lessons.json'), `${JSON.stringify(metadata, null, 2)}\n`);
  fs.writeFileSync(path.join(atrisDir, 'lessons.md'), `# lessons\n\n${prose.join('\n')}\n`);
  try {
    return run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function prose(slug, text) {
  return `- **[2026-08-03] ${slug}** — fail — ${text}`;
}

test('matches an active lesson when its applies_to path overlaps a task file', () => {
  withLessons({
    'fleet-prompt-safety': {
      status: 'open',
      applies_to: ['lib/fleet.js'],
    },
  }, [prose('fleet-prompt-safety', 'Keep fleet prompt changes at the shared builder.')], (root) => {
    const matches = matchLessons({ briefText: 'Update engine dispatch.', files: ['/tmp/work/lib/fleet.js'], root });
    assert.deepEqual(matches, [{
      slug: 'fleet-prompt-safety',
      text: 'Keep fleet prompt changes at the shared builder.',
      why_matched: 'file overlaps lib/fleet.js',
    }]);
  });
});

test('matches an active lesson when slug keywords appear in the brief', () => {
  withLessons({
    'bare-verifier-command': { status: 'observed' },
  }, [prose('bare-verifier-command', 'Run the verifier bare so its exit code stays real.')], (root) => {
    const matches = matchLessons({ briefText: 'Run the bare verifier command before commit.', files: [], root });
    assert.equal(matches[0].slug, 'bare-verifier-command');
    assert.match(matches[0].why_matched, /bare, verifier, command/);
  });
});

test('excludes resolved deterministic mechanisms but keeps explicit prompt rules', () => {
  withLessons({
    'resolved-code-guard': {
      status: 'resolved',
      mechanism: 'lib/guard.js rejects the bad state; test/guard.test.js pins it.',
    },
    'resolved-prompt-rule': {
      status: 'resolved',
      mechanism: 'prompt-rule: stop after the focused verifier passes',
    },
  }, [
    prose('resolved-code-guard', 'The code guard already enforces this.'),
    prose('resolved-prompt-rule', 'Stop after the focused verifier passes.'),
  ], (root) => {
    const matches = matchLessons({
      briefText: 'Apply the resolved code guard and resolved prompt rule.',
      files: [],
      root,
    });
    assert.deepEqual(matches.map((lesson) => lesson.slug), ['resolved-prompt-rule']);
  });
});

test('caps matches at five and orders the most specific paths first', () => {
  const metadata = {};
  const lines = [];
  const files = [];
  for (let index = 1; index <= 7; index += 1) {
    const slug = `specific-path-${index}`;
    const lessonPath = `${'nested/'.repeat(index)}file-${index}.js`;
    metadata[slug] = { status: 'attempted', applies_to: [lessonPath] };
    lines.push(prose(slug, `Lesson ${index}.`));
    files.push(lessonPath);
  }
  withLessons(metadata, lines, (root) => {
    const matches = matchLessons({ briefText: '', files, root });
    assert.equal(matches.length, 5);
    assert.deepEqual(matches.map((lesson) => lesson.slug), [
      'specific-path-7',
      'specific-path-6',
      'specific-path-5',
      'specific-path-4',
      'specific-path-3',
    ]);
  });
});

test('generated engine dispatch prompt appends matching lesson text', () => {
  withLessons({
    'fleet-dispatch-preflight': {
      status: 'open',
      applies_to: ['lib/fleet.js'],
    },
  }, [prose('fleet-dispatch-preflight', 'Inject the lesson before the engine starts.')], (root) => {
    const prompt = buildFleetPrompt({
      display_id: 'CLI-1',
      title: 'Change lib/fleet.js. Done: dispatch carries context. Check: node --test test/lesson-preflight.test.js.',
    }, { worktreePath: root });
    assert.match(prompt, /## lessons that apply\n- Inject the lesson before the engine starts\./);
  });
});
