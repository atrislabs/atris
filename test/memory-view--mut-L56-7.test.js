'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildMemorySpec } = require('../lib/memory-view');

test('recent lesson headings preserve the words in the saved identifier', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lesson-heading-'));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });
  fs.mkdirSync(path.join(root, 'atris'));
  fs.writeFileSync(path.join(root, 'atris', 'lessons.md'),
    '- **[2026-06-18] verify-saved_input** - pass - Check the saved input.\n');

  const spec = buildMemorySpec(root);
  const recentLessons = spec.slides.find((slide) => slide.type === 'columns');
  assert.match(recentLessons.columns[0].h, /\bverify\b/);
});
