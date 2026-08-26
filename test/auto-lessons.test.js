const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadHistory } = require('../lib/policy-lessons');

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-auto-lessons-'));
  fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
  fs.mkdirSync(path.join(root, '.atris', 'state'), { recursive: true });
  return root;
}

function writeLessons(root, value) {
  fs.writeFileSync(
    path.join(root, 'atris', 'lessons.json'),
    `${JSON.stringify(value, null, 2)}\n`,
    'utf8',
  );
}

function revisionEpisode(id, taskId, note) {
  return {
    schema: 'atris.task_episode.v1',
    episode_id: id,
    task_id: taskId,
    created_at: `2026-08-${id === 'episode-1' ? '24' : '25'}T12:00:00.000Z`,
    action: { event_type: 'revision_requested', actor: 'operator-jane' },
    human_feedback: { human_revision_note: note },
    rl: { label: 'rework_requested', source: 'task_revision' },
  };
}

function writeEpisodes(root, rows) {
  fs.writeFileSync(
    path.join(root, '.atris', 'state', 'task_episodes.jsonl'),
    `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
    'utf8',
  );
}

test('a repeated revision files one typed lesson and the next load does not duplicate it', (t) => {
  const root = makeWorkspace();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeLessons(root, {
    _schema: { description: 'fixture typed lessons' },
    'existing-rule': { scope: 'workspace', status: 'observed' },
  });
  writeEpisodes(root, [
    revisionEpisode('episode-1', 'task-1', 'Decision line was too vague.'),
    revisionEpisode('episode-2', 'task-2', '  decision line was too vague  '),
  ]);

  loadHistory(root);
  const lessonsPath = path.join(root, 'atris', 'lessons.json');
  const first = JSON.parse(fs.readFileSync(lessonsPath, 'utf8'));
  const slugs = Object.keys(first).filter((key) => key !== '_schema');
  assert.deepEqual(slugs, ['existing-rule', 'decision-line-was-too-vague']);
  assert.deepEqual(first['decision-line-was-too-vague'], {
    name: 'Decision line was too vague.',
    date: new Date().toISOString().slice(0, 10),
    scope: 'workspace',
    rule: 'Decision line was too vague.',
    detector: 'repeated_human_revision_note',
    source_signal: {
      type: 'repeated_human_revision_note',
      path: path.join('.atris', 'state', 'task_episodes.jsonl'),
      normalized_correction: 'decision line was too vague',
      occurrences: 2,
      task_ids: ['task-1', 'task-2'],
      episode_ids: ['episode-1', 'episode-2'],
    },
    status: 'observed',
    last_detected: new Date().toISOString().slice(0, 10),
  });

  loadHistory(root);
  const second = JSON.parse(fs.readFileSync(lessonsPath, 'utf8'));
  assert.deepEqual(second, first);
});

test('one revision occurrence files no lesson', (t) => {
  const root = makeWorkspace();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeLessons(root, { _schema: { description: 'fixture typed lessons' } });
  writeEpisodes(root, [revisionEpisode('episode-1', 'task-1', 'Decision line was too vague.')]);
  const lessonsPath = path.join(root, 'atris', 'lessons.json');
  const before = fs.readFileSync(lessonsPath, 'utf8');

  loadHistory(root);

  assert.equal(fs.readFileSync(lessonsPath, 'utf8'), before);
});

test('malformed lessons metadata stays untouched and raises an honest error', (t) => {
  const root = makeWorkspace();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lessonsPath = path.join(root, 'atris', 'lessons.json');
  const malformed = '{"existing-rule":';
  fs.writeFileSync(lessonsPath, malformed, 'utf8');
  writeEpisodes(root, [
    revisionEpisode('episode-1', 'task-1', 'Decision line was too vague.'),
    revisionEpisode('episode-2', 'task-2', 'Decision line was too vague.'),
  ]);

  assert.throws(
    () => loadHistory(root),
    /cannot file automatic lessons because .*lessons\.json contains malformed JSON/,
  );
  assert.equal(fs.readFileSync(lessonsPath, 'utf8'), malformed);
});
