'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { snapshotSoul } = require('../commands/soul');

const PERSONA = '# Persona\n\nSpeak plainly.\n';
const MAP = '# Map\n\nsoul lives in commands/soul.js\n';
const LESSONS = [
  '# Lessons',
  '',
  '- keep the reply short',
  '- name the file',
  '  - indented is not counted',
  'not a bullet',
  '',
].join('\n');
const TODO = [
  '# TODO',
  '',
  '- ship the snapshot test',
  '- check the empty folder',
  '-no-space-does-not-count',
  '  - indented does not count',
  '',
].join('\n');

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-soul-snapshot-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function assertUtcTimestamp(value) {
  assert.equal(typeof value, 'string');
  assert.match(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(new Date(value).toISOString(), value);
}

function comparable(soul) {
  assertUtcTimestamp(soul.timestamp);
  const copy = {
    project: soul.project,
    identity: { ...soul.identity },
    knowledge: { ...soul.knowledge },
    learned: { ...soul.learned },
    stats: { ...soul.stats },
  };
  if (Array.isArray(copy.identity.team)) copy.identity.team = [...copy.identity.team].sort();
  if (Array.isArray(copy.knowledge.features)) copy.knowledge.features = [...copy.knowledge.features].sort();
  if (Array.isArray(copy.knowledge.refs)) copy.knowledge.refs = [...copy.knowledge.refs].sort();
  if (Array.isArray(copy.learned.policies)) copy.learned.policies = [...copy.learned.policies].sort();
  return copy;
}

test('snapshotSoul reads a full project tree into identity, knowledge, learned, and stats', (t) => {
  const atrisDir = path.join(makeRoot(t), 'harbor', 'atris');
  writeFile(path.join(atrisDir, 'PERSONA.md'), PERSONA);
  writeFile(path.join(atrisDir, 'MAP.md'), MAP);
  writeFile(path.join(atrisDir, 'team', 'lin', 'MEMBER.md'), '# Lin\n');
  writeFile(path.join(atrisDir, 'team', 'ada', 'MEMBER.md'), '# Ada\n');
  writeFile(path.join(atrisDir, 'team', 'ghost', 'notes.md'), 'no profile\n');
  writeFile(path.join(atrisDir, 'features', 'ship', 'idea.md'), '# ship\n');
  writeFile(path.join(atrisDir, 'features', '_draft', 'idea.md'), '# draft\n');
  writeFile(path.join(atrisDir, 'features', 'bare', 'notes.md'), 'no idea file\n');
  writeFile(path.join(atrisDir, 'research', 'alpha.md'), 'alpha\n');
  writeFile(path.join(atrisDir, 'research', 'nest', 'beta.md'), 'beta\n');
  writeFile(path.join(atrisDir, 'research', '.draft', 'file.md'), 'hidden\n');
  writeFile(path.join(atrisDir, 'refs', 'MAP-NOTES.md'), '# notes\n');
  writeFile(path.join(atrisDir, 'refs', 'readme.md'), '# readme\n');
  writeFile(path.join(atrisDir, 'refs', 'data.json'), '{}\n');
  writeFile(path.join(atrisDir, 'policies', 'safety.md'), '# safety\n');
  writeFile(path.join(atrisDir, 'policies', 'voice.md'), '# voice\n');
  writeFile(path.join(atrisDir, 'policies', 'notes.txt'), 'skip\n');
  writeFile(path.join(atrisDir, 'logs', '2026-01-01.md'), 'one\n');
  writeFile(path.join(atrisDir, 'logs', '2026-01-02.md'), 'two\n');
  writeFile(path.join(atrisDir, 'logs', '.scratch.md'), 'skip\n');
  writeFile(path.join(atrisDir, 'lessons.md'), LESSONS);
  writeFile(path.join(atrisDir, 'TODO.md'), TODO);

  const soul = snapshotSoul(atrisDir);

  assert.deepStrictEqual(comparable(soul), {
    project: 'harbor',
    identity: {
      'PERSONA.md': PERSONA,
      'MAP.md': MAP,
      team: ['ada', 'lin'],
    },
    knowledge: {
      features: ['ship'],
      feature_count: 1,
      research_files: 3,
      refs: ['MAP-NOTES.md', 'readme.md'],
    },
    learned: {
      policies: ['safety.md', 'voice.md'],
      journal_entries: 2,
      lessons: 2,
    },
    stats: {
      open_tasks: 2,
      identity_files: 3,
      knowledge_items: 4,
      learned_items: 4,
    },
  });
});

test('snapshotSoul skips blank files, draft features, and a logs path that cannot be listed', (t) => {
  const atrisDir = path.join(makeRoot(t), 'skiff', 'atris');
  writeFile(path.join(atrisDir, 'PERSONA.md'), '');
  writeFile(path.join(atrisDir, 'MAP.md'), MAP);
  writeFile(path.join(atrisDir, 'team', 'ada', 'MEMBER.md'), '# Ada\n');
  writeFile(path.join(atrisDir, 'team', 'ghost', 'notes.md'), 'no profile\n');
  writeFile(path.join(atrisDir, 'features', 'ship', 'idea.md'), '# ship\n');
  writeFile(path.join(atrisDir, 'features', '_draft', 'idea.md'), '# draft\n');
  writeFile(path.join(atrisDir, 'features', 'loose.md'), 'not a feature folder\n');
  writeFile(path.join(atrisDir, 'policies', 'voice.md'), '# voice\n');
  writeFile(path.join(atrisDir, 'policies', 'ignore.txt'), 'nope\n');
  writeFile(path.join(atrisDir, 'logs'), 'not a directory\n');
  writeFile(path.join(atrisDir, 'lessons.md'), '# Lessons\n\nplain line only\n');
  writeFile(path.join(atrisDir, 'TODO.md'), '# TODO\n\n-no space\n  - indented\n');

  const soul = snapshotSoul(atrisDir);

  assert.deepStrictEqual(comparable(soul), {
    project: 'skiff',
    identity: {
      'MAP.md': MAP,
      team: ['ada'],
    },
    knowledge: {
      features: ['ship'],
      feature_count: 1,
    },
    learned: {
      policies: ['voice.md'],
      journal_entries: 0,
      lessons: 0,
    },
    stats: {
      open_tasks: 0,
      identity_files: 2,
      knowledge_items: 1,
      learned_items: 0,
    },
  });
});

test('snapshotSoul returns an empty soul for a missing path or a file, and rejects a non-path', (t) => {
  const root = makeRoot(t);
  const missing = path.join(root, 'gone', 'atris');
  const file = path.join(root, 'harbor', 'not-a-dir');
  writeFile(file, 'nope\n');

  assert.deepStrictEqual(comparable(snapshotSoul(missing)), {
    project: 'gone',
    identity: {},
    knowledge: {},
    learned: {},
    stats: {
      identity_files: 0,
      knowledge_items: 0,
      learned_items: 0,
    },
  });

  assert.deepStrictEqual(comparable(snapshotSoul(file)), {
    project: 'harbor',
    identity: {},
    knowledge: {},
    learned: {},
    stats: {
      identity_files: 0,
      knowledge_items: 0,
      learned_items: 0,
    },
  });

  assert.throws(() => snapshotSoul(null), { code: 'ERR_INVALID_ARG_TYPE' });
  assert.throws(() => snapshotSoul(undefined), { code: 'ERR_INVALID_ARG_TYPE' });
});
