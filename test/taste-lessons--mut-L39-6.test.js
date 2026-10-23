'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { addTaste, listTaste } = require('../lib/taste-lessons');

test('a null saved entry does not hide a valid lesson', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taste-null-entry-'));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    fs.mkdirSync(path.join(root, 'atris'));
    const lesson = addTaste({
      verdict: 'keep',
      subject: 'Readable dashboard typography',
      why: 'Clear hierarchy helps scanning.',
      scope: 'design',
      added: '2026-08-03',
      root,
    });
    const savedPath = path.join(root, 'atris', 'taste.json');
    const saved = JSON.parse(fs.readFileSync(savedPath, 'utf8'));
    saved.damaged = null;
    fs.writeFileSync(savedPath, JSON.stringify(saved));

    const lessons = listTaste({ root });
    assert.equal(lessons.length, 1);
    assert.equal(lessons[0].slug, lesson.slug);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
