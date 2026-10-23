const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { fileAutoLessons } = require('../lib/auto-lessons');

test('fileAutoLessons ignores threshold of 1 and does not file single occurrences', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-auto-lessons-mut-'));
  try {
    const episodes = [
      {
        episode_id: 'e1',
        task_id: 't1',
        action: { event_type: 'revision_requested' },
        human_feedback: { human_revision_note: 'Keep it short' },
        rl: { label: 'rework_requested' },
      },
    ];

    const result = fileAutoLessons(root, { episodes, threshold: 1 });
    assert.deepStrictEqual(result, { added: [], detected: [] });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
