'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { matchLessons } = require('../lib/lesson-preflight');

test('matches ancestor and descendant paths through lesson preflight', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lesson-preflight-prefix-'));
  try {
    const atrisDir = path.join(root, 'atris');
    fs.mkdirSync(atrisDir);
    fs.writeFileSync(path.join(atrisDir, 'lessons.json'), JSON.stringify({
      'directory-guidance': { status: 'open', applies_to: ['lib/widgets'] },
    }));
    fs.writeFileSync(path.join(atrisDir, 'lessons.md'),
      '- **[2020-01-01] directory-guidance**: Keep widget changes consistent.\n');

    for (const file of ['lib/widgets/render.js', 'lib']) {
      assert.deepEqual(matchLessons({ root, files: [file], briefText: '' }), [{
        slug: 'directory-guidance',
        text: 'Keep widget changes consistent.',
        why_matched: 'file overlaps lib/widgets',
      }], `expected a path overlap for ${file}`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
