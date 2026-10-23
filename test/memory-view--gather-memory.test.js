'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { gatherMemory } = require('../lib/memory-view');

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gather-memory-test-'));
  const savedEnv = { ...process.env };

  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) {
      delete process.env[key];
    }
  }

  process.env.HOME = root;
  process.env.USERPROFILE = root;

  t.after(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, savedEnv);
    fs.rmSync(root, { recursive: true, force: true });
  });

  return root;
}

test('gatherMemory collects lessons, learnings, and task counts from workspace files', (t) => {
  const root = createFixture(t);

  fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
  fs.mkdirSync(path.join(root, '.atris', 'state'), { recursive: true });

  const lessonsContent = [
    '- **[2026-06-18] git-first-check** \u2014 pass \u2014 verify with git diff before git log.',
    '- **[2026-06-19] bad-commit-check** \u2014 fail \u2014 [resolved] test resolved marker.',
  ].join('\n');
  fs.writeFileSync(path.join(root, 'atris', 'lessons.md'), lessonsContent);

  const learningsContent = [
    JSON.stringify({ ts: '2026-06-18T10:00:00.000Z', type: 'pitfall', key: 'narrow-grep', insight: 'grep wide' }),
    JSON.stringify({ ts: '2026-06-19T10:00:00.000Z', type: 'discovery', key: 'fast-path', insight: 'use cache' }),
  ].join('\n') + '\n';
  fs.writeFileSync(path.join(root, 'atris', 'learnings.jsonl'), learningsContent);

  const taskProjection = {
    tasks: [
      { id: 't1', status: 'done' },
      { id: 't2', status: 'accepted' },
      { id: 't3', status: 'active' },
      { id: 't4', status: 'in_progress' },
      { id: 't5', status: 'review' },
      { id: 't6', status: 'ready' },
      { id: 't7', status: 'blocked' },
    ],
  };
  fs.writeFileSync(
    path.join(root, '.atris', 'state', 'tasks.projection.json'),
    JSON.stringify(taskProjection)
  );

  const memory = gatherMemory(root);

  assert.strictEqual(memory.lessons.length, 2);
  assert.deepStrictEqual(memory.lessons[0], {
    date: '2026-06-18',
    id: 'git-first-check',
    status: 'pass',
    text: 'verify with git diff before git log.',
    resolved: false,
  });
  assert.deepStrictEqual(memory.lessons[1], {
    date: '2026-06-19',
    id: 'bad-commit-check',
    status: 'fail',
    text: 'test resolved marker.',
    resolved: true,
  });

  assert.strictEqual(memory.learnings.length, 2);
  assert.strictEqual(memory.learnings[0].key, 'narrow-grep');
  assert.strictEqual(memory.learnings[0].insight, 'grep wide');
  assert.strictEqual(memory.learnings[1].key, 'fast-path');
  assert.strictEqual(memory.learnings[1].insight, 'use cache');

  assert.deepStrictEqual(memory.tasks, {
    total: 7,
    done: 2,
    active: 2,
    review: 2,
  });
});

test('gatherMemory returns empty arrays and null task counts when files are missing', (t) => {
  const root = createFixture(t);

  const memory = gatherMemory(root);

  assert.deepStrictEqual(memory.lessons, []);
  assert.deepStrictEqual(memory.learnings, []);
  assert.strictEqual(memory.tasks, null);
});

test('gatherMemory handles edge cases like malformed lines and non-array tasks gracefully', (t) => {
  const root = createFixture(t);

  fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
  fs.mkdirSync(path.join(root, '.atris', 'state'), { recursive: true });

  const messyLessons = [
    '# Daily Lessons Header',
    'Some non-matching line here',
    '- **[2026-07-01] edge-case-note** : note with colon separator and no explicit status',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(root, 'atris', 'lessons.md'), messyLessons);

  const messyLearnings = [
    '',
    'not valid json',
    '   ',
    JSON.stringify({ ts: '2026-07-01T00:00:00Z', type: 'note', key: 'sparse', insight: 'keep it simple' }),
  ].join('\n');
  fs.writeFileSync(path.join(root, 'atris', 'learnings.jsonl'), messyLearnings);

  fs.writeFileSync(
    path.join(root, '.atris', 'state', 'tasks.projection.json'),
    JSON.stringify({ tasks: 'not-an-array' })
  );

  const memory = gatherMemory(root);

  assert.strictEqual(memory.lessons.length, 1);
  assert.strictEqual(memory.lessons[0].id, 'edge-case-note');
  assert.strictEqual(memory.lessons[0].status, '');
  assert.strictEqual(memory.lessons[0].text, 'note with colon separator and no explicit status');
  assert.strictEqual(memory.lessons[0].resolved, false);

  assert.strictEqual(memory.learnings.length, 1);
  assert.strictEqual(memory.learnings[0].key, 'sparse');
  assert.strictEqual(memory.learnings[0].insight, 'keep it simple');

  assert.deepStrictEqual(memory.tasks, {
    total: 0,
    done: 0,
    active: 0,
    review: 0,
  });
});

test('gatherMemory returns null tasks when tasks projection contains invalid json', (t) => {
  const root = createFixture(t);

  fs.mkdirSync(path.join(root, '.atris', 'state'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.atris', 'state', 'tasks.projection.json'),
    '{ malformed json content'
  );

  const memory = gatherMemory(root);

  assert.strictEqual(memory.tasks, null);
});
