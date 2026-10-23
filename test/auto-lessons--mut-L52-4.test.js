const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { fileAutoLessons, TYPED_LESSONS_FILE } = require('../lib/auto-lessons');

test('options.threshold of 1 falls back to the default repeat threshold', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-auto-lessons-mut-'));
  try {
    const singleEpisode = [
      {
        episode_id: 'ep-1',
        task_id: 'task-1',
        created_at: '2026-10-20T12:00:00.000Z',
        action: { event_type: 'revision_requested' },
        human_feedback: { human_revision_note: 'keep it simple' },
        rl: { label: 'rework_requested' },
      },
    ];

    const result = fileAutoLessons(root, { threshold: 1, episodes: singleEpisode });

    assert.deepStrictEqual(result, { added: [], detected: [] });
    assert.strictEqual(fs.existsSync(path.join(root, TYPED_LESSONS_FILE)), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
