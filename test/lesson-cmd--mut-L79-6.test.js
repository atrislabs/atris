'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { autoResolveLessons } = require('../commands/lesson');

test('resolving an empty lesson list does not create metadata', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-empty-lessons-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  try {
    process.env.HOME = root;
    process.chdir(root);
    fs.mkdirSync(path.join(root, 'atris'));
    fs.writeFileSync(path.join(root, 'atris', 'lessons.md'), '# Lessons\n');

    autoResolveLessons(root);

    assert.strictEqual(fs.existsSync(path.join(root, 'atris', 'lessons.json')), false);
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
