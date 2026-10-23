'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { matchLessons } = require('../lib/lesson-preflight');

test('matches a lesson through a three-letter slug keyword', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lesson-preflight-mut-L80-2-'));
  try {
    const dir = path.join(root, 'atris');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'lessons.json'), JSON.stringify({
      'cli-safety': { status: 'open' },
    }));
    fs.writeFileSync(path.join(dir, 'lessons.md'),
      '- **[2026-01-01] cli-safety**: fail: Keep command output readable.\n');

    assert.deepEqual(matchLessons({ root, briefText: 'Update the CLI.', files: [] }), [{
      slug: 'cli-safety',
      text: 'Keep command output readable.',
      why_matched: 'brief mentions cli',
    }]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
