require('./helpers/clean-temp');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { policyLessonsForFiles } = require('../lib/policy-lessons');

test('an empty normalized lesson scope does not match an absolute candidate', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-empty-scope-'));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    const matches = policyLessonsForFiles([path.join(root, 'src', 'app.js')], {
      lessons: [{ id: 'empty-scope', applies_to: ['./'], lesson: 'Check application code.' }],
    }, root);
    assert.strictEqual(matches.length, 0);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
