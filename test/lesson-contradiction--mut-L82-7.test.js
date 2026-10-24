'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { detectLessonContradictions } = require('../lib/lesson-contradiction');

test('ignores a single path string instead of reporting its characters as missing files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lesson-path-type-'));
  try {
    fs.mkdirSync(path.join(root, 'atris'));
    fs.writeFileSync(path.join(root, 'atris', 'lessons.json'), JSON.stringify({
      'check-path': {
        scope: 'test-repo',
        applies_to: 'commands/check.js',
        detector: 'true',
        status: 'open',
      },
    }));

    const contradictions = detectLessonContradictions(root);
    assert.strictEqual(contradictions.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
