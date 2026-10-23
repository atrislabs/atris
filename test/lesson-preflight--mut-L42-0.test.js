'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { matchLessons } = require('../lib/lesson-preflight');

test('resolved object prompt rules remain eligible for matching', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lesson-preflight-object-rule-'));
  try {
    const directory = path.join(root, 'atris');
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'lessons.json'), JSON.stringify({
      'review-guidance': {
        status: 'resolved',
        mechanism: { type: 'prompt-rule' },
        applies_to: ['lib/example.js'],
      },
    }));
    fs.writeFileSync(path.join(directory, 'lessons.md'),
      '- **[2020-01-01] review-guidance**: pass: Review the focused change.\n');

    assert.deepEqual(matchLessons({ root, files: ['lib/example.js'] }), [{
      slug: 'review-guidance',
      text: 'Review the focused change.',
      why_matched: 'file overlaps lib/example.js',
    }]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
